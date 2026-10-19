import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReviewAssignments } from "../../lib/review-plan.ts";

const a = "ri-" + "a".repeat(20), b = "ri-" + "b".repeat(20);
const tasks = [{ title: "First batch", reviewItemIds: [a] }, { title: "Second batch", reviewItemIds: [b] }];
test("written assignments agree with registered IDs in common task formats", () => {
	validateReviewAssignments(`## Tasks\n### Task 1 — First\n- reviewItemIds: \`${a}\`\n\n### Task 2 — Second\nAssigned manifest items (1):\n- \`${b}\` — source.ts\n\n`, tasks);
	validateReviewAssignments("# Legacy plan\n## Tasks\n- [ ] Inspect files\n", tasks);
});
test("replay wowmin mismatch: a plan cannot swap registered task assignments before approval", () => {
	assert.throws(() => validateReviewAssignments(`### 1. First\nAssigned manifest items (1):\n- ${b} — test-triangle-grid.cjs\n\n### 2. Second\n- reviewItemIds: ${a}\n`, tasks), /task 1 assigns different manifest items/);
});
test("unknown assignment headings fail rather than being silently accepted", () => {
	assert.throws(() => validateReviewAssignments(`### Task 9 — Unexpected\n- reviewItemIds: ${a}\n`, tasks), /task 9/);
});
