import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import rpacExtension from "../../extensions/rpac.ts";
import {
	activeWorkflowId,
	artifactExists,
	extensionApiFor,
	fire,
	makeMockPi,
	readIndex,
	readState,
	repoDir,
	rpacCmd,
	rpacTool,
	workflowDirPath,
	workflowDirs,
	writeArtifact,
	type MockPi,
} from "../helpers/mock-pi.ts";
import { makeTempDir, removeTree, sha256File } from "../../lib/util.ts";

let repo: string;
let m: MockPi;

before(() => {
	repo = makeTempDir("rpac-e2e-");
	repoDir(repo);
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src", "fetcher.ts"), "export function fetch(url: string) { return url; }\n");
	writeFileSync(join(repo, "README.md"), "# demo\n");
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
	execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
	execFileSync("git", ["add", "-A"], { cwd: repo });
	execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repo });

	m = makeMockPi();
	rpacExtension(extensionApiFor(m));
	assert.ok(m.commands.has("rpac"), "rpac command registered");
	assert.ok(m.tools.has("rpac"), "rpac tool registered");
});

after(() => {
	removeTree(repo);
});

/** End the model execution cycle: release the ACT lease + mark interrupted tasks. */
async function settle(): Promise<void> {
	const ctx = makeCommandCtxLite();
	await fire(m, "agent_end", { type: "agent_end" }, ctx);
}

import { makeCommandCtx } from "../helpers/mock-pi.ts";
function makeCommandCtxLite(): Record<string, unknown> {
	return makeCommandCtx(m, repo, { hasUI: true }) as unknown as Record<string, unknown>;
}

function state() {
	return readState(repo);
}

const SUBSTANTIVE_REQ = [
	"# Requirements",
	"## Context",
	"The fetcher module needs retry behavior so transient network errors do not fail the caller.",
	"## Verified codebase facts",
	"- src/fetcher.ts currently exports a plain fetch(url) passthrough with no retry.",
	"## Requirements",
	"- R1: fetch(url, {retries}) retries up to N times with a short delay between attempts.",
	"## Acceptance criteria",
	"- AC-1: a fetch that fails twice then succeeds returns the success result.",
].join("\n");

const SUBSTANTIVE_PLAN = [
	"# Plan",
	"## Summary",
	"Add a retry loop to the fetcher and wire it behind an option, keeping the default behavior.",
	"## Conventions",
	"TypeScript, no new dependencies; tests via the project runner.",
	"## Tasks",
	"- [ ] 1. Add retry loop to fetch()",
	"  - Done when: unit test for transient failure passes",
	"- [ ] 2. Wire retry option through the public API",
	"  - Done when: integration test passes",
	"  - Depends on: 1",
].join("\n");

test("no workflow: /rpac reports none and gives the start hint", async () => {
	const ctx = await rpacCmd(m, repo, "");
	assert.match(ctx.ui.text().join("\n"), /no active workflow/i);
});

test("start: creates a refine-phase workflow with a git baseline and issues the refine directive", async () => {
	const ctx = await rpacCmd(m, repo, "start Add retry to the fetcher");
	const s = state();
	assert.equal(s.phase, "refine");
	assert.equal(s.project, repo);
	assert.ok(s.id.startsWith("w-"));
	assert.ok(existsInWfDir("log"), "per-workflow log created");
	assert.ok(s.baseline, "git baseline captured");
	assert.equal(readIndex(repo).active, s.id, "index identifies the active workflow");
	assert.ok(ctx.ui.text("info").some((t) => /started/.test(t)));
	assert.equal(m.userMessages.length, 1);
	assert.match(m.userMessages[0], /RPAC · REFINE/);
	assert.match(m.userMessages[0], /Add retry to the fetcher/);
	// the directive names the exact (absolute) artifact path
	assert.match(m.userMessages[0], new RegExp(escapeRe(join(repo, ".pi", "rpac", s.id, "requirements.md"))));
});

function existsInWfDir(name: string): boolean {
	return artifactExists(repo, name as "log");
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("headless start without --yes refuses to replace an active workflow", async () => {
	const before = readIndex(repo);
	const ctx = await rpacCmd(m, repo, "start Another task", { hasUI: false });
	assert.match(ctx.ui.text("error").join("\n"), /--yes|explicit consent/);
	assert.equal(readIndex(repo).active, before.active, "unchanged");
	// with --yes it proceeds and the old workflow is preserved
	const ctx2 = await rpacCmd(m, repo, "start Another task --yes", { hasUI: false });
	assert.match(ctx2.ui.text("info").join("\n"), /started/);
	assert.notEqual(readIndex(repo).active, before.active, "new workflow is active");
	// the first workflow directory + artifacts remain
	const firstId = before.active!;
	assert.ok(workflowDirs(repo).includes(firstId));
	assert.equal(readState(repo, firstId).task, "Add retry to the fetcher");
});

test("second workflow preserves the first workflow's artifacts", async () => {
	const firstId = readState(repo).id;
	// complete the first workflow's refine+plan so it has real artifacts
	writeArtifact(repo, "requirements", SUBSTANTIVE_REQ, firstId);
	const out = await rpacTool(m, repo, { action: "refine_complete" }, { confirm: [true] });
	assert.match(out, /approved/i);
	writeArtifact(repo, "plan", SUBSTANTIVE_PLAN, firstId);
	await rpacTool(m, repo, { action: "plan_complete", tasks: [{ title: "Add retry loop to fetch()" }, { title: "Wire retry option through the public API", dependsOn: [1] }] }, { confirm: [true] });
	const reqSha = sha256File(join(workflowDirPath(repo, firstId), "requirements.md"));
	const planSha = sha256File(join(workflowDirPath(repo, firstId), "plan.md"));

	// start a third workflow; do work in it
	await rpacCmd(m, repo, "start Third task --yes", { hasUI: false });
	const thirdId = readState(repo).id;
	writeArtifact(repo, "requirements", "# R3 different content\nline\nline\n", thirdId);

	// first workflow artifacts are untouched and recoverable
	assert.equal(sha256File(join(workflowDirPath(repo, firstId), "requirements.md")), reqSha);
	assert.equal(sha256File(join(workflowDirPath(repo, firstId), "plan.md")), planSha);
	// /rpac list shows all three
	const list = await rpacCmd(m, repo, "list");
	const listed = list.ui.text("info").join("\n");
	for (const id of [firstId, thirdId]) assert.ok(listed.includes(id), `list shows ${id}`);
	// resume the first workflow by id
	const res = await rpacCmd(m, repo, `resume ${firstId}`);
	assert.match(res.ui.text("info").join("\n"), new RegExp(`resumed workflow ${firstId}`));
	assert.equal(readState(repo).id, firstId);
});

test("full two-task flow: repeated non-sequential /rpac act through done", async () => {
	const firstId = readState(repo).id;
	// requirements are already approved from the previous test; issue the plan directive
	await rpacCmd(m, repo, "plan");
	assert.match(m.userMessages.at(-1)!, /RPAC · PLAN/);

	// --- task 1 ends the run without completion → interrupted outcome ---
	await rpacCmd(m, repo, "act");
	assert.equal(state().phase, "act");
	assert.equal(state().tasks[0]!.status, "in_progress");
	assert.match(m.userMessages.at(-1)!, /RPAC · ACT/);
	assert.match(m.userMessages.at(-1)!, /Task #1: Add retry loop to fetch\(\)/);
	await settle(); // run ends with task 1 still in_progress
	assert.equal(state().tasks[0]!.status, "interrupted", "interrupted outcome recorded");

	// resume re-issues the interrupted task
	await rpacCmd(m, repo, "resume");
	assert.equal(state().tasks[0]!.status, "in_progress");
	const resumeLease = JSON.parse(readFileSync(join(repo, ".pi", "rpac", ".act-lease"), "utf8"));
	assert.equal(resumeLease.workflowId, state().id, "resume holds a workflow-bound ACT lease");
	assert.equal(resumeLease.taskId, 1, "resume lease identifies the resumed task");
	assert.match(m.userMessages.at(-1)!, /resume — check what is already done/);
	const duplicateStart = await rpacTool(m, repo, { action: "task_start", task: 1 });
	assert.match(duplicateStart, /already in progress/, "current task_start is idempotent in one-task mode too");
	// the model finishes task 1 within this run, then the run ends
	let out = await rpacTool(m, repo, { action: "task_done", task: 1, verification: [{ name: "unit", result: "pass" }] });
	assert.match(out, /Task 1\/2 complete/);
	assert.equal(state().tasks[0]!.status, "done");
	const earlyNext = await rpacTool(m, repo, { action: "task_start", task: 2 });
	assert.match(earlyNext, /one-task mode stops/);
	assert.equal(state().tasks[1]!.status, "pending");
	await settle(); // nothing in_progress → no interrupt, lease released

	// task_done of an already-done task is refused (idempotent guard)
	out = await rpacTool(m, repo, { action: "task_done", task: 1, verification: [{ name: "unit", result: "pass" }] });
	assert.match(out, /RPAC error|already/);

	// --- task 2: second /rpac act, dependency satisfied ---
	await rpacCmd(m, repo, "act");
	assert.equal(state().tasks[1]!.status, "in_progress", "second task started by repeated /rpac act");
	out = await rpacTool(m, repo, { action: "task_done", task: 2, verification: [{ name: "integration", result: "pass" }] });
	assert.match(out, /All tasks complete/);
	assert.equal(state().tasks[1]!.status, "done");
	await settle();

	// consolidate
	const con = await rpacCmd(m, repo, "consolidate");
	assert.equal(state().phase, "consolidate");
	assert.match(con.ui.text("info").join("\n"), /check the overall result and write the report/);
	assert.match(m.userMessages.at(-1)!, /RPAC · CONSOLIDATE/);

	writeArtifact(repo, "report", "# Completion report\n## Verdict\nComplete — AC-1 verified.\n", firstId);
	out = await rpacTool(m, repo, { action: "consolidate_complete", text: "complete" });
	assert.equal(state().phase, "done");
	assert.match(out, /Workflow complete/);
	await settle();
	void firstId;
});

test("status reflects completion and the saved workflow list", async () => {
	const st = await rpacCmd(m, repo, "status");
	assert.match(st.ui.text().join("\n"), /Phase: done/);
});

test("failed check: task stays failed (not done); unavailable check too", async () => {
	await rpacCmd(m, repo, "start Failed-check demo --yes", { hasUI: false });
	writeArtifact(repo, "requirements", SUBSTANTIVE_REQ);
	let out = await rpacTool(m, repo, { action: "refine_complete" }, { confirm: [true] });
	assert.match(out, /approved/i);
	await rpacCmd(m, repo, "plan");
	writeArtifact(repo, "plan", SUBSTANTIVE_PLAN);
	out = await rpacTool(m, repo, {
		action: "plan_complete",
		tasks: [{ title: "a" }, { title: "b" }, { title: "c" }],
	}, { confirm: [true] });
	assert.match(out, /approved/i);

	// task 1: failing check (task_done happens inside the run)
	await rpacCmd(m, repo, "act");
	assert.equal(state().tasks[0]!.status, "in_progress");
	out = await rpacTool(m, repo, {
		action: "task_done",
		task: 1,
		verification: [{ name: "unit", result: "pass" }, { name: "e2e", result: "fail", detail: "browser flake" }],
	});
	assert.match(out, /FAILED \(not done\)/);
	assert.equal(state().tasks[0]!.status, "failed");
	assert.ok(state().tasks[0]!.issues?.some((i: string) => /e2e/.test(i)));
	await settle();

	// task 2: unavailable check
	await rpacCmd(m, repo, "act 2");
	out = await rpacTool(m, repo, {
		action: "task_done",
		task: 2,
		verification: [{ name: "manual", result: "unavailable", detail: "needs a device" }],
	});
	assert.match(out, /FAILED \(not done\)/);
	assert.equal(state().tasks[1]!.status, "failed");
	await settle();

	// user accepts a documented exception for task 1 only
	const acc = await rpacCmd(m, repo, "accept 1 e2e infra outage — unit checks pass, user accepts");
	assert.match(acc.ui.text("warning").join("\n"), /accepted/);
	assert.equal(state().tasks[0]!.status, "done");
	assert.equal(state().tasks[0]!.acceptedException, "e2e infra outage — unit checks pass, user accepts");
	// task 2 still failed
	assert.equal(state().tasks[1]!.status, "failed");
	// accepting a non-failed task is refused
	await rpacCmd(m, repo, "accept 3 no reason given");
	assert.match((await rpacCmd(m, repo, "status")).ui.text().join("\n"), /failed/);
});

test("blocked task and sequential stop on failure", async () => {
	// fresh workflow with 2 tasks
	await rpacCmd(m, repo, "start Blocked demo --yes", { hasUI: false });
	writeArtifact(repo, "requirements", SUBSTANTIVE_REQ);
	await rpacTool(m, repo, { action: "refine_complete" }, { confirm: [true] });
	await rpacCmd(m, repo, "plan");
	writeArtifact(repo, "plan", SUBSTANTIVE_PLAN);
	await rpacTool(m, repo, { action: "plan_complete", tasks: [{ title: "a" }, { title: "b" }] }, { confirm: [true] });
	// approve sequential
	const seq = await rpacCmd(m, repo, "approve sequential");
	assert.match(seq.ui.text("info").join("\n"), /equential/);

	// task 1 gets blocked → sequential execution must stop
	await rpacCmd(m, repo, "act");
	const out = await rpacTool(m, repo, { action: "task_block", task: 1, text: "needs a design decision" });
	assert.match(out, /marked blocked/);
	assert.equal(state().tasks[0]!.status, "blocked");
	await settle();
	// the blocked task cannot be (re)started
	const blocked = await rpacCmd(m, repo, "act 1");
	assert.match(blocked.ui.text("error").join("\n"), /blocked/);
	// task 2 remains pending — nothing auto-continued
	assert.equal(state().tasks[1]!.status, "pending");
	// unblock → restart → done (task_done inside the run)
	await rpacTool(m, repo, { action: "task_unblock", task: 1 });
	await rpacCmd(m, repo, "act 1");
	await rpacTool(m, repo, { action: "task_done", task: 1, verification: [{ name: "check", result: "pass" }] });
	assert.equal(state().tasks[0]!.status, "done");
	await settle();
});

test("sequential execution continues only after a verified pass", async () => {
	// fresh workflow
	await rpacCmd(m, repo, "start Sequential demo --yes", { hasUI: false });
	writeArtifact(repo, "requirements", SUBSTANTIVE_REQ);
	await rpacTool(m, repo, { action: "refine_complete" }, { confirm: [true] });
	await rpacCmd(m, repo, "plan");
	writeArtifact(repo, "plan", SUBSTANTIVE_PLAN);
	await rpacTool(m, repo, { action: "plan_complete", tasks: [{ title: "a" }, { title: "b" }] }, { confirm: [true] });
	await rpacCmd(m, repo, "approve sequential");

	await rpacCmd(m, repo, "act");
	const deliverable = join(repo, ".pi", "rpac", activeWorkflowId(repo), "review.md");
	writeFileSync(deliverable, "# Review\n\nVerified output.\n", "utf8");
	const duplicate = await rpacTool(m, repo, { action: "task_start", task: 1 });
	assert.match(duplicate, /already in progress/, "repeating the task started by /rpac act is harmless");
	assert.equal(state().events.filter((e: { kind: string; detail: string }) => e.kind === "task_start" && /task 1:/.test(e.detail)).length, 1, "duplicate start records no restart event");
	const outside = await rpacTool(m, repo, {
		action: "task_done",
		task: 1,
		verification: [{ name: "check", result: "pass" }],
		deliverables: [join(repo, "..", "outside.md")],
	});
	assert.match(outside, /deliverable must be a file inside the project/);
	assert.equal(state().tasks[0]!.status, "in_progress", "invalid deliverable leaves task untouched");
	const out = await rpacTool(m, repo, {
		action: "task_done",
		task: 1,
		verification: [{ name: "check", result: "pass" }],
		deliverables: [deliverable],
	});
	assert.match(out, /Continue with the next ready task/, "verified pass continues sequential mode");
	assert.equal(state().tasks[0]!.deliverables?.[0]?.path, `.pi/rpac/${activeWorkflowId(repo)}/review.md`);
	assert.equal(state().tasks[0]!.deliverables?.[0]?.sha256, sha256File(deliverable));
	writeFileSync(deliverable, "changed after task completion\n", "utf8");
	const deliverableStatus = await rpacCmd(m, repo, "status");
	assert.match(deliverableStatus.ui.text("info").at(-1)!, /task 1 deliverable changed/, "status detects stale registered output");
	// the model continues within the run: task 2 starts (simulating the model's next task_start)
	const s2 = await rpacTool(m, repo, { action: "task_start", task: 2 });
	assert.match(s2, /Started task 2/);
	// failing task 2 stops the run
	const out2 = await rpacTool(m, repo, { action: "task_done", task: 2, verification: [{ name: "check", result: "fail" }] });
	assert.match(out2, /FAILED \(not done\)/);
	assert.equal(state().tasks[1]!.status, "failed");
	const continued = await rpacTool(m, repo, { action: "task_start", task: 1 });
	assert.match(continued, /sequential execution stopped/);
	await settle();
});

test("dependency cycles and invalid references are rejected at plan registration", async () => {
	await rpacCmd(m, repo, "start Graph demo --yes", { hasUI: false });
	writeArtifact(repo, "requirements", SUBSTANTIVE_REQ);
	await rpacTool(m, repo, { action: "refine_complete" }, { confirm: [true] });
	await rpacCmd(m, repo, "plan");
	writeArtifact(repo, "plan", SUBSTANTIVE_PLAN);
	let out = await rpacTool(m, repo, { action: "plan_complete", tasks: [{ title: "a", dependsOn: [2] }, { title: "b", dependsOn: [1] }] }, { confirm: [true] });
	assert.match(out, /RPAC error:.*cycle/);
	out = await rpacTool(m, repo, { action: "plan_complete", tasks: [{ title: "a", dependsOn: [9] }] }, { confirm: [true] });
	assert.match(out, /RPAC error:.*unknown task 9/);
	out = await rpacTool(m, repo, { action: "plan_complete", tasks: [{ title: "a", dependsOn: [1] }] }, { confirm: [true] });
	assert.match(out, /RPAC error:.*depends on itself/);
	// a valid graph is accepted
	out = await rpacTool(m, repo, { action: "plan_complete", tasks: [{ title: "a" }, { title: "b", dependsOn: [1] }] }, { confirm: [true] });
	assert.match(out, /approved/i);
});

test("deferred plan approval is bound to the finalized artifact hash", async () => {
	await rpacCmd(m, repo, "start Deferred approval demo --yes", { hasUI: false });
	writeArtifact(repo, "requirements", SUBSTANTIVE_REQ);
	await rpacTool(m, repo, { action: "refine_complete" }, { confirm: [true] });
	await rpacCmd(m, repo, "plan");
	writeArtifact(repo, "plan", SUBSTANTIVE_PLAN);
	const pending = await rpacTool(
		m,
		repo,
		{ action: "plan_complete", tasks: [{ title: "a" }] },
		{ confirm: [false] },
	);
	assert.match(pending, /Awaiting user approval/);
	writeArtifact(repo, "plan", SUBSTANTIVE_PLAN + "\n\nChanged after review.");
	const stale = await rpacCmd(m, repo, "approve plan");
	assert.match(stale.ui.text("error").join("\n"), /changed after it was finalized/);
	assert.equal(state().approvals.plan, false);
});

test("thin requirements cannot be finalized or approved", async () => {
	await rpacCmd(m, repo, "start Thin demo --yes", { hasUI: false });
	writeArtifact(repo, "requirements", "# Requirements\n- do the thing\n");
	const out = await rpacTool(m, repo, { action: "refine_complete" });
	assert.match(out, /RPAC error:.*too thin/);
	// Both approval entry points reject the same thin artifact.
	const plan = await rpacCmd(m, repo, "plan", { confirm: [true] });
	assert.match(plan.ui.text("error").join("\n"), /thin requirements/);
	const ctx = await rpacCmd(m, repo, "approve requirements");
	assert.match(ctx.ui.text("error").join("\n"), /thin requirements/);
});

// ---------------------------------------------------------------------------
// REFINE/PLAN read-only gate (tool_call handler)
// ---------------------------------------------------------------------------

test("REFINE/PLAN gate: application writes and mutating bash are blocked, artifact writes allowed", async () => {
	// fresh workflow in refine
	await rpacCmd(m, repo, "start Gate demo --yes", { hasUI: false });
	const wfId = activeWorkflowId(repo);
	const reqAbs = join(repo, ".pi", "rpac", wfId, "requirements.md");
	const planAbs = join(repo, ".pi", "rpac", wfId, "plan.md");
	const appAbs = join(repo, "src", "fetcher.ts");

	async function gate(toolName: string, input: Record<string, unknown>, cwd = repo) {
		return fire(m, "tool_call", { type: "tool_call", toolName, input }, { cwd }) as Promise<unknown> | unknown;
	}

	// refine phase
	let r = await gate("write", { path: appAbs, content: "x" });
	assert.ok((r as { block?: boolean })?.block, "application write blocked in refine");
	r = await gate("edit", { path: appAbs, edits: [] });
	assert.ok((r as { block?: boolean })?.block, "application edit blocked in refine");
	r = await gate("write", { path: reqAbs, content: "x" });
	assert.equal((r as { block?: boolean })?.block, undefined, "requirements artifact write allowed");
	r = await gate("write", { path: `.pi/rpac/${wfId}/requirements.md`, content: "x" });
	assert.equal((r as { block?: boolean })?.block, undefined, "cwd-relative artifact write allowed");
	r = await gate("write", { path: planAbs, content: "x" });
	assert.ok((r as { block?: boolean })?.block, "plan artifact NOT writable during refine");
	r = await gate("bash", { command: "git add ." });
	assert.ok((r as { block?: boolean })?.block, "mutating git blocked");
	r = await gate("bash", { command: "echo x > out.txt" });
	assert.ok((r as { block?: boolean })?.block, "redirect blocked");
	r = await gate("bash", { command: "npm install lodash" });
	assert.ok((r as { block?: boolean })?.block, "npm install blocked");
	r = await gate("bash", { command: "frobnicate --all" });
	assert.ok((r as { block?: boolean })?.block, "unknown command fail-closed");
	r = await gate("bash", { command: "git status" });
	assert.equal((r as { block?: boolean })?.block, undefined, "read-only git allowed");
	r = await gate("bash", { command: "grep -r retry src/" });
	assert.equal((r as { block?: boolean })?.block, undefined, "grep allowed");
	r = await gate("read", { path: appAbs });
	assert.equal((r as { block?: boolean })?.block, undefined, "read always allowed");
	r = await gate("ask_user_question", { questions: [] });
	assert.equal((r as { block?: boolean })?.block, undefined, "clarification questions are read-only");
	r = await gate("bash", { command: `git -C ${repo} merge-base HEAD main 2>/dev/null` });
	assert.equal((r as { block?: boolean })?.block, undefined, "real-world read-only git form allowed");

	// plan phase: complete refine (artifact written first so the transition is valid)
	writeArtifact(repo, "requirements", SUBSTANTIVE_REQ, wfId);
	await rpacTool(m, repo, { action: "refine_complete" }, { confirm: [true] }); // → plan
	r = await gate("write", { path: planAbs, content: "x" });
	assert.equal((r as { block?: boolean })?.block, undefined, "plan artifact write allowed in plan phase");
	r = await gate("write", { path: reqAbs, content: "x" });
	assert.ok((r as { block?: boolean })?.block, "requirements no longer writable in plan phase");

	// act phase: gate disengages
	await rpacCmd(m, repo, "plan");
	writeArtifact(repo, "plan", SUBSTANTIVE_PLAN, wfId);
	await rpacTool(m, repo, { action: "plan_complete", tasks: [{ title: "a" }] }, { confirm: [true] });
	await rpacCmd(m, repo, "act");
	r = await gate("write", { path: appAbs, content: "x" });
	assert.equal((r as { block?: boolean })?.block, undefined, "ACT is under normal Pi permissions");
	r = await gate("bash", { command: "git commit -m wip" });
	assert.equal((r as { block?: boolean })?.block, undefined, "ACT allows normal commands");
	await settle();
});

// ---------------------------------------------------------------------------
// Concurrency: ACT execution lease
// ---------------------------------------------------------------------------

test("concurrent ACT refusal: a live lease blocks /rpac act", async () => {
	// fresh workflow approved through act
	await rpacCmd(m, repo, "start Lease demo --yes", { hasUI: false });
	writeArtifact(repo, "requirements", SUBSTANTIVE_REQ);
	await rpacTool(m, repo, { action: "refine_complete" }, { confirm: [true] });
	await rpacCmd(m, repo, "plan");
	writeArtifact(repo, "plan", SUBSTANTIVE_PLAN);
	await rpacTool(m, repo, { action: "plan_complete", tasks: [{ title: "a" }] }, { confirm: [true] });

	const act1 = await rpacCmd(m, repo, "act");
	assert.match(act1.ui.text("info").join("\n"), /starting the approved task/);
	assert.ok(existsSync(join(repo, ".pi", "rpac", ".act-lease")), "execution lease held");
	// a second act while the first model run is still going (no settle) must refuse
	const act2 = await rpacCmd(m, repo, "act");
	assert.match(act2.ui.text("error").join("\n"), /already being executed by this Pi session/);
	// the lease is released when the run ends
	await settle();
	const act3 = await rpacCmd(m, repo, "act 1");
	assert.equal(state().tasks[0]!.status, "in_progress");
	await settle();
});

// ---------------------------------------------------------------------------
// Consolidation repair flow
// ---------------------------------------------------------------------------

test("a foreign ACT lease blocks dispatch, switching, replacement, abort, and cleanup", async () => {
	const activeId = activeWorkflowId(repo);
	const leasePath = join(repo, ".pi", "rpac", ".act-lease");
	writeFileSync(
		leasePath,
		JSON.stringify({
			token: "foreign-live-token",
			pid: process.pid,
			createdAt: new Date().toISOString(),
			refreshedAt: new Date().toISOString(),
			workflowId: activeId,
			taskId: 1,
		}),
		"utf8",
	);
	try {
		const before = readState(repo, activeId);
		const act = await rpacCmd(m, repo, "act 1");
		assert.match(act.ui.text("error").join("\n"), /held by another process|already being executed/);
		assert.deepEqual(readState(repo, activeId).tasks, before.tasks, "failed lease acquisition cannot start a task");

		const replacement = await rpacCmd(m, repo, "start --yes must not replace", { hasUI: false });
		assert.match(replacement.ui.text("error").join("\n"), /held by another process|already being executed/);
		assert.equal(activeWorkflowId(repo), activeId);

		const otherId = workflowDirs(repo).find((id) => id !== activeId)!;
		const switched = await rpacCmd(m, repo, `resume ${otherId}`);
		assert.match(switched.ui.text("error").join("\n"), /held by another process|already being executed/);
		assert.equal(activeWorkflowId(repo), activeId);

		const aborted = await rpacCmd(m, repo, "abort --yes", { hasUI: false });
		assert.match(aborted.ui.text("error").join("\n"), /held by another process|already being executed/);
		assert.notEqual(readState(repo, activeId).phase, "aborted");

		const cleaned = await rpacCmd(m, repo, "cleanup --yes", { hasUI: false });
		assert.match(cleaned.ui.text("error").join("\n"), /held by another process|already being executed/);
		assert.ok(existsSync(join(repo, ".pi", "rpac", "state.json")));
	} finally {
		unlinkSync(leasePath);
	}
});

test("consolidation finding → repair task → ACT → reconsolidation", async () => {
	// complete everything in the lease-demo workflow (task_done inside the run)
	await rpacCmd(m, repo, "act 1");
	await rpacTool(m, repo, { action: "task_done", task: 1, verification: [{ name: "check", result: "pass" }] });
	await settle();
	await rpacCmd(m, repo, "consolidate");
	writeArtifact(repo, "report", "# Report\n## Verdict\nFound a gap: the retry delay is missing.\n");
	// the model finds a problem → back_to_act creates a repair task
	const out = await rpacTool(m, repo, { action: "back_to_act", text: "retry delay is missing" });
	assert.match(out, /Repair task/);
	assert.equal(state().phase, "act");
	const repair = state().tasks[state().tasks.length - 1]!;
	assert.match(repair.title, /^Repair: retry delay is missing/);
	assert.equal(repair.status, "pending");

	// /rpac act executes the repair task (task_done inside the run)
	await rpacCmd(m, repo, "act");
	assert.equal(state().tasks[repair.id - 1]!.status, "in_progress", "repair task is the ready task");
	const done = await rpacTool(m, repo, { action: "task_done", task: repair.id, verification: [{ name: "check", result: "pass" }] });
	assert.match(done, /All tasks complete/);
	await settle();

	// reconsolidate — clean this time
	await rpacCmd(m, repo, "consolidate");
	writeArtifact(repo, "report", "# Report\n## Verdict\nComplete.\n");
	const cc = await rpacTool(m, repo, { action: "consolidate_complete", text: "complete" });
	assert.equal(state().phase, "done");
	assert.match(cc, /Workflow complete/);
	await settle();
});

test("headless consolidation with unfinished tasks requires --force", async () => {
	await rpacCmd(m, repo, "start Force demo --yes", { hasUI: false });
	writeArtifact(repo, "requirements", SUBSTANTIVE_REQ);
	await rpacTool(m, repo, { action: "refine_complete" }, { confirm: [true] });
	await rpacCmd(m, repo, "plan");
	writeArtifact(repo, "plan", SUBSTANTIVE_PLAN);
	await rpacTool(m, repo, { action: "plan_complete", tasks: [{ title: "a" }] }, { confirm: [true] });
	await rpacCmd(m, repo, "act"); // task 1 in_progress
	await settle();
	// headless, no --force → refused
	const c1 = await rpacCmd(m, repo, "consolidate", { hasUI: false });
	assert.match(c1.ui.text("error").join("\n"), /--force/);
	assert.equal(state().phase, "act", "still in act");
	// with --force → proceeds
	const c2 = await rpacCmd(m, repo, "consolidate --force", { hasUI: false });
	assert.equal(state().phase, "consolidate");
});

// ---------------------------------------------------------------------------
// Stale detection
// ---------------------------------------------------------------------------

test("stale artifact + git divergence are reported on act and resume", async () => {
	await rpacCmd(m, repo, "start Stale demo --yes", { hasUI: false });
	writeArtifact(repo, "requirements", SUBSTANTIVE_REQ);
	await rpacTool(m, repo, { action: "refine_complete" }, { confirm: [true] });
	await rpacCmd(m, repo, "plan");
	writeArtifact(repo, "plan", SUBSTANTIVE_PLAN);
	await rpacTool(m, repo, { action: "plan_complete", tasks: [{ title: "a" }] }, { confirm: [true] });
	await rpacCmd(m, repo, "act");
	await settle();
	// externally edit the requirements (user or another session)
	const wfId = activeWorkflowId(repo);
	const reqPath = join(workflowDirPath(repo, wfId), "requirements.md");
	const before = sha256File(reqPath);
	writeFileSync(reqPath, SUBSTANTIVE_REQ + "\n- CHANGED after approval\n", "utf8");
	assert.notEqual(before, sha256File(reqPath));
	// act reports the drift as a warning and logs it
	const act = await rpacCmd(m, repo, "act 1");
	assert.match(act.ui.text("warning").join("\n"), /requirements artifact changed/);
	// resume reports it too
	const res = await rpacCmd(m, repo, "resume");
	assert.match(res.ui.text("warning").join("\n"), /requirements artifact changed/);
	// RPAC's own state churn is NOT reported as git divergence
	const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	const st = await rpacCmd(m, repo, "status --details");
	const gitLine = st.ui.text().join("\n").split("\n").find((l) => l.startsWith("Git:"));
	assert.ok(gitLine, "git line present");
	assert.ok(gitLine.includes(base.slice(0, 8)));
	assert.ok(!/new uncommitted file/.test(gitLine) || /only RPAC state files/.test(gitLine), `RPAC state churn not user divergence: ${gitLine}`);
});

// ---------------------------------------------------------------------------
// Handoff, reload, isolation, corruption
// ---------------------------------------------------------------------------

test("handoff writes the workflow handoff and seeds a fresh session (tui)", async () => {
	await rpacCmd(m, repo, "start Handoff demo --yes", { hasUI: false });
	const wfId = activeWorkflowId(repo);
	const before = m.userMessages.length;
	const ctx = await rpacCmd(m, repo, "handoff", { confirm: [true] });
	assert.match(ctx.ui.text("info").join("\n"), /handoff written/);
	assert.ok(artifactExists(repo, "handoff", wfId));
	assert.ok(state().artifacts.handoff);
	assert.ok(m.userMessages.length > before, "fresh session seeded");
	assert.match(m.userMessages.at(-1)!, /RPAC fresh session/);
	assert.match(m.userMessages.at(-1)!, new RegExp(escapeRe(`.pi/rpac/${wfId}/workflow.json`)));
});

test("non-TUI handoff explains the manual fallback", async () => {
	const ctx = await rpacCmd(m, repo, "handoff", { mode: "rpc" });
	assert.match(ctx.ui.text("info").join("\n"), /Manual fallback/);
});

test("extension reload + session resume: a fresh runtime sees the same workflow", async () => {
	const wfId = activeWorkflowId(repo);
	const m2 = makeMockPi();
	rpacExtension(extensionApiFor(m2));
	const ctx = await rpacCmd(m2, repo, "status");
	assert.match(ctx.ui.text().join("\n"), new RegExp(wfId));
	// session_start refreshes the footer from disk
	const startHandlers = m2.handlers.get("session_start") ?? [];
	assert.ok(startHandlers.length > 0);
	await startHandlers[0]({ type: "session_start", reason: "resume" } as never, {
		cwd: repo,
		ui: {
			notify() {},
			setStatus(_k: string, _v: string | undefined) {},
			setWidget(_k: string, _v: string[] | undefined) {},
		} as never,
	});
	// session_shutdown clears UI and releases the lease (no crash)
	const shutdownHandlers = m2.handlers.get("session_shutdown") ?? [];
	await shutdownHandlers[0]({ type: "session_shutdown" } as never, {
		cwd: repo,
		ui: {
			notify() {},
			setStatus(_k: string, _v: string | undefined) {},
			setWidget(_k: string, _v: string[] | undefined) {},
		} as never,
	});
});

test("project isolation + subdirectory: state lives at the git root", async () => {
	// from a subdirectory, the workflow binds to the repo root
	const sub = join(repo, "src");
	const ctx = await rpacCmd(m, sub, "start Subdir demo --yes", { hasUI: false });
	assert.match(ctx.ui.text("info").join("\n"), /started/);
	assert.equal(state().project, repo, "bound to the git root, not the subdirectory cwd");
	// a different repo sees no workflow
	const other = makeTempDir("rpac-other-");
	try {
		mkdirSync(other, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: other });
		const m3 = makeMockPi();
		rpacExtension(extensionApiFor(m3));
		const ctx3 = await rpacCmd(m3, other, "status");
		assert.match(ctx3.ui.text().join("\n"), /no active workflow/i);
	} finally {
		removeTree(other);
	}
});

test("corrupt state is quarantined and reported, not crash-looped", async () => {
	const bad = makeTempDir("rpac-bad-");
	try {
		mkdirSync(join(bad, ".pi", "rpac", "w-bad1234"), { recursive: true });
		writeFileSync(join(bad, ".pi", "rpac", "state.json"), JSON.stringify({ version: 2, active: "w-bad1234", workflows: { "w-bad1234": { id: "w-bad1234", task: "t", phase: "refine", updatedAt: "2026-01-01T00:00:00Z" } } }), "utf8");
		writeFileSync(join(bad, ".pi", "rpac", "w-bad1234", "workflow.json"), "{ not json", "utf8");
		const m3 = makeMockPi();
		rpacExtension(extensionApiFor(m3));
		const ctx = await rpacCmd(m3, bad, "status");
		assert.match(ctx.ui.text().join("\n"), /quarantined/i);
		assert.ok(!ctx.ui.text("error").some((t) => /not valid JSON/.test(t)), "no crash error");
		// second load is stable
		const ctx2 = await rpacCmd(m3, bad, "status");
		assert.match(ctx2.ui.text().join("\n"), /no active workflow|saved workflow/i);
	} finally {
		removeTree(bad);
	}
});

test("migration from the MTP4 v1 shared layout is surfaced by /rpac status", async () => {
	const legacy = makeTempDir("rpac-legacy-cmd-");
	try {
		mkdirSync(join(legacy, ".pi", "rpac"), { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: legacy });
		const { newState } = await import("../../lib/schema.ts");
		const st = newState(legacy, "legacy task");
		st.version = 1;
		st.phase = "act";
		st.approvals = { requirements: true, plan: true, sequential: false };
		st.tasks = [{ id: 1, title: "l1", status: "in_progress" }];
		writeFileSync(join(legacy, ".pi", "rpac", "workflow.json"), JSON.stringify(st), "utf8");
		writeFileSync(join(legacy, ".pi", "rpac", "requirements.md"), "# legacy req\nline\nline\n");
		writeFileSync(join(legacy, ".pi", "rpac", "plan.md"), "# legacy plan\nline\nline\n");
		const m3 = makeMockPi();
		rpacExtension(extensionApiFor(m3));
		const ctx = await rpacCmd(m3, legacy, "status");
		assert.match(ctx.ui.text().join("\n"), /migrated/);
		assert.match(ctx.ui.text().join("\n"), /legacy task/);
		// artifacts moved into the per-workflow directory (the shared file is gone)
		assert.ok(!existsSync(join(legacy, ".pi", "rpac", "requirements.md")), "shared requirements.md moved");
		const dirs = readdirSync(join(legacy, ".pi", "rpac")).filter((d) => d.startsWith("w-") || d.startsWith("legacy-"));
		assert.equal(dirs.length, 1, "exactly one migrated workflow directory");
		assert.ok(existsSync(join(legacy, ".pi", "rpac", dirs[0]!, "requirements.md")), "requirements.md in workflow dir");
		assert.ok(existsSync(join(legacy, ".pi", "rpac", dirs[0]!, "workflow.json")), "workflow.json in workflow dir");
		// a mutation persists the index and points it at the migrated workflow
		await rpacCmd(m3, legacy, "pause");
		const idx = JSON.parse(readFileSync(join(legacy, ".pi", "rpac", "state.json"), "utf8"));
		assert.equal(idx.active, dirs[0]!);
	} finally {
		removeTree(legacy);
	}
});

test("abort headless requires --yes; cleanup headless requires --yes", async () => {
	// active workflow exists
	const id = activeWorkflowId(repo);
	const a1 = await rpacCmd(m, repo, "abort", { hasUI: false });
	assert.match(a1.ui.text("error").join("\n"), /--yes/);
	assert.equal(state().phase !== "aborted", true);
	const a2 = await rpacCmd(m, repo, "abort --yes user changed direction", { hasUI: false });
	assert.match(a2.ui.text("warning").join("\n"), /aborted/);
	assert.equal(readState(repo, id).phase, "aborted");
	// cleanup refuses headless without --yes
	const c1 = await rpacCmd(m, repo, "cleanup", { hasUI: false });
	assert.match(c1.ui.text("error").join("\n"), /--yes/);
	// and actually cleans up with it
	await rpacCmd(m, repo, "cleanup --yes", { hasUI: false });
	assert.ok(existsSync(join(repo, ".pi", "rpac")), "empty lock directory retained");
	assert.deepEqual(readdirSync(join(repo, ".pi", "rpac")), [], "all RPAC state removed");
});

// ---------------------------------------------------------------------------
// Report-only review workflow
// ---------------------------------------------------------------------------

test("/rpac review drives a manifest-backed report-only workflow through resume-safe phases", async () => {
	const reviewRepo = makeTempDir("rpac-review-e2e-");
	const reviewPi = makeMockPi();
	try {
		mkdirSync(join(reviewRepo, "src"), { recursive: true });
		writeFileSync(join(reviewRepo, "src", "app.ts"), "export const value = 1;\n");
		execFileSync("git", ["init", "-q"], { cwd: reviewRepo });
		execFileSync("git", ["config", "user.email", "t@t"], { cwd: reviewRepo });
		execFileSync("git", ["config", "user.name", "t"], { cwd: reviewRepo });
		execFileSync("git", ["add", "-A"], { cwd: reviewRepo });
		execFileSync("git", ["commit", "-qm", "initial"], { cwd: reviewRepo });
		writeFileSync(join(reviewRepo, "src", "app.ts"), "export const value = 2;\n");
		execFileSync("git", ["add", "--", "src/app.ts"], { cwd: reviewRepo });
		writeFileSync(join(reviewRepo, "src", "app.ts"), "export const value = 3;\n");
		writeFileSync(join(reviewRepo, "notes.txt"), "review me\n");
		rpacExtension(extensionApiFor(reviewPi));

		const started = await rpacCmd(reviewPi, reviewRepo, "review");
		const id = activeWorkflowId(reviewRepo);
		let reviewState = readState(reviewRepo, id);
		assert.equal(reviewState.workflowKind, "review");
		assert.equal(reviewState.review.mode, "current");
		assert.ok(reviewState.review.scopeItemIds.length >= 2);
		assert.ok(existsSync(join(workflowDirPath(reviewRepo, id), "review-manifest.json")));
		assert.match(reviewPi.userMessages.at(-1)!, /REVIEW REFINE/);
		assert.match(started.ui.text("info").join("\n"), /scope: .*item/);
		const status = await rpacCmd(reviewPi, reviewRepo, "status");
		assert.match(status.ui.text("info").join("\n"), /Active workflow .*review \(current\)/);
		const listed = await rpacCmd(reviewPi, reviewRepo, "list");
		assert.match(listed.ui.text("info").join("\n"), /review:refine/);
		const scoped = await rpacTool(reviewPi, reviewRepo, {
			action: "review_scope",
			exclusions: [{ path: "notes.txt", reason: "local scratch note" }],
		});
		assert.match(scoped, /scope replaced/);
		reviewState = readState(reviewRepo, id);
		assert.deepEqual(reviewState.review.exclusions, [{ path: "notes.txt", reason: "local scratch note" }]);

		const req = [
			"# Review requirements",
			"## Intent",
			"Review the captured current changes for concrete correctness and policy violations.",
			"## Scope",
			"Every manifest item is included; no project-specific exclusions are needed.",
			"## Acceptance",
			"Every item receives evidence and findings are adversarially validated.",
		].join("\n");
		writeArtifact(reviewRepo, "requirements", req, id);
		await rpacTool(reviewPi, reviewRepo, { action: "refine_complete" }, { confirm: [true] });
		const manifest = JSON.parse(readFileSync(join(workflowDirPath(reviewRepo, id), "review-manifest.json"), "utf8"));
		const itemIds = manifest.items.map((entry: { id: string }) => entry.id);
		const plan = [
			"# Review plan",
			"## Summary",
			"Inspect the captured files in one bounded batch, then validate candidate findings.",
			"## Conventions",
			"Report-only; preserve exact snapshot semantics and evidence.",
			"## Tasks",
			"- [ ] Review captured items",
			"- [ ] Validate findings and coverage",
		].join("\n");
		writeArtifact(reviewRepo, "plan", plan, id);
		const planned = await rpacTool(reviewPi, reviewRepo, {
			action: "plan_complete",
			tasks: [
				{ title: "Review captured items", reviewItemIds: itemIds },
				{ title: "Validate findings and coverage", dependsOn: [1] },
			],
			reviewChecks: ["npm test"],
		}, { confirm: [true] });
		assert.match(planned, /approved/i);

		await rpacCmd(reviewPi, reviewRepo, "act");
		reviewState = readState(reviewRepo, id);
		assert.equal(reviewState.tasks[0].status, "in_progress");
		assert.match(reviewPi.userMessages.at(-1)!, /REVIEW ACT/);
		const gate = async (toolName: string, input: Record<string, unknown>) =>
			fire(reviewPi, "tool_call", { type: "tool_call", toolName, input }, { cwd: reviewRepo }) as Promise<unknown>;
		assert.ok(((await gate("write", { path: join(reviewRepo, "src", "app.ts"), content: "bad" })) as { block?: boolean }).block);
		assert.equal(((await gate("bash", { command: "npm test" })) as { block?: boolean } | undefined)?.block, undefined);
		assert.ok(((await gate("bash", { command: "git add -A" })) as { block?: boolean }).block);
		await fire(reviewPi, "agent_end", { type: "agent_end" }, makeCommandCtx(reviewPi, reviewRepo) as never);
		assert.equal(readState(reviewRepo, id).tasks[0].status, "interrupted");
		await rpacCmd(reviewPi, reviewRepo, `resume ${id}`);
		assert.match(reviewPi.userMessages.at(-1)!, /REVIEW ACT/);
		assert.equal(readState(reviewRepo, id).review.fingerprint, reviewState.review.fingerprint, "snapshot identity survived resume");
		const batch1 = join(workflowDirPath(reviewRepo, id), "review-batch-1.md");
		writeFileSync(batch1, "# Batch 1\n\nAll assigned manifest items inspected.\n\nCandidate: example subject check failed.\n");
		const done1 = await rpacTool(reviewPi, reviewRepo, {
			action: "task_done",
			task: 1,
			verification: [
				{ name: "example subject check", kind: "observation", result: "fail", detail: "recorded as a candidate" },
				{ name: "batch evidence complete", kind: "acceptance", result: "pass" },
			],
			deliverables: [batch1],
		});
		assert.match(done1, /complete/);
		await fire(reviewPi, "agent_end", { type: "agent_end" }, makeCommandCtx(reviewPi, reviewRepo) as never);

		await rpacCmd(reviewPi, reviewRepo, "act");
		const batch2 = join(workflowDirPath(reviewRepo, id), "review-batch-2.md");
		writeFileSync(batch2, "# Batch 2\n\nCandidate rechecked against exact context; coverage ledger complete.\n");
		await rpacTool(reviewPi, reviewRepo, {
			action: "task_done",
			task: 2,
			verification: [{ name: "adversarial validation recorded", result: "pass" }],
			deliverables: [batch2],
		});
		await fire(reviewPi, "agent_end", { type: "agent_end" }, makeCommandCtx(reviewPi, reviewRepo) as never);
		reviewState = readState(reviewRepo, id);
		assert.equal(reviewState.review.coveredItemIds.length, itemIds.length);

		await rpacCmd(reviewPi, reviewRepo, "consolidate");
		assert.match(reviewPi.userMessages.at(-1)!, /REVIEW CONSOLIDATE/);
		const report = join(workflowDirPath(reviewRepo, id), "review-report.md");
		writeFileSync(report, "# Review report\n\nScope complete; one validated finding. This records scrutiny, not approval.\n");
		const completed = await rpacTool(reviewPi, reviewRepo, { action: "consolidate_complete", text: "report complete" });
		assert.match(completed, /Review workflow complete/);
		reviewState = readState(reviewRepo, id);
		assert.equal(reviewState.phase, "done");
		assert.match(reviewState.artifacts.report.path, /review-report\.md$/);
		assert.ok(reviewState.tasks.at(-1).deliverables.some((entry: { path: string }) => /review-report\.md$/.test(entry.path)), "final report is a hashed deliverable");
		assert.equal(readFileSync(join(reviewRepo, "src", "app.ts"), "utf8"), "export const value = 3;\n", "review did not edit source");
	} finally {
		removeTree(reviewRepo);
	}
});


test("review drift invalidates covered items and remains explicit in an incomplete final report", async () => {
	const root = makeTempDir("rpac-review-drift-");
	const localPi = makeMockPi();
	try {
		writeFileSync(join(root, "app.txt"), "base\n");
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
		execFileSync("git", ["config", "user.name", "t"], { cwd: root });
		execFileSync("git", ["add", "-A"], { cwd: root });
		execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
		writeFileSync(join(root, "app.txt"), "reviewed version\n");
		rpacExtension(extensionApiFor(localPi));
		await rpacCmd(localPi, root, "review current");
		const id = activeWorkflowId(root);
		writeArtifact(root, "requirements", [
			"# Review requirements",
			"## Intent",
			"Review the captured app change for concrete correctness under repository policy.",
			"## Scope",
			"Every manifest item is included without exclusions.",
			"## Acceptance",
			"Persist evidence and report any drift as incomplete coverage.",
		].join("\n"), id);
		await rpacTool(localPi, root, { action: "refine_complete" }, { confirm: [true] });
		const manifest = JSON.parse(readFileSync(join(workflowDirPath(root, id), "review-manifest.json"), "utf8"));
		const ids = manifest.items.map((item: { id: string }) => item.id);
		writeArtifact(root, "plan", [
			"# Review plan",
			"## Summary",
			"Inspect all captured content, retain evidence, and validate the final coverage ledger.",
			"## Tasks",
			"- [ ] Inspect the complete captured scope and validate findings",
			"  - Done when: all manifest IDs have durable evidence",
		].join("\n"), id);
		await rpacTool(localPi, root, {
			action: "plan_complete",
			tasks: [{ title: "Inspect scope and validate findings", reviewItemIds: ids }],
		}, { confirm: [true] });
		await rpacCmd(localPi, root, "act");
		const batch = join(workflowDirPath(root, id), "review-batch-1.md");
		writeFileSync(batch, "# Batch evidence\n\nAll assigned bytes inspected; no supported finding.\n");
		await rpacTool(localPi, root, {
			action: "task_done",
			task: 1,
			verification: [{ name: "complete evidence ledger", result: "pass" }],
			deliverables: [batch],
		});
		await fire(localPi, "agent_end", { type: "agent_end" }, makeCommandCtx(localPi, root) as never);
		assert.deepEqual(readState(root, id).review.coveredItemIds, ids);

		writeFileSync(join(root, "app.txt"), "changed during review\n");
		const consolidate = await rpacCmd(localPi, root, "consolidate");
		assert.match(consolidate.ui.text("warning").join("\n"), /drift/i);
		let s = readState(root, id);
		assert.ok(s.review.drift);
		assert.equal(s.review.coveredItemIds.length, 0);
		assert.deepEqual(s.review.uncoveredItemIds, ids);
		const report = join(workflowDirPath(root, id), "review-report.md");
		writeFileSync(report, "# Review report\n\n## Outcome\nIncomplete because the reviewed file drifted. Scrutiny, not approval.\n\n## Limitations\nThe changed manifest item is uncovered.\n");
		const result = await rpacTool(localPi, root, { action: "consolidate_complete", text: "incomplete drift report" });
		assert.match(result, /drift/i);
		s = readState(root, id);
		assert.equal(s.phase, "done");
		assert.ok(s.review.drift, "drift remains persisted at completion");
	} finally {
		removeTree(root);
	}
});

test("staged review rejects an unresolved index conflict without creating review state", async () => {
	const root = makeTempDir("rpac-review-conflict-");
	const localPi = makeMockPi();
	try {
		writeFileSync(join(root, "conflict.txt"), "base\n");
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
		execFileSync("git", ["config", "user.name", "t"], { cwd: root });
		execFileSync("git", ["add", "-A"], { cwd: root });
		execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
		const mainBranch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
		execFileSync("git", ["checkout", "-qb", "side"], { cwd: root });
		writeFileSync(join(root, "conflict.txt"), "side\n");
		execFileSync("git", ["commit", "-qam", "side"], { cwd: root });
		execFileSync("git", ["checkout", "-q", mainBranch], { cwd: root });
		writeFileSync(join(root, "conflict.txt"), "main\n");
		execFileSync("git", ["commit", "-qam", "main"], { cwd: root });
		assert.throws(() => execFileSync("git", ["merge", "side"], { cwd: root, stdio: "pipe" }));
		rpacExtension(extensionApiFor(localPi));
		const result = await rpacCmd(localPi, root, "review staged");
		assert.match(result.ui.text("error").join("\n"), /resolve unmerged index entries/i);
		assert.equal(existsSync(join(root, ".pi", "rpac", "state.json")), false);
	} finally {
		removeTree(root);
	}
});

test("/rpac review accepts all modes and preserves an empty current/staged scope", async () => {
	const root = makeTempDir("rpac-review-modes-");
	const localPi = makeMockPi();
	try {
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
		execFileSync("git", ["config", "user.name", "t"], { cwd: root });
		writeFileSync(join(root, "a.txt"), "a\n");
		execFileSync("git", ["add", "-A"], { cwd: root });
		execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
		rpacExtension(extensionApiFor(localPi));
		for (const mode of ["current", "staged", "full"] as const) {
			await rpacCmd(localPi, root, `review ${mode}`);
			const current = readState(root);
			assert.equal(current.review.mode, mode);
			assert.equal(current.review.scopeItemIds.length, mode === "full" ? 1 : 0);
			await rpacCmd(localPi, root, "abort --yes mode checked", { hasUI: false });
		}
	} finally {
		removeTree(root);
	}
});

test("/rpac review rejects invalid syntax/non-git roots and headless active replacement", async () => {
	const root = makeTempDir("rpac-review-errors-");
	const localPi = makeMockPi();
	try {
		rpacExtension(extensionApiFor(localPi));
		let ctx = await rpacCmd(localPi, root, "review branch main");
		assert.match(ctx.ui.text("error").join("\n"), /Usage/);
		assert.equal(existsSync(join(root, ".pi", "rpac", "state.json")), false);
		ctx = await rpacCmd(localPi, root, "review");
		assert.match(ctx.ui.text("error").join("\n"), /Git work tree/);

		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
		execFileSync("git", ["config", "user.name", "t"], { cwd: root });
		writeFileSync(join(root, "a.txt"), "a\n");
		execFileSync("git", ["add", "-A"], { cwd: root });
		execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
		await rpacCmd(localPi, root, "start active task");
		const active = activeWorkflowId(root);
		ctx = await rpacCmd(localPi, root, "review staged", { hasUI: false });
		assert.match(ctx.ui.text("error").join("\n"), /active workflow.*abort\/finish/i);
		assert.equal(activeWorkflowId(root), active);
	} finally {
		removeTree(root);
	}
});
