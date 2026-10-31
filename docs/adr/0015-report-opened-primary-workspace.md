# ADR-0015: Report the primary workspace worktree creation opened

- **Status:** Accepted
- **Date:** 2026-10-07
- **Amends:** [ADR-0011](0011-explicit-worktree-cleanup.md)

## Context

`herdr worktree create` groups a new worktree with the source repository's
primary workspace and opens that workspace when none is open. `herdr worktree
remove` removes only the linked checkout, so the first worktree of an idle
repository leaves an empty shell workspace behind.

Herdr's `WorktreeCreated` result does not include `created_parent`, so this
extension cannot ask Herdr which workspace the create call opened. The only
signal is a `herdr worktree list --cwd` snapshot before create and another
after it. A workspace the user or another session opens during a long checkout
can be attributed to this create. That race is inherent in the snapshots.

## Decision

Explicit worktree removal never closes the source repository's primary
workspace.

On a worktree launch, this process may record one claim: workspace id, the
source `repo_key`, the only pane's `terminal_id`, and the checkout path the
workspace was opened at. A workspace that was already open is not claimed. A
snapshot that fails, times out, or lacks a required field claims nothing. The
failure is returned as a launch diagnostic, shown in the `subagent`
acknowledgement and the `/worktree` notice, and never written to the console.
Ordinary non-worktree launches do not take these snapshots.

The claim lives only in the creating process and is not written to the
manifest. Removal from another session, or after this process restarts,
reports nothing. Extension reload inside the same process keeps the in-memory
claim.

On explicit removal, core checks whether this process holds a claim whose
checkout is the removed source repository. If not, removal makes no report
calls at all. Otherwise the Herdr surface reads the source once more, after
the checkout is removed and immediately before any sentence. It may tell the
parent:

`wX appears to have been opened by worktree creation; if you haven't used it, close it with herdr workspace close wX`

only when that read shows the workspace untouched: the default label equal to
the repository name (both present), not focused, one tab, not a linked
worktree, the claimed `repo_key`, one pane, the recorded terminal, and `cwd`
and `foreground_cwd` at the recorded checkout. No other workspace may be open
for the repository; a listed row with an open workspace and no boolean
`is_linked_worktree` blocks the sentence too. Any missing or wrong-typed field
a check uses means the workspace is not untouched, so removal says nothing
about it. Shell idleness and child processes are not checked: the sentence is
advisory and hedged, and the extra reads would double the removal cost
without making a close safe.

The surface method is `SurfaceProvider.reportOpenedPrimaryWorkspace`. Herdr
implements it. Other surfaces return no report. Core does not import Herdr.

A failed report is a warning. The checkout removal still succeeds. Nothing in
this path polls, retries, or sleeps.

### Time budgets

A worktree launch adds at most three asynchronous Herdr calls, each bounded at
3 seconds:

1. `herdr worktree list --cwd` before create
2. `herdr worktree list --cwd` after create, only when the before snapshot
   succeeded and showed no primary workspace
3. `herdr pane list --workspace` for that workspace's terminal, only when the
   after snapshot shows a new primary workspace with a repo key and checkout
   path

If each runs to its timeout, the reads consume up to 9 seconds of wall time
without blocking the event loop. A failed before-snapshot skips the later two.
The reads, worktree creation, and optional retained-root grouping share a
120-second acquisition budget. A timed-out mutation remains uncertain because
stopping the CLI does not cancel the server request. Recovery inspection has a
separate 6-second budget and never authorizes late Pi dispatch.

Explicit removal adds at most three asynchronous calls, each bounded at
3 seconds, and only when this process holds a claim for the removed source
repository:

1. `herdr worktree list --cwd`
2. `herdr workspace get`
3. `herdr pane list --workspace`

If each runs to its timeout, removal takes up to 9 more seconds of wall time.
The calls do not block the event loop. A failed or decisive call stops the
rest. These calls are in addition to the existing cleanup Git and Herdr calls,
which stay at 30 seconds each.

## Rejected alternatives

- **Automatic close from the untouched-workspace heuristic.** One tab, one
  pane, the same terminal id, cwd at the checkout, and the default label, even
  with an idle shell and no children, cannot tell whether the user worked in
  the workspace. `git
  log`, a test run, and `cd` back to the checkout leave that same picture, and
  closing it would destroy the scrollback.
- **Pane fingerprinting.** Reading `herdr pane read --source recent` at claim
  time and requiring the same text before a close would catch some commands
  the heuristic misses. It is not clearly better than reporting. Prompt
  redraws, hooks, and Herdr's own startup change the text without a user
  command; a cleared screen looks untouched; a read can fail; and the gap
  between the confirming read and a close is still a race. A mistaken close
  is destructive. A mistaken report is a command the user can ignore.
- **Trusting the manifest after restart.** The creating process is the only
  observer of the before/after snapshots. A later process would be acting on
  a claim it did not make.

## Consequences

Cwd containment, branch retention, and the rejection of automatic reaping in
ADR-0011 are unchanged. A misattributed claim can name a workspace this create
did not open, so the sentence says the workspace "appears" to have been opened
and asks the user to close it only if they have not used it. The message does
not close it. There is no second re-check: the single set of reads is taken
immediately before the sentence, and a workspace that changes after those
reads can still be named. The sentence is still only a suggestion.

See the [operating guide](../worktree-subagents.md#cleanup).
