// RPAC cross-process locking — real exclusive atomic creation.
//
// Every lock file is created with O_EXCL (`openSync(path, "wx")`), so exactly
// one contender can win an absent lock. The lock record carries an ownership
// token, the holder pid, and timestamps; only the token owner releases it.
//
// Stale takeover is serialized by a short exclusive `.takeover` guard. The
// winner re-reads the ownership token under that guard before rename/create,
// so a contender can never rename a newer owner's lock from a stale snapshot.
//
// Same-PID re-entrancy is reference-counted (a Map of token owners per
// process); nested acquire/release pairs only unlink on the outermost
// release, and only when the on-disk token still matches.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { nowIso } from "./util.ts";
import { rpacDir } from "./paths.ts";

export class RpacLockError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpacLockError";
	}
}

export interface LockRecord {
	token: string;
	pid: number;
	createdAt: string;
	/** lease: last activity stamp (refreshed during long work) */
	refreshedAt?: string;
	/** lease: which workflow/task is being executed */
	workflowId?: string;
	taskId?: number | null;
}

export interface LockHandle {
	root: string;
	name: string;
	token: string;
}

export interface AcquireOptions {
	/** a lock older than this (or held by a dead pid) is taken over. default 30 s */
	staleMs?: number;
	attempts?: number;
	delayMs?: number;
	/** extra fields recorded in the lock record (lease: workflowId/taskId) */
	record?: Partial<Pick<LockRecord, "workflowId" | "taskId">>;
	/** when true, age alone can never displace a holder whose pid is alive */
	requireDeadPidForTakeover?: boolean;
}

export const LOCK_STALE_MS_DEFAULT = 30_000;
/** Lease liveness additionally reports activity; takeover itself is pid-death based. */
export const LEASE_STALE_MS_DEFAULT = 120_000;

interface OwnerEntry {
	token: string;
	depth: number;
}

/** Per-process ownership registry (reference counting for re-entrant acquires). */
const owners = new Map<string, OwnerEntry>();

function lockPath(root: string, name: string): string {
	return join(rpacDir(root), name);
}

function ownerKey(root: string, name: string): string {
	return `${root}::${name}`;
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True when the pid exists (EPERM means it exists but is owned by another user). */
export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readRecord(path: string): LockRecord | null {
	try {
		const raw = readFileSync(path, "utf8");
		const rec = JSON.parse(raw) as Partial<LockRecord>;
		if (typeof rec.token === "string" && typeof rec.pid === "number" && typeof rec.createdAt === "string") {
			return rec as LockRecord;
		}
		return null;
	} catch {
		return null;
	}
}

/** Read a lock record without acquiring. Null when absent/unreadable. */
export function readLockRecord(root: string, name: string): LockRecord | null {
	return readRecord(lockPath(root, name));
}

/**
 * True when the holder is still considered live: pid alive and, when a
 * refreshedAt stamp exists, recent activity. `staleMs` bounds the activity
 * window; a dead pid is always stale.
 */
export function isLockLive(root: string, name: string, staleMs: number = LEASE_STALE_MS_DEFAULT): boolean {
	const rec = readLockRecord(root, name);
	if (!rec) return false;
	if (!isPidAlive(rec.pid)) return false;
	const ref = rec.refreshedAt ? Date.parse(rec.refreshedAt) : Date.parse(rec.createdAt);
	if (Number.isFinite(ref) && Date.now() - ref > staleMs) return false;
	return true;
}

/**
 * Acquire an exclusive lock named `name` (e.g. ".lock", ".act-lease") under
 * .pi/rpac/. Blocks briefly while a live foreign holder owns it; throws
 * RpacLockError after `attempts`. Stale locks are taken over atomically.
 */
export function acquireLock(root: string, name: string, opts: AcquireOptions = {}): LockHandle {
	const staleMs = opts.staleMs ?? LOCK_STALE_MS_DEFAULT;
	const attempts = opts.attempts ?? 40;
	const delayMs = opts.delayMs ?? 10;
	const p = lockPath(root, name);
	const takeoverPath = `${p}.takeover`;
	mkdirSync(rpacDir(root), { recursive: true });
	const key = ownerKey(root, name);

	const tryCreate = (): LockHandle | null => {
		let fd: number;
		try {
			fd = openSync(p, "wx");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
			throw err;
		}
		const rec: LockRecord = {
			token: randomUUID(),
			pid: process.pid,
			createdAt: nowIso(),
			...(opts.record ? { ...opts.record } : {}),
		};
		try {
			writeFileSync(fd, JSON.stringify(rec), "utf8");
		} finally {
			closeSync(fd);
		}
		owners.set(key, { token: rec.token, depth: 1 });
		return { root, name, token: rec.token };
	};

	for (let i = 0; i < attempts; i++) {
		const owned = owners.get(key);
		if (owned) {
			const rec = readRecord(p);
			if (rec && rec.token === owned.token) {
				owned.depth++;
				return { root, name, token: owned.token };
			}
			owners.delete(key);
		}

		try {
			// A stale takeover holds this short guard across compare/rename/create.
			// Waiting here prevents a contender from filling the rename gap.
			if (!existsSync(takeoverPath)) {
				const created = tryCreate();
				if (created) return created;
			}
		} catch (err) {
			if (i === attempts - 1) throw new RpacLockError(`could not acquire ${name} lock: ${(err as Error).message}`);
			sleepSync(delayMs);
			continue;
		}

		const rec = readRecord(p);
		if (rec) {
			const ref = rec.refreshedAt ? Date.parse(rec.refreshedAt) : Date.parse(rec.createdAt);
			const age = Number.isFinite(ref) ? Date.now() - ref : Infinity;
			const alive = isPidAlive(rec.pid);
			const mayTakeOver = !alive || (!opts.requireDeadPidForTakeover && age >= staleMs);
			if (!mayTakeOver) {
				if (i === attempts - 1) {
					throw new RpacLockError(
						`RPAC ${name} is held by another process (pid ${rec.pid}, ${Math.max(1, Math.round(age / 1000))}s ago). ` +
							`Wait for it to finish, or if that process is stuck, remove ${name} manually.`,
					);
				}
				sleepSync(delayMs);
				continue;
			}

			let guardFd: number;
			try {
				guardFd = openSync(takeoverPath, "wx");
				closeSync(guardFd);
			} catch {
				sleepSync(delayMs);
				continue;
			}
			try {
				// Re-read under the guard. A contender may have replaced the stale
				// record after our first read; never rename a different token.
				const current = readRecord(p);
				if (!current || current.token !== rec.token) continue;
				const stalePath = `${p}.stale-${rec.token.slice(0, 8)}`;
				renameSync(p, stalePath);
				try {
					unlinkSync(stalePath);
				} catch {
					// best effort; the stale file is inert
				}
				const created = tryCreate();
				if (created) return created;
			} catch {
				// Lost a release/takeover race; retry against the current owner.
			} finally {
				try {
					unlinkSync(takeoverPath);
				} catch {
					// best effort
				}
			}
		}
		sleepSync(delayMs);
	}
	throw new RpacLockError(`could not acquire ${name} lock after ${attempts} attempts`);
}

/** Release a lock if this process owns it (token-checked, reference-counted). */
export function releaseLock(root: string, name: string): void {
	const key = ownerKey(root, name);
	const owned = owners.get(key);
	if (!owned) return;
	owned.depth--;
	if (owned.depth > 0) return;
	owners.delete(key);
	const p = lockPath(root, name);
	const rec = readRecord(p);
	if (rec && rec.token === owned.token) {
		try {
			unlinkSync(p);
		} catch {
			// best effort — the lock is stale-safe anyway
		}
	}
}

/**
 * Rewrite the lock record (activity refresh). Only the token owner may
 * refresh. Returns false when we do not own the lock.
 */
export function refreshLock(root: string, name: string, extra?: Partial<LockRecord>): boolean {
	const key = ownerKey(root, name);
	const owned = owners.get(key);
	const p = lockPath(root, name);
	const rec = readRecord(p);
	if (!rec || !owned || rec.token !== owned.token) return false;
	try {
		const next: LockRecord = { ...rec, refreshedAt: nowIso(), ...(extra ?? {}) };
		writeFileSync(p, JSON.stringify(next), "utf8");
		return true;
	} catch {
		return false;
	}
}

/** True when this process currently holds the named lock (any depth). */
export function holdsLock(root: string, name: string): boolean {
	return owners.has(ownerKey(root, name));
}

/** Test hook: forget in-process ownership of a lock (simulates a crashed process). */
export function forgetOwnership(root: string, name: string): void {
	owners.delete(ownerKey(root, name));
}
