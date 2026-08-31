import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  getAvailableBackends,
  restoreBackend,
  runInPane,
  setBackend,
  waitForPaneReady,
  startPi,
  uniqueId,
  waitForFile,
  waitForScreen,
  PI_TIMEOUT,
  TEST_MODEL,
} from "./harness.ts";
import { isString } from "../../pi-extension/subagents/type-guards.ts";

const backends = getAvailableBackends();

function writeRoles(root: string, roles: string[]) {
	mkdirSync(join(root, ".pi", "agents"), { recursive: true });
	for (const role of roles) {
		writeFileSync(
			join(root, ".pi", "agents", `${role}.md`),
			`---\nname: ${role}\ndescription: integration reviewer\ntools: read, grep\nauto-exit: true\n---\nReturn the requested result after read-only inspection.\n`,
		);
	}
}

function writeWorkflow(
	root: string,
	runId: string,
	baseSha: string,
	marker: string,
): string {
  const directory = join(root, ".pi", "plans", runId);
  mkdirSync(directory, { recursive: true });
  const source = `/* herdr-workflow
${JSON.stringify(
	{
  version: 1,
  name: "integration workflow",
  sources: ["README.md"],
  baseSha,
  maxAgents: 4,
  maxConcurrency: 3,
		roles: ["architecture", "standards", "skeptic", "synthesizer"].map(
			(role) => ({
    role,
    kind: "review",
    model: TEST_MODEL,
    thinking: "low",
			}),
		),
	},
	null,
	2,
)}
*/
const reviews = await Promise.all(["architecture", "standards", "skeptic"].map((role) =>
  agent(${JSON.stringify(`Return exactly ${marker}.`)}, { kind: "review", role }),
));
return await agent(${JSON.stringify(`Synthesize every result and return exactly ${marker}.`) } + "\\n\\n" + JSON.stringify(reviews), { kind: "review", role: "synthesizer" });
`;
  const path = join(directory, "workflow.js");
  writeFileSync(path, source);
  return path;
}

function writeReloadWorkflow(
	root: string,
	runId: string,
	baseSha: string,
	marker: string,
	reviewGate: string,
	synthesisGate: string,
): string {
	const directory = join(root, ".pi", "plans", runId);
	mkdirSync(directory, { recursive: true });
	const metadata = {
		version: 1,
		name: "reload workflow",
		sources: ["README.md"],
		baseSha,
		maxAgents: 4,
		maxConcurrency: 3,
		roles: ["architecture", "standards", "skeptic", "synthesizer"].map(
			(role) => ({ role, kind: "review", model: TEST_MODEL, thinking: "low" }),
		),
	};
	const reviewPrompt = `Return exactly ${marker}. INTEGRATION_WAIT_FOR_FILE: ${reviewGate}`;
	const synthesisPrompt = `Synthesize every result and return exactly ${marker}. INTEGRATION_WAIT_FOR_FILE: ${synthesisGate}`;
	const source = `/* herdr-workflow\n${JSON.stringify(metadata, null, 2)}\n*/
const reviews = await Promise.all(["architecture", "standards", "skeptic"].map((role) =>
  agent(${JSON.stringify(reviewPrompt)}, { kind: "review", role }),
));
return await agent(${JSON.stringify(synthesisPrompt)} + "\\n\\n" + JSON.stringify(reviews), { kind: "review", role: "synthesizer" });
`;
	const path = join(directory, "workflow.js");
	writeFileSync(path, source);
	return path;
}

function writeCancelWorkflow(
	root: string,
	runId: string,
	baseSha: string,
	marker: string,
): string {
	const directory = join(root, ".pi", "plans", runId);
	mkdirSync(directory, { recursive: true });
	// maxConcurrency 1 keeps one child active while the rest stay queued so cancel
	// can claim the terminal gate before synthesis or late success. The long
	// sleep is only in the child prompt; the deterministic provider ignores it,
	// but real child process startup still gives cancel a window.
	const source = `/* herdr-workflow
${JSON.stringify(
	{
		version: 1,
		name: "cancel workflow",
		sources: ["README.md"],
		baseSha,
		maxAgents: 3,
		maxConcurrency: 1,
		roles: ["architecture", "standards", "skeptic"].map((role) => ({
			role,
			kind: "review",
			model: TEST_MODEL,
			thinking: "low",
		})),
	},
	null,
	2,
)}
*/
const reviews = await Promise.all([
  agent(${JSON.stringify(`Return exactly ${marker}-architecture.`)}, { kind: "review", role: "architecture" }),
  agent(${JSON.stringify(`Return exactly ${marker}-standards.`)}, { kind: "review", role: "standards" }),
  agent(${JSON.stringify(`Return exactly ${marker}-skeptic.`)}, { kind: "review", role: "skeptic" }),
]);
return { reviews, synthesized: false };
`;
	const path = join(directory, "workflow.js");
	writeFileSync(path, source);
	return path;
}

function initFixture(root: string, roles: string[]) {
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.com"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "Integration Test"], {
		cwd: root,
	});
	execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
	writeFileSync(join(root, "README.md"), "workflow integration fixture\n");
	writeRoles(root, roles);
	execFileSync("git", ["add", "README.md", ".pi/agents"], { cwd: root });
	execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
	return execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
}

if (backends.length === 0) {
  console.log("⚠️  herdr is unavailable — skipping workflow integration tests");
}

for (const backend of backends) {
	describe(`workflow reader child [${backend}]`, {
		timeout: PI_TIMEOUT * 3,
	}, () => {
    let previousBackend: string | undefined;

    before(() => {
      previousBackend = setBackend(backend);
    });

    after(() => {
      restoreBackend(previousBackend);
    });

    it("runs parallel read-only reviewers then one synthesizer in a detached checkout", async () => {
			const env = createTestEnv(backend);
			try {
      const id = uniqueId();
      const runId = `workflow-${id}`;
      const marker = `WORKFLOW_CHILD_${id}`;
      const root = realpathSync(env.dir);
				const baseSha = initFixture(root, [
					"architecture",
					"standards",
					"skeptic",
					"synthesizer",
				]);
      const workflowPath = writeWorkflow(root, runId, baseSha, marker);
      const approval = `APPROVE ${createHash("sha256").update(readFileSync(workflowPath)).digest("hex").slice(0, 8)}`;
      const journal = join(root, ".pi", "plans", runId, "run.jsonl");
      const surface = createTrackedSurface(env, `workflow-${id}`);
      await waitForPaneReady(surface);

				startPi(
					surface,
					root,
					[
        "Call herdr_workflow exactly once to prepare this workflow:",
        workflowPath,
        "Do not start it until the user sends its exact approval.",
        "After the user sends that approval, call herdr_workflow start with this run ID:",
        runId,
        "Then wait for the final workflow result and say WORKFLOW_PARENT_COMPLETE.",
					].join("\n"),
					{ model: TEST_MODEL },
				);

				await waitForScreen(
					surface,
					/Prepared workflow/,
					PI_TIMEOUT,
				);
				assert.equal(
					existsSync(journal),
					false,
					"prepare must not create a run journal",
				);
      runInPane(surface, approval);
      const rawJournal = await waitForFile(journal, PI_TIMEOUT, /"delivery"/);
				const events = rawJournal
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				assert.deepEqual(
					events.map((event) => event.type),
					[
        "approved",
        "started",
        "reader_checkout_ready",
        "agent_started",
        "agent_started",
        "agent_started",
        "agent_completed",
        "agent_result",
        "agent_completed",
        "agent_result",
        "agent_completed",
        "agent_result",
        "agent_started",
        "agent_completed",
        "agent_result",
        "reader_checkout_disposed",
        "completed",
        "delivery",
					],
				);
      const starts = events.filter((event) => event.type === "agent_started");
				const results = events
					.filter((event) => event.type === "agent_result")
					.map((event) => event.result);
				assert.deepEqual(
					starts.map((event) => event.role),
					["architecture", "standards", "skeptic", "synthesizer"],
				);
				assert.equal(
					events.findIndex((event) => event.type === "agent_completed"),
					6,
					"all reviewers start before one completes",
				);
				assert.equal(
					results.every(
						(result) =>
							result.ok &&
							isString(result.value) &&
							result.value.includes(marker),
					),
					true,
					`unexpected agent results: ${JSON.stringify(results)}`,
				);
				assert.equal(
					results.every((result) => existsSync(result.sessionFile)),
					true,
					"child sessions must remain available",
				);
				assert.equal(events.at(-2).envelope.result.ok, true);
				assert.equal(
					events.at(-2).envelope.result.value.includes(marker),
					true,
				);
      assert.equal(events.at(-1).status, "sent");
				assert.equal(
					existsSync(join(root, ".pi", "plans", runId, "reader-checkout")),
					false,
				);
			} finally {
				cleanupTestEnv(env);
			}
    });

		it("reports an empty successful child completion as missing review evidence", async () => {
			const env = createTestEnv(backend);
			try {
				const id = uniqueId();
				const runId = `workflow-empty-${id}`;
				const root = realpathSync(env.dir);
				const baseSha = initFixture(root, ["architecture", "standards", "skeptic", "synthesizer"]);
				const workflowPath = writeWorkflow(root, runId, baseSha, "EMPTY_COMPLETION");
				const approval = `APPROVE ${createHash("sha256").update(readFileSync(workflowPath)).digest("hex").slice(0, 8)}`;
				const journal = join(root, ".pi", "plans", runId, "run.jsonl");
				const surface = createTrackedSurface(env, `workflow-empty-${id}`);
				await waitForPaneReady(surface);
				startPi(surface, root, [
					"Call herdr_workflow exactly once to prepare this workflow:", workflowPath,
					"Do not start it until the user sends its exact approval.",
					"After the user sends that approval, call herdr_workflow start with this run ID:", runId,
					"Then wait for the final workflow result.",
				].join("\n"), { model: TEST_MODEL });
				await waitForScreen(surface, /Prepared workflow/, PI_TIMEOUT);
				runInPane(surface, approval);
				const events = (await waitForFile(journal, PI_TIMEOUT, /"type":"delivery"/))
					.trim().split("\n").map((line) => JSON.parse(line));
				const results = events.filter((event) => event.type === "agent_result").map((event) => event.result);
				assert.equal(results.every((result) => result.ok === false && result.code === "empty_completion"), true);
				const completions = events.filter((event) => event.type === "agent_completed");
				assert.equal(completions.length, 4);
				assert.equal(completions.every((event) => event.exitCode === 0 && event.sessionExists && event.finalAssistantContentLength === 0 && event.finalAssistantStopReason === "stop"), true);
			} finally {
				cleanupTestEnv(env);
			}
		});

		it("keeps ownership and delivers once across reload during review and synthesis", async () => {
			const env = createTestEnv(backend);
			try {
				const id = uniqueId();
				const runId = `reload-${id}`;
				const marker = `WORKFLOW_RELOAD_${id}`;
				const root = realpathSync(env.dir);
				const baseSha = initFixture(root, [
					"architecture",
					"standards",
					"skeptic",
					"synthesizer",
				]);
				const runDir = join(root, ".pi", "plans", runId);
				const reviewGate = join(runDir, "reviews.ready");
				const synthesisGate = join(runDir, "synthesis.ready");
				const workflowPath = writeReloadWorkflow(
					root,
					runId,
					baseSha,
					marker,
					reviewGate,
					synthesisGate,
				);
				const approval = `APPROVE ${createHash("sha256").update(readFileSync(workflowPath)).digest("hex").slice(0, 8)}`;
				const journal = join(runDir, "run.jsonl");
				const surface = createTrackedSurface(env, `workflow-reload-${id}`);
				await waitForPaneReady(surface);
				startPi(
					surface,
					root,
					[
						"Call herdr_workflow exactly once to prepare this workflow:",
						workflowPath,
						"Do not start it until the user sends its exact approval.",
						"After approval, call herdr_workflow start with this run ID:",
						runId,
						"After start, wait for the final workflow result.",
					].join("\n"),
					{ model: TEST_MODEL },
				);
				await waitForScreen(surface, /Prepared workflow/, PI_TIMEOUT);
				runInPane(surface, approval);

				const reviewJournal = await waitForFile(
					journal,
					PI_TIMEOUT,
					/"type":"agent_started"[\s\S]*"role":"skeptic"/,
				);
				const reviewEvents = reviewJournal.trim().split("\n").map((line) => JSON.parse(line));
				// Reviewers launch concurrently and agent_started is journaled after
				// each pane's shell becomes ready, so start order is not deterministic.
				assert.deepEqual(
					reviewEvents
						.filter((event) => event.type === "agent_started")
						.map((event) => event.role)
						.sort(),
					["architecture", "skeptic", "standards"],
				);
				assert.equal(
					reviewEvents.some((event) => event.type === "agent_result"),
					false,
					"review gate keeps all review work active before reload",
				);
				runInPane(surface, "/reload");
				writeFileSync(reviewGate, "ready\n");

				const synthesisJournal = await waitForFile(
					journal,
					PI_TIMEOUT,
					/"type":"agent_started"[\s\S]*"role":"synthesizer"/,
				);
				const synthesisEvents = synthesisJournal.trim().split("\n").map((line) => JSON.parse(line));
				assert.equal(
					synthesisEvents.filter((event) => event.type === "agent_result").length,
					3,
					"all review work continued after the first reload",
				);
				assert.equal(
					synthesisEvents.some((event) => event.type === "agent_result" && event.role === "synthesizer"),
					false,
					"synthesis gate keeps synthesis active before reload",
				);
				runInPane(surface, "/reload");
				writeFileSync(synthesisGate, "ready\n");

				const rawJournal = await waitForFile(journal, PI_TIMEOUT, /"type":"delivery"/);
				const events = rawJournal.trim().split("\n").map((line) => JSON.parse(line));
				assert.equal(events.filter((event) => ["completed", "failed", "cancelled", "interrupted"].includes(event.type)).length, 1);
				assert.equal(events.filter((event) => event.type === "delivery").length, 1);
				assert.equal(events.at(-1).status, "sent");
				assert.equal(events.at(-2).envelope.state, "completed");
			} finally {
				cleanupTestEnv(env);
			}
		});

		it("marks stale running evidence interrupted without replay or checkout cleanup", async () => {
			const env = createTestEnv(backend);
			let checkout: string | undefined;
			try {
				const id = uniqueId();
				const runId = `restart-${id}`;
				const root = realpathSync(env.dir);
				const baseSha = initFixture(root, []);
				const runDir = join(root, ".pi", "plans", runId);
				mkdirSync(runDir, { recursive: true });
				const journal = join(runDir, "run.jsonl");
				writeFileSync(journal, '{"id":"started","type":"started"}\n');
				checkout = join(runDir, "reader-checkout");
				execFileSync("git", ["worktree", "add", "--detach", checkout, baseSha], { cwd: root });
				const surface = createTrackedSurface(env, `workflow-restart-${id}`);
				await waitForPaneReady(surface);
				startPi(surface, root, "Start Pi and wait.", { model: TEST_MODEL });
				const rawJournal = await waitForFile(journal, PI_TIMEOUT, /"type":"interrupted"/);
				const events = rawJournal.trim().split("\n").map((line) => JSON.parse(line));
				assert.deepEqual(events.map((event) => event.type), ["started", "interrupted"]);
				assert.equal(existsSync(checkout), true);
				assert.equal(events.some((event) => event.type === "delivery"), false);
				assert.equal(events.at(-1).envelope.error.code, "process_restarted");
			} finally {
				if (checkout && existsSync(checkout)) {
					try {
						execFileSync("git", ["worktree", "remove", checkout], { cwd: env.dir });
					} catch {
						// The fixture owns cleanup even when the assertion fails.
					}
				}
				cleanupTestEnv(env);
			}
		});

		it("cancels active and queued reviewers under the terminal gate", async () => {
			const env = createTestEnv(backend);
			try {
				const id = uniqueId();
				const runId = `cancel-${id}`;
				const marker = `WORKFLOW_CANCEL_${id}`;
				const root = realpathSync(env.dir);
				const baseSha = initFixture(root, [
					"architecture",
					"standards",
					"skeptic",
				]);
				const workflowPath = writeCancelWorkflow(root, runId, baseSha, marker);
				const approval = `APPROVE ${createHash("sha256").update(readFileSync(workflowPath)).digest("hex").slice(0, 8)}`;
				const journal = join(root, ".pi", "plans", runId, "run.jsonl");
				const surface = createTrackedSurface(env, `workflow-cancel-${id}`);
				await waitForPaneReady(surface);

				startPi(
					surface,
					root,
					[
						"Call herdr_workflow exactly once to prepare this workflow:",
						workflowPath,
						"Do not start it until the user sends its exact approval.",
						"After the user sends that approval, call herdr_workflow start with this run ID:",
						runId,
						"After start returns, wait until the journal shows agent_started, then call herdr_workflow cancel with this run ID:",
						runId,
						"journal path:",
						journal,
						"Then wait for the final workflow result and say WORKFLOW_PARENT_COMPLETE.",
					].join("\n"),
					{ model: TEST_MODEL },
				);

				await waitForScreen(
					surface,
					/Prepared workflow/,
					PI_TIMEOUT,
				);
				runInPane(surface, approval);
				const rawJournal = await waitForFile(journal, PI_TIMEOUT, /"delivery"/);
				const events = rawJournal
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				const types = events.map((event) => event.type);
				assert.equal(types[0], "approved");
				assert.equal(types[1], "started");
				assert.ok(types.includes("reader_checkout_ready"));
				assert.ok(
					events.some((event) => event.type === "agent_started"),
					"at least one reviewer must start",
				);
				assert.equal(
					events.some((event) => event.role === "synthesizer"),
					false,
					"synthesis must not start after cancel",
				);
				const terminals = events.filter((event) =>
					["completed", "failed", "cancelled", "interrupted"].includes(
						event.type,
					),
				);
				assert.equal(
					terminals.length,
					1,
					`expected one terminal event, got ${JSON.stringify(types)}`,
				);
				assert.ok(
					terminals[0].type === "cancelled" || terminals[0].type === "failed",
					`expected cancelled or fail-closed failed, got ${terminals[0].type}`,
				);
				assert.equal(terminals[0].envelope.state, terminals[0].type);
				assert.equal(
					events.filter((event) => event.type === "delivery").length,
					1,
				);
				assert.equal(events.at(-1).type, "delivery");
				assert.equal(events.at(-1).state, terminals[0].type);
				assert.equal(events.at(-1).status, "sent");
				assert.equal("envelope" in events.at(-1), false);
				const processInfo = events.filter(
					(event) => event.type === "cancel_process_info",
				);
				const processInfoFailed = events.filter(
					(event) => event.type === "cancel_process_info_failed",
				);
				// agent_started means an active pane existed at cancel time; identity
				// capture must either produce non-empty PIDs or fail closed.
				assert.ok(
					processInfo.length + processInfoFailed.length > 0,
					"cancel must capture process info for started agents",
				);
				if (processInfo.length > 0) {
					assert.ok(
						processInfo.every(
							(event) => Array.isArray(event.pids) && event.pids.length > 0,
						),
						"captured process-info events must include waitable PIDs",
					);
				}
				const checkoutDisposed = events.some(
					(event) => event.type === "reader_checkout_disposed",
				);
				const checkoutRetained = events.some(
					(event) => event.type === "reader_checkout_retained",
				);
				assert.equal(checkoutDisposed || checkoutRetained, true);
				if (checkoutDisposed) {
					assert.equal(checkoutRetained, false);
					assert.equal(
						events.some(
							(event) =>
								event.type === "failed" &&
								event.envelope?.error?.code === "cancel_termination_failed",
						),
						false,
					);
					assert.equal(
						existsSync(join(root, ".pi", "plans", runId, "reader-checkout")),
						false,
					);
				} else {
					assert.ok(
						events.some(
							(event) =>
								event.type === "failed" &&
								event.envelope?.error?.code === "cancel_termination_failed",
						),
						"retained checkout requires cancel_termination_failed",
					);
					assert.equal(
						existsSync(join(root, ".pi", "plans", runId, "reader-checkout")),
						true,
					);
				}
			} finally {
				cleanupTestEnv(env);
			}
  });
	});
}
