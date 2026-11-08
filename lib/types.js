/**
 * Shared JSDoc typedefs for the host-health plugin.
 *
 * The module has no runtime exports; it exists so every other module can point
 * `@type`/`@param` references at one authoritative shape while `tsc` checks
 * the JavaScript.
 * @module host-health/types
 */

/**
 * @typedef {object} ProbeResult
 * @property {boolean} ok True only when the process exited 0 within its bounds.
 * @property {string} stdout Captured standard output (may be truncated).
 * @property {string} stderr Captured standard error (bounded).
 * @property {number|null} code Exit code, or null when the process did not exit.
 * @property {boolean} timedOut Whether the timeout fired and the process was killed.
 * @property {string|null} error Human-readable failure, or null on success.
 * @property {string|null} errorCode Machine-readable failure code (`ENOENT`, ...).
 * @property {number} durationMs Wall-clock duration of the probe.
 */

/**
 * @typedef {object} CommandRunner
 * @property {(command: string, args: string[], options?: { timeoutMs?: number }) => Promise<ProbeResult>} run
 */

/**
 * @typedef {object} ProcessInfo
 * @property {number} pid Process id.
 * @property {number|null} ppid Parent process id when the platform reports it.
 * @property {string} name Process name without a directory path.
 * @property {number} ramBytes Resident working set in bytes.
 * @property {number|null} cpuMs Cumulative CPU time in milliseconds, when available.
 * @property {number|null} pcpu Platform snapshot CPU percentage (fallback only).
 * @property {string|null} startedAt ISO creation timestamp, when available.
 * @property {string} commandLine Full or bounded command line.
 */

/**
 * @typedef {object} ProcessSnapshot
 * @property {number} at Epoch milliseconds when the probe completed.
 * @property {ProcessInfo[]} processes Processes sorted by pid.
 */

/**
 * @typedef {object} PortListener
 * @property {string} address Local address (e.g. `127.0.0.1`, `0.0.0.0`, `::`).
 * @property {number} port TCP port.
 * @property {number} pid Owning process id, or 0 when unknown.
 */

/**
 * @typedef {object} ListenerSnapshot
 * @property {number} at Epoch milliseconds when the probe completed.
 * @property {PortListener[]} listeners Listeners sorted by port then pid.
 * @property {boolean} available False when every listener probe failed; an
 *   empty `listeners` array then means "unknown", never "no listeners".
 * @property {'powershell'|'netstat'|'ss'|'lsof'|null} source Probe that produced
 *   the table, or null when the probe is unavailable.
 */

/**
 * @typedef {object} GpuInfo
 * @property {string} name GPU name.
 * @property {number|null} vramTotalMb Total dedicated VRAM in MiB.
 * @property {number|null} vramUsedMb Used VRAM in MiB.
 * @property {number|null} utilizationPercent GPU utilization percentage.
 */

/**
 * @typedef {object} MemoryInfo
 * @property {number} totalBytes Physical memory in bytes.
 * @property {number} freeBytes Free physical memory in bytes.
 * @property {number} usedBytes Used physical memory in bytes.
 * @property {number} usedPercent Used percentage, 0-100 rounded to one decimal.
 */

/**
 * @typedef {object} DiskInfo
 * @property {string} path Disk root that was measured.
 * @property {number} totalBytes Total capacity in bytes.
 * @property {number} freeBytes Available bytes for unprivileged users.
 * @property {number} usedBytes Used bytes.
 * @property {number} freePercent Free percentage, 0-100 rounded to one decimal.
 */

/**
 * @typedef {object} CpuTimes
 * @property {number} idleMs Cumulative idle time in milliseconds.
 * @property {number} totalMs Cumulative total time in milliseconds.
 */

/**
 * @typedef {object} SystemAdapter
 * @property {string} platform Node platform (`win32`, `darwin`, `linux`).
 * @property {string} arch Node architecture.
 * @property {number} cpuCount Logical processor count.
 * @property {() => string} hostname
 * @property {() => MemoryInfo} memory
 * @property {() => CpuTimes} cpuTimes
 * @property {() => number} uptimeSeconds
 * @property {() => number[]|null} loadAvg
 * @property {() => Promise<DiskInfo|null>} disk
 */

/**
 * @typedef {object} ProcessControl
 * @property {(pid: number) => boolean} exists Whether a process id is alive.
 * @property {(pid: number) => void} kill Terminate one process (no shell, no tree kill).
 * @property {(ms: number) => Promise<void>} sleep
 * @property {number} selfPid The plugin host process id.
 * @property {number} parentPid The plugin host parent process id.
 */

/**
 * @typedef {object} ThresholdWarning
 * @property {string} code Stable warning code.
 * @property {'warn'} severity Warning severity.
 * @property {string} message Human-readable warning.
 */

/**
 * @typedef {object} DevProcessMatch
 * @property {number} pid
 * @property {string} name
 * @property {string} category Stable category id.
 * @property {string} label Human-readable category label.
 * @property {string} reason Why it matched.
 * @property {number|null} port Listening port associated with the match.
 */

/**
 * @typedef {object} StaleCandidate
 * @property {number} pid
 * @property {string} name
 * @property {string} category
 * @property {string} label
 * @property {number|null} port
 * @property {number|null} ageMinutes
 * @property {boolean} stale
 * @property {'high'|'medium'|'low'} confidence
 * @property {string} reason
 * @property {SuggestedKill} suggested
 */

/**
 * @typedef {object} MetricsContext
 * @property {SystemAdapter} system
 * @property {number} cpuCount
 */

/**
 * One host snapshot from the system probe: Task-Manager-style memory, per-core
 * CPU, every fixed volume, battery state, and the process count. Any field may
 * be absent when a class is unavailable.
 * @typedef {object} SystemSnapshot
 * @property {{ totalBytes: number, freeBytes: number, availableBytes: number, usedBytes: number, usedPercent: number, committedBytes: number|null, commitLimitBytes: number|null, cacheBytes: number|null }|null} memory
 * @property {{ totalPercent: number|null, perCore: Array<{ index: number, percent: number }> }} cpu
 * @property {Array<{ path: string, totalBytes: number, freeBytes: number, usedBytes: number, usedPercent: number, freePercent: number }>} volumes
 * @property {{ percent: number, charging: boolean, runtimeMinutes: number|null }|null} battery
 * @property {number|null} processCount
 */

/**
 * @typedef {object} Probes
 * @property {(options?: { fresh?: boolean }) => Promise<ProcessSnapshot>} processTable
 * @property {(options?: { fresh?: boolean }) => Promise<ListenerSnapshot>} listeners
 * @property {() => Promise<GpuInfo|null>} gpu
 * @property {(options?: { fresh?: boolean }) => Promise<SystemSnapshot|null>} systemSnapshot
 * @property {() => void} clearCache
 * @property {() => void} clearNotes
 * @property {() => string[]} notes
 */

/**
 * @typedef {object} SuggestedKill
 * @property {'port_kill'|'process_kill'} tool
 * @property {Record<string, number|string>} args
 * @property {string} note
 */

/**
 * @typedef {{ ok: true, [key: string]: unknown }} OkResult
 * @typedef {{ ok: false, error: string, hint?: string, details?: unknown }} ErrResult
 */

export {};
