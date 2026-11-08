import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { createFakeReact } from './helpers.js';

/** @type {string} */
const clientSource = readFileSync(path.join(import.meta.dirname, '..', 'client.js'), 'utf8');

/**
 * Execute client.js in a VM with a fake module loader.
 * @returns {{ id: string, factory: (require: (id: string) => unknown) => any, React: any }}
 */
function loadClientModule() {
  /** @type {any} */
  let loaded;
  const window = {
    __ModuleLoader__: {
      load(config) {
        loaded = config;
      },
    },
  };
  const context = vm.createContext({ window, console, JSON, Object, Array, Math, Number, String, Error, Symbol });
  vm.runInContext(clientSource, context, { filename: 'client.js' });
  assert.ok(loaded, 'client.js called window.__ModuleLoader__.load');
  const React = createFakeReact();
  const factoryRequire = (dependency) => {
    if (dependency === 'react') return React;
    throw new Error(`unexpected require("${dependency}")`);
  };
  return { id: loaded.id, factory: loaded.factory, React };
}

/**
 * Apply the client module against a fake client context.
 * @param {any} module
 * @param {{ locale?: any }} [options]
 */
function installClient(module, options = {}) {
  /** @type {Array<{ options: any, component: (props: any) => any }>} */
  const registrations = [];
  /** @type {Array<{ namespace: string, dictionaries: any }>} */
  const locales = [];
  /** @type {string[]} */
  const injectedSlots = [];
  const ctx = {
    effect(callback, label) {
      callback();
      return { label, dispose() {} };
    },
    get(service) {
      if (typeof options.get === 'function') return options.get(service);
      return service === 'locale' ? options.locale : undefined;
    },
    slots: {
      inject(slot, factory) {
        injectedSlots.push(slot);
        factory();
        return () => {};
      },
      register(registration, component) {
        registrations.push({ options: registration, component });
        return () => {};
      },
    },
  };
  module.apply(ctx);
  return { registrations, locales, injectedSlots };
}

/**
 * Collect all string leaves from a fake React tree.
 * @param {any} node
 * @param {string[]} out
 * @returns {string[]}
 */
function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  const children = node.props?.children;
  if (Array.isArray(children)) for (const child of children) collectText(child, out);
  else collectText(children, out);
  return out;
}

/**
 * @param {any} node
 * @param {string} value
 * @returns {boolean}
 */
function treeContains(node, value) {
  return collectText(node).join('\n').includes(value);
}

test('client module declares the expected id and read-only card registrations', () => {
  const { id, factory } = loadClientModule();
  assert.equal(id, '@darkmintis/dsh-host-health');
  const module = factory((dependency) => {
    assert.equal(dependency, 'react');
    return createFakeReact();
  });
  assert.deepEqual(Array.from(module.inject), ['slots']);
  const { registrations, injectedSlots } = installClient(module);
  const cards = registrations.filter((registration) => registration.options.name === 'tool.call.toolview');
  assert.equal(cards.length, 5);
  assert.deepEqual([...injectedSlots].sort(), ['main', 'sidebar.panellist', 'tool.call.toolview', 'tool.call.toolview', 'tool.call.toolview', 'tool.call.toolview', 'tool.call.toolview']);
  const main = registrations.find((registration) => registration.options.name === 'main');
  assert.equal(main?.options.key, 'host-health', 'main panel key matches the panel id');
  const sidebar = registrations.find((registration) => registration.options.name === 'sidebar.panellist');
  assert.equal(sidebar?.options.id, 'host-health', 'sidebar entry addresses the main panel');
  assert.equal(typeof sidebar?.component, 'function');
  const keys = cards.map((registration) => registration.options.key);
  assert.deepEqual(keys, ['host_stats', 'ports_list', 'stale_dev_processes', 'port_kill', 'process_kill']);
  for (const registration of cards) {
    assert.equal(registration.options.name, 'tool.call.toolview');
    assert.equal(registration.options.locale, 'host-health');
    assert.equal(typeof registration.component, 'function');
  }
});

test('card components never throw on missing or malformed props', () => {
  const module = loadClientModule().factory(() => createFakeReact());
  const { registrations } = installClient(module);
  const cards = registrations.filter((registration) => registration.options.name === 'tool.call.toolview');
  const weirdProps = [
    null,
    undefined,
    {},
    { phase: 'preparing' },
    { phase: 'preparing', block: null },
    { phase: 'start', block: { argsRaw: 'not json' } },
    { phase: 'start', block: { argsRaw: '{"port":5173}' } },
    { phase: 'result', block: { kind: 'success', content: 'not-an-array', isError: false } },
    { phase: 'result', block: { kind: 'error', content: [{ type: 'text', text: 'Error: boom' }], isError: true, call: { argsRaw: '{"pid":1}' } } },
    { phase: 'result', block: { kind: 'success', content: [], error: { code: 'interrupted' }, call: null } },
  ];
  for (const registration of cards) {
    for (const props of weirdProps) {
      assert.doesNotThrow(() => registration.component(props));
    }
  }
});

test('result cards render the tool text inside an expandable body', () => {
  const module = loadClientModule().factory(() => createFakeReact());
  const { registrations } = installClient(module);
  const hostStats = registrations.find((registration) => registration.options.key === 'host_stats');
  assert.ok(hostStats);
  const tree = hostStats.component({
    phase: 'result',
    block: {
      kind: 'success',
      isError: false,
      content: [{ type: 'text', text: 'Host: dev-box\nRAM: 8 GB used' }],
      call: { argsRaw: '{}' },
    },
  });
  assert.equal(tree.props['data-tool'], 'host_stats');
  assert.equal(tree.props['data-state'], 'ok');
  assert.equal(treeContains(tree, 'Host: dev-box'), true);
  assert.equal(treeContains(tree, 'Host stats'), true);
});

test('preparing cards summarize the requested kill target', () => {
  const module = loadClientModule().factory(() => createFakeReact());
  const { registrations } = installClient(module);
  const portKill = registrations.find((registration) => registration.options.key === 'port_kill');
  const processKill = registrations.find((registration) => registration.options.key === 'process_kill');
  assert.ok(portKill);
  assert.ok(processKill);
  const portTree = portKill.component({ phase: 'preparing', block: { argsRaw: '{"port":5173}' } });
  assert.equal(treeContains(portTree, 'port 5173'), true);
  const processTree = processKill.component({
    phase: 'start',
    block: { argsRaw: '{"pid":1234,"expectedName":"node"}' },
  });
  assert.equal(treeContains(processTree, 'pid 1234'), true);
  assert.equal(treeContains(processTree, '(node)'), true);
});

test('locale is registered when the client locale service is present', () => {
  const module = loadClientModule().factory(() => createFakeReact());
  /** @type {Array<{ namespace: string, dictionaries: any }>} */
  const locales = [];
  const { registrations } = installClient(module, {
    locale: {
      register(namespace, dictionaries) {
        locales.push({ namespace, dictionaries });
        return () => {};
      },
    },
  });
  assert.equal(locales.length, 1);
  assert.equal(locales[0].namespace, 'host-health');
  assert.equal(locales[0].dictionaries.en['row.host_stats.title'], 'Host stats');
  const hostStats = registrations.find((registration) => registration.options.key === 'host_stats');
  assert.ok(hostStats);
  const translated = hostStats.component({
    phase: 'preparing',
    t: (key) => (key === 'row.host_stats.title' ? 'Host stats (translated)' : key),
  });
  assert.equal(treeContains(translated, 'Host stats (translated)'), true);
});

test('client module works without a locale service', () => {
  const module = loadClientModule().factory(() => createFakeReact());
  assert.doesNotThrow(() =>
    installClient(module, {
      get: () => undefined,
    }),
  );
});
