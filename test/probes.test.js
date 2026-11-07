import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProbes } from '../lib/probes.js';
import { fixture } from './helpers.js';

/**
 * Build a fake command runner keyed by executable name.
 * @param {Record<string, any>} handlers
 */
function createFakeRunner(handlers) {
  const calls = [];
  return {
    calls,
    async run(command, args, options = {}) {
      calls.push({ command, args, options });
      const handler = handlers[command];
      if (handler === undefined) {
        return {
          ok: false,
          stdout: '',
          stderr: '',
          code: null,
          timedOut: false,
          error: `spawn ${command} ENOENT`,
          errorCode: 'ENOENT',
          durationMs: 0,
        };
      }
      return typeof handler === 'function' ? handler(command, args, options) : handler;
    },
  };
}

/** @param {string} stdout */
function okResult(stdout) {
  return {
    ok: true,
    stdout,
    stderr: '',
    code: 0,
    timedOut: false,
    error: null,
    errorCode: null,
    durationMs: 1,
  };
}

/** @param {string} errorCode @param {string} [error] */
function failResult(errorCode, error = errorCode) {
  return {
    ok: false,
    stdout: '',
    stderr: '',
    code: null,
    timedOut: false,
    error,
    errorCode,
    durationMs: 1,
  };
}

test('Windows process probe parses PowerShell output and caches it', async () => {
  const runner = createFakeRunner({ pwsh: okResult(fixture('win-processes.json')) });
  let now = 1000;
  const probes = createProbes({ commandRunner: runner, platform: 'win32', clock: () => now });
  const first = await probes.processTable();
  assert.equal(first.processes.length, 5);
  assert.equal(first.at, 1000);
  const second = await probes.processTable();
  assert.equal(second, first);
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].command, 'pwsh');
  assert.deepEqual(runner.calls[0].args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(runner.calls[0].args[3], /Win32_Process/);
  const fresh = await probes.processTable({ fresh: true });
  assert.equal(runner.calls.length, 2);
  assert.equal(fresh.at, 1000);
  now = 5000;
  await probes.processTable();
  assert.equal(runner.calls.length, 3);
});

test('PowerShell falls back from pwsh to powershell.exe and remembers the choice', async () => {
  const runner = createFakeRunner({
    pwsh: failResult('ENOENT', 'spawn pwsh ENOENT'),
    'powershell.exe': okResult(fixture('win-processes.json')),
  });
  const probes = createProbes({ commandRunner: runner, platform: 'win32' });
  const snapshot = await probes.processTable();
  assert.equal(snapshot.processes.length, 5);
  assert.deepEqual(runner.calls.map((call) => call.command), ['pwsh', 'powershell.exe']);
  await probes.processTable({ fresh: true });
  assert.deepEqual(runner.calls.map((call) => call.command), ['pwsh', 'powershell.exe', 'powershell.exe']);
});

test('failed probes fail closed with a note instead of throwing', async () => {
  const runner = createFakeRunner({ pwsh: failResult('EXIT_CODE', 'probe exited with code 1') });
  const probes = createProbes({ commandRunner: runner, platform: 'win32' });
  const snapshot = await probes.processTable();
  assert.deepEqual(snapshot.processes, []);
  const notes = probes.notes();
  assert.equal(notes.length, 1);
  assert.match(notes[0], /process_table_unavailable/);
  probes.clearNotes();
  assert.deepEqual(probes.notes(), []);
});

test('missing PowerShell executable is reported as a note', async () => {
  const runner = createFakeRunner({});
  const probes = createProbes({ commandRunner: runner, platform: 'win32' });
  const snapshot = await probes.processTable();
  assert.deepEqual(snapshot.processes, []);
  assert.match(probes.notes().join('\n'), /no PowerShell executable available/);
});

test('Windows listener probe parses and caches listeners', async () => {
  const runner = createFakeRunner({ pwsh: okResult(fixture('win-listeners.json')) });
  const probes = createProbes({ commandRunner: runner, platform: 'win32' });
  const snapshot = await probes.listeners();
  assert.equal(snapshot.listeners.length, 4);
  assert.deepEqual(snapshot.listeners.map((listener) => listener.port), [5173, 5554, 8787, 53365]);
  assert.match(runner.calls[0].args[3], /Get-NetTCPConnection/);
  await probes.listeners();
  assert.equal(runner.calls.length, 1);
});

test('Linux probes use ps, ss, and nvidia-smi directly', async () => {
  const runner = createFakeRunner({
    ps: okResult(fixture('ps-processes.txt')),
    ss: okResult(fixture('ss-listeners.txt')),
    'nvidia-smi': okResult(fixture('nvidia-smi.txt')),
  });
  const probes = createProbes({ commandRunner: runner, platform: 'linux' });
  const processes = await probes.processTable();
  assert.equal(processes.processes.length, 5);
  assert.equal(runner.calls[0].command, 'ps');
  assert.deepEqual(runner.calls[0].args, ['-eo', 'pid=,ppid=,pcpu=,rss=,time=,args=']);
  const listeners = await probes.listeners();
  assert.equal(listeners.listeners.length, 3);
  assert.equal(runner.calls[1].command, 'ss');
  const gpu = await probes.gpu();
  assert.equal(gpu?.name, 'NVIDIA GeForce RTX 3060');
  assert.equal(runner.calls[2].command, 'nvidia-smi');
});

test('macOS listener probe falls back from lsof to ss', async () => {
  const runner = createFakeRunner({
    lsof: failResult('ENOENT', 'spawn lsof ENOENT'),
    ss: okResult(fixture('ss-listeners.txt')),
  });
  const probes = createProbes({ commandRunner: runner, platform: 'darwin' });
  const snapshot = await probes.listeners();
  assert.equal(snapshot.listeners.length, 3);
  assert.deepEqual(runner.calls.map((call) => call.command), ['lsof', 'ss']);
});

test('GPU probe is best-effort and returns null on failure', async () => {
  const runner = createFakeRunner({});
  const probes = createProbes({ commandRunner: runner, platform: 'linux' });
  assert.equal(await probes.gpu(), null);
  assert.deepEqual(probes.notes(), []);
});

test('clearCache forces the next probe to run again', async () => {
  const runner = createFakeRunner({ pwsh: okResult(fixture('win-processes.json')) });
  const probes = createProbes({ commandRunner: runner, platform: 'win32' });
  await probes.processTable();
  await probes.processTable();
  assert.equal(runner.calls.length, 1);
  probes.clearCache();
  await probes.processTable();
  assert.equal(runner.calls.length, 2);
});
