// Human-facing summaries. Machine results, diagnostics and saved evidence stay intact.
import type { RpacState } from "./schema.ts";
import { reviewCoverage } from "./machine.ts";

/** Custom voices affect model prose; deterministic milestones use Natural. */
export function progressMessage(phase: "refine" | "plan" | "act" | "consolidate", style = "natural"): string {
	const voices: Record<string, string[]> = {
		natural: ["I'll look into the task and clarify what needs to change. No application files will be changed in this step.", "The requirements are approved. I'll prepare a plan for you to review before implementation.", "I'm starting the approved task. I'll check the result before calling it done.", "I'll check the overall result and write the report, including any problems or limits."],
		chill: ["Let's see what needs changing. No application edits in this step.", "Requirements approved. Next up: a plan for your review.", "Time to work on the approved task, then check it.", "Time for the final checks and an honest wrap-up."],
		"critical-natural": ["I'll inspect the evidence and separate requirements from assumptions. Application edits stay blocked.", "Requirements approved. I'll build a plan with checks that can expose failures.", "I'll carry out the approved task and test its claims. Unverified work won't count as done.", "I'll check the outcome against the requirements and report defects and unverified claims."],
		teacher: ["I'll first clarify the goal by inspecting the project. Keeping application files unchanged now helps us agree on the right problem.", "The requirements are approved. Next I'll plan the work and its checks, so you can review how we'll reach the goal.", "I'll work on the approved task, then run checks. These help us see whether the change behaves as expected.", "I'll check the whole result against the goal. The report will explain what passed and what still needs attention."],
		technical: ["REFINE: inspect repository contracts and write requirements; application mutations remain blocked.", "PLAN: requirements approved; prepare tasks, dependencies and verification for user approval.", "ACT: execute the approved task under an exclusive execution lease; acceptance verification is mandatory.", "CONSOLIDATE: verify acceptance criteria, review the diff and record final check results and limitations."],
		eli5: ["I'll look at the project and work out what needs to change. I won't change the app in this step.", "You approved the goal. I'll make a plan for you to check next.", "I'll do the approved task. Then I'll check that it works.", "I'll check the work as a whole. I'll write down what worked and what did not."],
	};
	return (voices[style] ?? voices.natural)[["refine", "plan", "act", "consolidate"].indexOf(phase)];
}
export function nextStep(state: RpacState): string {
	if (state.phase === "done") return "Read the saved report before deciding what to do with the changes. RPAC has not committed or published them.";
	if (state.phase === "aborted") return "The workflow has stopped. Saved evidence and code changes remain. Use /rpac start <task> for new work.";
	if (state.paused) return "Work is paused. Run /rpac resume when you're ready to continue.";
	if (state.phase === "refine") return "When the requirements are ready, run /rpac plan to review them and approve planning.";
	if (state.phase === "plan") return state.approvals.plan ? "The plan is approved. Run /rpac act to start a task." : "Review the plan before approving it. Run /rpac approve plan once it has been finalized.";
	if (state.phase === "consolidate") return "This step checks the whole result and writes the report, including failures and limits. If the run stopped, use /rpac resume to continue.";
	if (state.tasks.some((task) => task.status === "in_progress")) return "A task is running. Wait for its checks and result before starting another.";
	if (state.tasks.length && state.tasks.every((task) => task.status === "done")) return "Run /rpac consolidate to check the whole result and write the report.";
	if (state.tasks.some((task) => task.status === "blocked")) return "Some work is blocked. Resolve the listed prerequisite and ask the model to unblock the task before retrying.";
	const retry = state.tasks.find((task) => task.status === "failed" || task.status === "interrupted");
	if (retry) return `Task ${retry.id} is ${retry.status}. Resolve any reported problem, then run /rpac act ${retry.id} to retry it. Failed checks do not count as completion.`;
	return "Run /rpac act to run the next ready task. Failed checks do not count as completion.";
}
export function statusOpening(state: RpacState, style = "natural"): string {
	const phases: Record<string, string> = { refine: "clarifying the goal", plan: "preparing the plan", act: "working through the tasks", consolidate: "checking the overall result", done: "complete", aborted: "stopped" };
	const title = style === "technical" ? `Phase: ${state.phase}${state.paused ? " (PAUSED)" : ""}` : `RPAC is ${phases[state.phase]}${state.paused ? " (paused)" : ""}.`;
	const failed = state.tasks.filter((task) => task.status === "failed").length;
	return `${title}${failed ? ` ${failed} task(s) failed verification; they are not done.` : ""}\n${nextStep(state)}`;
}
/** A separate human view, not a filtered copy of the technical status report. */
export function conversationalStatus(state: RpacState, style = "natural"): string {
	const review = state.review;
	const coverage = review ? reviewCoverage(state) : null;
	const ended = state.phase === "done" || state.phase === "aborted";
	const phases: Record<string, string> = review
		? { refine: "working out what to review", plan: "planning the review", act: "working through the review", consolidate: "checking the review evidence", done: "finished with the review workflow", aborted: "no longer working on this review" }
		: { refine: "clarifying the goal", plan: "preparing the plan", act: "working through the approved plan", consolidate: "checking the overall result", done: "finished with this workflow", aborted: "no longer working on this task" };
	const heading = state.paused ? "RPAC is paused." : `RPAC is ${phases[state.phase]}.`;
	const lines = [heading];
	if (!review) lines.push(`Goal: ${state.task}`);
	const done = state.tasks.filter((task) => task.status === "done").length;
	if (state.tasks.length) lines.push(state.tasks.length === 1
		? (done ? "The task is finished." : "The task is not finished.")
		: `${done} of ${state.tasks.length} tasks are finished.${done < state.tasks.length ? " The remaining work is not complete." : ""}`);
	const failed = state.tasks.filter((task) => task.status === "failed").length;
	const blocked = state.tasks.filter((task) => task.status === "blocked").length;
	const interrupted = state.tasks.filter((task) => task.status === "interrupted").length;
	if (failed) lines.push(`${failed} ${failed === 1 ? "task failed and is" : "tasks failed and are"} not complete.`);
	if (blocked) lines.push(`${blocked} ${blocked === 1 ? "task is" : "tasks are"} blocked and cannot continue yet.`);
	if (interrupted) lines.push(`${interrupted} ${interrupted === 1 ? "task stopped before finishing and still needs" : "tasks stopped before finishing and still need"} to be checked.`);
	const checks = state.tasks.flatMap((task) => task.verification ?? []);
	const failedChecks = checks.filter((check) => check.result === "fail").length;
	const unavailable = checks.filter((check) => check.result === "unavailable").length;
	if (failedChecks) lines.push(`${failedChecks} recorded ${failedChecks === 1 ? "check failed" : "checks failed"}.`);
	if (unavailable) lines.push(`${unavailable} recorded ${unavailable === 1 ? "check is" : "checks are"} unavailable; those results are unverified.`);
	if (state.tasks.some((task) => task.status === "done" && !task.verification?.length)) lines.push("Some finished tasks have no saved checks, so their results are unverified.");
	if (state.tasks.some((task) => task.acceptedException)) lines.push("Some tasks were accepted with an exception. That does not mean every check passed.");
	if (state.tasks.some((task) => task.issues?.length)) lines.push("Read the recorded issues or deviations in the details before relying on the result.");
	if (coverage) {
		lines.push(`The saved review evidence covers ${coverage.covered} of ${coverage.total} items.${coverage.uncovered.length ? ` ${coverage.uncovered.length} ${coverage.uncovered.length === 1 ? "item still needs" : "items still need"} review, so the assessment is incomplete.` : ""}`);
		if (review!.drift) lines.push("The files or review conditions changed, or could not be verified, during the review (review drift). Earlier results cannot be trusted for the affected parts. This is not a clean review.");
		if (done === state.tasks.length && state.tasks.length) lines.push("Finished review tasks alone do not establish a complete or successful assessment.");
		lines.push("This is a review, not approval or a guarantee that no problems remain.");
	}
	let next = nextStep(state);
	if (state.phase === "done") next = review ? "Read the saved review results and limitations before relying on them. No fixes or GitHub approval were made by this review." : "Review the saved results before deciding what to do with the changes. RPAC has not committed or published them.";
	if (coverage && !coverage.complete && ended) {
		const restart = review!.pr ? `/rpac start preview ${review!.pr.number}` : "/rpac review";
		next += ` For a new assessment of the remaining work, start another review with ${restart}.`;
	} else if (!ended && !state.paused && coverage && !coverage.complete && state.tasks.length && done === state.tasks.length && (state.phase === "act" || state.phase === "consolidate")) {
		next = "Ask the model to revisit the review plan for the missing or changed evidence, or finish with an explicitly incomplete report. Do not treat it as a complete assessment.";
	} else if (!ended && !state.paused && state.phase === "act" && state.tasks.some((task) => task.status === "in_progress")) {
		next = "A task is marked as underway. Wait for the current run to finish; if it stopped, use /rpac resume.";
	} else if (!ended && !state.paused && state.phase === "act" && blocked) {
		next = "Read the blocker in the details, resolve it, then ask the model to unblock the task before retrying.";
	}
	if (!ended && !state.paused && state.phase === "act" && !blocked && !state.tasks.some((task) => task.status === "in_progress")) {
		const retry = state.tasks.find((task) => task.status === "failed" || task.status === "interrupted");
		if (retry) next = `Resolve the reported problem, then run /rpac act ${retry.id} to retry the task.`;
	}
	if (style === "eli5") next = `Next: ${next}`;
	lines.push(next);
	return lines.join("\n\n");
}

export function humanError(diagnostic: string): string {
	if (/cannot approve thin|no requirements artifact/.test(diagnostic)) return "The requirements or plan are not ready for approval yet. Ask the model to finish the document first.\n" + diagnostic;
	if (/changed after it was finalized/.test(diagnostic)) return "The document changed after it was prepared for approval. Please review the updated version; the model must finalize it again before you approve.\n" + diagnostic;
	if (/review snapshot drift|affected coverage is incomplete/.test(diagnostic)) return "Some files changed during the review, so the earlier results no longer cover all of them. Those parts need another look (review drift).\n" + diagnostic;
	if (/requires the ACT execution lease/.test(diagnostic)) return "Execution hasn't been started for this task. The user must run /rpac act or /rpac resume before the model can update its result.\n" + diagnostic;
	// Preserve the original diagnostic, never guess a state-changing recovery command.
	return diagnostic + (/\/rpac |retry|first|before|resolve|run |use /i.test(diagnostic) ? "" : "\nRun /rpac status to check where the workflow stopped before trying again.");
}
export function approvalExplanation(what: "requirements" | "plan", review: boolean): string {
	return what === "requirements"
		? "Please read the requirements first. Approval agrees on the goal and allows planning, not implementation. You can decline and ask for changes."
		: `Please read the plan and its checks first. Approval allows ${review ? "only the report-only review and its listed checks; reviewed files stay read-only" : "the listed implementation tasks"}. You can decline and ask for changes.`;
}
