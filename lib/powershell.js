/**
 * Bounded PowerShell probe scripts.
 *
 * The scripts are single-purpose, stream nothing, and are executed through the
 * bounded command runner with a hard timeout. They only read: no settings are
 * changed and no process is terminated here. CIM/`Get-NetTCPConnection` work in
 * the unsandboxed DSH host process; on a sandboxed shell the probes fail closed
 * and the tools return a note instead of throwing.
 * @module host-health/powershell
 */

import { DEFAULT_LIMITS } from './constants.js';

/**
 * Read-only process table: pid, name, parent, working-set bytes, cumulative CPU
 * time, creation time, and a bounded command line.
 * @param {{ maxCommandLine?: number }} [options]
 * @returns {string}
 */
export function processTableScript(options = {}) {
  const maxCommandLine = options.maxCommandLine ?? DEFAULT_LIMITS.maxCommandLine;
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$out = @()',
    'foreach ($p in @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,WorkingSetSize,CommandLine,CreationDate,KernelModeTime,UserModeTime)) {',
    '  $pidValue = [int]$p.ProcessId',
    '  if ($pidValue -le 0) { continue }',
    '  $cmd = [string]$p.CommandLine',
    `  if ($cmd.Length -gt ${maxCommandLine}) { $cmd = $cmd.Substring(0, ${maxCommandLine}) }`,
    '  $started = $null',
    '  if ($null -ne $p.CreationDate) { $started = ([datetime]$p.CreationDate).ToUniversalTime().ToString("o") }',
    '  $cpuMs = $null',
    '  if ($null -ne $p.KernelModeTime -or $null -ne $p.UserModeTime) { $cpuMs = ([double]$p.KernelModeTime + [double]$p.UserModeTime) / 10000 }',
    '  $out += [pscustomobject]@{ pid = $pidValue; ppid = [int]$p.ParentProcessId; name = [string]$p.Name; ramBytes = [double]$p.WorkingSetSize; cpuMs = $cpuMs; pcpu = $null; startedAt = $started; commandLine = $cmd }',
    '}',
    'ConvertTo-Json -InputObject @($out) -Compress -Depth 3',
  ].join('\n');
}

/**
 * Read-only TCP listener table: local address, port, and owning pid. Process
 * names are joined in JavaScript from the cached process table.
 * @returns {string}
 */
export function listenerScript() {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$out = @()',
    'foreach ($c in @(Get-NetTCPConnection -State Listen)) {',
    '  $out += [pscustomobject]@{ address = [string]$c.LocalAddress; port = [int]$c.LocalPort; pid = [int]$c.OwningProcess }',
    '}',
    'ConvertTo-Json -InputObject @($out) -Compress -Depth 3',
  ].join('\n');
}

/**
 * Windows root path used for the disk measurement.
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function windowsSystemRoot(env = process.env) {
  const drive = typeof env.SystemDrive === 'string' && env.SystemDrive !== '' ? env.SystemDrive : 'C:';
  return `${drive}\\`;
}


/**
 * Read-only system snapshot: Task-Manager-style memory (available/committed),
 * aggregated and per-core CPU utilization, every fixed volume, battery state,
 * and the process count. One invocation keeps the whole snapshot consistent.
 * Any unavailable class is omitted; the parser tolerates partial output.
 * @returns {string}
 */
export function systemSnapshotScript() {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$os = Get-CimInstance -ClassName Win32_OperatingSystem',
    '$perf = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Memory',
    '$cores = @(Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Processor | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; percent = [int]$_.PercentProcessorTime } })',
    "$volumes = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { [pscustomobject]@{ path = [string]$_.DeviceID; total = [double]$_.Size; free = [double]$_.FreeSpace } })",
    '$battery = Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1',
    '$snapshot = [ordered]@{}',
    "if ($null -ne $os) { $snapshot.totalBytes = [double]$os.TotalVisibleMemorySize * 1024; $snapshot.freeBytes = [double]$os.FreePhysicalMemory * 1024; $snapshot.processCount = [int]$os.NumberOfProcesses }",
    'if ($null -ne $perf) { $snapshot.availableBytes = [double]$perf.AvailableBytes; $snapshot.committedBytes = [double]$perf.CommittedBytes; $snapshot.commitLimitBytes = [double]$perf.CommitLimit; $snapshot.cacheBytes = [double]$perf.CacheBytes }',
    "$snapshot.cores = if ($cores.Count -gt 0) { $cores } else { $null }",
    "$snapshot.volumes = if ($volumes.Count -gt 0) { $volumes } else { $null }",
    'if ($null -ne $battery) { $snapshot.battery = [pscustomobject]@{ percent = [int]$battery.EstimatedChargeRemaining; status = [int]$battery.BatteryStatus; runtimeMinutes = [int]$battery.EstimatedRunTime } } else { $snapshot.battery = $null }',
    'ConvertTo-Json -InputObject $snapshot -Compress -Depth 5',
  ].join('\n');
}