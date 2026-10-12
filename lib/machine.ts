// RPAC phase machine — pure transition logic with approval/pause guards.
//
// Task outcomes: pending → in_progress → done | failed | blocked; an
// in_progress task whose run is interrupted becomes `interrupted`. A task is
// `done` only when every recorded verification check passed (or the user
// explicitly accepted a documented exception). Failed/interrupted tasks are
// resumable; blocked tasks need unblocking first.
import {
	type RpacState,
	type RpacTask,
	type VerificationCheck,
	isSubstantive,
	validateTaskGraph,
	MAX_CHECKPOINTS,
	MAX_EVENTS,
	MAX_TASK_HISTORY,
} from "./schema.ts";
import { nowIso, sha256File, truncate } from "./util.ts";
import { readFileSync } from "node:fs";

export class RpacGuardError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpacGuardError";
	}
}

function pushEvent(s: RpacState, kind: string, detail: string): void {
	s.events.push({ at: nowIso(), kind, detail: truncate(detail, 300) });
	if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
}

function touch(s: RpacState): void {
	s.updatedAt = nowIso();
}

/** Record a workflow event (bounded). */
export function recordEvent(s: RpacState, kind: string, detail: string): void {
	pushEvent(s, kind, detail);
	touch(s);
}

/**
 * Re-baseline an artifact against its on-disk contents.
 * `pathAbs` is the absolute file path; `relPath` is the project-root-relative
 * path recorded in state. Returns "absent" | "unchanged" | "updated".
 */
export function refreshArtifact(
	s: RpacState,
	which: "requirements" | "plan" | "report" | "handoff",
	pathAbs: string,
	relPath: string,
): "absent" | "unchanged" | "updated" {
	const sha = sha256File(pathAbs);
	if (!sha) {
		if (s.artifacts[which]) pushEvent(s, "artifact_absent", `${which} artifact missing on disk: ${s.artifacts[which]?.path}`);
		s.artifacts[which] = undefined;
		touch(s);
		return "absent";
	}
	const prev = s.artifacts[which];
	const art = { path: prev?.path ?? relPath, sha256: sha, updatedAt: nowIso() };
	if (prev && prev.sha256 === sha) {
		if (prev.updatedAt !== art.updatedAt) s.artifacts[which] = { ...prev, updatedAt: art.updatedAt };
		return "unchanged";
	}
	s.artifacts[which] = art;
	if (prev) pushEvent(s, "artifact_changed", `${which} artifact modified externally (sha ${prev.sha256.slice(0, 8)}… → ${sha.slice(0, 8)}…)`);
	else pushEvent(s, "artifact_created", `${which} artifact written: ${relPath}`);
	touch(s);
	return "updated";
}

function requirePhase(s: RpacState, phases: RpacState["phase"][], action: string): void {
	if (!phases.includes(s.phase)) {
		throw new RpacGuardError(`${action} is not available in phase "${s.phase}" (needs: ${phases.join(", ")})`);
	}
}

function requireNotPaused(s: RpacState, action: string): void {
	if (s.paused) throw new RpacGuardError(`workflow is paused — run /rpac resume to continue ${action}`);
}

function requireRequirementsApproved(s: RpacState, action: string): void {
	if (!s.approvals.requirements) {
		throw new RpacGuardError(`${action} requires approved requirements. Ask the user to run /rpac approve requirements (or approve via the dialog).`);
	}
}

function requirePlanApproved(s: RpacState, action: string): void {
	if (!s.approvals.plan) {
		throw new RpacGuardError(`${action} requires an approved plan. Ask the user to run /rpac approve plan (or approve via the dialog).`);
	}
}

export interface MachineResult {
	state: RpacState;
	/** message for the model / user */
	message: string;
	/** true when the user must approve next (extension may show a dialog) */
	needsApproval?: "requirements" | "plan";
	/** true when sequential execution should stop (failed/blocked/interrupted/no progress) */
	stopSequential?: boolean;
}

/** Model finished refining requirements. Requires a present, non-trivial artifact. */
export function refineComplete(s: RpacState, requirementsPath: string, relPath = "requirements.md"): MachineResult {
	requirePhase(s, ["refine"], "refine_complete");
	requireNotPaused(s, "to finish refinement");
	const res = refreshArtifact(s, "requirements", requirementsPath, relPath);
	if (res === "absent") {
		throw new RpacGuardError(`requirements file not found at ${requirementsPath}. Write the refined requirements there first.`);
	}
	if (!isSubstantive(readFileSyncSafe(requirementsPath))) {
		throw new RpacGuardError(
			"requirements are too thin to approve (at least a short document: context, verified facts, requirements, acceptance criteria). Expand .pi/rpac requirements first.",
		);
	}
	pushEvent(s, "refine_complete", "requirements artifact finalized by model");
	return {
		state: s,
		message: `Requirements artifact finalized (${s.artifacts.requirements?.path}). Awaiting user approval before planning.`,
		needsApproval: "requirements",
	};
}

function readFileSyncSafe(pathAbs: string): string {
	try {
		return readFileSync(pathAbs, "utf8");
	} catch {
		return "";
	}
}

/** User approved the requirements. Transition refine → plan (idempotent). */
export function approveRequirements(s: RpacState): MachineResult {
	if (s.approvals.requirements) {
		return { state: s, message: "Requirements already approved." };
	}
	requirePhase(s, ["refine", "plan"], "approve requirements");
	if (!s.artifacts.requirements) {
		throw new RpacGuardError("cannot approve requirements: no requirements artifact on disk yet.");
	}
	s.approvals.requirements = true;
	if (s.phase === "refine") {
		s.phase = "plan";
		pushEvent(s, "phase", "refine → plan (requirements approved by user)");
	} else {
		pushEvent(s, "phase", "requirements approved by user");
	}
	return {
		state: s,
		message: "Requirements approved. Phase: plan. Run /rpac plan to create the implementation plan.",
	};
}

export interface PlanTaskSpec {
	title: string;
	dependsOn?: number[];
}

/** Model finished the plan. Requires plan artifact + a non-empty, valid task graph. */
export function planComplete(s: RpacState, planPath: string, tasks: PlanTaskSpec[], relPath = "plan.md"): MachineResult {
	requirePhase(s, ["plan"], "plan_complete");
	requireNotPaused(s, "to finish planning");
	requireRequirementsApproved(s, "plan_complete");
	const res = refreshArtifact(s, "plan", planPath, relPath);
	if (res === "absent") {
		throw new RpacGuardError(`plan file not found at ${planPath}. Write the implementation plan there first.`);
	}
	if (!isSubstantive(readFileSyncSafe(planPath))) {
		throw new RpacGuardError("the plan is too thin to approve (it needs a summary/conventions/acceptance section plus the ## Tasks list). Expand the plan first.");
	}
	if (!Array.isArray(tasks) || tasks.length === 0) {
		throw new RpacGuardError("plan_complete requires a non-empty task list matching the plan's ## Tasks section.");
	}
	if (tasks.length > 40) {
		throw new RpacGuardError(`too many tasks (${tasks.length}); keep plans to a handful of meaningful tasks.`);
	}
	const n = tasks.length;
	const deps = tasks.map((t) => (Array.isArray(t.dependsOn) ? (t.dependsOn as number[]) : undefined));
	try {
		validateTaskGraph(deps, n);
	} catch (err) {
		throw new RpacGuardError(`invalid task graph: ${(err as Error).message}`);
	}
	const completed = s.tasks.filter((t) => t.status === "done");
	if (completed.length > 0) {
		const supersededAt = nowIso();
		for (const task of completed) {
			s.taskHistory.push({
				...task,
				verification: task.verification?.map((check) => ({ ...check })),
				issues: task.issues ? [...task.issues] : undefined,
				dependsOn: task.dependsOn ? [...task.dependsOn] : undefined,
				supersededAt,
				reason: "plan superseded after back_to_plan",
			});
		}
		if (s.taskHistory.length > MAX_TASK_HISTORY) {
			s.taskHistory.splice(0, s.taskHistory.length - MAX_TASK_HISTORY);
		}
		pushEvent(s, "task_history", `${completed.length} completed task(s) archived before revised plan registration`);
	}
	s.tasks = tasks.map((t, i) => {
		const depList = (deps[i] ?? []).filter((d) => d >= 1 && d <= n && d !== i + 1);
		return {
			id: i + 1,
			title: String(t.title ?? `Task ${i + 1}`).trim(),
			status: "pending" as const,
			...(depList.length > 0 ? { dependsOn: depList } : {}),
		};
	});
	pushEvent(s, "plan_complete", `plan finalized with ${s.tasks.length} tasks`);
	return {
		state: s,
		message: `Plan finalized with ${s.tasks.length} task(s) (${s.tasks.map((t) => t.title).join("; ")}). Awaiting user approval before implementation.`,
		needsApproval: "plan",
	};
}

/** User approved the plan. Stays in plan phase until act is invoked. */
export function approvePlan(s: RpacState): MachineResult {
	if (s.approvals.plan) {
		return { state: s, message: "Plan already approved." };
	}
	requirePhase(s, ["plan"], "approve plan");
	requireRequirementsApproved(s, "approve plan");
	if (s.tasks.length === 0) {
		throw new RpacGuardError("cannot approve plan: no tasks recorded. Finish planning first (rpac plan_complete).");
	}
	if (!s.artifacts.plan) {
		throw new RpacGuardError("cannot approve plan: no finalized plan artifact. Finish planning first (rpac plan_complete).");
	}
	s.approvals.plan = true;
	pushEvent(s, "phase", "plan approved by user");
	return {
		state: s,
		message: "Plan approved. Run /rpac act to start executing the first task.",
	};
}

/** User approved sequential (multi-task-per-run) execution. Idempotent. */
export function approveSequential(s: RpacState): MachineResult {
	s.approvals.sequential = true;
	pushEvent(s, "approval", "sequential execution approved");
	return { state: s, message: "Sequential execution approved: /rpac act may continue through ready tasks in one run." };
}

/** Tasks whose dependencies are all done (and which are pending). */
export function readyTasks(s: RpacState): number[] {
	return s.tasks
		.filter((t) => t.status === "pending" && (t.dependsOn ?? []).every((d) => s.tasks.find((x) => x.id === d)?.status === "done"))
		.map((t) => t.id);
}

function findTask(s: RpacState, ref: number | string | undefined): RpacTask {
	if (s.tasks.length === 0) throw new RpacGuardError("no tasks recorded — finish planning first.");
	if (ref === undefined) {
		const ready = s.tasks.find((t) => t.status === "pending" && readyTasks(s).includes(t.id));
		if (!ready) {
			const anyPending = s.tasks.find((t) => t.status === "pending");
			if (anyPending) {
				const blockers = (anyPending.dependsOn ?? [])
					.map((d) => s.tasks.find((t) => t.id === d))
					.filter((t) => t && t.status !== "done")
					.map((t) => t!.id)
					.join(", ");
				throw new RpacGuardError(`no ready task: task ${anyPending.id} is blocked by unfinished task(s) ${blockers || "?"}`);
			}
			const failed = s.tasks.filter((t) => t.status === "failed" || t.status === "interrupted");
			throw new RpacGuardError(
				failed.length > 0
					? `no pending task — ${failed.map((t) => `task ${t.id} is ${t.status}`).join(", ")}; fix and retry (/rpac act <id>) or have the user accept it (/rpac accept <id> <reason>)`
					: s.tasks.every((t) => t.status === "done" || t.status === "blocked")
						? "all tasks are done or blocked — run /rpac consolidate."
						: "no pending tasks",
			);
		}
		return ready;
	}
	const id = typeof ref === "number" ? ref : Number(ref);
	if (!Number.isInteger(id)) throw new RpacGuardError(`invalid task reference: ${String(ref)}`);
	const task = s.tasks.find((t) => t.id === id);
	if (!task) throw new RpacGuardError(`no task with id ${id}`);
	return task;
}

/**
 * Start (or re-start) the next (or given) task for execution.
 * Re-startable outcomes: in_progress (re-issue), failed, interrupted.
 * Blocked tasks must be unblocked; done tasks are terminal.
 */
export function taskStart(s: RpacState, ref?: number | string): MachineResult {
	requirePhase(s, ["act"], "task_start");
	requireNotPaused(s, "to start a task");
	requirePlanApproved(s, "task_start");
	const task = findTask(s, ref);
	if (task.status === "done") throw new RpacGuardError(`task ${task.id} is already done`);
	if (task.status === "blocked") throw new RpacGuardError(`task ${task.id} is blocked — resolve the blocker first (task_unblock after the blocker is fixed)`);
	const openDeps = (task.dependsOn ?? []).filter((d) => s.tasks.find((t) => t.id === d)?.status !== "done");
	if (openDeps.length > 0) {
		throw new RpacGuardError(`task ${task.id} depends on unfinished task(s) ${openDeps.join(", ")}`);
	}
	const restarting = task.status === "in_progress" || task.status === "failed" || task.status === "interrupted";
	const prior = task.status;
	task.status = "in_progress";
	pushEvent(s, "task_start", restarting ? `task ${task.id}: ${task.title} (restarted from ${prior})` : `task ${task.id}: ${task.title}`);
	const done = s.tasks.filter((t) => t.status === "done").length;
	return {
		state: s,
		message:
			`Started task ${task.id}/${s.tasks.length} (${done} done). ` +
			`Sequential mode: ${s.approvals.sequential ? "on — continue through ready tasks until all are done or a task fails verification" : "off — stop after this task and wait for /rpac act"}.`,
	};
}

function collectIssues(verification: VerificationCheck[], deviations?: string[]): string[] {
	const issues: string[] = [];
	for (const c of verification) {
		if (c.result !== "pass") {
			issues.push(`check "${c.name}" ${c.result}${c.detail ? `: ${c.detail}` : ""}`);
		}
	}
	for (const d of deviations ?? []) {
		if (typeof d === "string" && d.trim()) issues.push(`deviation: ${d.trim()}`);
	}
	return issues;
}

/**
 * Mark a task complete. Verification is mandatory: at least one check, and
 * every check must be `pass` for the task to become `done`. A failing or
 * unavailable check leaves the task `failed` with the checks recorded — a
 * resumable, non-done outcome — unless the user later runs
 * `/rpac accept <id> <reason>` to accept a documented exception.
 */
export function taskDone(
	s: RpacState,
	ref: number | string,
	verification: VerificationCheck[],
	deviations?: string[],
): MachineResult {
	requirePhase(s, ["act"], "task_done");
	requireNotPaused(s, "to finish a task");
	if (!Array.isArray(verification) || verification.length === 0) {
		throw new RpacGuardError(
			"task_done requires verification: at least one check (name + result). A task must not be marked complete because code was generated — run the applicable checks and report them (result: pass|fail|unavailable).",
		);
	}
	const task = s.tasks.find((t) => (typeof ref === "number" ? t.id === ref : t.id === Number(ref)));
	if (!task) throw new RpacGuardError(`no task with id ${String(ref)}`);
	if (task.status === "done") throw new RpacGuardError(`task ${task.id} is already done`);
	if (task.status === "blocked") {
		throw new RpacGuardError(`task ${task.id} is blocked — use task_unblock after resolving the blocker`);
	}
	if (task.status !== "in_progress") {
		throw new RpacGuardError(`task ${task.id} is ${task.status}, not in_progress — start it first (task_start)`);
	}
	const issues = collectIssues(verification, deviations);
	const failures = verification.filter((c) => c.result !== "pass");
	task.verification = verification;

	if (failures.length > 0) {
		task.status = "failed";
		task.issues = issues;
		pushEvent(s, "task_failed", `task ${task.id}: ${issues.join("; ")}`);
		const remaining = s.tasks.filter((t) => t.status !== "done");
		return {
			state: s,
			message:
				`Task ${task.id}/${s.tasks.length} is FAILED (not done): ${issues.join("; ")}. ` +
				`A failed check does not count as completion. Fix the problem and re-run with /rpac act ${task.id}, ` +
				`or ask the user to accept a documented exception: /rpac accept ${task.id} <reason>.` +
				(remaining.length === 1 ? " No other task remains open." : ""),
			stopSequential: true,
		};
	}

	task.status = "done";
	task.doneAt = nowIso();
	if (issues.length > 0) {
		task.issues = issues;
		pushEvent(s, "task_issues", `task ${task.id}: ${issues.join("; ")}`);
	}
	pushEvent(s, "task_done", `task ${task.id} done (${verification.map((c) => c.result).join("/")})`);
	addCheckpoint(s, `task ${task.id} complete: ${task.title}`);

	const remaining = s.tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
	let message = `Task ${task.id}/${s.tasks.length} complete${issues.length ? ` — reported: ${issues.join("; ")}` : ""}.`;
	if (remaining.length === 0) {
		message += " All tasks complete. Run /rpac consolidate to verify the outcome and write the report.";
	} else if (s.approvals.sequential) {
		message += " Continue with the next ready task.";
	} else {
		message += " Stop and wait for /rpac act (or /rpac act --sequential) before the next task.";
	}
	return { state: s, message };
}

/**
 * Mark the in-progress task failed with an explicit reason (the model could
 * not complete it, or verification failed). Verification may be included.
 */
export function taskFail(s: RpacState, ref: number | string, reason: string, verification?: VerificationCheck[]): MachineResult {
	requirePhase(s, ["act"], "task_fail");
	requireNotPaused(s, "to update task status");
	if (!reason || !reason.trim()) throw new RpacGuardError("task_fail requires a reason");
	const task = s.tasks.find((t) => (typeof ref === "number" ? t.id === ref : t.id === Number(ref)));
	if (!task) throw new RpacGuardError(`no task with id ${String(ref)}`);
	if (task.status === "done") throw new RpacGuardError(`task ${task.id} is already done`);
	if (task.status === "blocked") throw new RpacGuardError(`task ${task.id} is blocked — use task_unblock after resolving the blocker`);
	if (task.status !== "in_progress") {
		throw new RpacGuardError(`task ${task.id} is ${task.status}, not in_progress`);
	}
	const issues: string[] = [`failed: ${reason.trim()}`];
	for (const c of verification ?? []) {
		if (c.result !== "pass") issues.push(`check "${c.name}" ${c.result}${c.detail ? `: ${c.detail}` : ""}`);
	}
	task.status = "failed";
	if (verification && verification.length > 0) task.verification = verification;
	task.issues = issues;
	pushEvent(s, "task_failed", `task ${task.id}: ${reason.trim()}`);
	return {
		state: s,
		message:
			`Task ${task.id} is FAILED: ${reason.trim()}. ` +
			`Resolve the problem and re-run with /rpac act ${task.id}, or have the user accept a documented exception: /rpac accept ${task.id} <reason>.`,
		stopSequential: true,
	};
}

/**
 * User-only (called from /rpac accept): convert a failed task to done with a
 * documented exception. This is the ONLY way non-passing checks become part
 * of a completed workflow.
 */
export function taskAccept(s: RpacState, ref: number | string, reason: string): MachineResult {
	if (!reason || !reason.trim()) {
		throw new RpacGuardError("accept requires a documented reason (what was accepted and why it is acceptable)");
	}
	const task = s.tasks.find((t) => (typeof ref === "number" ? t.id === ref : t.id === Number(ref)));
	if (!task) throw new RpacGuardError(`no task with id ${String(ref)}`);
	if (task.status === "done") throw new RpacGuardError(`task ${task.id} is already done`);
	if (task.status !== "failed") {
		throw new RpacGuardError(`task ${task.id} is ${task.status}; only failed tasks can be accepted with a documented exception`);
	}
	task.status = "done";
	task.doneAt = nowIso();
	task.acceptedException = reason.trim();
	task.issues = [...(task.issues ?? []), `accepted exception: ${reason.trim()}`];
	pushEvent(s, "task_accepted", `task ${task.id} accepted with documented exception: ${reason.trim()}`);
	addCheckpoint(s, `task ${task.id} accepted with exception: ${truncate(reason.trim(), 120)}`);
	return {
		state: s,
		message: `Task ${task.id} accepted as done with a documented exception: ${reason.trim()}`,
	};
}

/** Mark a task blocked (prerequisite unmet or contradicted by the codebase). */
export function taskBlock(s: RpacState, ref: number | string, reason: string): MachineResult {
	requirePhase(s, ["act"], "task_block");
	requireNotPaused(s, "to update task status");
	const task = s.tasks.find((t) => t.id === (typeof ref === "number" ? ref : Number(ref)));
	if (!task) throw new RpacGuardError(`no task with id ${String(ref)}`);
	if (!reason || !reason.trim()) throw new RpacGuardError("task_block requires a reason");
	if (task.status === "done") throw new RpacGuardError(`task ${task.id} is already done`);
	task.status = "blocked";
	pushEvent(s, "task_blocked", `task ${task.id} blocked: ${reason.trim()}`);
	return {
		state: s,
		message: `Task ${task.id} marked blocked: ${reason.trim()}. Resolve the blocker, then retry (task_unblock, then /rpac act ${task.id}).`,
		stopSequential: true,
	};
}

/** Re-open a blocked/failed/interrupted/pending task (e.g. after a blocker was resolved). */
export function taskUnblock(s: RpacState, ref: number | string): MachineResult {
	requirePhase(s, ["act"], "task_unblock");
	requireNotPaused(s, "to update task status");
	const task = s.tasks.find((t) => t.id === (typeof ref === "number" ? ref : Number(ref)));
	if (!task) throw new RpacGuardError(`no task with id ${String(ref)}`);
	if (task.status === "done") throw new RpacGuardError(`task ${task.id} is done`);
	task.status = "pending";
	pushEvent(s, "task_unblocked", `task ${task.id} re-opened`);
	return { state: s, message: `Task ${task.id} re-opened.` };
}

/** Record a decision (appended to log.md by the caller). */
export function decision(s: RpacState, text: string): MachineResult {
	if (s.phase === "done" || s.phase === "aborted") {
		throw new RpacGuardError(`workflow is ${s.phase} — no further decisions`);
	}
	if (!text || !text.trim()) throw new RpacGuardError("decision requires text");
	pushEvent(s, "decision", text.trim());
	return { state: s, message: "Decision recorded." };
}

/** Record a deviation from the approved plan (appended to log.md by the caller). */
export function deviation(s: RpacState, text: string): MachineResult {
	if (s.phase === "done" || s.phase === "aborted") {
		throw new RpacGuardError(`workflow is ${s.phase} — no further deviations`);
	}
	if (!text || !text.trim()) throw new RpacGuardError("deviation requires text");
	pushEvent(s, "deviation", text.trim());
	return { state: s, message: "Deviation recorded in log." };
}

/** Record an explicit checkpoint. */
export function checkpoint(s: RpacState, what: string, head?: string): MachineResult {
	if (!what || !what.trim()) throw new RpacGuardError("checkpoint requires text");
	addCheckpoint(s, what.trim(), head);
	return { state: s, message: "Checkpoint recorded." };
}

function addCheckpoint(s: RpacState, what: string, head?: string): void {
	s.checkpoints.push({ at: nowIso(), what, ...(head ? { head } : {}) });
	if (s.checkpoints.length > MAX_CHECKPOINTS) s.checkpoints.splice(0, s.checkpoints.length - MAX_CHECKPOINTS);
}

/**
 * An in-progress task whose execution cycle ended without completion
 * (session/agent run over) becomes `interrupted` — a resumable outcome that
 * is reported honestly instead of pretending progress.
 */
export function markInterrupted(s: RpacState): MachineResult {
	const task = s.tasks.find((t) => t.status === "in_progress");
	if (!task) return { state: s, message: "no in-progress task" };
	task.status = "interrupted";
	pushEvent(s, "task_interrupted", `task ${task.id} interrupted: ${task.title}`);
	return {
		state: s,
		message: `Task ${task.id} interrupted (run ended mid-task). It is resumable — /rpac act ${task.id} or /rpac resume.`,
	};
}

/** Model finished consolidation. Requires the report artifact. */
export function consolidateComplete(s: RpacState, reportPath: string, summary?: string, relPath = "report.md"): MachineResult {
	requirePhase(s, ["consolidate"], "consolidate_complete");
	requireNotPaused(s, "to finish consolidation");
	const res = refreshArtifact(s, "report", reportPath, relPath);
	if (res === "absent") {
		throw new RpacGuardError(`report not found at ${reportPath}. Write the completion report there first.`);
	}
	s.phase = "done";
	pushEvent(s, "phase", `consolidate → done${summary ? `: ${summary}` : ""}`);
	return {
		state: s,
		message: "Workflow complete. Completion report written. Review it, then commit or discard at your discretion.",
	};
}

/** Pause further execution (overlay; reversible). */
export function pause(s: RpacState): MachineResult {
	if (s.phase === "done" || s.phase === "aborted") throw new RpacGuardError(`workflow is ${s.phase}`);
	s.paused = true;
	pushEvent(s, "pause", "workflow paused");
	return { state: s, message: "Workflow paused. /rpac resume to continue." };
}

/** Resume after pause. */
export function resume(s: RpacState): MachineResult {
	if (!s.paused) return { state: s, message: "Workflow is not paused." };
	s.paused = false;
	pushEvent(s, "resume", "workflow resumed");
	return { state: s, message: `Workflow resumed (phase: ${s.phase}).` };
}

/** Abort: stops the workflow safely; artifacts and state are preserved. */
export function abort(s: RpacState, reason?: string): MachineResult {
	if (s.phase === "done" || s.phase === "aborted") throw new RpacGuardError(`workflow is already ${s.phase}`);
	s.phase = "aborted";
	s.paused = false;
	pushEvent(s, "abort", reason?.trim() ? `aborted: ${reason.trim()}` : "aborted by user");
	return {
		state: s,
		message:
			`Workflow aborted. All files under .pi/rpac/${s.id}/ (requirements, plan, log, state) are preserved. ` +
			`No code changes were reverted. Run /rpac start <task> to begin a new workflow.`,
	};
}

/**
 * Go back from consolidate to act: creates a concrete repair task for the
 * problem found, so `/rpac act` has something executable to run.
 */
export function backToAct(s: RpacState, reason: string): MachineResult {
	requirePhase(s, ["consolidate"], "back to act");
	if (!reason || !reason.trim()) throw new RpacGuardError("back_to_act requires the problem found");
	const nextId = s.tasks.reduce((m, t) => Math.max(m, t.id), 0) + 1;
	const repair: RpacTask = { id: nextId, title: `Repair: ${truncate(reason.trim(), 80)}`, status: "pending" };
	s.tasks.push(repair);
	s.phase = "act";
	pushEvent(s, "phase", `consolidate → act: ${reason.trim()}`);
	return {
		state: s,
		message:
			`Back in act phase. Repair task ${nextId} created ("${repair.title}"). ` +
			`Run /rpac act ${nextId} (or the model will pick it up as the next ready task), fix the problem with verification, then /rpac consolidate again.`,
	};
}

/**
 * Go back from act/consolidate to plan (the plan itself was wrong).
 * Completed tasks keep their status and verification evidence; the plan
 * approval is reset and the changed plan must be re-approved by the user.
 */
export function backToPlan(s: RpacState, reason: string): MachineResult {
	requirePhase(s, ["act", "consolidate"], "back to plan");
	if (!reason || !reason.trim()) throw new RpacGuardError("back_to_plan requires the problem found");
	s.phase = "plan";
	s.approvals.plan = false;
	s.artifacts.plan = undefined;
	s.tasks = s.tasks.map((t) => (t.status === "done" ? t : { ...t, status: "pending" as const, issues: undefined }));
	pushEvent(s, "phase", `→ plan (re-plan): ${reason.trim()}`);
	return {
		state: s,
		message:
			`Back in plan phase (plan approval reset; done tasks and their verification evidence kept, others re-opened). ` +
			`Fix the plan, then re-approve with /rpac approve plan.`,
	};
}
