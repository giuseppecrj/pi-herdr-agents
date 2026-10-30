# Managed worktree run

`subagent` with `worktree: { branch }` creates one Herdr-managed Git worktree from the source repo's committed `HEAD`. It writes the ownership manifest first, starts the child at the worktree root without stealing focus, and on completion delivers a handoff (path, workspace, branch, base/head SHAs, commits ahead, clean/dirty state). It retains the workspace. Removal is explicit and parent-owned: `worktree_list` / `/worktree list` and `worktree_remove` / `/worktree remove`. Dirty checkouts are refused and branches are never deleted.

## Sub-features

- `wt-create`: Herdr lists the branch's worktree for the lab project; the parent workspace keeps focus.
- `wt-handoff`: the `subagent_result` carries the worktree handoff host lines outside the envelope, and the commit is on the branch.
- `wt-retain`: after completion the worktree workspace stays open and the checkout is clean.
- `wt-list`: `/worktree list` shows the entry as `eligible · Git: 0 dirty` once holders exit.
- `wt-remove-dirty`: removal of a dirty checkout is refused and the file survives.
- `wt-remove`: removal of a clean checkout reports `commits retained`; the path is gone and the branch still exists.

## How to get to it (user POV)

- The model calls `subagent` with `worktree: { branch: "<b>" }` and `cwd` at the source repo (docs/tools.md, "Isolated worktree runs"; docs/worktree-subagents.md).
- The parent's model calls `worktree_list` / `worktree_remove`, or a human types `/worktree list` and `/worktree remove <path|branch|workspace-id>`.

## Driving it with lab.ts

Preconditions:

- `$L up` printed `LAB_READY`; the lab project has one commit on `main` and `.pi/` ignored. Covered by `test/integration/subagent-lifecycle.test.ts`: "retains a completed worktree, refuses dirty cleanup, and explicitly removes it without deleting history", and `test/integration/subagent-cancel.test.ts` "(c) cancels a worktree child: workspace, checkout, commit and handoff retained".

- **Launch.** Run `$L prompt worktree w1`. Then poll `$L herdr worktree list --cwd "$($L state | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).project')" --json` until an entry with branch `verify/ticket-w1` appears.
- **Handoff.** Wait for the `subagent_result` from `Worktree-w1`. In the worktree path, `git log -1 --pretty=%s` prints `Implement w1` and `git status --porcelain` is empty.
- **List.** Run `$L send "/worktree list"` and `$L read 120`, repeating until the entry reads `eligible · Git: 0 dirty`.
- **Dirty refusal.** `echo x > <worktree>/uncommitted.txt`, then `$L send "/worktree remove <open_workspace_id>"`. The screen shows the dirty refusal and the file still exists.
- **Remove.** Commit the file in the worktree, then send `/worktree remove <open_workspace_id>` again. The screen shows `commits retained`, the path is gone, and `git -C <project> branch --list verify/ticket-w1` still lists the branch.
- **Proof.** Run `$L evidence worktree` after each mutation, and keep the `herdr worktree list` output next to it.

## Gotchas

- The completed child's processes can briefly hold the checkout. Each `/worktree list` render is final, so re-issue it; do not wait on one screen.
- The worktree is created from committed `HEAD`. Uncommitted lab-project files are not copied.
- `subagent_resume` does not reattach a worktree run. Follow up in the retained workspace.
- Lab worktrees live under the lab HOME (`<home>/.herdr/worktrees`), not your real `~/.herdr/worktrees`, so `down` removes them with the lab root.
