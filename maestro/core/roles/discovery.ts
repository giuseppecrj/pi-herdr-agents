import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { isString } from "../config/type-guards.ts";
import { isThinkingLevel, type ThinkingLevel } from "../routing.ts";
import type { Role } from "../types.ts";

export type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface AgentDefaults {
	model?: string;
	tools?: string;
	skills?: string;
	thinking?: ThinkingLevel;
	denyTools?: string;
	spawning?: boolean;
	selfSpawn?: boolean;
	persistent?: boolean;
	autoExit?: boolean;
	interactive?: boolean;
	systemPromptMode?: "append" | "replace";
	sessionMode?: SubagentSessionMode;
	cwd?: string;
	body?: string;
	disableModelInvocation?: boolean;
}

type AgentSource = "package" | "global" | "project";

interface AgentDefinition extends AgentDefaults {
	name: string;
	description?: string;
	disableModelInvocation: boolean;
}

export interface ListedAgentDefinition extends AgentDefinition {
	/** Runtime role plus the unchanged raw listing/validation metadata above. */
	role: Role;
	source: AgentSource;
	path: string;
	provider?: string;
	providerVersion?: string;
}

export interface AgentDiagnostic {
	code: string;
	message: string;
	path?: string;
	agentName?: string;
	provider?: string;
}

export interface AgentCatalog {
	agents: ListedAgentDefinition[];
	diagnostics: AgentDiagnostic[];
}

export const ROLE_PACK_DISCOVERY_EVENT = "pi-herdr-subagents:roles:discover:v1";

export interface RolePackDiscoveryEvent {
	apiVersion: 1;
	register(path: string): void;
}

export interface RoleDiscoveryOptions {
	agentConfigDir: string;
	cwd: string;
	onRolePackDiscovered?(event: RolePackDiscoveryEvent): void;
}

function runtimeRole(
	definition: AgentDefinition,
	source: AgentSource,
	providerVersion?: string,
): Role {
	return {
		name: definition.name,
		version: providerVersion ?? "1",
		description: definition.description ?? "",
		systemPrompt: definition.body ?? "",
		allowedTools:
			definition.tools
				?.split(",")
				.map((tool) => tool.trim())
				.filter(Boolean) ?? [],
		defaults: {
			model: definition.model,
			thinking: definition.thinking,
			sessionMode: definition.sessionMode,
			spawning: definition.spawning,
			selfSpawn: definition.selfSpawn,
			autoExit: definition.autoExit,
			interactive: definition.interactive,
			persistent: definition.persistent,
			systemPromptMode: definition.systemPromptMode,
			denyTools: definition.denyTools
				?.split(",")
				.map((tool) => tool.trim())
				.filter(Boolean),
			skills: definition.skills
				?.split(",")
				.map((skill) => skill.trim())
				.filter(Boolean),
			cwd: definition.cwd,
		},
		source,
	};
}

function getFrontmatterLines(frontmatter: string, key: string): string[] {
	const prefix = `${key}:`;
	return frontmatter
		.split("\n")
		.filter((candidate) => candidate.startsWith(prefix));
}

function getFrontmatterValue(
	frontmatter: string,
	key: string,
): string | undefined {
	const line = getFrontmatterLines(frontmatter, key)[0];
	return line?.slice(`${key}:`.length).trim() || undefined;
}

type CapabilityField =
	| "tools"
	| "deny-tools"
	| "spawning"
	| "self-spawn"
	| "persistent";

interface CapabilityDeclarations {
	canonical: string[];
	hasNoncanonical: boolean;
}

function isCapabilityDeclaration(
	line: string,
	field: CapabilityField,
): boolean {
	const trimmed = line.trimStart();
	const colon = trimmed.indexOf(":");
	if (colon === -1) return false;
	const key = trimmed.slice(0, colon).trim();
	return key === field || key === `"${field}"` || key === `'${field}'`;
}

function getCapabilityDeclarations(
	frontmatter: string,
	field: CapabilityField,
): CapabilityDeclarations {
	const canonicalPrefix = `${field}:`;
	const lines = frontmatter.split("\n");
	return {
		canonical: lines.filter((line) => line.startsWith(canonicalPrefix)),
		hasNoncanonical: lines.some(
			(line) =>
				isCapabilityDeclaration(line, field) &&
				!line.startsWith(canonicalPrefix),
		),
	};
}

function validateCapabilityDeclarations(
	frontmatter: string,
): string | undefined {
	for (const field of [
		"tools",
		"deny-tools",
		"spawning",
		"self-spawn",
		"persistent",
	] as const) {
		const declarations = getCapabilityDeclarations(frontmatter, field);
		if (declarations.hasNoncanonical) {
			return `${field} must use an unquoted, unindented key written exactly as ${field}:`;
		}
		if (declarations.canonical.length > 1) {
			return `${field} may be declared only once.`;
		}
		if (declarations.canonical.length === 0) continue;

		const value = declarations.canonical[0].slice(`${field}:`.length).trim();
		if (
			field === "spawning" ||
			field === "self-spawn" ||
			field === "persistent"
		) {
			if (value !== "true" && value !== "false") {
				return `${field} must be true or false.`;
			}
			continue;
		}

		if (
			!value ||
			value.startsWith("[") ||
			value.startsWith("{") ||
			value.startsWith("|") ||
			value.startsWith(">") ||
			value.includes("#") ||
			value.includes('"') ||
			value.includes("'") ||
			value.split(",").some((entry) => !entry.trim())
		) {
			return `${field} must use a non-empty comma-separated scalar; YAML lists and containers, comments and quotes are unsupported.`;
		}
	}
	return undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
	return value == null ? undefined : value === "true";
}

function parseSessionMode(
	value: string | undefined,
): SubagentSessionMode | undefined {
	if (value === "standalone" || value === "lineage-only" || value === "fork") {
		return value;
	}
	return undefined;
}

function parseAgentDefinition(
	content: string,
	fallbackName: string,
): AgentDefinition | null {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return null;

	const frontmatter = match[1];
	const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
	const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");
	const thinking = getFrontmatterValue(frontmatter, "thinking");

	return {
		name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
		description: getFrontmatterValue(frontmatter, "description"),
		model: getFrontmatterValue(frontmatter, "model"),
		tools: getFrontmatterValue(frontmatter, "tools"),
		systemPromptMode:
			systemPromptMode === "replace"
				? "replace"
				: systemPromptMode === "append"
					? "append"
					: undefined,
		skills:
			getFrontmatterValue(frontmatter, "skills") ??
			getFrontmatterValue(frontmatter, "skill"),
		thinking: thinking && isThinkingLevel(thinking) ? thinking : undefined,
		denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
		spawning: parseOptionalBoolean(
			getFrontmatterValue(frontmatter, "spawning"),
		),
		selfSpawn: parseOptionalBoolean(
			getFrontmatterValue(frontmatter, "self-spawn"),
		),
		persistent: parseOptionalBoolean(
			getFrontmatterValue(frontmatter, "persistent"),
		),
		autoExit: parseOptionalBoolean(
			getFrontmatterValue(frontmatter, "auto-exit"),
		),
		interactive: parseOptionalBoolean(
			getFrontmatterValue(frontmatter, "interactive"),
		),
		sessionMode: parseSessionMode(
			getFrontmatterValue(frontmatter, "session-mode"),
		),
		cwd: getFrontmatterValue(frontmatter, "cwd"),
		body: body || undefined,
		disableModelInvocation:
			getFrontmatterValue(
				frontmatter,
				"disable-model-invocation",
			)?.toLowerCase() === "true",
	};
}

function invalidCapabilityDeclarationDiagnostic(
	content: string,
	agentName: string,
	path: string,
): AgentDiagnostic | null {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return null;
	const resolvedAgentName = getFrontmatterValue(match[1], "name") ?? agentName;
	const error = validateCapabilityDeclarations(match[1]);
	if (!error) return null;
	return {
		code: "invalid-capability-declaration",
		message: `Role "${resolvedAgentName}" has an invalid capability declaration in ${path}: ${error} Use documented comma-separated tools or deny-tools values, true or false for spawning or self-spawn, or omit the field.`,
		path,
		agentName: resolvedAgentName,
	};
}

function legacyExternalCliDiagnostic(
	content: string,
	agentName: string,
	path: string,
): AgentDiagnostic | null {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	const cli = match ? getFrontmatterValue(match[1], "cli") : undefined;
	if (!match || !cli) return null;
	const resolvedAgentName = getFrontmatterValue(match[1], "name") ?? agentName;
	return {
		code: "external-cli-unsupported",
		message: `Role "${resolvedAgentName}" requests external CLI "${cli}" in ${path}. pi-herdr-agents is Pi-only; remove the cli and cli-model fields and select Claude through an authenticated Pi provider/model ID.`,
		path,
		agentName: resolvedAgentName,
	};
}

function listMarkdownFiles(path: string): string[] {
	const stat = statSync(path);
	if (stat.isFile()) return path.endsWith(".md") ? [path] : [];
	if (!stat.isDirectory()) return [];
	return readdirSync(path)
		.filter((entry) => entry.endsWith(".md"))
		.sort((left, right) => left.localeCompare(right))
		.map((entry) => join(path, entry));
}

interface PackageMetadata {
	provider?: string;
	providerVersion?: string;
}

function findPackageMetadata(path: string): PackageMetadata {
	let current = statSync(path).isDirectory() ? path : dirname(path);
	while (true) {
		const packagePath = join(current, "package.json");
		if (existsSync(packagePath)) {
			try {
				const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
				return {
					provider: isString(pkg.name) ? pkg.name : undefined,
					providerVersion: isString(pkg.version) ? pkg.version : undefined,
				};
			} catch {
				return {};
			}
		}
		const parent = dirname(current);
		if (parent === current) return {};
		current = parent;
	}
}

interface RolePackDiscoveryResult {
	paths: string[];
	diagnostics: AgentDiagnostic[];
}

export function discoverRolePackPaths(
	onRolePackDiscovered?: RoleDiscoveryOptions["onRolePackDiscovered"],
): RolePackDiscoveryResult {
	const paths = new Set<string>();
	const diagnostics: AgentDiagnostic[] = [];
	if (!onRolePackDiscovered) return { paths: [], diagnostics };

	try {
		onRolePackDiscovered({
			apiVersion: 1,
			register(path: string) {
				if (!isString(path) || !isAbsolute(path)) {
					diagnostics.push({
						code: "invalid-role-pack-path",
						message:
							"Role packs must register an absolute file or directory path.",
					});
					return;
				}
				paths.add(resolve(path));
			},
		});
	} catch (error) {
		diagnostics.push({
			code: "role-pack-discovery-failed",
			message: `Role-pack discovery failed: ${error instanceof Error ? error.message : String(error)}`,
		});
	}

	return { paths: [...paths], diagnostics };
}

export function discoverAgentCatalog(
	options: RoleDiscoveryOptions,
): AgentCatalog {
	const agents = new Map<string, ListedAgentDefinition>();
	const diagnostics: AgentDiagnostic[] = [];

	const addDirectory = (path: string, source: AgentSource) => {
		if (!existsSync(path)) return;
		for (const filePath of listMarkdownFiles(path)) {
			const fallbackName = basename(filePath, ".md");
			const content = readFileSync(filePath, "utf8");
			const legacyDiagnostic = legacyExternalCliDiagnostic(
				content,
				fallbackName,
				filePath,
			);
			if (legacyDiagnostic) {
				diagnostics.push(legacyDiagnostic);
				agents.delete(legacyDiagnostic.agentName ?? fallbackName);
				continue;
			}
			const capabilityDiagnostic = invalidCapabilityDeclarationDiagnostic(
				content,
				fallbackName,
				filePath,
			);
			if (capabilityDiagnostic) {
				diagnostics.push(capabilityDiagnostic);
				agents.delete(capabilityDiagnostic.agentName ?? fallbackName);
				continue;
			}
			const parsed = parseAgentDefinition(content, fallbackName);
			if (parsed)
				agents.set(parsed.name, {
					...parsed,
					source,
					path: filePath,
					role: runtimeRole(parsed, source),
				});
		}
	};

	// Registered role packs are the entire package layer; the host ships no roles.
	const discovered = discoverRolePackPaths(options.onRolePackDiscovered);
	diagnostics.push(...discovered.diagnostics);
	const contributed = new Map<string, ListedAgentDefinition[]>();
	for (const registeredPath of discovered.paths) {
		if (!existsSync(registeredPath)) {
			diagnostics.push({
				code: "missing-role-pack-path",
				message: `Registered role-pack path does not exist: ${registeredPath}`,
				path: registeredPath,
			});
			continue;
		}

		let metadata: ReturnType<typeof findPackageMetadata>;
		let roleFiles: string[];
		try {
			metadata = findPackageMetadata(registeredPath);
			roleFiles = listMarkdownFiles(registeredPath);
		} catch (error) {
			diagnostics.push({
				code: "unreadable-role-pack-path",
				message: `Cannot read registered role-pack path ${registeredPath}: ${error instanceof Error ? error.message : String(error)}`,
				path: registeredPath,
			});
			continue;
		}
		if (roleFiles.length === 0 && statSync(registeredPath).isFile()) {
			diagnostics.push({
				code: "invalid-role-pack-file",
				message: `Registered role-pack file must use the .md extension: ${registeredPath}`,
				path: registeredPath,
				provider: metadata.provider,
			});
			continue;
		}

		for (const filePath of roleFiles) {
			const fallbackName = basename(filePath, ".md");
			let content: string;
			try {
				content = readFileSync(filePath, "utf8");
			} catch (error) {
				diagnostics.push({
					code: "unreadable-role-definition",
					message: `Cannot read role definition ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
					path: filePath,
					agentName: fallbackName,
					provider: metadata.provider,
				});
				continue;
			}
			const legacyDiagnostic = legacyExternalCliDiagnostic(
				content,
				fallbackName,
				filePath,
			);
			if (legacyDiagnostic) {
				diagnostics.push({ ...legacyDiagnostic, provider: metadata.provider });
				continue;
			}
			const capabilityDiagnostic = invalidCapabilityDeclarationDiagnostic(
				content,
				fallbackName,
				filePath,
			);
			if (capabilityDiagnostic) {
				diagnostics.push({
					...capabilityDiagnostic,
					provider: metadata.provider,
				});
				continue;
			}
			const parsed = parseAgentDefinition(content, fallbackName);
			if (!parsed) {
				diagnostics.push({
					code: "invalid-role-definition",
					message: `Role definition must start with frontmatter: ${filePath}`,
					path: filePath,
					agentName: fallbackName,
					provider: metadata.provider,
				});
				continue;
			}
			if (parsed.name !== fallbackName) {
				diagnostics.push({
					code: "role-name-mismatch",
					message: `Role name "${parsed.name}" must match filename "${fallbackName}" in ${filePath}`,
					path: filePath,
					agentName: fallbackName,
					provider: metadata.provider,
				});
				continue;
			}
			if (!parsed.description) {
				diagnostics.push({
					code: "missing-role-description",
					message: `Role "${parsed.name}" must declare a description in ${filePath}`,
					path: filePath,
					agentName: parsed.name,
					provider: metadata.provider,
				});
				continue;
			}
			const definitions = contributed.get(parsed.name) ?? [];
			definitions.push({
				...parsed,
				source: "package",
				path: filePath,
				...metadata,
				role: runtimeRole(parsed, "package", metadata.providerVersion),
			});
			contributed.set(parsed.name, definitions);
		}
	}

	for (const [name, definitions] of contributed) {
		if (definitions.length > 1) {
			const providers = definitions
				.map((definition) => definition.provider ?? definition.path)
				.sort((left, right) => left.localeCompare(right))
				.join(", ");
			diagnostics.push({
				code: "duplicate-package-role",
				message: `Role "${name}" is contributed by multiple role packs: ${providers}. It stays unavailable until only one pack provides it; use a global or project definition for an intentional override.`,
				agentName: name,
			});
			continue;
		}
		agents.set(name, definitions[0]);
	}

	addDirectory(join(options.agentConfigDir, "agents"), "global");
	addDirectory(join(options.cwd, ".pi", "agents"), "project");

	return { agents: [...agents.values()], diagnostics };
}

export function discoverAgentDefinitions(
	options: RoleDiscoveryOptions,
): ListedAgentDefinition[] {
	return discoverAgentCatalog(options).agents;
}
