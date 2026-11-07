import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolDefinitions } from '../lib/tools.js';
import { TOOL_NAMES, KNOWN_DEV_PORTS } from '../lib/constants.js';
import { renderHostStats, renderKillResult, renderPortsList, renderStaleProcesses } from '../lib/render.js';

/**
 * Fake service with canned results and call recording.
 * @param {Record<string, any>} [results]
 */
function createFakeService(results = {}) {
  const calls = [];
  return {
    calls,
    async hostStats(args) {
      calls.push(['hostStats', args]);
      return results.hostStats ?? { ok: true, host: {}, memory: {}, cpu: {}, disk: null, topRam: [], topCpu: [], devProcesses: [], warnings: [], notes: [] };
    },
    async portsList(args) {
      calls.push(['portsList', args]);
      return results.portsList ?? { ok: true, listeners: [], flagged: [], warnings: [], notes: [] };
    },
    async staleDevProcesses() {
      calls.push(['staleDevProcesses']);
      return results.staleDevProcesses ?? { ok: true, entries: [], notes: [] };
    },
    async portKill(port) {
      calls.push(['portKill', port]);
      return results.portKill ?? { ok: true, killed: { port, pid: 1, name: 'node.exe' }, verifiedGone: true };
    },
    async processKill(pid, expectedName) {
      calls.push(['processKill', pid, expectedName]);
      return results.processKill ?? { ok: true, killed: { pid, name: 'node.exe' }, verifiedGone: true };
    },
  };
}

/**
 * @param {Record<string, any>} value
 * @returns {string}
 */
function renderText(value) {
  assert.equal(Array.isArray(value), true);
  for (const block of value) {
    assert.equal(block.type, 'text');
    assert.equal(typeof block.text, 'string');
  }
  return value.map((block) => block.text).join('\n');
}

test('createToolDefinitions registers the five documented tools', () => {
  const definitions = createToolDefinitions(createFakeService());
  assert.deepEqual(definitions.map((definition) => definition.name), [...TOOL_NAMES]);
  const names = new Set(definitions.map((definition) => definition.name));
  assert.equal(names.size, definitions.length);
  for (const definition of definitions) {
    assert.equal(definition.description.split(/\s+/).length <= 16, true, `${definition.name} description is under 16 words`);
    assert.equal(typeof definition.execute, 'function');
    assert.equal(typeof definition.timeoutMs, 'number');
    assert.ok(definition.timeoutMs > 0);
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.output.schema, 'object');
  }
});

test('parameter schemas are closed object schemas with described properties', () => {
  const definitions = createToolDefinitions(createFakeService());
  for (const definition of definitions) {
    const parameters = /** @type {Record<string, any>} */ (definition.parameters);
    assert.equal(parameters.type, 'object');
    assert.equal(parameters.additionalProperties, false);
    assert.equal(Array.isArray(parameters.required), true);
    assert.equal(typeof parameters.properties, 'object');
    for (const [name, property] of Object.entries(parameters.properties)) {
      assert.equal(typeof property, 'object');
      const description = /** @type {Record<string, any>} */ (property).description;
      assert.equal(typeof description, 'string', `${definition.name}.${name} has a description`);
      assert.ok(description.length > 0);
    }
    for (const required of parameters.required) {
      assert.ok(Object.hasOwn(parameters.properties, required), `${definition.name} requires a declared property`);
    }
  }
});

test('host_stats renders a readable table and carries presentation metadata', async () => {
  const service = createFakeService({
    hostStats: {
      ok: true,
      host: { hostname: 'dev-box', platform: 'win32', arch: 'x64', cpuCount: 8, uptimeSeconds: 7320 },
      memory: { totalBytes: 16 * 1024 ** 3, freeBytes: 6 * 1024 ** 3, usedBytes: 10 * 1024 ** 3, usedPercent: 62.5 },
      cpu: { percent: 12.3 },
      disk: { path: 'C:\\', totalBytes: 500 * 1024 ** 3, freeBytes: 200 * 1024 ** 3, usedBytes: 300 * 1024 ** 3, freePercent: 40 },
      load: [1, 2, 3],
      gpu: null,
      topRam: [{ pid: 100, name: 'chrome.exe', ramMb: 800, cpuPercent: 2.5, commandLine: 'chrome.exe --flag' }],
      topCpu: [{ pid: 100, name: 'chrome.exe', ramMb: 800, cpuPercent: 2.5, commandLine: 'chrome.exe --flag' }],
      devProcesses: [{ pid: 100, name: 'chrome.exe', kind: 'dev-process', label: 'Dev process', ramMb: 800, cpuPercent: 2.5, port: null }],
      warnings: [{ code: 'ram_high', severity: 'warn', message: 'RAM usage is 90%, above the 85% threshold.' }],
      notes: [],
    },
  });
  const definition = createToolDefinitions(service).find((tool) => tool.name === 'host_stats');
  assert.ok(definition);
  const value = await definition.execute({});
  assert.equal(value.ok, true);
  const text = renderText(definition.output.render({}, value));
  assert.match(text, /Host: dev-box \(win32 x64\) up 2h 2m/);
  assert.match(text, /RAM: {2}10 GB used of 16 GB \(62\.5%\)/);
  assert.match(text, /CPU: {2}12\.3%/);
  assert.match(text, /WARN: RAM usage is 90%/);
  assert.match(text, /Top RAM/);
  assert.match(text, /chrome\.exe/);
  assert.match(text, /800 MB/);
  assert.equal(definition.output.presentationMeta?.({}, value), value);
});

test('ports_list and stale_dev_processes render their tables', async () => {
  const definitions = createToolDefinitions(
    createFakeService({
      portsList: {
        ok: true,
        listeners: [{ port: 5173, address: '127.0.0.1', pid: 100, name: 'node.exe', knownDevPort: true, devLabel: 'Vite dev server' }],
        flagged: [{ port: 5173, status: 'in_use', pid: 100, name: 'node.exe', knownDevPort: true, devLabel: 'Vite dev server' }],
        warnings: [{ code: 'port_in_use', severity: 'warn', message: 'Port 5173 (Vite dev server) is in use by node.exe (pid 100).' }],
        notes: [],
      },
      staleDevProcesses: {
        ok: true,
        staleAfterMinutes: 30,
        entries: [
          {
            pid: 100,
            name: 'node.exe',
            category: 'preview-server',
            label: 'Preview/dev server',
            port: 8787,
            ageMinutes: 120,
            stale: true,
            confidence: 'high',
            reason: 'Leftover preview server.',
            suggested: { tool: 'port_kill', args: { port: 8787 }, note: 'Frees the port.' },
          },
        ],
        notes: [],
      },
    }),
  );
  const ports = definitions.find((tool) => tool.name === 'ports_list');
  const stale = definitions.find((tool) => tool.name === 'stale_dev_processes');
  assert.ok(ports);
  assert.ok(stale);
  const portsText = renderText(ports.output.render({ ports: [3000] }, await ports.execute({ ports: [3000] })));
  assert.match(portsText, /TCP listeners: 1/);
  assert.match(portsText, /\[dev: Vite dev server\]/);
  assert.match(portsText, /IN USE/);
  const staleText = renderText(stale.output.render({}, await stale.execute({})));
  assert.match(staleText, /STALE\/high/);
  assert.match(staleText, /port_kill\(\{"port":8787\}\)/);
});

test('kill tools render success and refusal text', async () => {
  const definitions = createToolDefinitions(
    createFakeService({
      portKill: { ok: true, killed: { port: 5173, pid: 100, name: 'node.exe' }, verifiedGone: true },
      processKill: { ok: false, error: 'protected_process', hint: 'lsass is system-critical.' },
    }),
  );
  const portKill = definitions.find((tool) => tool.name === 'port_kill');
  const processKill = definitions.find((tool) => tool.name === 'process_kill');
  assert.ok(portKill);
  assert.ok(processKill);
  assert.equal((await portKill.execute({ port: 5173 })).ok, true);
  const successText = renderText(portKill.output.render({}, { ok: true, killed: { port: 5173, pid: 100, name: 'node.exe' }, verifiedGone: true }));
  assert.match(successText, /Killed port 5173 listener: node\.exe \(pid 100\) - verified gone/);
  const refusal = await processKill.execute({ pid: 900, expectedName: 'lsass' });
  assert.equal(refusal.ok, false);
  const refusalText = renderText(processKill.output.render({}, refusal));
  assert.match(refusalText, /Refused: protected_process/);
  assert.match(refusalText, /Hint: lsass is system-critical/);
});

test('tool execute wraps unexpected service failures without throwing', async () => {
  /** @type {Record<string, (...args: any[]) => any>} */
  const throwing = {};
  for (const name of ['hostStats', 'portsList', 'staleDevProcesses', 'portKill', 'processKill']) {
    throwing[name] = async () => {
      throw new Error(`boom in ${name}`);
    };
  }
  const definitions = createToolDefinitions(throwing);
  for (const definition of definitions) {
    const value = await definition.execute({ port: 1, pid: 1 });
    assert.equal(value.ok, false);
    assert.equal(value.error, `${definition.name}_failed`);
    assert.match(value.hint, /boom/);
  }
});

test('kill tool arguments are normalized to numbers', async () => {
  const service = createFakeService();
  const definitions = createToolDefinitions(service);
  await definitions.find((tool) => tool.name === 'port_kill').execute({ port: '5173' });
  await definitions.find((tool) => tool.name === 'process_kill').execute({ pid: '100', expectedName: 'node' });
  assert.deepEqual(service.calls[0], ['portKill', 5173]);
  assert.deepEqual(service.calls[1], ['processKill', 100, 'node']);
});

test('renderers tolerate partial payloads', () => {
  assert.match(renderHostStats({ ok: true }), /Host: unknown/);
  assert.match(renderPortsList({ ok: true }), /TCP listeners: 0/);
  assert.match(renderStaleProcesses({ ok: true, entries: [] }), /no leftover dev servers/);
  assert.match(renderKillResult({ ok: false, error: 'no_listener' }), /Refused: no_listener/);
  assert.equal(KNOWN_DEV_PORTS.length, 5);
});
