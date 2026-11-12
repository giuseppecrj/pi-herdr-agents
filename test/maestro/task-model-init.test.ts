import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
	startTaskModelInit,
	type TaskModelInitInput,
} from "../../maestro/runtime/task-model-init.ts";
import {
	collectApprovalOffers,
	openApprovalOffer,
	selectApprovalRoute,
	type TaskModelBrief,
	type TaskModelRegistryProjector,
} from "../../maestro/core/config/task-model-init.ts";

const REVISION = `sha256:${"ab".repeat(32)}`;
const ONE_MODEL = [{ provider: "p", id: "m", reasoning: false }];

/** An init run against a fake host; `events` records what happened, in order. */
function initHost(
	overrides: (events: string[]) => Partial<TaskModelInitInput> = () => ({}),
) {
	const events: string[] = [];
	const prompts: string[] = [];
	const briefs: TaskModelBrief[] = [];
	const input: TaskModelInitInput = {
		preferences: "",
		readConfig: () => ({ config: { agents: {} }, revision: REVISION }),
		projectActiveRegistry: (project) =>
			project({ getAvailable: () => ONE_MODEL }),
		emitApprovalRequest: (brief) => {
			briefs.push(brief);
			events.push("emit");
		},
		isToolActive: () => true,
		submit: (prompt) => {
			events.push("submit");
			prompts.push(prompt);
		},
		...overrides(events),
	};
	return { outcome: startTaskModelInit(input), events, prompts, briefs };
}

function ready(toolName: string, instructions: string, cancel = () => {}) {
	return { kind: "ready", destination: { toolName, instructions }, cancel };
}

describe("task-model init composition", () => {
	it("composes the complete active projection and preserves the exact accepted prompt", () => {
		const calls: string[] = [];
		const models = [
			{ provider: "z", id: "unknown", name: "Unknown", reasoning: false },
			{
				provider: "a",
				id: "zero",
				name: "Zero",
				reasoning: true,
				thinkingLevelMap: { max: "max", xhigh: null },
				input: ["text", "image", "secret"],
				contextWindow: 99,
				maxTokens: 12,
				cost: { input: 0, output: 2, cacheRead: 0 },
				baseUrl: "secret-url",
			},
		];
		const registry = {
			getRegisteredProviderIds() {
				assert.equal(this, registry);
				calls.push("extensions");
				return ["a"];
			},
			getAvailable() {
				assert.equal(this, registry);
				calls.push("available");
				return models;
			},
			getProviderAuthStatus(provider: string) {
				assert.equal(this, registry);
				calls.push(`auth:${provider}`);
				return {
					source: provider === "a" ? "stored" : "secret-source",
					token: "secret-token",
				};
			},
			getAll() {
				throw new Error("no unauthenticated query");
			},
			getApiKey() {
				throw new Error("no authentication resolution");
			},
			refresh() {
				throw new Error("no refresh/network");
			},
		};
		const current = {
			agents: { worker: "a/zero" },
			default: "z/unknown",
			tasks: { coding: ["a/zero"] },
		};
		const { outcome, prompts, briefs } = initHost(() => ({
			preferences: "  keep existing\nchoices  ",
			readConfig: () => {
				calls.push("config");
				return { config: current, revision: REVISION };
			},
			projectActiveRegistry: (project: TaskModelRegistryProjector) => {
				calls.push("projection");
				return project(registry);
			},
		}));
		assert.deepEqual(outcome, {
			kind: "started",
			destination: "subagents_write_task_models",
		});
		assert.deepEqual(calls, [
			"config",
			"projection",
			"extensions",
			"available",
			"auth:z",
			"auth:a",
		]);
		const [prompt] = prompts;
		const [brief] = briefs;
		assert.equal(brief.current, current, "the brief carries the saved config");
		assert.equal(brief.configRevision, REVISION);
		assert.equal(brief.operatorPreferences, "keep existing\nchoices");
		assert.deepEqual(
			brief.models.map((m) => m.ref),
			["a/zero", "z/unknown"],
		);
		assert.equal(brief.models[0].cost?.input, 0);
		assert.equal(brief.models[0].cost?.cacheWrite, undefined);
		assert.equal(brief.models[1].cost, undefined);
		assert.equal(brief.models[0].extensionRegistered, true);
		assert.equal(brief.models[1].extensionRegistered, false);
		assert.deepEqual(brief.models[0].supportedThinkingLevels, [
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"max",
		]);
		assert.doesNotMatch(prompt, /secret-/);
		// Golden SHA-256 of the accepted direct-writer prompt for these facts.
		// Recaptured when basis guidance distinguished the compact dialog from the tool result.
		assert.equal(
			createHash("sha256").update(prompt).digest("hex"),
			"ee1c2798118b09883d54d156a73eb21b9fd286de85c42b4ddaef5008c35bbd1e",
		);
		const unknown = initHost(() => ({
			projectActiveRegistry: (project) =>
				project({ getAvailable: () => [models[0]] }),
		})).prompts[0];
		const json = JSON.parse(unknown.match(/```json\n([\s\S]*?)\n```/)![1]);
		assert.equal(Object.hasOwn(json.models[0], "extensionRegistered"), false);
		assert.deepEqual(json.models[0].auth, { configured: true });
	});

	it("describes a basis-kind summary in the dialog and research sources in the tool result", () => {
		const { prompts } = initHost();
		assert.match(
			prompts[0],
			/approval dialog summarizes the basis by kind as submitted, not independently verified/,
		);
		assert.match(
			prompts[0],
			/research sources and their influence appear in the tool result/,
		);
		assert.doesNotMatch(prompts[0], /The basis is shown as submitted/);
	});

	it("includes saved thinking in the brief and asks for a thinking draft", () => {
		const { briefs, prompts } = initHost(() => ({
			readConfig: () => ({
				config: { agents: {}, tasksThinking: { coding: "high" } },
				revision: REVISION,
			}),
		}));
		assert.deepEqual(briefs[0].current.tasksThinking, { coding: "high" });
		const json = JSON.parse(prompts[0].match(/```json\n([\s\S]*?)\n```/)![1]);
		assert.deepEqual(json.current.tasksThinking, { coding: "high" });
		assert.match(prompts[0], /Draft a tasksThinking map/);
		assert.match(prompts[0], /reviewed draft as tasks and tasksThinking/);
	});

	it("reports an empty registry or an invalid config without asking anyone or prompting", () => {
		const empty = initHost(() => ({
			projectActiveRegistry: (project) => project({ getAvailable: () => [] }),
		}));
		assert.deepEqual(empty.outcome, {
			kind: "not-started",
			reason:
				"the active registry has no authenticated models, so there is nothing to rank. Configure a provider, then run /subagents-init again",
		});
		assert.deepEqual(empty.events, []);
		const invalid = initHost(() => ({
			readConfig: () => {
				throw new Error("Invalid JSON in subagent model config /x: nope");
			},
		}));
		assert.deepEqual(invalid.outcome, {
			kind: "not-started",
			reason: "Invalid JSON in subagent model config /x: nope",
		});
		assert.deepEqual(invalid.events, []);
	});

	it("replaces the writer instruction with the one offer's destination, opened after collection", () => {
		const { outcome, events, prompts } = initHost((events) => ({
			emitApprovalRequest: (_brief, offer) => {
				events.push("emit");
				assert.equal(
					offer({
						owner: "approval-pack",
						open: () => {
							events.push("open");
							return ready("pack_apply", "Call pack_apply once with basis.");
						},
					}),
					"recorded",
				);
				events.push("emit returned");
			},
		}));
		assert.deepEqual(outcome, { kind: "started", destination: "pack_apply" });
		assert.deepEqual(events, ["emit", "emit returned", "open", "submit"]);
		assert.match(prompts[0], /\n\nCall pack_apply once with basis\.\n\n/);
		assert.doesNotMatch(prompts[0], /call subagents_write_task_models/i);
		assert.doesNotMatch(prompts[0], /normalized saved tasks/);
		assert.match(prompts[0], /Submit the ranking basis/);
		assert.doesNotMatch(prompts[0], /Draft a tasksThinking map/);
	});

	it("freezes the brief listeners see, so the prompt shows what they saw", () => {
		const { prompts } = initHost(() => ({
			preferences: "original",
			emitApprovalRequest: (brief) => {
				assert.throws(() => {
					brief.operatorPreferences = "changed";
				}, TypeError);
				assert.throws(() => {
					brief.models.push(brief.models[0]);
				}, TypeError);
				assert.throws(() => {
					brief.current.agents.x = "y";
				}, TypeError);
			},
		}));
		const json = JSON.parse(prompts[0].match(/```json\n([\s\S]*?)\n```/)![1]);
		assert.equal(json.operatorPreferences, "original");
		assert.equal(json.models.length, 1);
		assert.equal(json.configRevision, REVISION);
	});

	it("opens no offer when more than one arrives and submits nothing", () => {
		let opened = 0;
		const open = () => {
			opened += 1;
			return ready("x", "y");
		};
		const { outcome, events } = initHost(() => ({
			emitApprovalRequest: (_brief, offer) => {
				offer({ owner: "z-pack", open });
				offer({ owner: "a-pack", open });
				offer({ owner: "a-pack", open });
			},
		}));
		assert.deepEqual(outcome, {
			kind: "not-started",
			reason:
				"more than one extension offered to approve task-model writes (a-pack, a-pack, z-pack); keep one loaded",
		});
		assert.equal(opened, 0);
		assert.deepEqual(events, []);
	});

	it("never falls back to the direct writer once an offer is recorded", () => {
		const cases: Array<[string, () => any, RegExp]> = [
			[
				"throws",
				() => {
					throw new Error("boom");
				},
				/^p failed to open its approval flow \(boom\); the host cannot undo what it changed$/,
			],
			[
				"answers with a promise",
				async () => ready("x", "y"),
				/^p answered asynchronously, but v1 opens synchronously/,
			],
			[
				"refuses",
				() => ({ kind: "blocked", reason: " busy " }),
				/^p refused: busy$/,
			],
			["refuses silently", () => ({ kind: "blocked" }), /^p refused without/],
			[
				"names an invalid tool",
				() => ready("bad tool", "y"),
				/^p returned an invalid open result; the host cannot undo what it changed$/,
			],
			[
				"gives no instructions",
				() => ready("x", "  "),
				/^p returned an invalid open result/,
			],
			[
				"cannot be cancelled",
				() => ({ ...ready("x", "y"), cancel: undefined }),
				/^p returned an invalid open result/,
			],
			["returns nothing", () => undefined, /invalid open result/],
		];
		for (const [label, open, reason] of cases) {
			const { outcome, events } = initHost(() => ({
				emitApprovalRequest: (_brief, offer) => {
					offer({ owner: "p", open });
				},
			}));
			assert.equal(outcome.kind, "not-started", label);
			assert.match(
				outcome.kind === "not-started" ? outcome.reason : "",
				reason,
				label,
			);
			assert.deepEqual(events, [], `${label}: nothing was submitted`);
		}
		const inactive = initHost(() => ({ isToolActive: () => false }));
		assert.deepEqual(inactive.outcome, {
			kind: "not-started",
			reason: "subagents_write_task_models is not an active tool",
		});
		assert.deepEqual(inactive.events, ["emit"]);
	});

	it("asks the host to activate the destination tool before checking it", () => {
		const direct = initHost((events) => ({
			activateTool: (name) => events.push(`activate ${name}`),
			isToolActive: (name) => {
				events.push(`check ${name}`);
				return true;
			},
		}));
		assert.equal(direct.outcome.kind, "started");
		assert.deepEqual(direct.events, [
			"emit",
			"activate subagents_write_task_models",
			"check subagents_write_task_models",
			"submit",
		]);
		const offered = initHost((events) => ({
			emitApprovalRequest: (_brief, offer) => {
				events.push("emit");
				offer({
					owner: "p",
					open: () => ready("pack_apply", "Use pack_apply."),
				});
			},
			activateTool: (name) => events.push(`activate ${name}`),
		}));
		assert.deepEqual(offered.events, ["emit", "activate pack_apply", "submit"]);
	});

	it("cancels an opened offer whose prompt is not submitted, and only then", () => {
		const offering =
			(events: string[], cancel = () => events.push("cancel")) =>
			(_brief: TaskModelBrief, offer: (raw: any) => string) => {
				offer({
					owner: "p",
					open: () => {
						events.push("open");
						return ready("pack_apply", "Use pack_apply.", cancel);
					},
				});
			};
		const cases: Array<[string, Partial<TaskModelInitInput>, string]> = [
			[
				"its tool is inactive",
				{ isToolActive: () => false },
				"pack_apply is not an active tool",
			],
			[
				"Pi throws while taking the prompt",
				{
					submit: () => {
						throw new Error("stale extension context");
					},
				},
				"Pi did not accept the init prompt (stale extension context)",
			],
		];
		for (const [label, override, reason] of cases) {
			const { outcome, events } = initHost((events) => ({
				emitApprovalRequest: offering(events),
				...override,
			}));
			assert.deepEqual(outcome, { kind: "not-started", reason }, label);
			assert.deepEqual(events, ["open", "cancel"], label);
		}
		const failing = initHost((events) => ({
			emitApprovalRequest: offering(events, () => {
				throw new Error("already gone");
			}),
			isToolActive: () => false,
		}));
		assert.deepEqual(failing.outcome, {
			kind: "not-started",
			reason:
				"pack_apply is not an active tool; p failed to close its approval flow (already gone)",
		});
		const submitted = initHost((events) => ({
			emitApprovalRequest: offering(events),
		}));
		assert.equal(submitted.outcome.kind, "started");
		assert.deepEqual(submitted.events, ["open", "submit"], "no cancel");
	});
});

describe("approval offer collection and selection", () => {
	it("routes zero offers to the writer, one to its owner, and anything else nowhere", () => {
		const offer = (owner: string) => ({ owner, open: () => undefined });
		const route = (...raws: unknown[]) =>
			selectApprovalRoute(
				collectApprovalOffers((accept) => {
					for (const raw of raws) accept(raw);
				}),
			);
		assert.deepEqual(route(), { kind: "direct" });
		const one = route(offer("only"));
		assert.equal(one.kind, "offer");
		assert.equal(one.kind === "offer" && one.offer.owner, "only");
		assert.deepEqual(route(offer("b"), offer("a")), {
			kind: "refused",
			reason:
				"more than one extension offered to approve task-model writes (a, b); keep one loaded",
		});
		const malformed: Array<[unknown, string]> = [
			[undefined, "an empty offer"],
			[{ owner: "two words", open: () => {} }, "an offer without a printable"],
			[{ owner: "", open: () => {} }, "an offer without a printable"],
			[{ owner: "p" }, "p offered no open function"],
			[{ owner: "p", open: "not callable" }, "p offered no open function"],
		];
		for (const [raw, expected] of malformed) {
			const result = route(offer("valid"), raw);
			assert.equal(result.kind, "refused", JSON.stringify(raw));
			assert.match(
				result.kind === "refused" ? result.reason : "",
				new RegExp(`^an approval listener answered with ${expected}`),
			);
		}
	});

	it("records offers only while emit runs and invokes none of them", () => {
		let late: ((offer: any) => string) | undefined;
		let opened = 0;
		const collected = collectApprovalOffers((accept) => {
			late = accept;
			accept({
				owner: "p",
				open: () => {
					opened += 1;
				},
			});
		});
		assert.equal(collected.offers.length, 1);
		assert.equal(opened, 0, "collection never opens an offer");
		assert.equal(late?.({ owner: "q", open: () => {} }), "closed");
		assert.equal(collected.offers.length, 1, "a late offer is ignored");
		assert.equal(collected.problems.length, 0);
	});

	it("opens a ready offer and copies its destination", () => {
		const raw = {
			owner: "p",
			open: () => ready("tool_1", "  Use tool_1.  "),
		};
		const [offer] = collectApprovalOffers((accept) => {
			accept(raw);
		}).offers;
		raw.open = () => ready("other", "swapped");
		const opened = openApprovalOffer(offer);
		assert.equal(opened.kind, "ready");
		assert.deepEqual(opened.kind === "ready" && opened.destination, {
			toolName: "tool_1",
			instructions: "Use tool_1.",
		});
	});

	it("matches the Pi event bus: offers before the first await count, later ones and pre-offer throws do not", async () => {
		const bus = createEventBus();
		const channel = "test:approval";
		const errors: unknown[][] = [];
		const consoleError = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args);
		};
		// The bus hands listeners untyped data; these tests emit only `{ offer }`.
		const onRequest = (
			listen: (request: { offer(offer: any): string }) => void | Promise<void>,
		) => bus.on(channel, (data: any) => listen(data));
		try {
			let lateAnswer: string | undefined;
			onRequest(async (request) => {
				request.offer({ owner: "sync-prefix", open: () => ready("a", "b") });
				await Promise.resolve();
				lateAnswer = request.offer({ owner: "late", open: () => {} });
			});
			bus.on(channel, () => {
				throw new Error("before offering");
			});
			onRequest((request) => {
				request.offer({ owner: "then-throws", open: () => ready("c", "d") });
				throw new Error("after offering");
			});
			const collected = collectApprovalOffers((offer) => {
				bus.emit(channel, { offer });
			});
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(
				collected.offers.map((offer) => offer.owner),
				["sync-prefix", "then-throws"],
			);
			assert.equal(lateAnswer, "closed");
			assert.deepEqual(
				errors.map((args) => String(args[1])),
				["Error: before offering", "Error: after offering"],
				"the bus swallowed both throws",
			);
			// A throw before offering is indistinguishable from no listener.
			const silent = createEventBus();
			silent.on(channel, () => {
				throw new Error("before offering");
			});
			assert.deepEqual(
				selectApprovalRoute(
					collectApprovalOffers((offer) => {
						silent.emit(channel, { offer });
					}),
				),
				{ kind: "direct" },
			);
		} finally {
			console.error = consoleError;
		}
	});
});
