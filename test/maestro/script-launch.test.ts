import "../clean-host-env.ts";
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
import { delimiter, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createDefaultRunSession } from "@nubl/maestro/runtime/pi-run-session";
import {
	createLaunchSurfaceProvider,
	hostSurfaceBinding,
} from "../../pi-extension/subagents/host-surface.ts";
import { writeSubagentSessionPolicy } from "@nubl/maestro/adapters/pi/session";
import type { PiLaunchSnapshot } from "@nubl/maestro/runtime";
import { __herdrTest__ } from "../../maestro/surfaces/herdr/herdr.ts";
import { HerdrSurfaceProvider } from "../../maestro/surfaces/herdr/herdr-surface-provider.ts";
import { runScriptInPane } from "../../maestro/surfaces/herdr/terminal.ts";

/** A path is literal text in an expected pattern: `\\` and `.` must not be syntax. */
const escapeRegExp = (value: string) =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

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
	// Some tests stub process.platform to "win32" before this runs. The host
	// then looks for herdr.exe on a ';'-split PATH, so the fake has to follow
	// whatever platform the host will see, not the one the test runs on.
	const windows = process.platform === "win32";
	const bin = join(dir, windows ? "herdr.exe" : "herdr");
	writeFileSync(bin, "#!/bin/sh\nexit 0\n");
	chmodSync(bin, 0o755);
	const saved = { env: process.env.HERDR_ENV, path: process.env.PATH };
	process.env.HERDR_ENV = "1";
	process.env.PATH = `${dir}${windows ? win32.delimiter : delimiter}${saved.path ?? ""}`;
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
			assert.match(line, new RegExp(`^& '${escapeRegExp(projectBash)}' `));
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
				assert.match(line, new RegExp(`^& '${escapeRegExp(globalBash)}' `));
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
					hostSurface: hostSurfaceBinding,
					configDir: dir,
					configExamplePath: fileURLToPath(
						new URL("../../config.json.example", import.meta.url),
					),
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
						assert.match(
							runCommands[0]!,
							new RegExp(`^& '${escapeRegExp(projectBash)}' `),
						);
					},
				);
			} finally {
				Object.assign(proto, original);
				Object.defineProperty(process, "platform", platform);
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
