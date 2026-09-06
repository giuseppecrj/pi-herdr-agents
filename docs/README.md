# Documentation map

Use this page to find the authoritative document for a task. Current shipped
behavior and accepted ADRs govern existing APIs. Historical plans and research
are evidence, not shipped contracts, when a later ADR supersedes them.

## Shipped contracts

- [`../README.md`](../README.md) — installation, public tools, configuration,
  lifecycle, and role authoring.
- [`../CONTEXT.md`](../CONTEXT.md) — orchestration glossary.
- [`../skills/orchestrate/SKILL.md`](../skills/orchestrate/SKILL.md) — public
  subagent review fan-out and parent synthesis procedure.
- [`../skills/orchestrate/adversarial-review.md`](../skills/orchestrate/adversarial-review.md)
  — adversarial topology, finding records, and incomplete-coverage policy.
- [`worktree-subagents.md`](worktree-subagents.md) — worktree operation,
  review, recovery, and cleanup.

The package launches asynchronous Pi children in Herdr and supports managed
worktrees for writing tasks. Orchestrated review materializes pinned evidence,
launches fresh public reviewers, receives automatic completion delivery, and
has the parent synthesize outcomes. Role frontmatter tool allowlists are the
available enforcement boundary; `read,bash` is not read-only. Automated package
acceptance covers unit tests, lint, and `npm pack --dry-run`. Deterministic
Herdr integration is a manual release gate run from inside Herdr.

## ADRs

| ADR | Status | Decision |
| --- | --- | --- |
| [`0001`](adr/0001-btw-ephemeral-side-questions.md) | Accepted | Add `/btw` as an ephemeral side-question child. |
| [`0002`](adr/0002-agent-workflow-skill-runtime-taxonomy.md) | Partially superseded by 0009 | Keep agent execution, skills, and Pi runtimes distinct. |
| [`0003`](adr/0003-installable-role-packs.md) | Accepted | Define installable role-pack discovery and collision rules. |
| [`0004`](adr/0004-require-active-user-approval-for-workflow-execution.md) | Superseded by 0009 | Historical exact-script approval decision. |
| [`0005`](adr/0005-parent-owns-workflow-script-authority.md) | Superseded by 0009 | Historical workflow-script authority decision. |
| [`0006`](adr/0006-limit-v1-execution-effects-to-isolated-worktrees.md) | Partially superseded by 0009 | Historical runner effect boundary; managed worktree rules remain. |
| [`0007`](adr/0007-require-fresh-review-for-workflow-scripts.md) | Superseded by 0009 | Historical workflow-review decision. |
| [`0008`](adr/0008-adopt-pi-only-subagent-execution.md) | Accepted; implemented | Remove the external CLI adapter and make subagent execution Pi-only. |
| [`0009`](adr/0009-remove-workflow-subsystem.md) | Accepted | Remove the workflow subsystem; use public subagent fan-out and parent synthesis. |
| [`0010`](adr/0010-persistent-specialists-as-session-generations.md) | Accepted | Define persistent specialists as logical identities with policy-bound session generations. |

## Historical material

- [`orchestrated-review-workflow-plan.md`](orchestrated-review-workflow-plan.md)
  — superseded workflow design, retained as history.
- [`research/`](research/) — background evidence and alternatives, not shipped
  behavior.
