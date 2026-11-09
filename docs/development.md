# Development

This page is for contributors. Read [`AGENTS.md`](../AGENTS.md) for repository rules and [`RELEASING.md`](../RELEASING.md) for the release procedure.

## Code map

The maestro seams remain inside one npm package with the same Pi extension
entry point. Pi is the sole real harness. Legacy Herdr and local Herdr Core
provide execution; Desktop presentation is separate and not yet implemented.
Fakes are for conformance tests only.

- `pi-extension/subagents/index.ts` — Pi composition root: loads config,
  adopts the reload-surviving runtime, builds the per-load controllers, and
  registers session handlers, tools, commands, and renderers in order. It also
  holds the `__test__` surface.
- `pi-extension/subagents/state.ts`, `catalog.ts`, `presentation.ts` — run-state
  types and reload slots; the role catalog, `subagent` parameters, and launch
  policy; the parent message model, its one serializer, and the child-report
  envelope.
- `pi-extension/subagents/tool-boundary.ts` — the one registration boundary
  that encodes errors thrown by any host tool or command.
- `pi-extension/subagents/deferred-tools.ts` — `deferred` exposure for the
  routine host tools. It records which tools this load registered, recognizes
  Pi's built-in `tool_search` by its reported source, and at `session_start`
  activates that search or, without it, the routine tools Pi kept. See
  [Tool loading](tools.md#tool-loading).
- `pi-extension/subagents/observation.ts`, `widgets.ts`, `controls.ts`,
  `persistent.ts`, `delivery.ts`, `launch.ts` — per-load controllers
  (`create*`) for activity observation, the widget and status refresh,
  interrupt/cancel, persistent specialists, parent delivery, and launch plans.
  `index.ts` creates each once per module load, because tests and `/reload`
  re-import it and its config and timers must not be shared.
- `pi-extension/subagents/launch-tools.ts`, `control-tools.ts`,
  `worktree-tools.ts`, `task-models.ts`, `renderers.ts` — `register*`
  functions for the public tools, commands, and message renderers.
- `pi-extension/subagents/model-registry.ts`, `config-path.ts` — permanent
  host-local SDK capability glue and configuration-path conventions.
- `maestro/core/` — seam interfaces/types, activity and lifecycle projection,
  status, routing, wake-ups, and supervision; `undelivered-children.ts` is the
  shared registry-slot key and the check the child protocol uses to defer
  auto-exit.
- `maestro/core/roles/discovery.ts`, `maestro/core/config/` — role discovery,
  config loaders with injected directories, and task-model init prompt logic.
- `maestro/core/config/herdr-config.ts` — strict backend configuration and
  pure native-context selection; `maestro/runtime/herdr-backend.ts` composes
  the selected provider, with the binding retained by `pi-run-session.ts`.
- `maestro/core/worktree.ts`, `maestro/core/worktree-cleanup.ts` — manifest
  schema/state, handoff types, and cleanup eligibility/formatting.
- `maestro/core/realpath-without-opening.ts` — lstat/stat/readlink realpath for
  cleanup canonicalization and Herdr checkout comparisons; avoids Bun `open()`
  freezes on protected directories.
- `maestro/core/git-environment.ts` removes inherited repository-selection and
  command-local Git configuration overrides from host-managed Git subprocesses.
  It retains user configuration, identity, and hooks.
- `maestro/core/deadline.ts` defines finite monotonic operation budgets.
  `maestro/surfaces/herdr/herdr-cli.ts` owns bounded asynchronous Herdr clients.
  `maestro/runtime/worktree-operations.ts` owns asynchronous Git preflight and
  handoff inspection. Explicit cleanup Git commands remain bounded and synchronous.
- `maestro/core/host-text.ts` — the one encoding for variable values in
  parent-facing host lines, lossless command-argument serializers, and display
  normalization for child text.
- `maestro/adapters/pi/` — Pi launch, completion, session I/O, activity files,
  model SDK glue, and registry projection behind `PiHarnessAdapter`;
  `child/subagent-done.ts` implements the child protocol, and
  `child/declared-skills.ts` injects the declared skills the child's own Pi
  loaded on its first run (names come from `maestro/core/declared-skills.ts`).
  Launch is split into `launch.ts` (fresh transaction), `launch-resume.ts`
  (resumed transaction), `launch-command.ts` (shared child command-line
  pieces), and `launch-operations.ts` (the `PiLaunchOperations` seam, its
  surface-backed implementation, and process-identity capture).
- The accept check ([ADR-0017](adr/0017-accept-check.md)):
  `maestro/core/accept.ts` (spec validation, the closed verdict set, the
  `Check:` detail text, and the outcome-ledger line),
  `maestro/adapters/pi/accept-runner.ts` (`sh -c` with a timeout and
  process-group termination), `maestro/adapters/pi/process-tree.ts` (the one
  kill: a POSIX group kill, or `taskkill /T /F` on Windows),
  `maestro/adapters/pi/accept-groups.ts` (the
  process-wide registry of running check groups, terminated by their owner at
  shutdown and killed by an `exit` hook),
  `maestro/adapters/pi/child/accept-check.ts` (the
  child's `agent_before_settle` retry loop), and
  `maestro/runtime/accept-recheck.ts` (the parent re-check `finalize` runs and
  the outcome-ledger append).
- `maestro/surfaces/herdr/` — `HerdrSurfaceProvider`, Herdr CLI driver,
  terminal scripts/placement, and `herdr-socket.ts`, the bounded socket
  client for pane metadata. The CLI driver is `herdr-cli.ts` (exec, JSON,
  availability, test exec hook), `herdr-pane.ts` (pane inspection, process
  info, readiness and absence waits), and `herdr.ts` (placement, worktrees,
  the opened-primary report, pane commands). On Windows a launch script runs
  through an absolute bash path spelled for the pane's shell
  (`maestro/core/script-launch.ts` builds the PowerShell, cmd or Git Bash
  line; `terminal.ts` reads the shell from `pane process-info`;
  `maestro/adapters/pi/script-shell.ts` resolves the path with Pi's
  `shellPath` setting for the launching session's cwd and project trust, then
  bash-tool discovery) so a bare `bash` never resolves to the WSL launcher.
  `herdr-core-protocol.ts` owns bounded generation-1 RPC and mutation uncertainty;
  `herdr-core-surface-provider.ts` owns local native execution, exact launch
  identity, termination confirmation and record removal.
- `maestro/runtime/` — run ownership, controls/retries, observation,
  delivery-gated cleanup, Pi composition, worktree operations/handoff,
  task-model init composition, and sidebar markers (`delegated-marker.ts`).
  `pi-run-session.ts` composes the Pi run session; its public contract types
  live in `pi-run-session-types.ts` and its persistent-specialist inbox and
  ledger I/O in `pi-persistent-io.ts`.
- `plugins/sidebar/` — the optional Herdr plugin. Its `sidebar.mjs` uses Node
  built-ins only and imports nothing from the extension, so Herdr can install
  the directory by itself.
- `maestro/adapters/fake/`, `maestro/surfaces/fake/`, `test/maestro/` —
  conformance fakes, seam tests, and the import dependency-rule test.

See [ADR-0012](adr/0012-adopt-maestro-seams-in-repo.md),
[ADR-0018](adr/0018-herdr-core-execution.md), the
[glossary](../CONTEXT.md), and the [documentation map](README.md).

The **CI** workflow runs formatting, generated tool-doc checks, lint, type-check,
unit tests, and the package preview on pushes and pull requests to `main`, or
manually from GitHub Actions. Its **Unit tests (Windows, non-blocking)** job runs
on `windows-latest` and, after dependency installation, runs only `npm test`.
It is allowed to fail and must not be cited as passing verification evidence
while that policy remains in place. The separate **Linux integration** workflow runs on
pushes to `main` or manual dispatch. It pins legacy Herdr 0.9.5 and Core 0.1.17
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

The public tool schemas are captured by loading the real extensions. After changing a tool name, description, or parameter, run `npm run docs:tools` to regenerate `test/fixtures/tool-schema/current.json` and the marked blocks in `docs/tools.md`, and commit the result. `test/maestro/tool-schema.test.ts` also compares the snapshot with `test/fixtures/tool-schema/released.json`, the last released contract, and fails on a change that would break an existing client: a removed or newly required property, a changed type, or a narrowed union or enum. Release copies `current.json` over `released.json`.

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
pinned version. Core 0.1.16 has been exercised with Pi 1.1.0 and 1.4.0;
Core 0.1.17 has also passed with Pi 1.4.0. The tests exercise public tools, not `__test__`,
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
