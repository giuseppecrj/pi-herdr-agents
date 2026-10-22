import { readFileSync } from "node:fs";

/** One declared skill resolved to the instruction body delivered with a task. */
export interface ResolvedSkill {
	name: string;
	filePath: string;
	baseDir: string;
	content: string;
}

/** Resolve declared skill names to their instruction bodies. */
export type SkillResolver = (
	names: string[],
	options: { cwd: string; agentDir: string },
) => Promise<ResolvedSkill[]>;

/**
 * Resolve declared skill names through Pi's own resource discovery.
 *
 * A standalone child cannot receive its skills through `/skill:name`: Pi binds
 * `@file` to the first prompt and expands one slash command per message, so the
 * declared skills land in a later turn or not at all. Reading the bodies here
 * and inlining them keeps every declared skill in the child's first request.
 *
 * Resolution requires the child's own `cwd` and effective agent directory, so
 * worktree children see the checkout's skills.
 */
export async function resolveSkillBodies(
	names: string[],
	options: { cwd: string; agentDir: string },
): Promise<ResolvedSkill[]> {
	if (names.length === 0) return [];
	const { DefaultResourceLoader } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
	});
	await loader.reload();
	const byName = new Map(
		loader.getSkills().skills.map((skill) => [skill.name, skill]),
	);
	const resolved: ResolvedSkill[] = [];
	for (const name of names) {
		const skill = byName.get(name);
		if (!skill) continue;
		resolved.push({
			name,
			filePath: skill.filePath,
			baseDir: skill.baseDir,
			content: stripFrontmatter(readFileSync(skill.filePath, "utf8")),
		});
	}
	return resolved;
}

/** Format resolved skills as the `<skill>` blocks Pi injects for `/skill:name`. */
export function formatSkillBlocks(skills: ResolvedSkill[]): string {
	return skills
		.map(
			(skill) =>
				`<skill name="${skill.name}" location="${skill.filePath}">\n` +
				`References are relative to ${skill.baseDir}.\n\n` +
				`${skill.content}\n</skill>`,
		)
		.join("\n\n");
}

/** Drop a leading YAML frontmatter block, matching Pi's skill expansion. */
function stripFrontmatter(markdown: string): string {
	if (!markdown.startsWith("---")) return markdown.trim();
	const end = markdown.indexOf("\n---", 3);
	if (end === -1) return markdown.trim();
	return markdown.slice(end + 4).trim();
}
