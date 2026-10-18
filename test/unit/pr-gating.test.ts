import { test } from "node:test";
import assert from "node:assert/strict";
import { gateToolCall, isApprovedReviewCheck, prCheckPrefix } from "../../lib/gating.ts";
import { newReviewState, validateState } from "../../lib/schema.ts";
import { buildPrMeta, resolvePrMeta, prRestoreCommand } from "../../lib/pr.ts";

function state() {
 const root = "/work/original";
 const pr = buildPrMeta(resolvePrMeta({ number: 1, url: "https://github.com/acme/widget/pull/1", title: "test", body: "", state: "OPEN", baseRefName: "main", headRefName: "topic", baseRefOid: "a".repeat(40), headRefOid: "b".repeat(40) }),
  { strategy: "worktree", location: "/work/isolated", head: "b".repeat(40), output: "" }, { branch: "main", head: "a".repeat(40), dirty: ["local"] });
 const s = newReviewState(root, { mode: "pr", fingerprint: "c".repeat(64), manifestSha256: "d".repeat(64), head: pr.headSha, unborn: false, capturedAt: "2026-01-01T00:00:00Z", scopeItemIds: ["ri-a"], pr });
 s.phase = "act"; s.approvals.plan = true;
 s.tasks = [{ id: 1, title: "review", status: "in_progress", reviewItemIds: ["ri-a"] }];
 return s;
}

test("legacy unqualified approved PR checks are blocked instead of testing the original checkout", () => {
 const s = state(); s.review!.approvedChecks = ["npm test", "node --version"];
 for (const command of s.review!.approvedChecks) {
  assert.ok(gateToolCall(s, s.project, "bash", { command }, s.project)?.block);
  assert.equal(isApprovedReviewCheck(s, command), false);
 }
});

test("PR checks require exact approved directory prefix; suffixes and directory escapes stay blocked", () => {
 const s = state(); const check = `${prCheckPrefix(s.review!.pr!.checkoutLocation)}npm test`;
 s.review!.approvedChecks = [check];
 assert.equal(gateToolCall(s, s.project, "bash", { command: check }, s.project), null);
 for (const command of ["npm test", `${prCheckPrefix(s.project)}npm test`, `${check} --extra`, `${check} && npm test`]) {
  assert.ok(gateToolCall(s, s.project, "bash", { command }, s.project)?.block);
 }
 assert.ok(gateToolCall(s, s.project, "powershell", { command: check }, s.project)?.block);
 const escape = `${prCheckPrefix(s.review!.pr!.checkoutLocation)}cd .. && npm test`;
 s.review!.approvedChecks = [escape];
 assert.equal(isApprovedReviewCheck(s, escape), false);
 assert.equal(prCheckPrefix("/tmp/it's here"), "cd -- '/tmp/it'\\''s here' && ");
});

test("plan approval never authorizes GitHub publication or direct Git state mutations", () => {
 const s = state();
 for (const op of ["gh pr merge 1", "gh pr review 1 --approve", "gh api --method POST repos/acme/widget/issues/1/comments", "git fetch origin", "git update-ref refs/heads/main HEAD", "git update-index --chmod=+x app", "git --git-dir=/work/original/.git update-ref refs/heads/main HEAD", "git -c alias.publish=push publish origin HEAD"]) {
  const command = `${prCheckPrefix(s.review!.pr!.checkoutLocation)}${op}`;
  s.review!.approvedChecks = [command];
  assert.equal(isApprovedReviewCheck(s, command), false, op);
  assert.ok(gateToolCall(s, s.project, "bash", { command }, s.project)?.block, op);
 }
});

test("PR restore hints safely support detached HEAD and shell-special branch names", () => {
 assert.equal(prRestoreCommand({ originalBranch: "", originalHead: "a".repeat(40) }), `git switch --detach '${"a".repeat(40)}'`);
 assert.equal(prRestoreCommand({ originalBranch: "it's-a-branch", originalHead: "a".repeat(40) }), "git switch -- 'it'\\''s-a-branch'");
});

test("PR state round-trips and rejects mode/identity inconsistencies and unsafe PR numbers", () => {
 const s = state(); assert.equal(validateState(JSON.parse(JSON.stringify(s))).review!.pr!.headSha, s.review!.pr!.headSha);
 for (const mutate of [
  (x: any) => { x.review.mode = "current"; },
  (x: any) => { delete x.review.pr; },
  (x: any) => { x.review.head = "e".repeat(40); },
  (x: any) => { x.review.pr.crossRepository = "false"; },
  (x: any) => { x.review.pr.number = Number.MAX_SAFE_INTEGER + 1; },
 ]) {
  const raw = JSON.parse(JSON.stringify(s)); mutate(raw); assert.throws(() => validateState(raw));
 }
});
