/**
 * Kill safety and process control.
 *
 * Safety rules are deliberately conservative and checked twice: once right
 * after the approval prompt resolves and once again in the same fresh probe
 * window that the kill executes from. Kills never use a shell, never kill a
 * process tree, and never request elevation.
 * @module host-health/kill
 */

import { MIN_PROTECTED_PID, PROTECTED_PROCESS_NAMES } from './constants.js';

/**
 * @typedef {import('./types.js').ProcessInfo} ProcessInfo
 * @typedef {import('./types.js').ProcessControl} ProcessControl
 */

/**
 * @typedef {object} KillRefusal
 * @property {false} safe
 * @property {string} code Stable refusal code.
 * @property {string} reason Human-readable refusal.
 */

/**
 * @typedef {object} KillApproval
 * @property {true} safe
 */

/**
 * Normalize a process name for comparison: lowercase, no directory, no `.exe`.
 * @param {string} name
 * @returns {string}
 */
export function normalizeProcessName(name) {
  const base = name.trim().toLowerCase().split(/[\\/]/).pop() ?? '';
  return base.endsWith('.exe') ? base.slice(0, -4) : base;
}

/**
 * Check whether a pid/process pair is safe to kill.
 * @param {{ pid: number, name: string, selfPid?: number, parentPid?: number }} target
 * @returns {KillRefusal|KillApproval}
 */
export function checkKillTarget(target) {
  const pid = target.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { safe: false, code: 'invalid_pid', reason: 'PID must be a positive integer.' };
  }
  if (pid <= MIN_PROTECTED_PID) {
    return {
      safe: false,
      code: 'protected_pid',
      reason: `PID ${pid} is a Windows kernel or platform process and is never killed.`,
    };
  }
  if (typeof target.selfPid === 'number' && pid === target.selfPid) {
    return {
      safe: false,
      code: 'self_protected',
      reason: 'Refusing to kill the DeepSeek Harness host process that is running this tool.',
    };
  }
  if (typeof target.parentPid === 'number' && target.parentPid > 0 && pid === target.parentPid) {
    return {
      safe: false,
      code: 'parent_protected',
      reason: 'Refusing to kill the parent process that launched the DeepSeek Harness host.',
    };
  }
  const name = normalizeProcessName(target.name);
  if (name !== '' && PROTECTED_PROCESS_NAMES.includes(name)) {
    return {
      safe: false,
      code: 'protected_process',
      reason: `"${target.name}" is a system-critical process and is never killed.`,
    };
  }
  return { safe: true };
}

/**
 * Whether a PID refers to a running process.
 * @param {number} pid
 * @returns {boolean}
 */
export function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error
      ? /** @type {{ code?: unknown }} */ (error).code
      : null;
    return code === 'EPERM';
  }
}

/**
 * Terminate one process with `SIGTERM` (Node maps it to TerminateProcess on
 * Windows). No tree kill, no shell, no elevation attempt.
 * @param {number} pid
 * @returns {void}
 */
export function terminateProcess(pid) {
  process.kill(pid, 'SIGTERM');
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Create the real process control adapter.
 * @param {{ selfPid?: number, parentPid?: number }} [options]
 * @returns {ProcessControl}
 */
export function createProcessControl(options = {}) {
  return {
    exists: processExists,
    kill: terminateProcess,
    sleep,
    selfPid: options.selfPid ?? process.pid,
    parentPid: options.parentPid ?? process.ppid,
  };
}

/**
 * Whether two identity snapshots describe the same process. A pid can be
 * reused; a name change (or a vanished pid) means the approved target is gone.
 * @param {ProcessInfo|undefined} expected
 * @param {ProcessInfo|undefined} actual
 * @returns {boolean}
 */
export function sameProcessIdentity(expected, actual) {
  if (expected === undefined || actual === undefined) return false;
  if (expected.pid !== actual.pid) return false;
  if (normalizeProcessName(expected.name) !== normalizeProcessName(actual.name)) return false;
  if (expected.startedAt !== null && actual.startedAt !== null && expected.startedAt !== actual.startedAt) return false;
  return true;
}
