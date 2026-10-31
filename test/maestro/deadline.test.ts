import assert from "node:assert/strict";
import { test } from "node:test";
import { Deadline } from "../../maestro/core/deadline.ts";

test("deadlines reject unlimited/invalid timers, use a monotonic clock and never extend a parent", () => {
	for (const value of [0, -1, NaN, Infinity, 2 ** 31])
		assert.throws(() => Deadline.after(value), /finite and positive/);
	let now = 100;
	const parent = Deadline.after(10, () => now);
	const child = parent.cappedAt(100);
	now = 109.9;
	assert.equal(parent.remainingMs(), 1);
	assert.equal(child.remainingMs(), 1);
	now = 110;
	assert.equal(child.expired(), true);
	assert.throws(() => child.remainingMs(), /deadline/);
});
