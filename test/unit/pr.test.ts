import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	classifyPrState,
	repositoryFromUrl,
	resolvePrMeta,
	parseNameStatus,
	capturePrSnapshot,
	verifyGitObjects,
	prWorktreePath,
	assessPrCheckout,
	performPrCheckout,
	removePrWorktree,
	buildPrMeta,
	type GhRunner,
	type PrViewResult,
} from "../../lib/pr.ts";
import { compareReviewSnapshots } from "../../lib/review.ts";
import { makeTempDir, removeTree } from "../../lib/util.ts";

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

/** Build a local origin + work clone that simulates a GitHub PR. */
function prFixture(): {
	origin: string;
	work: string;
	baseSha: string;
	headSha: string;
	prNumber: number;
	baseRef: string;
	cleanup: () => void;
} {
	const origin = makeTempDir("rpac-pr-origin-");
	const work = makeTempDir("rpac-pr-work-");
	git(origin, "init", "-q");
	git(origin, "config", "user.email", "o@o");
	git(origin, "config", "user.name", "origin");
	writeFileSync(join(origin, "app.txt"), "main\n");
	writeFileSync(join(origin, "keep.txt"), "keep\n");
	git(origin, "add", "-A");
	git(origin, "commit", "-qm", "main");
	const baseRef = git(origin, "branch", "--show-current") || "HEAD";
	const baseSha = git(origin, "rev-parse", "HEAD");
	git(origin, "checkout", "-qb", "feature");
	writeFileSync(join(origin, "app.txt"), "main+feat\n");
	writeFileSync(join(origin, "new.txt"), "new\n");
	git(origin, "rm", "-q", "keep.txt");
	git(origin, "add", "-A");
	git(origin, "commit", "-qm", "feat");
	const headSha = git(origin, "rev-parse", "HEAD");
	// Expose the PR head the way GitHub does on the base repo's origin.
	git(origin, "update-ref", "refs/pull/1/head", headSha);
	// Reset origin's HEAD to the default branch, as GitHub's does (not the PR head).
	git(origin, "checkout", "-q", baseRef);

	// Work clone (the "current repo" where Pi runs).
	execFileSync("git", ["clone", "-q", origin, work], { stdio: "ignore" });
	git(work, "config", "user.email", "w@w");
	git(work, "config", "user.name", "work");
	git(work, "checkout", "-q", baseRef);
	return {
		origin,
		work,
		baseSha,
		headSha,
		prNumber: 1,
		baseRef,
		cleanup: () => {
			try { git(work, "worktree", "prune"); } catch { /* ignore */ }
			removeTree(origin);
			removeTree(work);
			// worktree (sibling) may have been created outside; clean it too.
			const wt = prWorktreePath(work, 1);
			if (existsSync(wt)) removeTree(wt);
		},
	};
}

function viewFor(base: string, head: string, extra: Partial<PrViewResult> = {}): PrViewResult {
	return {
		number: 1,
		url: "https://github.com/acme/widget/pull/1",
		title: "Add feature",
		body: "This PR adds a feature and removes a file.",
		state: "OPEN",
		baseRefName: "main",
		baseRefOid: base,
		headRefName: "feature",
		headRefOid: head,
		headRepository: { nameWithOwner: "acme/widget" },
		headRepositoryOwner: { login: "acme" },
		isCrossRepository: false,
		...extra,
	};
}

// --- pure metadata helpers -------------------------------------------------

test("repositoryFromUrl parses owner/name", () => {
	assert.equal(repositoryFromUrl("https://github.com/acme/widget/pull/1"), "acme/widget");
	assert.equal(repositoryFromUrl("https://github.com/acme/widget"), "acme/widget");
	assert.equal(repositoryFromUrl("not a url"), "");
});

test("classifyPrState maps GitHub states", () => {
	assert.equal(classifyPrState("OPEN"), "open");
	assert.equal(classifyPrState("MERGED"), "merged");
	assert.equal(classifyPrState("CLOSED"), "closed");
	assert.equal(classifyPrState("open"), "open");
});

test("resolvePrMeta normalizes and rejects invalid SHAs", () => {
	const base = "a".repeat(40);
	const head = "b".repeat(40);
	const meta = resolvePrMeta(viewFor(base, head));
	assert.equal(meta.repository, "acme/widget");
	assert.equal(meta.state, "open");
	assert.equal(meta.crossRepository, false);
	assert.equal(meta.baseSha, base);
	assert.equal(meta.headSha, head);
	assert.equal(meta.headRepositoryOwner, "acme");
	assert.throws(() => resolvePrMeta(viewFor(base, head, { headRefOid: "nope" })), /base\/head commit SHA/);
	const fork = resolvePrMeta(viewFor(base, head, { isCrossRepository: true }));
	assert.equal(fork.crossRepository, true);
});

// --- name-status parsing ---------------------------------------------------

test("parseNameStatus handles add/modify/delete/rename", () => {
	const { work, baseSha, headSha, cleanup } = prFixture();
	try {
		const raw = execFileSync("git", ["diff", "--name-status", "--find-renames", "-z", `${baseSha}...${headSha}`], {
			cwd: work, encoding: "buffer",
		}) as Buffer;
		const records = parseNameStatus(raw);
		const byStatus = new Map(records.map((r) => [r.path.toString(), r.status[0]]));
		assert.equal(byStatus.get("new.txt"), "A");
		assert.equal(byStatus.get("app.txt"), "M");
		assert.equal(byStatus.get("keep.txt"), "D");
	} finally {
		cleanup();
	}
});

// --- PR snapshot (scope) ---------------------------------------------------

test("capturePrSnapshot captures added/modified/deleted with base+pr layers", () => {
	const { work, baseSha, headSha, cleanup } = prFixture();
	try {
		const snap = capturePrSnapshot(work, baseSha, headSha, 1);
		assert.equal(snap.mode, "pr");
		assert.equal(snap.baseSha, baseSha);
		assert.equal(snap.headSha, headSha);
		assert.equal(snap.items.length, 3);
		const byPath = new Map(snap.items.map((i) => [i.path, i]));
		const added = byPath.get("new.txt")!;
		assert.deepEqual(added.layers.map((l) => [l.source, l.state]), [["base", "deleted"], ["pr", "present"]]);
		const modified = byPath.get("app.txt")!;
		assert.deepEqual(modified.layers.map((l) => [l.source, l.state]), [["base", "present"], ["pr", "present"]]);
		assert.notEqual(modified.layers[0]!.sha256, modified.layers[1]!.sha256);
		const deleted = byPath.get("keep.txt")!;
		assert.deepEqual(deleted.layers.map((l) => [l.source, l.state]), [["base", "present"], ["pr", "deleted"]]);
		assert.equal(snap.fingerprint.length, 64);
		// Deterministic: capture time is not identity.
		assert.equal(capturePrSnapshot(work, baseSha, headSha, 1).fingerprint, snap.fingerprint);
	} finally {
		cleanup();
	}
});

test("capturePrSnapshot requires both commits locally", () => {
	const { work, baseSha, cleanup } = prFixture();
	try {
		const missing = "c".repeat(40);
		assert.throws(() => capturePrSnapshot(work, baseSha, missing, 1), /not available locally/);
	} finally {
		cleanup();
	}
});

test("capturePrSnapshot exclusions remove items and change the fingerprint", () => {
	const { work, baseSha, headSha, cleanup } = prFixture();
	try {
		const full = capturePrSnapshot(work, baseSha, headSha, 1);
		const excl = capturePrSnapshot(work, baseSha, headSha, 1, [{ path: "new.txt", reason: "generated" }]);
		assert.equal(excl.items.length, full.items.length - 1);
		assert.equal(excl.items.some((i) => i.path === "new.txt"), false);
		assert.notEqual(excl.fingerprint, full.fingerprint);
	} finally {
		cleanup();
	}
});

test("compareReviewSnapshots detects PR head drift via item changes", () => {
	const { work, baseSha, headSha, cleanup } = prFixture();
	try {
		const before = capturePrSnapshot(work, baseSha, headSha, 1);
		// Advance the head: append a commit and re-point the PR ref.
		writeFileSync(join(work, "extra.txt"), "later\n");
		git(work, "add", "-A");
		git(work, "commit", "-qm", "later");
		const newHead = git(work, "rev-parse", "HEAD");
		git(work, "update-ref", "refs/pull/1/head", newHead);
		const after = capturePrSnapshot(work, baseSha, newHead, 1);
		const drift = compareReviewSnapshots(before as never, after as never);
		assert.equal(drift.unchanged, false);
		assert.ok(drift.addedItemIds.length > 0 || drift.changedItemIds.length > 0);
	} finally {
		cleanup();
	}
});

// --- checkout assessment + execution ---------------------------------------

test("assessPrCheckout reports clean/dirty and remote presence", () => {
	const { work, cleanup } = prFixture();
	try {
		const clean = assessPrCheckout(work);
		assert.equal(clean.isRepo, true);
		assert.equal(clean.hasRemote, true);
		assert.equal(clean.remote, "origin");
		assert.equal(clean.clean, true);
		// Make it dirty.
		writeFileSync(join(work, "scratch.txt"), "untracked\n");
		const dirty = assessPrCheckout(work);
		assert.equal(dirty.clean, false);
		assert.ok(dirty.dirty.includes("scratch.txt"));
	} finally {
		cleanup();
	}
});

test("verifyGitObjects true when present, false otherwise", () => {
	const { work, baseSha, headSha, cleanup } = prFixture();
	try {
		// The clone fetches all origin refs, so both base and head are present.
		assert.equal(verifyGitObjects(work, [baseSha]), true);
		assert.equal(verifyGitObjects(work, [baseSha, headSha]), true);
		// A fabricated SHA is absent.
		assert.equal(verifyGitObjects(work, ["c".repeat(40)]), false);
	} finally {
		cleanup();
	}
});

function stubGh(view: PrViewResult): GhRunner {
	return {
		isAvailable: () => true,
		isAuthed: () => ({ ok: true }),
		prView: () => view,
		prCheckout: (root, n) => {
			git(root, "fetch", "origin", `refs/pull/${n}/head`);
			git(root, "checkout", "--detach", view.headRefOid);
			return "mock checkout";
		},
	};
}

test("performPrCheckout in-place lands the worktree on the PR head", () => {
	const { work, baseSha, headSha, cleanup } = prFixture();
	try {
		const resolved = resolvePrMeta(viewFor(baseSha, headSha));
		const outcome = performPrCheckout(work, resolved, "in-place", stubGh(viewFor(baseSha, headSha)), "origin");
		assert.equal(outcome.strategy, "in-place");
		assert.equal(outcome.location, work);
		assert.equal(outcome.head, headSha);
		assert.equal(git(work, "rev-parse", "HEAD"), headSha);
	} finally {
		cleanup();
	}
});

test("performPrCheckout worktree isolates the PR head from a dirty main tree", () => {
	const { work, baseSha, headSha, baseRef, cleanup } = prFixture();
	try {
		// Dirty the main worktree.
		writeFileSync(join(work, "local.txt"), "user work\n");
		const resolved = resolvePrMeta(viewFor(baseSha, headSha));
		const outcome = performPrCheckout(work, resolved, "worktree", stubGh(viewFor(baseSha, headSha)), "origin");
		assert.equal(outcome.strategy, "worktree");
		assert.notEqual(outcome.location, work);
		assert.equal(outcome.head, headSha);
		// Main worktree untouched: still on the base branch, local file present.
		assert.equal(git(work, "branch", "--show-current"), baseRef);
		assert.ok(existsSync(join(work, "local.txt")));
		// Worktree is at the head with the PR content.
		assert.equal(git(outcome.location, "rev-parse", "HEAD"), headSha);
		assert.equal(readFile(join(outcome.location, "app.txt")), "main+feat\n");
		// Cleanup removes the worktree, leaves the main repo.
		const msg = removePrWorktree(work, 1);
		assert.match(msg, /removed PR worktree/);
		assert.equal(existsSync(outcome.location), false);
		assert.ok(existsSync(join(work, "local.txt")));
	} finally {
		cleanup();
	}
});

function readFile(path: string): string {
	return readFileSync(path, "utf8");
}

test("buildPrMeta records original state + checkout outcome", () => {
	const { work, baseSha, headSha, cleanup } = prFixture();
	try {
		const resolved = resolvePrMeta(viewFor(baseSha, headSha));
		const outcome = performPrCheckout(work, resolved, "in-place", stubGh(viewFor(baseSha, headSha)), "origin");
		const meta = buildPrMeta(resolved, outcome, { branch: "main", head: baseSha, dirty: [] });
		assert.equal(meta.number, 1);
		assert.equal(meta.repository, "acme/widget");
		assert.equal(meta.checkoutStrategy, "in-place");
		assert.equal(meta.checkoutLocation, work);
		assert.equal(meta.originalBranch, "main");
		assert.equal(meta.originalHead, baseSha);
		assert.equal(meta.baseSha, baseSha);
		assert.equal(meta.headSha, headSha);
	} finally {
		cleanup();
	}
});
