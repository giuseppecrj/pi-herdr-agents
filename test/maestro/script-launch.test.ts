import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { createPiScriptShellResolver } from "../../maestro/adapters/pi/script-shell.ts";
import {
	buildScriptLaunchCommand,
	isWslBashLauncher,
	powerShellQuote,
} from "../../maestro/core/script-launch.ts";
import { __herdrTest__ } from "../../maestro/surfaces/herdr/herdr.ts";
import { HerdrSurfaceProvider } from "../../maestro/surfaces/herdr/herdr-surface-provider.ts";
import { runScriptInPane } from "../../maestro/surfaces/herdr/terminal.ts";

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const CJK_BASH = "D:\\工具 箱\\王小明's Git\\bin\\bash.exe";
const WIN_SCRIPT = "C:\\Users\\王 小明\\AppData\\Local\\Temp\\cmd-1.sh";
const WSL_BASH = "C:\\Windows\\System32\\bash.exe";

describe("buildScriptLaunchCommand", () => {
	it("calls an absolute bash through PowerShell's & operator on win32", () => {
		assert.equal(
			buildScriptLaunchCommand({
				scriptPath: WIN_SCRIPT,
				platform: "win32",
				resolveShell: () => GIT_BASH,
			}),
			`& 'C:\\Program Files\\Git\\bin\\bash.exe' 'C:\\Users\\王 小明\\AppData\\Local\\Temp\\cmd-1.sh'`,
		);
	});

	it("keeps spaces, CJK characters and apostrophes intact on win32", () => {
		assert.equal(
			buildScriptLaunchCommand({
				scriptPath: WIN_SCRIPT,
				platform: "win32",
				resolveShell: () => CJK_BASH,
			}),
			`& 'D:\\工具 箱\\王小明''s Git\\bin\\bash.exe' 'C:\\Users\\王 小明\\AppData\\Local\\Temp\\cmd-1.sh'`,
		);
	});

	it("fails clearly on win32 when no bash resolves", () => {
		assert.throws(
			() =>
				buildScriptLaunchCommand({
					scriptPath: WIN_SCRIPT,
					platform: "win32",
					resolveShell: () => undefined,
				}),
			/No bash found.*shellPath/s,
		);
		assert.throws(
			() =>
				buildScriptLaunchCommand({ scriptPath: WIN_SCRIPT, platform: "win32" }),
			/No bash found/,
		);
	});

	it("refuses the WSL launcher instead of running the script in WSL", () => {
		for (const wsl of [WSL_BASH, "c:/windows/sysnative/BASH.EXE"]) {
			assert.throws(
				() =>
					buildScriptLaunchCommand({
						scriptPath: WIN_SCRIPT,
						platform: "win32",
						resolveShell: () => wsl,
					}),
				/WSL/,
			);
		}
	});

	it("leaves darwin and linux as a bare bash and never resolves a shell", () => {
		for (const platform of ["darwin", "linux"] as const) {
			assert.equal(
				buildScriptLaunchCommand({
					scriptPath: "/tmp/it's here/cmd-1.sh",
					platform,
					resolveShell: () => {
						throw new Error("must not resolve off Windows");
					},
				}),
				`bash '/tmp/it'\\''s here/cmd-1.sh'`,
			);
		}
	});

	it("recognises only the WSL launcher paths", () => {
		assert.equal(isWslBashLauncher(WSL_BASH), true);
		assert.equal(isWslBashLauncher("C:/Windows/Sysnative/bash.exe"), true);
		assert.equal(isWslBashLauncher(GIT_BASH), false);
		assert.equal(isWslBashLauncher("C:\\Windows\\System32\\bash.cmd"), false);
	});

	it("quotes PowerShell literals by doubling single quotes", () => {
		assert.equal(powerShellQuote("a'b"), "'a''b'");
	});
});

describe("createPiScriptShellResolver", () => {
	it("resolves through Pi's shellPath setting", () => {
		const seen: Array<string | undefined> = [];
		const resolve = createPiScriptShellResolver({
			readShellPath: () => CJK_BASH,
			resolveShell: (shellPath) => {
				seen.push(shellPath);
				return { shell: shellPath ?? "" };
			},
		});
		assert.equal(resolve(), CJK_BASH);
		assert.deepEqual(seen, [CJK_BASH]);
	});

	it("falls back to Pi's own discovery when shellPath is unset", () => {
		const resolve = createPiScriptShellResolver({
			readShellPath: () => undefined,
			resolveShell: (shellPath) => {
				assert.equal(shellPath, undefined);
				return { shell: GIT_BASH };
			},
		});
		assert.equal(resolve(), GIT_BASH);
	});

	it("lets Pi's error through when no bash exists", () => {
		const resolve = createPiScriptShellResolver({
			readShellPath: () => undefined,
			resolveShell: () => {
				throw new Error("No bash shell found.");
			},
		});
		assert.throws(resolve, /No bash shell found/);
	});
});

async function withFakeHerdr<T>(
	run: (runCommands: string[]) => Promise<T>,
): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "script-launch-"));
	const bin = join(dir, "herdr");
	writeFileSync(bin, "#!/bin/sh\nexit 0\n");
	chmodSync(bin, 0o755);
	const saved = { env: process.env.HERDR_ENV, path: process.env.PATH };
	process.env.HERDR_ENV = "1";
	process.env.PATH = `${dir}${delimiter}${saved.path ?? ""}`;
	const runCommands: string[] = [];
	try {
		return await __herdrTest__.withMockHerdrExec(
			(args) => {
				if (args[0] === "pane" && args[1] === "run") runCommands.push(args[3]!);
				return "";
			},
			() => run(runCommands),
		);
	} finally {
		if (saved.env === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = saved.env;
		process.env.PATH = saved.path;
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("runScriptInPane launch command", () => {
	it("types the absolute-bash PowerShell call on win32", async () => {
		await withFakeHerdr(async (runCommands) => {
			const scriptPath = join(tmpdir(), `script-launch-${process.pid}-win.sh`);
			try {
				await runScriptInPane("p1", "echo hi", {
					scriptPath,
					platform: "win32",
					resolveShell: () => CJK_BASH,
				});
				assert.deepEqual(runCommands, [
					`& 'D:\\工具 箱\\王小明''s Git\\bin\\bash.exe' '${scriptPath}'`,
				]);
				assert.match(
					readFileSync(scriptPath, "utf8"),
					/^#!\/bin\/bash\necho hi\n$/,
				);
			} finally {
				rmSync(scriptPath, { force: true });
			}
		});
	});

	it("dispatches nothing and writes no script when win32 has no bash", async () => {
		await withFakeHerdr(async (runCommands) => {
			const scriptPath = join(tmpdir(), `script-launch-${process.pid}-none.sh`);
			await assert.rejects(
				() =>
					runScriptInPane("p1", "echo hi", {
						scriptPath,
						platform: "win32",
						resolveShell: () => undefined,
					}),
				/No bash found/,
			);
			assert.deepEqual(runCommands, []);
			assert.equal(existsSync(scriptPath), false);
		});
	});

	it("keeps `bash <script>` on darwin and linux", async () => {
		for (const platform of ["darwin", "linux"] as const) {
			await withFakeHerdr(async (runCommands) => {
				const scriptPath = join(
					tmpdir(),
					`script-launch-${process.pid}-${platform}.sh`,
				);
				try {
					await runScriptInPane("p1", "echo hi", { scriptPath, platform });
					assert.deepEqual(runCommands, [`bash '${scriptPath}'`]);
				} finally {
					rmSync(scriptPath, { force: true });
				}
			});
		}
	});

	it("routes HerdrSurfaceProvider.runScript through its injected resolver", async () => {
		await withFakeHerdr(async (runCommands) => {
			const scriptPath = join(tmpdir(), `script-launch-${process.pid}-prov.sh`);
			try {
				const provider = new HerdrSurfaceProvider({
					paneConfig: { mode: "grouped", direction: "down", maxPerTab: 2 },
					platform: "win32",
					resolveScriptShell: () => GIT_BASH,
				});
				await provider.runScript("p1", "echo hi", {
					scriptPath,
					scriptPreamble: "",
				});
				assert.deepEqual(runCommands, [`& '${GIT_BASH}' '${scriptPath}'`]);
			} finally {
				rmSync(scriptPath, { force: true });
			}
		});
	});
});
