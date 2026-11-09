import assert from "node:assert/strict";
import { test } from "node:test";
import { isExpectedPiProcess } from "../../maestro/adapters/pi/launch-operations.ts";

const SESSION = "C:\\Users\\dev\\.pi\\agent\\sessions\\child.jsonl";
const CWD = "D:\\source\\repo";

// Shape of `herdr pane process-info` for a live Pi on Windows (herdr 0.9.5):
// the process is node.exe, argv is the real command line, and cwd ends in `\`.
const live = {
	pid: 36804,
	name: "node.exe",
	argv0: "C:\\nvm4w\\nodejs\\node.exe",
	argv: [
		"C:\\nvm4w\\nodejs\\node.exe",
		"C:\\pi\\dist\\bundle\\cli.js",
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

test("Windows readiness accepts any executable name, since Pi shows as node.exe", () => {
	for (const name of ["node.exe", "pi.exe", "bun.exe"])
		assert.equal(windows({ ...live, name }), true, name);
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
