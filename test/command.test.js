import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createCommandRunner, errorMessage } from '../lib/command.js';

/**
 * Build a fake spawn implementation driving one scripted child lifecycle.
 * @param {(child: any) => void} run
 */
function createFakeSpawn(run) {
  const calls = [];
  const killed = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = null;
    child.pid = 123;
    child.kill = (signal) => {
      killed.push(signal);
      // Real Node children close after a signal; emit it so the runner settles.
      queueMicrotask(() => child.emit('close', null, signal));
      return true;
    };
    queueMicrotask(() => run(child));
    return child;
  };
  return { calls, killed, spawnImpl };
}

test('successful probes capture stdout and stderr with no shell option', async () => {
  const fake = createFakeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('hello '));
    child.stdout.emit('data', Buffer.from('world'));
    child.stderr.emit('data', 'warn');
    child.emit('close', 0, null);
  });
  const runner = createCommandRunner({ spawnImpl: fake.spawnImpl, defaultTimeoutMs: 1000 });
  const result = await runner.run('pwsh', ['-NoProfile', '-Command', 'Write-Output hi']);
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'hello world');
  assert.equal(result.stderr, 'warn');
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, null);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].args, ['-NoProfile', '-Command', 'Write-Output hi']);
  assert.equal(fake.calls[0].options.shell, undefined);
  assert.equal(fake.calls[0].options.windowsHide, true);
});

test('nonzero exits become structured failures', async () => {
  const fake = createFakeSpawn((child) => {
    child.stdout.emit('data', 'partial');
    child.emit('close', 3, null);
  });
  const runner = createCommandRunner({ spawnImpl: fake.spawnImpl });
  const result = await runner.run('ps', ['-ef']);
  assert.equal(result.ok, false);
  assert.equal(result.code, 3);
  assert.equal(result.errorCode, 'EXIT_CODE');
  assert.match(result.error ?? '', /exited with code 3/);
  assert.equal(result.stdout, 'partial');
});

test('spawn errors (EPERM in a sandbox) settle without throwing', async () => {
  const fake = createFakeSpawn((child) => {
    const error = Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
    child.emit('error', error);
  });
  const runner = createCommandRunner({ spawnImpl: fake.spawnImpl });
  const result = await runner.run('pwsh', ['-Command', 'x']);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'EPERM');
  assert.equal(result.code, null);
  assert.match(result.error ?? '', /EPERM/);
});

test('synchronous spawn throws settle without throwing', async () => {
  const runner = createCommandRunner({
    spawnImpl() {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    },
  });
  const result = await runner.run('missing', []);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'ENOENT');
});

test('timeouts kill the child and report timedOut', async () => {
  const fake = createFakeSpawn(() => {
    // The child never exits on its own; the runner's timeout must kill it.
  });
  const runner = createCommandRunner({ spawnImpl: fake.spawnImpl, defaultTimeoutMs: 20 });
  const result = await runner.run('pwsh', ['-Command', 'Start-Sleep 99']);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.errorCode, 'TIMEOUT');
  assert.match(result.error ?? '', /timed out after 20 ms/);
  assert.deepEqual(fake.killed, ['SIGKILL']);
});

test('oversized output is stopped and reported as a limit failure', async () => {
  const fake = createFakeSpawn((child) => {
    child.stdout.emit('data', Buffer.alloc(64, 0x61));
    child.emit('close', 0, null);
  });
  const runner = createCommandRunner({ spawnImpl: fake.spawnImpl, maxOutputBytes: 10 });
  const result = await runner.run('ps', ['-ef']);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'OUTPUT_LIMIT');
  assert.match(result.error ?? '', /exceeded 10 bytes/);
  assert.deepEqual(fake.killed, ['SIGKILL']);
});

test('errorMessage normalizes unknown thrown values', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage('text'), 'text');
  assert.equal(errorMessage({ a: 1 }), '{"a":1}');
  assert.equal(errorMessage(undefined), 'undefined');
});
