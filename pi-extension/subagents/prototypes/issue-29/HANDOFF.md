# Start here: issue 29 prototype handoff

**Prototype archive, not an implementation to merge. Resume #29 after #32's lifecycle contract is settled.**

This branch is frozen at `ebef2657b0b21177373868d83d66965fdf77febd` (v1.5.1), before the workflow removal in #31 and the persistent-agent design in #32. Do not use its inherited workflow code or exit-based watcher lifetime as the destination architecture.

## Read in this order

1. [DECISIONS.md](DECISIONS.md): the user-approved goals, constraints, terminology, and required contract from #32.
2. [REPORT.md](REPORT.md): both prototype iterations, measured gains, limitations, and the correctness finding.
3. [MEASUREMENTS.json](MEASUREMENTS.json): sanitized per-trial data, including measurement conditions. No raw sessions or credentials are included.
4. [README.md](README.md): commands and the distinction between runnable experiments, historical tests, and unfinished scaffolding.

[REPORT-ITERATION1.md](REPORT-ITERATION1.md) and [ORIGINAL-ISSUE.md](ORIGINAL-ISSUE.md) are historical evidence only. Their earlier no-go result and original architectural claims are superseded by the current report and the #32 dependency.

## What was learned

- File signals are useful for ordinary completion. Pi returning to its shell does not generally emit a pane-exit event.
- Herdr events have a distinct benefit for external pane closure. They remain hints to collect evidence, never successful task results.
- Slowing one-per-child queries to five seconds narrowly missed the 80% gate. Batched pane inspection with aligned 4.8-second sweeps crossed it in the legacy prototype.
- Complete global pane-list observations can cover multiple workspaces. Failed/malformed observations must fall back, not imply that an agent disappeared. Invalidate cached observations when registering new owners and on relevant signals/reconnects.
- The baseline zero-exit-marker race can discard concurrently published error/help evidence. `evidence-race.mjs` preserves a deterministic reproducer; the prototype guard rechecks semantic evidence after a terminal read.
- Task completion and agent lifetime must now be separated. A persistent specialist must remain supervised after delivering task A and before accepting task B.

## Evidence scope

Completed:
- Standalone comparisons at 1, 5, and 10 real deterministic Pi children; repeated 10-child trials.
- Guarded hybrid fault scenarios and comparative pane-closure measurements.
- Five real-parent legacy workflow integration cases, including two actual reloads and cancellation. These are historical because #31 removed that subsystem.
- A real public-parent smoke run: one baseline and one candidate child, with parent receipts/model-context checks and quiet fallback checks.

Not completed or not applicable:
- Persistent-agent task A/task B/stop lifecycle tests.
- A full real-parent 1/5/10 load benchmark; the public-parent harness is scaffolding with smoke evidence only.
- Post-#31/#32 production integration and an independent production-code review.
- Native Windows/macOS validation and exhaustive protocol/filesystem failure hardening.

## Resume after #32

1. Read the actual #32 implementation and identify its agent-instance identity, dispatch/task IDs, authoritative task-result records, stop/crash behavior, and duplicate-result rules. Do not substitute the original issue sketch for the settled contract.
2. Start from the then-current main branch in separate implementation work. Do not merge or cherry-pick this whole prototype branch.
3. Reproduce the evidence race against the new resolver. Carry its invariant forward even if #32 has already removed the exact old code path.
4. Adapt wake-ups and batched reconciliation to the existing #32 contract. A task result must not end the persistent agent's lifetime watcher.
5. Re-run performance measurements with idle persistent specialists, working specialists, repeated tasks, and one-shot agents where supported. Keep the agreed 80% and five-second gates; report uncertainty and full parent-delivery latency separately from detector latency.
6. Test task A then B, late A evidence, duplicate/replayed signals, crash during B, idle periods, graceful stop, disconnect/reconnect, reload, and multiple workspaces. Verify one delivery per task, no false success, and no parent model turn caused solely by a reconnect.
7. Remove legacy workflow-specific gates from the new implementation plan. Use the relevant persistent send/result/stop behavior instead.
8. Review production changes independently. Strip prototype telemetry and generated-runtime machinery; this archive is evidence, not a framework.

## Safety and publication

Experiments use an isolated test-owned Herdr server, scratch HOME/configuration, and a deterministic local provider. Do not restart the user's live Herdr session. Generated runtime copies, raw sessions, dependency trees, and local measurements are ignored; `prepare.mjs` regenerates the experimental copies from verified baseline files.

The user authorized preserving this work on a prototype branch and linking it from #29. That is not authorization to merge it, modify #32, release a package, or close #29.
