---
name: verify-pi-herdr-agents
description: Verify pi-herdr-agents changes end to end. Drives a real parent Pi through the subagent tool path inside an isolated Herdr lab server, with the extension loaded from the working tree and the deterministic pi-integration provider, and captures the delivered <subagent_report> result, child session and pane lifecycle as evidence. Also maps each change type to its required gates (unit, tool-schema contract, integration suite, refactor behavior pin). Use after changing pi-herdr-agents code, before claiming a lifecycle, delivery, worktree, cancel or persistent-specialist behavior works, when judging an integration failure, or when porting a contributor PR.
---

# Verify pi-herdr-agents

The product is a Pi extension. A parent Pi inside Herdr calls `subagent`; the child runs in a Herdr pane; its result returns as a steer message wrapped in a `<subagent_report>` envelope ([docs/delegation-outcome-contract.md](../../../docs/delegation-outcome-contract.md)).

Primary surface: a real parent Pi in an isolated Herdr lab, driven through the real tool path (`scripts/lab.ts`). Secondary: the unit gates and the tool-schema contract.

Paths below are relative to the repository root. `L` means:

```bash
L="node --experimental-strip-types .pi/skills/verify-pi-herdr-agents/scripts/lab.ts"
```

## Gates by change type

| Change | Run |
| --- | --- |
| Any normal change | `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run docs:tools:check`, `npm pack --dry-run`, `git diff --check` |
| Tool schema or description | `npm run docs:tools`, then `npm run docs:tools:check`. A breaking change fails `test/maestro/tool-schema.test.ts` against `test/fixtures/tool-schema/released.json`. Never edit `released.json` outside a release ([../release/SKILL.md](../release/SKILL.md)). |
| Lifecycle, delivery or Herdr behavior | The integration suite via [../run-integration-tests/SKILL.md](../run-integration-tests/SKILL.md), plus one lab drive of the affected feature (below). |
| Refactor (no behavior change) | The behavior pin, the size rule and a mutation proof (below). |
| Release | [../release/SKILL.md](../release/SKILL.md). |

Refactor pin. Run it on the base and on your change, then diff:

```bash
git worktree add --detach /tmp/piha-base main && ln -s "$PWD/node_modules" /tmp/piha-base/node_modules
node --experimental-strip-types .pi/skills/verify-pi-herdr-agents/scripts/pin.ts /tmp/piha-base > /tmp/pin-base.json
node --experimental-strip-types .pi/skills/verify-pi-herdr-agents/scripts/pin.ts > /tmp/pin-head.json
diff /tmp/pin-base.json /tmp/pin-head.json   # only the "repo" line may differ
git worktree remove /tmp/piha-base
```

`pin.ts` loads `pi-extension/subagents/index.ts` against `test/helpers/mock-extension-api.ts` in parent scope and in child scope (`PI_SUBAGENT_ID` and `PI_DENY_TOOLS` set). It records tool, command, renderer and shortcut registration order, tool schemas, event handlers and module exports.

Size rule: every file under `pi-extension/subagents` stays under 32 KB:

```bash
find pi-extension/subagents -type f -size +32k
```

This must print nothing.

Mutation proof: for every new guard, break it, watch the gate that should catch it fail, then restore it and watch the gate pass. Report both runs.

## Doctor

Run this first, and again whenever anything looks off. It is read-only.

```bash
$L doctor
```

It checks: the Herdr binary and version, and whether it is >= 0.9.4 (herdr 0.9.4, #4964, changed the suspended-session rule); the Pi binary and version; the Node version (lint needs >= 22.18); `HERDR_ENV`; the extension path; no running `test/integration` suite; and, for a current lab, that the helper is alive, the server PID's HOME is the lab's, and the lab socket answers `ping`. Any `FAIL` line means stop.

Run only one integration suite per Herdr instance. The doctor counts only `node` processes with a `test/integration/` argument. Do not use `pgrep -f test/integration` as a wait loop: the loop's own shell command line matches the pattern, so it waits until its timeout.

## Launch

```bash
$L up
```

`up` refuses to start while an integration suite runs. It then starts a detached helper that:

1. Imports `createLabRoot`/`startLabServer` from `test/integration/herdr-lab.ts`. The server gets its own session `verify-piha-<run>`, its own HOME, XDG dirs and config, and a socket under `/tmp/piha-herdr-lab-*`.
2. Imports `test/integration/fake-provider.ts`, which starts the deterministic provider in-process. `TEST_MODEL` (`pi-integration/test`) comes from `test/integration/harness.ts`. It writes `models.json` for provider `pi-integration` into an isolated `PI_CODING_AGENT_DIR`.
3. Creates a git project with the `test/integration/agents/*.md` roles pinned to the test model. In a pane of the lab, it runs `pi -ne -e <checkout>/pi-extension/subagents/index.ts --model pi-integration/test --session <lab>/sessions/parent.jsonl`.

Pi, Herdr and node run by absolute path, and the server PATH contains only their directories plus `/usr/bin:/bin`. Mise shims fail under a scratch HOME ("Config files in ~/.config/mise/config.toml are not trusted"). Set `PIHA_REPO=<checkout>` to load another checkout's extension, and `HERDR_BIN`/`PI_BIN` to pick other binaries.

Ready means `up` prints `LAB_READY run=<dir> session=... workspace=... parent=<pane>`, about 2 s in. That happens once the parent pane's footer reads `<n>%/128k (auto) ... test • medium`, which is the deterministic model's context window and id. The helper links the host's `fd` into the scratch agent dir; without it, Pi downloads `fd` from the network on first start. `LAB_FAILED` means run `$L down` and read `<run>/state.json` (`failed`) and `<run>/cleanup.json`.

To watch it live from your own terminal, attach a client without touching your real session. `state.json` holds `home` and `socket`:

```bash
HOME=<home> HERDR_SOCKET_PATH=<socket> <herdr-bin> --session verify-piha-<run>
```

## Drive

Every command targets the current run (`/tmp/verify-pi-herdr-agents/current`):

```bash
$L prompt launch [id]      # types a deterministic prompt into the parent Pi and presses Enter
$L read 120                # parent pane, recent output
$L panes                   # lab pane list (JSON); a child appears in an "Agents" tab
$L pane-read <pane> 80     # any lab pane, e.g. a running child
$L send "/worktree list"   # literal text + Enter: slash commands or free prompts
```

The deterministic provider only acts on prompts in the grammar of `test/integration/fake-provider.ts`. `prompt` emits these kinds: `launch`, `ping`, `cancel`, `worktree`, `persistent`. It prints the id and what to watch. Free text that matches none of them gets the reply `completed`. Each feature recipe is in [features/README.md](features/README.md).

Wait on an observable condition, such as a delivered entry in the parent session, a marker file or a pane change. Do not sleep a fixed time.

## Evidence

```bash
$L evidence <label>
```

This writes `<run>/evidence-<label>-<ts>/`:

- `parent-pane.txt` (screen)
- `panes.json`
- `delivered.txt`: every `subagent_result`/`subagent_ping` custom message, verbatim
- copies of the child session files
- `files/`: `sessions/` (parent session and `artifacts/`) and `agent-sessions/` (child sessions)
- `verdict.json`: per delivery, `envelopeFrom`, `envelopeKind`, `headOutsideEnvelope`, `childSessionExists` and `parentContinued`, plus `panesOtherThanParent`

The helper also records for the whole run:

- `<run>/pane-timeline.jsonl`: every pane change, which shows a child pane appear and then vanish
- `<run>/provider-requests.json`: model, tools and last user text per request, which proves the deterministic provider served it

The run dir lives under `/tmp/verify-pi-herdr-agents/` and survives `down`.

A delegation is proved by all of these:

- the delivered text contains `<subagent_report from="<name>" kind="result">` with the child's output inside, and the host head line (`Sub-agent "<name>" completed`) outside;
- the child session file exists;
- the timeline shows the child pane appear, and then `panesOtherThanParent` is 0 after release;
- the parent continued (an assistant message after the delivery).

Proof standards:

- Exercise the real tool path, a typed prompt to the real parent Pi. Never call extension internals or `__test__`.
- Capture the action and the resulting state, not only the final screen.
- Check the side effects too: session files, marker files, git refs.
- The deterministic provider is the only mock. It stands in for the model API, which the production boundary already isolates.
- A skipped Herdr test is not passing evidence.

## Judging failures

- An integration failure counts only if it reproduces twice. Run the single file again with `node --experimental-strip-types --test --test-concurrency=1 test/integration/<file>.test.ts`.
- Tell a regression from a pre-existing failure by running the same test on `main`: `git worktree add --detach /tmp/x main`, symlink `node_modules`, run there, then `git worktree remove /tmp/x`.
- For sidebar or suspended-session behavior, check the Herdr version first. `HERDR_BIN=<path>` runs the lab, and `test/integration/sidebar.test.ts`, against another binary.
- uutils coreutils hosts (`readlink -f /bin/sleep` gives `/usr/lib/cargo/bin/coreutils/...`) dispatch on argv[0]. A binary symlinked under another name fails there, so test stand-ins use `process.execPath`, never a renamed `sleep` or `true`.
- GitHub CI passing while local runs fail usually means a host difference (coreutils, Herdr version). CI does not run the Herdr suite ([RELEASING.md](../../../RELEASING.md)).

## Cleanup

```bash
$L down
```

This SIGTERMs only the helper whose PID, start time and command line match `state.json`. The helper snapshots sessions into `<run>/files/`, stops the lab server through `stopLabServer` (which re-verifies the server identity), and removes the lab root through `removeLabRoot`. If the helper is already dead, `down` does the same by identity. `down` prints `LAB_DOWN ... labRootExists=false leftoverPids=none` on success, and exits 1 if any process still carries the lab HOME. Run it after every failed iteration too. It never deletes the run dir.

The integration suite can leave empty `~/.herdr/worktrees/pi-integ-*` directories. Remove only the empty ones newer than your run start:

```bash
touch /tmp/piha-run-start            # before the suite
find ~/.herdr/worktrees -mindepth 1 -maxdepth 1 -type d -name 'pi-integ-*' -empty -newer /tmp/piha-run-start -print -delete
```

Never kill by process name. Never run `herdr` against your real session to clean the lab; the lab has its own session and socket.

## Porting and pushing

- To prove a rebased contributor PR kept its intent, run `git range-diff <base>..<orig> main..HEAD`.
- With `push.followTags=true`, fork pushes print tag rejections that do not mean the branch push failed. Confirm with `git ls-remote <remote> <branch>`.

## Helpers

- `scripts/lab.ts`: `doctor`, `up`, `prompt`, `send`, `read`, `panes`, `pane-read`, `evidence`, `down`. Run `$L help` for the list.
- `scripts/pin.ts [checkout]`: the refactor behavior pin, as JSON on stdout.
