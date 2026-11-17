export default async function* reporter(events) {
	const counts = new Map();
	const failures = [];
	let bad = false;
	let complete = false;
	let invalid = false;
	let truncated = false;

	for await (const event of events) {
		const d = event.data;

		if (event.type === "test:diagnostic" && /^'only' and 'runOnly' require the --test-only command-line option\.?$/.test(d.message)) { bad = true; invalid = true; }

		if (event.type === "test:pass" || event.type === "test:fail") {
			if (d.skip || d.todo || event.type === "test:fail") bad = true;

			const load = (d.name === d.file || d.file?.endsWith(`/${d.name}`)) && d.line === 1 && d.column === 1;

			if (d.details?.type === "suite" && !load) continue;
			const file = d.file?.replace(/^.*?\/(?:w|tree|baseline)\//, "") ?? "missing-file";

			if (!load) counts.set(file, (counts.get(file) ?? 0) + 1);
			const error = d.details?.error;
			const code = error?.cause?.code == null ? null : String(error.cause.code).slice(0, 100);
			const failureType = error?.failureType;

			if (load) bad = true;

			if (d.skip || d.todo || event.type === "test:fail") { if (failures.length >= 1000) truncated = true; else if (failureType !== "subtestsFailed") failures.push({ file, name: String(d.name).slice(0, 300), outcome: d.skip ? "skip" : d.todo ? "todo" : "failed", kind: load ? "load_error" : d.skip ? "skip" : d.todo ? "todo" : failureType === "testTimeoutFailure" ? "timeout" : failureType === "cancelledByParent" || failureType === "testAborted" ? "cancelled" : code === "ERR_ASSERTION" ? "assertion" : "runtime_error", code, message: String(error?.cause?.message ?? error?.message ?? "").slice(0, 200) }); }
		}

		if (event.type === "test:summary" && d.file === undefined) {
			complete = true;

			if (!d.success) bad = true;
		}
	}

	yield `${JSON.stringify({ complete, bad, invalid, truncated, counts: Object.fromEntries([...counts].sort()), failures })}\n`;
}
