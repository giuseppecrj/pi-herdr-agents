# Pi Herdr Agents

[![npm version](https://img.shields.io/npm/v/pi-herdr-agents)](https://www.npmjs.com/package/pi-herdr-agents)
[![CI](https://github.com/giuseppecrj/pi-herdr-agents/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/giuseppecrj/pi-herdr-agents/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

![Pi Herdr Agents: a parent Pi session delegating to parallel child agents in dedicated Herdr panes, an isolated worktree and a retained session, with a live status widget.](https://raw.githubusercontent.com/giuseppecrj/pi-herdr-agents/main/docs/assets/pi-herdr-agents-gallery.png)

> **Agents:** the tool list is in [What's Included](#whats-included) and the operating guide is [`skills/pi-herdr-agents/SKILL.md`](skills/pi-herdr-agents/SKILL.md). Contributors: read [`AGENTS.md`](AGENTS.md).

Asynchronous subagents for [Pi](https://github.com/earendil-works/pi), running exclusively in [Herdr](https://herdr.dev).

Delegate investigation, implementation, and review without blocking the parent session. Each child runs as a real Pi process in its own Herdr surface; results return automatically when the child finishes.

## Features

- **Non-blocking delegation** — `subagent` acknowledges launch immediately while the parent keeps working.
- **Parallel execution** — run independent scouts, workers, and reviewers at the same time.
- **Live supervision** — track process and turn state in Pi's subagent widget; interrupt one child turn without destroying its session.
- **Managed worktrees** — isolate writing agents in retained Herdr workspaces with explicit Git ownership and recovery details.
- **Conversation handoff** — continue the active Pi conversation in a new worktree with `/worktree` while preserving the parent session.
- **Pack-neutral roles** — use project or global definitions and installable role packs; this package ships no default roles or workflows.
- **Persistent specialists** — retain one policy-bound Pi session for sequential, turn-based tasks.
- **Optional sidebar focus** — the companion [Pi Herdr Agents Sidebar](plugins/sidebar/README.md) Herdr plugin hides marked delegated children from Herdr's Agents view while you run Focus. Markers are display-only and follow the pane, so see its [limits](plugins/sidebar/README.md#reusing-a-delegated-pane).

## Requirements

- [Pi](https://github.com/earendil-works/pi) with package support
- [Herdr](https://herdr.dev) and its CLI
- `HERDR_ENV=1` — start Pi from inside Herdr

Other terminal multiplexers are not supported. Session startup skips worktree inventory to avoid blocking Pi initialization; use `/worktree list` or `worktree_list` to inspect managed worktrees. Outside Herdr, explicit inventory tools still report unavailable inspection as unknown. Worktrees isolate Git checkouts, not processes or permissions; child agents and installed Pi packages run with your user account's access.

## Install

Install from npm:

```bash
pi install npm:pi-herdr-agents
```

Install project-locally or try it for one run:

```bash
pi install -l npm:pi-herdr-agents
pi -e npm:pi-herdr-agents
```

Then start Pi inside Herdr:

```bash
herdr
pi
```

Restart or `/reload` Pi after installation. Review package source before installing any Pi package.

> **Upgrading from 2.x?** Bundled roles and several commands moved out. See [3.0.0 release notes](#300).

## Contents

- [Requirements](#requirements), [Install](#install), [Safety and uninstall](#safety-and-uninstall)
- [Quick start](#quick-start), [Release notes](#release-notes), [How it works](#how-it-works)
- [What's Included](#whats-included): tools, commands, the operating skill, role packs
- [Async Subagent Flow](#async-subagent-flow): status, configuration, model routing, [sidebar markers](#sidebar-markers)
- [Spawning Subagents](#spawning-subagents), [Persistent specialists](#persistent-specialists), [Interrupting](#interrupting-a-running-subagent), [Cancelling](#cancelling-a-running-subagent)
- [The `/worktree` Workflow](#the-worktree-workflow), [Custom Agents](#custom-agents), [Tool Access Control](#tool-access-control)
- [Development](#development), [License](#license)

## Safety and uninstall

- Child agents are real Pi processes running with your user account's permissions, inside Herdr panes. Worktrees isolate Git checkouts, not processes or permissions.
- The extension creates Herdr panes, tabs and managed worktrees only when a launch asks for them. It never pushes, merges, opens pull requests, deletes branches or removes worktrees on its own; cleanup is an explicit parent action ([worktree cleanup](#explicit-worktree-cleanup)).
- What it writes: `$PI_CODING_AGENT_DIR/herdr-agents/config.json` (only through `/subagents-init` or the writer tool, never on startup); per-launch artifacts under the parent session's `artifacts/<session-id>/` directory beside Pi's session store, which hold the child's full task text and any `systemPrompt` as Markdown files, activity snapshots and worktree manifests; and the child's own Pi session file. A managed worktree that carries its own `.pi/agent` directory receives that child's session inside the checkout. Treat task text as potentially sensitive when you share or inspect those files.
- Managed worktree children record their PID, process start time, boot ID, and PID namespace in `<session>.process.json` beside their session. With [`sidebar.enabled`](#sidebar-markers), every other child records the same facts, and a resumed child records them under `artifacts/<session-id>/process-identity/`. The parent then reports one display-only pane token, `piha_delegated_v1`, on each child's pane through the Herdr socket. With the setting off, the extension writes no pane metadata.
- To uninstall: first list and remove any retained worktrees while the extension is still loaded (`/worktree list`, then `/worktree remove <target>`), because those commands leave with the package. If you installed the optional sidebar plugin, remove it with `herdr plugin uninstall pi-herdr-agents.sidebar` (or `herdr plugin unlink` for a linked copy). Then run `pi remove npm:pi-herdr-agents`, and delete `$PI_CODING_AGENT_DIR/herdr-agents/` and the `artifacts/` directories above if you no longer want the configuration and launch records.

## Quick start

This package is an execution host and ships no agent roles. Named roles come
from your project or global definitions or from an installed
[role pack](#publish-a-role-pack). The `scout` examples below assume one of
those provides `scout`; see [Migrating from bundled roles](#migrating-from-bundled-roles).
A bare launch without `agent` needs no role.

Ask Pi to delegate naturally:

```text
Use two scouts in parallel to map the authentication flow, then summarize their findings.
```

Or launch a named role directly:

```text
/subagent scout Analyze the authentication module and report relevant files and risks
```

For an isolated writing task:

```text
/worktree auth-fix Implement the approved authentication fix and run the focused tests
```

Pi can also call the tool directly:

```typescript
subagent({ name: "Auth scout", agent: "scout", model: "<provider>/<fast-tier-id>", thinking: "low", task: "Map the authentication flow" });
subagent({ name: "DB scout", agent: "scout", model: "<provider>/<fast-tier-id>", thinking: "low", task: "Map the session schema" });
// A bare launch needs no installed role.
subagent({ name: "Auth summary", model: "<provider>/<fast-tier-id>", thinking: "low", task: "Summarize the authentication flow" });
// All return immediately; each result comes back independently.
```

Use ordinary panes for read-only agents. A single or sequential writer can work in the parent checkout; give each parallel independent writing agent a unique managed worktree. The parent acts as coordinator: decompose work, give each child one bounded outcome with its goal, allowed files, verification, and commit instruction, and keep dependent writes sequential. Children are leaves by default; the parent owns integration and final verification. See [Worktree subagents](docs/worktree-subagents.md).

## Release notes

[`CHANGELOG.md`](CHANGELOG.md) is generated from Git history on each release.
Hand-written upgrade notes for breaking releases live here.

### 3.0.0

3.0.0 makes the host pack-neutral. It also adds conditional task-model writes
(`expectedConfigRevision`, an advisory lock, and the reported `configRevision`),
the `pi-herdr-agents` operating skill, and `subagent_cancel`.

**Breaking changes.** The package no longer ships the seven former bundled roles,
`/plan` and its plan skill, or `/skill:orchestrate`; these moved to optional role
packs. `/iterate`, `/btw`, and `/btw-close` were removed without replacement.
`roles.bundled` is now a deprecated no-op. A named launch of a role that no
definition or installed pack supplies now fails before Herdr creates a pane or
worktree.

**Migration.**

- Install `pi-herdr-roles` for the six generic roles (`scout`, `planner`,
  `worker`, `reviewer`, `adversarial-reviewer`, `visual-tester`), `/plan`, and
  `/skill:orchestrate`.
- Install `pi-herdr-pstack` for the `poteto-mode` methodology skill and command.
  It ships no named roles; its delegates are bare.
- Remove `roles.bundled` from `$PI_CODING_AGENT_DIR/herdr-agents/config.json`.
- Alternatively, copy a former role's definition into `.pi/agents/` or the
  global agents directory to keep it without a pack.

See [Migrating from bundled roles](#migrating-from-bundled-roles) for the full
mapping and pack-compatibility notes.

## How it works

![Pi Herdr Agents lifecycle: spawn a child, run it in Herdr, supervise live state, and deliver one bounded result to the parent.](https://raw.githubusercontent.com/giuseppecrj/pi-herdr-agents/main/docs/assets/async-subagent-lifecycle.png)

A `subagent` call selects the target checkout, reuses its Herdr workspace, and gives the child a pane in an extension-owned `Agents` tab. Four panes fit in each tab by default; overflow opens another tab in the same workspace. A worktree is created only when explicitly requested for checkout isolation. The call launches a child Pi session and returns `started`. The parent watcher combines Herdr process state with child activity details and projects the result into a live widget:

```text
╭─ Subagents ──────────────────── 1 active · 1 open ─╮
│ 00:23  Scout: Auth (scout)        active · read 7m │
│ 00:45  Reviewer (reviewer)              waiting 2m │
╰────────────────────────────────────────────────────╯
```

When the child completes, the parent receives one bounded `subagent_result` message and starts a new turn with that result in context. Disposable ordinary panes close after result delivery; Herdr removes a tab when its last pane closes. Persistent specialists keep their pane between tasks, and managed worktree roots return to retained interactive shells. Callers never need to poll, tail session files, or wait in a shell loop.

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

Subagent tabs, panes, and worktree workspaces are created without stealing keyboard focus. Launch commands target child panes by explicit ID, so focus and command delivery are independent. If a fresh or resumed launch fails, the extension closes the ordinary pane that it created and preserves the original launch error. It does not close a caller-supplied surface, and managed worktree workspaces remain retained on failure. Note: the `interactive` option controls parent status notifications, not terminal focus.

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
| `pi-herdr-agents` | Operating guide for this host: launching, supervising, interrupting, cancelling and resuming children, worktrees, persistent specialists, model routing and configuration. Loaded by agents on demand; see `skills/pi-herdr-agents/SKILL.md` |

| Pi child-only tool | Description |
| ---------------- | ------------------------------------------------------------------------- |
| `caller_ping` | Ask the parent for help; ordinary children exit, persistent specialists stay alive |
| `subagent_done` | Mark an interactive child complete and exit; autonomous agents auto-exit |

| Command                    | Description                          |
| -------------------------- | ------------------------------------ |
| `/worktree <name> [task]`  | Continue this session in a new managed worktree (`/worktree list` lists them) |
| `/subagent <agent> <task>` | Spawn a named agent directly (`/subagent list` lists available agents) |
| `/subagents-init [preferences]` | Draft task-category model preferences from the live authenticated registry, with optional ranking preferences; a loaded approval extension can own the write |

### Taxonomy and discovery

This package distinguishes directly runnable **agent roles**, Pi-native
**skills**, and authenticated Pi **runtimes**. A multi-stage user outcome may
be a command or skill that composes roles; it is not itself an agent role.

The host's own orchestration surfaces are:

| Surface | Entry point | Behavior |
| --- | --- | --- |
| Delegation | `subagent`, `/subagent <agent> <task>` | Launches one bare or named child; results return automatically. |
| Worktree handoff | `/worktree <name> [task]`, `/worktree list` | Forks the active conversation into a managed worktree. |

Planning, review, and other multi-stage workflows belong to role packs and
skills, not to this package. See
[ADR-0002](docs/adr/0002-agent-workflow-skill-runtime-taxonomy.md),
[ADR-0009](docs/adr/0009-remove-workflow-subsystem.md), and
[ADR-0013](docs/adr/0013-pack-neutral-execution-host.md).

### Roles and role packs

This package is a pack-neutral execution host: it ships no agent roles, no
`/plan` command, and no planning or review skills. Its one skill,
`pi-herdr-agents`, is a general operating guide for the host. A named launch resolves
`agent` from project definitions, global definitions, and roles registered by
installed role packs, in that precedence order (see below). An empty catalog is
valid. A bare launch without `agent` always works. An explicitly named role that
is missing or invalid fails before Herdr creates a pane or worktree; it is never
silently replaced by a bare agent.

All subagents execute through Pi. Claude models remain available through normal
Pi provider/model routing. Legacy role definitions that contain `cli` fail before
Herdr creates a pane or worktree; remove `cli` and `cli-model`, then select an
authenticated Pi `provider/model-id`.

Role packs own their roles' prerequisites, such as a required skill, and must
document them. This package does not install role packs or prerequisites.

### Migrating from bundled roles

Earlier versions bundled seven roles and two workflows. They have moved to
separately installed packs or have been removed. Nothing is installed
automatically, and your global and project role files and `config.json` are not
modified.

| Former bundled surface | Status | Destination |
| --- | --- | --- |
| `scout`, `planner`, `worker`, `reviewer`, `adversarial-reviewer`, `visual-tester` roles | Moved | `pi-herdr-roles` role pack |
| `/plan` command and its plan skill | Moved | `pi-herdr-roles` |
| `/skill:orchestrate` and its adversarial-review resources | Moved | `pi-herdr-roles` |
| `poteto` role | Removed; replaced by the `poteto-mode` skill and `/poteto-mode` command | `pi-herdr-pstack` |
| `/iterate` | Removed, not relocated | Call `subagent({ name, task, fork: true, interactive: true })` directly |
| `/btw`, `/btw-close` | Removed, not relocated | None |
| `roles.bundled` setting | Deprecated no-op | Remove it from `config.json` |

Both destination packs are experimental, unpublished candidates; their install
sources and compatible host versions are not final. Install a role pack with
`pi install` like any Pi package and enable it beside this extension; a role pack
stays inert without it. Older versions of this package that still bundle these
roles, `/plan`, or `orchestrate` collide with the replacement packs: a bundled
role rejects a same-named pack role, and Pi resolves duplicate commands and
skills by discovery order. Setting `roles.bundled: false` on an older host only
removes its roles, not its command or skill. Upgrade the host instead of
combining an older host with the replacement packs.

Existing `models.agents` preferences keyed by role name keep applying when a
pack or definition supplies that name. To keep a former role without installing
a pack, copy its definition into `.pi/agents/` or the global agents directory.

Roles use model defaults from `config.json` when configured; otherwise
they inherit the parent model. Thinking defaults still come from agent
frontmatter or the parent level. This resolution chain remains available as a
fallback, but orchestrators should explicitly set each child's exact
authenticated `provider/model-id` and supported thinking level. Select the
model tier first: fast for bounded mechanical work and recon, mid for ordinary
implementation or review, and frontier for architecture, security, hard
diagnosis, or adversarial review. Then select thinking within that model's
supported range. Cross-family independent review requires a reviewer from a
different model family than the author. For ordinary review, prefer a different
authenticated model family. When no other authenticated model family is
available, ordinary review may use a same-family reviewer in a fresh standalone
session. Disclose that this review is context-isolated, not cross-family
independent. Cross-family verification must not use this fallback. A stronger
model in the same family is a quality escalation, not cross-family
independent review. Family is the independence boundary; project policy may
separately require a different provider.

Discovery loads definitions in **package → global → project** order, so effective
priority remains **project** (`.pi/agents/`) > **global**
(`$PI_CODING_AGENT_DIR/agents/`, defaulting to `~/.pi/agent/agents/`) >
**package**. Package definitions are the roles contributed by installed Pi role
packs; there is no bundled layer. Both `subagents_list` and `/subagent list` show each
visible definition's source; contributed roles include their package identity,
for example `(package:@acme/security-roles)`. A hidden higher-priority definition
still suppresses a visible lower-priority definition.

Custom roles and installable role packs are the package's main extension points.
See [Custom Agents](#custom-agents) for the complete create, package, verify, and
launch workflow.

---

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
- `running` — fallback when only coarse process presence is known (e.g. non-Pi backends)
- `finalizing` — completion was observed and delivery is in progress; the process elapsed timer freezes here
- `cancelling…` / `cancel unconfirmed` — a `subagent_cancel` is terminating the run, or its termination could not be confirmed and the run stays live

The widget header counts **active** vs **open**:

- **active** — `active`, `starting`, `running`, or `blocked`
- **open** — everything else still tracked (`waiting`, `interrupted`, `stalled`, `finalizing`, …)

When `activeCount === 0` (every tracked row is open), the border uses an amber accent. Process elapsed time (`MM:SS` on the left) freezes when the process reaches finalizing/completed/failed. Interrupt does **not** freeze that process clock; the interrupted state shows its own duration on the right while the process remains open.

A fixed internal watchdog marks a run as `stalled` when pane inspection fails or the pane disappears without a completion sidecar; valid long-running `active` or `waiting` states do not become `stalled` just because time passes. When a run enters `stalled` or recovers from it, the parent agent receives a steer message so it can react. All other status transitions stay in the widget only.

**Interactive subagents stay silent.** Long-running user-driven subagents (for example, an interactive planning role or a bare `interactive: true` fork) do not wake the parent session on `stalled`/`recovered` transitions — the user is working directly in the subagent's pane, and a steer message there would just burn an orchestrator turn on a no-op "still waiting" ping. The widget still updates normally, and activity snapshots are still recorded/classified regardless of the `interactive` setting. By default, agents with `auto-exit: true` are treated as autonomous and get stall pings; agents without it are treated as interactive and stay quiet. Override per-agent with `interactive: true|false` in frontmatter, or per-spawn with `interactive: true|false` on the tool call.

#### Configuration

The durable user configuration is `$PI_CODING_AGENT_DIR/herdr-agents/config.json`,
defaulting to `~/.pi/agent/herdr-agents/config.json`. It is not read from the
installed package root, so npm and git package upgrades do not overwrite it.
Create it by copying the installed package's `config.json.example`, or run
`/subagents-init` to seed and draft model task preferences. This is a breaking
migration: manually move an existing package-local `config.json` to this path,
or re-run `/subagents-init`.

```json
{
  "status": {
    "enabled": true
  },
  "models": {
    "agents": {}
  },
  "persistent": {
    "maxAgents": 3
  },
  "supervision": {
    "forcePolling": false,
    "hangWarningMinutes": 15
  },
  "panes": {
    "mode": "grouped",
    "direction": "right",
    "maxPerTab": 4
  }
}
```

If `config.json` is absent, status, role, pane, and persistent-specialist settings fall back to `config.json.example`.
Model routing does not read the example: no model overrides apply until a real
`config.json` exists.

The copyable example is model-neutral, so it works without requiring credentials
for a specific provider. To configure models, replace the empty section with
exact IDs from your authenticated model catalog:

```json
{
  "models": {
    "default": "your-provider/your-default-model",
    "agents": {
      "scout": "your-provider/your-fast-model",
      "reviewer": "your-provider/your-review-model"
    },
    "tasks": {
      "coding": ["your-provider/your-coding-model"],
      "review": ["your-provider/your-review-model"],
      "recon": ["your-provider/your-fast-model"],
      "qa": ["your-provider/your-qa-model"],
      "architecture": ["your-provider/your-architecture-model"],
      "docs": ["your-provider/your-docs-model"]
    },
    "tasksMeta": {
      "generatedAt": "2026-09-17T00:00:00Z",
      "method": "research"
    }
  }
}
```

`models.tasks` candidates are ordered exact authenticated IDs. Use
`task:<category>` only in the `subagent` tool's `model` argument; it is not
valid in frontmatter or model defaults. Cross-family independent review requires
a reviewer from a different model family than the author. For ordinary review,
prefer a different authenticated model family. When no other authenticated
model family is available, ordinary review may use a same-family reviewer in a
fresh standalone session. Disclose that this review is context-isolated, not
cross-family independent. Cross-family verification must not use this fallback.
Use an exact authenticated
shortlist `provider/model-id` when the
authoring family is known; `task:review` does not establish independence. Family
is the independence boundary; project policy may separately require a different
provider. This is guidance, not extension enforcement.

Run `/subagents-init [preferences]` to draft task-model preferences. For example:

```text
/subagents-init Prefer capability over price for implementation; keep recon inexpensive
```

The command supplies a sanitized snapshot of **all available models from the
active session registry**, including extension-registered providers, exact IDs,
display names, reported base token costs, context/output limits, input
modalities, reasoning, and supported thinking levels. Safe extension-registration and auth-source
metadata is included when Pi exposes it; credentials, endpoints, and raw auth
labels are not. Configured authentication does not prove account access or a
successful request. Missing costs remain unknown; reported zero does not mean
free, and OAuth does not establish subscription billing. The brief uses compact
JSON without truncating models and reports its model count and JSON character
count (not a token estimate); large catalogs still consume context. This is the
current synchronous snapshot: a dynamic provider whose initial catalog refresh
has not completed might be absent. Init does not refresh providers or probe the
network for availability. The brief also includes `configRevision`, the
revision of the exact config bytes that supplied the saved preferences. Init
does not start while a turn runs or messages are queued, and an empty registry
ends with a notice instead of a prompt. Neither case writes anything.

The draft considers current saved task, default, and per-agent preferences.
Optional command arguments set ranking preferences. Otherwise it favors
capability for substantive work and efficiency for bounded reconnaissance and
test execution. Categories describe work, not complexity tiers:

| Category | Work |
| --- | --- |
| `coding` | Implementation workers |
| `review` | Code reviewers |
| `recon` | Reconnaissance scouts |
| `qa` | Software and test runners |
| `architecture` | Planning and diagnosis |
| `docs` | Documentation workers |

Init asks the agent to research major candidates across providers using primary
sources, disclose uncertainty and notable exclusions, and avoid duplicate
upstream models across routes unless deliberate redundancy is explained. Display
names help identify candidates but, like aliases, do not prove upstream
equivalence; research is still required. Price or context size alone is not
quality evidence. No live model probes run.

The proposal carries a ranking `basis`. It is `{"kind":"registry-only"}` when
search is unavailable or yields no usable evidence. It is `{"kind":"research"}`
only with the http(s) `sources` consulted in this run, the `influence` each had
on the ranking, and the remaining `uncertainty`. Code checks the basis's shape,
not whether a source was read, so the basis is labeled as submitted and
unverified.

While init runs, it emits `pi-herdr-subagents:task-models:init:approval:v1`.
With no offer, the prompt directs the model to `subagents_write_task_models`
with `expectedConfigRevision`. When exactly one loaded extension offers, init
opens that extension's flow, and the extension's instructions replace the
writer instruction; the extension then owns approval and the write. Two or more
offers, or an invalid one, stop init before any extension opens or a prompt is
sent. Once an offer is recorded, a refusal or failure also stops init: it never
falls back to the direct writer. See [Task-model init events](#task-model-init-events).

The writer validates and atomically replaces `models.tasks` and `tasksMeta`,
preserving unrelated settings. Its tool schema accepts partial nonempty
categories (omitted categories are removed), rejects empty `tasks: {}` input,
and rejects exact duplicate refs within a category after trimming;
IDs remain case-sensitive. Its result includes normalized saved `tasks`,
`tasksMeta`, `configPath`, `missingCategories`, and `configRevision`. Init requests all six categories
and a before/after table based on that saved result, not the unsaved draft, and
must explain missing categories or changed choices.

Optional `basis` must have the same kind as `tasksMeta.method`. A research basis
needs at least one source with an http(s) URL that has a host and a nonblank
`influence`, plus a nonblank `uncertainty`. The writer validates it before
writing, returns it in the result, and never saves it; only `tasksMeta.method`
persists. Calls without `basis`, including research calls, keep the earlier
contract.

Optional `expectedConfigRevision` makes a write conditional on the config the
proposal was read from. A revision is `sha256:` followed by 64 lowercase hex
digits of the SHA-256 of the exact `config.json` bytes (not normalized JSON or
only `models.tasks`), or the literal `missing` when the file is absent. Any byte
change, including whitespace or unrelated settings, makes the revision stale; a
`missing` revision rejects a file that now exists, and an existing revision
rejects a file that was removed. A stale revision fails with `Stale task model
config revision` without replacing configuration: re-read, re-propose, and
re-approve rather than retrying. Malformed revisions, including `null` and empty
strings, fail closed. Omitting the field keeps the unconditional write. A write
to a missing file still seeds from the packaged `config.json.example`.
`configRevision` is the revision of the exact bytes written and can serve as the
next precondition.

Every writer call, conditional or not, holds an exclusive `config.json.lock`
sibling while it reads one snapshot, checks the revision, and atomically renames
a private temporary file into place. A held lock fails immediately with `Task
model config writer busy`; there are no waits or retries. The lock is never
broken automatically: after a crash, the error names the recorded owner and
reports when that process is no longer running, and you remove the lock only
after confirming that no writer is active. Each call removes only its own lock
and temporary file. This lock is advisory: it serializes cooperating writers
but cannot constrain a text editor or another process that ignores it. The
revision check detects changes made before the snapshot is read; it is not a
filesystem transaction against arbitrary external writers.

`task:<category>` values select subagent models; they are not slash commands and
do not change the parent model. Ordered authenticated candidate plans resolve
before launch. Ordinary nonpersistent runs can retry later candidates after
launch failure or after a running child settles with a provider/agent error,
not after a completed negative task result. Persistent specialists do not
advance after a running-child error. This is not per-step routing; worktrees
use the first authenticated candidate only, without fallback retries.
Shortlists do not enforce reviewer independence. Cross-family independent
review requires a reviewer from a different model family than the author. For
ordinary review, prefer a different authenticated model family. When no other
authenticated model family is available, ordinary review may use a same-family
reviewer in a fresh standalone session. Disclose that this review is
context-isolated, not cross-family independent. Cross-family verification
must not use this fallback. Another route to the same family is not
independent review. Family is the independence boundary; project policy may
separately require a different provider. Run `/reload` (or start a new session)
after writing preferences.

Set `persistent.maxAgents` to the maximum concurrently retained persistent specialists. It defaults to `3`; a persistent spawn at the cap is rejected before Herdr creates a pane or workspace, and no specialist is evicted.

`roles.bundled` is deprecated and has no effect because this package ships no
roles. Existing `true` and `false` values are accepted so that current
configuration keeps loading; a parent session reports one warning per extension
load naming the file and asking you to remove the key. The extension never
rewrites the file. Other values remain configuration errors, as do unknown keys
under `roles`. Registered role packs are the entire package layer, and global and
project definitions keep their precedence over them.

### Task-model init events

Two versioned `pi.events` channels let another extension take part in
`/subagents-init` without importing this package. Both carry the invoking
command's live `ExtensionCommandContext`, so they are for trusted extensions in
the same process. The context is current only while the event is emitted.

The host emits `pi-herdr-subagents:task-models:init:approval:v1` while init
runs:

```typescript
type ApprovalRequest = {
  apiVersion: 1;
  brief: TaskModelBrief; // frozen: operatorPreferences, categories, configRevision, current, models (never empty)
  context: ExtensionCommandContext;
  offer(offer: { owner: string; open(): OpenResult }): "recorded" | "closed";
};
type OpenResult =
  | {
      kind: "ready";
      destination: { toolName: string; instructions: string };
      cancel(): void; // closes the flow this open created
    }
  | { kind: "blocked"; reason: string };
```

- Call `offer` synchronously, before the listener's first `await`. After `emit`
  returns, `offer` answers `"closed"` and records nothing.
- Offer whenever your extension owns task-model approval, even when it is busy,
  and refuse from `open`. `owner` is one printable token without spaces.
- The host opens nothing until collection ends. Two offers (even with the same
  owner) or an invalid offer stop init. With one offer, the host calls `open()`
  once, and it must return synchronously.
- `ready` must leave `toolName` active. Its `instructions` replace the host's
  writer instruction in the prompt the host sends.
- `ready` must include `cancel`. When the host does not hand the prompt to Pi
  (the tool is inactive, or `pi.sendUserMessage` throws), it calls `cancel()`
  once before reporting `not-started`. `cancel` must close only the flow that
  this `open` created, never a later one. A `cancel` that throws is reported
  with the outcome.
- A throw, a promise, an invalid result (including a missing `cancel`), or
  `blocked` stops init with a notice and no prompt. The host cannot undo what
  `open` changed before failing.
- Pi accepts the prompt asynchronously. It can still reject it after `start`
  reports `started`, for example when the selected model has no configured
  auth; the host refuses up front only when no model is selected. Pi delivers
  the prompt to `input` handlers (source `"extension"`) before that check and
  emits `before_agent_start` and `agent_start` only after it passes. An
  extension whose flow outlives one prompt should close it when other input or
  a run arrives before those events, so a later request cannot inherit it.
- Pi's event bus logs and swallows listener exceptions. A listener that throws
  before offering looks the same as no listener, so init uses the direct
  writer. An extension that guards the writer still refuses that write.

Another extension's command emits `pi-herdr-subagents:task-models:init:start:v1`
to start the same init:

```typescript
type StartRequest = {
  apiVersion: 1;
  context: ExtensionCommandContext;
  preferences: string; // ranking preferences, passed through as typed
  offer(offer: { owner: string; start(): InitOutcome }): "recorded" | "closed";
};
type InitOutcome =
  | { kind: "started"; destination: string }
  | { kind: "not-started"; reason: string };
```

The host offers synchronously as `pi-herdr-agents` and starts nothing until the
emitter calls `start()`. Call it only when exactly one host offered. `start`
runs init with the request's context and returns synchronously; the emitter
shows a `not-started` reason. The host does not listen in subagent sessions
and unsubscribes at `session_shutdown`. Unsubscribe an approval listener there
too, as the role-pack bridge does.

### Sidebar markers

Set `sidebar.enabled` to `true` to mark delegated children for the optional
[Pi Herdr Agents Sidebar](plugins/sidebar/README.md) Herdr plugin, whose Focus
action hides marked children from Herdr's Agents view. The setting defaults to
`false`.

```json
{
  "sidebar": {
    "enabled": true
  }
}
```

Add the key to your existing `config.json`. The extension rejects a
`config.json` without its `status` section, so copy `config.json.example`
first if the file does not exist. Run `/reload` after changing the setting.
Children launched before the change stay unmarked.

Setting `sidebar.enabled` to `false` and running `/reload` retires every
existing marker and clears the markers of running children. A clear can fail to
reach Herdr, so a token still expires at most 15 seconds after the last write
Herdr accepted. Setting it back to `true` marks only later launches; a child
that was already running when you turned it off is never marked again.

With markers on, every fresh, resumed, and persistent child records its own
process identity, as managed worktree children always do. After the parent
verifies that identity, it reports the pane token `piha_delegated_v1` with the
value `live`, a 15-second time-to-live, and an increasing sequence number
through `HERDR_SOCKET_PATH`. It renews the token on supervision checks while
that exact process is alive. It clears the token when the run finalizes or is
suppressed, or when the process exits or can no longer be verified. A
`/worktree` handoff session is never marked.

Marker writes never fail a launch or keep Pi running. Each write has a 2-second
timeout on an unreferenced socket, failed writes are not retried, and three
failures in a row stop that child's marker. Process identity reads Linux
`/proc`, so on other systems, and outside Herdr, nothing is marked. After a
parent crash, a marker can remain for up to 15 seconds after the last write
Herdr applied. A marker belongs to the pane, so a different process started by
hand in a delegated pane stays hidden by Focus while the original process is
alive and supervised, even if it is suspended. Run All first or use a fresh
pane. See [what a marker proves](plugins/sidebar/README.md#what-a-marker-proves)
and [reusing a delegated pane](plugins/sidebar/README.md#reusing-a-delegated-pane).

### Supervision transport

On supported local filesystems, supervision uses file wake-ups plus one shared
4.8-second pane reconciliation. A wake-up only prompts fresh evidence
collection; it never establishes a result by itself. While any child's wait for
that check is parked, the coordinator's file watches stay referenced, so the
sidecar is still observed when the parent has no other event-loop work. The
reference is released when the wait settles, is aborted, or its child is
unregistered. With no parked wait, the watches stay unreferenced and do not
keep the process running. If the watcher
or shared pane inspection becomes unavailable, supervision quietly returns to
the legacy one-second polling cadence. No caller action is required.

Set `supervision.forcePolling` to `true` in the durable user `config.json` to
disable wake-ups and use that legacy cadence deliberately. The setting is read
when the coordinator is created, so run `/reload` after changing it.
`subagents_list` reports the active transport mode (`wake+batch`,
`polling(forced)`, or `polling(fallback)`) and watcher count.

`supervision.hangWarningMinutes` defaults to `15`; set it to `0` to disable
no-progress advisories. For example, this keeps the default transport and sets
a 30-minute advisory budget:

```json
{
  "supervision": {
    "forcePolling": false,
    "hangWarningMinutes": 30
  }
}
```

While a child projects active or blocked, the parent compares durable session
JSONL and activity-snapshot updates against this budget. An advisory is warning-only, fires once per no-progress episode, and
never interrupts, kills, retries, or restarts a child. It identifies `blocked-tool` (an outstanding tool call may still complete),
`truncated-turn` (an observed `toolUse` stop with no tool call; its cause is unknown), or
`generic-no-progress` when neither condition is established, then
includes the session path and manual recovery options. Ordinary children can be
interrupted, cancelled with `subagent_cancel`, or, after termination, resumed or
newly spawned. Persistent
ordinary-pane specialists can be interrupted or stopped with `subagent_stop` and
replaced; they cannot be resumed. Managed-worktree children, including persistent
ones, retain their workspace and continue there only after the previous process
has exited; do not use `subagent_resume` or start a concurrent writer. Interactive children stay
quiet just as they do for stalled/recovered notices; their widget state still
updates. A later durable update clears the episode and sends the corresponding
recovered notice for non-interactive children.
`polling(fallback)` means at least one tracked child is using per-child polling;
other children can still use wake+batch.

A Linux manual benchmark on 2026-09-06 used isolated Herdr panes held pending,
20-second windows, and the extension's completion/supervision seams. At 10
children across three rotated rounds, wake+batch averaged 2.20 CLI launches/s
versus 14.20 for forced polling (84.5% fewer); mean evidence-to-resolver
latency was 3.2 ms versus 449.0 ms, and the largest reconciliation probe gap
was 4.82 s. The benchmark measures `/proc` CPU ticks for the supervisor and
isolated Herdr tree, not parent-model latency; raw samples are written to
`/tmp/issue29-bench/` by `test/bench/supervision-bench.mjs`.

`panes.mode` defaults to `"grouped"` when omitted. Ordinary public `subagent` and `subagent_resume` launches, including bare forks, fill extension-owned `Agents`, `Agents 2`, etc. tabs in the target checkout's existing workspace. `panes.maxPerTab` is a positive safe integer, defaults to `4`, and counts all live panes in each owned tab, including user-added panes and retained shells. Overlapping launches in one parent respect this cap. It is independent of `persistent.maxAgents`.

Checkout matching uses Herdr's canonical `worktree.checkout_path` and includes descendant directories. Shell working directories do not establish workspace ownership. If no checkout matches (including non-Git directories), placement uses the caller's workspace; overflow never creates a workspace. A reviewer with `cwd` set to a managed checkout joins that workspace without creating another worktree. Resume placement uses the saved session's cwd.

Explicit `panes.mode: "tab"` preserves one new tab per ordinary child in the caller's workspace. Explicit `"split"` preserves splits of the stable parent pane. `panes.direction` is `"right"` (default) or `"down"` and applies to grouped and legacy splits. `maxPerTab` does not affect these legacy modes. Managed worktrees retain their separate workspaces.

Ownership is tracked by returned pane/tab/workspace IDs, never labels. Separate parent processes own separate groups; `/reload` preserves a parent's in-memory ownership, but a full restart does not adopt old tabs. Placement never moves existing panes or renames user tabs. Background launches preserve focus; Herdr may resize sibling panes when splitting or closing. User-added panes are never closed by automatic tab cleanup. An owned tab remains reusable while user panes remain, even after all child panes close.

Run `/reload` after changing role, model, or pane settings.

`models.default` sets the model for subagents that do not specify a model.
`models.agents` sets per-agent defaults, keyed by the agent name passed to
`subagent({ agent: ... })`. Explicit `model` tool arguments take precedence,
followed by agent frontmatter, per-agent config, the global default, and finally
the parent model. Model values must be exact authenticated `provider/model-id`
references. A value can contain an ordered comma-separated fallback list, for
example `provider/preferred, provider/fallback`. The tool argument also accepts
`task:<category>` as its complete value (not in a list), for configured
`coding`, `review`, `recon`, `qa`, `architecture`, or `docs` preferences. The extension validates every
candidate before launch, then launches later candidates only after the selected
child settles with a provider/agent error. Pi owns any automatic transient
retrying inside that child; the extension does not infer retry counts or
permanence from the error text. A later candidate that launches after a parent
`/reload`, `/new`, `/resume`, or `/fork` uses the live parent session for its
artifacts and lineage, as completion delivery does. Its candidate list and
thinking level stay those of the original call. The original parent directory
and process directory remain the bases for directory resolution. Role files are
read again for each attempt, so a changed role `cwd` can redirect a fallback
when the tool call did not specify `cwd`. If no live parent context is available,
that candidate fails without launching. A completed child result, including a
negative task result, never switches models. Completion metadata reports the
requested candidate, every attempted candidate, the model actually used, and
each raw model failure in attempt order when fallbacks are tried.

A catalog-listed model and configured authentication do not prove that the
active provider account can use that model. Providers may reject an account /
model combination only when the request is made. The completion preserves each
raw provider reason with its model and suggests checking account access,
spawning a new subagent with a supported model, or choosing an appropriate
configured fallback. `subagent_resume` does not select a model and should be
used only after the session's stored model is usable. Persistent session sidecars fail closed: v1 does not resume or revive a stopped or crashed specialist; retain its evidence and spawn a new specialist. The completion does not
claim a permanent failure or a retry count that Pi has not exposed. Reliable
structured permanence and retry counts require an upstream Pi/ExtensionAPI
diagnostics seam for final provider errors and retry outcomes.

`config.json` is durable user state under the Pi agent directory and is loaded
when the extension starts. Run `/reload` after changing it. Package-root
`config.json` files are ignored; move them manually or re-run `/subagents-init`.

---

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
| `thinking`             | string  | parent level   | Pick the model tier first, then set thinking within that model's range: minimal/low for bounded mechanical work, medium for ordinary implementation or review, high+ for architecture, security, or hard diagnosis. Omitting still inherits the parent level; this is a discouraged fallback for orchestrated children. |
| `systemPrompt`         | string  | —              | Role text for a bare spawn, delivered as a role block at the top of the child's first message (not the system prompt); dropped for `fork: true` children. Named agents keep their definition body |
| `skills`               | string  | —              | Comma-separated skill names                                                                       |
| `tools`                | string  | —              | Comma-separated tool names                                                                        |
| `cwd`                  | string  | —              | Working directory, or source repository when `worktree` is set (see [Role Folders](#role-folders)) |
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

The extension does **not** push, create a PR, merge, cherry-pick, or remove the worktree or branch automatically. For task selection, lifecycle states, review commands, failure recovery, and safe cleanup, read [Worktree subagents](docs/worktree-subagents.md). The [research report](docs/research/worktree-subagent-orchestration.md) records the rationale and deferred roadmap.

---

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
- **Managed worktree:** the retained root pane, workspace, checkout, branch, commits, and manifest are kept. At launch, the child records its own process identity (PID, kernel start time, boot ID, and PID namespace) beside its session; the parent accepts it only while that process is alive in the parent's PID namespace as the Herdr pane shell or a descendant of it. SIGTERM goes only to that identity, re-verified immediately before the signal. Confirmation requires that identity to no longer exist, or the pane to be gone while it is not known alive. Command-line text and Herdr's foreground list are never evidence, because Pi rewrites its process title. A live identity (for example a suspended Pi), or one whose SIGTERM fails while it is still alive, leaves termination `unconfirmed` even if the pane is gone. An identity that was not captured (including on non-Linux hosts), is unreadable, or whose PID now names another process is never signalled and leaves termination `unconfirmed` unless pane absence confirms it. Every Herdr query and capture wait is bounded by the cancel's deadline (5 seconds); an answer that arrives after the deadline is ignored, even if it settles before the timer runs, and never changes a reported outcome. A retry re-checks, and if the launch capture expired it captures the identity again within its own deadline. The manifest becomes `cancelled` only after confirmed termination (a parent shutdown while unconfirmed records the plain shutdown state), and the normal worktree handoff is delivered. No Git cleanup is performed. See [Worktree subagents](docs/worktree-subagents.md).

Do not poll after cancelling; the cancelled result arrives as a steer message. Design rationale: [ADR-0014](docs/adr/0014-operator-cancel-terminal-intent.md).

The package ships one host-owned skill, `pi-herdr-agents`, a general operating guide covering launching, lifecycle control, persistent specialists, worktrees, and configuration. Live tool descriptions and this README remain authoritative.

---

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

---

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

---

## The `/worktree` Workflow

`/worktree <worktree> [task]` creates a Herdr-managed worktree from the current committed branch and launches a new interactive Pi session there with the active conversation branch. The original session remains available. Use `/worktree list` or `worktree_list({})` to inspect managed worktrees, including cross-session orphans, whose canonical source repositories are inside the session's cwd subtree. This is a new-process handoff, not an in-place move of the existing shell or Pi process.

The destination workspace is focused only after Pi startup is confirmed. Every fresh launch, including the handoff, sets `PI_HERDR_AGENTS_SESSION` to its session file; confirmation requires a Pi process in the root pane with the worktree cwd whose launch-time environment carries that value. Pi rewrites its process title, so command-line text is never evidence. Nothing inside Pi reads the variable, and it is not a child-context hint. Confirmation reads Linux `/proc`; see [Worktree subagents](docs/worktree-subagents.md).

---

### Explicit worktree cleanup

Parent sessions can call `worktree_remove({ target: "<path|branch|workspace-id>", preserve: true })` or `/worktree remove <target> [--preserve]`. Preservation is optional and never implied: dirty work is blocked unless explicitly committed first or preserved as a WIP commit. The result reports its SHA even if removal later fails or is refused. A failed preservation commit restores the pre-preservation index and never proceeds to removal. Inventory and removal reports disclose exact ignored-file counts: enumeration is streamed rather than buffered as one listing. Ignored files do not block cleanup and are not captured by preservation; failed counting still blocks removal.

Eligibility is rechecked at removal time: canonical source-repository cwd containment, registered linked checkout, no detected process holder, known live child, or persistent lease, and clean Git state with no untracked files or conflicts. A successful launch from a linked checkout does not itself authorize its removal; cleanup uses the canonical principal/source repository under the invoking parent session's cwd, not `manifest.sourceCwd` or shared Git identity. Start the parent Pi session rooted at that principal checkout or an ancestor containing it, then use normal explicit cleanup; `cd` inside an existing Pi session does not change the session cwd. A source repository that is a Git submodule is located through the `core.worktree` setting of its shared Git directory under the superproject's `.git/modules`, not through that directory's parent. Unknown inspection, identity disagreements, detached HEAD, locked checkouts, and initialized submodules block removal. Out-of-scope repositories are never eligible. Open worktree workspaces use Herdr removal. The source repository's primary workspace is never closed automatically. If this process recorded that worktree creation appeared to open it and a read taken just before the report still shows it untouched, removal adds `wX appears to have been opened by worktree creation; if you haven't used it, close it with herdr workspace close wX`; a missing or wrong-typed field, another open workspace for the repository, another session, or a restarted process reports nothing. Orphans use Git removal and registration pruning after checkout absence is verified. Owned reachable manifests are marked `removed`; manifests from other sessions are not required or rewritten. Stale removed manifests never govern a recreated checkout. Missing or dangling manifest paths do not affect unrelated checkouts; undecidable or conflicting manifest identity still blocks removal. A failed manifest update after removal is reported as a warning. Symlinked ancestors are supported; checkout symlinks escaping the canonical managed root are blocked. Process inspection covers observable same-user processes across sessions, regardless of runtime name, exempting only Herdr-confirmed idle retained shells, never runtimes at the same PID. Unreadable individual process details produce non-blocking warnings without an override flag; scanning continues so another observable holder still blocks removal. Human and structured inventory/removal results disclose incomplete coverage, including warnings seen before a later recheck or failure. Same-user inspection is permission-limited, and other-user processes are not inspected: a protected process could hold the checkout undetected. Warnings aggregate counts and bounded PID samples, not commands or environments. Linux uses `/proc`; macOS uses same-user `lsof` cwd records and warns for unreadable individual records. Unsupported platforms, failed global enumeration (including a failed `lsof` with partial output), and other unverifiable eligibility evidence still block removal. Cleanup Git and Herdr calls have 30-second timeouts.

A worktree launch may add three synchronous Herdr snapshots (`worktree list` before create, `worktree list` after create, and `pane list` for the opened primary), each bounded at 3 seconds, 9 seconds if all three run to their timeouts. A failed snapshot claims nothing and is returned as a launch diagnostic, shown in the `subagent` acknowledgement and the `/worktree` notice; it is not written to the console. Claims are kept only in this process and are not written to the manifest. Ordinary non-worktree launches add no Herdr calls. Explicit removal adds a primary-workspace report only when this process holds a claim for the removed source repository: `worktree list`, `workspace get`, and `pane list`, each asynchronous and bounded at 3 seconds, taken after the checkout is removed. That is at most three calls and 9 seconds of wall time, without blocking the event loop. These report calls sit on top of the existing cleanup Git and Herdr calls, which stay at 30 seconds each.

Cleanup never deletes or rewrites branches, uses force flags, or runs automatically. It never closes the source repository's primary workspace. Session startup does not scan worktree inventory, avoiding blocking Pi initialization; use `/worktree list` or `worktree_list` for an explicit inventory. Child sessions retain `/worktree list` and `/worktree <name>`, but receive neither cleanup tools nor the remove subcommand. Their repository-local listing labels detached entries `(detached HEAD)`; a detached sibling does not prevent inspection of named branches. See [cleanup and recovery](docs/worktree-subagents.md#cleanup) for details.

## Custom Agents

Custom agent roles are the package's primary extension mechanism. Create one
when a child needs a reusable, bounded responsibility such as scouting,
implementation, or review. If the new concept instead describes a multi-stage
user outcome, make it a workflow, command, or Pi skill that composes roles; do
not disguise a workflow as an agent definition.

### 1. Choose the scope

| Scope | Location | Use when |
| ----- | -------- | -------- |
| Project | `.pi/agents/<name>.md` | The role belongs to one repository |
| Global | `$PI_CODING_AGENT_DIR/agents/<name>.md` | The role should be available everywhere; the default root is `~/.pi/agent` |
| Role pack | An installed Pi package's registered `roles/` directory | The role should be independently installable and shareable |

The filename stem is the launch key. `name` frontmatter is optional because it
defaults to the filename stem. If supplied, keep it identical so overrides remain
predictable; role packs reject mismatches.

### 2. Create the definition

```markdown
---
description: Reviews a bounded change for concrete security vulnerabilities
thinking: high
tools: read, bash
system-prompt: append
session-mode: standalone
spawning: false
auto-exit: true
---

# Security Reviewer

Review only the requested change. Trace trust boundaries and affected callers.
Report concrete findings with file and line references, exploit conditions,
severity, and the smallest safe correction. Do not modify files.
```

Omit `model` to use `models.agents.<name>`, then `models.default`, then the
parent model. Put `model` in frontmatter only when the role itself needs a
specific exact authenticated `provider/model-id`.

`tools` is passed to Pi's `--tools` allowlist and may name any registered
built-in, extension, or custom tool. Listing a tool does not install its
extension. Use one non-empty inline comma-separated scalar, such as
`tools: read, grep`; do not use YAML lists, containers, quotes, or comments.
Omitting `tools` intentionally leaves the role unrestricted. Likewise, `skills`
names must already be discoverable by Pi; this package does not install role
prerequisites.

### 3. Verify and launch

```text
/subagent list
/subagent security-reviewer Review the authentication changes against main
```

Or call the tool directly:

```typescript
subagent({
  name: "Security review",
  agent: "security-reviewer",
  task: "Review the authentication changes against main.",
});
```

Agent files are read when definitions are listed or launched, so creating or
editing one normally does not require `/reload`. Installing, removing, updating,
or changing the extension code of a role pack uses Pi's normal `/reload` flow.

### Publish a role pack

A role pack is an ordinary Pi package with Markdown definitions and a tiny
extension that registers their directory through Pi's public inter-extension
event bus:

```text
security-roles/
├── package.json
├── extension.ts
└── roles/
    └── security-reviewer.md
```

```json
{
  "name": "@acme/security-roles",
  "version": "1.0.0",
  "keywords": ["pi-package"],
  "type": "module",
  "pi": {
    "extensions": ["./extension.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  }
}
```

```typescript
import { fileURLToPath } from "node:url";

const roles = fileURLToPath(new URL("./roles", import.meta.url));

export default (pi: any) => {
  const unsubscribe = pi.events.on(
    "pi-herdr-subagents:roles:discover:v1",  // stable protocol identifier
    (request: { apiVersion: number; register(path: string): void }) => {
      if (request.apiVersion === 1) request.register(roles);
    },
  );
  pi.on("session_shutdown", unsubscribe);
};
```

Install both packages through Pi; the role pack remains inert if
`pi-herdr-agents` is absent:

```bash
pi install npm:pi-herdr-agents
pi install npm:@acme/security-roles
```

Registration is synchronous and accepts one absolute Markdown file or a
directory whose direct `.md` children are roles. The bridge must unsubscribe on
`session_shutdown` as shown so removed or updated packages do not survive a
reload. A copyable package lives in [`examples/role-pack/`](examples/role-pack/).
The host reads and validates
the files, derives package name/version from the nearest `package.json`, and
reports invalid paths, missing descriptions, filename/name mismatches, and
package-layer collisions in the listing surfaces.

Registered role packs form the whole package layer and have no priority over
one another: duplicate role names from multiple role packs are disabled with a
diagnostic rather than resolved by extension load order. Use a global or
project definition for an intentional override.

See [ADR-0003](docs/adr/0003-installable-role-packs.md) for the registration seam,
collision rules, and rejected alternatives.

### Authoring checklist

- The role has one bounded responsibility and a clear report or handoff contract.
- The filename stem is the role name; if `name` is present, it matches the stem.
- `description` states the role's input/output responsibility.
- `tools` and `skills` contain only installed, necessary capabilities.
- Leaf roles set `spawning: false`.
- Autonomous roles set `auto-exit: true`; interactive roles leave it off.
- Generic roles omit `model` unless a particular runtime is functionally required.
- `/subagent list` shows the expected source and a smoke launch succeeds.

Capability declarations are strict: use the unquoted, unindented keys
`tools:`, `deny-tools:`, and `spawning:` exactly once when present. Declare
`tools` and `deny-tools` as non-empty inline comma-separated scalars, and
`spawning` as exactly `true` or `false`. YAML lists, containers, multiline
values, quotes, comments, empty values, duplicates, noncanonical key spelling,
and invalid booleans are rejected. A role with an invalid capability declaration
is excluded from discovery, and an exact-name launch reports the diagnostic
before creating a Herdr pane or worktree. Other unsupported or unknown
frontmatter may still be ignored.
Compare definitions against the reference below and verify them with
`/subagent list` plus a smoke launch.

### Frontmatter Reference

| Field         | Type    | Description                                                                                                                                                                                                                                                                 |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string  | Optional explicit agent name used in `agent: "my-agent"`; defaults to the filename stem and must match it in role packs                                                                                                                                                                                            |
| `description` | string  | Shown in `subagents_list` output                                                                                                                                                                                                                                            |
| `model`       | string  | Optional exact authenticated Pi model default or ordered comma-separated fallback list; omit to use per-agent config, global config, then the parent                                                                                                                       |
| `thinking`    | string  | Optional Pi thinking default (`off` through `max`); omit to inherit the parent                                                                                                                                   |
| `system-prompt` | string | `append` passes the agent body through Pi's appended system prompt; `replace` replaces Pi's default system prompt. Without this field, the body is included in the task wrapper                                                                                                                                                                                                                                 |
| `tools`       | string  | One non-empty inline comma-separated Pi `--tools` allowlist under the exact unquoted key `tools:`; may contain any registered built-in, extension, or custom tool name. Omit to leave unrestricted. YAML lists, containers, multiline values, quotes, comments, noncanonical keys, and duplicates are rejected. |
| `skills`      | string  | Comma-separated installed skill names to auto-load. Use this plural form for new definitions; legacy project/global definitions using singular `skill` remain compatible. |
| `session-mode` | string | Default child-session mode: `standalone`, `lineage-only`, or `fork` |
| `spawning`    | boolean | Set exactly `false` to deny all subagent-spawning tools under the exact unquoted key `spawning:`. Only one `true` or `false` declaration is accepted. |
| `deny-tools`  | string  | One non-empty inline comma-separated `pi-herdr-agents` tool list to suppress under the exact unquoted key `deny-tools:`; this is not a universal cross-extension deny list. YAML lists, containers, multiline values, quotes, comments, noncanonical keys, and duplicates are rejected. |
| `auto-exit`   | boolean | Auto-shutdown after Pi fully settles when the latest assistant turn does not end with `stopReason: "aborted"` — no `subagent_done` call needed. User input does not permanently disable auto-exit. Recommended for autonomous roles; not for interactive ones the user drives. Also determines the default value of `interactive` (see below). |
| `interactive` | boolean | Override whether stall/recovery transitions wake the parent session. Defaults to the inverse of `auto-exit`: autonomous agents (`auto-exit: true`) are non-interactive and get stall pings; agents without `auto-exit` are interactive and stay quiet. Explicit values take precedence. |
| `persistent` | boolean | Keep this role's specialist session open between tasks. Follow-up work uses `subagent_send`; persistent specialists cannot be resumed in v1. |
| `cwd`         | string  | Default working directory. Absolute paths are unambiguous; relative agent-frontmatter paths resolve from Pi's agent config directory (`PI_CODING_AGENT_DIR` or `~/.pi/agent`), not the project root                                                                                                                                                                                                            |
| `disable-model-invocation` | boolean | Hide a role from discovery surfaces like `subagents_list`. The definition remains directly invocable by exact name via `subagent({ agent: "name", ... })`. |

---

Discovery still resolves precedence before visibility filtering. If a project-local hidden agent has the same name as a visible global or role-pack agent, the hidden project agent wins and the lower-precedence agent does not appear in `subagents_list`.

### `session-mode`

Choose how a subagent session starts:

- `standalone` — default fresh session with no lineage link to the caller
- `lineage-only` — fresh blank child session with `parentSession` linkage, but no copied turns from the caller
- `fork` — linked child session seeded with the caller's prior conversation context

`lineage-only` is useful when you want session discovery and fork lineage UX to show the relationship later, but you do **not** want the child to inherit the parent's turns.

`fork: true` on the tool call forces `fork` mode; `fork: false` forces `standalone` mode. Omitting `fork` inherits the agent's frontmatter `session-mode`.

```yaml
---
name: planner
session-mode: lineage-only
---
```

### `auto-exit`

When set to `true`, the agent session shuts down on Pi's `agent_settled` event unless the latest assistant message has `stopReason: "aborted"` — no explicit `subagent_done` call is needed.

**Behavior:**

- Low-level `agent_end` events do not close the session because Pi may still retry, compact and retry, or process a queued continuation.
- After `agent_settled`, a normal or error stop exits, while an aborted stop stays open.
- User input does not permanently disable auto-exit; the latest settled assistant stop reason determines whether the session exits.
- The modeHint injected into the agent's task is adjusted accordingly: autonomous agents see "Complete your task autonomously." rather than instructions to call `subagent_done`

**When to use:**

- ✅ Autonomous roles, such as scouting, implementation, or review, that run to completion
- ❌ Interactive roles or `interactive: true` forks where the user drives the session

```yaml
---
name: scout
auto-exit: true
---
```

### `interactive`

Controls whether status transitions (`stalled`, `recovered`) wake the parent session with a steer message.

**Default:** the inverse of `auto-exit`. Autonomous agents (`auto-exit: true`) are non-interactive and ping the parent on stall/recovery; named agents without `auto-exit` are interactive and stay quiet. Bare spawns have no agent definition and default to autonomous auto-exit behavior; they become interactive only when the call passes `interactive: true`.

**Why it exists:** Interactive agents can run for minutes or hours while the user thinks, types, and reads in the subagent's pane. Child snapshots still update the widget, but stalled/recovered supervision messages rarely need to wake the parent for user-driven sessions. Skipping the steer keeps the parent quiet until the child actually finishes.

**When to override:**

- Set `interactive: false` on an agent that doesn't auto-exit but you still want stall pings for
- Set `interactive: true` on an autonomous agent you'd rather check on yourself

```yaml
---
name: planner
# interactive defaults to true because auto-exit is not set
---
```

Or per spawn:

```typescript
subagent({ name: "Scout", agent: "scout", interactive: true, task: "..." });
```

---

## Tool Access Control

Without a restrictive `tools` allowlist or spawning policy, a sub-agent can spawn further sub-agents. Control this with frontmatter:

### `spawning: false`

Denies all subagent lifecycle tools (`subagent`, `subagent_interrupt`, `subagent_cancel`, `subagent_send`, `subagent_stop`, `subagents_list`, `subagent_resume`):

```yaml
---
name: worker
spawning: false
---
```

### `deny-tools`

Fine-grained control over tools registered by `pi-herdr-agents`:

```yaml
---
name: focused-agent
deny-tools: subagent
---
```

### Recommended Configuration

| Role shape | `spawning` | Rationale |
| --- | --- | --- |
| Leaf (scouting, implementation, review, QA) | `false` | Performs one bounded responsibility without delegation. |
| Coordinator | `true` | Delegates bounded children; a multi-wave coordinator sets `auto-exit: false` so automatic child-result steers drive each wave, then calls `subagent_done`. |
| Interactive collaborator | *(default)* | May delegate factual gaps while the user drives the session. |

Each role pack documents the settings of the roles it ships.

---

## Role Folders

The `cwd` parameter lets sub-agents start in a specific directory with its own configuration:

```
project/
├── agents/
│   ├── game-designer/
│   │   └── CLAUDE.md          ← "You are a game designer..."
│   ├── sre/
│   │   ├── CLAUDE.md          ← "You are an SRE specialist..."
│   │   └── .pi/skills/        ← SRE-specific skills
│   └── narrative/
│       └── CLAUDE.md          ← "You are a narrative designer..."
```

```typescript
subagent({ name: "Game Designer", cwd: "agents/game-designer", task: "Design the combat system" });
subagent({ name: "SRE", cwd: "agents/sre", task: "Review deployment pipeline" });
```

Set a default `cwd` in agent frontmatter. Use an absolute path for a project directory; relative frontmatter paths are resolved from Pi's agent config directory:

```yaml
---
name: game-designer
cwd: /absolute/path/to/project/agents/game-designer
spawning: false
---
```

---

## Tools Widget

Every sub-agent session displays a compact one-line tools widget summarizing available and denied tools:

```
[scout] — 12 tools · 4 denied
```

---

## Development

### Code map

The maestro seams remain inside one npm package with the same Pi extension
entry point. Pi is the sole real harness and Herdr the sole real surface
provider; fakes are for conformance tests only.

- `pi-extension/subagents/index.ts` — Pi composition root: tools/commands,
  role-pack event bridge, host policy, widgets, and parent delivery.
- `pi-extension/subagents/model-registry.ts`, `config-path.ts` — permanent
  host-local SDK capability glue and configuration-path conventions.
- `maestro/core/` — seam interfaces/types, activity and lifecycle projection,
  status, routing, wake-ups, and supervision.
- `maestro/core/roles/discovery.ts`, `maestro/core/config/` — role discovery,
  config loaders with injected directories, and task-model init prompt logic.
- `maestro/core/worktree.ts`, `maestro/core/worktree-cleanup.ts` — manifest
  schema/state, handoff types, and cleanup eligibility/formatting.
- `maestro/adapters/pi/` — Pi launch, completion, session I/O, activity files,
  model SDK glue, and registry projection behind `PiHarnessAdapter`;
  `child/subagent-done.ts` implements the child protocol.
- `maestro/surfaces/herdr/` — `HerdrSurfaceProvider`, Herdr CLI driver,
  terminal scripts/placement, and `herdr-socket.ts`, the bounded socket
  client for pane metadata.
- `maestro/runtime/` — run ownership, controls/retries, observation,
  delivery-gated cleanup, Pi composition, worktree operations/handoff,
  task-model init composition, and sidebar markers (`delegated-marker.ts`).
- `plugins/sidebar/` — the optional Herdr plugin. Its `sidebar.mjs` uses Node
  built-ins only and imports nothing from the extension, so Herdr can install
  the directory by itself.
- `maestro/adapters/fake/`, `maestro/surfaces/fake/`, `test/maestro/` —
  conformance fakes, seam tests, and the import dependency-rule test.

See [ADR-0012](docs/adr/0012-adopt-maestro-seams-in-repo.md), the
[glossary](CONTEXT.md), and the [documentation map](docs/README.md).

The **CI** workflow runs formatting, lint, unit tests, and the package preview
on pushes and pull requests to `main`, or manually from GitHub Actions. It has
read-only repository permissions and never publishes. Herdr integration tests
remain a local gate; the separate **Release** workflow still validates each
release before publishing.

Run local checks:

```bash
npm ci
npm run format:check
npm test
npm run lint
npm pack --dry-run
```

`npm run lint` needs Node.js 22.18+ (or 22.6–22.17 with `NODE_OPTIONS=--experimental-strip-types`) because oxlint imports TypeScript directly: its configuration, `oxlint.config.ts`, and the JavaScript plugin it loads, `tools/oxlint/anti-slop/index.ts`. Without type stripping, oxlint fails before linting with `Unknown file extension ".ts"`. This is a contributor tooling requirement, not a runtime requirement for package users.

Run the required end-to-end suite from inside Herdr:

```bash
npm run test:integration
```

Start the Herdr server with Node.js 22.19+ on its `PATH`, because test panes inherit the server's environment, not the test runner's: Pi 1.0.0 needs Node.js 22.19+ and crashes at startup on versions older than 22.15.

The deterministic suite launches real Pi sessions, Herdr panes, and worktrees without provider credentials. The optional live-provider smoke test is not a merge gate:

```bash
PI_TEST_MODEL="openai-codex/gpt-5.6-luna" PI_TEST_TIMEOUT=180000 \
  npm run test:integration:live
```

See [RELEASING.md](RELEASING.md) for versioning, trusted publication, and release verification.

---

## Acknowledgements

This package builds on earlier open-source work by [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) and [0xRichardH/pi-herdr-subagents](https://github.com/0xRichardH/pi-herdr-subagents). The sub-agent status supervision and turn-only interruption features were inspired by [RepoPrompt](https://repoprompt.com/)'s sub-agent snapshot polling and run cancellation features.

---

## License

MIT, see [LICENSE](LICENSE). Copyright notice retained from the upstream lineage (`HazAT`).
