# Roles and custom agents

This page covers how named roles are found, how to write your own, and how to publish a role pack. A bare `subagent` launch without `agent` needs none of this. For everyday use, see the [README](../README.md).

## Taxonomy and discovery

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
[ADR-0002](adr/0002-agent-workflow-skill-runtime-taxonomy.md),
[ADR-0009](adr/0009-remove-workflow-subsystem.md), and
[ADR-0013](adr/0013-pack-neutral-execution-host.md).

## Roles and role packs

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
reload. A copyable package lives in [`examples/role-pack/`](../examples/role-pack/).
The host reads and validates
the files, derives package name/version from the nearest `package.json`, and
reports invalid paths, missing descriptions, filename/name mismatches, and
package-layer collisions in the listing surfaces.

Registered role packs form the whole package layer and have no priority over
one another: duplicate role names from multiple role packs are disabled with a
diagnostic rather than resolved by extension load order. Use a global or
project definition for an intentional override.

See [ADR-0003](adr/0003-installable-role-packs.md) for the registration seam,
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
