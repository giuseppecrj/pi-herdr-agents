# Prototype archive for issue 29

**Start with [HANDOFF.md](HANDOFF.md). This is not a production implementation or a branch to merge wholesale.** It preserves the measured experiments so #29 can be resumed after #32 settles the persistent-agent lifecycle.

The archive is pinned to the v1.5.1 source commit recorded in [BASELINE.json](BASELINE.json), before #31 removed workflows and before #32. Generators verify source hashes and refuse to silently run against a changed lifecycle. Retarget deliberately after #32.

## Context

- [DECISIONS.md](DECISIONS.md): approved goals, thresholds, rollout, and terminology.
- [REPORT.md](REPORT.md): current findings and evidence limitations.
- [MEASUREMENTS.json](MEASUREMENTS.json): sanitized per-trial measurements and executed-test inventory.
- [REPORT-ITERATION1.md](REPORT-ITERATION1.md): the initial, unbatched experiment.
- [ORIGINAL-ISSUE.md](ORIGINAL-ISSUE.md): superseded proposal, retained only as provenance.

## Reproduce the standalone experiment

Use a separate checkout/worktree of this prototype commit. Do not switch an in-progress #32 checkout to it. Existing repository dependencies are sufficient; no packages were added.

```bash
npm ci
node --experimental-strip-types pi-extension/subagents/prototypes/issue-29/prepare.mjs
node --experimental-strip-types pi-extension/subagents/prototypes/issue-29/evidence-race.mjs
node --experimental-strip-types pi-extension/subagents/prototypes/issue-29/run.mjs smoke
node --experimental-strip-types pi-extension/subagents/prototypes/issue-29/run.mjs bench --modes=baseline,files-batch,events-batch
```

Other completed experiment paths:

```bash
node --experimental-strip-types pi-extension/subagents/prototypes/issue-29/run.mjs faults
node --experimental-strip-types pi-extension/subagents/prototypes/issue-29/run.mjs close-latency --sizes=1
```

The original unbatched comparison uses `--modes=baseline,files,events`. `--seconds=...` and `--sizes=...` allow shorter exploratory runs, but changed workloads are not comparable to the recorded acceptance samples. `smoke` is not a performance acceptance run.

Tested on Linux x64, Node 26.7.0, Pi 0.85.1, and Herdr `0.8.2-preview.2026-08-31-b1ff4582e968`. CPU measurement is Linux-specific. Ten real Pi children require adequate memory headroom; the recorded run began with over 13 GiB available.

## Parent integration scaffolding

These commands generate an instrumented runtime copy under ignored `results/`:

```bash
node --experimental-strip-types pi-extension/subagents/prototypes/issue-29/prepare-parent.mjs
node --experimental-strip-types pi-extension/subagents/prototypes/issue-29/parent-integration.mjs --public --smoke
```

The public-parent smoke was exercised; the full public-parent load benchmark was not completed. The driver without `--public` runs the old workflow suite, which passed during the experiment but is **historical only** after #31. Do not bring that subsystem back as a dependency of #29.

Do not regenerate the runtime copy while parent integration runs are active. Generated runtime copies, child extensions, raw sessions, and raw results are ignored and are not part of the published prototype commit. The committed generators preserve how those experiments were constructed.

## Code map

- `batch.mjs`: complete pane-list batching, cache invalidation, and fallback on bad observations.
- `wake.mjs`: standalone file/socket wake-ups and per-run ownership.
- `lab.mjs`: isolated Herdr server, deterministic Pi fixtures, and Linux CPU sampling.
- `run.mjs`: standalone comparisons and fault scenarios.
- `prepare.mjs`: verified-baseline generation of the experimental resolver and timestamp-instrumented child.
- `evidence-race.mjs`: baseline zero-exit race and experimental guard demonstration.
- `parent-adapter.mjs`, `prepare-parent.mjs`, `parent-integration.mjs`: generated-copy integration with real parent Pi sessions.
- `prototype-provider.mjs`, `public-parent.test.mjs`: deterministic public-parent scenario and measurement scaffolding.

## Safety and interpretation

The harness uses a separate test-owned Herdr server, scratch HOME/configuration/socket, and a local deterministic provider. It does not use user model credentials or paid model calls. Keep experiments isolated; never aim stop/restart commands at the user's live Herdr socket.

Normal/error cleanup stops owned servers. Abruptly killing the driver can prevent cleanup; ownership manifests and server logs are retained in the printed scratch directory for recovery. Raw experimental results remain local under ignored `results/`; `MEASUREMENTS.json` preserves the non-sensitive summaries needed for the handoff.

CPU and latency scopes are explicit in the report. Do not treat detection latency as parent-model response latency, a subscription acknowledgement as lifecycle latency, or smoke/controller tests as persistent-lifecycle validation. Production integration, hardening, and independent review remain required after #32.

The package's npm ignore policy excludes `prototypes/`. The prototype branch is an evidence archive, not a release or production PR.
