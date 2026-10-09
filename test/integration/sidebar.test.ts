/**
 * The sidebar plugin and the extension's marker writer against real,
 * isolated Herdr servers. A second server runs a real client attached to the
 * first, so assertions read the rendered Agents view, not `agent.list`.
 * Nothing here talks to the caller's Herdr server.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
	createLabRoot,
	HERDR_BIN,
	removeLabRoot,
	startLabServer,
	stopLabServer,
	type HerdrLabRoot,
	type HerdrLabServer,
} from "./herdr-lab.ts";
import {
	DELEGATED_MARKER_RENEW_MS,
	DelegatedMarkers,
	herdrMarkerWriter,
} from "../../maestro/runtime/delegated-marker.ts";
import {
	linuxProcessProbe,
	type PiProcessIdentity,
} from "../../maestro/adapters/pi/process-identity.ts";
import {
	isRecord,
	isString,
	type JsonObject,
} from "../../maestro/core/config/type-guards.ts";
import { shellQuote } from "../../maestro/core/shell.ts";

const PLUGIN_DIR = resolve(
	fileURLToPath(new URL("../../plugins/sidebar", import.meta.url)),
);
const PLUGIN_ID = "pi-herdr-agents.sidebar";
const TOKEN = "piha_delegated_v1";

const CONFIG = `onboarding = false
[terminal]
default_shell = "/bin/bash"
shell_mode = "non_login"
[update]
version_check = false
manifest_check = false
[ui]
sidebar_width = 36
sidebar_max_width = 40
[ui.sound]
enabled = false
[ui.toast]
delivery = "off"
[ui.sidebar.agents]
rows = [["state_icon", "workspace", "tab"], ["agent", "$${TOKEN}"]]
[experimental]
allow_nested = true
[server]
headless_cols = 170
headless_rows = 60
`;

// Holds a pane's agent authority, as a real agent process does.
const OCCUPANT = `import net from "node:net";
import { writeFileSync } from "node:fs";
const [file, agent, state] = process.argv.slice(2);
const socket = net.connect(process.env.HERDR_SOCKET_PATH, () =>
	socket.write(JSON.stringify({ id: "occupant", method: "pane.report_agent", params: {
		pane_id: process.env.HERDR_PANE_ID, source: "custom:lab", agent, state } }) + "\\n"));
socket.on("data", () => {
	socket.destroy();
	writeFileSync(file, JSON.stringify({ pid: process.pid, pane: process.env.HERDR_PANE_ID }));
});
setInterval(() => {}, 1 << 30);
`;

const supported = HERDR_BIN !== "" && process.platform === "linux";

interface Occupant {
	pid: number;
	pane: string;
}

function field(value: JsonObject, key: string): JsonObject {
	const child = value[key];
	assert.ok(isRecord(child), `missing ${key}`);
	return child;
}

function text(value: JsonObject, key: string): string {
	const child = value[key];
	assert.ok(isString(child), `missing ${key}`);
	return child;
}

describe("sidebar plugin on isolated Herdr", {
	skip: supported ? false : "needs Herdr and Linux /proc",
	timeout: 240_000,
}, () => {
	let lab: HerdrLabRoot;
	let target: HerdrLabServer;
	let viewer: HerdrLabServer | undefined;
	let viewerPane = "";
	let workspace = "";
	const panes = new Map<string, string>();
	const occupants: Occupant[] = [];
	let keepAlive: ReturnType<typeof setInterval>;
	let rawSeq = 1;

	async function startOccupant(
		pane: string,
		agent: string,
		state: string,
	): Promise<Occupant> {
		const file = join(lab.root, `occupant-${agent}-${occupants.length}.json`);
		target.cli([
			"pane",
			"run",
			pane,
			`node ${join(lab.root, "occupant.mjs")} ${file} ${agent} ${state}`,
		]);
		for (let i = 0; i < 100 && !existsSync(file); i++) await delay(100);
		assert.ok(existsSync(file), `occupant ${agent} did not report`);
		const occupant: Occupant = JSON.parse(readFileSync(file, "utf8"));
		occupants.push(occupant);
		return occupant;
	}

	function ownsOccupant(pid: number): boolean {
		try {
			return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(
				join(lab.root, "occupant.mjs"),
			);
		} catch {
			return false;
		}
	}

	async function stopOccupant(occupant: Occupant) {
		if (ownsOccupant(occupant.pid)) process.kill(occupant.pid, "SIGTERM");
		for (let i = 0; i < 50 && ownsOccupant(occupant.pid); i++) await delay(50);
		assert.equal(ownsOccupant(occupant.pid), false);
	}

	function identityOf(occupant: Occupant): PiProcessIdentity {
		const stat = linuxProcessProbe.stat(occupant.pid);
		assert.ok(stat);
		return {
			pid: occupant.pid,
			startTime: stat.startTime,
			...linuxProcessProbe.host(),
		};
	}

	/** A token written by the fixture, not the extension; no expiry. */
	async function fixtureToken(pane: string, value: string | null) {
		await target.ok("pane.report_metadata", {
			pane_id: pane,
			source: "lab-fixture",
			seq: rawSeq++,
			tokens: { [TOKEN]: value },
		});
	}

	async function paneToken(pane: string): Promise<string | undefined> {
		const info = field(await target.ok("pane.get", { pane_id: pane }), "pane");
		const tokens = info.tokens;
		const value = isRecord(tokens) ? tokens[TOKEN] : undefined;
		return isString(value) ? value : undefined;
	}

	async function waitForToken(
		pane: string,
		expected: string | undefined,
		timeoutMs = 5_000,
	) {
		const deadline = Date.now() + timeoutMs;
		let actual = await paneToken(pane);
		while (actual !== expected && Date.now() < deadline) {
			await delay(100);
			actual = await paneToken(pane);
		}
		assert.equal(actual, expected, `token on ${pane}`);
	}

	/** The Agents panel as the attached client draws it. */
	async function rendered(): Promise<string[]> {
		assert.ok(viewer);
		const read = field(
			await viewer.ok("pane.read", { pane_id: viewerPane, source: "visible" }),
			"read",
		);
		const lines = text(read, "text")
			.split("\n")
			.map((line) => line.split("│")[0].trimEnd());
		const start = lines.findIndex((line) => /^ agents\b/.test(line));
		return start < 0
			? []
			: lines.slice(start).filter((line) => line.trim() && line.trim() !== "«");
	}

	async function waitForRendered(
		predicate: (panel: string[]) => boolean,
		label: string,
	): Promise<string[]> {
		const deadline = Date.now() + 5_000;
		let panel = await rendered();
		while (!predicate(panel) && Date.now() < deadline) {
			await delay(100);
			panel = await rendered();
		}
		assert.ok(predicate(panel), `${label}:\n${panel.join("\n")}`);
		return panel;
	}

	const header = (panel: string[]) => panel[0]?.trim().split(/\s+/).at(-1);
	const shows = (panel: string[], agent: string) =>
		panel.some((line) => line.trim().split(" ")[0] === agent);

	async function invoke(action: "focus" | "all") {
		const invoked = await target.ok("plugin.action.invoke", {
			action_id: `${PLUGIN_ID}.${action}`,
		});
		const logId = text(field(invoked, "log"), "log_id");
		for (let i = 0; i < 100; i++) {
			const logs = (
				await target.ok("plugin.log.list", { plugin_id: PLUGIN_ID, limit: 50 })
			).logs;
			const log = Array.isArray(logs)
				? logs.find((entry) => isRecord(entry) && entry.log_id === logId)
				: undefined;
			if (isRecord(log) && log.status !== "running") return log;
			await delay(100);
		}
		throw new Error(`plugin action ${action} did not finish`);
	}

	before(async () => {
		keepAlive = setInterval(() => {}, 1_000);
		lab = createLabRoot(CONFIG);
		writeFileSync(join(lab.root, "occupant.mjs"), OCCUPANT);
		target = await startLabServer(lab, "sidebar-target");
		const created = await target.ok("workspace.create", {
			cwd: lab.root,
			label: "lab",
			focus: true,
		});
		workspace = text(field(created, "workspace"), "workspace_id");
		panes.set("main-agent", text(field(created, "root_pane"), "pane_id"));
		for (const agent of [
			"child-live",
			"child-idle",
			"child-blocked",
			"child-unknown",
			"child-other",
			"child-missing",
			"parent-a",
			"parent-b",
		]) {
			const tab = await target.ok("tab.create", {
				workspace_id: workspace,
				cwd: lab.root,
				label: agent,
				focus: false,
			});
			panes.set(agent, text(field(tab, "root_pane"), "pane_id"));
		}
		const states = new Map([
			["child-idle", "idle"],
			["child-blocked", "blocked"],
			["child-unknown", "unknown"],
		]);
		for (const [agent, pane] of panes)
			await startOccupant(pane, agent, states.get(agent) ?? "working");
		for (const agent of ["child-idle", "child-blocked", "child-unknown"])
			await fixtureToken(panes.get(agent) ?? "", "live");
		await fixtureToken(panes.get("child-other") ?? "", "stale");

		viewer = await startLabServer(lab, "sidebar-viewer");
		const viewerWorkspace = await viewer.ok("workspace.create", {
			cwd: lab.root,
			label: "viewer",
			focus: true,
		});
		viewerPane = text(field(viewerWorkspace, "root_pane"), "pane_id");
		viewer.cli([
			"pane",
			"run",
			viewerPane,
			// The lab PATH may not reach HERDR_BIN; run the same binary as the servers.
			`${shellQuote(HERDR_BIN)} --session ${shellQuote(target.session)}`,
		]);
		await waitForRendered(
			(panel) => shows(panel, "child-missing"),
			"client attached",
		);
	});

	after(async () => {
		try {
			for (const occupant of occupants)
				if (ownsOccupant(occupant.pid)) process.kill(occupant.pid, "SIGTERM");
			if (viewer) await stopLabServer(lab, viewer);
			if (target) await stopLabServer(lab, target);
			if (lab) removeLabRoot(lab);
		} finally {
			clearInterval(keepAlive);
		}
	});

	it("links from its own directory with Focus and All and no warnings", async () => {
		const linked = field(
			await target.ok("plugin.link", { path: PLUGIN_DIR, enabled: true }),
			"plugin",
		);
		assert.equal(linked.plugin_id, PLUGIN_ID);
		assert.equal(linked.name, "Pi Herdr Agents Sidebar");
		assert.equal(linked.warnings, undefined);
		const actions = (
			await target.ok("plugin.action.list", { plugin_id: PLUGIN_ID })
		).actions;
		assert.ok(Array.isArray(actions));
		assert.deepEqual(
			actions
				.map((action) => (isRecord(action) ? action.action_id : undefined))
				.sort(),
			["all", "focus"],
		);
		const panel = await rendered();
		assert.notEqual(header(panel), "focus");
	});

	it("Focus hides only live-marked idle or working children, and All restores them", async () => {
		const live = panes.get("child-live") ?? "";
		const markers = new DelegatedMarkers({
			write: herdrMarkerWriter(target.socket),
		});
		const occupant = occupants.find((entry) => entry.pane === live);
		assert.ok(occupant);
		const marker = markers.attach({
			surface: live,
			processIdentityCapture: Promise.resolve(identityOf(occupant)),
		});
		await waitForToken(live, "live");

		const focus = await invoke("focus");
		assert.equal(focus.exit_code, 0);
		assert.match(String(focus.stdout), /replaced whatever agent view/);
		const panel = await waitForRendered(
			(lines) => header(lines) === "focus" && !shows(lines, "child-live"),
			"Focus projection",
		);
		for (const agent of [
			"main-agent",
			"child-blocked",
			"child-unknown",
			"child-other",
			"child-missing",
		])
			assert.ok(shows(panel, agent), `${agent} hidden:\n${panel.join("\n")}`);
		assert.equal(shows(panel, "child-idle"), false);
		const agents = (await target.ok("agent.list", {})).agents;
		assert.ok(
			Array.isArray(agents) &&
				agents.some((agent) => isRecord(agent) && agent.pane_id === live),
		);

		const all = await invoke("all");
		assert.equal(all.exit_code, 0);
		await waitForRendered(
			(lines) =>
				header(lines) !== "focus" &&
				shows(lines, "child-live") &&
				shows(lines, "child-idle"),
			"All projection",
		);
		marker.retire();
		await marker.settled();
		await waitForToken(live, undefined);
	});

	it("All leaves another tool's view in place and says so", async () => {
		await target.ok("agent.view.set", {
			source: "other-tool",
			label: "other",
			filter: { op: "eq", field: "agent", value: "main-agent" },
		});
		try {
			const all = await invoke("all");
			assert.equal(all.exit_code, 3);
			assert.match(String(all.stderr), /source other-tool, label other/);
			await waitForRendered(
				(lines) => header(lines) === "other" && !shows(lines, "child-missing"),
				"foreign view still active",
			);
		} finally {
			await target.ok("agent.view.clear", { source: "other-tool" });
		}
	});

	it("stops marking once the child exits, and a later occupant is never hidden", async () => {
		const live = panes.get("child-live") ?? "";
		const clock = { now: Date.now() };
		const markers = new DelegatedMarkers({
			write: herdrMarkerWriter(target.socket),
			now: () => clock.now,
		});
		const occupant = occupants.find((entry) => entry.pane === live);
		assert.ok(occupant);
		const marker = markers.attach({
			surface: live,
			processIdentityCapture: Promise.resolve(identityOf(occupant)),
		});
		await waitForToken(live, "live");
		assert.equal((await invoke("focus")).exit_code, 0);
		await waitForRendered(
			(lines) => header(lines) === "focus" && !shows(lines, "child-live"),
			"marked child hidden",
		);

		await stopOccupant(occupant);
		clock.now += DELEGATED_MARKER_RENEW_MS;
		marker.renew();
		await marker.settled();
		assert.equal(marker.kind, "retired");
		await waitForToken(live, undefined);

		await target.ok("pane.report_metadata", {
			pane_id: live,
			source: "pi-herdr-agents",
			seq: clock.now * 1000 - 1,
			tokens: { [TOKEN]: "live" },
			ttl_ms: 15_000,
		});
		assert.equal(await paneToken(live), undefined);

		await startOccupant(live, "child-reuse", "working");
		clock.now += DELEGATED_MARKER_RENEW_MS;
		marker.renew();
		await marker.settled();
		await waitForRendered(
			(lines) => header(lines) === "focus" && shows(lines, "child-reuse"),
			"replacement occupant visible under Focus",
		);
		assert.equal(await paneToken(live), undefined);
		assert.equal((await invoke("all")).exit_code, 0);
	});

	it("keeps two parents' markers independent on one source", async () => {
		const paneA = panes.get("parent-a") ?? "";
		const paneB = panes.get("parent-b") ?? "";
		const capture = (pane: string) => {
			const occupant = occupants.find((entry) => entry.pane === pane);
			assert.ok(occupant);
			return Promise.resolve(identityOf(occupant));
		};
		const parentA = new DelegatedMarkers({
			write: herdrMarkerWriter(target.socket),
		});
		const parentB = new DelegatedMarkers({
			write: herdrMarkerWriter(target.socket),
		});
		const markerA = parentA.attach({
			surface: paneA,
			processIdentityCapture: capture(paneA),
		});
		const markerB = parentB.attach({
			surface: paneB,
			processIdentityCapture: capture(paneB),
		});
		await waitForToken(paneA, "live");
		await waitForToken(paneB, "live");
		markerA.retire();
		await markerA.settled();
		await waitForToken(paneA, undefined);
		assert.equal(await paneToken(paneB), "live");
		markerB.retire();
		await markerB.settled();
		await waitForToken(paneB, undefined);
	});

	it("lets an unrenewed marker expire after its 15-second TTL", async () => {
		const pane = panes.get("child-missing") ?? "";
		const write = herdrMarkerWriter(target.socket);
		const sentAt = Date.now();
		assert.equal(
			await write({ paneId: pane, seq: sentAt * 1000, live: true }),
			"answered",
		);
		await waitForToken(pane, "live");
		await waitForToken(pane, undefined, 25_000);
		const elapsed = Date.now() - sentAt;
		assert.ok(elapsed >= 14_000, `expired after ${elapsed}ms`);
	});

	it("reports a missing pane to the marker writer", async () => {
		const write = herdrMarkerWriter(target.socket);
		assert.equal(
			await write({ paneId: `${workspace}:p999`, seq: 1, live: true }),
			"pane-missing",
		);
	});

	it("drops its view when the plugin is unlinked", async () => {
		assert.equal((await invoke("focus")).exit_code, 0);
		await waitForRendered((lines) => header(lines) === "focus", "Focus on");
		await target.ok("plugin.unlink", { plugin_id: PLUGIN_ID });
		await waitForRendered(
			(lines) => header(lines) !== "focus" && shows(lines, "child-idle"),
			"view dropped on unlink",
		);
	});
});
