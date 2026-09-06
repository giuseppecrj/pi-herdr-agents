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

**Worktree lease**:
The lifetime-exclusive binding between a persistent specialist generation and
one managed worktree, when that specialist writes in a worktree.
_Avoid_: Rebindable checkout, shared worktree ownership
