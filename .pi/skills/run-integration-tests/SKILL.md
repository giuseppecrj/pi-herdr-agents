---
name: run-integration-tests
description: Run the integration test suite and verify all sessions end-to-end. Use when asked to run integration or e2e tests, test before release, or check everything works.
---

# Run integration tests

Run this workflow from inside herdr. This project supports no other terminal backend.

## Preflight

```bash
echo "HERDR_ENV=$HERDR_ENV"
command -v herdr
npm test
npm pack --dry-run
```

Stop and ask the user to start pi inside herdr if `HERDR_ENV` is not `1` or the CLI is missing.

## Integration suite

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

Report passing, failing, and skipped tests. Do not claim full verification when Herdr-dependent tests were skipped. For package changes, explicitly inspect the dry-run contents for `skills/orchestrate/SKILL.md` and confirm that `pi-extension/subagents/workflow-worker.js` is absent and that plans, journals, sessions, prototypes, generated evidence, and local config are absent.

## Postflight

```bash
git status --short
herdr workspace list
find "$HOME/.herdr/worktrees" "${TMPDIR:-/tmp}" /tmp -name 'pi-integ-*' -print 2>/dev/null
```

Confirm that no `pi-integ-*` workspace, process, temporary repository, or worktree remains. `herdr workspace list` already returns JSON. If a failed test leaves an artifact, verify that it is test-owned before removing it. Close a test-owned workspace with `herdr workspace close <workspace-id>`. Do not remove unrelated user workspaces, processes, files, or worktrees.
