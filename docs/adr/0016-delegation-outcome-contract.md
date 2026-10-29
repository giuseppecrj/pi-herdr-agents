# ADR-0016: Define a delegation outcome contract

- **Status:** Accepted
- **Date:** 2026-10-29
- **Scope:** What a parent receives from a delegated child, and the public tool
  schemas it sends
- **Contract:** [`delegation-outcome-contract.md`](../delegation-outcome-contract.md)

## Context

Runtimes such as herdr-core now launch agents, place panes, and report process
state. Starting and supervising a child is becoming a commodity. These runtimes
leave out what happens after the child stops. They do not say whether the
outcome is correct, who wrote each line of the report, or which verdict the
parent should act on.

`pi-herdr-agents` already answers part of that. It wraps child text in a
`subagent_report` envelope, records whether a summary came from the child or
the host, bounds every delivery, and attaches model, worktree, and cancel
evidence. It also guards its tool schemas against breaking changes. These rules
live in code, tests, and `docs/tools.md`, but no document states them as one
contract another host could implement.

Methodology packs such as `pi-herdr-pstack` depend on these rules. A pack
cannot rely on behavior that only one host's code defines and that can change
without notice.

## Decision

1. Define and maintain a small, versioned delegation outcome contract,
   starting at `delegation-outcome/v0`. It covers the report envelope,
   provenance, size bounds, host evidence, and tool-schema compatibility. It
   stays small enough for another host to implement in an afternoon.
2. `pi-herdr-agents` is the reference implementation. The contract describes
   only behavior this package ships and tests. Designs that are not shipped,
   such as the [accept check](../accept-check-design.md), appear as proposed
   items.
3. The contract does not depend on a terminal surface. It names no Herdr panes,
   workspaces, or CLI commands as requirements, so it survives a move from
   Herdr 1 to herdr-core.
4. The host ships mechanisms and packs ship policy, as in
   [ADR-0013](0013-pack-neutral-execution-host.md). The host frames, bounds,
   attributes, and attaches evidence. The parent or its pack decides whether to
   accept the work.

## Consequences

- The tool-schema snapshot and the compatibility test are mandatory.
  `test/fixtures/tool-schema/released.json` is the released request contract,
  and a breaking change needs a major package version.
- A change to the envelope, the host evidence, or schema compatibility updates
  the contract document and its tests in the same commit.
- The accept check and its closed verdict set land as v0.1, an additive change.
- Adoption is a risk. A contract with one implementation is only a description
  of that implementation until another host or pack relies on it.
- Scope creep is a risk. Writing adapters for every orchestrator, such as
  Claude Code subagents, Codex, or hc templates, is out of scope. Other hosts
  implement the contract themselves.
