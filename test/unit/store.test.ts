import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	appendLog,
	createWorkflow,
	loadActive,
	listWorkflows,
	peekActive,
	removeAll,
	switchActive,
	updateActive,
	artifactPresent,
} from "../../lib/store.ts";
import { RpacStateError, newState } from "../../lib/schema.ts";
import { workflowDir, workflowFile, indexPath, rpacDir, quarantineDir } from "../../lib/paths.ts";
import { nowIso, projectRoot, makeTempDir, removeTree } from "../../lib/util.ts";

let repo: string;

before(() => {
	repo = makeTempDir("rpac-store-");
	mkdirSync(repo, { recursive: true });
	writeFileSync(join(repo, "README.md"), "# demo\n");
	execFileSync("git", ["init", "-q"], { cwd: repo });
});

after(() => {
	removeTree(repo);
});

function freshWorkflow(task: string) {
	const state = newState(repo, task);
	// force: previous test workflows stay saved; this test just needs a new one
	const { id } = createWorkflow(repo, state, true);
	return { id, state };
}

test("createWorkflow + loadActive round-trips and binds to the project root", () => {
	const { id, state } = freshWorkflow("first task");
	assert.ok(id.startsWith("w-"));
	assert.equal(state.project, repo);
	assert.ok(existsSync(workflowFile(repo, id)), "workflow.json in the per-workflow dir");
	assert.ok(existsSync(indexPath(repo)), "state.json index exists");
	const { index, state: loaded } = loadActive(repo, repo);
	assert.equal(loaded!.id, id);
	assert.equal(index.active, id);
	assert.equal(index.workflows[id]!.phase, "refine");
	// per-workflow log was created with a header
	const log = readFileSync(join(workflowDir(repo, id), "log.md"), "utf8");
	assert.match(log, /workflow started: first task/);
});

test("createWorkflow refuses to replace a non-terminal active workflow without force", () => {
	freshWorkflow("keeper");
	const other = newState(repo, "intruder");
	assert.throws(
		() => createWorkflow(repo, other),
		(e: Error) => e instanceof RpacStateError && /active RPAC workflow already exists/.test(e.message),
	);
	// with explicit consent (force) it proceeds — the old workflow is kept intact
	const { id: newId } = createWorkflow(repo, other, true);
	const { index, state } = loadActive(repo, repo);
	assert.equal(index.active, newId);
	assert.equal(state!.task, "intruder");
	assert.ok(index.workflows[Object.keys(index.workflows)[0]!] || index.workflows[newId], "index lists workflows");
});

test("a second workflow never touches the first workflow's artifacts", () => {
	const first = freshWorkflow("first");
	// write the first workflow's artifacts
	mkdirSync(workflowDir(repo, first.id), { recursive: true });
	writeFileSync(join(workflowDir(repo, first.id), "requirements.md"), "# R1 first requirements content\nline\nline\n");
	writeFileSync(join(workflowDir(repo, first.id), "plan.md"), "# P1 first plan content\nline\nline\n");
	const reqBefore = readFileSync(join(workflowDir(repo, first.id), "requirements.md"), "utf8");

	const second = freshWorkflow("second");
	// simulate the second workflow writing its own artifacts
	writeFileSync(join(workflowDir(repo, second.id), "requirements.md"), "# R2 second requirements\nline\nline\n");
	writeFileSync(join(workflowDir(repo, second.id), "plan.md"), "# P2 second plan\nline\nline\n");

	// first workflow artifacts are byte-identical and still on disk
	assert.equal(readFileSync(join(workflowDir(repo, first.id), "requirements.md"), "utf8"), reqBefore);
	assert.match(readFileSync(join(workflowDir(repo, first.id), "plan.md"), "utf8"), /P1 first plan/);
	// both workflows listed
	const all = listWorkflows(repo);
	assert.ok(all.some((w) => w.id === first.id));
	assert.ok(all.some((w) => w.id === second.id));
	// the first workflow can be re-activated and re-read
	switchActive(repo, first.id);
	const { state } = loadActive(repo, repo);
	assert.equal(state!.id, first.id);
	assert.equal(state!.task, "first");
	assert.ok(artifactPresent(repo, first.id, "requirements"));
	switchActive(repo, second.id);
});

test("updateActive leaves state untouched when the mutator throws", () => {
	const { id } = freshWorkflow("stable");
	const before = readFileSync(workflowFile(repo, id), "utf8");
	assert.throws(
		() => updateActive(repo, (s) => { s.phase = "plan"; throw new Error("boom"); }),
		/boom/,
	);
	const after = readFileSync(workflowFile(repo, id), "utf8");
	assert.equal(after, before);
});

test("a state tampered to another project is refused on load (wrong_project)", () => {
	const { id } = freshWorkflow("tampered");
	const f = workflowFile(repo, id);
	const raw = JSON.parse(readFileSync(f, "utf8"));
	raw.project = "/another/project";
	writeFileSync(f, JSON.stringify(raw), "utf8");
	const { state, notes } = loadActive(repo, repo);
	assert.equal(state, null);
	assert.ok(notes.some((n) => /another project|refusing/.test(n)), `notes: ${notes.join("; ")}`);
	// the file itself is preserved (it is valid, just foreign)
	assert.ok(existsSync(f));
});

test("appendLog appends lines in order and keeps the log bounded", () => {
	const { id } = freshWorkflow("loggy");
	for (let i = 0; i < 650; i++) appendLog(repo, id, `- line ${i}`);
	const content = readFileSync(join(workflowDir(repo, id), "log.md"), "utf8");
	const lines = content.split("\n");
	assert.ok(lines.length <= 600, `log stays bounded (got ${lines.length} lines)`);
	assert.match(content, /older log entries trimmed/);
	// most recent entries survive
	assert.ok(content.includes("- line 649"));
	// ordering preserved among survivors
	const idx648 = content.indexOf("- line 648");
	const idx649 = content.indexOf("- line 649");
	assert.ok(idx648 > -1 && idx649 > idx648);
});

test("removeAll removes all state while retaining the lock directory", () => {
	freshWorkflow("doomed");
	removeAll(repo);
	assert.equal(existsSync(rpacDir(repo)), true);
	assert.deepEqual(readdirSync(rpacDir(repo)), [], "no workflow, index, artifact, or lock remains");
});

test("projectRoot matches the git toplevel used by the store", () => {
	const sub = join(repo, "sub", "dir");
	mkdirSync(sub, { recursive: true });
	assert.equal(projectRoot(sub), repo);
});

test("corrupt workflow.json is quarantined, reported, and does not crash", () => {
	const { id } = freshWorkflow("corruptible");
	writeFileSync(workflowFile(repo, id), "{ not valid json", "utf8");
	const { state, index, notes } = loadActive(repo, repo);
	assert.equal(state, null, "no usable active state");
	assert.equal(index.active, null, "stale active pointer repaired");
	assert.equal(index.workflows[id], undefined, "stale workflow summary removed");
	assert.ok(notes.some((n) => /quarantined/.test(n)), `notes mention quarantine: ${notes.join("; ")}`);
	const qdir = quarantineDir(repo);
	assert.ok(existsSync(qdir) && readdirSync(qdir).some((f) => f.startsWith("workflow-")), "quarantine file exists");
	assert.equal(existsSync(workflowFile(repo, id)), false, "original moved aside");
	// a second load is stable (no crash loop, no double quarantine of the same file)
	const again = loadActive(repo, repo);
	assert.equal(again.state, null);
});

test("corrupt state.json is quarantined and the index rebuilt from workflow dirs", () => {
	const a = freshWorkflow("rebuild a");
	const b = freshWorkflow("rebuild b");
	writeFileSync(indexPath(repo), "}{", "utf8");
	const { index, notes } = loadActive(repo, repo);
	assert.ok(index.workflows[a.id], "workflow a recovered");
	assert.ok(index.workflows[b.id], "workflow b recovered");
	assert.ok(notes.some((n) => /state\.json/.test(n)), "notes mention the bad index");
	assert.equal(existsSync(indexPath(repo)), false, "bad index quarantined");
});

test("unsupported future version is rejected and left untouched", () => {
	const { id } = freshWorkflow("future");
	const f = workflowFile(repo, id);
	const raw = JSON.parse(readFileSync(f, "utf8"));
	raw.version = 99;
	writeFileSync(f, JSON.stringify(raw), "utf8");
	const { state, notes } = loadActive(repo, repo);
	assert.equal(state, null);
	assert.ok(notes.some((n) => /newer than the supported/.test(n)), `notes: ${notes.join("; ")}`);
	assert.ok(existsSync(f), "future-version file untouched (not quarantined)");
	// restore so cleanup is clean
	raw.version = 2;
	writeFileSync(f, JSON.stringify(raw), "utf8");
});

test("peekActive reads without the lock and is null on pending legacy migration", () => {
	const { id } = freshWorkflow("peekable");
	const s = peekActive(repo, repo);
	assert.ok(s && s.id === id);
	// legacy layout present → v2 peek is null (migration happens on the next locked op)
	const legacy = makeTempDir("rpac-legacy-peek-");
	try {
		mkdirSync(join(legacy, ".pi", "rpac"), { recursive: true });
		const st = newState(legacy, "legacy task");
		st.version = 1;
		writeFileSync(join(legacy, ".pi", "rpac", "workflow.json"), JSON.stringify(st), "utf8");
		assert.equal(peekActive(legacy, legacy), null);
	} finally {
		removeTree(legacy);
	}
});

test("migration: v1 shared layout becomes a per-workflow directory (nothing lost)", () => {
	const legacy = makeTempDir("rpac-migrate-");
	try {
		const dir = join(legacy, ".pi", "rpac");
		mkdirSync(join(dir, "archive"), { recursive: true });
		const st = newState(legacy, "legacy active task");
		st.version = 1;
		st.phase = "act";
		st.approvals = { requirements: true, plan: true, sequential: false };
		st.tasks = [{ id: 1, title: "legacy task", status: "in_progress" }];
		writeFileSync(join(dir, "workflow.json"), JSON.stringify(st), "utf8");
		writeFileSync(join(dir, "requirements.md"), "# legacy requirements body\nline\nline\n");
		writeFileSync(join(dir, "plan.md"), "# legacy plan body\nline\nline\n");
		writeFileSync(join(dir, "log.md"), "# RPAC log — legacy\n");
		// an archived v1 workflow
		const arch = newState(legacy, "legacy archived task");
		arch.version = 1;
		arch.id = "w-archived1";
		arch.phase = "done";
		arch.artifacts = { requirements: { path: ".pi/rpac/requirements.md", sha256: "ab".repeat(32) } };
		writeFileSync(join(dir, "archive", "w-archived1.json"), JSON.stringify(arch), "utf8");

		const { index, state, notes } = loadActive(legacy, legacy);
		assert.ok(state, "active workflow present");
		assert.equal(state!.task, "legacy active task");
		assert.equal(state!.version, 2, "bumped to v2");
		const wfDir = workflowDir(legacy, state!.id);
		assert.ok(existsSync(join(wfDir, "workflow.json")));
		assert.equal(readFileSync(join(wfDir, "requirements.md"), "utf8"), "# legacy requirements body\nline\nline\n", "requirements moved into the workflow dir");
		assert.equal(readFileSync(join(wfDir, "plan.md"), "utf8"), "# legacy plan body\nline\nline\n", "plan moved into the workflow dir");
		assert.equal(readFileSync(join(wfDir, "log.md"), "utf8"), "# RPAC log — legacy\n");
		assert.equal(existsSync(join(dir, "workflow.json")), false, "legacy shared workflow.json consumed");
		assert.equal(existsSync(join(dir, "requirements.md")), false, "legacy shared requirements consumed");
		// archived workflow recovered as its own directory
		assert.ok(index.workflows["w-archived1"], "archived workflow in the index");
		assert.ok(existsSync(join(workflowDir(legacy, "w-archived1"), "workflow.json")));
		const archState = JSON.parse(readFileSync(join(workflowDir(legacy, "w-archived1"), "workflow.json"), "utf8"));
		assert.equal(archState.version, 2);
		assert.deepEqual(archState.artifacts, {}); // shared files cannot be attributed — honestly cleared
		assert.ok(archState.events.some((e: { detail: string }) => /migrated/.test(e.detail)));
		assert.ok(notes.some((n) => /migrated/.test(n)));
		// migration is idempotent (nothing left to migrate)
		const second = loadActive(legacy, legacy);
		assert.equal(second.migrated, false);
	} finally {
		removeTree(legacy);
	}
});

test("migration: corrupt v1 state is quarantined, not destroyed", () => {
	const legacy = makeTempDir("rpac-migrate-bad-");
	try {
		const dir = join(legacy, ".pi", "rpac");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "workflow.json"), "{ broken", "utf8");
		writeFileSync(join(dir, "requirements.md"), "# orphan requirements\n");
		const { notes } = loadActive(legacy, legacy);
		assert.ok(notes.some((n) => /quarantined/.test(n)), `notes: ${notes.join("; ")}`);
		// the orphaned requirements file is preserved in place (never deleted)
		assert.ok(existsSync(join(dir, "requirements.md")));
	} finally {
		removeTree(legacy);
	}
});

test("migration is skipped for a v1 file bound to another project", () => {
	const legacy = makeTempDir("rpac-migrate-foreign-");
	try {
		const dir = join(legacy, ".pi", "rpac");
		mkdirSync(dir, { recursive: true });
		const st = newState("/somewhere/else", "foreign");
		st.version = 1;
		writeFileSync(join(dir, "workflow.json"), JSON.stringify(st), "utf8");
		const { state, notes } = loadActive(legacy, legacy);
		assert.equal(state, null);
		assert.ok(notes.some((n) => /another project root/.test(n)), `notes: ${notes.join("; ")}`);
		assert.ok(existsSync(join(dir, "workflow.json")), "foreign legacy file left untouched");
	} finally {
		removeTree(legacy);
	}
});

test("switchActive to an unknown id is a clean error", () => {
	freshWorkflow("only");
	assert.throws(() => switchActive(repo, "w-doesnotexist"), (e: Error) => e instanceof RpacStateError && e.code === "not_found");
});

test("listWorkflows puts the active workflow first", () => {
	const a = freshWorkflow("a");
	const b = freshWorkflow("b");
	const all = listWorkflows(repo);
	assert.equal(all[0]!.id, b.id, "b is active (most recent)");
	assert.ok(all.some((w) => w.id === a.id));
});

test("nowIso is parseable and near-now", () => {
	const t = nowIso();
	const ms = Date.parse(t);
	assert.ok(Number.isFinite(ms));
	assert.ok(Math.abs(Date.now() - ms) < 2000);
});
