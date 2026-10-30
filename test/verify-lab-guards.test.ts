import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	assertMarkerId,
	assertPrivateDir,
	assertRemovableLabRoot,
	assertRunDir,
	defaultEvidenceRoot,
	realHost,
	type GuardHost,
	type GuardStat,
} from "../.pi/skills/verify-pi-herdr-agents/scripts/path-guards.ts";

const dirStat = (overrides: Partial<GuardStat> = {}): GuardStat => ({
	isDirectory: () => true,
	isSymbolicLink: () => false,
	uid: 1000,
	mode: 0o40700,
	...overrides,
});

/** A fake machine: paths map to stats and canonical targets. */
function fakeHost(
	stats: Record<string, GuardStat>,
	links: Record<string, string> = {},
): GuardHost {
	return {
		uid: 1000,
		tmpdir: "/tmp",
		lstat(path) {
			const st = stats[path];
			if (!st)
				throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
			return st;
		},
		realpath(path) {
			// Resolve `..` lexically and apply the link table.
			const parts: string[] = [];
			for (const part of path.split("/").filter(Boolean)) {
				if (part === "..") parts.pop();
				else parts.push(part);
			}
			const joined = `/${parts.join("/")}`;
			return links[joined] ?? joined;
		},
	};
}

describe("assertPrivateDir", () => {
	it("accepts a real directory we own with mode 0700", () => {
		assertPrivateDir("/s", fakeHost({ "/s": dirStat() }));
	});

	it("refuses a symlink", () => {
		assert.throws(
			() =>
				assertPrivateDir(
					"/s",
					fakeHost({
						"/s": dirStat({
							isSymbolicLink: () => true,
							isDirectory: () => false,
						}),
					}),
				),
			/symlink/,
		);
	});

	it("refuses a directory owned by another user", () => {
		assert.throws(
			() => assertPrivateDir("/s", fakeHost({ "/s": dirStat({ uid: 0 }) })),
			/owned by uid 0/,
		);
	});

	it("refuses a group- or world-writable directory", () => {
		for (const mode of [0o40770, 0o40707, 0o41777])
			assert.throws(
				() => assertPrivateDir("/s", fakeHost({ "/s": dirStat({ mode }) })),
				/writable/,
			);
	});

	it("refuses a file and a missing path", () => {
		assert.throws(
			() =>
				assertPrivateDir(
					"/s",
					fakeHost({ "/s": dirStat({ isDirectory: () => false }) }),
				),
			/not a directory/,
		);
		assert.throws(() => assertPrivateDir("/s", fakeHost({})), /not accessible/);
	});

	it("refuses a real symlink and a loosened directory on the real filesystem", () => {
		const base = mkdtempSync(join(tmpdir(), "guard-test-"));
		try {
			const real = join(base, "real");
			mkdirSync(real, { mode: 0o700 });
			assertPrivateDir(real, realHost);
			const link = join(base, "link");
			symlinkSync(real, link);
			assert.throws(() => assertPrivateDir(link, realHost), /symlink/);
			chmodSync(real, 0o777);
			assert.throws(() => assertPrivateDir(real, realHost), /writable/);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("assertRemovableLabRoot", () => {
	const root = "/tmp/piha-herdr-lab-Ab12Cd";
	const ok = fakeHost({ [root]: dirStat() });

	it("accepts a recorded, owned lab root directly below the temp dir", () => {
		assert.equal(assertRemovableLabRoot(root, root, ok), root);
	});

	it("refuses the traversal that passes a string-prefix check", () => {
		const evil = "/tmp/piha-herdr-lab-x/../../home/g/Projects/victim";
		const host = fakeHost({
			[evil]: dirStat(),
			"/home/g/Projects/victim": dirStat(),
		});
		assert.throws(() => assertRemovableLabRoot(evil, evil, host), /normalized/);
	});

	it("refuses a normalized path outside the temp dir or without the lab name", () => {
		for (const bad of [
			"/home/g/Projects/victim",
			"/tmp/victim",
			"/tmp/piha-herdr-lab-",
			"/tmp/piha-herdr-lab-Ab12Cd/sub",
			"/tmp/piha-herdr-lab-Ab12Cd2",
			"/home/g/piha-herdr-lab-Ab12Cd",
		])
			assert.throws(
				() => assertRemovableLabRoot(bad, bad, fakeHost({ [bad]: dirStat() })),
				Error,
				bad,
			);
	});

	it("refuses a root that is not the one recorded in the state", () => {
		assert.throws(
			() => assertRemovableLabRoot(root, "/tmp/piha-herdr-lab-Zz99Zz", ok),
			/recorded/,
		);
	});

	it("refuses a symlink named like a lab root", () => {
		const host = fakeHost({
			[root]: dirStat({ isSymbolicLink: () => true, isDirectory: () => false }),
		});
		assert.throws(
			() => assertRemovableLabRoot(root, root, host),
			/not a real directory/,
		);
	});

	it("refuses a lab root owned by another user", () => {
		assert.throws(
			() =>
				assertRemovableLabRoot(
					root,
					root,
					fakeHost({ [root]: dirStat({ uid: 4242 }) }),
				),
			/owned by uid 4242/,
		);
	});

	it("refuses when the parent is a symlink that leaves the temp dir", () => {
		const viaLink = "/tmp/link/piha-herdr-lab-Ab12Cd";
		const host = fakeHost({ [viaLink]: dirStat() }, { "/tmp/link": "/home/g" });
		assert.throws(
			() => assertRemovableLabRoot(viaLink, viaLink, host),
			/not directly below/,
		);
	});

	it("refuses on a real symlinked lab-named path", () => {
		const base = mkdtempSync(join(tmpdir(), "guard-test-"));
		try {
			const victim = join(base, "victim");
			mkdirSync(victim);
			const link = join(
				tmpdir(),
				`piha-herdr-lab-${Math.random().toString(36).slice(2, 8).padEnd(6, "x")}`,
			);
			symlinkSync(victim, link);
			try {
				assert.throws(
					() => assertRemovableLabRoot(link, link, realHost),
					/not a real directory/,
				);
			} finally {
				rmSync(link, { force: true });
			}
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("assertRunDir", () => {
	const evidence = "/s/verify";
	const run = "/s/verify/20261030-041853-ab12";

	it("accepts a run dir directly inside the evidence root", () => {
		assertRunDir(run, evidence, fakeHost({ [run]: dirStat() }));
	});

	it("refuses traversal, odd names and other parents", () => {
		for (const bad of [
			"/s/verify/../victim",
			"/s/verify/other",
			"/s/other/20261030-041853-ab12",
			"/s/verify/20261030-041853-ab12/x",
		])
			assert.throws(
				() => assertRunDir(bad, evidence, fakeHost({ [bad]: dirStat() })),
				Error,
				bad,
			);
	});
});

describe("assertMarkerId", () => {
	it("accepts plain ids", () => {
		for (const id of ["c1", "s1", "a_b-C9", "x".repeat(32)])
			assert.equal(assertMarkerId(id), id);
	});

	it("refuses path, shell and oversize ids", () => {
		for (const id of [
			"",
			"../x",
			"a/b",
			"a b",
			"a'b",
			"a;b",
			"-x",
			"$(id)",
			"x".repeat(33),
		])
			assert.throws(() => assertMarkerId(id), /invalid id/, id);
	});
});

describe("defaultEvidenceRoot", () => {
	it("uses an absolute XDG_STATE_HOME and ignores a relative one", () => {
		assert.equal(
			defaultEvidenceRoot({ XDG_STATE_HOME: "/x/state" }),
			"/x/state/pi-herdr-agents/verify",
		);
		assert.match(
			defaultEvidenceRoot({ XDG_STATE_HOME: "rel" }),
			/\.local\/state\/pi-herdr-agents\/verify$/,
		);
		assert.ok(!defaultEvidenceRoot({}).startsWith("/tmp/"));
	});
});
