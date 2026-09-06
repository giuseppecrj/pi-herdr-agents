# Historical iteration 1

Superseded by [REPORT.md](REPORT.md). This records the initial result before batched reconciliation; it is not the current handoff.

# Issue 29 prototype result: no production go-ahead yet

The comparison is complete. Neither experimental variant clears every agreed gate. File wake-ups provide most of the normal-completion benefit; Herdr events add a distinct benefit for external pane closure. Do not round the measured 79.67% CLI reduction into the required 80%.

## Setup

- Base commit: `ebef2657b0b21177373868d83d66965fdf77febd`.
- Local branch: `prototype/issue-29-wakeups-eba2bc97`; no prototype commit or push.
- Linux x64, Node 26.7.0, Pi 0.85.1, Herdr `0.8.2-preview.2026-08-31-b1ff4582e968`.
- Real interactive Pi processes in ordinary shell-wrapped Herdr panes, using a local deterministic provider. No paid model requests or user credentials.
- A separate headless Herdr server, scratch HOME/configuration/socket, no client attached, and no changes to the user's live Herdr server.
- All variants use the same completion-evidence policy, except the explicitly documented experimental race guard below. Baseline imports the real production resolver unchanged.
- 20-second steady-state windows. One trial per variant at 1 and 5 children; three trials per variant at 10 children, rotating variant order and startup offsets. Startup and teardown are outside the steady-state window.
- CPU comes from Linux process ticks: the Node supervisor and reaped CLI children, plus the isolated Herdr process tree including the live Pi children. The real parent Pi TUI is not measured.
- Latency is the time immediately before the child writes semantic completion evidence through the resolver returning. It excludes final parent rendering, message injection, and a subsequent parent model response. Millisecond clock resolution means a measured 0 ms is not literal zero latency.

## Main result at 10 concurrent children

| Variant | CLI launches/s | Reduction | Observed CPU ms/s | Median detection | Nearest-rank p95 detection |
| --- | ---: | ---: | ---: | ---: | ---: |
| Current polling | 19.671 | baseline | 354.27 | 492.5 ms | 997 ms |
| File wake-ups + reconciliation | 3.999 | 79.669% | 314.61 | 1 ms | 6 ms |
| Files + Herdr events + reconciliation | 3.999 | 79.670% | 316.10 | 1 ms | 5 ms |

Each 10-child variant has three CPU/call-rate windows and 30 normal-completion samples. CPU differences are observations from finite samples, not a statistical guarantee. The file and event variants save approximately 11.2% and 10.8% observed CPU respectively; their small difference should not be treated as significant.

At 1 child, the measured CLI reduction was about 79.9%; at 5 children it was about 79.2%. Full rows and raw samples are retained in `results/summary.json` and `results/benchmark/`.

### Why the strict 80% target narrowly fails

The baseline sleeps one second *after* its CLI work, so it performs slightly fewer than 20 CLI calls/s at 10 children. The experiments still perform two CLI calls per child on each five-second reconciliation, approximately four calls/s. Relative to the measured baseline, that is 79.67%, not 80%.

Merely lengthening the interval to clear 80% would violate the agreed checking budget. A future iteration could investigate reducing work per reconciliation, such as batching pane-state inspection. That alternative was not implemented or measured here.

### Five-second target

The configured reconciliation period is 5,000 ms. Observed maximum probe-start gaps reached 5,015.53 ms for files and 5,008.18 ms for events due to scheduling/IPC overhead. This is not a hard real-time five-second guarantee. If the agreed limit is literal wall-clock time, the implementation needs scheduling headroom and another measurement; it must not silently reinterpret the limit.

## Where Herdr events help

Six additional measurements closed a real test-owned pane with no completion artifact. Each result correctly remained an error, not success. Times include the existing completion-artifact grace period.

| Variant | Two observed pane-closure detection times |
| --- | --- |
| Current polling | 0.81 s, 1.37 s |
| Files only | 4.82 s, 5.35 s |
| Files + Herdr events | 0.58 s, 0.64 s |

These are two samples per variant, not latency SLAs. File-only supervision is simpler but makes this exceptional path slower. Herdr events recover fast external-closure detection without adding recurring CLI launches.

Normal Pi completion, provider error, help completion, and killing Pi while its surrounding shell survives produced no pane-exit event in these fixtures. The event stream is not a replacement for completion-file signals or exit evidence.

## Correctness finding discovered during the experiment

The initial benchmark stopped at 10 children because a zero-exit terminal marker won over a completion sidecar published during the asynchronous terminal read. The record remained on disk after the resolver returned `sentinel`.

`evidence-race.mjs` reproduces the more consequential cases against the actual unchanged production function:

- Concurrent help record + zero-exit marker: baseline returns a generic successful sentinel and leaves the help record behind.
- Concurrent error record + zero-exit marker: baseline returns exit code 0 and leaves the error record behind.

The experimental resolver re-checks the sidecar after a terminal read and before accepting *any* exit marker. It preserves both records and consumes them once. This guard is present only in `completion-prototype.ts`; production code was not modified.

Both experimental variants use this guard in the final comparison. It is a prerequisite correctness correction, not a benefit to attribute to the event transport. Raw evidence is in `results/evidence-race.json`; the initial failed run is retained in `results/initial-failed-benchmark/`.

## Fault coverage

Twelve bounded scenarios completed with the guarded hybrid variant:

- Real Pi completion, provider error, and help request; duplicate late wake-ups did not duplicate delivery.
- Deliberately dropped file/socket signals followed by reconciliation.
- Socket disconnect, one-second fallback cadence, reconnect, and no fabricated result for a still-running child.
- Controller/listener rebinding retained one owner and one connection.
- Actual Escape kept Pi open; a subsequent prompt completed normally.
- SIGKILL of the test-owned Pi process preserved its enclosing shell and returned the numeric exit sentinel.
- Pane closure without an artifact returned an error.
- Late help evidence after pane closure won over a generic missing-pane result.
- Watcher abort detached listeners without inventing a completion.
- Restart of the isolated Herdr server reconnected the stream without fabricating a successful child result. Where evidence was unavailable, the watcher remained unresolved until explicitly stopped.

The last two lifecycle abstractions are deliberately limited: controller rebinding is a model of parent reload, and watcher abort is not an end-to-end test of the production workflow cancellation machinery. No real parent Pi `/reload` or full workflow-cancel integration was run against these candidate watchers.

## Gate assessment

| Gate | Result |
| --- | --- |
| At least 80% fewer recurring CLI launches at 10 children | **Not met: 79.67%** |
| No supervision CPU regression | Observed CPU lower at 10 children; finite-sample/component measurement only |
| No normal completion-delivery latency regression | Resolver detection much faster; full parent delivery remains unmeasured |
| Five-second maximum check interval | Nominal target met; literal wall-clock maximum exceeded by 8–16 ms |
| Semantic evidence preserved | Passed observed candidate cases **with the experimental race guard** |
| Full parent reload/workflow-cancel integration | Not exercised; do not count as passing |
| Windows/macOS compatibility | Not exercised |

There is no production-ready winner under the complete agreed contract. The failed primary gate also means it is premature to expand this prototype into a full parent-runtime integration.

## Recommendation

1. Treat the zero-exit sidecar race as a prerequisite correctness finding before enabling faster wake-ups.
2. Do not add a Herdr stream merely to accelerate ordinary Pi completion: files already provide that signal. Add it if preserving fast external pane-closure detection justifies the additional connection lifecycle.
3. If continuing, make the next experiment narrowly about reducing reconciliation work while keeping the five-second budget. Do not round the gate upward or slow reconciliation beyond it.
4. Retain the agreed automatic enablement with a polling escape hatch only for a variant that ultimately passes all gates. Nothing in this prototype has been promoted to production.

## Artifacts and cleanup

The code is retained uncommitted in the isolated worktree. Raw final measurements, fault results, metadata, and cleanup records are under `results/` and are Git-ignored. All owned experimental Herdr servers were stopped and their sockets disappeared. The prototype worktree workspace itself is retained for inspection. No commits, pushes, GitHub issue updates, or production-code edits were performed.
