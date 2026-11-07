/**
 * Host-health service: the single place where probes, CPU math, dev-process
 * detection, thresholds, and kills are combined.
 *
 * The service is fully injectable (system adapter, probes, process control,
 * clock, sleep) so unit tests exercise real logic against fixture snapshots.
 * @module host-health/service
 */

import { DEV_PORT_LABELS, DEFAULT_LIMITS, DEFAULT_THRESHOLDS, KNOWN_DEV_PORTS } from './constants.js';
import { computeAggregateCpuPercent, computeProcessCpuPercents, round1, topProcessLists, withCpuPercent } from './cpu.js';
import { collectDevHighlights, collectStaleCandidates, shorten } from './devprocess.js';
import { checkKillTarget, normalizeProcessName, sameProcessIdentity } from './kill.js';
import { evaluateThresholds } from './thresholds.js';

/**
 * @typedef {import('./types.js').SystemAdapter} SystemAdapter
 * @typedef {import('./types.js').ProcessControl} ProcessControl
 * @typedef {import('./types.js').ProcessInfo} ProcessInfo
 * @typedef {import('./types.js').ProcessSnapshot} ProcessSnapshot
 * @typedef {import('./types.js').ProbeResult} ProbeResult
 * @typedef {import('./probes.js').Probes} Probes
 */

/**
 * @typedef {object} HostServiceOptions
 * @property {SystemAdapter} system
 * @property {Probes} probes
 * @property {ProcessControl} control
 * @property {() => number} [clock]
 * @property {Partial<typeof DEFAULT_LIMITS>} [limits]
 * @property {Partial<typeof DEFAULT_THRESHOLDS>} [thresholds]
 * @property {Record<string, unknown>} [config]
 */

/**
 * @typedef {object} HostService
 * @property {(args?: { includeProcesses?: boolean, includeGpu?: boolean }) => Promise<Record<string, any>>} hostStats
 * @property {(args?: { ports?: number[] }) => Promise<Record<string, any>>} portsList
 * @property {() => Promise<Record<string, any>>} staleDevProcesses
 * @property {(port: number) => Promise<Record<string, any>>} portKill
 * @property {(pid: number, expectedName?: string) => Promise<Record<string, any>>} processKill
 */

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isPortNumber(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isPid(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function errorMessageOf(value, label) {
  if (value instanceof Error) return `${label}: ${value.message}`;
  return `${label}: ${String(value)}`;
}

/**
 * Create the host-health service.
 * @param {HostServiceOptions} options
 * @returns {HostService}
 */
export function createHostService(options) {
  const system = options.system;
  const probes = options.probes;
  const control = options.control;
  const clock = options.clock ?? Date.now;
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
  const config = options.config ?? {};
  const platform = system.platform;
  const supportedPlatform = platform === 'win32' || platform === 'darwin' || platform === 'linux';

  /** @type {{ times: import('./types.js').CpuTimes, at: number }|null} */
  let lastCpuSample = null;
  /** @type {ProcessSnapshot|null} */
  let lastRawSnapshot = null;
  /** @type {{ at: number, processes: Array<ProcessInfo & { cpuPercent: number }> }|null} */
  let lastComputed = null;

  /**
   * Aggregate host CPU percentage.
   *
   * With a recent previous sample the delta is free; otherwise a bounded second
   * sample is taken. A sample older than the maximum window is discarded.
   * @returns {Promise<number>}
   */
  async function sampleCpuPercent() {
    const current = system.cpuTimes();
    const at = clock();
    const previous = lastCpuSample;
    if (
      previous !== null &&
      at - previous.at >= limits.minCpuWindowMs &&
      at - previous.at <= limits.maxCpuWindowMs
    ) {
      lastCpuSample = { times: current, at };
      const percent = computeAggregateCpuPercent(previous.times, current);
      if (percent !== null) return percent;
    }
    lastCpuSample = { times: current, at };
    await control.sleep(limits.cpuSampleMs);
    const second = system.cpuTimes();
    lastCpuSample = { times: second, at: clock() };
    return computeAggregateCpuPercent(current, second) ?? 0;
  }

  /**
   * Process snapshot enriched with CPU percentages, cached per probe snapshot.
   * @returns {Promise<{ at: number, processes: Array<ProcessInfo & { cpuPercent: number }> }>}
   */
  async function processData() {
    const snapshot = await probes.processTable();
    if (snapshot === lastRawSnapshot && lastComputed !== null) return lastComputed;
    let previous = lastRawSnapshot;
    let current = snapshot;
    if (previous === null) {
      // No baseline yet: take one bounded second sample so CPU has a window.
      lastRawSnapshot = snapshot;
      await control.sleep(limits.cpuSampleMs);
      previous = snapshot;
      current = await probes.processTable({ fresh: true });
    }
    const cpuMap = computeProcessCpuPercents(previous, current, system.cpuCount);
    const computed = { at: current.at, processes: withCpuPercent(current.processes, cpuMap) };
    lastRawSnapshot = current;
    lastComputed = computed;
    return computed;
  }

  /**
   * @returns {Promise<Map<number, string>>}
   */
  async function processNames() {
    const snapshot = await probes.processTable();
    /** @type {Map<number, string>} */
    const names = new Map();
    for (const process of snapshot.processes) names.set(process.pid, process.name);
    return names;
  }

  /**
   * @param {string} label
   * @returns {string[]}
   */
  function notesFromProbes(label) {
    const notes = probes.notes();
    if (notes.length === 0) return [];
    return notes.slice(0, 4).map((note) => `${label} ${note}`);
  }

  /**
   * @param {Array<ProcessInfo & { cpuPercent: number }>} processes
   * @returns {Array<Record<string, unknown>>}
   */
  function summarizeProcesses(processes) {
    return processes.map((process) => ({
      pid: process.pid,
      name: process.name,
      ramMb: round1(process.ramBytes / (1024 * 1024)),
      cpuPercent: process.cpuPercent,
      commandLine: shorten(process.commandLine, limits.maxCommandLineRender),
    }));
  }

  /** @type {HostService} */
  const service = {
    /**
     * Snapshot host resources plus top processes and dev-process highlights.
     * @param {{ includeProcesses?: boolean, includeGpu?: boolean }} [args]
     * @returns {Promise<Record<string, any>>}
     */
    async hostStats(args = {}) {
      probes.clearNotes();
      const includeProcesses = args.includeProcesses !== false;
      const includeGpu = args.includeGpu !== false;
      try {
        const memory = system.memory();
        const disk = await system.disk();
        /** @type {import('./types.js').GpuInfo|null} */
        let gpu = null;
        /** @type {number[]|null} */
        let load = null;
        try {
          load = system.loadAvg();
        } catch {
          load = null;
        }
        const [cpuPercent, gpuResult] = await Promise.all([
          sampleCpuPercent(),
          includeGpu ? probes.gpu() : Promise.resolve(null),
        ]);
        gpu = gpuResult;
        const gpuStatus = !includeGpu ? 'skipped' : gpu === null ? 'unavailable' : 'available';
        const warnings = evaluateThresholds({ memory, disk, thresholds });

        /** @type {Array<Record<string, unknown>>} */
        let topRam = [];
        /** @type {Array<Record<string, unknown>>} */
        let topCpu = [];
        /** @type {Array<Record<string, unknown>>} */
        let devProcesses = [];
        /** @type {string[]} */
        const notes = [];
        if (includeProcesses) {
          if (!supportedPlatform) {
            notes.push(`process table is not implemented on platform "${platform}"`);
          } else {
            const snapshot = await processData();
            const lists = topProcessLists(snapshot.processes, limits.maxProcesses);
            topRam = summarizeProcesses(lists.topRam);
            topCpu = summarizeProcesses(lists.topCpu);
            devProcesses = collectDevHighlights(snapshot.processes, [], limits.maxHighlights).filter(
              (process) => process.pid !== control.selfPid && process.pid !== control.parentPid,
            );
          }
        }
        notes.push(...notesFromProbes('host_stats'));
        return {
          ok: true,
          host: {
            hostname: system.hostname(),
            platform,
            arch: system.arch,
            cpuCount: system.cpuCount,
            uptimeSeconds: Math.round(system.uptimeSeconds()),
          },
          memory,
          cpu: { percent: cpuPercent },
          disk,
          load,
          gpu,
          gpuStatus,
          topRam,
          topCpu,
          devProcesses,
          warnings,
          notes,
          thresholds,
          staleAfterMinutes: limits.staleAfterMinutes,
        };
      } catch (error) {
        return {
          ok: false,
          error: 'host_stats_failed',
          hint: errorMessageOf(error, 'host stats'),
        };
      }
    },

    /**
     * List TCP listeners and flag known/requested ports.
     * @param {{ ports?: number[] }} [args]
     * @returns {Promise<Record<string, any>>}
     */
    async portsList(args = {}) {
      probes.clearNotes();
      try {
        const requested = args.ports ?? [];
        if (!Array.isArray(requested) || requested.some((port) => !isPortNumber(port))) {
          return {
            ok: false,
            error: 'invalid_port',
            hint: 'Every entry in "ports" must be an integer between 1 and 65535.',
          };
        }
        if (!supportedPlatform) {
          return {
            ok: false,
            error: 'unsupported_platform',
            hint: `TCP listener probing is implemented for win32, darwin, and linux (current: "${platform}").`,
          };
        }
        const listenerSnapshot = await probes.listeners();
        if (listenerSnapshot.available !== true) {
          const notes = notesFromProbes('ports_list');
          notes.push('The TCP listener table is unavailable, so every flagged port status is unknown (not "free").');
          const flaggedPorts = [...new Set([...KNOWN_DEV_PORTS, ...requested])].sort((a, b) => a - b);
          return {
            ok: true,
            at: listenerSnapshot.at,
            available: false,
            source: null,
            listeners: [],
            truncated: 0,
            flagged: flaggedPorts.map((port) => ({
              port,
              status: 'unknown',
              pid: null,
              name: null,
              knownDevPort: KNOWN_DEV_PORTS.includes(port),
              devLabel: DEV_PORT_LABELS[port] ?? null,
            })),
            warnings: [],
            notes,
            knownDevPorts: KNOWN_DEV_PORTS,
          };
        }
        const names = await processNames();
        /** @type {Map<string, Record<string, unknown>>} */
        const deduped = new Map();
        for (const listener of listenerSnapshot.listeners) {
          const key = `${listener.port}|${listener.pid}`;
          if (deduped.has(key)) continue;
          deduped.set(key, {
            port: listener.port,
            address: listener.address,
            pid: listener.pid,
            name: names.get(listener.pid) ?? 'unknown',
            knownDevPort: KNOWN_DEV_PORTS.includes(listener.port),
            devLabel: DEV_PORT_LABELS[listener.port] ?? null,
          });
        }
        const allListeners = [...deduped.values()].sort(
          (a, b) => Number(a.port) - Number(b.port) || Number(a.pid) - Number(b.pid),
        );
        const truncated = Math.max(0, allListeners.length - limits.maxListeners);
        const listeners = allListeners.slice(0, limits.maxListeners);
        const flaggedPorts = [...new Set([...KNOWN_DEV_PORTS, ...requested])].sort((a, b) => a - b);
        const flagged = flaggedPorts.map((port) => {
          const owner = allListeners.find((listener) => listener.port === port);
          const knownDevPort = KNOWN_DEV_PORTS.includes(port);
          if (owner === undefined) {
            return { port, status: 'free', pid: null, name: null, knownDevPort, devLabel: DEV_PORT_LABELS[port] ?? null };
          }
          return {
            port,
            status: 'in_use',
            pid: owner.pid,
            name: owner.name,
            knownDevPort,
            devLabel: DEV_PORT_LABELS[port] ?? null,
          };
        });
        const warnings = flagged
          .filter((entry) => entry.status === 'in_use')
          .map((entry) => ({
            code: 'port_in_use',
            severity: 'warn',
            message: `Port ${entry.port}${entry.devLabel ? ` (${entry.devLabel})` : ''} is in use by ${entry.name} (pid ${entry.pid}).`,
          }));
        const notes = notesFromProbes('ports_list');
        if (truncated > 0) notes.push(`listener list truncated to ${limits.maxListeners} entries (${truncated} more omitted)`);
        return {
          ok: true,
          at: listenerSnapshot.at,
          available: true,
          source: listenerSnapshot.source,
          listeners,
          truncated,
          flagged,
          warnings,
          notes,
          knownDevPorts: KNOWN_DEV_PORTS,
        };
      } catch (error) {
        return { ok: false, error: 'ports_list_failed', hint: errorMessageOf(error, 'ports list') };
      }
    },

    /**
     * Detect leftover dev servers, emulators, Flutter runs, and Gradle daemons.
     * @returns {Promise<Record<string, any>>}
     */
    async staleDevProcesses() {
      probes.clearNotes();
      if (!supportedPlatform) {
        return {
          ok: false,
          error: 'unsupported_platform',
          hint: `Stale dev-process detection is implemented for win32, darwin, and linux (current: "${platform}").`,
        };
      }
      try {
        const snapshot = await processData();
        const listenerSnapshot = await probes.listeners();
        const listenerAvailable = listenerSnapshot.available === true;
        const entries = collectStaleCandidates({
          processes: snapshot.processes,
          listeners: listenerSnapshot.listeners,
          now: clock(),
          staleAfterMinutes: limits.staleAfterMinutes,
          gradleDaemonIdleMinutes: limits.gradleDaemonIdleMinutes,
          limit: limits.maxStaleEntries,
          excludePids: [control.selfPid, control.parentPid],
        });
        const notes = notesFromProbes('stale_dev_processes');
        if (!listenerAvailable) {
          notes.push('The TCP listener table is unavailable; candidates have no port association and suggest process_kill targets only.');
        }
        return {
          ok: true,
          at: snapshot.at,
          staleAfterMinutes: limits.staleAfterMinutes,
          count: entries.length,
          entries,
          listenerProbeAvailable: listenerAvailable,
          notes,
        };
      } catch (error) {
        return { ok: false, error: 'stale_dev_processes_failed', hint: errorMessageOf(error, 'stale dev processes') };
      }
    },

    /**
     * Kill the single process listening on a TCP port.
     *
     * Identity is read from fresh probes after approval resolves, and the
     * listener is read once more immediately before the kill; a changed PID or
     * a vanished listener aborts the kill.
     * @param {number} port
     * @returns {Promise<Record<string, any>>}
     */
    async portKill(port) {
      probes.clearNotes();
      if (!isPortNumber(port)) {
        return {
          ok: false,
          error: 'invalid_port',
          hint: 'Pass an integer TCP port between 1 and 65535.',
        };
      }
      if (!supportedPlatform) {
        return {
          ok: false,
          error: 'unsupported_platform',
          hint: `Port kills are implemented for win32, darwin, and linux (current: "${platform}").`,
        };
      }
      try {
        const listenerSnapshot = await probes.listeners({ fresh: true });
        if (listenerSnapshot.available !== true) {
          return {
            ok: false,
            error: 'listener_probe_unavailable',
            details: { port },
            hint: 'The TCP listener table is unavailable (both the primary probe and the netstat fallback failed), so the target cannot be re-verified. Refusing to kill blind; retry after ports_list can read listeners.',
          };
        }
        const ownerPids = [
          ...new Set(
            listenerSnapshot.listeners
              .filter((listener) => listener.port === port && listener.pid > 0)
              .map((listener) => listener.pid),
          ),
        ];
        if (ownerPids.length === 0) {
          return {
            ok: false,
            error: 'no_listener',
            details: { port },
            hint: `No TCP listener currently owns port ${port}; nothing was killed.`,
          };
        }
        if (ownerPids.length > 1) {
          return {
            ok: false,
            error: 'ambiguous_listener',
            details: { port, pids: ownerPids },
            hint: 'Multiple processes listen on this port; inspect ports_list and use process_kill with an explicit PID.',
          };
        }
        const pid = ownerPids[0];
        const table = await probes.processTable({ fresh: true });
        const identity = table.processes.find((process) => process.pid === pid);
        if (identity === undefined) {
          return {
            ok: false,
            error: 'process_not_found',
            details: { port, pid },
            hint: 'The listener exited before its identity could be verified; no kill was attempted.',
          };
        }
        const refusal = checkKillTarget({
          pid,
          name: identity.name,
          selfPid: control.selfPid,
          parentPid: control.parentPid,
        });
        if (!refusal.safe) {
          return { ok: false, error: refusal.code, details: { port, pid, name: identity.name }, hint: refusal.reason };
        }
        // Re-read the listener table immediately before killing: the approved
        // target must still be the process listening on the requested port.
        const recheck = await probes.listeners({ fresh: true });
        if (recheck.available !== true) {
          return {
            ok: false,
            error: 'listener_probe_unavailable',
            details: { port, pid },
            hint: 'The listener table became unavailable during re-verification; no kill was attempted. Retry ports_list first.',
          };
        }
        const stillListening = recheck.listeners.some((listener) => listener.port === port && listener.pid === pid);
        if (!stillListening) {
          return {
            ok: false,
            error: 'identity_changed',
            details: { port, pid },
            hint: 'The listener identity changed after verification; no kill was attempted. Re-run ports_list.',
          };
        }
        if (!control.exists(pid)) {
          return {
            ok: false,
            error: 'process_not_found',
            details: { port, pid },
            hint: 'The listener process is already gone.',
          };
        }
        control.kill(pid);
        const verifiedGone = await verifyGone(pid);
        return {
          ok: true,
          killed: { port, pid, name: identity.name },
          verifiedGone,
          method: 'SIGTERM',
          listenerSource: recheck.source,
          notes: verifiedGone
            ? [`Approval-gated kill completed after listener (${recheck.source ?? 'unknown'} source) and process identity re-checks.`]
            : [`Process ${pid} was signalled but is still visible after ${limits.killVerifyMs} ms; it may be elevated or protected.`],
        };
      } catch (error) {
        return killFailureResult(error, { port });
      }
    },

    /**
     * Kill one process by PID after a fresh identity check.
     * @param {number} pid
     * @param {string} [expectedName] Optional name the caller expects; a mismatch aborts the kill.
     * @returns {Promise<Record<string, any>>}
     */
    async processKill(pid, expectedName) {
      probes.clearNotes();
      if (!isPid(pid)) {
        return { ok: false, error: 'invalid_pid', hint: 'Pass a positive integer PID.' };
      }
      if (!supportedPlatform) {
        return {
          ok: false,
          error: 'unsupported_platform',
          hint: `Process kills are implemented for win32, darwin, and linux (current: "${platform}").`,
        };
      }
      try {
        const table = await probes.processTable({ fresh: true });
        const identity = table.processes.find((process) => process.pid === pid);
        if (identity === undefined) {
          return {
            ok: false,
            error: 'process_not_found',
            details: { pid },
            hint: `No running process has PID ${pid}; it may have already exited.`,
          };
        }
        const refusal = checkKillTarget({
          pid,
          name: identity.name,
          selfPid: control.selfPid,
          parentPid: control.parentPid,
        });
        if (!refusal.safe) {
          return { ok: false, error: refusal.code, details: { pid, name: identity.name }, hint: refusal.reason };
        }
        if (typeof expectedName === 'string' && expectedName.trim() !== '') {
          if (normalizeProcessName(expectedName) !== normalizeProcessName(identity.name)) {
            return {
              ok: false,
              error: 'identity_mismatch',
              details: { pid, expectedName, actualName: identity.name },
              hint: 'The PID now belongs to a different process name; refusing to kill it.',
            };
          }
        }
        // Re-read the process table immediately before killing: the approved
        // pid must still describe the process that was verified above.
        const recheck = await probes.processTable({ fresh: true });
        const nextIdentity = recheck.processes.find((process) => process.pid === pid);
        if (!sameProcessIdentity(identity, nextIdentity)) {
          return {
            ok: false,
            error: 'identity_changed',
            details: { pid },
            hint: 'The process identity changed after verification; no kill was attempted.',
          };
        }
        if (!control.exists(pid)) {
          return { ok: false, error: 'process_not_found', details: { pid }, hint: 'The process is already gone.' };
        }
        control.kill(pid);
        const verifiedGone = await verifyGone(pid);
        return {
          ok: true,
          killed: { pid, name: identity.name, commandLine: shorten(identity.commandLine, limits.maxCommandLineRender) },
          verifiedGone,
          method: 'SIGTERM',
          notes: verifiedGone
            ? ['Approval-gated kill completed after a fresh identity re-check.']
            : [`Process ${pid} was signalled but is still visible after ${limits.killVerifyMs} ms; it may be elevated or protected.`],
        };
      } catch (error) {
        return killFailureResult(error, { pid });
      }
    },
  };

  /**
   * Poll until the process disappears or the verify window closes.
   * @param {number} pid
   * @returns {Promise<boolean>}
   */
  async function verifyGone(pid) {
    const deadline = clock() + limits.killVerifyMs;
    while (clock() < deadline) {
      await control.sleep(limits.killPollMs);
      if (!control.exists(pid)) return true;
    }
    return !control.exists(pid);
  }

  /**
   * Convert a thrown kill failure into a structured tool result.
   * @param {unknown} error
   * @param {Record<string, number>} target
   * @returns {Record<string, any>}
   */
  function killFailureResult(error, target) {
    const codeOf = error !== null && typeof error === 'object' && 'code' in error
      ? /** @type {{ code?: unknown }} */ (error).code
      : null;
    const code = typeof codeOf === 'string' ? codeOf : null;
    if (code === 'ESRCH') {
      return {
        ok: false,
        error: 'process_not_found',
        details: { ...target, code },
        hint: 'The process exited before the kill signal was delivered.',
      };
    }
    if (code === 'EPERM' || code === 'EACCES') {
      return {
        ok: false,
        error: 'access_denied',
        details: { ...target, code },
        hint: 'The target is elevated or owned by another user. This plugin never requests administrator rights, so it cannot kill that process.',
      };
    }
    return {
      ok: false,
      error: 'kill_failed',
      details: { ...target, code, message: errorMessageOf(error, 'kill') },
      hint: 'The signal could not be delivered; re-run ports_list to refresh process state.',
    };
  }

  return service;
}
