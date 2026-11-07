import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkKillTarget,
  createProcessControl,
  normalizeProcessName,
  processExists,
  sameProcessIdentity,
} from '../lib/kill.js';
import { makeProcess } from './helpers.js';

test('normalizeProcessName strips directories and .exe', () => {
  assert.equal(normalizeProcessName('C:\\Windows\\System32\\LSASS.EXE'), 'lsass');
  assert.equal(normalizeProcessName('node.exe'), 'node');
  assert.equal(normalizeProcessName(' System '), 'system');
});

test('checkKillTarget refuses invalid, protected, self, and parent PIDs', () => {
  assert.equal(checkKillTarget({ pid: 0, name: 'x' }).safe, false);
  assert.equal(checkKillTarget({ pid: -5, name: 'x' }).safe, false);
  assert.equal(checkKillTarget({ pid: 1.5, name: 'x' }).safe, false);
  const kernel = checkKillTarget({ pid: 4, name: 'System' });
  assert.equal(kernel.safe, false);
  assert.equal(kernel.code, 'protected_pid');
  const systemProcess = checkKillTarget({ pid: 900, name: 'lsass.exe' });
  assert.equal(systemProcess.safe, false);
  assert.equal(systemProcess.code, 'protected_process');
  const self = checkKillTarget({ pid: 500, name: 'node.exe', selfPid: 500 });
  assert.equal(self.safe, false);
  assert.equal(self.code, 'self_protected');
  const parent = checkKillTarget({ pid: 700, name: 'pwsh.exe', parentPid: 700 });
  assert.equal(parent.safe, false);
  assert.equal(parent.code, 'parent_protected');
});

test('checkKillTarget accepts ordinary user processes', () => {
  assert.deepEqual(checkKillTarget({ pid: 1234, name: 'node.exe', selfPid: 4242, parentPid: 1 }), { safe: true });
  assert.deepEqual(checkKillTarget({ pid: 4243, name: 'qemu-system-x86_64.exe' }), { safe: true });
  assert.deepEqual(checkKillTarget({ pid: 4244, name: 'svchost.exe' }).safe, false);
});

test('processExists identifies the current process and invalid PIDs', () => {
  assert.equal(processExists(process.pid), true);
  assert.equal(processExists(-1), false);
});

test('createProcessControl exposes the host pid and a no-op-capable surface', () => {
  const control = createProcessControl({ selfPid: 111, parentPid: 222 });
  assert.equal(control.selfPid, 111);
  assert.equal(control.parentPid, 222);
  assert.equal(typeof control.exists, 'function');
  assert.equal(typeof control.kill, 'function');
  assert.equal(typeof control.sleep, 'function');
  assert.equal(control.exists(process.pid), true);
});

test('sameProcessIdentity detects PID reuse and missing processes', () => {
  const expected = makeProcess({ pid: 10, name: 'node.exe', startedAt: '2026-11-08T00:00:00Z' });
  assert.equal(sameProcessIdentity(expected, { ...expected }), true);
  assert.equal(sameProcessIdentity(expected, makeProcess({ pid: 10, name: 'chrome.exe', startedAt: '2026-11-08T00:00:00Z' })), false);
  assert.equal(sameProcessIdentity(expected, makeProcess({ pid: 10, name: 'node.exe', startedAt: '2026-11-08T01:00:00Z' })), false);
  assert.equal(sameProcessIdentity(expected, undefined), false);
  assert.equal(sameProcessIdentity(undefined, expected), false);
});
