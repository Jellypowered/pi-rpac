import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capturePrSnapshot, performPrCheckout, prWorktreePath, removePrWorktree, resolvePrMeta, selectPrRemote, type GhRunner } from "../../lib/pr.ts";
import { makeTempDir, removeTree } from "../../lib/util.ts";

function git(root: string, ...args: string[]): string {
 return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function fixture() {
 const dir = makeTempDir("rpac-adversarial-");
 const root = join(dir, "repo"); mkdirSync(root);
 git(root, "init", "-q"); git(root, "config", "user.name", "test"); git(root, "config", "user.email", "test@test");
 writeFileSync(join(root, "file"), "ancestor\n"); git(root, "add", "."); git(root, "commit", "-qm", "ancestor");
 const base = git(root, "rev-parse", "HEAD");
 git(root, "checkout", "-qb", "topic"); writeFileSync(join(root, "file"), "topic\n");
 git(root, "commit", "-qam", "topic"); const head = git(root, "rev-parse", "HEAD");
 git(root, "update-ref", "refs/pull/1/head", head);
 return { root, base, head, cleanup: () => removeTree(dir) };
}
function meta(base: string, head: string) {
 return resolvePrMeta({ number: 1, url: "https://github.com/acme/widget/pull/1", title: "test", body: "", state: "OPEN", baseRefName: "main", headRefName: "topic", baseRefOid: base, headRefOid: head });
}
const gh: GhRunner = { isAvailable: () => true, isAuthed: () => ({ok:true}), prView: () => { throw Error("unused"); }, prCheckout: () => { throw Error("unused"); } };

test("PR base layer is the merge base, not independently advanced base tip", () => {
 const f = fixture(); try {
  git(f.root, "checkout", "--detach", f.base); writeFileSync(join(f.root, "file"), "upstream\n"); git(f.root, "commit", "-qam", "upstream");
  const tip = git(f.root, "rev-parse", "HEAD");
  const snap = capturePrSnapshot(f.root, tip, f.head, 1);
  assert.equal(snap.items[0]!.layers[0]!.objectId, git(f.root, "rev-parse", `${f.base}:file`));
 } finally { f.cleanup(); }
});

test("PR snapshot preserves raw paths, modes, symlinks, gitlinks, renames and binary bytes", () => {
 const f = fixture(); try {
  git(f.root, "checkout", "--detach", f.base);
  const odd = Buffer.concat([Buffer.from(`${f.root}/odd-`), Buffer.from([0xff])]);
  writeFileSync(odd, "odd\n"); writeFileSync(join(f.root, "executable"), "#!/bin/sh\n"); chmodSync(join(f.root, "executable"), 0o755);
  symlinkSync("missing-target", join(f.root, "link")); writeFileSync(join(f.root, "binary"), Buffer.from([0,1,2]));
  git(f.root, "mv", "file", "renamed"); git(f.root, "add", "-A");
  git(f.root, "update-index", "--add", "--cacheinfo", `160000,${f.head},submodule`);
  git(f.root, "commit", "-qm", "types"); const head = git(f.root, "rev-parse", "HEAD");
  const snap = capturePrSnapshot(f.root, f.base, head, 1);
  const item = (p: string) => snap.items.find(i => i.path === p)!;
  assert.equal(item("submodule").layers[1]!.kind, "gitlink");
  assert.equal(item("executable").layers[1]!.mode, "100755");
  assert.equal(item("link").layers[1]!.kind, "symlink");
  assert.equal(item("binary").layers[1]!.binary, true);
  assert.equal(item("renamed").originalPath, "file");
  const raw = snap.items.find(i => Buffer.from(i.pathBase64, "base64").includes(0xff))!;
  assert.equal(raw.layers[1]!.state, "present"); assert.ok(raw.layers[1]!.objectId);
 } finally { f.cleanup(); }
});

test("PR cleanup refuses an arbitrary sibling directory without deleting its files", () => {
 const f = fixture(); try {
  const wt = prWorktreePath(f.root, 1); mkdirSync(wt); writeFileSync(join(wt, "precious"), "keep");
  assert.throws(() => removePrWorktree(f.root, 1), /owned|registered|ownership/);
  assert.equal(readFileSync(join(wt, "precious"), "utf8"), "keep");
 } finally { f.cleanup(); }
});

test("PR cleanup preserves dirty, untracked, and ignored files", () => {
 for (const kind of ["tracked", "untracked", "ignored", "assume-unchanged", "skip-worktree"]) {
  const f = fixture(); try {
   const outcome = performPrCheckout(f.root, meta(f.base, f.head), "worktree", gh, f.root);
   if (kind === "ignored") writeFileSync(join(f.root, ".git", "info", "exclude"), "precious\n");
   if (kind === "assume-unchanged" || kind === "skip-worktree") git(outcome.location, "update-index", `--${kind}`, "file");
   writeFileSync(join(outcome.location, ["tracked", "assume-unchanged", "skip-worktree"].includes(kind) ? "file" : "precious"), "keep");
   assert.throws(() => removePrWorktree(f.root, 1), /dirty|uncommitted|head|HEAD/);
   assert.ok(existsSync(outcome.location));
  } finally { f.cleanup(); }
 }
});

test("PR checkout refuses to reuse a foreign checkout even with the expected HEAD", () => {
 const f = fixture(); try {
  const wt = prWorktreePath(f.root, 1); git(f.root, "worktree", "add", "--detach", wt, f.head);
  assert.throws(() => performPrCheckout(f.root, meta(f.base, f.head), "worktree", gh, f.root), /owned|ownership/);
 } finally { f.cleanup(); }
});

test("PR checkout fails on fetch error even when a stale local PR ref matches", () => {
 const f = fixture(); try {
  git(f.root, "update-ref", "refs/rpac/pr/1", f.head);
  assert.throws(() => performPrCheckout(f.root, meta(f.base, f.head), "worktree", gh, "/does/not/exist"), /fetch/);
  assert.equal(existsSync(prWorktreePath(f.root, 1)), false);
 } finally { f.cleanup(); }
});

test("PR metadata rejects mismatched numbers, malformed identity, unknown state and unsafe integers", () => {
 const raw = { number: 1, url: "https://github.com/acme/widget/pull/1", title: "", body: "", state: "OPEN", baseRefName: "main", headRefName: "topic", baseRefOid: "a".repeat(40), headRefOid: "b".repeat(40) };
 for (const patch of [{ number: 2 }, { number: Number.MAX_SAFE_INTEGER + 1 }, { url: "https://evil.test/github.com/acme/widget/pull/1" }, { state: "UNKNOWN" }, { baseRefName: "--upload-pack=evil" }]) {
  assert.throws(() => resolvePrMeta({ ...raw, ...patch }, 1));
 }
});

test("PR remote selection matches host and BASE repository, including SSH and enterprise", () => {
 const f = fixture(); try {
  git(f.root, "remote", "add", "origin", "git@github.com:contributor/widget.git");
  git(f.root, "remote", "add", "upstream", "git@github.com:acme/widget.git");
  assert.equal(selectPrRemote(f.root, meta(f.base, f.head)), "upstream");
  git(f.root, "remote", "remove", "upstream");
  assert.throws(() => selectPrRemote(f.root, meta(f.base, f.head)), /no remote matches/);
  const enterprise = { ...meta(f.base, f.head), url: "https://git.example.test/acme/widget/pull/1" };
  git(f.root, "remote", "add", "enterprise", "ssh://git@git.example.test/acme/widget.git");
  assert.equal(selectPrRemote(f.root, enterprise), "enterprise");
 } finally { f.cleanup(); }
});

test("failed in-place checkout restores the original branch without force", () => {
 const f = fixture(); try {
  const branch = git(f.root, "branch", "--show-current");
  const runner = { ...gh, prCheckout(root: string) { git(root, "checkout", "--detach", f.base); throw Error("mock partial checkout failure"); } };
  assert.throws(() => performPrCheckout(f.root, meta(f.base, f.head), "in-place", runner), /partial checkout failure/);
  assert.equal(git(f.root, "branch", "--show-current"), branch);
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.head);
 } finally { f.cleanup(); }
});

test("failed checkout does not reset over newly created local work", () => {
 const f = fixture(); try {
  const runner = { ...gh, prCheckout(root: string) { git(root, "checkout", "--detach", f.base); writeFileSync(join(root, "precious"), "keep"); throw Error("partial failure"); } };
  assert.throws(() => performPrCheckout(f.root, meta(f.base, f.head), "in-place", runner), /restore manually/);
  assert.equal(readFileSync(join(f.root, "precious"), "utf8"), "keep");
 } finally { f.cleanup(); }
});

test("PR checkout and cleanup refuse symlinked locations; reuse refuses contaminated owned trees", () => {
 const f = fixture(); try {
  const target = join(f.root, "precious-dir"); mkdirSync(target); writeFileSync(join(target, "file"), "keep");
  const wt = prWorktreePath(f.root, 1); symlinkSync(target, wt);
  assert.throws(() => removePrWorktree(f.root, 1), /ownership/);
  assert.throws(() => performPrCheckout(f.root, meta(f.base, f.head), "worktree", gh, f.root), /ownership/);
  assert.equal(readFileSync(join(target, "file"), "utf8"), "keep");
 } finally { f.cleanup(); }
 const owned = fixture(); try {
  const outcome = performPrCheckout(owned.root, meta(owned.base, owned.head), "worktree", gh, owned.root);
  writeFileSync(join(outcome.location, "precious"), "keep");
  assert.throws(() => performPrCheckout(owned.root, meta(owned.base, owned.head), "worktree", gh, owned.root), /dirty/);
 } finally { owned.cleanup(); }
});

test("PR mode-only changes retain modes; raw deleted paths retain base bytes; internal state is excluded", () => {
 const f = fixture(); try {
  const odd = Buffer.concat([Buffer.from(`${f.root}/raw-`), Buffer.from([0xff])]);
  writeFileSync(odd, "raw-base\n"); git(f.root, "add", "-A"); git(f.root, "commit", "-qm", "raw");
  const base = git(f.root, "rev-parse", "HEAD");
  chmodSync(join(f.root, "file"), 0o755);
  // Git accepts raw bytes via the index; deletion via fs avoids any UTF-8 conversion.
  unlinkSync(odd);
  mkdirSync(join(f.root, ".pi", "rpac"), { recursive: true }); writeFileSync(join(f.root, ".pi", "rpac", "evil"), "state");
  git(f.root, "add", "-A"); git(f.root, "commit", "-qm", "mode and delete");
  const snap = capturePrSnapshot(f.root, base, git(f.root, "rev-parse", "HEAD"), 1);
  const mode = snap.items.find(i => i.path === "file")!;
  assert.equal(mode.layers[0]!.sha256, mode.layers[1]!.sha256);
  assert.deepEqual(mode.layers.map(l => l.mode), ["100644", "100755"]);
  const raw = snap.items.find(i => Buffer.from(i.pathBase64, "base64").includes(0xff))!;
  assert.equal(raw.layers[0]!.objectId, execFileSync("git", ["hash-object", "--stdin"], { cwd: f.root, input: "raw-base\n", encoding: "utf8" }).trim());
  assert.equal(raw.layers[1]!.state, "deleted");
  assert.equal(snap.items.some(i => i.path.startsWith(".pi/rpac")), false);
 } finally { f.cleanup(); }
});
