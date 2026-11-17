/**
 * Smoke tests for the systemPromptMode feature.
 * Tests: frontmatter parsing, identity routing, CLI flag generation.
 */
import "./clean-host-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	writeFileSync,
	rmSync,
	mkdirSync,
	readFileSync,
	existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// --- Extracted logic under test ---

function parseFrontmatter(content: string) {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return null;
	const frontmatter = match[1];
	const get = (key: string) => {
		const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
		return m ? m[1].trim() : undefined;
	};
	const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
	const spm = get("system-prompt");
	return {
		systemPromptMode:
			spm === "replace" ? "replace" : spm === "append" ? "append" : undefined,
		body: body || undefined,
	};
}

function simulateRouting(
	agentBody: string | undefined,
	systemPromptMode: "append" | "replace" | undefined,
	paramSystemPrompt: string | undefined,
) {
	const identity = agentBody ?? paramSystemPrompt ?? null;
	const identityInSystemPrompt = systemPromptMode && identity;
	const roleBlock =
		identity && !identityInSystemPrompt ? `\n\n${identity}` : "";

	let cliFlag: string | null = null;
	if (identityInSystemPrompt && identity) {
		cliFlag =
			systemPromptMode === "replace"
				? "--system-prompt"
				: "--append-system-prompt";
	}

	return {
		roleBlock,
		cliFlag,
		identityInSystemPrompt: !!identityInSystemPrompt,
	};
}

// --- Fixtures ---

const AGENT_REPLACE = `---
model: anthropic/claude-sonnet-4-20250514
system-prompt: replace
auto-exit: true
---

You are a specialized agent.`;

const AGENT_APPEND = `---
model: anthropic/claude-sonnet-4-20250514
system-prompt: append
---

You are an appended identity.`;

const AGENT_DEFAULT = `---
model: anthropic/claude-sonnet-4-20250514
---

You are a default agent.`;

const AGENT_INVALID = `---
model: anthropic/claude-sonnet-4-20250514
system-prompt: foobar
---

Body here.`;

test("Frontmatter parsing of system-prompt field", () => {
	const r1 = parseFrontmatter(AGENT_REPLACE)!;
	assert.equal(
		r1.systemPromptMode,
		"replace",
		"system-prompt: replace → mode is 'replace'",
	);
	assert.equal(
		r1.body,
		"You are a specialized agent.",
		"body extracted correctly",
	);

	const r2 = parseFrontmatter(AGENT_APPEND)!;
	assert.equal(
		r2.systemPromptMode,
		"append",
		"system-prompt: append → mode is 'append'",
	);

	const r3 = parseFrontmatter(AGENT_DEFAULT)!;
	assert.equal(
		r3.systemPromptMode,
		undefined,
		"no system-prompt field → mode is undefined",
	);

	const r4 = parseFrontmatter(AGENT_INVALID)!;
	assert.equal(
		r4.systemPromptMode,
		undefined,
		"system-prompt: foobar → mode is undefined (ignored)",
	);
});

test("Identity routing (system prompt vs user message)", () => {
	const s1 = simulateRouting("You are X.", "replace", undefined);
	assert.equal(s1.roleBlock, "", "replace mode: roleBlock empty (not in task)");
	assert.equal(
		s1.cliFlag,
		"--system-prompt",
		"replace mode: uses --system-prompt flag",
	);

	const s2 = simulateRouting("You are X.", "append", undefined);
	assert.equal(s2.roleBlock, "", "append mode: roleBlock empty (not in task)");
	assert.equal(
		s2.cliFlag,
		"--append-system-prompt",
		"append mode: uses --append-system-prompt flag",
	);

	const s3 = simulateRouting("You are X.", undefined, undefined);
	assert.equal(
		s3.roleBlock,
		"\n\nYou are X.",
		"no mode: roleBlock contains identity",
	);
	assert.equal(s3.cliFlag, null, "no mode: no CLI flag");

	const s4 = simulateRouting(undefined, undefined, undefined);
	assert.equal(s4.roleBlock, "", "no identity: roleBlock empty");
	assert.equal(s4.cliFlag, null, "no identity: no CLI flag");

	const s5 = simulateRouting(undefined, "replace", undefined);
	assert.equal(s5.roleBlock, "", "mode set but no body: roleBlock empty");
	assert.equal(s5.cliFlag, null, "mode set but no body: no CLI flag");

	const s6 = simulateRouting(undefined, "replace", "Param identity");
	assert.equal(
		s6.cliFlag,
		"--system-prompt",
		"mode + param systemPrompt: uses CLI flag",
	);
	assert.equal(s6.roleBlock, "", "mode + param systemPrompt: roleBlock empty");
});

test("End-to-end with temp agent files", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-test-spm-"));
	const agentsDir = join(tmpDir, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });

	writeFileSync(join(agentsDir, "test-replace.md"), AGENT_REPLACE);
	writeFileSync(join(agentsDir, "test-append.md"), AGENT_APPEND);
	writeFileSync(join(agentsDir, "test-default.md"), AGENT_DEFAULT);

	function loadFromDir(name: string) {
		const p = join(agentsDir, `${name}.md`);
		if (!existsSync(p)) return null;
		return parseFrontmatter(readFileSync(p, "utf8"));
	}

	const t1 = loadFromDir("test-replace")!;
	assert.equal(
		t1.systemPromptMode,
		"replace",
		"file test-replace.md → replace mode",
	);
	assert.equal(
		t1.body,
		"You are a specialized agent.",
		"file test-replace.md → body correct",
	);

	const t2 = loadFromDir("test-append")!;
	assert.equal(
		t2.systemPromptMode,
		"append",
		"file test-append.md → append mode",
	);

	const t3 = loadFromDir("test-default")!;
	assert.equal(
		t3.systemPromptMode,
		undefined,
		"file test-default.md → no mode",
	);

	rmSync(tmpDir, { recursive: true });
});
