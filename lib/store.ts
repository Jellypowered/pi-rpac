// RPAC durable state store — .pi/rpac/ (state schema version 2).
//
// Layout:
//   .pi/rpac/state.json         index: active workflow + per-workflow summaries
//   .pi/rpac/<workflow-id>/     one directory per workflow (durable, immutable once done)
//
// Concurrency model: every mutation runs under an exclusive lock (lib/lock.ts,
// atomic O_EXCL create, ownership tokens). The canonical shape is
// load → validate → mutate → atomic save, all while holding the lock, so a
// snapshot loaded before the lock can never overwrite a concurrent update.
// workflow.json and state.json are written atomically (tmp + fsync + rename),
// so a crash mid-write cannot leave a partial file.
//
// Corrupt files are quarantined (moved to .pi/rpac/quarantine/), never deleted
// and never crash-looped on. Version-1 (shared-layout) state is migrated on
// first use; migration only moves files and records events — it never
// destroys state.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { nowIso, sha256File, atomicWriteFile, shortId } from "./util.ts";
import {
	type RpacIndex,
	type RpacState,
	type RpacTask,
	type WorkflowSummary,
	RpacStateError,
	validateIndex,
	validateState,
} from "./schema.ts";
import {
	type ArtifactName,
	artifactFile,
	indexPath,
	isValidWorkflowId,
	logFile,
	quarantineDir,
	relWorkflowArtifactPath,
	rpacDir,
	workflowDir,
	workflowFile,
} from "./paths.ts";
import { acquireLock, releaseLock } from "./lock.ts";

export const LOCK_NAME = ".lock";
export const LEASE_NAME = ".act-lease";

/** Log cap: keep the file human-readable; older entries are trimmed, not lost silently. */
export const LOG_MAX_LINES = 600;
export const LOG_KEEP_LINES = 500;

export type ArtifactWhich = "requirements" | "plan" | "report" | "handoff";

export interface LoadResult {
	index: RpacIndex;
	/** state of the active workflow (null when there is none) */
	state: RpacState | null;
	/** files quarantined during this load (for user-facing reporting) */
	quarantined: string[];
	migrated: boolean;
	notes: string[];
}

function emptyIndex(): RpacIndex {
	return { version: 2, active: null, workflows: {} };
}

/** Acquire the state lock, run `fn`, always release. All mutations go through this. */
function withStateLock<T>(root: string, fn: () => T): T {
	acquireLock(root, LOCK_NAME);
	try {
		return fn();
	} finally {
		releaseLock(root, LOCK_NAME);
	}
}

function summaryOf(s: RpacState): WorkflowSummary {
	return { id: s.id, task: s.task, phase: s.phase, updatedAt: s.updatedAt };
}

function pickActive(summaries: WorkflowSummary[]): string | null {
	if (summaries.length === 0) return null;
	const sorted = [...summaries].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
	const last = sorted[sorted.length - 1]!;
	const nonTerminal = sorted.filter((s) => s.phase !== "done" && s.phase !== "aborted");
	return nonTerminal.length > 0 ? nonTerminal[nonTerminal.length - 1]!.id : last.id;
}

/** Move a corrupt/invalid file to .pi/rpac/quarantine/ and return the new path. */
export function quarantineFile(root: string, path: string, tag: string): string | null {
	if (!existsSync(path)) return null;
	const dir = quarantineDir(root);
	mkdirSync(dir, { recursive: true });
	const name = join(dir, `${tag}-${Date.now()}-${process.pid}`);
	try {
		renameSync(path, name);
		return name;
	} catch {
		return null;
	}
}

/** Rebuild the index by scanning workflow directories (recovery path). */
function rebuildIndex(root: string, notes: string[]): RpacIndex {
	const index = emptyIndex();
	const base = rpacDir(root);
	let entries: string[] = [];
	try {
		entries = readdirSync(base);
	} catch {
		return index;
	}
	for (const entry of entries) {
		if (!isValidWorkflowId(entry)) continue;
		const f = join(base, entry, "workflow.json");
		if (!existsSync(f)) continue;
		try {
			const state = validateState(JSON.parse(readFileSync(f, "utf8")));
			index.workflows[state.id] = summaryOf(state);
		} catch (err) {
			if (err instanceof RpacStateError && err.code === "unsupported_version") {
				notes.push(`workflow ${entry}: ${err.message} — left untouched and excluded from the index`);
				continue;
			}
			const q = quarantineFile(root, f, `workflow-${entry}`);
			notes.push(`workflow ${entry}: state is invalid and was quarantined${q ? ` to ${q}` : ""}`);
		}
	}
	index.active = pickActive(Object.values(index.workflows));
	return index;
}

/** Migrate version-1 (shared-layout) state, if present. Must run under the lock. */
function migrateLegacy(root: string, notes: string[]): boolean {
	const legacyWf = join(rpacDir(root), "workflow.json");
	if (!existsSync(legacyWf)) return false;

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(legacyWf, "utf8"));
	} catch (err) {
		const q = quarantineFile(root, legacyWf, "legacy-workflow");
		notes.push(`legacy .pi/rpac/workflow.json was not valid JSON and was quarantined${q ? ` to ${q}` : ""}: ${(err as Error).message}`);
		return true;
	}
	let state: RpacState;
	try {
		state = validateState(raw); // accepts version 1, normalizes to 2
	} catch (err) {
		if (err instanceof RpacStateError && err.code === "unsupported_version") {
			notes.push(`legacy .pi/rpac/workflow.json: ${err.message} — left untouched`);
			return true;
		}
		const q = quarantineFile(root, legacyWf, "legacy-workflow");
		notes.push(`legacy .pi/rpac/workflow.json was invalid and was quarantined${q ? ` to ${q}` : ""}: ${err instanceof RpacStateError ? err.message : String(err)}`);
		return true;
	}
	if (state.project !== root) {
		notes.push(`legacy .pi/rpac/workflow.json belongs to another project root (${state.project}) — left untouched`);
		return true;
	}

	const id = isValidWorkflowId(state.id) ? state.id : `legacy-${shortId()}`;
	const dir = workflowDir(root, id);
	mkdirSync(dir, { recursive: true });

	// The shared artifact files on disk belong to this (most recent) workflow.
	for (const name of ["requirements", "plan", "log", "report", "handoff"] as ArtifactName[]) {
		const src = join(rpacDir(root), `${name}.md`);
		if (existsSync(src)) {
			try {
				renameSync(src, join(dir, `${name}.md`));
			} catch {
				notes.push(`migration: could not move shared ${name}.md into ${id}/ — it stays in place`);
			}
		}
	}
	// Point recorded artifact references at the per-workflow paths.
	const artMap: Record<string, ArtifactName> = {
		".pi/rpac/requirements.md": "requirements",
		".pi/rpac/plan.md": "plan",
		".pi/rpac/report.md": "report",
		".pi/rpac/handoff.md": "handoff",
	};
	for (const key of Object.keys(state.artifacts) as ArtifactWhich[]) {
		const art = state.artifacts[key];
		if (!art) continue;
		const name = artMap[art.path] ?? (key === "requirements" ? "requirements" : key === "plan" ? "plan" : key === "report" ? "report" : "handoff");
		if (existsSync(join(dir, `${name}.md`))) {
			state.artifacts[key] = { ...art, path: relWorkflowArtifactPath(root, id, name), updatedAt: nowIso() };
		}
	}
	state.events.push({ at: nowIso(), kind: "migration", detail: "migrated from the version-1 shared layout into .pi/rpac/<workflow-id>/" });
	atomicWriteFile(workflowFile(root, id), JSON.stringify(state, null, 2) + "\n");

	// Legacy archives: complete their directories (artifact files were shared and
	// cannot be attributed to older workflows — say so honestly).
	const archive = join(rpacDir(root), "archive");
	let archived = 0;
	try {
		for (const f of readdirSync(archive)) {
			if (!f.endsWith(".json")) continue;
			const src = join(archive, f);
			try {
				const s = validateState(JSON.parse(readFileSync(src, "utf8")));
				const wid = isValidWorkflowId(s.id) ? s.id : `legacy-${shortId()}`;
				mkdirSync(workflowDir(root, wid), { recursive: true });
				s.artifacts = {};
				s.events.push({ at: nowIso(), kind: "migration", detail: "migrated from the version-1 shared layout; shared artifact files were not attributable to this workflow" });
				atomicWriteFile(workflowFile(root, wid), JSON.stringify(s, null, 2) + "\n");
				try {
					rmSync(src);
					archived++;
				} catch {
					notes.push(`migration: archive ${f} was migrated but the original could not be removed`);
				}
			} catch (err) {
				const q = quarantineFile(root, src, `legacy-archive-${f.replace(/\.json$/, "")}`);
				notes.push(`legacy archive ${f} was invalid and was quarantined${q ? ` to ${q}` : ""}`);
			}
		}
		rmSync(archive, { recursive: true, force: true });
	} catch {
		// no archive directory — fine
	}

	// The legacy file has been fully processed — remove it now (its contents are
	// preserved in the new location).
	try {
		rmSync(legacyWf);
	} catch {
		notes.push("migration: legacy workflow.json could not be removed after migration");
	}
	notes.push(`migrated version-1 workflow ${id} into .pi/rpac/${id}/ (${archived} archived workflow(s) recovered)`);
	return true;
}

/**
 * Load the index + active workflow. Acquires the state lock (which also
 * serializes legacy migration), quarantines corrupt files, and rebuilds the
 * index from workflow directories when the index itself is corrupt.
 */
export function loadActive(root: string, expectedProject: string = root): LoadResult {
	return withStateLock(root, () => {
		const notes: string[] = [];
		const migrated = migrateLegacy(root, notes);
		let index: RpacIndex;
		const ip = indexPath(root);
		if (existsSync(ip)) {
			try {
				index = validateIndex(JSON.parse(readFileSync(ip, "utf8")));
			} catch {
				const q = quarantineFile(root, ip, "index");
				notes.push(`state.json was invalid and was quarantined${q ? ` to ${q}` : ""}; index rebuilt from workflow directories`);
				index = rebuildIndex(root, notes);
			}
		} else {
			index = rebuildIndex(root, notes);
		}
		let state: RpacState | null = null;
		let repairedIndex = false;
		while (index.active && !state) {
			const activeId = index.active;
			const wf = workflowFile(root, activeId);
			if (!existsSync(wf)) {
				notes.push(`active workflow ${activeId} has no workflow.json; removed its stale index entry`);
				delete index.workflows[activeId];
				index.active = pickActive(Object.values(index.workflows));
				repairedIndex = true;
				continue;
			}
			try {
				state = validateState(JSON.parse(readFileSync(wf, "utf8")), expectedProject);
			} catch (err) {
				if (err instanceof RpacStateError && (err.code === "unsupported_version" || err.code === "wrong_project")) {
					notes.push(`active workflow ${activeId}: ${err.message}`);
					break;
				}
				const q = quarantineFile(root, wf, `workflow-${activeId}`);
				notes.push(`active workflow ${activeId}: state is invalid and was quarantined${q ? ` to ${q}` : ""}; index repaired`);
				delete index.workflows[activeId];
				index.active = pickActive(Object.values(index.workflows));
				repairedIndex = true;
			}
		}
		if (repairedIndex) saveIndex(root, index, state);
		return { index, state, quarantined: [], migrated, notes };
	});
}

/**
 * Read the active workflow without taking the lock (best-effort, for hot
 * paths like the read-only phase gate). Returns null on any problem —
 * including a pending legacy migration, which is completed by the next
 * locked operation.
 */
export function peekActive(root: string, expectedProject: string = root): RpacState | null {
	try {
		const ip = indexPath(root);
		if (!existsSync(ip)) return null;
		const index = validateIndex(JSON.parse(readFileSync(ip, "utf8")));
		if (!index.active) return null;
		const wf = workflowFile(root, index.active);
		if (!existsSync(wf)) return null;
		return validateState(JSON.parse(readFileSync(wf, "utf8")), expectedProject);
	} catch {
		return null;
	}
}

function saveWorkflow(root: string, state: RpacState): void {
	if (state.project !== root) {
		throw new RpacStateError("wrong_project", `refusing to write state for ${state.project} into ${root}`);
	}
	state.updatedAt = nowIso();
	mkdirSync(workflowDir(root, state.id), { recursive: true });
	atomicWriteFile(workflowFile(root, state.id), JSON.stringify(state, null, 2) + "\n");
}

function saveIndex(root: string, index: RpacIndex, state?: RpacState | null): void {
	if (state) index.workflows[state.id] = summaryOf(state);
	atomicWriteFile(indexPath(root), JSON.stringify(index, null, 2) + "\n");
}

/**
 * Load → mutate → save under one lock. The mutator receives the (fresh)
 * active state; throwing it leaves everything untouched. `index` is kept in
 * sync automatically.
 */
export function updateActive<T>(root: string, mutate: (state: RpacState, index: RpacIndex) => T): T {
	return withStateLock(root, () => {
		const { index, state } = loadActive(root, root);
		if (!state) throw new RpacStateError("not_found", "no active RPAC workflow");
		const out = mutate(state, index);
		saveWorkflow(root, state);
		saveIndex(root, index, state);
		return out;
	});
}

export interface CreateResult {
	id: string;
	state: RpacState;
}

/**
 * Create a brand-new workflow and make it active. Throws RpacStateError
 * ("invalid") when a non-terminal active workflow exists — the caller must
 * get explicit user consent first and retry with `force: true`.
 */
export function createWorkflow(root: string, state: RpacState, force = false): CreateResult {
	return withStateLock(root, () => {
		const { index, state: existing } = loadActive(root, root);
		if (existing && existing.phase !== "done" && existing.phase !== "aborted" && !force) {
			throw new RpacStateError(
				"invalid",
				`an active RPAC workflow already exists (${existing.id}, phase ${existing.phase}, "${existing.task}"). ` +
					`Aborting/finishing it, or starting anyway with explicit consent, is required first.`,
			);
		}
		mkdirSync(workflowDir(root, state.id), { recursive: true });
		state.events.push({ at: nowIso(), kind: "workflow_started", detail: state.task });
		saveWorkflow(root, state);
		saveIndex(root, { ...index, active: state.id }, state);
		appendLog(root, state.id, `# RPAC log — ${state.id}\n\n- **${nowIso()}** workflow started: ${state.task}`);
		return { id: state.id, state };
	});
}

/** Make workflow `id` the active workflow (e.g. resuming an older one). */
export function switchActive(root: string, id: string): RpacState {
	return withStateLock(root, () => {
		const { index } = loadActive(root, root);
		const f = workflowFile(root, id);
		if (!existsSync(f)) throw new RpacStateError("not_found", `no workflow with id ${id}`);
		const state = validateState(JSON.parse(readFileSync(f, "utf8")), root);
		index.active = id;
		saveIndex(root, index, state);
		return state;
	});
}

/** Summaries of all known workflows (active first), for /rpac list. */
export function listWorkflows(root: string): WorkflowSummary[] {
	return withStateLock(root, () => {
		const { index } = loadActive(root, root);
		const all = Object.values(index.workflows);
		if (!index.active) return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		const active = all.find((w) => w.id === index.active);
		const rest = all.filter((w) => w.id !== index.active).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		return active ? [active, ...rest] : rest;
	});
}

/**
 * Append a line to the workflow's human-readable log (under the lock).
 * The log is bounded: once it exceeds LOG_MAX_LINES the oldest entries are
 * trimmed (a marker notes the trim), so it stays readable and small.
 */
export function appendLog(root: string, id: string, line: string): void {
	withStateLock(root, () => {
		const dir = workflowDir(root, id);
		mkdirSync(dir, { recursive: true });
		const f = logFile(root, id);
		const entry = line.endsWith("\n") ? line : line + "\n";
		if (!existsSync(f)) {
			atomicWriteFile(f, entry);
			return;
		}
		const existing = readFileSync(f, "utf8");
		const lines = existing.split("\n");
		if (lines.length + 1 > LOG_MAX_LINES) {
			const kept = [...lines.slice(lines.length - LOG_KEEP_LINES), ...entry.split("\n")];
			atomicWriteFile(f, `… (older log entries trimmed) …\n${kept.join("\n")}`);
			return;
		}
		atomicWriteFile(f, existing + entry);
	});
}

/**
 * Remove all RPAC state while preserving the lock files held by the caller.
 * The empty .pi/rpac directory is intentionally retained so exclusion remains
 * valid until the caller releases its control lease.
 */
export function removeAll(root: string): void {
	withStateLock(root, () => {
		const dir = rpacDir(root);
		for (const entry of readdirSync(dir)) {
			if (entry === LOCK_NAME || entry === LEASE_NAME) continue;
			rmSync(join(dir, entry), { recursive: true, force: true });
		}
	});
}

const ARTIFACT_FILES: Record<ArtifactWhich, ArtifactName> = {
	requirements: "requirements",
	plan: "plan",
	report: "report",
	handoff: "handoff",
};

/** Re-hash an on-disk workflow artifact into the state reference. */
export function noteArtifact(state: RpacState, root: string, which: ArtifactWhich): void {
	const name = ARTIFACT_FILES[which];
	const pathAbs = artifactFile(root, state.id, name);
	if (!existsSync(pathAbs)) return;
	const sha = sha256File(pathAbs);
	if (!sha) return;
	const prev = state.artifacts[which];
	state.artifacts[which] = {
		path: prev?.path ?? relWorkflowArtifactPath(root, state.id, name),
		sha256: sha,
		updatedAt: nowIso(),
	};
}

/**
 * True when the artifact file for this workflow exists on disk at its
 * recorded (or canonical) path.
 */
export function artifactPresent(root: string, id: string, which: ArtifactWhich): boolean {
	return existsSync(artifactFile(root, id, ARTIFACT_FILES[which]));
}

export function taskOf(state: RpacState, ref: number | string | undefined): RpacTask | undefined {
	if (ref === undefined) return undefined;
	const id = typeof ref === "number" ? ref : Number(ref);
	if (!Number.isInteger(id)) return undefined;
	return state.tasks.find((t) => t.id === id);
}
