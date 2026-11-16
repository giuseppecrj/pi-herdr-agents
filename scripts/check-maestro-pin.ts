/**
 * Maestro pin gate (extraction plan §1.4). Before the switch it refused an
 * @nubl/maestro candidate unless its recorded `base_main_sha` was this
 * branch's main base and its `copy_sha` the H1 tip. The switch is merged and
 * H3 deleted the local copies, so main now holds commits after the pin and
 * that equality can never hold again. What still holds, and is checked here:
 * `package.json` names one exact version, the installed package is that
 * version, and the pin's `base_main_sha` is a commit this checkout descends
 * from (the engine was extracted from this history, not another).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, isString } from "@nubl/maestro/core/config/type-guards";

interface Pin {
	version: string;
	baseMainSha: string;
	copySha: string;
}

/** Read the declared version and the installed package's version and pin. */
function readPin(): Pin {
	let manifest;
	try {
		manifest = JSON.parse(
			readFileSync(
				fileURLToPath(new URL("../package.json", import.meta.url)),
				"utf8",
			),
		);
	} catch (cause) {
		throw new Error("Cannot read package.json", { cause });
	}
	const declared =
		isRecord(manifest) && isRecord(manifest.dependencies)
			? manifest.dependencies["@nubl/maestro"]
			: undefined;
	assert.ok(
		isString(declared) && /^\d+\.\d+\.\d+$/.test(declared),
		"package.json must depend on one exact @nubl/maestro version",
	);
	const packageJson = createRequire(import.meta.url).resolve(
		"@nubl/maestro/package.json",
	);
	let installed;
	try {
		installed = JSON.parse(readFileSync(packageJson, "utf8"));
	} catch (cause) {
		throw new Error("Cannot read the installed @nubl/maestro manifest", {
			cause,
		});
	}
	assert.ok(
		isRecord(installed) && installed.version === declared,
		`The installed @nubl/maestro is not the declared ${declared}`,
	);
	let pin;
	try {
		pin = JSON.parse(
			readFileSync(join(dirname(packageJson), "dist/provenance.json"), "utf8"),
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
	return {
		version: declared,
		baseMainSha: pin.base_main_sha,
		copySha: pin.copy_sha,
	};
}

const pin = readPin();
try {
	execFileSync("git", ["merge-base", "--is-ancestor", pin.baseMainSha, "HEAD"]);
} catch (cause) {
	throw new Error(
		`Pin base ${pin.baseMainSha} is not an ancestor of this checkout`,
		{ cause },
	);
}
console.log(
	`@nubl/maestro ${pin.version} pin accepted: base ${pin.baseMainSha} (copy ${pin.copySha}).`,
);
