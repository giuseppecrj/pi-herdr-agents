import { readFileSync, writeFileSync } from "node:fs";
import { captureToolSchemas } from "../test/helpers/tool-schema-capture.ts";
import { renderSnapshotJson, renderToolDocs } from "./tool-docs.ts";

const root = new URL("../", import.meta.url);
const targets = {
	snapshot: new URL("test/fixtures/tool-schema/current.json", root),
	docs: new URL("docs/tools.md", root),
};

const snapshot = await captureToolSchemas();
const next = {
	snapshot: renderSnapshotJson(snapshot),
	docs: renderToolDocs(readFileSync(targets.docs, "utf8"), snapshot),
};

if (process.argv.includes("--check")) {
	const stale = [
		...(readFileSync(targets.snapshot, "utf8") === next.snapshot
			? []
			: ["test/fixtures/tool-schema/current.json"]),
		...(readFileSync(targets.docs, "utf8") === next.docs
			? []
			: ["docs/tools.md"]),
	];
	if (stale.length > 0) {
		console.error(
			`Stale generated tool reference (${stale.join(", ")}). Run \`npm run docs:tools\`.`,
		);
		process.exit(1);
	}
} else {
	writeFileSync(targets.snapshot, next.snapshot);
	writeFileSync(targets.docs, next.docs);
}
