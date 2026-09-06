// THROWAWAY: real Pi parents using a generated, instrumented copy of the extension.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLab } from "./lab.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const runtime = join(here, "results/runtime-parent");
const publicRun = process.argv.includes("--public");
const smoke = process.argv.includes("--smoke");
const output = join(
	here,
	"results",
	`parent-${publicRun ? "public" : "workflow"}-${Date.now()}`,
);
await mkdir(output, { recursive: true });
const lab = await createLab();
const trace = join(output, "trace.jsonl");
await writeFile(trace, "");
try {
	const pane = (await lab.cli(["pane", "get", lab.rootPane])).result.pane;
	const env = {
		...lab.env,
		HERDR_ENV: "1",
		HERDR_WORKSPACE_ID: lab.workspace,
		HERDR_PANE_ID: lab.rootPane,
		HERDR_TAB_ID: pane.tab_id,
		PI_ISSUE29_MODE: "events-batch",
		PI_ISSUE29_TRACE: trace,
		PI_TEST_TIMEOUT: "45000",
		PI_ISSUE29_OUTPUT: output,
		PI_ISSUE29_SERVER_PID: String(lab.serverPid),
		PI_ISSUE29_SIZES: smoke ? "1" : "1,5,10",
		PI_ISSUE29_SECONDS: smoke ? "2" : "20",
		PI_ISSUE29_MODES: smoke
			? "baseline,events-batch"
			: "baseline,files-batch,events-batch",
		PI_ISSUE29_ROUNDS: smoke ? "1" : "3",
	};
	const args = ["--experimental-strip-types", "--test", "--test-concurrency=1"];
	if (smoke && !publicRun)
		args.push("--test-name-pattern=runs parallel read-only");
	args.push(
		publicRun
			? join(here, "public-parent.test.mjs")
			: join(runtime, "test/integration/workflow-review.test.ts"),
	);
	const fd = openSync(join(output, "tests.log"), "w");
	const child = spawn(process.execPath, args, {
		env,
		cwd: runtime,
		stdio: ["ignore", fd, fd],
	});
	closeSync(fd);
	const timer = setTimeout(
		() => child.kill("SIGTERM"),
		publicRun ? 900000 : 300000,
	);
	const code = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
	clearTimeout(timer);
	const events = [];
	for (const name of (await readdir(output)).filter(
		(name) => name.endsWith(".jsonl") && name.includes("trace"),
	)) {
		events.push(
			...(await readFile(join(output, name), "utf8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		);
	}
	const watches = events.filter((event) => event.type === "watch-candidate");
	const baseline = events.filter((event) => event.type === "watch-baseline");
	const reloads = events.filter(
		(event) => event.type === "session-start" && event.reason === "reload",
	);
	const summary = {
		code,
		publicRun,
		smoke,
		candidateWatches: watches.length,
		baselineWatches: baseline.length,
		realParentReloads: reloads.length,
		reloadStates: reloads.map((event) => event.state),
		source:
			"real Pi parent + generated copy of production extension with candidate wait adapter",
		output,
	};
	await writeFile(
		join(output, "summary.json"),
		JSON.stringify(summary, null, 2),
	);
	console.log(JSON.stringify(summary, null, 2));
	assert.equal(code, 0, `See ${join(output, "tests.log")}`);
	assert.ok(watches.length > 0, "Candidate adapter was not actually exercised");
	if (!publicRun) {
		assert.equal(baseline.length, 0, "Unexpected silent baseline fallback");
		if (!smoke)
			assert.ok(
				reloads.length >= 2,
				"Real parent reload cases were not observed",
			);
	}
} finally {
	await lab.stop();
	await writeFile(
		join(output, "cleanup.json"),
		JSON.stringify(
			{
				serverExitCode: lab.server.exitCode,
				serverSignal: lab.server.signalCode,
			},
			null,
			2,
		),
	);
}
