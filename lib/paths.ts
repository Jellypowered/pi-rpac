// RPAC paths — project-local, human-readable layout under .pi/rpac/.
//
// Layout (state schema version 3):
//   .pi/rpac/state.json        top-level index (active workflow + summaries)
//   .pi/rpac/.lock             exclusive state lock
//   .pi/rpac/.act-lease        ACT execution lease
//   .pi/rpac/quarantine/       corrupt/invalid files, moved aside (never deleted)
//   .pi/rpac/<workflow-id>/    one directory per workflow (durable, never reused)
//       workflow.json
//       requirements.md plan.md log.md report.md handoff.md
import { join } from "node:path";

export type ArtifactName = "requirements" | "plan" | "log" | "report" | "handoff";

export function rpacDir(root: string): string {
	return join(root, ".pi", "rpac");
}
export function indexPath(root: string): string {
	return join(rpacDir(root), "state.json");
}
export function workflowDir(root: string, id: string): string {
	return join(rpacDir(root), id);
}
export function workflowFile(root: string, id: string): string {
	return join(workflowDir(root, id), "workflow.json");
}
export function artifactFile(root: string, id: string, name: ArtifactName): string {
	return join(workflowDir(root, id), `${name}.md`);
}
export function logFile(root: string, id: string): string {
	return artifactFile(root, id, "log");
}
export function reviewManifestFile(root: string, id: string): string {
	return join(workflowDir(root, id), "review-manifest.json");
}
export function reviewBatchFile(root: string, id: string, taskId: number): string {
	if (!Number.isInteger(taskId) || taskId < 1) throw new Error(`invalid review task id: ${taskId}`);
	return join(workflowDir(root, id), `review-batch-${taskId}.md`);
}
export function reviewReportFile(root: string, id: string): string {
	return join(workflowDir(root, id), "review-report.md");
}
export function quarantineDir(root: string): string {
	return join(rpacDir(root), "quarantine");
}
export function lockFile(root: string): string {
	return join(rpacDir(root), ".lock");
}
export function leaseFile(root: string): string {
	return join(rpacDir(root), ".act-lease");
}

/**
 * Safe workflow id: a single path segment, no leading dot. MTP4 ids were
 * `w-<8 hex>`; the same shape is the canonical form.
 */
export function isValidWorkflowId(id: string): boolean {
	if (!id || id.length > 64) return false;
	if (id === "." || id === "..") return false;
	return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(id);
}

/** Project-root-relative path of an artifact, for display in state. */
export function relArtifactPath(root: string, abs: string): string {
	const rel = abs.slice(root.length + 1);
	return rel.split("\\").join("/");
}

/** Project-root-relative artifact path (e.g. `.pi/rpac/<id>/plan.md`). */
export function relWorkflowArtifactPath(root: string, id: string, name: ArtifactName): string {
	return relArtifactPath(root, artifactFile(root, id, name));
}
