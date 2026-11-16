# Development

This page is for contributors. Read [`AGENTS.md`](../AGENTS.md) for repository rules and [`RELEASING.md`](../RELEASING.md) for the release procedure.

## Code map

The engine is the exact `@nubl/maestro` dependency in `package.json`: run
ownership, the Pi harness adapter and launch transactions, tool schemas and
registration, the per-load controllers, configuration loaders, role
discovery, worktree operations, the child protocol, and the accept check.
This package is the terminal host around it. It imports engine modules
through `@nubl/maestro` subpaths and keeps only the Herdr providers, the
terminal presentation, and the child path that launches use. Change engine
behavior in `@nubl/maestro`, then raise the exact dependency here. Pi is the
sole real harness. Legacy Herdr and local Herdr Core provide execution;
Desktop presentation is separate and not yet implemented.

- `pi-extension/subagents/index.ts` — the terminal entry Pi loads. It calls
  `createPiExtension` from `@nubl/maestro/pi` once per module load with the
  terminal host's hooks: `hostSurfaceBinding` (`host-surface.ts`), the
  presentation hooks (widgets, message renderers and `tool-renderers.ts`),
  the child wrapper path and the package root for `config.json.example`. It
  re-exports the `__test__` surface. Each `/reload` re-imports it, so config
  and timers are never shared between loads.
- `pi-extension/subagents/host-surface.ts`, `marker-transport.ts` — the
  terminal host's runtime composition: legacy/Core binding selection, the
  owning provider, the per-launch legacy pane provider with that launch's
  shell trust, and the Herdr socket sidebar-marker reader and writer.
- `pi-extension/subagents/widgets.ts`, `renderers.ts`, `tool-renderers.ts` —
  the terminal presentation hooks: the widget and status refresh with
  `borderLine`, the message renderers, and the per-tool `renderCall`/
  `renderResult` callbacks the factory injects into tool definitions.
- `pi-extension/subagents/child.ts`, `child-widget.ts` — the terminal child
  wrapper: the package child protocol (`createChildExtension` from
  `@nubl/maestro/pi/child`) plus its tools widget.
- `maestro/adapters/pi/child/subagent-done.ts` — the child path launches pass
  and old session policies name. It re-exports the package child protocol and
  defaults to `child.ts`, so existing launch artifacts keep resolving.
- `maestro/surfaces/herdr/` — `HerdrSurfaceProvider`, Herdr CLI driver,
  terminal scripts/placement, and `herdr-socket.ts`, the bounded socket
  client for pane metadata. The CLI driver is `herdr-cli.ts` (bounded
  asynchronous exec, JSON, availability, test exec hook), `herdr-pane.ts`
  (pane inspection, process info, readiness and absence waits), and
  `herdr.ts` (placement, worktrees, the opened-primary report, pane
  commands). On Windows a launch script runs through an absolute bash path
  spelled for the pane's shell (`@nubl/maestro/core/script-launch` builds the
  PowerShell, cmd or Git Bash line; `terminal.ts` reads the shell from
  `pane process-info`; `@nubl/maestro/adapters/pi/script-shell` resolves the
  path with Pi's `shellPath` setting for the launching session's cwd and
  project trust, then bash-tool discovery) so a bare `bash` never resolves to
  the WSL launcher. `herdr-core-protocol.ts` owns bounded generation-1 RPC
  and mutation uncertainty; `herdr-core-surface-provider.ts` owns local
  native execution, exact launch identity, termination confirmation and
  record removal.
- `plugins/sidebar/` — the optional Herdr plugin. Its `sidebar.mjs` uses Node
  built-ins only and imports nothing from the extension, so Herdr can install
  the directory by itself.
- `test/` — host tests: the Herdr and Core providers and transports, terminal
  presentation, composition hooks, packaging, release and lab guards, the
  import dependency rule (`test/maestro/dependency-rule.test.ts`), and the
  real Herdr lifecycle suites in `test/integration/`. Engine unit tests and
  the conformance fakes run in `@nubl/maestro`; the conformance runners in
  `test/maestro/*.conformance.ts` stay here because `test/integration/` drives
  them against the real providers.

See [ADR-0012](adr/0012-adopt-maestro-seams-in-repo.md),
[ADR-0018](adr/0018-herdr-core-execution.md), the
[glossary](../CONTEXT.md), and the [documentation map](README.md).

The **CI** workflow runs formatting, generated tool-doc checks, lint, type-check,
unit tests, and the package preview on pushes and pull requests to `main`, or
manually from GitHub Actions. Its **Unit tests (Windows, non-blocking)** job runs
on `windows-latest` and, after dependency installation, runs only `npm test`.
It is allowed to fail and must not be cited as passing verification evidence
while that policy remains in place. The separate **Linux integration** workflow runs on
pushes to `main` or manual dispatch. It pins legacy Herdr 0.9.5 and Core 0.1.20
with SHA-256 checks, uses the lockfile's Pi, and runs on Ubuntu 24.04 without
provider credentials or a GUI. `scripts/run-linux-integration.ts` reuses the
private verification lab for a real-parent delegation, then runs the complete
deterministic integration suite sequentially. Desktop GUI coverage is deferred.
Always-run cleanup verifies the owned legacy lab stopped; TAP, parent evidence,
and Core sessions are uploaded as `linux-integration-evidence` for seven days.
Both workflows have read-only repository permissions and never publish. The
separate **Release** workflow still validates each release before publishing.

Run local checks:

```bash
npm ci
npm run format:check
npm test
npm run docs:tools:check
npm run lint
npm run typecheck
npm pack --dry-run
```

`npm run typecheck` covers production sources, the TypeScript tests (`test/**/*.ts`), and the verification lab scripts (`.pi/skills/**/*.ts`) under `strict`. Tests run with type stripping, so a type error in a test fails the typecheck gate, not `npm test`. JavaScript tests (`*.js`, `*.mjs`) are not type-checked.

Unit tests do not depend on the shell they run in, so `npm test` and single-file `node --experimental-strip-types --test <file>` runs behave the same inside a Pi subagent or a Herdr pane as in CI. Every unit-test entry file first imports `test/clean-host-env.ts` (directly or through `test/isolated-agent-dir.ts`), which removes inherited `PI_*`, `HERDR_*`, and `HC_*` variables except `PI_TEST_*`, `PI_BIN`, `HERDR_BIN`, and `HERDR_CORE_BIN`. A test that needs one of the removed variables sets it explicitly. `test/maestro/test-environment.test.ts` fails if an entry file in the `npm test` script lacks that first import.

A unit test that starts a fake socket server listens on `socketPath(dir, name)` from `test/socket-path.ts`: it returns `dir/name` on Linux and macOS and a unique `\\.\pipe\` named pipe on Windows, where Node cannot listen on a filesystem path.

The public tool schemas are captured by loading the real extensions through the host entry. After changing a tool name, description, or parameter, run `npm run docs:tools` to regenerate `test/fixtures/tool-schema/current.json` and the marked blocks in `docs/tools.md`, and commit the result; `npm run docs:tools:check` fails while either is stale, including after a `@nubl/maestro` upgrade that changes a schema. The breaking-change check against the last released contract runs in `@nubl/maestro`'s own suite, which fails on a change that would break an existing client: a removed or newly required property, a changed type, or a narrowed union or enum. `test/fixtures/tool-schema/released.json` is this package's last released contract; release copies `current.json` over it.

`npm run lint` needs Node.js 22.18+ (or 22.6–22.17 with `NODE_OPTIONS=--experimental-strip-types`) because oxlint imports TypeScript directly: its configuration, `oxlint.config.ts`, and the JavaScript plugin it loads, `tools/oxlint/anti-slop/index.ts`. Without type stripping, oxlint fails before linting with `Unknown file extension ".ts"`. This is a contributor tooling requirement, not a runtime requirement for package users.

Run the required end-to-end suite from inside Herdr:

```bash
npm run test:integration
```

Start the Herdr server with Node.js 22.19+ on its `PATH`, because test panes inherit the server's environment, not the test runner's: Pi 1.0.0 needs Node.js 22.19+ and crashes at startup on versions older than 22.15.

For Core, run the independent isolated suite (Linux or macOS; requires
`herdr-core`, Pi and Node on PATH, or absolute `HERDR_CORE_BIN` / `PI_BIN`):

```bash
npm run test:integration:core
```

`test/integration/herdr-core-lab.ts` owns private HOME/XDG directories, a unique
Core session and socket, and identity-checked shutdown without PID signalling.
`core-parent.ts` loads this checkout in real parent/child Pi processes against
the local deterministic provider. npm puts `node_modules/.bin` first on PATH,
so set `PI_BIN` explicitly to verify an installed Pi rather than the repository's
pinned version. `PI_BIN` must be an executable named `pi`: the lab builds child
terminals' PATH from its directory and children start a bare `pi`, so a path to
the bundle's `cli.js` makes children exit 127. Core 0.1.16 has been exercised with Pi 1.1.0 and 1.4.0;
Core 0.1.17 has also passed with Pi 1.4.0, and Core 0.1.17 and 0.1.20 with Pi 1.1.0. The tests exercise public tools, not `__test__`,
and save sessions, provider requests and native inventory/screens under the
reported `/tmp/piha-core-evidence-*` directories before removing lab resources.
Unknown startup/shutdown ownership retains the lab and fails the test. No daily
Core/Desktop layout, configuration or authentication is used.

The older `scripts/lab.ts` verification driver and some legacy fixtures require
Linux `/proc`; a Core pass on macOS does not substitute for those legacy gates.
Report skips and unavailable gates explicitly. See the
[verification skill](../.pi/skills/verify-pi-herdr-agents/SKILL.md).

The deterministic suite launches real Pi sessions, Herdr panes, and worktrees without provider credentials. The optional live-provider smoke test is not a merge gate:

```bash
PI_TEST_MODEL="openai-codex/gpt-5.6-luna" PI_TEST_TIMEOUT=180000 \
  npm run test:integration:live
```

See [RELEASING.md](../RELEASING.md) for versioning, trusted publication, and release verification.
