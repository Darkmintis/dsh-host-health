/**
 * Host probes for the data Node builtins cannot provide: the process table,
 * TCP listeners, and a best-effort NVIDIA GPU reading.
 *
 * Windows uses bounded PowerShell child processes (the DSH host process can
 * query CIM; a sandboxed shell cannot, so failures are returned as notes).
 * macOS/Linux use `ps`, `ss`, or `lsof` directly. Expensive results are cached
 * for a couple of seconds so polling tools stay cheap.
 * @module host-health/probes
 */

import { DEFAULT_LIMITS } from './constants.js';
import { createCache } from './cache.js';
import { errorMessage } from './command.js';
import {
  parseLsofListeners,
  parseNetstatListeners,
  parseNvidiaSmi,
  parsePsProcesses,
  parseSsListeners,
  parseWindowsListeners,
  parseWindowsProcesses,
} from './parsers.js';
import { listenerScript, processTableScript } from './powershell.js';

/**
 * @typedef {import('./types.js').CommandRunner} CommandRunner
 * @typedef {import('./types.js').ProbeResult} ProbeResult
 * @typedef {import('./types.js').ProcessSnapshot} ProcessSnapshot
 * @typedef {import('./types.js').ListenerSnapshot} ListenerSnapshot
 * @typedef {import('./types.js').GpuInfo} GpuInfo
 * @typedef {import('./types.js').ProcessInfo} ProcessInfo
 * @typedef {import('./types.js').PortListener} PortListener
 */

/** @typedef {'processes'|'listeners'|'gpu'} ProbeCacheKey */

/**
 * @typedef {object} Probes
 * @property {(options?: { fresh?: boolean }) => Promise<ProcessSnapshot>} processTable
 * @property {(options?: { fresh?: boolean }) => Promise<ListenerSnapshot>} listeners
 * @property {(options?: { fresh?: boolean }) => Promise<GpuInfo|null>} gpu
 * @property {() => void} clearCache
 * @property {() => void} clearNotes
 * @property {() => string[]} notes
 */

/**
 * @typedef {object} CreateProbesOptions
 * @property {CommandRunner} commandRunner
 * @property {string} [platform]
 * @property {number} [cacheTtlMs]
 * @property {number} [gpuCacheTtlMs]
 * @property {number} [commandTimeoutMs]
 * @property {number} [listenerTimeoutMs]
 * @property {number} [netstatTimeoutMs]
 * @property {() => number} [clock]
 * @property {string[]} [powershellCandidates]
 */

/**
 * Build a failed snapshot message without throwing.
 * @param {string} label
 * @param {ProbeResult} result
 * @returns {string}
 */
function failureNote(label, result) {
  const detail = result.error ?? errorMessage(result.stderr || 'unknown probe failure');
  return `${label} probe failed: ${detail}`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Create the injectable probe set.
 * @param {CreateProbesOptions} options
 * @returns {Probes & { notes: () => string[] }}
 */
export function createProbes(options) {
  const commandRunner = options.commandRunner;
  const platform = options.platform ?? process.platform;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_LIMITS.cacheTtlMs;
  const gpuCacheTtlMs = options.gpuCacheTtlMs ?? DEFAULT_LIMITS.gpuCacheTtlMs;
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_LIMITS.commandTimeoutMs;
  const listenerTimeoutMs = options.listenerTimeoutMs ?? DEFAULT_LIMITS.listenerTimeoutMs;
  const netstatTimeoutMs = options.netstatTimeoutMs ?? DEFAULT_LIMITS.netstatTimeoutMs;
  const clock = options.clock ?? Date.now;
  const cache = createCache({ now: clock });
  const powershellCandidates =
    options.powershellCandidates ??
    (platform === 'win32' ? ['pwsh', 'powershell.exe'] : ['pwsh']);

  /** @type {string|null} */
  let shellCommand = null;
  /** @type {'powershell'|'netstat'|'ss'|'lsof'|null} */
  let listenerPreference = null;
  /** @type {string|null} */
  let lastPrimaryListenerFailure = null;
  /** @type {string[]} */
  const notes = [];

  /**
   * Run one PowerShell script through the first working host executable.
   * @param {string} script
   * @param {string} label
   * @param {{ timeoutMs?: number }} [runOptions]
   * @returns {Promise<{ ok: boolean, stdout: string, note: string|null }>}
   */
  async function runPowerShell(script, label, runOptions = {}) {
    const timeoutMs = runOptions.timeoutMs ?? commandTimeoutMs;
    /** @type {string[]} */
    const candidates = shellCommand === null ? powershellCandidates : [shellCommand];
    /** @type {ProbeResult|null} */
    let last = null;
    let allMissing = true;
    for (const candidate of candidates) {
      const result = await commandRunner.run(
        candidate,
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeoutMs },
      );
      last = result;
      if (result.ok) {
        shellCommand = candidate;
        return { ok: true, stdout: text(result.stdout), note: null };
      }
      // A missing executable is the only case where the next candidate helps.
      if (result.errorCode !== 'ENOENT') {
        allMissing = false;
        break;
      }
    }
    if (last === null || allMissing) {
      return { ok: false, stdout: '', note: `${label} probe failed: no PowerShell executable available` };
    }
    return { ok: false, stdout: '', note: failureNote(label, last) };
  }

  /**
   * Record one probe failure note once per tool call.
   * @param {string} code
   * @param {string} note
   */
  function recordNote(code, note) {
    const marker = `${code}: ${note}`;
    if (!notes.includes(marker)) notes.push(marker);
  }

  /**
   * @param {ProbeResult} result
   * @returns {string}
   */
  function probeFailureReason(result) {
    return result.error ?? errorMessage(result.stderr || 'unknown probe failure');
  }

  /**
   * @param {string} key
   * @param {boolean} fresh
   * @param {number} ttlMs
   * @param {() => Promise<unknown>} loader
   * @returns {Promise<unknown>}
   */
  async function cached(key, fresh, ttlMs, loader) {
    if (!fresh) {
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
    }
    const value = await loader();
    cache.set(key, value, ttlMs);
    return value;
  }

  /**
   * @returns {Promise<ProcessSnapshot>}
   */
  async function loadProcessTable() {
    /** @type {ProcessSnapshot} */
    let snapshot = { at: clock(), processes: [] };
    if (platform === 'win32') {
      const result = await runPowerShell(processTableScript(), 'process table');
      if (!result.ok) {
        recordNote('process_table_unavailable', result.note ?? 'process table probe failed');
        return snapshot;
      }
      snapshot = { at: clock(), processes: parseWindowsProcesses(result.stdout) };
      return snapshot;
    }
    if (platform === 'darwin' || platform === 'linux') {
      const result = await commandRunner.run(
        'ps',
        ['-eo', 'pid=,ppid=,pcpu=,rss=,time=,args='],
        { timeoutMs: commandTimeoutMs },
      );
      if (!result.ok) {
        recordNote('process_table_unavailable', failureNote('process table', result));
        return snapshot;
      }
      snapshot = { at: clock(), processes: parsePsProcesses(result.stdout) };
      return snapshot;
    }
    recordNote('unsupported_platform', `no process probe for platform "${platform}"`);
    return snapshot;
  }

  /**
   * Windows listener probe: bounded `Get-NetTCPConnection` first, then a
   * bounded `netstat -ano -p tcp` fallback. The result carries `available` so
   * callers never report a failed probe as "zero listeners".
   * @returns {Promise<ListenerSnapshot>}
   */
  async function loadWindowsListeners() {
    /** @type {string|null} */
    let primaryFailure = null;
    if (listenerPreference !== 'netstat') {
      const primary = await runPowerShell(listenerScript(), 'Get-NetTCPConnection', { timeoutMs: listenerTimeoutMs });
      if (primary.ok) {
        listenerPreference = 'powershell';
        lastPrimaryListenerFailure = null;
        return { at: clock(), listeners: parseWindowsListeners(primary.stdout), available: true, source: 'powershell' };
      }
      primaryFailure = primary.note ?? 'Get-NetTCPConnection probe failed';
      lastPrimaryListenerFailure = primaryFailure;
    } else {
      primaryFailure = lastPrimaryListenerFailure ?? 'Get-NetTCPConnection probe previously failed';
    }

    const fallback = await commandRunner.run('netstat', ['-ano', '-p', 'tcp'], { timeoutMs: netstatTimeoutMs });
    if (fallback.ok) {
      const listeners = parseNetstatListeners(fallback.stdout);
      listenerPreference = 'netstat';
      recordNote(
        'listener_probe_fallback',
        `${primaryFailure}; using the bounded netstat fallback instead (${listeners.length} listener${listeners.length === 1 ? '' : 's'}).`,
      );
      return { at: clock(), listeners, available: true, source: 'netstat' };
    }
    recordNote(
      'listener_probe_unavailable',
      `${primaryFailure}; netstat fallback failed: ${probeFailureReason(fallback)}`,
    );
    return { at: clock(), listeners: [], available: false, source: null };
  }

  /**
   * @returns {Promise<ListenerSnapshot>}
   */
  async function loadListeners() {
    if (platform === 'win32') return loadWindowsListeners();
    if (platform !== 'darwin' && platform !== 'linux') {
      recordNote('unsupported_platform', `no listener probe for platform "${platform}"`);
      return { at: clock(), listeners: [], available: false, source: null };
    }
    /** @type {Array<{ command: 'ss'|'lsof', args: string[], parse: (stdout: string) => PortListener[] }>} */
    const attempts =
      platform === 'darwin'
        ? [
            { command: 'lsof', args: ['-nP', '-iTCP', '-sTCP:LISTEN'], parse: parseLsofListeners },
            { command: 'ss', args: ['-ltnpH'], parse: parseSsListeners },
          ]
        : [
            { command: 'ss', args: ['-ltnpH'], parse: parseSsListeners },
            { command: 'lsof', args: ['-nP', '-iTCP', '-sTCP:LISTEN'], parse: parseLsofListeners },
          ];
    /** @type {string[]} */
    const failures = [];
    for (const attempt of attempts) {
      const result = await commandRunner.run(attempt.command, attempt.args, { timeoutMs: listenerTimeoutMs });
      if (result.ok) {
        return { at: clock(), listeners: attempt.parse(result.stdout), available: true, source: attempt.command };
      }
      failures.push(`${attempt.command}: ${probeFailureReason(result)}`);
    }
    recordNote(
      'listener_probe_unavailable',
      failures.length > 0 ? failures.join('; ') : 'no ss or lsof executable available',
    );
    return { at: clock(), listeners: [], available: false, source: null };
  }

  /**
   * @returns {Promise<GpuInfo|null>}
   */
  async function loadGpu() {
    const result = await commandRunner.run(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits'],
      { timeoutMs: Math.min(commandTimeoutMs, 3000) },
    );
    if (!result.ok) return null;
    return parseNvidiaSmi(result.stdout);
  }

  return {
    async processTable(probeOptions = {}) {
      const value = await cached('processes', probeOptions.fresh === true, cacheTtlMs, loadProcessTable);
      return /** @type {ProcessSnapshot} */ (value);
    },
    async listeners(probeOptions = {}) {
      const value = await cached('listeners', probeOptions.fresh === true, cacheTtlMs, loadListeners);
      return /** @type {ListenerSnapshot} */ (value);
    },
    async gpu(probeOptions = {}) {
      const value = await cached('gpu', probeOptions.fresh === true, gpuCacheTtlMs, loadGpu);
      return /** @type {GpuInfo|null} */ (value);
    },
    clearCache() {
      cache.clear();
      notes.length = 0;
    },
    clearNotes() {
      notes.length = 0;
    },
    notes() {
      return [...notes];
    },
  };
}
