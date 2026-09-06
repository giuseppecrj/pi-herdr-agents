# ADR-0010: Persistent specialists as session generations

**Status:** Accepted

## Context

Issue #32's capability-continuity, design-update, and v1-decisions comments
(2026-09-06) define persistent specialists as durable logical identities rather
than immortal Pi processes.

## Decision

A persistent specialist has a logical ID and one v1 session generation. Its
launch policy, including its resolved tool policy and optional worktree binding,
is immutable for that generation. Each task records the logical ID, generation,
policy hash, and explicit terminal outcome.

A specialist accepts one task at a time. Sends while busy are recorded as
`rejected-busy`; v1 has no queue. A replaceable depth-1 next slot is the only
possible future queue shape. Stop waits for the active task's terminal outcome
and requires confirmed process exit. Stop and crash notices contain
harness-captured facts only. Neither stopped nor crashed specialists revive in
v1; a same-name spawn is a new specialist with a fresh ledger.

## Consequences

Evidence and policy sidecars remain after stop or crash. Automatic context relay
will add unbounded successful generation rotations in a follow-up issue; it is
not part of v1.
