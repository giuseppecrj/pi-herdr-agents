import { lstatSync, readlinkSync, statSync } from "node:fs";
import { join, parse, resolve, sep } from "node:path";

/**
 * Resolve symbolic links with lstat, stat, and readlink only, matching Node's
 * JavaScript realpathSync, including its lexical `..` handling. Bun's
 * realpathSync opens the path, and open() blocks indefinitely on some
 * protected macOS directories, such as another app's sandbox container,
 * freezing the whole process.
 */
export function realpathWithoutOpening(path: string): string {
	// A root is `/` on POSIX but `C:\` or `\\host\share\` on Windows, and a link
	// target may name another one, so each absolute path carries its own root.
	const split = (from: string) => {
		const absolute = resolve(from);
		const { root } = parse(absolute);
		return {
			root,
			parts: absolute.slice(root.length).split(sep).filter(Boolean),
		};
	};
	const start = split(path);
	let pending = start.parts;
	let resolved: string = start.root;
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
		const target = split(resolve(resolved, readlinkSync(next)));
		pending = [...target.parts, ...pending];
		resolved = target.root;
	}
	return resolved;
}
