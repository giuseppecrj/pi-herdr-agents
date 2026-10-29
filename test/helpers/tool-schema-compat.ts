import {
	isFiniteNumber,
	isRecord,
	isString,
	type JsonObject,
	type JsonValue,
} from "../../maestro/core/config/type-guards.ts";
import type { ToolSchemaSnapshot } from "./tool-schema-capture.ts";

type SchemaNode = JsonObject;

// Documentation-only keywords never change what a client may send.
const IGNORED = new Set(["description", "title", "default", "examples"]);
const LOWER_BOUNDS = ["minLength", "minItems", "minimum", "minProperties"];
const UPPER_BOUNDS = ["maxLength", "maxItems", "maximum", "maxProperties"];
const HANDLED = new Set([
	...IGNORED,
	...LOWER_BOUNDS,
	...UPPER_BOUNDS,
	"anyOf",
	"type",
	"const",
	"enum",
	"pattern",
	"properties",
	"required",
	"items",
	"additionalProperties",
]);

const same = (a: JsonValue | undefined, b: JsonValue | undefined) =>
	JSON.stringify(a) === JSON.stringify(b);

function without(node: SchemaNode, key: string): SchemaNode {
	const { [key]: _removed, ...rest } = node;
	return rest;
}

function literalSet(node: SchemaNode): JsonValue[] | undefined {
	if (Array.isArray(node.enum)) return node.enum;
	if ("const" in node && node.const !== undefined) return [node.const];
	return undefined;
}

function requiredNames(node: SchemaNode): string[] {
	return Array.isArray(node.required) ? node.required.filter(isString) : [];
}

function propertyNodes(node: SchemaNode): SchemaNode {
	return isRecord(node.properties) ? node.properties : {};
}

function asNode(value: JsonValue | undefined): SchemaNode | undefined {
	return isRecord(value) ? value : undefined;
}

function compareProperties(
	oldNode: SchemaNode,
	newNode: SchemaNode,
	path: string,
): string[] {
	const problems: string[] = [];
	const oldProps = propertyNodes(oldNode);
	const newProps = propertyNodes(newNode);
	const oldRequired = new Set(requiredNames(oldNode));
	for (const [name, oldProp] of Object.entries(oldProps)) {
		const newProp = asNode(newProps[name]);
		const oldChild = asNode(oldProp);
		if (!newProp || !oldChild) {
			problems.push(`${path}.${name}: property removed`);
			continue;
		}
		problems.push(...compareNodes(oldChild, newProp, `${path}.${name}`));
	}
	for (const name of requiredNames(newNode)) {
		if (!oldRequired.has(name))
			problems.push(
				name in oldProps
					? `${path}.${name}: property became required`
					: `${path}.${name}: new required property`,
			);
	}
	return problems;
}

function compareAdditional(
	oldNode: SchemaNode,
	newNode: SchemaNode,
	path: string,
): string[] {
	const before = oldNode.additionalProperties;
	const after = newNode.additionalProperties;
	if (before === false || same(before, after)) return [];
	if (after === undefined || after === true) return [];
	if (after === false)
		return [`${path}: additionalProperties changed from true to false`];
	const afterNode = asNode(after);
	const beforeNode = asNode(before);
	if (afterNode && beforeNode)
		return compareNodes(beforeNode, afterNode, `${path}.<additional>`);
	return [`${path}: additionalProperties narrowed`];
}

function compareLiteralValues(
	oldNode: SchemaNode,
	newNode: SchemaNode,
	path: string,
): string[] {
	const before = literalSet(oldNode);
	const after = literalSet(newNode);
	if (!before) {
		return after ? [`${path}: enum/const constraint added`] : [];
	}
	if (!after) return [];
	return before
		.filter((value) => !after.some((candidate) => same(candidate, value)))
		.map(
			(value) => `${path}: enum/const value removed: ${JSON.stringify(value)}`,
		);
}

function compareBounds(
	oldNode: SchemaNode,
	newNode: SchemaNode,
	path: string,
): string[] {
	const problems: string[] = [];
	const bound = (key: string) => {
		const before = oldNode[key];
		const after = newNode[key];
		return {
			before: isFiniteNumber(before) ? before : undefined,
			after: isFiniteNumber(after) ? after : undefined,
			unrecognized:
				(before !== undefined && !isFiniteNumber(before)) ||
				(after !== undefined && !isFiniteNumber(after)),
		};
	};
	for (const key of LOWER_BOUNDS) {
		const { before, after, unrecognized } = bound(key);
		if (unrecognized) problems.push(`${path}: unrecognized ${key}`);
		else if (after !== undefined && (before === undefined || after > before))
			problems.push(`${path}: ${key} raised from ${before} to ${after}`);
	}
	for (const key of UPPER_BOUNDS) {
		const { before, after, unrecognized } = bound(key);
		if (unrecognized) problems.push(`${path}: unrecognized ${key}`);
		else if (after !== undefined && (before === undefined || after < before))
			problems.push(`${path}: ${key} lowered from ${before} to ${after}`);
	}
	return problems;
}

function compareLeaf(
	oldNode: SchemaNode,
	newNode: SchemaNode,
	path: string,
): string[] {
	const problems: string[] = [];
	if (!same(oldNode.type, newNode.type))
		problems.push(
			`${path}: type changed from ${JSON.stringify(oldNode.type)} to ${JSON.stringify(newNode.type)}`,
		);
	if (newNode.pattern !== undefined && !same(oldNode.pattern, newNode.pattern))
		problems.push(`${path}: pattern changed`);
	problems.push(...compareLiteralValues(oldNode, newNode, path));
	problems.push(...compareBounds(oldNode, newNode, path));
	problems.push(...compareProperties(oldNode, newNode, path));
	problems.push(...compareAdditional(oldNode, newNode, path));
	const oldItems = asNode(oldNode.items);
	const newItems = asNode(newNode.items);
	if (oldNode.items !== undefined || newNode.items !== undefined) {
		if (oldItems && newItems)
			problems.push(...compareNodes(oldItems, newItems, `${path}[]`));
		else if (oldNode.items === undefined || !same(oldNode.items, newNode.items))
			if (newNode.items !== undefined)
				problems.push(`${path}: unrecognized or narrowed items`);
	}
	for (const key of new Set([...Object.keys(oldNode), ...Object.keys(newNode)]))
		if (!HANDLED.has(key) && !same(oldNode[key], newNode[key]))
			problems.push(`${path}: unrecognized keyword ${key} changed`);
	return problems;
}

/** Every value the old node accepted must still be accepted by the new node. */
function compareNodes(
	oldNode: SchemaNode,
	newNode: SchemaNode,
	path: string,
): string[] {
	const oldBranches = oldNode.anyOf;
	if (Array.isArray(oldBranches)) {
		const rest = without(oldNode, "anyOf");
		return oldBranches.flatMap((branch, index) => {
			const branchNode = asNode(branch);
			if (!branchNode) return [`${path}: unrecognized anyOf branch ${index}`];
			return compareNodes(
				{ ...rest, ...branchNode },
				newNode,
				`${path}|${index}`,
			);
		});
	}
	const newBranches = newNode.anyOf;
	if (Array.isArray(newBranches)) {
		const rest = without(newNode, "anyOf");
		const accepted = newBranches.some((branch) => {
			const branchNode = asNode(branch);
			return (
				branchNode !== undefined &&
				compareNodes(oldNode, { ...rest, ...branchNode }, path).length === 0
			);
		});
		return accepted
			? []
			: [`${path}: anyOf branch has no accepting branch in the new schema`];
	}
	return compareLeaf(oldNode, newNode, path);
}

/** Lists changes that would break a client written for `released`. */
export function findBreakingChanges(
	released: ToolSchemaSnapshot,
	current: ToolSchemaSnapshot,
): string[] {
	const problems: string[] = [];
	for (const oldTool of released.tools) {
		const sameName = current.tools.filter((tool) => tool.name === oldTool.name);
		if (sameName.length === 0) {
			problems.push(`${oldTool.name}: tool removed or renamed`);
			continue;
		}
		for (const scope of oldTool.scopes) {
			const newTool = sameName.find((tool) => tool.scopes.includes(scope));
			if (!newTool) {
				problems.push(
					`${oldTool.name}: tool no longer registered in ${scope} scope`,
				);
				continue;
			}
			const before = asNode(oldTool.parameters);
			const after = asNode(newTool.parameters);
			if (!before || !after) {
				problems.push(`${oldTool.name}: unrecognized parameters schema`);
				continue;
			}
			for (const problem of compareNodes(before, after, oldTool.name))
				problems.push(`${problem} (${scope} scope)`);
		}
	}
	return [...new Set(problems)];
}
