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
  parseSystemSnapshot,
} from './parsers.js';
import { listenerScript, processTableScript, systemSnapshotScript } from './powershell.js';
import { resolveAdb } from './adb.js';
import { parseAdbDevices, parseAndroidSnapshot, cpuPercentFromDelta, ANDROID_SECTION } from './parsers-android.js';

/**
 * @typedef {import('./types.js').CommandRunner} CommandRunner
 * @typedef {import('./types.js').ProbeResult} ProbeResult
 * @typedef {import('./types.js').ProcessSnapshot} ProcessSnapshot
 * @typedef {import('./types.js').ListenerSnapshot} ListenerSnapshot
 * @typedef {import('./types.js').SystemSnapshot} SystemSnapshot
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
 * @property {(options?: { fresh?: boolean }) => Promise<SystemSnapshot|null>} systemSnapshot
 * @property {(options?: { fresh?: boolean }) => Promise<{ available: boolean, devices: Array<{ serial: string, state: string, model: string|null }> }>} mobileDevices
 * @property {(serial: string) => Promise<Record<string, any>|null>} mobileSnapshot
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
  /** @type {string|null|undefined} */
  let adbPath;
  /** @type {Map<string, { totalMs: number, idleMs: number }>} */
  const previousCpu = new Map();

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

  /**
   * One consistent Task-Manager-style snapshot: memory, CPU cores, volumes,
   * battery, process count. Returns null when the host shell cannot answer.
   * @returns {Promise<import('./parsers.js').parseSystemSnapshot extends (s: string) => infer R ? R : never>}
   */
  async function loadSystemSnapshot() {
    const result = await runPowerShell(systemSnapshotScript(), 'system snapshot', {
      timeoutMs: Math.min(commandTimeoutMs, 8000),
    });
    if (!result.ok) return null;
    return parseSystemSnapshot(result.stdout);
  }

  /**
   * Locate adb once; a missing binary disables the mobile half instead of
   * producing a failure note on every poll.
   * @returns {string|null} adb path.
   */
  function adb() {
    if (adbPath === undefined) adbPath = resolveAdb({ platform: /** @type {NodeJS.Platform} */ (platform) });
    return adbPath;
  }

  /** Android shell snapshot: memory, CPU line, /data usage, battery, props. */
  const MOBILE_SCRIPT =
    'cat /proc/meminfo; echo ' + ANDROID_SECTION + '; head -1 /proc/stat; echo ' + ANDROID_SECTION +
    '; df /data; echo ' + ANDROID_SECTION + '; dumpsys battery; echo ' + ANDROID_SECTION +
    '; echo MODEL=$(getprop ro.product.model); echo RELEASE=$(getprop ro.build.version.release); echo SDK=$(getprop ro.build.version.sdk)';

  /**
   * List ready Android devices.
   * @returns {Promise<{ available: boolean, devices: Array<{ serial: string, state: string, model: string|null }> }>}
   */
  async function loadMobileDevices() {
    const binary = adb();
    if (binary === null) return { available: false, devices: [] };
    const result = await commandRunner.run(binary, ['devices', '-l'], { timeoutMs: Math.min(commandTimeoutMs, 5000) });
    if (!result.ok) return { available: false, devices: [] };
    return { available: true, devices: parseAdbDevices(result.stdout) };
  }

  /**
   * One device snapshot with CPU computed from the previous cumulative sample.
   * @param {string} serial Device serial.
   * @returns {Promise<Record<string, any>|null>} snapshot or null when unreachable.
   */
  async function loadMobileSnapshot(serial) {
    const binary = adb();
    if (binary === null) return null;
    const result = await commandRunner.run(binary, ['-s', serial, 'shell', MOBILE_SCRIPT], {
      timeoutMs: Math.min(commandTimeoutMs, 6000),
    });
    if (!result.ok) return null;
    const parsed = parseAndroidSnapshot(result.stdout);
    const previous = previousCpu.get(serial);
    const cpuPercent = previous !== undefined && parsed.cpuTimes !== null ? cpuPercentFromDelta(previous, parsed.cpuTimes) : null;
    if (parsed.cpuTimes !== null) previousCpu.set(serial, parsed.cpuTimes);
    return { ...parsed, cpuPercent };
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
    async systemSnapshot(probeOptions = {}) {
      const value = await cached('system', probeOptions.fresh === true, cacheTtlMs, loadSystemSnapshot);
      return /** @type {any} */ (value);
    },
    async mobileDevices(probeOptions = {}) {
      const value = await cached('mobile-devices', probeOptions.fresh === true, cacheTtlMs, loadMobileDevices);
      return /** @type {{ available: boolean, devices: Array<{ serial: string, state: string, model: string|null }> }} */ (value);
    },
    /** @param {string} serial Device serial. */
    async mobileSnapshot(serial) {
      return loadMobileSnapshot(serial);
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
