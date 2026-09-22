# Worktree subagents

This guide is the operational reference for running writing agents in isolated Git worktrees with `pi-herdr-agents`. For the complete tool API, installation, and status model, see the [README](../README.md). For the product and open-source research behind these choices, see the [research report](research/worktree-subagent-orchestration.md).

## Quick start

Run Pi inside Herdr from a Git checkout, then give each independent writing task a unique branch:

```typescript
subagent({
  name: "Ticket 123",
  agent: "worker",
  model: "<worker-provider>/<mid-tier-id>",
  thinking: "medium",
  cwd: "/path/to/repository",
  worktree: { branch: "ticket/123", base: "main" },
  task: "Implement ticket 123, run its tests, commit the result, and report the commit SHA. Do not push, merge, or remove the worktree.",
});
```

`base` is optional. When omitted, the extension resolves the source checkout's committed `HEAD` before creating the worktree.

## When to use a worktree

Use one worktree per independent task that may write files or create commits. This prevents workers from overwriting each other's files and indexes.

Use an ordinary subagent pane instead when the task is read-only, interactive, or intentionally shares the current checkout:

```typescript
subagent({
  name: "Scout auth",
  agent: "scout",
  model: "<scout-provider>/<fast-tier-id>",
  thinking: "low",
  task: "Map the auth flow; do not modify files.",
});
```

Omit `worktree` for an ordinary pane. If a generated tool client requires every declared property, pass `worktree: null`; the extension treats it exactly like omission and starts the child in `cwd` without calling `herdr worktree create`.

Worktrees isolate checkouts, indexes, and `HEAD`. They are **not security sandboxes**: worktrees still share the repository's object database and most refs, and the child process has the same host permissions as Pi.

## Launch contract

For a worktree launch:

- `cwd` selects the source Git repository. A relative tool argument is resolved from the parent Pi process's current directory.
- `worktree.branch` is a new, unique branch name. Git/Herdr rejects a branch that cannot be created or is already checked out elsewhere.
- `worktree.base` may be any revision that resolves to a commit in the source repository. It defaults to committed `HEAD`.
- The extension resolves `base` to an exact SHA, writes an ownership manifest, then calls `herdr worktree create --no-focus`.
- The child starts at the root of the returned worktree, in that workspace's retained root pane and newly owned `Agents` tab. Finishing Pi returns to the interactive checkout shell; it does not close the root pane.
- Uncommitted and untracked files from the parent checkout are not copied. Commit anything the child must see before spawning it, or pass the needed context in the task.
- Worktree creation does not steal terminal focus.

For an explicit interactive handoff, use `/worktree <worktree> [task]`. It creates the worktree from the current committed branch, forks the active conversation branch into the target-cwd session, launches a normal long-lived Pi process in the returned root pane, and focuses the destination workspace only after Herdr confirms Pi is running with the expected session and worktree cwd. Use `/worktree list` to inspect managed worktrees whose source repositories are inside the current cwd subtree, including cross-session orphans. The original process and session remain intact; pane movement is not used to change a running shell's cwd.

`worktree` cannot be set in agent frontmatter and is not exposed by the `/subagent <agent> <task>` shorthand. It is selected per call to the `subagent` tool. Ordered model fallback lists are not supported for worktree subagents: a failed attempt retains its worktree and branch for review, so a retry cannot safely reuse the requested branch. A persistent specialist either holds one worktree lease for its full lifetime or runs read-only in an ordinary pane; it cannot be re-bound.

## Parent and worker responsibilities

| Parent/orchestrator | Worker |
| --- | --- |
| Choose a unique branch and committed base | Work only in the provided checkout |
| Provide complete task context | Read existing code before editing |
| Review the returned Git metadata and diff | Run relevant verification |
| Decide how and when to integrate | Commit when the task requests a commit |
| Push, create a PR, merge, or clean up explicitly | Do not push, merge, switch branches, or remove the worktree unless explicitly authorized |

A worker commit is recommended because it gives the parent an exact review and integration unit. Uncommitted worker changes are still retained and reported; they are not discarded.

## Parallel writing pattern

Independent tasks can launch concurrently from the same committed base:

```typescript
subagent({
  name: "API ticket",
  agent: "worker",
  model: "<worker-provider>/<mid-tier-id>",
  thinking: "medium",
  worktree: { branch: "tickets/api", base: "main" },
  task: "Implement the API ticket, test it, and commit. Do not push or merge.",
});

subagent({
  name: "UI ticket",
  agent: "worker",
  model: "<worker-provider>/<mid-tier-id>",
  thinking: "medium",
  worktree: { branch: "tickets/ui", base: "main" },
  task: "Implement the UI ticket, test it, and commit. Do not push or merge.",
});
```

Do not parallelize tasks that edit the same behavior, depend on each other's unmerged output, or require ordered migrations. Run those sequentially, or integrate the prerequisite first and use its committed SHA as the next task's base.

## Lifecycle and ownership manifest

Before asking Herdr to create resources, the extension writes a manifest under:

```text
<parent-session-directory>/artifacts/<parent-session-id>/worktree-runs/<run-id>.json
```

The manifest uses the stable owner identifier `pi-herdr-subagents`, retained for compatibility independently of the npm package name. It records the requested base and branch, observed workspace/pane/path, child session path, timestamps, state, and final Git handoff when available.

Possible states are:

| State | Meaning |
| --- | --- |
| `provisioning` | Intent recorded; Herdr creation not yet confirmed |
| `provisioned` | Worktree workspace exists |
| `running` | Child launch command was delivered |
| `ready_for_review` | Child exited successfully; workspace retained |
| `needs_help` | Child called `caller_ping`; workspace retained |
| `failed` | Creation, launch, or execution failed; any created workspace is retained |
| `removed` | Explicit parent cleanup verified checkout absence; branch and manifest retained |

The manifest supports ownership and inspection; v1 does not provide automatic reconciliation after a full Pi/Herdr restart. Do not edit manifests by hand.

## Completion handoff

The parent receives the normal child summary plus:

- worktree path
- Herdr workspace ID
- branch
- requested base ref and resolved base SHA
- head SHA
- number of commits in `base..HEAD`
- changed files across committed, staged, unstaged, and untracked work
- untracked files separately
- working-tree state: clean, dirty, or conflicted

`clean` means there are no staged, unstaged, or untracked files. It does **not** mean the branch has no commits or diff relative to its base.

If Git inspection fails, SHA/count/state/file fields are reported as unknown rather than guessed, and the warning is included in the handoff. Inspect the retained workspace directly before integrating or deleting it. Every retained handoff points to `/worktree remove` and `worktree_remove`, with the raw Herdr command as an operator override after independent safety checks.

## Parallel pull-request review without new worktrees

For parallel read-only review, prepare one stable existing checkout of the pull request or retained worker result. Do not create one managed worktree per reviewer.

1. The parent records the canonical repository root, exact comparison base and head SHAs, and exact task/spec evidence. It makes sure no writer changes the checkout while review runs.
2. Decide explicitly whether staged, unstaged, and untracked files are in scope. For included dirty state, record a bounded inventory and fingerprint; a commit SHA alone cannot pin it.
3. Start each read-only child in an ordinary pane with `cwd` set to that checkout. Omit `worktree`. With default grouped placement, the extension reuses that checkout's workspace and available space in this parent's owned Agents tabs, including a retained writer's root tab. It never moves the writer or creates another worktree. Separate parent processes do not adopt one another's tabs by label.
4. Give every reviewer the same exact scope. Require it to report the repository root and `git rev-parse HEAD` before its review result.
5. Before each dependent review wave and before reporting, recheck the head and dirty-state fingerprint. Drift makes prior evidence stale; review the new state again instead of mixing revisions.

A `read,bash` tool allowlist does not enforce read-only behavior because Bash can mutate the checkout. Tell public reviewers to use only safe inspection, avoid artifact-generating verification, and consume supplied mechanical evidence. Public completion reports above 16,000 characters are abbreviated; when a completed report is needed, retrieve its final assistant message once from the supplied session path with bounded output. This is evidence retrieval, not live-session polling.

For a committed candidate, prefer the `/skill:orchestrate` adversarial procedure. Its approved runner creates one detached checkout pinned to the review head. Effective tools are the resolved role allowlist intersected with the runner maximum (`read`, `grep`, `find`, and `ls`) and deny rules; an override can reduce that set. The parent must materialize the changed-file inventory and unified diff, or complete before/after excerpts, because head-checkout reads cannot recover deleted or base-only blobs. Parent dirty and untracked state is absent. Use the `adversarial-reviewer` compatibility coordinator only when its weaker public-child boundary is intentional and project policy permits it.

```typescript
subagent({
  name: "PR reviewer",
  agent: "reviewer",
  model: "<review-provider>/<mid-tier-id>",
  thinking: "medium",
  cwd: "/path/to/pr-checkout",
  task: "Review base <base-sha> through head <head-sha>. First report git rev-parse HEAD. Do not modify files.",
});
```

A retained worker worktree can be this checkout. The parent owns any final report, PR action, integration, and cleanup.

## Review and integration

Treat completion as a review handoff, not acceptance. Using the path, workspace ID, and base SHA from the result:

```bash
herdr workspace focus <workspace-id>
git -C <worktree-path> status --short
git -C <worktree-path> log --oneline <base-sha>..HEAD
git -C <worktree-path> diff --stat <base-sha>...HEAD
git -C <worktree-path> diff <base-sha>...HEAD
```

Then:

1. Read the worker summary and test evidence.
2. Inspect committed and uncommitted changes.
3. Run relevant tests in the worktree.
4. Resolve dirty or conflicted state in the worktree.
5. Integrate deliberately—merge, cherry-pick, or publish a PR according to the repository's policy.
6. Re-run integration checks on the destination branch.
7. Remove the worktree only after its useful state is preserved.

The extension never pushes, creates a PR, merges, cherry-picks, or changes the parent checkout automatically.

## Failure, help, and restart behavior

- **Ordinary launch failure:** if a fresh launch or `subagent_resume` fails after the extension creates its pane, the extension closes that pane and preserves the original launch error. It does not close a caller-supplied surface.
- **Creation failure:** the manifest is marked failed. If Herdr created the branch but returned an incomplete response, the extension reconciles a unique branch match through `/worktree list` and records any recovered workspace/path.
- **Launch failure after creation:** the manifest is marked failed and the workspace, forked session, and path are retained. The destination is not focused unless Pi startup is confirmed.
- **Worker failure:** summary and available Git state are returned; the workspace remains open. Auto-exit waits until Pi is fully settled, so a transient provider error followed by automatic compaction or retry does not end the worker early.
- **`caller_ping`:** the child exits with `needs_help`; continue worktree-bound follow-up in the retained workspace rather than through `subagent_resume`. Public `subagent_resume` rejects managed-worktree child sessions before creating a pane so it cannot silently lose worktree ownership or policy.
- **Parent `/reload`, `/new`, `/resume`, or `/fork`:** active in-memory watchers transfer to the replacement parent session.
- **Full process restart or crash:** the worktree remains, but v1 does not automatically rediscover and resume its watcher.

`subagent_resume` rejects managed-worktree sessions. It does not reattach the managed worktree lifecycle or produce a new worktree handoff. For worktree follow-up, focus the retained workspace and resume manually from its shell:

```bash
herdr workspace focus <workspace-id>
pi --session <child-session-path>
```

This manual continuation is not watched by the original parent lifecycle. Do not create another managed worktree for a branch that is already checked out.

## Cleanup

Worktree and branch cleanup is always explicit. Ordinary temporary reviewer panes close after result delivery; Herdr removes their tab only if its last pane closes. The retained worktree root shell is excluded from automatic cleanup, and user-added panes are preserved. Persistent specialists retain their pane between tasks and follow the existing explicit stop semantics.

Parent sessions have an inspect-only inventory and an explicit removal surface:

```text
/worktree list
/worktree remove <path|branch|workspace-id> [--preserve]
```

The equivalent tools are `worktree_list({})` and `worktree_remove({ target, preserve?: true })`. Use the exact path when a branch name is ambiguous. Children are not offered these tools or `/worktree remove`. Their existing `/worktree list` (repository-local Herdr listing) and `/worktree <name>` handoff remain available. Detached entries are labeled `(detached HEAD)` in the child listing and do not prevent cleanup inspection of named-branch siblings; the detached checkout itself remains blocked.

Authorization uses **cwd containment**: the canonical source repository root must equal or descend from the canonical session cwd. It does not use the managed checkout's location or require a current-session manifest. Discovery scans `~/.herdr/worktrees/*/*/`, joins Git registration and Herdr workspace state, and includes orphans from ended sessions. Out-of-scope entries are never removable; unregistered residue and failed probes are unknown, not clean. Inventory includes path, branch, source, workspace, Git state, manifest presence, concrete blockers, and separate process-inspection warnings. The managed root, source, and cwd are canonicalized: symlinked ancestors work normally, but a checkout symlink escaping the managed root is blocked.

Removal rechecks containment, Git registration, no detected process holder, known live child, or persistent-specialist lease, and no uncommitted, untracked, or conflicted files. Liveness checks observable same-user processes from any session with a cwd inside the checkout, regardless of runtime name (including thread-suffixed Node names). Only Herdr-confirmed idle retained shell PIDs are exempt; an active runtime at the same PID is not. Detached HEAD, locked checkouts, initialized submodules, and conflicting identity evidence block removal. For initialized submodules, deinitialize them deliberately or use operator removal. No force option is provided.

Unreadable individual process details are **warnings, not blockers**, with no override flag. Scanning continues after each unreadable entry, so another observable holder still blocks removal. Unknown processes are not classified as unrelated. Inventory rows expose separate `blockers` and `warnings` arrays; removal results expose `warnings` and retain warnings from earlier inspections, including refusals and preservation/removal failures when available. Human-readable output includes the same warnings, with counts and at most ten sampled PIDs per inspection, not process commands or environments. Pi tool refusals and failures use thrown errors, so their warnings travel in the error message rather than structured tool details.

This is not proof of machine-wide inactivity: same-user inspection is permission-limited, other-user processes are not inspected, and a protected process could hold the checkout undetected. Linux enumerates `/proc` and checks readable cwd paths; disappeared processes and confirmed zombies do not hold a checkout. macOS uses same-user `lsof` cwd records; unreadable or missing details in individual returned records warn, but a failed global `lsof` blocks even when it returns partial output. Neither platform can establish coverage of processes hidden by the OS. Unsupported platforms, failed or empty global enumeration, and unknown Git, containment, or ownership state remain blockers.

Dirty work requires an explicit `--preserve` or `preserve: true`. This stages all uncommitted and untracked files and creates a WIP commit on the retained branch. A failed commit restores the pre-preservation index and leaves the checkout and its uncommitted files in place; removal does not proceed. Success reports the preservation SHA even if the subsequent recheck or removal fails. Conflicts, detached HEAD, and other blockers cannot be bypassed with preservation.

Ignored files do not block cleanup. Inventory shows their exact file count, and a successful removal reports how many were deleted. Counting streams the NUL-delimited Git listing rather than buffering all paths; errors and the 30-second timeout still block removal, never report a guessed zero. Preservation does not capture ignored files; attempted and successful preservation reports disclose that exclusion when ignored files are present.

Open workspaces are removed through Herdr. Git-only orphans use `git worktree remove`, verify checkout absence, and then prune stale Git registrations. Failed removal is reported, never forced. A reachable owned manifest is merge-updated to `removed` with `workspaceRemovedAt` only after success; absent cross-session manifests are reported and are not rewritten. A manifest update failure after removal is a removed-with-warning result, not a failed removal. Removed manifests provide already-removed no-op evidence only; a new checkout at the same path is classified independently. Missing and dangling manifest paths are non-matches. Permission errors, symlink loops, and other undecidable manifest identities remain blockers, as do genuine identity disagreements. Cleanup Git and Herdr calls have 30-second timeouts; a timed-out operation fails closed rather than proceeding with removal.

Branches and their commits are always retained: cleanup never deletes, force-updates, or rewrites a branch. It never runs on completion, shutdown, or a timer. Inside Herdr with its CLI available, parent session start emits only one compact inventory count when contained worktrees remain. Outside Herdr, startup skips the automatic inventory; explicit inventory tools remain available and report unavailable inspection as unknown. Unsupported platforms or failed global process enumeration block removal; individual visibility gaps are disclosed warnings, never proof that an orphan is idle.

## Current limits

This first version intentionally does not provide:

- automatic push, PR creation, merge, or cherry-pick
- automatic worktree or branch removal
- worktree-aware `subagent_resume`
- durable restart reconciliation
- dependency DAG scheduling or merge queues
- stacked-branch management
- multi-repository workspaces
