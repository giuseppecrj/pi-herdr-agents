import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	renameSync,
	lstatSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	readFileSync,
	statSync,
	writeFileSync,
	unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isRecord, type JsonObject } from "../core/config/type-guards.ts";
import { gitEnvironment } from "../core/git-environment.ts";
import { Deadline } from "../core/deadline.ts";
import type { SurfaceProvider } from "../core/surface-provider.ts";
import type {
	CleanupGitState,
	HolderInspection,
	WorktreeCleanupOperations,
} from "../core/worktree-cleanup.ts";
import {
	isWorktreeManifest,
	mergeWorktreeManifest,
	type WorktreeLaunch,
	type WorktreeHandoff,
	type WorktreeResultState,
	type WorktreeOperations,
} from "../core/worktree.ts";

function message(error: any): string {
	return error instanceof Error ? error.message : String(error);
}
function contained(root: string, path: string): boolean {
	const rel = relative(root, path);
	return (
		rel === "" ||
		(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
	);
}

export const GIT_BASE_TIMEOUT_MS = 10_000;
export const GIT_SOURCE_TIMEOUT_MS = 15_000;
export const GIT_HANDOFF_TIMEOUT_MS = 15_000;
const GIT_OUTPUT_BYTES = 1024 * 1024;

/** One owned read client; expiry bounds the wait even if descendants hold pipes. */
async function gitRead(
	cwd: string,
	args: string[],
	deadline: Deadline,
): Promise<string> {
	const timeout = deadline.remainingMs();
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, {
			cwd,
			env: gitEnvironment(),
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		let settled = false,
			bytes = 0,
			errorBytes = 0;
		const output: Buffer[] = [],
			errors: Buffer[] = [];
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				if (process.platform !== "win32" && child.pid)
					process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				/* already exited */
			}
			child.stdout.destroy();
			child.stderr.destroy();
			child.unref();
			reject(error);
		};
		const timer = setTimeout(
			() => fail(new Error("Git inspection deadline exceeded")),
			timeout,
		);
		child.on("error", fail);
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > GIT_OUTPUT_BYTES)
				fail(new Error("Git output limit exceeded"));
			else output.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			errorBytes += chunk.length;
			if (errorBytes > GIT_OUTPUT_BYTES)
				fail(new Error("Git error output limit exceeded"));
			else errors.push(chunk);
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			if (deadline.expired())
				return fail(new Error("Git inspection deadline exceeded"));
			if (code !== 0)
				return fail(
					new Error(
						`Git exited ${code ?? signal}: ${Buffer.concat(errors).toString("utf8")}`,
					),
				);
			settled = true;
			clearTimeout(timer);
			resolve(Buffer.concat(output).toString("utf8"));
		});
	});
}

function gitSha(output: string): string {
	const sha = output.trim();
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))
		throw new Error("Git returned an invalid commit SHA");
	return sha;
}

export async function resolveGitCommit(
	cwd: string,
	ref: string,
): Promise<string> {
	return gitSha(
		await gitRead(
			cwd,
			["rev-parse", "--verify", `${ref}^{commit}`],
			Deadline.after(GIT_BASE_TIMEOUT_MS),
		),
	);
}

export async function resolveWorktreeProvisionCwd(
	sourceCwd: string,
): Promise<string> {
	const deadline = Deadline.after(GIT_SOURCE_TIMEOUT_MS);
	let gitDir: string;
	let commonDir: string;
	try {
		gitDir = await resolveGitPath(sourceCwd, "--git-dir", deadline);
		commonDir = await resolveGitPath(sourceCwd, "--git-common-dir", deadline);
	} catch (error) {
		throw new Error(
			`Unable to identify the Git checkout for worktree provisioning from ${sourceCwd}: ${errorMessage(error)}`,
		);
	}
	if (gitDir === commonDir) return sourceCwd;

	try {
		const output = await gitRead(
			sourceCwd,
			["worktree", "list", "--porcelain", "-z"],
			deadline,
		);
		const principal = output
			.split("\0")
			.find((record) => record.startsWith("worktree "))
			?.slice("worktree ".length);
		if (!principal) throw new Error("Git returned no principal worktree");
		return principal;
	} catch (error) {
		throw new Error(
			`Unable to determine the principal Git checkout for linked worktree ${sourceCwd}: ${errorMessage(error)}`,
		);
	}
}

async function resolveGitPath(
	cwd: string,
	flag: "--git-dir" | "--git-common-dir",
	deadline: Deadline,
): Promise<string> {
	const output = await gitRead(
		cwd,
		["rev-parse", "--path-format=absolute", flag],
		deadline,
	);
	if (!output || output === "\n")
		throw new Error("Git returned no checkout path");
	return output.endsWith("\n") ? output.slice(0, -1) : output;
}

export function readWorktreeManifest(path: string): JsonObject | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (isRecord(value) && isWorktreeManifest(value)) return value;
	} catch {
		// Unreachable or malformed manifests do not establish ownership.
	}
	return undefined;
}

export function writeWorktreeManifest(path: string, value: JsonObject): void {
	mkdirSync(dirname(path), { recursive: true });
	let existing: JsonObject = {};
	if (existsSync(path)) {
		try {
			existing = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			existing = {};
		}
	}
	const tempPath = `${path}.tmp`;
	writeFileSync(
		tempPath,
		`${JSON.stringify(
			mergeWorktreeManifest(existing, value, Date.now()),
			null,
			2,
		)}\n`,
	);
	renameSync(tempPath, path);
}

async function gitPathList(
	cwd: string,
	args: string[],
	deadline: Deadline,
): Promise<string[]> {
	const output = await gitRead(cwd, args, deadline);
	if (output && !output.endsWith("\0"))
		throw new Error("Git returned an incomplete NUL filename list");
	return output.split("\0").filter(Boolean);
}

export async function captureWorktreeHandoff(
	worktree: WorktreeLaunch,
	timeoutMs = GIT_HANDOFF_TIMEOUT_MS,
): Promise<WorktreeHandoff> {
	const deadline = Deadline.after(timeoutMs);
	try {
		const headSha = gitSha(
			await gitRead(
				worktree.path,
				["rev-parse", "--verify", "HEAD^{commit}"],
				deadline,
			),
		);
		const status = await gitRead(
			worktree.path,
			["status", "--porcelain=v1", "--untracked-files=all", "-z"],
			deadline,
		);
		if (status && !status.endsWith("\0"))
			throw new Error("Git returned incomplete status");
		const untrackedFiles = await gitPathList(
			worktree.path,
			["ls-files", "--others", "--exclude-standard", "-z"],
			deadline,
		);
		const conflictedFiles = await gitPathList(
			worktree.path,
			["diff", "--name-only", "--diff-filter=U", "-z"],
			deadline,
		);
		const changedFiles = new Set([
			...(await gitPathList(
				worktree.path,
				["diff", "--name-only", "-z", `${worktree.baseSha}...HEAD`],
				deadline,
			)),
			...(await gitPathList(
				worktree.path,
				["diff", "--name-only", "-z"],
				deadline,
			)),
			...(await gitPathList(
				worktree.path,
				["diff", "--cached", "--name-only", "-z"],
				deadline,
			)),
			...untrackedFiles,
		]);
		const count = (
			await gitRead(
				worktree.path,
				["rev-list", "--count", `${worktree.baseSha}..HEAD`],
				deadline,
			)
		).trim();
		const commitsAhead = Number(count);
		if (!/^(0|[1-9][0-9]*)$/.test(count) || !Number.isSafeInteger(commitsAhead))
			throw new Error("Git returned an invalid commit count");
		return {
			...worktree,
			headSha,
			commitsAhead,
			clean: status.length === 0,
			conflicted: conflictedFiles.length > 0,
			changedFiles: [...changedFiles].sort(),
			untrackedFiles: untrackedFiles.sort(),
		};
	} catch (error) {
		return {
			...worktree,
			headSha: null,
			commitsAhead: null,
			clean: null,
			conflicted: null,
			changedFiles: null,
			untrackedFiles: null,
			gitError: errorMessage(error),
		};
	}
}

export function persistWorktreeResult(
	worktree: WorktreeLaunch,
	state: WorktreeResultState,
	handoff?: WorktreeHandoff,
): void {
	writeWorktreeManifest(worktree.manifestFile, {
		state,
		...worktree,
		...handoff,
	});
}

function errorMessage(error: any): string {
	return error instanceof Error ? error.message : String(error);
}

const CLEANUP_TIMEOUT_MS = 30_000;

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		env: gitEnvironment(),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: CLEANUP_TIMEOUT_MS,
		killSignal: "SIGKILL",
	});
}
function exists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		// SAFETY: filesystem calls throw Node errors with an optional errno code.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
/**
 * Resolve symbolic links with lstat, stat, and readlink only, matching Node's
 * JavaScript realpathSync, including its lexical `..` handling. Bun's
 * realpathSync opens the path, and open() blocks indefinitely on some
 * protected macOS directories, such as another app's sandbox container,
 * freezing the whole process.
 */
function realpathWithoutOpening(path: string): string {
	const parts = (from: string) => resolve(from).split(sep).filter(Boolean);
	let pending = parts(path);
	let resolved: string = sep;
	let links = 0;
	while (pending.length) {
		const next = join(resolved, pending.shift() ?? "");
		if (!lstatSync(next).isSymbolicLink()) {
			resolved = next;
			continue;
		}
		// Like Node, let the kernel validate the target: missing targets throw
		// ENOENT and real cycles throw ELOOP.
		statSync(next);
		// Backstop only; valid repeated traversals stay far below this.
		if (++links > 4096)
			throw Object.assign(new Error(`Too many symbolic links: ${path}`), {
				code: "ELOOP",
			});
		pending = [...parts(resolve(resolved, readlinkSync(next))), ...pending];
		resolved = sep;
	}
	return resolved;
}
function directories(path: string): string[] {
	if (!exists(path)) return [];
	return readdirSync(path, { withFileTypes: true })
		.filter((item) => item.isDirectory() || item.isSymbolicLink())
		.map((item) => join(path, item.name));
}

/** Source identity is resolved independently of status so Git failures remain visible. */
function resolveSource(path: string): string {
	const common = realpathSync(
		git(path, [
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]).trim(),
	);
	// A submodule's common directory lives under the superproject's
	// .git/modules; only core.worktree, including included config, names its checkout.
	const configured = git(common, [
		`--git-dir=${common}`,
		"config",
		"--default",
		"",
		"--get",
		"core.worktree",
	]).trim();
	const root = realpathSync(
		configured ? resolve(common, configured) : dirname(common),
	);
	if (realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim()) !== root)
		throw new Error("Cannot prove source repository root");
	if (
		realpathSync(
			git(root, [
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
			]).trim(),
		) !== common
	)
		throw new Error("Source Git directory mismatch");
	return root;
}
/** Count NUL-delimited file paths without retaining the ignored-file listing. */
function countIgnoredFiles(cwd: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"git",
			["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
			{
				cwd,
				env: gitEnvironment(),
				stdio: ["ignore", "pipe", "ignore"],
				timeout: CLEANUP_TIMEOUT_MS,
				killSignal: "SIGKILL",
			},
		);
		let count = 0;
		child.stdout.on("data", (chunk: Buffer) => {
			for (const byte of chunk) if (byte === 0) count++;
		});
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (code === 0) resolve(count);
			else
				reject(
					new Error(
						`Ignored-file inspection failed (${signal ?? `exit ${code}`})`,
					),
				);
		});
	});
}

async function inspectGit(
	path: string,
	sourceRepo: string,
): Promise<CleanupGitState> {
	const records = git(sourceRepo, ["worktree", "list", "--porcelain", "-z"])
		.split("\0\0")
		.map((record) => record.split("\0"));
	const record = records.find((fields) => {
		if (!fields[0]?.startsWith("worktree ")) return false;
		const registeredPath = fields[0].slice("worktree ".length);
		return exists(registeredPath) && realpathSync(registeredPath) === path;
	});
	// rev-parse returns HEAD for a detached checkout, without treating a valid
	// detached state as an inspection error. Only named refs may be preserved.
	const headRef = git(path, [
		"rev-parse",
		"--symbolic-full-name",
		"HEAD",
	]).trim();
	const branch = headRef.startsWith("refs/heads/")
		? headRef.slice("refs/heads/".length)
		: "";
	const status = git(path, [
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
		"-z",
	]);
	let dirtyFiles = 0;
	const fields = status.split("\0");
	for (let i = 0; i < fields.length; i++) {
		if (!fields[i]) continue;
		dirtyFiles++;
		if (/^[RC]|^.[RC]/.test(fields[i])) i++;
	}
	return {
		branch,
		headSha: git(path, ["rev-parse", "HEAD"]).trim(),
		registered:
			!!record &&
			path !== sourceRepo &&
			(branch
				? record.includes(`branch refs/heads/${branch}`)
				: record.includes("detached")),
		locked: !!record?.some(
			(field) => field === "locked" || field.startsWith("locked "),
		),
		dirtyFiles,
		untrackedFiles: git(path, [
			"ls-files",
			"--others",
			"--exclude-standard",
			"-z",
		])
			.split("\0")
			.filter(Boolean).length,
		ignoredFiles: await countIgnoredFiles(path),
		conflicts: git(path, ["diff", "--name-only", "--diff-filter=U", "-z"])
			.split("\0")
			.filter(Boolean).length,
		submodules: git(path, ["submodule", "status", "--recursive"])
			.split("\n")
			.some((line) => line.length > 0 && !line.startsWith("-")),
	};
}

/** Individual visibility gaps warn; failed enumeration still blocks cleanup. */
function processHolders(
	path: string,
	idleShellPids = new Set<number>(),
	procRoot = "/proc",
	platform: NodeJS.Platform = process.platform,
): HolderInspection {
	const blockers: string[] = [];
	const unreadable = new Set<string>();
	const shellNames = new Set(["bash", "zsh", "fish", "sh", "dash"]);
	const checkout =
		platform === "linux" || platform === "darwin" ? realpathSync(path) : path;
	if (!process.getuid) throw new Error("Process user identity unavailable");
	const uid = process.getuid();
	if (platform === "linux") {
		// Keep enumeration outside the per-process guard: total failure is a blocker.
		const pids = readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
		if (!pids.length) throw new Error("Process enumeration returned no PIDs");
		for (const pid of pids) {
			try {
				if (lstatSync(`${procRoot}/${pid}`).uid !== uid) continue;
				let command = "";
				try {
					command = readFileSync(`${procRoot}/${pid}/comm`, "utf8").trim();
				} catch {
					// An unreadable name cannot exempt a runtime or hide a readable cwd.
					unreadable.add(pid);
				}
				// A shell can exec a runtime without changing PID/process group.
				if (idleShellPids.has(Number(pid)) && shellNames.has(command)) continue;
				const cwd = realpathSync(`${procRoot}/${pid}/cwd`);
				if (contained(checkout, cwd))
					blockers.push(`Live process ${pid} holds the checkout`);
			} catch (error) {
				// SAFETY: filesystem probes throw Node errors with an optional errno code.
				if (
					["ENOENT", "ESRCH"].includes(
						(error as NodeJS.ErrnoException).code ?? "",
					)
				) {
					try {
						// Confirm disappearance separately from unreadable status.
						realpathSync(`${procRoot}/${pid}`);
						if (
							/^State:\s+[ZX]/m.test(
								readFileSync(`${procRoot}/${pid}/status`, "utf8"),
							)
						) {
							unreadable.delete(pid);
							continue;
						}
					} catch {
						// Missing status alone is not proof of process disappearance.
						try {
							realpathSync(`${procRoot}/${pid}`);
						} catch (presenceError) {
							// SAFETY: these are Node filesystem errors.
							if (
								["ENOENT", "ESRCH"].includes(
									(presenceError as NodeJS.ErrnoException).code ?? "",
								)
							) {
								unreadable.delete(pid);
								continue;
							}
						}
					}
				}
				unreadable.add(pid);
			}
		}
	} else if (platform === "darwin") {
		// A nonzero lsof exit is a global failure, even if partial stdout exists.
		let output: string;
		try {
			output = execFileSync(
				"lsof",
				["-n", "-P", "-a", "-u", String(uid), "-d", "cwd", "-Fpcn"],
				{
					encoding: "utf8",
					timeout: CLEANUP_TIMEOUT_MS,
					killSignal: "SIGKILL",
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
		} catch {
			// Command errors may embed partial process output; never disclose it.
			throw new Error("lsof failed to enumerate processes");
		}
		const records = output.split(/^p/m).slice(1);
		if (!records.length)
			throw new Error("Process enumeration returned no PIDs");
		for (const record of records) {
			const [pid, ...fields] = record.split("\n");
			if (!/^\d+$/.test(pid))
				throw new Error("Invalid process enumeration record");
			const command = fields.find((line) => line.startsWith("c"))?.slice(1);
			if (idleShellPids.has(Number(pid)) && command && shellNames.has(command))
				continue;
			const cwd = fields.find((line) => line.startsWith("n"))?.slice(1);
			if (!command) unreadable.add(pid);
			try {
				if (!cwd || !isAbsolute(cwd))
					throw new Error("Process cwd unavailable");
				// Every same-user cwd is resolved, so this must never open a path.
				if (contained(checkout, realpathWithoutOpening(cwd)))
					blockers.push(`Live process ${pid} holds the checkout`);
			} catch {
				unreadable.add(pid);
			}
		}
	} else {
		throw new Error(`Process inspection unsupported on ${platform}`);
	}
	const warnings = [
		"Incomplete process coverage: same-user inspection is permission-limited; other-user processes are not inspected. A protected process could hold the checkout undetected.",
	];
	if (unreadable.size)
		warnings.push(
			`${unreadable.size} process(es) (PIDs ${[...unreadable].slice(0, 10).join(", ")}${unreadable.size > 10 ? ", …" : ""}) have unreadable details; not proven unrelated to the checkout.`,
		);
	return { blockers, warnings };
}

export const __worktreeCleanupTest__ = {
	processHolders,
	realpathWithoutOpening,
};

export function createWorktreeCleanupOperations(
	provider: SurfaceProvider,
	input: {
		manifestDir: string;
		liveHolders: () => { path: string; persistent?: boolean }[];
		managedRoot?: string;
	},
): WorktreeCleanupOperations {
	const root = input.managedRoot ?? join(homedir(), ".herdr", "worktrees");
	let canonicalRoot: string;
	return {
		managedRoot: () => canonicalRoot ?? realpathSync(root),
		scan: () => {
			if (!exists(root)) return [];
			canonicalRoot = realpathSync(root);
			return directories(canonicalRoot).flatMap(directories);
		},
		realpath: realpathSync,
		resolveSource,
		inspectGit,
		listWorktrees: (source) =>
			provider.listWorktreeSurfaces({
				cwd: source,
				timeoutMs: CLEANUP_TIMEOUT_MS,
			}),
		readManifests: () => {
			if (!exists(input.manifestDir)) return [];
			return readdirSync(input.manifestDir)
				.filter((name) => name.endsWith(".json"))
				.flatMap((name) => {
					const file = join(input.manifestDir, name);
					const value = readWorktreeManifest(file);
					return value ? [{ file, value }] : [];
				});
		},
		holders: async (entry) => {
			const blockers: string[] = input
				.liveHolders()
				.filter((holder) => realpathSync(holder.path) === entry.path)
				.map((holder) =>
					holder.persistent
						? "Persistent-specialist lease holds the worktree"
						: "Live child holds the worktree",
				);
			const idleShellPids = new Set<number>();
			if (entry.workspaceId) {
				const panes = await provider.listSurfaces({
					timeoutMs: CLEANUP_TIMEOUT_MS,
				});
				if (!panes) throw new Error("Herdr pane snapshot unavailable");
				const owned = panes.filter(
					(pane) => pane.workspaceId === entry.workspaceId,
				);
				if (!owned.length)
					throw new Error("Open workspace has no observable panes");
				for (const pane of owned) {
					const info = await provider.getProcessInfo(pane.id, {
						timeoutMs: CLEANUP_TIMEOUT_MS,
					});
					if (!info.shellPid || !info.foregroundProcessGroupId)
						throw new Error(`Process state unknown for pane ${pane.id}`);
					// Exempt only Herdr's observed idle retained shell, never a runtime
					// name or a shell running a foreground command.
					if (info.foregroundProcessGroupId === info.shellPid)
						idleShellPids.add(info.shellPid);
					else
						blockers.push(
							`Live child or foreground process in pane ${pane.id}`,
						);
				}
			}
			try {
				const inspection = processHolders(entry.path, idleShellPids);
				return {
					blockers: [...blockers, ...inspection.blockers],
					warnings: inspection.warnings,
				};
			} catch (error) {
				// Preserve known children and leases even when global inspection fails.
				return {
					blockers: [
						...blockers,
						`Process inspection unavailable: ${message(error)}`,
					],
					warnings: [],
				};
			}
		},
		exists,
		preserve: (entry) => {
			if (
				!entry.branch ||
				git(entry.path, ["symbolic-ref", "--short", "HEAD"]).trim() !==
					entry.branch
			)
				throw new Error("Retained branch changed before preservation");
			const index = git(entry.path, [
				"rev-parse",
				"--path-format=absolute",
				"--git-path",
				"index",
			]).trim();
			const originalIndex = exists(index) ? readFileSync(index) : undefined;
			try {
				git(entry.path, ["add", "-A"]);
				git(entry.path, [
					"commit",
					"-m",
					"WIP: preserve worktree before explicit cleanup",
				]);
			} catch (error) {
				if (originalIndex) writeFileSync(index, originalIndex);
				else if (exists(index)) unlinkSync(index);
				throw error;
			}
			return git(entry.path, ["rev-parse", "HEAD"]).trim();
		},
		removeWorkspace: (id) =>
			provider.removeWorktreeSurface(id, { timeoutMs: CLEANUP_TIMEOUT_MS }),
		reportOpenedPrimaryWorkspace: (sourceRepo, claims) =>
			provider.reportOpenedPrimaryWorkspace({ sourceRepo, claims }),
		removeCheckout: (source, path) => {
			git(source, ["worktree", "remove", "--", path]);
		},
		prune: (source) => {
			git(source, ["worktree", "prune"]);
		},
		writeManifest: (file, value) => {
			if (!readWorktreeManifest(file))
				throw new Error(
					"Manifest ownership became unavailable; checkout removed but manifest unchanged",
				);
			writeWorktreeManifest(file, value);
		},
	};
}

export function createWorktreeOperations(): WorktreeOperations {
	return {
		resolveGitCommit,
		resolveWorktreeProvisionCwd,
		writeWorktreeManifest,
		captureWorktreeHandoff,
		persistWorktreeResult,
	};
}
