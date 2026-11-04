import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assertCoreWorktreeResource,
	assertCoreWorktreeServer,
	parseWorktreeOwnership,
	validateWorktreeOwnershipUpdate,
	WorktreeOwnershipError,
	type CoreWorktreeOwnership,
	type CoreWorktreeTerminalIdentity,
} from "../../maestro/core/worktree-ownership.ts";

const legacy = {
	version: 1,
	kind: "worktree-run",
	owner: "pi-herdr-subagents",
	id: "run-1",
	sourceCwd: "/repo/linked",
	branch: "task/one",
	baseRef: "HEAD",
	baseSha: "a".repeat(40),
	createdAt: 100,
	state: "provisioning",
};
function core(): CoreWorktreeOwnership {
	return {
		version: 2,
		kind: "worktree-run",
		owner: "pi-herdr-subagents",
		backend: "core",
		id: "run-1",
		runToken: "unique-launch-token",
		socket: "/private/core.sock",
		coreId: "original-server",
		parentTerminal: "t1",
		sourceCwd: "/repo/linked",
		principalCwd: "/repo/main",
		commonGitDir: "/repo/main/.git",
		intendedPath: "/managed/task-one",
		branch: "task/one",
		baseRef: "HEAD",
		baseSha: "a".repeat(40),
		createdAt: 100,
		updatedAt: 100,
		state: "provisioning",
		resources: [],
		observedTerminalIds: [],
		acquisitionUncertain: false,
	};
}
function terminal(): CoreWorktreeTerminalIdentity {
	return {
		socket: "/private/core.sock",
		coreId: "original-server",
		parentTerminal: "t1",
		address: "t2",
		createdAt: 101,
	};
}
function rejects(code: WorktreeOwnershipError["code"], action: () => void) {
	assert.throws(action, (error) => {
		assert.ok(error instanceof WorktreeOwnershipError);
		assert.equal(error.code, code);
		return true;
	});
}

test("legacy v1 remains readable without a backend, including early and future data", () => {
	const receipt = parseWorktreeOwnership({ ...legacy, future: { keep: true } });
	assert.deepEqual(receipt, {
		...legacy,
		backend: "legacy",
		future: { keep: true },
	});
	assert.equal(
		parseWorktreeOwnership({ ...legacy, backend: "legacy" }).backend,
		"legacy",
	);
	assert.equal(
		parseWorktreeOwnership({
			version: 1,
			kind: legacy.kind,
			owner: legacy.owner,
		}).backend,
		"legacy",
	);
});

test("unknown or malformed backend/version/owner never falls back to legacy", () => {
	for (const backend of [null, undefined, "", "future", "core", false, {}])
		rejects("invalid-receipt", () =>
			parseWorktreeOwnership({ ...legacy, backend }),
		);
	for (const value of [
		null,
		[],
		{},
		{ ...legacy, version: 2 },
		{ ...legacy, owner: "foreign" },
		{ ...legacy, kind: "other" },
		{ ...core(), backend: "legacy" },
		{ ...core(), version: 3 },
	])
		rejects("invalid-receipt", () => parseWorktreeOwnership(value));
});

test("Core requires every identity and evidence field, even before acquisition", () => {
	assert.deepEqual(parseWorktreeOwnership(core()), {
		...core(),
		handoff: undefined,
	});
	for (const field of Object.keys(core())) {
		const incomplete = { ...core(), [field]: undefined };
		rejects("invalid-receipt", () => parseWorktreeOwnership(incomplete));
	}
});

test("Core rejects malformed paths, native addresses, timestamps and evidence", () => {
	const invalidFields = {
		socket: "relative.sock",
		sourceCwd: "repo",
		principalCwd: "repo",
		commonGitDir: "repo/.git",
		intendedPath: "../managed",
		parentTerminal: "workspace-1",
		coreId: "",
		runToken: "",
		baseRef: "",
		baseSha: "",
		createdAt: -1,
		updatedAt: 99,
		state: "clean",
		resources: {},
		observedTerminalIds: ["workspace-1"],
		acquisitionUncertain: "yes",
	};
	for (const [field, value] of Object.entries(invalidFields))
		rejects("invalid-receipt", () =>
			parseWorktreeOwnership({ ...core(), [field]: value }),
		);
	for (const createdAt of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
		rejects("invalid-receipt", () =>
			parseWorktreeOwnership({ ...core(), createdAt }),
		);
});

test("Core has no legacy workspace, pane or observed-path surrogate", () => {
	for (const field of ["workspaceId", "paneId", "path"])
		rejects("invalid-receipt", () =>
			parseWorktreeOwnership({ ...core(), [field]: "t2" }),
		);
});

test("acquired resource roles and terminal addresses are unique, excluding parent", () => {
	const execution = { role: "execution", address: "t2", createdAt: 101 };
	for (const resources of [
		[execution, { ...execution, address: "t3" }],
		[execution, { ...execution, role: "retained-shell" }],
		[{ ...execution, address: "t1" }],
		[{ ...execution, role: "observed" }],
		[{ ...execution, address: "workspace-2" }],
		[{ ...execution, createdAt: undefined }],
		[{ ...execution, createdAt: -1 }],
	])
		rejects("invalid-receipt", () =>
			parseWorktreeOwnership({ ...core(), resources }),
		);
	assert.equal(
		parseWorktreeOwnership({
			...core(),
			resources: [
				execution,
				{ role: "retained-shell", address: "t3", createdAt: 102 },
			],
		}).backend,
		"core",
	);
});

test("observed IDs and uncertainty never authorize terminal control", () => {
	const value = {
		...core(),
		observedTerminalIds: ["t2"],
		acquisitionUncertain: true,
	};
	const receipt = parseWorktreeOwnership(value);
	assert.equal(receipt.backend, "core");
	if (receipt.backend !== "core") throw new Error("expected Core");
	rejects("identity-mismatch", () =>
		assertCoreWorktreeResource(receipt, "execution", terminal()),
	);
	rejects("identity-mismatch", () =>
		assertCoreWorktreeResource(receipt, "retained-shell", terminal()),
	);
	rejects("invalid-receipt", () =>
		parseWorktreeOwnership({ ...value, observedTerminalIds: ["t2", "t2"] }),
	);
});

test("matching uses durable server and original native parent, not a new parent session", () => {
	const receipt = {
		...core(),
		resources: [{ role: "execution", address: "t2", createdAt: 101 } as const],
	};
	assertCoreWorktreeServer(receipt, {
		socket: receipt.socket,
		coreId: receipt.coreId,
	});
	assert.equal(
		assertCoreWorktreeResource(receipt, "execution", terminal()).address,
		"t2",
	);
	for (const change of [
		{ socket: "/different.sock" },
		{ coreId: "restarted-server" },
		{ parentTerminal: "t9" },
		{ address: "t3" },
		{ createdAt: 102 },
	])
		rejects("identity-mismatch", () =>
			assertCoreWorktreeResource(receipt, "execution", {
				...terminal(),
				...change,
			}),
		);
	rejects("identity-mismatch", () =>
		assertCoreWorktreeResource(receipt, "retained-shell", terminal()),
	);
});

test("Core ownership identity is immutable across complete snapshot updates", () => {
	const changes = {
		id: "run-2",
		runToken: "other-token",
		socket: "/different.sock",
		coreId: "other-server",
		parentTerminal: "t9",
		sourceCwd: "/other/linked",
		principalCwd: "/other/main",
		commonGitDir: "/other/.git",
		intendedPath: "/managed/other",
		branch: "task/two",
		baseRef: "main",
		baseSha: "b".repeat(40),
		createdAt: 99,
	};
	for (const [field, value] of Object.entries(changes))
		rejects("invalid-update", () =>
			validateWorktreeOwnershipUpdate(core(), { ...core(), [field]: value }),
		);
	rejects("invalid-update", () =>
		validateWorktreeOwnershipUpdate(core(), legacy),
	);
});

test("acquired resources can only be appended, not removed, replaced, reordered or retimed", () => {
	const first: CoreWorktreeOwnership = {
		...core(),
		resources: [{ role: "execution", address: "t2", createdAt: 101 }],
	};
	const both: CoreWorktreeOwnership = {
		...first,
		resources: [
			...first.resources,
			{ role: "retained-shell", address: "t3", createdAt: 102 },
		],
	};
	assert.equal(validateWorktreeOwnershipUpdate(core(), first).backend, "core");
	assert.equal(validateWorktreeOwnershipUpdate(first, both).backend, "core");
	for (const resources of [
		[],
		[{ ...first.resources[0], address: "t4" }],
		[{ ...first.resources[0], createdAt: 103 }],
		[{ ...first.resources[0], role: "retained-shell" }],
	])
		rejects("invalid-update", () =>
			validateWorktreeOwnershipUpdate(first, { ...first, resources }),
		);
	rejects("invalid-update", () =>
		validateWorktreeOwnershipUpdate(both, {
			...both,
			resources: [...both.resources].reverse(),
		}),
	);
});

test("state and Git handoff updates preserve ownership and do not mutate inputs", () => {
	const previous: CoreWorktreeOwnership = {
		...core(),
		resources: [{ role: "execution", address: "t2", createdAt: 101 }],
	};
	const original = structuredClone(previous);
	Object.freeze(previous);
	Object.freeze(previous.resources);
	const value = {
		...previous,
		updatedAt: 200,
		state: "ready_for_review",
		resources: [{ role: "execution", address: "t2", createdAt: 101 }],
		handoff: {
			headSha: "b".repeat(40),
			commitsAhead: 1,
			clean: null,
			conflicted: null,
			changedFiles: ["file.ts"],
			untrackedFiles: null,
			gitError: "inspection incomplete",
		},
	};
	const before = structuredClone(value);
	const next = validateWorktreeOwnershipUpdate(previous, value);
	assert.deepEqual(value, before);
	assert.deepEqual(previous, original);
	assert.equal(next.state, "ready_for_review");
	if (next.backend !== "core") throw new Error("expected Core");
	assert.equal(next.runToken, previous.runToken);
	value.resources[0].address = "t9";
	value.handoff.changedFiles.push("later.ts");
	assert.equal(next.resources[0].address, "t2");
	assert.deepEqual(next.handoff?.changedFiles, ["file.ts"]);
	rejects("invalid-receipt", () =>
		parseWorktreeOwnership({ ...value, handoff: { clean: true } }),
	);
});

test("uncertainty and observed evidence cannot be silently cleared by a state change", () => {
	const previous = {
		...core(),
		acquisitionUncertain: true,
		observedTerminalIds: ["t2"],
	};
	rejects("invalid-update", () =>
		validateWorktreeOwnershipUpdate(previous, {
			...previous,
			state: "removed",
			acquisitionUncertain: false,
		}),
	);
	rejects("invalid-update", () =>
		validateWorktreeOwnershipUpdate(previous, {
			...previous,
			observedTerminalIds: [],
		}),
	);
	const next = validateWorktreeOwnershipUpdate(previous, {
		...previous,
		state: "failed",
		observedTerminalIds: ["t2", "t3"],
	});
	assert.equal(next.acquisitionUncertain, true);
	const newer = { ...core(), updatedAt: 200 };
	rejects("invalid-update", () =>
		validateWorktreeOwnershipUpdate(newer, { ...newer, updatedAt: 150 }),
	);
});

test("legacy updates retain recorded source/base/resource identity and uncertainty", () => {
	const previous = parseWorktreeOwnership({
		...legacy,
		path: "/managed/one",
		workspaceId: "w1",
		paneId: "p1",
		acquisitionUncertain: true,
	});
	const acquired = validateWorktreeOwnershipUpdate(previous, {
		...previous,
		sessionFile: "/sessions/child.jsonl",
		state: "failed",
	});
	if (acquired.backend !== "legacy") throw new Error("expected legacy");
	assert.equal(acquired.workspaceId, "w1");
	for (const field of [
		"id",
		"sourceCwd",
		"branch",
		"baseRef",
		"baseSha",
		"createdAt",
		"path",
		"workspaceId",
		"paneId",
		"sessionFile",
	])
		rejects("invalid-update", () =>
			validateWorktreeOwnershipUpdate(acquired, {
				...acquired,
				[field]: undefined,
			}),
		);
	rejects("invalid-update", () =>
		validateWorktreeOwnershipUpdate(acquired, {
			...acquired,
			acquisitionUncertain: false,
		}),
	);
	rejects("invalid-update", () =>
		validateWorktreeOwnershipUpdate(acquired, core()),
	);
});
