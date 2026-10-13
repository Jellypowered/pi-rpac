// RPAC phase directives — the short user messages that drive each phase — and
// the tiny per-turn phase context injected by before_agent_start.
//
// Directives are sent once when a phase command runs; they name the exact
// (absolute) artifact path and the matching lazily-loaded skill. Behavioral
// detail lives in the skills; everything durable lives in .pi/rpac/.
// The per-turn context block is deliberately minimal (a few lines, no
// artifact content) so normal conversation stays reliable and cheap.

import type { RpacState } from "./schema.ts";
import { relWorkflowArtifactPath, artifactFile } from "./paths.ts";
import { join } from "node:path";

export function refineDirective(task: string, requirementsAbs: string, notes?: string): string {
	const extra = notes?.trim() ? `\nAdditional user notes: ${notes.trim()}` : "";
	return `RPAC · REFINE. Refine this task into a self-contained requirements document.

Task: ${task}
${extra}

Read and follow the \`rpac-refine\` skill (codebase inspection; what, not how; ask only what the code cannot answer — one question at a time with a recommendation).
Write the artifact to \`${requirementsAbs}\` — the only file you may write; REFINE is mechanically read-only (application edits and mutating shell commands are blocked).
When the requirements are ready, call the \`rpac\` tool with action "refine_complete" so the user can approve; do not change scope afterwards.`;
}

export function planDirective(task: string, planAbs: string, requirementsAbs: string, notes?: string): string {
	const extra = notes?.trim() ? `\nAdditional user notes: ${notes.trim()}` : "";
	return `RPAC · PLAN. Requirements are approved. Create the implementation plan.

Task: ${task}
Requirements: \`${requirementsAbs}\` (approved — do not change scope).
${extra}

Read and follow the \`rpac-plan\` skill. Write the plan to \`${planAbs}\` with a \`## Tasks\` section (checkbox list; each task: done-when + verification + deps). PLAN is mechanically read-only (application edits and mutating shell commands are blocked) — \`${planAbs}\` is the only file you may write.
Keep the plan small: a handful of meaningful tasks. When ready, call the \`rpac\` tool with action "plan_complete" and the task list (titles + dependsOn ids) so the user can approve it.`;
}

export function actDirective(
	task: string,
	taskId: number,
	taskTitle: string,
	sequential: boolean,
	planRel: string,
): string {
	return `RPAC · ACT. Execute the approved plan task${sequential ? " — sequential mode: continue through ready tasks until all are done or a task fails verification" : ""}.

Task: ${task}
Plan: \`${planRel}\` (approved). Task #${taskId}: ${taskTitle}

Read and follow the \`rpac-act\` skill. Task #${taskId} is already in progress under this execution lease — do not call \`task_start\` for it. Verify assumptions against the code first, make only the necessary changes, run the applicable checks/tests, report results honestly, and call the \`rpac\` tool with action "task_done" (verification required — a task is done only when its acceptance checks pass; audit observations may record subject failures without failing the task, and blocked work uses "task_block").
Do not expand scope. Do not commit/push. Record deviations with action "deviation".${sequential ? "" : " Stop after this task; the user runs /rpac act again for the next one."}`;
}

export function consolidateDirective(task: string, reportAbs: string, requirementsRel: string, planRel: string, logRel: string): string {
	return `RPAC · CONSOLIDATE. Implementation is complete. Verify the outcome against the requirements and write the completion report.

Task: ${task}
Requirements: \`${requirementsRel}\` · Plan: \`${planRel}\` · Decisions/deviations: \`${logRel}\`

Read and follow the \`rpac-consolidate\` skill. Compare the result against the acceptance criteria, review the actual git diff, run the final verification, and write \`${reportAbs}\` — identify genuine problems rather than declaring success. Do not commit or publish.
If you find a problem, call the \`rpac\` tool with action "back_to_act" (creates a repair task) or "back_to_plan" (the plan itself was wrong). When the report is written and the outcome is sound, call the \`rpac\` tool with action "consolidate_complete".`;
}

export function resumeDirective(task: string, phase: string, detail: string, stateRel: string): string {
	return `RPAC · RESUME. The workflow is in phase "${phase}".

Task: ${task}
${detail}

Continue from where the state files indicate (\`${stateRel}\` is the source of truth — re-verify against the repository before acting). Follow the phase instructions again: refine/plan/act/consolidate each has a \`rpac-*\` skill to read.`;
}

/**
 * Tiny per-turn context (injected via before_agent_start while a phase is
 * active). Pointers and rules only — never artifact content.
 */
export function phaseContext(state: RpacState, root: string): string | null {
	if (state.phase === "done" || state.phase === "aborted" || state.paused) return null;
	const wf = relWorkflowArtifactPath(root, state.id, "log");
	const reqAbs = artifactFile(root, state.id, "requirements");
	const planAbs = artifactFile(root, state.id, "plan");
	const reportAbs = artifactFile(root, state.id, "report");
	const done = state.tasks.filter((t) => t.status === "done").length;
	const taskPart = state.tasks.length > 0 ? ` tasks ${done}/${state.tasks.length} done` : "";
	switch (state.phase) {
		case "refine":
			return `[RPAC] phase=REFINE${taskPart} — task: "${state.task}"
Write requirements to ${reqAbs} (self-contained, what-not-how). REFINE is read-only: application edits and mutating shell commands are blocked.
When requirements are ready, call the rpac tool (refine_complete) and stop; the user runs /rpac plan.`;
		case "plan":
			return `[RPAC] phase=PLAN${taskPart} — task: "${state.task}"
Approved requirements: ${reqAbs}. Write the plan to ${planAbs} (with a ## Tasks list). PLAN is read-only: application edits and mutating shell commands are blocked.
When the plan is ready, call the rpac tool (plan_complete with the task list) and stop; the user runs /rpac act.`;
		case "act": {
			const current = state.tasks.find((t) => t.status === "in_progress");
			const cur = current ? ` current task #${current.id}: ${current.title}` : " no task started yet — the user runs /rpac act";
			return `[RPAC] phase=ACT${taskPart} — task: "${state.task}"${cur}
Plan: ${planAbs}. Verify with real checks and report via the rpac tool: task_done (all checks must pass for done; failures → task_fail), task_block when stuck.
${state.approvals.sequential ? "Sequential mode: continue through ready tasks until all are done or one fails." : "One task per run: stop after reporting the task outcome."}`;
		}
		case "consolidate":
			return `[RPAC] phase=CONSOLIDATE${taskPart} — task: "${state.task}"
Compare the result to ${relWorkflowArtifactPath(root, state.id, "requirements")}, review the git diff, run final checks, write ${reportAbs}.
Genuine problems → rpac back_to_act / back_to_plan; otherwise rpac consolidate_complete. Log: ${wf}`;
		default:
			return null;
	}
}
