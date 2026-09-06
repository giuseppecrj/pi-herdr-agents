// THROWAWAY: generate an instrumented runtime copy; never edit the production files.
import "./prepare.mjs";
import assert from "node:assert/strict";
import {
	cp,
	mkdir,
	readFile,
	writeFile,
	rm,
	symlink,
	readdir,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "./lab.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const runtime = join(here, "results/runtime-parent");
assert.ok(runtime.startsWith(here + "/results/"));
await rm(runtime, { recursive: true, force: true });
await mkdir(join(runtime, "pi-extension/subagents"), { recursive: true });
for (const entry of await readdir(join(ROOT, "pi-extension/subagents"))) {
	if (entry === "prototypes") continue;
	await cp(
		join(ROOT, "pi-extension/subagents", entry),
		join(runtime, "pi-extension/subagents", entry),
		{ recursive: true },
	);
}
for (const name of ["package.json", "config.json.example", "README.md"])
	await cp(join(ROOT, name), join(runtime, name));
await cp(join(ROOT, "agents"), join(runtime, "agents"), { recursive: true });
await cp(join(ROOT, "skills"), join(runtime, "skills"), { recursive: true });
await cp(join(ROOT, "test/integration"), join(runtime, "test/integration"), {
	recursive: true,
});
await symlink(join(ROOT, "node_modules"), join(runtime, "node_modules"), "dir");
const directory = join(runtime, "pi-extension/subagents");
const adapter = join(here, "parent-adapter.mjs");
let index = await readFile(join(directory, "index.ts"), "utf8");
assert.equal(
	index.split("export default function subagentsExtension(pi: ExtensionAPI) {")
		.length,
	2,
);
index =
	`import { instrumentApi, installControl } from ${JSON.stringify(adapter)};\n` +
	index;
index = index.replace(
	"export default function subagentsExtension(pi: ExtensionAPI) {",
	"export default function subagentsExtension(pi: ExtensionAPI) {\n\tpi = instrumentApi(pi);",
);
const anchor =
	"const result = await waitForCompletion(signal, {\n\t\t\tintervalMs: 1000,";
assert.ok(index.includes(anchor));
index = index.replace(
	anchor,
	"const result = await waitForCompletion(signal, {\n\t\t\tprototypePane: surface,\n\t\t\tprototypeRun: running.id,\n\t\t\tintervalMs: 1000,",
);
const lastBrace = index.lastIndexOf("\n}");
assert.ok(lastBrace > index.length - 10);
index =
	index.slice(0, lastBrace) +
	"\n\tinstallControl(pi);" +
	index.slice(lastBrace);
await writeFile(join(directory, "index.ts"), index);
await cp(
	join(directory, "completion.ts"),
	join(directory, "completion-base.ts"),
);
await writeFile(
	join(directory, "completion.ts"),
	`export * from './completion-base.ts';\nexport { waitForCompletion } from ${JSON.stringify(adapter)};\n`,
);
let herdr = await readFile(join(directory, "herdr.ts"), "utf8");
herdr = `import { beginCli } from ${JSON.stringify(adapter)};\n` + herdr;
herdr = herdr.replace(
	'import { execFile, execSync, execFileSync } from "node:child_process";',
	'import { execFile, execSync, execFileSync as rawExecFileSync } from "node:child_process";',
);
herdr = herdr.replace(
	"const execFileAsync = promisify(execFile);",
	`const rawExecFileAsync = promisify(execFile);\nconst execFileAsync = async (...args: any[]) => { const end = beginCli(args[0], args[1]); try { return await (rawExecFileAsync as any)(...args); } finally { end(); } };\nconst execFileSync = (...args: any[]) => { const end = beginCli(args[0], args[1]); try { return (rawExecFileSync as any)(...args); } finally { end(); } };`,
);
await writeFile(join(directory, "herdr.ts"), herdr);
let child = await readFile(join(directory, "subagent-done.ts"), "utf8");
child = child.replace(
	'import { writeFileSync } from "node:fs";',
	'import { writeFileSync as originalWriteFileSync } from "node:fs";',
);
child += `\nfunction writeFileSync(path: any, data: any, options?: any): void { const evidenceAt = Date.now(); originalWriteFileSync(path, data, options); if (String(path) === process.env.PI_SUBAGENT_SESSION + '.exit') originalWriteFileSync(process.env.PI_SUBAGENT_SESSION + '.timing.json', JSON.stringify({evidenceAt, pid: process.pid})); }\n`;
await writeFile(join(directory, "subagent-done.ts"), child);
const harnessPath = join(runtime, "test/integration/harness.ts");
let harness = await readFile(harnessPath, "utf8");
const envAnchor =
	'agentDir ? `PI_CODING_AGENT_DIR=${shellQuote(agentDir)}` : "",';
assert.ok(harness.includes(envAnchor));
harness = harness.replace(
	envAnchor,
	envAnchor +
		'\n\t\t`PI_ISSUE29_MODE=${shellQuote(process.env.PI_ISSUE29_MODE ?? "baseline")}`,\n\t\tprocess.env.PI_ISSUE29_TRACE ? `PI_ISSUE29_TRACE=${shellQuote(process.env.PI_ISSUE29_TRACE)}` : "",',
);
await writeFile(harnessPath, harness);
const providerPath = join(runtime, "test/integration/fake-provider.ts");
let provider = await readFile(providerPath, "utf8");
provider =
	`import { prototypeResponse } from ${JSON.stringify(join(here, "prototype-provider.mjs"))};\n` +
	provider;
const parentHook = "const lastRole = request.messages?.at(-1)?.role;";
assert.ok(provider.includes(parentHook));
provider = provider.replace(
	parentHook,
	parentHook +
		"\n\tconst prototypePlan = await prototypeResponse(names, source);\n\tif (prototypePlan) return prototypePlan;",
);
provider = provider.replace(
	"writeResponse(response, chatRequest, await planResponse(chatRequest));",
	"const plan = await planResponse(chatRequest);\n\t\tif (!response.destroyed) writeResponse(response, chatRequest, plan);",
);
await writeFile(providerPath, provider);
await writeFile(
	join(runtime, "PROTOTYPE-COPY.json"),
	JSON.stringify(
		{
			source: ROOT,
			adapter,
			changes: [
				"wait seam metadata",
				"prototype adapter",
				"in-memory CLI counters and lifecycle telemetry",
				"child evidence timestamp",
				"test harness prototype environment only",
			],
			productionFilesEdited: false,
		},
		null,
		2,
	),
);
console.log(runtime);
