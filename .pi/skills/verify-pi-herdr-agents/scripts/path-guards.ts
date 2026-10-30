/**
 * Path guards for the verification lab (lab.ts). Pure functions over an
 * injectable filesystem view, so test/verify-lab-guards.test.ts can feed them
 * symlinks, traversal and foreign owners without touching the real disk.
 * No side effects on import.
 */
import { lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** The slice of `fs.Stats` the guards read. */
export interface GuardStat {
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
	uid: number;
	mode: number;
}

/** What the guards need from the machine; tests inject fakes. */
export interface GuardHost {
	lstat(path: string): GuardStat;
	realpath(path: string): string;
	/** uid of the current user. */
	uid: number;
	/** The temp parent a lab root must sit directly below (not yet canonical). */
	tmpdir: string;
}

export const realHost: GuardHost = {
	lstat: (path) => lstatSync(path),
	realpath: (path) => realpathSync(path),
	uid: process.getuid?.() ?? -1,
	tmpdir: tmpdir(),
};

/** Directory-name prefix `createLabRoot` uses (test/integration/herdr-lab.ts). */
export const LAB_ROOT_PREFIX = "piha-herdr-lab-";
/** `mkdtemp` appends six characters from [A-Za-z0-9]. */
const LAB_ROOT_NAME = /^piha-herdr-lab-[A-Za-z0-9]{6}$/;
/** `<yyyymmdd>-<hhmmss>-<random>` as `lab.ts up` names run directories. */
const RUN_ID = /^\d{8}-\d{6}-[a-z0-9]{1,8}$/;
/** Ids typed into prompts and marker paths: shell-, path- and provider-safe. */
const MARKER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** Default state/evidence location: `$XDG_STATE_HOME/pi-herdr-agents/verify`. */
export function defaultEvidenceRoot(env: NodeJS.ProcessEnv = process.env): string {
	const xdg = env.XDG_STATE_HOME;
	const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local/state");
	return join(base, "pi-herdr-agents/verify");
}

/**
 * Throws unless `dir` is a real directory (not a symlink), owned by the
 * current user and not group- or world-writable.
 */
export function assertPrivateDir(dir: string, host: GuardHost = realHost): void {
	let st: GuardStat;
	try {
		st = host.lstat(dir);
	} catch (error) {
		throw new Error(`state directory ${dir} is not accessible: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (st.isSymbolicLink()) throw new Error(`refusing ${dir}: it is a symlink, not a real directory`);
	if (!st.isDirectory()) throw new Error(`refusing ${dir}: not a directory`);
	if (st.uid !== host.uid) throw new Error(`refusing ${dir}: owned by uid ${st.uid}, not by you (uid ${host.uid})`);
	if ((st.mode & 0o022) !== 0)
		throw new Error(`refusing ${dir}: mode ${(st.mode & 0o777).toString(8)} is group/world-writable; chmod 700 it or choose another VERIFY_EVIDENCE_ROOT`);
}

/** Throws unless `id` is a strict marker/prompt id. Returns it. */
export function assertMarkerId(id: string): string {
	if (!MARKER_ID.test(id)) throw new Error(`invalid id ${JSON.stringify(id)}: use 1-32 of A-Z a-z 0-9 _ - and start with a letter or digit`);
	return id;
}

/** Throws unless `runDir` is a run directory name directly inside `evidenceRoot`. Returns it. */
export function assertRunDir(runDir: string, evidenceRoot: string, host: GuardHost = realHost): string {
	if (!isAbsolute(runDir) || resolve(runDir) !== runDir) throw new Error(`run dir ${runDir} is not a normalized absolute path`);
	if (!RUN_ID.test(basename(runDir))) throw new Error(`run dir ${runDir} does not have a lab run name`);
	if (host.realpath(dirname(runDir)) !== host.realpath(evidenceRoot)) throw new Error(`run dir ${runDir} is not directly inside ${evidenceRoot}`);
	assertPrivateDir(runDir, host);
	return runDir;
}

/**
 * Shape-only check on a lab root (no filesystem access beyond resolving the
 * temp parent): normalized absolute path, exactly one level below the temp
 * parent, with a `piha-herdr-lab-XXXXXX` name. `..` segments and string-prefix
 * tricks fail here.
 */
export function assertLabRootShape(root: string, host: GuardHost = realHost): void {
	if (!isAbsolute(root) || resolve(root) !== root) throw new Error(`lab root ${root} is not a normalized absolute path`);
	if (!LAB_ROOT_NAME.test(basename(root))) throw new Error(`lab root ${root} does not have a lab name (${LAB_ROOT_PREFIX}XXXXXX)`);
	let parent: string;
	try {
		parent = host.realpath(dirname(root));
	} catch (error) {
		throw new Error(`lab root ${root}: parent is not resolvable: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (parent !== host.realpath(host.tmpdir)) throw new Error(`lab root ${root} is not directly below ${host.tmpdir}`);
}

/**
 * Throws unless `root` may be removed recursively: it is the root recorded in
 * our own state, has the lab shape, is a real directory (lstat, not a symlink)
 * owned by the current user. Returns the path to remove.
 */
export function assertRemovableLabRoot(root: string, recordedRoot: string, host: GuardHost = realHost): string {
	if (root !== recordedRoot) throw new Error(`refusing to remove ${root}: it is not the root recorded in the lab state`);
	assertLabRootShape(root, host);
	let st: GuardStat;
	try {
		st = host.lstat(root);
	} catch (error) {
		throw new Error(`lab root ${root} is not accessible: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`refusing to remove ${root}: not a real directory`);
	if (st.uid !== host.uid) throw new Error(`refusing to remove ${root}: owned by uid ${st.uid}, not by you`);
	return join(host.realpath(dirname(root)), basename(root));
}

/** Lab-owned paths in a state file must stay inside the lab root. */
export function assertInside(parent: string, child: string, what: string): void {
	const rel = relative(parent, child);
	if (!isAbsolute(child) || rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${what} ${child} is outside ${parent}`);
}
