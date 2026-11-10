# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Mobile health over adb**: `host_stats` reports each connected Android device
  (model, Android/SDK, memory, `/data` usage, battery/charging/temperature, and
  CPU from consecutive `/proc/stat` samples). The dropdown renders one compact
  card per device, and multi-device setups list every device. adb is resolved
  from `ADB`/`ANDROID_HOME`/SDK paths/`PATH` and every call is bounded.
- Host snapshot now also covers per-core CPU, every fixed volume, battery, and
  the process count (Task-Manager-grade numbers).
- Redesigned dropdown: headline CPU/memory cards, a colourful storage card with
  every volume, battery/AC, per-core bars, and compact process tables without
  command lines. The collapsed pill shows CPU, RAM, battery, and device count —
  no disk storage.

### Changed

- The health overlay is now two **ghost pills in the composer dock**, matching the
  shipped "N turns M steps" / "Cache hit" pills, with dialogs styled like the
  official Session statistics and Token usage panels (icon title, key number,
  half-pixel rule, two-column label/value grid). Host dialog shows CPU (peak
  core), memory + committed, every fixed volume, process count, uptime, and top
  CPU/RAM processes; the devices pill appears only when an Android device is
  attached and lists RAM / `/data` / CPU per device. Battery is no longer shown.

### Changed

- The dropdown has one **sortable process table** (click RAM/CPU/PID to sort
  highest or lowest) instead of separate top-CPU and top-RAM tables, and a
  **target switcher** that shows this PC or any connected Android device's RAM,
  storage, CPU, and battery in place.

### Changed

- The health overlay is now two **ghost pills in the composer dock**, matching the
  shipped "N turns M steps" / "Cache hit" pills, with dialogs styled like the
  official Session statistics and Token usage panels (icon title, key number,
  half-pixel rule, two-column label/value grid). Host dialog shows CPU (peak
  core), memory + committed, every fixed volume, process count, uptime, and top
  CPU/RAM processes; the devices pill appears only when an Android device is
  attached and lists RAM / `/data` / CPU per device. Battery is no longer shown.

### Changed

- Redesigned the host-health dropdown as one modern surface: headline CPU /
  memory / disk cards, per-core bars, volume and battery rows, and compact
  process tables without command lines. The popover renders from prefetched
  data, so it opens populated instead of showing "loading/reading" text.

### Added

- **Frame usage strip**: a compact CPU/RAM/free-disk pill pinned to the window's
  top strip (left of the native window buttons) through the `shell.overlay`
  layer, visible in every Session and workspace, with a one-click,
  fixed-positioned details popover (overview bars, top
  processes, ports with kills, stale processes with kills). It polls every three
  seconds, degrades to an `offline` badge when the Host API is unreachable, and
  uses the desktop transport origin when the page is not served from the HTTP host.
- **Panel HTTP API** (`/dsh-host-health/api/`) registered through the Web server
  and admitted by the connection trust fence: stats, ports, stale processes, and
  user-confirmed kills. The API is absent in headless profiles.
- Panel API tests: unauthenticated rejection, structured payloads, port/pid kill
  routing, invalid-target refusal, and error shapes.

### Added

- **Mobile health over adb**: `host_stats` reports each connected Android device
  (model, Android/SDK, memory, `/data` usage, battery/charging/temperature, and
  CPU from consecutive `/proc/stat` samples). The dropdown renders one compact
  card per device, and multi-device setups list every device. adb is resolved
  from `ADB`/`ANDROID_HOME`/SDK paths/`PATH` and every call is bounded.
- Host snapshot now also covers per-core CPU, every fixed volume, battery, and
  the process count (Task-Manager-grade numbers).
- Redesigned dropdown: headline CPU/memory cards, a colourful storage card with
  every volume, battery/AC, per-core bars, and compact process tables without
  command lines. The collapsed pill shows CPU, RAM, battery, and device count —
  no disk storage.

### Changed

- The health overlay is now two **ghost pills in the composer dock**, matching the
  shipped "N turns M steps" / "Cache hit" pills, with dialogs styled like the
  official Session statistics and Token usage panels (icon title, key number,
  half-pixel rule, two-column label/value grid). Host dialog shows CPU (peak
  core), memory + committed, every fixed volume, process count, uptime, and top
  CPU/RAM processes; the devices pill appears only when an Android device is
  attached and lists RAM / `/data` / CPU per device. Battery is no longer shown.

### Changed

- The dropdown has one **sortable process table** (click RAM/CPU/PID to sort
  highest or lowest) instead of separate top-CPU and top-RAM tables, and a
  **target switcher** that shows this PC or any connected Android device's RAM,
  storage, CPU, and battery in place.

### Changed

- The health overlay is now two **ghost pills in the composer dock**, matching the
  shipped "N turns M steps" / "Cache hit" pills, with dialogs styled like the
  official Session statistics and Token usage panels (icon title, key number,
  half-pixel rule, two-column label/value grid). Host dialog shows CPU (peak
  core), memory + committed, every fixed volume, process count, uptime, and top
  CPU/RAM processes; the devices pill appears only when an Android device is
  attached and lists RAM / `/data` / CPU per device. Battery is no longer shown.

### Changed

- Redesigned the host-health dropdown as one modern surface: headline CPU /
  memory / disk cards, per-core bars, volume and battery rows, and compact
  process tables without command lines. The popover renders from prefetched
  data, so it opens populated instead of showing "loading/reading" text.

### Added

- **Task-Manager-grade `host_stats`**: memory now reports available/committed/
  commit-limit/cache bytes, CPU reports the aggregate counter plus per-core
  utilisation, and the snapshot adds every fixed volume, battery charge/AC state,
  and the process count. Overflow-friendly text rendering and dropdown UI
  (per-core bars, per-volume bars, battery line).

### Fixed

- Health dialogs now anchor to the pill that opened them — left edge aligned to
  the pill and 8px above it, clamped to the viewport — instead of centering
  themselves in the window, matching how the shipped statistics dialogs open.

### Fixed

- Health dialogs now use the shipped menu surface (`--dsw-specific-menu` with
  elevation/backdrop tokens) instead of the generic overlay background, so they
  match the official Session statistics / Token usage dialogs. Top CPU and top
  RAM rows show a single process each (the three-row lists churned too fast).

### Fixed

- Health dialogs now anchor to the pill that opened them — left edge aligned to
  the pill and 8px above it, clamped to the viewport — instead of centering
  themselves in the window, matching how the shipped statistics dialogs open.

### Fixed

- **Desktop panel API**: the usage strip now resolves its API calls against the page origin. The desktop window runs at `dsh-app://app` and forwards page-relative requests to the Host with its authentication cookie; targeting the loopback HTTP origin directly was cross-origin and left the strip offline.

- `ports_list` on Windows no longer fails when a cold `pwsh` plus `Get-NetTCPConnection` exceeds the probe timeout: the primary listener probe now gets a bounded 15 s timeout and automatically falls back to a bounded `netstat -ano -p tcp` parse. If both probes fail, the tool reports `available: false` with both failure reasons and every flagged port status is `unknown` instead of claiming zero listeners.
- `port_kill` re-verifies the listener through the same fallback source and refuses with `listener_probe_unavailable` when the listener table cannot be read — it never kills blind.
- `stale_dev_processes` keeps working without a listener table (no port associations, `process_kill` suggestions only) and says so in `notes`.
- `host_stats` renders an explicit `GPU: not available` line (`gpuStatus: "unavailable"`) when `nvidia-smi` is absent instead of silently omitting the GPU row.
- `stale_dev_processes` now shares the same listener probe path as `ports_list` (15 s bounded PowerShell probe + `netstat` fallback), reads the listener snapshot before the slower process probe so a recent `ports_list` cache is reused, attaches ports to candidates, and reports `listenerProbeAvailable`/`listenerSource`. When the listener table is genuinely unavailable, candidates suggest `process_kill` only.
- Every Host tool result now includes `pluginVersion` so a stale Host module generation (package replaced without a full DSH restart) is detectable from tool output.
- Documented that `FREE` means “no enumerable listener”, not “bindable”: a port can be bound and serving yet hidden from all host enumeration (network compartments, WSL/container boundaries, security software). `port_kill` continues to refuse rather than kill blind.

## [0.1.0] - 2026-11-08

Initial release. Package `@darkmintis/dsh-host-health`, a DeepSeek Harness profile bundle.

### Added

- **Mobile health over adb**: `host_stats` reports each connected Android device
  (model, Android/SDK, memory, `/data` usage, battery/charging/temperature, and
  CPU from consecutive `/proc/stat` samples). The dropdown renders one compact
  card per device, and multi-device setups list every device. adb is resolved
  from `ADB`/`ANDROID_HOME`/SDK paths/`PATH` and every call is bounded.
- Host snapshot now also covers per-core CPU, every fixed volume, battery, and
  the process count (Task-Manager-grade numbers).
- Redesigned dropdown: headline CPU/memory cards, a colourful storage card with
  every volume, battery/AC, per-core bars, and compact process tables without
  command lines. The collapsed pill shows CPU, RAM, battery, and device count —
  no disk storage.

### Changed

- The health overlay is now two **ghost pills in the composer dock**, matching the
  shipped "N turns M steps" / "Cache hit" pills, with dialogs styled like the
  official Session statistics and Token usage panels (icon title, key number,
  half-pixel rule, two-column label/value grid). Host dialog shows CPU (peak
  core), memory + committed, every fixed volume, process count, uptime, and top
  CPU/RAM processes; the devices pill appears only when an Android device is
  attached and lists RAM / `/data` / CPU per device. Battery is no longer shown.

### Changed

- The dropdown has one **sortable process table** (click RAM/CPU/PID to sort
  highest or lowest) instead of separate top-CPU and top-RAM tables, and a
  **target switcher** that shows this PC or any connected Android device's RAM,
  storage, CPU, and battery in place.

### Changed

- The health overlay is now two **ghost pills in the composer dock**, matching the
  shipped "N turns M steps" / "Cache hit" pills, with dialogs styled like the
  official Session statistics and Token usage panels (icon title, key number,
  half-pixel rule, two-column label/value grid). Host dialog shows CPU (peak
  core), memory + committed, every fixed volume, process count, uptime, and top
  CPU/RAM processes; the devices pill appears only when an Android device is
  attached and lists RAM / `/data` / CPU per device. Battery is no longer shown.

### Changed

- Redesigned the host-health dropdown as one modern surface: headline CPU /
  memory / disk cards, per-core bars, volume and battery rows, and compact
  process tables without command lines. The popover renders from prefetched
  data, so it opens populated instead of showing "loading/reading" text.

### Added

- **`host_stats`** — RAM used/total/percent, CPU percent, disk free, uptime, load average, best-effort NVIDIA GPU data, top 8 processes by RAM and by CPU (name, PID, RAM MB, CPU %, truncated command line), and known dev-process highlights.
- **`ports_list`** — TCP listeners with owning PID and process name; always flags known dev ports `8787`, `5554`, `8000`, `5173`, `53365` and any extra requested ports; reports `in_use`/`free`, truncation, and port-in-use warnings.
- **`stale_dev_processes`** — detects leftover preview/dev servers, Flutter/Dart runs, Android emulators, and Gradle daemons with age, confidence, an explanation, and a suggested `port_kill`/`process_kill` target.
- **`port_kill`** and **`process_kill`** — approval-gated kills with fresh identity re-verification, system/self/parent protection, optional expected-name pinning, and bounded post-kill verification.
- Optional thresholds: RAM > 85%, disk free < 10 GB or < 10%, and flagged port occupancy, surfaced in tool output only (no background writer).
- Read-only Web Client tool cards for all five tools, implemented with plain React elements and no first-party imports.
- Bundle manifest (`dsh.bundle.patch`, `dsh.client`, locale metadata, original icon) for installation as a DSH profile bundle.
- Bounded probe layer: hard timeouts, output caps, injected command runner/system/clock/process control, and a ~2.5 s in-memory probe cache.

### Security

- Read-only by default; kills require an explicit approval prompt.
- The plugin never requests administrator rights, never uses the network, never sends telemetry, and never writes files.
- Machine-specific absolute paths are not used at runtime; the repository is scanned for them in CI.
- `SECURITY.md` documents what is read, what can be terminated, and how to report issues.

### Notes

- Windows 10/11 is the primary target. macOS/Linux paths (`ps`, `ss`, `lsof`) are implemented and fixture-tested but not exercised on real hosts in this release.
- Not published to npm in v0.1.0; install from the repository with the Plugin Manager.
- Screenshots/GIF placeholders are listed in the README and will be captured for the first tagged release.

[Unreleased]: https://github.com/Darkmintis/dsh-host-health/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Darkmintis/dsh-host-health/releases/tag/v0.1.0
