# Agent notes — dsh-host-health

Instructions for AI coding agents (and humans acting like them) working on this repository. Read this before changing runtime behaviour.

## What this package is

A DeepSeek Harness profile bundle that exposes five Host tools (`host_stats`, `ports_list`, `stale_dev_processes`, `port_kill`, `process_kill`) plus a read-only Web Client card set. The bundle contract lives in `package.json` (`dsh.bundle.patch`, `dsh.client`, `exports`, `files`) and `cordis.patch.yml`. `index.js` is the Host entry, `client.js` the Client artifact, `lib/` the implementation, `scripts/` the checks.

## Invariants — do not break these

1. **Read-only by default.** Only `port_kill` and `process_kill` may change host state. Every other tool must remain a pure read. Do not add file writes, config writes, registry writes, or background writers. Threshold warnings must stay in tool output only.
2. **Approval before any kill.** Both kill tools must be listed in `DESTRUCTIVE_TOOLS` (lib/constants.js) and the `tools/pre-execute` listener must return `{ kind: 'ask', reason }` for them. Read-only tools must return `next()`. Never let a kill tool bypass the approval waterfall or catch an approval failure into “allowed”.
3. **Re-verify identity immediately before killing.** After approval, kills must read fresh probes and re-check the target: `port_kill` requires exactly one PID and re-reads the listener table right before `SIGTERM`; `process_kill` re-reads the process table and abort on PID reuse or name mismatch. Compare with `sameProcessIdentity` / `normalizeProcessName`; never kill from cached probe data.
4. **Never kill protected targets.** Refuse PIDs ≤ 16, the Harness host PID (`control.selfPid`), its parent, and names in `PROTECTED_PROCESS_NAMES`. Add a test for every new protection.
5. **Bounded probes only.** Every external command goes through `lib/command.js`: `spawn` without a shell, hard timeout, output cap, captured stdout/stderr, argument vector. No `execSync`, no `shell: true`, no unbounded streaming, no shell interpolation. Every probe call must set or inherit a timeout.
6. **No administrator rights.** Never attempt elevation, `sudo`, `runas`, service control, or system-wide changes. Report `access_denied` instead.
7. **No telemetry, no network.** No outbound HTTP, DNS, analytics, or crash reporting. `nvidia-smi` and local shell/process probes are the only external processes.
8. **No arbitrary commands.** Do not add a tool that executes user-supplied command lines, scripts, or paths. Tool parameters are validated data.
9. **No machine-specific state.** Never hardcode absolute paths, usernames, hostnames, ports of a particular machine, or credentials. Detect at runtime (`lib/system.js`, `lib/powershell.js`) and document examples with `<path>` placeholders.
10. **Client half stays passive.** `client.js` may require only `react` and `react/jsx-runtime`; it renders plain React elements only. No DOM writes outside the component, no timers, no fetches, no first-party imports, no state mutation. A malformed block must render `null`, never throw.
11. **Locale and icon stay shipped.** `locale/en.json` carries `meta.title`, `meta.description`, card strings; `icon.svg` is original artwork under 256 KiB. Every new runtime file must be added to `package.json` `files` and (if applicable) `exports`.
12. **No push/publish from agent sessions.** The Lead/maintainer handles `git push`, tags, and `npm publish`. Never run them.
13. **Deterministic tests.** Tests must not depend on a live process table, real CIM, real ports, or timing races. Use `test/helpers.js` fakes and `test/fixtures/`; inject the probe runner, clock, and process control.
14. **Keep the text tools truthful.** When a probe fails, surface a `notes` entry explaining the failure; never invent process/port data and never present cached data as fresh.

## Change workflow

1. Read `lib/service.js` and the touched module first; the service composes probes, CPU math, classification, thresholds, renderers, and kills.
2. Prefer pure functions in `lib/parsers.js`, `lib/cpu.js`, `lib/devprocess.js`, `lib/thresholds.js`, `lib/render.js`; I/O stays in `lib/probes.js`, `lib/system.js`, `lib/kill.js`, `lib/command.js`.
3. Add or extend fixture-based tests for every parser, classification rule, tool renderer, and error path you touch.
4. Run the full gate before committing: `npm run typecheck && npm run lint && npm test && npm run build`.
5. Update docs in the same change: `README.md` (tool reference/troubleshooting), `CHANGELOG.md` (Unreleased), and this file when an invariant changes.

## Commit conventions

Conventional Commits, imperative, one logical change per commit, no machine-specific artefacts:

- `chore: scaffold plugin package`
- `feat: add host stats tool`
- `feat: detect stale dev processes`
- `feat: approval-gated port and process kills`
- `test: cover proc parsing and kill refusal paths`
- `docs: document install and security model`
- `ci: add node 24 workflow`
- `fix: ...`

Reference the affected module in the body when useful. Keep `package-lock.json` in sync with `package.json`.

## Review checklist

- [ ] No tool can kill without the approval waterfall and fresh identity checks.
- [ ] No new child process runs without a timeout and captured output.
- [ ] No new network, filesystem write, eval, or shell usage.
- [ ] New tool parameters are closed (`additionalProperties: false`), described, and validated again in the service.
- [ ] Tool descriptions stay under 16 words and say what the tool does, not how it is implemented.
- [ ] Client changes still load without any first-party dependency and render `null` on bad input.
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` all pass.
- [ ] No absolute machine paths, secrets, or personal data in the diff.
- [ ] `files`/`exports` cover every new runtime asset.
