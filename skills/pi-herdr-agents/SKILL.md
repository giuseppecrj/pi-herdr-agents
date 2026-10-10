---
name: pi-herdr-agents
description: Operate the pi-herdr-agents host. Use when asked to launch, delegate to, supervise, interrupt, cancel, stop, resume, or clean up Pi subagents; to use worktrees, persistent specialists, or model routing; to edit the host's config.json or task-model preferences; to install, configure, troubleshoot, or uninstall the optional Herdr sidebar plugin; or when a child looks hung, stalled, or unwanted.
---

# pi-herdr-agents operating guide

## Authority and version caveat

Live tool descriptions and the installed package's documentation are
authoritative; this guide is a summary. Check the installed version and which
`subagent*`, `worktree_*`, and `subagents_*` tools you have before relying on
source from another branch or release. Resolve this guide's relative links
from its directory, not the user's working directory.

## What the host is

A Pi extension that runs asynchronous Pi child agents exclusively inside Herdr
(the terminal multiplexer; Pi must be started from inside Herdr). It is a
pack-neutral execution host: it ships no agent roles and no planning or review
workflows. Roles and workflows come from project or global definitions and
installed role packs. Children are real Pi processes in Herdr panes; ordinary
children are grouped in extension-owned `Agents` tabs by default.

## Results arrive automatically: never poll

`subagent` returns an acknowledgement. The child's result (or failure, or help
request) is delivered to you as one bounded `subagent_result` message that
starts a new turn. Never sleep, loop, tail session files, or repeatedly list
status to wait. If a child is merely slow, do nothing. Stalled or no-progress
notices are facts, not instructions to act.

## Launching: `subagent` parameters

`name` and `task` are required. Everything else is optional.

| Parameter | What it means |
| --- | --- |
| `agent` | Load defaults from a named role. Omit for a bare child (always works). A named role that is missing or invalid fails before any pane or worktree is created; it is never replaced by a bare agent. |
| `systemPrompt` | Role text for a bare spawn only; named agents keep their definition body. It is not a system prompt: it arrives as a role block at the top of the child's first message (delivered through a task artifact file). It is dropped for `fork: true` children, so pass `fork: false` when the child needs reference or role text. |
| `model` | Exact authenticated `provider/model-id`; an ordered comma-separated fallback list; or whole-value `task:<category>` (`coding`, `review`, `recon`, `qa`, `architecture`, `docs`) from configured `models.tasks`. Resolution: tool argument, then role frontmatter, `models.agents`, `models.default`, then the parent model. Fallbacks: ordinary non-persistent runs can try later candidates after a launch failure or a provider/agent error from a running child, never after a completed negative result; persistent specialists do not advance after a running-child error; fallback lists are rejected with `worktree`; `task:<category>` with a worktree uses only the first authenticated candidate. A listed model does not prove the account can use it. |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, subject to model support. Precedence: this argument, then role `thinking`, then the parent level. Choose the model tier first, then thinking within its range: low for bounded mechanical work, medium for ordinary implementation or review, high+ for architecture, security, hard diagnosis. Omitting uses the role's `thinking` when set, otherwise the parent level (discouraged). |
| `tools`, `skills` | Comma-separated tool or skill names for the child. |
| `cwd` | Working directory (a role folder with its own config), or the source repository when `worktree` is set. |
| `fork` | `true` forces a full-context fork of your session, `false` forces standalone; omit to follow the role's `session-mode`. |
| `interactive` | Controls parent notifications only (silences stall/recovered pings); it does not affect terminal focus. Precedence: this argument, then the role's `interactive`, then the inverse of `auto-exit` (autonomous roles get pings, others stay quiet). Bare spawns default to autonomous auto-exit unless `interactive: true`. Exception: persistent specialists are always non-interactive unless this argument says otherwise (a persistent role's `interactive: true` is ignored), and they never auto-exit. |
| `persistent` | Keep one specialist session alive for sequential tasks (see below). Rejected at the `persistent.maxAgents` cap (default 3). |
| `worktree` | `{ branch, base? }` for an isolated Herdr-managed Git worktree (see below). Omit, or pass `null`, for an ordinary pane. |

Label coordinated children `<task>-<role>[-n]`. Panes and tabs are created
without stealing focus. Read-only scouts and reviewers use ordinary panes; a
single or sequential writer can work in the parent checkout.

## Roles and role packs

A named `agent` resolves by precedence: project (`.pi/agents/`), then global
(`$PI_CODING_AGENT_DIR/agents/`, default `~/.pi/agent/agents/`), then roles
registered by installed role packs. An empty catalog is valid. `subagents_list`
and `/subagent list` show each visible role and its source. Roles that request
an external CLI (`cli`) fail before launch. Role frontmatter can set
`spawning: false` (denies all subagent lifecycle tools) and `deny-tools`
(tools registered by this package). Children also get `caller_ping`, and
interactive (non-`auto-exit`) children get `subagent_done` to mark themselves
complete; `auto-exit` roles exit on their own. These exist only inside child
sessions. Parent-only tools (`worktree_list`, `worktree_remove`,
`subagents_write_task_models`, `/subagents-init`) are omitted in children. For
frontmatter authoring, read [Custom Agents](../../docs/roles.md#custom-agents)
and [Tool Access Control](../../docs/roles.md#tool-access-control).

## Help requests: `caller_ping`

A child that needs help calls `caller_ping({ message })`. An ordinary child
exits; resume it with `subagent_resume` and guidance. A persistent specialist
stays alive; answer with `subagent_send`.

`subagent_resume` takes `sessionPath` (required), `name` (pane label, default
`Resume`), `message` (follow-up prompt), and `autoExit` (default `true`; set
`false` for an interactive handoff). It restores the stored tool allowlist and
denied tools, cannot change the model (use it only once the stored model is
usable), and fails before creating a pane on a missing, malformed, or
unsupported launch policy. It rejects managed-worktree sessions (use the
retained workspace instead) and cannot revive persistent specialists.

## Persistent specialists

`persistent: true` creates one logical specialist with one session generation;
tools, model, thinking, and worktree binding are fixed at launch.

- `subagent_send({ id|name, message })` delivers one task, exactly once. One task
  at a time: a send while busy is `rejected-busy`; nothing is queued.
- `subagent_stop({ id|name })` is graceful: with an active task it becomes
  `stop-pending`, the task finishes first, and `stopped` is reported only after
  process-exit evidence.
- A timed-out stop leaves it `stalled` with an unconfirmed stop; sends are
  rejected. Retry `subagent_stop` or spawn a replacement.
- Persistent specialists cannot be resumed; after a crash or confirmed stop,
  spawn a new one. No automatic restart or revival.
- A persistent worktree specialist holds its worktree for its lifetime.

## Lifecycle control

| Goal | Use | Effect | Not guaranteed |
| --- | --- | --- | --- |
| Halt the child's current model turn, keep its session | `subagent_interrupt({ id\|name })` | Sends Escape only; pane, process, session stay; label `interrupted` | No result emitted; child not stopped; may start work again |
| End a persistent specialist | `subagent_stop` | Graceful, then confirmed exit | Persistent only; not immediate |
| Continue an exited ordinary child | `subagent_resume` | New ordinary pane on the old session | Rejected for managed-worktree and persistent sessions; cannot change model |
| Follow up a live persistent specialist | `subagent_send` | One task if idle | Rejected while busy or stop-unconfirmed |
| Terminate an ordinary child | `subagent_cancel({ id\|name })` | Records cancel intent first, terminates the owned process, delivers one `cancelled` result; no fallback or retry | Ordinary only (persistent rejected); not confirmed unless the status says so |
| Close the pane, kill the process, Ctrl-C by hand | Avoid | See fallback gotcha | Can launch a replacement run |

`id` or `name` must be an exact running ID or an exact, unambiguous name; `id`
wins if both are given.

## Cancelling an ordinary child: `subagent_cancel`

`subagent_cancel({ id|name })` ends one running ordinary child, including an
interrupted one (targets resolve as for `subagent_interrupt`). Intent is
recorded before anything is killed, so no fallback, retry, or recovery starts
afterwards. Do not poll; the result arrives on its own.

| Status | Meaning for you |
| --- | --- |
| `confirmed` | Termination confirmed. One cancelled result is delivered. |
| `requested` | Launch in flight; terminated once acquired, no later model tried. Wait. |
| `unconfirmed` | Termination failed. The run stays live and supervised; nothing is delivered. Retry, or report. |
| `already-terminal` | Already had a natural result or was retired; nothing cancelled. |

Repeated cancels join an in-flight one and keep the first request time; there
is no SIGKILL escalation. The one `subagent_result` carries `error: "cancelled"`
and a `cancellation` record (not a provider failure); a natural result taken
before the cancel stays authoritative.

Termination follows ownership:

- **Ordinary pane:** the pane is closed. Confirmed means Herdr reports the pane
  absent; this is not a separate OS process check.
- **Worktree child:** pane, workspace, checkout, and commits are never closed
  or removed. SIGTERM goes only to the child's Pi process identity verified
  at launch (PID and start time, never command-line text); confirmed when
  that identity no longer exists, or when the pane is gone while it is not
  known alive. A live identity (such as a suspended Pi) leaves it
  `unconfirmed`. One not captured (including on non-Linux hosts),
  unreadable, or whose PID now names another process is never signalled and
  leaves it `unconfirmed` unless pane absence confirms termination. A retry
  re-checks, and captures again if launch capture expired; every check stays
  within the cancel's time bound. Cancel itself never closes the retained
  pane. The manifest
  records `cancelled` only after confirmation; the normal handoff is
  delivered. No Git cleanup; `worktree_remove` stays separate.
- **Persistent specialist:** rejected with a pointer to `subagent_stop`.

Widget labels: `cancelling…`, `cancel unconfirmed`. `spawning: false` denies it.

### State labels

`starting` launched, still settling; `active` working (turn, provider request,
streaming, tool); `blocked` Herdr reports blocked; `waiting` turn finished,
process open; `interrupted` turn cancelled, process open; `stalled` pane
inspection unhealthy, run untrusted (also an unconfirmed stop); `running`
coarse process presence only; `finalizing` completion observed, delivering.
Herdr's own pane status is a separate, coarser signal; do not read it as
stopped or clean.

### Evidence before declaring stopped

A request is not an exit. `interrupt` sent, `stop` requested, or `stop-pending`
means nothing has stopped. A delivered task result ends the task, not the
session: persistent specialists stay alive after results and keep their
worktree lease. Say an ordinary child is stopped only with a delivered
result or failure notice for that run (including the cancelled result), or a
`subagent_cancel` status of `confirmed`. A `requested` cancel means it is still
live and terminates once the launch settles: wait for the cancelled result. An
`unconfirmed` cancel means termination failed and it is still live: retry or
report the uncertainty. Say a
persistent specialist is stopped only with confirmed process exit (for
example `subagent_stop` reporting `stopped`). Otherwise report the
uncertainty. Do not start a concurrent writer on the same files or worktree
until exit is confirmed.

### Fallback gotcha

A pane that disappears without completion evidence is treated as error or
`stalled` evidence, and an ordinary run with remaining fallback candidates
retries after a provider/agent error. So closing a pane by hand can, as
observed in practice (not guaranteed), launch a replacement run and keep the
work you tried to cancel going. Persistent specialists never auto-restart.
Never close panes, kill processes, or send raw terminal keystrokes to cancel;
use `subagent_cancel`, which blocks fallback first. If a replacement launched anyway, identify the new run and handle it with the
tools above.

## Worktrees

`worktree: { branch, base? }` (or `/worktree <name> [task]` to continue the
current conversation in a new interactive session there). Use one per parallel
independent writer.

- `cwd` selects the source repo; the child starts at the created worktree root.
- `base` resolves to an exact commit, defaulting to committed `HEAD`. Parent
  uncommitted or untracked files are not copied. `branch` must be unique.
- Workspaces are retained after success, failure, and help requests. Completion
  reports path, workspace, branch, base/head SHAs, commits ahead, changed and
  untracked files, and clean/dirty/conflicted. `clean` means no uncommitted
  files; commits may exist. Inspection failure means unknown, not clean.
- Tell workers whether to commit; a good default is test, commit, report the
  SHA, and do not push, merge, switch branches, or remove. The extension never
  pushes, merges, creates PRs, or auto-removes anything. The parent owns review,
  integration, and publication.
- `worktree_list({})` / `/worktree list` is read-only inventory with cleanup
  blockers. Startup does not scan it.
- `worktree_remove({ target, preserve? })` / `/worktree remove <target>
  [--preserve]` is explicit, parent-only, and needs separate authorization;
  stopping or interrupting a child never authorizes cleanup. Removal never
  closes the source repository's primary workspace. If this process's create
  appears to have opened that workspace and it still looks untouched, the
  result suggests `herdr workspace close <id>` if you haven't used it. Another
  session or a restarted process says nothing about it. Primary-workspace
  snapshot failures at launch appear as launch diagnostics. Dirty work is
  blocked unless committed first or `preserve: true` makes a WIP commit (SHA
  reported). Eligibility is rechecked at removal and fails closed (unknown
  state, live holder, untracked files, conflicts, detached HEAD, locks,
initialized submodules). Ignored files are neither blockers nor preserved by
`preserve`; their counts are reported. Branches
  are never deleted. Cleanup works from a parent session rooted at the principal
  checkout or an ancestor; `cd` inside Pi does not change that.
- `subagent_resume` rejects managed-worktree sessions. Continue in the
  retained workspace only after the previous process has exited.

## Configuration

Durable config: `$PI_CODING_AGENT_DIR/herdr-agents/config.json` (default
`~/.pi/agent/herdr-agents/config.json`); never the package root. Copy the
package's `config.json.example` or run `/subagents-init`. Run `/reload` after
changes. Without a real file, only non-model settings fall back to the example.

| Key | Purpose |
| --- | --- |
| `status.enabled` | Widget status |
| `sidebar.enabled` | Opt-in delegated-child markers for the optional Herdr sidebar plugin; off by default |
| `models.default` | Model for children that specify none |
| `models.agents` | Per-role model, keyed by role name |
| `models.tasks` | Ordered exact-ID candidates per category for `task:<category>` |
| `models.tasksMeta` | Provenance of the task preferences |
| `persistent.maxAgents` | Retained specialist cap (default 3) |
| `supervision.*`, `panes.*` | Transport, hang advisory minutes, pane grouping |
| `roles.bundled` | Deprecated no-op; remove it |

Model values must be exact authenticated IDs. `/subagents-init [preferences]`
drafts task preferences from the live model registry and the saved config's
`configRevision`, then saves them through `subagents_write_task_models`
(parent-only; validates, atomically replaces `models.tasks` and `tasksMeta`,
preserves other settings). When one loaded extension offers to approve the
write, the init prompt names that extension's tool instead; follow the prompt
and do not call the writer around it. Payload: `tasks`
(partial but nonempty categories; empty `tasks: {}` and duplicate refs within a
category are rejected) and required `tasksMeta`. Warning: categories you omit
are removed from the saved config, so send every category you want to keep.
Optional `basis` states what the ranking rests on and is not saved: use
`{"kind":"registry-only"}` unless sources consulted in this run informed it,
then `{"kind":"research","sources":[{"url":"https://...","influence":"how it changed the ranking"}],"uncertainty":"what remains unknown"}`.
Its kind must equal `tasksMeta.method`.
Optional `expectedConfigRevision` (`sha256:` plus 64 lowercase hex digits of the exact file bytes,
or `missing`) makes the write conditional; a stale revision fails with
`Stale task model config revision`: re-read, re-propose, re-approve, do not
retry blindly. Every write holds an advisory `config.json.lock`; a held lock
fails immediately with `Task model config writer busy`, and it is never broken
automatically. Remove it only after confirming no writer is active.

## Optional Herdr sidebar plugin

For installation or troubleshooting, first read the
[sidebar plugin guide](../../plugins/sidebar/README.md). Resolve that path from
this skill's directory, not the user's working directory. It is the canonical
reference for requirements, installation, Focus/All, limits, and uninstall.

Setup has two separate parts: **install the Herdr plugin** and **enable markers
in the Pi extension**. Neither alone enables sidebar filtering.

1. Check the installed extension supports `sidebar.enabled`, and check the
   guide's Herdr compatibility requirements. Markers require Linux; the Herdr
   server needs `node` on its `PATH`. Use `pi list` to check package sources;
   do not load two copies of the extension.
2. Review the plugin source, then follow the guide to install
   `giuseppecrj/pi-herdr-agents/plugins/sidebar` with `herdr plugin install`,
   or link an existing compatible directory with `herdr plugin link`.
   Installing the Pi package does not install the Herdr plugin.
3. Merge `"sidebar": { "enabled": true }` into the durable config described
   above, preserving `status`, `models`, and all other settings. If the file
   does not exist, first copy the installed package's `config.json.example`;
   a sidebar-only config is invalid because `status` is required.
4. Run `/reload` in each parent Pi session inside Herdr, then launch new
   children. Children already running stay unmarked.
5. Invoke Focus explicitly; installation and enablement never activate it:

   ```bash
   herdr plugin action invoke pi-herdr-agents.sidebar.focus
   ```

Focus changes the server-wide Agents view, replacing any existing view. It
hides marked children except those blocked or with unknown status; it never
stops children or suppresses notifications. To restore rows, invoke
`herdr plugin action invoke pi-herdr-agents.sidebar.all`. All clears only this
plugin's view and leaves another tool's view untouched. If filtering does not
work, inspect `herdr plugin log list --plugin pi-herdr-agents.sidebar` and
follow the guide's troubleshooting steps.

## Denied tools

Role `spawning: false` and `deny-tools` restrict what a child may call; the
host applies them at launch and they survive resume. Without a restrictive
allowlist or spawning policy, a child can spawn further children. A `read,bash`
allowlist is not a read-only boundary.

## Finding current help

Read live tool descriptions first, then the installed package's
[README](../../README.md). Use the detailed references for
[tools and lifecycle](../../docs/tools.md), [roles](../../docs/roles.md),
[configuration](../../docs/configuration.md),
[worktrees](../../docs/worktree-subagents.md), and
[troubleshooting](../../docs/troubleshooting.md).
