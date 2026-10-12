import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureBaseline, detectDivergence, gitInfo } from "../../lib/git.ts";
import { makeTempDir, removeTree } from "../../lib/util.ts";

function git(repo: string, ...args: string[]): void {
	execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

function freshRepo(): { root: string; cleanup: () => void } {
	const root = makeTempDir();
	git(root, "init", "-q");
	git(root, "config", "user.email", "t@t");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "a.txt"), "a\n");
	git(root, "add", "a.txt");
	git(root, "commit", "-q", "-m", "c1");
	return { root, cleanup: () => removeTree(root) };
}

test("gitInfo: reports head, branch, and dirty files (modified + untracked)", () => {
	const { root, cleanup } = freshRepo();
	try {
		const before = gitInfo(root);
		assert.equal(before.isRepo, true);
		assert.equal(before.root, root);
		assert.equal(before.head.length, 40);
		assert.deepEqual(before.dirty, []);

		writeFileSync(join(root, "a.txt"), "a changed\n"); // modified
		writeFileSync(join(root, "new.txt"), "n\n"); // untracked
		const after = gitInfo(root);
		assert.ok(after.dirty.includes("a.txt"));
		assert.ok(after.dirty.includes("new.txt"));
	} finally {
		cleanup();
	}
});

test("gitInfo: non-repo degrades gracefully", () => {
	const root = makeTempDir();
	try {
		const info = gitInfo(root);
		assert.equal(info.isRepo, false);
		assert.equal(info.root, null);
		assert.deepEqual(info.dirty, []);
	} finally {
		removeTree(root);
	}
});

test("captureBaseline + detectDivergence: detects head moves and new/committed dirty files", () => {
	const { root, cleanup } = freshRepo();
	try {
		// baseline on a dirty tree
		writeFileSync(join(root, "wip.txt"), "wip\n");
		const baseline = captureBaseline(root);
		assert.ok(baseline);
		assert.ok(baseline.dirty.includes("wip.txt"));

		// unchanged -> matches baseline
		let div = detectDivergence(root, baseline);
		assert.equal(div.noBaseline, false);
		assert.equal(div.summary, "working tree matches baseline");

		// commit the wip file + create a new dirty file + move HEAD
		git(root, "add", "wip.txt");
		git(root, "commit", "-q", "-m", "c2");
		writeFileSync(join(root, "brand.txt"), "b\n");
		div = detectDivergence(root, baseline);
		assert.equal(div.headMoved, true);
		assert.ok(div.committedSince.includes("wip.txt"));
		assert.ok(div.newDirty.includes("brand.txt"));
		assert.match(div.summary, /HEAD moved/);
	} finally {
		cleanup();
	}
});

test("detectDivergence: no baseline is reported, not an error", () => {
	const { root, cleanup } = freshRepo();
	try {
		const div = detectDivergence(root, undefined);
		assert.equal(div.noBaseline, true);
		assert.equal(div.headMoved, false);
	} finally {
		cleanup();
	}
});

test("detectDivergence: .pi/rpac/ state churn is expected, not reported as divergence", () => {
	const { root, cleanup } = freshRepo();
	try {
		const baseline = captureBaseline(root);
		assert.ok(baseline);
		// RPAC writes its own state under .pi/rpac/
		mkdirSync(join(root, ".pi", "rpac", "w-test"), { recursive: true });
		writeFileSync(join(root, ".pi", "rpac", "w-test", "workflow.json"), "{}\n");
		const div = detectDivergence(root, baseline);
		assert.deepEqual(div.newDirty, [], "RPAC state files are not user divergence");
		assert.ok(div.expectedRpacChanges > 0);
		assert.match(div.summary, /only RPAC state files.*expected/i);
		// an external change still shows up next to it
		writeFileSync(join(root, "external.txt"), "x\n");
		const div2 = detectDivergence(root, baseline);
		assert.ok(div2.newDirty.includes("external.txt"));
		assert.match(div2.summary, /1 new uncommitted file/);
	} finally {
		cleanup();
	}
});
