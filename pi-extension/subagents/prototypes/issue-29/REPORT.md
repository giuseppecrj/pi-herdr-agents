# Issue 29 prototype: measured gains, pending #32 retargeting

**The batched prototype crossed the legacy process-count and observed check-interval targets. This is not production approval for persistent agents.** Start with [HANDOFF.md](HANDOFF.md) before using the code.

## Baseline and method

The prototype is based on `ebef2657b0b21177373868d83d66965fdf77febd` (v1.5.1), before #31/#32. Tests used Linux x64, Node 26.7.0, Pi 0.85.1, and Herdr `0.8.2-preview.2026-08-31-b1ff4582e968`.

The workload used real interactive Pi children inside ordinary shell-wrapped panes, with an isolated Herdr server and local deterministic provider. Steady-state windows were 20 seconds. There was one trial per variant at 1 and 5 children, and three rotated-order trials per variant at 10 children.

CPU includes the Node supervisor and reaped CLI children plus the isolated Herdr process tree, including Pi children. It excludes a real parent Pi TUI in these standalone measurements. Detection latency runs from immediately before completion-record publication to resolver return, not to parent-model response. Millisecond clock resolution means 0 ms is not literal zero latency. Small CPU differences are not a statistical guarantee.

Sanitized per-trial data and conditions are in [MEASUREMENTS.json](MEASUREMENTS.json).

## Iteration 1: wake-ups alone

At 10 children, both file wake-ups and file-plus-Herdr wake-ups reduced recurring CLI launches by approximately **79.67%**, below the strict 80% gate. Observed CPU fell roughly 11%, and median detection improved from about 493 ms to 1 ms.

The explanation is structural: the baseline delays one second after doing CLI work, so its measured rate is slightly below 20 calls/s. Two calls per child every five seconds cost about four calls/s—not quite an 80% reduction from that measured baseline. Extending the interval would violate the freshness budget.

[REPORT-ITERATION1.md](REPORT-ITERATION1.md) retains that first result and its limitations.

## Iteration 2: batched reconciliation

The second iteration used complete pane-list observations shared across children and aligned 4.8-second sweeps, leaving scheduling headroom. The global pane-list behavior was checked across multiple workspaces, including with caller workspace context present.

| Variant, 10 children | CLI calls/s | Reduction | Observed CPU ms/s | Median detection | Maximum observed probe gap |
| --- | ---: | ---: | ---: | ---: | ---: |
| Current polling | 19.183 | baseline | 357.72 | 641 ms | 1.332 s |
| File wake-ups + batching | 2.382 | **87.58%** | 302.36 | 1 ms | **4.846 s** |
| Files + Herdr events + batching | 2.249 | **88.27%** | 303.23 | 1 ms | **4.866 s** |

All observed normal completions in these runs preserved semantic evidence. Observed CPU was about 15% lower than the matching baseline. Do not interpret the small file-versus-Herdr CPU difference as significant. These results need repetition against #32's persistent lifecycle and actual parent-delivery path.

Batching requires correctness safeguards: validate a complete snapshot, fall back on malformed/failed responses, invalidate snapshots for newly registered owners and relevant signals, and retain reconciliation even when the event stream appears healthy.

## What Herdr events add

Earlier comparative pane-closure measurements, including the existing artifact grace, showed:

- Current polling: 0.81–1.37 seconds.
- Files only: 4.82–5.35 seconds.
- Files plus Herdr events: 0.58–0.64 seconds.

There were only two samples per variant; these are not SLAs. File signals provide the ordinary-completion benefit. Herdr events help external pane closure. Normal Pi completion and SIGKILL of Pi with its shell still alive did not emit pane-exit events in these fixtures.

## Prerequisite evidence race

The initial run exposed a zero-exit terminal marker winning over a concurrently published completion record. The unchanged baseline resolver also reproduces the important error/help cases: it returns a generic zero-exit sentinel and leaves the semantic record behind.

`evidence-race.mjs` demonstrates the baseline behavior and the experimental correction. The candidate rechecks semantic evidence after terminal I/O before accepting any exit marker. This correction is not attributable to the transport optimization and must be rechecked against #32. Production source was not modified.

## Integration evidence and limits

- Twelve guarded hybrid fault scenarios completed: normal/error/help outcomes, dropped and duplicate signals, reconnect, controller rebind, actual Escape/continuation, Pi SIGKILL with surviving shell, pane closure, late evidence, watcher abort, and isolated Herdr-server restart.
- Five legacy real-parent workflow tests passed using the generated candidate runtime. Two actual parent reloads retained one connection, with 13 candidate watches and no unintended baseline fallback. Cancellation was also exercised. This is historical evidence; #31 removed the subsystem.
- A real public-parent smoke run passed two one-child cases, baseline and candidate, including actual parent receipt/model-context assertions and quiet fallback checks. It is **not** a completed full parent-load benchmark.
- Persistent task A/task B/stop behavior, late task-A records, and post-#32 lifecycle integration remain untested.
- Windows/macOS, exhaustive malformed-stream/filesystem-failure handling, and independent production-code review remain outstanding.

The snapshot preserves later integration scaffolding as well as executed experiments. Do not infer that every available command or mode received a full acceptance run. `MEASUREMENTS.json` distinguishes the completed evidence from unfinished work.

## Decision

Keep the batching and wake-up findings as a starting point, but resume implementation planning only after #32 settles agent identity, task IDs, authoritative per-task results, and lifetime termination. Replace obsolete workflow-specific gates with persistent-agent send/result/stop coverage, while retaining supported one-shot-agent regressions.

Do not merge this prototype wholesale, revive the removed workflow subsystem, infer completion from pane events, or claim that old measurements certify #32. The user-authorized outcome here is a preserved prototype branch and a context link from #29.
