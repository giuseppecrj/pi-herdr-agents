---
name: run-integration-tests
description: Run the integration test suite and verify all sessions end-to-end. Use when asked to run integration or e2e tests, test before release, or check everything works.
---

# Run integration tests

The package supports legacy Herdr and local Herdr Core execution. Desktop
presentation is not yet implemented. Select the matching suite; a Core pass is
not a substitute for legacy coverage.

## Linux GitHub Actions

The **Linux integration** workflow runs on pushes to `main` or manual dispatch,
with read-only permissions and no publishing. It installs checksum-pinned legacy
Herdr 0.9.5 and Core 0.1.20, uses the lockfile's Pi, and runs
`scripts/run-linux-integration.ts` on Ubuntu 24.04. That driver proves a real
parent delegation in the existing private verification lab before running the
complete deterministic suite sequentially. Always-run cleanup stops only the
owned lab; `linux-integration-evidence` keeps TAP, parent evidence and Core
sessions for seven days. Desktop GUI coverage is deferred.

## Isolated Core suite

From the repository root:

```bash
npm run test:integration:core
```

Requires `herdr-core`, `pi` and Node on PATH, or absolute `HERDR_CORE_BIN` and
`PI_BIN`. `PI_BIN` must be an absolute path to an executable named `pi`, such
as `$PWD/node_modules/.bin/pi`: the lab builds child terminals' PATH from its directory
and children start a bare `pi`. Pointing it at the bundle's `cli.js` makes
children exit 127. It does not require `HERDR_ENV` or an existing Core/Desktop session.
The fixture creates private HOME/XDG directories, Core session/socket and Pi
configuration, and uses the local deterministic provider. Real parent Pi calls
the public tools; do not replace that path with direct extension internals.

The log prints `/tmp/piha-core-evidence-*` paths containing parent/child sessions,
provider requests and native inventory/screens. Lab resources are removed only
after same-server shutdown confirmation. An uncertain start or shutdown keeps
its private root and fails. Do not clean it by process name or by talking to the
user's daily Core. Missing binaries are skips, not passing evidence. No Desktop
visual acceptance is established by this suite.

## Legacy preflight

```bash
echo "HERDR_ENV=$HERDR_ENV"
command -v herdr
npm test
npm pack --dry-run
```

Stop and ask the user to start pi inside herdr if `HERDR_ENV` is not `1` or the CLI is missing.

## Legacy integration suite

Run only one integration suite at a time on a Herdr instance. Before starting, confirm that no other checkout or agent is running `test/integration/*.test.ts`; concurrent suites compete for terminal focus and process capacity and can cause false timeouts or leaked test resources.

From the repository root, run the deterministic required suite:

```bash
npm run test:integration
```

The harness loads the extension directly from the working tree, creates isolated test agents, and routes every parent and child Pi session to a local scripted provider. It still exercises real Pi and Herdr lifecycle behavior without provider credentials, network calls, or model-output assertions.

Integration tests must own and tear down their Herdr workspaces, processes, temporary repositories, and worktrees, including on failure. Wait for observable journal, pane, process, file, or screen conditions. Do not use a fixed sleep to synchronize a transition; deliberate elapsed-time scenarios are the exception.

Use this optional live-provider smoke test only when checking provider compatibility:

```bash
PI_TEST_MODEL="openai-codex/gpt-5.6-luna" PI_TEST_TIMEOUT=180000 npm run test:integration:live
```

Report passing, failing, and skipped tests. Do not claim full verification when Herdr-dependent tests were skipped. For package changes, explicitly inspect the dry-run contents: confirm that no `agents/` or `skills/` resources, `pi-extension/subagents/plan-skill.md`, or `pi-extension/subagents/workflow-worker.js` are present, and that plans, journals, sessions, prototypes, generated evidence, and local config are absent. Lifecycle tests use only the role fixtures in `test/integration/agents/`; a test that needs a production role from a pack belongs in that pack.

## Legacy postflight

```bash
git status --short
herdr workspace list
find "$HOME/.herdr/worktrees" "${TMPDIR:-/tmp}" /tmp -name 'pi-integ-*' -print 2>/dev/null
```

Confirm that no `pi-integ-*` workspace, process, temporary repository, or worktree remains. `herdr workspace list` already returns JSON. If a failed test leaves an artifact, verify that it is test-owned before removing it. Close a test-owned workspace with `herdr workspace close <workspace-id>`. Do not remove unrelated user workspaces, processes, files, or worktrees.
