# Configuration

This page is the reference for the durable `config.json` settings, task-model preferences, and the events other extensions use during `/subagents-init`. For a short introduction, see [Choose models](../README.md#choose-models) in the README.

## Configuration file

The durable user configuration is `$PI_CODING_AGENT_DIR/herdr-agents/config.json`,
defaulting to `~/.pi/agent/herdr-agents/config.json`. It is not read from the
installed package root, so npm and git package upgrades do not overwrite it.
Create it by copying the installed package's `config.json.example`, or run
`/subagents-init` to seed and draft model task preferences.

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

`config.json` is durable user state under the Pi agent directory and is loaded
when the extension starts. Run `/reload` after changing it. Package-root
`config.json` files are ignored; move them manually or re-run `/subagents-init`.

## Model preferences

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

## Draft task-model preferences

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

## Task-model writer

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

## Task routing

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

## Persistent specialist limit

Set `persistent.maxAgents` to the maximum concurrently retained persistent specialists. It defaults to `3`; a persistent spawn at the cap is rejected before Herdr creates a pane or workspace, and no specialist is evicted.

## Deprecated `roles.bundled`

`roles.bundled` is deprecated and has no effect because this package ships no
roles. Existing `true` and `false` values are accepted so that current
configuration keeps loading; a parent session reports one warning per extension
load naming the file and asking you to remove the key. The extension never
rewrites the file. Other values remain configuration errors, as do unknown keys
under `roles`. Registered role packs are the entire package layer, and global and
project definitions keep their precedence over them.

## Task-model init events

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

## Sidebar markers

Set `sidebar.enabled` to `true` to mark delegated children for the optional
[Pi Herdr Agents Sidebar](../plugins/sidebar/README.md) Herdr plugin, whose Focus
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
pane. See [what a marker proves](../plugins/sidebar/README.md#what-a-marker-proves)
and [reusing a delegated pane](../plugins/sidebar/README.md#reusing-a-delegated-pane).

## Supervision transport

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

## Pane placement

`panes.mode` defaults to `"grouped"` when omitted. Ordinary public `subagent` and `subagent_resume` launches, including bare forks, fill extension-owned `Agents`, `Agents 2`, etc. tabs in the target checkout's existing workspace. `panes.maxPerTab` is a positive safe integer, defaults to `4`, and counts all live panes in each owned tab, including user-added panes and retained shells. Overlapping launches in one parent respect this cap. It is independent of `persistent.maxAgents`.

Checkout matching uses Herdr's canonical `worktree.checkout_path` and includes descendant directories. Shell working directories do not establish workspace ownership. If no checkout matches (including non-Git directories), placement uses the caller's workspace; overflow never creates a workspace. A reviewer with `cwd` set to a managed checkout joins that workspace without creating another worktree. Resume placement uses the saved session's cwd.

Explicit `panes.mode: "tab"` preserves one new tab per ordinary child in the caller's workspace. Explicit `"split"` preserves splits of the stable parent pane. `panes.direction` is `"right"` (default) or `"down"` and applies to grouped and legacy splits. `maxPerTab` does not affect these legacy modes. Managed worktrees retain their separate workspaces.

Ownership is tracked by returned pane/tab/workspace IDs, never labels. Separate parent processes own separate groups; `/reload` preserves a parent's in-memory ownership, but a full restart does not adopt old tabs. Placement never moves existing panes or renames user tabs. Background launches preserve focus; Herdr may resize sibling panes when splitting or closing. User-added panes are never closed by automatic tab cleanup. An owned tab remains reusable while user panes remain, even after all child panes close.

Run `/reload` after changing role, model, or pane settings.

## Model resolution and fallback

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
