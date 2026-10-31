import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { discoverAgentCatalog } from "../../maestro/core/roles/discovery.ts";
import {
	getAgentConfigDir,
	getSubagentsConfigPath,
} from "../../pi-extension/subagents/config-path.ts";

const role =
	"---\ndescription: audit role\nspawning: false\ntools: read\n---\nBody";

for (const source of ["global", "project"] as const) {
	for (const kind of [
		"invalid",
		"directory",
		"dangling",
		"unreadable",
		"crlf",
		"bom",
		"invalid-crlf",
	] as const) {
		test(`${source} ${kind} override preserves unrelated roles and never widens policy`, () => {
			const root = mkdtempSync(join(tmpdir(), "audit-discovery-"));
			try {
				const agentConfigDir = join(root, "global");
				const cwd = join(root, "project");
				const pack = join(root, "pack");
				const global = join(agentConfigDir, "agents");
				const project = join(cwd, ".pi", "agents");
				for (const dir of [pack, global, project])
					mkdirSync(dir, { recursive: true });
				writeFileSync(
					join(pack, "worker.md"),
					"---\ndescription: permissive\n---\nBody",
				);
				if (source === "project")
					writeFileSync(
						join(global, "worker.md"),
						"---\ndescription: permissive\n---\nBody",
					);
				const dir = source === "project" ? project : global;
				writeFileSync(join(dir, "other.md"), role);
				const path = join(dir, "worker.md");
				if (kind === "directory") mkdirSync(path);
				else if (kind === "dangling") symlinkSync(join(root, "missing"), path);
				else if (kind === "unreadable") symlinkSync(path, path);
				else
					writeFileSync(
						path,
						kind === "invalid"
							? "not frontmatter"
							: kind === "bom"
								? `\uFEFF${role}`
								: (kind === "invalid-crlf"
										? role.replace("tools: read", "tools: [read]")
										: role
									).replaceAll("\n", "\r\n"),
					);
				const catalog = discoverAgentCatalog({
					agentConfigDir,
					cwd,
					onRolePackDiscovered: (event) => event.register(pack),
				});
				assert.ok(catalog.agents.some((agent) => agent.name === "other"));
				const worker = catalog.agents.find((agent) => agent.name === "worker");
				if (kind === "crlf" || kind === "bom") {
					assert.equal(worker?.source, source);
					assert.equal(worker?.spawning, false);
					assert.equal(worker?.tools, "read");
					assert.equal(worker?.body, "Body");
					assert.deepEqual(catalog.diagnostics, []);
				} else {
					assert.equal(worker, undefined);
					assert.ok(
						catalog.diagnostics.some(
							(diagnostic) =>
								diagnostic.agentName === "worker" &&
								diagnostic.path === path &&
								diagnostic.code ===
									(kind === "invalid"
										? "invalid-role-definition"
										: kind === "invalid-crlf"
											? "invalid-capability-declaration"
											: "unreadable-role-definition"),
						),
					);
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
}

test("host config paths use Pi's public agent-directory resolver", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		for (const value of [
			undefined,
			"",
			"~",
			"~/custom-agent",
			"relative/agent",
			"/tmp/custom-agent",
		]) {
			if (value === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = value;
			assert.equal(getAgentConfigDir(), getAgentDir(), String(value));
			assert.equal(
				getSubagentsConfigPath(),
				join(getAgentDir(), "herdr-agents", "config.json"),
			);
		}
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});
