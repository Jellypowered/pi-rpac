import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newReviewState, validateState, RPAC_PREVIEW_STATE_VERSION, type PrReviewMeta } from "../../lib/schema.ts";
import { prepareHostExecution, parseHostExecution, executionDigest, assertHostApproval, assertScreeningCurrent, generatedPath, hostApprovalText, unexecutedHostChecks, requireRuntimeEvidence, type ExecutionInput } from "../../lib/execution.ts";
import { hostCommandIssue, prCheckPrefix } from "../../lib/gating.ts";
import { cleanPrStatus } from "../../lib/pr.ts";
import { makeTempDir, removeTree, sha256File } from "../../lib/util.ts";

function fixture(run: (root: string, state: ReturnType<typeof newReviewState>, input: ExecutionInput, checks: string[]) => void) {
	const root = makeTempDir("rpac-execution-");
	try {
		const checkout = join(root, "checkout"); mkdirSync(checkout);
		writeFileSync(join(checkout, "package.json"), JSON.stringify({ scripts: { test: "node verify.cjs" } }));
		writeFileSync(join(checkout, "package-lock.json"), "{}\n");
		writeFileSync(join(checkout, "verify.cjs"), "console.log('fixture check');\n");
		writeFileSync(join(root, "plan.md"), "# Plan\nReviewed checks and risks are documented here.\n");
		const pr: PrReviewMeta = { number: 7, url: "https://github.com/example/project/pull/7", title: "Fixture", body: "", repository: "example/project", state: "open", crossRepository: false, baseRef: "main", baseSha: "a".repeat(40), headRef: "feature", headSha: "b".repeat(40), originalBranch: "main", originalHead: "a".repeat(40), originalDirty: [], checkoutStrategy: "worktree", checkoutLocation: checkout, checkedOutAt: "2026-01-01T00:00:00Z" };
		const state = newReviewState(root, { mode: "pr", fingerprint: "c".repeat(64), manifestSha256: "d".repeat(64), head: pr.headSha, unborn: false, capturedAt: pr.checkedOutAt, scopeItemIds: [], pr });
		state.phase = "plan"; state.approvals.requirements = true; state.approvals.plan = true;
		state.version = RPAC_PREVIEW_STATE_VERSION;
		state.artifacts.plan = { path: "plan.md", sha256: sha256File(join(root, "plan.md")) };
		const prefix = prCheckPrefix(checkout), checks = [`${prefix}npm test`]; state.review!.approvedChecks = checks;
		const input: ExecutionInput = { setupCommands: [`${prefix}npm ci --ignore-scripts --no-audit --no-fund`], generatedPaths: ["node_modules/", "dist/"], screening: { summary: "Reviewed package scripts, the lockfile and verify.cjs. The fixture only prints a message, but downloaded dependency code has not been exhaustively inspected and host execution is not a sandbox.", files: ["package.json", "package-lock.json", "verify.cjs"], risks: ["Dependencies and scripts may access host files, credentials and network."], recommendation: "run" } };
		run(root, state, input, checks);
	} finally { removeTree(root); }
}

test("screening is bounded declarative evidence, not user approval; state round-trips", () => fixture((root, state, input, checks) => {
	state.review!.execution = prepareHostExecution(state, checks, input);
	assert.throws(() => assertHostApproval(root, state), /user must run \/rpac approve execution/);
	const execution = state.review!.execution;
	assert.ok(execution.screening!.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
	assert.deepEqual(validateState(state, root).review!.execution, execution);
	assert.equal(validateState(state, root).version, 4);
	assert.throws(() => validateState({ ...state, version: 3 }, root), /requires workflow version 4/);
	assert.throws(() => validateState({ ...state, version: 5 }, root), /newer than/);
	const explanation = hostApprovalText(state);
	for (const pattern of [/NOT a sandbox/, /NOT proof of safety/, /credentials/, /networking is NOT mechanically restricted/, /npm ci/, /npm test/]) assert.match(explanation, pattern);
	state.review!.execution.approval = { at: "2026-01-01T00:00:00Z", digest: executionDigest(state) };
	assert.doesNotThrow(() => assertHostApproval(root, state));
	assert.deepEqual(unexecutedHostChecks(state), checks);
	assert.throws(() => requireRuntimeEvidence(state, [{ name: checks[0], kind: "observation", result: "pass", detail: "deferred to later" }]), /do not report a planned\/deferred test as pass/);
	assert.doesNotThrow(() => requireRuntimeEvidence(state, [{ name: checks[0], kind: "observation", result: "unavailable", detail: "User did not authorize host execution; these tests were not run." }]));
}));

test("approval is bound to source bytes, plan, commands, outputs and scope", () => fixture((root, state, input, checks) => {
	state.review!.execution = prepareHostExecution(state, checks, input);
	state.review!.execution.approval = { at: "2026-01-01T00:00:00Z", digest: executionDigest(state) };
	const pristine = structuredClone(state);
	for (const mutate of [
		(s: typeof state) => { s.review!.fingerprint = "e".repeat(64); },
		(s: typeof state) => { s.review!.approvedChecks = [checks[0] + " --silent"]; },
		(s: typeof state) => { s.review!.execution!.generatedPaths.push("coverage/"); },
		(s: typeof state) => { s.review!.execution!.screening!.summary += " changed"; },
		(s: typeof state) => { s.review!.pr!.headSha = "f".repeat(40); },
	]) { const changed = structuredClone(pristine); mutate(changed); assert.throws(() => assertHostApproval(root, changed), /not been approved/); }
	writeFileSync(join(state.review!.pr!.checkoutLocation, "verify.cjs"), "changed code\n");
	assert.throws(() => assertHostApproval(root, state), /Screened file changed/);
	writeFileSync(join(root, "plan.md"), "changed plan\n");
	assert.throws(() => assertHostApproval(root, state), /plan changed/);
}));

test("known risky scripts cannot be approved against a do-not-run recommendation", () => fixture((root, state, input, checks) => {
	input.screening.recommendation = "do-not-run";
	state.review!.execution = prepareHostExecution(state, checks, input);
	assert.throws(() => assertScreeningCurrent(root, state), /cannot override/);
}));

test("package setup requires reviewing relevant project configuration and lockfiles", () => fixture((_root, state, input, checks) => {
	input.screening.files = ["verify.cjs"];
	assert.throws(() => prepareHostExecution(state, checks, input), /Screen package.json/);
	input.screening.files.push("package.json");
	assert.throws(() => prepareHostExecution(state, checks, input), /Screen package-lock.json/);
	input.screening.files.push("package-lock.json");
	input.setupCommands = [prCheckPrefix(state.review!.pr!.checkoutLocation) + "npm install"];
	assert.throws(() => prepareHostExecution(state, checks, input), /supports npm ci/);
}));

test("literal npm search data is not mistaken for an npm launcher", () => fixture((_root, state, input) => {
	input.setupCommands = [];
	input.screening.files = ["verify.cjs"];
	const command = prCheckPrefix(state.review!.pr!.checkoutLocation) + "grep 'npm' verify.cjs && node verify.cjs";
	assert.doesNotThrow(() => prepareHostExecution(state, [command], input));
}));

test("malformed records and unsafe screened/output paths cannot grant host permission", () => fixture((_root, state, input, checks) => {
	for (const path of ["../outside", "/tmp/escape", ".git/config", ".pi/rpac/state.json"]) {
		input.screening.files = [path]; assert.throws(() => prepareHostExecution(state, checks, input), /inside the PR checkout/);
	}
	for (const path of ["../", "/tmp/", "src/../", ".git/", ".pi/", "*", "build"]) assert.equal(generatedPath(path), false, path);
	for (const raw of [null, { version: 2 }, { version: 1, setupCommands: [], generatedPaths: ["../"], runs: [] }, { version: 1, setupCommands: [], generatedPaths: [], approval: { at: "now", digest: "bad" }, runs: [] }]) assert.throws(() => parseHostExecution(raw));
}));

test("host command policy supports useful && recipes, but never installs in verification or directory/shell bypasses", () => {
	const prefix = prCheckPrefix("/review path");
	for (const suffix of ["npm run typecheck && npm test", "sed -n '1,10p' package.json && npm test", "npx --no-install tsc --noEmit", "node --test test/fixture.test.cjs", "npm test -- --grep 'gh or rm is literal test data'"]) assert.equal(hostCommandIssue("/review path", prefix + suffix, "check"), null, suffix);
	assert.equal(hostCommandIssue("/review path", prefix + "npm ci --ignore-scripts --no-audit --no-fund", "setup"), null);
	for (const suffix of ["npm ci", "npm install", "npm test --prefix=/elsewhere", "npm test -g", "npm test --location=global", "cd / && npm test", "env X=1 npm test", "node -e 'console.log(1)'", "bash -c 'npm test'", "npm test | cat", "npm test > out", "npm test &", "npm test $(pwd)", "make -C / test", "make test -C/elsewhere", "npx --no-install bash -c true", "npx --no-install node -e 'console.log(1)'", "npx --no-install git status", "npx --no-install rm -rf src", "git push origin HEAD", "rm -rf src"]) assert.ok(hostCommandIssue("/review path", prefix + suffix, "check"), suffix);
	assert.ok(hostCommandIssue("/review path", "npm test", "check"));
	assert.ok(hostCommandIssue("/review path", prefix + "npm ci && npm test", "setup"));
});

test("only explicitly approved untracked generated paths are ignored; tracked source and cleanup stay strict", () => {
	assert.equal(cleanPrStatus(Buffer.from("?? dist/result.js\0"), false, ["dist/"]), true);
	assert.equal(cleanPrStatus(Buffer.from(" M dist/result.js\0"), false, ["dist/"]), false);
	assert.equal(cleanPrStatus(Buffer.from("A  dist/result.js\0"), false, ["dist/"]), false);
	assert.equal(cleanPrStatus(Buffer.from("?? source.ts\0"), false, ["dist/"]), false);
	assert.equal(cleanPrStatus(Buffer.from("?? dist-extra/result.js\0"), false, ["dist/"]), false);
	assert.equal(cleanPrStatus(Buffer.from("?? dist/result.js\0")), false, "cleanup never inherits execution output permission");
	assert.equal(cleanPrStatus(Buffer.from("R  dist/result.js\0source.ts\0"), false, ["dist/"]), false);
});
