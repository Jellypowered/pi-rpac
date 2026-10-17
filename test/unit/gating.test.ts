import { test } from "node:test";
import assert from "node:assert/strict";
import {
	isApprovedReviewCheck,
	isReadOnlyCommand,
	gateToolCall,
	gateUnreadableState,
	allowedArtifactForPhase,
	pathIsExactly,
	resolveTarget,
} from "../../lib/gating.ts";
import { newReviewState, newState, type RpacState } from "../../lib/schema.ts";
import { reviewBatchFile, reviewReportFile } from "../../lib/paths.ts";
import { join } from "node:path";

const ROOT = "/work/proj";
const WF = "w-abc12345";
const REQ = join(ROOT, ".pi", "rpac", WF, "requirements.md");
const PLAN = join(ROOT, ".pi", "rpac", WF, "plan.md");
const APP = join(ROOT, "src", "app.ts");

function state(phase: "refine" | "plan" | "act" | "consolidate"): RpacState {
	const s = newState(ROOT, "demo");
	s.id = WF;
	s.phase = phase;
	return s;
}

function reviewState(phase: "refine" | "plan" | "act" | "consolidate"): RpacState {
	const s = newReviewState(ROOT, {
		mode: "current",
		fingerprint: "ab".repeat(32),
		manifestSha256: "cd".repeat(32),
		head: "1".repeat(40),
		unborn: false,
		capturedAt: "2026-01-01T00:00:00Z",
		scopeItemIds: ["ri-a"],
	});
	s.id = WF;
	s.phase = phase;
	s.tasks = [{ id: 1, title: "review batch", status: "in_progress", reviewItemIds: ["ri-a"] }];
	s.review!.approvedChecks = ["npm test", "rm -rf src"];
	s.approvals.plan = true;
	return s;
}

test("allowedArtifactForPhase maps refine→requirements, plan→plan, nothing else", () => {
	assert.equal(allowedArtifactForPhase(ROOT, WF, "refine"), REQ);
	assert.equal(allowedArtifactForPhase(ROOT, WF, "plan"), PLAN);
	assert.equal(allowedArtifactForPhase(ROOT, WF, "act"), null);
	assert.equal(allowedArtifactForPhase(ROOT, WF, "consolidate"), null);
});

// --- write/edit gating ------------------------------------------------------

test("REFINE: writing the requirements artifact (absolute or cwd-relative) is allowed", () => {
	const s = state("refine");
	assert.equal(gateToolCall(s, ROOT, "write", { path: REQ, content: "x" }, ROOT), null);
	assert.equal(gateToolCall(s, ROOT, "write", { path: `.pi/rpac/${WF}/requirements.md`, content: "x" }, ROOT), null);
	// from a subdirectory cwd, the root-relative path still resolves to the artifact
	const sub = join(ROOT, "sub");
	assert.equal(gateToolCall(s, sub, "write", { path: join(ROOT, "sub", "..", ".pi", "rpac", WF, "requirements.md"), content: "x" }, ROOT), null);
});

test("REFINE: writing the plan artifact is blocked (only requirements allowed)", () => {
	const s = state("refine");
	const d = gateToolCall(s, ROOT, "write", { path: PLAN, content: "x" }, ROOT);
	assert.ok(d?.block);
	assert.match(d!.reason, /read-only/);
});

test("REFINE/PLAN: application write and edit are blocked", () => {
	for (const phase of ["refine", "plan"] as const) {
		const s = state(phase);
		assert.ok(gateToolCall(s, ROOT, "write", { path: APP, content: "x" }, ROOT)?.block, `${phase} write blocked`);
		assert.ok(gateToolCall(s, ROOT, "edit", { path: APP, edits: [] }, ROOT)?.block, `${phase} edit blocked`);
		// the RPAC state index itself is not writable either (exact-allowlist, not a dir prefix)
		assert.ok(gateToolCall(s, ROOT, "write", { path: join(ROOT, ".pi", "rpac", "state.json"), content: "x" }, ROOT)?.block);
		assert.ok(gateToolCall(s, ROOT, "write", { path: join(ROOT, ".pi", "rpac", WF, "log.md"), content: "x" }, ROOT)?.block, "log.md is not a model-writable artifact");
	}
});

test("PLAN: writing the plan artifact is allowed, requirements is not", () => {
	const s = state("plan");
	assert.equal(gateToolCall(s, ROOT, "write", { path: PLAN, content: "x" }, ROOT), null);
	assert.ok(gateToolCall(s, ROOT, "edit", { path: REQ, edits: [] }, ROOT)?.block);
});

test("review workflows allow only their exact phase artifact in every phase", () => {
	const cases = [
		["refine", REQ],
		["plan", PLAN],
		["act", reviewBatchFile(ROOT, WF, 1)],
		["consolidate", reviewReportFile(ROOT, WF)],
	] as const;
	for (const [phase, allowed] of cases) {
		const s = reviewState(phase);
		assert.equal(gateToolCall(s, ROOT, "write", { path: allowed, content: "evidence" }, ROOT), null, `${phase} artifact allowed`);
		assert.ok(gateToolCall(s, ROOT, "write", { path: APP, content: "x" }, ROOT)?.block, `${phase} source blocked`);
		assert.ok(gateToolCall(s, ROOT, "write", { path: join(ROOT, "..", "sibling", "x"), content: "x" }, ROOT)?.block, `${phase} sibling blocked`);
	}
	const act = reviewState("act");
	assert.ok(gateToolCall(act, ROOT, "write", { path: reviewBatchFile(ROOT, WF, 2), content: "wrong" }, ROOT)?.block);
});

test("review shell allows reads and exact approved non-destructive checks only", () => {
	const act = reviewState("act");
	assert.equal(gateToolCall(act, ROOT, "bash", { command: "git status" }, ROOT), null);
	assert.equal(isApprovedReviewCheck(act, "npm test"), true);
	assert.equal(gateToolCall(act, ROOT, "bash", { command: "npm test" }, ROOT), null);
	assert.ok(gateToolCall(act, ROOT, "bash", { command: "npm run other" }, ROOT)?.block);
	assert.equal(isApprovedReviewCheck(act, "rm -rf src"), false, "denylist wins over plan approval");
	assert.ok(gateToolCall(act, ROOT, "bash", { command: "rm -rf src" }, ROOT)?.block);
	assert.ok(gateToolCall(reviewState("plan"), ROOT, "bash", { command: "npm test" }, ROOT)?.block, "checks wait for ACT");
	assert.ok(gateToolCall(act, ROOT, "custom_mutator", {}, ROOT)?.block);
});

test("ACT/CONSOLIDATE: no gating at all (normal implementation workflow permissions apply)", () => {
	for (const phase of ["act", "consolidate"] as const) {
		const s = state(phase);
		assert.equal(gateToolCall(s, ROOT, "write", { path: APP, content: "x" }, ROOT), null);
		assert.equal(gateToolCall(s, ROOT, "bash", { command: "git commit -m x" }, ROOT), null);
	}
});

test("explicitly read-only tools pass through; unknown custom tools fail closed", () => {
	for (const tool of ["read", "grep", "find", "ls", "codemode", "ask_user_question"]) {
		assert.equal(gateToolCall(state("refine"), ROOT, tool, { path: APP }, ROOT), null, `${tool} unblocked`);
	}
	assert.ok(gateToolCall(state("refine"), ROOT, "custom_mutator", { path: APP }, ROOT)?.block);
});

test("the rpac tool itself is never gated", () => {
	assert.equal(gateToolCall(state("refine"), ROOT, "rpac", { action: "refine_complete" }, ROOT), null);
});

test("unreadable RPAC state fails closed for mutation tools", () => {
	assert.ok(gateUnreadableState("write")?.block);
	assert.ok(gateUnreadableState("bash")?.block);
	assert.ok(gateUnreadableState("custom_mutator")?.block);
	assert.equal(gateUnreadableState("read"), null);
	assert.equal(gateUnreadableState("rpac"), null);
});

// --- bash fail-closed read-only policy ---------------------------------------

const SAFE: [string, string][] = [
	["simple read", "cat src/app.ts"],
	["grep", "grep -r todo src/"],
	["ls", "ls -la"],
	["find", "find . -name '*.ts'"],
	["git status", "git status"],
	["git diff", "git diff HEAD"],
	["git log", "git log --oneline -5"],
	["git rev-parse", "git rev-parse --short HEAD"],
	["git cwd status", "git -C /work/proj status"],
	["git cwd log", "git -C /work/proj log --oneline -10"],
	["git merge base", "git merge-base HEAD main"],
	["git branch list all", "git branch -a"],
	["git branch verbose", "git branch -vv"],
	["git config read", "git config --get remote.origin.url"],
	["git check-ignore", "git check-ignore renderer/styles/output.css"],
	["git stash list", "git -C /work/proj stash list"],
	["quoted grep alternation", "grep -rn \"one\\|two\" src"],
	["quoted append operators", "grep -rn \"guid <<\\|guid >>\\|guid &\\|& 0x\" src"],
	["single-quoted redirection text", "grep 'literal > and >> text' src/app.ts"],
	["escaped redirection text", "printf \\>"],
	["stderr to dev null", "find . -name '*.ts' 2>/dev/null"],
	["fd redirection", "git show HEAD 2>&1 | head"],
	["change directory", "cd /work/proj && git status"],
	["piped reads", "ls | grep foo | wc -l"],
	["compound reads", "git status && git diff"],
	["node --version", "node --version"],
	["node -v", "node -v"],
	["printenv", "printenv PATH"],
];

const BLOCKED: [string, string][] = [
	["git commit", "git commit -m msg"],
	["git add", "git add -A"],
	["git push", "git push origin main"],
	["git checkout", "git checkout main"],
	["git cwd checkout", "git -C /work/proj checkout main"],
	["git stash push", "git stash push -m save"],
	["git stash pop", "git stash pop"],
	["git stash drop", "git stash drop stash@{0}"],
	["git stash clear", "git stash clear"],
	["git stash list options stay fail-closed", "git stash list --format=%gd"],
	["git config write", "git config user.name attacker"],
	["redirect", "echo hi > out.txt"],
	["redirect after quoted text", "grep 'literal > text' file > out.txt"],
	["redirect under tmp", "ls > /tmp/out.txt"],
	["dev-null prefix is not suppression", "ls > /dev/null.log"],
	["dev-null traversal is not suppression", "ls > /dev/null/../output"],
	["append redirect", "echo hi >> log.txt"],
	["stderr redirect to file", "grep foo file 2>/tmp/errors"],
	["combined redirect to file", "grep foo file &>output.txt"],
	["rm", "rm -rf build"],
	["mv", "mv a b"],
	["cp", "cp a b"],
	["touch", "touch newfile"],
	["mkdir", "mkdir foo"],
	["sed -i", "sed -i 's/a/b/' f.txt"],
	["npm install", "npm install lodash"],
	["pip install", "pip install requests"],
	["sudo", "sudo apt-get update"],
	["unknown command (fail-closed)", "frobnicate --all"],
	["node eval stays blocked", "node -e 'console.log(1)'"],
	["node version with extra args", "node -v -e 'console.log(1)'"],
	["node mutating", "node -e 'require(\"fs\").writeFileSync(\"x\",\"y\")'"],
	["pipe to tee", "cat a | tee b"],
	["curl -o", "curl -o out.html https://x"],
	["curl POST", "curl -X POST https://x"],
	["find delete", "find . -name '*.tmp' -delete"],
	["find exec", "find . -exec touch marker {} ;"],
	["env launches command", "env sh -c 'touch marker'"],
	["awk system", "awk 'BEGIN { system(\"touch marker\") }'"],
	["sort output", "sort -o out.txt in.txt"],
	["git diff output", "git diff --output=changes.txt"],
	["git remote add", "git remote add backup https://example.invalid/repo"],
	["date set", "date --set tomorrow"],
	["file compile", "file --compile magic"],
	["npm list disallowed", "npm list"],
	["sed disallowed", "sed -n '1,10p' file.txt"],
	["substitution write", "echo $(date) > stamp.txt"],
	["double-quoted substitution", "echo \"$(touch marker)\""],
	["process substitution", "cat <(python -c 'open(\"x\",\"w\")')"],
];

test("bash policy: safe read-only commands are allowed", () => {
	for (const [label, cmd] of SAFE) {
		assert.equal(isReadOnlyCommand(cmd), true, `${label}: ${cmd}`);
	}
});

test("bash policy: mutating commands are blocked (fail-closed)", () => {
	for (const [label, cmd] of BLOCKED) {
		assert.equal(isReadOnlyCommand(cmd), false, `${label}: ${cmd}`);
	}
});

test("gate blocks mutating bash in refine/plan and allows read-only bash", () => {
	const s = state("refine");
	assert.ok(gateToolCall(s, ROOT, "bash", { command: "git commit -m x" }, ROOT)?.block);
	assert.equal(gateToolCall(s, ROOT, "bash", { command: "git status" }, ROOT), null);
	const s2 = state("plan");
	assert.ok(gateToolCall(s2, ROOT, "bash", { command: "echo hi > out.txt" }, ROOT)?.block);
});

test("shell denials identify the first rejected segment and rejection class", () => {
	const s = state("refine");
	const unknown = gateToolCall(s, ROOT, "bash", { command: "git status && rg -n todo src" }, ROOT);
	assert.match(unknown!.reason, /not on the read-only allowlist: rg -n todo src/);
	assert.match(unknown!.reason, /every segment of a compound command must qualify/);

	const redirected = gateToolCall(s, ROOT, "bash", { command: "grep todo src > findings.txt" }, ROOT);
	assert.match(redirected!.reason, /output redirection is not read-only/);

	const mutation = gateToolCall(s, ROOT, "bash", { command: "git status && git push" }, ROOT);
	assert.match(mutation!.reason, /blocked mutating operation.*git push/);

	const substitution = gateToolCall(s, ROOT, "bash", { command: "echo \"$(touch marker)\"" }, ROOT);
	assert.match(substitution!.reason, /unsupported shell syntax/);
});

test("review denial explains exact approved-check matching", () => {
	const act = reviewState("act");
	const decision = gateToolCall(act, ROOT, "bash", { command: "cd /work/proj && npm test" }, ROOT);
	assert.ok(decision?.block);
	assert.match(decision.reason, /not on the read-only allowlist: npm test/);
	assert.match(decision.reason, /Run approved checks exactly as recorded/);
});

// --- path resolution helpers --------------------------------------------------

test("pathIsExactly resolves cwd-relative and absolute targets to exactly the artifact", () => {
	assert.equal(pathIsExactly(ROOT, REQ, REQ), true);
	assert.equal(pathIsExactly(ROOT, `.pi/rpac/${WF}/requirements.md`, REQ), true);
	assert.equal(pathIsExactly(ROOT, `.pi/rpac/${WF}/requirements.md.bak`, REQ), false);
	assert.equal(pathIsExactly(ROOT, join(ROOT, ".pi", "rpac", WF, "..", "state.json"), REQ), false);
});

test("resolveTarget normalizes traversal", () => {
	assert.equal(resolveTarget(ROOT, join(ROOT, "sub", "..", "src", "app.ts")), APP);
});
