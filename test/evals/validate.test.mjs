import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { reviewerInput, validate } from "./validate.mjs";

const directory = new URL("./", import.meta.url);
const [corpus, oracle] = await Promise.all([
	readFile(new URL("./cases.public.json", directory), "utf8").then(JSON.parse),
	readFile(new URL("./oracle.json", directory), "utf8").then(JSON.parse),
]);

function fixture() {
	return { corpus: structuredClone(corpus), oracle: structuredClone(oracle) };
}

async function rejects(mutator, pattern) {
	const input = fixture();
	mutator(input);
	await assert.rejects(() => validate(input.corpus, input.oracle), pattern);
}

test("validates the checked-in corpus and exports label-free reviewer input", async () => {
	const result = await validate(corpus, oracle);
	assert.equal(result.cases, 8);
	assert.deepEqual(Object.keys(reviewerInput(corpus.cases[0])).sort(), [
		"reviewTask",
		"source",
		"spec",
	]);
});

test("runs the documented validator command when default type stripping is disabled", () => {
	const result = spawnSync(
		process.execPath,
		[
			"--no-experimental-strip-types",
			"--experimental-strip-types",
			"test/evals/validate.mjs",
		],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
});

test("validates a nested source path when its oracle imports that path", async () => {
	const input = fixture();
	input.corpus.cases[0].source.path = "src/target.mjs";
	input.oracle.cases[0].groundTruth.program =
		input.oracle.cases[0].groundTruth.program.replaceAll(
			"./target.mjs",
			"./src/target.mjs",
		);
	await validate(input.corpus, input.oracle);
});

test("rejects source that cannot load", async () => {
	await rejects(({ corpus }) => {
		corpus.cases[0].source.after = "export const = ;";
	}, /could not load/);
});

test("rejects an unintended module throw", async () => {
	await rejects(({ corpus }) => {
		corpus.cases[0].source.after = "throw new Error('unintended');";
	}, /could not load/);
});

test("rejects signaled and timed-out module loading", async () => {
	await rejects(({ corpus }) => {
		corpus.cases[0].source.after =
			"process.kill(process.pid, 'SIGTERM'); export const value = 1;";
	}, /could not load/);
	await rejects(({ corpus }) => {
		corpus.cases[0].source.after =
			"await new Promise(() => setInterval(() => {}, 1_000));";
	}, /could not load/);
});

test("rejects label mismatches, exposed labels, and duplicate oracle IDs", async () => {
	await rejects(({ oracle }) => {
		oracle.cases[5].expectedFindingIds = ["F99"];
	}, /labels do not match/);
	await rejects(({ corpus }) => {
		corpus.cases[0].expectedFindingIds = [];
	}, /unknown key expectedFindingIds/);
	await rejects(({ corpus }) => {
		corpus.cases[0].label = "F01";
	}, /unknown key label/);
	await rejects(({ oracle }) => {
		oracle.cases[1].id = oracle.cases[0].id;
	}, /duplicate or invalid oracle case ID/);
});

test("rejects a fixed regression when the oracle still expects a failure", async () => {
	await rejects(({ corpus }) => {
		corpus.cases[0].source.after = corpus.cases[0].source.before;
	}, /expected fail, got pass/);
});
