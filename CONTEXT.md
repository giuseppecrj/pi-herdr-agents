# Orchestration glossary

## Language

**Pi subagent runtime**:
The single execution path for fresh and resumed children. `launchPiSubagent()`
owns the complete Pi and Herdr launch transaction; completion uses Pi sidecar
evidence first and the terminal exit marker as fallback.
_Avoid_: Runtime dispatch, adapter registry, split launch ownership

**Child wake-up signal**:
An internal indication that prompts fresh inspection of an owned child. It does
not itself establish completion, failure, or a help request.
_Avoid_: Completion result, user alert

**Child result delivery**:
The parent-facing handoff of a child run's observed outcome and available
evidence. Receiving it does not establish that the work is correct or accepted.
_Avoid_: Wake-up signal, acceptance

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

**Public review fan-out**:
A parent procedure that materializes pinned evidence, launches fresh public
reviewer subagents, receives automatic result delivery, and synthesizes every
outcome. Reviewers use ordinary panes and do not poll for completion.
_Avoid_: Hidden child runner, approval gate, parentless aggregation

**Pinned review evidence**:
The parent-captured repository identity, base and head SHAs, task/spec text,
provenance, changed-file inventory, complete diff, and deleted or base-only
content supplied to reviewers. Dirty state is included only when explicitly
captured and fingerprinted.
_Avoid_: Moving-checkout inference, head-only deleted-content review

**Role allowlist**:
The `tools:` inline comma-separated role-frontmatter scalar passed to Pi for a
public child. It is the enforced capability boundary available to a reviewer.
`read,bash` is not read-only because Bash can mutate files.
_Avoid_: Shell-as-read-only claim, implicit capability grant

**Finding record**:
A bounded review record with a stable ID, claimed P0–P3 severity, nullable
confirmed severity, separate provenance, evidence status (`reproduced`,
`trace-backed`, or `unverified`), preconditions, reproduction or trace, expected
and actual behavior, impact, and minimal fix. An unverified potential P0/P1 is
a candidate for verification, not a certified finding.
_Avoid_: Confidence gate, provenance-as-severity, vote count

**Incomplete review**:
A review outcome for drift, failure, missing or truncated evidence, malformed
output, coverage gaps, or unresolved serious candidates. A child-reported
`INCOMPLETE` propagates to the parent result.
_Avoid_: Hidden missing coverage, certified uncertainty

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
A parent-requested removal of one named managed checkout and its open workspace,
with absence verification and retained branch history. Never automatic reaping.
_Avoid_: Branch deletion, completion cleanup

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
choices, with source-based research when available. A dynamic provider awaiting
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
independent. Cross-family verification, `/skill:orchestrate`, and
`adversarial-reviewer` must not use this fallback. Family is the independence
boundary; project policy may separately require a
different provider.
_Avoid_: Generic tier, reviewer-family enforcement, per-step routing

**Loop template**:
A future reusable orchestration definition beside `models`, describing stages,
task categories, and a termination/report contract. Loop templates are not
implemented by task-model routing.
_Avoid_: Current executable workflow
