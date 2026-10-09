# Orchestration glossary

## Language

**Pi subagent runtime**:
The single real execution path for fresh and resumed children, coordinated by a
run session through the Pi harness adapter. `launchPiSubagent()` still owns each
complete launch transaction; completion uses Pi sidecar evidence first and the
terminal exit marker as fallback.
_Avoid_: Runtime dispatch, adapter registry, split launch ownership

**Harness adapter**:
An object implementing the core interface for child launch, observation,
completion evidence, and controls. Pi is the only real implementation; the fake
is for conformance tests.
_Avoid_: Runtime selector, adapter registry, external CLI compatibility

**Surface provider**:
An object implementing the core interface for panes, commands, inspection, and
worktree surfaces. Herdr is the only real implementation; the fake is for
conformance tests.
_Avoid_: Supported multiplexer catalog, harness adapter, security sandbox

**Run session**:
The runtime owner coordinating launched attempts, retries, observations,
settlement, and delivery-gated surface cleanup. Pi composition supplies the
real adapter, provider, and session I/O.
_Avoid_: Pi session file, persistent specialist identity, historical run registry

**Composition root**:
The Pi host entry point that registers tools and commands, supplies current
launch inputs and host policy, renders status, and delivers parent results.
Runtime composition constructs adapters and providers behind its operations.
_Avoid_: Direct adapter dispatch, duplicated launch owner, workflow engine

**Dependency rule**:
The test-enforced import boundaries between core, adapters, surfaces, runtime,
and the Pi host. Core stays harness-neutral; the host consumes core and runtime
without direct adapter or surface imports.
_Avoid_: Runtime authorization, package split, hidden compatibility re-export

**Conformance suite**:
Shared seam-contract tests applied to an in-memory fake and the real
implementation. Fake coverage is local; real Pi and Herdr coverage uses the
deterministic integration suite.
_Avoid_: Second supported harness, fake-only behavior proof, release certification

**Child wake-up signal**:
An internal indication that prompts fresh inspection of an owned child. It does
not itself establish completion, failure, or a help request.
_Avoid_: Completion result, user alert

**Child result delivery**:
The parent-facing handoff of a child run's observed outcome and available
evidence. Receiving it does not establish that the work is correct or accepted.
_Avoid_: Wake-up signal, acceptance

**Operator cancel**:
A parent's `subagent_cancel` of one ordinary managed run. Its terminal intent is
recorded before any abort, kill, or await, so no fallback, retry, or recovery
follows. The run settles with one cancelled result only after its owned process
or pane termination is confirmed; unconfirmed termination keeps it live for a
retry, and shutdown suppression of it is not a cancellation. A natural result
taken first stays authoritative.
_Avoid_: Interrupt, suppression, persistent stop, pane-close fallback

**Process identity**:
A child's Pi process named by immutable kernel facts (PID, start time, boot,
and PID namespace), recorded by the child at launch and verified by the parent
against the Herdr pane. Every managed worktree child records it; other children
record it when sidebar markers are on. A worktree cancel signals and judges
exit only by it, and a delegated marker renews only while it is alive.
_Avoid_: argv match, foreground process, shell visibility

**Delegated marker**:
The display-only pane token `piha_delegated_v1=live` that a parent reports on
a delegated child's pane when `sidebar.enabled` is on. It means the parent
classified the pane's process as its child within the last 15 seconds, not
that the process is alive when Herdr draws the row. One stable source, a
15-second TTL, and increasing sequence numbers bound a leftover marker;
renewal requires the original process identity. A `/worktree` handoff is
never marked.
_Avoid_: liveness proof, ownership record, security boundary, per-run source

**Sidebar Focus**:
The Herdr agent view that the optional `pi-herdr-agents.sidebar` plugin sets
on request. It hides rows whose delegated marker is `live` while their status
is idle, working, or done, and keeps blocked, unknown, and unmarked rows. All
clears only this plugin's view and reports a view that another tool owns.
_Avoid_: hiding processes, notification filter, automatic view, popup

**Pi startup confirmation**:
The bounded check that a `/worktree` handoff's Pi is running before its
workspace is focused: a Pi process in the root pane with the worktree cwd whose
launch-time environment names the launched session in
`PI_HERDR_AGENTS_SESSION`. Nothing inside Pi reads that marker.
_Avoid_: argv match, `--session` visibility, child-context hint

**No-progress advisory**:
An internal warning that an active child shows no durable progress in its session
JSONL or activity snapshot. It is advisory only and never changes the child's
outcome or triggers recovery.
_Avoid_: Hang verdict, automatic recovery, stall replacement

**Legacy external CLI role**:
An old role definition that contains `cli`. Discovery reports a migration
diagnostic, and launch fails before Herdr creates a pane or worktree. Remove
`cli` and `cli-model`, then select the model through Pi provider/model routing.
_Avoid_: Silent Pi reinterpretation, compatibility adapter

**Pack-neutral host**:
This package as an execution host that ships no agent roles and no planning or
review workflows. Its only skill, `pi-herdr-agents`, is a general operating guide for its own
control tools. Role packs and project or global definitions supply every
named role. An empty catalog is valid, and bare launches need no role.
_Avoid_: Default role set, privileged pack, starter workflow

**Role pack**:
A separately installed Pi package that registers role definitions through the
`pi-herdr-subagents:roles:discover:v1` event. Registered packs form the whole
package layer below global and project definitions; duplicate names across
packs are disabled. A pack owns its roles' workflows, skills, prerequisites, and
workflow glossary.
_Avoid_: Bundled layer, protected fallback, load-order winner

**Child-context hint**:
The `PI_SUBAGENT_ID` environment variable set for every fresh or resumed child
this extension launches, and absent from `/worktree` handoff sessions. It
distinguishes delegated children from user sessions for tool registration and
pack state decisions. Nested processes inherit it, so it is not a security
boundary.
_Avoid_: Authentication token, permission check, second child protocol

**Deprecated role setting**:
A valid legacy `roles.bundled` boolean, accepted as a no-op and reported once per
parent extension load. Malformed values remain configuration errors. The
extension never rewrites user configuration.
_Avoid_: Bundled-role toggle, automatic migration

**Role allowlist**:
The `tools:` inline comma-separated role-frontmatter scalar passed to Pi for a
public child. It is the enforced capability boundary available to a reviewer.
`read,bash` is not read-only because Bash can mutate files.
_Avoid_: Shell-as-read-only claim, implicit capability grant

**Persistent specialist**:
A logical subagent that retains one policy-bound Pi session between sequential
tasks until it is stopped or crashes.
_Avoid_: Immortal process, reusable pane

**Session generation**:
One concrete Pi session serving a persistent specialist's logical identity.
_Avoid_: Logical specialist, revived session

**Task outcome**:
The recorded terminal result for one persistent-specialist task, including
`delivered`, `rejected-busy`, or a stop-pending task's eventual terminal state.
_Avoid_: Assumed completion, replay candidate

**Delivery ledger**:
The append-only evidence record of persistent task dispatch and terminal
outcomes for one session generation.
_Avoid_: Work queue, mutable task list

**Agents tab**:
An extension-owned Herdr tab grouping delegated child panes in an existing
checkout workspace. Ownership comes from returned IDs, not its display label.
The pane cap includes every live pane; overflow creates another tab, not a
workspace. Separate parent processes own separate groups.
_Avoid_: Agent workspace, label-based ownership, automatic rearrangement

**Retained checkout shell**:
The interactive shell in a managed worktree's root pane, preserved after the
child Pi process exits. Temporary review panes can close without deleting this
surface or its checkout.
_Avoid_: Completed agent process, disposable pane, automatic worktree cleanup

**Worktree lease**:
The lifetime-exclusive binding between a persistent specialist generation and
one managed worktree, when that specialist writes in a worktree.
_Avoid_: Rebindable checkout, shared worktree ownership

**Worktree inventory**:
An inspect-only view joining managed checkout discovery, Git registration/state,
Herdr workspace association, and reachable owned manifests, including orphans.
_Avoid_: Session-only resource list, cleanup action

**Cwd containment**:
Cleanup authorization requiring the canonical source repository root to equal or
be a descendant of the invoking session's canonical cwd.
_Avoid_: Managed-path containment, manifest ownership authorization

**Cleanup eligibility**:
Fresh evidence of cwd containment, registered checkout identity, a named branch,
no detected process holder, known live child, or persistent lease, and clean Git
state. Only Herdr-confirmed idle retained shells are exempt from process checks,
never runtimes at the same PID. Ignored files and individual process-visibility
gaps are disclosed, not blockers. Other unknown evidence blocks removal.
_Avoid_: Guessed idle, presumed clean

**Process-inspection warning**:
Non-blocking disclosure of incomplete same-user process visibility, separate
from cleanup blockers and requiring no override flag. Scanning continues after
unreadable details; detected holders still block. Other-user processes are not
inspected, and a protected process could hold the checkout undetected. Failed
global enumeration and unsupported platforms remain blockers.
_Avoid_: Proven unrelated, machine-wide inactivity, bypass permission

**Explicit worktree removal**:
A parent-requested removal of one named managed checkout and its open worktree
workspace, with absence verification and retained branch history. Never automatic
reaping. It never closes the source repository's primary workspace. When this
process recorded that worktree creation appeared to open that workspace and a
read taken just before the report still shows it untouched, removal suggests
the `herdr workspace close` command, to use only if the workspace is unused.
_Avoid_: Branch deletion, completion cleanup, automatic close of a workspace the user may have used

**Dirty-state preservation**:
Explicit opt-in staging and WIP commitment of a worktree's uncommitted and
untracked files on its retained branch before rechecking removal eligibility.
Ignored files are not captured. Commit failure restores the original index.
_Avoid_: Implicit commit, stash, discard

**Task-category model preference**:
An ordered authenticated model shortlist in `models.tasks` for `coding`,
`review`, `recon`, `qa`, `architecture`, or `docs`. Recon maps to scouts,
architecture to planning and diagnosis, coding to workers, review to reviewers,
QA to software and test runners, and docs to documentation workers. Categories
describe work, not complexity. `/subagents-init [preferences]` drafts them from
the active extension-loaded registry's synchronous snapshot and existing saved
choices, with source-based research when available. A single loaded extension
that offers on the task-model init approval event owns approval and the write
instead of the host writer. A dynamic provider awaiting
its initial catalog refresh might be absent. `task:<category>` is a subagent
model selector, not a command or parent model change. Ordered authenticated
candidate plans resolve before launch; ordinary nonpersistent runs can retry
after launch failure or a running child's provider/agent error, not a completed
negative task result. Persistent specialists do not advance after a running-child
error. Worktrees select the first authenticated candidate only, without fallback
retries. Cross-family independent review requires a reviewer from a different
model family than the author. For ordinary review, prefer a different
authenticated model family. When no other authenticated model family is
available, ordinary review may use a same-family reviewer in a fresh standalone
session. Disclose that this review is context-isolated, not cross-family
independent. Cross-family verification must not use this fallback. Family is
the independence boundary; project policy may separately require a
different provider.
_Avoid_: Generic tier, reviewer-family enforcement, per-step routing

**Ranking basis**:
What a task-model proposal's ranking rests on, as the proposing model submitted
it: `registry-only`, or `research` with the http(s) sources consulted in that
run, how each influenced the ranking, and the remaining uncertainty. It travels
with one write for review and is never saved; `tasksMeta.method` keeps its kind.
Code checks its shape, not that a source was read.
_Avoid_: Verified research, evidence store

**Loop template**:
A future reusable orchestration definition beside `models`, describing stages,
task categories, and a termination/report contract. Loop templates are not
implemented by task-model routing.
_Avoid_: Current executable workflow
