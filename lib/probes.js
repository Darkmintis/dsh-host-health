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
  const clock = options.clock ?? Date.now;
  const cache = createCache({ now: clock });
  const powershellCandidates =
    options.powershellCandidates ??
    (platform === 'win32' ? ['pwsh', 'powershell.exe'] : ['pwsh']);

  /** @type {string|null} */
  let shellCommand = null;
  /** @type {string[]} */
  const notes = [];

  /**
   * Run one PowerShell script through the first working host executable.
   * @param {string} script
   * @param {string} label
   * @returns {Promise<{ ok: boolean, stdout: string, note: string|null }>}
   */
  async function runPowerShell(script, label) {
    /** @type {string[]} */
    const candidates = shellCommand === null ? powershellCandidates : [shellCommand];
    /** @type {ProbeResult|null} */
    let last = null;
    let allMissing = true;
    for (const candidate of candidates) {
      const result = await commandRunner.run(
        candidate,
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeoutMs: commandTimeoutMs },
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
   * @param {string} label
   * @param {string} code
   * @param {string} note
   */
  function recordNote(label, code, note) {
    const marker = `${code}: ${note}`;
    if (!notes.includes(marker)) notes.push(marker);
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
        recordNote('processes', 'process_table_unavailable', result.note ?? 'process table probe failed');
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
        recordNote('processes', 'process_table_unavailable', failureNote('process table', result));
        return snapshot;
      }
      snapshot = { at: clock(), processes: parsePsProcesses(result.stdout) };
      return snapshot;
    }
    recordNote('processes', 'unsupported_platform', `no process probe for platform "${platform}"`);
    return snapshot;
  }

  /**
   * @returns {Promise<ListenerSnapshot>}
   */
  async function loadListeners() {
    /** @type {ListenerSnapshot} */
    let snapshot = { at: clock(), listeners: [] };
    if (platform === 'win32') {
      const result = await runPowerShell(listenerScript(), 'listener');
      if (!result.ok) {
        recordNote('listeners', 'listener_probe_unavailable', result.note ?? 'listener probe failed');
        return snapshot;
      }
      snapshot = { at: clock(), listeners: parseWindowsListeners(result.stdout) };
      return snapshot;
    }
    /** @type {Array<{ command: string, args: string[], parse: (stdout: string) => PortListener[] }>} */
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
    for (const attempt of attempts) {
      const result = await commandRunner.run(attempt.command, attempt.args, { timeoutMs: commandTimeoutMs });
      if (result.ok) {
        snapshot = { at: clock(), listeners: attempt.parse(result.stdout) };
        return snapshot;
      }
      if (result.errorCode !== 'ENOENT') {
        recordNote('listeners', 'listener_probe_unavailable', failureNote(attempt.command, result));
        return snapshot;
      }
    }
    recordNote('listeners', 'listener_probe_unavailable', 'no ss or lsof executable available');
    return snapshot;
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
