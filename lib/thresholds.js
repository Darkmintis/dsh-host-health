/**
 * Threshold evaluation for resource pressure.
 *
 * Warnings are computed fresh on every `host_stats` call and returned in the
 * tool output only. Nothing is persisted and no background watcher writes a
 * status file.
 * @module host-health/thresholds
 */

import { DEFAULT_THRESHOLDS } from './constants.js';

/**
 * @typedef {import('./types.js').MemoryInfo} MemoryInfo
 * @typedef {import('./types.js').DiskInfo} DiskInfo
 * @typedef {import('./types.js').ThresholdWarning} ThresholdWarning
 */

/**
 * Format a byte count for a warning message.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = safe;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * @param {{ memory?: MemoryInfo|null, disk?: DiskInfo|null, thresholds?: Partial<typeof DEFAULT_THRESHOLDS> }} input
 * @returns {ThresholdWarning[]}
 */
export function evaluateThresholds(input) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  /** @type {ThresholdWarning[]} */
  const warnings = [];

  if (input.memory !== undefined && input.memory !== null) {
    const memory = input.memory;
    if (memory.usedPercent > thresholds.ramPercent) {
      warnings.push({
        code: 'ram_high',
        severity: 'warn',
        message: `RAM usage is ${memory.usedPercent}% (${formatBytes(memory.usedBytes)} of ${formatBytes(memory.totalBytes)}), above the ${thresholds.ramPercent}% threshold.`,
      });
    }
  }

  if (input.disk !== undefined && input.disk !== null) {
    const disk = input.disk;
    if (disk.freeBytes < thresholds.diskFreeBytes || disk.freePercent < thresholds.diskFreePercent) {
      warnings.push({
        code: 'disk_low',
        severity: 'warn',
        message: `Disk ${disk.path} has ${formatBytes(disk.freeBytes)} free (${disk.freePercent}% of ${formatBytes(disk.totalBytes)}), below the ${formatBytes(thresholds.diskFreeBytes)} / ${thresholds.diskFreePercent}% threshold.`,
      });
    }
  }

  return warnings;
}
