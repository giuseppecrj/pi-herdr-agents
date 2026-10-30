# pi-herdr-agents verification map

This directory is the maintained source for verifying the user-facing behavior of pi-herdr-agents. A user here is a parent Pi agent, or its human, calling the extension's tools and commands. Read this index first, then use the matching feature file as the recipe. Tool semantics are canonical in [docs/tools.md](../../../../docs/tools.md); envelope rules are in [docs/delegation-outcome-contract.md](../../../../docs/delegation-outcome-contract.md).

## Baseline preconditions

- `L="node --experimental-strip-types .pi/skills/verify-pi-herdr-agents/scripts/lab.ts"`, run from the repository root.
- `$L doctor` has no `FAIL` line and reports no running integration suite.
- `$L up` printed `LAB_READY`. The parent Pi runs on `pi-integration/test` in an isolated Herdr server, with the extension from the checkout under test (`PIHA_REPO`, default this checkout).
- The lab project is a git repo with one commit on `main` and the roles `test-echo`, `test-ping`, `test-restricted` and `test-coordinator` in `.pi/agents/`.
- Never drive a lab you did not start, and never the real Herdr session.

## Driving conventions

- `$L prompt <kind> [id]` types the one prompt shape the deterministic provider acts on for that feature. Pick an `id` so the markers are yours.
- `$L send "<text>"` types literal text and Enter. Use it for slash commands such as `/worktree list`.
- `$L herdr <args>` runs Herdr CLI calls against the lab only, e.g. `$L herdr worktree list --cwd <project> --json`. `$L state` prints `project`, `parentSession`, `parentPane` and `runDir`.
- Wait on the parent session file (`state.parentSession`), a marker file or a pane change, never a fixed sleep. A quick check: `grep -c '"customType":"subagent_result"' <parentSession>`.
- Start each recipe from a fresh `up` unless it says otherwise. Recipes leave children and worktrees behind only inside the lab, which `down` removes.

## Proof and skip reporting

- Run `$L evidence <feature-id>` once the end state is reached. Proof is `delivered.txt` and `verdict.json` from that directory, plus `<run>/pane-timeline.jsonl` and `<run>/provider-requests.json`.
- Quote the delivered text that proves the envelope. Do not paraphrase it.
- A mutation (commit, worktree, cancel) needs a second, read-only view: git refs, `herdr worktree list`, pane list.
- Report a journey the deterministic provider cannot drive as unverified, with the reason. Never report it as verified through another path.

## Feature entry contract

Each feature file has an H1, one paragraph, then exactly four H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with lab.ts` (starting with `Preconditions:`), `Gotchas`.

## Features

- **Launch and result delivery** (`launch-and-delivery.md`): ordinary `subagent` launch, child pane, `<subagent_report kind="result">` delivery, pane release.
- **Help request** (`caller-ping.md`): a child's `caller_ping` delivered as `kind="help-request"`, then `subagent_resume`.
- **Cancel and interrupt** (`cancel-and-interrupt.md`): `subagent_cancel` on an ordinary child; `subagent_interrupt` gaps.
- **Managed worktree run** (`worktree-run.md`): `worktree: { branch }` launch, retained handoff, `worktree_list` / `/worktree remove`.
- **Persistent specialist** (`persistent-specialist.md`): `persistent: true`, `subagent_send`, busy rejection, `subagent_stop`.
