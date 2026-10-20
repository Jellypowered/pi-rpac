// Explicitly authorized host execution for PR previews. This is NOT a sandbox or malware detector.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { RpacState, VerificationCheck } from "./schema.ts";
import { hostCommandIssue, prCheckPrefix, isReadOnlyCommand } from "./gating.ts";
import { atomicWriteFile, sha256File } from "./util.ts";
import { relArtifactPath, workflowDir } from "./paths.ts";
import { shellSegments, shellWords } from "./shell.ts";

export interface ScreeningInput {
	summary: string;
	files: string[];
	risks: string[];
	recommendation: "run" | "do-not-run";
}
export interface ExecutionInput {
	setupCommands?: string[];
	generatedPaths?: string[];
	screening: ScreeningInput;
}
export interface HostExecution {
	version: 1;
	setupCommands: string[];
	generatedPaths: string[];
	screening?: Omit<ScreeningInput, "files"> & { files: { path: string; sha256: string }[] };
	approval?: { at: string; digest: string; record?: { path: string; sha256: string } };
	runs: { command: string; kind: "setup" | "check"; startedAt: string; result: "running" | "pass" | "fail" | "unavailable"; taskId: number; approvalDigest: string; exitCode?: number; output?: { path: string; sha256: string }; detail?: string }[];
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value); }
function strings(value: unknown, max: number, length: number): value is string[] { return Array.isArray(value) && value.length <= max && value.every(entry => text(entry, length)); }
export function generatedPath(path: string): boolean {
	return /^[A-Za-z0-9_.\/-]+\/$/.test(path) && !isAbsolute(path) && path.split("/").filter(Boolean).every(part => part !== "." && part !== ".." && ![".git", ".pi"].includes(part));
}
export function parseHostExecution(raw: unknown): HostExecution {
	if (!object(raw) || raw.version !== 1 || !strings(raw.setupCommands, 20, 4096) || !strings(raw.generatedPaths, 16, 160) || !raw.generatedPaths.every(generatedPath) || !Array.isArray(raw.runs) || raw.runs.length > 100) throw new Error("Invalid preview host-execution record.");
	if (raw.screening !== undefined) {
		const s = raw.screening;
		if (!object(s) || !text(s.summary, 4000) || s.summary.trim().length < 80 || !strings(s.risks, 20, 1000) || !["run", "do-not-run"].includes(String(s.recommendation)) || !Array.isArray(s.files) || !s.files.length || s.files.length > 200 || !s.files.every(file => object(file) && text(file.path, 512) && !isAbsolute(file.path) && !file.path.split(/[\\/]/).includes("..") && sha(file.sha256))) throw new Error("Invalid preview script-screening evidence.");
	}
	if (raw.approval !== undefined && (!object(raw.approval) || !text(raw.approval.at, 40) || !sha(raw.approval.digest))) throw new Error("Invalid host-execution approval.");
	if (object(raw.approval) && raw.approval.record !== undefined && (!object(raw.approval.record) || !text(raw.approval.record.path, 512) || isAbsolute(raw.approval.record.path) || raw.approval.record.path.split(/[\\/]/).includes("..") || !sha(raw.approval.record.sha256))) throw new Error("Invalid host-approval evidence record.");
	for (const run of raw.runs) {
		if (!object(run) || !text(run.command, 4096) || !["setup", "check"].includes(String(run.kind)) || !text(run.startedAt, 40) || !["running", "pass", "fail", "unavailable"].includes(String(run.result)) || (!Number.isInteger(run.taskId) || Number(run.taskId) < 1) || !sha(run.approvalDigest) || (run.exitCode !== undefined && !Number.isInteger(run.exitCode)) || (run.detail !== undefined && !text(run.detail, 2000))) throw new Error("Invalid host-execution outcome.");
		if (run.output !== undefined && (!object(run.output) || !text(run.output.path, 512) || isAbsolute(run.output.path) || run.output.path.split(/[\\/]/).includes("..") || !sha(run.output.sha256))) throw new Error("Invalid host-execution log identity.");
	}
	// Reconstruct the permitted fields, rather than trusting arbitrary config/state properties.
	return { version: 1, setupCommands: [...raw.setupCommands], generatedPaths: [...raw.generatedPaths], ...(raw.screening ? { screening: structuredClone(raw.screening) as HostExecution["screening"] } : {}), ...(raw.approval ? { approval: { at: raw.approval.at as string, digest: raw.approval.digest as string, ...(raw.approval.record ? { record: structuredClone(raw.approval.record) as { path: string; sha256: string } } : {}) } } : {}), runs: structuredClone(raw.runs) as HostExecution["runs"] };
}
function insideFile(root: string, path: string): string {
	if (!text(path, 512) || isAbsolute(path) || path.split(/[\\/]/).some(part => part === ".." || part === ".git" || part === ".pi")) throw new Error(`Screened file must be a source file inside the PR checkout: ${path}`);
	const abs = resolve(root, path), rel = relative(root, abs);
	if (!rel || rel.startsWith("..") || isAbsolute(rel) || !existsSync(abs) || !lstatSync(abs).isFile() || lstatSync(abs).isSymbolicLink() || realpathSync(abs) !== abs) throw new Error(`Screened file is missing, linked, or outside the checkout: ${path}`);
	return abs;
}
export function prepareHostExecution(state: RpacState, checks: string[], input: ExecutionInput): HostExecution {
	const pr = state.review?.pr;
	if (!pr) throw new Error("Host execution is available only for PR previews.");
	const setupCommands = input.setupCommands ?? [], generatedPaths = input.generatedPaths ?? [];
	const screening = input.screening;
	const result: HostExecution = { version: 1, setupCommands, generatedPaths, runs: state.review?.execution?.runs ?? [], screening: { ...screening, files: [] } };
	if (!screening || !Array.isArray(screening.files)) throw new Error("Provide a script-screening summary, source files, risks and run/do-not-run recommendation before asking to execute PR code.");
	result.screening!.files = [...new Set(screening.files)].map(path => ({ path, sha256: sha256File(insideFile(pr.checkoutLocation, path)) }));
	parseHostExecution(result);
	for (const [commands, kind] of [[setupCommands, "setup"], [checks, "check"]] as const) for (const command of commands) {
		const issue = hostCommandIssue(pr.checkoutLocation, command, kind);
		if (issue) throw new Error(`Cannot approve ${kind} command: ${issue}. Adjust the plan before requesting approval.`);
	}
	// Package scripts, lifecycle hooks, registries and lockfiles are relevant inputs, not just the test file.
	if ([...setupCommands, ...checks].some(command => (shellSegments(command.slice(prCheckPrefix(pr.checkoutLocation).length)) ?? []).some(segment => ["npm", "npx"].includes(shellWords(segment)?.[0] ?? "")))) {
		if (!existsSync(join(pr.checkoutLocation, "package.json"))) throw new Error("The checkout has no package.json; choose the actual project toolchain rather than approving a predictably unavailable npm check.");
		if (setupCommands.length && !["package-lock.json", "npm-shrinkwrap.json"].some(file => existsSync(join(pr.checkoutLocation, file)))) throw new Error("npm ci requires a checkout lockfile. Supply an existing package-lock.json/npm-shrinkwrap.json or remove setup and record verification unavailable; do not generate a new lockfile during review.");
		for (const file of ["package.json", "package-lock.json", "npm-shrinkwrap.json", ".npmrc"]) {
			if (existsSync(join(pr.checkoutLocation, file)) && !result.screening!.files.some(entry => entry.path === file)) throw new Error(`Screen ${file} and include it in screening.files before host execution.`);
		}
		let manifest: { scripts?: Record<string, unknown> };
		try { manifest = JSON.parse(readFileSync(join(pr.checkoutLocation, "package.json"), "utf8")); } catch { throw new Error("package.json is not valid JSON; resolve this before approving npm execution."); }
		for (const command of checks) for (const segment of shellSegments(command.slice(prCheckPrefix(pr.checkoutLocation).length)) ?? []) {
			const words = shellWords(segment);
			if (words?.[0] === "npm" && ["test", "run"].includes(words[1] ?? "")) {
				const script = words[1] === "test" ? "test" : words[2]!;
				if (!manifest || !object(manifest.scripts) || !Object.hasOwn(manifest.scripts, script) || (typeof manifest.scripts[script] !== "string" || !manifest.scripts[script].trim())) throw new Error(`package.json does not define scripts.${script}; select a real check before approval.`);
			}
		}
	}
	return result;
}
export function executionDigest(state: RpacState): string {
	const execution = state.review?.execution, pr = state.review?.pr;
	if (!execution?.screening || !pr || !state.artifacts.plan) throw new Error("Finalize the screened execution plan first.");
	return createHash("sha256").update(JSON.stringify({ profileVersion: execution.version, workflow: state.id, fingerprint: state.review!.fingerprint, plan: state.artifacts.plan.sha256, head: pr.headSha, checkout: pr.checkoutLocation, checks: state.review!.approvedChecks, setup: execution.setupCommands, generated: execution.generatedPaths, screening: execution.screening })).digest("hex");
}
export function assertScreeningCurrent(root: string, state: RpacState): void {
	const execution = state.review?.execution, pr = state.review?.pr;
	if (!execution?.screening || !pr || !state.approvals.plan || !state.artifacts.plan) throw new Error("An approved plan and script-screening evidence are required. Finalize the plan first.");
	if (state.review!.drift) throw new Error("Review drift is unresolved. Revisit the scope and screening before executing code.");
	if (execution.screening.recommendation !== "run") throw new Error("The script review recommends do-not-run. Resolve the reported risks and replan; host approval cannot override that recommendation.");
	if (sha256File(join(root, state.artifacts.plan.path)) !== state.artifacts.plan.sha256) throw new Error("The plan changed. Finalize and approve the updated plan before executing code.");
	for (const file of execution.screening.files) if (sha256File(insideFile(pr.checkoutLocation, file.path)) !== file.sha256) throw new Error(`Screened file changed: ${file.path}. Re-screen and request fresh approval.`);
}
export function assertHostApproval(root: string, state: RpacState): void {
	assertScreeningCurrent(root, state);
	if (!state.review!.execution!.approval || state.review!.execution!.approval!.digest !== executionDigest(state)) throw new Error("Host execution has not been approved for this screened plan. The user must run /rpac approve execution (headless: /rpac approve execution --yes).");
	const record = state.review!.execution!.approval!.record;
	if (record && sha256File(join(root, record.path)) !== record.sha256) throw new Error("The saved host-approval record is missing or changed. Inspect the evidence and request fresh approval.");
}
export function unexecutedHostChecks(state: RpacState): string[] {
	const execution = state.review?.execution;
	if (!execution) return [];
	return state.review!.approvedChecks.filter(command => !isReadOnlyCommand(command) && !execution.runs.some(run => !!execution.approval && run.command === command && run.kind === "check" && run.approvalDigest === execution.approval?.digest && (run.result === "pass" || run.result === "fail")));
}
/** A final review task must not silently turn planned/deferred host tests into passes. */
export function requireRuntimeEvidence(state: RpacState, additional: VerificationCheck[]): void {
	const checks = [...state.tasks.flatMap(task => task.verification ?? []), ...additional];
	for (const command of unexecutedHostChecks(state)) {
		if (!checks.some(check => check.name === command && check.result === "unavailable" && (check.detail?.trim().length ?? 0) >= 20)) throw new Error(`No completed native execution exists for ${command}. Record this exact command as unavailable with a concrete reason; do not report a planned/deferred test as pass.`);
	}
}

export function hostApprovalText(state: RpacState): string {
	const execution = state.review!.execution!, s = execution.screening!;
	return `Execute reviewed PR commands ON THIS HOST? A separate checkout is NOT a sandbox. Code and dependencies can access host files, credentials, network and shared Git administration. Screening is a model assessment, NOT proof of safety. Approval trusts this code with your user account's access. npm ci may run dependency lifecycle hooks unless --ignore-scripts is used; downloaded dependency code is not exhaustively screened.\n\nCheckout: ${state.review!.pr!.checkoutLocation}\n\nScreening:\n${s.summary}\n\nRisks/limitations:\n${s.risks.join("\n") || "No specific risks reported; arbitrary/dependency code remains unproven."}\n\nSetup (network expected):\n${execution.setupCommands.join("\n") || "none"}\n\nChecks/builds (expected offline; host networking is NOT mechanically restricted):\n${state.review!.approvedChecks.join("\n") || "none"}\n\nExpected untracked output directories: ${execution.generatedPaths.join(", ") || "none"}. Tracked source edits are never hidden. No automatic cleanup or GitHub publishing. Approval covers only these exact commands and this plan/screening; changed inputs require fresh approval.\n\nWorkflow: ${state.id}\nPR head: ${state.review!.pr!.headSha}\nPlan SHA-256: ${state.artifacts.plan!.sha256}\nRecipe: ${executionDigest(state)}\n\nInspected files (${s.files.length}):\n${s.files.map(file => `${file.path} (${file.sha256})`).join("\n")}`;
}

/** Content-addressed, complete pre-consent dossier; never overwrite prior evidence. */
export function writeHostReview(root: string, state: RpacState): { text: string; path: string; sha256: string } {
	const text = hostApprovalText(state) + "\n";
	const sha256 = createHash("sha256").update(text).digest("hex");
	const path = join(workflowDir(root, state.id), `host-execution-review-${sha256}.txt`);
	let existing: Stats | undefined;
	try { existing = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	if (existing) {
		if (existing.isSymbolicLink() || !existing.isFile() || sha256File(path) !== sha256) throw new Error("Saved host-execution review differs from its content identity; preserving it and refusing approval.");
	} else atomicWriteFile(path, text);
	return { text, path: relArtifactPath(root, path), sha256 };
}

/** Bounded consent text: full commands/risks/inventory remain in the review, not this prompt. */
export function hostApprovalConfirmation(state: RpacState, reviewPath: string): string {
	const execution = state.review!.execution!;
	return `NOT a sandbox. Allow this PR code your account's host access: files, credentials, network and shared Git. Screening is NOT proof of safety; offline hints do NOT restrict networking.\n\nRecipe ${executionDigest(state).slice(0, 12)}: ${execution.setupCommands.length} setup, ${state.review!.approvedChecks.length} checks, ${execution.screening!.files.length} inspected files.\nRead the full commands, risks and outputs first:\n${reviewPath}\n\nApprove only this exact screened recipe?`;
}
