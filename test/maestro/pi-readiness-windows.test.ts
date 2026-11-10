import assert from "node:assert/strict";
import { test } from "node:test";
import { isExpectedPiProcess } from "../../maestro/adapters/pi/launch-operations.ts";

const SESSION = "C:\\Users\\dev\\.pi\\agent\\sessions\\child.jsonl";
const CWD = "D:\\source\\repo";

// The entrypoint a managed Pi install runs: the package's `bin`.
const PI_CLI =
	"C:\\Users\\dev\\.pi\\agent\\install\\releases\\1.5.0\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js";

// Shape of `herdr pane process-info` for a live Pi on Windows (herdr 0.9.5):
// the process is node.exe, argv is the real command line, and cwd ends in `\`.
const live = {
	pid: 36804,
	name: "node.exe",
	argv0: "C:\\nvm4w\\nodejs\\node.exe",
	argv: [
		"C:\\nvm4w\\nodejs\\node.exe",
		PI_CLI,
		"--session",
		SESSION,
		"--model",
		"x",
	],
	cwd: `${CWD}\\`,
};

type Reported = Omit<typeof live, "argv" | "cwd"> & {
	argv?: string[];
	cwd?: string;
};

// Windows has no /proc: reading the environment must never be attempted.
const noEnvironment = () => {
	throw new Error("process environment is unreadable on win32");
};

const windows = (process: Reported, session = SESSION, cwd = CWD) =>
	isExpectedPiProcess(process, session, cwd, noEnvironment, "win32");

test("Windows readiness recognises the launched Pi by its --session argument", () => {
	assert.equal(windows(live), true);
});

test("Windows readiness ignores separator style, case and a trailing backslash", () => {
	assert.equal(
		windows(
			{
				...live,
				argv: [...live.argv.slice(0, 3), SESSION.replaceAll("\\", "/")],
				cwd: "d:/SOURCE/repo/",
			},
			SESSION.toUpperCase(),
		),
		true,
	);
	assert.equal(windows({ ...live, cwd: "D:\\source\\repo\\\\" }), true);
});

test("Windows readiness takes Pi's runtime from argv[0], whatever name Herdr reports", () => {
	for (const name of ["node.exe", "pi.exe", "bun.exe", "NODE.EXE"])
		assert.equal(windows({ ...live, name }), true, name);
});

test("Windows readiness accepts node options before the entrypoint, and a compiled pi.exe", () => {
	const node = live.argv[0]!;
	const withOptions = [
		node,
		"--no-warnings",
		"--require",
		"C:\\hooks\\trace.cjs",
		"--import=file:///C:/hooks/x.mjs",
		PI_CLI,
		"--session",
		SESSION,
	];
	assert.equal(windows({ ...live, argv: withOptions }), true);
	const compiled = ["C:\\tools\\pi.exe", "--session", SESSION];
	assert.equal(windows({ ...live, name: "pi.exe", argv: compiled }), true);
	const bun = ["C:\\bun\\bun.exe", "run", PI_CLI, "--session", SESSION];
	assert.equal(windows({ ...live, name: "bun.exe", argv: bun }), true);
});

test("Windows readiness rejects the launcher wrappers that forward --session before Pi starts", () => {
	const node = live.argv[0]!;
	const forwarded = ["--session", SESSION, "--model", "x"];
	const wrappers = {
		// npm's POSIX shim run by Git for Windows' sh
		"sh shim": [
			"C:\\Program Files\\Git\\usr\\bin\\sh.exe",
			"C:\\npm\\pi",
			...forwarded,
		],
		"bash shim": [
			"C:\\Program Files\\Git\\bin\\bash.exe",
			"C:\\npm\\pi",
			...forwarded,
		],
		"cmd shim": [
			"C:\\Windows\\System32\\cmd.exe",
			"/c",
			"C:\\npm\\pi.cmd",
			...forwarded,
		],
		powershell: ["powershell.exe", "-File", "C:\\npm\\pi.ps1", ...forwarded],
		// the managed install's node launcher, which spawns the real Pi as a child
		"node launcher": [
			node,
			"C:\\Users\\dev\\.pi\\agent\\bin\\pi-launcher.js",
			...forwarded,
		],
		"another node script": [node, "C:\\other\\other.js", ...forwarded],
		"node eval": [node, "-e", "setTimeout(() => {}, 1e9)", ...forwarded],
		"no entrypoint at all": [node, ...forwarded],
	} satisfies Record<string, string[]>;
	for (const [label, argv] of Object.entries(wrappers))
		assert.equal(windows({ ...live, name: "node.exe", argv }), false, label);
	// Herdr's reported name must not rescue a wrapper either.
	assert.equal(
		windows({ ...live, name: "node.exe", argv: wrappers["sh shim"] }),
		false,
	);
});

test("Windows readiness needs --session to be an argument to Pi, not to the runtime or a script it loads before", () => {
	const node = live.argv[0]!;
	assert.equal(
		windows({ ...live, argv: [node, "--session", SESSION, PI_CLI] }),
		false,
	);
});

test("Windows readiness rejects another session, another cwd and missing evidence", () => {
	const rejected: Reported[] = [
		{
			...live,
			argv: [...live.argv.slice(0, 2), "--session", "C:\\other\\child.jsonl"],
		},
		{ ...live, cwd: "D:\\source\\elsewhere\\" },
		{ ...live, argv: ["C:\\nvm4w\\nodejs\\node.exe", "C:\\pi\\cli.js"] },
		{ ...live, argv: [...live.argv.slice(0, 2), "--session"] },
		{ ...live, argv: undefined },
		{ ...live, cwd: undefined },
	];
	for (const process of rejected)
		assert.equal(windows(process), false, JSON.stringify(process));
});

test("Windows readiness keeps a filesystem root comparable", () => {
	assert.equal(windows({ ...live, cwd: "C:\\" }, SESSION, "c:/"), true);
});

test("outside Windows, argv alone is still not readiness evidence", () => {
	const environments = new Map([
		[42, new Map([["PI_HERDR_AGENTS_SESSION", "/tmp/child.jsonl"]])],
	]);
	const read = (pid: number) => environments.get(pid);
	const rewritten = { pid: 42, name: "pi", argv: ["pi"], cwd: "/repo" };
	assert.equal(
		isExpectedPiProcess(rewritten, "/tmp/child.jsonl", "/repo", read, "linux"),
		true,
	);
	assert.equal(
		isExpectedPiProcess(
			{ ...rewritten, pid: 43, argv: ["pi", "--session", "/tmp/child.jsonl"] },
			"/tmp/child.jsonl",
			"/repo",
			read,
			"linux",
		),
		false,
	);
});
