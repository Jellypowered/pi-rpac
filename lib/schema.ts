// RPAC workflow state — schema, types, validation. Pure (node builtins only).
//
// Version 3: workflow kinds and durable review snapshot/coverage metadata.
// Version 2 introduced per-workflow storage and explicit task outcomes.

export const RPAC_STATE_VERSION = 3;

export const RPAC_PHASES = ["refine", "plan", "act", "consolidate", "done", "aborted"] as const;
export type RpacPhase = (typeof RPAC_PHASES)[number];

export const TASK_STATUSES = [
	"pending",
	"in_progress",
	"done",
	"blocked",
	"failed",
	"interrupted",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const WORKFLOW_KINDS = ["implementation", "review"] as const;
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];

export const REVIEW_MODES = ["current", "staged", "full"] as const;
/** GitHub PR review mode — a distinct source from the worktree snapshot modes. */
export const PR_REVIEW_MODE = "pr" as const;
export const ALL_REVIEW_MODES = [...REVIEW_MODES, PR_REVIEW_MODE] as const;
export type ReviewMode = (typeof ALL_REVIEW_MODES)[number];

/**
 * Durable identity + checkout record for a GitHub PR review. Present exactly
 * when a review workflow targets a pull request (mode "pr"). The snapshot
 * scope is the object-level base...head diff; the checkout only makes the PR
 * head inspectable/testable and is a preparation step, not mutation permission.
 */
export interface PrReviewMeta {
	number: number;
	url: string;
	title: string;
	body: string;
	/** base repository as "owner/name" (the repository the PR targets). */
	repository: string;
	state: "open" | "closed" | "merged";
	/** head lives in a fork (cross-repository PR). */
	crossRepository: boolean;
	baseRef: string;
	baseSha: string;
	headRef: string;
	headSha: string;
	headRepositoryOwner?: string;
	/** repository state captured before the checkout (restore reference). */
	originalBranch: string;
	originalHead: string;
	originalDirty: string[];
	/** "in-place" (gh pr checkout in this worktree) or "worktree" (isolated). */
	checkoutStrategy: "in-place" | "worktree";
	/** absolute location where the PR head was checked out for inspection. */
	checkoutLocation: string;
	checkedOutAt: string;
}

export interface RpacReviewState {
	mode: ReviewMode;
	/** fingerprint and artifact for the approved review scope */
	fingerprint: string;
	manifest: RpacArtifact;
	head: string;
	unborn: boolean;
	capturedAt: string;
	/** stable ids from the manifest; plan tasks assign these exactly once */
	scopeItemIds: string[];
	coveredItemIds: string[];
	uncoveredItemIds: string[];
	approvedChecks: string[];
	exclusions: { path: string; reason: string }[];
	/** GitHub PR review metadata; present exactly when mode is "pr". */
	pr?: PrReviewMeta;
	drift?: {
		detectedAt: string;
		fingerprint: string;
		addedItemIds: string[];
		removedItemIds: string[];
		changedItemIds: string[];
	};
}

/** Terminal task outcomes that stop sequential execution and block task_start. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["done", "blocked"];

/** A verification check attached to a finished (or failed) task. result: pass | fail | unavailable */
export interface VerificationCheck {
	name: string;
	/** acceptance checks determine task success; observations record audited subject outcomes without blocking the task */
	kind?: "acceptance" | "observation";
	result: "pass" | "fail" | "unavailable";
	detail?: string;
}

export interface RpacTask {
	id: number;
	title: string;
	status: TaskStatus;
	/** ids of tasks that must be done before this one (from the plan) */
	dependsOn?: number[];
	/** review manifest items assigned to this task (review workflows only) */
	reviewItemIds?: string[];
	/** filled when done */
	doneAt?: string;
	verification?: VerificationCheck[];
	issues?: string[];
	/** hashed files produced by this task, including report-only outputs under .pi/rpac */
	deliverables?: RpacArtifact[];
	/** user-documented exception that accepted a failed task as done */
	acceptedException?: string;
}

export interface RpacHistoricalTask extends RpacTask {
	supersededAt: string;
	reason: string;
}

export interface RpacArtifact {
	/** project-root-relative path */
	path: string;
	sha256: string;
	updatedAt?: string;
}

export interface RpacBaseline {
	head: string;
	branch: string;
	/** dirty (modified/untracked) files at baseline, relative to repo root */
	dirty: string[];
	createdAt: string;
}

export interface RpacCheckpoint {
	at: string;
	what: string;
	head?: string;
}

export interface RpacEvent {
	at: string;
	kind: string;
	detail: string;
}

export interface RpacState {
	version: number;
	/** omitted in legacy v2 files; validation defaults it to implementation */
	workflowKind: WorkflowKind;
	/** workflow id, e.g. "w-1a2b3c4d" — also the directory name under .pi/rpac/ */
	id: string;
	/** absolute project root the workflow is bound to */
	project: string;
	/** one-line task description */
	task: string;
	phase: RpacPhase;
	paused: boolean;
	approvals: {
		requirements: boolean;
		plan: boolean;
		sequential: boolean;
	};
	tasks: RpacTask[];
	/** completed task evidence retained when an approved plan is superseded */
	taskHistory: RpacHistoricalTask[];
	artifacts: {
		requirements?: RpacArtifact;
		plan?: RpacArtifact;
		report?: RpacArtifact;
		handoff?: RpacArtifact;
		reviewManifest?: RpacArtifact;
	};
	/** present exactly when workflowKind is review */
	review?: RpacReviewState;
	baseline?: RpacBaseline;
	checkpoints: RpacCheckpoint[];
	/** bounded (last 50) append-only event trail */
	events: RpacEvent[];
	createdAt: string;
	updatedAt: string;
}

/** Top-level index under .pi/rpac/state.json. */
export interface WorkflowSummary {
	id: string;
	task: string;
	phase: RpacPhase;
	workflowKind: WorkflowKind;
	updatedAt: string;
}

export interface RpacIndex {
	version: number;
	/** id of the workflow the user is working on (most recently started) */
	active: string | null;
	workflows: Record<string, WorkflowSummary>;
}

export const MAX_EVENTS = 50;
export const MAX_CHECKPOINTS = 100;
export const MAX_TASK_HISTORY = 200;

/** Minimums for a non-trivial artifact before a user approval is valid. */
export const SUBSTANTIVE_MIN_CHARS = 80;
export const SUBSTANTIVE_MIN_LINES = 3;

export class RpacStateError extends Error {
	readonly code:
		| "not_found"
		| "corrupt"
		| "unsupported_version"
		| "wrong_project"
		| "invalid";
	constructor(code: RpacStateError["code"], message: string) {
		super(message);
		this.name = "RpacStateError";
		this.code = code;
	}
}

const PHASE_SET = new Set<string>(RPAC_PHASES);
const STATUS_SET = new Set<string>(TASK_STATUSES);
const RESULT_SET = new Set<string>(["pass", "fail", "unavailable"]);
const CHECK_KIND_SET = new Set<string>(["acceptance", "observation"]);
const WORKFLOW_KIND_SET = new Set<string>(WORKFLOW_KINDS);
const REVIEW_MODE_SET = new Set<string>(ALL_REVIEW_MODES);

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
	return typeof v === "string";
}

function isBoolean(v: unknown): v is boolean {
	return typeof v === "boolean";
}

function isNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every(isString);
}

function isSha(v: unknown): v is string {
	return isString(v) && /^[0-9a-f]{64}$/.test(v);
}

/**
 * A full git commit SHA: 40 hex (SHA-1, the default) or 64 hex (SHA-256
 * repositories). Distinct from `isSha`, which is a 64-hex content digest.
 */
function isGitSha(v: unknown): v is string {
	return isString(v) && (/^[0-9a-f]{40}$/.test(v) || /^[0-9a-f]{64}$/.test(v));
}

const PR_STATE_SET = new Set<string>(["open", "closed", "merged"]);
const PR_STRATEGY_SET = new Set<string>(["in-place", "worktree"]);

/** Parse + validate the optional `pr` review metadata block. */
function parsePrMeta(raw: unknown): PrReviewMeta | undefined {
	if (raw === undefined) return undefined;
	if (!isRecord(raw)) throw new RpacStateError("corrupt", "review pr metadata is not an object");
	if (!isNumber(raw.number) || !Number.isSafeInteger(raw.number) || raw.number < 1) {
		throw new RpacStateError("corrupt", "review pr metadata has an invalid PR number");
	}
	for (const key of ["url", "title", "body", "repository", "baseRef", "baseSha", "headRef", "headSha", "originalBranch", "originalHead", "checkoutStrategy", "checkoutLocation", "checkedOutAt"] as const) {
		if (!isString(raw[key])) throw new RpacStateError("corrupt", `review pr metadata is missing ${key}`);
	}
	if (typeof raw.crossRepository !== "boolean") throw new RpacStateError("corrupt", "review pr metadata has invalid crossRepository");
	if (!isGitSha(raw.baseSha) || !isGitSha(raw.headSha)) throw new RpacStateError("corrupt", "review pr metadata has invalid base/head SHAs");
	if (!isString(raw.state) || !PR_STATE_SET.has(raw.state as string)) throw new RpacStateError("corrupt", "review pr metadata has an invalid PR state");
	if (!isString(raw.checkoutStrategy) || !PR_STRATEGY_SET.has(raw.checkoutStrategy as string)) throw new RpacStateError("corrupt", "review pr metadata has an invalid checkout strategy");
	if (!Array.isArray(raw.originalDirty) || !raw.originalDirty.every(isString)) {
		throw new RpacStateError("corrupt", "review pr metadata has invalid originalDirty");
	}
	const str = (key: string): string => raw[key] as string;
	const pr: PrReviewMeta = {
		number: raw.number,
		url: str("url"),
		title: str("title"),
		body: str("body"),
		repository: str("repository"),
		state: raw.state as PrReviewMeta["state"],
		crossRepository: Boolean(raw.crossRepository),
		baseRef: str("baseRef"),
		baseSha: str("baseSha"),
		headRef: str("headRef"),
		headSha: str("headSha"),
		originalBranch: str("originalBranch"),
		originalHead: str("originalHead"),
		originalDirty: [...(raw.originalDirty as string[])],
		checkoutStrategy: raw.checkoutStrategy as PrReviewMeta["checkoutStrategy"],
		checkoutLocation: str("checkoutLocation"),
		checkedOutAt: str("checkedOutAt"),
	};
	if (isString(raw.headRepositoryOwner)) pr.headRepositoryOwner = raw.headRepositoryOwner;
	return pr;
}

/**
 * True when an artifact has enough content to be meaningful (requirements/plan).
 * A one-line stub is not an approved-able artifact.
 */
export function isSubstantive(text: string, minChars = SUBSTANTIVE_MIN_CHARS, minLines = SUBSTANTIVE_MIN_LINES): boolean {
	const trimmed = text.trim();
	if (trimmed.length < minChars) return false;
	const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
	return lines.length >= minLines;
}

/**
 * Validate a task dependency graph: every reference must exist, no self
 * references, and the graph must be acyclic. `n` is the number of tasks
 * (ids are 1..n). Throws Error with a descriptive message on violation.
 */
export function validateTaskGraph(deps: (number[] | undefined)[], n: number): void {
	for (let i = 0; i < n; i++) {
		for (const d of deps[i] ?? []) {
			if (!Number.isInteger(d) || d < 1 || d > n) {
				throw new Error(`task ${i + 1} depends on unknown task ${d} (valid ids: 1..${n})`);
			}
			if (d === i + 1) {
				throw new Error(`task ${i + 1} depends on itself`);
			}
		}
	}
	// cycle detection: iterative DFS with 0=unvisited 1=in-stack 2=done
	const state = new Array<number>(n + 1).fill(0);
	for (let start = 1; start <= n; start++) {
		if (state[start]) continue;
		const stack: { id: number; next: number }[] = [{ id: start, next: 0 }];
		state[start] = 1;
		while (stack.length > 0) {
			const frame = stack[stack.length - 1]!;
			const children = deps[frame.id - 1] ?? [];
			let advanced = false;
			while (frame.next < children.length) {
				const d = children[frame.next]!;
				frame.next++;
				if (state[d] === 0) {
					state[d] = 1;
					stack.push({ id: d, next: 0 });
					advanced = true;
					break;
				}
				if (state[d] === 1) {
					throw new Error(`dependency cycle detected involving task ${d} (and task ${frame.id})`);
				}
			}
			if (advanced) continue;
			state[frame.id] = 2;
			stack.pop();
		}
	}
}

/**
 * Validate and normalize a parsed JSON value into a well-formed RpacState.
 * Throws RpacStateError with a precise code on failure.
 */
export function validateState(raw: unknown, expectedProject?: string): RpacState {
	if (!isRecord(raw)) throw new RpacStateError("corrupt", "workflow.json is not a JSON object");

	if (typeof raw.version === "number" && raw.version > RPAC_STATE_VERSION) {
		throw new RpacStateError(
			"unsupported_version",
			`workflow state version ${raw.version} is newer than the supported version ${RPAC_STATE_VERSION} — refusing to touch it`,
		);
	}
	// Versions 1 (shared layout) and 2 (pre-review per-workflow layout) are
	// accepted and normalized; older binaries reject v3 rather than dropping
	// review metadata on save.
	if (raw.version !== 1 && raw.version !== 2 && raw.version !== RPAC_STATE_VERSION) {
		throw new RpacStateError(
			"unsupported_version",
			`unsupported workflow state version ${String(raw.version ?? "?")} (expected ${RPAC_STATE_VERSION})`,
		);
	}
	if (!isString(raw.id) || !raw.id) throw new RpacStateError("corrupt", "missing workflow id");
	if (!isString(raw.project) || !raw.project) {
		throw new RpacStateError("corrupt", "missing project root");
	}
	if (expectedProject && raw.project !== expectedProject) {
		throw new RpacStateError(
			"wrong_project",
			`workflow is bound to ${raw.project}, not ${expectedProject} — refusing to use it`,
		);
	}
	if (!isString(raw.task) || !raw.task.trim()) throw new RpacStateError("corrupt", "missing task description");
	if (!isString(raw.phase) || !PHASE_SET.has(raw.phase)) {
		throw new RpacStateError("corrupt", `invalid phase: ${String(raw.phase)}`);
	}
	if (!isString(raw.createdAt) || !isString(raw.updatedAt)) {
		throw new RpacStateError("corrupt", "missing createdAt/updatedAt");
	}

	if (raw.workflowKind !== undefined && (!isString(raw.workflowKind) || !WORKFLOW_KIND_SET.has(raw.workflowKind))) {
		throw new RpacStateError("corrupt", `invalid workflow kind: ${String(raw.workflowKind)}`);
	}
	const workflowKind: WorkflowKind = isString(raw.workflowKind) ? raw.workflowKind as WorkflowKind : "implementation";
	const state: RpacState = {
		version: RPAC_STATE_VERSION,
		workflowKind,
		id: raw.id,
		project: raw.project,
		task: raw.task,
		phase: raw.phase as RpacPhase,
		paused: Boolean(raw.paused),
		approvals: {
			requirements: false,
			plan: false,
			sequential: false,
		},
		tasks: [],
		taskHistory: [],
		artifacts: {},
		checkpoints: [],
		events: [],
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt,
	};
	const a = raw.approvals;
	if (isRecord(a)) {
		state.approvals = {
			requirements: Boolean(a.requirements),
			plan: Boolean(a.plan),
			sequential: Boolean(a.sequential),
		};
	}

	if (raw.tasks !== undefined) {
		if (!Array.isArray(raw.tasks)) throw new RpacStateError("corrupt", "tasks must be an array");
		const seen = new Set<number>();
		for (const t of raw.tasks) {
			if (!isRecord(t) || !isNumber(t.id) || !isString(t.title) || !isString(t.status) || !STATUS_SET.has(t.status)) {
				throw new RpacStateError("corrupt", "malformed task entry");
			}
			if (seen.has(t.id)) throw new RpacStateError("corrupt", `duplicate task id ${t.id}`);
			seen.add(t.id);
			const task: RpacTask = { id: t.id, title: t.title, status: t.status as TaskStatus };
			if (Array.isArray(t.dependsOn)) {
				const deps = (t.dependsOn as unknown[]).filter((d): d is number => typeof d === "number" && Number.isInteger(d));
				if (deps.length > 0) task.dependsOn = deps;
			}
			if (isStringArray(t.reviewItemIds)) task.reviewItemIds = [...new Set(t.reviewItemIds as string[])];
			if (isString(t.doneAt)) task.doneAt = t.doneAt;
			if (Array.isArray(t.verification)) {
				const checks: VerificationCheck[] = [];
				for (const c of t.verification) {
					if (isRecord(c) && isString(c.name) && isString(c.result) && RESULT_SET.has(c.result)) {
						checks.push({
							name: c.name,
							...(isString(c.kind) && CHECK_KIND_SET.has(c.kind) ? { kind: c.kind as VerificationCheck["kind"] } : {}),
							result: c.result as VerificationCheck["result"],
							...(isString(c.detail) ? { detail: c.detail } : {}),
						});
					}
				}
				if (checks.length > 0) task.verification = checks;
			}
			if (Array.isArray(t.deliverables)) {
				const deliverables: RpacArtifact[] = [];
				for (const artifact of t.deliverables) {
					if (isRecord(artifact) && isString(artifact.path) && isSha(artifact.sha256)) {
						deliverables.push({
							path: artifact.path,
							sha256: artifact.sha256,
							...(isString(artifact.updatedAt) ? { updatedAt: artifact.updatedAt } : {}),
						});
					}
				}
				if (deliverables.length > 0) task.deliverables = deliverables;
			}
			if (isStringArray(t.issues)) task.issues = t.issues;
			if (isString(t.acceptedException)) task.acceptedException = t.acceptedException;
			state.tasks.push(task);
		}
	}

	if (raw.taskHistory !== undefined) {
		if (!Array.isArray(raw.taskHistory)) throw new RpacStateError("corrupt", "taskHistory must be an array");
		for (const t of raw.taskHistory.slice(-MAX_TASK_HISTORY)) {
			if (
				!isRecord(t) || !isNumber(t.id) || !isString(t.title) || !isString(t.status) || !STATUS_SET.has(t.status) ||
				!isString(t.supersededAt) || !isString(t.reason)
			) {
				throw new RpacStateError("corrupt", "malformed taskHistory entry");
			}
			const historical: RpacHistoricalTask = {
				id: t.id,
				title: t.title,
				status: t.status as TaskStatus,
				supersededAt: t.supersededAt,
				reason: t.reason,
			};
			if (Array.isArray(t.dependsOn)) {
				const deps = (t.dependsOn as unknown[]).filter((d): d is number => typeof d === "number" && Number.isInteger(d));
				if (deps.length > 0) historical.dependsOn = deps;
			}
			if (isStringArray(t.reviewItemIds)) historical.reviewItemIds = [...new Set(t.reviewItemIds as string[])];
			if (isString(t.doneAt)) historical.doneAt = t.doneAt;
			if (Array.isArray(t.verification)) {
				const checks: VerificationCheck[] = [];
				for (const c of t.verification) {
					if (isRecord(c) && isString(c.name) && isString(c.result) && RESULT_SET.has(c.result)) {
						checks.push({
							name: c.name,
							...(isString(c.kind) && CHECK_KIND_SET.has(c.kind) ? { kind: c.kind as VerificationCheck["kind"] } : {}),
							result: c.result as VerificationCheck["result"],
							...(isString(c.detail) ? { detail: c.detail } : {}),
						});
					}
				}
				if (checks.length > 0) historical.verification = checks;
			}
			if (Array.isArray(t.deliverables)) {
				const deliverables: RpacArtifact[] = [];
				for (const artifact of t.deliverables) {
					if (isRecord(artifact) && isString(artifact.path) && isSha(artifact.sha256)) {
						deliverables.push({
							path: artifact.path,
							sha256: artifact.sha256,
							...(isString(artifact.updatedAt) ? { updatedAt: artifact.updatedAt } : {}),
						});
					}
				}
				if (deliverables.length > 0) historical.deliverables = deliverables;
			}
			if (isStringArray(t.issues)) historical.issues = t.issues;
			if (isString(t.acceptedException)) historical.acceptedException = t.acceptedException;
			state.taskHistory.push(historical);
		}
	}

	if (isRecord(raw.artifacts)) {
		for (const key of ["requirements", "plan", "report", "handoff", "reviewManifest"] as const) {
			const art = raw.artifacts[key];
			if (isRecord(art) && isString(art.path) && isSha(art.sha256)) {
				state.artifacts[key] = {
					path: art.path,
					sha256: art.sha256,
					...(isString(art.updatedAt) ? { updatedAt: art.updatedAt } : {}),
				};
			}
		}
	}

	if (workflowKind === "review") {
		const review = raw.review;
		if (!isRecord(review) || !isString(review.mode) || !REVIEW_MODE_SET.has(review.mode)) {
			throw new RpacStateError("corrupt", "review workflow is missing a valid review mode/state");
		}
		if (!isString(review.fingerprint) || !isSha(review.fingerprint) || !isRecord(review.manifest) ||
			!isString(review.manifest.path) || !isSha(review.manifest.sha256) || !isString(review.head) ||
			!isString(review.capturedAt) || !isStringArray(review.scopeItemIds) || !isStringArray(review.coveredItemIds) ||
			!isStringArray(review.uncoveredItemIds) || !isStringArray(review.approvedChecks) || !Array.isArray(review.exclusions)) {
			throw new RpacStateError("corrupt", "review workflow has malformed snapshot or coverage state");
		}
		const exclusions: { path: string; reason: string }[] = [];
		for (const exclusion of review.exclusions) {
			if (!isRecord(exclusion) || !isString(exclusion.path) || !isString(exclusion.reason)) {
				throw new RpacStateError("corrupt", "review workflow has malformed exclusions");
			}
			exclusions.push({ path: exclusion.path, reason: exclusion.reason });
		}
		const manifest: RpacArtifact = {
			path: review.manifest.path,
			sha256: review.manifest.sha256,
			...(isString(review.manifest.updatedAt) ? { updatedAt: review.manifest.updatedAt } : {}),
		};
		if (state.artifacts.reviewManifest &&
			(state.artifacts.reviewManifest.path !== manifest.path || state.artifacts.reviewManifest.sha256 !== manifest.sha256)) {
			throw new RpacStateError("corrupt", "review manifest artifact does not match review snapshot state");
		}
		state.artifacts.reviewManifest = { ...manifest };
		const pr = parsePrMeta(review.pr);
		if (((review.mode as string) === PR_REVIEW_MODE) !== Boolean(pr)) {
			throw new RpacStateError("corrupt", "pr review mode and metadata must occur together");
		}
		if (pr && review.head !== pr.headSha) throw new RpacStateError("corrupt", "pr review HEAD does not match pinned head SHA");
		state.review = {
			mode: review.mode as ReviewMode,
			fingerprint: review.fingerprint,
			manifest,
			head: review.head,
			unborn: Boolean(review.unborn),
			capturedAt: review.capturedAt,
			scopeItemIds: [...new Set(review.scopeItemIds as string[])],
			coveredItemIds: [...new Set(review.coveredItemIds as string[])],
			uncoveredItemIds: [...new Set(review.uncoveredItemIds as string[])],
			approvedChecks: [...new Set(review.approvedChecks as string[])],
			exclusions,
			...(pr ? { pr } : {}),
		};
		if (review.drift !== undefined) {
			if (!isRecord(review.drift) || !isString(review.drift.detectedAt) || !isSha(review.drift.fingerprint) ||
				!isStringArray(review.drift.addedItemIds) || !isStringArray(review.drift.removedItemIds) ||
				!isStringArray(review.drift.changedItemIds)) {
				throw new RpacStateError("corrupt", "review workflow has malformed drift state");
			}
			state.review.drift = {
				detectedAt: review.drift.detectedAt,
				fingerprint: review.drift.fingerprint,
				addedItemIds: [...new Set(review.drift.addedItemIds as string[])],
				removedItemIds: [...new Set(review.drift.removedItemIds as string[])],
				changedItemIds: [...new Set(review.drift.changedItemIds as string[])],
			};
		}
	} else if (raw.review !== undefined) {
		throw new RpacStateError("corrupt", "implementation workflow must not contain review state");
	}

	if (isRecord(raw.baseline) && isString(raw.baseline.head) && isString(raw.baseline.createdAt)) {
		state.baseline = {
			head: raw.baseline.head,
			branch: isString(raw.baseline.branch) ? raw.baseline.branch : "",
			dirty: isStringArray(raw.baseline.dirty) ? (raw.baseline.dirty as string[]) : [],
			createdAt: raw.baseline.createdAt,
		};
	}

	if (Array.isArray(raw.checkpoints)) {
		const cps: RpacCheckpoint[] = [];
		for (const c of raw.checkpoints) {
			if (isRecord(c) && isString(c.at) && isString(c.what)) {
				cps.push({ at: c.at, what: c.what, ...(isString(c.head) ? { head: c.head } : {}) });
			}
		}
		state.checkpoints = cps.slice(-MAX_CHECKPOINTS);
	}

	if (Array.isArray(raw.events)) {
		const evs: RpacEvent[] = [];
		for (const e of raw.events) {
			if (isRecord(e) && isString(e.at) && isString(e.kind) && isString(e.detail)) {
				evs.push({ at: e.at, kind: e.kind, detail: e.detail });
			}
		}
		state.events = evs.slice(-MAX_EVENTS);
	}

	return state;
}

/** Validate a parsed state.json index. Throws RpacStateError on failure. */
export function validateIndex(raw: unknown): RpacIndex {
	if (!isRecord(raw)) throw new RpacStateError("corrupt", "state.json is not a JSON object");
	if (raw.version !== 2 && raw.version !== RPAC_STATE_VERSION) {
		throw new RpacStateError("corrupt", `unsupported state index version ${String(raw.version ?? "?")}`);
	}
	const workflows: Record<string, WorkflowSummary> = {};
	const w = raw.workflows;
	if (isRecord(w)) {
		for (const [id, entry] of Object.entries(w)) {
			if (isRecord(entry) && isString(entry.id) && isString(entry.task) && isString(entry.phase) && isString(entry.updatedAt)) {
				workflows[id] = {
					id: entry.id,
					task: entry.task,
					phase: entry.phase as RpacPhase,
					workflowKind: isString(entry.workflowKind) && WORKFLOW_KIND_SET.has(entry.workflowKind)
						? entry.workflowKind as WorkflowKind
						: "implementation",
					updatedAt: entry.updatedAt,
				};
			}
		}
	}
	return {
		version: RPAC_STATE_VERSION,
		active: isString(raw.active) ? raw.active : null,
		workflows,
	};
}

/** Create a fresh state for a new workflow. */
export function newState(project: string, task: string, now = nowIsoDefault()): RpacState {
	return {
		version: RPAC_STATE_VERSION,
		workflowKind: "implementation",
		id: `w-${shortIdDefault()}`,
		project,
		task,
		phase: "refine",
		paused: false,
		approvals: { requirements: false, plan: false, sequential: false },
		tasks: [],
		taskHistory: [],
		artifacts: {},
		checkpoints: [],
		events: [],
		createdAt: now,
		updatedAt: now,
	};
}

export interface NewReviewStateInput {
	mode: ReviewMode;
	fingerprint: string;
	manifestSha256: string;
	head: string;
	unborn: boolean;
	capturedAt: string;
	scopeItemIds: string[];
	exclusions?: { path: string; reason: string }[];
	/** GitHub PR metadata (required when mode is "pr"). */
	pr?: PrReviewMeta;
	/** override the default "Self-review …" task string. */
	task?: string;
}

/** Create a review workflow around a manifest already captured on disk. */
export function newReviewState(
	project: string,
	input: NewReviewStateInput,
	now = nowIsoDefault(),
): RpacState {
	if (!isSha(input.manifestSha256)) throw new Error("review manifest SHA-256 is invalid");
	if (input.mode === PR_REVIEW_MODE && !input.pr) throw new Error("pr review requires pr metadata");
	const state = newState(project, input.task ?? `Self-review ${input.mode} snapshot`, now);
	state.workflowKind = "review";
	const manifest = {
		path: `.pi/rpac/${state.id}/review-manifest.json`,
		sha256: input.manifestSha256,
		updatedAt: now,
	};
	state.artifacts.reviewManifest = { ...manifest };
	state.review = {
		mode: input.mode,
		fingerprint: input.fingerprint,
		manifest: { ...manifest },
		head: input.head,
		unborn: input.unborn,
		capturedAt: input.capturedAt,
		scopeItemIds: [...new Set(input.scopeItemIds)],
		coveredItemIds: [],
		uncoveredItemIds: [],
		approvedChecks: [],
		exclusions: input.exclusions?.map((entry) => ({ ...entry })) ?? [],
		...(input.pr ? { pr: { ...input.pr, originalDirty: [...input.pr.originalDirty] } } : {}),
	};
	return state;
}

/** Cap the bounded arrays in place so the on-disk file stays small. */
export function capStateArrays(s: RpacState): void {
	if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
	if (s.checkpoints.length > MAX_CHECKPOINTS) s.checkpoints.splice(0, s.checkpoints.length - MAX_CHECKPOINTS);
	if (s.taskHistory.length > MAX_TASK_HISTORY) s.taskHistory.splice(0, s.taskHistory.length - MAX_TASK_HISTORY);
}

// Indirections so tests can stub time/ids without importing this module's deps.
import { nowIso as nowIsoDefault, shortId as shortIdDefault } from "./util.ts";
