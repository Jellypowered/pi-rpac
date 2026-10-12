// RPAC git helpers — baseline capture + divergence detection.
// Thin wrappers over the git CLI; degrade gracefully outside a git repo.
import { execFileSync } from "node:child_process";
import type { RpacBaseline } from "./schema.ts";
import { nowIso } from "./util.ts";

export interface GitInfo {
	isRepo: boolean;
	root: string | null;
	head: string;
	branch: string;
	/** modified + untracked files, relative to repo root */
	dirty: string[];
}

function runGit(root: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
			timeout: 10_000,
		});
	} catch {
		return null;
	}
}

/** Snapshot the git working tree. `root` is the project root (git toplevel when in a repo). */
export function gitInfo(root: string): GitInfo {
	const topLevel = runGit(root, ["rev-parse", "--show-toplevel"])?.trim();
	if (!topLevel) {
		return { isRepo: false, root: null, head: "", branch: "", dirty: [] };
	}
	const head = runGit(topLevel, ["rev-parse", "HEAD"])?.trim() ?? "";
	const branch = runGit(topLevel, ["branch", "--show-current"])?.trim() ?? "";
	const status = runGit(topLevel, ["status", "--porcelain"]);
	const dirty: string[] = [];
	if (status) {
		for (const line of status.split("\n")) {
			if (!line.trim()) continue;
			// "XY <path>" (rename: "R  old -> new" — keep the new side)
			let p = line.slice(3);
			const arrow = p.indexOf(" -> ");
			if (arrow >= 0) p = p.slice(arrow + 4);
			p = p.trim();
			if (p) dirty.push(p);
		}
	}
	return { isRepo: true, root: topLevel, head, branch, dirty: [...new Set(dirty)] };
}

/** Capture a workflow baseline from the current working tree. */
export function captureBaseline(root: string): RpacBaseline | undefined {
	const info = gitInfo(root);
	if (!info.isRepo) return undefined;
	return { head: info.head, branch: info.branch, dirty: info.dirty, createdAt: nowIso() };
}

export interface Divergence {
	/** workflow has no baseline (non-git repo) — divergence checks are skipped */
	noBaseline: boolean;
	/** HEAD moved since baseline */
	headMoved: boolean;
	/** files that were dirty at baseline and were committed since */
	committedSince: string[];
	/** files dirty now that were not dirty at baseline */
	newDirty: string[];
	/** baseline-dirty files no longer dirty */
	cleanedSince: string[];
	/** changes under .pi/rpac/ — expected RPAC state churn, not user divergence */
	expectedRpacChanges: number;
	summary: string;
}

/**
 * Compare the current working tree with the workflow baseline.
 * Informational: RPAC never auto-resolves divergence, it only reports it.
 * Changes under `.pi/rpac/` are expected (RPAC writes its own state) and are
 * counted separately rather than reported as divergence.
 */
export function detectDivergence(root: string, baseline: RpacBaseline | undefined): Divergence {
	if (!baseline) {
		return {
			noBaseline: true,
			headMoved: false,
			committedSince: [],
			newDirty: [],
			cleanedSince: [],
			expectedRpacChanges: 0,
			summary: "no git baseline recorded",
		};
	}
	const info = gitInfo(root);
	if (!info.isRepo) {
		return {
			noBaseline: false,
			headMoved: false,
			committedSince: [],
			newDirty: info.dirty,
			cleanedSince: baseline.dirty,
			expectedRpacChanges: 0,
			summary: "repository no longer accessible — treat plan as possibly stale",
		};
	}
	const headMoved = info.head !== baseline.head;
	const isRpacPath = (f: string) => f.startsWith(".pi/") || f.startsWith(".pi\\");
	const baseSet = new Set(baseline.dirty);
	const nowSet = new Set(info.dirty);
	const externalCommitted = baseline.dirty.filter((f) => !nowSet.has(f) && !isRpacPath(f));
	const rpacNow = info.dirty.filter((f) => isRpacPath(f)).length;
	const rpacBase = baseline.dirty.filter((f) => isRpacPath(f)).length;
	const expectedRpacChanges = Math.max(rpacNow, rpacBase, 0);
	const newDirty = info.dirty.filter((f) => !baseSet.has(f) && !isRpacPath(f));
	const cleanedSince = externalCommitted;
	const parts: string[] = [];
	if (headMoved) {
		parts.push(`git HEAD moved (${baseline.head.slice(0, 8)} → ${info.head.slice(0, 8)})`);
	}
	if (externalCommitted.length > 0) parts.push(`${externalCommitted.length} baseline-dirty file(s) committed/changed`);
	if (newDirty.length > 0) parts.push(`${newDirty.length} new uncommitted file(s) since baseline`);
	if (parts.length === 0 && expectedRpacChanges > 0) {
		parts.push(`only RPAC state files under .pi/rpac/ changed (expected)`);
	}
	return {
		noBaseline: false,
		headMoved,
		committedSince: externalCommitted,
		newDirty,
		cleanedSince,
		expectedRpacChanges,
		summary: parts.length > 0 ? parts.join("; ") : "working tree matches baseline",
	};
}
