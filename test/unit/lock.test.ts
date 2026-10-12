import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
	acquireLock,
	releaseLock,
	RpacLockError,
	readLockRecord,
	isPidAlive,
	isLockLive,
	refreshLock,
	holdsLock,
	forgetOwnership,
} from "../../lib/lock.ts";
import { rpacDir, leaseFile, lockFile } from "../../lib/paths.ts";
import { makeTempDir, removeTree, nowIso } from "../../lib/util.ts";
import { newState } from "../../lib/schema.ts";
import { createWorkflow, loadActive, updateActive, LOCK_NAME, LEASE_NAME } from "../../lib/store.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD_RACE = join(HERE, "..", "helpers", "lock-race-child.ts");
const CHILD_RMW = join(HERE, "..", "helpers", "rmw-child.ts");

let root: string;

function deadPid(): number {
	// Spawn a child and wait for it to exit — its pid is guaranteed dead.
	const out = execFileSync(
		process.execPath,
		[
			"-e",
			`const { spawn } = require("node:child_process");
			 const cp = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),30)"], { stdio: "ignore" });
			 cp.on("exit", () => { console.log(cp.pid); process.exit(0); });`,
		],
		{ encoding: "utf8" },
	).trim();
	return Number(out);
}

function spawnAndWait(args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
	return new Promise((res, rej) => {
		const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += String(d)));
		child.stderr.on("data", (d) => (out += String(d)));
		const t = setTimeout(() => {
			child.kill("SIGKILL");
			rej(new Error(`child timed out: ${out}`));
		}, timeoutMs);
		child.on("exit", (code) => {
			clearTimeout(t);
			res({ code, out });
		});
	});
}

function runRace(children: number, winnerFile: string, opts: { holdMs?: number; attempts?: number; delayMs?: number } = {}): Promise<number[]> {
	const kids: ChildProcess[] = [];
	for (let i = 0; i < children; i++) {
		kids.push(spawn(process.execPath, [CHILD_RACE, root, winnerFile, String(opts.holdMs ?? 3000), String(opts.attempts ?? 200), String(opts.delayMs ?? 5)], { stdio: ["pipe", "ignore", "ignore"] }));
	}
	return new Promise((res, rej) => {
		const codes: (number | null)[] = new Array(children).fill(null);
		let done = 0;
		const t = setTimeout(() => {
			kids.forEach((k) => k.kill("SIGKILL"));
			rej(new Error("race children timed out"));
		}, 20000);
		// start barrier: give every child time to load its modules, then release them together
		setTimeout(() => {
			kids.forEach((k) => k.stdin!.write("go\n"));
		}, 1500);
		kids.forEach((k, i) => {
			k.on("exit", (code) => {
				codes[i] = code;
				done++;
				if (done === children) {
					clearTimeout(t);
					res(codes as number[]);
				}
			});
		});
	});
}

before(() => {
	root = makeTempDir("rpac-lock-");
	mkdirSync(root, { recursive: true });
});

after(() => {
	rmSync(join(root, ".pi"), { recursive: true, force: true });
	removeTree(root);
});

test("lock: absent lock — exactly one contender wins (atomic wx create)", async () => {
	const winnerFile = join(root, `win-${Date.now()}.txt`);
	writeFileSync(winnerFile, "");
	const codes = await runRace(6, winnerFile);
	const winners = readFileSync(winnerFile, "utf8").trim().split("\n").filter(Boolean);
	assert.equal(winners.length, 1, `exactly one winner, got ${winners.length}; codes: ${codes.join(",")}`);
	// the loser exited with the expected RpacLockError code
	assert.ok(codes.every((c) => c === 0 || c === 2));
	// the winner released its lock
	assert.equal(existsSync(lockFile(root)), false, "lock released after the run");
	rmSync(winnerFile, { force: true });
});

test("lock: stale lock (dead pid, old) is taken over by the next acquirer", () => {
	const dead = deadPid();
	const createdAt = new Date(Date.now() - 120_000).toISOString().replace(/\.\d{3}Z$/, "Z");
	writeFileSync(
		lockFile(root),
		JSON.stringify({ token: "stale-token", pid: dead, createdAt }),
		"utf8",
	);
	assert.ok(!isPidAlive(dead), "test setup: pid is dead");
	const h = acquireLock(root, LOCK_NAME);
	assert.ok(h.token);
	assert.equal(readLockRecord(root, LOCK_NAME)!.token, h.token, "taker owns the new token");
	releaseLock(root, LOCK_NAME);
	assert.equal(existsSync(lockFile(root)), false);
	// leftover .stale- files from the takeover are cleaned up
	const leftovers = readdirSync(rpacDir(root)).filter((f) => f.includes(".stale-"));
	assert.equal(leftovers.length, 0, `stale remnants: ${leftovers.join(",")}`);
});

test("lock: two contenders for the same stale lock — exactly one takes it over", async () => {
	const dead = deadPid();
	const createdAt = new Date(Date.now() - 120_000).toISOString().replace(/\.\d{3}Z$/, "Z");
	writeFileSync(lockFile(root), JSON.stringify({ token: "old-stale", pid: dead, createdAt }), "utf8");
	const winnerFile = join(root, `win2-${Date.now()}.txt`);
	writeFileSync(winnerFile, "");
	// both children see the same stale lock; staleMs default 30s → takeover race
	const codes = await runRace(2, winnerFile, { holdMs: 3000, attempts: 40 });
	const winners = readFileSync(winnerFile, "utf8").trim().split("\n").filter(Boolean);
	assert.equal(winners.length, 1, `exactly one taker, codes: ${codes.join(",")}`);
	assert.ok(codes.every((c) => c === 0 || c === 2));
	assert.equal(existsSync(lockFile(root)), false);
	rmSync(winnerFile, { force: true });
});

test("lock: a live foreign holder blocks acquisition (no displacement)", () => {
	// A lock record with OUR pid but a foreign token simulates another
	// process that reused our pid: we must not treat it as ours.
	const createdAt = nowIso();
	writeFileSync(lockFile(root), JSON.stringify({ token: "foreign-token", pid: process.pid, createdAt }), "utf8");
	assert.throws(
		() => acquireLock(root, LOCK_NAME, { attempts: 8, delayMs: 10 }),
		(e: Error) => e instanceof RpacLockError && /held by another process/.test(e.message),
	);
	assert.ok(existsSync(lockFile(root)), "foreign lock untouched");
	// release must NOT remove a lock we do not own
	releaseLock(root, LOCK_NAME);
	assert.ok(existsSync(lockFile(root)), "release ignored for a foreign lock");
	rmSync(lockFile(root), { force: true });
});

test("lease policy never displaces a live pid based on age alone", () => {
	const createdAt = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
	writeFileSync(leaseFile(root), JSON.stringify({ token: "old-but-live", pid: process.pid, createdAt }), "utf8");
	assert.throws(
		() => acquireLock(root, LEASE_NAME, { staleMs: 1, attempts: 2, delayMs: 1, requireDeadPidForTakeover: true }),
		(e: Error) => e instanceof RpacLockError && /held by another process/.test(e.message),
	);
	assert.equal(readLockRecord(root, LEASE_NAME)?.token, "old-but-live");
	rmSync(leaseFile(root), { force: true });
});

test("lock: same-PID re-entrancy is reference-counted", () => {
	const h1 = acquireLock(root, LOCK_NAME);
	const h2 = acquireLock(root, LOCK_NAME);
	assert.equal(h1.token, h2.token);
	assert.ok(holdsLock(root, LOCK_NAME));
	releaseLock(root, LOCK_NAME); // inner release — file must stay
	assert.ok(existsSync(lockFile(root)), "outer lock still held after inner release");
	releaseLock(root, LOCK_NAME); // outer release — file goes
	assert.equal(existsSync(lockFile(root)), false);
	assert.equal(holdsLock(root, LOCK_NAME), false);
});

test("lock: refresh only works for the owner and updates refreshedAt", () => {
	const h = acquireLock(root, LOCK_NAME);
	assert.equal(refreshLock(root, LOCK_NAME), true);
	const rec = readLockRecord(root, LOCK_NAME)!;
	assert.ok(rec.refreshedAt);
	// simulate losing ownership (crash/interference): refresh refuses
	forgetOwnership(root, LOCK_NAME);
	assert.equal(refreshLock(root, LOCK_NAME), false);
	rmSync(lockFile(root), { force: true });
	// forgetOwnership left nothing claimed
	assert.equal(holdsLock(root, LOCK_NAME), false);
	void h;
});

test("lease: acquired with workflow/task identity, refreshed, and released", () => {
	// a workflow must exist for the lease to be meaningful
	const st = newState(root, "lease task");
	createWorkflow(root, st, true);
	const h = acquireLock(root, LEASE_NAME, { staleMs: 24 * 3600 * 1000, record: { workflowId: st.id, taskId: 1 } });
	assert.ok(h.token);
	const rec = readLockRecord(root, LEASE_NAME)!;
	assert.equal(rec.workflowId, st.id);
	assert.equal(rec.taskId, 1);
	assert.ok(isLockLive(root, LEASE_NAME), "lease is live while its pid runs");
	assert.equal(refreshLock(root, LEASE_NAME), true);
	releaseLock(root, LEASE_NAME);
	assert.equal(readLockRecord(root, LEASE_NAME), null);
	assert.equal(existsSync(leaseFile(root)), false);
});

test("lease: a stale lease (dead pid) is taken over", () => {
	const dead = deadPid();
	const createdAt = nowIso();
	writeFileSync(leaseFile(root), JSON.stringify({ token: "old-lease", pid: dead, createdAt, workflowId: "w-x", taskId: 2 }), "utf8");
	assert.equal(isLockLive(root, LEASE_NAME), false, "dead holder → not live");
	const h = acquireLock(root, LEASE_NAME, { staleMs: 24 * 3600 * 1000, record: { workflowId: "w-new", taskId: 3 } });
	assert.ok(h.token);
	assert.equal(readLockRecord(root, LEASE_NAME)!.workflowId, "w-new");
	releaseLock(root, LEASE_NAME);
});

test("load-under-lock: concurrent read-modify-write cycles lose no updates", async () => {
	// a workflow to mutate
	const st = newState(root, "rmw task");
	createWorkflow(root, st, true);
	const K = 15;
	const before = loadActive(root, root).state!.checkpoints.length;
	const results = await Promise.all([K, K].map((k) => spawnAndWait([CHILD_RMW, root, String(k)], 60_000)));
	for (const r of results) {
		assert.equal(r.code, 0, `rmw child failed: ${r.out}`);
	}
	const after = loadActive(root, root).state!.checkpoints;
	const added = after.slice(before).map((c) => c.what);
	assert.equal(added.length, K * 2, `all ${K * 2} checkpoints present (lost updates would reduce this): ${added.join(",")}`);
	// unique per iteration — duplicates would indicate a snapshot overwrite
	assert.equal(new Set(added).size, K * 2);
});

test("updateState-equivalent: a snapshot loaded before the lock cannot overwrite a concurrent update", () => {
	// Direct unit proof: two successive updateActive calls each see the latest
	// disk state (load happens AFTER acquire), so the second mutation builds on
	// the first rather than clobbering it.
	const st = newState(root, "snap task");
	createWorkflow(root, st, true);
	updateActive(root, (s) => {
		recordEventLocal(s, "first");
	});
	updateActive(root, (s) => {
		recordEventLocal(s, "second");
	});
	const { state } = loadActive(root, root);
	const kinds = state!.events.map((e) => e.detail);
	assert.ok(kinds.includes("first") && kinds.includes("second"), "both mutations persisted");
});

function recordEventLocal(s: import("../../lib/schema.ts").RpacState, detail: string): void {
	s.events.push({ at: nowIso(), kind: "test", detail });
}
