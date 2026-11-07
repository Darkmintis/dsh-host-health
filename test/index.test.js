import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, inject, name } from '../index.js';
import { createFakeHostContext } from './helpers.js';

test('apply registers the five tools and the approval listener', () => {
  const { ctx, registrations, listeners, effectLabels } = createFakeHostContext();
  apply(ctx, {});
  assert.deepEqual(
    registrations.map((definition) => definition.name),
    ['host_stats', 'ports_list', 'stale_dev_processes', 'port_kill', 'process_kill'],
  );
  assert.equal(registrations.length, 5);
  assert.equal(effectLabels.length, 5);
  assert.equal(typeof listeners.get('tools/pre-execute'), 'function');
  assert.deepEqual(inject, ['tools']);
  assert.equal(name, '@darkmintis/dsh-host-health');
});

test('apply accepts an empty or malformed config without throwing', () => {
  for (const config of [undefined, null, {}, { cacheTtlMs: -1 }, { thresholds: { ramPercent: 'high' } }, 'nope']) {
    const { ctx, registrations } = createFakeHostContext();
    assert.doesNotThrow(() => apply(ctx, config));
    assert.equal(registrations.length, 5);
  }
});

test('read-only tools never ask for approval', async () => {
  const { ctx, listeners } = createFakeHostContext();
  apply(ctx, {});
  const preExecute = listeners.get('tools/pre-execute');
  assert.ok(preExecute);
  let nextCalled = 0;
  const next = async () => {
    nextCalled += 1;
    return { kind: 'allow' };
  };
  for (const tool of ['host_stats', 'ports_list', 'stale_dev_processes', 'unknown_tool']) {
    const decision = await preExecute({ name: tool, arguments: {} }, next);
    assert.deepEqual(decision, { kind: 'allow' });
  }
  assert.equal(nextCalled, 4);
});

test('destructive tools return an approval request with a clear reason', async () => {
  const { ctx, listeners } = createFakeHostContext();
  apply(ctx, {});
  const preExecute = listeners.get('tools/pre-execute');
  assert.ok(preExecute);
  const next = async () => ({ kind: 'allow' });

  const portDecision = await preExecute({ name: 'port_kill', arguments: { port: 5173 } }, next);
  assert.equal(portDecision.kind, 'ask');
  assert.match(portDecision.reason, /TCP port 5173/);
  assert.match(portDecision.reason, /cannot be undone/);
  assert.match(portDecision.reason, /re-checked/);

  const processDecision = await preExecute({ name: 'process_kill', arguments: { pid: 4321 } }, next);
  assert.equal(processDecision.kind, 'ask');
  assert.match(processDecision.reason, /PID 4321/);
});

test('destructive tools with invalid targets skip the prompt and let the tool validate', async () => {
  const { ctx, listeners } = createFakeHostContext();
  apply(ctx, {});
  const preExecute = listeners.get('tools/pre-execute');
  assert.ok(preExecute);
  let nextCalled = 0;
  const next = async () => {
    nextCalled += 1;
    return { kind: 'allow' };
  };
  for (const args of [{ port: 0 }, { port: 'abc' }, {}]) {
    const decision = await preExecute({ name: 'port_kill', arguments: args }, next);
    assert.deepEqual(decision, { kind: 'allow' });
  }
  const pidDecision = await preExecute({ name: 'process_kill', arguments: { pid: -3 } }, next);
  assert.deepEqual(pidDecision, { kind: 'allow' });
  assert.equal(nextCalled, 4);
});

test('the approval listener tolerates missing arguments', async () => {
  const { ctx, listeners } = createFakeHostContext();
  apply(ctx, {});
  const preExecute = listeners.get('tools/pre-execute');
  assert.ok(preExecute);
  const next = async () => ({ kind: 'allow' });
  assert.deepEqual(await preExecute({ name: 'port_kill' }, next), { kind: 'allow' });
  assert.deepEqual(await preExecute({ name: 'process_kill', arguments: null }, next), { kind: 'allow' });
});
