import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
	ALL_MESSAGE,
	FOCUS_MESSAGE,
	FOCUS_PARAMS,
	PLUGIN_ID,
	VIEW_SOURCE,
	requestHerdr,
	runAction,
} from "../plugins/sidebar/sidebar.mjs";
import {
	DELEGATED_MARKER_TOKEN,
	DELEGATED_MARKER_VALUE,
} from "../maestro/runtime/delegated-marker.ts";
import {
	replyError,
	replyResult,
	withFakeHerdrSocket,
} from "./fake-herdr-socket.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = join(root, "plugins", "sidebar");
const script = join(pluginDir, "sidebar.mjs");

function capture() {
	const lines = { log: [], error: [] };
	return {
		lines,
		out: {
			log: (text) => lines.log.push(text),
			error: (text) => lines.error.push(text),
		},
	};
}

function run(action, socketPath, env = {}) {
	const { lines, out } = capture();
	return runAction(action, {
		env: { HERDR_SOCKET_PATH: socketPath, HERDR_PLUGIN_ID: PLUGIN_ID, ...env },
		out,
	}).then((code) => ({ code, ...lines }));
}

describe("sidebar plugin contract", () => {
	it("hides only a live marker on an idle, working, or done agent", () => {
		assert.equal(VIEW_SOURCE, "plugin:pi-herdr-agents.sidebar");
		// One `filter` under `not`; Herdr rejects a `filters` array there.
		assert.deepEqual(FOCUS_PARAMS, {
			source: "plugin:pi-herdr-agents.sidebar",
			label: "focus",
			filter: {
				op: "not",
				filter: {
					op: "all",
					filters: [
						{
							op: "eq",
							field: { token: "piha_delegated_v1" },
							value: "live",
						},
						{ op: "in", field: "status", values: ["idle", "working", "done"] },
					],
				},
			},
		});
		assert.equal(Object.hasOwn(FOCUS_PARAMS, "sort"), false);
	});

	it("reads the same token and value the extension writes", () => {
		const leaf = FOCUS_PARAMS.filter.filter.filters[0];
		assert.equal(leaf.field.token, DELEGATED_MARKER_TOKEN);
		assert.equal(leaf.value, DELEGATED_MARKER_VALUE);
	});

	it("imports only Node built-ins so a subdirectory install runs as is", () => {
		const source = readFileSync(script, "utf8");
		const specifiers = [
			...source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"/g),
		].map((match) => match[1] ?? match[2]);
		assert.ok(specifiers.length > 0);
		for (const specifier of specifiers)
			assert.match(specifier, /^node:/, `non built-in import ${specifier}`);
	});

	it("declares Focus and All with an honest platform and version floor", () => {
		const manifest = readFileSync(join(pluginDir, "herdr-plugin.toml"), "utf8");
		assert.match(manifest, /^id = "pi-herdr-agents\.sidebar"$/m);
		assert.match(manifest, /^name = "Pi Herdr Agents Sidebar"$/m);
		assert.match(
			manifest,
			// Herdr rejects prerelease versions here; the tested preview reports 0.9.2.
			/^min_herdr_version = "0\.9\.2"$/m,
		);
		assert.match(manifest, /^platforms = \["linux"\]$/m);
		assert.deepEqual(
			[...manifest.matchAll(/^id = "([a-z]+)"$/gm)].map((match) => match[1]),
			["focus", "all"],
		);
		assert.deepEqual(
			[...manifest.matchAll(/^command = (.+)$/gm)].map((match) =>
				JSON.parse(match[1]),
			),
			[
				["node", "sidebar.mjs", "focus"],
				["node", "sidebar.mjs", "all"],
			],
		);
		assert.doesNotMatch(manifest, /\[\[(startup|events|panes)\]\]/);
	});
});

describe("Focus", () => {
	it("sets exactly one view and explains that it replaced any other", () =>
		withFakeHerdrSocket(
			replyResult({
				type: "agent_view",
				active: true,
				source: VIEW_SOURCE,
				label: "focus",
			}),
			async (path, requests) => {
				const result = await run("focus", path);
				assert.deepEqual(result, { code: 0, log: [FOCUS_MESSAGE], error: [] });
				assert.match(FOCUS_MESSAGE, /replaced whatever agent view was active/);
				assert.deepEqual(
					requests.map(({ method, params }) => ({ method, params })),
					[{ method: "agent.view.set", params: FOCUS_PARAMS }],
				);
			},
		));

	it("reports Herdr's refusal", () =>
		withFakeHerdrSocket(
			replyError("plugin_disabled", "plugin is disabled"),
			async (path) => {
				const result = await run("focus", path);
				assert.equal(result.code, 1);
				assert.deepEqual(result.error, [
					"Focus failed: plugin_disabled: plugin is disabled",
				]);
			},
		));

	it("does not claim success when Herdr reports another owner", () =>
		withFakeHerdrSocket(
			replyResult({ type: "agent_view", active: true, source: "other-tool" }),
			async (path) => {
				const result = await run("focus", path);
				assert.equal(result.code, 1);
				assert.match(result.error[0], /unexpected reply/);
			},
		));
});

describe("All", () => {
	it("clears only this plugin's view", () =>
		withFakeHerdrSocket(
			replyResult({ type: "agent_view", active: false }),
			async (path, requests) => {
				assert.deepEqual(await run("all", path), {
					code: 0,
					log: [ALL_MESSAGE],
					error: [],
				});
				assert.deepEqual(
					requests.map(({ method, params }) => ({ method, params })),
					[{ method: "agent.view.clear", params: { source: VIEW_SOURCE } }],
				);
			},
		));

	it("leaves a foreign view in place and says so", () =>
		withFakeHerdrSocket(
			replyResult({
				type: "agent_view",
				active: true,
				source: "other-tool",
				label: "mine",
			}),
			async (path) => {
				const result = await run("all", path);
				assert.equal(result.code, 3);
				assert.deepEqual(result.log, []);
				assert.match(
					result.error[0],
					/^Another agent view is still active \(source other-tool, label mine\)\. All clears only this plugin's Focus/,
				);
			},
		));

	it("fails if its own view survives the clear", () =>
		withFakeHerdrSocket(
			replyResult({ type: "agent_view", active: true, source: VIEW_SOURCE }),
			async (path) => {
				assert.equal((await run("all", path)).code, 1);
			},
		));

	it("fails on a reply that is not an agent view", () =>
		withFakeHerdrSocket(replyResult({ type: "ok" }), async (path) => {
			assert.equal((await run("all", path)).code, 1);
		}));
});

describe("plugin action guards", () => {
	it("refuses to run without Herdr's socket, a known action, or its own plugin id", async () => {
		await withFakeHerdrSocket(replyResult({}), async (path, requests) => {
			assert.equal((await run("focus", "")).code, 1);
			assert.equal((await run("bogus", path)).code, 2);
			const foreign = await run("all", path, {
				HERDR_PLUGIN_ID: "someone.else",
			});
			assert.equal(foreign.code, 1);
			assert.match(
				foreign.error[0],
				/refusing to change a view it does not own/,
			);
			assert.deepEqual(requests, []);
		});
	});
});

describe("plugin socket request", () => {
	it("fails on a timeout, partial data, another id, or an oversized reply", async () => {
		await withFakeHerdrSocket(
			() => {},
			async (path) => {
				const reply = await requestHerdr(path, "ping", {}, { timeoutMs: 50 });
				assert.deepEqual(reply.error, {
					code: "timeout",
					message: "ping got no reply in 50ms",
				});
			},
		);
		await withFakeHerdrSocket(
			(_request, socket) => socket.end('{"id":'),
			async (path) => {
				assert.equal(
					(await requestHerdr(path, "ping", {})).error.code,
					"closed",
				);
			},
		);
		await withFakeHerdrSocket(
			(_request, socket) => socket.end('{"id":"other","result":{}}\n'),
			async (path) => {
				assert.equal(
					(await requestHerdr(path, "ping", {}, { id: "mine" })).error.code,
					"wrong_id",
				);
			},
		);
		await withFakeHerdrSocket(
			(_request, socket) => socket.write("x".repeat(4_096)),
			async (path) => {
				assert.equal(
					(await requestHerdr(path, "ping", {}, { maxBytes: 1_024 })).error
						.code,
					"too_large",
				);
			},
		);
		await withFakeHerdrSocket(
			(_request, socket) => socket.end("not json\n"),
			async (path) => {
				assert.equal(
					(await requestHerdr(path, "ping", {})).error.code,
					"malformed",
				);
			},
		);
	});

	it("runs as a command with Herdr's environment and exit codes", () =>
		withFakeHerdrSocket(
			replyResult({ type: "agent_view", active: true, source: "other-tool" }),
			async (path) => {
				const result = await new Promise((resolve) => {
					execFile(
						process.execPath,
						[script, "all"],
						{
							cwd: pluginDir,
							env: { PATH: process.env.PATH, HERDR_SOCKET_PATH: path },
						},
						(error, stdout, stderr) =>
							resolve({ code: error?.code ?? 0, stdout, stderr }),
					);
				});
				assert.equal(result.code, 3);
				assert.equal(result.stdout, "");
				assert.match(result.stderr, /source other-tool/);
			},
		));
});
