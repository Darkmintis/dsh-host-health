import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ageMinutes,
  classifyProcess,
  collectDevHighlights,
  collectStaleCandidates,
  formatAge,
  isHarnessProcess,
  isKnownDevProcessName,
  listenersByPid,
  shorten,
} from '../lib/devprocess.js';
import { makeProcess } from './helpers.js';

const now = Date.parse('2026-11-08T02:00:00.000Z');

test('isHarnessProcess recognizes harness command lines', () => {
  assert.equal(isHarnessProcess('node /opt/@deepseek-ai/dsh/lib/index.js'), true);
  assert.equal(isHarnessProcess('node C:\\deepseek-harness\\app.js'), true);
  assert.equal(isHarnessProcess('node vite.js'), false);
  assert.equal(isHarnessProcess(''), false);
});

test('isKnownDevProcessName normalizes extension and prefix', () => {
  assert.equal(isKnownDevProcessName('node.exe'), true);
  assert.equal(isKnownDevProcessName('qemu-system-x86_64'), true);
  assert.equal(isKnownDevProcessName('dart.exe'), true);
  assert.equal(isKnownDevProcessName('explorer.exe'), false);
});

test('classifyProcess matches the specific dev categories', () => {
  const preview = classifyProcess(makeProcess({ pid: 1, commandLine: 'node vite --port 5173' }));
  assert.equal(preview?.category, 'preview-server');
  const gradle = classifyProcess(makeProcess({ pid: 2, name: 'java.exe', commandLine: 'java GradleDaemon' }));
  assert.equal(gradle?.category, 'gradle-daemon');
  const flutter = classifyProcess(makeProcess({ pid: 3, name: 'dart.exe', commandLine: 'dart run lib/main.dart' }));
  assert.equal(flutter?.category, 'flutter-run');
  const emulator = classifyProcess(makeProcess({ pid: 4, name: 'qemu-system-x86_64.exe', commandLine: 'qemu-system-x86_64 -avd Pixel' }));
  assert.equal(emulator?.category, 'android-emulator');
  const plain = classifyProcess(makeProcess({ pid: 5, name: 'notepad.exe', commandLine: 'notepad.exe notes.txt' }));
  assert.equal(plain, null);
});

test('classifyProcess excludes the harness and attaches listener ports', () => {
  const harness = classifyProcess(makeProcess({ pid: 9, commandLine: 'node C:/x/@deepseek-ai/dsh/index.js vite' }));
  assert.equal(harness, null);
  const ports = listenersByPid([{ address: '127.0.0.1', port: 8787, pid: 11 }]);
  const withPort = classifyProcess(makeProcess({ pid: 11, commandLine: 'node vite preview' }), { ports });
  assert.equal(withPort?.port, 8787);
});

test('collectDevHighlights keeps named dev tools without the harness', () => {
  const listeners = [{ address: '127.0.0.1', port: 5554, pid: 30 }];
  const processes = [
    { ...makeProcess({ pid: 10, name: 'node.exe', commandLine: 'node vite' }), cpuPercent: 1 },
    { ...makeProcess({ pid: 20, name: 'chrome.exe', commandLine: 'chrome' }), cpuPercent: 2 },
    { ...makeProcess({ pid: 30, name: 'qemu-system-x86_64.exe', commandLine: 'qemu-system-x86_64 -avd x' }), cpuPercent: 3 },
    { ...makeProcess({ pid: 40, name: 'node.exe', commandLine: 'node @deepseek-ai/dsh' }), cpuPercent: 4 },
    { ...makeProcess({ pid: 50, name: 'explorer.exe', commandLine: 'explorer' }), cpuPercent: 5 },
  ];
  const highlights = collectDevHighlights(processes, listeners, 10);
  assert.deepEqual(highlights.map((entry) => entry.pid), [10, 20, 30]);
  assert.equal(highlights[2].port, 5554);
  assert.equal(highlights[0].kind, 'preview-server');
});

test('ageMinutes and formatAge are tolerant', () => {
  assert.equal(ageMinutes('2026-11-08T01:00:00.000Z', now), 60);
  assert.equal(ageMinutes('2026-11-08T03:00:00.000Z', now), 0);
  assert.equal(ageMinutes(null, now), null);
  assert.equal(ageMinutes('not-a-date', now), null);
  assert.equal(formatAge(5), '5 min');
  assert.equal(formatAge(120), '2 h');
  assert.equal(formatAge(60 * 24 * 3), '3 d');
});

test('shorten collapses whitespace and truncates', () => {
  assert.equal(shorten('  a   b  '), 'a b');
  assert.equal(shorten('abcdef', 5), 'ab...');
  assert.equal(shorten('abc'), 'abc');
});

test('collectStaleCandidates classifies and ranks dev-process leftovers', () => {
  const processes = [
    makeProcess({
      pid: 100,
      name: 'node.exe',
      ramBytes: 200 * 1024 * 1024,
      startedAt: '2026-11-08T00:30:00.000Z',
      commandLine: 'node C:/workspace/app/node_modules/vite/bin/vite.js --port 8787',
    }),
    makeProcess({
      pid: 101,
      name: 'java.exe',
      ramBytes: 500 * 1024 * 1024,
      startedAt: '2026-11-07T20:00:00.000Z',
      commandLine: 'java -Dorg.gradle.appname=gradle GradleDaemon',
    }),
    makeProcess({
      pid: 102,
      name: 'qemu-system-x86_64.exe',
      ramBytes: 2048 * 1024 * 1024,
      startedAt: '2026-11-08T01:40:00.000Z',
      commandLine: 'qemu-system-x86_64 -avd Pixel_6',
    }),
    makeProcess({ pid: 103, name: 'explorer.exe', commandLine: 'explorer.exe' }),
    makeProcess({ pid: 104, name: 'node.exe', commandLine: 'node @deepseek-ai/dsh/index.js' }),
  ];
  const candidates = collectStaleCandidates({
    processes,
    listeners: [
      { address: '127.0.0.1', port: 8787, pid: 100 },
      { address: '127.0.0.1', port: 5554, pid: 102 },
    ],
    now,
  });
  assert.equal(candidates.length, 3);
  const preview = candidates.find((candidate) => candidate.pid === 100);
  assert.ok(preview);
  assert.equal(preview.category, 'preview-server');
  assert.equal(preview.stale, true);
  assert.equal(preview.confidence, 'high');
  assert.equal(preview.port, 8787);
  assert.equal(preview.suggested.tool, 'port_kill');
  assert.deepEqual(preview.suggested.args, { port: 8787 });
  const gradle = candidates.find((candidate) => candidate.pid === 101);
  assert.ok(gradle);
  assert.equal(gradle.stale, true);
  assert.equal(gradle.suggested.tool, 'process_kill');
  const emulator = candidates.find((candidate) => candidate.pid === 102);
  assert.ok(emulator);
  assert.equal(emulator.stale, false);
  assert.equal(emulator.port, 5554);
});

test('collectStaleCandidates respects the stale threshold and entry limit', () => {
  const processes = [
    makeProcess({
      pid: 100,
      name: 'node.exe',
      startedAt: '2026-11-08T01:59:00.000Z',
      commandLine: 'node node_modules/vite/bin/vite.js',
    }),
  ];
  const fresh = collectStaleCandidates({ processes, listeners: [], now });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].stale, false);
  assert.equal(fresh[0].confidence, 'low');
  const limited = collectStaleCandidates({
    processes: [
      ...processes,
      makeProcess({ pid: 200, name: 'node.exe', commandLine: 'node some-preview-server' }),
    ],
    listeners: [],
    now,
    limit: 1,
  });
  assert.equal(limited.length, 1);
});

test('collectStaleCandidates excludes the harness host and parent PIDs', () => {
  const processes = [
    makeProcess({ pid: 100, name: 'node.exe', commandLine: 'node vite preview' }),
    makeProcess({ pid: 4242, name: 'node.exe', commandLine: 'node vite preview' }),
    makeProcess({ pid: 900, name: 'pwsh.exe', commandLine: 'pwsh -Command node vite preview' }),
  ];
  const candidates = collectStaleCandidates({
    processes,
    listeners: [],
    now,
    excludePids: [4242, 900],
  });
  assert.deepEqual(candidates.map((candidate) => candidate.pid), [100]);
});
