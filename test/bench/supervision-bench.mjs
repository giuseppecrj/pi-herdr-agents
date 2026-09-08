#!/usr/bin/env node
/**
 * Manual coordinator benchmark. It owns an isolated Herdr server and never
 * touches the caller's HOME, workspace, or test resources.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import {
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { SupervisionCoordinator } from "../../pi-extension/subagents/supervision.ts";
import { waitForCompletion } from "../../pi-extension/subagents/completion.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const WINDOW_MS = 20_000;
const SIZES = [1, 5, 10];
const REAL_HERDR =
	process.env.HERDR_BIN ??
	execFileSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim();
const output = process.env.ISSUE29_BENCH_OUT ?? "/tmp/issue29-bench";
const now = () => Number(process.hrtime.bigint()) / 1e6;

function command(file, args, env, timeout = 10_000) {
	return new Promise((resolve, reject) => {
		const child = execFile(
			file,
			args,
			{ env, timeout, encoding: "utf8" },
			(error, stdout, stderr) => {
				if (error)
					reject(
						new Error(`${file} ${args.join(" ")}: ${stderr || error.message}`),
					);
				else resolve(stdout);
			},
		);
		child.unref?.();
	});
}

async function until(condition, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await delay(50);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function stat(pid) {
	try {
		const columns = readFileSync(`/proc/${pid}/stat`, "utf8")
			.slice(readFileSync(`/proc/${pid}/stat`, "utf8").lastIndexOf(")") + 2)
			.split(" ");
		return {
			pid: Number(pid),
			parent: Number(columns[1]),
			ticks:
				Number(columns[11]) +
				Number(columns[12]) +
				Number(columns[13]) +
				Number(columns[14]),
		};
	} catch {
		return null;
	}
}

async function cpuSnapshot(serverPid) {
	const all = (await readdir("/proc"))
		.filter((name) => /^\d+$/.test(name))
		.map(stat)
		.filter(Boolean);
	const owned = new Set([serverPid]);
	for (let changed = true; changed; ) {
		changed = false;
		for (const entry of all)
			if (owned.has(entry.parent) && !owned.has(entry.pid)) {
				owned.add(entry.pid);
				changed = true;
			}
	}
	return {
		supervisorTicks: stat(process.pid)?.ticks ?? 0,
		herdrTreeTicks: all
			.filter((entry) => owned.has(entry.pid))
			.reduce((sum, entry) => sum + entry.ticks, 0),
	};
}

async function createLab() {
	const root = await mkdtemp(join(tmpdir(), "issue29-bench-"));
	const home = join(root, "home");
	const socket = join(home, ".config/herdr/sessions/issue29-bench/herdr.sock");
	const config = join(root, "config.toml");
	await mkdir(dirname(socket), { recursive: true });
	await writeFile(
		config,
		'onboarding = false\n[terminal]\ndefault_shell = "/bin/bash"\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n[ui.sound]\nenabled = false\n[ui.toast]\ndelivery = "off"\n[experimental]\nallow_nested = true\n',
	);
	await writeFile(join(dirname(socket), "config.toml"), await readFile(config));
	const calls = join(root, "herdr-calls.jsonl");
	const shim = join(root, "bin");
	await mkdir(shim);
	await writeFile(
		join(shim, "herdr"),
		`#!/bin/sh\nprintf '{"at":%s,"argv":"%s"}\\n' "$(date +%s%N)" "$*" >> ${JSON.stringify(calls)}\nexec ${JSON.stringify(REAL_HERDR)} "$@"\n`,
		{ mode: 0o755 },
	);
	const env = {
		...process.env,
		HOME: home,
		PATH: `${shim}:${process.env.PATH}`,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local/share"),
		XDG_STATE_HOME: join(home, ".local/state"),
		HERDR_CONFIG_PATH: config,
		HERDR_SOCKET_PATH: socket,
		PI_OFFLINE: "1",
	};
	const server = spawn(REAL_HERDR, ["--session", "issue29-bench", "server"], {
		env,
		stdio: "ignore",
	});
	const cli = (args) => command("herdr", args, env);
	try {
		await until(
			async () => {
				try {
					await cli(["workspace", "list"]);
					return true;
				} catch {
					return false;
				}
			},
			15_000,
			"isolated Herdr startup",
		);
		const created = JSON.parse(
			await cli([
				"workspace",
				"create",
				"--cwd",
				ROOT,
				"--label",
				"issue29 benchmark",
				"--no-focus",
			]),
		);
		return {
			root,
			env,
			server,
			cli,
			calls,
			workspace: created.result.workspace.workspace_id,
		};
	} catch (error) {
		server.kill("SIGTERM");
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}

async function closeLab(lab) {
	try {
		await lab.cli(["server", "stop"]);
	} catch {}
	if (lab.server.exitCode === null) lab.server.kill("SIGTERM");
	await rm(lab.root, { recursive: true, force: true });
}

async function makeChildren(lab, count, sequence) {
	const children = [];
	for (let index = 0; index < count; index++) {
		const created = JSON.parse(
			await lab.cli([
				"tab",
				"create",
				"--workspace",
				lab.workspace,
				"--cwd",
				lab.root,
				"--label",
				`held-${sequence}-${index}`,
				"--no-focus",
			]),
		);
		const pane = created.result.root_pane.pane_id;
		await lab.cli(["pane", "run", pane, "sleep 300"]);
		const session = join(lab.root, `held-${sequence}-${index}.jsonl`);
		await writeFile(session, "{}\n");
		children.push({ pane, session, probes: [], evidenceAt: 0, resolvedAt: 0 });
	}
	return children;
}

async function trial(lab, mode, count, round, sequence) {
	const children = await makeChildren(lab, count, sequence);
	const hz = Number((await command("getconf", ["CLK_TCK"], lab.env)).trim());
	const coordinator = new SupervisionCoordinator(
		async () => {
			const reply = JSON.parse(await lab.cli(["pane", "list"]));
			const panes = reply.result?.panes;
			if (!Array.isArray(panes)) return { complete: false, panes: [] };
			return {
				complete: true,
				panes: panes.map((pane) => ({
					paneId: pane.pane_id,
					workspaceId: pane.workspace_id,
					inspection: { kind: "present", observedAt: Date.now() },
				})),
			};
		},
		async (pane) => {
			const reply = JSON.parse(await lab.cli(["pane", "get", pane]));
			return reply.result?.pane
				? { kind: "present", observedAt: Date.now() }
				: { kind: "missing" };
		},
		mode === "baseline",
	);
	const watches = children.map((child) => {
		const registration = coordinator.register(child.session, child.pane);
		const promise = waitForCompletion(new AbortController().signal, {
			intervalMs: 1_000,
			sessionFile: child.session,
			waitForNextCheck: registration.wait,
			inspectPane: registration.inspectPane,
			readTerminalTail: async () => {
				child.probes.push(now());
				return lab.cli([
					"pane",
					"read",
					child.pane,
					"--source",
					"visible",
					"--lines",
					"5",
				]);
			},
		}).then((result) => {
			child.resolvedAt = now();
			return result;
		});
		return { registration, promise };
	});
	try {
		await delay(1_000); // Let initial reconciliation settle before the window.
		await writeFile(lab.calls, "");
		const before = await cpuSnapshot(lab.server.pid);
		const startedAt = now();
		await delay(WINDOW_MS);
		const after = await cpuSnapshot(lab.server.pid);
		const elapsed = now() - startedAt;
		for (const child of children) {
			child.evidenceAt = now();
			await writeFile(
				`${child.session}.exit.tmp`,
				JSON.stringify({ type: "done" }),
			);
			await command(
				"mv",
				[`${child.session}.exit.tmp`, `${child.session}.exit`],
				lab.env,
			);
		}
		const outcomes = await Promise.all(watches.map((watch) => watch.promise));
		assert.ok(outcomes.every((result) => result.reason === "done"));
		const calls = (await readFile(lab.calls, "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(JSON.parse);
		const latencies = children.map(
			(child) => child.resolvedAt - child.evidenceAt,
		);
		const gaps = children.flatMap((child) =>
			child.probes.slice(1).map((at, index) => at - child.probes[index]),
		);
		return {
			mode,
			count,
			round,
			windowMs: elapsed,
			cliLaunches: calls.length,
			cliLaunchesPerSecond: (calls.length * 1000) / elapsed,
			supervisionCpuMs:
				((after.supervisorTicks - before.supervisorTicks) * 1000) / hz,
			herdrTreeCpuMs:
				((after.herdrTreeTicks - before.herdrTreeTicks) * 1000) / hz,
			detectionLatencyMs: latencies,
			maxProbeGapMs: Math.max(0, ...gaps),
			calls,
		};
	} finally {
		for (const watch of watches) watch.registration.unregister();
		coordinator.close();
		for (const child of children)
			try {
				await lab.cli(["pane", "close", child.pane]);
			} catch {}
	}
}

await mkdir(output, { recursive: true });
const lab = await createLab();
const results = [];
try {
	let sequence = 0;
	for (const count of SIZES) {
		const rounds = count === 10 ? 3 : 1;
		for (let round = 0; round < rounds; round++) {
			for (const mode of round % 2
				? ["wake+batch", "baseline"]
				: ["baseline", "wake+batch"]) {
				const result = await trial(lab, mode, count, round, sequence++);
				results.push(result);
				const { calls: _calls, ...summary } = result;
				console.log(JSON.stringify(summary));
			}
		}
	}
	await writeFile(
		join(output, "results.json"),
		JSON.stringify(
			{
				conditions: {
					windowMs: WINDOW_MS,
					sizes: SIZES,
					roundsAtTen: 3,
					cpu: "Linux /proc ticks for benchmark supervisor and isolated Herdr tree",
					latency: "sidecar publication to waitForCompletion resolver return",
					children: "isolated Herdr panes held in sleep 300",
				},
				results,
			},
			null,
			2,
		),
	);
	const by = (mode, count) =>
		results.filter((result) => result.mode === mode && result.count === count);
	const average = (values, key) =>
		values.reduce((sum, value) => sum + value[key], 0) / values.length;
	const averageLatency = (values) => {
		const samples = values.flatMap((value) => value.detectionLatencyMs);
		return samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
	};
	const baseline = by("baseline", 10);
	const wake = by("wake+batch", 10);
	const reduction =
		1 -
		average(wake, "cliLaunchesPerSecond") /
			average(baseline, "cliLaunchesPerSecond");
	const gates = {
		recurringCliReductionAtTen: reduction >= 0.8,
		noCpuRegression:
			average(wake, "supervisionCpuMs") <=
			average(baseline, "supervisionCpuMs"),
		noLatencyRegression: averageLatency(wake) <= averageLatency(baseline),
		maxReconcileGap:
			Math.max(...wake.map((result) => result.maxProbeGapMs)) < 5_000,
	};
	await writeFile(
		join(output, "summary.json"),
		JSON.stringify({ reduction, gates }, null, 2),
	);
	console.log(JSON.stringify({ output, reduction, gates }));
	if (!Object.values(gates).every(Boolean)) process.exitCode = 1;
} finally {
	await closeLab(lab);
}
