/**
 * Bounded command runner.
 *
 * Every external probe goes through this module: `spawn` without a command
 * shell, a hard timeout that kills the child, and bounded captured output.
 * Probe arguments are passed as an argument vector, so they are never
 * interpreted by a shell.
 * @module host-health/command
 */

import { spawn } from 'node:child_process';
import { DEFAULT_LIMITS } from './constants.js';

/**
 * @typedef {import('./types.js').ProbeResult} ProbeResult
 * @typedef {import('./types.js').CommandRunner} CommandRunner
 */

/**
 * @typedef {object} SpawnOptions
 * @property {string[]} [args]
 * @property {string} [cwd]
 * @property {Record<string, string|undefined>} [env]
 * @property {boolean} [windowsHide]
 */

/**
 * @typedef {object} SpawnedProcess
 * @property {NodeJS.ReadableStream|null} stdout
 * @property {NodeJS.ReadableStream|null} stderr
 * @property {NodeJS.WritableStream|null} stdin
 * @property {number|null} pid
 * @property {(signal?: NodeJS.Signals) => boolean} kill
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} on
 */

/**
 * @typedef {(command: string, args: string[], options: SpawnOptions) => SpawnedProcess} SpawnImpl
 */

/**
 * Build a failed probe result.
 * @param {Partial<ProbeResult>} overrides
 * @returns {ProbeResult}
 */
function failedResult(overrides) {
  return {
    ok: false,
    stdout: '',
    stderr: '',
    code: null,
    timedOut: false,
    error: 'probe failed',
    errorCode: null,
    durationMs: 0,
    ...overrides,
  };
}

/**
 * @param {unknown} error
 * @returns {string|null}
 */
function errorCodeOf(error) {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = /** @type {{ code?: unknown }} */ (error).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    const json = JSON.stringify(error);
    return typeof json === 'string' ? json : String(error);
  } catch {
    return String(error);
  }
}

/**
 * Create a bounded command runner.
 * @param {{
 *   spawnImpl?: SpawnImpl,
 *   defaultTimeoutMs?: number,
 *   maxOutputBytes?: number,
 *   env?: Record<string, string|undefined>,
 *   platform?: string,
 * }} [options]
 * @returns {CommandRunner}
 */
export function createCommandRunner(options = {}) {
  const spawnImpl = options.spawnImpl ?? /** @type {SpawnImpl} */ (spawn);
  const platform = options.platform ?? process.platform;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_LIMITS.commandTimeoutMs;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_LIMITS.maxOutputBytes;
  const baseEnv = options.env ?? process.env;

  return {
    /**
     * Run one command to completion with a timeout and bounded output.
     * @param {string} command
     * @param {string[]} args
     * @param {{ timeoutMs?: number }} [runOptions]
     * @returns {Promise<ProbeResult>}
     */
    run(command, args, runOptions = {}) {
      const timeoutMs = runOptions.timeoutMs ?? defaultTimeoutMs;
      const startedAt = Date.now();
      return new Promise((resolve) => {
        /** @type {SpawnedProcess} */
        let child;
        try {
          child = spawnImpl(command, args, {
            cwd: undefined,
            windowsHide: true,
            env: { ...baseEnv },
          });
        } catch (error) {
          resolve(failedResult({ error: errorMessage(error), errorCode: errorCodeOf(error) }));
          return;
        }

        let stdout = '';
        let stderr = '';
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;
        let timedOut = false;
        let outputOverflow = false;
        /** @type {ReturnType<typeof setTimeout>|null} */
        let timer = null;

        /** @param {ProbeResult} result */
        const settle = (result) => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          result.durationMs = Date.now() - startedAt;
          resolve(result);
        };

        const append = (/** @type {'stdout'|'stderr'} */ stream, /** @type {Buffer|string} */ chunk) => {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          if (stream === 'stdout') {
            stdoutBytes += Buffer.byteLength(text, 'utf8');
            if (stdoutBytes <= maxOutputBytes) stdout += text;
            else outputOverflow = true;
          } else {
            stderrBytes += Buffer.byteLength(text, 'utf8');
            if (stderrBytes <= maxOutputBytes) stderr += text;
            else outputOverflow = true;
          }
          if (outputOverflow && !settled) {
            try {
              child.kill('SIGKILL');
            } catch {
              // The child may have exited between the check and the kill.
            }
          }
        };

        child.stdout?.on('data', (chunk) => append('stdout', chunk));
        child.stderr?.on('data', (chunk) => append('stderr', chunk));
        child.on('error', (error) => {
          settle(
            failedResult({
              stdout,
              stderr,
              error: errorMessage(error),
              errorCode: errorCodeOf(error),
            }),
          );
        });
        child.on('close', (code, signal) => {
          if (outputOverflow) {
            settle(
              failedResult({
                stdout,
                stderr,
                code: typeof code === 'number' ? code : null,
                error: `probe output exceeded ${maxOutputBytes} bytes and was stopped`,
                errorCode: 'OUTPUT_LIMIT',
              }),
            );
            return;
          }
          const numericCode = typeof code === 'number' ? code : null;
          const ok = !timedOut && numericCode === 0;
          settle({
            ok,
            stdout,
            stderr,
            code: numericCode,
            timedOut,
            error: ok
              ? null
              : timedOut
                ? `probe timed out after ${timeoutMs} ms`
                : `probe exited with code ${numericCode === null ? 'null' : numericCode}${signal ? ` (${signal})` : ''}`,
            errorCode: ok ? null : timedOut ? 'TIMEOUT' : 'EXIT_CODE',
            durationMs: 0,
          });
        });

        timer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // The child may already be gone; close/error will settle the probe.
          }
        }, timeoutMs);
        if (platform === 'win32' && typeof timer === 'object' && timer !== null && 'unref' in timer) {
          try {
            timer.unref();
          } catch {
            // unref is best-effort only.
          }
        }
      });
    },
  };
}
