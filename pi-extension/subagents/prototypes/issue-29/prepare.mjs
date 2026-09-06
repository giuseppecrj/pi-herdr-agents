// Reproduce the ignored experimental copies from the frozen baseline.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "./lab.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(ROOT, "pi-extension/subagents");
const manifest = JSON.parse(
	await readFile(join(here, "BASELINE.json"), "utf8"),
);
for (const [name, expected] of Object.entries(manifest.sourceHashes)) {
	const actual = createHash("sha256")
		.update(await readFile(join(sourceDir, name)))
		.digest("hex");
	assert.equal(
		actual,
		expected,
		`Frozen prototype source changed: ${name}. Port deliberately after #32; do not reuse old measurements.`,
	);
}
let resolver = await readFile(join(sourceDir, "completion.ts"), "utf8");
assert.equal(
	resolver.split("await abortableDelay(options.intervalMs, signal);").length,
	2,
);
resolver = resolver.replace(
	"intervalMs: number;",
	"intervalMs: number;\n\twait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;",
);
resolver = resolver.replace(
	"await abortableDelay(options.intervalMs, signal);",
	"await (options.wait ?? abortableDelay)(options.intervalMs, signal);",
);
resolver = resolver.replace(
	"if (exitCode !== null) {",
	"if (exitCode !== null) {\n\t\t\t\tconst publishedDuringRead = consumeExitSidecar(options.sessionFile);\n\t\t\t\tif (publishedDuringRead) return publishedDuringRead;",
);
resolver = resolver
	.replaceAll('"./type-guards.ts"', '"../../type-guards.ts"')
	.replaceAll('"./lifecycle.ts"', '"../../lifecycle.ts"');
await writeFile(
	join(here, "completion-prototype.ts"),
	"// GENERATED PROTOTYPE ONLY: wait seam and zero-exit evidence guard.\n" +
		resolver,
);
let child = await readFile(join(sourceDir, "subagent-done.ts"), "utf8");
child = child.replace(
	'import { writeFileSync } from "node:fs";',
	'import { writeFileSync as originalWriteFileSync } from "node:fs";',
);
child = child
	.replaceAll('"./activity.ts"', '"../../activity.ts"')
	.replaceAll('"./type-guards.ts"', '"../../type-guards.ts"');
child += `\n// Measurement data only; never consumed as completion evidence.\nfunction writeFileSync(path: any, data: any, options?: any): void {\n  const evidenceAt = Date.now();\n  originalWriteFileSync(path, data, options);\n  if (String(path) === process.env.PI_SUBAGENT_SESSION + '.exit') originalWriteFileSync(process.env.PI_SUBAGENT_SESSION + '.timing.json', JSON.stringify({evidenceAt, pid: process.pid}));\n}\n`;
await writeFile(
	join(here, "instrumented-child.ts"),
	"// GENERATED PROTOTYPE ONLY: timestamp-instrumented child extension.\n" +
		child,
);
console.log(
	"Prepared ignored experimental copies from the verified frozen baseline.",
);
