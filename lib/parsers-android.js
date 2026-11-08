/**
 * Parsers shared by the host probes and the Android/mobile probes.
 * Pure functions: every parser tolerates malformed rows and never throws.
 *
 * The Android parsers read one bounded `adb shell` snapshot whose sections are
 * separated by the `===DSH===` marker:
 *   /proc/meminfo, the /proc/stat cpu line, `df /data`, `dumpsys battery`, and
 *   `KEY=value` lines for the model, Android release, and SDK level.
 *
 * @module host-health/parsers-android
 */

/** Section separator the snapshot script prints. */
export const ANDROID_SECTION = '===DSH===';

/**
 * Parse `adb devices -l`.
 * @param {string} stdout Raw output.
 * @returns {Array<{ serial: string, state: string, model: string|null }>} devices.
 */
export function parseAdbDevices(stdout) {
  /** @type {Array<{ serial: string, state: string, model: string|null }>} */
  const devices = [];
  if (typeof stdout !== 'string') return devices;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('List of devices')) continue;
    if (trimmed.startsWith('*')) continue;
    const match = /^(\S+)\s+(\S+)(.*)$/u.exec(trimmed);
    if (match === null) continue;
    const serial = match[1];
    const state = match[2];
    if (state !== 'device') continue;
    const rest = match[3] ?? '';
    const model = /model:(\S+)/u.exec(rest);
    devices.push({ serial, state, model: model === null ? null : model[1].replaceAll('_', ' ') });
  }
  return devices;
}

/**
 * @param {string} sections One snapshot section.
 * @param {RegExp} pattern Field pattern.
 * @returns {number|null} first numeric capture.
 */
function firstNumber(sections, pattern) {
  const match = pattern.exec(sections);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parse one `adb shell` snapshot (see the module description).
 * @param {string} stdout Raw combined stdout.
 * @returns {{ model: string|null, androidVersion: string|null, sdk: number|null, battery: { percent: number, charging: boolean, temperatureC: number|null }|null, memory: { totalBytes: number, availableBytes: number, usedBytes: number, usedPercent: number }|null, storage: { totalBytes: number, freeBytes: number, usedBytes: number, usedPercent: number }|null, cpuTimes: { totalMs: number, idleMs: number }|null }}
 */
export function parseAndroidSnapshot(stdout) {
  /** @type {{ model: string|null, androidVersion: string|null, sdk: number|null, battery: { percent: number, charging: boolean, temperatureC: number|null }|null, memory: { totalBytes: number, availableBytes: number, usedBytes: number, usedPercent: number }|null, storage: { totalBytes: number, freeBytes: number, usedBytes: number, usedPercent: number }|null, cpuTimes: { totalMs: number, idleMs: number }|null }} */
  const result = {
    model: null,
    androidVersion: null,
    sdk: null,
    battery: null,
    memory: null,
    storage: null,
    cpuTimes: null,
  };
  if (typeof stdout !== 'string' || stdout.trim() === '') return result;
  const sections = stdout.split(ANDROID_SECTION);
  const [meminfo = '', statLine = '', dfOut = '', batteryOut = '', propsOut = ''] = sections;

  // Memory
  const totalKb = firstNumber(meminfo, /MemTotal:\s+(\d+)\s+kB/u);
  const availableKb = firstNumber(meminfo, /MemAvailable:\s+(\d+)\s+kB/u) ?? firstNumber(meminfo, /MemFree:\s+(\d+)\s+kB/u);
  if (totalKb !== null && totalKb > 0 && availableKb !== null) {
    const totalBytes = totalKb * 1024;
    const availableBytes = Math.min(availableKb * 1024, totalBytes);
    const usedBytes = totalBytes - availableBytes;
    result.memory = {
      totalBytes,
      availableBytes,
      usedBytes,
      usedPercent: Math.round((usedBytes / totalBytes) * 1000) / 10,
    };
  }

  // CPU times from the first /proc/stat line.
  const cpuMatch = /^cpu\s+(.+)$/mu.exec(statLine);
  if (cpuMatch !== null) {
    const fields = cpuMatch[1].trim().split(/\s+/u).map(Number);
    if (fields.length >= 4 && fields.every((value) => Number.isFinite(value))) {
      const total = fields.reduce((sum, value) => sum + value, 0);
      const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
      result.cpuTimes = { totalMs: total * 10, idleMs: idle * 10 };
    }
  }

  // /data usage from df (1K blocks).
  const dfLine = dfOut
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1);
  if (dfLine !== undefined) {
    const cells = dfLine.split(/\s+/u);
    if (cells.length >= 4) {
      const blocks = Number(cells[1]);
      const freeBlocks = Number(cells[3]);
      if (Number.isFinite(blocks) && Number.isFinite(freeBlocks) && blocks > 0) {
        const totalBytes = blocks * 1024;
        const freeBytes = Math.min(Math.max(0, freeBlocks * 1024), totalBytes);
        const usedBytes = totalBytes - freeBytes;
        result.storage = {
          totalBytes,
          freeBytes,
          usedBytes,
          usedPercent: Math.round((usedBytes / totalBytes) * 1000) / 10,
        };
      }
    }
  }

  // Battery
  const level = firstNumber(batteryOut, /^\s*level:\s*(\d+)/mu);
  const status = firstNumber(batteryOut, /^\s*status:\s*(\d+)/mu);
  const temperature = firstNumber(batteryOut, /^\s*temperature:\s*(\d+)/mu);
  if (level !== null) {
    result.battery = {
      percent: Math.max(0, Math.min(100, level)),
      charging: status === 2 || status === 5,
      temperatureC: temperature !== null ? Math.round(temperature / 10) : null,
    };
  }

  // Props
  for (const line of propsOut.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('MODEL=')) result.model = trimmed.slice('MODEL='.length).trim() || null;
    else if (trimmed.startsWith('RELEASE=')) result.androidVersion = trimmed.slice('RELEASE='.length).trim() || null;
    else if (trimmed.startsWith('SDK=')) {
      const sdk = Number(trimmed.slice('SDK='.length).trim());
      result.sdk = Number.isFinite(sdk) ? sdk : null;
    }
  }

  return result;
}

/**
 * Compute a CPU utilisation percentage from two cumulative samples.
 * @param {{ totalMs: number, idleMs: number }} previous Earlier sample.
 * @param {{ totalMs: number, idleMs: number }} current Later sample.
 * @returns {number|null} percentage 0-100, or null when the delta is unusable.
 */
export function cpuPercentFromDelta(previous, current) {
  const totalDelta = current.totalMs - previous.totalMs;
  const idleDelta = current.idleMs - previous.idleMs;
  if (!Number.isFinite(totalDelta) || totalDelta <= 0 || !Number.isFinite(idleDelta)) return null;
  const percent = (1 - idleDelta / totalDelta) * 100;
  return Math.round(Math.max(0, Math.min(100, percent)) * 10) / 10;
}
