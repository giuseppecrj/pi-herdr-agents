# Evaluate adversarial code review

This small corpus compares review strategies against known changes. It does not
measure the workflow runtime or establish that any strategy is optimal.

## Use the corpus

[`../test/evals/cases.public.json`](../test/evals/cases.public.json) contains
eight before/after source pairs. Case IDs (`case-NN`) and titles (`Scenario NN`)
are intentionally neutral. They are evaluator metadata, not reviewer input.

When you call a reviewer, send **only** these public fields:

```json
{
  "reviewTask": "...",
  "spec": "...",
  "source": { "path": "target.mjs", "before": "...", "after": "..." }
}
```

Do not send [`../test/evals/oracle.json`](../test/evals/oracle.json). It holds
private expected finding IDs, descriptions, rationales, and ground-truth
programs. The public validator rejects unknown public or source keys, including
`expectedFindingIds` and `label`, so labels cannot be added to reviewer input by
accident.

The corpus covers correctness, trust boundaries, lifecycle/concurrency, two
clean counterexamples, hostile instructions embedded in source, and missing
validation evidence. The limit contract explicitly clamps finite values outside
`1..100`; only non-finite values default to `20`.

The legacy prompt fixture,
[`../test/evals/legacy-adversarial-reviewer.md`](../test/evals/legacy-adversarial-reviewer.md),
is pinned text copied from `agents/adversarial-reviewer.md` when the corpus was
added. Keep it unchanged for historical comparisons.

Validate the corpus and run dependency-free self-tests. These commands require
Node.js 22.6.0 or later, which supports `--experimental-strip-types`:

```bash
node --experimental-strip-types test/evals/validate.mjs
node --experimental-strip-types --test test/evals/*.test.mjs
```

The validator imports each source version before it runs the ground-truth
program. A real-finding case must pass before and fail after with a Node
`AssertionError [ERR_ASSERTION]`. A clean case must pass in both versions.
Syntax errors, unintended throws, signals, timeouts, spawn errors, and other
non-assertion failures reject the corpus and retain child stdout/stderr in the
diagnostic. Each child has a three-second bound. These tests prove only the
included trigger, not the absence of every other defect.

`.npmignore` excludes `test/`, so fixtures do not enter the package preview.
`docs/review-evaluation.md` is intentional package documentation. If the
`test/` exclusion changes, add an explicit `test/evals/` exclusion before
publishing; this deliverable does not change packaging configuration.

## Score captured results

A human adjudicator maps each concrete reported issue to one private oracle ID
(`F01` through `F06`) only when it matches that finding's private description.
For each false positive, use a stable ID scoped to the case, such as
`case-06-fp-01`; retain a pointer to the raw report in the capture system. This
makes adjudication unambiguous without exact-prose matching or an LLM judge.

A result file declares the cases and trial IDs it intends to cover. Every
strategy uses the same plan. Trial IDs allow repeated trials while rejecting a
duplicate result for the same case/trial pair.

```json
{
  "version": 1,
  "plan": {
    "caseIds": ["case-01", "case-02", "case-06"],
    "trialIds": ["trial-01", "trial-02"]
  },
  "strategies": [
    {
      "name": "two-reviewers-plus-synthesis",
      "runs": [
        {
          "caseId": "case-01",
          "trialId": "trial-01",
          "complete": true,
          "findings": [{ "id": "F01", "disposition": "verified" }],
          "metrics": {
            "latencyMs": 12400,
            "inputTokens": 950,
            "outputTokens": 260,
            "totalTokens": 1210
          }
        }
      ]
    }
  ]
}
```

`plan.caseIds` must include at least one clean and one finding case.
`complete` means the captured reviewer output met its reporting/evidence
contract. It is not a candidate verdict. Findings use `verified`,
`false_positive`, or `unresolved` dispositions. Omit `metrics` when the
provider did not supply a value; do not infer or manufacture telemetry.

Run the scorer:

```bash
node --experimental-strip-types test/evals/score.mjs path/to/captured-results.json
```

For each strategy, the score includes:

- precision: verified claims divided by verified plus false-positive claims;
- recall over all planned finding opportunities, including omitted trials;
- `findings.verified`: reproducible, human-adjudicated findings;
- deduplicated unique verified and expected findings;
- clean-case false-positive rate over submitted clean runs (`null` when none are submitted);
- planned completeness and observed completeness; and
- coverage with omitted case/trial pairs, omitted cases, and submitted/omitted
  counts for clean and finding classes.

Metric summaries give observations, total, and mean only for supplied latency
or token values. Missing data remains missing. The scorer rejects malformed
metric arrays, invalid metrics, unknown verified IDs, duplicated oracle IDs,
and duplicated case/trial records.

## Compare strategies

Use the same public reviewer payload, exact models, tools, system prompts, and
adjudication contract for each strategy:

1. One fresh reviewer.
2. The textual legacy `3 Optimizer + 3 Skeptic + 1 synthesis` baseline.
3. The routine proposal: two fresh reviewers and one fresh synthesis pass.
4. The high-risk proposal: three lens reviewers, targeted cross-family
   verifier passes for high-risk claims, and one fresh synthesis pass.

The legacy fixture describes a theoretical offline `3+3+1` topology. It is not
a runnable baseline in the current spawned-coordinator lifecycle: child starts
are asynchronous, the coordinator lacks an adapter that awaits and gathers all
six reports before later stages, and `auto-exit` can end its turn. Do not claim
a runnable legacy result without that adapter. Label any measurement of the
fixture as an offline simulation.

Before tuning prompts, create a stratified split. This corpus uses
`case-01`, `case-02`, `case-04`, and `case-06` for tuning, and `case-03`,
`case-05`, `case-07`, and `case-08` for holdout. Each split has clean and
finding cases. Keep the holdout sealed until the prompt is selected.

For each split:

1. Pin exact model IDs and versions where available, reviewer/synthesizer
   prompts, tools, and public payloads.
2. Use the same trial IDs for every strategy and rotate strategy order inside
   each case/trial block.
3. Match **total** token budgets across strategies: sum all reviewer, verifier,
   and synthesis budgets. Per-reviewer budgets alone favor strategies that
   launch more calls. Report both the total budget and its allocation.
4. Preserve raw reviewer and synthesis outputs, timestamps, run IDs, and only
   provider-reported latency/token fields. Redact secrets before storage.
5. Blind the adjudicator to strategy name, score the captures, and report raw
   counts, coverage, and absent telemetry beside rates.
6. Evaluate the sealed holdout only after prompt selection. Treat it as an
   estimate for this corpus, not a general performance claim.

Actual model measurements require ordinary exact workflow preparation and user
approval. Prepare the workflow, show its approval packet, and wait for the
exact approval before starting it. This corpus does not authorize live models
or approved workflow execution.

## Evidence and limits

This procedure follows vendor guidance to define task-specific ground truth,
retain traces, and evaluate agent behavior end to end. See Anthropic's
[Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
and OpenAI's [agent evals guide](https://developers.openai.com/api/docs/guides/agent-evals).

Diverse passes are a hypothesis, not an independence guarantee. Kim et al.,
[Correlated Errors in Large Language Models](https://proceedings.mlr.press/v267/kim25e.html)
(ICML 2025) provides direct evidence that LLM errors can be correlated. It does
not measure this package or code review, so this corpus measures misses and
false positives instead of assuming provider or lens diversity solves them.
