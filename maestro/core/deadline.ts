/** A finite monotonic budget. Zero is never passed to Node's unlimited timeout. */
export class Deadline {
	private readonly end: number;
	private readonly now: () => number;
	private constructor(end: number, now: () => number) {
		this.end = end;
		this.now = now;
	}
	static after(
		timeoutMs: number,
		now: () => number = () => performance.now(),
	): Deadline {
		if (
			!Number.isFinite(timeoutMs) ||
			timeoutMs <= 0 ||
			timeoutMs > 2_147_483_647
		)
			throw new Error(
				"Timeout must be finite and positive (at most 2147483647ms)",
			);
		return new Deadline(now() + timeoutMs, now);
	}
	remainingMs(): number {
		const remaining = this.end - this.now();
		if (remaining <= 0) throw new Error("Operation deadline exceeded");
		return Math.ceil(remaining);
	}
	expired(): boolean {
		return this.now() >= this.end;
	}
	cappedAt(timeoutMs: number): Deadline {
		const cap = Deadline.after(timeoutMs, this.now);
		return new Deadline(Math.min(this.end, cap.end), this.now);
	}
}
