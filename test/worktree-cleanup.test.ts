import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs, {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	mkdirSync,
	symlinkSync,
	chmodSync,
} from "node:fs";
import childProcess, { spawn, execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readWorktreeManifest,
	writeWorktreeManifest,
} from "../pi-extension/subagents/launch.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";
import {
	cleanupBlockers,
	createWorktreeCleanupOperations,
	__worktreeCleanupTest__,
	listContainedWorktrees,
	removeContainedWorktree,
	formatWorktreeInventory,
} from "../pi-extension/subagents/worktree-cleanup.ts";
import { cleanupFixture } from "./worktree-cleanup-fixture.ts";

describe("cleanup process visibility policy", () => {
	it("scans the real Linux host without mutation and retains known child and lease blockers", {
		skip: process.platform !== "linux",
	}, async () => {
		const entry = (await listContainedWorktrees(cleanupFixture().input))[0];
		entry.path = fs.realpathSync(process.cwd());
		for (const persistent of [false, true]) {
			const ops = createWorktreeCleanupOperations({
				manifestDir: "/unused",
				liveHolders: () => [{ path: entry.path, persistent }],
			});
			const result = await ops.holders(entry);
			assert.match(
				result.blockers.join(),
				new RegExp(`Live process ${process.pid} holds the checkout`),
			);
			assert.match(
				result.blockers.join(),
				persistent ? /Persistent-specialist lease/ : /Live child holds/,
			);
			assert.match(
				result.warnings.join(),
				/same-user.*other-user.*protected process/i,
			);
		}
	});
	it("retains known lease evidence when the real enumeration seam fails", {
		skip: process.platform !== "linux",
	}, async (t) => {
		const entry = (await listContainedWorktrees(cleanupFixture().input))[0];
		entry.path = fs.realpathSync(process.cwd());
		const ops = createWorktreeCleanupOperations({
			manifestDir: "/unused",
			liveHolders: () => [{ path: entry.path, persistent: true }],
		});
		const original: (...args: any[]) => any = fs.readdirSync;
		const mocked = t.mock.method(fs, "readdirSync", (...args: any[]) => {
			if (String(args[0]) === "/proc")
				throw Object.assign(new Error("global enumeration denied"), {
					code: "EACCES",
				});
			return original(...args);
		});
		syncBuiltinESMExports();
		try {
			const result = await ops.holders(entry);
			assert.match(result.blockers.join(), /Persistent-specialist lease/);
			assert.match(result.blockers.join(), /Process inspection unavailable/);
		} finally {
			mocked.mock.restore();
			syncBuiltinESMExports();
		}
	});
	for (const deniedDetail of ["cwd", "comm", "status", "identity"] as const) {
		for (const withHolder of [false, true]) {
			it(`warns for unreadable ${deniedDetail} and continues scanning (holder: ${withHolder})`, async (t) => {
				const dir = mkdtempSync(join(tmpdir(), "cleanup-protected-"));
				const f = cleanupFixture();
				for (const pid of ["101", "202"]) {
					mkdirSync(join(dir, pid));
					writeFileSync(join(dir, pid, "comm"), "private-process-name\n");
					writeFileSync(join(dir, pid, "status"), "State:\tS (sleeping)\n");
					symlinkSync(
						pid === "202" && withHolder ? dir : tmpdir(),
						join(dir, pid, "cwd"),
					);
				}
				if (deniedDetail === "status") rmSync(join(dir, "101", "cwd"));
				const denied = join(
					dir,
					"101",
					deniedDetail === "identity" ? "" : deniedDetail,
				);
				const method =
					deniedDetail === "identity"
						? "lstatSync"
						: deniedDetail === "cwd"
							? "realpathSync"
							: "readFileSync";
				const original: (...args: any[]) => any = fs[method];
				const mocked = t.mock.method(fs, method, (...args: any[]) => {
					if (String(args[0]) === denied)
						throw Object.assign(new Error("private error details"), {
							code: "EACCES",
						});
					return original(...args);
				});
				syncBuiltinESMExports();
				try {
					let inspection: ReturnType<
						typeof __worktreeCleanupTest__.processHolders
					>;
					assert.doesNotThrow(() => {
						inspection = __worktreeCleanupTest__.processHolders(
							dir,
							new Set(),
							dir,
							"linux",
						);
					});
					assert.match(
						inspection!.warnings.join(),
						/1 process.*101.*unreadable/,
					);
					assert.match(
						inspection!.warnings.join(),
						/same-user.*other-user.*protected process could hold the checkout undetected/i,
					);
					assert.doesNotMatch(JSON.stringify(inspection!), /private/);
					assert.equal(inspection!.blockers.length, withHolder ? 1 : 0);
					if (withHolder)
						assert.match(inspection!.blockers.join(), /202.*holds/);
					f.operations.holders = async () => inspection!;
					const rows = await listContainedWorktrees(f.input);
					assert.equal(
						rows[0].classification,
						withHolder ? "blocked" : "eligible",
					);
					assert.deepEqual(rows[0].warnings, inspection!.warnings);
					assert.match(formatWorktreeInventory(rows), /Warning:.*unreadable/);
					const result = await removeContainedWorktree(f.input);
					assert.equal(result.status, withHolder ? "blocked" : "removed");
					assert.deepEqual(result.warnings, inspection!.warnings);
					assert.match(result.message, /Warning:.*unreadable/);
					if (withHolder) assert.deepEqual(f.calls, []);
				} finally {
					mocked.mock.restore();
					syncBuiltinESMExports();
					rmSync(dir, { recursive: true });
				}
			});
		}
	}
	it("does not lose a holder when its own command name is unreadable", (t) => {
		const dir = mkdtempSync(join(tmpdir(), "cleanup-hidden-command-"));
		mkdirSync(join(dir, "101"));
		symlinkSync(dir, join(dir, "101", "cwd"));
		const original: (...args: any[]) => any = fs.readFileSync;
		const mocked = t.mock.method(fs, "readFileSync", (...args: any[]) => {
			if (String(args[0]) === join(dir, "101", "comm"))
				throw Object.assign(new Error("denied"), { code: "EPERM" });
			return original(...args);
		});
		syncBuiltinESMExports();
		try {
			const result = __worktreeCleanupTest__.processHolders(
				dir,
				new Set([101]),
				dir,
				"linux",
			);
			assert.match(result.blockers.join(), /101.*holds/);
			assert.match(result.warnings.join(), /101.*unreadable/);
		} finally {
			mocked.mock.restore();
			syncBuiltinESMExports();
			rmSync(dir, { recursive: true });
		}
	});
	for (const kind of ["enumeration", "platform"] as const) {
		it(`blocks ${kind} failure rather than warning`, async () => {
			const f = cleanupFixture();
			f.operations.holders = async () =>
				__worktreeCleanupTest__.processHolders(
					"/unused",
					new Set(),
					"/missing-proc-root",
					kind === "platform" ? "win32" : "linux",
				);
			const result = await removeContainedWorktree(f.input);
			assert.equal(result.status, "blocked");
			assert.match(
				result.message,
				kind === "platform" ? /unsupported/ : /ENOENT/,
			);
			assert.deepEqual(f.calls, []);
		});
	}
	it("keeps disappeared and zombie processes harmless and only exempts observed idle shells", () => {
		const dir = mkdtempSync(join(tmpdir(), "cleanup-idle-shell-"));
		try {
			mkdirSync(join(dir, "101"));
			writeFileSync(join(dir, "101", "comm"), "bash\n");
			symlinkSync(dir, join(dir, "101", "cwd"));
			assert.equal(
				__worktreeCleanupTest__.processHolders(dir, new Set(), dir, "linux")
					.blockers.length,
				1,
			);
			assert.deepEqual(
				__worktreeCleanupTest__.processHolders(
					dir,
					new Set([101]),
					dir,
					"linux",
				).blockers,
				[],
			);
			rmSync(join(dir, "101", "cwd"));
			writeFileSync(join(dir, "101", "status"), "State:\tZ (zombie)\n");
			symlinkSync(join(dir, "absent"), join(dir, "202"));
			const result = __worktreeCleanupTest__.processHolders(
				dir,
				new Set(),
				dir,
				"linux",
			);
			assert.deepEqual(result.blockers, []);
			assert.doesNotMatch(result.warnings.join(), /unreadable/);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
	for (const kind of [
		"removed",
		"preserved",
		"preserve-failed",
		"reinspect-blocked",
		"remove-failed",
		"ambiguous",
	] as const) {
		it(`retains process warnings in ${kind} reporting`, async () => {
			const f = cleanupFixture();
			const warnings = [
				"Incomplete process inspection: protected process could hold the checkout undetected.",
			];
			let pass = 0;
			f.operations.holders = async () => ({
				blockers: [],
				warnings: ++pass === 1 ? warnings : [],
			});
			if (kind.startsWith("preserv") || kind === "reinspect-blocked")
				f.state.dirtyFiles = 1;
			if (kind === "preserve-failed")
				f.operations.preserve = () => {
					throw new Error("commit refused");
				};
			if (kind === "remove-failed")
				f.operations.removeCheckout = () => {
					throw new Error("remove refused");
				};
			if (kind === "reinspect-blocked") {
				const preserve = f.operations.preserve;
				f.operations.preserve = (entry) => {
					const sha = preserve(entry);
					f.state.locked = true;
					return sha;
				};
			}
			if (kind === "ambiguous")
				f.operations.scan = () => ["/managed/repo/task", "/managed/other/task"];
			const result = await removeContainedWorktree({
				...f.input,
				preserve: true,
			});
			assert.equal(
				result.status,
				kind.endsWith("failed")
					? "failed"
					: kind === "ambiguous" || kind === "reinspect-blocked"
						? "blocked"
						: "removed",
			);
			assert.deepEqual(result.warnings, warnings);
			assert.match(result.message, /Warning:.*protected process/);
		});
	}
	it("continues past unreadable Darwin cwd records but blocks a failed global lsof", async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "cleanup-darwin-"));
		const mocked = t.mock.method(
			childProcess,
			"execFileSync",
			() => `p101\ncprivate\np202\ncprivate\nn${dir}\n`,
		);
		syncBuiltinESMExports();
		try {
			const result = __worktreeCleanupTest__.processHolders(
				dir,
				new Set(),
				"/proc",
				"darwin",
			);
			assert.match(result.warnings.join(), /101.*unreadable/);
			assert.match(result.blockers.join(), /202.*holds/);
			assert.doesNotMatch(JSON.stringify(result), /private/);
			mocked.mock.mockImplementation(() => {
				throw Object.assign(new Error("lsof failed: private command output"), {
					stdout: `p202\ncprivate\nn${dir}\n`,
					status: 1,
				});
			});
			const f = cleanupFixture();
			f.operations.holders = async () =>
				__worktreeCleanupTest__.processHolders(
					dir,
					new Set(),
					"/proc",
					"darwin",
				);
			const refused = await removeContainedWorktree(f.input);
			assert.equal(refused.status, "blocked");
			assert.match(refused.message, /lsof failed/);
			assert.doesNotMatch(refused.message, /private/);
			assert.deepEqual(f.calls, []);
		} finally {
			mocked.mock.restore();
			syncBuiltinESMExports();
			rmSync(dir, { recursive: true });
		}
	});
});

describe("cleanup operating-system probes", () => {
	it("counts every ignored file when the real Git listing exceeds 1 MiB", async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "cleanup-large-ignored-"));
		const git = (args: string[]) =>
			execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		try {
			git(["init", "-q", "-b", "task"]);
			git(["config", "user.name", "Cleanup test"]);
			git(["config", "user.email", "cleanup@example.invalid"]);
			git(["config", "commit.gpgsign", "false"]);
			writeFileSync(join(dir, ".gitignore"), "ignored/\n");
			git(["add", ".gitignore"]);
			git(["commit", "-qm", "base"]);
			mkdirSync(join(dir, "ignored"));
			for (let i = 0; i < 5000; i++)
				writeFileSync(
					join(
						dir,
						"ignored",
						`${"x".repeat(220)}-${i}${i === 0 ? "\nfile" : ""}`,
					),
					"",
				);
			const listing = execFileSync(
				"git",
				["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
				{ cwd: dir, maxBuffer: 2 * 1024 * 1024 },
			);
			assert.ok(listing.length > 1024 * 1024);
			const ops = createWorktreeCleanupOperations({
				manifestDir: join(dir, "manifests"),
				liveHolders: () => [],
			});
			const state = await ops.inspectGit(dir, dir);
			assert.equal(state.ignoredFiles, 5000);
			assert.equal(state.dirtyFiles, 0);
			assert.equal(state.untrackedFiles, 0);
			const realSpawn = childProcess.spawn;
			for (const failure of ["partial", "missing"] as const) {
				const mocked = t.mock.method(
					childProcess,
					"spawn",
					(
						file: string,
						args: string[],
						options: { timeout?: number; killSignal?: string },
					) => {
						assert.equal(file, "git");
						assert.deepEqual(args, [
							"ls-files",
							"--others",
							"--ignored",
							"--exclude-standard",
							"-z",
						]);
						assert.equal(options.timeout, 30_000);
						assert.equal(options.killSignal, "SIGKILL");
						return failure === "partial"
							? realSpawn(
									process.execPath,
									[
										"-e",
										'process.stdout.write("partial\\0", () => process.exit(1))',
									],
									{ stdio: ["ignore", "pipe", "ignore"] },
								)
							: realSpawn(join(dir, "missing-executable"), [], {
									stdio: ["ignore", "pipe", "ignore"],
								});
					},
				);
				syncBuiltinESMExports();
				try {
					await assert.rejects(
						async () => ops.inspectGit(dir, dir),
						failure === "partial"
							? /Ignored-file inspection failed.*exit 1/
							: /ENOENT/,
					);
				} finally {
					mocked.mock.restore();
					syncBuiltinESMExports();
				}
			}
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
	it("inspects a clean Git sibling beside a detached entry from captured Herdr output", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cleanup-detached-sibling-"));
		const source = join(dir, "source");
		const managed = join(dir, "managed");
		const alpha = join(managed, "repo", "alpha");
		const delta = join(managed, "repo", "delta");
		mkdirSync(source);
		const git = (args: string[]) =>
			execFileSync("git", args, { cwd: source, stdio: "pipe" });
		try {
			git(["init", "-q", "-b", "main"]);
			git(["config", "user.name", "Cleanup test"]);
			git(["config", "user.email", "cleanup@example.invalid"]);
			git(["config", "commit.gpgsign", "false"]);
			git(["commit", "--allow-empty", "-qm", "base"]);
			git(["worktree", "add", "-q", "-b", "alpha", alpha]);
			git(["worktree", "add", "-q", "--detach", delta]);
			// Captured from Herdr 0.9.0-preview.2026-09-08; only paths/labels relocated.
			const payload = JSON.stringify({
				id: "cli:worktree:list",
				result: {
					type: "worktree_list",
					worktrees: [
						{
							branch: "main",
							is_bare: false,
							is_detached: false,
							is_linked_worktree: false,
							is_prunable: false,
							label: "repo",
							path: source,
						},
						{
							branch: "alpha",
							is_bare: false,
							is_detached: false,
							is_linked_worktree: true,
							is_prunable: false,
							label: "repo",
							path: alpha,
						},
						{
							is_bare: false,
							is_detached: true,
							is_linked_worktree: true,
							is_prunable: false,
							label: "repo",
							path: delta,
						},
					],
				},
			});
			const ops = createWorktreeCleanupOperations({
				managedRoot: managed,
				manifestDir: join(dir, "manifests"),
				liveHolders: () => [],
			});
			ops.listHerdr = () => __herdrTest__.parseHerdrWorktreeList(payload);
			// Process-inspection policy is tested separately; this regression isolates Git/Herdr identity.
			ops.holders = async () => ({ blockers: [], warnings: [] });
			const rows = await listContainedWorktrees({
				cwd: source,
				operations: ops,
			});
			const clean = rows.find((row) => row.path === fs.realpathSync(alpha));
			const detached = rows.find((row) => row.path === fs.realpathSync(delta));
			assert.ok(clean, `Missing ${alpha}: ${JSON.stringify(rows)}`);
			assert.ok(detached, `Missing ${delta}: ${JSON.stringify(rows)}`);
			assert.equal(clean.classification, "eligible");
			assert.deepEqual(clean.blockers, []);
			assert.equal(detached.classification, "blocked");
			assert.deepEqual(detached.blockers, [
				"Detached HEAD: no retained branch",
			]);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
	for (const manifestKind of [
		"dangling",
		"conflicting",
		"consistent",
		"loop",
		"lstat-denied",
		"realpath-denied",
	] as const) {
		it(`isolates manifest identity with real filesystem probes: ${manifestKind}`, async () => {
			const dir = mkdtempSync(join(tmpdir(), "cleanup-manifest-identity-"));
			try {
				const root = join(dir, "managed");
				const path = join(root, "repo", "task");
				const dangling = join(dir, "dangling");
				mkdirSync(path, { recursive: true });
				symlinkSync(join(dir, "absent"), dangling);
				const ops = createWorktreeCleanupOperations({
					managedRoot: root,
					manifestDir: join(dir, "manifests"),
					liveHolders: () => [],
				});
				ops.resolveSource = () => dir;
				ops.inspectGit = () => ({ ...cleanupFixture().state });
				ops.listHerdr = () => [];
				ops.holders = async () => ({ blockers: [], warnings: [] });
				const manifests = [
					{
						file: "/dangling.json",
						value: { state: "created", path: dangling, branch: "other" },
					},
				];
				if (manifestKind === "consistent" || manifestKind === "conflicting")
					manifests.push({
						file: "/actual.json",
						value: {
							state: "created",
							path,
							branch: manifestKind === "consistent" ? "task" : "other",
						},
					});
				if (manifestKind === "loop") {
					const loop = join(dir, "loop");
					symlinkSync(loop, loop);
					manifests.push({
						file: "/loop.json",
						value: { state: "created", path: loop, branch: "unknown" },
					});
				}
				// Deterministic EACCES guards, including when running tests as root.
				if (manifestKind.endsWith("-denied")) {
					const denied = () => {
						throw Object.assign(new Error("EACCES manifest identity"), {
							code: "EACCES",
						});
					};
					if (manifestKind === "lstat-denied") {
						const original = ops.exists;
						ops.exists = (candidate) =>
							candidate === dangling ? denied() : original(candidate);
					} else {
						const original = ops.realpath;
						ops.realpath = (candidate) =>
							candidate === dangling ? denied() : original(candidate);
					}
				}
				ops.readManifests = () => manifests;
				const [row] = await listContainedWorktrees({
					cwd: dir,
					operations: ops,
				});
				if (manifestKind === "conflicting") {
					assert.equal(row.classification, "unknown");
					assert.match(
						row.blockers.join(),
						/Manifest and live worktree identity disagree/,
					);
					assert.equal(row.manifest.length, 1);
				} else if (
					manifestKind === "loop" ||
					manifestKind.endsWith("-denied")
				) {
					assert.equal(row.classification, "unknown");
					assert.match(row.blockers.join(), /ELOOP|EACCES/);
				} else {
					assert.equal(row.classification, "eligible");
					assert.deepEqual(row.blockers, []);
					assert.equal(
						row.manifest.length,
						manifestKind === "consistent" ? 1 : 0,
					);
				}
			} finally {
				rmSync(dir, { recursive: true });
			}
		});
	}
	it("bounds Git and Herdr cleanup exec calls and fails closed on timeout", async (t) => {
		const ops = createWorktreeCleanupOperations({
			manifestDir: "/unused",
			liveHolders: () => [],
		});
		const calls: string[] = [];
		const mocked = t.mock.method(
			childProcess,
			"execFileSync",
			(
				file: string,
				_args: string[],
				options: { timeout?: number; killSignal?: string },
			) => {
				assert.equal(options.timeout, 30_000);
				assert.equal(options.killSignal, "SIGKILL");
				calls.push(file);
				throw new Error("ETIMEDOUT");
			},
		);
		syncBuiltinESMExports();
		try {
			const f = cleanupFixture();
			f.operations.inspectGit = ops.inspectGit;
			const result = await removeContainedWorktree(f.input);
			assert.equal(result.status, "blocked");
			assert.match(result.message, /ETIMEDOUT/);
			assert.deepEqual(f.calls, []);
			assert.throws(() => ops.listHerdr("/repo"), /ETIMEDOUT/);
			assert.throws(() => ops.removeWorkspace("fixture"), /ETIMEDOUT/);
			assert.deepEqual(calls, ["git", "herdr", "herdr"]);
		} finally {
			mocked.mock.restore();
			syncBuiltinESMExports();
		}
	});
	it("detects a real node-MainThread process through /proc, not a runtime allowlist", {
		skip: process.platform !== "linux",
	}, async () => {
		const dir = mkdtempSync(join(tmpdir(), "cleanup-proc-"));
		const checkout = join(dir, "checkout");
		const procRoot = join(dir, "proc");
		mkdirSync(checkout);
		mkdirSync(procRoot);
		const child = spawn(
			process.execPath,
			[
				"-e",
				'process.title="node-MainThread"; console.log("ready"); setInterval(() => {}, 1000)',
			],
			{ cwd: checkout, stdio: ["ignore", "pipe", "pipe"] },
		);
		try {
			await once(child.stdout!, "data");
			symlinkSync(`/proc/${child.pid}`, join(procRoot, String(child.pid)));
			assert.equal(
				readFileSync(`/proc/${child.pid}/comm`, "utf8").trim(),
				"node-MainThread",
			);
			for (const idleShellPids of [new Set<number>(), new Set([child.pid!])]) {
				assert.match(
					__worktreeCleanupTest__
						.processHolders(checkout, idleShellPids, procRoot)
						.blockers.join(),
					new RegExp(`${child.pid} holds the checkout`),
				);
			}
		} finally {
			child.kill();
			await once(child, "exit");
			rmSync(dir, { recursive: true });
		}
	});
	it("blocks non-runtime holders but warns about unverifiable live process cwd", {
		skip: process.platform !== "linux",
	}, () => {
		const dir = mkdtempSync(join(tmpdir(), "cleanup-proc-"));
		try {
			mkdirSync(join(dir, "123"));
			writeFileSync(join(dir, "123", "comm"), "python3\n");
			writeFileSync(join(dir, "123", "status"), "State:\tS (sleeping)\n");
			symlinkSync(dir, join(dir, "123", "cwd"));
			assert.match(
				__worktreeCleanupTest__
					.processHolders(dir, new Set(), dir)
					.blockers.join(),
				/123.*holds/,
			);
			rmSync(join(dir, "123", "cwd"));
			const result = __worktreeCleanupTest__.processHolders(
				dir,
				new Set(),
				dir,
			);
			assert.deepEqual(result.blockers, []);
			assert.match(result.warnings.join(), /123.*unreadable/);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
	it("tolerates symlinked ancestors but blocks a checkout symlink escaping the managed root", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cleanup-alias-"));
		try {
			const root = join(dir, "real", "managed");
			const path = join(root, "repo", "task");
			mkdirSync(path, { recursive: true });
			symlinkSync(join(dir, "real"), join(dir, "home"));
			const ops = createWorktreeCleanupOperations({
				managedRoot: join(dir, "home", "managed"),
				manifestDir: join(dir, "manifests"),
				liveHolders: () => [],
			});
			ops.resolveSource = () => join(dir, "home");
			ops.inspectGit = () => ({ ...cleanupFixture().state });
			ops.listHerdr = () => [];
			ops.holders = async () => ({ blockers: [], warnings: [] });
			const [row] = await listContainedWorktrees({
				cwd: join(dir, "home"),
				operations: ops,
			});
			assert.equal(row.classification, "eligible");
			assert.equal(row.path, fs.realpathSync(path));
			assert.equal(row.sourceRepo, fs.realpathSync(join(dir, "real")));
			symlinkSync(dir, join(root, "repo", "escape"));
			const escaped = (
				await listContainedWorktrees({ cwd: dir, operations: ops })
			).find((entry) => entry.path.endsWith("escape"))!;
			assert.equal(escaped.classification, "unknown");
			assert.match(escaped.blockers.join(), /symlink to an unmanaged/);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
	it("probes ignored files and detached HEAD, and restores the exact index after a failed hook", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cleanup-git-"));
		const git = (args: string[]) =>
			execFileSync("git", args, {
				cwd: dir,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		try {
			git(["init", "-q", "-b", "task"]);
			git(["config", "user.name", "Cleanup test"]);
			git(["config", "user.email", "cleanup@example.invalid"]);
			git(["config", "commit.gpgsign", "false"]);
			writeFileSync(join(dir, ".gitignore"), ".env\n");
			writeFileSync(join(dir, "tracked"), "base\n");
			git(["add", "."]);
			git(["commit", "-qm", "base"]);
			writeFileSync(join(dir, "tracked"), "staged\n");
			git(["add", "tracked"]);
			writeFileSync(join(dir, "tracked"), "unstaged\n");
			writeFileSync(join(dir, "new-file"), "untracked\n");
			writeFileSync(join(dir, ".env"), "ignored fixture\n");
			const ops = createWorktreeCleanupOperations({
				manifestDir: join(dir, "manifests"),
				liveHolders: () => [],
			});
			assert.equal((await ops.inspectGit(dir, dir)).ignoredFiles, 1);
			const index = readFileSync(join(dir, ".git", "index"));
			const status = git(["status", "--porcelain=v1"]);
			const hook = join(dir, ".git", "hooks", "pre-commit");
			writeFileSync(hook, "#!/bin/sh\nexit 1\n");
			chmodSync(hook, 0o755);
			const entry = (await listContainedWorktrees(cleanupFixture().input))[0];
			entry.path = dir;
			assert.throws(() => ops.preserve(entry));
			assert.deepEqual(readFileSync(join(dir, ".git", "index")), index);
			assert.equal(git(["status", "--porcelain=v1"]), status);
			assert.equal(readFileSync(join(dir, "tracked"), "utf8"), "unstaged\n");
			assert.equal(readFileSync(join(dir, "new-file"), "utf8"), "untracked\n");
			git([
				"update-ref",
				"--no-deref",
				"HEAD",
				git(["rev-parse", "HEAD"]).trim(),
			]);
			entry.git = await ops.inspectGit(dir, dir);
			assert.equal(entry.git.branch, "");
			assert.match(cleanupBlockers(entry).join(), /Detached HEAD/);
			entry.branch = entry.git.branch;
			assert.throws(() => ops.preserve(entry), /Retained branch/);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});

describe("explicit worktree cleanup", () => {
	it("lists contained cross-session orphans and retains local-only history", async () => {
		const f = cleanupFixture();
		const [row] = await listContainedWorktrees(f.input);
		assert.equal(row.classification, "eligible");
		assert.equal(row.sourceRepo, "/repo");
		assert.deepEqual(row.manifest, []);
		assert.match(formatWorktreeInventory([row]), /manifest: absent/);
		const inventory = formatWorktreeInventory([
			{ ...row, path: "/managed/inside", branch: "inside" },
			{
				...row,
				path: "/managed/outside",
				branch: "outside",
				contained: false,
				classification: "out-of-scope",
			},
		]);
		assert.ok(
			inventory.indexOf("outside —") < inventory.indexOf("inside —"),
			"in-scope rows stay at the end of large inventories",
		);
		assert.deepEqual(f.calls, []);
	});
	for (const [name, patch, blocker] of [
		["dirty", { dirtyFiles: 1 }, /Dirty/],
		["untracked", { untrackedFiles: 1 }, /untracked/],
		["conflicted", { conflicts: 1 }, /conflicted/],
		["submodules", { submodules: true }, /deinitialize/],
		["locked", { locked: true }, /locked/],
		["detached", { branch: "" }, /Detached/],
		["residue", { registered: false }, /unknown residue/],
	] as const) {
		it(`blocks ${name} without any removal effects`, async () => {
			const f = cleanupFixture();
			Object.assign(f.state, patch);
			const result = await removeContainedWorktree({
				...f.input,
				target: "/managed/repo/task",
			});
			assert.equal(result.status, "blocked");
			assert.match(result.message, blocker);
			assert.deepEqual(f.calls, []);
		});
	}
	for (const dirty of [false, true]) {
		it(`blocks detached HEAD with preserve requested (dirty: ${dirty})`, async () => {
			const f = cleanupFixture();
			Object.assign(f.state, {
				branch: "",
				dirtyFiles: dirty ? 1 : 0,
				untrackedFiles: dirty ? 1 : 0,
			});
			const before = { ...f.state };
			const target = "/managed/repo/task";
			const result = await removeContainedWorktree({
				...f.input,
				target,
				preserve: true,
			});
			assert.equal(result.status, "blocked");
			assert.match(result.message, /Detached HEAD: no retained branch/);
			assert.equal(result.entry?.path, target);
			assert.deepEqual(f.calls, [], "must neither preserve nor remove");
			assert.equal(f.operations.exists(target), true);
			assert.deepEqual(f.state, before);
		});
	}
	it("fails closed for out-of-scope and prefix-collision repositories", async () => {
		const f = cleanupFixture();
		f.operations.resolveSource = () => "/repo-other";
		assert.equal(
			(await listContainedWorktrees(f.input))[0].classification,
			"out-of-scope",
		);
		assert.equal(
			(await removeContainedWorktree({ ...f.input, preserve: true })).status,
			"blocked",
		);
		assert.deepEqual(f.calls, []);
	});
	it("canonicalizes cwd and source paths before containment", async () => {
		const f = cleanupFixture();
		f.operations.realpath = (path) => (path === "/alias" ? "/repo" : path);
		assert.equal(
			(await listContainedWorktrees({ ...f.input, cwd: "/alias" }))[0]
				.classification,
			"eligible",
		);
		assert.equal(
			(await listContainedWorktrees({ ...f.input, cwd: "/repo/subfolder" }))[0]
				.classification,
			"out-of-scope",
		);
	});
	for (const probe of [
		"inspectGit",
		"listHerdr",
		"holders",
		"resolveSource",
		"realpath",
	] as const) {
		it(`reports unknown when ${probe} fails`, async () => {
			const f = cleanupFixture();
			f.operations[probe] = () => {
				throw new Error("probe unavailable");
			};
			const [row] = await listContainedWorktrees(f.input);
			assert.equal(row.classification, "unknown");
			assert.match(row.blockers.join(), /probe unavailable/);
			assert.equal(
				(
					await removeContainedWorktree({
						...f.input,
						target: row.path,
						preserve: true,
					})
				).status,
				"blocked",
			);
			assert.deepEqual(f.calls, []);
		});
	}
	for (const holder of [
		"Live child holds the worktree",
		"Persistent-specialist lease holds the worktree",
	]) {
		it(`blocks ${holder}`, async () => {
			const f = cleanupFixture();
			f.operations.holders = async () => ({ blockers: [holder], warnings: [] });
			const result = await removeContainedWorktree({
				...f.input,
				preserve: true,
			});
			assert.equal(result.status, "blocked");
			assert.match(result.message, new RegExp(holder));
			assert.deepEqual(f.calls, []);
		});
	}
	it("blocks symlink aliases without turning the target into a managed candidate", async () => {
		const f = cleanupFixture();
		f.operations.realpath = (path) =>
			path === "/managed/repo/task" ? "/unmanaged/task" : path;
		const [row] = await listContainedWorktrees(f.input);
		assert.equal(row.path, "/managed/repo/task");
		assert.equal(row.classification, "unknown");
		assert.equal(
			(await removeContainedWorktree({ ...f.input, target: row.path })).status,
			"blocked",
		);
		assert.equal(
			(await removeContainedWorktree({ ...f.input, target: "/unmanaged/task" }))
				.status,
			"blocked",
		);
		assert.deepEqual(f.calls, []);
	});
	for (const source of ["Herdr", "manifest"]) {
		it(`blocks ${source} identity disagreements`, async () => {
			const f = cleanupFixture();
			if (source === "Herdr")
				f.operations.listHerdr = () => [
					{
						path: "/managed/repo/task",
						branch: "other",
						isLinkedWorktree: true,
					},
				];
			else
				f.operations.readManifests = () => [
					{
						file: "/manifest",
						value: { path: "/managed/repo/task", branch: "other" },
					},
				];
			const result = await removeContainedWorktree(f.input);
			assert.equal(result.status, "blocked");
			assert.match(result.message, /identity disagree/);
			assert.deepEqual(f.calls, []);
		});
	}
	it("preserve never bypasses conflicts or submodule blockers", async () => {
		for (const patch of [
			{ conflicts: 1 },
			{ submodules: true },
			{ branch: "" },
		]) {
			const f = cleanupFixture();
			Object.assign(f.state, { dirtyFiles: 1 }, patch);
			assert.equal(
				(await removeContainedWorktree({ ...f.input, preserve: true })).status,
				"blocked",
			);
			assert.deepEqual(f.calls, []);
		}
	});
	it("uses Herdr for an open workspace and merges the reachable manifest", async () => {
		const f = cleanupFixture();
		f.operations.listHerdr = () => [
			{
				path: "/managed/repo/task",
				branch: "task",
				isLinkedWorktree: true,
				workspaceId: "w1",
			},
		];
		f.operations.readManifests = () => [
			{
				file: "/manifest.json",
				value: {
					branch: "task",
					path: "/managed/repo/task",
					state: "ready_for_review",
					baseSha: "base",
				},
			},
		];
		const result = await removeContainedWorktree(f.input);
		assert.equal(result.status, "removed");
		assert.equal(result.entry?.manifest[0].value.baseSha, "base");
		assert.deepEqual(f.calls, ["herdr:w1", "manifest:removed"]);
		assert.match(result.message, /Branch task and its commits retained/);
	});
	it("uses Git for an orphan, then prunes only after absence is verified", async () => {
		const f = cleanupFixture();
		assert.equal((await removeContainedWorktree(f.input)).status, "removed");
		assert.deepEqual(f.calls, ["git:/repo:/managed/repo/task", "prune:/repo"]);
		assert.equal("deleteBranch" in f.operations, false);
	});
	it("reprobes eligibility immediately before removal", async () => {
		const f = cleanupFixture();
		let count = 0;
		f.operations.holders = async () => ({
			blockers: ++count === 1 ? [] : ["Live child restarted"],
			warnings: [],
		});
		assert.equal((await removeContainedWorktree(f.input)).status, "blocked");
		assert.deepEqual(f.calls, []);
	});
	for (const kind of ["herdr", "git", "checkout-present", "prune"] as const) {
		it(`reports ${kind} failure without marking manifests removed`, async () => {
			const f = cleanupFixture();
			const fail = () => {
				throw new Error("refused");
			};
			if (kind === "herdr") {
				f.operations.listHerdr = () => [
					{
						path: "/managed/repo/task",
						branch: "task",
						isLinkedWorktree: true,
						workspaceId: "w1",
					},
				];
				f.operations.removeWorkspace = fail;
			}
			if (kind === "git") f.operations.removeCheckout = fail;
			if (kind === "checkout-present") f.operations.removeCheckout = () => {};
			if (kind === "prune") f.operations.prune = fail;
			f.operations.readManifests = () => [
				{
					file: "/manifest.json",
					value: { path: "/managed/repo/task", branch: "task" },
				},
			];
			assert.equal((await removeContainedWorktree(f.input)).status, "failed");
			assert.equal(
				f.calls.some((call) => call.startsWith("manifest:")),
				false,
			);
			if (kind !== "prune")
				assert.equal(
					f.calls.some((call) => call.startsWith("prune:")),
					false,
				);
		});
	}
	it("requires explicit preservation and reports its SHA", async () => {
		const f = cleanupFixture();
		f.state.dirtyFiles = 2;
		f.state.untrackedFiles = 1;
		assert.equal((await removeContainedWorktree(f.input)).status, "blocked");
		const result = await removeContainedWorktree({
			...f.input,
			preserve: true,
		});
		assert.equal(result.status, "removed");
		assert.equal(result.preservationSha, "wip-sha");
		assert.deepEqual(f.calls, [
			"preserve",
			"git:/repo:/managed/repo/task",
			"prune:/repo",
		]);
	});
	it("preservation failure aborts removal with state retained", async () => {
		const f = cleanupFixture();
		f.state.dirtyFiles = 1;
		f.operations.preserve = () => {
			throw new Error("commit hook rejected");
		};
		const result = await removeContainedWorktree({
			...f.input,
			preserve: true,
		});
		assert.equal(result.status, "failed");
		assert.match(result.message, /commit hook rejected/);
		assert.equal(f.state.dirtyFiles, 1);
		assert.deepEqual(f.calls, []);
	});
	it("rechecks dirty state after preservation", async () => {
		const f = cleanupFixture();
		f.state.dirtyFiles = 1;
		f.operations.preserve = () => "sha-but-still-dirty";
		assert.equal(
			(await removeContainedWorktree({ ...f.input, preserve: true })).status,
			"blocked",
		);
		assert.deepEqual(f.calls, []);
	});
	it("refuses ambiguous names and unknown targets", async () => {
		const f = cleanupFixture();
		assert.equal(
			(await removeContainedWorktree({ ...f.input, target: "absent" })).status,
			"blocked",
		);
		f.operations.scan = () => ["/managed/repo/task", "/managed/other/task"];
		assert.match((await removeContainedWorktree(f.input)).message, /Ambiguous/);
		assert.deepEqual(f.calls, []);
	});
	it("ignores removed manifests when the branch is relaunched at the same path", async () => {
		const f = cleanupFixture();
		f.operations.readManifests = () => [
			{
				file: "/old.json",
				value: {
					path: "/managed/repo/task",
					branch: "previous",
					workspaceId: "old",
					state: "removed",
				},
			},
		];
		assert.equal(
			(await listContainedWorktrees(f.input))[0].classification,
			"eligible",
		);
		assert.equal((await removeContainedWorktree(f.input)).status, "removed");
		assert.deepEqual(f.calls, ["git:/repo:/managed/repo/task", "prune:/repo"]);
	});
	it("discloses ignored files in inventory and removal without blocking", async () => {
		const f = cleanupFixture();
		f.state.ignoredFiles = 2;
		const rows = await listContainedWorktrees(f.input);
		assert.equal(rows[0].classification, "eligible");
		assert.match(formatWorktreeInventory(rows), /2 ignored/);
		assert.match(
			(await removeContainedWorktree(f.input)).message,
			/Deleted 2 ignored files/,
		);
	});
	it("reports ignored exclusions and preservation SHA after later refusal or failure", async () => {
		for (const kind of ["preserve", "reinspect", "remove"]) {
			const f = cleanupFixture();
			f.state.dirtyFiles = 1;
			f.state.ignoredFiles = 2;
			if (kind === "preserve")
				f.operations.preserve = () => {
					throw new Error("hook rejected");
				};
			if (kind === "reinspect") {
				const preserve = f.operations.preserve;
				f.operations.preserve = (entry) => {
					const sha = preserve(entry);
					f.state.locked = true;
					return sha;
				};
			}
			if (kind === "remove")
				f.operations.removeCheckout = () => {
					throw new Error("remove refused");
				};
			const result = await removeContainedWorktree({
				...f.input,
				preserve: true,
			});
			assert.notEqual(result.status, "removed");
			assert.match(
				result.message,
				/2 ignored files are not captured by preservation/,
			);
			if (kind !== "preserve") assert.match(result.message, /wip-sha/);
		}
	});
	it("reports manifest write failure as removed with warning", async () => {
		const f = cleanupFixture();
		f.operations.readManifests = () => [
			{
				file: "/manifest",
				value: { path: "/managed/repo/task", branch: "task" },
			},
		];
		f.operations.writeManifest = () => {
			throw new Error("permission denied");
		};
		const result = await removeContainedWorktree(f.input);
		assert.equal(result.status, "removed");
		assert.match(result.message, /Warning: Manifest.*permission denied/);
	});
	it("reports inspection failure instead of claiming an existing branch is missing", async () => {
		const f = cleanupFixture();
		f.operations.inspectGit = () => {
			throw new Error("Git timed out");
		};
		const result = await removeContainedWorktree(f.input);
		assert.equal(result.status, "blocked");
		assert.match(result.message, /Git timed out/);
		assert.doesNotMatch(result.message, /Target not found/);
	});
	it("already removed is a no-op with retained manifest evidence", async () => {
		const f = cleanupFixture();
		f.operations.scan = () => [];
		f.operations.exists = () => false;
		f.operations.readManifests = () => [
			{
				file: "/manifest",
				value: { path: "/managed/repo/task", branch: "task", state: "removed" },
			},
		];
		assert.equal(
			(await removeContainedWorktree(f.input)).status,
			"already-removed",
		);
		assert.deepEqual(f.calls, []);
	});
	it("removal args contain only the explicit workspace selector", () => {
		assert.deepEqual(__herdrTest__.buildWorktreeRemoveArgs("w1"), [
			"worktree",
			"remove",
			"--workspace",
			"w1",
		]);
	});
	it("manifest read/merge-write round-trip retains metadata and skips invalid JSON", () => {
		const dir = mkdtempSync(join(tmpdir(), "cleanup-manifest-"));
		const file = join(dir, "manifest.json");
		try {
			writeWorktreeManifest(file, {
				branch: "task",
				state: "running",
				baseSha: "base",
			});
			writeWorktreeManifest(file, {
				state: "removed",
				workspaceRemovedAt: 123,
			});
			assert.equal(readWorktreeManifest(file)?.state, "removed");
			assert.equal(readWorktreeManifest(file)?.baseSha, "base");
			assert.equal(
				JSON.parse(readFileSync(file, "utf8")).workspaceRemovedAt,
				123,
			);
			writeFileSync(file, "{");
			assert.equal(readWorktreeManifest(file), undefined);
			writeFileSync(file, JSON.stringify({ owner: "foreign" }));
			assert.equal(readWorktreeManifest(file), undefined);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});
