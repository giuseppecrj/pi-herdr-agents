import "../isolated-agent-dir.ts";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "../../pi-extension/subagents/index.ts";
import {
	describeTaskModelWriteFailure,
	prepareTaskModelWrite,
	readConfigRevision,
	writeTaskModelConfig,
} from "../../maestro/core/config/model-config.ts";
import {
	TASK_MODEL_INIT_APPROVAL_EVENT,
	type OfferCallback,
} from "../../maestro/core/config/task-model-init.ts";
import { createMockExtensionApi } from "../helpers/mock-extension-api.ts";

const YES = "Yes, save";
const NO = "No, keep current";
const tasksMeta = {
	generatedAt: "2026-11-12T00:00:00Z",
	method: "registry-only" as const,
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
		choices: string[];
		options?: ExtensionUIDialogOptions;
	}> = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		modelRegistry: { ...modelRegistry },
		ui: {
			select: async (
				title: string,
				choices: string[],
				options?: ExtensionUIDialogOptions,
			): Promise<string | undefined> => {
				prompts.push({ title, choices, options });
				return YES;
			},
		},
	};
	return { ...mock, writer, configPath, ctx, prompts, dir };
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
function preparedProposal(f: WriterFixture) {
	return prepareTaskModelWrite(f.configPath, {
		agents: {},
		tasks: { coding: ["p/first"] },
		tasksThinking: { coding: "max" },
		tasksMeta,
	});
}

describe("task-model writer approval", () => {
	it("refuses init before registry access or an external handoff when no UI is available", async () => {
		await withWriter(async (f) => {
			f.ctx.hasUI = false;
			const notices: string[] = [];
			f.api.events.on(TASK_MODEL_INIT_APPROVAL_EVENT, () => {
				throw new Error("must not open a handoff");
			});
			await f.registeredCommands
				.find((command) => command.name === "subagents-init")
				.handler("", {
					...f.ctx,
					ui: { notify: (text: string) => notices.push(text) },
					isIdle: () => {
						throw new Error("must refuse before init");
					},
				});
			assert.match(notices[0], /requires a dialog-capable UI/);
			assert.equal(f.sentUserMessages.length, 0);
			assert.equal(f.prompts.length, 0);
		});
	});

	it("shows only changed categories, exact ordered models and thinking, and waits for approval", async () => {
		await withWriter(async (f) => {
			const original = readFileSync(f.configPath);
			const select = f.ctx.ui.select;
			let approve: (choice: string) => void = () => {
				throw new Error("selector did not open");
			};
			f.ctx.ui.select = async (...args) => {
				await select(...args);
				return new Promise<string>((resolve) => {
					approve = resolve;
				});
			};
			const pending = execute(f);
			await Promise.resolve();
			let result;
			try {
				const dialog = f.prompts[0];
				assert.match(dialog.title, /^Approve task model preferences\n/);
				assert.ok(
					dialog.title.includes(`Save to ${JSON.stringify(f.configPath)}`),
				);
				assert.ok(
					dialog.title.includes(
						'coding: ["p/old"] / "low" -> ["p/first","p/second"] / "max"',
					),
				);
				assert.ok(
					dialog.title.includes('review: ["p/old"] / "high" -> null / null'),
				);
				for (const category of ["recon", "qa", "architecture", "docs"])
					assert.ok(!dialog.title.includes(`${category}:`));
				assert.ok(dialog.title.includes("4 categories unchanged."));
				assert.ok(
					dialog.title.includes(
						`Metadata: ${JSON.stringify(before.models.tasksMeta)} -> ${JSON.stringify(tasksMeta)}`,
					),
				);
				assert.ok(
					dialog.title.split("\n").length < 12,
					"ordinary changes stay compact",
				);
				assert.equal(dialog.options?.timeout, 60_000);
				assert.deepEqual(dialog.choices, [NO, YES]);
				assertUntouched(f, original);
			} finally {
				approve(YES);
				result = await pending;
			}
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

	it("the first/default selector choice refuses rather than approving on Enter", async () => {
		await withWriter(async (f) => {
			const original = readFileSync(f.configPath);
			f.ctx.ui.select = async (_title, choices) => choices[0];
			await assert.rejects(execute(f), /not written: approval declined/);
			assertUntouched(f, original);
		});
	});

	it("escapes long IDs, default-ignorable and format characters losslessly without truncation", async () => {
		await withWriter(async (f) => {
			const original = readFileSync(f.configPath);
			const invisible = "\u200b\u2060\ufeff\u00ad\u034f\u{e0020}";
			const id = `${"long-model".repeat(80)}|line\n\u202e${invisible}`;
			f.ctx.modelRegistry.find = (provider, modelId) =>
				provider === "p" && modelId === id
					? { provider, id, reasoning: false }
					: undefined;
			const select = f.ctx.ui.select;
			f.ctx.ui.select = async (...args) => {
				await select(...args);
				return NO;
			};
			await assert.rejects(
				f.writer.execute(
					"long",
					{ ...proposal(), tasks: { coding: [`p/${id}`] } },
					undefined,
					undefined,
					f.ctx,
				),
				/not written/,
			);
			const title = f.prompts[0].title;
			assert.ok(title.includes("long-model".repeat(80)));
			assert.ok(
				title.includes(
					"\\u007cline\\n\\u202e\\u200b\\u2060\\ufeff\\u00ad\\u034f\\udb40\\udc20",
				),
			);
			assert.doesNotMatch(title, /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u);
			assert.doesNotMatch(title, /abbreviated/);
			assertUntouched(f, original);
		});
	});

	it("declines without writing, locking, or deactivating the retryable writer", async () => {
		await withWriter(async (f) => {
			const original = readFileSync(f.configPath);
			f.ctx.ui.select = async () => NO;
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
			f.ctx.ui.select = async (_title, _choices, options) => {
				assert.equal(options?.timeout, 60_000);
				return new Promise<undefined>((resolve) =>
					setTimeout(() => resolve(undefined), options?.timeout),
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
			assert.equal(f.prompts.length, 2);
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
			f.ctx.ui.select = async (_title, _choices, options) => {
				assert.equal(options?.signal, during.signal);
				during.abort();
				return YES;
			};
			await assert.rejects(
				execute(f, proposal(), during.signal),
				/not written: approval declined/,
			);
			assertUntouched(f, original);
		});
	});

	it("rejects revision conflicts during approval with or without a caller revision", async () => {
		for (const conditional of [false, true])
			await withWriter(async (f) => {
				const params: ReturnType<typeof proposal> & {
					expectedConfigRevision?: string;
				} = proposal();
				if (conditional)
					params.expectedConfigRevision = readConfigRevision(f.configPath);
				const changed = JSON.stringify({ ...before, editorChange: true });
				f.ctx.ui.select = async () => {
					writeFileSync(f.configPath, changed);
					return YES;
				};
				await assert.rejects(
					execute(f, params),
					/Stale task model config revision.*not replaced/,
				);
				assertUntouched(f, Buffer.from(changed));
			});
	});

	it("rejects stale proposals, invalid thinking and orphan category thinking before approval", async () => {
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
			await assert.rejects(
				f.writer.execute(
					"orphan",
					{ ...proposal(), tasksThinking: { review: "high" } },
					undefined,
					undefined,
					f.ctx,
				),
				/has no submitted task category/,
			);
			assert.equal(f.prompts.length, 0);
			assertUntouched(f, original);
		});
	});

	it("keeps the approved proposal detached from caller mutations and revalidates auth", async () => {
		await withWriter(async (f) => {
			const params = proposal();
			const select = f.ctx.ui.select;
			f.ctx.ui.select = async (...args) => {
				await select(...args);
				params.tasks.coding.reverse();
				params.tasksThinking.coding = "off";
				params.tasksMeta.generatedAt = "2026-12-01T00:00:00Z";
				return YES;
			};
			const saved = await execute(f, params);
			assert.deepEqual(saved.details.tasks, {
				coding: ["p/first", "p/second"],
			});
			assert.deepEqual(saved.details.tasksThinking, { coding: "max" });
			assert.deepEqual(saved.details.tasksMeta, tasksMeta);
			const original = readFileSync(f.configPath);
			f.ctx.ui.select = async () => {
				f.ctx.modelRegistry.hasConfiguredAuth = () => false;
				return YES;
			};
			await assert.rejects(
				execute(f),
				/not an authenticated exact registry model/,
			);
			assert.deepEqual(readFileSync(f.configPath), original);
		});
	});

	it("preserves legacy/null thinking, removes omitted categories, and clears without persisting an empty map", async () => {
		await withWriter(async (f) => {
			const legacy = await f.writer.execute(
				"legacy",
				{ tasks: { coding: ["p/first"] }, tasksThinking: null, tasksMeta },
				undefined,
				undefined,
				f.ctx,
			);
			assert.deepEqual(legacy.details.tasksThinking, { coding: "low" });
			assert.ok(
				f.prompts[0].title.includes(
					'coding: ["p/old"] / "low" -> ["p/first"] / "low"',
				),
			);
			assert.ok(
				f.prompts[0].title.includes(
					'review: ["p/old"] / "high" -> null / null',
				),
			);
			const cleared = await f.writer.execute(
				"clear",
				{ tasks: { coding: ["p/first"] }, tasksThinking: {}, tasksMeta },
				undefined,
				undefined,
				f.ctx,
			);
			assert.equal(cleared.details.tasksThinking, undefined);
			assert.equal(
				Object.hasOwn(
					JSON.parse(readFileSync(f.configPath, "utf8")).models,
					"tasksThinking",
				),
				false,
			);
			assert.ok(
				f.prompts[1].title.includes(
					'coding: ["p/first"] / "low" -> ["p/first"] / null',
				),
			);
		});
	});

	it("creates nothing on decline and detects a config created during missing-file approval", async () => {
		await withWriter(async (f) => {
			rmSync(dirname(f.configPath), { recursive: true });
			f.ctx.ui.select = async () => NO;
			await assert.rejects(execute(f), /not written/);
			assert.equal(existsSync(dirname(f.configPath)), false);
			f.ctx.ui.select = async () => {
				mkdirSync(dirname(f.configPath));
				writeFileSync(f.configPath, JSON.stringify(before));
				return YES;
			};
			await assert.rejects(
				execute(f),
				/expected no config file, but one now exists/,
			);
			assertUntouched(f, Buffer.from(JSON.stringify(before)));
		});
	});

	it("discloses every new-file top-level key and writes only the minimal approved seed", async () => {
		await withWriter(async (f) => {
			rmSync(dirname(f.configPath), { recursive: true });
			const saved = await execute(f);
			assert.ok(
				f.prompts[0].title.includes(
					'Create new file; top-level keys: status, models. Other settings: {"status":{"enabled":true}}.',
				),
			);
			assert.deepEqual(JSON.parse(readFileSync(f.configPath, "utf8")), {
				status: { enabled: true },
				models: {
					tasksThinking: { coding: "max" },
					tasks: saved.details.tasks,
					tasksMeta,
				},
			});
		});
	});

	it("binds the exact replacement bytes, not a mutable example or only a starting revision", async () => {
		await withWriter(async (f) => {
			rmSync(f.configPath);
			const example = join(f.dir, "example.json");
			writeFileSync(
				example,
				JSON.stringify({
					status: { enabled: false },
					models: { default: "p/unshown" },
					spawning: { maxDepth: 100 },
				}),
			);
			const prepared = preparedProposal(f);
			writeFileSync(example, JSON.stringify({ injected: true }));
			assert.throws(
				() =>
					writeTaskModelConfig(
						f.configPath,
						example,
						{ coding: ["p/second"] },
						tasksMeta,
						() => true,
						{
							approvedWrite: prepared,
							expectedConfigRevision: prepared.configRevision,
							tasksThinking: { coding: "max" },
						},
					),
				/bytes differ from the approved proposal/,
			);
			assert.equal(existsSync(f.configPath), false);
			writeTaskModelConfig(
				f.configPath,
				example,
				prepared.after.tasks ?? {},
				tasksMeta,
				() => true,
				{
					approvedWrite: prepared,
					expectedConfigRevision: prepared.configRevision,
					tasksThinking: prepared.after.tasksThinking,
				},
			);
			assert.equal(readFileSync(f.configPath, "utf8"), prepared.output);
			assert.deepEqual(Object.keys(JSON.parse(prepared.output)), [
				"status",
				"models",
			]);
		});
	});

	it("supports symlinked config directories and shows the resolved destination", {
		skip: process.platform === "win32",
	}, async () => {
		await withWriter(async (f) => {
			const real = join(f.dir, "dotfiles");
			renameSync(dirname(f.configPath), real);
			symlinkSync(real, dirname(f.configPath));
			await execute(f);
			assert.ok(
				f.prompts[0].title.includes(
					`Real path: ${JSON.stringify(join(realpathSync(real), "config.json"))}`,
				),
			);
			assert.deepEqual(
				JSON.parse(readFileSync(join(real, "config.json"), "utf8")).models
					.tasksThinking,
				{ coding: "max" },
			);
		});
	});

	it("refuses a symlink target swapped during approval even when config bytes are identical", {
		skip: process.platform === "win32",
	}, async () => {
		await withWriter(async (f) => {
			const first = join(f.dir, "first-target");
			const second = join(f.dir, "second-target");
			renameSync(dirname(f.configPath), first);
			mkdirSync(second);
			writeFileSync(join(second, "config.json"), JSON.stringify(before));
			symlinkSync(first, dirname(f.configPath));
			f.ctx.ui.select = async () => {
				unlinkSync(dirname(f.configPath));
				symlinkSync(second, dirname(f.configPath));
				return YES;
			};
			await assert.rejects(
				execute(f),
				/directory changed after approval.*not replaced/,
			);
			for (const path of [first, second]) {
				assert.equal(
					readFileSync(join(path, "config.json"), "utf8"),
					JSON.stringify(before),
				);
				assert.deepEqual(readdirSync(path), ["config.json"]);
			}
		});
	});

	it("rechecks the symlink under the lock immediately before rename", {
		skip: process.platform === "win32",
	}, async () => {
		await withWriter(async (f) => {
			const first = join(f.dir, "first-target");
			const second = join(f.dir, "second-target");
			renameSync(dirname(f.configPath), first);
			mkdirSync(second);
			writeFileSync(join(second, "config.json"), JSON.stringify(before));
			symlinkSync(first, dirname(f.configPath));
			const prepared = preparedProposal(f);
			assert.throws(
				() =>
					writeTaskModelConfig(
						f.configPath,
						"unused",
						prepared.after.tasks ?? {},
						tasksMeta,
						() => true,
						{
							approvedWrite: prepared,
							expectedConfigRevision: prepared.configRevision,
							tasksThinking: prepared.after.tasksThinking,
							fileOperations: {
								writeFileSync(path, data, options) {
									writeFileSync(path, data, options);
									unlinkSync(dirname(f.configPath));
									symlinkSync(second, dirname(f.configPath));
								},
								renameSync,
							},
						},
					),
				/directory changed after approval/,
			);
			for (const path of [first, second]) {
				assert.equal(
					readFileSync(join(path, "config.json"), "utf8"),
					JSON.stringify(before),
				);
				assert.deepEqual(readdirSync(path), ["config.json"]);
			}
		});
	});

	it("refuses concurrent approval calls immediately, including another loaded writer, then releases the gate", async () => {
		await withWriter(async (f) => {
			const original = readFileSync(f.configPath);
			const select = f.ctx.ui.select;
			let settle: (choice: string) => void = () => {
				throw new Error("no selector");
			};
			f.ctx.ui.select = async (...args) => {
				await select(...args);
				if (f.prompts.length > 1) return NO;
				return new Promise<string>((resolve) => {
					settle = resolve;
				});
			};
			const first = execute(f);
			await Promise.resolve();
			try {
				await assert.rejects(execute(f), /another approval is already open/);
				const other = createMockExtensionApi();
				subagentsExtension(other.api);
				await assert.rejects(
					other.registeredTools
						.find((tool) => tool.name === f.writer.name)
						.execute("second", proposal(), undefined, undefined, f.ctx),
					/another approval is already open/,
				);
				assert.equal(f.prompts.length, 1);
				assertUntouched(f, original);
			} finally {
				settle(NO);
				await assert.rejects(first, /not written/);
			}
			f.ctx.ui.select = select;
			await execute(f);
			assert.equal(f.prompts.length, 2);
		});
	});

	it("reports the re-read file state for a generic failure after approval", async () => {
		await withWriter(async (f) => {
			const original = readFileSync(f.configPath);
			f.ctx.ui.select = async () => {
				f.ctx.modelRegistry.hasConfiguredAuth = () => {
					throw new Error("auth recheck failed");
				};
				return YES;
			};
			await assert.rejects(
				execute(f),
				/auth recheck failed.*Configuration was not replaced \(verified unchanged by re-read\)/,
			);
			assertUntouched(f, original);
		});
	});

	it("reports publication after a rename-then-throw and returns the revision actually observed", async () => {
		await withWriter(async (f) => {
			const prepared = preparedProposal(f);
			assert.throws(
				() =>
					writeTaskModelConfig(
						f.configPath,
						"unused",
						prepared.after.tasks ?? {},
						tasksMeta,
						() => true,
						{
							approvedWrite: prepared,
							expectedConfigRevision: prepared.configRevision,
							tasksThinking: prepared.after.tasksThinking,
							fileOperations: {
								writeFileSync,
								renameSync(from, to) {
									renameSync(from, to);
									throw new Error("after publication");
								},
							},
						},
					),
				/after publication/,
			);
			assert.equal(
				describeTaskModelWriteFailure(prepared),
				"Configuration matches the approved replacement (verified by re-read).",
			);
			const saved = writeTaskModelConfig(
				f.configPath,
				"unused",
				prepared.after.tasks ?? {},
				tasksMeta,
				() => true,
				{
					tasksThinking: prepared.after.tasksThinking,
					fileOperations: {
						writeFileSync,
						renameSync(from, to) {
							renameSync(from, to);
							writeFileSync(to, readFileSync(to, "utf8") + "\n");
						},
					},
				},
			);
			assert.equal(saved.configRevision, readConfigRevision(f.configPath));
		});
	});

	it("sends init drafts through the same selector, including the retained v1 handoff", async () => {
		for (const legacyHandoff of [false, true])
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
				if (legacyHandoff) {
					assert.match(f.sentUserMessages[0], /Use legacy_apply/);
					assert.doesNotMatch(
						f.sentUserMessages[0],
						/Draft a tasksThinking map/,
					);
				} else
					assert.match(
						f.sentUserMessages[0],
						/asks the user to approve through ctx.ui/,
					);
				const brief = JSON.parse(
					f.sentUserMessages[0].match(/```json\n([\s\S]*?)\n```/)![1],
				);
				const original = readFileSync(f.configPath);
				const select = f.ctx.ui.select;
				f.ctx.ui.select = async (...args) => {
					await select(...args);
					return NO;
				};
				await assert.rejects(
					f.writer.execute(
						"init",
						{ ...proposal(), expectedConfigRevision: brief.configRevision },
						undefined,
						undefined,
						f.ctx,
					),
					/not written/,
				);
				assert.equal(f.prompts.length, 1);
				assertUntouched(f, original);
			});
	});
});
