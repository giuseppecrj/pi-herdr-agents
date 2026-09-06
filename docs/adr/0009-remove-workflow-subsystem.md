# ADR-0009: Remove the workflow subsystem

**Status:** Accepted

## Context

The review workflow runner added roughly 3,700 lines of preparation, approval,
journaling, checkout, Worker, and cancellation code for an unused surface. Its
approval gate and arbitrary project-script execution increased operational and
security risk without providing a needed product capability.

## Decision

Remove `herdr_workflow`, its Worker, workflow tests, and runner-owned review
checkout. The bundled `orchestrate` skill now has the parent materialize pinned
evidence, fan out fresh public read-only reviewers through `subagent()`, wait
for automatic completion delivery, and synthesize outcomes in the parent.

Public role frontmatter `tools:` is the available enforced allowlist. This is
not a shell sandbox: `read,bash` is not read-only. Every review prompt retains
the untrusted-artifact trust boundary.

## Consequences

There is no script compilation, approval packet, Worker, `vm`, runner journal,
or private review-child topology. Review results enter the parent context, so
parent synthesis must preserve failures and incomplete coverage explicitly.

This supersedes ADR-0004, ADR-0005, and ADR-0007, and supersedes the workflow
portions of ADR-0002 and ADR-0006.
