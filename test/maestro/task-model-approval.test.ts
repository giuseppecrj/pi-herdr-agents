import "../clean-host-env.ts";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "../../pi-extension/subagents/index.ts";
import { readConfigRevision } from "../../maestro/core/config/model-config.ts";
import {
	TASK_MODEL_INIT_APPROVAL_EVENT,
	type OfferCallback,
} from "../../maestro/core/config/task-model-init.ts";
import { createMockExtensionApi } from "../helpers/mock-extension-api.ts";

const tasksMeta = {
	generatedAt: "2026-11-12T00:00:00Z",
	method: "registry-only",
};
const before = {
	status: { enabled: false },
	models: {
		default: "p/old",
		tasks: { coding: ["p/old"], review: ["p/old"] },
		tasksThinking: { coding: "low", review: "high" },
		tasksMeta: { ...tasksMeta, generatedAt: "2026-11-11T00:00:00Z" },
	},
};
const models = ["old", "first", "second"].map((id) => ({
	provider: "p",
	id,
	reasoning: false,
}));
const modelRegistry = {
	find: (provider: string, id: string) =>
		models.find((model) => model.provider === provider && model.id === id),
	getAvailable: () => models,
	hasConfiguredAuth: () => true,
};
function proposal() {
	return {
		tasks: { coding: [" p/first ", "p/second"] },
		tasksThinking: { coding: "max" },
		tasksMeta: { ...tasksMeta },
	};
}

function createWriterFixture(dir: string) {
	const configPath = join(dir, "herdr-agents", "config.json");
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, JSON.stringify(before));
	const mock = createMockExtensionApi();
	subagentsExtension(mock.api);
	const writer = mock.registeredTools.find(
		(tool) => tool.name === "subagents_write_task_models",
	);
	assert.ok(writer);
	mock.api.setActiveTools([...mock.api.getActiveTools(), writer.name]);
	const prompts: Array<{
		title: string;
		message: string;
		options?: ExtensionUIDialogOptions;
	}> = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		modelRegistry: { ...modelRegistry },
		ui: {
			confirm: async (
				title: string,
				message: string,
				options?: ExtensionUIDialogOptions,
			) => {
				prompts.push({ title, message, options });
				return true;
			},
		},
	};
	return { ...mock, writer, configPath, ctx, prompts };
}
type WriterFixture = ReturnType<typeof createWriterFixture>;

async function withWriter(run: (fixture: WriterFixture) => Promise<void>) {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const previousChild = process.env.PI_SUBAGENT_ID;
	const dir = mkdtempSync(join(tmpdir(), "piha-approval-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.PI_SUBAGENT_ID;
	try {
		await run(createWriterFixture(dir));
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		if (previousChild === undefined) delete process.env.PI_SUBAGENT_ID;
		else process.env.PI_SUBAGENT_ID = previousChild;
		rmSync(dir, { recursive: true, force: true });
	}
}

function execute(f: WriterFixture, params = proposal(), signal?: AbortSignal) {
	return f.writer.execute("write", params, signal, undefined, f.ctx);
}

function assertUntouched(f: WriterFixture, original: Buffer) {
	assert.deepEqual(readFileSync(f.configPath), original);
	assert.deepEqual(readdirSync(dirname(f.configPath)), ["config.json"]);
	assert.ok(f.api.getActiveTools().includes(f.writer.name));
}

describe("task-model writer approval", () => {
	it("shows the exact normalized before/after for every category and writes only after approval", async () => {
		await withWriter(async (f) => {
			const original = readFileSync(f.configPath);
			const confirm = f.ctx.ui.confirm;
			let approve: (approved: boolean) => void = () => {
				throw new Error("dialog did not open");
			};
			f.ctx.ui.confirm = async (...args) => {
				await confirm(...args);
				return new Promise<boolean>((resolve) => {
					approve = resolve;
				});
			};
			const pending = execute(f);
			await Promise.resolve();
			const dialog = f.prompts[0];
			assert.equal(dialog.title, "Approve task model preferences");
			assert.ok(
				dialog.message.includes(
					`Save task preferences to ${JSON.stringify(f.configPath)}?`,
				),
			);
			assert.ok(
				dialog.message.includes(
					'| coding | ["p/old"] | "low" | ["p/first","p/second"] | "max" |',
				),
			);
			assert.ok(
				dialog.message.includes(
					'| review | ["p/old"] | "high" | null | null |',
				),
			);
			for (const category of ["recon", "qa", "architecture", "docs"])
				assert.ok(
					dialog.message.includes(
						`| ${category} | null | null | null | null |`,
					),
				);
			assert.ok(
				dialog.message.includes(
					`Before tasksMeta: ${JSON.stringify(before.models.tasksMeta)}`,
				),
			);
			assert.ok(
				dialog.message.includes(
					`After tasksMeta: ${JSON.stringify(tasksMeta)}`,
				),
			);
			assert.equal(dialog.options?.timeout, 60_000);
			assertUntouched(f, original);
			approve(true);
			const result = await pending;
			assert.deepEqual(result.details.tasks, {
				coding: ["p/first", "p/second"],
			});
			assert.deepEqual(result.details.tasksThinking, { coding: "max" });
			assert.equal(
				result.details.configRevision,
				readConfigRevision(f.configPath),
			);
			assert.deepEqual(JSON.parse(readFileSync(f.configPath, "utf8")), {
				...before,
				models: {
					default: "p/old",
					tasks: result.details.tasks,
					tasksThinking: { coding: "max" },
					tasksMeta,
				},
			});
			assert.ok(!f.api.getActiveTools().includes(f.writer.name));
		});
	});

	it("shows long and control-containing model IDs losslessly, without truncation or table injection", async () => {
		await withWriter(async (f) => {
			const original = readFileSync(f.configPath);
			const id = `${"long-model".repeat(80)}|line\n\u202e`;
			f.ctx.modelRegistry.find = (provider, modelId) =>
				provider === "p" && modelId === id
					? { provider, id, reasoning: false }
					: undefined;
			const confirm = f.ctx.ui.confirm;
			f.ctx.ui.confirm = async (...args) => {
				await confirm(...args);
				return false;
			};
			await assert.rejects(
				f.writer.execute(
					"long-id",
					{ ...proposal(), tasks: { coding: [`p/${id}`] } },
					undefined,
					undefined,
					f.ctx,
				),
				/not written/,
			);
			assert.ok(
				f.prompts[0].message.includes(
					JSON.stringify([`p/${id}`])
						.replace("|", "\\u007c")
						.replace("\u202e", "\\u202e"),
				),
			);
			assert.doesNotMatch(f.prompts[0].message, /abbreviated/);
			assertUntouched(f, original);
		});
	});

	it("declines without writing, locking, or deactivating the retryable writer", async () => {
		await withWriter(async (f) => {
			const original = readFileSync(f.configPath);
			f.ctx.ui.confirm = async () => false;
			await assert.rejects(
				execute(f),
				/not written: approval declined, cancelled or timed out/,
			);
			assertUntouched(f, original);
		});
	});

	it("times out through ctx.ui after 60 seconds and leaves config untouched", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		await withWriter(async (f) => {
			const original = readFileSync(f.configPath);
			f.ctx.ui.confirm = async (_title, _message, options) => {
				assert.equal(options?.timeout, 60_000);
				return new Promise<boolean>((resolve) =>
					setTimeout(() => resolve(false), options?.timeout),
				);
			};
			const refused = assert.rejects(
				execute(f),
				/not written: approval declined, cancelled or timed out/,
			);
			t.mock.timers.tick(59_999);
			assertUntouched(f, original);
			t.mock.timers.tick(1);
			await refused;
			assertUntouched(f, original);
		});
	});

	it("refuses no-UI, print and JSON sessions without prompting, even if hasUI is misreported", async () => {
		await withWriter(async (f) => {
			const original = readFileSync(f.configPath);
			for (const session of [
				{ mode: "tui", hasUI: false },
				{ mode: "print", hasUI: false },
				{ mode: "json", hasUI: false },
				{ mode: "print", hasUI: true },
				{ mode: "json", hasUI: true },
				{ mode: "rpc", hasUI: false },
			]) {
				Object.assign(f.ctx, session);
				await assert.rejects(
					execute(f),
					/not written: user approval requires a dialog-capable UI/,
				);
				assertUntouched(f, original);
			}
			assert.equal(f.prompts.length, 0);
		});
	});

	it("uses the same approval in dialog-capable RPC sessions and asks again for every call", async () => {
		await withWriter(async (f) => {
			f.ctx.mode = "rpc";
			await execute(f);
			await execute(f);
			assert.equal(
				f.prompts.length,
				2,
				"neither a prior approval nor an identical write skips the dialog",
			);
		});
	});

	it("does not register a writer in child sessions and guards an already captured writer", async () => {
		await withWriter(async (f) => {
			const original = readFileSync(f.configPath);
			process.env.PI_SUBAGENT_ID = "approval-child";
			const child = createMockExtensionApi();
			subagentsExtension(child.api);
			assert.ok(
				!child.registeredTools.some((tool) => tool.name === f.writer.name),
			);
			await assert.rejects(
				execute(f),
				/not written: child sessions cannot approve/,
			);
			assertUntouched(f, original);
			assert.equal(f.prompts.length, 0);
		});
	});

	it("refuses an aborted call before the dialog and an approval returned after cancellation", async () => {
		await withWriter(async (f) => {
			const original = readFileSync(f.configPath);
			const early = new AbortController();
			early.abort();
			await assert.rejects(
				execute(f, proposal(), early.signal),
				/not written: approval cancelled/,
			);
			assert.equal(f.prompts.length, 0);
			const during = new AbortController();
			f.ctx.ui.confirm = async (_title, _message, options) => {
				assert.equal(options?.signal, during.signal);
				during.abort();
				return true;
			};
			await assert.rejects(
				execute(f, proposal(), during.signal),
				/not written: approval declined, cancelled or timed out/,
			);
			assertUntouched(f, original);
		});
	});

	it("rejects revision conflicts occurring during approval with or without a caller revision", async () => {
		for (const conditional of [false, true]) {
			await withWriter(async (f) => {
				const params: ReturnType<typeof proposal> & {
					expectedConfigRevision?: string;
				} = proposal();
				if (conditional)
					params.expectedConfigRevision = readConfigRevision(f.configPath);
				const changed = JSON.stringify({ ...before, editorChange: true });
				f.ctx.ui.confirm = async () => {
					writeFileSync(f.configPath, changed);
					return true;
				};
				await assert.rejects(
					execute(f, params),
					/Stale task model config revision.*not replaced/,
				);
				assertUntouched(f, Buffer.from(changed));
			});
		}
	});

	it("rejects stale proposals and invalid thinking before showing approval", async () => {
		await withWriter(async (f) => {
			const original = readFileSync(f.configPath);
			await assert.rejects(
				f.writer.execute(
					"stale",
					{ ...proposal(), expectedConfigRevision: "missing" },
					undefined,
					undefined,
					f.ctx,
				),
				/Stale task model config revision/,
			);
			for (const expectedConfigRevision of ["", null])
				await assert.rejects(
					f.writer.execute(
						"invalid",
						{ ...proposal(), expectedConfigRevision },
						undefined,
						undefined,
						f.ctx,
					),
					/Invalid expectedConfigRevision/,
				);
			await assert.rejects(
				f.writer.execute(
					"invalid",
					{ ...proposal(), tasksThinking: { coding: "ultra" } },
					undefined,
					undefined,
					f.ctx,
				),
				/models.tasksThinking.coding must be one of/,
			);
			assert.equal(f.prompts.length, 0);
			assertUntouched(f, original);
		});
	});

	it("keeps the approved proposal detached from subsequent caller mutations and revalidates auth", async () => {
		await withWriter(async (f) => {
			const params = proposal();
			const confirm = f.ctx.ui.confirm;
			f.ctx.ui.confirm = async (...args) => {
				await confirm(...args);
				params.tasks.coding.reverse();
				params.tasksThinking.coding = "off";
				params.tasksMeta.generatedAt = "2026-12-01T00:00:00Z";
				return true;
			};
			const saved = await execute(f, params);
			assert.deepEqual(saved.details.tasks, {
				coding: ["p/first", "p/second"],
			});
			assert.deepEqual(saved.details.tasksThinking, { coding: "max" });
			assert.deepEqual(saved.details.tasksMeta, tasksMeta);
			const original = readFileSync(f.configPath);
			f.ctx.ui.confirm = async () => {
				f.ctx.modelRegistry.hasConfiguredAuth = () => false;
				return true;
			};
			await assert.rejects(
				execute(f),
				/not an authenticated exact registry model/,
			);
			assert.deepEqual(readFileSync(f.configPath), original);
		});
	});

	it("shows preserved legacy thinking, removed categories and explicit clearing accurately", async () => {
		await withWriter(async (f) => {
			const legacy = await f.writer.execute(
				"legacy",
				{ tasks: { coding: ["p/first"] }, tasksMeta },
				undefined,
				undefined,
				f.ctx,
			);
			assert.deepEqual(legacy.details.tasksThinking, { coding: "low" });
			assert.ok(
				f.prompts[0].message.includes(
					'| coding | ["p/old"] | "low" | ["p/first"] | "low" |',
				),
			);
			assert.ok(
				f.prompts[0].message.includes(
					'| review | ["p/old"] | "high" | null | null |',
				),
			);
			const cleared = await f.writer.execute(
				"clear",
				{ tasks: { coding: ["p/first"] }, tasksThinking: {}, tasksMeta },
				undefined,
				undefined,
				f.ctx,
			);
			assert.deepEqual(cleared.details.tasksThinking, {});
			assert.ok(
				f.prompts[1].message.includes(
					'| coding | ["p/first"] | "low" | ["p/first"] | null |',
				),
			);
		});
	});

	it("creates nothing when a missing config proposal is declined, and detects a file created during approval", async () => {
		await withWriter(async (f) => {
			rmSync(dirname(f.configPath), { recursive: true });
			f.ctx.ui.confirm = async () => false;
			await assert.rejects(execute(f), /not written/);
			assert.equal(existsSync(dirname(f.configPath)), false);
			f.ctx.ui.confirm = async () => {
				mkdirSync(dirname(f.configPath));
				writeFileSync(f.configPath, JSON.stringify(before));
				return true;
			};
			await assert.rejects(
				execute(f),
				/expected no config file, but one now exists/,
			);
			assertUntouched(f, Buffer.from(JSON.stringify(before)));
		});
	});

	it("sends init drafts to the same writer approval, including the retained v1 handoff", async () => {
		for (const legacyHandoff of [false, true]) {
			await withWriter(async (f) => {
				if (legacyHandoff) {
					f.api.registerTool({
						name: "legacy_apply",
						parameters: {},
						description: "Legacy setup apply",
					});
					f.api.events.on(
						TASK_MODEL_INIT_APPROVAL_EVENT,
						(request: { offer: OfferCallback }) =>
							request.offer({
								owner: "legacy-pack",
								open: () => ({
									kind: "ready",
									destination: {
										toolName: "legacy_apply",
										instructions: "Use legacy_apply to submit the proposal.",
									},
									cancel() {},
								}),
							}),
					);
				}
				await f.registeredCommands
					.find((command) => command.name === "subagents-init")
					.handler("prefer capability", {
						...f.ctx,
						model: models[0],
						isIdle: () => true,
						hasPendingMessages: () => false,
					});
				assert.equal(f.sentUserMessages.length, 1);
				if (legacyHandoff)
					assert.match(f.sentUserMessages[0], /Use legacy_apply/);
				else
					assert.match(
						f.sentUserMessages[0],
						/asks the user to approve through ctx.ui/,
					);
				const brief = JSON.parse(
					f.sentUserMessages[0].match(/```json\n([\s\S]*?)\n```/)![1],
				);
				const original = readFileSync(f.configPath);
				const confirm = f.ctx.ui.confirm;
				f.ctx.ui.confirm = async (...args) => {
					await confirm(...args);
					return false;
				};
				await assert.rejects(
					f.writer.execute(
						"init-write",
						{ ...proposal(), expectedConfigRevision: brief.configRevision },
						undefined,
						undefined,
						f.ctx,
					),
					/not written/,
				);
				assert.equal(
					f.prompts.length,
					1,
					"an earlier package approval never bypasses host approval",
				);
				assertUntouched(f, original);
			});
		}
	});
});
