import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, isWithin, makeTempDir, projectRoot, removeTree, sha256File, slugify, truncate } from "../../lib/util.ts";

test("slugify produces kebab-case slugs", () => {
	assert.equal(slugify("Add --retry flag! to /api/v2 endpoints"), "add-retry-flag-to-api-v2-endpoints");
	assert.equal(slugify("   "), "task");
	assert.equal(slugify("A").length, 1);
	assert.ok(slugify("x".repeat(100), 20).length <= 20);
});

test("truncate caps length with ellipsis", () => {
	assert.equal(truncate("hello", 10), "hello");
	assert.equal(truncate("hello world", 5), "hell…");
});

test("sha256File: content hash, empty for missing file", () => {
	const dir = makeTempDir();
	try {
		const f = join(dir, "a.txt");
		writeFileSync(f, "abc");
		assert.equal(sha256File(f), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		assert.equal(sha256File(join(dir, "nope.txt")), "");
	} finally {
		removeTree(dir);
	}
});

test("atomicWriteFile writes full content and leaves no temp files", () => {
	const dir = makeTempDir();
	try {
		const f = join(dir, "out.txt");
		const content = "x".repeat(100_000);
		atomicWriteFile(f, content);
		assert.equal(readFileSync(f, "utf8"), content);
		const leftovers = readdirSync(dir).filter((n) => n.includes(".tmp"));
		assert.deepEqual(leftovers, []);
		// overwrites atomically
		atomicWriteFile(f, "short");
		assert.equal(readFileSync(f, "utf8"), "short");
	} finally {
		removeTree(dir);
	}
});

test("atomicWriteFile cleans up the temp file when the write fails", () => {
	const dir = makeTempDir();
	try {
		// the target exists as a directory: the temp file is created and written,
		// then the rename fails — the .tmp must be cleaned up
		const target = join(dir, "out.txt");
		mkdirSync(target);
		assert.throws(() => atomicWriteFile(target, "x"));
		const leftovers = readdirSync(dir).filter((n) => n.includes(".tmp"));
		assert.deepEqual(leftovers, []);
	} finally {
		removeTree(dir);
	}
});

test("projectRoot: git toplevel inside a repo, cwd outside", () => {
	const dir = makeTempDir();
	try {
		assert.equal(projectRoot(dir), dir);
		execFileSync("git", ["init", "-q"], { cwd: dir });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "c1"], { cwd: dir });
		const sub = join(dir, "a", "b");
		mkdirSync(sub, { recursive: true });
		assert.equal(projectRoot(sub), dir);
	} finally {
		removeTree(dir);
	}
});

test("isWithin rejects traversal outside the root", () => {
	const root = "/work/proj";
	assert.ok(isWithin(root, "src/a.ts"));
	assert.ok(isWithin(root, "/work/proj/src/a.ts"));
	assert.ok(!isWithin(root, "../other/a.ts"));
	assert.ok(!isWithin(root, "/work/other/a.ts"));
});

test("existsSync import sanity (util module loads under type stripping)", () => {
	assert.ok(existsSync("/"));
});
