# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## What this plugin is

`@darkmintis/dsh-host-health` is a DeepSeek Harness profile bundle. It adds host-monitoring tools and two approval-gated termination tools to an agent. It runs inside the DSH Host process on the user's machine.

## Privacy

- **No telemetry.** The plugin contains no analytics, no crash reporting, and no usage reporting.
- **No network by default.** The plugin makes no outbound connections; it has no HTTP client code. GPU information comes from a local `nvidia-smi` executable, and process/port data comes from local bounded PowerShell, `ps`, `ss`, and `lsof` calls.
- **No file writes.** Probe results are held in an in-memory cache (about 2.5 s) and disappear when the plugin unloads. Threshold warnings are returned in tool output only; there is no background watcher and no status file.
- **No credentials.** The plugin never reads credentials, keys, tokens, browser profiles, or environment secrets.

## What it reads

- Resource counters from Node builtins: total/free RAM, aggregate CPU times, disk capacity of the system root, uptime, load average.
- The host process table: PID, parent PID, name, working-set bytes, cumulative CPU time, creation time, and command line (truncated to 400 characters when stored; 160 characters shown in output).
- The TCP listener table: local address, port, owning PID. Enumeration is best-effort and may be incomplete: a genuinely bound port can be hidden from all host enumeration APIs (Windows network compartments, WSL/container boundaries, VPN/filter drivers, security software). `FREE` therefore means “no enumerable listener”, never “bindable”, and the plugin never kills a process it cannot identify from a fresh listener/process re-check.
- Optionally, local GPU counters from `nvidia-smi`.
- A local command line may contain sensitive arguments (paths, tokens passed as CLI flags). The plugin only displays it to the requesting agent/user as tool output; it does not transmit it anywhere. Avoid passing secrets on command lines if tool output may be shared.

## What it can terminate

Only through `port_kill` or `process_kill`, both of which require the Host approval prompt before they execute. After approval:

- `port_kill` requires exactly one PID to own the requested port. It reads a fresh listener table and a fresh process table, refuses protected targets, re-reads the listener table immediately before signalling, then sends `SIGTERM` (mapped to `TerminateProcess` on Windows) to that single process.
- `process_kill` reads a fresh process table, refuses protected targets, optionally checks an `expectedName`, re-reads the process table immediately before signalling, then sends `SIGTERM` to that single PID.
- No process trees are killed. No service control, no scheduled-task changes, and no registry writes are performed.

Protected targets are always refused: PIDs at or below 16, the DSH Host process itself, its parent process, and system-critical process names (`System`, `Registry`, `smss`, `csrss`, `wininit`, `services`, `lsass`, `winlogon`, `svchost`, `launchd`, `systemd`, and related).

## Privileges

The plugin never requests administrator or root rights and never attempts elevation. Processes that are elevated or owned by other users are reported as `access_denied` instead of being killed.

## Child processes

Every external probe is bounded: started without a command shell, given an argument vector, killed after a hard timeout, with stdout/stderr capped. There is no “execute arbitrary command” capability.

## Reporting a vulnerability

Please report security issues privately through GitHub's security advisory flow on `https://github.com/Darkmintis/dsh-host-health` (“Security” → “Report a vulnerability”). Include the plugin version, DSH version, OS, the tool call used, and the observed behaviour. Do not open a public issue for a vulnerability before a fix is available.

We aim to acknowledge reports within 5 business days and to publish a fixed release within 30 days for validated issues.
