import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import {
	createPiScriptShellResolver,
	piHasProjectTrustGating,
	piScriptShellDeps,
	resolveProjectTrusted,
} from "../../maestro/adapters/pi/script-shell.ts";
import {
	buildScriptLaunchCommand,
	classifyPaneShell,
	isWslBashLauncher,
	powerShellQuote,
	type PaneShell,
} from "../../maestro/core/script-launch.ts";
import {
	createDefaultRunSession,
	createLaunchSurfaceProvider,
} from "../../maestro/runtime/pi-run-session.ts";
import { writeSubagentSessionPolicy } from "../../maestro/adapters/pi/session.ts";
import type { PiLaunchSnapshot } from "../../maestro/runtime/index.ts";
import { createLaunchPlanner } from "../../pi-extension/subagents/launch.ts";
import { __herdrTest__ } from "../../maestro/surfaces/herdr/herdr.ts";
import { HerdrSurfaceProvider } from "../../maestro/surfaces/herdr/herdr-surface-provider.ts";
import { runScriptInPane } from "../../maestro/surfaces/herdr/terminal.ts";

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const CJK_BASH = "D:\\工具 箱\\王小明's Git\\bin\\bash.exe";
const WIN_SCRIPT = "C:\\Users\\王 小明\\AppData\\Local\\Temp\\cmd-1.sh";
const WSL_BASH = "C:\\Windows\\System32\\bash.exe";

const SCRIPT_UNIX = "/tmp/it's here/cmd-1.sh";
const BARE_UNIX = `bash '/tmp/it'\\''s here/cmd-1.sh'`;

function win(
	paneShell: PaneShell | undefined,
	bash: string | undefined,
	scriptPath = WIN_SCRIPT,
) {
	return buildScriptLaunchCommand({
		scriptPath,
		platform: "win32",
		paneShell,
		resolveShell: () => bash,
	});
}

describe("buildScriptLaunchCommand per pane shell", () => {
	it("calls an absolute bash through PowerShell's & operator", () => {
		assert.equal(
			win("powershell", GIT_BASH),
			`& 'C:\\Program Files\\Git\\bin\\bash.exe' 'C:\\Users\\王 小明\\AppData\\Local\\Temp\\cmd-1.sh'`,
		);
	});

	it("keeps spaces, CJK characters and quotes intact for PowerShell", () => {
		assert.equal(
			win("powershell", CJK_BASH),
			`& 'D:\\工具 箱\\王小明''s Git\\bin\\bash.exe' 'C:\\Users\\王 小明\\AppData\\Local\\Temp\\cmd-1.sh'`,
		);
		// PowerShell also ends a literal at typographic single quotes.
		assert.equal(powerShellQuote("a‘b’c‚d‛e"), "'a‘‘b’’c‚‚d‛‛e'");
	});

	it("double-quotes both paths for cmd.exe", () => {
		assert.equal(
			win("cmd", CJK_BASH),
			`"D:\\工具 箱\\王小明's Git\\bin\\bash.exe" "C:\\Users\\王 小明\\AppData\\Local\\Temp\\cmd-1.sh"`,
		);
	});

	it("refuses a cmd.exe line whose path cmd would expand", () => {
		for (const bad of [
			"C:\\a%PATH%\\bash.exe",
			"C:\\a!x!\\bash.exe",
			'C:\\a"b\\bash.exe',
		]) {
			assert.throws(() => win("cmd", bad), /cmd\.exe pane.*", % or !/s);
			assert.throws(() => win("cmd", GIT_BASH, bad), /cmd\.exe pane/);
		}
		// The same paths are fine for the shells that do not expand them.
		assert.match(win("powershell", "C:\\a%PATH%\\bash.exe"), /^& /);
		assert.match(win("posix", "C:\\a!x!\\bash.exe"), /^'C:/);
	});

	it("POSIX-quotes the Windows paths for Git Bash and sh", () => {
		assert.equal(
			win("posix", CJK_BASH),
			`'D:\\工具 箱\\王小明'\\''s Git\\bin\\bash.exe' 'C:\\Users\\王 小明\\AppData\\Local\\Temp\\cmd-1.sh'`,
		);
	});

	it("keeps the old bare line for an unknown shell and never resolves bash", () => {
		const resolveShell = () => {
			throw new Error("must not resolve without a known pane shell");
		};
		for (const paneShell of [undefined]) {
			assert.equal(
				buildScriptLaunchCommand({
					scriptPath: SCRIPT_UNIX,
					platform: "win32",
					paneShell,
					resolveShell,
				}),
				BARE_UNIX,
			);
		}
	});

	it("fails clearly once an absolute path would be typed and no bash resolves", () => {
		for (const paneShell of ["powershell", "cmd"] as const) {
			assert.throws(
				() => win(paneShell, undefined),
				/No bash found.*shellPath/s,
			);
			assert.throws(
				() =>
					buildScriptLaunchCommand({
						scriptPath: WIN_SCRIPT,
						platform: "win32",
						paneShell,
					}),
				/No bash found/,
			);
		}
	});

	it("refuses the WSL launcher and says how to point shellPath at Git", () => {
		for (const wsl of [WSL_BASH, "c:/windows/sysnative/BASH.EXE"]) {
			for (const paneShell of ["powershell", "cmd"] as const) {
				assert.throws(
					() => win(paneShell, wsl),
					/WSL launcher.*shellPath.*Scoop or MSYS2.*LOCALAPPDATA/s,
				);
			}
		}
	});

	it("keeps the bare line in a Git Bash pane when no usable bash resolves", () => {
		const bare = `bash '${WIN_SCRIPT}'`;
		assert.equal(win("posix", undefined), bare);
		assert.equal(win("posix", WSL_BASH), bare);
		assert.equal(
			buildScriptLaunchCommand({
				scriptPath: WIN_SCRIPT,
				platform: "win32",
				paneShell: "posix",
			}),
			bare,
		);
		assert.equal(
			buildScriptLaunchCommand({
				scriptPath: WIN_SCRIPT,
				platform: "win32",
				paneShell: "posix",
				resolveShell: () => {
					throw new Error("No bash shell found.");
				},
			}),
			bare,
		);
		// PowerShell and cmd panes would hit WSL or nothing, so they still refuse.
		for (const paneShell of ["powershell", "cmd"] as const) {
			assert.throws(
				() =>
					buildScriptLaunchCommand({
						scriptPath: WIN_SCRIPT,
						platform: "win32",
						paneShell,
						resolveShell: () => {
							throw new Error("No bash shell found.");
						},
					}),
				/No bash shell found/,
			);
		}
	});

	it("leaves darwin and linux as a bare bash and never resolves a shell", () => {
		for (const platform of ["darwin", "linux"] as const) {
			for (const paneShell of [
				undefined,
				"powershell",
				"cmd",
				"posix",
			] as const) {
				assert.equal(
					buildScriptLaunchCommand({
						scriptPath: SCRIPT_UNIX,
						platform,
						paneShell,
						resolveShell: () => {
							throw new Error("must not resolve off Windows");
						},
					}),
					BARE_UNIX,
				);
			}
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

describe("classifyPaneShell", () => {
	it("maps the process names Windows Herdr reports", () => {
		assert.equal(classifyPaneShell("powershell.exe"), "powershell");
		assert.equal(classifyPaneShell("pwsh.exe"), "powershell");
		assert.equal(classifyPaneShell("PWSH"), "powershell");
		assert.equal(classifyPaneShell("cmd.exe"), "cmd");
		assert.equal(classifyPaneShell("bash.exe"), "posix");
		assert.equal(classifyPaneShell("sh.exe"), "posix");
		assert.equal(
			classifyPaneShell("C:\\Program Files\\Git\\bin\\bash.exe"),
			"posix",
		);
	});

	it("leaves everything else unknown", () => {
		for (const name of [
			"nu.exe",
			"zsh.exe",
			"fish",
			"",
			undefined,
			"cmd.exe.bak",
		]) {
			assert.equal(classifyPaneShell(name), undefined);
		}
	});
});

describe("createPiScriptShellResolver", () => {
	const context = { cwd: "C:\\proj", projectTrusted: true };

	it("resolves through Pi's shellPath setting for the launch context", () => {
		const seen: unknown[] = [];
		const resolve = createPiScriptShellResolver(context, {
			readShellPath: (c) => {
				seen.push(c);
				return CJK_BASH;
			},
			resolveShell: (shellPath) => ({ shell: shellPath ?? "" }),
			baseDir: () => "/unused",
		});
		assert.equal(resolve(), CJK_BASH);
		assert.deepEqual(seen, [context]);
	});

	it("makes a relative shellPath absolute against the directory Pi resolves it from", () => {
		const base = mkdtempSync(join(tmpdir(), "script-shell-base-"));
		try {
			const resolve = createPiScriptShellResolver(context, {
				readShellPath: () => join("tools", "bash"),
				resolveShell: (shellPath) => ({ shell: shellPath ?? "" }),
				baseDir: () => base,
			});
			assert.equal(resolve(), join(base, "tools", "bash"));
			// Pi's own default base is the process cwd.
			assert.equal(piScriptShellDeps.baseDir(), process.cwd());
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("leaves absolute Windows and POSIX paths untouched", () => {
		for (const shell of [GIT_BASH, CJK_BASH, "/usr/bin/bash"]) {
			const resolve = createPiScriptShellResolver(context, {
				readShellPath: () => shell,
				resolveShell: (shellPath) => ({ shell: shellPath ?? "" }),
				baseDir: () => "/elsewhere",
			});
			assert.equal(resolve(), shell);
		}
	});

	it("falls back to Pi's own discovery when shellPath is unset", () => {
		const resolve = createPiScriptShellResolver(context, {
			readShellPath: () => undefined,
			resolveShell: (shellPath) => {
				assert.equal(shellPath, undefined);
				return { shell: GIT_BASH };
			},
			baseDir: () => "/unused",
		});
		assert.equal(resolve(), GIT_BASH);
	});

	it("lets Pi's error through when no bash exists", () => {
		const resolve = createPiScriptShellResolver(context, {
			readShellPath: () => undefined,
			resolveShell: () => {
				throw new Error("No bash shell found.");
			},
			baseDir: () => "/unused",
		});
		assert.throws(resolve, /No bash shell found/);
	});
});

/** A temp agent dir plus a project whose `.pi/settings.json` sets shellPath. */
async function withSettingsFixture<T>(
	run: (fixture: {
		project: string;
		globalBash: string;
		projectBash: string;
	}) => T,
): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "script-shell-"));
	const saved = process.env.PI_CODING_AGENT_DIR;
	try {
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(project, ".pi"), { recursive: true });
		const globalBash = join(root, "global-bash");
		const projectBash = join(root, "project-bash");
		writeFileSync(globalBash, "");
		writeFileSync(projectBash, "");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ shellPath: globalBash }),
		);
		writeFileSync(
			join(project, ".pi", "settings.json"),
			JSON.stringify({ shellPath: projectBash }),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		return await run({ project, globalBash, projectBash });
	} finally {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
		rmSync(root, { recursive: true, force: true });
	}
}

describe("Pi shellPath settings and project trust", () => {
	const deps = {
		...piScriptShellDeps,
		resolveShell: (shellPath?: string) => ({
			shell: shellPath ?? "pi-discovery",
		}),
	};

	it("uses the project's shellPath only when the project is trusted", async () => {
		await withSettingsFixture(({ project, globalBash, projectBash }) => {
			assert.equal(
				createPiScriptShellResolver(
					{ cwd: project, projectTrusted: true },
					deps,
				)(),
				projectBash,
			);
			assert.equal(
				createPiScriptShellResolver(
					{ cwd: project, projectTrusted: false },
					deps,
				)(),
				globalBash,
			);
		});
	});

	it("reads the launching session's cwd, not the process cwd", async () => {
		await withSettingsFixture(({ project, globalBash, projectBash }) => {
			const elsewhere = mkdtempSync(join(tmpdir(), "script-shell-else-"));
			try {
				assert.equal(
					createPiScriptShellResolver(
						{ cwd: elsewhere, projectTrusted: true },
						deps,
					)(),
					globalBash,
				);
				assert.equal(
					createPiScriptShellResolver(
						{ cwd: project, projectTrusted: true },
						deps,
					)(),
					projectBash,
				);
			} finally {
				rmSync(elsewhere, { recursive: true, force: true });
			}
		});
	});
});

interface FakeHerdr {
	runCommands: string[];
	processInfoCalls: number;
}

/** Pane `process-info` for a Windows pane whose shell is `shellName`. */
function windowsProcessInfo(shellName: string | undefined): string {
	return JSON.stringify({
		result: {
			process_info: {
				pane_id: "p1",
				shell_pid: 4242,
				foreground_process_group_id: 4242,
				foreground_processes:
					shellName === undefined
						? []
						: [
								{
									pid: 99,
									name: "conhost.exe",
									argv0: "conhost.exe",
									cmdline: "bash.exe -lc x",
								},
								{ pid: 4242, name: shellName, argv0: shellName },
							],
			},
		},
	});
}

async function withFakeHerdr<T>(
	processInfo: () => string,
	run: (herdr: FakeHerdr) => Promise<T>,
): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "script-launch-"));
	const bin = join(dir, "herdr");
	writeFileSync(bin, "#!/bin/sh\nexit 0\n");
	chmodSync(bin, 0o755);
	const saved = { env: process.env.HERDR_ENV, path: process.env.PATH };
	process.env.HERDR_ENV = "1";
	process.env.PATH = `${dir}${delimiter}${saved.path ?? ""}`;
	const herdr: FakeHerdr = { runCommands: [], processInfoCalls: 0 };
	try {
		return await __herdrTest__.withMockHerdrExec(
			(args) => {
				if (args[0] === "pane" && args[1] === "run")
					herdr.runCommands.push(args[3]!);
				if (args[0] === "pane" && args[1] === "process-info") {
					herdr.processInfoCalls++;
					return processInfo();
				}
				return "";
			},
			() => run(herdr),
		);
	} finally {
		if (saved.env === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = saved.env;
		process.env.PATH = saved.path;
		rmSync(dir, { recursive: true, force: true });
	}
}

function tempScript(label: string): string {
	return join(tmpdir(), `script-launch-${process.pid}-${label}.sh`);
}

describe("runScriptInPane launch command", () => {
	const winShells: Array<[string, (bash: string, script: string) => string]> = [
		["powershell.exe", (b, s) => `& '${b}' '${s}'`],
		["pwsh.exe", (b, s) => `& '${b}' '${s}'`],
		["cmd.exe", (b, s) => `"${b}" "${s}"`],
		["bash.exe", (b, s) => `'${b}' '${s}'`],
		["sh.exe", (b, s) => `'${b}' '${s}'`],
	];

	for (const [shell, expected] of winShells) {
		it(`types the ${shell} form on win32`, async () => {
			await withFakeHerdr(
				() => windowsProcessInfo(shell),
				async ({ runCommands }) => {
					const scriptPath = tempScript(shell);
					try {
						await runScriptInPane("p1", "echo hi", {
							scriptPath,
							platform: "win32",
							resolveShell: () => GIT_BASH,
						});
						assert.deepEqual(runCommands, [expected(GIT_BASH, scriptPath)]);
						assert.match(
							readFileSync(scriptPath, "utf8"),
							/^#!\/bin\/bash\necho hi\n$/,
						);
					} finally {
						rmSync(scriptPath, { force: true });
					}
				},
			);
		});
	}

	it("picks the pane shell by shell_pid, never by cmdline", async () => {
		await withFakeHerdr(
			// A foreground process named like a shell must not be taken for the shell.
			() =>
				JSON.stringify({
					result: {
						process_info: {
							pane_id: "p1",
							shell_pid: 4242,
							foreground_processes: [
								{ pid: 7, name: "cmd.exe", argv0: "cmd.exe" },
								{
									pid: 4242,
									name: "powershell.exe",
									cmdline: "cmd.exe /c bash.exe",
								},
							],
						},
					},
				}),
			async ({ runCommands }) => {
				const scriptPath = tempScript("pid");
				try {
					await runScriptInPane("p1", "echo hi", {
						scriptPath,
						platform: "win32",
						resolveShell: () => GIT_BASH,
					});
					assert.deepEqual(runCommands, [`& '${GIT_BASH}' '${scriptPath}'`]);
				} finally {
					rmSync(scriptPath, { force: true });
				}
			},
		);
	});

	for (const [label, info] of [
		["an unknown shell", () => windowsProcessInfo("nu.exe")],
		["no foreground processes", () => windowsProcessInfo(undefined)],
		["unusable process info", () => "not json"],
	] as const) {
		it(`keeps the bare bash line on win32 for ${label}, without resolving bash`, async () => {
			await withFakeHerdr(info, async ({ runCommands }) => {
				const scriptPath = tempScript("unknown");
				try {
					await runScriptInPane("p1", "echo hi", {
						scriptPath,
						platform: "win32",
						resolveShell: () => {
							throw new Error("must not resolve for an unknown shell");
						},
					});
					assert.deepEqual(runCommands, [`bash '${scriptPath}'`]);
				} finally {
					rmSync(scriptPath, { force: true });
				}
			});
		});
	}

	it("dispatches nothing and writes no script when a known shell has no bash", async () => {
		await withFakeHerdr(
			() => windowsProcessInfo("powershell.exe"),
			async ({ runCommands }) => {
				const scriptPath = tempScript("none");
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
			},
		);
	});

	it("keeps `bash <script>` on darwin and linux without asking Herdr for the shell", async () => {
		for (const platform of ["darwin", "linux"] as const) {
			await withFakeHerdr(
				() => windowsProcessInfo("cmd.exe"),
				async (herdr) => {
					const scriptPath = tempScript(platform);
					try {
						await runScriptInPane("p1", "echo hi", { scriptPath, platform });
						assert.deepEqual(herdr.runCommands, [`bash '${scriptPath}'`]);
						assert.equal(herdr.processInfoCalls, 0);
					} finally {
						rmSync(scriptPath, { force: true });
					}
				},
			);
		}
	});

	it("routes HerdrSurfaceProvider.runScript through its injected resolver", async () => {
		await withFakeHerdr(
			() => windowsProcessInfo("powershell.exe"),
			async ({ runCommands }) => {
				const scriptPath = tempScript("prov");
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
			},
		);
	});
});

describe("launch composition on Windows", () => {
	const paneConfig = {
		mode: "grouped",
		direction: "down",
		maxPerTab: 2,
	} as const;

	function snapshot(overrides: Partial<PiLaunchSnapshot>): PiLaunchSnapshot {
		return {
			parent: {
				cwd: "/unused",
				sessionFile: "",
				sessionId: "s",
				sessionDir: "",
			},
			// SAFETY: the Windows script path never reads the model registry.
			modelRegistry: {} as PiLaunchSnapshot["modelRegistry"],
			paneConfig,
			...overrides,
		};
	}

	async function typedLine(launch: PiLaunchSnapshot, shell = "powershell.exe") {
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			return await withFakeHerdr(
				() => windowsProcessInfo(shell),
				async ({ runCommands }) => {
					const scriptPath = tempScript("compose");
					try {
						await createLaunchSurfaceProvider(launch).runScript(
							"p1",
							"echo hi",
							{
								scriptPath,
								scriptPreamble: "",
							},
						);
						return runCommands[0]!;
					} finally {
						rmSync(scriptPath, { force: true });
					}
				},
			);
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
	}

	it("types the bash Pi resolves for the launching session's trusted project", async () => {
		await withSettingsFixture(async ({ project, projectBash }) => {
			const line = await typedLine(
				snapshot({ scriptShell: { cwd: project, projectTrusted: true } }),
			);
			assert.match(line, new RegExp(`^& '${projectBash}' `));
		});
	});

	it("ignores an untrusted project's shellPath, and a snapshot without trust data", async () => {
		await withSettingsFixture(async ({ project, globalBash }) => {
			for (const launch of [
				snapshot({ scriptShell: { cwd: project, projectTrusted: false } }),
				snapshot({
					parent: {
						cwd: project,
						sessionFile: "",
						sessionId: "s",
						sessionDir: "",
					},
				}),
			]) {
				const line = await typedLine(launch);
				assert.match(line, new RegExp(`^& '${globalBash}' `));
				assert.doesNotMatch(line, /project-bash/);
			}
		});
	});

	it("types the resolved bash when the default run session resumes a child", async () => {
		await withSettingsFixture(async ({ project, projectBash }) => {
			const dir = mkdtempSync(join(tmpdir(), "script-launch-session-"));
			const proto = HerdrSurfaceProvider.prototype;
			const original = {
				createSurface: proto.createSurface,
				waitForShellReady: proto.waitForShellReady,
				closeSurface: proto.closeSurface,
				waitForSurfaceAbsence: proto.waitForSurfaceAbsence,
				runScript: proto.runScript,
			};
			let outcome: unknown;
			// Only the pane plumbing is stubbed; runScript stays real and the
			// typed line is read from the fake Herdr.
			proto.createSurface = async () => "p1";
			proto.waitForShellReady = async () => {};
			proto.closeSurface = async () => {};
			proto.waitForSurfaceAbsence = async () => {};
			proto.runScript = async function (...args) {
				await original.runScript.apply(this, args);
				throw new Error("stop after the script was typed");
			};
			const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
			Object.defineProperty(process, "platform", { value: "win32" });
			try {
				const sessionFile = join(dir, "resume.jsonl");
				writeFileSync(
					sessionFile,
					JSON.stringify({ type: "session", cwd: dir }) + "\n",
				);
				writeSubagentSessionPolicy(sessionFile, {
					owner: "public",
					deniedTools: [],
				});
				const session = createDefaultRunSession({
					configDir: dir,
					configExamplePath: new URL(
						"../../config.json.example",
						import.meta.url,
					).pathname,
					forcePolling: false,
					roles: [],
					getLaunchSnapshot: () =>
						snapshot({
							parent: {
								cwd: project,
								sessionFile,
								sessionId: "s",
								sessionDir: join(dir, "sessions"),
							},
							scriptShell: { cwd: project, projectTrusted: true },
						}),
					hooks: { onSettled() {} },
					persistent: {
						send: () => ({ error: "unused" }),
						stop: () => ({ error: "unused" }),
						drain() {},
					},
				});
				await withFakeHerdr(
					() => windowsProcessInfo("powershell.exe"),
					async ({ runCommands }) => {
						outcome = await session
							.resumePi({ taskId: "t1", sessionPath: sessionFile, name: "r" })
							.then(
								() => "resolved",
								(error: Error) => error.message,
							);
						assert.equal(runCommands.length, 1, String(outcome));
						assert.match(runCommands[0]!, new RegExp(`^& '${projectBash}' `));
					},
				);
			} finally {
				Object.assign(proto, original);
				Object.defineProperty(process, "platform", platform);
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	it("builds the snapshot's trust data from the launching context", () => {
		// SAFETY: building a snapshot touches only the context below, never the
		// planner's runtime or model config.
		const { launchSnapshot } = createLaunchPlanner({
			runtime: {} as never,
			modelConfig: {} as never,
			paneConfig,
		});
		const ctx = (isProjectTrusted?: () => boolean) =>
			// SAFETY: the stub carries every ExtensionContext member launchSnapshot reads.
			({
				cwd: "/session/cwd",
				sessionManager: {
					getSessionFile: () => "f",
					getSessionId: () => "s",
					getSessionDir: () => "d",
				},
				modelRegistry: {
					find: () => undefined,
					getAvailable: () => [],
					getAll: () => [],
				},
				isProjectTrusted,
			}) as never;
		assert.deepEqual(launchSnapshot(ctx(() => false)).scriptShell, {
			cwd: "/session/cwd",
			projectTrusted: false,
		});
		assert.deepEqual(launchSnapshot(ctx(() => true)).scriptShell, {
			cwd: "/session/cwd",
			projectTrusted: true,
		});
		// A context that cannot report the decision follows this Pi's gating.
		assert.equal(
			launchSnapshot(ctx()).scriptShell?.projectTrusted,
			!piHasProjectTrustGating(),
		);
	});

	it("treats an unreported trust decision as untrusted wherever Pi gates project settings", () => {
		// pi 0.79.0: the gate exists, `ctx.isProjectTrusted` does not.
		assert.equal(resolveProjectTrusted(undefined, true), false);
		// pi 0.74 to 0.78: no trust concept, project settings always load.
		assert.equal(resolveProjectTrusted(undefined, false), true);
		// A reported decision always wins.
		for (const gating of [true, false]) {
			assert.equal(resolveProjectTrusted(true, gating), true);
			assert.equal(resolveProjectTrusted(false, gating), false);
		}
	});

	it("detects trust gating from the installed Pi SDK", () => {
		assert.equal(piHasProjectTrustGating(), true);
	});
});
