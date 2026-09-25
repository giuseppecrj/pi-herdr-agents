import { execFileSync, spawn } from "node:child_process";
import {
	lstatSync,
	readdirSync,
	realpathSync,
	readFileSync,
	writeFileSync,
	unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
	getHerdrPaneProcessInfo,
	listHerdrPanes,
	listHerdrWorktrees,
	removeHerdrWorktree,
	type HerdrWorktreeInfo,
} from "./herdr.ts";
import { readWorktreeManifest, writeWorktreeManifest } from "./launch.ts";
import { isString, type JsonObject } from "./type-guards.ts";

export interface CleanupGitState {
	branch: string;
	headSha: string;
	registered: boolean;
	locked: boolean;
	dirtyFiles: number;
	untrackedFiles: number;
	ignoredFiles: number;
	conflicts: number;
	submodules: boolean;
}

export interface CleanupManifest {
	file: string;
	value: JsonObject;
}
export interface HolderInspection {
	blockers: string[];
	warnings: string[];
}
export interface WorktreeInventoryEntry {
	path: string;
	sourceRepo?: string;
	branch?: string;
	workspaceId?: string;
	contained: boolean;
	git?: CleanupGitState;
	manifest: CleanupManifest[];
	classification: "eligible" | "blocked" | "unknown" | "out-of-scope";
	blockers: string[];
	warnings: string[];
}

/** All probes and effects are injectable; inventories never perform mutations. */
export interface WorktreeCleanupOperations {
	scan(): string[];
	managedRoot(): string;
	realpath(path: string): string;
	resolveSource(path: string): string;
	inspectGit(
		path: string,
		sourceRepo: string,
	): CleanupGitState | Promise<CleanupGitState>;
	listHerdr(sourceRepo: string): HerdrWorktreeInfo[];
	readManifests(): CleanupManifest[];
	holders(entry: WorktreeInventoryEntry): Promise<HolderInspection>;
	exists(path: string): boolean;
	preserve(entry: WorktreeInventoryEntry): string;
	removeWorkspace(id: string): void;
	removeCheckout(sourceRepo: string, path: string): void;
	prune(sourceRepo: string): void;
	writeManifest(file: string, value: JsonObject): void;
}
export interface CleanupInput {
	cwd: string;
	operations: WorktreeCleanupOperations;
}
export interface WorktreeRemovalResult {
	status: "removed" | "blocked" | "failed" | "already-removed";
	message: string;
	warnings: string[];
	entry?: WorktreeInventoryEntry;
	preservationSha?: string;
}

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

export function cleanupBlockers(entry: WorktreeInventoryEntry): string[] {
	const git = entry.git;
	const blockers: string[] = [];
	if (!entry.contained)
		blockers.push("Source repository is outside cwd containment");
	if (!git) return [...blockers, "Git state is unknown"];
	if (!git.registered)
		blockers.push("Not a registered linked worktree (unknown residue)");
	if (!git.branch) blockers.push("Detached HEAD: no retained branch");
	if (git.locked) blockers.push("Git worktree is locked");
	if (git.conflicts)
		blockers.push(`${git.conflicts} conflicted files; resolve conflicts first`);
	if (git.submodules)
		blockers.push(
			"Initialized submodules: deinitialize them or use operator removal",
		);
	if (git.dirtyFiles || git.untrackedFiles)
		blockers.push(
			`Dirty worktree: ${git.dirtyFiles} changed files, ${git.untrackedFiles} untracked; commit or request preserve explicitly`,
		);
	return blockers;
}

async function inspectEntry(
	path: string,
	cwd: string,
	ops: WorktreeCleanupOperations,
	manifests: CleanupManifest[],
): Promise<WorktreeInventoryEntry> {
	const entry: WorktreeInventoryEntry = {
		path,
		contained: false,
		manifest: [],
		classification: "unknown",
		blockers: [],
		warnings: [],
	};
	try {
		const canonicalPath = ops.realpath(path);
		if (!contained(ops.managedRoot(), canonicalPath))
			throw new Error(
				"Managed checkout is a symlink to an unmanaged location; inspect residue manually",
			);
		entry.path = canonicalPath;
		entry.sourceRepo = ops.realpath(ops.resolveSource(entry.path));
		entry.contained = contained(ops.realpath(cwd), entry.sourceRepo);
		entry.manifest = manifests.filter(({ value }) => {
			if (value.state === "removed" || !isString(value.path)) return false;
			try {
				return (
					ops.exists(value.path) && ops.realpath(value.path) === entry.path
				);
			} catch (error) {
				// SAFETY: filesystem probes throw Node errors with an optional errno code.
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
				// Permission errors and symlink loops leave identity undecidable.
				throw error;
			}
		});
		entry.git = await ops.inspectGit(entry.path, entry.sourceRepo);
		entry.branch = entry.git.branch;
		entry.blockers.push(...cleanupBlockers(entry));
		if (!entry.contained) {
			entry.classification = "out-of-scope";
			return entry;
		}
		const matches = ops
			.listHerdr(entry.sourceRepo)
			.filter((row) => ops.realpath(row.path) === entry.path);
		if (
			matches.length > 1 ||
			matches.some(
				(row) => !row.isLinkedWorktree || row.branch !== entry.branch,
			)
		)
			throw new Error("Git and Herdr worktree identity disagree");
		entry.workspaceId = matches[0]?.workspaceId;
		for (const { value } of entry.manifest) {
			if (
				value.branch !== entry.branch ||
				(isString(value.sourceCwd) &&
					ops.realpath(ops.resolveSource(value.sourceCwd)) !==
						entry.sourceRepo) ||
				(isString(value.workspaceId) &&
					entry.workspaceId &&
					value.workspaceId !== entry.workspaceId)
			)
				throw new Error("Manifest and live worktree identity disagree");
		}
		const holders = await ops.holders(entry);
		entry.blockers.push(...holders.blockers);
		entry.warnings.push(...holders.warnings);
		entry.classification = !entry.git.registered
			? "unknown"
			: entry.blockers.length
				? "blocked"
				: "eligible";
	} catch (error) {
		entry.blockers.push(`Inspection unavailable: ${message(error)}`);
		entry.classification = "unknown";
	}
	return entry;
}

export async function listContainedWorktrees({
	cwd,
	operations: ops,
}: CleanupInput): Promise<WorktreeInventoryEntry[]> {
	const manifests = ops.readManifests();
	const rows: WorktreeInventoryEntry[] = [];
	for (const path of new Set(ops.scan()))
		rows.push(await inspectEntry(path, cwd, ops, manifests));
	return rows;
}

export function formatWorktreeInventory(
	rows: WorktreeInventoryEntry[],
): string {
	return (
		[...rows]
			.sort(
				(a, b) =>
					Number(a.contained) - Number(b.contained) ||
					a.path.localeCompare(b.path),
			)
			.map(
				(row) =>
					`${row.branch ?? "unknown branch"} — ${row.path}\nSource: ${row.sourceRepo ?? "unknown"} · workspace: ${row.workspaceId ?? "none"} · manifest: ${row.manifest.length ? row.manifest.map(({ value }) => value.state ?? "unknown").join(", ") : "absent"}\n${row.classification} · Git: ${row.git ? `${row.git.dirtyFiles} dirty, ${row.git.untrackedFiles} untracked, ${row.git.ignoredFiles} ignored, ${row.git.conflicts} conflicts` : "unknown"}${row.blockers.length ? ` · ${row.blockers.join("; ")}` : " · clean"}${row.warnings.length ? `\nWarning: ${row.warnings.join("; ")}` : ""}`,
			)
			.join("\n\n") || "No managed worktrees found."
	);
}

export async function removeContainedWorktree(
	input: CleanupInput & { target: string; preserve?: boolean },
): Promise<WorktreeRemovalResult> {
	const { operations: ops } = input;
	let entry: WorktreeInventoryEntry | undefined;
	let preservationSha: string | undefined;
	let ignoredFiles = 0;
	let preservationAttempted = false;
	let checkoutRemoved = false;
	const observedWarnings = new Set<string>();
	const finish = (
		result: Omit<WorktreeRemovalResult, "warnings">,
	): WorktreeRemovalResult => ({
		...result,
		warnings: [...observedWarnings],
		message:
			result.message +
			(observedWarnings.size
				? ` Warning: ${[...observedWarnings].join("; ")}`
				: ""),
	});
	const ignoredNotice = () =>
		ignoredFiles
			? checkoutRemoved
				? ` Deleted ${ignoredFiles} ignored files.${preservationAttempted ? " Ignored files are not captured by preservation." : ""}`
				: ` ${ignoredFiles} ignored files${preservationAttempted ? " are not captured by preservation" : " present"}.`
			: "";
	try {
		const rows = await listContainedWorktrees(input);
		const targetPath =
			!rows.some((row) => row.path === input.target) &&
			isAbsolute(input.target) &&
			ops.exists(input.target)
				? ops.realpath(input.target)
				: input.target;
		const matches = rows.filter(
			(row) =>
				row.path === input.target ||
				row.path === targetPath ||
				row.branch === input.target ||
				row.workspaceId === input.target,
		);
		for (const row of matches.length ? matches : rows)
			for (const warning of row.warnings) observedWarnings.add(warning);
		if (matches.length !== 1) {
			const removed = ops
				.readManifests()
				.filter(
					({ value }) =>
						value.state === "removed" &&
						(value.path === input.target ||
							value.branch === input.target ||
							value.workspaceId === input.target),
				);
			if (
				!matches.length &&
				removed.length === 1 &&
				isString(removed[0].value.path) &&
				!ops.exists(removed[0].value.path)
			)
				return finish({
					status: "already-removed",
					message: "Worktree already removed; branch retained.",
				});
			return finish({
				status: "blocked",
				message: matches.length
					? "Ambiguous target; use the exact worktree path."
					: rows.some((row) => row.classification === "unknown")
						? `Target could not be resolved because inventory inspection failed: ${rows
								.filter((row) => row.classification === "unknown")
								.map((row) => `${row.path}: ${row.blockers.join("; ")}`)
								.join("; ")}`
						: "Target not found in managed inventory; nothing removed.",
			});
		}
		// Never trust an inventory cached by the caller, or even the discovery pass.
		entry = await inspectEntry(
			matches[0].path,
			input.cwd,
			ops,
			ops.readManifests(),
		);
		for (const warning of entry.warnings) observedWarnings.add(warning);
		ignoredFiles = entry.git?.ignoredFiles ?? 0;
		const hardBlockers = entry.blockers.filter(
			(blocker) => !blocker.startsWith("Dirty worktree:"),
		);
		if (
			entry.classification === "unknown" ||
			hardBlockers.length ||
			(entry.blockers.length && !input.preserve)
		)
			return finish({
				status: "blocked",
				entry,
				message: entry.blockers.join("; ") + ignoredNotice(),
			});
		if (entry.git && (entry.git.dirtyFiles || entry.git.untrackedFiles)) {
			preservationAttempted = true;
			preservationSha = ops.preserve(entry);
			const before = entry;
			entry = await inspectEntry(
				entry.path,
				input.cwd,
				ops,
				ops.readManifests(),
			);
			for (const warning of entry.warnings) observedWarnings.add(warning);
			if (
				entry.classification !== "eligible" ||
				entry.sourceRepo !== before.sourceRepo ||
				entry.branch !== before.branch ||
				entry.workspaceId !== before.workspaceId ||
				entry.git?.headSha !== preservationSha
			)
				return finish({
					status: "blocked",
					entry,
					preservationSha,
					message: `Preserved ${preservationSha}, but reinspection blocks removal: ${entry.blockers.join("; ") || "identity changed"}${ignoredNotice()}`,
				});
		}
		ignoredFiles = entry.git?.ignoredFiles ?? ignoredFiles;
		if (!entry.sourceRepo) throw new Error("Source repository unknown");
		if (entry.workspaceId) ops.removeWorkspace(entry.workspaceId);
		else ops.removeCheckout(entry.sourceRepo, entry.path);
		if (ops.exists(entry.path))
			throw new Error("Removal left the checkout present");
		checkoutRemoved = true;
		if (!entry.workspaceId) ops.prune(entry.sourceRepo);
		const warnings: string[] = [];
		for (const manifest of entry.manifest) {
			try {
				ops.writeManifest(manifest.file, {
					state: "removed",
					workspaceRemovedAt: Date.now(),
				});
			} catch (error) {
				warnings.push(
					`Manifest ${manifest.file} update failed: ${message(error)}`,
				);
			}
		}
		return finish({
			status: "removed",
			entry,
			preservationSha,
			message: `Removed ${entry.path}. Branch ${entry.branch} and its commits retained.${preservationSha ? ` Preservation commit: ${preservationSha}.` : ""}${ignoredNotice()}${warnings.length ? ` Warning: ${warnings.join("; ")}` : entry.manifest.length ? " Manifest marked removed." : " No reachable manifest (orphan)."}`,
		});
	} catch (error) {
		return finish({
			status: "failed",
			entry,
			preservationSha,
			message: `Removal failed: ${message(error)}${preservationSha ? `; preserved commit ${preservationSha}` : ""}${ignoredNotice()}`,
		});
	}
}

const CLEANUP_TIMEOUT_MS = 30_000;

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
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
	const root = realpathSync(dirname(common));
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
				if (contained(checkout, realpathSync(cwd)))
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

export const __worktreeCleanupTest__ = { processHolders };

export function createWorktreeCleanupOperations(input: {
	manifestDir: string;
	liveHolders: () => { path: string; persistent?: boolean }[];
	managedRoot?: string;
}): WorktreeCleanupOperations {
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
		listHerdr: (source) => listHerdrWorktrees(source, CLEANUP_TIMEOUT_MS),
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
				const panes = await listHerdrPanes(CLEANUP_TIMEOUT_MS);
				if (!panes) throw new Error("Herdr pane snapshot unavailable");
				const owned = panes.filter(
					(pane) => pane.workspaceId === entry.workspaceId,
				);
				if (!owned.length)
					throw new Error("Open workspace has no observable panes");
				for (const pane of owned) {
					const info = getHerdrPaneProcessInfo(pane.paneId, CLEANUP_TIMEOUT_MS);
					if (!info.shellPid || !info.foregroundProcessGroupId)
						throw new Error(`Process state unknown for pane ${pane.paneId}`);
					// Exempt only Herdr's observed idle retained shell, never a runtime
					// name or a shell running a foreground command.
					if (info.foregroundProcessGroupId === info.shellPid)
						idleShellPids.add(info.shellPid);
					else
						blockers.push(
							`Live child or foreground process in pane ${pane.paneId}`,
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
		removeWorkspace: (id) => removeHerdrWorktree(id, CLEANUP_TIMEOUT_MS),
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
