/**
 * Node builtin system adapter.
 *
 * RAM, aggregate CPU times, uptime, load average, and disk free space come from
 * `node:os`/`node:fs` rather than from PowerShell: they are accurate, fast, and
 * require no external process. The adapter is injectable so tests can supply
 * deterministic samples.
 * @module host-health/system
 */

import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { windowsSystemRoot } from './powershell.js';

/**
 * @typedef {import('./types.js').SystemAdapter} SystemAdapter
 * @typedef {import('./types.js').MemoryInfo} MemoryInfo
 * @typedef {import('./types.js').DiskInfo} DiskInfo
 * @typedef {import('./types.js').CpuTimes} CpuTimes
 */

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
 * @param {number} totalBytes
 * @param {number} freeBytes
 * @returns {MemoryInfo}
 */
export function memoryUsage(totalBytes, freeBytes) {
  const safeTotal = Math.max(0, totalBytes);
  const safeFree = Math.min(Math.max(0, freeBytes), safeTotal > 0 ? safeTotal : 0);
  const usedBytes = Math.max(0, safeTotal - safeFree);
  const usedPercent = safeTotal > 0 ? round1((usedBytes / safeTotal) * 100) : 0;
  return { totalBytes: safeTotal, freeBytes: safeFree, usedBytes, usedPercent };
}

/**
 * Sum cumulative idle/total CPU times across logical processors.
 * @param {import('node:os').CpuInfo[]} cpus
 * @returns {CpuTimes}
 */
export function sumCpuTimes(cpus) {
  let idleMs = 0;
  let totalMs = 0;
  for (const cpu of cpus) {
    idleMs += cpu.times.idle;
    totalMs += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idleMs, totalMs };
}

/**
 * Root path measured for disk capacity.
 * @param {string} platform
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function diskRoot(platform, env = process.env) {
  return platform === 'win32' ? windowsSystemRoot(env) : '/';
}

/**
 * @param {number} totalBytes
 * @param {number} freeBytes
 * @param {string} path
 * @returns {DiskInfo}
 */
export function diskUsage(totalBytes, freeBytes, path) {
  const safeTotal = Math.max(0, totalBytes);
  const safeFree = Math.min(Math.max(0, freeBytes), safeTotal);
  const usedBytes = Math.max(0, safeTotal - safeFree);
  const freePercent = safeTotal > 0 ? round1((safeFree / safeTotal) * 100) : 0;
  return { path, totalBytes: safeTotal, freeBytes: safeFree, usedBytes, freePercent };
}

/**
 * Create the real Node builtin system adapter.
 * @param {{ platform?: string, arch?: string, env?: Record<string, string|undefined>, statfsImpl?: typeof statfs }} [options]
 * @returns {SystemAdapter}
 */
export function createNodeSystem(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const statfsImpl = options.statfsImpl ?? statfs;
  const cpuCount = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const root = diskRoot(platform, env);

  return {
    platform,
    arch,
    cpuCount,
    hostname() {
      try {
        return os.hostname();
      } catch {
        return 'unknown-host';
      }
    },
    memory() {
      return memoryUsage(os.totalmem(), os.freemem());
    },
    cpuTimes() {
      return sumCpuTimes(os.cpus());
    },
    uptimeSeconds() {
      const value = os.uptime();
      return Number.isFinite(value) ? value : 0;
    },
    loadAvg() {
      try {
        const values = os.loadavg();
        if (!Array.isArray(values) || values.length < 3) return null;
        return [values[0], values[1], values[2]];
      } catch {
        return null;
      }
    },
    async disk() {
      try {
        const stats = await statfsImpl(root);
        const blockSize = Number(stats.bsize);
        const totalBytes = Number(stats.blocks) * blockSize;
        const freeBytes = Number(stats.bavail) * blockSize;
        if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes) || totalBytes <= 0) return null;
        return diskUsage(totalBytes, freeBytes, root);
      } catch {
        return null;
      }
    },
  };
}
