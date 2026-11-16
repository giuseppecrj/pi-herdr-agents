import "../isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createDefaultRunSession } from "@nubl/maestro/runtime/pi-run-session";
import type { DefaultRunSessionOptions } from "@nubl/maestro/runtime/pi-run-session-types";
import { FakeSurfaceProvider } from "@nubl/maestro/testing";
import { launchOperationsFromSurface } from "@nubl/maestro/adapters/pi/launch-operations";
import { SupervisionCoordinator } from "@nubl/maestro/core/supervision";
import { DEFAULT_CHILD_ENTRY_PATH } from "@nubl/maestro/adapters/pi/launch-command";
import { getSubagentsConfigExamplePath } from "@nubl/maestro/pi/subagents/config-path";
import { hostSurfaceBinding } from "../../pi-extension/subagents/host-surface.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
function probe(path: string, ...args: string[]): string {
	return execFileSync(
		process.execPath,
		["--experimental-strip-types", join(repo, path), ...args],
		{ cwd: repo, encoding: "utf8", timeout: 60_000 },
	);
}

test("H1 freezes the before-hook parent/child/deny-tool contract and registration order", () => {
	const actual = JSON.parse(
		probe(".pi/skills/verify-pi-herdr-agents/scripts/pin.ts"),
	);
	delete actual.repo;
	assert.deepEqual(
		actual,
		JSON.parse(
			readFileSync(join(repo, "test/fixtures/h1-contract.json"), "utf8"),
		),
	);
});

test("H1 real Pi /reload loader path preserves ownership, held delivery and registration while refreshing config", () => {
	assert.deepEqual(
		JSON.parse(probe("test/fixtures/h1-reload-probe.ts")),
		JSON.parse(
			readFileSync(join(repo, "test/fixtures/h1-reload.json"), "utf8"),
		),
	);
});

function options(configDir: string): DefaultRunSessionOptions {
	return {
		configDir,
		configExamplePath: join(repo, "config.json.example"),
		roles: [],
		forcePolling: false,
		getLaunchSnapshot() {
			throw new Error("not launching");
		},
		hooks: { onSettled() {} },
		persistent: {
			send: () => ({ error: "unused" }),
			stop: () => ({ error: "unused" }),
			drain() {},
		},
	};
}

test("H1 missing host composition fails before acquisition; injected infrastructure never consults the host", async () => {
	const dir = mkdtempSync(join(tmpdir(), "piha-h1-binding-"));
	const paneConfig = {
		mode: "grouped" as const,
		direction: "right" as const,
		maxPerTab: 4,
	};
	const surface = new FakeSurfaceProvider();
	const supervision = new SupervisionCoordinator(
		async () => ({ complete: true, panes: [] }),
		(id) => surface.inspectSurface(id),
	);
	let discoveries = 0;
	const unexpected = () => {
		discoveries++;
		throw new Error("ambient host consulted");
	};
	try {
		assert.throws(() => createDefaultRunSession(options(dir)), {
			message: "Pi run session requires a host surface binding",
		});
		const session = createDefaultRunSession({
			...options(dir),
			hostSurface: {
				resolve: unexpected,
				createProvider: unexpected,
				createLaunchProvider: unexpected,
				markers: unexpected,
			},
			infrastructure: {
				surfaceProvider: surface,
				launchOperations: launchOperationsFromSurface(surface, paneConfig),
				supervision,
			},
		});
		await session.shutdown("quit");
		assert.equal(discoveries, 0);
	} finally {
		supervision.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("H1 production binding resolves on each reload, creates one owner with one marker transport and refuses binding drift before provider acquisition", async () => {
	const dir = mkdtempSync(join(tmpdir(), "piha-h1-owner-"));
	const surface = new FakeSurfaceProvider();
	let resolutions = 0,
		providers = 0,
		markerTransports = 0;
	let backend: "legacy" | "core" = "legacy";
	const host = {
		...hostSurfaceBinding,
		resolve() {
			resolutions++;
			return backend === "legacy"
				? { backend }
				: { backend, socket: "/unused", parentTerminal: "changed" };
		},
		createProvider() {
			providers++;
			return surface;
		},
		markers() {
			markerTransports++;
			return {
				write: async () => "answered" as const,
				readSession: async () => ({ kind: "none" as const }),
			};
		},
	};
	let session;
	try {
		session = createDefaultRunSession({ ...options(dir), hostSurface: host });
		const next = createDefaultRunSession(
			{ ...options(dir), hostSurface: host },
			session,
		);
		assert.equal(providers, 1);
		assert.equal(resolutions, 2);
		// The legacy owner takes its marker transport once and keeps it across reload.
		assert.equal(markerTransports, 1);
		backend = "core";
		assert.throws(
			() =>
				createDefaultRunSession({ ...options(dir), hostSurface: host }, next),
			/restart/,
		);
		assert.equal(providers, 1);
	} finally {
		await session?.shutdown("quit");
		rmSync(dir, { recursive: true, force: true });
	}
});

test("H1 injected tool renderers and the child widget hook render exactly as before", () => {
	const expected = JSON.parse(
		readFileSync(join(repo, "test/fixtures/h1-presentation.json"), "utf8"),
	);
	assert.deepEqual(
		JSON.parse(probe("test/fixtures/h1-presentation-probe.ts")),
		expected,
	);
	// The protocol-only entry registers the same child tools and handlers,
	// without the terminal widget.
	const protocolOnly = JSON.parse(
		probe(
			"test/fixtures/h1-presentation-probe.ts",
			repo,
			// H2: the installed package's protocol-only launch entry.
			relative(repo, DEFAULT_CHILD_ENTRY_PATH),
		),
	);
	assert.deepEqual(protocolOnly.child, { ...expected.child, widgets: [] });
});

test("H1 protocol-only child entry imports no terminal host, Herdr or pi-tui module", () => {
	const seen = new Set<string>();
	const external = new Set<string>();
	const visit = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		const source = readFileSync(file, "utf8");
		for (const [, specifier] of source.matchAll(
			/(?:import|export)\s[^;]*?from\s+"([^"]+)"/g,
		)) {
			if (specifier.startsWith(".")) visit(join(dirname(file), specifier));
			else external.add(specifier);
		}
	};
	visit(DEFAULT_CHILD_ENTRY_PATH);
	// H2: the default child entry is the installed package's emitted entry.
	const dist = fileURLToPath(
		new URL("dist/", import.meta.resolve("@nubl/maestro/package.json")),
	);
	const local = [...seen].map((file) => relative(dist, file));
	assert.ok(local.includes("maestro/adapters/pi/child/protocol.js"));
	assert.deepEqual(
		local.filter(
			(file) =>
				!file.startsWith("maestro/core/") &&
				!file.startsWith("maestro/adapters/pi/"),
		),
		[],
	);
	assert.deepEqual(
		[...external].filter((name) => name.includes("pi-tui")),
		[],
	);
});

test("H1 child/config resource defaults use module locations and preserve spaces", () => {
	// Source runs resolve the source entry; emitted JS resolves entry.js beside
	// it. H2 loads the installed package's emitted launch command.
	assert.equal(
		DEFAULT_CHILD_ENTRY_PATH,
		fileURLToPath(
			new URL(
				"./child/entry.js",
				import.meta.resolve("@nubl/maestro/adapters/pi/launch-command"),
			),
		),
	);
	assert.ok(existsSync(DEFAULT_CHILD_ENTRY_PATH));
	assert.equal(
		getSubagentsConfigExamplePath(join(repo, "asset root with spaces")),
		join(repo, "asset root with spaces", "config.json.example"),
	);
});
