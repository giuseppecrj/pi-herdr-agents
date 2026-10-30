/**
 * Declared skills, resolved by the child's own Pi.
 *
 * The parent exports only the role's declared skill names
 * ({@link DECLARED_SKILLS_ENV}). Pi in this child has already discovered,
 * trust-checked, ignore-filtered and package-filtered its skills; the first
 * `before_agent_start` of a fresh launch looks each declared name up there,
 * by exact name, and returns one message carrying the `<skill>` blocks Pi
 * itself writes for `/skill:name`. Pi adds that message to the run's first
 * provider request, beside the task. A name Pi did not load is noted, never
 * searched for elsewhere.
 */
import * as nodeFs from "node:fs";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	DECLARED_SKILLS_ENV,
	parseDeclaredSkillsEnv,
} from "../../../core/declared-skills.ts";

/** Largest SKILL.md injected. */
export const SKILL_FILE_MAX_BYTES = 64 * 1024;
/** Largest combined size of all skill files read, and of all injected blocks. */
export const SKILLS_TOTAL_MAX_BYTES = 256 * 1024;

const MESSAGE_TYPE = "pi-herdr-agents:declared-skills";

/** The fields of Pi's loaded `Skill` this module reads. */
interface LoadedSkill {
	name: string;
	filePath: string;
	baseDir: string;
}

interface BeforeAgentStart {
	systemPromptOptions: { skills?: readonly LoadedSkill[] };
}

/** The node:fs calls used for bounded reads; injectable for tests. */
export interface SkillFileSystem {
	statSync(path: string): { isFile(): boolean; size: number };
	openSync(path: string, flags: "r"): number;
	readSync(
		fd: number,
		buffer: Buffer,
		offset: number,
		length: number,
		position: number,
	): number;
	closeSync(fd: number): void;
}

const kib = (bytes: number) => `${Math.ceil(bytes / 1024)} KiB`;

type SkillRead =
	| { text: string; bytesRead: number }
	| { skipped: string; bytesRead: number };

const overTotal = (bytesRead: number): SkillRead => ({
	skipped: `would pass the ${kib(SKILLS_TOTAL_MAX_BYTES)} total limit`,
	bytesRead,
});

/**
 * The file's text, or why it was skipped. Stats first and never reads more
 * than the smaller of the per-skill limit and the remaining total budget, plus
 * one byte, even if the file grows.
 */
function readSkillFile(
	filePath: string,
	fs: SkillFileSystem,
	budget: number,
): SkillRead {
	const stats = fs.statSync(filePath);
	if (!stats.isFile())
		return { skipped: "is not a regular file", bytesRead: 0 };
	const overLimit = (bytes: number, bytesRead: number): SkillRead => ({
		skipped: `(${kib(bytes)}) is over the ${kib(SKILL_FILE_MAX_BYTES)} per-skill limit`,
		bytesRead,
	});
	if (stats.size > SKILL_FILE_MAX_BYTES) return overLimit(stats.size, 0);
	if (stats.size > budget) return overTotal(0);
	const cap = Math.min(SKILL_FILE_MAX_BYTES, budget);
	const buffer = Buffer.alloc(cap + 1);
	const fd = fs.openSync(filePath, "r");
	let length = 0;
	try {
		for (;;) {
			const n = fs.readSync(fd, buffer, length, buffer.length - length, length);
			if (n === 0 || (length += n) === buffer.length) break;
		}
	} finally {
		fs.closeSync(fd);
	}
	if (length > cap)
		return cap === SKILL_FILE_MAX_BYTES
			? overLimit(length, length)
			: overTotal(length);
	return { text: buffer.toString("utf8", 0, length), bytesRead: length };
}

/**
 * A `before_agent_start` handler that injects the declared skills once, on
 * its first call, and nothing afterwards.
 */
export function createDeclaredSkillsInjector(
	names: readonly string[],
	fs: SkillFileSystem = nodeFs,
) {
	let fired = false;
	return (event: BeforeAgentStart) => {
		if (fired) return undefined;
		fired = true;
		if (names.length === 0) return undefined;
		const loaded = event.systemPromptOptions.skills ?? [];
		const blocks: string[] = [];
		const notLoaded: string[] = [];
		const skipped: string[] = [];
		let total = 0;
		let readBudget = SKILLS_TOTAL_MAX_BYTES;
		for (const name of names) {
			const skill = loaded.find((candidate) => candidate.name === name);
			if (!skill) {
				notLoaded.push(name);
				continue;
			}
			let read: SkillRead;
			try {
				read = readSkillFile(skill.filePath, fs, readBudget);
			} catch (error) {
				read = {
					skipped: `could not be read (${error instanceof Error ? error.message : String(error)})`,
					bytesRead: 0,
				};
			}
			readBudget -= read.bytesRead;
			if ("skipped" in read) {
				skipped.push(`${name} ${read.skipped}`);
				continue;
			}
			// The block Pi writes when it expands `/skill:name`.
			const block =
				`<skill name="${skill.name}" location="${skill.filePath}">\n` +
				`References are relative to ${skill.baseDir}.\n\n` +
				`${stripFrontmatter(read.text).trim()}\n</skill>`;
			const bytes = Buffer.byteLength(block);
			if (total + bytes > SKILLS_TOTAL_MAX_BYTES) {
				skipped.push(
					`${name} would pass the ${kib(SKILLS_TOTAL_MAX_BYTES)} total limit`,
				);
				continue;
			}
			total += bytes;
			blocks.push(block);
		}
		const notes = [
			notLoaded.length > 0
				? `declared skills not loaded by Pi: ${notLoaded.join(", ")}.`
				: "",
			skipped.length > 0
				? `declared skills skipped: ${skipped.join("; ")}.`
				: "",
		].filter(Boolean);
		const content = [
			...blocks,
			...(notes.length > 0 ? [`Host note: ${notes.join(" ")}`] : []),
		].join("\n\n");
		return {
			message: {
				customType: MESSAGE_TYPE,
				content,
				display: false,
				details: { injected: blocks.length, notLoaded, skipped },
			},
		};
	};
}

/**
 * Inject the skills named in {@link DECLARED_SKILLS_ENV} on this process's
 * first run. The first run consumes the variable, so a reloaded extension or
 * a process this child starts never injects them again.
 */
export function registerDeclaredSkills(
	pi: {
		on(
			event: "before_agent_start",
			handler: (
				event: BeforeAgentStart,
			) => ReturnType<ReturnType<typeof createDeclaredSkillsInjector>>,
		): void;
	},
	env: NodeJS.ProcessEnv = process.env,
): void {
	const inject = createDeclaredSkillsInjector(
		parseDeclaredSkillsEnv(env[DECLARED_SKILLS_ENV]),
	);
	pi.on("before_agent_start", (event) => {
		delete env[DECLARED_SKILLS_ENV];
		return inject(event);
	});
}
