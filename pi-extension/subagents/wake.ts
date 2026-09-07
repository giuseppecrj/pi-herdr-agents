import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

export type WakeReason = "wake" | "reconcile";

interface WakeEntry {
	filenames: Set<string>;
	wake: () => void;
	fallback: () => void;
}

interface DirectoryWatcher {
	watcher: FSWatcher;
	entries: Set<WakeEntry>;
}

export interface WakeRegistration {
	watching: boolean;
	unregister(): void;
}

/**
 * Shares directory watches between supervised sessions. Sidecars use atomic
 * rename and task events use appendFileSync, so directories are watched deliberately.
 */
export class FileWakeRegistry {
	private readonly directories = new Map<string, DirectoryWatcher>();
	private readonly watchDirectory: typeof watch;
	private closed = false;

	constructor(watchDirectory: typeof watch = watch) {
		this.watchDirectory = watchDirectory;
	}

	register(
		sessionFile: string,
		wake: () => void,
		fallback: () => void,
	): WakeRegistration {
		const directory = dirname(sessionFile);
		const entry: WakeEntry = {
			filenames: new Set([
				`${basename(sessionFile)}.exit`,
				`${basename(sessionFile)}.tasks`,
			]),
			wake,
			fallback,
		};
		let current = this.directories.get(directory);
		if (!this.closed && !current) {
			try {
				const watcher = this.watchDirectory(directory, (_event, filename) => {
					if (this.closed) return;
					for (const watched of current?.entries ?? []) {
						if (!filename || watched.filenames.has(filename.toString()))
							watched.wake();
					}
				});
				current = { watcher, entries: new Set() };
				watcher.unref();
				watcher.on("error", () => this.failDirectory(directory));
				this.directories.set(directory, current);
			} catch {
				// The caller switches this child to polling.
			}
		}
		if (current) current.entries.add(entry);
		else fallback();

		return {
			watching: current != null,
			unregister: () => {
				const active = this.directories.get(directory);
				if (!active) return;
				active.entries.delete(entry);
				if (active.entries.size === 0) {
					active.watcher.close();
					this.directories.delete(directory);
				}
			},
		};
	}

	get watcherCount(): number {
		return this.directories.size;
	}

	close(): void {
		this.closed = true;
		for (const { watcher } of this.directories.values()) watcher.close();
		this.directories.clear();
	}

	private failDirectory(directory: string): void {
		if (this.closed) return;
		const current = this.directories.get(directory);
		if (!current) return;
		this.directories.delete(directory);
		current.watcher.close();
		for (const entry of current.entries) entry.fallback();
	}
}
