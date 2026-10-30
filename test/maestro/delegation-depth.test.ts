import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_MAX_DELEGATION_DEPTH,
	childDelegationDepth,
	decideDelegation,
	parseDelegationDepth,
} from "../../maestro/core/delegation-depth.ts";
import { parseSpawningConfig } from "../../maestro/core/config/spawning-config.ts";

describe("delegation depth", () => {
	it("treats an absent variable as a top-level session at depth 0", () => {
		assert.deepEqual(parseDelegationDepth(undefined), {
			kind: "known",
			depth: 0,
		});
		assert.equal(childDelegationDepth(undefined), 1);
		assert.equal(childDelegationDepth("2"), 3);
	});

	it("treats non-canonical inherited values as unknown, never as 0", () => {
		for (const raw of ["", "abc", "-1", "1.5", "01", " 1", "1 ", "1e1", "+1"]) {
			assert.deepEqual(
				parseDelegationDepth(raw),
				{ kind: "unknown", raw },
				raw,
			);
			assert.throws(() => childDelegationDepth(raw), /not a non-negative/);
		}
		assert.equal(parseDelegationDepth("99999999999999999999").kind, "unknown");
	});

	it("allows depths up to the maximum and refuses the next one", () => {
		assert.equal(DEFAULT_MAX_DELEGATION_DEPTH, 3);
		const at = (depth: number) =>
			decideDelegation({ kind: "known", depth }, DEFAULT_MAX_DELEGATION_DEPTH);
		assert.deepEqual(at(0), { allowed: true, childDepth: 1 });
		assert.deepEqual(at(2), { allowed: true, childDepth: 3 });
		const refused = at(3);
		assert.equal(refused.allowed, false);
		if (refused.allowed) return;
		assert.equal(refused.reason, "max-depth");
		assert.match(refused.message, /depth 3 and the maximum is 3/);
		assert.match(refused.message, /spawning\.maxDepth/);
	});

	it("refuses when the inherited depth is unknown", () => {
		const refused = decideDelegation({ kind: "unknown", raw: "abc" }, 3);
		assert.equal(refused.allowed, false);
		if (refused.allowed) return;
		assert.equal(refused.reason, "unknown-depth");
		assert.match(refused.message, /PI_SUBAGENT_DEPTH="abc"/);
	});
});

describe("spawning config", () => {
	it("defaults to depth 3 and accepts a positive integer", () => {
		assert.deepEqual(parseSpawningConfig({}), { maxDepth: 3 });
		assert.deepEqual(parseSpawningConfig({ spawning: {} }), { maxDepth: 3 });
		assert.deepEqual(parseSpawningConfig({ spawning: { maxDepth: 1 } }), {
			maxDepth: 1,
		});
		assert.deepEqual(parseSpawningConfig({ spawning: { maxDepth: 6 } }), {
			maxDepth: 6,
		});
	});

	it("rejects other values and unknown keys strictly", () => {
		for (const maxDepth of [0, -1, 1.5, "3", null, true, NaN, Infinity]) {
			assert.throws(
				() => parseSpawningConfig({ spawning: { maxDepth } }),
				/spawning\.maxDepth must be a positive integer/,
				String(maxDepth),
			);
		}
		assert.throws(
			() => parseSpawningConfig({ spawning: { maxDepth: 3, extra: 1 } }),
			/spawning has unsupported key\(s\): extra/,
		);
		assert.throws(
			() => parseSpawningConfig({ spawning: 3 }),
			/spawning must be an object/,
		);
		assert.throws(() => parseSpawningConfig([]), /root must be an object/);
	});
});
