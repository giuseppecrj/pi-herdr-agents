# ADR-0011: Authorize explicit worktree cleanup by cwd containment

- **Status:** Accepted
- **Date:** 2026-09-17
- **Scope:** Managed subagent worktree cleanup (issue #45)

## Decision

A parent may explicitly remove one managed worktree when its canonical source
repository is within the session's canonical cwd subtree. This supersedes the
session-manifest-only ownership policy discussed in issue #45, per its
2026-09-17 scope update: ended sessions leave orphans whose manifests are no
longer reachable. A reachable owned manifest enriches inventory and is marked
removed after successful cleanup, but is not the authorization boundary.

Discovery joins the managed filesystem root, Git registration and working-tree
state, live Herdr workspace state, and current-session manifests. Unknown or
conflicting eligibility evidence blocks removal, subject to the approved
individual process-visibility exception below. Detected same-user process
holders, known live children, and persistent leases block removal; process
names are not a runtime allowlist. Only Herdr-confirmed idle retained shell
PIDs are exempt, never active runtimes at those PIDs. Dirty work requires an
explicit WIP preservation commit on the retained branch; detached HEAD,
conflicts, locks, and initialized submodules cannot be bypassed.

The approved process-visibility policy treats unreadable individual process
details as non-blocking warnings, without an override flag. Inspection continues
so one hidden process cannot mask an observable holder. Inventory and removal
results report incomplete coverage separately from blockers, retaining warnings
through rechecks, preservation, and failures when available. Reports use counts
and bounded PID samples, not commands or environments. Linux uses `/proc`;
macOS uses same-user `lsof` cwd records and warns for individual unreadable
records. Unsupported platforms and failed global enumeration remain blockers;
partial output from a failed `lsof` is not successful enumeration.

Paths are canonicalized, so symlinked ancestors are supported while checkout
symlinks escaping the managed root are blocked. Ignored files are counted and
disclosed, but do not block removal and are not captured by preservation. A
failed preservation commit restores the original index. A created preservation
SHA remains in the report even when subsequent removal fails.

Removed manifests are no-op evidence only and never classify a recreated
checkout. Post-removal manifest-write failures are warnings, not removal
failures. Cleanup Git and Herdr calls have bounded 30-second timeouts. Child
sessions retain their existing `/worktree list` and `/worktree <name>` surfaces;
only the cleanup tools and removal subcommand are parent-only.

Open workspaces are removed through Herdr. Git-only orphans use Git removal,
verify checkout absence, and then prune stale registrations. Branches and their
commits are retained.

Removing the last linked worktree workspace also closes one workspace that is
not a removal target: the source repository's primary workspace, which Herdr
opened as a side effect of worktree creation. This is limited to a workspace
the creating launch recorded as newly opened (a manifest claim pinning the
workspace id, the source `repo_key`, the root pane's `terminal_id`, and the
checkout path it started in); a workspace the user already had open is not
claimed. At close time every safety condition must hold and any check
that cannot run keeps the workspace: no other linked workspace open, default
label, not focused, one tab and one pane, the recorded terminal, the pane still
at the recorded checkout, an idle shell with no child processes. Claims that can
no longer match are cleared. These conditions are a heuristic: command history
alone, without a cwd change or background job, is undetectable, so a workspace
the user only typed in can still be closed. The close never passes `--group`
and its failure is a warning, not a failed removal. Session startup does not scan worktree inventory, avoiding blocking Pi initialization; use `/worktree list` or `worktree_list` for an explicit inventory.

## Rejected alternatives

- Session-only ownership cannot recover cross-session orphans.
- Global authorization would allow one project to remove another's review state.
- Automatic reaping at completion, shutdown, or on a timer erases the parent's
  opportunity to review retained work.
- Force removal and branch deletion are outside this feature's authority.
- Repo-global stashes make preserved work less visible than retained commits.
- Recursive filesystem deletion to bypass submodule protection is not supported.

## Consequences

Broad cwd values authorize broad repository subtrees, so callers must choose cwd
deliberately. Worktrees are not sandboxes. Fresh eligibility checks reduce but
cannot eliminate races with external writers; underlying refusals are surfaced,
not overridden. Same-user process inspection is permission-limited, and
other-user processes are not inspected. A protected process could hold the
checkout undetected; unreadability is not proof that it is unrelated. This
accepted blind spot replaces the earlier strict individual-unreadability
blocker, not the global enumeration or identity guards. Restart inventory does
not reattach watchers or rewrite other sessions' manifests.

See the [operating guide](../worktree-subagents.md#cleanup) for the shipped API.
