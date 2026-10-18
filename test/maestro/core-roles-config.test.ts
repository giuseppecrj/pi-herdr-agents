import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverAgentCatalog } from "../../maestro/core/roles/discovery.ts";
import { loadRoleConfig } from "../../maestro/core/config/role-config.ts";
import { loadModelConfig } from "../../maestro/core/config/model-config.ts";
import { loadPaneConfig } from "../../maestro/core/config/pane-config.ts";
import { loadPersistentConfig } from "../../maestro/core/config/persistent-config.ts";
import { loadSupervisionConfig } from "../../maestro/core/config/supervision-config.ts";

test("Task17 core discovery consumes the injected role-pack protocol and preserves order, diagnostics, raw defaults and provenance", () => {
	const root = mkdtempSync(join(tmpdir(), "core-role-discovery-"));
	try {
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const pack = join(root, "pack", "roles");
		for (const dir of [
			join(agentDir, "agents"),
			join(cwd, ".pi", "agents"),
			pack,
		])
			mkdirSync(dir, { recursive: true });
		const role = (dir: string, name: string, fields = "") =>
			writeFileSync(
				join(dir, `${name}.md`),
				`---\nname: ${name}\ndescription: ${dir}\n${fields}\n---\n${name} body`,
			);
		role(pack, "alpha");
		role(
			pack,
			"beta",
			"model: task:invalid-raw-default\ntools: read,bash\nskills: skill-a,skill-b\ndeny-tools: write\nspawning: false\nauto-exit: true\nsession-mode: lineage-only\ncwd: role-folder\nthinking: high",
		);
		role(join(agentDir, "agents"), "alpha");
		role(join(cwd, ".pi", "agents"), "alpha", "disable-model-invocation: true");
		role(join(cwd, ".pi", "agents"), "gamma");
		writeFileSync(
			join(root, "pack", "package.json"),
			JSON.stringify({ name: "role-pack", version: "2.3.4" }),
		);
		let projections = 0;
		const catalog = discoverAgentCatalog({
			agentConfigDir: agentDir,
			cwd,
			onRolePackDiscovered(event) {
				projections++;
				assert.equal(event.apiVersion, 1);
				event.register("relative-path");
				event.register(pack);
				event.register(pack);
			},
		});
		assert.equal(projections, 1);
		assert.deepEqual(
			catalog.agents.map((agent) => agent.name),
			["alpha", "beta", "gamma"],
		);
		assert.deepEqual(
			catalog.diagnostics.map((diagnostic) => diagnostic.code),
			["invalid-role-pack-path"],
		);
		assert.equal(catalog.agents[0].source, "project");
		assert.equal(catalog.agents[0].disableModelInvocation, true);
		const beta = catalog.agents[1];
		assert.equal(beta.provider, "role-pack");
		assert.equal(beta.providerVersion, "2.3.4");
		assert.equal(beta.path, join(pack, "beta.md"));
		assert.equal(
			beta.model,
			"task:invalid-raw-default",
			"discovery must not silently validate/drop the raw model",
		);
		assert.deepEqual(beta.role, {
			name: "beta",
			version: "2.3.4",
			description: pack,
			systemPrompt: "beta body",
			allowedTools: ["read", "bash"],
			source: "package",
			defaults: {
				model: "task:invalid-raw-default",
				thinking: "high",
				sessionMode: "lineage-only",
				spawning: false,
				selfSpawn: undefined,
				autoExit: true,
				interactive: undefined,
				persistent: undefined,
				systemPromptMode: undefined,
				denyTools: ["write"],
				skills: ["skill-a", "skill-b"],
				cwd: "role-folder",
			},
		});
		const failed = discoverAgentCatalog({
			agentConfigDir: agentDir,
			cwd,
			onRolePackDiscovered() {
				throw new Error("discovery error");
			},
		});
		assert.equal(failed.diagnostics[0].code, "role-pack-discovery-failed");
		assert.deepEqual(
			failed.agents.map((agent) => agent.name),
			["alpha", "gamma"],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("self-spawn is an opt-in capability declaration parsed as strictly as spawning", () => {
	const root = mkdtempSync(join(tmpdir(), "core-self-spawn-"));
	try {
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const agents = join(cwd, ".pi", "agents");
		mkdirSync(agents, { recursive: true });
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		const role = (name: string, fields: string[]) =>
			writeFileSync(
				join(agents, `${name}.md`),
				`---\nname: ${name}\ndescription: ${name}\n${fields.join("\n")}\n---\n${name} body`,
			);
		role("absent", []);
		role("enabled", ["self-spawn: true"]);
		role("disabled", ["self-spawn: false"]);
		role("enabled-no-spawning", ["self-spawn: true", "spawning: false"]);
		const invalid = [
			["invalid-maybe", ["self-spawn: maybe"]],
			["invalid-empty", ["self-spawn:"]],
			["invalid-capitalized", ["self-spawn: True"]],
			["invalid-quoted-value", ['self-spawn: "true"']],
			["invalid-comment", ["self-spawn: true # opt in"]],
			["invalid-duplicate", ["self-spawn: true", "self-spawn: false"]],
			["invalid-indented", ["  self-spawn: true"]],
			["invalid-quoted-key", ['"self-spawn": true']],
			["invalid-spaced-key", ["self-spawn : true"]],
		] as const;
		for (const [name, fields] of invalid) role(name, [...fields]);

		const catalog = discoverAgentCatalog({ agentConfigDir: agentDir, cwd });
		const defaults = (name: string) =>
			catalog.agents.find((agent) => agent.name === name)?.role.defaults;
		assert.equal(defaults("absent")?.selfSpawn, undefined);
		assert.equal(defaults("enabled")?.selfSpawn, true);
		assert.equal(defaults("disabled")?.selfSpawn, false);
		assert.equal(defaults("enabled-no-spawning")?.selfSpawn, true);
		assert.equal(defaults("enabled-no-spawning")?.spawning, false);

		for (const [name] of invalid) {
			assert.equal(
				catalog.agents.some((agent) => agent.name === name),
				false,
				`${name} must be rejected`,
			);
			const diagnostic = catalog.diagnostics.find(
				(candidate) => candidate.agentName === name,
			);
			assert.equal(diagnostic?.code, "invalid-capability-declaration", name);
			assert.match(diagnostic?.message ?? "", /self-spawn/, name);
		}
		assert.equal(catalog.diagnostics.length, invalid.length);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Task17 all five config owners use only the explicit config directory and example, failing strictly without fallback on invalid durable data", () => {
	const root = mkdtempSync(join(tmpdir(), "core-config-inputs-"));
	try {
		const configDir = join(root, "explicit-durable-dir");
		mkdirSync(configDir);
		const configPath = join(configDir, "config.json");
		const example = join(root, "explicit-example.json");
		writeFileSync(
			example,
			JSON.stringify({
				models: { default: "ignored/example" },
				roles: { bundled: false },
				panes: { mode: "split" },
				persistent: { maxAgents: 9 },
				supervision: { forcePolling: true },
			}),
		);
		writeFileSync(
			join(root, "config.json"),
			JSON.stringify({ models: { default: "decoy/model" } }),
		);
		assert.deepEqual(loadModelConfig(configDir), { agents: {} });
		assert.equal(loadRoleConfig(configDir, example).deprecations.length, 1);
		assert.equal(loadPaneConfig(configDir, example).mode, "split");
		assert.equal(loadPersistentConfig(configDir, example).maxAgents, 9);
		assert.equal(loadSupervisionConfig(configDir, example).forcePolling, true);
		const fallbackReaders = [
			loadRoleConfig,
			loadPaneConfig,
			loadPersistentConfig,
			loadSupervisionConfig,
		];
		for (const read of fallbackReaders)
			assert.throws(
				() => read(configDir, join(root, "absent-example")),
				(error: Error) =>
					error.message.includes(configPath) &&
					error.message.includes("absent-example"),
			);
		writeFileSync(configPath, "{");
		for (const read of [loadModelConfig, ...fallbackReaders])
			assert.throws(
				() => read(configDir, example),
				(error: Error) =>
					error.message.includes(configPath) &&
					error.message.includes("Invalid JSON"),
			);
		writeFileSync(configPath, "[]");
		for (const read of [loadModelConfig, ...fallbackReaders])
			assert.throws(() => read(configDir, example), /root must be an object/);
		writeFileSync(
			configPath,
			JSON.stringify({
				models: { default: "saved/model" },
				roles: { bundled: true },
			}),
		);
		assert.equal(loadModelConfig(configDir).default, "saved/model");
		const [deprecation] = loadRoleConfig(configDir, example).deprecations;
		assert.ok(deprecation.includes(configPath));
		assert.match(deprecation, /roles\.bundled \(true\)/);
		rmSync(configPath);
		mkdirSync(configPath);
		for (const read of [loadModelConfig, ...fallbackReaders])
			assert.throws(() => read(configDir, example), /EISDIR/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
