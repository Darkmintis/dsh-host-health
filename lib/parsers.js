/**
 * Pure parsers for bounded probe output.
 *
 * Every parser accepts the raw text produced by PowerShell, `ps`, `ss`,
 * `lsof`, or `nvidia-smi`, tolerates malformed rows, and never throws. Tests
 * feed captured fixture strings so parser behaviour is deterministic even on a
 * machine where the sandboxed shell cannot query CIM.
 * @module host-health/parsers
 */

/**
 * @typedef {import('./types.js').ProcessInfo} ProcessInfo
 * @typedef {import('./types.js').PortListener} PortListener
 * @typedef {import('./types.js').GpuInfo} GpuInfo
 */

/**
 * Parse `ConvertTo-Json` output into a value.
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonOutput(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Coerce PowerShell arrays (which may serialize as a single object) to an array.
 * @param {unknown} value
 * @returns {unknown[]}
 */
export function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function toInteger(value) {
  const parsed = toFiniteNumber(value);
  return parsed === null || !Number.isInteger(parsed) ? null : parsed;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read one of several aliases from a record.
 * @param {Record<string, unknown>} record
 * @param {string[]} keys
 * @returns {unknown}
 */
function pick(record, keys) {
  for (const key of keys) {
    if (Object.hasOwn(record, key) && record[key] !== undefined) return record[key];
  }
  return undefined;
}

/**
 * Normalize a raw Windows process row.
 * @param {Record<string, unknown>} row
 * @returns {ProcessInfo|null}
 */
export function normalizeWindowsProcess(row) {
  if (row === null || typeof row !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (row);
  const pid = toInteger(pick(record, ['pid', 'ProcessId', 'Id']));
  const name = toText(pick(record, ['name', 'Name', 'ProcessName']));
  if (pid === null || pid <= 0 || name === '') return null;
  const ppid = toInteger(pick(record, ['ppid', 'ParentProcessId']));
  const ramBytes = toFiniteNumber(pick(record, ['ramBytes', 'WorkingSetSize', 'WorkingSet64'])) ?? 0;
  const cpuMs = toFiniteNumber(pick(record, ['cpuMs']));
  const pcpu = toFiniteNumber(pick(record, ['pcpu', 'PercentProcessorTime']));
  const startedAtRaw = pick(record, ['startedAt', 'CreationDate']);
  const startedAt = typeof startedAtRaw === 'string' && startedAtRaw.trim() !== '' ? startedAtRaw.trim() : null;
  const commandLine = toText(pick(record, ['commandLine', 'CommandLine']));
  return {
    pid,
    ppid,
    name,
    ramBytes,
    cpuMs,
    pcpu,
    startedAt,
    commandLine,
  };
}

/**
 * Parse the PowerShell process-table probe (`lib/powershell.js#processTableScript`).
 * @param {string} stdout
 * @returns {ProcessInfo[]}
 */
export function parseWindowsProcesses(stdout) {
  const parsed = parseJsonOutput(stdout);
  /** @type {ProcessInfo[]} */
  const processes = [];
  for (const row of asArray(parsed)) {
    const normalized = normalizeWindowsProcess(/** @type {Record<string, unknown>} */ (row));
    if (normalized !== null) processes.push(normalized);
  }
  return processes.sort((a, b) => a.pid - b.pid);
}

/**
 * Parse a `ps` cumulative-time field such as `1:02:03`, `12:34`, `0:00.00`, or
 * `2-01:02:03` into milliseconds.
 * @param {string} text
 * @returns {number|null}
 */
export function parsePsTime(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (value === '') return null;
  const dayMatch = /^(\d+)-(\d+):([0-5]\d):([0-5]\d)$/.exec(value);
  if (dayMatch !== null) {
    const days = Number(dayMatch[1]);
    const hours = Number(dayMatch[2]);
    const minutes = Number(dayMatch[3]);
    const seconds = Number(dayMatch[4]);
    return ((days * 24 + hours) * 60 + minutes) * 60000 + seconds * 1000;
  }
  const hourMatch = /^(\d+):([0-5]\d):([0-5]\d)$/.exec(value);
  if (hourMatch !== null) {
    const hours = Number(hourMatch[1]);
    const minutes = Number(hourMatch[2]);
    const seconds = Number(hourMatch[3]);
    return (hours * 60 + minutes) * 60000 + seconds * 1000;
  }
  const minuteMatch = /^(\d+):([0-5]\d(?:\.\d+)?)$/.exec(value);
  if (minuteMatch !== null) {
    const minutes = Number(minuteMatch[1]);
    const seconds = Number(minuteMatch[2]);
    return Math.round(minutes * 60000 + seconds * 1000);
  }
  return null;
}

/**
 * @param {string} commandLine
 * @returns {string}
 */
function commandName(commandLine) {
  const first = commandLine.split(/\s+/, 1)[0] ?? '';
  const withoutQuotes = first.replace(/^["']|["']$/g, '');
  const parts = withoutQuotes.split(/[\\/]/);
  return parts[parts.length - 1] ?? withoutQuotes;
}

/**
 * Parse `ps -eo pid=,ppid=,pcpu=,rss=,time=,args=` output.
 * @param {string} stdout
 * @returns {ProcessInfo[]}
 */
export function parsePsProcesses(stdout) {
  /** @type {ProcessInfo[]} */
  const processes = [];
  const lines = typeof stdout === 'string' ? stdout.split(/\r?\n/) : [];
  const rowPattern = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const match = rowPattern.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pcpu = Number(match[3]);
    const rssKb = Number(match[4]);
    const commandLine = match[6].trim();
    if (!Number.isInteger(pid) || pid <= 0 || commandLine === '') continue;
    processes.push({
      pid,
      ppid: Number.isInteger(ppid) ? ppid : null,
      name: commandName(commandLine),
      ramBytes: Number.isFinite(rssKb) ? rssKb * 1024 : 0,
      cpuMs: parsePsTime(match[5]),
      pcpu: Number.isFinite(pcpu) ? pcpu : null,
      startedAt: null,
      commandLine,
    });
  }
  return processes.sort((a, b) => a.pid - b.pid);
}

/**
 * Parse native `netstat -ano -p tcp` output on Windows.
 *
 * Columns are `Proto Local Foreign State PID`. Only `LISTENING` rows with a
 * numeric PID are kept; the state match is case-insensitive and also accepts a
 * zero foreign port so a localized state word does not hide every listener.
 * @param {string} stdout
 * @returns {PortListener[]}
 */
export function parseNetstatListeners(stdout) {
  /** @type {PortListener[]} */
  const listeners = [];
  const lines = typeof stdout === 'string' ? stdout.split(/\r?\n/) : [];
  for (const line of lines) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 5) continue;
    if (tokens[0].toUpperCase() !== 'TCP') continue;
    const localToken = tokens[1];
    const foreignToken = tokens[2];
    const state = tokens[3];
    const pid = Number(tokens[4]);
    const listening = /^listen/i.test(state) || /:0$/.test(foreignToken);
    if (!listening || !Number.isInteger(pid) || pid <= 0) continue;
    const portMatch = /:(\d+)$/.exec(localToken);
    if (portMatch === null) continue;
    const port = Number(portMatch[1]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    const address = localToken.slice(0, localToken.length - portMatch[0].length).replace(/^\[|\]$/g, '') || '*';
    listeners.push({ address, port, pid });
  }
  return dedupeListeners(listeners);
}

/**
 * Parse the PowerShell listener probe (`lib/powershell.js#listenerScript`).
 * @param {string} stdout
 * @returns {PortListener[]}
 */
export function parseWindowsListeners(stdout) {
  const parsed = parseJsonOutput(stdout);
  /** @type {PortListener[]} */
  const listeners = [];
  for (const row of asArray(parsed)) {
    if (row === null || typeof row !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (row);
    const port = toInteger(pick(record, ['port', 'LocalPort']));
    const pid = toInteger(pick(record, ['pid', 'OwningProcess']));
    const address = toText(pick(record, ['address', 'LocalAddress'])) || '*';
    if (port === null || port <= 0 || port > 65535) continue;
    listeners.push({ address, port, pid: pid ?? 0 });
  }
  return dedupeListeners(listeners);
}

/**
 * @param {PortListener[]} listeners
 * @returns {PortListener[]}
 */
function dedupeListeners(listeners) {
  const seen = new Set();
  /** @type {PortListener[]} */
  const result = [];
  for (const listener of listeners) {
    const key = `${listener.address}|${listener.port}|${listener.pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(listener);
  }
  return result.sort((a, b) => a.port - b.port || a.pid - b.pid || a.address.localeCompare(b.address));
}

/**
 * Parse `ss -ltnpH` output (Linux).
 * @param {string} stdout
 * @returns {PortListener[]}
 */
export function parseSsListeners(stdout) {
  /** @type {PortListener[]} */
  const listeners = [];
  const lines = typeof stdout === 'string' ? stdout.split(/\r?\n/) : [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const tokens = trimmed.split(/\s+/);
    const local = tokens.find((token) => /^\S*:\d+$/.test(token) && !token.endsWith(':*'));
    if (local === undefined) continue;
    const portMatch = /:(\d+)$/.exec(local);
    if (portMatch === null) continue;
    const port = Number(portMatch[1]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    const address = local.slice(0, local.length - portMatch[0].length).replace(/^\[|\]$/g, '') || '*';
    const userMatch = /pid=(\d+)/.exec(trimmed);
    listeners.push({ address, port, pid: userMatch === null ? 0 : Number(userMatch[1]) });
  }
  return dedupeListeners(listeners);
}

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN` output (macOS, Linux fallback).
 * @param {string} stdout
 * @returns {PortListener[]}
 */
export function parseLsofListeners(stdout) {
  /** @type {PortListener[]} */
  const listeners = [];
  const lines = typeof stdout === 'string' ? stdout.split(/\r?\n/) : [];
  for (const line of lines) {
    if (!line.includes('(LISTEN)')) continue;
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 9) continue;
    const pid = Number(tokens[1]);
    const last = tokens[tokens.length - 1];
    const addressToken = last === '(LISTEN)' ? tokens[tokens.length - 2] : last;
    const portMatch = /:(\d+)$/.exec(addressToken);
    if (portMatch === null || !Number.isInteger(pid) || pid <= 0) continue;
    const port = Number(portMatch[1]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    const address = addressToken.slice(0, addressToken.length - portMatch[0].length).replace(/^\[|\]$/g, '') || '*';
    listeners.push({ address, port, pid });
  }
  return dedupeListeners(listeners);
}

/**
 * Parse `nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu`.
 * @param {string} stdout
 * @returns {GpuInfo|null}
 */
export function parseNvidiaSmi(stdout) {
  const text = typeof stdout === 'string' ? stdout.trim() : '';
  if (text === '') return null;
  const firstLine = text.split(/\r?\n/)[0] ?? '';
  const fields = firstLine.split(',').map((field) => field.trim());
  if (fields.length < 4) return null;
  const name = fields[0];
  if (name === '') return null;
  const vramTotalMb = toFiniteNumber(fields[1]);
  const vramUsedMb = toFiniteNumber(fields[2]);
  const utilizationPercent = toFiniteNumber(fields[3]);
  if (vramTotalMb === null && vramUsedMb === null && utilizationPercent === null) return null;
  return { name, vramTotalMb, vramUsedMb, utilizationPercent };
}
