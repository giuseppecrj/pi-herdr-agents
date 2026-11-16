/**
 * H2 switch gate (Maestro extraction plan §1.4): refuse an installed
 * @nubl/maestro candidate whose recorded extraction pin is older than this
 * checkout. Its `base_main_sha` must be this branch's main base and the latest
 * known `origin/main`; its `copy_sha` must be the H1 composition-hooks tip the
 * copies came from. Usage: check-maestro-pin.ts [h1-ref]
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isRecord, isString } from "@nubl/maestro/core/config/type-guards";

const git = (...args: string[]) =>
	execFileSync("git", args, { encoding: "utf8" }).trim();
const packageRoot = dirname(
	createRequire(import.meta.url).resolve("@nubl/maestro/package.json"),
);
let pin: unknown;
try {
	pin = JSON.parse(
		readFileSync(join(packageRoot, "dist/provenance.json"), "utf8"),
	);
} catch (cause) {
	throw new Error("The installed @nubl/maestro has no readable pin", {
		cause,
	});
}
assert.ok(
	isRecord(pin) && isString(pin.base_main_sha) && isString(pin.copy_sha),
	"The installed @nubl/maestro records no extraction pin",
);
const main = git("rev-parse", "origin/main");
const base = git("merge-base", "HEAD", "origin/main");
const h1 = git("rev-parse", process.argv[2] ?? "h1/composition-hooks");
assert.equal(
	pin.base_main_sha,
	base,
	"Candidate base_main_sha differs from this branch's main base",
);
assert.equal(
	pin.base_main_sha,
	main,
	"Candidate base_main_sha is older than origin/main",
);
assert.equal(pin.copy_sha, h1, "Candidate copy_sha differs from the H1 tip");
git("merge-base", "--is-ancestor", pin.copy_sha, "HEAD");
console.log(
	`@nubl/maestro pin accepted: base ${pin.base_main_sha}, copy ${pin.copy_sha}.`,
);
