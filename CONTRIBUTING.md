# Contributing

Thanks for improving `dsh-host-health`. This repository accepts small, reviewed changes with tests and documentation.

## Setup

The plugin runtime has **no dependencies**; development needs only Node 24+ and the devDependencies.

```sh
npm install
```

Local npm may need a workspace cache in constrained environments:

```powershell
$env:npm_config_cache = '<workspace>/.npm-cache'   # PowerShell
npm install
```

## Commands

```sh
npm run typecheck   # tsc --noEmit with checkJs (JSDoc types)
npm run lint        # node --check + forbidden-pattern guard
npm test            # node --test test/
npm run build       # static manifest/bundle readiness checks
npm run smoke       # manual live probe; not part of CI
```

The full gate before any commit:

```sh
npm run typecheck && npm run lint && npm test && npm run build
```

## Project layout

| Path | Purpose |
| --- | --- |
| `index.js` | Host entry: service wiring, tool registration, approval waterfall listener |
| `client.js` | Web Client artifact: read-only tool cards, React only |
| `lib/command.js` | Bounded child-process runner (no shell, timeout, output cap) |
| `lib/powershell.js` | Fixed PowerShell probe scripts |
| `lib/parsers.js` | Pure parsers for PowerShell/`ps`/`ss`/`lsof`/`nvidia-smi` output |
| `lib/probes.js` | Probe orchestration + memory cache |
| `lib/system.js` | Node builtin system adapter (RAM/CPU/disk/uptime/load) |
| `lib/cpu.js` | Pure CPU delta math and top lists |
| `lib/devprocess.js` | Pure dev-process classification and stale detection |
| `lib/thresholds.js` | Threshold warnings |
| `lib/render.js` | Human-readable tool output text |
| `lib/service.js` | Composes everything; tool-facing service (injectable) |
| `lib/tools.js` | Tool definitions (schema, timeout, execute, render) |
| `lib/kill.js` | Kill safety, identity comparison, process control adapter |
| `scripts/` | lint, build-check, smoke |
| `test/` | `node:test` suites and captured fixtures |

## Design rules

1. **No runtime dependencies.** Everything must work with Node builtins and the Host-provided services. DevDependencies are fine for typecheck only.
2. **Everything I/O is injectable.** The service takes `system`, `probes`, `control`, `clock`, `sleep`, `limits`, and `thresholds`. New behaviour should follow the same pattern so tests stay deterministic.
3. **Pure logic is separate from I/O.** Transformations go in `lib/parsers.js`, `lib/cpu.js`, `lib/devprocess.js`, `lib/thresholds.js`, `lib/render.js`. Probe execution stays in `lib/command.js` / `lib/probes.js` / `lib/system.js`.
4. **Bounded probes.** Any child process needs `spawn` without a shell, a timeout, an output cap, and captured output. Add a test for timeout and failure paths.
5. **Kills are special.** Any change to a kill path requires: approval listener test, protected-target test, identity-change test, and a success test. Never weaken `checkKillTarget` or the fresh re-check.
6. **Tool text rules.** Tool descriptions are under 16 words and describe behaviour, not implementation. Parameter schemas are closed objects with descriptions. Failure values are `{ ok: false, error, hint? }` — never thrown stack traces.
7. **Client half.** `client.js` may require only `react` and `react/jsx-runtime`, renders plain React elements, and returns `null` for malformed data instead of throwing. Do not add DOM writes, timers, fetches, or first-party imports.
8. **No machine-specific paths or secrets.** Runtime detection only; docs use `<path>` placeholders. CI (`node scripts/build-check.mjs` and `test/manifest.test.js`) scans for violations.
9. **Docs travel with code.** Update `README.md` (tool reference/troubleshooting), `CHANGELOG.md` (Unreleased), and `AGENTS.md` invariants in the same change.

## Tests

- `node:test` with `node:assert/strict`.
- Fixtures for platform output live in `test/fixtures/`. When adding fixture data, strip usernames and machine-specific paths.
- Prefer several focused tests over one large integration test; every error path in `lib/service.js` should have a test.
- Integration tests use the fakes in `test/helpers.js` (`createFakeProbes`, `createFakeSystem`, `createFakeControl`, `createTestClock`) and never touch the live host.
- New runtime files must be added to `package.json` `files` (and `exports` when public) and covered by `test/manifest.test.js`.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `test:`, `docs:`, `ci:`, `chore:`, `refactor:`.
- One logical change per commit; keep `package-lock.json` in sync with `package.json`.
- Never commit `node_modules/`, logs, coverage output, `.env` files, absolute machine paths, or credentials.
- PR checklist: the full gate passes, new behaviour is documented, security invariants are unchanged, no new network/file-write/admin capability was added.

## License

By contributing you agree that your contribution is licensed under the MIT license of this repository.
