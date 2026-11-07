/**
 * Dev-process classification and stale-target detection.
 *
 * The rules are pure functions over a process snapshot and listener snapshot,
 * so tests can inject fixtures. Detection is advisory: every entry explains
 * itself and suggests a target that still goes through approval and an
 * identity re-check before anything is killed.
 * @module host-health/devprocess
 */

import { HARNESS_MARKERS, KNOWN_DEV_PROCESS_NAMES, DEV_PORT_LABELS, DEFAULT_LIMITS } from './constants.js';

/**
 * @typedef {import('./types.js').ProcessInfo} ProcessInfo
 * @typedef {import('./types.js').PortListener} PortListener
 * @typedef {import('./types.js').DevProcessMatch} DevProcessMatch
 * @typedef {import('./types.js').StaleCandidate} StaleCandidate
 */

/**
 * @typedef {object} DevCategory
 * @property {string} id Stable category id.
 * @property {string} label Human-readable label.
 * @property {RegExp} pattern Matched against the bounded command line.
 */

/** Category matchers, most specific first. */
export const DEV_CATEGORIES = Object.freeze([
  Object.freeze({
    id: 'gradle-daemon',
    label: 'Gradle daemon',
    pattern: /gradle/i,
  }),
  Object.freeze({
    id: 'android-emulator',
    label: 'Android emulator',
    pattern: /( -avd |qemu-system|emulator(?:\.exe)?(?:\s|$)|emulator-\d)/i,
  }),
  Object.freeze({
    id: 'flutter-run',
    label: 'Flutter run session',
    pattern: /(flutter_tools|flutter(?:\s|$)|flutter\.bat|dart(?:\.exe)?\s+.*(?:run|daemon|devtools))/i,
  }),
  Object.freeze({
    id: 'preview-server',
    label: 'Preview/dev server',
    pattern: /(vite|webpack-dev-server|webpack serve|next\s+dev|next\s+start|nuxt\s+dev|astro\s+dev|http-server|live-server|serve\s+-s|parcel|rollup\s+-w|preview)/i,
  }),
]);

/**
 * @param {string} commandLine
 * @returns {string}
 */
function lowerCommandLine(commandLine) {
  return commandLine.toLowerCase();
}

/**
 * Whether a process command line points at the DeepSeek Harness itself.
 * @param {string} commandLine
 * @returns {boolean}
 */
export function isHarnessProcess(commandLine) {
  const lowered = lowerCommandLine(commandLine);
  return HARNESS_MARKERS.some((marker) => lowered.includes(marker.toLowerCase()));
}

/**
 * @param {string} name
 * @returns {string}
 */
function baseName(name) {
  const value = name.trim().toLowerCase();
  return value.endsWith('.exe') ? value.slice(0, -4) : value;
}

/**
 * Whether a process name is a known dev-tool name.
 * @param {string} name
 * @returns {boolean}
 */
export function isKnownDevProcessName(name) {
  const base = baseName(name);
  return KNOWN_DEV_PROCESS_NAMES.some((known) => base === known || base.startsWith(known));
}

/**
 * Classify one process. Returns null for ordinary processes.
 * @param {ProcessInfo} process
 * @param {{ ports?: Map<number, PortListener> }} [context]
 * @returns {DevProcessMatch|null}
 */
export function classifyProcess(process, context = {}) {
  if (isHarnessProcess(process.commandLine)) return null;
  const name = baseName(process.name);
  const commandLine = lowerCommandLine(process.commandLine);
  for (const category of DEV_CATEGORIES) {
    if (category.pattern.test(commandLine)) {
      const port = context.ports?.get(process.pid)?.port ?? null;
      return {
        pid: process.pid,
        name: process.name,
        category: category.id,
        label: category.label,
        reason: `Matched ${category.label.toLowerCase()} command line: "${shorten(process.commandLine)}".`,
        port,
      };
    }
  }
  if (name === 'java' || name === 'javaw') {
    if (commandLine.includes('gradle')) {
      const port = context.ports?.get(process.pid)?.port ?? null;
      return {
        pid: process.pid,
        name: process.name,
        category: 'gradle-daemon',
        label: 'Gradle daemon',
        reason: 'Java process running Gradle.',
        port,
      };
    }
  }
  if (isKnownDevProcessName(process.name)) {
    const port = context.ports?.get(process.pid)?.port ?? null;
    return {
      pid: process.pid,
      name: process.name,
      category: 'dev-process',
      label: 'Dev process',
      reason: `Known dev process name "${process.name}".`,
      port,
    };
  }
  return null;
}

/**
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function shorten(text, limit = DEFAULT_LIMITS.maxCommandLineRender) {
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

/**
 * Map pid to its first listening port.
 * @param {PortListener[]} listeners
 * @returns {Map<number, PortListener>}
 */
export function listenersByPid(listeners) {
  /** @type {Map<number, PortListener>} */
  const map = new Map();
  for (const listener of listeners) {
    if (listener.pid <= 0) continue;
    const existing = map.get(listener.pid);
    if (existing === undefined || listener.port < existing.port) map.set(listener.pid, listener);
  }
  return map;
}

/**
 * Build the host_stats highlight list: known dev processes, bounded and
 * excluding the harness itself.
 * @param {Array<ProcessInfo & { cpuPercent: number }>} processes
 * @param {PortListener[]} listeners
 * @param {number} limit
 * @returns {Array<{ pid: number, name: string, kind: string, label: string, ramMb: number, cpuPercent: number, port: number|null }>}
 */
export function collectDevHighlights(processes, listeners, limit) {
  const ports = listenersByPid(listeners);
  const highlights = [];
  for (const process of processes) {
    const match = classifyProcess(process, { ports });
    if (match === null) continue;
    if (highlights.length >= limit) break;
    highlights.push({
      pid: process.pid,
      name: process.name,
      kind: match.category,
      label: match.label,
      ramMb: round1(process.ramBytes / (1024 * 1024)),
      cpuPercent: process.cpuPercent,
      port: match.port,
    });
  }
  return highlights;
}

/**
 * Round to one decimal without negative zero.
 * @param {number} value
 * @returns {number}
 */
function round1(value) {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * @param {string|null} startedAt
 * @param {number} now
 * @returns {number|null}
 */
export function ageMinutes(startedAt, now) {
  if (startedAt === null) return null;
  const parsed = Date.parse(startedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round(((now - parsed) / 60000) * 10) / 10);
}

/**
 * Build stale dev-process candidates from process/listener snapshots.
 * @param {{
 *   processes: Array<ProcessInfo & { cpuPercent?: number }>,
 *   listeners: PortListener[],
 *   now: number,
 *   staleAfterMinutes?: number,
 *   gradleDaemonIdleMinutes?: number,
 *   limit?: number,
 * }} input
 * @returns {StaleCandidate[]}
 */
export function collectStaleCandidates(input) {
  const staleAfterMinutes = input.staleAfterMinutes ?? DEFAULT_LIMITS.staleAfterMinutes;
  const gradleDaemonIdleMinutes = input.gradleDaemonIdleMinutes ?? DEFAULT_LIMITS.gradleDaemonIdleMinutes;
  const limit = input.limit ?? DEFAULT_LIMITS.maxStaleEntries;
  const ports = listenersByPid(input.listeners);
  /** @type {StaleCandidate[]} */
  const candidates = [];

  for (const process of input.processes) {
    // The harness process itself is never a candidate.
    if (process.pid === process.ppid) continue;
    if (isHarnessProcess(process.commandLine)) continue;
    const match = classifyProcess(process, { ports });
    if (match === null) continue;
    if (match.category === 'dev-process') continue;
    const listener = ports.get(process.pid);
    const port = listener?.port ?? null;
    const age = ageMinutes(process.startedAt, input.now);
    const ageText = age === null ? 'age unknown' : `age ${formatAge(age)}`;
    const portText = port === null ? 'no listener port' : `listening on port ${port}`;
    let stale = false;
    let confidence = /** @type {'high'|'medium'|'low'} */ ('medium');
    let reason = '';

    switch (match.category) {
      case 'gradle-daemon': {
        stale = age !== null && age >= gradleDaemonIdleMinutes;
        confidence = stale ? 'high' : 'medium';
        reason = stale
          ? `Gradle daemon has been running for ${formatAge(age ?? 0)} (above the ${gradleDaemonIdleMinutes} min idle default); it is safe to stop when no build is running.`
          : `Gradle daemon (${ageText}); Gradle reuses it for later builds, so only stop it if builds are stuck.`;
        break;
      }
      case 'preview-server': {
        stale = age !== null && age >= staleAfterMinutes;
        confidence = stale ? 'high' : 'low';
        reason = stale
          ? `Dev server has been running for ${formatAge(age ?? 0)} (${portText}); likely a leftover preview server from an earlier session.`
          : `Dev server started ${ageText} (${portText}); verify no browser tab or terminal is using it before stopping.`;
        break;
      }
      case 'flutter-run': {
        stale = age !== null && age >= staleAfterMinutes * 2;
        confidence = stale ? 'medium' : 'low';
        reason = `Flutter/Dart session (${ageText}, ${portText}). If adb shows no attached device and the IDE has no live run, it is stale.`;
        break;
      }
      case 'android-emulator': {
        stale = age !== null && age >= gradleDaemonIdleMinutes;
        confidence = stale ? 'medium' : 'low';
        reason = `Android emulator (${ageText}, ${portText}). Emulators are often left running on purpose; stop it only for an orphaned AVD.`;
        break;
      }
      default: {
        stale = age !== null && age >= staleAfterMinutes;
        confidence = 'low';
        reason = `Dev tool process (${ageText}, ${portText}).`;
      }
    }

    /** @type {import('./types.js').SuggestedKill} */
    const suggested = port !== null
      ? {
          tool: 'port_kill',
          args: { port },
          note: `Frees port ${port} and re-verifies the listener identity immediately before killing.`,
        }
      : {
          tool: 'process_kill',
          args: { pid: process.pid },
          note: `Kills PID ${process.pid} after re-checking its identity.`,
        };

    candidates.push({
      pid: process.pid,
      name: process.name,
      category: match.category,
      label: match.label,
      port,
      ageMinutes: age,
      stale,
      confidence,
      reason: port !== null && DEV_PORT_LABELS[port] !== undefined
        ? `${reason} Port ${port} is a known ${DEV_PORT_LABELS[port]} port.`
        : reason,
      suggested,
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  candidates.sort(
    (a, b) =>
      rank[a.confidence] - rank[b.confidence] ||
      (b.ageMinutes ?? -1) - (a.ageMinutes ?? -1) ||
      a.pid - b.pid,
  );
  return candidates.slice(0, limit);
}

/**
 * @param {number} minutes
 * @returns {string}
 */
export function formatAge(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return 'unknown';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours * 10) / 10} h`;
  return `${Math.round((hours / 24) * 10) / 10} d`;
}
