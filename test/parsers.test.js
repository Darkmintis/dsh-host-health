import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  asArray,
  normalizeWindowsProcess,
  parseJsonOutput,
  parseLsofListeners,
  parseNvidiaSmi,
  parsePsProcesses,
  parsePsTime,
  parseSsListeners,
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
