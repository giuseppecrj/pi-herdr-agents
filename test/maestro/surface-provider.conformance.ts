import assert from "node:assert/strict";
import { describe as nodeDescribe, it as nodeIt } from "node:test";
import type { SurfaceProvider } from "@nubl/maestro/core/surface-provider";

interface TestRunner {
	describe: typeof nodeDescribe;
	it: typeof nodeIt;
}

interface SurfaceProviderFixture {
	provider: SurfaceProvider;
	cwd: string;
	/**
	 * Maximum grouped surfaces per provider group. The fixture must provide an
	 * empty, isolated grouping space so conformance can count only its surfaces.
	 */
	groupingCap?: number;
	dispose(): Promise<void>;
}

const DEFAULT_GROUPING_CAP = 4;
const WAIT_INTERVAL_MS = 50;

export function registerSurfaceProviderConformance(
	runner: TestRunner,
	name: string,
	factory: () => Promise<SurfaceProviderFixture>,
): void {
	runner.describe(`${name} SurfaceProvider conformance`, () => {
		runner.it("isAvailable returns a boolean and never throws", async () => {
			await usingFixture(factory, async ({ provider }) => {
				const available = provider.isAvailable();
				assert.equal(available === true || available === false, true);
			});
		});

		runner.it(
			"createSurface returns an id listed by listSurfaces with name and cwd",
			async () => {
				await usingFixture(factory, async ({ provider, cwd }) => {
					const surfaceId = await provider.createSurface({
						name: "conformance-create",
						cwd,
					});
					const surfaces = await provider.listSurfaces();
					assert.ok(surfaceId.length > 0);
					const surface = surfaces.find((entry) => entry.id === surfaceId);
					assert.ok(surface);
					assert.equal(surface.name, "conformance-create");
					assert.equal(surface.cwd, cwd);
				});
			},
		);

		runner.it(
			"runCommand then readScreen shows the command output",
			async () => {
				await usingFixture(factory, async ({ provider, cwd }) => {
					const outputMarker = "conformance-marker";
					const surfaceId = await provider.createSurface({
						name: "conformance-run",
						cwd,
					});
					await provider.waitForShellReady(surfaceId, { timeoutMs: 5_000 });
					await provider.runCommand(surfaceId, `echo ${outputMarker}`);
					const screen = await readScreenUntilStandaloneLine(
						provider,
						surfaceId,
						outputMarker,
						5_000,
					);
					assert.equal(hasStandaloneScreenLine(screen, outputMarker), true);
				});
			},
		);

		runner.it(
			"inspectSurface returns a PaneInspection for a live surface",
			async () => {
				await usingFixture(factory, async ({ provider, cwd }) => {
					const surfaceId = await provider.createSurface({
						name: "conformance-inspect",
						cwd,
					});
					const inspection = await provider.inspectSurface(surfaceId);
					assert.equal(inspection.kind, "present");
					assert.equal(Number.isFinite(inspection.observedAt), true);
				});
			},
		);

		runner.it("closeSurface then waitForSurfaceAbsence resolves", async () => {
			await usingFixture(factory, async ({ provider, cwd }) => {
				const surfaceId = await provider.createSurface({
					name: "conformance-close",
					cwd,
				});
				await assert.rejects(() =>
					provider.waitForSurfaceAbsence(surfaceId, { timeoutMs: 0 }),
				);
				await provider.closeSurface(surfaceId);
				await provider.waitForSurfaceAbsence(surfaceId, { timeoutMs: 5_000 });
				const surfaces = await provider.listSurfaces();
				assert.equal(
					surfaces.some((surface) => surface.id === surfaceId),
					false,
				);
			});
		});

		runner.it(
			"grouped placement overflows to a new tab at the cap",
			async () => {
				await usingFixture(factory, async (fixture) => {
					const { provider, cwd } = fixture;
					const groupingCap = fixture.groupingCap ?? DEFAULT_GROUPING_CAP;
					const surfaceIds: string[] = [];
					for (let index = 0; index < groupingCap + 1; index += 1) {
						surfaceIds.push(
							await provider.createSurface({
								name: `conformance-grouped-${index}`,
								cwd,
								placement: { kind: "grouped" },
							}),
						);
					}
					const surfaces = await provider.listSurfaces();
					const createdSurfaces = surfaceIds.map((surfaceId) =>
						surfaces.find((surface) => surface.id === surfaceId),
					);
					assert.equal(createdSurfaces.every(Boolean), true);
					const groups = createdSurfaces.map((surface) => surface?.group);
					assert.equal(
						groups.every((group) => Boolean(group)),
						true,
					);
					const groupCounts = countGroups(groups);
					assert.equal(groupCounts.size, 2);
					assert.equal(
						Array.from(groupCounts.values()).every(
							(count) => count <= groupingCap,
						),
						true,
					);
				});
			},
		);

		runner.it("setupHint returns a non-empty string", async () => {
			await usingFixture(factory, async ({ provider }) => {
				assert.ok(provider.setupHint().trim().length > 0);
			});
		});

		runner.it(
			"attachSurface returns a handle with sendKeys and close",
			async () => {
				await usingFixture(factory, async ({ provider, cwd }) => {
					const surfaceId = await provider.createSurface({
						name: "conformance-attach",
						cwd,
					});
					const handle = provider.attachSurface(surfaceId);
					assert.equal(handle.id, surfaceId);
					assert.ok(handle.sendKeys);
					assert.ok(handle.close);
					await handle.sendKeys("Escape");
					await handle.close();
				});
			},
		);

		runner.it(
			"createWorktreeSurface registers neutral worktree inventory and removeWorktreeSurface removes it",
			async () => {
				await usingFixture(factory, async ({ provider, cwd }) => {
					const worktree = await provider.createWorktreeSurface({
						name: "conformance-worktree",
						cwd,
						branch: "conformance-branch",
						base: "HEAD",
					});
					assert.equal(worktree.branch, "conformance-branch");
					assert.equal(worktree.path.length > 0, true);
					assert.equal(worktree.surfaceId.length > 0, true);
					const worktreeSurface = (await provider.listSurfaces()).find(
						(surface) => surface.id === worktree.surfaceId,
					);
					assert.ok(worktreeSurface);
					assert.equal(worktreeSurface.workspaceId, worktree.workspaceId);
					let worktrees = await provider.listWorktreeSurfaces({ cwd });
					const listed = worktrees.find(
						(entry) => entry.workspaceId === worktree.workspaceId,
					);
					assert.ok(listed);
					assert.equal(listed.path, worktree.path);
					assert.equal(listed.branch, worktree.branch);
					assert.equal(listed.workspaceId, worktree.workspaceId);
					assert.equal(listed.isLinkedWorktree, true);
					assert.equal(Object.hasOwn(listed, "surfaceId"), false);
					await provider.removeWorktreeSurface(worktree.workspaceId);
					worktrees = await provider.listWorktreeSurfaces({ cwd });
					assert.equal(
						worktrees.some(
							(entry) => entry.workspaceId === worktree.workspaceId,
						),
						false,
					);
					const surfaces = await provider.listSurfaces();
					assert.equal(
						surfaces.some((surface) => surface.id === worktree.surfaceId),
						false,
					);
				});
			},
		);
	});
}

async function usingFixture(
	factory: () => Promise<SurfaceProviderFixture>,
	test: (fixture: SurfaceProviderFixture) => Promise<void>,
) {
	const fixture = await factory();
	try {
		await test(fixture);
	} finally {
		await fixture.dispose();
	}
}

async function readScreenUntilStandaloneLine(
	provider: SurfaceProvider,
	surfaceId: string,
	needle: string,
	timeoutMs: number,
) {
	const deadline = Date.now() + timeoutMs;
	let screen = "";
	do {
		screen = await provider.readScreen(surfaceId);
		if (hasStandaloneScreenLine(screen, needle)) return screen;
		await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
	} while (Date.now() < deadline);
	return screen;
}

export function hasStandaloneScreenLine(
	screen: string,
	needle: string,
): boolean {
	return screen.split(/\r?\n/).some((line) => line.trim() === needle);
}

function countGroups(groups: Array<string | undefined>): Map<string, number> {
	const counts = new Map<string, number>();
	for (const group of groups) {
		assert.ok(group);
		counts.set(group, (counts.get(group) ?? 0) + 1);
	}
	return counts;
}
