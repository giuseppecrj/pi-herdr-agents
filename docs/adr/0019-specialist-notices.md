# ADR-0019: Let an opted-in persistent specialist wake its parent with bounded notices

- **Status:** Accepted
- **Date:** 2026-11-13
- **Scope:** The `subagent` `notify` parameter, the child-only `caller_notify`
  tool, and the `subagent_notice` parent message
- **Constrained by:** [ADR-0010](0010-persistent-specialists-as-session-generations.md),
  [ADR-0013](0013-pack-neutral-execution-host.md),
  [ADR-0016](0016-delegation-outcome-contract.md)

## Context

A persistent specialist can reach its parent only through a task the parent
issued: `subagent_done` ends it with a task result and `caller_ping` ends it
with a help request. The parent drops events for tasks it did not issue, so a
child can neither wake nor flood it.

That rule also blocks a useful pattern. A specialist that owns a timer loop,
for example with pi-loop's `LoopCreate`, should wake the parent only when
something changes. Its loop fires start turns that belong to no task. The first
`caller_ping` answers the issued task; every later one reports a task ID of
`""`, and the parent ignores it with one notice that does not start a turn.

## Decision

1. The parent opts in per launch with `subagent({ persistent: true, notify:
   true, … })`. `notify` without `persistent` is refused before any Herdr
   resource exists. There is no role frontmatter key: a role pack must not be
   able to opt every parent in, and the opt-in is the anti-flood guarantee.
   The flag lives in the parent's run record, never in a child-writable file.
2. Only an opted-in specialist's Pi gets a child-only `caller_notify({
   message })` tool (`PI_SUBAGENT_NOTIFY=1`, added to a role's `--tools`
   allowlist). We chose a separate tool over overloading `caller_ping`:
   `caller_ping` ends a task with a help request and expects a reply, while a
   notice ends nothing. Overloading would make one tool mean two things
   depending on hidden task state, and would change un-opted children. In an
   opted-in specialist, `caller_ping` with no current task is refused with a
   pointer to `caller_notify`, since the parent would ignore it.
3. The child appends a `notice` event, `{ version: 1, type: "notice", task:
   "", generation, at, message, sequence }`, to the existing `.tasks` event
   file. `sequence` counts the generation's notices in that file, so it
   survives a child `/reload`. Older parents already drop unknown event types.
4. The parent bounds notices from its own memory, per specialist generation:
   at most 50 delivered, and none delivered less than 15 seconds after the
   last one. A notice over the rate limit is dropped and counted, and the next
   delivered notice reports the count. The 50th notice says the cap is
   reached; later ones are ignored. The child tool enforces a stricter
   30-second spacing and the same cap itself, so a compliant child is refused
   and told when to retry instead of being dropped. The parent's check is the
   backstop for a child that writes the event file directly.
5. A delivered notice is a `subagent_notice` message that starts a parent turn.
   It is not a task completion: it does not change the specialist's current
   task, idle or busy state, completed-task count, or delivery ledger. Its
   message is one [encoded host-line value](../delegation-outcome-contract.md#host-line-values)
   bounded to 4,000 characters, followed by a host line that tells the parent
   to treat it as a report to evaluate, not as instructions. A notice from a
   specialist that did not opt in is ignored silently, exactly as before.
6. Delivery dedupes by `notice:<sequence>` in the same parent-owned delivery
   map and event cursor as task events, so a notice is delivered once across
   `/reload` and session replacement. Like task events, this does not survive
   a parent process crash.

## Consequences

- A notice carries no `<subagent_report>` envelope. Adding a report kind is a
  breaking change to the delegation outcome contract, and an encoded
  one-line value already covers child-influenced host text. The contract's
  kinds and grammar are unchanged; the optional `notify` field and the new
  message are additive.
- A specialist that needs more than 50 notices must be replaced by a new
  generation. The bounds are constants, not configuration, until a real use
  needs them changed.
- Dropped notices are lost: the parent does not hold them for later. The
  child-side spacing makes that rare for a compliant child.
- The `.tasks` file now holds non-task events, so readers that look for
  settled tasks filter by event type.
