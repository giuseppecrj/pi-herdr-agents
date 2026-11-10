/** Where a fake test server listens: a Unix socket file, or a named pipe on Windows. */
import { randomUUID } from "node:crypto";
import { join, win32 } from "node:path";

/**
 * Windows Node `net` servers cannot listen on a filesystem path, only on a
 * `\\.\pipe\<name>` named pipe, which clients connect to with the same string.
 * Pipe names are global, so the Windows name adds a random suffix to stay
 * unique across concurrent test processes. Other platforms keep `dir/name`.
 */
export function socketPath(
	dir: string,
	name: string,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform !== "win32") return join(dir, name);
	return `\\\\.\\pipe\\${win32.basename(dir)}-${name}-${randomUUID()}`;
}
