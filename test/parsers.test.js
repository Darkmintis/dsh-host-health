import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  asArray,
  normalizeWindowsProcess,
  parseJsonOutput,
  parseLsofListeners,
  parseNetstatListeners,
  parseNvidiaSmi,
  parsePsProcesses,
  parsePsTime,
  parseSsListeners,
  parseSystemSnapshot,
  parseWindowsListeners,
  parseWindowsProcesses,
} from '../lib/parsers.js';
import { fixture } from './helpers.js';

test('parseJsonOutput tolerates empty and malformed output', () => {
  assert.equal(parseJsonOutput(''), null);
  assert.equal(parseJsonOutput('   '), null);
  assert.equal(parseJsonOutput('not json'), null);
  assert.deepEqual(parseJsonOutput('{"a":1}'), { a: 1 });
});

test('asArray wraps single records and drops nullish values', () => {
  assert.deepEqual(asArray({ a: 1 }), [{ a: 1 }]);
  assert.deepEqual(asArray([1, 2]), [1, 2]);
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray(undefined), []);
});

test('normalizeWindowsProcess keeps valid rows and rejects unusable ones', () => {
  const normalized = normalizeWindowsProcess({ pid: 123, name: ' node.exe ', ramBytes: 1024, cpuMs: 5, commandLine: 'node x' });
  assert.ok(normalized);
  assert.equal(normalized.pid, 123);
  assert.equal(normalized.name, 'node.exe');
  assert.equal(normalized.ramBytes, 1024);
  assert.equal(normalized.cpuMs, 5);
  assert.equal(normalizeWindowsProcess({ pid: 0, name: 'x' }), null);
  assert.equal(normalizeWindowsProcess({ pid: 'abc', name: 'x' }), null);
  assert.equal(normalizeWindowsProcess({ pid: 5, name: '' }), null);
});

test('parseWindowsProcesses parses the PowerShell process-table fixture', () => {
  const parsed = parseWindowsProcesses(fixture('win-processes.json'));
  assert.equal(parsed.length, 5);
  assert.deepEqual(parsed.map((process) => process.pid), [4, 1234, 2222, 3333, 4444]);
  const node = parsed.find((process) => process.pid === 1234);
  assert.ok(node);
  assert.equal(node.name, 'node.exe');
  assert.equal(node.ramBytes, 268435456);
  assert.equal(node.cpuMs, 45000);
  assert.match(node.commandLine, /vite/);
});

test('parseWindowsProcesses accepts a single serialized object and skips junk rows', () => {
  const single = parseWindowsProcesses(JSON.stringify({ pid: 77, name: 'node.exe', ramBytes: 1 }));
  assert.equal(single.length, 1);
  assert.equal(single[0].pid, 77);
  const mixed = parseWindowsProcesses(JSON.stringify([null, 'nope', { pid: 88, name: 'bun' }, { pid: -1, name: 'x' }]));
  assert.deepEqual(mixed.map((process) => process.pid), [88]);
  assert.deepEqual(parseWindowsProcesses(''), []);
});

test('parsePsTime handles seconds, minutes, hours, and days formats', () => {
  assert.equal(parsePsTime('00:02:00'), 120000);
  assert.equal(parsePsTime('1:02:03'), 3723000);
  assert.equal(parsePsTime('2-01:02:03'), (2 * 24 * 60 * 60 + 3723) * 1000);
  assert.equal(parsePsTime('12:34'), 754000);
  assert.equal(parsePsTime('0:00.50'), 500);
  assert.equal(parsePsTime('garbage'), null);
  assert.equal(parsePsTime(''), null);
});

test('parsePsProcesses parses ps output and derives names from command lines', () => {
  const parsed = parsePsProcesses(fixture('ps-processes.txt'));
  assert.equal(parsed.length, 5);
  const node = parsed.find((process) => process.pid === 1234);
  assert.ok(node);
  assert.equal(node.name, 'node');
  assert.equal(node.ramBytes, 262144 * 1024);
  assert.equal(node.cpuMs, 45000);
  assert.equal(node.pcpu, 2.5);
  assert.match(node.commandLine, /vite/);
  const gradle = parsed.find((process) => process.pid === 5555);
  assert.ok(gradle);
  assert.equal(gradle.cpuMs, 3723000);
  assert.equal(parsePsProcesses('').length, 0);
  assert.equal(parsePsProcesses('garbage line\n').length, 0);
});

test('parseWindowsListeners parses and dedupes listener rows', () => {
  const parsed = parseWindowsListeners(fixture('win-listeners.json'));
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed.map((listener) => listener.port), [5173, 5554, 8787, 53365]);
  const duplicated = parseWindowsListeners(
    JSON.stringify([
      { address: '0.0.0.0', port: 5173, pid: 10 },
      { address: '0.0.0.0', port: 5173, pid: 10 },
    ]),
  );
  assert.equal(duplicated.length, 1);
  const invalid = parseWindowsListeners(JSON.stringify([{ port: 0, pid: 1 }, { port: 70000, pid: 2 }]));
  assert.equal(invalid.length, 0);
});

test('parseSsListeners parses Linux ss -ltnpH output', () => {
  const parsed = parseSsListeners(fixture('ss-listeners.txt'));
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map((listener) => listener.port), [5173, 8000, 8787]);
  const node = parsed.find((listener) => listener.port === 5173);
  assert.ok(node);
  assert.equal(node.pid, 1234);
  assert.equal(node.address, '127.0.0.1');
  const v6 = parsed.find((listener) => listener.port === 8787);
  assert.ok(v6);
  assert.equal(v6.address, '::');
  assert.equal(v6.pid, 2345);
  const noProcess = parsed.find((listener) => listener.port === 8000);
  assert.ok(noProcess);
  assert.equal(noProcess.pid, 0);
});

test('parseNetstatListeners parses LISTENING rows and ignores other states', () => {
  const parsed = parseNetstatListeners(fixture('netstat-listeners.txt'));
  assert.deepEqual(parsed.map((listener) => listener.port), [135, 135, 5173, 8000, 8787, 53365]);
  const vite = parsed.find((listener) => listener.port === 5173);
  assert.ok(vite);
  assert.equal(vite.pid, 1234);
  assert.equal(vite.address, '127.0.0.1');
  const preview = parsed.find((listener) => listener.port === 8787);
  assert.ok(preview);
  assert.equal(preview.pid, 2345);
  const ipv6 = parsed.find((listener) => listener.port === 135 && listener.address === '::');
  assert.ok(ipv6);
  assert.equal(ipv6.pid, 812);
  assert.equal(parsed.some((listener) => listener.port === 5353), false);
  assert.equal(parsed.filter((listener) => listener.port === 5173).length, 1);
});

test('parseNetstatListeners accepts localized state words via the zero foreign port', () => {
  const parsed = parseNetstatListeners(
    ['TCP    0.0.0.0:9000           0.0.0.0:0              ABHOEREN        777', 'TCP    0.0.0.0:9001   10.0.0.5:443   HERGESTELLT     778'].join('\r\n'),
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].port, 9000);
  assert.equal(parsed[0].pid, 777);
});

test('parseNetstatListeners ignores headers, UDP, and malformed rows', () => {
  assert.deepEqual(parseNetstatListeners(''), []);
  assert.deepEqual(
    parseNetstatListeners(
      [
        'Active Connections',
        '  Proto  Local Address          Foreign Address        State           PID',
        '  UDP    0.0.0.0:5353           *:*                                    900',
        '  TCP    0.0.0.0:12345          0.0.0.0:0              LISTENING',
        '  TCP    not-an-address         0.0.0.0:0              LISTENING       42',
      ].join('\n'),
    ),
    [],
  );
});

test('parseLsofListeners parses macOS lsof output', () => {
  const parsed = parseLsofListeners(fixture('lsof-listeners.txt'));
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((listener) => listener.port), [5173, 8787]);
  assert.equal(parsed[0].pid, 1234);
  assert.equal(parsed[0].address, '127.0.0.1');
  assert.equal(parsed[1].address, '*');
});

test('parseNvidiaSmi parses the query-gpu CSV fixture', () => {
  const gpu = parseNvidiaSmi(fixture('nvidia-smi.txt'));
  assert.ok(gpu);
  assert.equal(gpu.name, 'NVIDIA GeForce RTX 3060');
  assert.equal(gpu.vramTotalMb, 12288);
  assert.equal(gpu.vramUsedMb, 4096);
  assert.equal(gpu.utilizationPercent, 37);
  assert.equal(parseNvidiaSmi(''), null);
  assert.equal(parseNvidiaSmi('garbage'), null);
});


test('parseSystemSnapshot reads Task-Manager memory, cores, volumes, and battery', () => {
  const snapshot = parseSystemSnapshot(
    JSON.stringify({
      totalBytes: 16_000_000_000,
      freeBytes: 4_000_000_000,
      availableBytes: 5_000_000_000,
      committedBytes: 9_000_000_000,
      commitLimitBytes: 20_000_000_000,
      cacheBytes: 2_000_000_000,
      processCount: 321,
      cores: [
        { name: '_Total', percent: 42 },
        { name: '1', percent: 10 },
        { name: '0', percent: 90 },
      ],
      volumes: [
        { path: 'C:', total: 500_000_000_000, free: 200_000_000_000 },
        { path: 'D:', total: 100_000_000_000, free: 0 },
      ],
      battery: { percent: 85, status: 2, runtimeMinutes: 0 },
    }),
  );
  assert.ok(snapshot);
  assert.equal(snapshot.memory.totalBytes, 16_000_000_000);
  assert.equal(snapshot.memory.freeBytes, 5_000_000_000, 'available memory wins over free memory');
  assert.equal(snapshot.memory.usedBytes, 11_000_000_000);
  assert.equal(snapshot.memory.usedPercent, 68.8);
  assert.equal(snapshot.memory.committedBytes, 9_000_000_000);
  assert.equal(snapshot.cpu.totalPercent, 42);
  assert.deepEqual(snapshot.cpu.perCore, [
    { index: 0, percent: 90 },
    { index: 1, percent: 10 },
  ]);
  assert.equal(snapshot.volumes.length, 2);
  assert.equal(snapshot.volumes[0].freePercent, 40);
  assert.equal(snapshot.volumes[0].usedPercent, 60);
  assert.equal(snapshot.volumes[1].freePercent, 0);
  assert.equal(snapshot.battery.percent, 85);
  assert.equal(snapshot.battery.charging, true, 'BatteryStatus 2 means on AC');
  assert.equal(snapshot.battery.runtimeMinutes, null, 'unknown runtime is dropped');
  assert.equal(snapshot.processCount, 321);
});

test('parseSystemSnapshot tolerates partial and malformed output', () => {
  assert.equal(parseSystemSnapshot(''), null);
  assert.equal(parseSystemSnapshot('not json'), null);
  const partial = parseSystemSnapshot(JSON.stringify({ totalBytes: 0, cores: 'nope', volumes: [{ path: '', total: 0 }], battery: { percent: 'x' } }));
  assert.ok(partial);
  assert.equal(partial.memory, null);
  assert.deepEqual(partial.cpu.perCore, []);
  assert.deepEqual(partial.volumes, []);
  assert.equal(partial.battery, null);
});