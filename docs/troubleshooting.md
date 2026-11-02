# Troubleshooting

This page collects the checks for common problems. Each section links to the full reference.

## Troubleshooting completion delivery

If a child finishes but the parent returns an empty or unrelated response, first verify that the result reached the parent session:

```bash
jq -c 'select(.type == "custom_message" and .customType == "subagent_result")' "$PI_SESSION_FILE" | tail -1
```

If the entry exists, spawning and result extraction worked; investigate parent wake-up and model-facing delivery rather than the child process. Completion wake-ups must contain the bounded result directly—do not send a separate message that merely tells the parent to look at an adjacent custom message.

Git package refs are pinned. To move an installed development copy back to the current `main`, install that ref explicitly and reload the active Pi session:

```bash
pi install git:github.com/giuseppecrj/pi-herdr-agents@main
# Then run /reload inside Pi.
```

Smoke-test delivery with an autonomous subagent instructed to return one exact marker. Success means the marker itself—not only a generic wake-up notice—automatically appears in the parent turn.

Subagent tabs, panes, and worktree workspaces are created without stealing keyboard focus. Launch commands target child panes by explicit ID, so focus and command delivery are independent. If a fresh or resumed launch fails, the extension attempts confirmed rollback of the ordinary pane it created and preserves the original launch error. Unconfirmed rollback retains ownership instead of claiming cleanup succeeded. It does not close a caller-supplied surface, and managed worktree workspaces remain retained on failure. Note: the `interactive` option controls parent status notifications, not terminal focus.

## An acquisition or dispatch is uncertain

Do not repeat the launch immediately. A timed-out Herdr client does not establish
that the server stopped creating a resource or delivering a command.

1. Read the exact pane, workspace, session, and manifest identities in the error
   or acknowledgement. Never choose a resource by its display label.
2. For an acknowledgement with `status: "uncertain"`, use the existing run's
   control tools. Its acquired owner stays supervised, and fallback is disabled.
   A result follows confirmed termination. An unconfirmed control response does
   not mean that the process stopped.
3. For an ownerless creation failure, inspect the reported resources and retained
   manifest before deciding whether another launch is safe. Worktree recovery
   evidence does not authorize automatic removal or reuse of the same branch.

Launch and handoff subprocesses have [finite operation budgets](tools.md#launch-deadlines-and-uncertainty).
A failed Git handoff reports unknown state. Inspect the retained checkout before
integration or cleanup. Explicit cleanup Git commands still run synchronously
with their existing timeouts.

## A child is stalled or makes no progress

The widget shows `stalled` when pane inspection fails or the pane disappears without a completion record. Time alone never makes a run stalled. A no-progress advisory warns once per episode and never interrupts, kills, retries, or restarts a child. Interrupt the child with `subagent_interrupt`, end an ordinary run with `subagent_cancel`, or stop a persistent specialist with `subagent_stop`. See [In-progress status updates](tools.md#in-progress-status-updates) and [Supervision transport](configuration.md#supervision-transport).

## A model fails

A catalog-listed model and configured authentication do not prove that your provider account can use the model. The completion keeps each raw provider reason with its model. Check account access, launch a new subagent with a supported model, or configure a fallback. See [Model resolution and fallback](configuration.md#model-resolution-and-fallback).

## An accept check reports error or an unexpected verdict

`Check: error (timed out after 600s)` means the parent's re-check never answered: it timed out, was killed by a signal, its directory was missing, or `sh` could not start. Raise `accept.timeoutSec` (at most 3,600) for a slow suite, and run the command by hand in the reported directory (`details.accept.cwd`). The check runs without `PI_SUBAGENT_*` variables, so a check that depends on them fails in the re-check. `rejected (child reported a pass; …)` means the child's own run passed and the parent's failed; for an ordinary child the delivery says `shared checkout`, and another writer's edits in that checkout can cause it, so use a worktree for parallel writers. `skipped` means the run did not complete naturally, and `none` means no check was requested, including every resumed run. See [Accept checks](tools.md#accept-checks).

## Worktree removal is refused

Removal reports each blocker, such as dirty files, a live process, or an unknown inspection. Commit the work or pass `--preserve`, stop any process in the checkout, and start the parent Pi session at the source repository or an ancestor of it. See [Explicit worktree cleanup](tools.md#explicit-worktree-cleanup) and [cleanup and recovery](worktree-subagents.md#cleanup).

## A Windows child fails to start, or runs inside WSL

A bare `bash` typed into a Windows pane resolves through `PATH`, where the WSL launcher (`C:\Windows\System32\bash.exe`) can outrank Git Bash. So the host runs each child's launch script through an absolute bash path, the one Pi's own bash tool uses: `shellPath` in Pi's `settings.json` (the launching session's, including its project settings only when the project is trusted), then Git Bash in `%ProgramFiles%` / `%ProgramFiles(x86)%`, then the first `bash.exe` on `PATH`.

The pane's shell is whatever Herdr's `terminal.default_shell` starts, so the host reads it from `herdr pane process-info` (the `foreground_processes` entry whose `pid` is `shell_pid`, by `name`) and spells the line for it:

| Pane shell | Line typed |
| --- | --- |
| `powershell.exe`, `pwsh.exe` | `& '<bash>' '<script>'` |
| `cmd.exe` | `"<bash>" "<script>"` |
| `bash.exe`, `sh.exe` (Git Bash) | `'<bash>' '<script>'` |
| anything else, or no process info | `bash '<script>'`, as before |

Launch fails before anything is typed when:

- **No bash resolves, or Pi's discovery returns the WSL launcher.** This happens with a per-user Git for Windows, Scoop or MSYS2 install, because Pi checks only the `Program Files` locations before taking the first `bash.exe` on `PATH`. Set `shellPath` in Pi's `settings.json` to your Git `bash.exe`, for example `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`.
- **A `cmd.exe` pane and a path containing `"`, `%` or `!`.** `cmd.exe` expands `%VAR%` inside quotes, and `!VAR!` under delayed expansion, so the line cannot be made safe. Use a PowerShell or Git Bash pane, or a bash and temp directory without those characters.

Unknown shells such as nushell keep the bare `bash '<script>'` line and are not protected from the WSL launcher.

## Sidebar Focus hides nothing

Focus applies at the first agent Herdr detects after install, so launch or start an agent first. If you ran All, Focus stays off until you run Focus. Check that the parent loads a `pi-herdr-agents` release newer than `3.3.1` (older releases also need `"sidebar": { "enabled": true }` in `config.json`), that you ran `/reload` in the parent after installing or upgrading it, and that you launched the child after the reload. Run `herdr pane get <child-pane-id>`: the pane must report the child's session file as `agent_session`. If it reports none, install Herdr's Pi integration with `herdr integration install pi` in the agent directory children use, then launch new children. Read the plugin log with `herdr plugin log list --plugin pi-herdr-agents.sidebar`. See the plugin's [troubleshooting](../plugins/sidebar/README.md#troubleshooting).
