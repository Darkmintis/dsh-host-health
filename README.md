# dsh-host-health

Host health and stale-dev-process tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): answer “why is this laptop hot / what is holding port 5173 / can I safely stop that emulator?” without leaving the conversation.

This is a **DSH profile bundle**. It adds five Host tools and a small read-only Web Client card set:

| Tool | Purpose |
| --- | --- |
| `host_stats` | Host RAM/CPU/volumes/battery/GPU plus connected Android devices (RAM, CPU, /data, battery), top processes, dev highlights |
| `ports_list` | TCP listeners with PID and process name, every known dev port flagged |
| `stale_dev_processes` | Detects leftover preview servers, Flutter/Dart runs, Android emulators, Gradle daemons, and suggests a safe target |
| `port_kill` | Kills the single process listening on a port — **requires approval**, re-verifies identity |
| `process_kill` | Kills one PID — **requires approval**, re-verifies identity (optional `expectedName` pin) |

Reads are approval-free; only the two kill tools ask. The plugin never requests administrator rights, never sends telemetry, never uses the network, and never writes files.

## Pitch

A local dev machine accumulates noise: a Vite preview server from three days ago, two Gradle daemons, an emulator whose AVD was deleted, and a Flutter run attached to no device. `host_stats` gives a compact health snapshot; `ports_list` shows exactly what owns each port; `stale_dev_processes` explains which leftovers are probably safe to stop and names the exact kill target. Kills are gated: the approval prompt is explicit, the target identity is read again immediately before the signal, and known system processes or the Harness host itself are always refused. Everything is bounded and cached in memory, so repeated polling stays cheap.

## Requirements

- DeepSeek Harness **>= 0.2.2-rc.1** with a profile that mounts `@deepseek-ai/dsh-tools` (the default desktop profile does).
- **Node 24+** (the plugin uses only Node builtins at runtime; no Python, no npm install for end users).
- **Windows 10/11 is the primary target.** macOS 12+ and Linux work through `ps`, `ss`, and `lsof` fallbacks; GPU data needs `nvidia-smi` and is always optional.
- No administrator rights are required for any tool. Processes owned by other users or elevated processes can be read (partially) but cannot be killed.

## Install

v0.1.0 is **not published to npm**. Install it from a checkout with the Plugin Manager, which installs the package into the active profile and enables the bundle:

```text
plugin_manager action=install_bundle target="<absolute-path-to>/dsh-host-health"
```

`install_bundle` performs the package installation; do not copy files into the profile or edit the profile `package.json` by hand. After installation, ask the agent for `host_stats` — if you are in the same session, the tools become available on the next model step.

If you maintain the profile composition by hand, the bundle row is this snippet in the profile’s `cordis.patch.yml` (the package’s own patch does the same thing when the bundle is selected):

```yaml
- insert:
    - id: dsh-host-health
      name: '@darkmintis/dsh-host-health'
      config: {}
```

Notes:

- The bundle manifest is `package.json` with `dsh.bundle.patch`; the client card set is exported as `./client` and loaded by the Web UI. A Host-only session without the Web Client still gets every tool.
- The optional row `config` is `{}`. v0.1.0 accepts these optional overrides, all with safe defaults: `cacheTtlMs`, `staleAfterMinutes`, `maxProcesses`, `maxStaleEntries`, and `thresholds.ramPercent` / `thresholds.diskFreeBytes` / `thresholds.diskFreePercent`. They are read defensively and are not schema-validated in this release.
- **Restart DSH after installing or replacing the package.** Host plugin JavaScript is loaded once per DSH process; a page reload or client HMR only reloads the Web Client half. Every Host tool result includes `pluginVersion` so you can confirm the running generation.
- `npm publish` is intentionally **not** part of v0.1.0.

## Security and permissions

Read [SECURITY.md](SECURITY.md) for the full policy. Short version:

- **Read-only by default.** Three of five tools only read process/listener/resource data. Nothing is written to disk; probe results are cached in memory for ~2.5 s and the cache vanishes with the plugin.
- **No telemetry, no network.** The plugin makes no outbound requests and has no analytics. GPU data comes from a local `nvidia-smi` process; probes are local PowerShell/`ps`/`ss`/`lsof` calls.
- **Approval-gated kills.** `port_kill` and `process_kill` are registered as destructive tools: the Host’s `tools/pre-execute` waterfall returns `{ kind: 'ask', reason }` for them. If an approval channel is unavailable, the call fails closed instead of running.
- **Identity re-verification.** Kills read a fresh listener/process snapshot after approval. `port_kill` requires exactly one PID on the port and re-reads the listener table immediately before signalling; a changed PID aborts. `process_kill` re-reads the process table and aborts when the PID now names a different executable; an optional `expectedName` pins the name.
- **Never kills system processes.** PIDs ≤ 16, the Harness host PID, its parent, and names such as `System`, `smss`, `csrss`, `wininit`, `services`, `lsass`, `winlogon`, `svchost`, `launchd`, and `systemd` are refused with a reason.
- **No administrator rights, no elevation.** The plugin never calls `sudo`, never spawns an elevated helper, and reports `access_denied` when a target is elevated or owned by another user.
- **No arbitrary commands.** There is no “run this command” tool; every child process is a fixed, bounded probe with a hard timeout, captured output, and an argument vector (never a shell).
- **What it reads:** resource counters, the process table (name, pid, parent, working set, cumulative CPU time, command line, creation time), TCP listener table, disk capacity, uptime/load, and optional GPU counters. Command lines are truncated in output (400 chars stored, 160 shown).
- **What it can terminate:** only an explicitly approved single process, after the checks above. No tree kills.

## Screenshots and GIF placeholders

Visual capture is intentionally deferred in v0.1.0 (the plugin ships a minimal read-only card set; screenshots are taken by the maintainers during the first public release):

| Asset | Suggested content |
| --- | --- |
| `docs/screenshots/host-stats.png` | Host stats card expanded with RAM/CPU/disk and top processes |
| `docs/screenshots/ports-list.png` | Port list card with a flagged Vite dev port |
| `docs/screenshots/stale-dev-processes.png` | Stale dev-process candidates with suggested kill targets |
| `docs/screenshots/approval.png` | Approval prompt for `port_kill` |
| `docs/gifs/stale-process-cleanup.gif` | `ports_list` → `stale_dev_processes` → `port_kill` flow |

These paths are placeholders; add the real captures before the first tagged release.

## Visual panel

Installing the bundle also adds a compact **usage strip pinned to the window's
top strip** (top-right, just left of minimize/maximize/close). It is registered
in the frame-wide overlay layer, so it stays visible in every Session and
workspace — chat, settings, and archives alike:

```
● CPU 18% · RAM 74% · 37.5 GB free   ▾
```

- The strip refreshes every three seconds and turns amber at 80% RAM and red at
  92% RAM or when the Host API is unreachable. It also shows battery state when
  the host reports a battery.
- Clicking it opens a modern, single-surface popover — fixed-positioned so the
  header cannot clip it — with a **target switcher** (This PC plus every
  connected Android device), headline CPU/memory cards, a colourful storage card
  with every fixed volume, per-core bars, battery/AC state, GPU, committed
  memory, and one **sortable process table** (Process · RAM · CPU · PID — click a
  value column to flip highest/lowest). Process rows never show command lines.
  Data is fetched when the plugin loads and refreshed every three seconds, so the
  popover opens already populated instead of showing a loading state.
- Choose a phone in the switcher to read that device's RAM, /data usage, CPU,
  and battery without leaving the Harness.
- Kill buttons ask for a browser confirmation, then call the same service methods
  as `port_kill` / `process_kill`, so identity re-verification and protected-PID
  refusals are identical. The panel requests go through the Host web server and
  are rejected unless they pass the connection trust fence.

The strip is registered only in profiles that compose the Web server and
connection services; headless profiles keep the five tools.

> Upgrading a bundle updates the Host half when the app starts, so quit and
> restart DeepSeek Harness once after installing a new version.
## Mobile health over adb

When an Android phone or emulator is connected with adb, `host_stats` grows a
**Devices** section and the panel adds one compact card per device:

- model, Android version/SDK, and the adb serial;
- memory used/available from `/proc/meminfo`;
- `/data` usage from `df /data`;
- battery level, charging state, and temperature from `dumpsys battery`;
- CPU percentage computed from two consecutive `/proc/stat` samples (the strip
  polls every few seconds, so the second sample arrives on the next refresh).

Up to four devices are reported per call; multi-device setups get one card each.
Linux/macOS hosts use the same adb binary. No device is required: without adb or
a connected device the host section renders alone and the plugin reports
`mobileStatus: "unavailable"` / `"none"` in the JSON.

The plugin resolves the adb binary from `ADB`, `ANDROID_HOME`,
`ANDROID_SDK_ROOT`, the standard SDK locations, then `PATH`. Every adb call is a
bounded child process with a captured, capped output — like every other probe.
## Tool reference

### `host_stats`

Snapshot host resources, top processes, and dev highlights. Read-only.

- Arguments: `{}`, optionally `{ "includeProcesses": false }` or `{ "includeGpu": false }`.
- Example result (abbreviated):

```json
{
  "ok": true,
  "pluginVersion": "0.1.0",
  "host": { "hostname": "dev-box", "platform": "win32", "arch": "x64", "cpuCount": 16, "uptimeSeconds": 57020 },
  "memory": { "usedBytes": 14323601408, "totalBytes": 16441667584, "usedPercent": 87.1 },
  "cpu": { "percent": 12.3 },
  "disk": { "path": "C:\\", "freeBytes": 148647677952, "freePercent": 34.7 },
  "load": [0, 0, 0],
  "gpu": { "name": "NVIDIA GeForce RTX 3060", "vramTotalMb": 12288, "vramUsedMb": 4096, "utilizationPercent": 37 },
  "topRam": [{ "pid": 1234, "name": "chrome.exe", "ramMb": 2341.2, "cpuPercent": 4.2, "commandLine": "chrome.exe --remote-debugging-port=9222" }],
  "topCpu": [{ "pid": 2345, "name": "node.exe", "ramMb": 512.4, "cpuPercent": 23.1, "commandLine": "node .../vite.js" }],
  "devProcesses": [{ "pid": 2345, "name": "node.exe", "kind": "preview-server", "label": "Preview/dev server", "ramMb": 512.4, "cpuPercent": 23.1, "port": null }],
  "warnings": [{ "code": "ram_high", "severity": "warn", "message": "RAM usage is 87.1% ... above the 85% threshold." }],
  "notes": []
}
```

Top lists are capped at 8 entries; RAM and CPU values are rounded; command lines are truncated. GPU data is best-effort: when `nvidia-smi` is absent or no NVIDIA GPU exists the value is `null`, `gpuStatus` is `"unavailable"`, and the rendered output explicitly says `GPU: not available` (it is never an error). Setting `includeGpu: false` reports `gpuStatus: "skipped"` and omits the line.

### `ports_list`

List TCP listeners and flag known dev ports plus any requested ones. Read-only.

- Arguments: `{}` or `{ "ports": [8787, 3000] }` (extra ports to flag, integers 1–65535).
- Known dev ports always flagged: **8787** (web preview), **5554** (Android emulator console), **8000** (local HTTP server), **5173** (Vite dev server), **53365** (DeepSeek Harness Web UI).
- Listener sources: bounded `Get-NetTCPConnection` (15 s) with an automatic bounded `netstat -ano -p tcp` fallback on Windows; `ss`/`lsof` on macOS/Linux. When every listener probe fails, the result has `available: false` and every flagged port status is `unknown` — the tool never claims there are zero listeners. The result’s `source` field (`powershell`/`netstat`/`ss`/`lsof`) shows which table supplied the data.
- `FREE` means **no enumerable listener**, not “the port is bindable”. A port can be genuinely bound and serving while all host enumeration APIs hide it (Windows network compartments, WSL/container boundaries, VPN/filter drivers, or security software). The plugin does not probe with a network connect and never kills a process it cannot identify; see Troubleshooting.
- Example result (abbreviated):

```json
{
  "ok": true,
  "pluginVersion": "0.1.0",
  "available": true,
  "source": "powershell",
  "listeners": [{ "port": 5173, "address": "127.0.0.1", "pid": 1234, "name": "node.exe", "knownDevPort": true, "devLabel": "Vite dev server" }],
  "flagged": [
    { "port": 5173, "status": "in_use", "pid": 1234, "name": "node.exe", "knownDevPort": true, "devLabel": "Vite dev server" },
    { "port": 8787, "status": "free", "pid": null, "name": null, "knownDevPort": true, "devLabel": "web preview server" }
  ],
  "warnings": [{ "code": "port_in_use", "severity": "warn", "message": "Port 5173 (Vite dev server) is in use by node.exe (pid 1234)." }],
  "notes": []
}
```

Listener output is capped at 80 rows (`truncated` reports omissions). Same PID on IPv4 and IPv6 appears once.

### `stale_dev_processes`

Detect leftover dev tooling and explain it. Read-only.

- Arguments: `{}`.
- Returns candidates with `category`, `label`, `port`, `ageMinutes`, `stale`, `confidence` (`high`/`medium`/`low`), a `reason`, and a `suggested` target (`port_kill` or `process_kill`) that still requires approval.
- Listener data comes from the same bounded probe path as `ports_list` (15 s PowerShell bound → `netstat` fallback), and a listener snapshot cached by a recent `ports_list` is reused when still fresh. Results carry `listenerProbeAvailable` and `listenerSource`; when the table is unavailable, entries have no `port` and suggest `process_kill` only.
- Heuristics: Gradle daemons older than 180 min are stale; preview servers older than 30 min are stale; Flutter/Dart runs and emulators are reported as candidates with explicit caveats (an emulator may be intentionally running). The Harness host process is never a candidate.
- Example result (abbreviated):

```json
{
  "ok": true,
  "pluginVersion": "0.1.0",
  "staleAfterMinutes": 30,
  "count": 1,
  "listenerProbeAvailable": true,
  "listenerSource": "netstat",
  "entries": [{
    "pid": 1234,
    "name": "node.exe",
    "category": "preview-server",
    "label": "Preview/dev server",
    "port": 8787,
    "ageMinutes": 120,
    "stale": true,
    "confidence": "high",
    "reason": "Dev server has been running for 2 h (listening on port 8787); likely a leftover preview server from an earlier session. Port 8787 is a known web preview server port.",
    "suggested": { "tool": "port_kill", "args": { "port": 8787 }, "note": "Frees port 8787 and re-verifies the listener identity immediately before killing." }
  }],
  "notes": []
}
```

### `port_kill`

Kill the single process listening on a port. **Approval required.**

- Arguments: `{ "port": 5173 }`.
- Flow: approval prompt → fresh listener read (PowerShell primary or netstat fallback) → exactly one owner required → fresh process identity read → system/self/parent refusal checks → listener re-read immediately before the signal via the same source → `SIGTERM` (TerminateProcess on Windows) → bounded verification window.
- Success: `{ "ok": true, "killed": { "port": 5173, "pid": 1234, "name": "node.exe" }, "verifiedGone": true, "method": "SIGTERM", "listenerSource": "powershell" }`.
- Failures are structured: `no_listener`, `ambiguous_listener`, `listener_probe_unavailable`, `process_not_found`, `identity_changed`, `protected_pid`, `protected_process`, `self_protected`, `parent_protected`, `access_denied`, `kill_failed`, `unsupported_platform`, `invalid_port`.
- If the listener table is unavailable at any point (both listener probes failed), the kill is refused with `listener_probe_unavailable` — it never kills blind from a stale or empty table.

### `process_kill`

Kill one local process by PID. **Approval required.**

- Arguments: `{ "pid": 1234 }`, optionally `{ "pid": 1234, "expectedName": "node" }`.
- Flow: approval prompt → fresh process table read → system/self/parent refusal checks → optional expected-name check → process table re-read immediately before the signal → `SIGTERM` → bounded verification window.
- `verifiedGone: false` means the signal was delivered but the process was still visible after 1.5 s (typically elevated or protected).
- Never kills process trees; stop the parent application or use its own quit action when a tree matters.

## Thresholds

`host_stats` surfaces warnings in its output and status text only (no background watcher, no status file):

| Warning | Default threshold | Override |
| --- | --- | --- |
| `ram_high` | RAM used > 85% | `config.thresholds.ramPercent` |
| `disk_low` | Disk free < 10 GB or < 10% | `config.thresholds.diskFreeBytes`, `config.thresholds.diskFreePercent` |
| `port_in_use` | A flagged dev/requested port has a listener | — (reported by `ports_list`) |

## Platform support

| Capability | Windows 10/11 | macOS | Linux |
| --- | --- | --- | --- |
| RAM/CPU/disk/uptime | Node builtins | Node builtins | Node builtins |
| Process table | `Get-CimInstance Win32_Process` (bounded PowerShell) | `ps` | `ps` |
| CPU per process | Cumulative CPU-time deltas | Cumulative CPU-time deltas | Cumulative CPU-time deltas |
| TCP listeners | `Get-NetTCPConnection` (15 s bound) → `netstat -ano -p tcp` fallback | `lsof`, `ss` fallback | `ss`, `lsof` fallback |
| GPU | `nvidia-smi` if installed | `nvidia-smi` if installed | `nvidia-smi` if installed |
| Kills | `process.kill` (no elevation) | `SIGTERM` | `SIGTERM` |

macOS/Linux support is implemented and unit-tested against captured fixtures but has not been exercised on real macOS/Linux hosts in v0.1.0; report issues with your `host_stats` output.

## Troubleshooting

- **`process_table_unavailable: ... spawn EPERM`** — the plugin is running inside a sandbox that forbids child processes. In a normal DSH Host process the probes work; in restricted shells they fail closed with this note. Run the tool from a normal DSH session.
- **`process_table_unavailable: ... no PowerShell executable available`** — Windows needs `pwsh` (PowerShell 7+) or `powershell.exe` on `PATH`. Install PowerShell 7 or add Windows PowerShell to `PATH`.
- **`listener_probe_unavailable`** — both the bounded `Get-NetTCPConnection` probe (15 s) and the bounded `netstat -ano -p tcp` fallback failed (or, on macOS/Linux, both `ss` and `lsof` failed). `ports_list` reports `available: false` with “probe unavailable”, not “0 listeners”; `stale_dev_processes` continues without port associations; `port_kill` refuses because it cannot re-verify the target. `host_stats` remains unaffected.
- **`listener_probe_fallback` note** — the primary listener probe timed out or failed, so the bounded `netstat` fallback supplied the table. This is expected on slow machines where a cold `pwsh` plus `Get-NetTCPConnection` exceeds the 15 s bound; subsequent probes reuse the fallback source.
- **`FREE` is not proof the port is bindable** — a genuinely bound port can be hidden from every host enumeration API (`netstat -ano -p tcp`, `Get-NetTCPConnection`) by Windows network compartments, WSL/container boundaries, VPN/filter drivers, or security software, while a TCP connect still succeeds and a bind returns `EADDRINUSE`. `ports_list`/`stale_dev_processes` report only what the OS lets them enumerate (`source` tells you which table was used); `port_kill` refuses with `no_listener`/`listener_probe_unavailable` instead of killing a process it cannot identify. If you can reproduce a bound-but-invisible listener, capture `ports_list`, its `notes`, a raw connect, and the owning process from an elevated Task Manager/Resource Monitor and report it — this is an OS observation limit, not a plugin capability to work around safely.
- **GPU shows `null` / `GPU: not available`** — no `nvidia-smi` on `PATH` or no NVIDIA GPU. This is never an error; `gpuStatus` reports `"unavailable"` and the line is explicit instead of silently missing.
- **`gpuStatus`/`pluginVersion` fields or the GPU line are missing entirely** — the running Host module generation predates them. Installing/replacing a bundle does not reload Host JavaScript in a live DSH process: a full DSH restart is required (a page reload or client HMR only reloads the `client.js` half). After reinstalling, restart DSH and confirm `host_stats` contains `"pluginVersion": "0.1.0"` and `"gpuStatus"`.
- **`ambiguous_listener`** — more than one distinct PID listens on the port (for example an IPv4 forwarder and a different IPv6 process). Inspect `ports_list` and use `process_kill` with the intended PID.
- **`identity_changed` / `process_not_found`** — the process exited or the PID was reused between approval and the kill. Re-run `ports_list`/`stale_dev_processes`; nothing was killed.
- **`access_denied`** — the target is elevated or owned by another user. The plugin deliberately does not request admin rights.
- **A kill returned `verifiedGone: false`** — the signal was delivered but the process is still alive (elevated, protected, or shutting down slowly). Check Task Manager / Activity Monitor.
- **Ports look empty though a server runs in WSL/Docker** — only the host's own listener table is visible; WSL/Docker listeners live in their own network namespace.
- **Results look stale for ~2.5 s** — expensive probes are cached in memory to keep polling cheap. The cache is per process and expires with the plugin.
- **`unsupported_platform`** — v0.1.0 implements win32, darwin, and linux; other platforms fail closed for process/port tools while `host_stats` still reports Node-level resource data.

## Development

```sh
# Local npm needs the workspace cache (the default cache path is blocked in this environment):
$env:npm_config_cache = '<workspace>/.npm-cache'   # PowerShell
npm install

npm run typecheck   # tsc --noEmit with checkJs over index.js, lib/, and scripts/
npm run lint        # node --check on every JS file + forbidden-pattern guard (shell, network, DOM, require allowlist)
npm test            # node --test over test/ (unit + fixture integration)
npm run build       # static package/bundle readiness checks
npm run smoke       # manual real-host probe, prints JSON; not part of CI
```

Design rules:

- **Injectable everything.** The probe runner, system adapter, process control, clock, and sleep are constructor arguments, so tests are deterministic and never depend on live CIM or a real process table.
- **Bounded probes only.** Every child process has a hard timeout, captured output, an output-size cap, and an argument vector (never a shell). No streaming, no unbounded reads.
- **Pure logic, thin I/O.** Parsers, CPU math, classification, thresholds, and renderers are pure functions tested against fixtures; the service composes them.
- **Fixture-tested parsing.** `test/fixtures/` contains captured PowerShell/`ps`/`ss`/`lsof`/`netstat`/`nvidia-smi` outputs. See [CONTRIBUTING.md](CONTRIBUTING.md).
- **Honest unavailability.** A failed listener probe is reported as `available: false` (never an empty table), both probe reasons are surfaced, and destructive tools refuse rather than act on unknown state. Listener probes get a longer bounded timeout (15 s) because `Get-NetTCPConnection` is slow, with a bounded `netstat` fallback.
- **Client safety.** The client half requires only `react`; malformed blocks render `null`; no DOM writes, timers, fetches, or first-party imports.

## Documentation

- [AGENTS.md](AGENTS.md) — invariants for agents working on this repository.
- [SECURITY.md](SECURITY.md) — security and privacy policy.
- [CONTRIBUTING.md](CONTRIBUTING.md) — development workflow and PR checklist.
- [CHANGELOG.md](CHANGELOG.md) — release notes.

## License

[MIT](LICENSE) © 2026 Darkmintis
