import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	formatInheritedModelScope,
	MODEL_SCOPE_ENV,
	modelScopeOf,
} from "../../core/routing.ts";
import {
	childDelegationDepth,
	DELEGATION_DEPTH_ENV,
} from "../../core/delegation-depth.ts";
import { shellQuote } from "../../core/shell.ts";

export const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * `--models <refs>` for a scoped parent, or nothing when unscoped. Pi reads
 * these as patterns, so this is only a hint for the child's own model
 * cycling; {@link modelScopeAssignment} carries the enforced allowlist.
 */
export function modelScopeArgs(
	modelScope: readonly string[] | undefined,
): string[] {
	const scope = modelScopeOf({ scope: modelScope });
	if (!scope || scope.length === 0) return [];
	// Pi splits --models on commas; a ref containing one cannot be carried.
	const unrepresentable = scope.find((ref) => ref.includes(","));
	if (unrepresentable)
		throw new Error(
			`Cannot pass the session model scope to the child: ${JSON.stringify(unrepresentable)} contains a comma`,
		);
	return ["--models", shellQuote(scope.join(","))];
}

/**
 * The exact allowlist the child's routing intersects with its own scope. Set
 * on every launch, empty when unscoped, so a value left in the pane's shell
 * never reaches the child.
 */
export function modelScopeAssignment(
	modelScope: readonly string[] | undefined,
): string {
	return `${MODEL_SCOPE_ENV}=${shellQuote(formatInheritedModelScope(modelScope))}`;
}

/**
 * Always set explicitly so a value left in the pane's shell never reaches the
 * child. Throws when this session's own depth is unknown.
 */
export function childDepthAssignment(
	launch: "child" | "handoff" = "child",
): string {
	return `${DELEGATION_DEPTH_ENV}=${childDelegationDepth(process.env[DELEGATION_DEPTH_ENV], launch)}`;
}

export function buildSubagentToolAllowlist(
	tools?: string,
	autoExit = false,
): string | null {
	const requested = (tools ?? "")
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
	if (requested.length === 0) return null;
	const allow = new Set(requested);
	allow.delete("subagent_done");
	allow.add("caller_ping");
	if (!autoExit) allow.add("subagent_done");
	return [...allow].join(",");
}

export function timestampForFile(includeMilliseconds = true): string {
	return (
		new Date()
			.toISOString()
			.replace(/[:.]/g, "-")
			.slice(0, includeMilliseconds ? 23 : 19) +
		(includeMilliseconds ? "Z" : "")
	);
}

export function shellComment(value: string): string {
	return `# ${value.replace(/[\r\n\u2028\u2029]/g, " ")}`;
}

export function safeName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}
