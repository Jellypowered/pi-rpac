// Child process for lock contention tests.
// Usage: node lock-race-child.ts <root> <winnerFile> <holdMs> <attempts> <delayMs>
// Waits for a "go" line on stdin (start barrier), then tries to acquire the
// state lock. The winner appends its pid to winnerFile and holds for holdMs.
import { appendFileSync } from "node:fs";
import { acquireLock, releaseLock, RpacLockError } from "../../lib/lock.ts";
import { LOCK_NAME } from "../../lib/store.ts";

const [root, winnerFile, holdMs, attempts, delayMs] = process.argv.slice(2, 7);
if (!root || !winnerFile) {
	console.error("usage: lock-race-child.ts <root> <winnerFile> <holdMs> <attempts> <delayMs>");
	process.exit(3);
}

process.stdin.once("data", () => {
	try {
		acquireLock(root, LOCK_NAME, {
			// liveness-based only: a live holder is never displaced within this test
			staleMs: 3600 * 1000,
			attempts: Number(attempts),
			delayMs: Number(delayMs),
		});
		appendFileSync(winnerFile, `${process.pid}\n`);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
		releaseLock(root, LOCK_NAME);
		process.exit(0);
	} catch (err) {
		// RpacLockError = expected loser exit code 2; anything else is a bug.
		process.exit(err instanceof RpacLockError ? 2 : 1);
	}
});
