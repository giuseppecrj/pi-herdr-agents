#!/usr/bin/env node
// Regression runner for GitHub issue #47: proves this checkout's
// subagent-done.ts against the pinned exact Pi 0.84.4 upstream source.
// See README.md in this directory for provenance and usage.

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
	cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PINNED_COMMIT = "b79e4cc834970cca69daebffab7df1da7d1e52c4";
const PINNED_VERSION = "0.84.4";
const UPSTREAM_REPO = "earendil-works/pi";
const AI_PACKAGE_SPEC = "@earendil-works/pi-ai@0.84.4";
// Written only into runner-bootstrapped temp checkouts. Offline reuse via
// PI_0844_SOURCE_DIR requires this exact marker in addition to the version,
// generated-data, and vitest checks below: a directory that merely happens to
// report the pinned coding-agent version is not accepted, only a retained
// output of this script's own bootstrap. See README.md "Provenance marker".
const PROVENANCE_MARKER_FILENAME = ".pi-0844-provenance.json";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const subagentDonePath = join(
	repoRoot,
	"pi-extension",
	"subagents",
	"subagent-done.ts",
);

function log(message) {
	process.stderr.write(`[test:pi-0844] ${message}\n`);
}

function vitestBinPath(sourceDir) {
	return join(sourceDir, "node_modules", ".bin", "vitest");
}

function verifySourceDir(sourceDir) {
	const markerPath = join(sourceDir, PROVENANCE_MARKER_FILENAME);
	if (!existsSync(markerPath)) {
		throw new Error(
			`missing provenance marker ${markerPath}: ${sourceDir} is not a retained bootstrap output of this script. ` +
				"An arbitrary directory that merely reports the pinned coding-agent version is not accepted offline; " +
				"only a PI_0844_KEEP=1 checkout retained by this script qualifies.",
		);
	}
	let marker;
	try {
		marker = JSON.parse(readFileSync(markerPath, "utf8"));
	} catch (error) {
		throw new Error(
			`unreadable provenance marker ${markerPath}: ${error.message}`,
		);
	}
	if (
		marker.repo !== UPSTREAM_REPO ||
		marker.commit !== PINNED_COMMIT ||
		marker.version !== PINNED_VERSION
	) {
		throw new Error(
			`provenance marker mismatch in ${markerPath}: expected {repo: ${UPSTREAM_REPO}, commit: ${PINNED_COMMIT}, version: ${PINNED_VERSION}}, found ${JSON.stringify(marker)}`,
		);
	}
	const codingAgentPkg = join(
		sourceDir,
		"packages",
		"coding-agent",
		"package.json",
	);
	if (!existsSync(codingAgentPkg)) {
		throw new Error(`missing ${codingAgentPkg}: not a Pi monorepo checkout`);
	}
	const parsed = JSON.parse(readFileSync(codingAgentPkg, "utf8"));
	if (parsed.version !== PINNED_VERSION) {
		throw new Error(
			`pinned version mismatch: expected @earendil-works/pi-coding-agent@${PINNED_VERSION}, found ${parsed.version} in ${codingAgentPkg}`,
		);
	}
	const dataDir = join(
		sourceDir,
		"packages",
		"ai",
		"src",
		"providers",
		"data",
		".manifest.json",
	);
	if (!existsSync(dataDir)) {
		throw new Error(
			`missing generated model data at ${dataDir}; source dir was not fully bootstrapped`,
		);
	}
	if (!existsSync(vitestBinPath(sourceDir))) {
		throw new Error(
			`missing bootstrapped vitest at ${vitestBinPath(sourceDir)}; run \`npm ci\` in ${sourceDir} or omit PI_0844_SOURCE_DIR to bootstrap fresh`,
		);
	}
}

function bootstrapSource() {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-0844-"));
	try {
		return bootstrapSourceInto(tempDir);
	} catch (error) {
		if (process.env.PI_0844_KEEP === "1") {
			log(
				`PI_0844_KEEP=1: retaining failed bootstrap attempt at ${tempDir} for inspection`,
			);
		} else {
			rmSync(tempDir, { recursive: true, force: true });
		}
		throw error;
	}
}

function bootstrapSourceInto(tempDir) {
	log(
		`downloading pinned commit ${PINNED_COMMIT} from ${UPSTREAM_REPO} (network required)`,
	);
	const tarballPath = join(tempDir, "pi-source.tar.gz");
	const downloadUrl = `https://codeload.github.com/${UPSTREAM_REPO}/tar.gz/${PINNED_COMMIT}`;
	execFileSync("curl", ["-sS", "-L", "-f", downloadUrl, "-o", tarballPath], {
		stdio: "inherit",
	});
	execFileSync("tar", ["-xzf", tarballPath, "-C", tempDir], {
		stdio: "inherit",
	});
	rmSync(tarballPath, { force: true });
	const extractedName = `pi-${PINNED_COMMIT}`;
	const sourceDir = join(tempDir, extractedName);
	if (!existsSync(sourceDir)) {
		throw new Error(`expected extracted directory ${sourceDir} after download`);
	}

	const codingAgentPkg = JSON.parse(
		readFileSync(
			join(sourceDir, "packages", "coding-agent", "package.json"),
			"utf8",
		),
	);
	if (codingAgentPkg.version !== PINNED_VERSION) {
		throw new Error(
			`downloaded commit ${PINNED_COMMIT} has @earendil-works/pi-coding-agent@${codingAgentPkg.version}, expected ${PINNED_VERSION}`,
		);
	}

	// The generated per-provider model catalog JSON under packages/ai/src/providers/data
	// is not committed to git; packages/ai/src imports it directly. Pull the pinned
	// immutable npm release's built copy to satisfy module resolution without a live
	// model-catalog fetch. Its exact contents are irrelevant to this regression: the
	// tests below use a faux provider, never the real model catalog.
	log(`fetching ${AI_PACKAGE_SPEC} npm artifact for generated provider data`);
	// Nested under tempDir (not the OS tmp root) so a pack/tar failure here is
	// still cleaned up by bootstrapSource()'s owned-temp catch below; this
	// script never leaves an orphaned directory outside tempDir.
	const npmPackDir = mkdtempSync(join(tempDir, "ai-pack-"));
	execFileSync("npm", ["pack", AI_PACKAGE_SPEC], {
		cwd: npmPackDir,
		stdio: "inherit",
	});
	const tgzName = execFileSync("ls", [npmPackDir])
		.toString()
		.trim()
		.split("\n")
		.find((name) => name.endsWith(".tgz"));
	if (!tgzName)
		throw new Error(
			`npm pack did not produce a tarball for ${AI_PACKAGE_SPEC}`,
		);
	execFileSync("tar", ["-xzf", join(npmPackDir, tgzName), "-C", npmPackDir], {
		stdio: "inherit",
	});
	const providerDataSrc = join(
		npmPackDir,
		"package",
		"dist",
		"providers",
		"data",
	);
	const providerDataDest = join(
		sourceDir,
		"packages",
		"ai",
		"src",
		"providers",
		"data",
	);
	mkdirSync(providerDataDest, { recursive: true });
	cpSync(providerDataSrc, providerDataDest, { recursive: true });
	rmSync(npmPackDir, { recursive: true, force: true });

	log("running npm ci in the pinned checkout (network required)");
	execFileSync("npm", ["ci", "--ignore-scripts"], {
		cwd: sourceDir,
		stdio: "inherit",
	});

	writeFileSync(
		join(sourceDir, PROVENANCE_MARKER_FILENAME),
		JSON.stringify({
			repo: UPSTREAM_REPO,
			commit: PINNED_COMMIT,
			version: PINNED_VERSION,
		}),
	);

	// Validated here, inside bootstrapSourceInto, so a fresh-bootstrap failure
	// (e.g. missing vitest bin) is still cleaned up by bootstrapSource()'s
	// owned-temp catch instead of leaking tempDir past this call.
	verifySourceDir(sourceDir);

	return { sourceDir, isTemporary: true, cleanupRoot: tempDir };
}

function resolveSourceDir() {
	const configuredDir = process.env.PI_0844_SOURCE_DIR;
	if (configuredDir) {
		log(`using PI_0844_SOURCE_DIR=${configuredDir} (offline path; no network)`);
		verifySourceDir(configuredDir);
		return {
			sourceDir: configuredDir,
			isTemporary: false,
			cleanupRoot: undefined,
		};
	}
	return bootstrapSource();
}

function buildRegressionTestFilename() {
	// Unique per invocation: avoids clobbering a concurrent run's installed
	// test file and, combined with the wx flag below, means restoring after
	// the run is always "delete the file we created" rather than trying to
	// remember and restore prior content at a shared fixed path.
	return `issue47-pi-herdr-regression-${process.pid}-${randomBytes(6).toString("hex")}.test.ts`;
}

function installRegressionTest(sourceDir) {
	const templatePath = join(__dirname, "issue47-regression.test.ts.template");
	const template = readFileSync(templatePath, "utf8");
	if (!existsSync(subagentDonePath)) {
		throw new Error(
			`missing ${subagentDonePath}: run from within the pi-herdr-agents checkout`,
		);
	}
	// JSON.stringify quotes and escapes the path for safe embedding inside the
	// generated TS import string literal (handles quotes/backslashes on any OS).
	const importPath = JSON.stringify(subagentDonePath).slice(1, -1);
	const rendered = template.replace("__SUBAGENT_DONE_PATH__", importPath);

	const testDir = join(sourceDir, "packages", "coding-agent", "test");
	const realSourceDir = realpathSync(sourceDir);
	const realTestDir = realpathSync(testDir);
	if (
		realTestDir !== realSourceDir &&
		!realTestDir.startsWith(realSourceDir + sep)
	) {
		throw new Error(
			`refusing to install regression test: ${testDir} resolves (realpath ${realTestDir}) outside ${sourceDir} (realpath ${realSourceDir})`,
		);
	}

	const filename = buildRegressionTestFilename();
	const destPath = join(testDir, filename);
	// flag: "wx" refuses to write through an existing path (including a
	// symlink), so this never follows a symlink leaf to clobber something
	// outside testDir, and never silently overwrites another run's file.
	writeFileSync(destPath, rendered, { flag: "wx" });
	return { destPath, filename };
}

function removeRegressionTest(destPath) {
	// destPath was created fresh with flag: "wx" above, so removing it here
	// only ever deletes a file this invocation created, never prior content.
	rmSync(destPath, { force: true });
}

function runVitest(sourceDir, filename) {
	log(
		`running vitest against pinned Pi ${PINNED_VERSION} (commit ${PINNED_COMMIT})`,
	);
	const result = spawnSync(
		vitestBinPath(sourceDir),
		["run", `test/${filename}`],
		{
			cwd: join(sourceDir, "packages", "coding-agent"),
			stdio: "inherit",
		},
	);
	return result.status ?? 1;
}

function main() {
	const { sourceDir, isTemporary, cleanupRoot } = resolveSourceDir();
	let exitCode = 1;
	try {
		const { destPath, filename } = installRegressionTest(sourceDir);
		try {
			exitCode = runVitest(sourceDir, filename);
		} finally {
			removeRegressionTest(destPath);
		}
	} finally {
		if (isTemporary && cleanupRoot) {
			if (process.env.PI_0844_KEEP === "1") {
				log(`PI_0844_KEEP=1: retaining bootstrapped checkout at ${sourceDir}`);
				log(
					`re-run offline with: PI_0844_SOURCE_DIR=${sourceDir} npm run test:pi-0844`,
				);
			} else {
				rmSync(cleanupRoot, { recursive: true, force: true });
			}
		}
	}
	process.exit(exitCode);
}

main();
