import "./clean-host-env.ts";
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
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __herdrTest__ } from "../maestro/surfaces/herdr/herdr.ts";
import {
	cleanupBlockers,
	listContainedWorktrees,
	removeContainedWorktree,
} from "@nubl/maestro/core/worktree-cleanup";
import {
	createWorktreeCleanupOperations as buildCleanupOperations,
	__worktreeCleanupTest__,
} from "@nubl/maestro/runtime/worktree-operations";
import { HerdrSurfaceProvider } from "../maestro/surfaces/herdr/herdr-surface-provider.ts";

const provider = new HerdrSurfaceProvider({
	paneConfig: { mode: "tab", direction: "right", maxPerTab: 4 },
});
const createWorktreeCleanupOperations = (
	input: Parameters<typeof buildCleanupOperations>[1],
) => buildCleanupOperations(provider, input);
import { cleanupFixture } from "./worktree-cleanup-fixture.ts";
import { worktreesUnsupportedOnWindows } from "./helpers/windows-scope.ts";

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
	it("scans and canonicalizes cleanup paths without opening protected directories", (t) => {
		// Regression for #97: managedRoot/scan/ops.realpath and escaped managed
		// symlinks used realpathSync/readdirSync, which Bun implements with open()
		// and can freeze Pi on a protected macOS directory.
		const dir = fs.realpathSync(
			mkdtempSync(join(tmpdir(), "cleanup-scan-open-")),
		);
		const managed = join(dir, "managed");
		const safeRepo = join(managed, "repo");
		const safeTask = join(safeRepo, "task");
		const protectedDir = join(dir, "protected");
		const escape = join(managed, "escape");
		mkdirSync(safeTask, { recursive: true });
		mkdirSync(protectedDir);
		symlinkSync(protectedDir, escape);
		const opened: string[] = [];
		const readdirSeen: string[] = [];
		const realpath = fs.realpathSync;
		const readdir = fs.readdirSync;
		const refuseProtected = (path: fs.PathLike) => {
			const raw = String(path);
			// Resolve through symlinks before the prefix check so a readdir of
			// managed/escape (the symlink itself) is caught as opening protected.
			// Use the unbound native helper so this resolve never hits the mock.
			let resolved = raw;
			try {
				resolved = realpath.native(raw);
			} catch {
				// Keep the unresolved path for the prefix check.
			}
			if (raw.startsWith(protectedDir) || resolved.startsWith(protectedDir)) {
				opened.push(raw);
				throw new Error("would block on open");
			}
		};
		const mocks = [
			t.mock.method(fs, "realpathSync", (path: string, options?: any) => {
				refuseProtected(path);
				return realpath(path, options);
			}),
			t.mock.method(fs, "readdirSync", (path: fs.PathLike, options?: any) => {
				readdirSeen.push(String(path));
				refuseProtected(path);
				return readdir(path, options);
			}),
			t.mock.method(fs, "openSync", refuseProtected),
			t.mock.method(fs, "opendirSync", refuseProtected),
		];
		syncBuiltinESMExports();
		try {
			const ops = createWorktreeCleanupOperations({
				managedRoot: managed,
				manifestDir: join(dir, "manifests"),
				liveHolders: () => [],
			});
			assert.equal(ops.realpath(safeTask), realpath(safeTask));
			assert.equal(ops.managedRoot(), realpath(managed));
			assert.deepEqual(ops.scan(), [safeTask]);
			assert.deepEqual(opened, []);
			assert.ok(
				!readdirSeen.includes(escape),
				"scan must not readdir an escaping managed symlink",
			);
			assert.equal(
				__herdrTest__.sameCheckoutPath(safeTask, realpath(safeTask)),
				true,
			);
			assert.equal(
				__herdrTest__.canonicalPath(
					join(managed, "repo", "..", "repo", "task"),
				),
				realpath(safeTask),
			);
			assert.deepEqual(opened, []);
		} finally {
			for (const mock of mocks) mock.mock.restore();
			syncBuiltinESMExports();
			rmSync(dir, { recursive: true });
		}
	});
});

describe("cleanup operating-system probes", () => {
	it("counts every ignored file when the real Git listing exceeds 1 MiB", {
		skip: worktreesUnsupportedOnWindows,
	}, async (t) => {
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
	it("inspects a clean Git sibling beside a detached entry from captured Herdr output", {
		skip: worktreesUnsupportedOnWindows,
	}, async () => {
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
			ops.listWorktrees = () => __herdrTest__.parseHerdrWorktreeList(payload);
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
				ops.listWorktrees = () => [];
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
			await __herdrTest__.withMockHerdrExec(
				(_args, timeout, mode) => {
					assert.equal(timeout, 30_000);
					assert.equal(mode, "async");
					calls.push("herdr");
					throw new Error("ETIMEDOUT");
				},
				async () => {
					await assert.rejects(
						async () => ops.listWorktrees("/repo"),
						/ETIMEDOUT/,
					);
					await assert.rejects(
						async () => ops.removeWorkspace("fixture"),
						/ETIMEDOUT/,
					);
				},
			);
			assert.deepEqual(calls, ["git", "herdr", "herdr"]);
		} finally {
			mocked.mock.restore();
			syncBuiltinESMExports();
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
			ops.listWorktrees = () => [];
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
		// The cleanup operations spawn git with the inherited environment, so
		// isolate the whole process from global hooksPath and similar settings.
		// Hooks export an absolute GIT_DIR and GIT_INDEX_FILE; inheriting them
		// would point fixture commands at the host repository.
		const overriddenEnv = {
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
		};
		const removedEnv = [
			"GIT_DIR",
			"GIT_INDEX_FILE",
			"GIT_WORK_TREE",
			"GIT_CONFIG_COUNT",
			"GIT_CONFIG_PARAMETERS",
		];
		const savedEnv = Object.fromEntries(
			[...Object.keys(overriddenEnv), ...removedEnv].map((key) => [
				key,
				process.env[key],
			]),
		);
		Object.assign(process.env, overriddenEnv);
		for (const key of removedEnv) delete process.env[key];
		try {
			git(["init", "-q", "-b", "task"]);
			git(["config", "user.name", "Cleanup test"]);
			git(["config", "user.email", "cleanup@example.invalid"]);
			git(["config", "commit.gpgsign", "false"]);
			git(["config", "core.untrackedCache", "true"]);
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
			const status = git(["status", "--porcelain=v1"]);
			// The first default-mode status fills the untracked cache and rewrites
			// the index; inspectGit's --untracked-files=all status does not.
			const index = readFileSync(join(dir, ".git", "index"));
			const hook = join(dir, ".git", "hooks", "pre-commit");
			// Git does not export GIT_DIR to this hook.
			writeFileSync(
				hook,
				'#!/bin/sh\ntouch "$(git rev-parse --git-dir)/hook-ran"\nexit 1\n',
			);
			chmodSync(hook, 0o755);
			const entry = (await listContainedWorktrees(cleanupFixture().input))[0];
			entry.path = dir;
			assert.throws(() => ops.preserve(entry), /git commit|pre-commit/);
			assert.ok(fs.existsSync(join(dir, ".git", "hook-ran")));
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
			for (const [key, value] of Object.entries(savedEnv)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(dir, { recursive: true });
		}
	});
});

describe("explicit worktree cleanup", () => {
	it("removal args contain only the explicit workspace selector", () => {
		assert.deepEqual(__herdrTest__.buildWorktreeRemoveArgs("w1"), [
			"worktree",
			"remove",
			"--workspace",
			"w1",
		]);
	});
});

describe("submodule source repositories", {
	skip: worktreesUnsupportedOnWindows,
}, () => {
	const gitIn = (cwd: string, args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
	const initRepository = (cwd: string) => {
		mkdirSync(cwd, { recursive: true });
		gitIn(cwd, ["init", "-q", "-b", "main"]);
		gitIn(cwd, ["config", "user.name", "Cleanup test"]);
		gitIn(cwd, ["config", "user.email", "cleanup@example.invalid"]);
		gitIn(cwd, ["config", "commit.gpgsign", "false"]);
	};
	const submoduleFixture = (dir: string) => {
		const origin = join(dir, "origin");
		initRepository(origin);
		gitIn(origin, ["commit", "--allow-empty", "-qm", "base"]);
		const parent = join(dir, "parent");
		initRepository(parent);
		gitIn(parent, [
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"add",
			"-q",
			origin,
			"apps/sub",
		]);
		gitIn(parent, ["commit", "-qm", "add submodule"]);
		const source = join(parent, "apps", "sub");
		const managed = join(dir, "managed");
		const worktree = join(managed, "sub", "task");
		mkdirSync(join(managed, "sub"), { recursive: true });
		gitIn(source, ["worktree", "add", "-q", "-b", "task", worktree]);
		const common = gitIn(worktree, [
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]).trim();
		assert.match(common, /\.git\/modules\/apps\/sub$/);
		const operations = createWorktreeCleanupOperations({
			managedRoot: managed,
			manifestDir: join(dir, "manifests"),
			liveHolders: () => [],
		});
		operations.listWorktrees = () => [];
		operations.holders = async () => ({ blockers: [], warnings: [] });
		return { origin, parent, source, worktree, common, operations };
	};

	for (const location of ["shared config", "included config"] as const) {
		it(`resolves, inventories, and removes a submodule worktree orphan with core.worktree in ${location}`, async () => {
			const dir = fs.realpathSync(mkdtempSync(join(tmpdir(), "cleanup-sub-")));
			try {
				const f = submoduleFixture(dir);
				if (location === "included config") {
					const shared = join(f.common, "config");
					const included = join(dir, "included.config");
					const configured = gitIn(f.source, [
						"config",
						"--get",
						"core.worktree",
					]).trim();
					gitIn(dir, [
						"config",
						"--file",
						included,
						"core.worktree",
						configured,
					]);
					gitIn(dir, ["config", "--file", shared, "--unset", "core.worktree"]);
					gitIn(dir, ["config", "--file", shared, "include.path", included]);
					assert.doesNotMatch(readFileSync(shared, "utf8"), /worktree =/);
				}

				assert.equal(f.operations.resolveSource(f.worktree), f.source);
				const [row] = await listContainedWorktrees({
					cwd: f.parent,
					operations: f.operations,
				});
				assert.equal(row.sourceRepo, f.source);
				assert.equal(row.branch, "task");
				assert.equal(row.classification, "eligible", row.blockers.join("; "));
				const [outside] = await listContainedWorktrees({
					cwd: f.origin,
					operations: f.operations,
				});
				assert.equal(outside.classification, "out-of-scope");

				const result = await removeContainedWorktree({
					cwd: f.parent,
					operations: f.operations,
					target: f.worktree,
				});
				assert.equal(result.status, "removed", result.message);
				assert.equal(fs.existsSync(f.worktree), false);
				assert.doesNotMatch(
					gitIn(f.source, ["worktree", "list", "--porcelain"]),
					/managed\/sub\/task/,
				);
				assert.equal(
					gitIn(f.source, ["branch", "--list", "task"]).trim(),
					"task",
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	it("fails closed when core.worktree names a checkout of another repository", async () => {
		const dir = fs.realpathSync(mkdtempSync(join(tmpdir(), "cleanup-sub-")));
		try {
			const f = submoduleFixture(dir);
			const other = join(dir, "other");
			initRepository(other);
			gitIn(dir, [
				"config",
				"--file",
				join(f.common, "config"),
				"core.worktree",
				other,
			]);
			assert.throws(
				() => f.operations.resolveSource(f.worktree),
				/Source Git directory mismatch/,
			);
			const [row] = await listContainedWorktrees({
				cwd: dir,
				operations: f.operations,
			});
			assert.equal(row.classification, "unknown");
			assert.match(row.blockers.join(), /Source Git directory mismatch/);
			const result = await removeContainedWorktree({
				cwd: dir,
				operations: f.operations,
				target: f.worktree,
			});
			assert.notEqual(result.status, "removed");
			assert.equal(fs.existsSync(f.worktree), true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("still blocks a superproject worktree whose submodules are initialized", async () => {
		const dir = fs.realpathSync(mkdtempSync(join(tmpdir(), "cleanup-sub-")));
		try {
			const f = submoduleFixture(dir);
			const worktree = join(dir, "managed", "parent", "task");
			mkdirSync(join(dir, "managed", "parent"));
			gitIn(f.parent, ["worktree", "add", "-q", "-b", "task", worktree]);
			gitIn(worktree, [
				"-c",
				"protocol.file.allow=always",
				"submodule",
				"update",
				"--init",
				"-q",
			]);
			const row = (
				await listContainedWorktrees({
					cwd: f.parent,
					operations: f.operations,
				})
			).find((entry) => entry.path === worktree);
			assert.ok(row);
			assert.equal(row.sourceRepo, f.parent);
			assert.equal(row.classification, "blocked");
			assert.match(row.blockers.join(), /Initialized submodules/);
			const result = await removeContainedWorktree({
				cwd: f.parent,
				operations: f.operations,
				target: worktree,
			});
			assert.equal(result.status, "blocked");
			assert.equal(fs.existsSync(worktree), true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
