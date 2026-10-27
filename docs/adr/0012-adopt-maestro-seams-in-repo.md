# ADR-0012: Adopt maestro seams in-repo

- **Status:** Accepted
- **Date:** 2026-10-04
- **Scope:** `giuseppecrj/pi-herdr-agents`
- **Supersedes:** Only ADR-0008's restriction on adding a runtime adapter seam without a second real execution path

## Decision

Adopt explicit `HarnessAdapter`, `SurfaceProvider`, and `RunSession` interfaces
under `maestro/` in this repository. Keep one npm package and the existing
`pi-extension/subagents/index.ts` Pi extension entry point.

Pi remains the sole real harness and Herdr the sole real surface provider.
In-memory fakes provide conformance coverage, not supported execution paths.
Runtime composition wires the real adapter and provider; the Pi host calls
runtime operations and core modules without importing adapters or surfaces
directly. A dependency-rule test enforces the directory boundaries.

Preserve the existing public tools, commands, role-pack protocol, completion
evidence and delivery, worktree invariants, and persistent-specialist semantics.
Do not add adapter registries, name-based runtime dispatch, or a second real
harness or provider.

## Why

Conformance fakes make run ownership and orchestration testable without real
Pi or Herdr resources. Explicit boundaries also prepare `maestro/` for later
extraction without maintaining a second implementation. These needs justify
the seam without a second real execution path.

## Consequences

The Pi launch module still owns each launch transaction; the run session owns
run coordination, retries, observation, and delivery-gated cleanup. Pi-specific
protocol code lives in `maestro/adapters/pi/`, Herdr operations in
`maestro/surfaces/herdr/`, and harness-neutral rules in `maestro/core/`.

The rest of [ADR-0008](0008-adopt-pi-only-subagent-execution.md) remains in
force, including Pi-only execution and rejection of legacy external CLI roles.
[ADR-0003](0003-installable-role-packs.md) continues to govern role packs.
This decision does not extract or publish a new package, promise another
harness, or establish that migration verification is complete. The migration
design was a development artifact and is not included in this package. See the
current [code map](../development.md#code-map).
