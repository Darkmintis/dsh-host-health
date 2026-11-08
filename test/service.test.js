import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHostService } from '../lib/service.js';
import {
  createFakeControl,
  createFakeProbes,
  createFakeSystem,
  createTestClock,
  makeListenerSnapshot,
  makeProcess,
  makeProcessSnapshot,
} from './helpers.js';

const START = 1_000_000;
const HOUR = 60 * 60 * 1000;

/**
 * Build a service with deterministic fakes.
 * @param {Record<string, any>} [overrides]
 */
function createHarness(overrides = {}) {
  const clock = createTestClock(overrides.start ?? START);
  const control = createFakeControl({
    alive: overrides.alive ?? [100, 200, 300],
    selfPid: overrides.selfPid ?? 4242,
    parentPid: overrides.parentPid ?? 1,
    killError: overrides.killError,
  });
  control.sleep = clock.sleep;
  const probes = createFakeProbes({
    processTables: overrides.processTables,
    listeners: overrides.listeners,
    gpu: overrides.gpu,
    systemSnapshots: overrides.systemSnapshots,
  });
  if (overrides.probeNotes !== undefined) probes.notes = () => overrides.probeNotes;
  const system = createFakeSystem(overrides.system);
  const service = createHostService({
    system,
    probes,
    control,
    clock: clock.now,
    limits: {
      cpuSampleMs: 100,
      killVerifyMs: 300,
      killPollMs: 100,
      ...(overrides.limits ?? {}),
    },
    thresholds: overrides.thresholds,
  });
  return { service, clock, control, probes, system };
}

const tableA = makeProcessSnapshot(START, [
  makeProcess({ pid: 100, name: 'node.exe', ramBytes: 400 * 1024 * 1024, cpuMs: 1000, commandLine: 'node vite --port 5173' }),
  makeProcess({ pid: 200, name: 'chrome.exe', ramBytes: 800 * 1024 * 1024, cpuMs: 2000, commandLine: 'chrome.exe' }),
  makeProcess({ pid: 300, name: 'explorer.exe', ramBytes: 100 * 1024 * 1024, cpuMs: 500, commandLine: 'explorer.exe' }),
]);
const tableB = makeProcessSnapshot(START + 100, [
  makeProcess({ pid: 100, name: 'node.exe', ramBytes: 400 * 1024 * 1024, cpuMs: 1100, commandLine: 'node vite --port 5173' }),
  makeProcess({ pid: 200, name: 'chrome.exe', ramBytes: 800 * 1024 * 1024, cpuMs: 2200, commandLine: 'chrome.exe' }),
  makeProcess({ pid: 300, name: 'explorer.exe', ramBytes: 100 * 1024 * 1024, cpuMs: 600, commandLine: 'explorer.exe' }),
]);
const gpuFixture = [{ name: 'NVIDIA GeForce RTX 3060', vramTotalMb: 12288, vramUsedMb: 4096, utilizationPercent: 37 }];

test('hostStats assembles host fields, CPU deltas, top lists, highlights, and thresholds', async () => {
  const { service } = createHarness({
    processTables: [tableA, tableB],
    gpu: gpuFixture,
    system: {
      memory: () => ({
        totalBytes: 16 * 1024 ** 3,
        freeBytes: 1.6 * 1024 ** 3,
        usedBytes: 14.4 * 1024 ** 3,
        usedPercent: 90,
      }),
    },
  });
  const value = await service.hostStats({ includeGpu: true });
  assert.equal(value.ok, true);
  assert.equal(value.pluginVersion, '0.1.0');
  assert.equal(value.host.hostname, 'test-host');
  assert.equal(value.host.platform, 'win32');
  assert.equal(value.host.cpuCount, 4);
  assert.equal(value.host.uptimeSeconds, 7200);
  // Aggregate CPU: idle +100 of total +200 => 50%.
  assert.equal(value.cpu.percent, 50);
  assert.equal(value.memory.usedPercent, 90);
  assert.equal(value.disk?.freePercent, 40);
  assert.deepEqual(value.load, [1.5, 1.2, 1]);
  assert.equal(value.gpu.name, 'NVIDIA GeForce RTX 3060');
  assert.equal(value.gpuStatus, 'available');
  assert.equal(value.warnings.length, 1);
  assert.equal(value.warnings[0].code, 'ram_high');
  assert.equal(value.thresholds.ramPercent, 85);

  // Top RAM: chrome (800 MB) then node (400 MB); CPU: node 25% then chrome 25%.
  assert.equal(value.topRam[0].pid, 200);
  assert.equal(value.topRam[0].ramMb, 800);
  assert.equal(value.topRam[1].pid, 100);
  const node = value.topCpu.find((process) => process.pid === 100);
  assert.ok(node);
  assert.equal(node.cpuPercent, 25);
  assert.match(node.commandLine, /vite/);
  assert.equal(value.devProcesses.length, 2);
  const preview = value.devProcesses.find((process) => process.pid === 100);
  assert.ok(preview);
  assert.equal(preview.kind, 'preview-server');
  assert.equal(preview.pid, 100);
});

test('hostStats takes one bounded second sample on the first call and reuses snapshots', async () => {
  const { service, probes } = createHarness({ processTables: [tableA, tableB] });
  await service.hostStats({ includeGpu: false });
  assert.equal(probes.calls.processTable, 2);
  assert.equal(probes.calls.freshProcessTable, 1);
  await service.hostStats({ includeGpu: false });
  assert.equal(probes.calls.processTable, 3);
  assert.equal(probes.calls.freshProcessTable, 1);
});

test('hostStats can skip processes and GPU', async () => {
  const { service, probes } = createHarness({ processTables: [tableA, tableB] });
  const value = await service.hostStats({ includeProcesses: false, includeGpu: false });
  assert.equal(value.ok, true);
  assert.deepEqual(value.topRam, []);
  assert.deepEqual(value.devProcesses, []);
  assert.equal(value.gpu, null);
  assert.equal(value.gpuStatus, 'skipped');
  assert.equal(probes.calls.processTable, 0);
});

test('hostStats marks an unavailable GPU explicitly', async () => {
  const { service } = createHarness({ processTables: [tableA, tableB] });
  const value = await service.hostStats({ includeGpu: true });
  assert.equal(value.ok, true);
  assert.equal(value.gpu, null);
  assert.equal(value.gpuStatus, 'unavailable');
});

test('hostStats forwards probe notes and survives a missing disk', async () => {
  const { service } = createHarness({
    processTables: [tableA, tableB],
    probeNotes: ['process_table_unavailable: powershell missing'],
    system: { disk: async () => null },
  });
  const value = await service.hostStats({ includeGpu: false });
  assert.equal(value.ok, true);
  assert.equal(value.disk, null);
  assert.match(value.notes.join('\n'), /process_table_unavailable/);
});

test('hostStats excludes the host and parent from dev highlights', async () => {
  const processes = [
    makeProcess({ pid: 100, name: 'node.exe', commandLine: 'node vite --port 5173' }),
    makeProcess({ pid: 4242, name: 'node.exe', commandLine: 'node vite --port 4242' }),
    makeProcess({ pid: 1, name: 'pwsh.exe', commandLine: 'pwsh -Command node vite' }),
  ];
  const snapshot = makeProcessSnapshot(START, processes);
  const second = makeProcessSnapshot(START + 100, processes);
  const { service } = createHarness({ processTables: [snapshot, second] });
  const value = await service.hostStats({ includeGpu: false });
  assert.deepEqual(value.devProcesses.map((process) => process.pid), [100]);
});

test('portsList lists listeners, joins names, and flags known and requested ports', async () => {
  const names = makeProcessSnapshot(START, [
    makeProcess({ pid: 100, name: 'node.exe' }),
    makeProcess({ pid: 101, name: 'node.exe' }),
    makeProcess({ pid: 102, name: 'python.exe' }),
  ]);
  const { service } = createHarness({
    processTables: [names],
    listeners: [
      makeListenerSnapshot(START, [
        { address: '127.0.0.1', port: 5173, pid: 100 },
        { address: '0.0.0.0', port: 8787, pid: 101 },
        { address: '0.0.0.0', port: 3000, pid: 102 },
      ]),
    ],
  });
  const value = await service.portsList({ ports: [3000] });
  assert.equal(value.ok, true);
  assert.equal(value.available, true);
  assert.equal(value.source, 'powershell');
  assert.equal(value.pluginVersion, '0.1.0');
  assert.deepEqual(value.listeners.map((listener) => listener.port), [3000, 5173, 8787]);
  assert.equal(value.listeners[0].name, 'python.exe');
  assert.equal(value.knownDevPorts.length, 5);
  const flaggedByPort = new Map(value.flagged.map((entry) => [entry.port, entry]));
  assert.equal(flaggedByPort.get(5173).status, 'in_use');
  assert.equal(flaggedByPort.get(5173).name, 'node.exe');
  assert.equal(flaggedByPort.get(5173).knownDevPort, true);
  assert.equal(flaggedByPort.get(5554).status, 'free');
  assert.equal(flaggedByPort.get(3000).status, 'in_use');
  const warningPorts = value.warnings.map((warning) => warning.message).join('\n');
  assert.match(warningPorts, /Port 5173/);
  assert.match(warningPorts, /Port 3000/);
});

test('portsList reports an unavailable listener probe instead of zero listeners', async () => {
  const { service } = createHarness({
    processTables: [tableA],
    listeners: [
      makeListenerSnapshot(START, [], { available: false, source: null }),
    ],
    probeNotes: ['listener_probe_unavailable: primary probe timed out; netstat fallback failed'],
  });
  const value = await service.portsList({ ports: [3000] });
  assert.equal(value.ok, true);
  assert.equal(value.available, false);
  assert.equal(value.source, null);
  assert.deepEqual(value.listeners, []);
  assert.deepEqual(value.warnings, []);
  assert.deepEqual(value.flagged.map((entry) => entry.status), Array(6).fill('unknown'));
  assert.match(value.notes.join('\n'), /listener_probe_unavailable/);
  assert.match(value.notes.join('\n'), /unavailable/);
});

test('portsList rejects invalid ports and unsupported platforms', async () => {
  const { service } = createHarness({ processTables: [tableA] });
  const invalid = await service.portsList({ ports: [0] });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, 'invalid_port');
  const unsupported = createHarness({ system: { platform: 'freebsd' } }).service;
  const value = await unsupported.portsList({});
  assert.equal(value.ok, false);
  assert.equal(value.error, 'unsupported_platform');
});

test('portsList truncates very long listener tables', async () => {
  const listeners = Array.from({ length: 90 }, (_, index) => ({
    address: '0.0.0.0',
    port: 10000 + index,
    pid: 100 + index,
  }));
  const { service } = createHarness({
    processTables: [tableA],
    listeners: [makeListenerSnapshot(START, listeners)],
    limits: { maxListeners: 5 },
  });
  const value = await service.portsList({});
  assert.equal(value.ok, true);
  assert.equal(value.listeners.length, 5);
  assert.equal(value.truncated, 85);
  assert.match(value.notes.join('\n'), /truncated/);
});

test('staleDevProcesses classifies leftover dev processes with suggested targets', async () => {
  const processes = [
    makeProcess({
      pid: 100,
      name: 'node.exe',
      startedAt: new Date(START - 2 * HOUR).toISOString(),
      commandLine: 'node C:/workspace/app/node_modules/vite/bin/vite.js --port 8787',
    }),
    makeProcess({
      pid: 101,
      name: 'java.exe',
      startedAt: new Date(START - 4 * HOUR).toISOString(),
      commandLine: 'java -Dorg.gradle.appname=gradle GradleDaemon',
    }),
    makeProcess({
      pid: 102,
      name: 'explorer.exe',
      commandLine: 'explorer.exe',
    }),
    makeProcess({
      pid: 4242,
      name: 'node.exe',
      startedAt: new Date(START - 2 * HOUR).toISOString(),
      commandLine: 'node C:/workspace/app/node_modules/vite/bin/vite.js --port 4242',
    }),
  ];
  const snapshot = makeProcessSnapshot(START, processes);
  const second = makeProcessSnapshot(START + 100, processes);
  const { service } = createHarness({
    processTables: [snapshot, second],
    listeners: [makeListenerSnapshot(START, [{ address: '127.0.0.1', port: 8787, pid: 100 }])],
  });
  const value = await service.staleDevProcesses();
  assert.equal(value.ok, true);
  assert.equal(value.listenerProbeAvailable, true);
  assert.equal(value.listenerSource, 'powershell');
  assert.equal(value.count, 2);
  assert.equal(value.entries.some((entry) => entry.pid === 4242), false);
  const preview = value.entries.find((entry) => entry.pid === 100);
  assert.ok(preview);
  assert.equal(preview.stale, true);
  assert.deepEqual(preview.suggested, {
    tool: 'port_kill',
    args: { port: 8787 },
    note: 'Frees port 8787 and re-verifies the listener identity immediately before killing.',
  });
  const gradle = value.entries.find((entry) => entry.pid === 101);
  assert.ok(gradle);
  assert.equal(gradle.suggested.tool, 'process_kill');
});

test('staleDevProcesses fails on unsupported platforms', async () => {
  const { service } = createHarness({ system: { platform: 'freebsd' } });
  const value = await service.staleDevProcesses();
  assert.equal(value.ok, false);
  assert.equal(value.error, 'unsupported_platform');
});

test('staleDevProcesses still works without a listener probe and says so', async () => {
  const processes = [
    makeProcess({
      pid: 100,
      name: 'node.exe',
      startedAt: new Date(START - 2 * HOUR).toISOString(),
      commandLine: 'node node_modules/vite/bin/vite.js',
    }),
  ];
  const snapshot = makeProcessSnapshot(START, processes);
  const second = makeProcessSnapshot(START + 100, processes);
  const { service } = createHarness({
    processTables: [snapshot, second],
    listeners: [makeListenerSnapshot(START, [], { available: false, source: null })],
    probeNotes: ['listener_probe_unavailable: both probes failed'],
  });
  const value = await service.staleDevProcesses();
  assert.equal(value.ok, true);
  assert.equal(value.listenerProbeAvailable, false);
  assert.equal(value.listenerSource, null);
  assert.equal(value.entries[0].suggested.tool, 'process_kill');
  assert.equal(value.entries[0].port, null);
  assert.match(value.notes.join('\n'), /listener table is unavailable/);
});

test('portKill kills through a netstat-sourced listener table', async () => {
  const table = makeProcessSnapshot(START, [makeProcess({ pid: 100, name: 'node.exe', startedAt: '2026-11-08T00:00:00Z' })]);
  const first = makeListenerSnapshot(START, [{ address: '127.0.0.1', port: 5173, pid: 100 }], {
    source: 'netstat',
  });
  const recheck = makeListenerSnapshot(START + 1, [{ address: '127.0.0.1', port: 5173, pid: 100 }], {
    source: 'netstat',
  });
  const { service, control } = createHarness({
    alive: [100],
    processTables: [table],
    listeners: [first, recheck],
  });
  const value = await service.portKill(5173);
  assert.equal(value.ok, true);
  assert.equal(value.listenerSource, 'netstat');
  assert.equal(value.verifiedGone, true);
  assert.equal(control.alive.has(100), false);
});

test('portKill refuses when the listener probe is unavailable', async () => {
  const unavailable = makeListenerSnapshot(START, [], { available: false, source: null });
  const { service, control } = createHarness({
    alive: [100],
    processTables: [tableA],
    listeners: [unavailable, unavailable],
  });
  const value = await service.portKill(5173);
  assert.equal(value.ok, false);
  assert.equal(value.error, 'listener_probe_unavailable');
  assert.match(value.hint, /Refusing to kill blind/);
  assert.equal(control.alive.has(100), true);
});

test('portKill refuses when re-verification loses the listener probe', async () => {
  const table = makeProcessSnapshot(START, [makeProcess({ pid: 100, name: 'node.exe' })]);
  const first = makeListenerSnapshot(START, [{ address: '127.0.0.1', port: 5173, pid: 100 }]);
  const lost = makeListenerSnapshot(START + 1, [], { available: false, source: null });
  const { service, control } = createHarness({ alive: [100], processTables: [table], listeners: [first, lost] });
  const value = await service.portKill(5173);
  assert.equal(value.ok, false);
  assert.equal(value.error, 'listener_probe_unavailable');
  assert.equal(control.alive.has(100), true);
});

test('portKill kills the verified listener and reports verification', async () => {
  const table = makeProcessSnapshot(START, [makeProcess({ pid: 100, name: 'node.exe', startedAt: '2026-11-08T00:00:00Z' })]);
  const first = makeListenerSnapshot(START, [{ address: '127.0.0.1', port: 5173, pid: 100 }]);
  const recheck = makeListenerSnapshot(START + 1, [{ address: '127.0.0.1', port: 5173, pid: 100 }]);
  const { service, control } = createHarness({
    alive: [100],
    processTables: [table],
    listeners: [first, recheck],
  });
  const value = await service.portKill(5173);
  assert.equal(value.ok, true);
  assert.deepEqual(value.killed, { port: 5173, pid: 100, name: 'node.exe' });
  assert.equal(value.verifiedGone, true);
  assert.equal(value.method, 'SIGTERM');
  assert.equal(control.alive.has(100), false);
});

test('portKill refuses when no listener owns the port', async () => {
  const { service } = createHarness({ listeners: [makeListenerSnapshot(START, [])], processTables: [tableA] });
  const value = await service.portKill(5173);
  assert.equal(value.ok, false);
  assert.equal(value.error, 'no_listener');
});

test('portKill refuses ambiguous listeners', async () => {
  const { service } = createHarness({
    listeners: [
      makeListenerSnapshot(START, [
        { address: '127.0.0.1', port: 5173, pid: 100 },
        { address: '[::1]', port: 5173, pid: 200 },
      ]),
    ],
    processTables: [tableA],
  });
  const value = await service.portKill(5173);
  assert.equal(value.ok, false);
  assert.equal(value.error, 'ambiguous_listener');
  assert.deepEqual(value.details.pids, [100, 200]);
});

test('portKill refuses protected PIDs before killing', async () => {
  const table = makeProcessSnapshot(START, [makeProcess({ pid: 8, name: 'System', startedAt: null })]);
  const listeners = makeListenerSnapshot(START, [{ address: '0.0.0.0', port: 5173, pid: 8 }]);
  const { service, control } = createHarness({ alive: [8], processTables: [table], listeners: [listeners, listeners] });
  const value = await service.portKill(5173);
  assert.equal(value.ok, false);
  assert.equal(value.error, 'protected_pid');
  assert.equal(control.alive.has(8), true);
});

test('portKill aborts when the listener identity changed', async () => {
  const table = makeProcessSnapshot(START, [makeProcess({ pid: 100, name: 'node.exe' })]);
  const first = makeListenerSnapshot(START, [{ address: '127.0.0.1', port: 5173, pid: 100 }]);
  const second = makeListenerSnapshot(START + 1, [{ address: '127.0.0.1', port: 5173, pid: 200 }]);
  const { service, control } = createHarness({ alive: [100, 200], processTables: [table], listeners: [first, second] });
  const value = await service.portKill(5173);
  assert.equal(value.ok, false);
  assert.equal(value.error, 'identity_changed');
  assert.equal(control.alive.has(100), true);
});

test('portKill reports process_not_found and access_denied', async () => {
  const listeners = makeListenerSnapshot(START, [{ address: '127.0.0.1', port: 5173, pid: 100 }]);
  const missing = createHarness({ listeners: [listeners, listeners], processTables: [makeProcessSnapshot(START, [])] });
  assert.equal((await missing.service.portKill(5173)).error, 'process_not_found');

  const table = makeProcessSnapshot(START, [makeProcess({ pid: 100, name: 'node.exe' })]);
  const denied = createHarness({
    alive: [100],
    listeners: [listeners, listeners],
    processTables: [table],
    killError: Object.assign(new Error('EPERM'), { code: 'EPERM' }),
  });
  const value = await denied.service.portKill(5173);
  assert.equal(value.ok, false);
  assert.equal(value.error, 'access_denied');
  assert.match(value.hint, /administrator rights/);
});

test('portKill reports when the process survives the verify window', async () => {
  const table = makeProcessSnapshot(START, [makeProcess({ pid: 100, name: 'node.exe' })]);
  const listeners = makeListenerSnapshot(START, [{ address: '127.0.0.1', port: 5173, pid: 100 }]);
  const { service, control } = createHarness({ alive: [100], processTables: [table], listeners: [listeners, listeners] });
  control.kill = () => {
    // Simulate an elevated process that ignores the signal.
  };
  const value = await service.portKill(5173);
  assert.equal(value.ok, true);
  assert.equal(value.verifiedGone, false);
  assert.match(value.notes.join('\n'), /still visible/);
});

test('portKill validates its port argument', async () => {
  const { service } = createHarness({ processTables: [tableA] });
  for (const port of [0, -1, 70000, 1.5, Number.NaN]) {
    const value = await service.portKill(port);
    assert.equal(value.ok, false);
    assert.equal(value.error, 'invalid_port');
  }
});

test('processKill kills a verified process and honors expectedName', async () => {
  const identity = makeProcess({ pid: 200, name: 'chrome.exe', startedAt: '2026-11-08T00:00:00Z' });
  const table = makeProcessSnapshot(START, [identity]);
  const recheck = makeProcessSnapshot(START + 1, [identity]);
  const { service, control } = createHarness({ alive: [200], processTables: [table, recheck] });
  const value = await service.processKill(200, 'chrome');
  assert.equal(value.ok, true);
  assert.equal(value.killed.pid, 200);
  assert.equal(value.killed.name, 'chrome.exe');
  assert.equal(value.verifiedGone, true);
  assert.equal(control.alive.has(200), false);
});

test('processKill refuses identity mismatch, protected names, and self', async () => {
  const chrome = makeProcess({ pid: 200, name: 'chrome.exe' });
  const lsass = makeProcess({ pid: 201, name: 'lsass.exe' });
  const self = makeProcess({ pid: 4242, name: 'node.exe' });
  const table = makeProcessSnapshot(START, [chrome, lsass, self]);
  const mismatch = createHarness({ alive: [200], processTables: [table] });
  const mismatchValue = await mismatch.service.processKill(200, 'node');
  assert.equal(mismatchValue.ok, false);
  assert.equal(mismatchValue.error, 'identity_mismatch');

  const protectedValue = await createHarness({ alive: [201], processTables: [table] }).service.processKill(201);
  assert.equal(protectedValue.ok, false);
  assert.equal(protectedValue.error, 'protected_process');

  const selfValue = await createHarness({ alive: [4242], processTables: [table] }).service.processKill(4242);
  assert.equal(selfValue.ok, false);
  assert.equal(selfValue.error, 'self_protected');
});

test('processKill aborts on PID reuse and missing processes', async () => {
  const first = makeProcessSnapshot(START, [makeProcess({ pid: 300, name: 'node.exe', startedAt: '2026-11-08T00:00:00Z' })]);
  const reused = makeProcessSnapshot(START + 1, [makeProcess({ pid: 300, name: 'chrome.exe', startedAt: '2026-11-08T00:00:00Z' })]);
  const { service } = createHarness({ alive: [300], processTables: [first, reused] });
  const value = await service.processKill(300);
  assert.equal(value.ok, false);
  assert.equal(value.error, 'identity_changed');

  const missing = await createHarness({ processTables: [makeProcessSnapshot(START, [])] }).service.processKill(999);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'process_not_found');

  const invalid = await createHarness({ processTables: [first] }).service.processKill(0);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, 'invalid_pid');
});

test('processKill reports kill failures as structured values', async () => {
  const table = makeProcessSnapshot(START, [makeProcess({ pid: 200, name: 'chrome.exe' })]);
  const denied = createHarness({
    alive: [200],
    processTables: [table],
    killError: Object.assign(new Error('EPERM'), { code: 'EPERM' }),
  });
  const value = await denied.service.processKill(200);
  assert.equal(value.ok, false);
  assert.equal(value.error, 'access_denied');

  const gone = createHarness({
    alive: [200],
    processTables: [table],
    killError: Object.assign(new Error('gone'), { code: 'ESRCH' }),
  });
  const goneValue = await gone.service.processKill(200);
  assert.equal(goneValue.ok, false);
  assert.equal(goneValue.error, 'process_not_found');
});

test('unsupported platforms fail closed for process-based tools', async () => {
  const { service } = createHarness({ system: { platform: 'freebsd' } });
  const killValue = await service.portKill(5173);
  assert.equal(killValue.error, 'unsupported_platform');
  const processValue = await service.processKill(123);
  assert.equal(processValue.error, 'unsupported_platform');
  const stats = await service.hostStats({ includeGpu: false });
  assert.equal(stats.ok, true);
  assert.match(stats.notes.join('\n'), /platform "freebsd"/);
});


test('hostStats prefers the system snapshot for memory, cores, volumes, battery, and process count', async () => {
  const { service } = createHarness({
    processTables: [tableA, tableB],
    systemSnapshots: [
      {
        memory: {
          totalBytes: 16 * 1024 ** 3,
          freeBytes: 8 * 1024 ** 3,
          availableBytes: 8 * 1024 ** 3,
          usedBytes: 8 * 1024 ** 3,
          usedPercent: 50,
          committedBytes: 9 * 1024 ** 3,
          commitLimitBytes: 24 * 1024 ** 3,
          cacheBytes: 2 * 1024 ** 3,
        },
        cpu: { totalPercent: 37, perCore: [{ index: 0, percent: 20 }, { index: 1, percent: 54 }] },
        volumes: [
          { path: 'C:', totalBytes: 500 * 1024 ** 3, freeBytes: 200 * 1024 ** 3, usedBytes: 300 * 1024 ** 3, usedPercent: 60, freePercent: 40 },
          { path: 'D:', totalBytes: 100 * 1024 ** 3, freeBytes: 10 * 1024 ** 3, usedBytes: 90 * 1024 ** 3, usedPercent: 90, freePercent: 10 },
        ],
        battery: { percent: 85, charging: true, runtimeMinutes: null },
        processCount: 321,
      },
    ],
  });
  const value = await service.hostStats({ includeGpu: false });
  assert.equal(value.ok, true);
  assert.equal(value.memory.usedPercent, 50);
  assert.equal(value.memory.committedBytes, 9 * 1024 ** 3);
  assert.equal(value.cpu.percent, 37);
  assert.deepEqual(value.cpu.perCore, [{ index: 0, percent: 20 }, { index: 1, percent: 54 }]);
  assert.equal(value.volumes.length, 2);
  assert.equal(value.disk.path, 'C:');
  assert.equal(value.disk.freePercent, 40);
  assert.equal(value.battery.percent, 85);
  assert.equal(value.battery.charging, true);
  assert.equal(value.host.processCount, 321);
});