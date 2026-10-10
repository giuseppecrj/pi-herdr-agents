# Worktree subagents

This guide is the operational reference for running writing agents in isolated Git worktrees with `pi-herdr-agents`. For installation and everyday use, see the [README](../README.md). For the complete tool API and status model, see the [tools and lifecycle reference](tools.md). For the product and open-source research behind these choices, see the [research report](research/worktree-subagent-orchestration.md).

## Quick start

Run Pi inside Herdr from a Git checkout, then give each independent writing task a unique branch. The examples name `worker`, `scout`, and `reviewer` roles; `pi-herdr-agents` ships no roles, so those names must come from an installed role pack or a project/global definition. Omit `agent` for a bare child.

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

- `cwd` selects the source Git repository. A relative tool argument is resolved from the parent Pi process's current directory. When `cwd` is a linked checkout, Herdr provisioning uses its principal checkout while the requested checkout supplies the base SHA and manifest provenance.
- `worktree.branch` is a new, unique branch name. Git/Herdr rejects a branch that cannot be created or is already checked out elsewhere.
- `worktree.base` may be any revision that resolves to a commit in the source repository. It defaults to committed `HEAD`.
- The extension resolves `base` to an exact SHA, writes an ownership manifest, then calls `herdr worktree create --no-focus`.
- Herdr groups the new worktree with the source repository's primary workspace and opens one when none is open. The extension reads `herdr worktree list --cwd` before and after creation, and `herdr pane list` for the opened workspace's terminal, only to record a claim in this process. Each of those reads has a 3-second timeout. A worktree launch runs at most three of them; if each runs to its timeout, that is 9 seconds on top of create. A workspace you already had open is not claimed. An unreadable, timed-out, or incomplete snapshot claims nothing and is reported as a launch diagnostic in the `subagent` acknowledgement or `/worktree` notice, never on the console. A failed before-snapshot skips the later reads. Ordinary pane launches do not make these calls. The claim is not written to the manifest and is not kept after this process exits.
- The child starts at the root of the returned worktree, in that workspace's retained root pane and newly owned `Agents` tab. Finishing Pi returns to the interactive checkout shell; it does not close the root pane. A successful launch from a linked checkout does not itself authorize cleanup there: cleanup checks the canonical principal/source repository under the invoking parent session's cwd, not `manifest.sourceCwd` or shared Git identity. Start the parent Pi session rooted at the principal checkout or an ancestor containing it, then use normal explicit cleanup; changing directories inside an existing Pi session does not change its session cwd.
- Uncommitted and untracked files from the parent checkout are not copied. Commit anything the child must see before spawning it, or pass the needed context in the task.
- Worktree creation does not steal terminal focus.

For an explicit interactive handoff, use `/worktree <worktree> [task]`. It creates the worktree from the current committed branch, forks the active conversation branch into the target-cwd session, launches a normal long-lived Pi process in the returned root pane, and focuses the destination workspace only after Pi startup is confirmed: a Pi process in the root pane's Herdr foreground list must have the worktree cwd and, in its launch-time environment (`/proc/<pid>/environ`), `PI_HERDR_AGENTS_SESSION` naming the forked session file. An unreadable environment (for example, a process that is exiting) never confirms startup. Command-line text is never evidence, because Pi rewrites its process title and Herdr then reports only `pi`. The confirmation reads Linux `/proc`; on other hosts it fails within its bounded wait and the launch-failure retention below applies. Use `/worktree list` to inspect managed worktrees whose source repositories are inside the current cwd subtree, including cross-session orphans. The original process and session remain intact; pane movement is not used to change a running shell's cwd.

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
| `cancelled` | The parent cancelled the run with `subagent_cancel` and the exit of the child's launch-verified Pi process identity was confirmed; workspace, checkout, and commits retained |
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

Review workflows supplied by role packs, such as `/skill:orchestrate` in `pi-herdr-roles`, build on this public-child pattern and document their own methodology. The host provides no review runner and creates no private review checkout. Reviewers read a head checkout, so the parent must materialize the changed-file inventory and unified diff, or complete before/after excerpts, because head-checkout reads cannot recover deleted or base-only blobs. Effective tools are the resolved role allowlist and deny rules.

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
- **Sidebar marker:** with `sidebar.enabled`, the worktree child's root pane carries the delegated marker only while the child's own Pi process runs. The parent clears it when the run finalizes, so the retained shell, and any agent you later start in it, is not marked. After a parent crash the marker expires within 15 seconds of the last write Herdr applied. See the [sidebar plugin README](../plugins/sidebar/README.md#what-a-marker-proves).
- **Worker failure:** summary and available Git state are returned; the workspace remains open. Auto-exit waits until Pi is fully settled, so a transient provider error followed by automatic compaction or retry does not end the worker early.
- **Operator cancel:** `subagent_cancel` never closes the retained root pane or workspace. At launch, the child's protocol extension records its own process identity (PID, `/proc` start time, boot ID, and PID-namespace link) in `<session>.process.json`, and the parent accepts it only while that process is alive in the parent's PID namespace as the Herdr pane shell or a descendant of it. Cancel sends SIGTERM only to that identity, re-verified (PID and start time) immediately before the signal, then confirms that the identity no longer exists, or that the pane is gone while it is not known alive. Command-line text and Herdr's foreground list are never evidence: Pi rewrites its process title, and Herdr lists foreground processes only. A live identity (such as a suspended Pi with SIGTERM pending), or one whose SIGTERM fails while it is still alive, leaves termination `unconfirmed` even if the pane is gone. An identity that was not captured (including on non-Linux hosts), is unreadable, belongs to another boot or PID namespace, or whose PID now has another start time is never signalled and also leaves it `unconfirmed` unless pane absence confirms termination. The PID could still be reused between the final check and the signal, because Node has no pidfd signal. Every Herdr query is bounded by the cancel deadline, and an answer that arrives after the deadline, even before the timer runs, never changes the reported outcome. The run stays live, and retrying `subagent_cancel` re-checks; if the launch capture expired, the retry captures the identity again within its own deadline. On confirmation, the manifest is marked `cancelled` and the normal Git handoff is delivered once. A parent shutdown while termination is unconfirmed records the plain shutdown state, never `cancelled`. No Git cleanup, branch change, or removal happens.
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

Authorization uses **cwd containment**: the canonical source repository root must equal or descend from the canonical session cwd. For linked checkouts, this means the canonical principal/source repository under the invoking parent session's cwd; a successful launch does not itself authorize cleanup, and authorization does not use `manifest.sourceCwd` or shared Git identity. Start the parent Pi session rooted at the principal checkout or an ancestor containing it, then use normal explicit cleanup; changing directories inside an existing Pi session does not change its session cwd. It does not use the managed checkout's location or require a current-session manifest. Discovery scans `~/.herdr/worktrees/*/*/`, joins Git registration and Herdr workspace state, and includes orphans from ended sessions. Out-of-scope entries are never removable; unregistered residue and failed probes are unknown, not clean. Inventory includes path, branch, source, workspace, Git state, manifest presence, concrete blockers, and separate process-inspection warnings. The managed root, source, and cwd are canonicalized: symlinked ancestors work normally, but a checkout symlink escaping the managed root is blocked.

A source repository can be a Git submodule. Its shared Git directory lives under the superproject's `.git/modules`, so cleanup reads `core.worktree` through `git config`, which also follows included configuration files. Cleanup then requires the same top-level and common-directory proofs as for any other source. If the read or a proof fails, the entry is unknown and cannot be removed. Initialized submodules inside a managed checkout still block removal.

Removal rechecks containment, Git registration, no detected process holder, known live child, or persistent-specialist lease, and no uncommitted, untracked, or conflicted files. Liveness checks observable same-user processes from any session with a cwd inside the checkout, regardless of runtime name (including thread-suffixed Node names). Only Herdr-confirmed idle retained shell PIDs are exempt; an active runtime at the same PID is not. Detached HEAD, locked checkouts, initialized submodules, and conflicting identity evidence block removal. For initialized submodules, deinitialize them deliberately or use operator removal. No force option is provided.

Unreadable individual process details are **warnings, not blockers**, with no override flag. Scanning continues after each unreadable entry, so another observable holder still blocks removal. Unknown processes are not classified as unrelated. Inventory rows expose separate `blockers` and `warnings` arrays; removal results expose `warnings` and retain warnings from earlier inspections, including refusals and preservation/removal failures when available. Human-readable output includes the same warnings, with counts and at most ten sampled PIDs per inspection, not process commands or environments. Pi tool refusals and failures use thrown errors, so their warnings travel in the error message rather than structured tool details.

This is not proof of machine-wide inactivity: same-user inspection is permission-limited, other-user processes are not inspected, and a protected process could hold the checkout undetected. Linux enumerates `/proc` and checks readable cwd paths; disappeared processes and confirmed zombies do not hold a checkout. macOS uses same-user `lsof` cwd records; unreadable or missing details in individual returned records warn, but a failed global `lsof` blocks even when it returns partial output. Neither platform can establish coverage of processes hidden by the OS. Unsupported platforms, failed or empty global enumeration, and unknown Git, containment, or ownership state remain blockers.

Dirty work requires an explicit `--preserve` or `preserve: true`. This stages all uncommitted and untracked files and creates a WIP commit on the retained branch. A failed commit restores the pre-preservation index and leaves the checkout and its uncommitted files in place; removal does not proceed. Success reports the preservation SHA even if the subsequent recheck or removal fails. Conflicts, detached HEAD, and other blockers cannot be bypassed with preservation.

Ignored files do not block cleanup. Inventory shows their exact file count, and a successful removal reports how many were deleted. Counting streams the NUL-delimited Git listing rather than buffering all paths; errors and the 30-second timeout still block removal, never report a guessed zero. Preservation does not capture ignored files; attempted and successful preservation reports disclose that exclusion when ignored files are present.

Open worktree workspaces are removed through Herdr. That removal never closes the source repository's primary workspace. If this process recorded that worktree creation opened it, removal reads the workspace after the checkout is removed and may report `wX appears to have been opened by worktree creation; if you haven't used it, close it with herdr workspace close wX` only when those reads, taken immediately before that sentence, show the workspace untouched: the default label equal to the repository name, not focused, one tab, not a linked worktree, the claimed `repo_key`, one pane, the recorded terminal, and both `cwd` and `foreground_cwd` at the recorded checkout, with no other workspace open for the repository. A listed row with an open workspace but no boolean `is_linked_worktree` blocks the sentence. A missing or wrong-typed `label`, `repo_name`, `focused`, `tab_count`, `foreground_cwd`, `terminal_id`, or any other field a check uses means the workspace is not untouched, so removal says nothing about it. Shell idleness and child processes are not checked; the sentence is a hedged suggestion, not a close. The before/after list can attribute a workspace that you or another session opened during a long checkout, because Herdr does not say which workspace create opened; the message does not close anything, so a wrong id is only a suggestion. Claims live only in the creating process: removal from another session, or after a restart, reports nothing. The report's longest path is three asynchronous calls — `worktree list`, `workspace get`, and `pane list`, 3 seconds each — 9 seconds of wall time if every call runs to its timeout, without blocking the event loop. A failed call stops the rest. With no claim for the removed source repository, removal adds none of these calls. Git-only orphans use `git worktree remove`, verify checkout absence, and then prune stale Git registrations. Failed removal is reported, never forced. A reachable owned manifest is merge-updated to `removed` with `workspaceRemovedAt` only after success; absent cross-session manifests are reported and are not rewritten. A manifest update failure after removal is a removed-with-warning result, not a failed removal. Removed manifests provide already-removed no-op evidence only; a new checkout at the same path is classified independently. Missing and dangling manifest paths are non-matches. Permission errors, symlink loops, and other undecidable manifest identities remain blockers, as do genuine identity disagreements. Cleanup Git and Herdr calls have 30-second timeouts; a timed-out operation fails closed rather than proceeding with removal.

Branches and their commits are always retained: cleanup never deletes, force-updates, or rewrites a branch. It never runs on completion, shutdown, or a timer. Session startup skips worktree inventory to avoid blocking Pi initialization; use `/worktree list` or `worktree_list` for an explicit inventory. Outside Herdr, explicit inventory tools remain available and report unavailable inspection as unknown. Unsupported platforms or failed global process enumeration block removal; individual visibility gaps are disclosed warnings, never proof that an orphan is idle.

## Current limits

This first version intentionally does not provide:

- automatic push, PR creation, merge, or cherry-pick
- automatic worktree or branch removal
- worktree-aware `subagent_resume`
- durable restart reconciliation (an opened-primary-workspace claim does not survive process restart)
- automatic close of the source repository's primary workspace
- dependency DAG scheduling or merge queues
- stacked-branch management
- multi-repository workspaces
