// RPAC workflow state — schema, types, validation. Pure (node builtins only).
//
// Version 2: per-workflow storage (see paths.ts), explicit task outcomes
// (pending/in_progress/done/blocked/failed/interrupted), documented-exception
// acceptance for failed tasks.

export const RPAC_STATE_VERSION = 2;

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
	};
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
	// version 1 (legacy shared layout) is accepted for migration only.
	if (raw.version !== 1 && raw.version !== RPAC_STATE_VERSION) {
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

	const state: RpacState = {
		version: RPAC_STATE_VERSION,
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
		for (const key of ["requirements", "plan", "report", "handoff"] as const) {
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
	if (raw.version !== RPAC_STATE_VERSION) {
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

/** Cap the bounded arrays in place so the on-disk file stays small. */
export function capStateArrays(s: RpacState): void {
	if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
	if (s.checkpoints.length > MAX_CHECKPOINTS) s.checkpoints.splice(0, s.checkpoints.length - MAX_CHECKPOINTS);
	if (s.taskHistory.length > MAX_TASK_HISTORY) s.taskHistory.splice(0, s.taskHistory.length - MAX_TASK_HISTORY);
}

// Indirections so tests can stub time/ids without importing this module's deps.
import { nowIso as nowIsoDefault, shortId as shortIdDefault } from "./util.ts";
