import { test } from "node:test";
import assert from "node:assert/strict";
import { phaseContext } from "../../lib/prompts.ts";
import { newReviewState } from "../../lib/schema.ts";

const root = "/tmp/rpac-guidance";

test("live review guidance permits only a verified, owned sequential transition", () => {
	const state = newReviewState(root, { mode: "current", fingerprint: "a".repeat(64), manifestSha256: "b".repeat(64), head: "", unborn: true, capturedAt: "2026-01-01T00:00:00Z", scopeItemIds: [] });
	state.phase = "act";
	state.approvals.sequential = true;
	state.tasks = [{ id: 1, title: "First batch", status: "done" }, { id: 2, title: "Second batch", status: "pending", dependsOn: [1] }];
	assert.match(phaseContext(state, root, true, 1)!, /task_start with task "next" BEFORE inspecting/);
	assert.match(phaseContext(state, root, false, 1)!, /Stop task work/);
	state.tasks[0].status = "failed";
	assert.match(phaseContext(state, root, true, 1)!, /Stop task work/);
	assert.doesNotMatch(phaseContext(state, root, true, 1)!, /task_start with task "next" BEFORE/);
	state.tasks[0].status = "done";
	state.tasks[1].status = "blocked";
	assert.match(phaseContext(state, root, true, 1)!, /Stop task work/);
	state.tasks[1].status = "done";
	assert.match(phaseContext(state, root, true, 2)!, /All tasks are finished.*\/rpac consolidate/);
	assert.doesNotMatch(phaseContext(state, root, true, 2)!, /task_start with task "next" BEFORE/);
});
