# ADR-0017: Let the parent decide an accept-check verdict

- **Status:** Accepted
- **Date:** 2026-10-30
- **Scope:** The `subagent` `accept` parameter, the verdict a delivery carries,
  and the outcome ledger
- **Contract:** [`delegation-outcome-contract.md`](../delegation-outcome-contract.md#verdicts) (v0.1)
- **Design:** [`accept-check-design.md`](../accept-check-design.md)
- **Constrained by:** [ADR-0013](0013-pack-neutral-execution-host.md),
  [ADR-0014](0014-operator-cancel-terminal-intent.md),
  [ADR-0016](0016-delegation-outcome-contract.md)

## Context

A delegated child "completes" when its Pi session stops, and the host delivers
its last message. Nothing checks the work. Packs tell the parent in prompt text
to run the tests after every handoff; a parent that forgets, or a child that
reports "all tests pass" without running them, slips through.

ADR-0016 planned the accept check and its closed verdict set as the additive
v0.1 step of the delegation outcome contract. Three parts of it are hard to
reverse: a closed vocabulary that packs will branch on, a parent process that
runs caller-supplied shell commands, and a durable file under the user's
configuration directory.

## Decision

1. `subagent` accepts an optional `accept: { run, maxRetries?, timeoutSec?,
   paths? }`. The host ships no checks and no default command; the caller or
   its pack supplies the command (ADR-0013). v1 refuses it, before any Herdr
   resource exists, for persistent specialists and non-auto-exit children.
2. The auto-exit child runs the check in `agent_before_settle` and, while
   retries remain, works another turn with the bounded failing output. Its
   report is evidence only.
3. The parent re-runs the check after the child exits, in the worktree for a
   worktree child and in the child's cwd otherwise, and that run alone decides
   the verdict. Callers cannot skip it in v1; `timeoutSec` bounds a slow suite.
   It runs with the user's permissions, like any child `bash` call, with
   `PI_SUBAGENT_*` removed from its environment. There is no sandbox.
4. The verdict is a closed set: `accepted`, `rejected`, `error`, `skipped`,
   `none`. Only the parent re-check produces the first three. A timeout is
   `error`, because the check never answered. A sixth value is a contract
   change.
5. A cancel during the parent re-check stops it and delivers the cancelled
   result with verdict `skipped`. The kernel reopens the settle point only
   while the re-check runs (`FinalizeControl.cancellable`), so ADR-0014's
   terminal intent still wins and one cancelled result is delivered. Once
   termination is confirmed the kernel's cancel is authoritative
   (`FinalizeControl.interruption`): verdict `skipped`, manifest
   `cancelled`, and ledger `cancelled`, even when the check finished on its
   own first. Cancellation is never inferred from the check's output.
   A running check is owned and never outlives its owner. Each process tracks
   its check process groups (`maestro/adapters/pi/accept-groups.ts`). The
   child's `session_shutdown` and the parent's quit terminate their own
   checks: SIGTERM, then SIGKILL after 1 second, awaited. A synchronous
   `exit` hook SIGKILLs any group still tracked.
6. A rejected verdict is a completed negative result: it starts no model
   fallback and changes neither the sidebar status nor the worktree manifest
   state. The verdict appears in the delivery, its details, and the ledger.
7. The parent appends one outcome-ledger line per model attempt to
   `herdr-agents/outcomes.jsonl`, on by default with `outcomeLedger: false` to
   turn it off. A line never holds task text, check output, environment
   values, or the command (only its SHA-256). Nothing reads it yet.

## Consequences

- The delegation outcome contract becomes `delegation-outcome/v0.1`. Every
  result and help-request delivery gains a `Check:` head line, including
  `Check: none` for unchecked runs, so a fixture that pins exact delivery text
  changes once.
- The host now executes caller-supplied commands in the parent process. That
  adds no new authority (the caller already controls the child's task and
  tools), but a malicious or careless check runs twice, once in the child and
  once in the parent.
- An ordinary child's re-check tests the shared checkout as it is, which can
  hold other writers' edits; the delivery says `shared checkout`. Parallel
  writers already belong in worktrees.
- Changed check files are reported for worktree children only. Ordinary
  children, interactive children, persistent specialists, `subagent_resume`,
  and routing that reads the ledger are later, separate steps.
- The ledger grows without rotation, one short line per attempt.
