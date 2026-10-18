// Exercise the real /rpac handlers: human summary and technical evidence are separate views.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import rpacExtension from "../../extensions/rpac.ts";
import { newState, newReviewState, type PrReviewMeta, type RpacState } from "../../lib/schema.ts";
import { createWorkflow, updateActive } from "../../lib/store.ts";
import { captureBaseline } from "../../lib/git.ts";
import { makeTempDir, removeTree, sha256File } from "../../lib/util.ts";
import { progressMessage } from "../../lib/presentation.ts";
import { extensionApiFor, fire, makeCommandCtx, makeMockPi, readIndex, rpacCmd } from "../helpers/mock-pi.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const manifest = "{}\n";
async function fixture(run: (root: string, m: ReturnType<typeof makeMockPi>) => Promise<void>) {
	const dir = makeTempDir("rpac-status-");
	const root = join(dir, "project"), agent = join(dir, "agent");
	mkdirSync(root); mkdirSync(agent);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	const m = makeMockPi(); rpacExtension(extensionApiFor(m));
	try { await run(root, m); }
	finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		removeTree(dir);
	}
}
async function status(m: ReturnType<typeof makeMockPi>, root: string, command = "status") {
	const response = await rpacCmd(m, root, command);
	assert.deepEqual(response.ui.text("error"), []);
	return response.ui.text("info").join("\n");
}
function plainOnly(text: string, state?: RpacState) {
	assert.match(text, /\/rpac status --details/);
	assert.doesNotMatch(text, /Active workflow|Approvals:|Phase:|fingerprint|Artifact:|PR checkout:|ACT lease:|Recent:|\.pi\/rpac\/|\b[0-9a-f]{8,64}\b/);
	if (state) assert.ok(!text.includes(state.id), "no routine workflow identity");
}
function implementation(root: string): RpacState {
	const state = newState(root, "Keep invalid ports out of the settings form");
	state.phase = "act";
	state.approvals.requirements = true; state.approvals.plan = true;
	state.tasks = [
		{ id: 1, title: "Check valid ports", status: "done", verification: [{ name: "valid ports", result: "pass" }] },
		{ id: 2, title: "Reject invalid ports", status: "pending" },
		{ id: 3, title: "Check the settings form", status: "pending" },
	];
	return state;
}
function review(root: string, pr?: PrReviewMeta): RpacState {
	const state = newReviewState(root, { mode: pr ? "pr" : "current", fingerprint: "b".repeat(64), manifestSha256: hash(manifest), head: pr?.headSha ?? "c".repeat(40), unborn: false, capturedAt: "2026-01-01T00:00:00Z", scopeItemIds: Array.from({ length: 18 }, (_, n) => `item-${n + 1}`), pr });
	state.phase = "act";
	state.approvals.requirements = true; state.approvals.plan = true;
	state.tasks = [{ id: 1, title: "Review files", status: "done" }, { id: 2, title: "Validate findings", status: "done" }];
	state.review!.coveredItemIds = state.review!.scopeItemIds.slice(0, 12);
	return state;
}
function save(root: string, state: RpacState) {
	createWorkflow(root, state, true);
	if (state.review) writeFileSync(join(root, state.review.manifest.path), manifest);
}
function prMeta(root: string, strategy: "in-place" | "worktree"): PrReviewMeta {
	return { number: 7, url: "https://github.com/example/project/pull/7", title: "Validate ports", body: "", repository: "example/project", state: "open", crossRepository: false, baseRef: "main", baseSha: "d".repeat(40), headRef: "ports", headSha: "c".repeat(40), originalBranch: "main", originalHead: "d".repeat(40), originalDirty: [], checkoutStrategy: strategy, checkoutLocation: strategy === "in-place" ? root : join(root, "separate-copy"), checkedOutAt: "2026-01-01T00:00:00Z" };
}

test("Natural default and bare /rpac report active progress without internal metadata", () => fixture(async (root, m) => {
	const state = implementation(root); save(root, state);
	const file = join(root, ".pi", "rpac", state.id, "workflow.json");
	const before = readFileSync(file, "utf8");
	const text = await status(m, root);
	assert.match(text, /working through the approved plan/);
	assert.match(text, /1 of 3 tasks are finished/);
	assert.match(text, /remaining work is not complete/);
	assert.match(text, /\/rpac act/);
	plainOnly(text, state);
	assert.equal(await status(m, root, ""), text, "/rpac shares the conversational command path");
	assert.equal(readFileSync(file, "utf8"), before, "status does not rewrite saved state");
}));

test("failed, blocked and interrupted work stays visible without dumping raw diagnostics", () => fixture(async (root, m) => {
	const state = implementation(root);
	state.tasks[0] = { id: 1, title: "Task failure", status: "failed", issues: ["Raw diagnostic with internal symbol x::y"], verification: [{ name: "npm test", result: "fail", detail: "exit 1" }, { name: "browser test", result: "unavailable" }] };
	state.tasks[1].status = "blocked";
	state.tasks[2].status = "interrupted";
	save(root, state);
	const text = await status(m, root);
	assert.match(text, /task failed and is not complete/);
	assert.match(text, /task is blocked/);
	assert.match(text, /stopped before finishing/);
	assert.match(text, /1 recorded check failed/);
	assert.match(text, /unavailable.*unverified/);
	assert.match(text, /resolve it.*unblock/);
	assert.doesNotMatch(text, /x::y|exit 1|npm test/);
	plainOnly(text, state);
	updateActive(root, (s) => { s.tasks = [s.tasks[0]]; });
	assert.match(await status(m, root), /\/rpac act 1/, "failed task retry names the supported explicit task command");
}));

test("completed, aborted and paused workflows report their actual state and next steps", () => fixture(async (root, m) => {
	const state = implementation(root); save(root, state);
	updateActive(root, (s) => { s.paused = true; });
	const paused = await status(m, root);
	assert.match(paused, /RPAC is paused/); assert.match(paused, /\/rpac resume/);
	assert.doesNotMatch(paused, /Run \/rpac act/); plainOnly(paused, state);
	updateActive(root, (s) => { s.paused = false; s.phase = "done"; s.tasks.forEach((task) => { task.status = "done"; }); });
	const done = await status(m, root);
	assert.match(done, /finished with this workflow/); assert.match(done, /3 of 3 tasks/);
	assert.match(done, /not committed or published/); plainOnly(done, state);
	updateActive(root, (s) => { s.phase = "aborted"; s.tasks[1].status = "pending"; });
	const aborted = await status(m, root);
	assert.match(aborted, /no longer working on this task/); assert.match(aborted, /\/rpac start <task>/);
	assert.match(aborted, /code changes remain/); plainOnly(aborted, state);
}));

test("finished tasks do not imply complete review coverage, including terminal and empty drifting reviews", () => fixture(async (root, m) => {
	const state = review(root); save(root, state);
	const text = await status(m, root);
	assert.match(text, /2 of 2 tasks are finished/);
	assert.match(text, /evidence covers 12 of 18 items/);
	assert.match(text, /6 items still need review.*assessment is incomplete/);
	assert.match(text, /tasks alone do not establish a complete or successful assessment/);
	assert.match(text, /revisit the review plan/); plainOnly(text, state);
	updateActive(root, (s) => {
		s.phase = "done";
		s.review!.drift = { detectedAt: "2026-01-01T00:00:00Z", fingerprint: "e".repeat(64), addedItemIds: [], removedItemIds: [], changedItemIds: ["item-1"] };
	});
	const ended = await status(m, root);
	assert.match(ended, /assessment is incomplete/); assert.match(ended, /not a clean review/);
	assert.match(ended, /\/rpac review/); assert.match(ended, /not approval/); plainOnly(ended, state);
	updateActive(root, (s) => { s.review!.scopeItemIds = []; s.review!.coveredItemIds = []; s.review!.uncoveredItemIds = []; });
	const empty = await status(m, root);
	assert.match(empty, /covers 0 of 0 items/); assert.match(empty, /not a clean review/);
}));

test("accepted exceptions and failed observations remain material even after tasks finish", () => fixture(async (root, m) => {
	const state = review(root);
	state.review!.coveredItemIds = [...state.review!.scopeItemIds];
	state.phase = "done";
	state.tasks[0].acceptedException = "One check could not run";
	state.tasks[0].verification = [{ name: "subject defect", kind: "observation", result: "fail" }, { name: "unavailable check", result: "unavailable" }];
	save(root, state);
	const text = await status(m, root);
	assert.match(text, /recorded check failed/); assert.match(text, /unverified/);
	assert.match(text, /accepted with an exception/); assert.match(text, /not approval/);
	assert.doesNotMatch(text, /task failed/, "a failed observation must not be relabeled as a failed task");
}));

test("PR restoration and safe cleanup guidance survives completion and abort without routine metadata", () => fixture(async (root, m) => {
	for (const strategy of ["in-place", "worktree"] as const) {
		const state = review(root, prMeta(root, strategy)); save(root, state);
		for (const phase of ["act", "done", "aborted"] as const) {
			updateActive(root, (s) => { s.phase = phase; });
			const text = await status(m, root);
			plainOnly(text, state);
			if (strategy === "in-place") {
				assert.match(text, /used your main working copy/); assert.match(text, /git switch -- 'main'/);
				assert.match(text, /inspect any new work/); assert.match(text, /does not automatically switch it back/);
			} else {
				assert.match(text, /main working copy was not changed/); assert.match(text, /\/rpac pr-cleanup/);
				assert.match(text, /refuses if files changed.*belongs to RPAC/);
			}
			if (phase !== "act") assert.match(text, /\/rpac start preview 7/, "new PR assessment must use the PR command, not a local review");
			const details = await status(m, root, "status --details");
			assert.match(details, /PR checkout:/); assert.ok(details.includes(state.review!.pr!.checkoutLocation));
			assert.match(details, strategy === "in-place" ? /PR restore:/ : /PR cleanup:/);
		}
	}
}));

test("details and Technical retain identities, checks, approvals, Git baseline and recovery evidence", () => fixture(async (root, m) => {
	execFileSync("git", ["init", "-q"], { cwd: root });
	writeFileSync(join(root, "app.txt"), "original\n");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd: root });
	const state = review(root); state.baseline = captureBaseline(root);
	state.tasks[0].verification = [{ name: "npm test", result: "fail", detail: "exit 1: invalid port accepted" }];
	state.review!.approvedChecks = ["npm test"];
	save(root, state);
	const output = join(root, "result.txt"); writeFileSync(output, "saved evidence\n");
	const artifact = { path: "result.txt", sha256: sha256File(output) };
	updateActive(root, (s) => { s.artifacts.report = artifact; s.tasks[0].deliverables = [artifact]; });
	const text = await status(m, root, "status --details");
	for (const exact of [state.id, artifact.path, artifact.sha256, state.baseline!.head, state.review!.fingerprint, state.review!.head, "item-18", "exit 1: invalid port accepted"]) assert.ok(text.includes(exact), exact);
	assert.match(text, /Approvals: requirements approved; plan approved/);
	assert.match(text, /Approved review check: npm test/); assert.match(text, /Recent:/);
	assert.match(text, /\[done\]/); assert.match(text, /coverage 12\/18/);
	await rpacCmd(m, root, "style technical");
	assert.equal(await status(m, root), await status(m, root, "status --details"));
	assert.equal(await status(m, root, ""), await status(m, root), "bare command also honors Technical");
	assert.equal(sha256File(output), artifact.sha256);
}));

test("changed documents and project versions warn conversationally without hiding the exact evidence", () => fixture(async (root, m) => {
	const state = implementation(root);
	state.artifacts.plan = { path: "missing-plan.md", sha256: "f".repeat(64) };
	state.baseline = { branch: "old-branch", head: "a".repeat(40), dirty: [], createdAt: "2026-01-01T00:00:00Z" };
	save(root, state);
	const text = await status(m, root);
	assert.match(text, /saved documents or task outputs can no longer be trusted/);
	assert.match(text, /starting point can no longer be checked/); plainOnly(text, state);
	const details = await status(m, root, "status --details");
	assert.match(details, /plan artifact is missing/); assert.match(details, /missing-plan.md/);
	assert.match(details, /repository no longer accessible/);
}));

test("custom styles affect model instructions but deterministic milestones fall back to Natural", () => fixture(async (root, m) => {
	const state = newState(root, "Clarify the port requirement"); save(root, state);
	writeFileSync(join(root, ".pi", "rpac-style.json"), JSON.stringify({ version: 1, style: "brief-reviewer", styles: { "brief-reviewer": { name: "Brief Reviewer", description: "Brief prose", instructions: "Respond in terse, evidence-focused paragraphs." } } }));
	assert.equal(progressMessage("refine", "brief-reviewer"), progressMessage("refine", "natural"));
	const refine = await rpacCmd(m, root, "refine");
	assert.deepEqual(refine.ui.text("info"), [progressMessage("refine", "natural")]);
	const request = await fire(m, "context", { messages: [] }, makeCommandCtx(m, root) as any) as any;
	assert.match(request.messages[0].content, /brief-reviewer/); assert.match(request.messages[0].content, /terse, evidence-focused paragraphs/);
	const customStatus = await status(m, root); plainOnly(customStatus, state);
	await rpacCmd(m, root, "style natural");
	assert.equal(await status(m, root), customStatus, "deterministic status uses shared Natural wording too");
}));

test("no-active status gives usable commands without routine roots or saved workflow identities", () => fixture(async (root, m) => {
	const empty = await status(m, root);
	assert.match(empty, /No active workflow/); assert.match(empty, /\/rpac start <task description>/);
	assert.equal(await status(m, root, ""), empty); plainOnly(empty);
	const state = implementation(root); save(root, state);
	const index = readIndex(root); index.active = null;
	writeFileSync(join(root, ".pi", "rpac", "state.json"), JSON.stringify(index));
	const saved = await status(m, root);
	assert.match(saved, /saved work.*\/rpac list/); plainOnly(saved, state);
	const listed = await rpacCmd(m, root, "list");
	assert.ok(listed.ui.text("info").join("\n").includes(state.id));
	const details = await status(m, root, "status --details");
	assert.ok(details.includes(state.id)); assert.ok(details.includes(root));
}));
