import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureReviewSnapshot, compareReviewSnapshots } from "../../lib/review.ts";
import { makeTempDir, removeTree } from "../../lib/util.ts";

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function freshRepo(withCommit = true): { root: string; cleanup: () => void } {
	const root = makeTempDir("rpac-review-");
	git(root, "init", "-q");
	git(root, "config", "user.email", "review@test");
	git(root, "config", "user.name", "Review Test");
	if (withCommit) {
		writeFileSync(join(root, "base.txt"), "base\n");
		git(root, "add", "--", "base.txt");
		git(root, "commit", "-qm", "base");
	}
	return { root, cleanup: () => removeTree(root) };
}

function item(snapshot: ReturnType<typeof captureReviewSnapshot>, path: string) {
	return snapshot.items.find((entry) => entry.path === path);
}

test("review snapshot requires a Git work tree", () => {
	const root = makeTempDir("rpac-review-nongit-");
	try {
		assert.throws(() => captureReviewSnapshot(root, "current"), /requires a Git work tree/);
	} finally {
		removeTree(root);
	}
});

test("current captures staged, unstaged, untracked, and distinct index/disk bytes", () => {
	const { root, cleanup } = freshRepo();
	try {
		writeFileSync(join(root, "base.txt"), "staged\n");
		git(root, "add", "--", "base.txt");
		writeFileSync(join(root, "base.txt"), "disk\n");
		writeFileSync(join(root, "new.txt"), "new\n");
		const snapshot = captureReviewSnapshot(root, "current");
		assert.deepEqual(snapshot.items.map((entry) => entry.path), ["base.txt", "new.txt"]);
		const changed = item(snapshot, "base.txt")!;
		assert.deepEqual(changed.layers.map((layer) => layer.source), ["head", "index", "worktree"]);
		assert.notEqual(changed.layers[1]!.sha256, changed.layers[2]!.sha256);
		assert.equal(item(snapshot, "new.txt")!.layers[1]!.state, "deleted");
		assert.equal(snapshot.fingerprint.length, 64);
		assert.equal(captureReviewSnapshot(root, "current").fingerprint, snapshot.fingerprint, "capture time is not identity");
	} finally {
		cleanup();
	}
});

test("current keeps staged edits that are canceled by the working tree", () => {
	const { root, cleanup } = freshRepo();
	try {
		const original = readFileSync(join(root, "base.txt"));
		writeFileSync(join(root, "base.txt"), "staged only\n");
		git(root, "add", "--", "base.txt");
		writeFileSync(join(root, "base.txt"), original);
		const snapshot = captureReviewSnapshot(root, "current");
		const changed = item(snapshot, "base.txt")!;
		assert.ok(changed, "union scope retains the path even though git diff HEAD is empty");
		assert.notEqual(changed.layers[1]!.sha256, changed.layers[2]!.sha256);
		assert.equal(changed.layers[0]!.sha256, changed.layers[2]!.sha256);
	} finally {
		cleanup();
	}
});

test("staged uses index bytes and ignores unstaged and untracked drift", () => {
	const { root, cleanup } = freshRepo();
	try {
		writeFileSync(join(root, "base.txt"), "staged\n");
		git(root, "add", "--", "base.txt");
		const before = captureReviewSnapshot(root, "staged");
		writeFileSync(join(root, "base.txt"), "disk only\n");
		writeFileSync(join(root, "untracked.txt"), "ignored by staged\n");
		const after = captureReviewSnapshot(root, "staged");
		assert.equal(after.items.length, 1);
		assert.deepEqual(after.items[0]!.layers.map((layer) => layer.source), ["head", "index"]);
		assert.equal(compareReviewSnapshots(before, after).unchanged, true);
		git(root, "add", "--", "base.txt");
		const changed = captureReviewSnapshot(root, "staged");
		assert.equal(compareReviewSnapshots(before, changed).unchanged, false);
	} finally {
		cleanup();
	}
});

test("full includes tracked/untracked files and records tracked deletions while excluding ignored and RPAC state", () => {
	const { root, cleanup } = freshRepo();
	try {
		writeFileSync(join(root, ".gitignore"), "ignored.txt\n.pi/\n");
		writeFileSync(join(root, "tracked.txt"), "tracked\n");
		git(root, "add", "--", ".gitignore", "tracked.txt");
		git(root, "commit", "-qm", "more");
		writeFileSync(join(root, "untracked.txt"), "untracked\n");
		writeFileSync(join(root, "ignored.txt"), "ignored\n");
		mkdirSync(join(root, ".pi", "rpac", "w-test"), { recursive: true });
		writeFileSync(join(root, ".pi", "rpac", "w-test", "workflow.json"), "{}\n");
		writeFileSync(join(root, "tracked.txt"), "changed on disk\n");
		const deleted = join(root, "base.txt");
		unlinkSync(deleted);
		const snapshot = captureReviewSnapshot(root, "full");
		assert.ok(item(snapshot, ".gitignore"));
		assert.ok(item(snapshot, "tracked.txt"));
		assert.ok(item(snapshot, "untracked.txt"));
		assert.equal(item(snapshot, "base.txt")!.layers.at(-1)!.state, "deleted");
		assert.equal(item(snapshot, "ignored.txt"), undefined);
		assert.equal(snapshot.items.some((entry) => entry.path.startsWith(".pi/rpac/")), false);
	} finally {
		cleanup();
	}
});

test("empty and unborn scopes are valid", () => {
	const committed = freshRepo();
	try {
		const empty = captureReviewSnapshot(committed.root, "current");
		assert.equal(empty.items.length, 0);
		assert.equal(empty.unborn, false);
	} finally {
		committed.cleanup();
	}
	const unborn = freshRepo(false);
	try {
		writeFileSync(join(unborn.root, "first.txt"), "first\n");
		git(unborn.root, "add", "--", "first.txt");
		const staged = captureReviewSnapshot(unborn.root, "staged");
		assert.equal(staged.unborn, true);
		assert.equal(staged.head, "unborn");
		assert.equal(item(staged, "first.txt")!.layers[0]!.state, "deleted");
		assert.equal(item(staged, "first.txt")!.layers[1]!.state, "present");
	} finally {
		unborn.cleanup();
	}
});

test("manifest handles rename, mode change, odd names, symlinks, binary and large files", () => {
	const { root, cleanup } = freshRepo();
	try {
		writeFileSync(join(root, "rename-me.txt"), "rename\n");
		writeFileSync(join(root, "mode.sh"), "#!/bin/sh\nexit 0\n");
		git(root, "add", "--", "rename-me.txt", "mode.sh");
		git(root, "commit", "-qm", "fixture");
		git(root, "mv", "--", "rename-me.txt", "renamed.txt");
		chmodSync(join(root, "mode.sh"), 0o755);
		writeFileSync(join(root, "- leading\nname.txt"), "odd\n");
		symlinkSync("base.txt", join(root, "link"));
		writeFileSync(join(root, "binary.bin"), Buffer.from([1, 0, 2]));
		writeFileSync(join(root, "large.bin"), Buffer.alloc(1024 * 1024 + 1, 7));
		const current = captureReviewSnapshot(root, "current");
		const renamed = item(current, "renamed.txt")!;
		assert.equal(renamed.originalPath, "rename-me.txt");
		assert.ok(item(current, "mode.sh")!.layers.some((layer) => layer.mode === "100755"));
		assert.ok(item(current, "- leading\nname.txt"));
		assert.equal(item(current, "link")!.layers.at(-1)!.kind, "symlink");
		assert.equal(item(current, "binary.bin")!.layers.at(-1)!.binary, true);
		assert.equal(item(current, "large.bin")!.layers.at(-1)!.large, true);
	} finally {
		cleanup();
	}
});

test("full records gitlinks without recursively auditing the nested repository", () => {
	const { root, cleanup } = freshRepo();
	const child = freshRepo();
	try {
		execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", child.root, "vendor/child"], {
			cwd: root,
			stdio: "ignore",
		});
		git(root, "commit", "-qam", "submodule");
		const snapshot = captureReviewSnapshot(root, "full");
		const gitlink = item(snapshot, "vendor/child")!;
		assert.ok(gitlink.layers.some((layer) => layer.kind === "gitlink"));
		assert.equal(snapshot.items.some((entry) => entry.path === "vendor/child/base.txt"), false);
	} finally {
		child.cleanup();
		cleanup();
	}
});

test("conflicts are explicit and exact exclusions affect the fingerprint", () => {
	const { root, cleanup } = freshRepo();
	try {
		const branch = git(root, "branch", "--show-current") || "master";
		git(root, "checkout", "-qb", "side");
		writeFileSync(join(root, "base.txt"), "side\n");
		git(root, "commit", "-qam", "side");
		git(root, "checkout", "-q", branch);
		writeFileSync(join(root, "base.txt"), "main\n");
		git(root, "commit", "-qam", "main");
		try {
			git(root, "merge", "side");
		} catch {
			// expected conflict
		}
		const conflicted = captureReviewSnapshot(root, "current");
		assert.equal(item(conflicted, "base.txt")!.conflicted, true);
		assert.deepEqual(conflicted.conflictItemIds, [item(conflicted, "base.txt")!.id]);
		const excluded = captureReviewSnapshot(root, "current", [{ path: "base.txt", reason: "known conflict report" }]);
		assert.equal(excluded.items.length, 0);
		assert.notEqual(excluded.fingerprint, conflicted.fingerprint);
	} finally {
		cleanup();
	}
});

test("patch fingerprints ignore exact exclusions and tracked RPAC state churn", () => {
	const { root, cleanup } = freshRepo();
	try {
		mkdirSync(join(root, ".pi", "rpac"), { recursive: true });
		writeFileSync(join(root, "excluded.txt"), "base\n");
		writeFileSync(join(root, ".pi", "rpac", "tracked.txt"), "state one\n");
		git(root, "add", "-f", "--", "excluded.txt", ".pi/rpac/tracked.txt");
		git(root, "commit", "-qm", "tracked exclusions");
		const exclusions = [{ path: "excluded.txt", reason: "local scratch" }];

		writeFileSync(join(root, "excluded.txt"), "staged one\n");
		writeFileSync(join(root, ".pi", "rpac", "tracked.txt"), "state two\n");
		git(root, "add", "-f", "--", "excluded.txt", ".pi/rpac/tracked.txt");
		const stagedBefore = captureReviewSnapshot(root, "staged", exclusions);
		assert.equal(stagedBefore.items.length, 0);
		writeFileSync(join(root, "excluded.txt"), "staged two\n");
		writeFileSync(join(root, ".pi", "rpac", "tracked.txt"), "state three\n");
		git(root, "add", "-f", "--", "excluded.txt", ".pi/rpac/tracked.txt");
		const stagedAfter = captureReviewSnapshot(root, "staged", exclusions);
		assert.equal(compareReviewSnapshots(stagedBefore, stagedAfter).unchanged, true);

		writeFileSync(join(root, "excluded.txt"), "disk one\n");
		writeFileSync(join(root, ".pi", "rpac", "tracked.txt"), "state four\n");
		const currentBefore = captureReviewSnapshot(root, "current", exclusions);
		assert.equal(currentBefore.items.length, 0);
		writeFileSync(join(root, "excluded.txt"), "disk two\n");
		writeFileSync(join(root, ".pi", "rpac", "tracked.txt"), "state five\n");
		const currentAfter = captureReviewSnapshot(root, "current", exclusions);
		assert.equal(compareReviewSnapshots(currentBefore, currentAfter).unchanged, true);
	} finally {
		cleanup();
	}
});

test("excluding a renamed destination also excludes its original path from patch identity", () => {
	const { root, cleanup } = freshRepo();
	try {
		git(root, "mv", "base.txt", "excluded.txt");
		const exclusions = [{ path: "excluded.txt", reason: "renamed scratch file" }];
		const snapshot = captureReviewSnapshot(root, "staged", exclusions);
		assert.equal(snapshot.items.length, 0);
		assert.equal(snapshot.patches.staged, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "rename source and destination are both absent from patch identity");
	} finally {
		cleanup();
	}
});

test("compareReviewSnapshots identifies added, removed, and changed items", () => {
	const { root, cleanup } = freshRepo();
	try {
		writeFileSync(join(root, "change.txt"), "one\n");
		writeFileSync(join(root, "remove.txt"), "one\n");
		const before = captureReviewSnapshot(root, "current");
		writeFileSync(join(root, "change.txt"), "two\n");
		unlinkSync(join(root, "remove.txt"));
		writeFileSync(join(root, "add.txt"), "new\n");
		const after = captureReviewSnapshot(root, "current");
		const drift = compareReviewSnapshots(before, after);
		assert.equal(drift.unchanged, false);
		assert.deepEqual(drift.addedItemIds, [item(after, "add.txt")!.id]);
		assert.deepEqual(drift.removedItemIds, [item(before, "remove.txt")!.id]);
		assert.deepEqual(drift.changedItemIds, [item(before, "change.txt")!.id]);
	} finally {
		cleanup();
	}
});
