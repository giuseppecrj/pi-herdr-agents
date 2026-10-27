# Tools and lifecycle reference

This page is the detailed reference for the tools, commands, and run lifecycle of `pi-herdr-agents`. For installation and everyday use, see the [README](../README.md). Configuration keys are in [Configuration](configuration.md), and role authoring is in [Roles and custom agents](roles.md).

## What's Included

### Extensions

**Subagents** — 10 parent-session tools + 3 commands, plus 2 child-only tools:

| Tool                 | Description                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `subagent`           | Spawn a sub-agent in a dedicated herdr pane (async — returns immediately)             |
| `subagent_interrupt` | Interrupt a running Pi-backed subagent's current turn                                       |
| `subagent_cancel`    | Cancel a running ordinary subagent: no fallback, one cancelled result after confirmed termination |
| `subagent_send`      | Deliver a follow-up task to an idle persistent specialist                                   |
| `subagent_stop`      | Gracefully stop a persistent specialist after its active task settles                      |
| `subagents_list`     | List available agent definitions                                                            |
| `worktree_list` | Parent-only inspect-only inventory of managed worktrees and cleanup blockers |
| `worktree_remove` | Parent-only explicit removal by `target` path, branch, or workspace ID; optional `preserve: true` commits dirty state first |
| `subagent_resume`    | Resume a previous Pi-backed sub-agent session in a new ordinary pane (async)                          |
| `subagents_write_task_models` | Parent-only internal tool that validates and atomically writes `models.tasks` preferences, optionally conditional on `expectedConfigRevision` and carrying an unsaved ranking `basis` |

| Skill | Description |
| ----- | ----------- |
| `pi-herdr-agents` | Operating guide for this host: launching, supervising, interrupting, cancelling and resuming children, worktrees, persistent specialists, model routing and configuration. Loaded by agents on demand; see the [operating skill](../skills/pi-herdr-agents/SKILL.md) |

| Pi child-only tool | Description |
| ---------------- | ------------------------------------------------------------------------- |
| `caller_ping` | Ask the parent for help; ordinary children exit, persistent specialists stay alive |
| `subagent_done` | Mark an interactive child complete and exit; autonomous agents auto-exit |

| Command                    | Description                          |
| -------------------------- | ------------------------------------ |
| `/worktree <name> [task]`  | Continue this session in a new managed worktree (`/worktree list` lists them) |
| `/subagent <agent> <task>` | Spawn a named agent directly (`/subagent list` lists available agents) |
| `/subagents-init [preferences]` | Draft task-category model preferences from the live authenticated registry, with optional ranking preferences; a loaded approval extension can own the write |

## Async Subagent Flow

```
1. Agent calls subagent()          → returns immediately ("started")
2. Sub-agent runs in herdr pane    → widget shows live status
3. User keeps chatting             → main session fully interactive
4. Sub-agent finishes              → result steered back as a normal completion/failure
5. Main agent processes result     → continues with new context
```

Multiple subagents run concurrently — each steers its result back independently as it finishes. Active watchers survive parent `/reload`, `/new`, `/resume`, and `/fork` transitions, so completion is delivered into the replacement session. Quitting Pi still stops parent-side delivery. The live widget above the input tracks every agent still in flight:

```
╭─ Subagents ──────────────────── 1 active · 2 open ─╮
│ 01:23  Scout: Auth (scout)             active · read 7m │
│ 00:45  Reviewer (reviewer)                   stalled 4m │
│ 00:12  Scout: DB (scout)                      starting… │
╰─────────────────────────────────────────────────────────╯
```

Completion messages render with a colored background and are expandable with `Ctrl+O`. Results larger than 16,000 characters are abbreviated in the parent context while preserving their beginning, conclusion, and session path; the complete result remains in the child session. The extension includes that bounded result and a continuation instruction directly in the single custom `subagent_result` message that triggers or steers Pi, avoiding empty turns caused by a separate context-free wake-up. The renderer uses the unadorned bounded result from structured details. Completed rows are removed from the widget as soon as their result is delivered or suppressed.

### In-progress status updates

The widget projects each sub-agent from a **process + turn lifecycle**:

- **Herdr pane inspection** is the coarse authority for whether the child process is present and whether Herdr reports it as idle, working, blocked, or done.
- **Child activity snapshots** enrich the label with Pi-only detail (tool name, streaming, etc.) when available.
- Session JSONL is still used for transcript, resume, lineage, and result extraction — not for liveness.

Projected labels include:

- `starting` — launched; pane/activity confirmation is still settling
- `active` — processing work (agent turn, provider request, streaming, or tool execution)
- `blocked` — Herdr reports the child as blocked
- `waiting` — turn finished; the process is intentionally open for more input or another stage
- `interrupted` — the current turn was cancelled (Escape / `subagent_interrupt`); the process stays open and is **not** treated as active processing
- `stalled` — pane inspection is unhealthy long enough that the parent can no longer trust the run
- `running` — fallback when only coarse process presence is known
- `finalizing` — completion was observed and delivery is in progress; the process elapsed timer freezes here
- `cancelling…` / `cancel unconfirmed` — a `subagent_cancel` is terminating the run, or its termination could not be confirmed and the run stays live

The widget header counts **active** vs **open**:

- **active** — `active`, `starting`, `running`, or `blocked`
- **open** — everything else still tracked (`waiting`, `interrupted`, `stalled`, `finalizing`, …)

When `activeCount === 0` (every tracked row is open), the border uses an amber accent. Process elapsed time (`MM:SS` on the left) freezes when the process reaches finalizing/completed/failed. Interrupt does **not** freeze that process clock; the interrupted state shows its own duration on the right while the process remains open.

A fixed internal watchdog marks a run as `stalled` when pane inspection fails or the pane disappears without a completion sidecar; valid long-running `active` or `waiting` states do not become `stalled` just because time passes. When a run enters `stalled` or recovers from it, the parent agent receives a steer message so it can react. All other status transitions stay in the widget only.

**Interactive subagents stay silent.** Long-running user-driven subagents (for example, an interactive planning role or a bare `interactive: true` fork) do not wake the parent session on `stalled`/`recovered` transitions — the user is working directly in the subagent's pane, and a steer message there would just burn an orchestrator turn on a no-op "still waiting" ping. The widget still updates normally, and activity snapshots are still recorded/classified regardless of the `interactive` setting. By default, agents with `auto-exit: true` are treated as autonomous and get stall pings; agents without it are treated as interactive and stay quiet. Override per-agent with `interactive: true|false` in frontmatter, or per-spawn with `interactive: true|false` on the tool call.

## Spawning Subagents

Examples that set `agent` assume a role pack or a project/global definition
supplies that role; this package ships none.

```typescript
// Explicit fast-tier runtime for bounded reconnaissance
subagent({ name: "Scout", agent: "scout", model: "<provider>/<fast-tier-id>", thinking: "low", task: "Analyze the codebase..." });

// Force a full-context fork for this spawn
subagent({ name: "Fix", fork: true, model: "<provider>/<mid-tier-id>", thinking: "medium", task: "Fix the bug where..." });

// Explicit frontier-tier runtime for architecture work
subagent({ name: "Planner", agent: "planner", model: "<provider>/<frontier-tier-id>", thinking: "high", task: "Work through the design with me" });

// Explicit mid-tier runtime with a custom working directory
subagent({ name: "Designer", agent: "game-designer", model: "<provider>/<mid-tier-id>", thinking: "medium", cwd: "agents/game-designer", task: "..." });

// Isolated ticket branch in a Herdr-managed Git worktree
subagent({
  name: "Ticket 123",
  agent: "worker",
  model: "<provider>/<mid-tier-id>",
  thinking: "medium",
  worktree: { branch: "ticket/123", base: "main" },
  task: "Implement ticket 123, test it, and commit the result",
});
```

### Parameters

| Parameter              | Type    | Default        | Description                                                                                       |
| ---------------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------- |
| `name`                 | string  | required       | Short stable child label; coordinated groups use `<task>-<role>[-n]` (widget and pane title)      |
| `task`                 | string  | required       | Task prompt for the sub-agent                                                                     |
| `agent`                | string  | —              | Load defaults from agent definition                                                               |
| `fork`                 | boolean | —              | Override the child session mode: `true` forces fork, `false` forces standalone. Omit to inherit the agent `session-mode` frontmatter |
| `persistent`           | boolean | `false`        | Keep one specialist session alive for sequential tasks; follow-ups use `subagent_send` only       |
| `interactive`          | boolean | derived        | Mark this spawn as interactive (don't wake the parent on stall/recovery). Defaults to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit`. |
| `model`                | string  | configured or parent | Exact authenticated `provider/model-id`, ordered fallback list, or whole-value `task:<category>` (coding, review, recon, qa, architecture, docs). Task routing is tool-only; worktrees use its first authenticated candidate. Resolution is tool argument → agent frontmatter → per-agent config → global config → parent |
| `thinking`             | string  | role or parent level | Pick the model tier first, then set thinking within that model's range: minimal/low for bounded mechanical work, medium for ordinary implementation or review, high+ for architecture, security, or hard diagnosis. If omitted, the role's thinking level applies when set, otherwise the parent's. |
| `systemPrompt`         | string  | —              | Role text for a bare spawn, delivered as a role block at the top of the child's first message (not the system prompt); dropped for `fork: true` children. Named agents keep their definition body |
| `skills`               | string  | —              | Comma-separated skill names                                                                       |
| `tools`                | string  | —              | Comma-separated tool names                                                                        |
| `cwd`                  | string  | —              | Working directory, or source repository when `worktree` is set (see [Role Folders](roles.md#role-folders)) |
| `worktree`             | object \| null | —          | Isolated Herdr-managed Git worktree; requires `branch`, with optional `base` (committed `HEAD` by default). Omit or pass `null` to use an ordinary pane in `cwd` when a client requires the property. |

A bare spawn's `systemPrompt` is not passed to Pi as a system prompt. The host
prepends it as a role block to the child's first message, which is delivered
through a task artifact file referenced with `@path`. A full-context fork
(`fork: true`) receives only the raw task, so its `systemPrompt` is dropped. Set
`fork: false` when a bare child must receive reference or role text through
`systemPrompt`.

### Naming coordinated children

Before launching a new group, choose a short task slug and label each new child
`<task>-<role>[-n]`, such as `login-api` or `login-test2`. Roles are `plan`,
`research`, `ui`, `api`, `build`, `test`, `review`, `browser`, `security`,
`perf`, and `merge`. Leave existing labels unchanged. After the final launch,
print `name | agent kind | role | model | worktree` and use each name in
prompts, handoffs, and results.

### Isolated worktree runs

Use one worktree per parallel independent writing task; a single or sequential writer can work in the parent checkout, and read-only agents use ordinary panes. Omit `worktree` for an ordinary pane; clients whose generated tool schema requires every property may send `worktree: null` with the same effect. `cwd` selects the source Git repository, `branch` must be unique, and `base` is resolved to an exact commit before creation. If `cwd` is a linked checkout, Herdr provisioning uses the principal checkout while the requested checkout supplies the base SHA and manifest provenance. A successful launch from that linked checkout does not itself authorize cleanup there: cleanup checks the canonical principal/source repository under the invoking parent session's cwd, not `manifest.sourceCwd` or shared Git identity. If cleanup is needed, start the parent Pi session rooted at the principal checkout or an ancestor containing it, then use the normal explicit cleanup flow; changing directories inside an existing Pi session does not change its session cwd. If `base` is omitted, the source checkout's committed `HEAD` is used. Parent-checkout changes that have not been committed are not copied.

Choose a worktree from the task, not from a role name: the extension emits no
role-specific worktree warnings. Read-only scouting and review normally use an
ordinary pane; to inspect or review an existing worker result, start an ordinary
child in that retained worktree path. Do not infer that a role cannot write
because its `tools` omit `write` or `edit`: a `read,bash` allowlist is not an
enforced read-only boundary because shell commands can mutate files. Report-only
roles must restrict Bash to safe inspection and avoid artifact-generating
verification in the reviewed checkout. Herdr worktree workspaces persist until
explicitly removed.

The child starts at the returned worktree root. Tell writing agents to test and commit when you want a commit-based handoff, and tell them not to push, merge, switch branches, or remove the worktree. The parent owns review and integration.

Successful, failed, and help-requesting worktree runs retain their workspace and root shell. A reviewer's disposable pane can close without closing that root, tab, or checkout. Completion includes the worktree path, Herdr workspace, branch, base/head SHAs, commits ahead, changed and untracked files, and clean/dirty/conflicted state. Here, `clean` means no uncommitted files; the branch may still contain commits. If Git inspection fails, state is reported as unknown rather than guessed.

An ownership manifest is written under the parent session's `artifacts/<session-id>/worktree-runs/` directory before Herdr creates resources. V1 does not automatically recover watchers after a full process restart, and `subagent_resume` does not reattach the managed worktree lifecycle.

The extension does **not** push, create a PR, merge, cherry-pick, or remove the worktree or branch automatically. For task selection, lifecycle states, review commands, failure recovery, and safe cleanup, read [Worktree subagents](worktree-subagents.md). The [research report](research/worktree-subagent-orchestration.md) records the rationale and deferred roadmap.

## Persistent specialists

Set `persistent: true` on a `subagent` launch to create one logical specialist with one v1 session generation. Its resolved tools, denied tools, model, thinking level, and optional worktree binding are snapshotted at launch and do not change when work is sent later. `subagents_list` shows each live specialist's logical ID, generation ID, state, completed-task count, and effective policy.

The initial task and each `subagent_send({ id|name, message })` task are delivered exactly once with a task ID. A specialist accepts one task at a time. Sends while it is working are recorded as `rejected-busy`; no queue is retained. After a task result arrives, it is idle and accepts the next task. A persistent child's `caller_ping` records a help request but keeps the session alive; answer with `subagent_send`.

Use `subagent_stop({ id|name })` to request graceful shutdown. If a task is active, stop becomes `stop-pending` and the task reaches its terminal outcome first. The parent reports `stopped` only after process-exit evidence is confirmed, then closes an ordinary pane it created and releases the name. If confirmation times out, the specialist is `stalled` in an unconfirmed-stop state: `subagent_send` rejects follow-up work while retaining evidence. Request `subagent_stop` again to make another bounded exit check, or spawn a new specialist. A pane or process disappearance without a stop directive produces one facts-only crash notice; persistent sessions cannot be resumed in v1, so spawn a new specialist. There is no automatic restart, replay, or revival.

A persistent specialist with a worktree holds that lease for its entire lifetime. It cannot be re-bound to another checkout. Otherwise it runs in an ordinary pane.

## Interrupting a running subagent

Use `subagent_interrupt` to cancel the active turn of a running Pi-backed subagent:

```typescript
subagent_interrupt({ id: "abcd1234" });
// or
subagent_interrupt({ name: "Scout" });
```

This sends Escape to the child pane, cancelling the in-progress model turn. The subagent session stays alive — the pane, session file, and background polling all remain intact. After the interrupt, the widget immediately labels the child as `interrupted` (counted as **open**, not active processing). Stale pre-interrupt activity snapshots are ignored so a lagging Herdr/`active` reading cannot overwrite the interrupt. The process elapsed timer keeps running because the pane is still open; only the interrupted-state duration freezes relative to the interrupt request. If the child starts work later, newer observations return it to `active`; completion, failure, and `caller_ping` still flow through normally.

`id` and `name` are each optional, but execution requires one usable target: an exact running ID or an exact, unambiguous display name. When both are supplied, `id` is used. Duplicate names are rejected.

This is a turn-level interrupt, not a method for forcibly terminating a subagent session. To end the run, use `subagent_cancel`.

## Cancelling a running subagent

Use `subagent_cancel` to end one ordinary (non-persistent) managed run, including an interrupted one:

```typescript
subagent_cancel({ id: "abcd1234" });
// or
subagent_cancel({ name: "Scout" });
```

Target resolution matches `subagent_interrupt`: an exact running ID or an exact, unambiguous display name. Persistent specialists are rejected; use `subagent_stop`, whose graceful v1 semantics are unchanged.

The cancel intent is recorded before anything is aborted or killed. From then on the run never advances its model shortlist, retries, or recovers, even when terminating the pane makes the watcher observe a lost pane, and even when a fallback launch was already in flight. The result reports one status:

| Status | Meaning |
| --- | --- |
| `confirmed` | Termination is confirmed. One cancelled result is delivered automatically. |
| `requested` | A launch or fallback acquisition is still in flight. Its owner is terminated as soon as it is acquired; no later model is tried. |
| `unconfirmed` | Termination failed (the error is reported). The run stays live, owned, and supervised, and nothing is delivered or cleaned up. Call `subagent_cancel` again to retry. |
| `already-terminal` | The run already took a natural result or was retired; nothing was cancelled. |

Repeated cancels join an in-flight termination and keep the first request time. The parent receives exactly one `subagent_result` whose details carry `error: "cancelled"` and a `cancellation` record (`requestedAt`, `termination`, `confirmedAt`). Its message says the run was cancelled and lists any models already attempted. It is never presented as a provider failure. A child's natural result taken before the cancel stays authoritative. A cancel while a provider error is still eligible for fallback wins and stops that fallback.

Termination follows surface ownership:

- **Ordinary pane:** the pane is closed. Confirmation is Herdr reporting it absent; closing a Herdr pane terminates its terminal session, but this is not a separate OS process check. Other panes, tabs, and user panes are never closed.
- **Managed worktree:** the retained root pane, workspace, checkout, branch, commits, and manifest are kept. At launch, the child records its own process identity (PID, kernel start time, boot ID, and PID namespace) beside its session; the parent accepts it only while that process is alive in the parent's PID namespace as the Herdr pane shell or a descendant of it. SIGTERM goes only to that identity, re-verified immediately before the signal. Confirmation requires that identity to no longer exist, or the pane to be gone while it is not known alive. Command-line text and Herdr's foreground list are never evidence, because Pi rewrites its process title. A live identity (for example a suspended Pi), or one whose SIGTERM fails while it is still alive, leaves termination `unconfirmed` even if the pane is gone. An identity that was not captured (including on non-Linux hosts), is unreadable, or whose PID now names another process is never signalled and leaves termination `unconfirmed` unless pane absence confirms it. Every Herdr query and capture wait is bounded by the cancel's deadline (5 seconds); an answer that arrives after the deadline is ignored, even if it settles before the timer runs, and never changes a reported outcome. A retry re-checks, and if the launch capture expired it captures the identity again within its own deadline. The manifest becomes `cancelled` only after confirmed termination (a parent shutdown while unconfirmed records the plain shutdown state), and the normal worktree handoff is delivered. No Git cleanup is performed. See [Worktree subagents](worktree-subagents.md).

Do not poll after cancelling; the cancelled result arrives as a steer message. Design rationale: [ADR-0014](adr/0014-operator-cancel-terminal-intent.md).

## caller_ping — Child-to-Parent Help Request

The `caller_ping` tool lets a Pi-backed subagent request help from its parent agent. Ordinary children **exit** and the parent can resume them with `subagent_resume`. Persistent specialists record a help-request outcome, stay alive, and accept a reply through `subagent_send`.

**`caller_ping` parameters:**

- `message` (required): What you need help with

**`subagent_resume` parameters (Pi-backed sessions):**

- `sessionPath` (required): Path to the child session `.jsonl` file
- `name` (optional): Display name for the resumed pane (defaults to `Resume`)
- `message` (optional): Follow-up prompt to send after resuming
- `autoExit` (optional): Whether the resumed session should auto-exit after its next response fully settles. Defaults to `true` for autonomous follow-up work; set `false` when resuming for an interactive handoff.

Each public child stores a session-adjacent versioned launch-policy sidecar. Public resume restores its resolved tool allowlist and denied subagent tools rather than looking up the current role, so later role changes cannot widen a child. An intentionally unrestricted launch remains unrestricted (no `--tools` argument); a restricted launch restores its exact allowlist. The `autoExit` override still controls whether `subagent_done` is available, while `caller_ping` remains available. Missing, malformed, or unsupported policy fails closed before a pane is created with recovery guidance. Public resume rejects managed-worktree child sessions; use their retained workspace instead. Unknown policy owners, including legacy workflow sidecars, fail closed.

**Interaction flow:**

1. Child calls `caller_ping({ message: "Not sure which schema to use" })`
2. Ordinary child sessions exit (like `subagent_done`); persistent specialists stay alive.
3. Parent receives a steer notification: *"Sub-agent Worker needs help: Not sure which schema to use"*
4. The parent resumes an ordinary child with `subagent_resume`, or replies to a persistent specialist with `subagent_send`.
5. The child picks up with the parent's guidance

**Example:**

```typescript
// Inside a worker subagent
await caller_ping({
  message: "Found two conflicting migration files — should I use v1 or v2?"
});
// Session exits here. Parent receives the ping, then resumes this session
// with guidance like "Use v2, v1 is deprecated"
```

> **Note:** `caller_ping` is only available inside Pi-backed subagent contexts. Calling it from a standalone Pi session returns an error. For a worktree child, the help handoff retains the workspace, but `subagent_resume` does not reattach worktree tracking; continue the work in the retained workspace.

## Child-context hint (`PI_SUBAGENT_ID`)

Every fresh or resumed child launched by this extension, including `fork: true`
children and persistent specialists, runs with `PI_SUBAGENT_ID` set to its run
ID. The extension uses it to register the child protocol tools and to omit
parent-only surfaces (`worktree_list`, `worktree_remove`,
`subagents_write_task_models`, and `/subagents-init`). A `/worktree <name>`
handoff starts an ordinary interactive Pi session and does not set it. Pi's own
`/fork` and `/clone` run in the same process and keep that process's
environment: the variable is absent in a top-level session and still present
inside a child.

Role packs may read `PI_SUBAGENT_ID` as a context hint, for example to avoid
restoring parent-only session state inside a delegated child. It is not an
authentication or security boundary: any process can set it, and shell commands
and nested processes a child runs inherit it, including a `pi` process started
from the child's Bash tool. Do not grant or deny privileges based on it. There
is no other parent/child protocol.

## The `/worktree` Workflow

`/worktree <worktree> [task]` creates a Herdr-managed worktree from the current committed branch and launches a new interactive Pi session there with the active conversation branch. The original session remains available. Use `/worktree list` or `worktree_list({})` to inspect managed worktrees, including cross-session orphans, whose canonical source repositories are inside the session's cwd subtree. This is a new-process handoff, not an in-place move of the existing shell or Pi process.

The destination workspace is focused only after Pi startup is confirmed. Every fresh launch, including the handoff, sets `PI_HERDR_AGENTS_SESSION` to its session file; confirmation requires a Pi process in the root pane with the worktree cwd whose launch-time environment carries that value. Pi rewrites its process title, so command-line text is never evidence. Nothing inside Pi reads the variable, and it is not a child-context hint. Confirmation reads Linux `/proc`; see [Worktree subagents](worktree-subagents.md).

### Explicit worktree cleanup

Parent sessions can call `worktree_remove({ target: "<path|branch|workspace-id>", preserve: true })` or `/worktree remove <target> [--preserve]`. Preservation is optional and never implied: dirty work is blocked unless explicitly committed first or preserved as a WIP commit. The result reports its SHA even if removal later fails or is refused. A failed preservation commit restores the pre-preservation index and never proceeds to removal. Inventory and removal reports disclose exact ignored-file counts: enumeration is streamed rather than buffered as one listing. Ignored files do not block cleanup and are not captured by preservation; failed counting still blocks removal.

Eligibility is rechecked at removal time: canonical source-repository cwd containment, registered linked checkout, no detected process holder, known live child, or persistent lease, and clean Git state with no untracked files or conflicts. A successful launch from a linked checkout does not itself authorize its removal; cleanup uses the canonical principal/source repository under the invoking parent session's cwd, not `manifest.sourceCwd` or shared Git identity. Start the parent Pi session rooted at that principal checkout or an ancestor containing it, then use normal explicit cleanup; `cd` inside an existing Pi session does not change the session cwd. A source repository that is a Git submodule is located through the `core.worktree` setting of its shared Git directory under the superproject's `.git/modules`, not through that directory's parent. Unknown inspection, identity disagreements, detached HEAD, locked checkouts, and initialized submodules block removal. Out-of-scope repositories are never eligible. Open worktree workspaces use Herdr removal. The source repository's primary workspace is never closed automatically. If this process recorded that worktree creation appeared to open it and a read taken just before the report still shows it untouched, removal adds `wX appears to have been opened by worktree creation; if you haven't used it, close it with herdr workspace close wX`; a missing or wrong-typed field, another open workspace for the repository, another session, or a restarted process reports nothing. Orphans use Git removal and registration pruning after checkout absence is verified. Owned reachable manifests are marked `removed`; manifests from other sessions are not required or rewritten. Stale removed manifests never govern a recreated checkout. Missing or dangling manifest paths do not affect unrelated checkouts; undecidable or conflicting manifest identity still blocks removal. A failed manifest update after removal is reported as a warning. Symlinked ancestors are supported; checkout symlinks escaping the canonical managed root are blocked. Process inspection covers observable same-user processes across sessions, regardless of runtime name, exempting only Herdr-confirmed idle retained shells, never runtimes at the same PID. Unreadable individual process details produce non-blocking warnings without an override flag; scanning continues so another observable holder still blocks removal. Human and structured inventory/removal results disclose incomplete coverage, including warnings seen before a later recheck or failure. Same-user inspection is permission-limited, and other-user processes are not inspected: a protected process could hold the checkout undetected. Warnings aggregate counts and bounded PID samples, not commands or environments. Linux uses `/proc`; macOS uses same-user `lsof` cwd records and warns for unreadable individual records. Unsupported platforms, failed global enumeration (including a failed `lsof` with partial output), and other unverifiable eligibility evidence still block removal. Cleanup Git and Herdr calls have 30-second timeouts.

A worktree launch may add three synchronous Herdr snapshots (`worktree list` before create, `worktree list` after create, and `pane list` for the opened primary), each bounded at 3 seconds, 9 seconds if all three run to their timeouts. A failed snapshot claims nothing and is returned as a launch diagnostic, shown in the `subagent` acknowledgement and the `/worktree` notice; it is not written to the console. Claims are kept only in this process and are not written to the manifest. Ordinary non-worktree launches add no Herdr calls. Explicit removal adds a primary-workspace report only when this process holds a claim for the removed source repository: `worktree list`, `workspace get`, and `pane list`, each asynchronous and bounded at 3 seconds, taken after the checkout is removed. That is at most three calls and 9 seconds of wall time, without blocking the event loop. These report calls sit on top of the existing cleanup Git and Herdr calls, which stay at 30 seconds each.

Cleanup never deletes or rewrites branches, uses force flags, or runs automatically. It never closes the source repository's primary workspace. Session startup does not scan worktree inventory, avoiding blocking Pi initialization; use `/worktree list` or `worktree_list` for an explicit inventory. Child sessions retain `/worktree list` and `/worktree <name>`, but receive neither cleanup tools nor the remove subcommand. Their repository-local listing labels detached entries `(detached HEAD)`; a detached sibling does not prevent inspection of named branches. See [cleanup and recovery](worktree-subagents.md#cleanup) for details.

## Tools Widget

Every sub-agent session displays a compact one-line tools widget summarizing available and denied tools:

```
[scout] — 12 tools · 4 denied
```
