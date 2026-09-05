import assert from "node:assert/strict";
import test from "node:test";

import { score } from "./score.mjs";

const oracle = {
	version: 1,
	cases: [
		{ id: "case-01", expectedFindingIds: ["F01"] },
		{ id: "case-02", expectedFindingIds: [] },
	],
};

function results(runs, trialIds = ["trial-01"]) {
	return {
		version: 1,
		plan: { caseIds: ["case-01", "case-02"], trialIds },
		strategies: [{ name: "routine", runs }],
	};
}

test("deduplicates repeated adjudications and reports planned coverage", () => {
	const result = score(
		results([
			{
				caseId: "case-01",
				trialId: "trial-01",
				complete: true,
				findings: [
					{ id: "F01", disposition: "verified" },
					{ id: "F01", disposition: "verified" },
				],
				metrics: { latencyMs: 10 },
			},
			{
				caseId: "case-02",
				trialId: "trial-01",
				complete: false,
				findings: [{ id: "case-02-fp-01", disposition: "false_positive" }],
			},
		]),
		oracle,
	).strategies[0];

	assert.equal(result.findings.verified, 1);
	assert.equal(result.findings.uniqueVerified, 1);
	assert.equal(result.precision, 0.5);
	assert.equal(result.recall, 1);
	assert.equal(result.completeness, 0.5);
	assert.equal(result.observedCompleteness, 0.5);
	assert.equal(result.cleanCaseFalsePositiveRate, 1);
	assert.deepEqual(result.coverage, {
		expectedRuns: 2,
		submittedRuns: 2,
		omittedCases: [],
		omittedCaseTrials: [],
		classes: {
			clean: { expectedRuns: 1, submittedRuns: 1, omittedRuns: 0 },
			finding: { expectedRuns: 1, submittedRuns: 1, omittedRuns: 0 },
		},
	});
	assert.deepEqual(result.metrics.latencyMs, {
		observations: 1,
		runs: 2,
		total: 10,
		mean: 10,
	});
	assert.deepEqual(result.metrics.inputTokens, { observations: 0, runs: 2 });
});

test("counts omitted planned runs in recall and completeness", () => {
	const result = score(
		results([
			{
				caseId: "case-01",
				trialId: "trial-01",
				complete: true,
				findings: [],
			},
		]),
		oracle,
	).strategies[0];

	assert.equal(result.recall, 0);
	assert.equal(result.completeness, 0.5);
	assert.equal(result.observedCompleteness, 1);
	assert.equal(result.cleanCaseFalsePositiveRate, null);
	assert.deepEqual(result.coverage.omittedCases, ["case-02"]);
	assert.deepEqual(result.coverage.omittedCaseTrials, [
		{ caseId: "case-02", trialId: "trial-01" },
	]);
});

test("uses submitted clean runs for false-positive rate while reporting omissions", () => {
	const result = score(
		results(
			[
				{
					caseId: "case-01",
					trialId: "trial-01",
					complete: true,
					findings: [],
				},
				{
					caseId: "case-01",
					trialId: "trial-02",
					complete: true,
					findings: [],
				},
				{
					caseId: "case-02",
					trialId: "trial-01",
					complete: true,
					findings: [{ id: "case-02-fp-01", disposition: "false_positive" }],
				},
			],
			["trial-01", "trial-02"],
		),
		oracle,
	).strategies[0];

	assert.equal(result.cleanCaseFalsePositiveRate, 1);
	assert.deepEqual(result.coverage.classes.clean, {
		expectedRuns: 2,
		submittedRuns: 1,
		omittedRuns: 1,
	});
});

test("rejects malformed metrics, duplicate trials, and unadjudicated verified findings", () => {
	assert.throws(
		() =>
			score(
				results([
					{
						caseId: "case-01",
						trialId: "trial-01",
						complete: true,
						findings: [],
						metrics: [],
					},
				]),
				oracle,
			),
		/non-array object/,
	);
	assert.throws(
		() =>
			score(
				results([
					{
						caseId: "case-01",
						trialId: "trial-01",
						complete: true,
						findings: [],
						metrics: { costUsd: 1 },
					},
				]),
				oracle,
			),
		/unsupported metric costUsd/,
	);
	assert.throws(
		() =>
			score(
				results([
					{
						caseId: "case-01",
						trialId: "trial-01",
						complete: true,
						findings: [],
					},
					{
						caseId: "case-01",
						trialId: "trial-01",
						complete: true,
						findings: [],
					},
				]),
				oracle,
			),
		/duplicate case\/trial run/,
	);
	assert.throws(
		() =>
			score(
				results([
					{
						caseId: "case-01",
						trialId: "trial-01",
						complete: true,
						findings: [{ id: "F99", disposition: "verified" }],
					},
				]),
				oracle,
			),
		/unknown finding F99/,
	);
});
