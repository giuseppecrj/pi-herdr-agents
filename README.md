# Pi Herdr Agents

[![npm version](https://img.shields.io/npm/v/pi-herdr-agents)](https://www.npmjs.com/package/pi-herdr-agents)
[![CI](https://github.com/giuseppecrj/pi-herdr-agents/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/giuseppecrj/pi-herdr-agents/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

![Pi Herdr Agents: a parent Pi session delegating to parallel child agents in dedicated Herdr panes, an isolated worktree and a retained session, with a live status widget.](https://raw.githubusercontent.com/giuseppecrj/pi-herdr-agents/main/docs/assets/pi-herdr-agents-gallery.png)

Asynchronous subagents for [Pi](https://github.com/earendil-works/pi), running exclusively in [Herdr](https://herdr.dev).

Delegate investigation, implementation, and review without blocking the parent session. Each child runs as a real Pi process in its own Herdr pane. Its result comes back to the parent automatically when it finishes.

> **Agents:** load the operating guide with `/skill:pi-herdr-agents`. It covers launching, supervising, interrupting, cancelling, and resuming children, worktrees, persistent specialists, model routing, and configuration. The source is [`skills/pi-herdr-agents/SKILL.md`](skills/pi-herdr-agents/SKILL.md). Contributors: read [`AGENTS.md`](AGENTS.md).

## Contents

- [Features](#features), [Requirements](#requirements), [Install](#install)
- [Quick start](#quick-start), [How it works](#how-it-works), [Tools and commands](#tools-and-commands)
- [Choose models](#choose-models), [Control running children](#control-running-children), [Worktrees](#worktrees)
- [Roles](#roles), [Sidebar plugin](#sidebar-plugin), [Configuration](#configuration)
- [Safety and uninstall](#safety-and-uninstall), [Troubleshooting](#troubleshooting), [Documentation](#documentation)

## Features

- **Non-blocking delegation.** `subagent` acknowledges the launch at once, and the parent keeps working.
- **Parallel execution.** Run independent scouts, workers, and reviewers at the same time.
- **Live supervision.** Pi's subagent widget tracks process and turn state. You can interrupt one child turn without ending its session.
- **Managed worktrees.** Writing agents can run in retained Herdr workspaces with explicit Git ownership and recovery details.
- **Conversation handoff.** `/worktree` continues the active Pi conversation in a new worktree and keeps the parent session.
- **Pack-neutral roles.** Use project or global definitions and installable role packs. This package ships no default roles or workflows.
- **Persistent specialists.** Keep one policy-bound Pi session for sequential, turn-based tasks.
- **Optional sidebar focus.** The companion [Pi Herdr Agents Sidebar](plugins/sidebar/README.md) Herdr plugin hides marked delegated children from Herdr's Agents view while Focus is on. Markers are display only and follow the pane. See [Sidebar plugin](#sidebar-plugin).

## Requirements

- [Pi](https://github.com/earendil-works/pi) with package support
- [Herdr](https://herdr.dev) and its CLI
- `HERDR_ENV=1`, which means you start Pi from inside Herdr

Other terminal multiplexers are not supported. Session startup skips worktree inventory to avoid blocking Pi initialization. Use `/worktree list` or `worktree_list` to inspect managed worktrees. Outside Herdr, explicit inventory tools report unavailable inspection as unknown. Worktrees isolate Git checkouts, not processes or permissions. Child agents and installed Pi packages run with your user account's access.

## Install

Install from npm:

```bash
pi install npm:pi-herdr-agents
```

Install project-locally, or try it for one run:

```bash
pi install -l npm:pi-herdr-agents
pi -e npm:pi-herdr-agents
```

Then start Pi inside Herdr:

```bash
herdr
pi
```

Restart or `/reload` Pi after installation. Review package source before you install any Pi package.

## Quick start

A bare launch needs no installed role. Ask Pi to delegate in plain language:

```text
Use two subagents in parallel to map the authentication flow and the session schema, then summarize their findings.
```

Pi can also call the tool directly. Each call returns at once, and each result comes back on its own:

```typescript
subagent({ name: "auth-research", model: "<provider>/<fast-tier-id>", thinking: "low", task: "Map the authentication flow" });
subagent({ name: "auth-research2", model: "<provider>/<fast-tier-id>", thinking: "low", task: "Map the session schema" });
```

Named roles such as `scout` come from your project or global definitions or from an installed role pack. This package ships none. When one supplies `scout`, you can launch it by name:

```text
/subagent scout Analyze the authentication module and report relevant files and risks
```

For an isolated writing task, hand the conversation to a new worktree:

```text
/worktree auth-fix Implement the approved authentication fix and run the focused tests
```

The parent is the coordinator. Give each child one bounded outcome with its goal, allowed files, verification, and commit instruction. Use ordinary panes for read-only agents. A single or sequential writer can work in the parent checkout. Give each parallel, independent writer its own managed worktree, and keep dependent writes sequential. Children are leaves by default, and the parent owns integration and final verification.

## How it works

![Pi Herdr Agents lifecycle: spawn a child, run it in Herdr, supervise live state, and deliver one bounded result to the parent.](https://raw.githubusercontent.com/giuseppecrj/pi-herdr-agents/main/docs/assets/async-subagent-lifecycle.png)

A `subagent` call selects the target checkout, reuses its Herdr workspace, and gives the child a pane in an extension-owned `Agents` tab. Four panes fit in each tab by default, and overflow opens another tab in the same workspace. The call launches a child Pi session and returns `started`. The parent watches Herdr process state and child activity and shows the result in a live widget:

```text
╭─ Subagents ──────────────────── 1 active · 1 open ─╮
│ 00:23  Scout: Auth (scout)        active · read 7m │
│ 00:45  Reviewer (reviewer)              waiting 2m │
╰────────────────────────────────────────────────────╯
```

**Results arrive automatically.** When a child finishes, the parent receives one bounded `subagent_result` message and starts a new turn with that result in context. Do not poll, tail session files, or wait in a shell loop. Results longer than 16,000 characters are shortened in the parent context, and the full result stays in the child session. Active watchers survive parent `/reload`, `/new`, `/resume`, and `/fork`. Quitting Pi stops parent-side delivery.

Disposable ordinary panes close after their result is delivered, and Herdr removes a tab when its last pane closes. Persistent specialists keep their pane between tasks. Managed worktree roots return to retained interactive shells. Subagent launches do not steal keyboard focus.

Status labels, the stall watchdog, and no-progress advisories are described in [In-progress status updates](docs/tools.md#in-progress-status-updates) and [Supervision transport](docs/configuration.md#supervision-transport).

## Tools and commands

The parent session gets these tools:

| Tool | Use |
| --- | --- |
| `subagent` | Launch a child in a Herdr pane. Returns at once. |
| `subagent_interrupt` | Stop the current turn of a running child. The session stays open. |
| `subagent_cancel` | End an ordinary run. No fallback model is tried, and one cancelled result is delivered. |
| `subagent_send` | Send the next task to an idle persistent specialist. |
| `subagent_stop` | Stop a persistent specialist after its active task settles. |
| `subagent_resume` | Resume an earlier child session in a new ordinary pane. |
| `subagents_list` | List agent definitions, live specialists, and the supervision mode. |
| `worktree_list` | List managed worktrees and what blocks their cleanup. |
| `worktree_remove` | Remove one managed worktree on explicit request. |
| `subagents_write_task_models` | Internal writer for `models.tasks` preferences. |

Children get `caller_ping` to ask the parent for help. Interactive children also get `subagent_done` to mark themselves complete.

| Command | Use |
| --- | --- |
| `/subagent <agent> <task>` | Launch a named role. `/subagent list` lists roles. |
| `/worktree <name> [task]` | Continue this conversation in a new managed worktree. `/worktree list` and `/worktree remove <target>` manage them. |
| `/subagents-init [preferences]` | Draft task-category model preferences from the live model registry. |
| `/skill:pi-herdr-agents` | Load the host operating guide. |

The main `subagent` parameters are `name`, `task`, `agent`, `model`, `thinking`, `fork`, `cwd`, `persistent`, `interactive`, and `worktree`. See [Parameters](docs/tools.md#parameters) for every parameter, and [Tools and lifecycle reference](docs/tools.md) for the full behavior of each tool. Live tool descriptions and these documents are authoritative. The `pi-herdr-agents` skill is a general operating guide.

## Choose models

Set each child's exact authenticated `provider/model-id` and a supported thinking level. Pick the model tier first:

- fast for bounded mechanical work and reconnaissance
- mid for ordinary implementation or review
- frontier for architecture, security, hard diagnosis, or adversarial review

Then set thinking within that model's range. Without `model`, a child uses agent frontmatter, then `models.agents.<name>`, then `models.default`, then the parent model. Without `thinking`, it uses the role's thinking level when set, otherwise the parent level.

A `model` value can also be an ordered fallback list, such as `provider/preferred, provider/fallback`, or a whole-value `task:<category>`. Task categories are `coding`, `review`, `recon`, `qa`, `architecture`, and `docs`. Their candidates come from `models.tasks` in `config.json`. Run `/subagents-init` to draft those preferences from your authenticated models, then `/reload`:

```text
/subagents-init Prefer capability over price for implementation; keep recon inexpensive
```

Ordinary non-persistent runs try later candidates after a launch failure or a provider or agent error, never after a completed negative result. Persistent specialists do not advance after a running-child error. Worktrees use the first authenticated candidate only. A catalog-listed model can still be rejected by your provider account at request time.

Cross-family independent review requires a reviewer from a different model family than the author. `task:review` alone does not establish that. For ordinary review, prefer a different authenticated model family. When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session. Disclose that this review is context-isolated, not cross-family independent. Cross-family verification must not use this fallback. See [Model resolution and fallback](docs/configuration.md#model-resolution-and-fallback), [Task routing](docs/configuration.md#task-routing), and [Draft task-model preferences](docs/configuration.md#draft-task-model-preferences).

## Control running children

Three tools end or pause work, and each does something different:

| Goal | Tool | Effect |
| --- | --- | --- |
| Stop the current turn but keep the child | `subagent_interrupt({ id \| name })` | Sends Escape. The pane and session stay open, and the widget shows `interrupted`. |
| End an ordinary run | `subagent_cancel({ id \| name })` | Records the cancel first, so no fallback or retry follows. Closes an ordinary pane. A worktree keeps its workspace. One cancelled result arrives. |
| End a persistent specialist | `subagent_stop({ id \| name })` | Waits for the active task, confirms process exit, then releases the name. |

`subagent_cancel` rejects persistent specialists. If termination cannot be confirmed, cancel reports `unconfirmed`, and the run stays live and supervised. Call it again to retry. Do not poll after a cancel or stop. The result arrives as a message.

A child that needs help calls `caller_ping`. An ordinary child exits, and you continue it with `subagent_resume({ sessionPath, message })`. A persistent specialist stays alive, and you answer with `subagent_send`. `subagent_resume` restores the child's launch tool policy and rejects managed-worktree sessions. Continue a worktree child in its retained workspace instead.

Set `persistent: true` to keep one specialist session for sequential tasks. It accepts one task at a time and rejects sends while busy. `persistent.maxAgents` caps how many stay open (default `3`). Persistent sessions cannot be resumed.

Details: [Persistent specialists](docs/tools.md#persistent-specialists), [Interrupting](docs/tools.md#interrupting-a-running-subagent), [Cancelling](docs/tools.md#cancelling-a-running-subagent), and [`caller_ping`](docs/tools.md#caller_ping--child-to-parent-help-request).

## Worktrees

A worktree is opt-in for each launch:

```typescript
subagent({
  name: "ticket-build",
  model: "<provider>/<mid-tier-id>",
  thinking: "medium",
  worktree: { branch: "ticket/123", base: "main" },
  task: "Implement ticket 123, run its tests, and commit. Do not push, merge, or remove the worktree.",
});
```

- `cwd` selects the source repository. The child starts at the new worktree root.
- `base` resolves to an exact commit before creation and defaults to the committed `HEAD`. Uncommitted and untracked parent files are not copied.
- Each `branch` must be unique. Use one worktree per parallel, independent writing task.
- Successful, failed, and help-requesting runs keep their workspace. Completion reports the path, branch, base and head SHAs, commits ahead, changed files, and clean, dirty, or conflicted state. Failed Git inspection is reported as unknown.
- The extension never pushes, opens pull requests, merges, cherry-picks, switches the parent checkout, or removes worktrees on its own. The parent owns review and integration.

Cleanup is an explicit parent action:

```text
/worktree list
/worktree remove ticket/123
```

Removal rechecks eligibility at the moment it runs. It requires the source repository to be inside the parent session's cwd, no detected process holder or live child, and a clean checkout with no untracked files or conflicts. Unknown Git state or failed process enumeration blocks removal. Unreadable individual process details produce warnings, not proof of inactivity. `--preserve` (or `preserve: true`) commits dirty work as a WIP commit first. Ignored files are not preserved and can be deleted. Cleanup never deletes branches, uses force flags, or closes the source repository's primary workspace.

Read [Worktree subagents](docs/worktree-subagents.md) before you run writing agents in worktrees. It covers task selection, review, recovery, and cleanup. The tool-level contract is in [Isolated worktree runs](docs/tools.md#isolated-worktree-runs) and [Explicit worktree cleanup](docs/tools.md#explicit-worktree-cleanup).

## Roles

A bare launch without `agent` always works. A named launch resolves `agent` from these sources, highest priority first:

1. project definitions in `.pi/agents/`
2. global definitions in `$PI_CODING_AGENT_DIR/agents/` (default `~/.pi/agent/agents/`)
3. roles registered by installed role packs

`/subagent list` and `subagents_list` show each visible role and its source. A missing or invalid named role fails before Herdr creates a pane or worktree. It is never replaced by a bare agent.

A role is a Markdown file with frontmatter. The filename stem is the role name:

```markdown
---
description: Reviews a bounded change for concrete security vulnerabilities
thinking: high
tools: read, bash
spawning: false
auto-exit: true
---

# Security Reviewer

Review only the requested change. Report concrete findings with file and line references. Do not modify files.
```

A `read, bash` allowlist is not a read-only boundary, because shell commands can change files. See [Roles and custom agents](docs/roles.md) for the frontmatter reference, tool access control, and how to publish a role pack.

## Sidebar plugin

The optional [Pi Herdr Agents Sidebar](plugins/sidebar/README.md) Herdr plugin adds two actions. Focus hides delegated Pi children from Herdr's Agents view. All removes this plugin's filter. It needs:

- `pi-herdr-agents` version `3.2.0` or later, with `sidebar.enabled` turned on
- Linux, because the extension identifies child processes through `/proc`
- Herdr with the agent view API. The tested build is `0.9.2-preview.2026-09-29-8e78f929d8f0`. Other builds accepted by the `0.9.2` minimum are untested.
- `node` on the `PATH` of the Herdr server

Setup has two parts. Neither part works alone.

1. Install the Herdr plugin. Herdr shows the manifest and commands for review:

   ```bash
   herdr plugin install giuseppecrj/pi-herdr-agents/plugins/sidebar
   ```

2. Open `$PI_CODING_AGENT_DIR/herdr-agents/config.json` (default `~/.pi/agent/herdr-agents/config.json`). If it does not exist, copy `config.json.example` from the installed package there first. The extension rejects a `config.json` without its `status` section.
3. Merge the `sidebar` section into the file. Keep `status`, `models`, and every other section:

   ```json
   {
     "sidebar": {
       "enabled": true
     }
   }
   ```

4. Run `/reload` in each parent Pi session, or start a new one. Then launch new children. Children that were already running stay unmarked.
5. Run Focus yourself. Installing or enabling the plugin never turns it on:

   ```bash
   herdr plugin action invoke pi-herdr-agents.sidebar.focus
   herdr plugin action invoke pi-herdr-agents.sidebar.all
   ```

Focus replaces the server-wide Agents view, including any filter set by another tool. All clears only this plugin's view and leaves another tool's view untouched.

Focus is display only. Hidden children keep running and still raise notifications. Blocked children and children with unknown status stay visible. The marker follows the pane, not the process, so run All before you start another agent by hand in a delegated pane. See [Sidebar markers](docs/configuration.md#sidebar-markers) and the plugin's [limits](plugins/sidebar/README.md#reusing-a-delegated-pane).

## Configuration

The durable configuration file is `$PI_CODING_AGENT_DIR/herdr-agents/config.json`, default `~/.pi/agent/herdr-agents/config.json`. Package upgrades never overwrite it. Create it by copying the installed package's `config.json.example`, or run `/subagents-init`. The extension reads it at startup, so run `/reload` after any change. A package-root `config.json` is ignored.

| Key | Default | Controls |
| --- | --- | --- |
| `status.enabled` | `true` | The live subagent widget. This section is required. |
| `models.default`, `models.agents`, `models.tasks` | none | Model defaults and task-category candidates. |
| `persistent.maxAgents` | `3` | How many persistent specialists can stay open. |
| `supervision.forcePolling`, `supervision.hangWarningMinutes` | `false`, `15` | Supervision transport and no-progress advisories. |
| `panes.mode`, `panes.direction`, `panes.maxPerTab` | `"grouped"`, `"right"`, `4` | Where child panes open. |
| `sidebar.enabled` | `false` | Pane markers for the sidebar plugin. |

See [Configuration](docs/configuration.md) for every key, the task-model writer, and the events other extensions can use during `/subagents-init`.

## Safety and uninstall

- Child agents are real Pi processes running with your user account's permissions, inside Herdr panes. Worktrees isolate Git checkouts, not processes or permissions.
- The extension creates Herdr panes, tabs and managed worktrees only when a launch asks for them. It never pushes, merges, opens pull requests, deletes branches or removes worktrees on its own; cleanup is an explicit parent action ([worktree cleanup](docs/tools.md#explicit-worktree-cleanup)).
- What it writes: `$PI_CODING_AGENT_DIR/herdr-agents/config.json` (only through `/subagents-init` or the writer tool, never on startup); per-launch artifacts under the parent session's `artifacts/<session-id>/` directory beside Pi's session store, which hold the child's full task text and any `systemPrompt` as Markdown files, activity snapshots and worktree manifests; and the child's own Pi session file. A managed worktree that carries its own `.pi/agent` directory receives that child's session inside the checkout. Treat task text as potentially sensitive when you share or inspect those files.
- Managed worktree children record their PID, process start time, boot ID, and PID namespace in `<session>.process.json` beside their session. With [`sidebar.enabled`](docs/configuration.md#sidebar-markers), every other child records the same facts, and a resumed child records them under `artifacts/<session-id>/process-identity/`. The parent then reports one display-only pane token, `piha_delegated_v1`, on each child's pane through the Herdr socket. With the setting off, the extension writes no pane metadata.
- To uninstall: first list and remove any retained worktrees while the extension is still loaded (`/worktree list`, then `/worktree remove <target>`), because those commands leave with the package. If you installed the optional sidebar plugin, remove it with `herdr plugin uninstall pi-herdr-agents.sidebar` (or `herdr plugin unlink` for a linked copy). Then run `pi remove npm:pi-herdr-agents`, and delete `$PI_CODING_AGENT_DIR/herdr-agents/` and the `artifacts/` directories above if you no longer want the configuration and launch records.

## Troubleshooting

- **A child finished, but the parent did not react.** Check that a `subagent_result` entry reached the parent session. See [Troubleshooting completion delivery](docs/troubleshooting.md#troubleshooting-completion-delivery).
- **A child shows `stalled` or a no-progress advisory.** Advisories never stop a child. Interrupt, cancel, or stop it yourself. See [Supervision transport](docs/configuration.md#supervision-transport).
- **A model fails at launch or during the run.** The completion keeps each raw provider reason. See [Model resolution and fallback](docs/configuration.md#model-resolution-and-fallback).
- **Worktree removal is refused.** The report names each blocker. See [cleanup and recovery](docs/worktree-subagents.md#cleanup).

More checks are in [Troubleshooting](docs/troubleshooting.md).

## Documentation

| Page | Contents |
| --- | --- |
| [Tools and lifecycle](docs/tools.md) | Every tool and command, parameters, status labels, persistent specialists, interrupt, cancel, resume, and `/worktree` |
| [Configuration](docs/configuration.md) | `config.json`, model preferences, `/subagents-init`, init events, sidebar markers, supervision, and pane placement |
| [Roles and custom agents](docs/roles.md) | Discovery, frontmatter reference, tool access control, and role packs |
| [Worktree subagents](docs/worktree-subagents.md) | Worktree operation, review, recovery, and cleanup |
| [Troubleshooting](docs/troubleshooting.md) | Completion delivery and other common problems |
| [Development](docs/development.md) | Code map, CI, and local checks |
| [Documentation map](docs/README.md) | ADRs, active design, and research |

[`CHANGELOG.md`](CHANGELOG.md) is generated from Git history on each release. The domain glossary is [`CONTEXT.md`](CONTEXT.md).

## Development

Run the local checks:

```bash
npm ci
npm run format:check
npm test
npm run lint
npm pack --dry-run
```

Run the deterministic integration suite from inside Herdr with `npm run test:integration`. See [Development](docs/development.md) for the code map, tool versions, and the optional live-provider test, and [RELEASING.md](RELEASING.md) for releases.

## Acknowledgements

This package builds on earlier open-source work by [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) and [0xRichardH/pi-herdr-subagents](https://github.com/0xRichardH/pi-herdr-subagents). The sub-agent status supervision and turn-only interruption features were inspired by [RepoPrompt](https://repoprompt.com/)'s sub-agent snapshot polling and run cancellation features.

## License

MIT, see [LICENSE](LICENSE). Copyright notice retained from the upstream lineage (`HazAT`).
