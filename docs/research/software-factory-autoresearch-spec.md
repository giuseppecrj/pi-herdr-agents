# Software-factory autoresearch specification
**Status:** Research/specification draft for human review. This is not an approved implementation plan, shipped behavior, budget, or
authorization to run live experiments.

## 1. Purpose
This document proposes the smallest credible path from `pi-herdr-agents` to a software factory that can discover better orchestration
strategies through a measured loop. The factory should improve all three goals together:
1. **Autonomy:** progress from issue/specification to a contract-passing, reviewable candidate with no unplanned human intervention,
   while preserving explicit human publication gates. AI parent coordination and child questions are not human attention by themselves;
   autonomy is not merely “no questions.”
2. **Quality:** increase contract satisfaction, test/evaluator performance, review precision, safety, and evidence completeness; avoid
   trading these for speed.
3. **Efficiency:** reduce human attention, wall-clock time, and model spend for comparable accepted outcomes.
The recommendation is **evaluation-first**: add a disciplined research harness around existing Pi/Herdr primitives rather than rebuilding the
removed workflow engine. A future factory is an operating procedure and evidence contract, not a new scheduler, DAG, database, or automatic
merge system by default.
Options considered: restore the removed workflow engine (high control and high complexity/risk), add a new autonomous scheduler first (high
surface area before evidence), or evaluate current primitives first (lowest reversible cost, but initially manual). The third option is
recommended; planning/repair, routing, persistence, and parallelism are hypotheses to test rather than assumed improvements.

## 2. Factory definition and boundaries
A factory run is a bounded, reproducible attempt to transform an issue or specification into an **accepted candidate**:

```text
issue/spec -> task framing -> bounded child work -> candidate -> protected
 evaluation -> human decision -> recorded keep/reject -> optional publication
```

“Accepted” means a human (or a separately authorized policy) accepts the candidate for publication review. It does not mean automatically
integrated, committed, pushed, merged, deployed, or released. Human publication gates stay explicit at least at:
- scope and risk classification;
- source baseline, model/configuration, and experiment recipe;
- candidate acceptance and conflict resolution; and
- integration, publication, deployment, or release.
Research `keep` means “select this candidate as the current best recorded result.” It does not merge it. Rejected candidates and their
worktrees remain reviewable under the existing retention policy. The factory never silently retries until a favorable result, destroys a
checkout, resets destructive state, or pushes on a research decision.
A worktree is a Git isolation and review surface, **not a sandbox**. Child processes retain host permissions and may share objects, refs,
credentials, and network access. The experiment recipe must therefore state external connectivity and environment controls explicitly.

## 3. Current evidence and constraints
The current product already supplies useful factory primitives:
- asynchronous Pi children run exclusively through Herdr; completion is delivered to the parent, and callers do not poll
  (`../../README.md`);
- public review is parent-owned evidence pinning, fresh child fan-out, automatic completion delivery, and parent synthesis
  (`../../skills/orchestrate/SKILL.md`);
- worktree creation is opt-in, retained after success/failure/help, and never automatically pushed, merged, cherry-picked, or removed
  (`../worktree-subagents.md`);
- persistent specialists have policy-bound session generations and an append-only delivery ledger, not immortal processes
  (`../adr/0010-persistent-specialists-as-session-generations.md`);
- file wake-ups plus shared reconciliation reduce supervision overhead, while authoritative completion sidecars and bounded fallback
  preserve evidence (`../../pi-extension/subagents/wake.ts`, `../../pi-extension/subagents/completion.ts`);
- the current review corpus has eight public before/after cases, a private oracle, repeated trial IDs, omission-aware coverage, and
  missing-telemetry preservation (`../review-evaluation.md`, `../../test/evals/score.mjs`);
- the existing eight cases cover correctness, trust boundaries, lifecycle/concurrency, clean changes, hostile source instructions, and
  validation evidence, but they are a review micro-corpus, not a software factory benchmark.
ADR-0009 is the governing decision: the old workflow subsystem, Worker, approval packet, runner journal, private review topology, and
workflow API were removed (`../adr/0009-remove-workflow-subsystem.md`). Any wording in `docs/review-evaluation.md` that describes an
obsolete approval-packet workflow is superseded by ADR-0009; this specification does not recreate that API.

## Autoresearch transfer map
The primary sources are [autoresearch README](https://raw.githubusercontent.com/karpathy/autoresearch/master/README.md), which separates
fixed `prepare.py` evaluation, editable `train.py`, and human `program.md` guidance; its fixed training window is five minutes excluding
startup and its outcome is `val_bpb`. [autoresearch program](https://raw.githubusercontent.com/karpathy/autoresearch/master/program.md)
describes a baseline, `results.tsv`, an unbounded campaign of fixed-duration training trials, Git commits/reset, and a simpler-is-better criterion. [Demystifying evals for AI
agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) supplies the task/trial/graded-outcome distinction,
repeated trials, and code/model/human graders.

Transfer to this project: the evaluator/oracle is the fixed evaluation surface; the candidate recipe is the editable program; the human
owns task selection, guidance, and publication; and each run appends provenance/results rather than relying on a narrative transcript.
Baseline measurement and the simpler-is-better preference transfer; bounded campaigns, paired software trials, and retained worktrees are our adaptations. Do **not**
transfer an infinite loop, automatic commits or resets, a single scalar objective, disabled permissions, or treating crashes as zero. This
project requires explicit caps, human gates, multiobjective decisions, ordinary host-permission disclosure, and failure attribution.

## 4. Proposed architecture: two loops

### 4.1 Production loop
The production loop handles a real issue or requested change:
1. Capture the issue, acceptance criteria, risk, repository identity, and human scope decision.
2. Select a bounded task recipe from the current approved configuration.
3. Launch ordinary or worktree children through existing public primitives.
4. Receive automatic completion messages; do not ask anyone to sleep, tail sessions, poll, or repeatedly check status.
5. Inspect the candidate's diff, tests, worktree handoff, and evidence.
6. Run the protected evaluation and record pass, fail, or inconclusive.
7. Ask the human to keep/reject/modify the candidate; only a separate explicit gate may integrate or publish it.
This loop optimizes delivery for a known task. Its policy and evaluator are immutable during a trial.

### 4.2 Research/meta loop
The research loop learns which production recipe to use:

```text
hypothesis -> bounded mutation -> paired trial -> protected evaluation ->
 decision/evidence -> next experiment
```

A mutation can change an allowlisted prompt, role topology, model route, planning/repair policy, persistence use, or bounded parallelism. It
cannot change the evaluator oracle, protected holdout, provenance rules, safety floors, or publication boundary. The meta loop proposes the
next experiment only from recorded evidence. A human reviews the recipe and promotion decision; automatic integration is out of scope.
Research and production artifacts must be distinguishable. A production candidate is a possible software change. A research candidate is a
recipe variant. Never let a recipe variant rewrite the evaluator or label its own outcome.

## 5. Multiobjective decision model
Represent each recipe by an objective vector, not one hidden weighted score:

```text
(Q, A, H, W, C) =
(quality, autonomous acceptance, human attention, wall time, model cost)
```

Higher `Q` and `A` are better; lower `H`, `W`, and `C` are better. Report the raw components, denominators, missing observations, and
uncertainty. A recipe is Pareto-dominated when another recipe is no worse in every component and strictly better in at least one. Maintain a
frontier rather than collapsing tradeoffs into an unreviewable scalar.
**Quality** is a vector itself: task contract pass rate, protected test/eval pass rate, review precision/recall where an oracle exists,
safety violations, and evidence completeness. The primary quality denominator is **all scheduled trials**, including trials that fail, exhaust retries, or remain incomplete.
Retries do not add denominator entries; infrastructure-attributed conditional quality is supplementary, never a replacement denominator. A task's contract outcome remains
a valid binary metric, not a demand for a continuous score. **Autonomous acceptance** is the fraction of scheduled trials that reach the
contract and human acceptance criteria without an unplanned human intervention, manual repair, or evaluator exception. It is not “number of
tool calls”; AI parent coordination is not human attention.
**Human attention** is active human work: minutes spent reading, deciding, answering a child, adjudicating an ambiguity, inspecting a diff,
and approving or rejecting. Record approval time separately. Queue elapsed time while a human is away, waiting for a child, or waiting for a
scheduled review is not human attention, though it is wall time. **Wall time** runs from authorized start to terminal evidence (including
queue delay). **Model cost** uses provider-billed cost when available; observed token usage, estimates, and billed cost are separate fields,
and unknown cost remains unknown, never zero.
Efficiency is reported over **all scheduled trials**, including failures and retries: total spend, elapsed time, and active human attention
divided by accepted outcomes, plus per-attempt distributions. With zero accepted outcomes, cost/time/attention per accepted outcome is
undefined, not efficient. This prevents success-only bias and all-reject gaming.
Hard floors precede Pareto comparison. Illustrative defaults for a first manual experiment (not approved thresholds) are: no known
safety-policy violation, no protected-oracle tampering, complete provenance, and nonzero evaluation coverage; task-specific quality and
reliability floors must be declared before running. A result below a floor is rejected or inconclusive regardless of speed, autonomy, or
apparent cost savings.
Humans explicitly choose among frontier points, for example “accept 2 minutes more wall time for fewer high-severity misses.” That tradeoff
is recorded as a decision and rationale, not hidden in weights. No threshold here is calibrated or an authorization to spend money.

## 6. Anti-gaming and validity controls
The factory must reject or flag these strategies:
- **Easy-task selection:** use a fixed, stratified task schedule; never choose tasks after seeing recipe performance, and report every
  scheduled task.
- **All-reject or zero-success efficiency gaming:** efficiency aggregates total spend, time, and attention across every scheduled trial,
  failure, and retry, then divides by accepted outcomes. With zero accepted outcomes, the ratio is undefined and cannot support an
  efficiency claim.
- **Cherry-picked retries:** predeclare attempt counts, retry semantics, and strategy order. Retries are distinct attempts with unique attempt IDs inside the same scheduled trial; do not
  discard failures or turn retries into extra successful trials.
- **Missing telemetry as zero:** absent latency, token, cost, attention, or approval fields stay `unknown`; they reduce completeness and can
  make a result inconclusive.
- **Model drift:** pin exact provider/model IDs, available version metadata, prompts, tools, thinking level, and catalog provenance. Rerun a
  calibration slice when a provider version or routing behavior changes; compare campaigns only with disclosed drift.
- **Holdout leakage:** keep campaign-bound holdouts sealed until recipe selection; never use holdout observations to tune prompts or routes.
- **Benchmark overfitting:** expand beyond the eight-case micro-corpus, rotate representative strata, and treat any holdout result as
  corpus/campaign-specific rather than a general capability claim.
- **Evaluator tampering:** evaluator code, oracle, scoring rules, task labels, and protected holdout are immutable inputs. Reviewers receive
  only public fields; private expected findings never enter child prompts.
- **Selective completion:** infrastructure failures, provider failures, child failures, malformed output, missing evidence, and task
  failures are all retained and attributed; omission is not success.

## 7. Task corpus and evaluation design
The current eight-case review corpus remains a deterministic smoke/evaluation fixture. Do not tune solely on it. Build a larger fixed corpus
with strata such as:
| Stratum | Examples to add |
| --- | --- |
| Small correctness | parser, state transition, API edge case with executable oracle |
| Security/trust | authorization, path handling, secret or prompt-injection boundary |
| Lifecycle/concurrency | cancellation, duplicate dispatch, completion race, restart |
| Repository change | multi-file feature with tests, docs, and migration constraints |
| Maintenance | bug fix with regression test and compatibility requirement |
| Review/acceptance | candidate claims requiring evidence, test output, and diff inspection |
| Operational | worktree handoff, failed child, unavailable telemetry, recovery |
Use real engineering tasks from representative repositories or sanitized local issues, not only toy source pairs. Each task needs an
issue/spec, immutable acceptance criteria, task stratum, baseline commit, expected environment, and an evaluator appropriate to its risk.
Separate deterministic infrastructure checks (manifest validity, one-shot dispatch, no duplicate task IDs, sidecar reconciliation,
protected-file integrity) from live outcome evaluation (actual model-generated patch quality and human acceptance).
Maintain train/dev/holdout splits. Train is for developing task schemas and instrumentation. Dev is for selecting prompts, topology, and
routing within a campaign. Holdout is campaign-bound, sealed before tuning, evaluated once (or under a predeclared repeated-trial plan)
after selection, and not reused for adaptive tuning. Include clean and defect-bearing tasks in every relevant stratum. A holdout result
estimates this corpus/campaign; it is not a general capability claim.
Protection must be enforceable, not prompt-only: grading runs outside candidate-writable authority; the held-out oracle is unavailable to
children; and a candidate touching protected evaluator/oracle files is rejected. Before autonomous mutation, use a dedicated sandbox/account
or container with no writable host mounts or credentials and controlled egress/process authority. The manual trusted pilot below is not
adversarially isolated. The repo-tracked `test/evals/oracle.json` is accessible to the checkout and therefore is not a secret or novel
holdout; a fresh external holdout is required for holdout claims. Candidates may add product tests, but may not alter the trusted acceptance
grader, oracle, scorer, or protected test inputs.

## 8. Controlled experiment protocol
The counting hierarchy is: **campaign → scheduled trial → attempt → child dispatch**. A trial is one task × recipe × replica slot;
`runId` identifies its execution record, and paired slots share a `pairId`. A retry is another attempt within that fixed trial, never a new
trial. Each attempt may dispatch a worker and reviewer; each actual launch has its own dispatch ID. Count each trial at most once as
accepted, include every attempt's resource use, and report first-attempt success separately from success within the retry allowance.

Every experiment is a paired comparison against a source baseline. Pairing means the same task IDs, replica-block keys (`pairId`), acceptance criteria,
environment class, total budget, and evaluator are used for every compared recipe; each recipe has distinct trial IDs. Rotate recipe order within task/trial blocks where order
can affect external conditions.
A bounded trial declares:
- task stratum and exact task IDs;
- total model-token/time/cost budget and allocation across children;
- maximum attempts, child count, concurrency, and wall-time deadline;
- whether a retry is permitted and what evidence makes it eligible;
- deterministic infrastructure checks and live outcome evaluator;
- human attention/approval capture method;
- stop conditions and inconclusive policy.
Initial A/A instrumentation pilot (not approved live spend) is deliberately fixed: three dev tasks—a representative bug fix,
multi-file feature, and lifecycle/concurrency fix—with two replicas each (six runs). Both arms are identical fresh-session baselines:
one worker plus the same cross-family reviewer, source baseline, configuration, evaluator, and total budget. Measure completion, delivery ledger,
unknown-data, and reconciliation gates; do not claim statistical superiority from this pilot. Assign replicas A1/A2 to each task: three pairs, six runs total. Every planned child dispatch must be accounted for exactly once;
each trial needs one terminal outcome, a complete manifest, and no unexplained unknowns before the next budget request.
After that gate, seek approval for the exact A/B variant: three tasks × two replica blocks × two recipes = twelve scheduled trials,
baseline versus one bounded plan→implement→repair pass, with the same total budget and randomized arm order. The pilot only validates instrumentation and feasibility;
larger confirmation sampling is planned after its results. Counts and caps here are proposed defaults, never authorization.

### 8.1 Required experiment recipe
A selected recipe is invalid unless it names:
1. thresholds and hard quality/safety floors, including “unknown/inconclusive” handling;
2. total spend/time/attempt caps (proposed values are not authorization);
3. exact source baseline commit and repository identity;
4. exact configuration, prompt versions, tool allowlists, role definitions, thinking levels, and model identity/version/catalog source;
5. evaluator identity, oracle version, scorer version, and sealed split;
6. mutable allowlist and an immutable evaluator/oracle checksum;
7. controlled external connectivity, environment image/versions, secrets policy, clock/locale assumptions, and worktree location;
8. task schedule, stratification, trial IDs, randomization/seed policy, and retry policy; and
9. human decision owner, attention/approval recording method, stop authority, and publication gate.
Mutable changes are limited to declared recipe inputs. Evaluators, oracle, holdout membership, provenance capture, and safety floors are
immutable.

### 8.2 Decision procedure
Before an A/B run, preregister practical non-inferiority margins for every reported metric and absolute quality/safety floors. Compare
paired task-level differences and report uncertainty clustered by task; two replicas provide no guaranteed confidence. Promote only when the
variant is stably no worse on every required dimension and shows a meaningful improvement on a declared dimension. Otherwise record
`inconclusive` or stop at the budget boundary. Unknown cost cannot justify cost superiority or cost non-inferiority. A human may select a documented frontier tradeoff for a limited pilot,
but that is not evidence of improvement across all dimensions. A larger confirmation sample and its budget must
be planned from the pilot, not retrofitted after seeing results.

## 9. Minimum run manifest and result schema
The following is a minimum logical schema; exact storage may remain JSONL files beside existing session artifacts in the first experiment.
It is not a request for a database.

```json
{
  "schemaVersion": 1,
  "campaignId": "...",
  "runId": "...",
  "recipeId": "...",
  "source": { "repository": "...", "baselineSha": "...", "baselineRecipeHash": "..." },
  "recipe": { "hash": "...", "mutableAllowlistHash": "..." },
  "task": { "id": "...", "stratum": "...", "splitId": "...", "corpusFingerprint": "...", "scheduleFingerprint": "..." },
  "trialId": "...",
  "pairId": "...",
  "stages": [{ "name": "worker|reviewer|evaluator", "provider": "...", "modelId": "...", "configHash": "...", "sessionIds": [],
    "observedTokens": { "input": null, "output": null }, "billedCost": null, "estimatedCost": null,
    "currency": null, "pricingSource": null, "costKind": "provider-reported|estimate|unknown" }],
  "budget": { "tokenCap": null, "timeCapMs": null, "costCap": null, "attemptCap": 1 },
  "attempts": [{ "attemptId": "...", "number": 1, "retryOf": null, "reason": null, "dispatchIds": [] }],
  "evaluator": { "id": "...", "version": "...", "oracleSha": "...", "scorerSha": "..." },
  "events": [],
  "outcome": "accepted|rejected|failed|inconclusive",
  "researchDecision": { "action": "keep|reject|modify|inconclusive|not-applicable", "recipeHash": null, "rationale": null },
  "attribution": "infrastructure|task|mixed|unknown",
  "metrics": { "quality": { "contractPass": null, "protectedChecksPass": null, "reviewVerified": null,
    "reviewFalsePositive": null, "reviewExpected": null, "safetyViolations": null, "evidenceComplete": null },
    "autonomy": null, "humanMinutes": null, "approvalMinutes": null, "wallMs": null, "modelCost": null },
  "provenance": { "startedAt": "...", "endedAt": "...", "parentSession": "...", "worktree": "..." },
  "evidence": { "candidateHeadSha": null, "diffSha": null, "immutablePointers": [], "artifacts": [] }
}
```

`outcome` records trial acceptance: `accepted` requires the protected checks and human acceptance criteria; `failed` is an execution failure,
`rejected` is an evaluated non-acceptance, and `inconclusive` means insufficient evidence. `researchDecision` separately records recipe
selection, never publication authorization. `modify` proposes a new recipe/trial; it cannot relabel or overwrite the current result.
Quality fields retain per-trial booleans and raw finding counts; aggregate pass rates and review precision/recall use explicit denominators.
`events` must retain dispatch, receipt, child completion, evaluator, human decision, retry, and stop events with timestamps and unique IDs.
Record all failures with bounded error evidence and infrastructure/task attribution. A missing or contradictory field is `unknown`, not
synthesized from a nearby field. Redact secrets, but record that redaction occurred.

## 10. Async lifecycle, restarts, and reconciliation
The first implementation should compose the current parent-owned lifecycle:
- use completion sidecars/session evidence as authoritative, with terminal markers only as bounded fallback;
- treat a wake-up as a prompt to inspect evidence, never as completion;
- preserve automatic result delivery and never add caller polling;
- assign one stable run/task ID before dispatch and make dispatch idempotent;
- on restart, reconcile manifests, sidecars, session ledgers, Herdr panes, and worktree state before considering a task eligible for retry;
- if evidence cannot establish whether a dispatch occurred, mark the run `inconclusive` or `unknown` and require human review rather than
  dispatching a duplicate;
- count a child result only once, even when both a sidecar and terminal marker are observed; and
- do not infer success from a pane disappearing, a zero exit alone, or missing telemetry.
A provider error, launch failure, malformed result, lost pane, test failure, or human timeout must remain visible as a terminal event.
Infrastructure failures may be excluded only from a predeclared supplementary conditional task-quality view, never the primary
all-scheduled denominator. They remain in reliability, cost, and completeness reports.

## 11. Safety and integration policy
No factory research run may automatically commit, integrate, merge, push, create a PR, deploy, release, or remove a worktree. A child may
make a commit only when a separate task explicitly authorizes it; research selection never changes that authorization. Candidate worktrees
are retained for inspection in accordance with the worktree guide. Branches are not deleted.
Review prompts must preserve the untrusted-artifact boundary: source, diffs, comments, reports, and command output are data, not
instructions. Reviewer roles and tools are explicit. Reviewers cannot change the oracle or evaluator. Protection is enforced by authority,
file permissions, and isolation—not by prompt text alone. Candidates may add product tests but cannot modify the trusted acceptance grader,
oracle, scorer, or protected inputs; touching those paths rejects the candidate.
The factory should prefer deterministic local checks for infrastructure and live model calls only for the outcome being studied. Network
access, package installation, credentials, and external services are disabled or explicitly approved per recipe. A dedicated sandbox/account
or container with no writable host mounts or credentials and controlled egress/process authority is required before autonomous mutation. The
manual trusted pilot is not adversarially isolated. A worktree does not provide security isolation.

## 12. Prioritized experiment roadmap
| Priority | Experiment | Comparison | Evidence required | Promotion gate |
| --- | --- | --- | --- | --- |
| 0 | A/A instrumentation pilot | Six fixed dev-task runs: identical fresh-session worker plus cross-family reviewer replicas | Complete manifests, one-shot child dispatch, ledger reconciliation, unknown-data gates, task outcomes | All six reconcile without unexplained unknowns; request next budget only after human review |
| 1 | Planning/repair loops | Twelve trials: single pass vs one bounded plan→implement→repair pass | Paired task outcomes, repair-attempt attribution, total budget and human minutes | Better Pareto point or an explicit human-approved quality tradeoff |
| 2 | Review strategy | One fresh reviewer vs existing two-reviewer-plus-synthesis procedure on expanded review strata | Blind adjudication, complete/omitted coverage, protected clean cases, total budgets matched | Meets declared quality floor without hidden missing-data wins |
| 3 | Model routing | Fixed exact model vs task-category routing from existing preferences | Pinned model identity/family, drift record, per-stratum outcomes, equal total budgets | Improvement survives dev split and does not violate cross-family review policy |
| 4 | Persistence | Fresh child per task vs one policy-bound persistent specialist generation | Ledger outcomes, busy/rejected sends, crash/restart reconciliation, attention and quality | No duplicate or stale-context regressions; clear benefit on sequential tasks |
| 5 | Parallelism | Sequential baseline vs bounded independent fan-out | Queue/wall-time and attention separation, shared-resource failures, paired quality | Only promote if wall/attention benefit survives fixed total budget and safety floors |
The first experiment must be small enough to run manually with the existing `subagent`, worktree, completion, and review-evaluation seams.
Do not build a scheduler, DAG, database, or automatic optimizer before this evidence exists. Parallelism is deliberately last: speed without
measured quality and reconciliation evidence is not factory progress.

## 13. Stop conditions, success, and staged promotion
Stop a run immediately for evaluator/oracle mutation, unbounded spend/time, secret exposure, destructive external effect, duplicate dispatch
uncertainty, source/baseline drift, or a known safety-policy violation. Stop a campaign for repeated infrastructure incompleteness, model
identity drift, holdout leakage, or a result that cannot distinguish task failures from harness failures.
A recipe can be called promising only when all of the following are evidenced:
- every scheduled task/trial has a terminal record or an explicit omission;
- protected evaluator and oracle checksums match the recipe;
- quality and safety floors pass, with uncertainty and practical margin reported rather than implied;
- no zero-success or all-reject result is presented as efficient;
- total budgets and retry counts are comparable across recipes;
- the result is not driven by holdout tuning or cherry-picked tasks;
- autonomy, human attention, wall time, and model cost are all reported (or marked unknown); and
- the candidate is retained and a human records keep/reject/inconclusive.
Promotion stages are: **instrumented dry run** (deterministic seams only), **train/dev manual comparison**, **sealed holdout confirmation**,
**limited production pilot with a human publication gate**, and only then a proposal for productization. Each stage requires a written human
decision and measurable gates from the preceding stage; this draft does not set those gates.

## 14. Open research questions
- Which real engineering task strata best predict accepted repository changes?
- How should practical margins be estimated when trials are few and outcomes are correlated by model, task, and reviewer?
- What minimum human decision record is sufficient without turning the factory into the removed workflow engine?
- Which telemetry can be captured from existing Pi/Herdr seams without changing child behavior or exposing provider secrets?
- When should a persistent specialist be stopped for capability drift rather than reused, and how should a fresh generation be compared?
- How should humans choose between Pareto points when quality dimensions conflict, while keeping the tradeoff visible and reversible?

## 15. Sources and contracts
The proposed transfer is grounded in these verified primary sources and repository contracts. “Autoresearch-inspired” refers only to the
bounded hypothesis/evaluation loop; the non-transfer rules above are part of this specification.
- [autoresearch README](https://raw.githubusercontent.com/karpathy/autoresearch/master/README.md)
- [autoresearch program](https://raw.githubusercontent.com/karpathy/autoresearch/master/program.md)
- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [README](../../README.md)
- [Domain glossary](../../CONTEXT.md)
- [Documentation map](../README.md)
- [ADR-0009: remove workflow subsystem](../adr/0009-remove-workflow-subsystem.md)
- [ADR-0010: persistent session generations](../adr/0010-persistent-specialists-as-session-generations.md)
- [Worktree operating guide](../worktree-subagents.md)
- [Review evaluation contract](../review-evaluation.md)
- [Public review skill](../../skills/orchestrate/SKILL.md)
- [Adversarial review procedure](../../skills/orchestrate/adversarial-review.md)
- [Public review cases](../../test/evals/cases.public.json)
- [Evaluation scorer](../../test/evals/score.mjs)
- [Completion evidence seam](../../pi-extension/subagents/completion.ts)
- [Wake/reconciliation seam](../../pi-extension/subagents/wake.ts)
- [Launch/worktree seam](../../pi-extension/subagents/launch.ts)
