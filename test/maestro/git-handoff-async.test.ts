import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
	captureWorktreeHandoff,
	resolveGitCommit,
	resolveWorktreeProvisionCwd,
} from "../../maestro/runtime/worktree-operations.ts";
import type { WorktreeLaunch } from "../../maestro/core/worktree.ts";

const sha = "a".repeat(40);
async function gitFixture(
	body: string,
	run: (worktree: WorktreeLaunch, log: string) => Promise<void>,
) {
	const dir = mkdtempSync(join(tmpdir(), "async-git-"));
	const oldPath = process.env.PATH;
	const log = join(dir, "calls");
	writeFileSync(
		join(dir, "git"),
		`#!${process.execPath}\nconst args = process.argv.slice(2); require('node:fs').appendFileSync(${JSON.stringify(log)}, args.join(' ')+'\\n');\n${body}\n`,
		{ mode: 0o755 },
	);
	process.env.PATH = dir;
	try {
		await run(
			{
				path: dir,
				workspaceId: "w",
				paneId: "p",
				branch: "b",
				baseRef: "HEAD",
				baseSha: sha,
				manifestFile: join(dir, "manifest"),
			},
			log,
		);
	} finally {
		if (oldPath === undefined) delete process.env.PATH;
		else process.env.PATH = oldPath;
		rmSync(dir, { recursive: true, force: true });
	}
}
const valid = `if(args[0]==='rev-parse') console.log('${sha}'); else if(args[0]==='rev-list') console.log('0');`;
function unknown(handoff: Awaited<ReturnType<typeof captureWorktreeHandoff>>) {
	for (const key of [
		"headSha",
		"commitsAhead",
		"clean",
		"conflicted",
		"changedFiles",
		"untrackedFiles",
	] as const)
		assert.equal(handoff[key], null, key);
	assert.ok(handoff.gitError);
}

test("one handoff deadline covers the sequence and launches no probes after expiry while the parent stays responsive", async () => {
	await gitFixture(
		`${valid} if(args[0]==='status') setTimeout(() => {}, 5000);`,
		async (worktree, log) => {
			let heartbeat = false;
			const timer = setTimeout(() => {
				heartbeat = true;
			}, 5);
			const start = performance.now();
			try {
				const result = await captureWorktreeHandoff(worktree, 2000);
				unknown(result);
				assert.match(result.gitError!, /deadline/);
				assert.equal(heartbeat, true);
				assert.ok(performance.now() - start < 3500);
				assert.deepEqual(
					readFileSync(log, "utf8")
						.trim()
						.split("\n")
						.map((line) => line.split(" ")[0]),
					["rev-parse", "status"],
				);
			} finally {
				clearTimeout(timer);
			}
		},
	);
});

for (const bad of ["sha", "count", "overflow", "exit", "nul"] as const)
	test(`handoff ${bad} failure reports every Git field unknown`, async () => {
		const body =
			bad === "sha"
				? "console.log('bad-sha')"
				: bad === "count"
					? `if(args[0]==='rev-list') console.log('2garbage'); else { ${valid} }`
					: bad === "overflow"
						? "process.stdout.write('a'.repeat(2*1024*1024))"
						: bad === "exit"
							? "process.exitCode=1"
							: `${valid} if(args[0]==='ls-files') process.stdout.write('not-terminated');`;
		await gitFixture(body, async (worktree) =>
			unknown(await captureWorktreeHandoff(worktree)),
		);
	});

test("async base/source preflight is awaited and NUL-delimited paths stay lossless", async () => {
	const names = ["line\nbreak", 'tab\tquote"', "leading space "];
	await gitFixture(
		`if(args[0]==='rev-parse' && args.includes('--path-format=absolute')) console.log('/repo/.git'); else { ${valid} } if(args[0]==='ls-files') process.stdout.write(${JSON.stringify(names.join("\0") + "\0")});`,
		async (worktree) => {
			assert.equal(await resolveGitCommit(worktree.path, "HEAD"), sha);
			assert.equal(
				await resolveWorktreeProvisionCwd(worktree.path),
				worktree.path,
			);
			const result = await captureWorktreeHandoff(worktree);
			assert.equal(result.gitError, undefined);
			assert.deepEqual(result.untrackedFiles, [...names].sort());
			assert.deepEqual(result.changedFiles, [...names].sort());
		},
	);
});

test("migrated launch/query and Git preflight/handoff production paths contain no synchronous subprocess calls", () => {
	const source = (path: string) =>
		readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
	for (const path of [
		"maestro/surfaces/herdr/herdr-pane.ts",
		"maestro/surfaces/herdr/herdr-surface-provider.ts",
		"maestro/adapters/pi/pi-harness-adapter.ts",
		"maestro/adapters/pi/launch.ts",
		"maestro/adapters/pi/launch-resume.ts",
	])
		assert.doesNotMatch(
			source(path),
			/\b(?:execSync|execFileSync|spawnSync|herdrExec)\s*\(/,
			path,
		);
	const cli = source("maestro/surfaces/herdr/herdr-cli.ts").replace(
		/export function herdrExec\([\s\S]*?\n}\n/,
		"",
	);
	assert.doesNotMatch(cli, /\b(?:execFileSync|spawnSync|execSync)\s*\(/);
	const herdr = source("maestro/surfaces/herdr/herdr.ts");
	const withoutDiagnostic = herdr.replace(
		/export function readHerdrScreen\([\s\S]*?\n}\n/,
		"",
	);
	assert.doesNotMatch(withoutDiagnostic, /\bherdrExec\s*\(/);
	const git = source("maestro/runtime/worktree-operations.ts").split(
		"const CLEANUP_TIMEOUT_MS",
	)[0];
	assert.doesNotMatch(git, /\b(?:execFileSync|spawnSync|execSync)\s*\(/);
});
