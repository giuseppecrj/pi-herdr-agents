import { isAbsolute, relative, sep } from "node:path";
import { isString, type JsonObject } from "./config/type-guards.ts";
import {
	forgetOpenedPrimaryWorkspaceClaims,
	openedPrimaryWorkspaceClaims,
	type OpenedPrimaryWorkspaceReport,
	type PrimaryWorkspaceClaim,
} from "./opened-primary-workspace.ts";
import type { WorktreeSurfaceInfo } from "./surface-provider.ts";
import {
	encodeHostValue,
	HOST_ERROR_CHARS,
	HOST_PATH_CHARS,
} from "./host-text.ts";

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
	listWorktrees(
		sourceRepo: string,
	): WorktreeSurfaceInfo[] | Promise<WorktreeSurfaceInfo[]>;
	readManifests(): CleanupManifest[];
	holders(entry: WorktreeInventoryEntry): Promise<HolderInspection>;
	exists(path: string): boolean;
	preserve(entry: WorktreeInventoryEntry): string;
	removeWorkspace(id: string): void | Promise<void>;
	/**
	 * Suggest, never close, a primary workspace this process's worktree
	 * creation appears to have opened. Undefined means the surface cannot report.
	 */
	reportOpenedPrimaryWorkspace(
		sourceRepo: string,
		claims: readonly PrimaryWorkspaceClaim[],
	):
		| OpenedPrimaryWorkspaceReport
		| undefined
		| Promise<OpenedPrimaryWorkspaceReport | undefined>;
	removeCheckout(sourceRepo: string, path: string): void | Promise<void>;
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

// Parent-facing text: paths, Git output, diagnostics, blockers and warnings
// are encoded values. Entries and results keep the raw strings.
const shownPath = (path: string) => encodeHostValue(path, HOST_PATH_CHARS);
const shownList = (items: Iterable<string>) =>
	[...items].map((item) => encodeHostValue(item, HOST_ERROR_CHARS)).join("; ");
function contained(root: string, path: string): boolean {
	const rel = relative(root, path);
	return (
		rel === "" ||
		(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
	);
}

function claimsForSource(
	claims: readonly PrimaryWorkspaceClaim[],
	sourceRepo: string,
	ops: WorktreeCleanupOperations,
): PrimaryWorkspaceClaim[] {
	return claims.filter((claim) => {
		if (claim.checkoutPath === sourceRepo) return true;
		try {
			return ops.realpath(claim.checkoutPath) === sourceRepo;
		} catch {
			return false;
		}
	});
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
		const matches = (await ops.listWorktrees(entry.sourceRepo)).filter(
			(row) => ops.realpath(row.path) === entry.path,
		);
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
					`${row.branch == null ? "unknown branch" : encodeHostValue(row.branch)} — ${shownPath(row.path)}\nSource: ${row.sourceRepo == null ? "unknown" : shownPath(row.sourceRepo)} · workspace: ${encodeHostValue(row.workspaceId ?? "none")} · manifest: ${row.manifest.length ? row.manifest.map(({ value }) => encodeHostValue(isString(value.state) ? value.state : "unknown")).join(", ") : "absent"}\n${row.classification} · Git: ${row.git ? `${row.git.dirtyFiles} dirty, ${row.git.untrackedFiles} untracked, ${row.git.ignoredFiles} ignored, ${row.git.conflicts} conflicts` : "unknown"}${row.blockers.length ? ` · ${shownList(row.blockers)}` : " · clean"}${row.warnings.length ? `\nWarning: ${shownList(row.warnings)}` : ""}`,
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
			(observedWarnings.size ? ` Warning: ${shownList(observedWarnings)}` : ""),
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
								.map(
									(row) => `${shownPath(row.path)}: ${shownList(row.blockers)}`,
								)
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
				message: shownList(entry.blockers) + ignoredNotice(),
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
					message: `Preserved ${encodeHostValue(preservationSha)}, but reinspection blocks removal: ${shownList(entry.blockers) || "identity changed"}${ignoredNotice()}`,
				});
		}
		ignoredFiles = entry.git?.ignoredFiles ?? ignoredFiles;
		if (!entry.sourceRepo) throw new Error("Source repository unknown");
		if (entry.workspaceId) await ops.removeWorkspace(entry.workspaceId);
		else await ops.removeCheckout(entry.sourceRepo, entry.path);
		if (ops.exists(entry.path))
			throw new Error("Removal left the checkout present");
		checkoutRemoved = true;
		if (!entry.workspaceId) ops.prune(entry.sourceRepo);
		const warnings: string[] = [];
		let primaryNote = "";
		const claims = claimsForSource(
			openedPrimaryWorkspaceClaims(),
			entry.sourceRepo,
			ops,
		);
		if (claims.length) {
			try {
				const report = await ops.reportOpenedPrimaryWorkspace(
					entry.sourceRepo,
					claims,
				);
				if (report?.note)
					primaryNote = ` ${encodeHostValue(report.note, HOST_ERROR_CHARS)}`;
				if (report?.releasedClaims.length)
					forgetOpenedPrimaryWorkspaceClaims(report.releasedClaims);
			} catch (error) {
				warnings.push(`Primary workspace report failed: ${message(error)}`);
			}
		}
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
			message: `Removed ${shownPath(entry.path)}. Branch ${encodeHostValue(entry.branch ?? "unknown")} and its commits retained.${preservationSha ? ` Preservation commit: ${encodeHostValue(preservationSha)}.` : ""}${ignoredNotice()}${primaryNote}${warnings.length ? ` Warning: ${shownList(warnings)}` : entry.manifest.length ? " Manifest marked removed." : " No reachable manifest (orphan)."}`,
		});
	} catch (error) {
		return finish({
			status: "failed",
			entry,
			preservationSha,
			message: `Removal failed: ${encodeHostValue(message(error), HOST_ERROR_CHARS)}${preservationSha ? `; preserved commit ${encodeHostValue(preservationSha)}` : ""}${ignoredNotice()}`,
		});
	}
}
