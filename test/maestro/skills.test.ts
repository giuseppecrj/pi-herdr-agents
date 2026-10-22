import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	formatSkillBlocks,
	resolveSkillBodies,
} from "../../maestro/adapters/pi/skills.ts";

function writeSkill(root: string, name: string, body: string): void {
	const dir = join(root, ".pi", "skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`,
	);
}

test("resolveSkillBodies loads declared skills through Pi discovery", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skills-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	try {
		writeSkill(root, "alpha", "# Alpha\nDo the alpha thing.");
		writeSkill(root, "beta", "# Beta\nDo the beta thing.");

		const resolved = await resolveSkillBodies(["alpha", "missing", "beta"], {
			cwd: root,
			agentDir,
		});

		assert.deepEqual(
			resolved.map((skill) => skill.name),
			["alpha", "beta"],
		);
		const alpha = resolved[0];
		assert.equal(
			alpha.filePath,
			join(root, ".pi", "skills", "alpha", "SKILL.md"),
		);
		assert.match(alpha.content, /# Alpha/);
		assert.doesNotMatch(alpha.content, /description:/);

		const blocks = formatSkillBlocks(resolved);
		assert.match(blocks, /<skill name="alpha" location="[^"]+SKILL\.md">/);
		assert.match(blocks, /References are relative to /);
		assert.match(blocks, /# Beta/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveSkillBodies returns nothing for an empty declaration", async () => {
	assert.deepEqual(
		await resolveSkillBodies([], { cwd: ".", agentDir: "." }),
		[],
	);
});
