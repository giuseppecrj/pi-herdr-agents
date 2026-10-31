import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { seedSubagentSessionFile } from "../../maestro/adapters/pi/session.ts";

function fixture(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "audit-fork-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const parentFile = join(dir, "parent.jsonl");
	const childFile = join(dir, "child", "session.jsonl");
	const childCwd = join(dir, "child-cwd");
	const parent = SessionManager.open(parentFile);
	return {
		parent,
		parentFile,
		fork() {
			const before = readFileSync(parentFile, "utf8");
			seedSubagentSessionFile({
				mode: "fork",
				parentSessionFile: parentFile,
				childSessionFile: childFile,
				childCwd,
			});
			assert.equal(readFileSync(parentFile, "utf8"), before);
			const child = SessionManager.open(childFile);
			assert.equal(child.getHeader()?.parentSession, parentFile);
			assert.equal(child.getHeader()?.cwd, childCwd);
			assert.equal(child.getHeader()?.version, 3);
			assert.notEqual(child.getSessionId(), parent.getSessionId());
			return child;
		},
	};
}

function user(session: SessionManager, content: string) {
	return session.appendMessage({ role: "user", content, timestamp: 1 });
}

function assistant(session: SessionManager, content: string) {
	return session.appendMessage(fauxAssistantMessage(content));
}

describe("ordinary fork active branch", () => {
	it("does not resurrect an abandoned assistant before the triggering user", (t) => {
		const { parent, fork } = fixture(t);
		const root = user(parent, "root user");
		assistant(parent, "abandoned assistant");
		parent.branch(root);
		user(parent, "triggering user");

		const child = fork();
		assert.deepEqual(child.getEntries(), [parent.getEntry(root)]);
		assert.deepEqual(child.buildSessionContext().messages, [
			{ role: "user", content: "root user", timestamp: 1 },
		]);
	});

	it("keeps the selected history but excludes the triggering turn and its descendants", (t) => {
		const { parent, parentFile, fork } = fixture(t);
		const root = user(parent, "root");
		assistant(parent, "abandoned response");
		user(parent, "abandoned follow-up");
		parent.branchWithSummary(root, "summary of the abandoned branch");
		assistant(parent, "selected response");
		const expectedEntries = SessionManager.open(parentFile).getBranch();
		const expectedContext = parent.buildSessionContext();
		user(parent, "delegate now");
		assistant(parent, "dispatching child");
		parent.appendCustomEntry("after-dispatch", { ignored: true });

		const child = fork();
		assert.deepEqual(child.getEntries(), expectedEntries);
		assert.deepEqual(child.buildSessionContext(), expectedContext);
	});

	for (const retain of [true, false]) {
		it(`preserves active compaction with ${retain ? "retained entries" : "no retained entries"}`, (t) => {
			const { parent, parentFile, fork } = fixture(t);
			const root = user(parent, "summarized root");
			assistant(parent, "abandoned response");
			parent.appendCompaction("abandoned summary", null, 100);
			user(parent, "abandoned follow-up");
			parent.branch(root);
			parent.appendModelChange("test-provider", "test-model");
			parent.appendThinkingLevelChange("high");
			const label = parent.appendLabelChange(root, "checkpoint");
			assistant(parent, "retained response");
			parent.appendCompaction("active summary", retain ? label : null, 200, {
				readFiles: ["source.ts"],
			});
			assistant(parent, "post-compaction response");
			const expectedEntries = SessionManager.open(parentFile).getBranch();
			const expectedContext = parent.buildSessionContext();
			assert.ok(
				expectedContext.messages.some(
					(message) => message.role === "compactionSummary",
				),
			);
			assert.equal(
				JSON.stringify(expectedContext.messages).includes("retained response"),
				retain,
			);
			user(parent, "triggering user");

			const child = fork();
			assert.deepEqual(child.getEntries(), expectedEntries);
			assert.deepEqual(child.buildSessionContext(), expectedContext);
		});
	}

	it("does not copy an abandoned root when the triggering user starts a new root", (t) => {
		const { parent, fork } = fixture(t);
		user(parent, "abandoned root");
		assistant(parent, "abandoned response");
		parent.resetLeaf();
		user(parent, "new root trigger");

		assert.deepEqual(fork().getEntries(), []);
	});

	it("copies the active branch intact when it has no user turn", (t) => {
		const { parent, parentFile, fork } = fixture(t);
		user(parent, "abandoned root");
		parent.resetLeaf();
		parent.appendCustomMessageEntry("context", "selected context", true);
		parent.appendThinkingLevelChange("medium");

		const child = fork();
		assert.deepEqual(
			child.getEntries(),
			SessionManager.open(parentFile).getBranch(),
		);
		assert.deepEqual(child.buildSessionContext(), parent.buildSessionContext());
	});
});
