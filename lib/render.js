/**
 * Human-readable text renderers for tool results.
 *
 * The structured value stays small and predictable for the model; these
 * formatters produce the table-like text blocks the user and the client tool
 * card see. Every formatter is tolerant of partial data and never throws.
 * @module host-health/render
 */

import { DEV_PORT_LABELS, KNOWN_DEV_PORTS } from './constants.js';
import { shorten } from './devprocess.js';
import { formatBytes } from './thresholds.js';

/**
 * @typedef {import('./types.js').ProcessInfo} ProcessInfo
 * @typedef {import('./types.js').ThresholdWarning} ThresholdWarning
 */

/**
 * @param {number} value
 * @returns {string}
 */
function fixed1(value) {
  return Number.isFinite(value) ? (Math.round(value * 10) / 10).toFixed(1) : '0.0';
}

/**
 * @param {number} seconds
 * @returns {string}
 */
export function formatUptime(seconds) {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  const days = Math.floor(safe / 86400);
  const hours = Math.floor((safe % 86400) / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * @param {number} mb
 * @returns {string}
 */
function formatMb(mb) {
  if (!Number.isFinite(mb) || mb <= 0) return '0 MB';
  if (mb >= 1024) return `${fixed1(mb / 1024)} GB`;
  return Number.isInteger(mb) ? `${mb} MB` : `${fixed1(mb)} MB`;
}

/**
 * Render top-process rows. Accepts both structured service entries (with
 * `ramMb`) and raw process records (with `ramBytes`).
 * @param {Array<Record<string, any>>} processes
 * @param {string} title
 * @returns {string[]}
 */
function processTable(processes, title) {
  /** @type {string[]} */
  const lines = [title];
  if (processes.length === 0) {
    lines.push('  (no process data available)');
    return lines;
  }
  for (const process of processes) {
    const ramMb =
      typeof process.ramMb === 'number' ? process.ramMb : (process.ramBytes ?? 0) / (1024 * 1024);
    lines.push(
      `  ${shorten(process.name, 22).padEnd(22)} pid ${String(process.pid).padEnd(7)} ${formatMb(ramMb).padStart(9)}  ${fixed1(process.cpuPercent).padStart(5)}%  ${shorten(process.commandLine, 90)}`,
    );
  }
  return lines;
}

/**
 * Render `host_stats` text.
 * @param {Record<string, any>} value The validated host_stats value.
 * @returns {string}
 */
export function renderHostStats(value) {
  /** @type {string[]} */
  const lines = [];
  const host = value.host ?? {};
  const platform = typeof host.platform === 'string' ? host.platform : 'unknown';
  const arch = typeof host.arch === 'string' ? host.arch : 'unknown';
  lines.push(
    `Host: ${typeof host.hostname === 'string' ? host.hostname : 'unknown'} (${platform} ${arch}) up ${formatUptime(host.uptimeSeconds ?? 0)}`,
  );
  const memory = value.memory ?? {};
  lines.push(
    `RAM:  ${formatBytes(memory.usedBytes ?? 0)} used of ${formatBytes(memory.totalBytes ?? 0)} (${fixed1(memory.usedPercent ?? 0)}%)`,
  );
  const cpu = value.cpu ?? {};
  lines.push(`CPU:  ${fixed1(cpu.percent ?? 0)}%${typeof host.cpuCount === 'number' ? ` across ${host.cpuCount} logical cores` : ''}`);
  if (value.disk !== null && typeof value.disk === 'object') {
    lines.push(
      `Disk: ${value.disk.path ?? '?'} ${formatBytes(value.disk.freeBytes ?? 0)} free of ${formatBytes(value.disk.totalBytes ?? 0)} (${fixed1(value.disk.freePercent ?? 0)}% free)`,
    );
  } else {
    lines.push('Disk: unavailable');
  }
  if (Array.isArray(value.load) && value.load.length >= 3) {
    const load = value.load;
    if (load.every((item) => typeof item === 'number' && item === 0) && platform === 'win32') {
      lines.push('Load: not reported on Windows');
    } else {
      lines.push(`Load: ${fixed1(load[0])} / ${fixed1(load[1])} / ${fixed1(load[2])} (1/5/15 min)`);
    }
  }
  if (value.gpu !== null && typeof value.gpu === 'object') {
    const vram =
      typeof value.gpu.vramTotalMb === 'number' && value.gpu.vramTotalMb > 0
        ? ` - ${fixed1(value.gpu.vramUsedMb ?? 0)}/${fixed1(value.gpu.vramTotalMb)} MB VRAM, ${fixed1(value.gpu.utilizationPercent ?? 0)}% util`
        : '';
    lines.push(`GPU:  ${value.gpu.name}${vram}`);
  }
  if (Array.isArray(value.warnings)) {
    for (const warning of /** @type {ThresholdWarning[]} */ (value.warnings)) {
      lines.push(`WARN: ${warning.message}`);
    }
  }
  if (Array.isArray(value.notes)) {
    for (const note of value.notes) lines.push(`NOTE: ${note}`);
  }
  lines.push(...processTable(value.topRam ?? [], 'Top RAM'));
  lines.push(...processTable(value.topCpu ?? [], 'Top CPU'));
  if (Array.isArray(value.devProcesses) && value.devProcesses.length > 0) {
    lines.push('Dev processes');
    for (const process of value.devProcesses) {
      const port = typeof process.port === 'number' ? ` port ${process.port}` : '';
      lines.push(`  ${shorten(process.label, 24).padEnd(24)} ${shorten(process.name, 20).padEnd(20)} pid ${process.pid}${port}`);
    }
  }
  return lines.join('\n');
}

/**
 * Render `ports_list` text.
 * @param {Record<string, any>} value
 * @returns {string}
 */
export function renderPortsList(value) {
  /** @type {string[]} */
  const lines = [];
  const listeners = Array.isArray(value.listeners) ? value.listeners : [];
  lines.push(`TCP listeners: ${listeners.length}${value.truncated ? ` (showing ${listeners.length}, ${value.truncated} omitted)` : ''}`);
  if (listeners.length === 0) {
    lines.push('  (no TCP listeners visible)');
  } else {
    for (const listener of listeners) {
      const dev = listener.knownDevPort ? ` [dev: ${listener.devLabel ?? 'known dev port'}]` : '';
      lines.push(`  ${String(listener.port).padStart(5)} ${shorten(listener.address ?? '*', 22).padEnd(22)} pid ${String(listener.pid ?? 0).padEnd(7)} ${shorten(listener.name ?? 'unknown', 24)}${dev}`);
    }
  }
  const flagged = Array.isArray(value.flagged) ? value.flagged : [];
  if (flagged.length > 0) {
    lines.push('Flagged ports');
    for (const port of flagged) {
      lines.push(
        `  ${String(port.port).padStart(5)}  ${port.status === 'in_use' ? `IN USE  pid ${port.pid ?? 0} ${port.name ?? 'unknown'}` : 'FREE'}${port.knownDevPort ? `  (${port.devLabel ?? 'known dev port'})` : ''}`,
      );
    }
  }
  if (Array.isArray(value.warnings)) {
    for (const warning of value.warnings) lines.push(`WARN: ${warning.message}`);
  }
  if (Array.isArray(value.notes)) {
    for (const note of value.notes) lines.push(`NOTE: ${note}`);
  }
  return lines.join('\n');
}

/**
 * Render `stale_dev_processes` text.
 * @param {Record<string, any>} value
 * @returns {string}
 */
export function renderStaleProcesses(value) {
  /** @type {string[]} */
  const lines = [];
  const entries = Array.isArray(value.entries) ? value.entries : [];
  lines.push(`Dev-process candidates: ${entries.length} (stale threshold ${value.staleAfterMinutes ?? '?'} min)`);
  if (entries.length === 0) {
    lines.push('  (no leftover dev servers, emulators, or Gradle daemons detected)');
    return lines.join('\n');
  }
  for (const entry of entries) {
    const flags = [entry.stale ? 'STALE' : 'candidate', entry.confidence ?? 'low'].join('/');
    const port = typeof entry.port === 'number' ? ` port ${entry.port}` : '';
    const age = typeof entry.ageMinutes === 'number' ? `, ${entry.ageMinutes} min` : '';
    lines.push(`  [${flags}] ${entry.label ?? entry.category} - ${entry.name} (pid ${entry.pid}${port}${age})`);
    lines.push(`    ${entry.reason}`);
    if (entry.suggested !== null && typeof entry.suggested === 'object') {
      lines.push(`    next: ${entry.suggested.tool}(${JSON.stringify(entry.suggested.args)}) - ${entry.suggested.note}`);
    }
  }
  if (Array.isArray(value.notes)) {
    for (const note of value.notes) lines.push(`NOTE: ${note}`);
  }
  return lines.join('\n');
}

/**
 * Render a kill result.
 * @param {Record<string, any>} value
 * @returns {string}
 */
export function renderKillResult(value) {
  if (value.ok === false) {
    const hint = typeof value.hint === 'string' ? `\nHint: ${value.hint}` : '';
    return `Refused: ${value.error ?? 'kill failed'}.${hint}`;
  }
  const killed = value.killed ?? {};
  const target = typeof killed.port === 'number' ? `port ${killed.port} listener` : `PID ${killed.pid}`;
  const parts = [`Killed ${target}: ${killed.name ?? 'unknown'}`];
  if (typeof killed.port === 'number' && typeof killed.pid === 'number') parts.push(`(pid ${killed.pid})`);
  parts.push(value.verifiedGone === true ? '- verified gone.' : '- process still visible after the verify window.');
  if (Array.isArray(value.notes) && value.notes.length > 0) parts.push(`\n${value.notes.join('\n')}`);
  return parts.join(' ');
}

/**
 * Render the generic failure value.
 * @param {Record<string, any>} value
 * @returns {string}
 */
export function renderError(value) {
  const hint = typeof value.hint === 'string' ? `\nHint: ${value.hint}` : '';
  return `Error: ${value.error ?? 'unknown error'}${hint}`;
}

/**
 * @returns {string}
 */
export function knownDevPortsLine() {
  return KNOWN_DEV_PORTS.map((port) => `${port} (${DEV_PORT_LABELS[port]})`).join(', ');
}
