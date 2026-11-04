import { lstatSync, readlinkSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Resolve symbolic links with lstat, stat, and readlink only, matching Node's
 * JavaScript realpathSync, including its lexical `..` handling. Bun's
 * realpathSync opens the path, and open() blocks indefinitely on some
 * protected macOS directories, such as another app's sandbox container,
 * freezing the whole process.
 */
export function realpathWithoutOpening(path: string): string {
	const parts = (from: string) => resolve(from).split(sep).filter(Boolean);
	let pending = parts(path);
	let resolved: string = sep;
	let links = 0;
	while (pending.length) {
		const next = join(resolved, pending.shift() ?? "");
		if (!lstatSync(next).isSymbolicLink()) {
			resolved = next;
			continue;
		}
		// Like Node, let the kernel validate the target: missing targets throw
		// ENOENT and real cycles throw ELOOP.
		statSync(next);
		// Backstop only; valid repeated traversals stay far below this.
		if (++links > 4096)
			throw Object.assign(new Error(`Too many symbolic links: ${path}`), {
				code: "ELOOP",
			});
		pending = [...parts(resolve(resolved, readlinkSync(next))), ...pending];
		resolved = sep;
	}
	return resolved;
}
