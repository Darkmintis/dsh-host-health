/**
 * Shared constants for the host-health plugin.
 *
 * Every value here is intentionally static and machine independent: runtime
 * detection happens in `lib/probes.js` and `lib/system.js`, never in config.
 * @module host-health/constants
 */

/** Plugin version, kept in sync with package.json. */
export const PLUGIN_VERSION = '0.1.0';

/** Dev ports that are always flagged by `ports_list` and `stale_dev_processes`. */
/** @type {readonly number[]} */
export const KNOWN_DEV_PORTS = Object.freeze([8787, 5554, 8000, 5173, 53365]);

/** Human labels for {@link KNOWN_DEV_PORTS}. */
/** @type {Readonly<Record<number, string>>} */
export const DEV_PORT_LABELS = Object.freeze({
  8787: 'web preview server',
  5554: 'Android emulator console',
  8000: 'local HTTP server',
  5173: 'Vite dev server',
  53365: 'DeepSeek Harness Web UI',
});

/**
 * Process names (lowercase, extension stripped) that count as known dev
 * tooling for the highlight section of `host_stats`.
 */
export const KNOWN_DEV_PROCESS_NAMES = Object.freeze([
  'emulator',
  'qemu-system-x86_64',
  'qemu-system-aarch64',
  'qemu-system-arm',
  'dart',
  'flutter_tester',
  'flutter',
  'gradle',
  'java',
  'node',
  'bun',
  'deno',
  'chrome',
  'msedge',
]);

/** PIDs at or below this value are Windows kernel or platform processes. */
export const MIN_PROTECTED_PID = 16;

/**
 * System process names (lowercase, extension stripped) that are never killed.
 * The Windows kernel and session-manager names come before the descriptive
 * POSIX ones; PID 1 and 0 are covered by {@link MIN_PROTECTED_PID}.
 */
export const PROTECTED_PROCESS_NAMES = Object.freeze([
  'system',
  'registry',
  'idle',
  'secure system',
  'memory compression',
  'smss',
  'csrss',
  'wininit',
  'services',
  'lsass',
  'winlogon',
  'svchost',
  'launchd',
  'systemd',
  'kernel_task',
  'windowserver',
  'init',
]);

/**
 * Command-line fragments that identify the DeepSeek Harness host process
 * itself. Matches are never reported or suggested as kill targets.
 */
export const HARNESS_MARKERS = Object.freeze([
  '@deepseek-ai/dsh',
  'deepseek-harness',
  '@darkmintis/dsh-host-health',
  'dsh-host-health',
]);

/** Operational limits applied to every probe and tool. */
/**
 * @type {Readonly<{
 *   cacheTtlMs: number,
 *   gpuCacheTtlMs: number,
 *   commandTimeoutMs: number,
 *   listenerTimeoutMs: number,
 *   netstatTimeoutMs: number,
 *   maxOutputBytes: number,
 *   cpuSampleMs: number,
 *   minCpuWindowMs: number,
 *   maxCpuWindowMs: number,
 *   maxProcesses: number,
 *   maxHighlights: number,
 *   maxListeners: number,
 *   maxStaleEntries: number,
 *   staleAfterMinutes: number,
 *   gradleDaemonIdleMinutes: number,
 *   maxCommandLine: number,
 *   maxCommandLineRender: number,
 *   killVerifyMs: number,
 *   killPollMs: number
 * }>}
 */
export const DEFAULT_LIMITS = Object.freeze({
  /** Expensive probe cache lifetime (Windows process table, port listeners). */
  cacheTtlMs: 2500,
  /** GPU probe cache lifetime; nvidia-smi is slower and its data is stable. */
  gpuCacheTtlMs: 10000,
  /** Hard timeout for a single bounded child process. */
  commandTimeoutMs: 5000,
  /**
   * Listener probes get a longer bounded timeout: a cold `pwsh` start plus
   * `Get-NetTCPConnection` module initialization can exceed 5 s on Windows.
   */
  listenerTimeoutMs: 15000,
  /** Timeout for the bounded `netstat -ano -p tcp` listener fallback. */
  netstatTimeoutMs: 10000,
  /** Upper bound on captured stdout/stderr bytes per probe. */
  maxOutputBytes: 4 * 1024 * 1024,
  /** Bounded wait used only when no previous CPU sample exists. */
  cpuSampleMs: 350,
  /** Ignore CPU windows shorter than this to avoid divide-by-noise results. */
  minCpuWindowMs: 100,
  /** Ignore CPU windows longer than this; the percentage stops being current. */
  maxCpuWindowMs: 120000,
  /** Number of entries in each top-process list. */
  maxProcesses: 8,
  /** Number of highlighted dev processes. */
  maxHighlights: 12,
  /** Number of listener rows returned by ports_list. */
  maxListeners: 80,
  /** Number of stale-process candidates returned. */
  maxStaleEntries: 20,
  /** Age above which a dev process is called stale without further evidence. */
  staleAfterMinutes: 30,
  /** Gradle daemons idle out after three hours by default. */
  gradleDaemonIdleMinutes: 180,
  /** Longest command line stored per process. */
  maxCommandLine: 400,
  /** Longest command line shown in tool output. */
  maxCommandLineRender: 160,
  /** Time allowed for a killed process to disappear. */
  killVerifyMs: 1500,
  /** Poll interval while verifying a kill. */
  killPollMs: 100,
});

/** Resource warning thresholds surfaced in tool output (never persisted). */
/** @type {Readonly<{ ramPercent: number, diskFreeBytes: number, diskFreePercent: number }>} */
export const DEFAULT_THRESHOLDS = Object.freeze({
  ramPercent: 85,
  diskFreeBytes: 10 * 1024 * 1024 * 1024,
  diskFreePercent: 10,
});

/** Tool names registered by this plugin. */
export const TOOL_NAMES = Object.freeze([
  'host_stats',
  'ports_list',
  'stale_dev_processes',
  'port_kill',
  'process_kill',
]);

/** Tools that require an approval prompt before they run. */
export const DESTRUCTIVE_TOOLS = Object.freeze(['port_kill', 'process_kill']);
