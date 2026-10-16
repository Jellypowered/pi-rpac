import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	RpacGuardError,
	abort,
	approvePlan,
	approveRequirements,
	approveSequential,
	backToAct,
	backToPlan,
	consolidateComplete,
	decision,
	deviation,
	markInterrupted,
	pause,
	planComplete,
	readyTasks,
	recordReviewDrift,
	refineComplete,
	replaceReviewScope,
	reviewCoverage,
	resume,
	taskAccept,
	taskBlock,
	taskDone,
	taskFail,
	taskStart,
	taskUnblock,
} from "../../lib/machine.ts";
import { type RpacState, newState, newReviewState, capStateArrays } from "../../lib/schema.ts";
import { makeTempDir, removeTree } from "../../lib/util.ts";

const PROJECT = "/work/demo";

// Substantive-enough artifacts (isSubstantive: >= 80 chars, >= 3 non-empty lines).
const REQ_BODY = [
	"# Requirements",
	"## Context",
	"The demo app needs a greeting function that returns a friendly string for any given name.",
	"## Requirements",
	"- R1: greet(name) returns 'Hello, <name>'.",
	"## Acceptance criteria",
	"- AC-1: greet('World') === 'Hello, World'",
].join("\n");

const PLAN_BODY = [
	"# Plan",
	"## Summary",
	"Add greet(name) to the demo app with a small unit check.",
	"## Conventions",
	"CommonJS, no new dependencies.",
	"## Tasks",
	"- [ ] 1. Implement greet()",
	"- [ ] 2. Wire greet into the app",
].join("\n");

const REPORT_BODY = ["# Completion report", "## Verdict", "Complete — AC-1 verified by the node check.", "## Verification", "- node greet check: pass"].join("\n");

function mkState(): { state: RpacState; dir: string; reqFile: string; planFile: string; reportFile: string; cleanup: () => void } {
	const dir = makeTempDir();
	return {
		state: newState(PROJECT, "demo"),
		dir,
		reqFile: join(dir, "requirements.md"),
		planFile: join(dir, "plan.md"),
		reportFile: join(dir, "report.md"),
		cleanup: () => removeTree(dir),
	};
}

function withArtifacts(env: ReturnType<typeof mkState>): void {
	writeFileSync(env.reqFile, REQ_BODY, "utf8");
	writeFileSync(env.planFile, PLAN_BODY, "utf8");
	writeFileSync(env.reportFile, REPORT_BODY, "utf8");
}

function approvedPlanState(): RpacState {
	const env = mkState();
	withArtifacts(env);
	refineComplete(env.state, env.reqFile);
	approveRequirements(env.state);
	planComplete(env.state, env.planFile, [
		{ title: "Implement greet()" },
		{ title: "Wire greet into the app", dependsOn: [1] },
	]);
	approvePlan(env.state);
	env.state.phase = "act";
	env.cleanup();
	return env.state;
}

function approvedReviewState(): RpacState {
	const env = mkState();
	withArtifacts(env);
	env.state = newReviewState(PROJECT, {
		mode: "current",
		fingerprint: "cd".repeat(32),
		manifestSha256: "ab".repeat(32),
		head: "1".repeat(40),
		unborn: false,
		capturedAt: "2026-01-01T00:00:00Z",
		scopeItemIds: ["ri-a", "ri-b"],
	});
	refineComplete(env.state, env.reqFile);
	approveRequirements(env.state);
	planComplete(env.state, env.planFile, [
		{ title: "Review batch", reviewItemIds: ["ri-a", "ri-b"] },
		{ title: "Validate findings", dependsOn: [1] },
	]);
	approvePlan(env.state);
	env.state.phase = "act";
	env.cleanup();
	return env.state;
}

test("refine_complete requires the artifact, is non-trivial, and requests approval", () => {
	const env = mkState();
	try {
		assert.throws(
			() => refineComplete(env.state, env.reqFile),
			(e: Error) => e instanceof RpacGuardError && /not found/.test(e.message),
		);
		// a one-line stub is not approvable
		writeFileSync(env.reqFile, "# Requirements\n- do the thing\n", "utf8");
		assert.throws(
			() => refineComplete(env.state, env.reqFile),
			(e: Error) => e instanceof RpacGuardError && /too thin/.test(e.message),
		);
		writeFileSync(env.reqFile, REQ_BODY, "utf8");
		const res = refineComplete(env.state, env.reqFile);
		assert.equal(res.needsApproval, "requirements");
		assert.equal(env.state.approvals.requirements, false); // still user-gated
	} finally {
		env.cleanup();
	}
});

test("approveRequirements is user-gated and transitions to plan", () => {
	const env = mkState();
	try {
		assert.throws(
			() => approveRequirements(env.state),
			(e: Error) => e instanceof RpacGuardError && /no requirements artifact/.test(e.message),
		);
		writeFileSync(env.reqFile, REQ_BODY, "utf8");
		refineComplete(env.state, env.reqFile);
		const res = approveRequirements(env.state);
		assert.equal(env.state.phase, "plan");
		assert.equal(env.state.approvals.requirements, true);
		assert.match(res.message, /Requirements approved/);
		// idempotent
		const again = approveRequirements(env.state);
		assert.equal(again.message, "Requirements already approved.");
	} finally {
		env.cleanup();
	}
});

test("plan_complete is gated on approved requirements and a valid task graph", () => {
	const env = mkState();
	try {
		writeFileSync(env.reqFile, REQ_BODY, "utf8");
		refineComplete(env.state, env.reqFile);
		// in plan phase without requirements approval the gate bites
		env.state.phase = "plan";
		assert.throws(
			() => planComplete(env.state, env.planFile, [{ title: "x" }]),
			(e: Error) => e instanceof RpacGuardError && /approved requirements/.test(e.message),
		);
		approveRequirements(env.state);
		// the plan artifact must exist: the artifact check precedes the task-list check
		writeFileSync(env.planFile, PLAN_BODY, "utf8");
		assert.throws(
			() => planComplete(env.state, env.planFile, []),
			(e: Error) => e instanceof RpacGuardError && /non-empty/.test(e.message),
		);
		// unknown dependency reference
		assert.throws(
			() => planComplete(env.state, env.planFile, [{ title: "a" }, { title: "b", dependsOn: [9] }]),
			(e: Error) => e instanceof RpacGuardError && /unknown task 9/.test(e.message),
		);
		// dependency cycle
		assert.throws(
			() => planComplete(env.state, env.planFile, [{ title: "a", dependsOn: [2] }, { title: "b", dependsOn: [1] }]),
			(e: Error) => e instanceof RpacGuardError && /cycle/.test(e.message),
		);
		// self reference
		assert.throws(
			() => planComplete(env.state, env.planFile, [{ title: "a", dependsOn: [1] }]),
			(e: Error) => e instanceof RpacGuardError && /depends on itself/.test(e.message),
		);
	} finally {
		env.cleanup();
	}
});

test("review plans require exact, single assignment of every manifest item", () => {
	const env = mkState();
	try {
		withArtifacts(env);
		env.state = newReviewState(PROJECT, {
			mode: "full",
			fingerprint: "cd".repeat(32),
			manifestSha256: "ab".repeat(32),
			head: "1".repeat(40),
			unborn: false,
			capturedAt: "2026-01-01T00:00:00Z",
			scopeItemIds: ["ri-a", "ri-b"],
		});
		refineComplete(env.state, env.reqFile);
		approveRequirements(env.state);
		assert.throws(() => planComplete(env.state, env.planFile, [{ title: "partial", reviewItemIds: ["ri-a"] }]), /leaves 1 manifest item/);
		assert.throws(
			() => planComplete(env.state, env.planFile, [{ title: "bad", reviewItemIds: ["ri-a", "ri-missing", "ri-b"] }]),
			/unknown manifest item ri-missing/,
		);
		assert.throws(
			() => planComplete(env.state, env.planFile, [
				{ title: "one", reviewItemIds: ["ri-a", "ri-b"] },
				{ title: "two", reviewItemIds: ["ri-b"] },
			]),
			/assigned more than once/,
		);
		planComplete(env.state, env.planFile, [
			{ title: "batch one", reviewItemIds: ["ri-a"] },
			{ title: "batch two", reviewItemIds: ["ri-b"], dependsOn: [1] },
			{ title: "validate", dependsOn: [2] },
		], "plan.md", ["npm test", "npm test", "  "]);
		assert.deepEqual(env.state.tasks[1]!.reviewItemIds, ["ri-b"]);
		assert.deepEqual(env.state.review!.approvedChecks, ["npm test"]);
	} finally {
		env.cleanup();
	}
});

test("review scope can be replaced only during refine/plan and invalidates an old plan", () => {
	const state = approvedReviewState();
	state.phase = "plan";
	state.approvals.plan = true;
	state.artifacts.plan = { path: "plan.md", sha256: "12".repeat(32) };
	const result = replaceReviewScope(state, {
		fingerprint: "ef".repeat(32),
		manifest: { path: "new-manifest.json", sha256: "34".repeat(32) },
		head: "2".repeat(40),
		unborn: false,
		capturedAt: "2026-01-02T00:00:00Z",
		scopeItemIds: ["ri-new"],
		exclusions: [{ path: "prior.md", reason: "prior report" }],
	});
	assert.match(result.message, /scope replaced/);
	assert.equal(state.approvals.plan, false);
	assert.equal(state.artifacts.plan, undefined);
	assert.deepEqual(state.review!.scopeItemIds, ["ri-new"]);
	state.phase = "act";
	assert.throws(() => replaceReviewScope(state, {
		fingerprint: "ef".repeat(32), manifest: { path: "x", sha256: "34".repeat(32) }, head: "x", unborn: false,
		capturedAt: "x", scopeItemIds: [], exclusions: [],
	}), /not available in phase/);
});

test("review coverage is persisted, accepted failures stay uncovered, and drift invalidates coverage", () => {
	const state = approvedReviewState();
	assert.deepEqual(reviewCoverage(state), { total: 2, covered: 0, uncovered: ["ri-a", "ri-b"], complete: false });
	taskStart(state, 1);
	taskDone(state, 1, [{ name: "batch evidence recorded", result: "pass" }]);
	assert.deepEqual(reviewCoverage(state), { total: 2, covered: 2, uncovered: [], complete: true });
	recordReviewDrift(state, "ef".repeat(32), ["ri-new"], [], ["ri-a"]);
	const drifted = reviewCoverage(state);
	assert.equal(drifted.complete, false);
	assert.equal(drifted.covered, 1);
	assert.deepEqual(drifted.uncovered, ["ri-a", "ri-new"]);
	const unchanged = recordReviewDrift(state, state.review!.fingerprint, [], [], []);
	assert.match(unchanged.message, /unchanged/);
	assert.equal(state.review!.drift, undefined);

	const accepted = approvedReviewState();
	taskStart(accepted, 1);
	taskDone(accepted, 1, [{ name: "evidence", result: "fail" }]);
	taskAccept(accepted, 1, "user accepts incomplete batch");
	assert.deepEqual(accepted.review!.uncoveredItemIds, ["ri-a", "ri-b"]);
	assert.equal(reviewCoverage(accepted).complete, false);
});

test("approvePlan requires tasks and stays idempotent", () => {
	const env = mkState();
	try {
		// in the plan phase with requirements approved but no tasks: refused
		writeFileSync(env.reqFile, REQ_BODY, "utf8");
		refineComplete(env.state, env.reqFile);
		approveRequirements(env.state); // → plan phase
		assert.equal(env.state.phase, "plan");
		assert.throws(() => approvePlan(env.state), (e: Error) => e instanceof RpacGuardError && /no tasks/.test(e.message));
		// with a registered task list: approved, and idempotent
		writeFileSync(env.planFile, PLAN_BODY, "utf8");
		planComplete(env.state, env.planFile, [{ title: "a" }, { title: "b", dependsOn: [1] }]);
		approvePlan(env.state);
		assert.equal(env.state.approvals.plan, true);
		const again = approvePlan(env.state);
		assert.equal(again.message, "Plan already approved.");
	} finally {
		env.cleanup();
	}
});

test("task_start picks the first ready task, honors dependencies, and re-starts resumable tasks", () => {
	const s = approvedPlanState();
	taskStart(s);
	assert.equal(s.tasks[0]!.status, "in_progress");
	// explicit re-start of the in-progress task is allowed (re-issue)
	taskStart(s, 1);
	assert.equal(s.tasks[0]!.status, "in_progress");
	// a dependent task cannot start
	const s2 = approvedPlanState();
	assert.throws(() => taskStart(s2, 2), (e: Error) => e instanceof RpacGuardError && /depends on unfinished task\(s\) 1/.test(e.message));
	taskStart(s2);
	taskDone(s2, 1, [{ name: "unit", result: "pass" }]);
	assert.throws(() => taskStart(s2, 1), (e: Error) => /already done/.test(e.message));
	assert.throws(() => taskStart(s2, 99), (e: Error) => /no task with id 99/.test(e.message));
});

test("task_done refuses without verification", () => {
	const s = approvedPlanState();
	taskStart(s);
	assert.throws(() => taskDone(s, 1, []), (e: Error) => e instanceof RpacGuardError && /requires verification/.test(e.message));
	assert.throws(() => taskDone(s, 1, undefined as never), (e: Error) => /requires verification/.test(e.message));
});

test("task_done with all-passing checks marks the task done", () => {
	const s = approvedPlanState();
	taskStart(s);
	const res = taskDone(s, 1, [{ name: "unit", result: "pass" }, { name: "lint", result: "pass", detail: "clean" }]);
	assert.equal(s.tasks[0]!.status, "done");
	assert.ok(s.tasks[0]!.doneAt);
	assert.match(res.message, /complete/);
});

test("task_done with a failing check leaves the task FAILED (not done)", () => {
	const s = approvedPlanState();
	taskStart(s);
	const res = taskDone(s, 1, [
		{ name: "unit", result: "pass" },
		{ name: "e2e", result: "fail", detail: "browser flake" },
	]);
	assert.equal(s.tasks[0]!.status, "failed");
	assert.equal(s.tasks[0]!.verification?.length, 2);
	assert.ok(s.tasks[0]!.issues?.some((i) => /e2e.*fail/.test(i)));
	assert.equal(res.stopSequential, true);
	assert.match(res.message, /FAILED \(not done\)/);
	// a failed task is restartable
	taskStart(s, 1);
	assert.equal(s.tasks[0]!.status, "in_progress");
});

test("audit observations record subject failures without failing a verified review task", () => {
	const s = approvedPlanState();
	taskStart(s);
	const res = taskDone(s, 1, [
		{ name: "clang-format", kind: "observation", result: "fail", detail: "48 existing violations found" },
		{ name: "review report captures tool output", kind: "acceptance", result: "pass" },
	]);
	assert.equal(s.tasks[0]!.status, "done");
	assert.ok(s.tasks[0]!.issues?.some((i) => /observation.*clang-format.*fail/.test(i)));
	assert.match(res.message, /complete.*observation/s);
});

test("observations alone cannot verify task completion", () => {
	const s = approvedPlanState();
	taskStart(s);
	assert.throws(
		() => taskDone(s, 1, [{ name: "lint", kind: "observation", result: "pass" }]),
		(e: Error) => /at least one acceptance check/.test(e.message),
	);
	assert.equal(s.tasks[0]!.status, "in_progress");
});

test("task_done with an unavailable check leaves the task FAILED (not done)", () => {
	const s = approvedPlanState();
	taskStart(s);
	const res = taskDone(s, 1, [{ name: "manual", result: "unavailable", detail: "needs a device" }]);
	assert.equal(s.tasks[0]!.status, "failed");
	assert.equal(res.stopSequential, true);
});

test("failed task can be accepted with a documented exception by the user", () => {
	const s = approvedPlanState();
	taskStart(s);
	taskDone(s, 1, [{ name: "e2e", result: "fail", detail: "infra outage" }]);
	assert.equal(s.tasks[0]!.status, "failed");
	assert.throws(() => taskAccept(s, 1, ""), (e: Error) => e instanceof RpacGuardError && /reason/.test(e.message));
	const res = taskAccept(s, 1, "e2e infra outage; unit checks pass; user accepts");
	assert.equal(s.tasks[0]!.status, "done");
	assert.equal(s.tasks[0]!.acceptedException, "e2e infra outage; unit checks pass; user accepts");
	assert.ok(s.tasks[0]!.issues?.some((i) => i.startsWith("accepted exception:")));
	assert.match(res.message, /accepted/);
	// accepting a non-failed task is refused
	taskStart(s, 2);
	assert.throws(() => taskAccept(s, 2, "nope"), (e: Error) => /only failed tasks/.test(e.message));
});

test("task_fail marks the in-progress task failed with a reason", () => {
	const s = approvedPlanState();
	taskStart(s);
	const res = taskFail(s, 1, "upstream API unavailable", [{ name: "api", result: "unavailable" }]);
	assert.equal(s.tasks[0]!.status, "failed");
	assert.ok(s.tasks[0]!.issues?.some((i) => /upstream API/.test(i)));
	assert.equal(res.stopSequential, true);
	assert.throws(() => taskFail(s, 1, "again"), (e: Error) => /not in_progress/.test(e.message));
});

test("blocked tasks need unblocking before re-start", () => {
	const s = approvedPlanState();
	taskStart(s);
	const res = taskBlock(s, 1, "needs a decision on the data model");
	assert.equal(s.tasks[0]!.status, "blocked");
	assert.equal(res.stopSequential, true);
	assert.throws(() => taskStart(s, 1), (e: Error) => /blocked/.test(e.message));
	assert.throws(() => taskDone(s, 1, [{ name: "x", result: "pass" }]), (e: Error) => /blocked/.test(e.message));
	taskUnblock(s, 1);
	assert.equal(s.tasks[0]!.status, "pending");
	taskStart(s, 1);
	assert.equal(s.tasks[0]!.status, "in_progress");
});

test("interrupted tasks are resumable", () => {
	const s = approvedPlanState();
	taskStart(s);
	const res = markInterrupted(s);
	assert.equal(s.tasks[0]!.status, "interrupted");
	assert.match(res.message, /interrupted/);
	// nothing in progress → no-op message
	const again = markInterrupted(s);
	assert.match(again.message, /no in-progress task/);
	taskStart(s, 1);
	assert.equal(s.tasks[0]!.status, "in_progress");
});

test("sequential stop semantics: only a verified done continues", () => {
	const s = approvedPlanState();
	s.approvals.sequential = true;
	taskStart(s);
	// failing check → stop
	const failed = taskDone(s, 1, [{ name: "unit", result: "fail" }]);
	assert.equal(failed.stopSequential, true);
	// fresh state, all passing → continue
	const s2 = approvedPlanState();
	s2.approvals.sequential = true;
	taskStart(s2);
	const ok = taskDone(s2, 1, [{ name: "unit", result: "pass" }]);
	assert.equal(ok.stopSequential, undefined);
	assert.match(ok.message, /Continue with the next ready task/);
	// blocked → stop
	const s3 = approvedPlanState();
	s3.approvals.sequential = true;
	taskStart(s3);
	const blocked = taskBlock(s3, 1, "blocked on API keys");
	assert.equal(blocked.stopSequential, true);
});

test("pause blocks mutations and resume clears it", () => {
	const s = approvedPlanState();
	pause(s);
	assert.throws(() => taskStart(s), (e: Error) => e instanceof RpacGuardError && /paused/.test(e.message));
	resume(s);
	taskStart(s);
	assert.equal(s.tasks[0]!.status, "in_progress");
});

test("unapproved plan blocks act entirely", () => {
	const s = approvedPlanState();
	s.approvals.plan = false;
	assert.throws(() => taskStart(s), (e: Error) => e instanceof RpacGuardError && /approved plan/.test(e.message));
});

test("no ready task: failed tasks are named in the error", () => {
	const s = approvedPlanState();
	taskStart(s);
	taskFail(s, 1, "cannot proceed");
	// task 2 is pending but its dep (task 1) is not done → blocked-by message
	assert.throws(() => taskStart(s), (e: Error) => /blocked by unfinished task\(s\) 1/.test(e.message));
});

test("decision/deviation/checkpoint guard terminal phases", () => {
	const env = mkState();
	try {
		withArtifacts(env);
		decision(env.state, "use approach A");
		deviation(env.state, "approach A needed a helper");
		const s = approvedPlanState();
		s.phase = "done";
		assert.throws(() => decision(s, "late"), (e: Error) => /no further decisions/.test(e.message));
		assert.throws(() => deviation(s, "late"), (e: Error) => /no further deviations/.test(e.message));
	} finally {
		env.cleanup();
	}
});

test("consolidate_complete requires the report and completes the workflow", () => {
	const env = mkState();
	try {
		writeFileSync(env.reqFile, REQ_BODY, "utf8");
		writeFileSync(env.planFile, PLAN_BODY, "utf8");
		env.state.phase = "consolidate";
		assert.throws(
			() => consolidateComplete(env.state, env.reportFile),
			(e: Error) => e instanceof RpacGuardError && /not found/.test(e.message),
		);
		writeFileSync(env.reportFile, REPORT_BODY, "utf8");
		const res = consolidateComplete(env.state, env.reportFile, "all good");
		assert.equal(env.state.phase, "done");
		assert.match(res.message, /Workflow complete/);
	} finally {
		env.cleanup();
	}
});

test("report-only review cannot create repair tasks", () => {
	const s = approvedReviewState();
	s.phase = "consolidate";
	assert.throws(() => backToAct(s, "fix reviewed code"), /report-only/);
});

test("back_to_act creates a concrete repair task", () => {
	const s = approvedPlanState();
	taskStart(s);
	taskDone(s, 1, [{ name: "unit", result: "pass" }]);
	s.phase = "consolidate";
	const res = backToAct(s, "greet is missing a null guard");
	assert.equal(s.phase, "act");
	const repair = s.tasks[s.tasks.length - 1]!;
	assert.match(repair.title, /^Repair: greet is missing a null guard/);
	assert.equal(repair.status, "pending");
	assert.equal(s.approvals.plan, true); // act still allowed
	// /rpac act can now start it
	taskStart(s, repair.id);
	assert.equal(repair.status, "in_progress");
	assert.match(res.message, /Repair task/);
	assert.throws(() => backToAct(s, "again"), (e: Error) => /not available in phase "act"/.test(e.message));
});

test("back_to_plan preserves completed evidence through revised plan registration", () => {
	const s = approvedPlanState();
	const dir = makeTempDir();
	const revisedPlan = join(dir, "plan.md");
	try {
		taskStart(s);
		taskDone(s, 1, [{ name: "unit", result: "pass" }]);
		s.phase = "consolidate";
		backToPlan(s, "the plan split the tasks wrong");
		assert.equal(s.phase, "plan");
		assert.equal(s.approvals.plan, false);
		assert.equal(s.artifacts.plan, undefined, "superseded plan cannot be re-approved without finalization");
		assert.equal(s.tasks[0]!.status, "done");
		assert.equal(s.tasks[0]!.verification?.length, 1);
		assert.equal(s.tasks[1]!.status, "pending");
		assert.throws(() => approvePlan(s), (e: Error) => /finalized plan artifact/.test(e.message));
		assert.throws(() => taskStart(s), (e: Error) => /not available in phase "plan"/.test(e.message));

		writeFileSync(revisedPlan, PLAN_BODY + "\n- [ ] 3. Add regression coverage\n", "utf8");
		planComplete(s, revisedPlan, [{ title: "Implement revised greeting" }, { title: "Add regression coverage", dependsOn: [1] }]);
		assert.equal(s.tasks.every((t) => t.status === "pending"), true, "revised plan starts conservatively");
		assert.equal(s.taskHistory.length, 1, "superseded completed evidence archived");
		assert.equal(s.taskHistory[0]!.verification?.[0]?.result, "pass");
		approvePlan(s);
	} finally {
		removeTree(dir);
	}
});

test("abort is safe and terminal; approveSequential is idempotent", () => {
	const s = approvedPlanState();
	const res = abort(s, "user changed their mind");
	assert.equal(s.phase, "aborted");
	assert.match(res.message, /aborted/);
	assert.throws(() => taskStart(s), (e: Error) => /not available in phase/.test(e.message));
	const s2 = approvedPlanState();
	approveSequential(s2);
	const again = approveSequential(s2);
	assert.match(again.message, /approved/);
});

test("checkpoints and events are bounded", () => {
	const s = approvedPlanState();
	for (let i = 0; i < 150; i++) {
		s.checkpoints.push({ at: `t${i}`, what: `cp ${i}` });
		s.events.push({ at: `t${i}`, kind: "e", detail: `event ${i}` });
	}
	capStateArrays(s);
	assert.ok(s.checkpoints.length <= 100);
	assert.ok(s.events.length <= 50);
});
