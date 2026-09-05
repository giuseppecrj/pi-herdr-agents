import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
	isBoolean,
	isFiniteNumber,
	isPlainObject,
	isString,
} from "../../pi-extension/subagents/type-guards.ts";

const metricNames = ["latencyMs", "inputTokens", "outputTokens", "totalTokens"];
const dispositions = new Set(["verified", "false_positive", "unresolved"]);

export async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

function requireObject(value, label) {
	if (!isPlainObject(value)) {
		throw new Error(`${label} must be an object`);
	}
}

function requireExactKeys(value, allowed, label) {
	requireObject(value, label);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${label} has unknown key ${key}`);
	}
	for (const key of allowed) {
		if (!(key in value)) throw new Error(`${label} is missing key ${key}`);
	}
}

function requireUniqueStrings(values, label) {
	if (!Array.isArray(values) || values.some((value) => !isString(value))) {
		throw new Error(`${label} must be an array of strings`);
	}
	if (new Set(values).size !== values.length)
		throw new Error(`${label} has duplicates`);
}

export function indexOracle(oracle) {
	if (!oracle || oracle.version !== 1 || !Array.isArray(oracle.cases)) {
		throw new Error("oracle must be a version 1 object with a cases array");
	}

	const cases = new Map();
	const findingIds = new Set();
	for (const entry of oracle.cases) {
		if (
			!isPlainObject(entry) ||
			!isString(entry.id) ||
			!Array.isArray(entry.expectedFindingIds)
		) {
			throw new Error(
				"each oracle case needs an id and expectedFindingIds array",
			);
		}
		if (cases.has(entry.id))
			throw new Error(`duplicate oracle case: ${entry.id}`);
		requireUniqueStrings(
			entry.expectedFindingIds,
			`${entry.id} expectedFindingIds`,
		);
		for (const findingId of entry.expectedFindingIds) {
			if (findingIds.has(findingId))
				throw new Error(`duplicate oracle finding ID ${findingId}`);
			findingIds.add(findingId);
		}
		cases.set(entry.id, new Set(entry.expectedFindingIds));
	}
	return cases;
}

function metricSummary(values, runCount) {
	if (values.length === 0) return { observations: 0, runs: runCount };
	const total = values.reduce((sum, value) => sum + value, 0);
	return {
		observations: values.length,
		runs: runCount,
		total,
		mean: total / values.length,
	};
}

function validatePlan(plan, cases) {
	requireExactKeys(plan, new Set(["caseIds", "trialIds"]), "plan");
	requireUniqueStrings(plan.caseIds, "plan caseIds");
	requireUniqueStrings(plan.trialIds, "plan trialIds");
	if (plan.caseIds.length === 0 || plan.trialIds.length === 0) {
		throw new Error("plan caseIds and trialIds must not be empty");
	}
	for (const caseId of plan.caseIds) {
		if (!cases.has(caseId))
			throw new Error(`plan has unknown caseId ${caseId}`);
	}
	const classes = new Set(
		plan.caseIds.map((caseId) =>
			cases.get(caseId).size === 0 ? "clean" : "finding",
		),
	);
	if (classes.size !== 2)
		throw new Error(
			"plan must include at least one clean and one finding case",
		);
	return classes;
}

function validateRun(run, cases, planCaseIds, planTrialIds) {
	requireObject(run, "run");
	for (const key of Object.keys(run)) {
		if (
			!new Set(["caseId", "trialId", "complete", "findings", "metrics"]).has(
				key,
			)
		) {
			throw new Error(`run has unknown key ${key}`);
		}
	}
	for (const key of ["caseId", "trialId", "complete", "findings"]) {
		if (!(key in run)) throw new Error(`run is missing key ${key}`);
	}
	if (!isString(run.caseId) || !cases.has(run.caseId)) {
		throw new Error(`run has an unknown caseId: ${run.caseId}`);
	}
	if (!planCaseIds.has(run.caseId))
		throw new Error(`run caseId is not in the plan: ${run.caseId}`);
	if (!isString(run.trialId) || !planTrialIds.has(run.trialId)) {
		throw new Error(`run has a trialId outside the plan: ${run.trialId}`);
	}
	if (!isBoolean(run.complete)) {
		throw new Error(
			`run ${run.caseId}/${run.trialId} must include complete: true or false`,
		);
	}
	if (!Array.isArray(run.findings)) {
		throw new Error(
			`run ${run.caseId}/${run.trialId} must include a findings array`,
		);
	}
	if (run.metrics !== undefined && !isPlainObject(run.metrics)) {
		throw new Error(
			`run ${run.caseId}/${run.trialId} metrics must be a non-array object when supplied`,
		);
	}
	for (const name of Object.keys(run.metrics ?? {})) {
		if (!metricNames.includes(name)) {
			throw new Error(
				`run ${run.caseId}/${run.trialId} has unsupported metric ${name}`,
			);
		}
	}

	const claims = new Map();
	for (const finding of run.findings) {
		requireExactKeys(finding, new Set(["id", "disposition"]), "finding");
		if (!isString(finding.id) || !dispositions.has(finding.disposition)) {
			throw new Error(
				`run ${run.caseId}/${run.trialId} has an invalid finding`,
			);
		}
		const previous = claims.get(finding.id);
		if (previous && previous !== finding.disposition) {
			throw new Error(
				`run ${run.caseId}/${run.trialId} assigns conflicting dispositions to ${finding.id}`,
			);
		}
		claims.set(finding.id, finding.disposition);
	}

	const expected = cases.get(run.caseId);
	for (const [id, disposition] of claims) {
		if (disposition === "verified" && !expected.has(id)) {
			throw new Error(
				`run ${run.caseId}/${run.trialId} verifies unknown finding ${id}`,
			);
		}
	}
	return claims;
}

function coverageFor(plan, cases, seenRuns) {
	const omittedCaseTrials = [];
	const omittedCases = new Set();
	const classes = {
		clean: { expectedRuns: 0, submittedRuns: 0, omittedRuns: 0 },
		finding: { expectedRuns: 0, submittedRuns: 0, omittedRuns: 0 },
	};
	for (const caseId of plan.caseIds) {
		const className = cases.get(caseId).size === 0 ? "clean" : "finding";
		for (const trialId of plan.trialIds) {
			classes[className].expectedRuns += 1;
			if (seenRuns.has(`${caseId}\u0000${trialId}`)) {
				classes[className].submittedRuns += 1;
			} else {
				classes[className].omittedRuns += 1;
				omittedCases.add(caseId);
				omittedCaseTrials.push({ caseId, trialId });
			}
		}
	}
	return {
		expectedRuns: plan.caseIds.length * plan.trialIds.length,
		submittedRuns: seenRuns.size,
		omittedCases: [...omittedCases],
		omittedCaseTrials,
		classes,
	};
}

export function summarizeStrategy(strategy, oracleCases, plan) {
	requireExactKeys(strategy, new Set(["name", "runs"]), "strategy");
	if (!isString(strategy.name) || !Array.isArray(strategy.runs)) {
		throw new Error("each strategy needs a name and runs array");
	}
	const planCaseIds = new Set(plan.caseIds);
	const planTrialIds = new Set(plan.trialIds);
	const metrics = Object.fromEntries(metricNames.map((name) => [name, []]));
	const uniqueExpected = new Set(
		plan.caseIds.flatMap((caseId) =>
			[...oracleCases.get(caseId)].map((findingId) => `${caseId}:${findingId}`),
		),
	);
	const uniqueVerified = new Set();
	const seenRuns = new Set();
	let completeRuns = 0;
	let verifiedOccurrences = 0;
	let reportedClaims = 0;
	let falsePositiveClaims = 0;
	let unresolvedClaims = 0;
	let cleanRunsWithFalsePositives = 0;

	for (const run of strategy.runs) {
		const runKey = `${run?.caseId}\u0000${run?.trialId}`;
		if (seenRuns.has(runKey))
			throw new Error(
				`duplicate case/trial run ${run?.caseId}/${run?.trialId}`,
			);
		const claims = validateRun(run, oracleCases, planCaseIds, planTrialIds);
		seenRuns.add(runKey);
		const expected = oracleCases.get(run.caseId);
		if (run.complete) completeRuns += 1;

		let runFalsePositives = 0;
		for (const [id, disposition] of claims) {
			if (disposition === "verified") {
				verifiedOccurrences += 1;
				reportedClaims += 1;
				uniqueVerified.add(`${run.caseId}:${id}`);
			} else if (disposition === "false_positive") {
				falsePositiveClaims += 1;
				reportedClaims += 1;
				runFalsePositives += 1;
			} else {
				unresolvedClaims += 1;
			}
		}
		if (expected.size === 0 && runFalsePositives > 0)
			cleanRunsWithFalsePositives += 1;

		for (const name of metricNames) {
			const value = run.metrics?.[name];
			if (value === undefined) continue;
			if (!isFiniteNumber(value) || value < 0) {
				throw new Error(`run ${run.caseId}/${run.trialId} has invalid ${name}`);
			}
			metrics[name].push(value);
		}
	}

	const coverage = coverageFor(plan, oracleCases, seenRuns);
	const expectedOpportunities =
		plan.caseIds.reduce(
			(total, caseId) => total + oracleCases.get(caseId).size,
			0,
		) * plan.trialIds.length;
	return {
		strategy: strategy.name,
		runs: coverage.submittedRuns,
		coverage,
		findings: {
			verified: verifiedOccurrences,
			falsePositives: falsePositiveClaims,
			unresolved: unresolvedClaims,
			uniqueVerified: uniqueVerified.size,
			uniqueExpected: uniqueExpected.size,
		},
		precision:
			reportedClaims === 0 ? null : verifiedOccurrences / reportedClaims,
		recall:
			expectedOpportunities === 0
				? null
				: verifiedOccurrences / expectedOpportunities,
		completeness:
			coverage.expectedRuns === 0 ? null : completeRuns / coverage.expectedRuns,
		observedCompleteness:
			coverage.submittedRuns === 0
				? null
				: completeRuns / coverage.submittedRuns,
		cleanCaseFalsePositiveRate:
			coverage.classes.clean.submittedRuns === 0
				? null
				: cleanRunsWithFalsePositives / coverage.classes.clean.submittedRuns,
		metrics: Object.fromEntries(
			metricNames.map((name) => [
				name,
				metricSummary(metrics[name], coverage.submittedRuns),
			]),
		),
	};
}

export function score(results, oracle) {
	requireExactKeys(
		results,
		new Set(["version", "plan", "strategies"]),
		"results",
	);
	if (results.version !== 1 || !Array.isArray(results.strategies)) {
		throw new Error(
			"results must be a version 1 object with a plan and strategies array",
		);
	}
	const oracleCases = indexOracle(oracle);
	validatePlan(results.plan, oracleCases);
	const names = new Set();
	const strategies = results.strategies.map((strategy) => {
		if (names.has(strategy?.name))
			throw new Error(`duplicate strategy: ${strategy?.name}`);
		names.add(strategy.name);
		return summarizeStrategy(strategy, oracleCases, results.plan);
	});
	return { version: 1, strategies };
}

async function main() {
	const [resultsPath, oraclePath = new URL("./oracle.json", import.meta.url)] =
		process.argv.slice(2);
	if (!resultsPath) {
		console.error(
			"Usage: node test/evals/score.mjs <captured-results.json> [oracle.json]",
		);
		process.exitCode = 2;
		return;
	}
	const [results, oracle] = await Promise.all([
		readJson(resultsPath),
		readJson(oraclePath),
	]);
	console.log(JSON.stringify(score(results, oracle), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
