import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProbes } from '../lib/probes.js';
import { createHostService } from '../lib/service.js';
import { DEFAULT_LIMITS } from '../lib/constants.js';
import { createFakeControl, createFakeSystem, createTestClock, fixture } from './helpers.js';

/**
 * @param {string} stdout
 * @returns {import('../lib/types.js').ProbeResult}
 */
function okResult(stdout) {
  return { ok: true, stdout, stderr: '', code: 0, timedOut: false, error: null, errorCode: null, durationMs: 1 };
}

/**
 * @param {string} errorCode
 * @param {string} error
 * @returns {import('../lib/types.js').ProbeResult}
 */
function failResult(errorCode, error) {
  return { ok: false, stdout: '', stderr: '', code: null, timedOut: errorCode === 'TIMEOUT', error, errorCode, durationMs: 1 };
}

/**
 * Fake child-process runner wired to the real probe layer, so service→probes
 * timeout/fallback wiring is exercised end to end instead of via fake probes.
 * @param {{ listener?: import('../lib/types.js').ProbeResult, netstat?: import('../lib/types.js').ProbeResult }} [overrides]
 */
function createFixtureRunner(overrides = {}) {
  /** @type {Array<{ command: string, args: string[], options: Record<string, any> }>} */
  const calls = [];
  return {
    calls,
    async run(command, args, options = {}) {
      calls.push({ command, args, options });
      const script = args[args.length - 1] ?? '';
      if (command === 'pwsh' || command === 'powershell.exe') {
        if (script.includes('Get-NetTCPConnection')) {
          return overrides.listener ?? failResult('TIMEOUT', 'probe timed out after 15000 ms');
        }
        if (script.includes('Win32_Process')) return okResult(fixture('win-processes.json'));
        return failResult('EXIT_CODE', 'unexpected PowerShell script');
      }
      if (command === 'netstat') return overrides.netstat ?? okResult(fixture('netstat-listeners.txt'));
      return failResult('ENOENT', `spawn ${command} ENOENT`);
    },
  };
}

/**
 * Wire the real probe layer and service with deterministic system/control/clock.
 * @param {{ listener?: import('../lib/types.js').ProbeResult, netstat?: import('../lib/types.js').ProbeResult }} [overrides]
 */
function createWiredHarness(overrides = {}) {
  const clock = createTestClock(1_000_000);
  const control = createFakeControl({ alive: [1234, 4242], selfPid: 4242, parentPid: 1 });
  control.sleep = clock.sleep;
  const runner = createFixtureRunner(overrides);
  const probes = createProbes({ commandRunner: runner, platform: 'win32', clock: clock.now });
  const system = createFakeSystem();
  const service = createHostService({
    system,
    probes,
    control,
    clock: clock.now,
    limits: { cpuSampleMs: 100 },
  });
  return { service, probes, runner, clock, control };
}

test('stale_dev_processes uses the bounded listener timeout and netstat fallback', async () => {
  const { service, runner } = createWiredHarness();
  const value = await service.staleDevProcesses();
  assert.equal(value.ok, true);
  assert.equal(value.pluginVersion, '0.1.0');
  assert.equal(DEFAULT_LIMITS.listenerTimeoutMs, 15000);
  assert.equal(value.listenerProbeAvailable, true);
  assert.equal(value.listenerSource, 'netstat');

  const listenerCalls = runner.calls.filter(
    (call) => call.command === 'pwsh' && String(call.args[3]).includes('Get-NetTCPConnection'),
  );
  assert.ok(listenerCalls.length >= 1, 'the listener probe ran through PowerShell');
  for (const call of listenerCalls) {
    assert.equal(
      call.options.timeoutMs,
      DEFAULT_LIMITS.listenerTimeoutMs,
      'the listener probe must use listenerTimeoutMs, not the generic command timeout',
    );
    assert.notEqual(call.options.timeoutMs, DEFAULT_LIMITS.commandTimeoutMs);
  }
  const netstatCall = runner.calls.find((call) => call.command === 'netstat');
  assert.ok(netstatCall, 'the netstat fallback ran');
  assert.deepEqual(netstatCall.args, ['-ano', '-p', 'tcp']);
  assert.equal(netstatCall.options.timeoutMs, DEFAULT_LIMITS.netstatTimeoutMs);

  const preview = value.entries.find((entry) => entry.pid === 1234);
  assert.ok(preview, 'the preview server is a stale candidate');
  assert.equal(preview.port, 5173);
  assert.equal(preview.suggested.tool, 'port_kill');
  assert.deepEqual(preview.suggested.args, { port: 5173 });
  assert.match(value.notes.join('\n'), /listener_probe_fallback/);
});

test('stale_dev_processes reports both listener failures and keeps process_kill suggestions', async () => {
  const { service } = createWiredHarness({
    listener: failResult('TIMEOUT', 'probe timed out after 15000 ms'),
    netstat: failResult('EXIT_CODE', 'probe exited with code 1'),
  });
  const value = await service.staleDevProcesses();
  assert.equal(value.ok, true);
  assert.equal(value.listenerProbeAvailable, false);
  assert.equal(value.listenerSource, null);
  const notes = value.notes.join('\n');
  assert.match(notes, /listener_probe_unavailable/);
  assert.match(notes, /probe timed out after 15000 ms/);
  assert.match(notes, /netstat fallback failed/);
  assert.match(notes, /listener table is unavailable/);
  const candidates = value.entries.filter((entry) => entry.pid === 1234 || entry.pid === 3333 || entry.pid === 4444);
  assert.ok(candidates.length > 0);
  for (const candidate of candidates) {
    assert.equal(candidate.port, null);
    assert.equal(candidate.suggested.tool, 'process_kill');
  }
});

test('stale_dev_processes reuses the listener snapshot cached by a recent ports_list', async () => {
  const { service, runner } = createWiredHarness();
  const ports = await service.portsList({ ports: [8787] });
  assert.equal(ports.ok, true);
  assert.equal(ports.available, true);
  assert.equal(ports.source, 'netstat');

  const listenerCallsBefore = runner.calls.filter(
    (call) => call.command === 'pwsh' && String(call.args[3]).includes('Get-NetTCPConnection'),
  ).length;
  const stale = await service.staleDevProcesses();
  assert.equal(stale.ok, true);
  assert.equal(stale.listenerSource, 'netstat');
  const listenerCallsAfter = runner.calls.filter(
    (call) => call.command === 'pwsh' && String(call.args[3]).includes('Get-NetTCPConnection'),
  ).length;
  assert.equal(listenerCallsAfter, listenerCallsBefore, 'the cached listener snapshot is reused');
  const netstatCalls = runner.calls.filter((call) => call.command === 'netstat');
  assert.equal(netstatCalls.length, 1, 'the fallback probe ran once and was cached');
});

test('ports_list uses the same bounded listener timeout and fallback', async () => {
  const { service, runner } = createWiredHarness();
  const value = await service.portsList({ ports: [8787] });
  assert.equal(value.ok, true);
  assert.equal(value.available, true);
  assert.equal(value.source, 'netstat');
  const listenerCalls = runner.calls.filter(
    (call) => call.command === 'pwsh' && String(call.args[3]).includes('Get-NetTCPConnection'),
  );
  assert.ok(listenerCalls.length >= 1);
  for (const call of listenerCalls) assert.equal(call.options.timeoutMs, DEFAULT_LIMITS.listenerTimeoutMs);
  assert.ok(value.flagged.some((entry) => entry.port === 8787 && entry.status === 'in_use'));
});
