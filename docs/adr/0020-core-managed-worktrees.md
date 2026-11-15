# ADR-0020: Separate managed checkouts from Core terminal execution

- **Status:** Proposed. Design only. No implementation or parity claim.
- **Date:** 2026-11-15
- **Scope:** Local Core managed worktrees in `giuseppecrj/pi-herdr-agents`
- **Would amend:** ADR-0018's managed-worktree deferral, not its execution or Desktop boundaries
- **Baseline:** `64f03130ca4e7a8bb30cdd7125a1a47777398179` (`v3.11.0`)

## Decision proposed

Let the host provision a Git checkout, then start Pi in it with Core's native
`terminal.run`. Keep checkout ownership separate from execution ownership.
A Core worktree has no Herdr workspace, tab, pane or retained interactive shell.
It has a retained checkout, branch, manifest, Pi session and terminal record.

Keep the existing public `worktree: { branch, base? }` request. Do not add pack
names, workflow policy or a pstack-specific path. Ordinary execution is unchanged.
The parent still owns review, integration and explicit cleanup. No completion,
shutdown, restart or timer removes a checkout or branch.

Use local manifests as durable host evidence. Publish a small ownership reference
in Core labels at launch. Labels aid discovery. They do not authorize control or
cleanup. Do not introduce a second authoritative registry in `doc.set`.

Do not automatically resume a task or adopt its watcher after a parent crash.
Recover an inspectable inventory, not a durable workflow engine. Retain uncertain
resources rather than guessing that they are abandoned.

## Evidence and terminology

**Fact** means observed source behavior or a reported experiment. Repository
`file:line` citations below refer only to the baseline commit above. They are not
claims about a future implementation. **Inference** is a conclusion from that
evidence. **Proposal** is behavior this ADR asks Giuseppe to approve. All sections
from “Proposed ownership model” onward are proposals unless marked otherwise.

Two existing meanings of handoff must remain distinct:

- **Completion handoff:** the Git state attached to a child's delivered result.
- **Conversation handoff:** `/worktree <name> [task]`, which forks the active
  conversation into a new, long-lived Pi session. It is not a watched subagent.

**Fact:** These differ in `maestro/runtime/pi-run-session.ts:738-773,967-992`
and `maestro/adapters/pi/launch.ts:728-752`. The domain terms are documented in
`CONTEXT.md` and the [worktree guide](../worktree-subagents.md).

### Current legacy contract

| Operation | Fact at the baseline | Backend dependency |
| --- | --- | --- |
| Select and resolve | `cwd` selects the source. Resolve `base` to an exact commit before creation. A linked source checkout supplies its own base, but provisioning uses its principal checkout. `maestro/adapters/pi/launch.ts:532-558`; `maestro/runtime/worktree-operations.ts:125-170`. | Git and local manifest operations. |
| Create | Write `provisioning` before calling Herdr. Herdr creates the new branch, checkout and workspace without focus. Validate its returned branch and retain the root pane. `maestro/adapters/pi/launch.ts:555-619`; `maestro/surfaces/herdr/herdr.ts:180-198,798-879`. | The combined checkout/workspace/root-pane acquisition is legacy-specific. |
| Bind | Start at the returned checkout root in the returned pane. Persist the child session and managed-worktree session policy. Select project agent state from the new checkout, not uncommitted parent files. `maestro/adapters/pi/launch.ts:600-697`; `test/launch.test.ts:1877-2005`. | Session policy and cwd are shared. Pane dispatch and shell readiness are legacy-specific. |
| Conversation handoff | Fork the active conversation leaf, preserve the original session, start a normal interactive Pi, then focus only after startup confirmation. No child protocol or watched task is attached. `maestro/adapters/pi/launch.ts:254-280,337-353,728-752`; `maestro/runtime/pi-run-session.ts:967-992`. | Forking is Pi-owned. Foreground-process readiness and workspace focus are legacy-specific. |
| Completion handoff | Capture head/base SHAs, commits ahead, committed/staged/unstaged/untracked paths, clean/conflict state. Failed Git inspection makes all required Git evidence unknown. Probes share a 15-second budget. Capture before the parent accept check. `maestro/runtime/worktree-operations.ts:44-47,231-322`; `maestro/runtime/pi-run-session.ts:738-773`. | Plain Git plus host finalization and delivery. |
| Retention | Successful, failed and help-requesting runs retain their checkout and workspace. The root returns to a shell. Worktree runs bypass temporary-surface release. `maestro/runtime/run-session.ts:334-350`; `docs/worktree-subagents.md:132-150,210-227`. | Checkout retention is policy. The retained shell/workspace is legacy presentation. |
| Cancel | Record terminal intent before termination. Kill only the verified child Pi identity, not the root pane. Confirm exit, retain checkout and deliver one cancelled handoff. Missing identity leaves cancellation unconfirmed. `maestro/adapters/pi/pi-harness-adapter.ts:354-462`; `docs/adr/0014-operator-cancel-terminal-intent.md:49-71,107-115`. | Legacy retained-shell cancel depends on Linux process identity. Core already has a separate native terminate path. |
| Inventory | Scan the managed root. Join Git identity/state, Herdr workspaces, reachable manifests, live children, leases and observable same-user cwd holders. No startup scan. `maestro/runtime/worktree-operations.ts:638-735`; `maestro/core/worktree-cleanup.ts:152-236`; `docs/worktree-subagents.md:244-271`. | Discovery and Git probes are reusable. Workspace association and idle-shell exemption depend on legacy Herdr. |
| Cleanup | Parent request only. Reinspect source-cwd containment and all eligibility evidence. Open workspaces use Herdr removal; Git-only orphans use Git removal and absence verification before prune. Never delete branches. `maestro/core/worktree-cleanup.ts:258-436`; `maestro/runtime/worktree-operations.ts:773-786`. | Eligibility is shared policy. Workspace removal is legacy-specific. |
| Recovery | In-process reload/session changes retain watchers. A full parent restart does not reattach them. Creation uncertainty retains evidence, never authorizes late dispatch. `docs/worktree-subagents.md:210-227`; `maestro/surfaces/herdr/herdr.ts:830-851`. | Shared policy, with backend-specific identity evidence. |

**Fact:** The manifest is currently version 1, with stable owner
`pi-herdr-subagents`. `WorktreeLaunch` requires `workspaceId` and `paneId`.
The merge writer stamps version 1 and uses a temporary file plus rename.
See `maestro/core/worktree.ts:3-77` and
`maestro/runtime/worktree-operations.ts:188-218`.

**Fact:** Cleanup authorization is source-repository containment under the
invoking session's canonical cwd. Neither launch ownership nor a manifest alone
is authorization. Individual unreadable process details are disclosed warnings.
Failed global enumeration and unknown Git or identity evidence are blockers.
Ignored files are counted but may be deleted by explicit cleanup. Preservation
does not save ignored files. See [ADR-0011](0011-explicit-worktree-cleanup.md),
`maestro/core/worktree-cleanup.ts:127-149`, and
`maestro/runtime/worktree-operations.ts:497-631,739-770`.

### Core facts and spike evidence

**Fact:** The adapter refuses before acquisition in
`maestro/adapters/pi/launch.ts:238-245`:

> Herdr Core supports ordinary native execution only; managed worktrees, handoffs and supplied panes are deferred

The runtime separately refuses Core cleanup in
`maestro/runtime/pi-run-session.ts:994-1004`. The provider's worktree and Desktop
operations are unsupported in
`maestro/surfaces/herdr/herdr-core-surface-provider.ts:312-323`.

**Fact:** Core selection is explicit or uses native `HC_TERMINAL_ID` context.
The endpoint must be local and absolute. Backend, endpoint and parent terminal
are pinned across reload. Windows refuses Core before effects.
See `maestro/core/config/herdr-config.ts:52-88` and
`docs/configuration.md:57-91`.

**Fact:** The existing Core provider verifies a live parent, starts a unique
script with `cwd`, and uses `no_notify:true`, `outlive_parent:true`,
`keep:false`, `rm:false`, `wait:false`. Ownership checks compare terminal ID,
parent, creation time, argv and cwd. Native exit and terminal-record removal are
separate. Its inventory currently filters to in-memory owned terminals, so it
cannot serve cross-session worktree inventory unchanged.
See `maestro/surfaces/herdr/herdr-core-surface-provider.ts:59-204,221-250,279-291`.
Every RPC checks protocol generation and the pinned Core identity:
`maestro/surfaces/herdr/herdr-core-protocol.ts:133-277`.

**Fact, external:** `/tmp/core-spike/REPORT.md`, sections D, E, F and H, reports
real Pi 1.5.2, host 3.11.0 and Core 0.1.21 on a private Linux VM:

- Ordinary children, persistent tasks, automatic delivery and confirmed cancel
  worked. Managed worktrees hit the exact adapter refusal above.
- A prototype published Pi session path/ID in terminal labels and updated them
  on `/new`. Native Core status did not contain a Pi session reference. Labels
  remained mutable same-user data, not attestations.
- A daemon restart and same-version update preserved the Pi and holder processes
  and terminal identity. No reboot or parent-crash adoption test was run.
- The API had same-user command/file authority, even on an observer connection.
  The socket directory was private. Raw Core RPC was not a client authorization
  boundary.

The temporary report is supporting evidence, not a durable public dependency.
The released API can be checked in the tagged primary sources:
[Core v0.1.21 API](https://github.com/herdrdev/herdr-core/blob/v0.1.21/schema/README.md),
[OpenRPC schema](https://github.com/herdrdev/herdr-core/blob/v0.1.21/schema/hc.openrpc.json),
[README](https://github.com/herdrdev/herdr-core/blob/v0.1.21/README.md), and
[security](https://github.com/herdrdev/herdr-core/blob/v0.1.21/docs/security.md).
The inspected runtime schema is `/tmp/core-spike/schema.json`. Sources were
read as evidence. No downloaded source commands were executed and no local
files or credentials were sent to them.

**Fact, API:** That schema exposes `terminal.run` with `cwd`, `parent`, `labels`
and explicit lifetime flags. `terminal.list({all:true})` includes finished
records. `terminal.get` supplies exact identity; `terminal.kill` ends a program;
`terminal.rm` removes only a finished record. `terminal.label` mutates free-form
labels. `doc.get/set` provide version-checked opaque documents up to 1 MiB.
Documents survive daemon restart but can disappear with state loss or corruption.
There is no native Git-worktree or legacy workspace API.

**Fact, API docs:** `keep` restores a lost program with a shell, never replays its
command. A normal exit or explicit kill is still final. Holder processes let a
daemon restart leave programs alive. This does not preserve a process through a
host reboot. On Unix, ending a terminal need not stop deliberately detached jobs.
See the tagged API sections “Events” and “Documents”, and README's process-lifetime
text. These are contracts, not reboot or detached-job experiments from this task.

**Inference:** No Core PTY feature blocks parallel writers. The missing part is
host-managed Git provisioning and lifecycle evidence. Replacing a workspace ID
with a terminal ID would conceal that missing ownership model. `keep:true` would
also weaken the current promise that a terminal still refers to the submitted
execution, without giving normal-completion shell parity.

## Proposed ownership model

### Checkout and execution are separate resources

Give each launch a unique acquisition ID, separate from a display name or branch.
Use the same ID in the manifest, unique launch script and diagnostic labels.

A checkout record contains:

- schema version, stable owner, acquisition ID and backend;
- requested source cwd, canonical principal source root and common Git directory;
- branch, requested base, resolved base SHA and canonical intended checkout path;
- parent Pi session reference, child session reference, creation/update times;
- provisioning phase, execution state, cancellation intent and completion handoff;
- persistent logical ID and session generation when a lifetime lease applies;
- a backend-specific binding, absent until its acquisition is observed.

Legacy bindings keep actual workspace and pane IDs. Core bindings contain the
pinned socket, `hello.core.id`, original parent terminal address and creation
time, child terminal address and creation time, initial cwd and exact unique
script argv. Record terminal identity only when observed. Do not serialize
process environments, provider credentials or arbitrary user command lines.
Record a boot identity where available for diagnostics, not as a replacement for
fresh Core and OS inspection.

Make the model a discriminated union. Do not fill `workspaceId` or `paneId` with
`t...`, empty strings or invented IDs. Keep legacy output fields unchanged.
Core reports identify `backend: core` and a terminal binding. Public formatters,
session-policy readers and report contracts must handle the distinction. Do not
make `NativeExecution.start` pretend to acquire a shell before it starts Pi.

### Durable manifest and labels

Keep legacy version-1 manifests readable and leave their location unchanged.
Introduce a version-2 Core manifest, with one authoritative file per acquisition
under the parent host's agent directory:

```text
$PI_CODING_AGENT_DIR/herdr-agents/worktree-runs/<acquisition-id>.json
```

Use Pi's resolved agent-directory default when the variable is absent. Persist
this absolute location in the run and session policy. Do not recompute it from
the child's checkout-local agent directory. Session artifacts may reference the
record, but must not become a second mutable copy. This location makes ended
parent sessions inspectable without recursively searching every session file.

Write intent before Git or Core acquisition. Use exclusive initial creation,
owner-private storage, bounded validated reads and atomic updates. Preserve
unknown future fields. A malformed existing record is unknown, not an empty
record to overwrite. A v1 reader must not treat a v2 Core record as a legacy
workspace. No manifest migration runs at startup.

Publish a small set of proposed labels as part of `terminal.run`, not a later
critical `terminal.label` write:

```text
piha.owner=pi-herdr-subagents
piha.kind=managed-worktree
piha.run=<acquisition-id>
```

The binding's manifest contains the session path. Native Pi history does not
need a new label protocol for this feature. In particular, do not claim the
spike's mutable `pi.session_file` label is a verified session identity.
Never follow an arbitrary manifest path supplied in a label. Resolve a validated
run ID only within the configured host registry. Missing labels cannot make a
live process or checkout safe to remove.

Reject `doc.set` as a required registry for these two PRs. Its compare-and-set
can prevent document overwrites, but cannot make Git creation and process start
one transaction. It adds split authority and document-loss recovery to solve a
problem the local manifest already addresses. A future UI may publish a derived
document. It must remain disposable and non-authoritative.

### What replaces the workspace

The review unit is the checkout plus its manifest and Pi session. Retain the
finished Core terminal record for screen/history inspection until explicit
worktree removal. Do not spawn an idle shell, restore one with `keep`, create a
primary workspace, focus Desktop or rearrange tabs. Reviewers can run ordinary
children with `cwd` set to the retained checkout.

After verified exit, an operator can start a separate ordinary terminal in that
checkout and explicitly continue its Pi session. Check that the session is not
already open. This is manual continuation, not restored host supervision. The
new live process blocks cleanup even if it has no `piha` labels.
`subagent_resume` continues to reject managed-worktree sessions.

## Proposed acquisition and binding

1. Validate platform, model, request and backend capabilities before effects.
   Require local Core, supported Git and the existing finite RPC/launch budgets.
   Verify and pin Core identity and the original live parent terminal identity.
   Check that the socket's containing directory is private to the account;
   socket mode alone is not that boundary. Never expose raw Core RPC as a
   phone-facing API. Do not switch backend when Core is unavailable.
2. Resolve the base from the requested checkout, then resolve the principal
   source and common Git directory. Use the existing Git-environment isolation.
   Validate a new branch. Choose a path below `~/.herdr/worktrees/` with the
   existing two-level discovery shape. Recommend a Core-specific repository
   directory name derived from source identity, and a bounded branch slug plus
   digest. Hashes prevent accidental naming collisions; they do not prove ownership.
3. Record the intended path and `provisioning` in the durable manifest. Do not
   infer an acquired checkout from that path's existence.
4. Provision with an asynchronous, bounded Git worktree-add operation from the
   principal checkout, using a new branch and the exact SHA. Never force, reuse
   an existing branch/path, reset a ref or copy parent dirty files. Git's branch
   and checkout registration locks arbitrate competing launches. Validate the
   returned registration, branch, common directory and head before proceeding.
5. Record `provisioned`. Prepare the child session, managed-worktree policy, task,
   accept-check artifacts and unique script outside the checkout. For Core
   managed runs, allocate the session and its sidecars in durable host storage
   and pass its exact path with `--session`. Do not make removing the checkout
   delete the session or its policy. Select checkout-local agent configuration
   as legacy does, but separate that choice from session storage. All local
   preparation that can prevent dispatch finishes before `terminal.run`.
6. Durably record `start-submitted` before sending the one start request. Pass
   the checkout as `cwd`, the verified parent address and labels. Keep
   `no_notify:true`, `outlive_parent:true`, `keep:false`, `rm:false`, `wait:false`.
   Reuse the existing environment scrub and exit-code-preserving native script.
7. Validate the returned child against the pinned Core, parent identity, unique
   script, cwd and flags. Bind the actual terminal ID and creation time, record
   `running`, and transfer execution ownership to the existing watcher.
   A post-start manifest-write failure retains that in-memory owner and reports
   degraded recovery. It must not trigger fallback or another start.

The host owns local Git effects in `maestro/runtime/`. The Core surface owns RPC
and terminal identity. Pi session preparation stays in `maestro/adapters/pi/`.
Add a small provisioning/binding seam rather than another provider registry.
Legacy's combined workspace acquisition can remain behind its existing adapter.
Separate the shared checkout metadata from backend placement and execution.

A timeout is not proof of no effect. If Git creation fails or is uncertain,
record observed branch/path/registration evidence and retain partial state.
Do not dispatch Pi, retry creation, roll back the branch or recursively delete
anything. A bounded inspection may clarify what exists; it is not permission
to finish the launch later.

If Core submission has an uncertain reply, retain the checkout and manifest.
An exact observed terminal can enter the existing pending-ownership path, but
control still requires full verification. Without an ID, one bounded inventory
may locate a unique candidate by run reference, unique script and parent/cwd.
That is recovery evidence, not permission to adopt or retry. An empty snapshot
cannot exclude a late start. Preserve `start-submitted/uncertain` as a cleanup
blocker until the original operation's outcome can actually be established.

Duplicate calls never become “resume this worktree.” A repeated branch/path
fails without touching the first launch. Duplicate task IDs retain the kernel's
existing rejection. No worktree model fallback is added. No Core name is used
as an idempotency key or ownership token.

## Proposed lifecycle and recovery

Keep checkout phase and observed execution state distinct. A recorded `running`
state after a crash is historical, not a live lease. A recorded
`ready_for_review` is not fresh cleanup permission. Record `cancelled` only after
confirmed termination, and `removed` only after checkout absence is verified.
Every unfinished acquisition phase blocks cleanup, including `provisioned`
before submission. The owning transaction may record a definite pre-start
failure once it has stopped; another parent must not infer that from age.

| Event | Required behavior |
| --- | --- |
| Normal completion | Confirm native exit independently of Pi status. Capture the normal Git handoff once, run the parent accept check in its existing order, and deliver through the existing report envelope. Retain checkout, branch, manifest, session and finished terminal. |
| Child error or crash | When exit is confirmed, deliver available Pi evidence plus Git state. Missing semantic evidence is reported as such. Do not call a zero exit with missing task evidence accepted. Keep all review resources. |
| `caller_ping` | Ordinary worker exits with help outcome and retained resources. Persistent specialist ends only its current task and retains its generation and lease. |
| Persistent specialist | Bind one checkout for the generation's full lifetime. Busy, idle-between-tasks and stop-pending states all block removal. Stop must confirm native exit before releasing the lease. Never rebind it to another branch. |
| Interrupt | Interrupt the current turn through the existing native input path. Do not change checkout ownership, release a lease or mark cancelled. |
| Cancel | Record intent before any await. Verify the exact native execution, request `terminal.kill`, then independently inspect exit. Retain the finished record and Git state. Deliver once without fallback. Unconfirmed exit keeps the run live and cleanup blocked. No PID or name-based kill fallback. |
| Parent reload, `/new`, `/resume`, `/fork` | Transfer the existing in-memory owner and watcher. Keep the original Core and parent-terminal binding. A new Pi session ID does not reparent the Core terminal. |
| Parent crash or full restart | `outlive_parent` may leave the child running. Keep the manifest. A new parent can inspect and explicitly clean eligible completed work, but does not acquire a live task, replay a result, kill by ancestry or reopen its session automatically. A live orphan needs operator action on its independently verified terminal. |
| Core daemon restart | Reconnect to the pinned endpoint and require the same Core identity and exact terminal tuple. Reinspect before control. If they still match, continue the existing watcher. A transport outage is not completion. If events are later used, take a fresh snapshot because daemon event sequence numbers reset. |
| Core replacement or state loss | A changed Core ID blocks terminal control and cleanup that needs that binding. An empty new daemon is not proof the old holder stopped. Keep files and report the mismatch for operator recovery. |
| Host reboot or holder loss | Do not enable `keep` or replay Pi. The old process does not survive reboot. Inspect Core's actual post-recovery record and local Git state. Mark historical running evidence interrupted/unknown, not successful or cancelled. Same-address terminals from a different incarnation cannot inherit ownership. |
| Crash during provisioning or submission | Keep partial checkout, branch and manifest. Unknown pending effects remain blockers. Neither elapsed time, parent death nor a single empty listing proves the operation cannot still finish. Explicit diagnostic recovery may report a candidate, never dispatch it. |
| Stale or removed manifest | Reinspect the live registration and backend binding. Missing/dangling paths do not match another checkout. Conflicting or unreadable identity evidence blocks. A removed record can prove an absent checkout is already removed, but cannot classify a recreated path. |
| Dirty, conflicted or externally used checkout | Report actual state and retain it. Another terminal, manual Pi or detached build holding the checkout blocks removal regardless of labels or semantic task completion. |

Cancellation confirms the owned terminal execution, not machine-wide inactivity.
Core 0.1.21 can leave deliberately detached jobs alive on Unix. The independent
process-holder scan must still block cleanup of a checkout used by such a job.
Do not equate successful cancel with permission to remove files.

Full crash-safe delivery, cross-parent live adoption, lease takeover and automatic
resume remain out of scope. The concrete cost is that a finished orphan's result
may need manual review rather than an automatic message to a replacement parent.
This is the existing restart limitation, made explicit rather than silently
promising exactly-once delivery across processes.

## Proposed inventory and explicit removal

### Read-only inventory

Keep `worktree_list` and parent `/worktree list` inspect-only. Join:

1. canonical managed-root discovery and Git's worktree registrations;
2. reachable legacy manifests and the configured Core manifest registry;
3. a complete bounded local `terminal.list({all:true})` snapshot from the pinned
   Core, with exact `terminal.get` verification when binding a record;
4. current host children/leases and same-user OS process-holder inspection.

Do not use the current provider's in-memory-owned `listSurfaces` filter. Do not
filter the safety snapshot only by `piha` labels. Unlabelled terminals and manual
processes can hold the checkout too. Match containment using canonical paths,
including subdirectories, and distinguish initial terminal cwd from current
foreground/process cwd. A finished terminal record is not a live holder.

Show checkout path, branch, principal source, backend, terminal reference/state,
manifest state, Git state, blockers and visibility warnings. A known live or
uncertain bound execution blocks even if its current cwd has moved elsewhere.
A live manual Core shell in the checkout also blocks. Core has no automatically
created retained shell, so no Core idle-shell exemption is needed.

A new parent may inspect ended-session records without claiming their live
executions. Validate a finished foreign-parent binding against its stored tuple,
not against the new parent's terminal. This narrow cleanup inspection does not
seed the runtime's map of active owned runs. Different agent directories can
have unreachable manifests; do not follow external label paths to compensate.

Source containment still authorizes cleanup. Manifests provide identity and
uncertainty evidence, not an exclusive authorization token. Missing-manifest
registered orphans can be listed. Git-only removal is available only when the
inspection can exclude an unresolved backend association or pending acquisition.
For an undecidable backend, unavailable relevant Core endpoint or an open legacy
workspace, report unknown/blocked rather than treating it as an ordinary orphan.
Do not route a legacy workspace through Git-only removal. Keep legacy cleanup
available through its original backend. Do not manufacture workspace identities
for Core or auto-start a legacy server to fill an inspection gap.

Retain the existing no-open path canonicalization and submodule-source proofs.
Retain the approved warning-only treatment of individual process visibility gaps.
Retain blockers for unsupported platforms and failed global enumeration. This
remains permission-limited same-user inspection, not a security sandbox or a
proof against hostile concurrent writers.

### Removal transaction

Use the existing parent-only `worktree_remove({target,preserve?})` and command.
For Core, resolve exact path or unambiguous branch. Keep workspace-ID targeting
legacy-only. Display terminal IDs as evidence, not as new checkout deletion
selectors. An exact path is the recommended recovery target.

1. Freshly resolve one candidate, source containment and Git registration.
   Recheck all identities, process holders, live children, leases and acquisition
   uncertainty. Never trust a prior inventory or manifest status.
2. Block detached HEAD, locks, conflicts, initialized submodules, unknown state,
   changed backend identity and out-of-scope sources. No force option exists.
3. Dirty or untracked state requires explicit `preserve:true`. Reuse the WIP
   commit and exact index-restoration behavior. Reinspect after preservation.
   A successful preservation SHA remains in the report if a later step fails.
4. Remove the checkout through Git only after those checks. Never call
   `terminal.kill` as a cleanup convenience. Use no force or recursive-delete
   fallback. Confirm absence before any prune and retain branch history.
5. Once absence is confirmed, remove only verified finished Core records bound
   to this acquisition. Never remove the parent, unrelated terminals, a live
   manually continued session or a record found only by label. Missing records
   are harmless only when absence comes from the correct Core identity.
6. Persist checkout removal separately from terminal-record removal. A failed
   `terminal.rm` or manifest update after Git success is removed-with-warning,
   not a reason to retry Git or lose the preserved SHA. An explicit retry can
   finish record cleanup after revalidation. Keep a tombstone, session and
   branch; never edit a recreated checkout using the tombstone.

**Fact and decision needed:** Legacy explicitly allows deletion of ignored
files. That can include local user data, not just build output. See
`docs/worktree-subagents.md:260-266` and
`test/worktree-cleanup.test.ts:1402-1444`.
**Proposal:** Core initially blocks removal when ignored files exist, reports
their count and asks the operator to move or deliberately remove them. Do not
silently broaden `preserve` to commit ignored secrets. This is a small, explicit
Core safety difference pending Giuseppe's answer below. Legacy behavior does
not change in these PRs. It avoids claiming “nothing deletes user work” while
silently inheriting this destructive exception.

No check eliminates races with an unrelated same-user writer. Reuse fresh
eligibility probes and Git's own refusals. Do not add a distributed lock service,
watchdog-based reaper or a forced stale-lease timeout. Those would add complexity
without making arbitrary shell users obey the host's locks.

## Proposed conversation handoff

Reuse Pi's active-leaf fork and worktree context. Start the new interactive Pi
through the same Core checkout/binding path, without the child protocol,
`PI_SUBAGENT_ID`, auto-exit or a watched task. Preserve the original parent.

Replace legacy workspace focus with a returned exact terminal reference and
local attach guidance. Do not invoke an interactive attach process from the host
or claim Desktop focus. Native `terminal.run` confirms process submission, not
Pi startup. Add a minimal Pi startup acknowledgment tied to this launch/session
and terminal identity, using a bounded local sidecar. It must not install the
child protocol or depend on mutable generic session labels. A timeout reports
unconfirmed startup with retained checkout, session and any observed terminal.

This readiness change needs the supported Pi extension lifecycle API checked
at implementation time. If that acknowledgment is not implemented and tested,
conversation handoff must remain explicitly unsupported. Do not relax the
legacy readiness check into “Core says live.” Completion handoffs for watched
writers are required independently of this interactive feature.

## Proposed parity at the end of the two slices

| Capability | Legacy today | Proposed Core |
| --- | --- | --- |
| Opt-in branch/base/cwd and committed-base isolation | Supported | Same public request and Git contract |
| Parallel independent writers | Managed workspace per writer | Checkout and native execution per writer |
| Ownership before effects | Session-scoped v1 manifest | Durable v2 Core manifest before Git/start |
| Background launch | `--no-focus`, root pane | Native background start, no Desktop mutation |
| Completed/failed/help retention | Checkout, workspace, shell, session | Checkout, finished record, session; no shell |
| Git completion handoff and accept check | Supported | Same evidence and ordering |
| Explicit conversation handoff | Active-leaf fork, confirmed startup, focus | Active-leaf fork, confirmed startup, terminal reference; no focus |
| Interrupt/cancel | Legacy pane/process controls | Native exact-execution controls; files retained |
| Persistent worktree lease | One per generation | Same lifetime restriction |
| Cross-session inventory and explicit removal | Containment-based, includes orphans | Same authorization; Core identity join and partial-removal reporting |
| Ignored files at removal | Counted, may be deleted | Proposed blocker until operator handles them |
| Full parent-crash watcher adoption | Not supported | Not supported |
| Worktree-aware `subagent_resume` | Rejected | Rejected |
| Daemon restart | No general durable watcher recovery promise | Surviving native execution revalidated; no replay |
| Reboot task restoration | Not promised | Not promised; `keep:false` |
| Agents tabs, primary workspace, sidebar | Legacy UI | Unsupported; no fake workspace or sidebar marker |
| Supplied pane or remote Core execution | Separate legacy surface semantics | Still unsupported |
| Linux | Supported, including retained-child cancel | Target acceptance platform with real 0.1.21 tests |
| macOS | Worktree cleanup via `lsof`; legacy retained-child cancel lacks Linux identity | Target Core support via native termination and existing `lsof`; requires platform verification, not inferred from Linux |
| Windows | Managed worktrees refused; ordinary legacy support experimental | Core and managed worktrees still refused before effects |

## Implementation slices and acceptance

### PR 1: Provisioning and binding foundation

- Separate checkout metadata from legacy placement in `maestro/core/worktree.ts`,
  surface/launch seams, session policy and report types. Read v1 and v2 without
  inventing IDs or rewriting old manifests.
- Add bounded local Git provisioning and the Core registry writer in runtime.
  Retain the existing legacy provisioning path and ordinary native path.
- Prepare a managed child session, labels and script before native submission.
  Persist exact Core/parent/child identity and uncertain acquisition evidence.
- Test success, dirty-parent isolation, a linked source's exact base, branch/path
  collisions, concurrent duplicate requests, invalid branch names, path escaping,
  submodule sources, script/session failures, Git timeout, response loss with and
  without an ID, and post-start persistence failure. Assert no fallback, no
  automatic deletion and no second execution.
- Extend `test/launch.test.ts`, `test/maestro/worktree-operations.test.ts` and
  `test/maestro/herdr-core-execution.test.ts`. Pin unchanged legacy behavior with
  its existing fixtures. Add real Git tests, not only mocked command assertions.
- Run a live provisioning/binding seam test against real **herdr-core 0.1.21**
  in a private Core lab. Observe actual cwd, branch/base, manifest ordering and
  terminal identity. Retain evidence and remove only explicit test-owned state.
  This seam test is not public-tool end-to-end acceptance.

Keep the installed public managed-worktree refusal until PR 2 completes the
lifecycle. PR 1 may merge dormant foundation code; do not ship a flag that lets
users create worktrees without the finished cleanup and control contract. This
avoids a speculative public configuration key and an unsafe interim release.

### PR 2: Lifecycle, handoff, inventory, removal and cancellation

- Enable the public managed-worktree path. Reuse Git finalization, accept checks,
  report delivery and persistent leases. Retain Core worktree records instead
  of ordinary automatic record removal.
- Add backend-aware inventory and explicit Git/terminal removal. Keep source
  containment, process warnings, preservation rollback and all hard blockers.
  Report partial removal and keep ordinary Core cleanup unchanged.
- Verify native cancel for retained worktrees, help, persistent stop and failure.
  Add conversation-handoff readiness/attach output, or keep that one entry point
  refused and report the slice incomplete rather than claiming full parity.
- Cover parent reload/crash/restart, Core daemon restart, changed Core identity,
  stale or recreated paths, missing/corrupt manifests, incomplete inventory,
  dirty/conflicted/locked/detached/submodule states, unlabelled holders, detached
  jobs, multiple Core sessions, label tampering, and removal failure at each
  step. A live original-parent child must block a new parent's removal.
- Extend the cleanup tests and Core integration fixtures. The baseline examples
  include `test/worktree-cleanup.test.ts:1054-1479`,
  `test/integration/subagent-lifecycle.test.ts:446-674`,
  `test/integration/subagent-cancel.test.ts:390-536`, and
  `test/maestro/herdr-core-execution.test.ts:1078-1147,1376-1432`.
- Synchronize README, tools, configuration, worktree guide, outcome contract,
  domain vocabulary, code map and verification instructions in that PR. Run
  tool-doc/schema generation and compatibility checks. Amend ADR-0018 only when
  the new behavior is accepted and implemented.

### Required real-parent tests for PR 2

Use the existing `test/integration/herdr-core-lab.ts` and `core-parent.ts` pattern.
Pin the actual binary to 0.1.21 and record its version. Use fresh HOME, agent
state, XDG directories, Core session/socket and temporary Git repositories.
Use the deterministic model provider. Never use the operator's Core/Desktop,
credentials, production checkout or the earlier spike VM as a test fixture.

1. Through real parent Pi public tools, launch two parallel writers on different
   branches at the same SHA. Each commits a unique file. Prove distinct cwd,
   index and terminal identities, parent dirty-file isolation, two automatic
   results, correct Git handoffs and retained review resources.
2. Cancel a writer after it has written committed and uncommitted work. Prove
   one confirmed cancelled result, no fallback, preserved bytes and retained
   record. A detached checkout holder must still block removal.
3. Restart the Core daemon while a writer is active. Prove the same child
   execution survives, completes and delivers once to the still-live parent.
   Replace Core identity in a separate fault test and prove control refuses.
4. Terminate the test parent while its child is running. Start a new parent in
   scope. Inventory must show the orphan, refuse live cleanup and never replay
   the task. After independently observed child exit, explicit cleanup must
   preserve its branch and commits. Repeat with dirty work and explicit preserve.
5. Exercise completed, failed and help outcomes, persistent lease/stop, parent
   reload, and conversation handoff. Capture Pi session/sidecar evidence, manifest
   transitions, Core inventory, Git refs/status and terminal output. Do not use
   OSC `done`, a launch acknowledgment or child prose as the sole success proof.
6. Inject response loss and manifest-write faults. Check both the returned
   result and the actual Git/terminal resources. Prove that removal never kills
   a live terminal and that terminal-removal failure after Git removal is
   reported without erasing branch/session evidence.

A host reboot requires a disposable VM and separate authorization. Add a
reboot-equivalent fixture for missing old processes and persisted terminal state,
plus an actual disposable-VM reboot test before claiming reboot recovery.
Neither the spike nor a daemon restart counts as reboot evidence. Missing
binaries and unavailable macOS/reboot coverage are explicit gaps, not passes.

For both PRs run the repository's normal gates: unit tests, typecheck, lint,
format check, tool-doc check, package preview and diff check. For behavior changes
run the deterministic legacy integration suite and Core suite serially per
instance. Final acceptance requires the real-parent tests above, not only PR 1's
seam test. No implementation or live verification was performed by this ADR.

## Rejected alternatives and consequences

- **Invent a Core workspace ID:** hides different lifetimes and risks routing
  terminal IDs into legacy destructive commands.
- **Use `keep:true` or an always-running wrapper shell:** changes execution
  identity and cancellation semantics to emulate presentation. Not needed for
  headless parallel writers.
- **Treat `cwd` alone as managed ownership:** loses branch/base, manifest,
  retention and cleanup evidence. Ordinary existing-checkout launches remain
  useful but are not this feature.
- **Use labels, names or parent ancestry as authority:** mutable or shared
  metadata cannot establish this host's execution ownership.
- **Automatically adopt and resume after a crash:** requires a durable delivery
  protocol and live-owner takeover policy. It is larger than two bounded PRs.
- **Remove on success, cancel or parent exit:** destroys review opportunity and
  can erase uncommitted work. Explicit removal remains the only route.

The main cost is additional persisted Core identity and a versioned checkout
binding. The benefit is managed parallel writing without a Desktop dependency.
The user-visible differences are no retained shell/focus, stricter proposed
ignored-file handling, and explicit recovery work after ambiguous failures.

## Open questions for Giuseppe

1. **Retained surface:** Is a retained checkout, Pi session and finished terminal
   record sufficient, with no automatic shell or Desktop focus? Recommend yes.
2. **Ignored files:** Should Core block their removal as proposed, or inherit
   legacy's explicit-delete policy? Recommend blocking until deliberately
   handled. Do not describe the legacy policy as lossless preservation.
3. **Recovery scope:** Is inspect-and-clean recovery sufficient for the first
   release, with live orphan termination and result review left to the operator?
   Recommend yes. Automatic watcher adoption needs a separate decision.
4. **Conversation handoff:** Must interactive `/worktree <name>` ship with the
   parallel-writer feature, or may it stay refused until startup acknowledgment
   is proven? Recommend ordinary managed writers first if this delays safety
   acceptance. Completion Git handoffs are not optional.
5. **Platform acceptance:** Is Linux on real Core 0.1.21 the initial release gate,
   with macOS explicitly pending its own live evidence? Recommend no Windows
   expansion and no reboot-recovery claim without the separate VM test.
