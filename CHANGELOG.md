# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `ports_list` on Windows no longer fails when a cold `pwsh` plus `Get-NetTCPConnection` exceeds the probe timeout: the primary listener probe now gets a bounded 15 s timeout and automatically falls back to a bounded `netstat -ano -p tcp` parse. If both probes fail, the tool reports `available: false` with both failure reasons and every flagged port status is `unknown` instead of claiming zero listeners.
- `port_kill` re-verifies the listener through the same fallback source and refuses with `listener_probe_unavailable` when the listener table cannot be read — it never kills blind.
- `stale_dev_processes` keeps working without a listener table (no port associations, `process_kill` suggestions only) and says so in `notes`.
- `host_stats` renders an explicit `GPU: not available` line (`gpuStatus: "unavailable"`) when `nvidia-smi` is absent instead of silently omitting the GPU row.

## [0.1.0] - 2026-11-08

Initial release. Package `@darkmintis/dsh-host-health`, a DeepSeek Harness profile bundle.

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
