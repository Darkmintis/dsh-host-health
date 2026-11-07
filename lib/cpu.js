/**
 * Pure CPU math: aggregate host CPU percentage and per-process deltas.
 *
 * CPU percentages are computed from cumulative CPU time snapshots, which is
 * accurate and cheap: the process table is already needed for RAM and command
 * lines, so no second counter provider is queried.
 * @module host-health/cpu
 */

/**
 * @typedef {import('./types.js').CpuTimes} CpuTimes
 * @typedef {import('./types.js').ProcessSnapshot} ProcessSnapshot
 * @typedef {import('./types.js').ProcessInfo} ProcessInfo
 */

/**
 * Round to one decimal without keeping negative zero.
 * @param {number} value
 * @returns {number}
 */
export function round1(value) {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Clamp a percentage into 0-100.
 * @param {number} value
 * @returns {number}
 */
export function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return round1(value);
}

/**
 * Host CPU percentage from two cumulative `CpuTimes` samples.
 * @param {CpuTimes} previous
 * @param {CpuTimes} current
 * @returns {number|null} Percentage 0-100, or null when the window is unusable.
 */
export function computeAggregateCpuPercent(previous, current) {
  const totalDelta = current.totalMs - previous.totalMs;
  const idleDelta = current.idleMs - previous.idleMs;
  if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) return null;
  return clampPercent((1 - idleDelta / totalDelta) * 100);
}

/**
 * Per-process CPU percentages from two cumulative snapshots.
 *
 * A process percentage is its CPU-time delta divided by the wall-clock delta
 * and the logical processor count, so it is directly comparable with host CPU
 * usage: 100% means every logical core is busy on that process.
 * @param {ProcessSnapshot|null} previous
 * @param {ProcessSnapshot} current
 * @param {number} cpuCount
 * @returns {Map<number, number>}
 */
export function computeProcessCpuPercents(previous, current, cpuCount) {
  /** @type {Map<number, number>} */
  const percentages = new Map();
  const safeCpuCount = Number.isFinite(cpuCount) && cpuCount > 0 ? cpuCount : 1;
  const previousByPid = new Map();
  if (previous !== null) {
    if (current.at - previous.at <= 0) {
      for (const process of current.processes) percentages.set(process.pid, 0);
      return percentages;
    }
    for (const process of previous.processes) previousByPid.set(process.pid, process);
  }
  const windowMs = previous === null ? 0 : current.at - previous.at;
  for (const process of current.processes) {
    const prior = previousByPid.get(process.pid);
    if (
      windowMs > 0 &&
      process.cpuMs !== null &&
      prior !== undefined &&
      prior.cpuMs !== null
    ) {
      const deltaMs = process.cpuMs - prior.cpuMs;
      const percent = deltaMs <= 0 ? 0 : (deltaMs / windowMs / safeCpuCount) * 100;
      percentages.set(process.pid, clampPercent(percent));
      continue;
    }
    const hint = process.pcpu;
    percentages.set(process.pid, hint === null ? 0 : clampPercent(hint / safeCpuCount));
  }
  return percentages;
}

/**
 * Merge computed percentages into process records without mutating them.
 * @param {ProcessInfo[]} processes
 * @param {Map<number, number>} percentages
 * @returns {Array<ProcessInfo & { cpuPercent: number }>}
 */
export function withCpuPercent(processes, percentages) {
  return processes.map((process) => ({
    ...process,
    cpuPercent: percentages.get(process.pid) ?? 0,
  }));
}

/**
 * The top `limit` processes by RAM, then by CPU. Ties fall back to name and pid
 * so output is deterministic across probes.
 * @param {Array<ProcessInfo & { cpuPercent: number }>} processes
 * @param {number} limit
 * @returns {{ topRam: Array<ProcessInfo & { cpuPercent: number }>, topCpu: Array<ProcessInfo & { cpuPercent: number }> }}
 */
export function topProcessLists(processes, limit) {
  const byRam = [...processes].sort((a, b) => b.ramBytes - a.ramBytes || a.name.localeCompare(b.name) || a.pid - b.pid);
  const byCpu = [...processes].sort((a, b) => b.cpuPercent - a.cpuPercent || b.ramBytes - a.ramBytes || a.pid - b.pid);
  return {
    topRam: byRam.slice(0, limit),
    topCpu: byCpu.slice(0, limit),
  };
}
