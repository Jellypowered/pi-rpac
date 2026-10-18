// End-to-end PR review tests: load the real extension factory against a mock
// Pi runtime, with a mock `gh` on PATH (no real GitHub needed). Covers command
// parsing, metadata resolution, in-place + worktree checkout, dirty-tree
// handling, drift/force-push, resume, report-only enforcement, and the
// guarantee that no unauthorized GitHub mutation is ever attempted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, sep, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import rpacExtension from "../../extensions/rpac.ts";
import {
	activeWorkflowId,
	extensionApiFor,
	fire,
	makeCommandCtx,
	makeMockPi,
	readState,
	rpacCmd,
	rpacTool,
	workflowDirPath,
	writeArtifact,
	type MockPi,
} from "../helpers/mock-pi.ts";
import { makeTempDir, removeTree } from "../../lib/util.ts";
import type { PrViewResult } from "../../lib/pr.ts";

const MOCK_GH = fileURLToPath(new URL("../helpers/mock-gh.js", import.meta.url));

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

interface PrEnv {
	work: string;
	origin: string;
	baseSha: string;
	headSha: string;
	baseRef: string;
	prNumber: number;
	/** current PR metadata the mock gh returns for `pr view`. */
	view: PrViewResult;
	setView(view: PrViewResult): void;
	ghLogPath: string;
	ghCalls(): string[];
	cleanup(): void;
}

function makeView(base: string, head: string, extra: Partial<PrViewResult> = {}): PrViewResult {
	return {
		number: 1,
		url: "https://github.com/acme/widget/pull/1",
		title: "Add feature",
		body: "Adds a feature and removes a file.",
		state: "OPEN",
		baseRefName: "main",
		baseRefOid: base,
		headRefName: "feature",
		headRefOid: head,
		headRepository: { nameWithOwner: "acme/widget" },
		headRepositoryOwner: { login: "acme" },
		isCrossRepository: false,
		...extra,
	};
}

function setupPrEnv(): PrEnv {
	const origin = makeTempDir("rpac-pr-e2e-origin-");
	const work = makeTempDir("rpac-pr-e2e-work-");
	git(origin, "init", "-q");
	git(origin, "config", "user.email", "o@o");
	git(origin, "config", "user.name", "origin");
	writeFileSync(join(origin, "app.txt"), "main\n");
	writeFileSync(join(origin, "keep.txt"), "keep\n");
	git(origin, "add", "-A");
	git(origin, "commit", "-qm", "main");
	const baseRef = git(origin, "branch", "--show-current") || "HEAD";
	const baseSha = git(origin, "rev-parse", "HEAD");
	git(origin, "checkout", "-qb", "feature");
	writeFileSync(join(origin, "app.txt"), "main+feat\n");
	writeFileSync(join(origin, "new.txt"), "new\n");
	git(origin, "rm", "-q", "keep.txt");
	git(origin, "add", "-A");
	git(origin, "commit", "-qm", "feat");
	const headSha = git(origin, "rev-parse", "HEAD");
	git(origin, "update-ref", "refs/pull/1/head", headSha);
	// Reset origin's HEAD to the default branch, as GitHub's does (not the PR head).
	git(origin, "checkout", "-q", baseRef);

	execFileSync("git", ["clone", "-q", origin, work], { stdio: "ignore" });
	git(work, "config", "user.email", "w@w");
	git(work, "config", "user.name", "work");
	git(work, "checkout", "-q", baseRef);

	// Mock gh wrapper on PATH.
	const ghDir = makeTempDir("rpac-pr-e2e-ghbin-");
	const ghShim = join(ghDir, "gh");
	writeFileSync(ghShim, `#!/bin/sh\nexec node ${MOCK_GH} "$@"\n`);
	chmodSync(ghShim, 0o755);

	const ghLogPath = join(ghDir, "gh-calls.log");
	const oldPath = process.env.PATH;
	const oldView = process.env.MOCK_GH_VIEW;
	const oldHead = process.env.MOCK_GH_HEADSHA;
	const oldUnauthed = process.env.MOCK_GH_UNAUTHED;
	const oldLog = process.env.MOCK_GH_LOG;
	let view = makeView(baseSha, headSha);

	const env = {
		work,
		origin,
		baseSha,
		headSha,
		baseRef,
		prNumber: 1,
		get view() { return view; },
		setView(v: PrViewResult) {
			view = v;
			process.env.MOCK_GH_VIEW = JSON.stringify(v);
			process.env.MOCK_GH_HEADSHA = v.headRefOid;
		},
		ghLogPath,
		ghCalls(): string[] {
			if (!existsSync(ghLogPath)) return [];
			return readFileSync(ghLogPath, "utf8").split("\n").filter(Boolean);
		},
		cleanup() {
			try { git(work, "worktree", "prune"); } catch { /* ignore */ }
			// restore env
			process.env.PATH = oldPath;
			if (oldView === undefined) delete process.env.MOCK_GH_VIEW; else process.env.MOCK_GH_VIEW = oldView;
			if (oldHead === undefined) delete process.env.MOCK_GH_HEADSHA; else process.env.MOCK_GH_HEADSHA = oldHead;
			if (oldUnauthed === undefined) delete process.env.MOCK_GH_UNAUTHED; else process.env.MOCK_GH_UNAUTHED = oldUnauthed;
			if (oldLog === undefined) delete process.env.MOCK_GH_LOG; else process.env.MOCK_GH_LOG = oldLog;
			removeTree(origin);
			removeTree(work);
			removeTree(ghDir);
			const wt = join(dirname(work), `${basename(work)}-rpac-pr-1`);
			if (existsSync(wt)) removeTree(wt);
		},
	};
	// Activate the mock gh environment.
	env.setView(view);
	process.env.MOCK_GH_LOG = ghLogPath;
	process.env.PATH = ghDir + delimiter + oldPath;
	return env;
}

function basename(p: string): string {
	return p.split(sep).pop()!;
}

const MUTATING_GH = /(pr\s+(review|merge|close|create|update|edit)|\bapi\b.*-(X|POST|PATCH|DELETE)|repo\s+delete|pr\s+(diff|ready)\b.*\s-y)/;

function assertNoGhMutations(calls: string[]): void {
	for (const c of calls) {
		assert.equal(MUTATING_GH.test(c), false, `unauthorized GitHub mutation attempted: ${c}`);
	}
}

const REQ = [
	"# PR review requirements",
	"## Intent",
	"Review PR #1 (Add feature) for correctness, behavior, and policy compliance against its base.",
	"## Scope",
	"Every base...head manifest item is reviewed; no exclusions.",
	"## Acceptance",
	"Every item receives evidence; checks are run and reported honestly.",
].join("\n");

const PLAN = [
	"# PR review plan",
	"## Summary",
	"Review the PR diff in one bounded batch, then adversarially validate findings and run the build check.",
	"## Checks",
	"- safe: `node --version` (toolchain sanity). No destructive commands are approved.",
	"## Tasks",
	"- [ ] Review PR diff items",
	"- [ ] Validate findings and coverage",
].join("\n");

/** Drive a fresh PR review (refine) through refine→plan approval to the act phase. */
async function driveToAct(m: MockPi, work: string): Promise<{ id: string; itemIds: string[] }> {
	const id = activeWorkflowId(work);
	writeArtifact(work, "requirements", REQ, id);
	await rpacTool(m, work, { action: "refine_complete" }, { confirm: [true] });
	const manifest = JSON.parse(readFileSync(join(workflowDirPath(work, id), "review-manifest.json"), "utf8"));
	const itemIds = manifest.items.map((e: { id: string }) => e.id);
	writeArtifact(work, "plan", PLAN, id);
	await rpacTool(m, work, {
		action: "plan_complete",
		tasks: [
			{ title: "Review PR diff items", reviewItemIds: itemIds },
			{ title: "Validate findings and coverage", dependsOn: [1] },
		],
		reviewChecks: ["node --version"],
	}, { confirm: [true] });
	return { id, itemIds };
}

test("PR review happy path: in-place checkout, full lifecycle, report-only, no gh mutations", async () => {
	const env = setupPrEnv();
	const m = makeMockPi();
	try {
		rpacExtension(extensionApiFor(m));

		const started = await rpacCmd(m, env.work, "start preview 1");
		assert.match(started.ui.text("info").join("\n"), /PR review .* started/);
		const id = activeWorkflowId(env.work);
		let s = readState(env.work, id);
		assert.equal(s.workflowKind, "review");
		assert.equal(s.review.mode, "pr");
		assert.equal(s.review.pr.number, 1);
		assert.equal(s.review.pr.baseSha, env.baseSha);
		assert.equal(s.review.pr.headSha, env.headSha);
		assert.equal(s.review.pr.checkoutStrategy, "in-place");
		assert.equal(s.review.pr.checkoutLocation, env.work);
		assert.equal(s.review.pr.repository, "acme/widget");
		assert.equal(s.review.pr.originalBranch, env.baseRef);
		// In-place checkout moved the worktree onto the PR head.
		assert.equal(git(env.work, "rev-parse", "HEAD"), env.headSha);
		// Manifest captures the exact base...head scope.
		const manifest = JSON.parse(readFileSync(join(workflowDirPath(env.work, id), "review-manifest.json"), "utf8"));
		assert.deepEqual(manifest.items.map((i: { path: string }) => i.path).sort(), ["app.txt", "keep.txt", "new.txt"]);
		assert.match(m.userMessages.at(-1)!, /PR REVIEW REFINE/);
		assert.match(started.ui.statuses.rpac ?? "", /review:pr#1/);

		// gh was used only for the read/checkout operations (no mutations).
		assertNoGhMutations(env.ghCalls());

		// Drive to act; report-only gate enforced + approved check allowed.
		const { id: pid, itemIds } = await driveToAct(m, env.work);
		assert.equal(pid, id);
		await rpacCmd(m, env.work, "act");
		s = readState(env.work, id);
		assert.equal(s.tasks[0].status, "in_progress");
		const gate = async (toolName: string, input: Record<string, unknown>) =>
			fire(m, "tool_call", { type: "tool_call", toolName, input }, { cwd: env.work }) as Promise<unknown>;
		// Approved, non-destructive check is allowed.
		assert.equal(((await gate("bash", { command: "node --version" })) as { block?: boolean } | undefined)?.block, undefined);
		// A destructive/remote mutation is blocked even though in ACT.
		assert.ok(((await gate("bash", { command: "git push origin HEAD" })) as { block?: boolean }).block);
		// Writing a reviewed source file is blocked (report-only).
		assert.ok(((await gate("write", { path: join(env.work, "app.txt"), content: "x" })) as { block?: boolean }).block);

		// Record batch evidence and complete the review tasks.
		const batch1 = join(workflowDirPath(env.work, id), "review-batch-1.md");
		writeFileSync(batch1, "# Batch 1\n\nAll assigned PR items inspected; one candidate finding validated.\n");
		await rpacTool(m, env.work, {
			action: "task_done",
			task: 1,
			verification: [
				{ name: "build check", result: "pass", detail: "node --version ran" },
				{ name: "batch evidence complete", kind: "acceptance", result: "pass" },
			],
			deliverables: [batch1],
		});
		await fire(m, "agent_end", { type: "agent_end" }, makeCommandCtx(m, env.work) as never);
		await rpacCmd(m, env.work, "act");
		const batch2 = join(workflowDirPath(env.work, id), "review-batch-2.md");
		writeFileSync(batch2, "# Batch 2\n\nAdversarial validation complete; coverage ledger audited.\n");
		await rpacTool(m, env.work, {
			action: "task_done",
			task: 2,
			verification: [{ name: "adversarial validation", result: "pass" }],
			deliverables: [batch2],
		});
		await fire(m, "agent_end", { type: "agent_end" }, makeCommandCtx(m, env.work) as never);
		s = readState(env.work, id);
		assert.equal(s.review.coveredItemIds.length, itemIds.length);

		// Consolidate: report persisted + recommendation is advisory.
		await rpacCmd(m, env.work, "consolidate");
		const report = join(workflowDirPath(env.work, id), "review-report.md");
		writeFileSync(report, [
			"# PR review report",
			"## Outcome",
			`Reviewed PR #1 at ${env.headSha.slice(0, 12)} — scrutiny, not approval.`,
			"## Recommendation",
			"Request changes (advisory only; nothing was posted to GitHub).",
		].join("\n"));
		const done = await rpacTool(m, env.work, { action: "consolidate_complete", text: "report complete" });
		assert.match(done, /Review workflow complete/);
		s = readState(env.work, id);
		assert.equal(s.phase, "done");
		assert.match(s.artifacts.report.path, /review-report\.md$/);
		// Still no GitHub mutations at any point.
		assertNoGhMutations(env.ghCalls());
	} finally {
		env.cleanup();
	}
});

test("PR review rejects invalid PR numbers", async () => {
	const env = setupPrEnv();
	const m = makeMockPi();
	try {
		rpacExtension(extensionApiFor(m));
		let ctx = await rpacCmd(m, env.work, "start preview abc");
		assert.match(ctx.ui.text("error").join("\n"), /invalid PR number/);
		ctx = await rpacCmd(m, env.work, "start preview 0");
		assert.match(ctx.ui.text("error").join("\n"), /invalid PR number/);
		ctx = await rpacCmd(m, env.work, "start preview 1 2");
		assert.match(ctx.ui.text("error").join("\n"), /Usage/);
		assert.equal(existsSync(join(env.work, ".pi", "rpac", "state.json")), false, "no state created on invalid input");
	} finally {
		env.cleanup();
	}
});

test("PR review handles missing gh, unauthenticated gh, non-git, and missing remote", async () => {
	const env = setupPrEnv(); // mock gh on PATH, work has an origin remote
	const m = makeMockPi();
	const nonGit = makeTempDir("rpac-pr-nongit-");
	try {
		rpacExtension(extensionApiFor(m));

		// Non-git directory (mock gh present).
		let ctx = await rpacCmd(m, nonGit, "start preview 1");
		assert.match(ctx.ui.text("error").join("\n"), /requires a Git work tree/);

		// Missing remote: drop the origin remote from the (otherwise valid) work repo.
		execFileSync("git", ["remote", "remove", "origin"], { cwd: env.work, stdio: "ignore" });
		ctx = await rpacCmd(m, env.work, "start preview 1");
		assert.match(ctx.ui.text("error").join("\n"), /requires a Git remote/);
		assert.equal(existsSync(join(env.work, ".pi", "rpac", "state.json")), false);
	} finally {
		removeTree(nonGit);
		env.cleanup(); // restores PATH + MOCK vars, cleans work
	}

	// Missing gh: empty PATH (gh unfindable). projectRoot degrades to cwd; the gh check fails first.
	const emptyBin = makeTempDir("rpac-no-gh-");
	const oldPath = process.env.PATH;
	const work = makeTempDir("rpac-pr-missngh-");
	const m1 = makeMockPi();
	rpacExtension(extensionApiFor(m1));
	try {
		process.env.PATH = emptyBin;
		const ctx = await rpacCmd(m1, work, "start preview 1");
		assert.match(ctx.ui.text("error").join("\n"), /GitHub CLI .* not on PATH/);
	} finally {
		process.env.PATH = oldPath;
		removeTree(emptyBin);
		removeTree(work);
	}

	// Unauthenticated gh: mock gh present but MOCK_GH_UNAUTHED set.
	const env2 = setupPrEnv();
	const m2 = makeMockPi();
	rpacExtension(extensionApiFor(m2));
	try {
		process.env.MOCK_GH_UNAUTHED = "1";
		const ctx = await rpacCmd(m2, env2.work, "start preview 1");
		assert.match(ctx.ui.text("error").join("\n"), /not authenticated/);
		assert.equal(existsSync(join(env2.work, ".pi", "rpac", "state.json")), false);
	} finally {
		delete process.env.MOCK_GH_UNAUTHED;
		env2.cleanup();
	}
});

test("PR review uses an isolated worktree when the main tree is dirty and preserves it", async () => {
	const env = setupPrEnv();
	const m = makeMockPi();
	try {
		// Dirty the main worktree.
		writeFileSync(join(env.work, "local.txt"), "user work\n");
		rpacExtension(extensionApiFor(m));
		const started = await rpacCmd(m, env.work, "start preview 1");
		assert.match(started.ui.text("info").join("\n"), /checkout: worktree/);
		const id = activeWorkflowId(env.work);
		const s = readState(env.work, id);
		assert.equal(s.review.pr.checkoutStrategy, "worktree");
		assert.notEqual(s.review.pr.checkoutLocation, env.work);
		assert.ok(existsSync(s.review.pr.checkoutLocation));
		// Main worktree untouched: still on base branch, local file present.
		assert.equal(git(env.work, "branch", "--show-current"), env.baseRef);
		assert.ok(existsSync(join(env.work, "local.txt")));
		// Worktree is at the PR head.
		assert.equal(git(s.review.pr.checkoutLocation, "rev-parse", "HEAD"), env.headSha);
		// The isolated worktree can be removed via /rpac pr-cleanup without touching the main tree.
		const cleaned = await rpacCmd(m, env.work, "pr-cleanup");
		assert.match(cleaned.ui.text("info").join("\n"), /removed PR worktree/);
		assert.equal(existsSync(s.review.pr.checkoutLocation), false);
		assert.ok(existsSync(join(env.work, "local.txt")), "main tree preserved after cleanup");
	} finally {
		env.cleanup();
	}
});

test("PR review preserves an existing active workflow (headless requires --yes)", async () => {
	const env = setupPrEnv();
	const m = makeMockPi();
	try {
		rpacExtension(extensionApiFor(m));
		await rpacCmd(m, env.work, "start existing implementation task");
		const existingId = activeWorkflowId(env.work);
		// Headless replacement without --yes is refused.
		const ctx = await rpacCmd(m, env.work, "start preview 1", { hasUI: false });
		assert.match(ctx.ui.text("error").join("\n"), /active workflow .* abort\/finish|--yes/);
		assert.equal(activeWorkflowId(env.work), existingId, "existing workflow still active");
		// With --yes, the old workflow is saved (not destroyed) and the PR review becomes active.
		const ok = await rpacCmd(m, env.work, "start preview --yes 1", { hasUI: false });
		assert.match(ok.ui.text("info").join("\n"), /PR review .* started/);
		const prId = activeWorkflowId(env.work);
		assert.notEqual(prId, existingId);
		const index = JSON.parse(readFileSync(join(env.work, ".pi", "rpac", "state.json"), "utf8"));
		assert.ok(index.workflows[existingId], "old workflow preserved in index");
		assert.equal(index.active, prId);
	} finally {
		env.cleanup();
	}
});

test("PR review records fork (cross-repository) PRs", async () => {
	const env = setupPrEnv();
	const m = makeMockPi();
	try {
		env.setView(makeView(env.baseSha, env.headSha, { isCrossRepository: true, headRepositoryOwner: { login: "contrib" }, headRepository: { nameWithOwner: "contrib/widget" } }));
		rpacExtension(extensionApiFor(m));
		await rpacCmd(m, env.work, "start preview 1");
		const s = readState(env.work);
		assert.equal(s.review.pr.crossRepository, true);
		assert.equal(s.review.pr.headRepositoryOwner, "contrib");
		assert.equal(git(env.work, "rev-parse", "HEAD"), env.headSha);
	} finally {
		env.cleanup();
	}
});

test("PR head drift (force-push) invalidates coverage and is reported, not auto-switched", async () => {
	const env = setupPrEnv();
	const m = makeMockPi();
	try {
		rpacExtension(extensionApiFor(m));
		await rpacCmd(m, env.work, "start preview 1");
		const { id, itemIds } = await driveToAct(m, env.work);
		// Complete the first (coverage) task so there is coverage to invalidate.
		await rpacCmd(m, env.work, "act");
		const batch1 = join(workflowDirPath(env.work, id), "review-batch-1.md");
		writeFileSync(batch1, "# Batch 1\n\nCoverage evidence for all PR items.\n");
		await rpacTool(m, env.work, {
			action: "task_done",
			task: 1,
			verification: [{ name: "batch evidence complete", kind: "acceptance", result: "pass" }],
			deliverables: [batch1],
		});
		await fire(m, "agent_end", { type: "agent_end" }, makeCommandCtx(m, env.work) as never);
		let s = readState(env.work, id);
		assert.equal(s.review.coveredItemIds.length, itemIds.length, "coverage recorded before drift");
		// Force-push: the PR head now points at a different commit.
		const newHead = "d".repeat(40);
		env.setView(makeView(env.baseSha, newHead));
		// Re-entering act rechecks the snapshot and must report drift + invalidate coverage.
		const act = await rpacCmd(m, env.work, "act");
		assert.match(act.ui.text("warning").join("\n"), /force-pushed|drift|stale/i);
		s = readState(env.work, id);
		assert.ok(s.review.drift, "drift persisted");
		assert.equal(s.review.coveredItemIds.length, 0, "coverage invalidated");
		assert.deepEqual([...s.review.uncoveredItemIds].sort(), [...itemIds].sort());
		// The reviewed commit was NOT silently switched.
		assert.equal(s.review.pr.headSha, env.headSha);
		assert.equal(git(env.work, "rev-parse", "HEAD"), env.headSha);
	} finally {
		env.cleanup();
	}
});

test("PR review is resumable after restart (state + directive persist)", async () => {
	const env = setupPrEnv();
	const m = makeMockPi();
	try {
		rpacExtension(extensionApiFor(m));
		await rpacCmd(m, env.work, "start preview 1");
		const id = activeWorkflowId(env.work);
		const s = readState(env.work, id);
		assert.equal(s.review.pr.number, 1);
		assert.equal(git(env.work, "rev-parse", "HEAD"), env.headSha);

		// Simulate a fresh Pi session (new mock runtime, same on-disk state).
		const m2 = makeMockPi();
		rpacExtension(extensionApiFor(m2));
		const status = await rpacCmd(m2, env.work, "status");
		assert.match(status.ui.text("info").join("\n"), /PR: #1 https:\/\/github\.com\/acme\/widget\/pull\/1/);
		assert.match(status.ui.text("info").join("\n"), /PR checkout: in-place/);
		const resumed = await rpacCmd(m2, env.work, `resume ${id}`);
		assert.match(m2.userMessages.at(-1)!, /PR REVIEW REFINE/);
		// State survived intact.
		assert.equal(readState(env.work, id).review.pr.headSha, env.headSha);
	} finally {
		env.cleanup();
	}
});
