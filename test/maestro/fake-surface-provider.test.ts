import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FakeSurfaceProvider } from "../../maestro/surfaces/fake/fake-surface-provider.ts";
import {
	hasStandaloneScreenLine,
	registerSurfaceProviderConformance,
} from "./surface-provider.conformance.ts";

const FAKE_GROUPING_CAP = 4;

registerSurfaceProviderConformance(
	{ describe, it },
	"FakeSurfaceProvider",
	async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "fake-surface-conformance-"));
		return {
			provider: new FakeSurfaceProvider({ maxPerTab: FAKE_GROUPING_CAP }),
			cwd,
			groupingCap: FAKE_GROUPING_CAP,
			async dispose() {
				await rm(cwd, { recursive: true, force: true });
			},
		};
	},
);

describe("FakeSurfaceProvider controls", () => {
	it("records commands and runScript intent without executing shell or writing scripts", async () => {
		const provider = new FakeSurfaceProvider();
		const surfaceId = await provider.createSurface({
			name: "commands",
			cwd: "/tmp",
		});

		await provider.runCommand(surfaceId, "echo fake-marker");
		const scriptCommand = provider.runScript(surfaceId, "echo scripted", {
			scriptPath: "/tmp/should-not-be-created.sh",
			scriptPreamble: "set -e",
		});

		assert.equal(scriptCommand, "/tmp/should-not-be-created.sh");
		assert.deepEqual(provider.commands(surfaceId), [
			"echo fake-marker",
			"echo scripted",
		]);
		assert.match(await provider.readScreen(surfaceId), /fake-marker/);
	});

	it("returns scripted inspections while preserving missing and unavailable distinctions", async () => {
		const provider = new FakeSurfaceProvider();
		const surfaceId = await provider.createSurface({
			name: "inspection",
			cwd: "/tmp",
		});
		provider.scriptInspection(surfaceId, {
			kind: "unavailable",
			error: "provider down",
		});

		assert.deepEqual(await provider.inspectSurface(surfaceId), {
			kind: "unavailable",
			error: "provider down",
		});

		provider.removeSurface(surfaceId);
		assert.deepEqual(await provider.inspectSurface(surfaceId), {
			kind: "missing",
			error: `surface not found: ${surfaceId}`,
		});
	});

	it("rejects missing screen reads and command sends instead of inventing success", async () => {
		const provider = new FakeSurfaceProvider();
		const surfaceId = await provider.createSurface({
			name: "dead",
			cwd: "/tmp",
		});
		provider.removeSurface(surfaceId);

		assert.throws(() => provider.readScreen(surfaceId), /surface not found/);
		assert.throws(
			() => provider.runCommand(surfaceId, "echo nope"),
			/surface not found/,
		);
	});

	it("readScreen returns bounded trailing lines", async () => {
		const provider = new FakeSurfaceProvider();
		const surfaceId = await provider.createSurface({
			name: "screen",
			cwd: "/tmp",
		});
		provider.appendScreen(surfaceId, "one\ntwo\nthree");

		assert.equal(await provider.readScreen(surfaceId, 2), "two\nthree");
	});

	it("does not treat echoed command text as standalone command output", () => {
		assert.equal(
			hasStandaloneScreenLine(
				"$ echo conformance-marker",
				"conformance-marker",
			),
			false,
		);
	});

	it("fills grouped placement gaps after removals without exceeding the cap", async () => {
		const provider = new FakeSurfaceProvider({ maxPerTab: 4 });
		const surfaceIds: string[] = [];
		for (let index = 0; index < 5; index += 1) {
			surfaceIds.push(
				await provider.createSurface({
					name: `grouped-before-delete-${index}`,
					cwd: "/tmp",
					placement: { kind: "grouped" },
				}),
			);
		}
		provider.removeSurface(surfaceIds[0]);
		for (let index = 0; index < 4; index += 1) {
			await provider.createSurface({
				name: `grouped-after-delete-${index}`,
				cwd: "/tmp",
				placement: { kind: "grouped" },
			});
		}

		const groupCounts = countGroupsByPrefix(
			(await provider.listSurfaces()).map((surface) => surface.group),
			"fake-agents-",
		);
		assert.deepEqual(
			groupCounts,
			new Map([
				["fake-agents-1", 4],
				["fake-agents-2", 4],
			]),
		);
	});

	it("honors non-default grouped placement caps", async () => {
		const provider = new FakeSurfaceProvider({ maxPerTab: 2 });
		for (let index = 0; index < 3; index += 1) {
			await provider.createSurface({
				name: `grouped-cap-two-${index}`,
				cwd: "/tmp",
				placement: { kind: "grouped" },
			});
		}

		const groupCounts = countGroupsByPrefix(
			(await provider.listSurfaces()).map((surface) => surface.group),
			"fake-agents-",
		);
		assert.deepEqual(
			groupCounts,
			new Map([
				["fake-agents-1", 2],
				["fake-agents-2", 1],
			]),
		);
	});

	it("assigns a unique group to each tab placement", async () => {
		const provider = new FakeSurfaceProvider();
		const directTabA = await provider.createSurface({
			name: "tab-a",
			cwd: "/tmp",
			placement: { kind: "tab" },
		});
		const directTabB = await provider.createSurface({
			name: "tab-b",
			cwd: "/tmp",
			placement: { kind: "tab" },
		});

		const surfaces = await provider.listSurfaces();
		const tabGroups = [directTabA, directTabB].map((surfaceId) => {
			const surface = surfaces.find((entry) => entry.id === surfaceId);
			assert.ok(surface);
			assert.ok(surface.group);
			return surface.group;
		});

		assert.equal(new Set(tabGroups).size, tabGroups.length);
	});

	it("lists neutral worktree inventory without inventing surface IDs or workspace IDs", async () => {
		const provider = new FakeSurfaceProvider();
		provider.recordWorktreeInfo({
			path: "/tmp/detached",
			branch: "",
			isLinkedWorktree: true,
		});
		provider.recordWorktreeInfo({
			path: "/tmp/plain",
			branch: "main",
			label: "Plain checkout",
			isLinkedWorktree: false,
		});

		assert.deepEqual(await provider.listWorktreeSurfaces(), [
			{
				path: "/tmp/detached",
				branch: "",
				isLinkedWorktree: true,
			},
			{
				path: "/tmp/plain",
				branch: "main",
				label: "Plain checkout",
				isLinkedWorktree: false,
			},
		]);
	});

	it("scopes fake worktree listings by modeled source cwd", async () => {
		const provider = new FakeSurfaceProvider();
		provider.recordWorktreeInfo(
			{
				path: "/repo-a/wt-a",
				branch: "feature/a",
				workspaceId: "workspace-a",
				isLinkedWorktree: true,
			},
			{ cwd: "/repo-a" },
		);
		provider.recordWorktreeInfo(
			{
				path: "/repo-b/wt-b",
				branch: "feature/b",
				workspaceId: "workspace-b",
				isLinkedWorktree: true,
			},
			{ cwd: "/repo-b" },
		);

		assert.deepEqual(await provider.listWorktreeSurfaces({ cwd: "/repo-a" }), [
			{
				path: "/repo-a/wt-a",
				branch: "feature/a",
				workspaceId: "workspace-a",
				isLinkedWorktree: true,
			},
		]);
		assert.deepEqual(
			await provider.listWorktreeSurfaces({ cwd: "/repo-c" }),
			[],
		);
		assert.deepEqual(
			(await provider.listWorktreeSurfaces()).map((worktree) => worktree.path),
			["/repo-a/wt-a", "/repo-b/wt-b"],
		);
	});
});

function countGroupsByPrefix(
	groups: Array<string | undefined>,
	prefix: string,
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const group of groups) {
		if (!group?.startsWith(prefix)) continue;
		counts.set(group, (counts.get(group) ?? 0) + 1);
	}
	return counts;
}
