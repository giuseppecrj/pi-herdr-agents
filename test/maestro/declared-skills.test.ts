import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	DECLARED_SKILLS_ENV,
	formatDeclaredSkillsEnv,
	parseDeclaredSkills,
	parseDeclaredSkillsEnv,
} from "../../maestro/core/declared-skills.ts";
import {
	createDeclaredSkillsInjector,
	registerDeclaredSkills,
	SKILL_FILE_MAX_BYTES,
	SKILLS_TOTAL_MAX_BYTES,
	type SkillFileSystem,
} from "../../maestro/adapters/pi/child/declared-skills.ts";

function withDir(run: (dir: string) => Promise<void> | void) {
	const dir = mkdtempSync(join(tmpdir(), "declared-skills-"));
	return Promise.resolve(run(dir)).finally(() =>
		rmSync(dir, { recursive: true, force: true }),
	);
}

function writeSkill(root: string, name: string, body: string) {
	const baseDir = join(root, name);
	mkdirSync(baseDir, { recursive: true });
	const filePath = join(baseDir, "SKILL.md");
	writeFileSync(
		filePath,
		`---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`,
	);
	return { name, filePath, baseDir };
}

/** The `before_agent_start` event shape the handler reads. */
function event(skills: { name: string; filePath: string; baseDir: string }[]) {
	return { systemPromptOptions: { skills } };
}

function block(
	skill: { name: string; filePath: string; baseDir: string },
	body: string,
) {
	return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

/** node:fs, counting the bytes read from each path. */
function countingFs() {
	const bytesRead = new Map<string, number>();
	const paths = new Map<number, string>();
	const io: SkillFileSystem = {
		statSync: fs.statSync,
		openSync(path, flags) {
			const fd = fs.openSync(path, flags);
			paths.set(fd, String(path));
			return fd;
		},
		readSync(fd, buffer, offset, length, position) {
			const n = fs.readSync(fd, buffer, offset, length, position);
			const path = paths.get(fd) ?? "?";
			bytesRead.set(path, (bytesRead.get(path) ?? 0) + n);
			return n;
		},
		closeSync: fs.closeSync,
	};
	return { io, bytesRead };
}

describe("declared skill names", () => {
	it("splits, trims and dedupes a declaration, and round-trips it through the env", () => {
		const names = parseDeclaredSkills(" tdd, review-notes ,tdd,, a1 ");
		assert.deepEqual(names, ["tdd", "review-notes", "a1"]);
		assert.equal(formatDeclaredSkillsEnv(names), '["tdd","review-notes","a1"]');
		assert.deepEqual(
			parseDeclaredSkillsEnv(formatDeclaredSkillsEnv(names)),
			names,
		);
		assert.deepEqual(parseDeclaredSkills(undefined), []);
		assert.equal(formatDeclaredSkillsEnv([]), "[]");
	});

	it("refuses a name outside Pi's skill-name rules with an actionable error", () => {
		assert.throws(
			() => parseDeclaredSkills("tdd, ../etc"),
			/Invalid skill name "\.\.\/etc".*lowercase letters, digits and single hyphens/,
		);
		assert.doesNotThrow(() => parseDeclaredSkills("a".repeat(64)));
		assert.throws(
			() => parseDeclaredSkills("a".repeat(65)),
			/Invalid skill name/,
		);
	});

	it("reads an absent, empty or malformed env as no skills", () => {
		for (const raw of [undefined, "", "[]", "tdd", "{}", '"tdd"', "[1]", "["]) {
			assert.deepEqual(parseDeclaredSkillsEnv(raw), [], String(raw));
		}
		assert.deepEqual(parseDeclaredSkillsEnv('["tdd", 3, "../x", "ok"]'), [
			"tdd",
			"ok",
		]);
	});
});

describe("child declared-skill injection", () => {
	it("injects exactly the declared skills Pi loaded, in declared order, in Pi's /skill: block format", () =>
		withDir((dir) => {
			const tdd = writeSkill(
				dir,
				"tdd",
				"# TDD\nWrite the failing test first.",
			);
			const review = writeSkill(dir, "review", "Review body.");
			const other = writeSkill(dir, "other", "Not declared.");
			const inject = createDeclaredSkillsInjector(["review", "tdd"]);
			const result = inject(event([tdd, other, review]));
			assert.ok(result?.message);
			assert.equal(
				result.message.customType,
				"pi-herdr-agents:declared-skills",
			);
			assert.equal(
				result.message.content,
				`${block(review, "Review body.")}\n\n${block(tdd, "# TDD\nWrite the failing test first.")}`,
			);
			assert.doesNotMatch(
				String(result.message.content),
				/Not declared|name: tdd/,
			);
		}));

	it("does not inject a declared skill Pi excluded, and names it in a host note", () =>
		withDir((dir) => {
			const tdd = writeSkill(dir, "tdd", "TDD body.");
			// Pi left "ignored" out (an ignore file, a package filter, no trust):
			// its file exists, but it is absent from Pi's loaded set.
			writeSkill(dir, "ignored", "Must not be injected.");
			const result = createDeclaredSkillsInjector(["tdd", "ignored", "absent"])(
				event([tdd]),
			);
			const content = String(result?.message?.content);
			assert.ok(content.startsWith(block(tdd, "TDD body.")));
			assert.doesNotMatch(
				content,
				/Must not be injected|<skill name="ignored"/,
			);
			assert.match(content, /not loaded by Pi: ignored, absent/);
		}));

	it("reads skill files bounded: an oversize file is skipped after a stat, never read whole", () =>
		withDir((dir) => {
			const small = writeSkill(dir, "small", "Small body.");
			const huge = writeSkill(dir, "huge", "x".repeat(1024 * 1024));
			const { io, bytesRead } = countingFs();
			const result = createDeclaredSkillsInjector(
				["huge", "small"],
				io,
			)(event([huge, small]));
			assert.equal(bytesRead.get(huge.filePath) ?? 0, 0, "1 MiB file not read");
			assert.ok(
				(bytesRead.get(small.filePath) ?? 0) <= SKILL_FILE_MAX_BYTES + 1,
			);
			const content = String(result?.message?.content);
			assert.ok(content.startsWith(block(small, "Small body.")));
			assert.doesNotMatch(content, /xxxx/);
			assert.match(
				content,
				/huge \(\d+ KiB\) is over the 64 KiB per-skill limit/,
			);
		}));

	it("never reads more than the per-skill limit even when a file grows after its stat", () =>
		withDir((dir) => {
			const growing = writeSkill(dir, "growing", "small at stat time");
			const { io, bytesRead } = countingFs();
			const statSync = io.statSync;
			io.statSync = (path: string) => {
				const stats = statSync(path);
				writeFileSync(growing.filePath, "y".repeat(1024 * 1024));
				return stats;
			};
			const result = createDeclaredSkillsInjector(
				["growing"],
				io,
			)(event([growing]));
			assert.ok(
				(bytesRead.get(growing.filePath) ?? 0) <= SKILL_FILE_MAX_BYTES + 1,
			);
			assert.doesNotMatch(String(result?.message?.content), /<skill/);
			assert.match(
				String(result?.message?.content),
				/growing .*per-skill limit/,
			);
		}));

	it("skips skills past the aggregate limit and notes them", () =>
		withDir((dir) => {
			const each = Math.floor(SKILL_FILE_MAX_BYTES * 0.9);
			const names = ["s-1", "s-2", "s-3", "s-4", "s-5"];
			const skills = names.map((name) =>
				writeSkill(dir, name, "z".repeat(each)),
			);
			assert.ok(each * names.length > SKILLS_TOTAL_MAX_BYTES);
			const content = String(
				createDeclaredSkillsInjector(names)(event(skills))?.message?.content,
			);
			assert.ok(Buffer.byteLength(content) <= SKILLS_TOTAL_MAX_BYTES + 1024);
			for (const name of ["s-1", "s-2", "s-3", "s-4"])
				assert.match(content, new RegExp(`<skill name="${name}"`));
			assert.doesNotMatch(content, /<skill name="s-5"/);
			assert.match(content, /s-5 .*256 KiB total limit/);
		}));

	it("fires once: a later run injects nothing", () =>
		withDir((dir) => {
			const tdd = writeSkill(dir, "tdd", "TDD body.");
			const inject = createDeclaredSkillsInjector(["tdd"]);
			assert.ok(inject(event([tdd]))?.message);
			assert.equal(inject(event([tdd])), undefined);
		}));

	it("injects nothing when no skills are declared (a resume sets none)", () =>
		withDir((dir) => {
			const tdd = writeSkill(dir, "tdd", "TDD body.");
			assert.equal(createDeclaredSkillsInjector([])(event([tdd])), undefined);
		}));

	it("consumes the env on the first run, so a reloaded extension injects nothing", () =>
		withDir((dir) => {
			const tdd = writeSkill(dir, "tdd", "TDD body.");
			const env: NodeJS.ProcessEnv = {
				[DECLARED_SKILLS_ENV]: formatDeclaredSkillsEnv(["tdd"]),
			};
			const register = () => {
				const handlers: Function[] = [];
				registerDeclaredSkills(
					{ on: (_name: string, handler: Function) => handlers.push(handler) },
					env,
				);
				return handlers;
			};
			const [first] = register();
			assert.match(
				String(first(event([tdd]))?.message?.content),
				/<skill name="tdd"/,
			);
			assert.equal(env[DECLARED_SKILLS_ENV], undefined);
			const [reloaded] = register();
			assert.equal(reloaded(event([tdd])), undefined);
		}));
});

describe("declared skills through the installed Pi SDK", () => {
	it("reach the model in the first provider request, only for skills Pi loaded, and only once", () =>
		withDir(async (dir) => {
			const cwd = join(dir, "project");
			const agentDir = join(dir, "agent");
			mkdirSync(cwd, { recursive: true });
			const skillsDir = join(agentDir, "skills");
			const tdd = writeSkill(
				skillsDir,
				"tdd",
				"# TDD\nWrite the failing test first.",
			);
			writeSkill(skillsDir, "ignored", "IGNORED BODY");
			// Pi's own discovery honors ignore files; the child must follow Pi.
			writeFileSync(join(skillsDir, ".ignore"), "ignored/\n");
			const env: NodeJS.ProcessEnv = {
				[DECLARED_SKILLS_ENV]: formatDeclaredSkillsEnv(["tdd", "ignored"]),
			};
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory(),
				extensionFactories: [(pi) => registerDeclaredSkills(pi, env)],
			});
			await loader.reload();
			const loaded = loader.getSkills().skills.map((skill) => skill.name);
			assert.ok(loaded.includes("tdd"));
			assert.ok(
				!loaded.includes("ignored"),
				"Pi itself excludes the ignored skill",
			);

			const modelRuntime = await ModelRuntime.create({
				authPath: join(dir, "auth.json"),
				modelsPath: null,
				refreshOnCreate: false,
			});
			const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
			modelRuntime.registerNativeProvider(faux.provider);
			await modelRuntime.setRuntimeApiKey("faux", "test-key");
			const requests: { role: string; text: string }[][] = [];
			const respond = (context: { messages: any[] }) => {
				requests.push(
					context.messages.map((message) => ({
						role: message.role,
						// Content is a string or text parts; a string has no `.text`.
						text: [message.content]
							.flat()
							.map((part: any) => part.text ?? part)
							.join(""),
					})),
				);
				return fauxAssistantMessage("ok");
			};
			faux.setResponses([respond, respond]);
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				modelRuntime,
				model: faux.getModel(),
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(cwd),
				settingsManager: SettingsManager.inMemory(),
			});
			try {
				await session.prompt("Do the task.");
				await session.prompt("A later turn.");
			} finally {
				session.dispose();
			}

			assert.equal(requests.length, 2);
			const [first, second] = requests;
			const user = first.filter((message) => message.role === "user");
			assert.equal(user[0].text, "Do the task.");
			assert.equal(
				user[1].text,
				`${block(tdd, "# TDD\nWrite the failing test first.")}\n\nHost note: declared skills not loaded by Pi: ignored.`,
				"the skill block reaches the first request with the task",
			);
			assert.doesNotMatch(JSON.stringify(first), /IGNORED BODY/);
			const blocks = (messages: { text: string }[]) =>
				messages.filter((message) => message.text.includes('<skill name="tdd"'))
					.length;
			assert.equal(blocks(second), 1, "a later turn adds no second copy");
		}));
});
