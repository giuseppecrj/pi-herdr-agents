import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	isPlainObject,
	isString,
} from "../../pi-extension/subagents/type-guards.ts";

const timeoutMs = 3_000;
const publicCaseKeys = new Set(["id", "title", "reviewTask", "spec", "source"]);
const sourceKeys = new Set(["path", "before", "after"]);
const oracleCaseKeys = new Set([
	"id",
	"expectedFindingIds",
	"groundTruth",
	"rationale",
]);
const groundTruthKeys = new Set(["before", "after", "program"]);
const findingKeys = new Set(["id", "caseId", "description"]);

async function readJson(path) {
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

function isSafeRelativePath(path) {
	return (
		isString(path) &&
		path.length > 0 &&
		!isAbsolute(path) &&
		!normalize(path).startsWith(`..${"/"}`) &&
		!normalize(path).startsWith(`..${"\\"}`)
	);
}

function validatePublicCase(entry) {
	requireExactKeys(entry, publicCaseKeys, "public case");
	if (!/^case-\d{2}$/.test(entry.id)) {
		throw new Error("public case ID must be a neutral case-NN identifier");
	}
	if (entry.title !== `Scenario ${entry.id.slice(-2)}`) {
		throw new Error(`${entry.id} title must be its neutral Scenario NN title`);
	}
	if (!isString(entry.reviewTask) || !isString(entry.spec)) {
		throw new Error(`${entry.id} needs reviewTask and spec strings`);
	}
	requireExactKeys(entry.source, sourceKeys, `${entry.id} source`);
	if (!isSafeRelativePath(entry.source.path)) {
		throw new Error(`${entry.id} source path must be relative and contained`);
	}
	for (const version of ["before", "after"]) {
		if (!isString(entry.source[version])) {
			throw new Error(`${entry.id} source ${version} must be a string`);
		}
	}
}

function validateOracle(oracle) {
	requireExactKeys(oracle, new Set(["version", "cases", "findings"]), "oracle");
	if (
		oracle.version !== 1 ||
		!Array.isArray(oracle.cases) ||
		!Array.isArray(oracle.findings)
	) {
		throw new Error(
			"oracle must be a version 1 object with cases and findings arrays",
		);
	}

	const caseIds = new Set();
	const expectedIds = new Set();
	for (const entry of oracle.cases) {
		requireExactKeys(entry, oracleCaseKeys, "oracle case");
		if (!isString(entry.id) || caseIds.has(entry.id)) {
			throw new Error(`duplicate or invalid oracle case ID ${entry.id}`);
		}
		caseIds.add(entry.id);
		requireUniqueStrings(
			entry.expectedFindingIds,
			`${entry.id} expectedFindingIds`,
		);
		for (const findingId of entry.expectedFindingIds) {
			if (expectedIds.has(findingId)) {
				throw new Error(`duplicate oracle finding ID ${findingId}`);
			}
			expectedIds.add(findingId);
		}
		requireExactKeys(
			entry.groundTruth,
			groundTruthKeys,
			`${entry.id} groundTruth`,
		);
		const { before, after, program } = entry.groundTruth;
		if (
			!["pass", "fail"].includes(before) ||
			!["pass", "fail"].includes(after) ||
			!isString(program)
		) {
			throw new Error(`${entry.id} has invalid ground truth`);
		}
		const cleanCase = entry.expectedFindingIds.length === 0;
		if (cleanCase !== (before === "pass" && after === "pass")) {
			throw new Error(
				`${entry.id} labels do not match its ground-truth outcomes`,
			);
		}
		if (!cleanCase && !(before === "pass" && after === "fail")) {
			throw new Error(
				`${entry.id} labels do not match its ground-truth outcomes`,
			);
		}
		if (!isString(entry.rationale))
			throw new Error(`${entry.id} rationale must be a string`);
	}

	const catalogIds = new Set();
	for (const finding of oracle.findings) {
		requireExactKeys(finding, findingKeys, "oracle finding");
		if (!isString(finding.id) || catalogIds.has(finding.id)) {
			throw new Error(`duplicate or invalid catalog finding ID ${finding.id}`);
		}
		if (!caseIds.has(finding.caseId) || !isString(finding.description)) {
			throw new Error(`invalid catalog finding ${finding.id}`);
		}
		catalogIds.add(finding.id);
	}
	if (
		catalogIds.size !== expectedIds.size ||
		[...expectedIds].some((id) => !catalogIds.has(id))
	) {
		throw new Error(
			"oracle finding catalog must contain every expected finding exactly once",
		);
	}
	for (const finding of oracle.findings) {
		const owner = oracle.cases.find((entry) => entry.id === finding.caseId);
		if (!owner.expectedFindingIds.includes(finding.id)) {
			throw new Error(
				`catalog finding ${finding.id} does not belong to ${finding.caseId}`,
			);
		}
	}
}

function childResult(child, stdout, stderr, timedOut, spawnError) {
	return {
		code: child?.exitCode ?? null,
		signal: child?.signalCode ?? null,
		stdout,
		stderr,
		timedOut,
		spawnError: spawnError?.message,
	};
}

function runNode(cwd, program) {
	return new Promise((resolve) => {
		let timedOut = false;
		let spawnError;
		const child = spawn(
			process.execPath,
			["--input-type=module", "--eval", program],
			{
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.once("error", (error) => {
			spawnError = error;
		});
		child.once("close", () => {
			clearTimeout(timer);
			resolve(childResult(child, stdout, stderr, timedOut, spawnError));
		});
	});
}

function passed(result) {
	return (
		!result.timedOut &&
		!result.spawnError &&
		result.code === 0 &&
		result.signal === null
	);
}

function diagnostic(result) {
	return JSON.stringify({
		code: result.code,
		signal: result.signal,
		timedOut: result.timedOut,
		spawnError: result.spawnError,
		stdout: result.stdout,
		stderr: result.stderr,
	});
}

async function verifyCase(entry, oracle) {
	const workspace = await mkdtemp(join(tmpdir(), "review-eval-"));
	try {
		for (const version of ["before", "after"]) {
			const fixture = join(workspace, version);
			await mkdir(dirname(join(fixture, entry.source.path)), {
				recursive: true,
			});
			await writeFile(join(fixture, "package.json"), '{"type":"module"}\n');
			await writeFile(join(fixture, entry.source.path), entry.source[version]);

			const sourceUrl = pathToFileURL(join(fixture, entry.source.path)).href;
			const loaded = await runNode(
				fixture,
				`await import(${JSON.stringify(sourceUrl)});`,
			);
			if (!passed(loaded)) {
				throw new Error(
					`${entry.id} ${version} could not load: ${diagnostic(loaded)}`,
				);
			}

			const result = await runNode(fixture, oracle.groundTruth.program);
			const actual = passed(result) ? "pass" : "fail";
			if (actual !== oracle.groundTruth[version]) {
				throw new Error(
					`${entry.id} ${version} expected ${oracle.groundTruth[version]}, got ${actual}: ${diagnostic(result)}`,
				);
			}
			if (
				actual === "fail" &&
				(result.timedOut ||
					result.signal !== null ||
					!/AssertionError \[ERR_ASSERTION\]/.test(result.stderr))
			) {
				throw new Error(
					`${entry.id} ${version} failed without an assertion error: ${diagnostic(result)}`,
				);
			}
		}
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

export function reviewerInput(entry) {
	return {
		reviewTask: entry.reviewTask,
		spec: entry.spec,
		source: entry.source,
	};
}

export async function validate(corpus, oracle) {
	requireExactKeys(corpus, new Set(["version", "cases"]), "public corpus");
	if (corpus.version !== 1 || !Array.isArray(corpus.cases)) {
		throw new Error(
			"cases.public.json must be a version 1 object with a cases array",
		);
	}
	if (corpus.cases.length < 6 || corpus.cases.length > 10) {
		throw new Error("the corpus must contain 6 through 10 cases");
	}

	validateOracle(oracle);
	const oracleById = new Map(oracle.cases.map((entry) => [entry.id, entry]));
	const ids = new Set();
	for (const entry of corpus.cases) {
		validatePublicCase(entry);
		if (ids.has(entry.id))
			throw new Error(`duplicate public case ID ${entry.id}`);
		ids.add(entry.id);
		if (!oracleById.has(entry.id))
			throw new Error(`${entry.id} has no oracle ground truth`);
	}
	if (
		oracleById.size !== ids.size ||
		[...oracleById.keys()].some((id) => !ids.has(id))
	) {
		throw new Error("public corpus and oracle must have identical case IDs");
	}
	for (const entry of corpus.cases)
		await verifyCase(entry, oracleById.get(entry.id));
	return {
		cases: corpus.cases.length,
		verified: corpus.cases.map((entry) => entry.id),
	};
}

async function main() {
	const directory = new URL("./", import.meta.url);
	const [corpus, oracle] = await Promise.all([
		readJson(new URL("./cases.public.json", directory)),
		readJson(new URL("./oracle.json", directory)),
	]);
	console.log(JSON.stringify(await validate(corpus, oracle), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
