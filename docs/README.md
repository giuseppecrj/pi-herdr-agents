# Documentation map

Use this page to find the authoritative document for a task. Current shipped
behavior and accepted ADRs govern existing APIs. Historical plans and research
are evidence, not shipped contracts, when a later ADR supersedes them.

## Shipped contracts

- [`../README.md`](../README.md) — installation, public tools, configuration,
  lifecycle, and role authoring.
- [`../CONTEXT.md`](../CONTEXT.md) — orchestration glossary.
- [`worktree-subagents.md`](worktree-subagents.md) — worktree operation,
  review, recovery, and cleanup.
- [`../plugins/sidebar/README.md`](../plugins/sidebar/README.md) — the
  optional Herdr sidebar plugin: installation, Focus and All, the delegated
  marker contract, and its staleness limits.

The package is a pack-neutral execution host: it launches asynchronous Pi
children in Herdr and supports managed worktrees for writing tasks, but ships no
agent roles, planning or review workflows, or skills. Roles come from project or
global definitions and installed role packs; workflows such as `/plan` and
`/skill:orchestrate` belong to those packs
([ADR-0013](adr/0013-pack-neutral-execution-host.md)). Role frontmatter tool
allowlists are the available enforcement boundary; `read,bash` is not
read-only. Automated package
acceptance covers unit tests, lint, and `npm pack --dry-run`. Deterministic
Herdr integration is a manual release gate run from inside Herdr. The manual
supervision transport benchmark is `../test/bench/supervision-bench.mjs`; it
uses an isolated Herdr server and writes uncommitted raw samples to
`/tmp/issue29-bench/`.

## Architecture and code map

[ADR-0012](adr/0012-adopt-maestro-seams-in-repo.md) records the accepted seams
decision. The [migration design](superpowers/specs/2026-10-02-maestro-seams-design.md)
is implemented in the feature branch, with local unit and deterministic
integration gates passed and the implementation checkpoint signed. It is not
yet a shipped contract.

- `../maestro/core/` — harness-neutral interfaces, domain rules, roles, and config.
- `../maestro/adapters/pi/` — Pi harness and child protocol.
- `../maestro/surfaces/herdr/` — Herdr provider and CLI driver.
- `../maestro/runtime/` — run ownership and real Pi/Herdr composition.
- `../pi-extension/subagents/index.ts` — Pi host entry point;
  `model-registry.ts` and `config-path.ts` remain permanent host-local owners.
- `../test/maestro/` — seam conformance and dependency-rule tests; real
  conformance runs in `../test/integration/`.

See the [full code map](../README.md#code-map). Pi and Herdr remain the only
real implementations; in-memory fakes are conformance fixtures only.

## ADRs

| ADR | Status | Decision |
| --- | --- | --- |
| [`0001`](adr/0001-btw-ephemeral-side-questions.md) | Superseded by 0013 | Historical `/btw` side-question decision; the command was removed. |
| [`0002`](adr/0002-agent-workflow-skill-runtime-taxonomy.md) | Partially superseded by 0009 and 0013 | Keep agent execution, skills, and Pi runtimes distinct. |
| [`0003`](adr/0003-installable-role-packs.md) | Accepted; bundled layer superseded by 0013 | Define installable role-pack discovery and collision rules. |
| [`0004`](adr/0004-require-active-user-approval-for-workflow-execution.md) | Superseded by 0009 | Historical exact-script approval decision. |
| [`0005`](adr/0005-parent-owns-workflow-script-authority.md) | Superseded by 0009 | Historical workflow-script authority decision. |
| [`0006`](adr/0006-limit-v1-execution-effects-to-isolated-worktrees.md) | Partially superseded by 0009 | Historical runner effect boundary; managed worktree rules remain. |
| [`0007`](adr/0007-require-fresh-review-for-workflow-scripts.md) | Superseded by 0009 | Historical workflow-review decision. |
| [`0008`](adr/0008-adopt-pi-only-subagent-execution.md) | Partially superseded by 0012 | Keep Pi-only execution; 0012 supersedes only the adapter-seam restriction. |
| [`0009`](adr/0009-remove-workflow-subsystem.md) | Accepted; skill ownership moved by 0013 | Remove the workflow subsystem; use public subagent fan-out and parent synthesis. |
| [`0010`](adr/0010-persistent-specialists-as-session-generations.md) | Accepted | Define persistent specialists as logical identities with policy-bound session generations. |
| [`0011`](adr/0011-explicit-worktree-cleanup.md) | Accepted; amended by 0015 | Authorize explicit worktree cleanup by cwd containment; retain branches and reject automatic reaping. |
| [`0012`](adr/0012-adopt-maestro-seams-in-repo.md) | Accepted | Adopt in-repo seams and conformance fakes; keep one package, Pi-only execution, and Herdr-only surfaces. |
| [`0013`](adr/0013-pack-neutral-execution-host.md) | Accepted | Ship a pack-neutral execution host; roles and workflows move to optional packs, and `/iterate` and `/btw` are removed. |
| [`0014`](adr/0014-operator-cancel-terminal-intent.md) | Accepted | Operator cancel records terminal intent before owned termination: no fallback, one confirmed cancelled result, unconfirmed runs stay live. |
| [`0015`](adr/0015-report-opened-primary-workspace.md) | Accepted | Report, and never automatically close, a primary workspace that worktree creation opened. |

## Active design

- `sidebar-plan.md` — local plan and audit record for the sidebar plugin and
  its marker bridge. It is excluded from the npm package, so it has no link
  here. It is not a shipped contract; the plugin README is.

## Historical material

- [`orchestrated-review-workflow-plan.md`](orchestrated-review-workflow-plan.md)
  — superseded workflow design, retained as history. Its `skills/orchestrate`
  and review-evaluation paths now belong to the `pi-herdr-roles` pack.
- [`research/`](research/) — background evidence and alternatives, not shipped
  behavior.
