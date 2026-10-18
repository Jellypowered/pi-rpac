/**
 * RPAC (Refine → Plan → Act → Consolidate) — native Pi extension.
 *
 * One slash command namespace (/rpac), one model-facing tool (rpac), durable
 * human-readable per-workflow state under .pi/rpac/. See DESIGN.md and
 * README.md.
 *
 * Safety model:
 *  - REFINE/PLAN are mechanically read-only (tool_call gate: only the exact
 *    phase artifact is writable; bash is fail-closed read-only).
 *  - Approvals (requirements, plan, sequential) are user-only.
 *  - Destructive operations (replace/abort/cleanup/force) require an explicit
 *    user action: a TUI confirm dialog, or the --yes/--force flag headless.
 *  - A real exclusive lock guards every state mutation (load → validate →
 *    mutate → atomic save under lock); a separate ACT execution lease is
 *    held for the complete model execution cycle so two Pi processes cannot
 *    execute tasks at the same time.
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Type, type Static } from "typebox";

import {
	type RpacState,
	type ReviewMode,
	type PrReviewMeta,
	REVIEW_MODES,
	PR_REVIEW_MODE,
	RpacStateError,
	newReviewState,
	newState,
	isSubstantive,
} from "../lib/schema.ts";
import {
	RpacGuardError,
	abort as mAbort,
	approvePlan,
	approveRequirements,
	approveSequential,
	backToAct,
	backToPlan,
	consolidateComplete,
	decision as mDecision,
	deviation as mDeviation,
	markInterrupted,
	pause as mPause,
	planComplete,
	readyTasks,
	recordEvent,
	recordReviewDrift,
	refineComplete,
	replaceReviewScope,
	reviewCoverage,
	resume as mResume,
	taskAccept,
	taskBlock,
	taskDone,
	taskFail,
	taskStart,
	taskUnblock,
} from "../lib/machine.ts";
import {
	appendLog,
	createWorkflow,
	loadActive,
	listWorkflows,
	noteArtifact,
	removeAll,
	switchActive,
	updateActive,
	peekActive,
	LEASE_NAME,
	type ArtifactWhich,
} from "../lib/store.ts";
import { RpacLockError, acquireLock, isPidAlive, readLockRecord, refreshLock, releaseLock, holdsLock } from "../lib/lock.ts";
import { captureBaseline, detectDivergence, gitInfo } from "../lib/git.ts";
import { runGitText } from "../lib/review.ts";
import { captureReviewSnapshot, compareReviewSnapshots, type ReviewExclusion, type ReviewSnapshot } from "../lib/review.ts";
import {
	assessPrCheckout,
	buildPrMeta,
	capturePrSnapshot,
	defaultGhRunner,
	performPrCheckout,
	prWorktreePath,
	prRestoreCommand,
	removePrWorktree,
	selectPrRemote,
	assertPrCheckout,
	resolvePrMeta,
	verifyGitObjects,
	type GhRunner,
	type PrReviewSnapshot,
	type ResolvedPr,
} from "../lib/pr.ts";
import {
	artifactFile,
	relArtifactPath,
	relWorkflowArtifactPath,
	reviewBatchFile,
	reviewManifestFile,
	reviewReportFile,
	workflowDir,
} from "../lib/paths.ts";
import { gateToolCall, gateUnreadableState, hasPrCheckDirectory, isApprovedReviewCheck, prCheckPrefix } from "../lib/gating.ts";
import { atomicWriteFile, nowIso, projectRoot, sha256File } from "../lib/util.ts";
import {
	actDirective,
	consolidateDirective,
	phaseContext,
	planDirective,
	refineDirective,
	resumeDirective,
	reviewActDirective,
	reviewConsolidateDirective,
	reviewPlanDirective,
	reviewRefineDirective,
	prRefineDirective,
	prPlanDirective,
	prActDirective,
	prConsolidateDirective,
	type PrPromptMeta,
} from "../lib/prompts.ts";

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

/** Minimal UI surface used for status/footer refresh + notifications. */
interface UiMin {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, content: string[] | undefined): void;
}

function rootOf(cwd: string): string {
	return projectRoot(cwd);
}

function describeState(s: RpacState): string {
	const done = s.tasks.filter((t) => t.status === "done").length;
	const taskPart = s.tasks.length > 0 ? ` ${done}/${s.tasks.length}` : "";
	const paused = s.paused ? " ⏸" : "";
	const approval =
		!s.approvals.requirements && s.phase === "plan"
			? " ·req?"
			: !s.approvals.plan && (s.phase === "plan" || s.phase === "act")
				? " ·plan?"
				: "";
	const kind =
		s.workflowKind === "review"
			? s.review?.mode === "pr" && s.review.pr
				? `review:pr#${s.review.pr.number} `
				: `review:${s.review?.mode ?? "?"} `
				: "";
	return `◆ ${kind}${s.phase}${taskPart}${paused}${approval}`;
}

/**
 * Refresh footer status + task widget from disk state.
 * Cheap and idempotent; safe to call after any mutation.
 */
function refreshUI(ui: UiMin, root: string): void {
	let state: RpacState | null = null;
	try {
		({ state } = loadActive(root, root));
	} catch {
		ui.setStatus("rpac", "◆ rpac: state error (run /rpac status)");
		return;
	}
	if (!state) {
		ui.setStatus("rpac", undefined);
	} else {
		ui.setStatus("rpac", describeState(state));
	}
	if (state && (state.phase === "act" || state.phase === "consolidate") && state.tasks.length > 0) {
		const lines = state.tasks.slice(0, 12).map((t) => {
			const mark =
				t.status === "done" ? "✓"
					: t.status === "in_progress" ? "▶"
					: t.status === "blocked" ? "⊘"
					: t.status === "failed" ? "✗"
					: t.status === "interrupted" ? "⏸"
					: "·";
			return `${mark} ${t.id}. ${t.title.length > 40 ? t.title.slice(0, 39) + "…" : t.title}`;
		});
		if (state.tasks.length > 12) lines.push(`… ${state.tasks.length - 12} more`);
		ui.setWidget("rpac-tasks", lines);
	} else {
		ui.setWidget("rpac-tasks", undefined);
	}
}

/**
 * Clear the RPAC UI (footer + widget) without touching disk. Use after
 * removing all state — refreshUI would re-read state and (via lock
 * acquisition) recreate the empty .pi/rpac directory.
 */
function clearUI(ui: UiMin): void {
	ui.setStatus("rpac", undefined);
	ui.setWidget("rpac-tasks", undefined);
}

function fail(ui: UiMin, err: unknown, fallback: string): void {
	const msg = err instanceof Error ? err.message : fallback;
	ui.notify(`RPAC: ${msg}`, "error");
}

function reportNotes(ui: UiMin, notes: string[]): void {
	for (const n of notes) ui.notify(`RPAC: ${n}`, "warning");
}

/** Format a full status report (used by /rpac and /rpac status). */
function statusReport(root: string): string {
	const { index, state, notes } = loadActive(root, root);
	const lines: string[] = [];
	lines.push(`RPAC state: .pi/rpac/ (project root ${root})`);
	for (const n of notes) lines.push(`Note: ${n}`);
	if (!state) {
		const others = Object.values(index.workflows);
		if (others.length > 0) {
			lines.push("No active workflow. Saved workflows:");
			for (const w of others.slice(0, 10)) lines.push(`  ${w.id} — ${w.phase} — ${w.task} (${w.updatedAt})`);
			lines.push(`Resume one with:  /rpac resume <id>   (list: /rpac list)`);
		} else {
			lines.push("No active workflow. Start one with:  /rpac start <task description>");
		}
		return lines.join("\n");
	}
	lines.push(`Active workflow ${state.id} — ${state.workflowKind}${state.review ? ` (${state.review.mode})` : ""} — ${state.task}`);
	lines.push(
		`Phase: ${state.phase}${state.paused ? " (PAUSED)" : ""}   Approvals: req=${state.approvals.requirements ? "✓" : "·"} plan=${state.approvals.plan ? "✓" : "·"} sequential=${state.approvals.sequential ? "✓" : "·"}`,
	);
	const done = state.tasks.filter((t) => t.status === "done").length;
	if (state.tasks.length > 0) {
		lines.push(`Tasks: ${done}/${state.tasks.length} done. Ready: ${readyTasks(state).join(", ") || "—"}`);
		for (const t of state.tasks) {
			const mark =
				t.status === "done" ? "✓"
					: t.status === "in_progress" ? "▶"
					: t.status === "blocked" ? "⊘"
					: t.status === "failed" ? "✗"
					: t.status === "interrupted" ? "⏸"
					: "·";
			const issue = t.issues?.length ? `  ⚠ ${t.issues.join("; ")}` : "";
			lines.push(`  ${mark} ${t.id}. [${t.status}] ${t.title}${issue}`);
			for (const artifact of t.deliverables ?? []) lines.push(`      deliverable → ${artifact.path} (${artifact.sha256.slice(0, 8)}…)`);
		}
	}
	for (const key of ["requirements", "plan", "report", "handoff", "reviewManifest"] as const) {
		const art = state.artifacts[key];
		if (art) lines.push(`Artifact: ${key} → ${art.path} (${art.sha256.slice(0, 8)}…)`);
	}
	if (state.review) {
		const coverage = reviewCoverage(state);
		lines.push(
			`Review: ${state.review.mode} on ${state.review.head.slice(0, 12)}; fingerprint ${state.review.fingerprint.slice(0, 12)}…; coverage ${coverage.covered}/${coverage.total}; uncovered ${coverage.uncovered.length}${state.review.drift ? "; DRIFT DETECTED" : ""}`,
		);
		if (state.review.pr) {
			const pr = state.review.pr;
			lines.push(`PR: #${pr.number} ${pr.url} (${pr.state}${pr.crossRepository ? ", fork" : ""})`);
			lines.push(`PR scope: base ${pr.baseRef} @ ${pr.baseSha.slice(0, 8)} → head ${pr.headRef} @ ${pr.headSha.slice(0, 8)}; repo ${pr.repository}`);
			lines.push(`PR checkout: ${pr.checkoutStrategy} @ ${pr.checkoutLocation}`);
			if (state.phase !== "done" && state.phase !== "aborted") {
				if (pr.checkoutStrategy === "in-place") {
					lines.push(`PR restore: to return to the pre-review branch run \`${prRestoreCommand(pr)}\` (original HEAD ${pr.originalHead.slice(0, 8)}). RPAC never auto-restores (it could overwrite new work).`);
				} else {
					lines.push(`PR cleanup: remove the isolated worktree with \`/rpac pr-cleanup\` (refuses dirty, unowned, or changed worktrees). The main worktree was not touched.`);
				}
			}
		}
	}
	for (const note of stalenessNotes(root, state).filter((n) => !n.startsWith("git:"))) lines.push(`Stale: ${note}`);
	if (state.baseline) {
		const div = detectDivergence(root, state.baseline);
		lines.push(`Git: ${state.baseline.branch || "(detached)"} @ ${state.baseline.head.slice(0, 8)} (baseline ${state.baseline.dirty.length} dirty) — ${div.summary}`);
	}
	const lease = readLockRecord(root, LEASE_NAME);
	if (lease && isPidAlive(lease.pid)) {
		lines.push(`ACT lease: task ${lease.taskId ?? "?"} executing (pid ${lease.pid})`);
	}
	const recent = state.events.slice(-5);
	if (recent.length > 0) {
		lines.push("Recent:");
		for (const e of recent) lines.push(`  ${e.at} ${e.kind}: ${e.detail}`);
	}
	const others = Object.values(index.workflows).filter((w) => w.id !== state.id);
	if (others.length > 0) {
		lines.push(`Other saved workflows: ${others.map((w) => `${w.id} (${w.phase})`).join(", ")} — /rpac list`);
	}
	return lines.join("\n");
}

/** Validate and hash task-produced files before they become durable workflow evidence. */
function captureDeliverables(root: string, paths: string[] | undefined) {
	if (!paths?.length) return undefined;
	const captured = [];
	const seen = new Set<string>();
	for (const value of paths) {
		if (!value.trim()) throw new RpacGuardError("deliverable paths must not be empty");
		const abs = resolve(isAbsolute(value) ? value : join(root, value));
		const rel = relative(root, abs);
		if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
			throw new RpacGuardError(`deliverable must be a file inside the project: ${value}`);
		}
		if (seen.has(rel)) continue;
		seen.add(rel);
		if (!existsSync(abs) || !statSync(abs).isFile()) throw new RpacGuardError(`deliverable does not exist or is not a file: ${value}`);
		const sha256 = sha256File(abs);
		if (!sha256) throw new RpacGuardError(`could not hash deliverable: ${value}`);
		captured.push({ path: rel, sha256, updatedAt: nowIso() });
	}
	return captured;
}

function reviewSnapshotText(snapshot: ReviewSnapshot): string {
	return JSON.stringify(snapshot, null, 2) + "\n";
}

function sha256Text(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function readReviewSnapshot(root: string, state: RpacState): ReviewSnapshot {
	if (state.workflowKind !== "review" || !state.review) throw new RpacGuardError("active workflow is not a review");
	const path = resolve(root, state.review.manifest.path);
	const rel = relative(root, path);
	if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
		throw new RpacGuardError(`review manifest path escapes the project: ${state.review.manifest.path}`);
	}
	if (sha256File(path) !== state.review.manifest.sha256) {
		throw new RpacGuardError("review manifest is missing or changed since capture — recapture the review scope before continuing");
	}
	try {
		return JSON.parse(readFileSync(path, "utf8")) as ReviewSnapshot;
	} catch {
		throw new RpacGuardError("review manifest is not valid JSON — recapture the review scope before continuing");
	}
}

/** Read + integrity-check the persisted PR (base...head) manifest. */
function readPrSnapshot(root: string, state: RpacState): PrReviewSnapshot {
	if (!isPrReview(state)) throw new RpacGuardError("active workflow is not a PR review");
	const path = resolve(root, state.review!.manifest.path);
	const rel = relative(root, path);
	if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
		throw new RpacGuardError(`review manifest path escapes the project: ${state.review!.manifest.path}`);
	}
	if (sha256File(path) !== state.review!.manifest.sha256) {
		throw new RpacGuardError("review manifest is missing or changed since capture — recapture the review scope before continuing");
	}
	try {
		return JSON.parse(readFileSync(path, "utf8")) as PrReviewSnapshot;
	} catch {
		throw new RpacGuardError("review manifest is not valid JSON — recapture the review scope before continuing");
	}
}

/** Capture a stable PR base...head snapshot (object-level; double-capture for stability). */
function captureStablePrSnapshot(root: string, pr: PrReviewMeta, exclusions: ReviewExclusion[]): PrReviewSnapshot {
	const first = capturePrSnapshot(root, pr.baseSha, pr.headSha, pr.number, exclusions);
	const second = capturePrSnapshot(root, pr.baseSha, pr.headSha, pr.number, exclusions);
	if (!compareReviewSnapshots(first, second).unchanged) {
		throw new RpacGuardError("the PR refs changed while the snapshot was being captured — retry when stable");
	}
	return second;
}

/**
 * PR drift recheck: recompute the recorded base...head object diff and
 * re-resolve the current PR head. A force-pushed head or a changed diff
 * invalidates affected coverage; the reviewed commit is NEVER switched
 * silently. gh failures are reported, not treated as drift.
 */
function recheckPrSnapshot(root: string, state: RpacState, gh: GhRunner): string | null {
	const pr = state.review!.pr!;
	let fingerprint = state.review!.fingerprint;
	let added: string[] = [];
	let removed: string[] = [];
	let changed: string[] = [];
	let note = "";
	try {
		const before = readPrSnapshot(root, state);
		const after = capturePrSnapshot(root, pr.baseSha, pr.headSha, pr.number, state.review!.exclusions);
		const drift = compareReviewSnapshots(before, after);
		fingerprint = after.fingerprint;
		added = drift.addedItemIds;
		removed = drift.removedItemIds;
		changed = drift.changedItemIds;
	} catch (err) {
		// The recorded commit may no longer be reproducible (e.g. force-pushed +
		// GC'd). Invalidate all coverage and say so honestly.
		removed = [...state.review!.scopeItemIds];
		note = ` recorded scope is no longer reproducible (${(err as Error).message})`;
	}
	// Check BOTH PR refs and repository identity (a base retarget changes scope).
	try {
		const live = resolvePrMeta(gh.prView(root, pr.number), pr.number);
		if (live.url !== pr.url || live.repository !== pr.repository || live.headSha !== pr.headSha ||
			live.baseSha !== pr.baseSha || live.baseRef !== pr.baseRef) {
			note += ` PR #${pr.number} base/head or identity changed (possibly force-pushed/retargeted) — review evidence is stale; start a new review`;
		}
	} catch (err) {
		note += ` could not re-resolve the PR identity/base/head: ${(err as Error).message}; freshness is unverified`;
	}
	try { assertPrCheckout(root, pr); }
	catch (err) { note += ` checkout verification failed: ${(err as Error).message}`; }
	if (note) {
		added = [];
		changed = [...state.review!.scopeItemIds];
		removed = [];
		// Also preserve drift for EMPTY scopes; a matching old object fingerprint
		// must not erase a remote/checkout verification failure.
		fingerprint = sha256Text(`${fingerprint}\n${note}`);
	}
	return updateActive(root, (current) => {
		if (current.id !== state.id) throw new RpacGuardError("active workflow changed during PR drift check");
		const res = recordReviewDrift(current, fingerprint, added, removed, changed);
		return note ? `${res.message}${note}` : res.message;
	});
}

function captureStableReviewSnapshot(root: string, mode: string, exclusions: ReviewExclusion[]): ReviewSnapshot {
	const first = captureReviewSnapshot(root, mode, exclusions);
	const second = captureReviewSnapshot(root, mode, exclusions);
	if (!compareReviewSnapshots(first, second).unchanged) {
		throw new RpacGuardError("repository changed while the review snapshot was being captured — retry when the selected state is stable");
	}
	return second;
}

function captureAndReplaceReviewScope(root: string, state: RpacState, exclusions: ReviewExclusion[]): string {
	if (state.workflowKind !== "review" || !state.review) throw new RpacGuardError("active workflow is not a review");
	if (state.phase !== "refine" && state.phase !== "plan") {
		throw new RpacGuardError(`review scope can only be recaptured in refine/plan, not ${state.phase}`);
	}
	const seenExclusions = new Set<string>();
	for (const exclusion of exclusions) {
		if (seenExclusions.has(exclusion.path)) throw new RpacGuardError(`duplicate review exclusion: ${exclusion.path}`);
		seenExclusions.add(exclusion.path);
	}
	let fingerprint: string;
	let scopeItemIds: string[];
	let head: string;
	let unborn: boolean;
	let capturedAt: string;
	if (isPrReview(state)) {
		const pr = state.review.pr!;
		const rawSnapshot = captureStablePrSnapshot(root, pr, []);
		for (const exclusion of exclusions) {
			if (rawSnapshot.items.filter((item) => item.path === exclusion.path).length !== 1) {
				throw new RpacGuardError(`review exclusion is not a unique exact in-scope path (raw filenames may collide in display): ${exclusion.path}`);
			}
		}
		const snapshot = exclusions.length > 0 ? captureStablePrSnapshot(root, pr, exclusions) : rawSnapshot;
		fingerprint = snapshot.fingerprint;
		scopeItemIds = snapshot.items.map((item) => item.id);
		head = snapshot.headSha;
		unborn = false;
		capturedAt = snapshot.capturedAt;
		const text = JSON.stringify(snapshot, null, 2) + "\n";
		const path = reviewManifestFile(root, state.id);
		atomicWriteFile(path, text);
		const artifact = { path: relArtifactPath(root, path), sha256: sha256Text(text), updatedAt: nowIso() };
		return updateActive(root, (current) => {
			if (current.id !== state.id) throw new RpacGuardError("active workflow changed during review scope capture");
			return replaceReviewScope(current, { fingerprint, manifest: artifact, head, unborn, capturedAt, scopeItemIds, exclusions }).message;
		});
	}
	const rawSnapshot = captureStableReviewSnapshot(root, state.review.mode, []);
	for (const exclusion of exclusions) {
		if (!rawSnapshot.items.some((item) => item.path === exclusion.path)) {
			throw new RpacGuardError(`review exclusion is not an exact in-scope path: ${exclusion.path}`);
		}
	}
	const snapshot = exclusions.length > 0
		? captureStableReviewSnapshot(root, state.review.mode, exclusions)
		: rawSnapshot;
	if (state.review.mode === "staged" && snapshot.conflictItemIds.length > 0) {
		throw new RpacGuardError("staged review requires an exact index snapshot; resolve unmerged index entries first");
	}
	const text = reviewSnapshotText(snapshot);
	const path = reviewManifestFile(root, state.id);
	atomicWriteFile(path, text);
	const artifact = { path: relArtifactPath(root, path), sha256: sha256Text(text), updatedAt: nowIso() };
	return updateActive(root, (current) => {
		if (current.id !== state.id) throw new RpacGuardError("active workflow changed during review scope capture");
		return replaceReviewScope(current, {
			fingerprint: snapshot.fingerprint,
			manifest: artifact,
			head: snapshot.head,
			unborn: snapshot.unborn,
			capturedAt: snapshot.capturedAt,
			scopeItemIds: snapshot.items.map((item) => item.id),
			exclusions,
		}).message;
	});
}

/** Re-capture selected state and persist relevant drift. */
function recheckReviewSnapshot(root: string, state: RpacState, gh: GhRunner): string | null {
	if (state.workflowKind !== "review" || !state.review) return null;
	if (isPrReview(state)) return recheckPrSnapshot(root, state, gh);
	const before = readReviewSnapshot(root, state);
	const after = captureReviewSnapshot(root, state.review.mode, state.review.exclusions);
	const drift = compareReviewSnapshots(before, after);
	return updateActive(root, (current) => {
		if (current.id !== state.id) throw new RpacGuardError("active workflow changed during review drift check");
		return recordReviewDrift(
			current,
			after.fingerprint,
			drift.addedItemIds,
			drift.removedItemIds,
			drift.changedItemIds,
		).message;
	});
}

/** Stale-artifact + git divergence notes for a workflow. */
function stalenessNotes(root: string, state: RpacState): string[] {
	const notes: string[] = [];
	for (const key of ["requirements", "plan", "reviewManifest"] as const) {
		const art = state.artifacts[key];
		if (!art) continue;
		const abs = join(root, art.path);
		const sha = sha256File(abs);
		if (!sha) {
			notes.push(`${key} artifact is missing on disk (${art.path})`);
		} else if (sha !== art.sha256) {
			notes.push(`${key} artifact changed since it was recorded — re-read it before acting`);
		}
	}
	for (const task of [...state.tasks, ...state.taskHistory]) {
		for (const artifact of task.deliverables ?? []) {
			const abs = resolve(root, artifact.path);
			const rel = relative(root, abs);
			const label = "supersededAt" in task ? `historical task ${task.id}` : `task ${task.id}`;
			if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
				notes.push(`${label} has an invalid deliverable path (${artifact.path})`);
				continue;
			}
			const sha = sha256File(abs);
			if (!sha) notes.push(`${label} deliverable is missing on disk (${artifact.path})`);
			else if (sha !== artifact.sha256) notes.push(`${label} deliverable changed since it was recorded (${artifact.path})`);
		}
	}
	const div = detectDivergence(root, state.baseline);
	if (!div.noBaseline && div.summary !== "working tree matches baseline") {
		notes.push(`git: ${div.summary}`);
	}
	return notes;
}

function requireApprovalArtifact(root: string, state: RpacState, which: "requirements" | "plan"): void {
	if (state.workflowKind === "review") readReviewSnapshot(root, state);
	const path = artifactFile(root, state.id, which);
	if (!existsSync(path)) throw new RpacGuardError(`cannot approve: ${which}.md does not exist`);
	if (!isSubstantive(readFileSync(path, "utf8"))) {
		throw new RpacGuardError(`cannot approve thin ${which} — complete the artifact first`);
	}
	const sha = sha256File(path);
	const recorded = state.artifacts[which];
	if (!sha || !recorded || recorded.sha256 !== sha) {
		throw new RpacGuardError(
			`${which}.md changed after it was finalized — have the model call ${which === "requirements" ? "refine_complete" : "plan_complete"} again before approval`,
		);
	}
}

/**
 * True when a task is currently being executed under a live ACT lease
 * (by this process or another). Returns a holder description for messages.
 */
function leaseConflict(root: string): string | null {
	const lease = readLockRecord(root, LEASE_NAME);
	if (!lease || !isPidAlive(lease.pid)) return null;
	const age = Date.now() - Date.parse(lease.refreshedAt ?? lease.createdAt);
	const holder = holdsLock(root, LEASE_NAME)
		? "this Pi session"
		: `another process (pid ${lease.pid}, active ${Math.max(1, Math.round(age / 1000))}s ago)`;
	return `task ${lease.taskId ?? "?"} of workflow ${lease.workflowId ?? "?"} is already being executed by ${holder} — wait for it to finish (check /rpac status)`;
}

function acquireActLease(root: string, workflowId: string, taskId: number | null = null): void {
	if (holdsLock(root, LEASE_NAME)) {
		throw new RpacGuardError(`cannot acquire ACT lease: ${leaseConflict(root) ?? "this Pi session already owns it"}`);
	}
	acquireLock(root, LEASE_NAME, {
		staleMs: 24 * 3600 * 1000,
		attempts: 30,
		requireDeadPidForTakeover: true,
		record: { workflowId, taskId },
	});
}

function requireOwnedActLease(root: string, state: RpacState, action: string, taskRef?: number | string): void {
	const lease = readLockRecord(root, LEASE_NAME);
	if (!holdsLock(root, LEASE_NAME) || !lease || lease.workflowId !== state.id) {
		throw new RpacGuardError(`${action} requires the ACT execution lease — the user must start or resume execution with /rpac act or /rpac resume`);
	}
	if (action === "task_start" && lease.taskId !== null && lease.taskId !== undefined) {
		const previous = state.tasks.find((t) => t.id === lease.taskId);
		const requestedId = typeof taskRef === "number" ? taskRef : Number(taskRef);
		if (previous?.status === "in_progress" && Number.isInteger(requestedId) && requestedId === lease.taskId) {
			return; // harmless duplicate from a model that did not realize /rpac act already started it
		}
		if (!state.approvals.sequential) {
			throw new RpacGuardError("one-task mode stops after the current task — wait for the user to run /rpac act again");
		}
		if (!previous || previous.status !== "done") {
			throw new RpacGuardError(
				`sequential execution stopped because task ${lease.taskId} is ${previous?.status ?? "missing"} — wait for a new /rpac act cycle`,
			);
		}
	}
	if (action !== "task_start" && taskRef !== undefined && lease.taskId !== Number(taskRef)) {
		throw new RpacGuardError(`${action} targets task ${String(taskRef)}, but this execution lease belongs to task ${lease.taskId ?? "?"}`);
	}
}

function abandonActLease(root: string): void {
	try {
		const lease = readLockRecord(root, LEASE_NAME);
		const state = loadActive(root, root).state;
		if (
			lease && state && lease.workflowId === state.id &&
			state.tasks.some((t) => t.id === lease.taskId && t.status === "in_progress")
		) {
			updateActive(root, (s) => markInterrupted(s));
			appendLog(root, state.id, `- **${nowIso()}** task interrupted: ACT directive could not be dispatched`);
		}
	} catch {
		// Preserve the original dispatch error; status will show persisted state.
	} finally {
		releaseLock(root, LEASE_NAME);
	}
}

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const RpacAction = Type.Union([
	Type.Literal("status"),
	Type.Literal("review_scope"),
	Type.Literal("refine_complete"),
	Type.Literal("plan_complete"),
	Type.Literal("task_start"),
	Type.Literal("task_done"),
	Type.Literal("task_fail"),
	Type.Literal("task_block"),
	Type.Literal("task_unblock"),
	Type.Literal("decision"),
	Type.Literal("deviation"),
	Type.Literal("checkpoint"),
	Type.Literal("consolidate_complete"),
	Type.Literal("back_to_plan"),
	Type.Literal("back_to_act"),
]);

const CheckSchema = Type.Object({
	name: Type.String(),
	kind: Type.Optional(Type.Union([Type.Literal("acceptance"), Type.Literal("observation")])),
	result: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("unavailable")]),
	detail: Type.Optional(Type.String()),
});

const RpacToolSchema = Type.Object({
	action: RpacAction,
	/** task id (number) or "next" for task_* actions */
	task: Type.Optional(Type.Union([Type.Number(), Type.String()])),
	/** plan_complete: the task list matching the plan's ## Tasks section */
	tasks: Type.Optional(
		Type.Array(
			Type.Object({
				title: Type.String(),
				dependsOn: Type.Optional(Type.Array(Type.Number())),
				reviewItemIds: Type.Optional(Type.Array(Type.String())),
			}),
		),
	),
	/** plan_complete for reviews: exact project checks disclosed in the plan */
	reviewChecks: Type.Optional(Type.Array(Type.String())),
	/** review_scope: exact exclusions with recorded reasons */
	exclusions: Type.Optional(Type.Array(Type.Object({ path: Type.String(), reason: Type.String() }))),
	/** task_done/task_fail: verification checks that were run (task_done: mandatory, >= 1) */
	verification: Type.Optional(Type.Array(CheckSchema)),
	/** task_done: deviations from the plan noticed while implementing */
	deviations: Type.Optional(Type.Array(Type.String())),
	/** task_done: project-relative or absolute files produced by the task; RPAC hashes and tracks them */
	deliverables: Type.Optional(Type.Array(Type.String())),
	/** task_fail/task_block/back_to_plan/back_to_act/decision/deviation/checkpoint/consolidate text */
	text: Type.Optional(Type.String()),
});

type RpacToolParams = Static<typeof RpacToolSchema>;

const TASK_ACTIONS = new Set(["task_start", "task_done", "task_fail", "task_block", "task_unblock"]);
const ACT_LEASE_ACTIONS = new Set(["task_start", "task_done", "task_fail", "task_block", "back_to_plan"]);

function textResult(text: string, details?: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text }],
		details: details ?? undefined,
	};
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

/** True when a review workflow targets a GitHub PR (module-level; pure). */
function isPrReview(state: RpacState): boolean {
	return state.workflowKind === "review" && state.review?.mode === PR_REVIEW_MODE && Boolean(state.review.pr);
}

export default function rpacExtension(pi: ExtensionAPI, gh: GhRunner = defaultGhRunner): void {
	// Queue a phase directive as a follow-up user message; works whether or not
	// the agent is currently streaming.
	const issueDirective = (text: string): void => {
		pi.sendUserMessage(text, { deliverAs: "followUp" });
	};

	function prPromptMeta(pr: PrReviewMeta): PrPromptMeta {
		return {
			number: pr.number,
			url: pr.url,
			title: pr.title,
			baseRef: pr.baseRef,
			baseSha: pr.baseSha,
			headRef: pr.headRef,
			headSha: pr.headSha,
			repository: pr.repository,
			crossRepository: pr.crossRepository,
			checkoutStrategy: pr.checkoutStrategy,
			checkoutLocation: pr.checkoutLocation,
		};
	}

	/** The consolidate directive for the active review (PR-aware). */
	function reviewConsolidateDirFor(state: RpacState, root: string): string {
		if (isPrReview(state)) {
			return prConsolidateDirective(
				prPromptMeta(state.review!.pr!),
				reviewReportFile(root, state.id),
				relWorkflowArtifactPath(root, state.id, "requirements"),
				relWorkflowArtifactPath(root, state.id, "plan"),
				state.review!.manifest.path,
				relWorkflowArtifactPath(root, state.id, "log"),
			);
		}
		return reviewConsolidateDirective(
			state.review!.mode,
			reviewReportFile(root, state.id),
			relWorkflowArtifactPath(root, state.id, "requirements"),
			relWorkflowArtifactPath(root, state.id, "plan"),
			state.review!.manifest.path,
			relWorkflowArtifactPath(root, state.id, "log"),
		);
	}

	const SUBCOMMANDS = [
		"start",
		"review",
		"refine",
		"plan",
		"act",
		"consolidate",
		"approve",
		"status",
		"list",
		"resume",
		"accept",
		"pause",
		"abort",
		"pr-cleanup",
		"handoff",
		"cleanup",
	] as const;

	const SUB_HELP: Record<string, string> = {
		"start": "start a new workflow: /rpac start [--yes] <task> (--yes required headless to replace an active one)",
		"review": "start a report-only review: /rpac review [current|staged|full] (default: current)",
		"refine": "(re)issue the refine directive",
		"plan": "approve requirements, then issue the plan directive",
		"act": "execute the next approved task (flags: --sequential, task id)",
		"consolidate": "issue the consolidate directive (--force for unfinished tasks / non-act phases)",
		"approve": "approve: /rpac approve requirements|plan|sequential",
		"status": "show workflow state",
		"list": "list saved workflows",
		"resume": "stale checks + re-issue current phase directive (/rpac resume <id> for another workflow)",
		"accept": "accept a documented exception: /rpac accept <task-id> <reason> (failed → done)",
		"pause": "pause further workflow execution",
		"abort": "stop the workflow (keeps all files; --yes required headless)",
		"pr-cleanup": "remove the isolated PR worktree for the active PR review (main worktree untouched)",
		"handoff": "write handoff.md; in TUI, start a fresh session with it",
		"cleanup": "remove all RPAC state (--yes required headless)",
	};

	function parseFlags(tokens: string[]): { flags: Set<string>; rest: string } {
		const flags = new Set<string>();
		const pos: string[] = [];
		for (const t of tokens) {
			if (t.startsWith("--")) flags.add(t.slice(2));
			else pos.push(t);
		}
		return { flags, rest: pos.join(" ") };
	}

	async function cmdStart(ctx: ExtensionCommandContext, args: string): Promise<void> {
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		// PR preview subcommand: /rpac start preview <pr-number> [--yes]
		if (tokens[0]?.toLowerCase() === "preview") {
			const { flags, rest } = parseFlags(tokens.slice(1));
			if (rest.trim().includes(" ") || [...flags].some(flag => flag !== "yes")) {
				ctx.ui.notify("Usage: /rpac start preview <pr-number>  (a single positive integer)", "error");
				return;
			}
			await cmdStartPreview(ctx, rest.trim(), flags.has("yes"));
			return;
		}
		const { flags, rest } = parseFlags(tokens);
		const task = rest.trim();
		if (!task) {
			ctx.ui.notify("Usage: /rpac start <task description>  (headless: add --yes when replacing an active workflow)", "error");
			return;
		}
		const root = rootOf(ctx.cwd);
		let controlLease = false;
		try {
			const { state: existing, notes } = loadActive(root, root);
			reportNotes(ctx.ui, notes);
			if (existing && existing.phase !== "done" && existing.phase !== "aborted") {
				if (!ctx.hasUI) {
					if (!flags.has("yes")) {
						throw new RpacGuardError(
							`an active workflow exists (${existing.id}, phase ${existing.phase}, "${existing.task}"). ` +
								`Headless replacement requires explicit consent: run /rpac start --yes "<task>", or /rpac abort first.`,
						);
					}
				} else {
					const ok = await ctx.ui.confirm(
						"RPAC: start a new workflow now?",
						`The active workflow will be left as a saved (resumable) workflow:\n  ${existing.id} — ${existing.phase} — ${existing.task}\n\nStart "${task}"?`,
					);
					if (!ok) {
						ctx.ui.notify("Cancelled. Active workflow untouched.", "info");
						return;
					}
				}
			}
			acquireActLease(root, "control:start");
			controlLease = true;
			const currentId = loadActive(root, root).state?.id ?? null;
			if (currentId !== (existing?.id ?? null)) {
				throw new RpacGuardError("the active workflow changed while start confirmation was pending — review status and retry");
			}
			const state = newState(root, task);
			state.baseline = captureBaseline(root);
			createWorkflow(root, state, /* force */ true);
			if (state.baseline) {
				appendLog(
					root,
					state.id,
					`- **${nowIso()}** baseline: ${state.baseline.branch || "(detached)"} @ ${state.baseline.head.slice(0, 8)} (${state.baseline.dirty.length} uncommitted file(s))`,
				);
			}
			releaseLock(root, LEASE_NAME);
			controlLease = false;
			issueDirective(refineDirective(task, artifactFile(root, state.id, "requirements")));
			refreshUI(ctx.ui, root);
			ctx.ui.notify(`RPAC workflow ${state.id} started. Phase: refine. Task: ${task}`, "info");
		} catch (err) {
			if (controlLease) releaseLock(root, LEASE_NAME);
			fail(ctx.ui, err, "start failed");
		}
	}

	async function cmdStartPreview(ctx: ExtensionCommandContext, prNumberArg: string, yes: boolean): Promise<void> {
		const root = rootOf(ctx.cwd);
		let controlLease = false;
		try {
			// Validate the PR number (positive integer only).
			const arg = prNumberArg.trim();
			if (!/^\d+$/.test(arg) || !Number.isSafeInteger(Number(arg)) || Number(arg) < 1) {
				throw new RpacGuardError(`invalid PR number "${prNumberArg}" — it must be a positive integer`);
			}
			const prNumber = Number(arg);

			// Existing active-workflow safeguard (same as start/review): save, never destroy.
			const { state: existing, notes } = loadActive(root, root);
			reportNotes(ctx.ui, notes);
			if (existing && existing.phase !== "done" && existing.phase !== "aborted") {
				if (!ctx.hasUI) {
					if (!yes) {
						throw new RpacGuardError(
							`an active workflow exists (${existing.id}, phase ${existing.phase}, "${existing.task}"). ` +
							`Headless preview cannot replace it: run /rpac start preview --yes ${arg} to replace, or /rpac abort first.`,
						);
					}
				} else {
					const ok = await ctx.ui.confirm(
						"RPAC: start a PR review now?",
						`The active workflow remains saved and resumable:\n  ${existing.id} — ${existing.phase} — ${existing.task}\n\nStart a report-only review of PR #${prNumber}?`,
					);
					if (!ok) {
						ctx.ui.notify("Cancelled. Active workflow untouched.", "info");
						return;
					}
				}
			}

			// gh requirements.
			if (!gh.isAvailable()) {
				throw new RpacGuardError("the GitHub CLI (\`gh\`) is not on PATH — install it (https://cli.github.com) and retry");
			}
			const auth = gh.isAuthed();
			if (!auth.ok) {
				throw new RpacGuardError(`GitHub CLI is not authenticated (${auth.reason ?? "unknown reason"}) — run \`gh auth login\` and retry`);
			}

			// Repository identity + remote.
			const info = gitInfo(root);
			if (!info.isRepo) throw new RpacGuardError("PR review requires a Git work tree — this directory is not a Git repository");
			const assessment = assessPrCheckout(root);
			if (!assessment.hasRemote || !assessment.remote) {
				throw new RpacGuardError("PR review requires a Git remote to fetch the PR refs — add one (e.g. \`git remote add origin <url>\`) and retry");
			}

			// Resolve PR metadata (base/head, state, url, title, body).
			let resolved: ResolvedPr;
			try {
				resolved = resolvePrMeta(gh.prView(root, prNumber), prNumber);
			} catch (err) {
				throw new RpacGuardError(`could not resolve PR #${prNumber}: ${(err as Error).message}`);
			}
			const remote = selectPrRemote(root, resolved);
			const stateNote = resolved.state === "open" ? "" : ` · PR state: ${resolved.state}`;

			// Choose the checkout strategy: in-place when the tree is clean, isolated
			// worktree when it is not (never discard local work).
			let strategy: "in-place" | "worktree";
			let original: { branch: string; head: string; dirty: string[] };

			// Take the control lease before mutating Git, and confirm the active
			// workflow has not changed underneath us.
			acquireActLease(root, "control:preview");
			controlLease = true;
			const currentId = loadActive(root, root).state?.id ?? null;
			if (currentId !== (existing?.id ?? null)) {
				throw new RpacGuardError("the active workflow changed while preview confirmation was pending — review status and retry");
			}

			// Reassess AFTER confirmation and lease acquisition. Local work may have
			// appeared while metadata or a dialog was pending.
			const fresh = assessPrCheckout(root);
			strategy = fresh.clean ? "in-place" : "worktree";
			const freshInfo = gitInfo(root);
			original = { branch: freshInfo.branch, head: freshInfo.head, dirty: freshInfo.dirty };

			// Preflight objects and the full diff before changing any checkout.
			if (!verifyGitObjects(root, [resolved.baseSha, resolved.headSha])) {
				runGitText(root, ["fetch", remote, `refs/pull/${prNumber}/head`, `refs/heads/${resolved.baseRef}`]);
				if (!verifyGitObjects(root, [resolved.baseSha, resolved.headSha])) {
					throw new RpacGuardError(
						`the PR base/head objects are not available locally (base ${resolved.baseSha.slice(0, 12)}, head ${resolved.headSha.slice(0, 12)}) — ` +
						`run \`git fetch ${remote}\` to obtain them and retry`,
					);
				}
			}

			const snapshot = capturePrSnapshot(root, resolved.baseSha, resolved.headSha, prNumber);
			let outcome;
			try {
				outcome = performPrCheckout(root, resolved, strategy, gh, remote);
			} catch (err) {
				throw new RpacGuardError(`PR checkout failed: ${(err as Error).message}`);
			}
			const prMeta = buildPrMeta(resolved, outcome, original);
			const manifestText = JSON.stringify(snapshot, null, 2) + "\n";
			const state = newReviewState(root, {
				mode: PR_REVIEW_MODE,
				fingerprint: snapshot.fingerprint,
				manifestSha256: sha256Text(manifestText),
				head: snapshot.headSha,
				unborn: false,
				capturedAt: snapshot.capturedAt,
				scopeItemIds: snapshot.items.map((item) => item.id),
				pr: prMeta,
				task: `PR review #${prNumber}`,
			});
			state.baseline = captureBaseline(root);
			mkdirSync(workflowDir(root, state.id), { recursive: true });
			atomicWriteFile(reviewManifestFile(root, state.id), manifestText);
			createWorkflow(root, state, true);
			appendLog(
				root,
				state.id,
				`- **${nowIso()}** PR review #${prNumber} ${resolved.url}; base ${resolved.baseRef} @ ${resolved.baseSha.slice(0, 8)} → head ${resolved.headRef} @ ${resolved.headSha.slice(0, 8)}; checkout ${strategy} @ ${outcome.location}${stateNote}`,
			);
			releaseLock(root, LEASE_NAME);
			controlLease = false;
			issueDirective(prRefineDirective(prPromptMeta(prMeta), artifactFile(root, state.id, "requirements"), state.review!.manifest.path));
			refreshUI(ctx.ui, root);
			ctx.ui.notify(
				`RPAC PR review ${state.id} started. PR #${prNumber} (${resolved.state}${prMeta.crossRepository ? ", fork" : ""}); scope: ${snapshot.items.length} file(s); checkout: ${strategy}${stateNote}. Phase: refine.`,
				"info",
			);
		} catch (err) {
			if (controlLease) releaseLock(root, LEASE_NAME);
			fail(ctx.ui, err, "PR preview start failed");
		}
	}

	async function cmdReview(ctx: ExtensionCommandContext, args: string): Promise<void> {
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		if (tokens.length > 1 || (tokens[0] && !(REVIEW_MODES as readonly string[]).includes(tokens[0].toLowerCase()))) {
			ctx.ui.notify("Usage: /rpac review [current|staged|full] (no branch/base/options; default: current)", "error");
			return;
		}
		const mode = (tokens[0]?.toLowerCase() ?? "current") as ReviewMode;
		const root = rootOf(ctx.cwd);
		let controlLease = false;
		try {
			const { state: existing, notes } = loadActive(root, root);
			reportNotes(ctx.ui, notes);
			if (existing && existing.phase !== "done" && existing.phase !== "aborted") {
				if (!ctx.hasUI) {
					throw new RpacGuardError(
						`an active workflow exists (${existing.id}, phase ${existing.phase}). Headless review cannot replace it; abort/finish it first.`,
					);
				}
				const ok = await ctx.ui.confirm(
					"RPAC: start a review workflow now?",
					`The active workflow remains saved and resumable:\n  ${existing.id} — ${existing.phase} — ${existing.task}\n\nStart a report-only ${mode} review?`,
				);
				if (!ok) {
					ctx.ui.notify("Cancelled. Active workflow untouched.", "info");
					return;
				}
			}
			acquireActLease(root, "control:review");
			controlLease = true;
			const currentId = loadActive(root, root).state?.id ?? null;
			if (currentId !== (existing?.id ?? null)) {
				throw new RpacGuardError("the active workflow changed while review confirmation was pending — review status and retry");
			}
			const snapshot = captureStableReviewSnapshot(root, mode, []);
			if (mode === "staged" && snapshot.conflictItemIds.length > 0) {
				throw new RpacGuardError("staged review requires an exact index snapshot; resolve unmerged index entries first");
			}
			const text = reviewSnapshotText(snapshot);
			const state = newReviewState(root, {
				mode,
				fingerprint: snapshot.fingerprint,
				manifestSha256: sha256Text(text),
				head: snapshot.head,
				unborn: snapshot.unborn,
				capturedAt: snapshot.capturedAt,
				scopeItemIds: snapshot.items.map((item) => item.id),
			});
			state.baseline = captureBaseline(root);
			mkdirSync(workflowDir(root, state.id), { recursive: true });
			atomicWriteFile(reviewManifestFile(root, state.id), text);
			createWorkflow(root, state, true);
			appendLog(
				root,
				state.id,
				`- **${nowIso()}** review scope: ${mode}; ${snapshot.items.length} item(s); ${snapshot.fingerprint}`,
			);
			releaseLock(root, LEASE_NAME);
			controlLease = false;
			issueDirective(
				reviewRefineDirective(mode, artifactFile(root, state.id, "requirements"), state.review!.manifest.path),
			);
			refreshUI(ctx.ui, root);
			ctx.ui.notify(
				`RPAC review ${state.id} started. Mode: ${mode}; scope: ${snapshot.items.length} item(s). Phase: refine.`,
				"info",
			);
		} catch (err) {
			if (controlLease) releaseLock(root, LEASE_NAME);
			fail(ctx.ui, err, "review start failed");
		}
	}

	async function cmdRefine(ctx: ExtensionCommandContext, args: string): Promise<void> {
		const root = rootOf(ctx.cwd);
		try {
			const { state, notes } = loadActive(root, root);
			reportNotes(ctx.ui, notes);
			if (!state) throw new RpacStateError("not_found", "no active workflow — /rpac start <task> first");
			if (state.phase === "aborted" || state.phase === "done") {
				throw new RpacStateError("invalid", `workflow is ${state.phase}`);
			}
			if (state.phase !== "refine") {
				throw new RpacStateError("invalid", `workflow is in phase ${state.phase}, not refine`);
			}
			if (state.workflowKind === "review" && state.review) {
				if (args.trim()) throw new RpacGuardError("/rpac refine notes are not supported for review workflows; record intent in requirements");
				issueDirective(
					isPrReview(state)
						? prRefineDirective(prPromptMeta(state.review.pr!), artifactFile(root, state.id, "requirements"), state.review.manifest.path)
						: reviewRefineDirective(state.review.mode, artifactFile(root, state.id, "requirements"), state.review.manifest.path),
				);
			} else {
				issueDirective(refineDirective(state.task, artifactFile(root, state.id, "requirements"), args || undefined));
			}
			ctx.ui.notify("RPAC: refine directive issued.", "info");
		} catch (err) {
			fail(ctx.ui, err, "refine failed");
		}
	}

	async function cmdPlan(ctx: ExtensionCommandContext, args: string): Promise<void> {
		const root = rootOf(ctx.cwd);
		try {
			const { state, notes } = loadActive(root, root);
			reportNotes(ctx.ui, notes);
			if (!state) throw new RpacStateError("not_found", "no active workflow — /rpac start <task> first");
			if (state.phase !== "refine" && state.phase !== "plan") {
				throw new RpacStateError("invalid", `workflow is in phase ${state.phase}, not refine/plan`);
			}
			if (!state.approvals.requirements) {
				const requirementsPath = artifactFile(root, state.id, "requirements");
				if (!existsSync(requirementsPath)) {
					throw new RpacGuardError("no requirements artifact yet. Finish refining first (the model writes it, then calls rpac refine_complete).");
				}
				if (!isSubstantive(readFileSync(requirementsPath, "utf8"))) {
					throw new RpacGuardError("cannot approve thin requirements — refine them first (see the rpac-refine skill)");
				}
				// Finalize the exact content that is about to be shown for approval.
				updateActive(root, (s) => noteArtifact(s, root, "requirements"));
				const approved = ctx.hasUI
					? await ctx.ui.confirm(
							"RPAC: approve the requirements?",
							`Requirements document: ${artifactFile(root, state.id, "requirements")}\n\nApprove and move to the PLAN phase?`,
						)
					: false;
				if (!approved) {
					throw new RpacGuardError(
						"Requirements need approval: run /rpac approve requirements" + (ctx.hasUI ? " (or run /rpac plan again and confirm)" : "."),
					);
				}
				const approvalState = loadActive(root, root).state;
				if (!approvalState) throw new RpacStateError("not_found", "state disappeared during requirements approval");
				if (approvalState.id !== state.id) {
					throw new RpacGuardError("the active workflow changed while approval was pending — review status and retry");
				}
				requireApprovalArtifact(root, approvalState, "requirements");
				updateActive(root, (s) => {
					if (s.id !== state.id) throw new RpacGuardError("active workflow changed during requirements approval");
					return approveRequirements(s);
				});
				appendLog(root, state.id, `- **${nowIso()}** requirements approved → phase plan`);
			}
			const cur = loadActive(root, root).state;
			if (!cur) throw new RpacStateError("not_found", "no active workflow");
			if (cur.workflowKind === "review" && cur.review) {
				if (args.trim()) throw new RpacGuardError("/rpac plan notes are not supported for review workflows; keep scope in approved requirements");
				issueDirective(
					isPrReview(cur)
						? prPlanDirective(
							prPromptMeta(cur.review.pr!),
							artifactFile(root, cur.id, "plan"),
							relWorkflowArtifactPath(root, cur.id, "requirements"),
							cur.review.manifest.path,
						)
						: reviewPlanDirective(
							cur.review.mode,
							artifactFile(root, cur.id, "plan"),
							relWorkflowArtifactPath(root, cur.id, "requirements"),
							cur.review.manifest.path,
						),
				);
			} else {
				issueDirective(planDirective(cur.task, artifactFile(root, cur.id, "plan"), artifactFile(root, cur.id, "requirements"), args || undefined));
			}
			ctx.ui.notify("RPAC: plan directive issued (requirements approved).", "info");
			refreshUI(ctx.ui, root);
		} catch (err) {
			fail(ctx.ui, err, "plan failed");
		}
	}

	async function cmdAct(ctx: ExtensionCommandContext, args: string): Promise<void> {
		const root = rootOf(ctx.cwd);
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		const { flags, rest } = parseFlags(tokens);
		const sequential = flags.has("sequential");
		const taskRef = rest.trim();
		let leaseAcquired = false;
		let directiveIssued = false;
		try {
			let { state, notes } = loadActive(root, root);
			reportNotes(ctx.ui, notes);
			if (!state) throw new RpacStateError("not_found", "no active workflow — /rpac start <task> first");
			if (state.phase === "done" || state.phase === "aborted") {
				throw new RpacStateError("invalid", `workflow is ${state.phase} — nothing to act on`);
			}

			// Stale checks: report, never auto-resolve.
			const notes2 = stalenessNotes(root, state);
			for (const n of notes2) {
				ctx.ui.notify(`RPAC: ${n}`, "warning");
				appendLog(root, state.id, `- **${nowIso()}** stale-check: ${n}`);
			}

			const canEnterAct = state.phase === "act" || (state.phase === "plan" && state.approvals.plan);
			if (!canEnterAct) {
				throw new RpacStateError(
					"invalid",
					`workflow is in phase ${state.phase} — ${state.phase === "plan" && !state.approvals.plan ? "approve the plan first (/rpac approve plan)" : "not ready for act"}`,
				);
			}

			// Acquire before any ACT state transition or approval dialog. Lifecycle
			// commands cannot switch the active workflow while this command waits.
			acquireActLease(root, state.id);
			leaseAcquired = true;
			if (state.workflowKind === "review") {
				const driftMessage = recheckReviewSnapshot(root, state, gh);
				if (driftMessage && !/unchanged/.test(driftMessage)) ctx.ui.notify(`RPAC: ${driftMessage}`, "warning");
				({ state, notes } = loadActive(root, root));
				if (!state) throw new RpacStateError("not_found", "review workflow disappeared during snapshot check");
			}
			if (state.phase === "plan") {
				updateActive(root, (s) => {
					if (s.id !== state.id) throw new RpacGuardError("active workflow changed before ACT dispatch");
					s.phase = "act";
					recordEvent(s, "phase", "plan → act (plan approved)");
				});
			}
			if (sequential && !state.approvals.sequential) {
				if (ctx.hasUI) {
					const ok = await ctx.ui.confirm(
						"RPAC: approve sequential execution?",
						"In sequential mode the model continues through ready tasks in one run without stopping for /rpac act between tasks. Approve?",
					);
					if (!ok) throw new RpacGuardError("sequential mode not approved — /rpac act stays one task per run");
				}
				// headless: the explicit `--sequential` flag on the command is the approval
				updateActive(root, (s) => {
					if (s.id !== state.id) throw new RpacGuardError("active workflow changed during sequential approval");
					return approveSequential(s);
				});
				appendLog(root, state.id, `- **${nowIso()}** sequential execution approved${ctx.hasUI ? "" : " (headless --sequential)"}`);
			}
			const ref = taskRef ? (Number.isInteger(Number(taskRef)) && taskRef !== "" ? Number(taskRef) : taskRef) : undefined;

			const result = updateActive(root, (s) => {
				if (s.id !== state.id) throw new RpacGuardError("active workflow changed before task start");
				return taskStart(s, ref);
			});
			const cur = loadActive(root, root).state!;
			const task = cur.tasks.find((t) => t.status === "in_progress");
			if (!task) throw new RpacStateError("invalid", "no in-progress task after task_start (internal error)");
			if (!refreshLock(root, LEASE_NAME, { workflowId: cur.id, taskId: task.id })) {
				throw new RpacLockError("lost the ACT execution lease before dispatch");
			}

			appendLog(root, cur.id, `- **${nowIso()}** ${result.message}`);
			issueDirective(
				cur.workflowKind === "review" && cur.review
					? (isPrReview(cur)
						? prActDirective(
							prPromptMeta(cur.review.pr!),
							task.id,
							task.title,
							task.reviewItemIds ?? [],
							relArtifactPath(root, reviewBatchFile(root, cur.id, task.id)),
							relWorkflowArtifactPath(root, cur.id, "plan"),
							cur.approvals.sequential,
						)
						: reviewActDirective(
							cur.review.mode,
							task.id,
							task.title,
							task.reviewItemIds ?? [],
							relArtifactPath(root, reviewBatchFile(root, cur.id, task.id)),
							relWorkflowArtifactPath(root, cur.id, "plan"),
							cur.approvals.sequential,
						))
					: actDirective(
						cur.task,
						task.id,
						task.title,
						cur.approvals.sequential,
						relWorkflowArtifactPath(root, cur.id, "plan"),
					),
			);
			directiveIssued = true;
			refreshUI(ctx.ui, root);
			ctx.ui.notify(`RPAC: ${result.message} (execution lease held until this run ends)`, "info");
		} catch (err) {
			if (leaseAcquired && !directiveIssued) abandonActLease(root);
			fail(ctx.ui, err, "act failed");
		}
	}

	async function cmdConsolidate(ctx: ExtensionCommandContext, args: string): Promise<void> {
		const root = rootOf(ctx.cwd);
		const { flags } = parseFlags(args.trim().split(/\s+/).filter(Boolean));
		let controlLease = false;
		try {
			const { state, notes } = loadActive(root, root);
			reportNotes(ctx.ui, notes);
			if (!state) throw new RpacStateError("not_found", "no active workflow — /rpac start <task> first");
			if (state.phase === "done" || state.phase === "aborted") {
				throw new RpacStateError("invalid", `workflow is ${state.phase}`);
			}
			const remaining = state.tasks.filter((t) => t.status !== "done");
			const fromPlanOrRefine = state.phase === "plan" || state.phase === "refine";
			const needsForce = remaining.length > 0 || fromPlanOrRefine;
			if (needsForce) {
				if (!ctx.hasUI) {
					if (!flags.has("force")) {
						throw new RpacGuardError(
							`consolidation while ${
								remaining.length > 0 ? `${remaining.length} task(s) are unfinished (${remaining.map((t) => `#${t.id} ${t.status}`).join(", ")})` : `phase is ${state.phase}`
							} requires an explicit force: run /rpac consolidate --force (headless) to override.`,
						);
					}
				} else {
					const ok = await ctx.ui.confirm(
						"RPAC: consolidate with open work?",
						remaining.length > 0 || fromPlanOrRefine
							? `Open work: ${remaining.length > 0 ? `${remaining.length} task(s) not done: ${remaining.map((t) => `#${t.id} ${t.status}`).join(", ")}` : `phase is ${state.phase}`}.\n\nConsolidate anyway?`
							: "",
					);
					if (!ok) throw new RpacGuardError("cancelled — open work remains");
				}
			}
			acquireActLease(root, `control:consolidate:${state.id}`);
			controlLease = true;
			if (state.workflowKind === "review") {
				const driftMessage = recheckReviewSnapshot(root, state, gh);
				if (driftMessage && !/unchanged/.test(driftMessage)) ctx.ui.notify(`RPAC: ${driftMessage}`, "warning");
			}
			updateActive(root, (s) => {
				if (s.id !== state.id) throw new RpacGuardError("the active workflow changed while consolidation confirmation was pending — review status and retry");
				if (s.phase !== "consolidate") {
					s.phase = "consolidate";
					recordEvent(s, "phase", `→ consolidate${remaining.length ? ` (${remaining.length} task(s) unfinished)` : ""}`);
				}
			});
			const cur = loadActive(root, root).state!;
			releaseLock(root, LEASE_NAME);
			controlLease = false;
			issueDirective(
				cur.workflowKind === "review" && cur.review
					? reviewConsolidateDirFor(cur, root)
					: consolidateDirective(
						cur.task,
						artifactFile(root, cur.id, "report"),
						relWorkflowArtifactPath(root, cur.id, "requirements"),
						relWorkflowArtifactPath(root, cur.id, "plan"),
						relWorkflowArtifactPath(root, cur.id, "log"),
					),
			);
			refreshUI(ctx.ui, root);
			ctx.ui.notify("RPAC: consolidate directive issued.", "info");
		} catch (err) {
			if (controlLease) releaseLock(root, LEASE_NAME);
			fail(ctx.ui, err, "consolidate failed");
		}
	}

	async function cmdApprove(ctx: ExtensionCommandContext, args: string): Promise<void> {
		const what = args.trim().toLowerCase();
		const root = rootOf(ctx.cwd);
		let controlLease = false;
		try {
			acquireActLease(root, `control:approve:${what || "unknown"}`);
			controlLease = true;
			let message: string;
			switch (what) {
				case "requirements": {
					const { state } = loadActive(root, root);
					if (!state) throw new RpacStateError("not_found", "no active workflow");
					const reqPath = artifactFile(root, state.id, "requirements");
					if (!existsSync(reqPath)) {
						throw new RpacGuardError("cannot approve: the requirements artifact does not exist yet");
					}
					if (!isSubstantive(readFileSync(reqPath, "utf8"))) {
						throw new RpacGuardError("cannot approve thin requirements — refine them first (see the rpac-refine skill)");
					}
					updateActive(root, (s) => noteArtifact(s, root, "requirements"));
					const finalized = loadActive(root, root).state;
					if (!finalized) throw new RpacStateError("not_found", "state disappeared during requirements approval");
					requireApprovalArtifact(root, finalized, "requirements");
					message = updateActive(root, (s) => approveRequirements(s)).message;
					break;
				}
				case "plan": {
					const { state } = loadActive(root, root);
					if (!state) throw new RpacStateError("not_found", "no active workflow");
					requireApprovalArtifact(root, state, "plan");
					message = updateActive(root, (s) => approvePlan(s)).message;
					break;
				}
				case "sequential":
					message = updateActive(root, (s) => approveSequential(s)).message;
					break;
				default:
					throw new RpacGuardError("usage: /rpac approve requirements|plan|sequential");
			}
			const cur = loadActive(root, root).state;
			if (cur) appendLog(root, cur.id, `- **${nowIso()}** approved: ${what}`);
			releaseLock(root, LEASE_NAME);
			controlLease = false;
			refreshUI(ctx.ui, root);
			ctx.ui.notify(`RPAC: ${message}`, "info");
		} catch (err) {
			if (controlLease) releaseLock(root, LEASE_NAME);
			fail(ctx.ui, err, "approve failed");
		}
	}

	async function cmdResume(ctx: ExtensionCommandContext, args: string): Promise<void> {
		const root = rootOf(ctx.cwd);
		const idArg = args.trim();
		let leaseAcquired = false;
		let directiveIssued = false;
		try {
			let { state, notes } = loadActive(root, root);
			reportNotes(ctx.ui, notes);
			if (!state) throw new RpacStateError("not_found", "no saved workflow to resume — /rpac list shows what exists");
			if (idArg && state.id !== idArg) {
				const curId = state.id;
				acquireActLease(root, `control:resume:${idArg}`);
				try {
					state = switchActive(root, idArg);
					notes = loadActive(root, root).notes;
					appendLog(root, state.id, `- **${nowIso()}** resumed workflow ${state.id} (was active: ${curId})`);
				} finally {
					releaseLock(root, LEASE_NAME);
				}
			}
			if (state.phase === "done") {
				ctx.ui.notify(`RPAC: workflow ${state.id} is complete. Nothing to resume — /rpac start <task> for new work.`, "info");
				return;
			}
			if (state.phase === "aborted") {
				ctx.ui.notify(`RPAC: workflow ${state.id} was aborted. /rpac start <task> to begin a new one.`, "info");
				return;
			}
			if (state.paused) {
				updateActive(root, (s) => {
					if (s.id !== state.id) throw new RpacGuardError("active workflow changed before resume");
					return mResume(s);
				});
				appendLog(root, state.id, `- **${nowIso()}** resumed from pause`);
			}
			let cur = loadActive(root, root).state;
			if (!cur) throw new RpacStateError("not_found", "state disappeared");
			const stNotes = stalenessNotes(root, cur);
			for (const n of stNotes) ctx.ui.notify(`RPAC: ${n}`, "warning");
			const stateRel = `.pi/rpac/${cur.id}/workflow.json`;
			switch (cur.phase) {
				case "refine":
					issueDirective(
						cur.workflowKind === "review" && cur.review
							? (isPrReview(cur)
								? prRefineDirective(prPromptMeta(cur.review.pr!), artifactFile(root, cur.id, "requirements"), cur.review.manifest.path)
								: reviewRefineDirective(cur.review.mode, artifactFile(root, cur.id, "requirements"), cur.review.manifest.path))
							: refineDirective(cur.task, artifactFile(root, cur.id, "requirements")),
					);
					break;
				case "plan":
					if (cur.approvals.requirements) {
						issueDirective(
							cur.workflowKind === "review" && cur.review
								? (isPrReview(cur)
									? prPlanDirective(
										prPromptMeta(cur.review.pr!),
										artifactFile(root, cur.id, "plan"),
										relWorkflowArtifactPath(root, cur.id, "requirements"),
										cur.review.manifest.path,
									)
									: reviewPlanDirective(
										cur.review.mode,
										artifactFile(root, cur.id, "plan"),
										relWorkflowArtifactPath(root, cur.id, "requirements"),
										cur.review.manifest.path,
									))
								: planDirective(cur.task, artifactFile(root, cur.id, "plan"), artifactFile(root, cur.id, "requirements")),
						);
					} else {
						issueDirective(
							resumeDirective(
								cur.task,
								"plan",
								"Requirements are NOT yet approved — review the requirements with the user; the user runs /rpac plan to approve.",
								stateRel,
							),
						);
					}
					break;
				case "act": {
					const inProgress = cur.tasks.find((t) => t.status === "in_progress");
					const interrupted = cur.tasks.find((t) => t.status === "interrupted");
					if (inProgress || interrupted || cur.approvals.plan) {
						const requested = inProgress ?? interrupted;
						acquireActLease(root, cur.id);
						leaseAcquired = true;
						if (cur.workflowKind === "review") {
							const driftMessage = recheckReviewSnapshot(root, cur, gh);
							if (driftMessage && !/unchanged/.test(driftMessage)) ctx.ui.notify(`RPAC: ${driftMessage}`, "warning");
							cur = loadActive(root, root).state!;
						}
						const resumeId = cur.id;
						const result = updateActive(root, (s) => {
							if (s.id !== resumeId) throw new RpacGuardError("active workflow changed before resume dispatch");
							return taskStart(s, requested?.id);
						});
						const active = loadActive(root, root).state;
						const task = active?.tasks.find((t) => t.status === "in_progress");
						if (!active || !task) throw new RpacStateError("invalid", "no in-progress task after resume (internal error)");
						if (!refreshLock(root, LEASE_NAME, { workflowId: active.id, taskId: task.id })) {
							throw new RpacLockError("lost the ACT execution lease before resume dispatch");
						}
						issueDirective(
							active.workflowKind === "review" && active.review
								? (isPrReview(active)
									? prActDirective(
										prPromptMeta(active.review.pr!),
										task.id,
										requested ? `${task.title} (resume — verify existing batch evidence first)` : task.title,
										task.reviewItemIds ?? [],
										relArtifactPath(root, reviewBatchFile(root, active.id, task.id)),
										relWorkflowArtifactPath(root, active.id, "plan"),
										active.approvals.sequential,
									)
									: reviewActDirective(
										active.review.mode,
										task.id,
										requested ? `${task.title} (resume — verify existing batch evidence first)` : task.title,
										task.reviewItemIds ?? [],
										relArtifactPath(root, reviewBatchFile(root, active.id, task.id)),
										relWorkflowArtifactPath(root, active.id, "plan"),
										active.approvals.sequential,
									))
								: actDirective(
									active.task,
									task.id,
									requested ? `${task.title} (resume — check what is already done in the repo first)` : task.title,
									active.approvals.sequential,
									relWorkflowArtifactPath(root, active.id, "plan"),
								),
						);
						directiveIssued = true;
						appendLog(root, active.id, `- **${nowIso()}** ${result.message}`);
					} else {
						issueDirective(resumeDirective(cur.task, "act", "The plan is not approved yet — /rpac approve plan.", stateRel));
					}
					break;
				}
				case "consolidate":
					if (cur.workflowKind === "review") {
						acquireActLease(root, `control:resume-review:${cur.id}`);
						try {
							const driftMessage = recheckReviewSnapshot(root, cur, gh);
							if (driftMessage && !/unchanged/.test(driftMessage)) ctx.ui.notify(`RPAC: ${driftMessage}`, "warning");
							cur = loadActive(root, root).state!;
						} finally {
							releaseLock(root, LEASE_NAME);
						}
					}
					issueDirective(
						cur.workflowKind === "review" && cur.review
							? reviewConsolidateDirFor(cur, root)
							: consolidateDirective(
								cur.task,
								artifactFile(root, cur.id, "report"),
								relWorkflowArtifactPath(root, cur.id, "requirements"),
								relWorkflowArtifactPath(root, cur.id, "plan"),
								relWorkflowArtifactPath(root, cur.id, "log"),
							),
					);
					break;
				default:
					issueDirective(resumeDirective(cur.task, cur.phase, stNotes.join("\n") || "Continue per the phase skill.", stateRel));
			}
			refreshUI(ctx.ui, root);
			ctx.ui.notify(`RPAC: resumed workflow ${cur.id} in phase ${cur.phase}.`, "info");
		} catch (err) {
			if (leaseAcquired && !directiveIssued) abandonActLease(root);
			fail(ctx.ui, err, "resume failed");
		}
	}

	async function cmdPause(ctx: ExtensionCommandContext): Promise<void> {
		const root = rootOf(ctx.cwd);
		let controlLease = false;
		try {
			acquireActLease(root, "control:pause");
			controlLease = true;
			const result = updateActive(root, (s) => mPause(s));
			const cur = loadActive(root, root).state;
			if (cur) appendLog(root, cur.id, `- **${nowIso()}** paused`);
			releaseLock(root, LEASE_NAME);
			controlLease = false;
			refreshUI(ctx.ui, root);
			ctx.ui.notify(`RPAC: ${result.message}`, "info");
		} catch (err) {
			if (controlLease) releaseLock(root, LEASE_NAME);
			fail(ctx.ui, err, "pause failed");
		}
	}

	async function cmdAbort(ctx: ExtensionCommandContext, args: string): Promise<void> {
		const root = rootOf(ctx.cwd);
		const { flags } = parseFlags(args.trim().split(/\s+/).filter(Boolean));
		const reason = args.replace(/--yes\b/g, "").trim() || undefined;
		let controlLease = false;
		try {
			const { state } = loadActive(root, root);
			if (!state) {
				ctx.ui.notify("RPAC: no active workflow to abort.", "info");
				return;
			}
			if (!ctx.hasUI) {
				if (!flags.has("yes")) {
					throw new RpacGuardError("headless abort requires explicit consent: run /rpac abort --yes [reason]");
				}
			} else {
				const ok = await ctx.ui.confirm(
					"RPAC: abort this workflow?",
					`Task: ${state.task}\n\nAll files under .pi/rpac/${state.id}/ are preserved; no code changes are reverted.`,
				);
				if (!ok) {
					ctx.ui.notify("Cancelled.", "info");
					return;
				}
			}
			acquireActLease(root, `control:abort:${state.id}`);
			controlLease = true;
			const message = updateActive(root, (s) => {
				if (s.id !== state.id) throw new RpacGuardError("the active workflow changed while abort confirmation was pending — review status and retry");
				return mAbort(s, reason);
			}).message;
			appendLog(root, state.id, `- **${nowIso()}** ${message}`);
			releaseLock(root, LEASE_NAME);
			controlLease = false;
			refreshUI(ctx.ui, root);
			ctx.ui.notify(`RPAC: ${message}`, "warning");
		} catch (err) {
			if (controlLease) releaseLock(root, LEASE_NAME);
			fail(ctx.ui, err, "abort failed");
		}
	}

	async function cmdAccept(ctx: ExtensionCommandContext, args: string): Promise<void> {
		const root = rootOf(ctx.cwd);
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		try {
			if (tokens.length < 2) {
				throw new RpacGuardError("usage: /rpac accept <task-id> <documented reason> — only failed tasks can be accepted");
			}
			const ref = tokens[0]!;
			const reason = tokens.slice(1).join(" ");
			const message = updateActive(root, (s) => taskAccept(s, Number.isInteger(Number(ref)) ? Number(ref) : ref, reason)).message;
			const cur = loadActive(root, root).state;
			if (cur) appendLog(root, cur.id, `- **${nowIso()}** ${message}`);
			refreshUI(ctx.ui, root);
			ctx.ui.notify(`RPAC: ${message}`, "warning");
		} catch (err) {
			fail(ctx.ui, err, "accept failed");
		}
	}

	async function cmdList(ctx: ExtensionCommandContext): Promise<void> {
		const root = rootOf(ctx.cwd);
		try {
			const { index, notes } = loadActive(root, root);
			reportNotes(ctx.ui, notes);
			const all = listWorkflows(root);
			if (all.length === 0) {
				ctx.ui.notify("RPAC: no saved workflows. Start one: /rpac start <task>", "info");
				return;
			}
			const lines = all.map(
				(w) => `  ${w.id === index.active ? "*" : " "} ${w.id} — ${w.workflowKind}:${w.phase}${w.phase === "done" || w.phase === "aborted" ? " (terminal)" : " (resumable)"} — ${w.task} [${w.updatedAt}]`,
			);
			ctx.ui.notify(`RPAC workflows (* = active):\n${lines.join("\n")}\nResume: /rpac resume <id>`, "info");
		} catch (err) {
			fail(ctx.ui, err, "list failed");
		}
	}

	async function cmdCleanup(ctx: ExtensionCommandContext, args: string): Promise<void> {
		const root = rootOf(ctx.cwd);
		const { flags } = parseFlags(args.trim().split(/\s+/).filter(Boolean));
		let controlLease = false;
		try {
			const stateDir = join(root, ".pi", "rpac");
			if (!existsSync(stateDir) || readdirSync(stateDir).every((entry) => entry === ".lock" || entry === LEASE_NAME)) {
				ctx.ui.notify("RPAC: nothing to clean up.", "info");
				return;
			}
			if (!ctx.hasUI) {
				if (!flags.has("yes")) {
					throw new RpacGuardError("headless cleanup requires explicit consent: run /rpac cleanup --yes");
				}
			} else {
				const ok = await ctx.ui.confirm(
					"RPAC: remove ALL RPAC state?",
					"Everything under .pi/rpac/ (all workflows, artifacts, logs) will be deleted. Code changes are NOT touched.",
				);
				if (!ok) {
					ctx.ui.notify("Cancelled.", "info");
					return;
				}
			}
			acquireActLease(root, "control:cleanup");
			controlLease = true;
			removeAll(root);
			releaseLock(root, LEASE_NAME);
			controlLease = false;
			clearUI(ctx.ui);
			ctx.ui.notify("RPAC: all RPAC state removed.", "warning");
		} catch (err) {
			if (controlLease) releaseLock(root, LEASE_NAME);
			fail(ctx.ui, err, "cleanup failed");
		}
	}

	async function cmdPrCleanup(ctx: ExtensionCommandContext, args: string): Promise<void> {
		const root = rootOf(ctx.cwd);
		const { flags, rest } = parseFlags(args.trim().split(/\s+/).filter(Boolean));
		let controlLease = false;
		try {
			if (rest || [...flags].some(flag => flag !== "yes")) throw new RpacGuardError("Usage: /rpac pr-cleanup [--yes]");
			const { state } = loadActive(root, root);
			if (!state) {
				ctx.ui.notify("RPAC: no active workflow.", "info");
				return;
			}
			if (!isPrReview(state)) {
				throw new RpacGuardError("pr-cleanup only applies to a PR review workflow — the active workflow is not a PR review");
			}
			const pr = state.review!.pr!;
			if (pr.checkoutStrategy !== "worktree") {
				ctx.ui.notify(
					`RPAC: this PR review used the in-place checkout. RPAC does not auto-restore the branch (it could overwrite new work). To return to the pre-review state run:\n  ${prRestoreCommand(pr)}\n  (original HEAD ${pr.originalHead.slice(0, 8)})`,
					"info",
				);
				return;
			}
			if (!ctx.hasUI) {
				if (!flags.has("yes")) throw new RpacGuardError("headless pr-cleanup requires explicit consent: /rpac pr-cleanup --yes");
			} else {
				const ok = await ctx.ui.confirm(
					"RPAC: remove the isolated PR worktree?",
					`This removes ${prWorktreePath(root, pr.number)}. Your main worktree and its changes are NOT touched.`,
				);
				if (!ok) {
					ctx.ui.notify("Cancelled.", "info");
					return;
				}
			}
			acquireActLease(root, "control:pr-cleanup");
			controlLease = true;
			if (loadActive(root, root).state?.id !== state.id) throw new RpacGuardError("active workflow changed while cleanup confirmation was pending");
			if (pr.checkoutLocation !== prWorktreePath(root, pr.number)) throw new RpacGuardError("recorded PR worktree location does not match; refusing cleanup");
			const result = removePrWorktree(root, pr.number, pr.headSha);
			releaseLock(root, LEASE_NAME);
			controlLease = false;
			appendLog(root, state.id, `- **${nowIso()}** pr-cleanup: ${result}`);
			refreshUI(ctx.ui, root);
			ctx.ui.notify(`RPAC: ${result}.`, "info");
		} catch (err) {
			if (controlLease) releaseLock(root, LEASE_NAME);
			fail(ctx.ui, err, "pr-cleanup failed");
		}
	}

	function buildHandoff(state: RpacState): string {
		const open = state.tasks.filter((t) => t.status !== "done");
		const decisions = state.events.filter((e) => e.kind === "decision" || e.kind === "deviation");
		const wf = `.pi/rpac/${state.id}`;
		const lines: string[] = [];
		lines.push(`# RPAC handoff — ${state.id}`);
		lines.push("");
		lines.push(`- Task: ${state.task}`);
		lines.push(`- Kind: ${state.workflowKind}${state.review ? ` (${state.review.mode})` : ""}`);
		lines.push(`- Phase: ${state.phase} (paused: ${state.paused})`);
		lines.push(`- Project: ${state.project}`);
		if (state.baseline) lines.push(`- Git baseline: ${state.baseline.branch || "(detached)"} @ ${state.baseline.head.slice(0, 8)}`);
		lines.push(
			`- Artifacts: requirements ${state.artifacts.requirements?.path ?? `${wf}/requirements.md`}, plan ${state.artifacts.plan?.path ?? `${wf}/plan.md`}, report ${state.artifacts.report?.path ?? (state.review ? `${wf}/review-report.md` : "(none)")}, log ${wf}/log.md`,
		);
		if (state.review) {
			const coverage = reviewCoverage(state);
			lines.push(`- Review manifest: ${state.review.manifest.path} (${state.review.fingerprint}); coverage ${coverage.covered}/${coverage.total}; uncovered ${coverage.uncovered.length}`);
			if (state.review.pr) {
				const pr = state.review.pr;
				lines.push(`- PR: #${pr.number} ${pr.url} (${pr.state}); base ${pr.baseRef}@${pr.baseSha.slice(0, 8)} → head ${pr.headRef}@${pr.headSha.slice(0, 8)}`);
				lines.push(`- PR checkout: ${pr.checkoutStrategy} @ ${pr.checkoutLocation}${pr.checkoutStrategy === "in-place" ? ` (restore: ${prRestoreCommand(pr)})` : " (cleanup: /rpac pr-cleanup)"}`);
			}
		}
		lines.push("");
		if (state.tasks.length > 0) {
			lines.push("## Tasks");
			for (const t of state.tasks) {
				const checks = t.verification?.length ? ` [${t.verification.map((c) => `${c.name}:${c.result}`).join(", ")}]` : "";
				const issues = t.issues?.length ? ` — issues: ${t.issues.join("; ")}` : "";
				lines.push(`- [${t.status === "done" ? "x" : " "}] #${t.id} ${t.title} — ${t.status}${checks}${issues}`);
				for (const artifact of t.deliverables ?? []) lines.push(`  - deliverable: ${artifact.path} (${artifact.sha256.slice(0, 8)}…)`);
			}
			lines.push(open.length > 0 ? `Remaining: ${open.map((t) => `#${t.id} (${t.status})`).join(", ")}` : "All tasks complete.");
		}
		if (decisions.length > 0) {
			lines.push("");
			lines.push("## Decisions & deviations");
			for (const d of decisions.slice(-15)) lines.push(`- (${d.kind}) ${d.detail}`);
		}
		lines.push("");
		lines.push("## Continuation");
		lines.push(
			state.workflowKind === "review"
				? `You are a fresh session continuing an RPAC report-only${state.review?.pr ? ` PR #${state.review.pr.number}` : ""} review. Read ${wf}/workflow.json, its manifest, requirements, plan, batch artifacts, and log. Recheck snapshot drift, follow the rpac-review "PR REVIEW" section (for PR reviews) for phase "${state.phase}", and never edit reviewed files, Git state, or the remote. The PR head is checked out at the location recorded in workflow.json.`
				: `You are a fresh session continuing an RPAC workflow. The state files are the source of truth: read ${wf}/workflow.json, the requirements and plan listed above, and re-verify against the repository (git state may have moved). Continue in phase "${state.phase}" using the matching rpac-* skill. Do not commit or publish.`,
		);
		return lines.join("\n");
	}

	async function cmdHandoff(ctx: ExtensionCommandContext): Promise<void> {
		const root = rootOf(ctx.cwd);
		try {
			const { state } = loadActive(root, root);
			if (!state) throw new RpacStateError("not_found", "no active workflow");
			const text = buildHandoff(state);
			const handoffAbs = artifactFile(root, state.id, "handoff");
			// The handoff is written with the plain atomic writer — it is a
			// per-workflow artifact, and the gate only constrains REFINE/PLAN
			// model tool calls, never user commands.
			atomicWriteFile(handoffAbs, text + "\n");
			updateActive(root, (s) => {
				noteArtifact(s, root, "handoff");
				recordEvent(s, "handoff", "handoff.md written");
			});
			appendLog(root, state.id, `- **${nowIso()}** handoff written: .pi/rpac/${state.id}/handoff.md`);
			refreshUI(ctx.ui, root);
			ctx.ui.notify(`RPAC: handoff written to .pi/rpac/${state.id}/handoff.md`, "info");
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					`Non-TUI mode: fresh-session handoff needs interactive mode. Manual fallback — start a new Pi session in this project, then run: /rpac resume ${state.id}`,
					"info",
				);
				return;
			}
			const ok = await ctx.ui.confirm(
				"RPAC: start a fresh session from the handoff?",
				"A new session is created and the handoff prompt is queued as its first message. The current session is kept.",
			);
			if (!ok) return;
			const result = await ctx.newSession({
				withSession: async (newCtx) => {
					await newCtx.sendUserMessage(
						`RPAC fresh session (handoff from workflow ${state.id}).\n\n${text}\n\nThen run \`/rpac resume ${state.id}\` when you are ready to continue the workflow.`,
						{ deliverAs: "followUp" },
					);
				},
			});
			if (result.cancelled) {
				ctx.ui.notify("Handoff session cancelled.", "info");
			}
		} catch (err) {
			fail(ctx.ui, err, "handoff failed");
		}
	}

	pi.registerCommand("rpac", {
		description:
			"RPAC workflow: /rpac [start <task>|start preview <pr-number>|review [current|staged|full]|refine|plan|act|consolidate|approve|status|list|resume|accept|pause|abort|pr-cleanup|handoff|cleanup]",
		getArgumentCompletions: (prefix) => {
			const matches = SUBCOMMANDS.filter((s) => s.startsWith(prefix.toLowerCase()));
			if (matches.length === 0) return null;
			return matches.map((m) => ({ value: m, label: m, description: SUB_HELP[m] }));
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const sub = tokens.shift()?.toLowerCase() ?? "";
			const rest = tokens.join(" ");
			try {
				switch (sub) {
					case "":
					case "status":
					case "help":
						ctx.ui.notify(statusReport(rootOf(ctx.cwd)), "info");
						break;
					case "start":
						await cmdStart(ctx, rest);
						break;
					case "review":
						await cmdReview(ctx, rest);
						break;
					case "refine":
						await cmdRefine(ctx, rest);
						break;
					case "plan":
						await cmdPlan(ctx, rest);
						break;
					case "act":
						await cmdAct(ctx, rest);
						break;
					case "consolidate":
						await cmdConsolidate(ctx, rest);
						break;
					case "approve":
						await cmdApprove(ctx, rest);
						break;
					case "resume":
						await cmdResume(ctx, rest);
						break;
					case "accept":
						await cmdAccept(ctx, rest);
						break;
					case "list":
						await cmdList(ctx);
						break;
					case "pause":
						await cmdPause(ctx);
						break;
					case "abort":
						await cmdAbort(ctx, rest);
						break;
					case "pr-cleanup":
						await cmdPrCleanup(ctx, rest);
						break;
					case "handoff":
						await cmdHandoff(ctx);
						break;
					case "cleanup":
						await cmdCleanup(ctx, rest);
						break;
					default:
						ctx.ui.notify(
							`Unknown RPAC subcommand "${sub}".\n${SUBCOMMANDS.map((s) => `  /rpac ${SUB_HELP[s]}`).join("\n")}`,
							"error",
						);
				}
			} catch (err) {
				fail(ctx.ui, err, "command failed");
			}
		},
	});

	// ---- rpac tool (model-facing) --------------------------------------------

	/**
	 * Approvals are user-only. With a dialog UI the model's *_complete actions
	 * prompt the user directly; headless, the model is told what the user must
	 * run. The model can never approve on its own.
	 */
	async function requestApproval(
		ctx: {
			hasUI: boolean;
			ui: { confirm(t: string, m: string): Promise<boolean>; notify(m: string, t?: "info" | "warning" | "error"): void };
		},
		what: "requirements" | "plan",
		stateId: string,
	): Promise<boolean> {
		if (ctx.hasUI) {
			const title = what === "requirements" ? "RPAC: approve the requirements?" : "RPAC: approve the implementation plan?";
			const preview =
				what === "requirements"
					? `Requirements document: .pi/rpac/${stateId}/requirements.md`
					: `Implementation plan: .pi/rpac/${stateId}/plan.md (with its task list)`;
			return ctx.ui.confirm(title, `${preview}\n\nApprove and continue the workflow?`);
		}
		ctx.ui.notify(`RPAC needs user approval: run /rpac approve ${what} to continue.`, "warning");
		return false;
	}

	pi.registerTool({
		name: "rpac",
		label: "RPAC",
		description:
			"RPAC workflow state machine (Refine → Plan → Act → Consolidate). Actions: " +
			"status (read state), review_scope (review workflows: recapture manifest with exact exclusions), refine_complete (requirements artifact done — user must approve), " +
			"plan_complete (plan + task list done — user must approve), " +
			"task_start/task_done/task_fail/task_block/task_unblock (the task named by /rpac act is already started; use task_start only to advance sequential mode; task_done REQUIRES verification " +
			"checks and only passes when all acceptance checks pass; observation checks can record audited failures without failing the task; pass deliverables to hash task-produced files), " +
			"decision/deviation/checkpoint (record to the workflow log), consolidate_complete (report.md done), " +
			"back_to_plan/back_to_act (verification found a problem; back_to_act creates a repair task). " +
			"Use only inside an active RPAC workflow; state lives in .pi/rpac/<workflow-id>/workflow.json.",
		promptGuidelines: [
			"Only call `rpac` actions while an RPAC workflow is active (started via /rpac start or /rpac review).",
			"Never approve anything yourself: approvals happen via user dialogs or /rpac approve.",
			"Review workflows are report-only: write only their named workflow artifacts; findings become separate ordinary RPAC work, never source edits in the review.",
			"The task named in an ACT directive is already in_progress. Do not call task_start for it; in sequential mode, call task_start only after task_done succeeds.",
			"task_done requires real verification — run checks and report actual outcomes. Acceptance failures fail the task; for audit/review work, use kind=observation for a subject failure and a separate passing acceptance check that the result was correctly captured. Include every task-produced file in deliverables so RPAC can hash and track it.",
		],
		exposure: "model-only",
		executionMode: "sequential",
		parameters: RpacToolSchema,
		annotations: { readOnlyHint: false },
		execute: async (_id, params: RpacToolParams, _signal, _onUpdate, ctx) => {
			const ui: UiMin = ctx.ui;
			const root = rootOf(ctx.cwd);
			try {
				// --- read-only ---
				if (params.action === "status") {
					const { state } = loadActive(root, root);
					if (!state) return textResult("No active RPAC workflow. The user starts one with /rpac start <task>.");
					const done = state.tasks.filter((t) => t.status === "done").length;
					const open = state.tasks.filter((t) => t.status !== "done").map((t) => `#${t.id} ${t.status}`).join(", ");
					const coverage = state.review ? reviewCoverage(state) : null;
					return textResult(
						`RPAC state: kind ${state.workflowKind}${state.review ? ` (${state.review.mode})` : ""}; phase ${state.phase}${state.paused ? " (paused)" : ""}; approvals req=${state.approvals.requirements ? "✓" : "·"} plan=${state.approvals.plan ? "✓" : "·"} sequential=${state.approvals.sequential ? "✓" : "·"}; tasks ${done}/${state.tasks.length} done; open: ${open || "—"}; ready: ${readyTasks(state).join(", ") || "—"}${coverage ? `; coverage ${coverage.covered}/${coverage.total}, uncovered ${coverage.uncovered.length}${state.review?.drift ? ", drift detected" : ""}` : ""}; state dir: .pi/rpac/${state.id}/. Full detail: /rpac status.`,
						{ action: params.action, phase: state.phase, workflowKind: state.workflowKind },
					);
				}

				if (TASK_ACTIONS.has(params.action) && params.task === undefined) {
					throw new RpacGuardError(`${params.action} requires a "task" argument (task id number, or "next")`);
				}
				if (ACT_LEASE_ACTIONS.has(params.action)) {
					const active = loadActive(root, root).state;
					if (!active) throw new RpacStateError("not_found", "no active RPAC workflow");
					if (active.phase === "act") requireOwnedActLease(root, active, params.action, params.task);
				}

				// --- mutations (all under the state lock) ---
				const run = <T,>(mutate: (s: RpacState) => T): T => updateActive(root, mutate);

				let message = "";
				let logLine: string | undefined;
				let needsApproval: "requirements" | "plan" | undefined;

				switch (params.action) {
					case "review_scope": {
						const active = loadActive(root, root).state;
						if (!active) throw new RpacStateError("not_found", "no active RPAC workflow");
						const exclusions = (params.exclusions ?? []).map((entry) => ({ path: entry.path, reason: entry.reason.trim() }));
						if (exclusions.some((entry) => !entry.path || !entry.reason)) {
							throw new RpacGuardError("review_scope exclusions require an exact non-empty path and reason");
						}
						message = captureAndReplaceReviewScope(root, active, exclusions);
						logLine = `- **${nowIso()}** ${message}; exclusions: ${exclusions.length}`;
						break;
					}
					case "refine_complete": {
						const res = run((s) => refineComplete(s, artifactFile(root, s.id, "requirements"), relWorkflowArtifactPath(root, s.id, "requirements")));
						message = res.message;
						needsApproval = res.needsApproval;
						logLine = `- **${nowIso()}** requirements artifact finalized (.pi/rpac/${res.state.id}/requirements.md)`;
						break;
					}
					case "plan_complete": {
						const active = loadActive(root, root).state;
						if (active && isPrReview(active) && (params.reviewChecks ?? []).some(check => !hasPrCheckDirectory(active, check))) {
							throw new RpacGuardError(`PR review checks must include the checkout directory in the exact approved command: ${prCheckPrefix(active.review!.pr!.checkoutLocation)}`);
						}
						const res = run((s) => planComplete(
							s,
							artifactFile(root, s.id, "plan"),
							params.tasks ?? [],
							relWorkflowArtifactPath(root, s.id, "plan"),
							params.reviewChecks ?? [],
						));
						message = res.message;
						needsApproval = res.needsApproval;
						logLine = `- **${nowIso()}** plan finalized with ${res.state.tasks.length} tasks: ${res.state.tasks.map((t) => `${t.id}.${t.title}`).join("; ")}`;
						break;
					}
					case "task_start": {
						const before = loadActive(root, root).state;
						const requestedId = params.task === "next" ? undefined : Number(params.task);
						const current = before?.tasks.find((t) => t.status === "in_progress");
						if (current && requestedId === current.id) {
							return textResult(
								`Task ${current.id}/${before!.tasks.length} is already in progress under this /rpac act execution lease. Continue it; do not call task_start again.`,
								{ action: params.action, phase: before!.phase, taskId: current.id, alreadyStarted: true },
							);
						}
						message = run((s) => taskStart(s, params.task === "next" ? undefined : (params.task as number | string))).message;
						const active = loadActive(root, root).state;
						const started = active?.tasks.find((t) => t.status === "in_progress");
						if (!active || !started || !refreshLock(root, LEASE_NAME, { workflowId: active.id, taskId: started.id })) {
							throw new RpacLockError("lost the ACT execution lease while starting the next task");
						}
						logLine = `- **${nowIso()}** ${message}`;
						break;
					}
					case "task_done": {
						const before = loadActive(root, root).state;
						if (!before) throw new RpacStateError("not_found", "no active RPAC workflow");
						const targetId = Number(params.task);
						if (before.workflowKind === "review") {
							const expected = relative(root, reviewBatchFile(root, before.id, targetId));
							const supplied = (params.deliverables ?? []).map((value) => relative(root, resolve(isAbsolute(value) ? value : join(root, value))));
							if (!supplied.includes(expected)) {
								throw new RpacGuardError(`review task_done requires its batch evidence deliverable: ${expected}`);
							}
							if (supplied.some((path) => path !== expected)) {
								throw new RpacGuardError("review task deliverables are report-only; only the current batch evidence artifact is allowed");
							}
						}
						const deliverables = captureDeliverables(root, params.deliverables);
						message = run((s) => taskDone(s, params.task as number | string, params.verification ?? [], params.deviations, deliverables)).message;
						logLine = `- **${nowIso()}** ${message}`;
						break;
					}
					case "task_fail": {
						message = run((s) => taskFail(s, params.task as number | string, params.text ?? "", params.verification)).message;
						logLine = `- **${nowIso()}** ${message}`;
						break;
					}
					case "task_block": {
						message = run((s) => taskBlock(s, params.task as number | string, params.text ?? "")).message;
						logLine = `- **${nowIso()}** ${message}`;
						break;
					}
					case "task_unblock": {
						message = run((s) => taskUnblock(s, params.task as number | string)).message;
						logLine = `- **${nowIso()}** ${message}`;
						break;
					}
					case "decision": {
						message = run((s) => mDecision(s, params.text ?? "")).message;
						logLine = `- **${nowIso()}** decision: ${params.text}`;
						break;
					}
					case "deviation": {
						message = run((s) => mDeviation(s, params.text ?? "")).message;
						logLine = `- **${nowIso()}** deviation: ${params.text}`;
						break;
					}
					case "checkpoint": {
						message = run((s) => {
							recordEvent(s, "checkpoint", params.text ?? "");
							s.checkpoints.push({ at: nowIso(), what: params.text ?? "" });
							return { state: s, message: "Checkpoint recorded." };
						}).message;
						logLine = `- **${nowIso()}** checkpoint: ${params.text}`;
						break;
					}
					case "consolidate_complete": {
						const before = loadActive(root, root).state;
						if (!before) throw new RpacStateError("not_found", "no active RPAC workflow");
						if (before.workflowKind === "review") {
							const driftMessage = recheckReviewSnapshot(root, before, gh);
							if (driftMessage && !/unchanged/.test(driftMessage)) message = `${driftMessage} `;
						}
						message += run((s) => {
							const report = s.workflowKind === "review" ? reviewReportFile(root, s.id) : artifactFile(root, s.id, "report");
							const rel = s.workflowKind === "review" ? relArtifactPath(root, report) : relWorkflowArtifactPath(root, s.id, "report");
							return consolidateComplete(s, report, params.text, rel);
						}).message;
						logLine = `- **${nowIso()}** ${message}`;
						break;
					}
					case "back_to_plan": {
						message = run((s) => backToPlan(s, params.text ?? "")).message;
						logLine = `- **${nowIso()}** ${message}`;
						break;
					}
					case "back_to_act": {
						message = run((s) => backToAct(s, params.text ?? "")).message;
						logLine = `- **${nowIso()}** ${message}`;
						break;
					}
					default:
						throw new RpacGuardError(`unknown action ${String(params.action)}`);
				}

				// User approval gate (model may request, never self-approve).
				if (needsApproval) {
					const { state: cur } = loadActive(root, root);
					if (!cur) throw new RpacStateError("not_found", "state vanished during approval");
					const approved = await requestApproval(ctx, needsApproval, cur.id);
					if (approved) {
						const what = needsApproval;
						const latest = loadActive(root, root).state;
						if (!latest) throw new RpacStateError("not_found", "state vanished during approval");
						if (latest.id !== cur.id) {
							throw new RpacGuardError("the active workflow changed while approval was pending — review status and retry");
						}
						requireApprovalArtifact(root, latest, what);
						message = run((s) => {
							if (s.id !== cur.id) throw new RpacGuardError("active workflow changed during approval");
							return what === "requirements" ? approveRequirements(s) : approvePlan(s);
						}).message;
						// Keep the finalize line AND record the approval as a second line.
						const approvalLine = `- **${nowIso()}** approved: ${what}`;
						logLine = logLine ? `${logLine}\n${approvalLine}` : approvalLine;
					} else {
						message += `\nAwaiting user approval — the user will run /rpac approve ${needsApproval} (or confirm the dialog). Do not proceed to the next phase until approval is recorded (check with action "status").`;
					}
				}
				const curId = loadActive(root, root).state?.id;
				if (logLine && curId) {
					for (const line of logLine.split("\n")) appendLog(root, curId, line);
				}
				// Activity refresh while executing a task.
				if (holdsLock(root, LEASE_NAME)) refreshLock(root, LEASE_NAME);
				refreshUI(ui, root);
				return textResult(message, { action: params.action });
			} catch (err) {
				const msg =
					err instanceof RpacLockError || err instanceof RpacStateError || err instanceof RpacGuardError
						? err.message
						: (err as Error)?.message ?? "rpac action failed";
				return textResult(`RPAC error: ${msg}`, { action: params.action, error: true });
			}
		},
	});

	// ---- lifecycle ------------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		// Cheap: one locked load + status/footer refresh. Disk state is the
		// source of truth, so nothing needs to be injected into the model
		// context here (the tiny per-turn context is added by before_agent_start).
		try {
			const { notes } = loadActive(rootOf(ctx.cwd), rootOf(ctx.cwd));
			reportNotes(ctx.ui, notes);
		} catch {
			// ignore — surfaced on the next /rpac status
		}
		refreshUI(ctx.ui, rootOf(ctx.cwd));
	});

	pi.on("session_shutdown", (_event, ctx) => {
		// Release the ACT lease: this process will execute no more tasks.
		try {
			const root = rootOf(ctx.cwd);
			if (holdsLock(root, LEASE_NAME)) releaseLock(root, LEASE_NAME);
		} catch {
			// best effort
		}
		ctx.ui.setStatus("rpac", undefined);
		ctx.ui.setWidget("rpac-tasks", undefined);
	});

	// ---- planning + report-only review gate ----------------------------------

	pi.on("tool_call", (event, ctx) => {
		try {
			const root = rootOf(ctx.cwd);
			const state = peekActive(root, root);
			if (!state) {
				const stateFilesExist =
					existsSync(join(root, ".pi", "rpac", "state.json")) ||
					existsSync(join(root, ".pi", "rpac", "workflow.json"));
				if (stateFilesExist) {
					const decision = gateUnreadableState(event.toolName);
					if (decision) return decision;
				}
				return;
			}
			if (state.workflowKind === "review" || state.phase === "refine" || state.phase === "plan") {
				const decision = gateToolCall(state, ctx.cwd, event.toolName, event.input as Record<string, unknown> | undefined, root);
				if (decision) return { block: true, reason: decision.reason };
				if (isPrReview(state) && typeof (event.input as Record<string, unknown>)?.command === "string" &&
					isApprovedReviewCheck(state, (event.input as { command: string }).command)) {
					assertPrCheckout(root, state.review!.pr!);
				}
			}
			// Activity refresh: the model is making progress on an ACT task.
			if (state.phase === "act" && holdsLock(root, LEASE_NAME)) refreshLock(root, LEASE_NAME);
		} catch (err) {
			// Failure to establish review/check provenance must not allow execution.
			return { block: true, reason: `RPAC cannot safely authorize this tool call: ${(err as Error).message}` };
		}
	});

	// ---- tiny per-turn phase context (MTP2-style) ------------------------------

	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			const root = rootOf(ctx.cwd);
			const state = peekActive(root, root);
			if (!state) return;
			const text = phaseContext(state, root);
			if (!text) return;
			return {
				message: { customType: "rpac-context", content: text, display: false },
			};
		} catch {
			return;
		}
	});

	// ---- end of model execution cycle ------------------------------------------

	pi.on("agent_end", async (_event, ctx) => {
		const root = rootOf(ctx.cwd);
		// Record interruption while the lease still excludes workflow switching;
		// only then release it for the next execution cycle.
		try {
			const lease = holdsLock(root, LEASE_NAME) ? readLockRecord(root, LEASE_NAME) : null;
			const { state } = loadActive(root, root);
			if (
				lease && state && lease.workflowId === state.id && state.phase === "act" && !state.paused &&
				state.tasks.some((t) => t.id === lease.taskId && t.status === "in_progress")
			) {
				updateActive(root, (s) => markInterrupted(s));
				appendLog(root, state.id, `- **${nowIso()}** task interrupted: agent run ended with a task still in progress`);
			}
		} catch {
			// best effort — status will surface whatever happened
		} finally {
			try {
				if (holdsLock(root, LEASE_NAME)) releaseLock(root, LEASE_NAME);
			} catch {
				// best effort
			}
		}
		refreshUI(ctx.ui, root);
	});
}
