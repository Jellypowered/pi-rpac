/**
 * End-to-end: ONE COMPLETE RPAC workflow (REFINE → PLAN → ACT →
 * CONSOLIDATE → DONE) on an isolated sample repo, driven by the REAL
 * installed Pi binary in RPC mode (`pi --mode rpc --no-session
 * --extension ...`). A stateful mock OpenAI-compatible model writes the
 * phase artifacts, implements and verifies the task with real tool calls
 * (write/bash), and calls the `rpac` tool for transitions. The extension
 * enforces phases, approvals, the REFINE/PLAN read-only gate, the ACT
 * lease, verification, and durable per-workflow state.
 *
 * Skipped automatically when the pi binary or git is unavailable.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	makeSampleRepo,
	mockModelsJson,
	piAvailable,
	RpcClient,
	startWorkflowMockModel,
	type WorkflowMockContent,
} from "./realpi-harness.ts";

const EXTENSION_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "extensions", "rpac.ts");

const REQUIREMENTS = [
	"# Requirements",
	"## Context",
	"Add a greeting function to the sample app.",
	"## Verified codebase facts",
	"- src/app.js currently exports an empty object (module.exports = {}).",
	"- The app has no dependencies; scripts.test runs a trivial node check.",
	"## Requirements",
	"- R1: `greet(name)` returns \"Hello, <name>\".",
	"## Acceptance criteria",
	"- AC-1: greet(\"World\") === \"Hello, World\" (verified by a node check).",
].join("\n");

const PLAN = [
	"# Plan",
	"## Summary",
	"Implement greet(name) in src/app.js as a single CommonJS export.",
	"## Conventions",
	"CommonJS; no new dependencies; keep the existing module shape.",
	"## Tasks",
	"- [ ] 1. Implement greet() in src/app.js",
	"  - Done when: `node -e` check prints greet ok and exits 0",
].join("\n");

const CONTENT: WorkflowMockContent = {
	requirements: REQUIREMENTS,
	plan: PLAN,
	taskTitle: "Implement greet() in src/app.js",
	appFile: "src/app.js",
	appImpl: 'function greet(name) {\n\treturn "Hello, " + name;\n}\nmodule.exports = { greet };\n',
	verifyCommand: "node -e \"const a=require('./src/app.js'); if(a.greet('World')!=='Hello, World') process.exit(1); console.log('greet ok')\"",
	finalCheck: "node -e \"require('./src/app.js').greet('Final'); console.log('final ok')\"",
	report: [
		"# Completion report",
		"## What was implemented",
		"greet(name) in src/app.js.",
		"## Acceptance criteria",
		"- AC-1: verified — the node check printed `greet ok` and exited 0.",
		"## Verification",
		"- node greet check (ACT): pass",
		"- final check (CONSOLIDATE): pass",
		"## Deviations",
		"None.",
		"## Gaps and limitations",
		"None known.",
	].join("\n"),
};

const skip = !piAvailable() || !existsSync(EXTENSION_PATH);

describe("e2e: complete RPAC workflow through the real Pi binary (RPC)", { skip: skip ? "pi binary or extension not available" : false }, () => {
	let repo: string;
	let agentDir: string;
	let client: RpcClient;
	let mock: { server: Server; port: number };

	before(async () => {
		mock = await startWorkflowMockModel(CONTENT, (which) => {
			const index = JSON.parse(readFileSync(join(repo, ".pi", "rpac", "state.json"), "utf8"));
			return join(repo, ".pi", "rpac", index.active, `${which}.md`);
		});
		repo = makeSampleRepo();
		agentDir = mkdtempSync(join(tmpdir(), "rpac-e2e-agent-"));
		writeFileSync(join(agentDir, "models.json"), mockModelsJson(mock.port));
		client = new RpcClient(repo, ["--mode", "rpc", "--no-session", "--extension", EXTENSION_PATH], {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
		});
		client.autoConfirm = true;
	});

	after(async () => {
		client?.close();
		mock?.server.close();
		if (repo) rmSync(repo, { recursive: true, force: true });
		if (agentDir) rmSync(agentDir, { recursive: true, force: true });
	});

	const wfFile = () => join(repo, ".pi", "rpac", wfId(), "workflow.json");
	const wfId = () => JSON.parse(readFileSync(join(repo, ".pi", "rpac", "state.json"), "utf8")).active as string;
	const wf = (): any => (existsSync(wfFile()) ? JSON.parse(readFileSync(wfFile(), "utf8")) : null);
	const cmd = (message: string) => client.send({ type: "prompt", message });
	const settle = (ms = 120_000) => client.waitForEvent("agent_settled", undefined, ms).catch(() => undefined);

	it(
		"boots, loads the extension, and answers /rpac status",
		{ timeout: 60_000 },
		async () => {
			const r = await cmd("/rpac status");
			assert.equal(r.success, true);
			assert.ok(client.uiNotifyMatching(/No active workflow/i), `no-workflow notice (stderr: ${client.stderrLog.slice(-300)})`);
		},
	);

	it(
		"REFINE: start creates the per-workflow state; the model writes requirements and requests approval",
		{ timeout: 180_000 },
		async () => {
			const p = cmd("/rpac start add a greeting function to src/app.js");
			const r = await p;
			assert.equal(r.success, true);
			const s = wf();
			assert.ok(s, "workflow state exists");
			assert.equal(s.phase, "refine");
			assert.ok(s.baseline?.head, "git baseline captured");
			assert.ok(existsSync(join(repo, ".pi", "rpac", s.id, "log.md")), "per-workflow log created");

			// model run: writes requirements, then calls refine_complete (auto-confirmed)
			await settle();
			const req = readFileSync(join(repo, ".pi", "rpac", s.id, "requirements.md"), "utf8");
			assert.match(req, /greet\(name\)/);
			const s2 = wf();
			assert.equal(s2.approvals.requirements, true, "refine_complete approval recorded");
			assert.equal(s2.phase, "plan", "approval moved the phase to plan");
			assert.ok(s2.artifacts.requirements, "artifact reference recorded");
		},
	);

	it(
		"PLAN: the model writes the plan and registers the task list",
		{ timeout: 180_000 },
		async () => {
			const r = await cmd("/rpac plan");
			assert.equal(r.success, true);
			await settle();
			const s = wf();
			const plan = readFileSync(join(repo, ".pi", "rpac", s.id, "plan.md"), "utf8");
			assert.match(plan, /## Tasks/);
			assert.equal(s.approvals.plan, true, "plan approval recorded");
			assert.equal(s.tasks.length, 1);
			assert.match(s.tasks[0].title, /Implement greet/);
			assert.equal(s.phase, "plan", "approval stays in the plan phase; /rpac act moves to act");
		},
	);

	it(
		"ACT: the model implements, verifies, and reports the task done (lease held during the run)",
		{ timeout: 240_000 },
		async () => {
			const r = await cmd("/rpac act");
			assert.equal(r.success, true);
			const s = wf();
			assert.equal(s.phase, "act");
			assert.equal(s.tasks[0].status, "in_progress");

			await settle(180_000);
			const app = readFileSync(join(repo, "src", "app.js"), "utf8");
			assert.match(app, /Hello, /);
			const s2 = wf();
			assert.equal(s2.tasks[0].status, "done", "verified task_done → done");
			assert.equal(s2.tasks[0].verification?.length, 1);
			// the ACT lease is released when the run ends (poll: agent_end handler ordering)
			const leasePath = join(repo, ".pi", "rpac", ".act-lease");
			const deadline = Date.now() + 5000;
			while (existsSync(leasePath) && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 100));
			}
			assert.ok(!existsSync(leasePath), "lease file released");
		},
	);

	it(
		"CONSOLIDATE → DONE: final check, report, and terminal phase",
		{ timeout: 240_000 },
		async () => {
			const r = await cmd("/rpac consolidate");
			assert.equal(r.success, true);
			assert.equal(wf().phase, "consolidate");
			await settle(180_000);
			const report = readFileSync(join(repo, ".pi", "rpac", wfId(), "report.md"), "utf8");
			assert.match(report, /Completion report/);
			const s = wf();
			assert.equal(s.phase, "done", "consolidate_complete → done");
		},
	);

	it(
		"state integrity: artifacts, log, and index; RPAC never committed anything",
		{ timeout: 60_000 },
		async () => {
			const id = wfId();
			assert.ok(id.startsWith("w-"));
			const index = JSON.parse(readFileSync(join(repo, ".pi", "rpac", "state.json"), "utf8"));
			assert.equal(index.active, id);
			assert.ok(index.workflows[id], "index lists the workflow");
			for (const f of ["requirements.md", "plan.md", "report.md", "log.md"]) {
				assert.ok(existsSync(join(repo, ".pi", "rpac", id, f)), `${f} present`);
			}
			const log = readFileSync(join(repo, ".pi", "rpac", id, "log.md"), "utf8");
			assert.match(log, /requirements artifact finalized/);
			assert.match(log, /approved: plan/);
			// exactly the initial commit — RPAC never commits/pushes
			const count = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
			assert.equal(count, "1");
			const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
			assert.ok(status.length > 0, "working tree still dirty (code change uncommitted)");
		},
	);
});
