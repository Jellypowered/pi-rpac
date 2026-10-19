import { test } from "node:test";
import assert from "node:assert/strict";
import {
	RPAC_STATE_VERSION,
	RPAC_PREVIEW_STATE_VERSION,
	TASK_STATUSES,
	RpacStateError,
	validateState,
	validateIndex,
	newState,
	isSubstantive,
	validateTaskGraph,
	newReviewState,
} from "../../lib/schema.ts";

const PROJECT = "/tmp/project";

function base(raw: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: RPAC_STATE_VERSION,
		id: "w-abc12345",
		project: PROJECT,
		task: "add a thing",
		phase: "refine",
		paused: false,
		approvals: { requirements: false, plan: false, sequential: false },
		tasks: [],
		artifacts: {},
		checkpoints: [],
		events: [],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...raw,
	};
}

test("validateState accepts the current version and defaults legacy workflow kind", () => {
	const s = validateState(base(), PROJECT);
	assert.equal(s.id, "w-abc12345");
	assert.equal(s.project, PROJECT);
	assert.equal(s.phase, "refine");
	assert.equal(s.workflowKind, "implementation");
});

test("validateState accepts versions 1 and 2 for migration and bumps them", () => {
	for (const version of [1, 2]) {
		const s = validateState(base({ version }), PROJECT);
		assert.equal(s.version, RPAC_STATE_VERSION);
		assert.equal(s.workflowKind, "implementation");
	}
});

test("validateState rejects unsupported future versions without touching data", () => {
	assert.throws(
		() => validateState(base({ version: RPAC_PREVIEW_STATE_VERSION + 1 })),
		(e: Error) => e instanceof RpacStateError && e.code === "unsupported_version" && /newer/.test(e.message),
	);
});

test("validateState rejects unknown versions", () => {
	assert.throws(() => validateState(base({ version: 42 })), (e: Error) => e instanceof RpacStateError && e.code === "unsupported_version");
});

test("validateState enforces the project binding", () => {
	assert.throws(() => validateState(base(), "/other/project"), (e: Error) => e instanceof RpacStateError && e.code === "wrong_project");
});

test("validateState rejects corrupt shapes", () => {
	assert.throws(() => validateState("nope" as never), (e: Error) => e instanceof RpacStateError && e.code === "corrupt");
	assert.throws(() => validateState(base({ phase: "bogus" })), (e: Error) => e instanceof RpacStateError && /invalid phase/.test(e.message));
	assert.throws(() => validateState(base({ id: "" })), (e: Error) => e instanceof RpacStateError && /missing workflow id/.test(e.message));
	assert.throws(() => validateState(base({ workflowKind: "unknown" })), /invalid workflow kind/);
	assert.throws(() => validateState(base({ workflowKind: "review" })), /missing a valid review mode\/state/);
	assert.throws(() => validateState(base({ review: {} })), /must not contain review state/);
});

test("task statuses include the explicit outcomes", () => {
	assert.deepEqual([...TASK_STATUSES], ["pending", "in_progress", "done", "blocked", "failed", "interrupted"]);
});

test("validateState round-trips all task statuses and recorded evidence", () => {
	const s = validateState(
		base({
			tasks: [
				{
					id: 1,
					title: "a",
					status: "done",
					doneAt: "2026-01-02T00:00:00Z",
					verification: [{ name: "lint", kind: "observation", result: "fail" }, { name: "report", kind: "acceptance", result: "pass" }],
					deliverables: [{ path: "review.md", sha256: "ab".repeat(32), updatedAt: "2026-01-02T00:00:00Z" }],
				},
				{ id: 2, title: "b", status: "failed", issues: ["check x failed"] },
				{ id: 3, title: "c", status: "interrupted" },
				{ id: 4, title: "d", status: "blocked" },
				{ id: 5, title: "e", status: "pending", dependsOn: [1] },
				{ id: 6, title: "f", status: "done", acceptedException: "user accepted flaky e2e" },
			],
			taskHistory: [
				{
					id: 1,
					title: "superseded task",
					status: "done",
					doneAt: "2026-01-02T00:00:00Z",
					verification: [{ name: "old unit", result: "pass" }],
					supersededAt: "2026-01-03T00:00:00Z",
					reason: "plan superseded after back_to_plan",
				},
			],
		}),
		PROJECT,
	);
	assert.equal(s.tasks.length, 6);
	assert.equal(s.tasks[0]!.verification?.[0]?.kind, "observation");
	assert.equal(s.tasks[0]!.deliverables?.[0]?.path, "review.md");
	assert.equal(s.tasks[1]!.status, "failed");
	assert.equal(s.tasks[2]!.status, "interrupted");
	assert.equal(s.tasks[5]!.acceptedException, "user accepted flaky e2e");
	assert.equal(s.taskHistory[0]!.verification?.[0]?.result, "pass");
	assert.equal(s.taskHistory[0]!.reason, "plan superseded after back_to_plan");
});

test("isSubstantive rejects stubs and accepts real documents", () => {
	assert.equal(isSubstantive("# Requirements\n- one line\n"), false);
	assert.equal(isSubstantive("x".repeat(80)), false); // 80 chars, 1 line
	assert.equal(isSubstantive(""), false);
	assert.equal(
		isSubstantive(
			"# Requirements\n## Context\nThe app needs a greeting function that returns a friendly string for any name given.\n## Acceptance\n- greet returns Hello, name",
		),
		true,
	);
});

test("validateTaskGraph accepts a valid DAG", () => {
	validateTaskGraph([undefined, [1], [1, 2]], 3);
});

test("validateTaskGraph rejects unknown references", () => {
	assert.throws(() => validateTaskGraph([[9], undefined], 2), /unknown task 9/);
	assert.throws(() => validateTaskGraph([[0]], 1), /unknown task 0/);
});

test("validateTaskGraph rejects self references", () => {
	assert.throws(() => validateTaskGraph([[1]], 1), /depends on itself/);
});

test("validateTaskGraph rejects cycles", () => {
	assert.throws(() => validateTaskGraph([[2], [1]], 2), /cycle/);
	assert.throws(() => validateTaskGraph([[2], [3], [1]], 3), /cycle/);
	assert.throws(() => validateTaskGraph([[2], [3], [4], [2]], 4), /cycle/);
});

test("validateIndex parses and normalizes an index", () => {
	const idx = validateIndex({
		version: RPAC_STATE_VERSION,
		active: "w-1",
		workflows: {
			"w-1": { id: "w-1", task: "t", phase: "act", updatedAt: "2026-01-01T00:00:00Z" },
			"junk": "not-an-object",
		},
	});
	assert.equal(idx.active, "w-1");
	assert.deepEqual(Object.keys(idx.workflows), ["w-1"]);
	assert.equal(idx.workflows["w-1"]!.workflowKind, "implementation");
});

test("validateIndex migrates v2 and rejects an unknown version", () => {
	assert.equal(validateIndex({ version: 2, active: null, workflows: {} }).version, RPAC_STATE_VERSION);
	assert.throws(() => validateIndex({ version: 9, active: null, workflows: {} }), (e: Error) => e instanceof RpacStateError);
});

test("newState creates a fresh current-version workflow bound to the project", () => {
	const s = newState(PROJECT, "do a thing");
	assert.equal(s.version, RPAC_STATE_VERSION);
	assert.equal(s.project, PROJECT);
	assert.equal(s.phase, "refine");
	assert.equal(s.workflowKind, "implementation");
	assert.match(s.id, /^w-[0-9a-f]{8}$/);
});

test("newReviewState round-trips snapshot and coverage metadata", () => {
	const state = newReviewState(PROJECT, {
		mode: "staged",
		fingerprint: "cd".repeat(32),
		manifestSha256: "ab".repeat(32),
		head: "unborn",
		unborn: true,
		capturedAt: "2026-01-01T00:00:00Z",
		scopeItemIds: ["ri-a", "ri-b", "ri-a"],
		exclusions: [{ path: "old-review.md", reason: "prior report" }],
	});
	const loaded = validateState(JSON.parse(JSON.stringify(state)), PROJECT);
	assert.equal(loaded.workflowKind, "review");
	assert.equal(loaded.review?.mode, "staged");
	assert.deepEqual(loaded.review?.scopeItemIds, ["ri-a", "ri-b"]);
	assert.equal(loaded.artifacts.reviewManifest?.sha256, "ab".repeat(32));
	assert.match(loaded.artifacts.reviewManifest?.path ?? "", new RegExp(`\\.pi/rpac/${state.id}/review-manifest\\.json$`));
});
