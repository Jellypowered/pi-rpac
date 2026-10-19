// Read-only planning and all-phase report-only review gating (mechanically enforced).
//
// During REFINE and PLAN the model may investigate freely, but may only write
// the single workflow artifact the current phase allows (refine →
// requirements.md, plan → plan.md). Application-code mutation through the
// built-in write/edit tools is blocked, and bash is restricted to a
// fail-closed read-only command policy. Ordinary ACT/CONSOLIDATE use normal Pi
// permissions. Reviews retain source/Git guards in every phase; separately
// consented PR host execution uses the native runner, never a raw-shell bypass.
//
// The gate hooks Pi's `tool_call` event, which also fires for nested
// (tool-issued / codemode) calls, so those are covered too.
//
// The read-only bash policy is an adaptation of MTP2's allowlist approach
// (itself inherited from Pi's plan-mode example extension).
import { isAbsolute, resolve, join } from "node:path";
import type { RpacState } from "./schema.ts";
import { shellSegments, shellWords, inspectionSpecialCase } from "./shell.ts";
import { artifactFile, reviewBatchFile, reviewReportFile } from "./paths.ts";

const DESTRUCTIVE_PATTERNS: RegExp[] = [
	// GitHub access for PR reviews is owned by the native preparation/drift path.
	// Approval of a project check never grants permission to publish a PR action.
	/\bgh\b/i,
	/\brm\b/,
	/\brmdir\b/,
	/\bmv\b/,
	/\bcp\b/,
	/\bmkdir\b/,
	/\btouch\b/,
	/\bchmod\b/,
	/\bchown\b/,
	/\bchgrp\b/,
	/\bln\b/,
	/\btee\b/,
	/\btruncate\b/,
	/\bcurl\b[^|;&)]*\s-[oO]\s+(?!-)\S/,
	/\bwget\b[^|;&)]*\s-[oO]\s+(?!-)\S/,
	/\bdd\b/,
	/\bshred\b/,
	/\b(sed\s+(-i|--in-place)|perl\s+-i|awk\s+.*\bprint\s*>)\b/i,
	/\bnpm\s+(install|uninstall|update|ci|link|publish|deprecate)\b/i,
	/\byarn\s+(add|remove|install|publish|upgrade)\b/i,
	/\bpnpm\s+(add|remove|install|publish)\b/i,
	/\bpip(\d)\s+(install|uninstall|freeze)\b/i,
	/\b(uv|poetry|pnpm-workspace)\s+(add|install|remove)\b/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade|full-upgrade)\b/i,
	/\b(dnf|yum)\s+(install|remove|erase|update|upgrade)\b/i,
	/\bbrew\s+(install|uninstall|upgrade|remove)\b/i,
	/\bgit\s+(?:(?:add|commit|push|pull|merge|rebase|reset|checkout|switch|stash(?!\s+list(?:\s|$))|cherry-pick|revert|tag|init|clone|am|apply|restore|clean|rm|mv|worktree|fetch|update-ref|update-index|read-tree|checkout-index|symbolic-ref|pack-refs|gc)(?=\s|$)|branch\s+(?:-[dD]\b|\w))/i,
	/\bgit\s+config\b(?!\s+--get(?:\s|$))/i,
	/\bsudo\b/,
	/\bsu\s+(-|\w)/,
	/\bkill(all)?\b/,
	/\breboot\b/,
	/\bshutdown\b/,
	/\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
	/\bservice\s+\S+\s+(start|stop|restart)\b/i,
	/\b(vim?|nano|emacs|code|subl|htop)\b/,
	/\bpython[23]?\s+.*\b(open|input)\s*\(\s*["'][^"']*["']\s*,\s*["']w/i,
	/\bnode\s+.*\bfs\.write/i,
	/\bfind\b[^|;&)]*\s-(delete|exec|execdir|ok|okdir|fls|fprint|fprint0|fprintf)\b/i,
	/\b(?:diff|git|sort)\b[^|;&)]*(?:--output(?:=|\s)|\s-o(?:\s|\S))/i,
	/\bnpm\s+audit\b[^|;&)]*--fix\b/i,
	/\bdate\b[^|;&)]*(?:\s-s(?:\s|$)|--set(?:=|\s))/i,
	/\bfile\b[^|;&)]*(?:--compile|\s-C(?:\s|$))/i,
];

const SAFE_PATTERNS: RegExp[] = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*grep\b/,
	/^\s*egrep\b/,
	/^\s*fgrep\b/,
	/^\s*zgrep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*cd(?:\s|$)/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*diff\b/,
	/^\s*diff -/i,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*free\b/,
	/^\s*javap\b/,
	/^\s*jq\b/,
	/^\s*cut\b/,
	/^\s*column\b/,
	/^\s*basename\b/,
	/^\s*dirname\b/,
	/^\s*realpath\b/,
	/^\s*readlink\b/,
	/^\s*xargs\s+(grep|ls|stat|file|wc|du|md5sum|sha256sum)\b/,
	/^\s*git\s+(status|log|diff|show|rev-parse|ls-files|shortlog|describe|merge-base|for-each-ref|name-rev)(?:\s|$)/i,
	/^\s*git\s+check-ignore(?:\s|$)/i,
	/^\s*git\s+stash\s+list\s*$/i,
	/^\s*git\s+remote(?:\s+-v)?\s*$/i,
	/^\s*git\s+branch(?:\s+(?:--list|-a|--all|-r|--remotes|--show-current|-v|-vv))*\s*$/i,
	/^\s*git\s+config\s+--get(?:\s|$)/i,
	/^\s*(node|deno|bun)\s+(?:-v|--(?:version|help))\s*$/i,
	/^\s*(python[23]?|ruby|perl|java)\s+--version\b/i,
	/^\s*docker\s+(ps|inspect|images|version)(?:\s|$)/i,
	/^\s*md5sum\b/,
	/^\s*sha256sum\b/,
	/^\s*test\b/,
	/^\s*\[/,
	/^\s*true\b/,
	/^\s*false\b/,
];

/** Replace quoted/escaped text so literal `>` characters are not parsed as shell operators. */
function shellSyntaxOnly(command: string): string | null {
	let result = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;
	for (const ch of command) {
		if (escaped) {
			result += " ";
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			result += " ";
			escaped = true;
			continue;
		}
		if (quote) {
			result += " ";
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			result += " ";
			continue;
		}
		result += ch;
	}
	return quote || escaped ? null : result;
}

/** Strip harmless output redirections used to suppress inspection noise. */
function stripSafeRedirections(command: string): string {
	return command
		.replace(/(?:\d+|&)?\s*>\s*\/dev\/null(?=\s|$)/g, "")
		.replace(/\d*\s*>\s*&\s*\d+(?=\s|$)/g, "")
		.trim();
}

/** True for output redirection outside quotes, except explicit suppression to `/dev/null`/another fd. */
function hasUnsafeOutputRedirection(command: string): boolean {
	const syntax = shellSyntaxOnly(command);
	if (syntax === null) return true;
	return stripSafeRedirections(syntax).includes(">");
}

/** Normalize leading env assignments and read-only git global options. */
function normalize(command: string): string {
	let result = command.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, "").trim();
	const git = result.match(
		/^git\s+(?:(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|--(?:no-pager|paginate|literal-pathspecs|glob-pathspecs|noglob-pathspecs|icase-pathspecs))\s+)+(.*)$/i,
	);
	if (git) result = `git ${git[1]}`;
	return result;
}

/**
 * Decide whether a bash command is allowed while REFINE/PLAN are active.
 * Piped/compound commands are checked segment by segment; every segment must
 * match the safe allowlist and none may match a destructive pattern
 * (fail-closed: unknown commands are blocked).
 */
function hasDestructiveShellSegment(rawCommand: string): boolean {
	const segments = shellSegments(rawCommand.trim());
	if (!segments?.length) return true;
	for (const seg of segments) {
		if (hasUnsafeOutputRedirection(seg)) return true;
		const withoutSafeRedirections = stripSafeRedirections(seg);
		const normalized = normalize(withoutSafeRedirections);
		// Unknown Git global options must not hide mutations from the denylist
		// (e.g. git --git-dir=... update-ref). Only known read-only Git syntax
		// may appear directly in an approved project check.
		if (/^git(?:\s|$)/i.test(normalized) && readOnlyCommandIssue(seg) !== null) return true;
		for (const pattern of DESTRUCTIVE_PATTERNS) {
			if (pattern.test(normalized) || pattern.test(withoutSafeRedirections)) return true;
		}
	}
	return false;
}

function shortSegment(segment: string): string {
	return segment.length > 120 ? `${segment.slice(0, 117)}…` : segment;
}

/** Explain the first fail-closed shell-policy rejection, or return null when the command is allowed. */
function readOnlyCommandIssue(rawCommand: string): string | null {
	const command = rawCommand.trim();
	if (command === "") return null;
	const segments = shellSegments(command);
	if (!segments?.length) {
		return "unsupported shell syntax (unclosed quoting, escaping, or command/process substitution)";
	}
	for (const seg of segments) {
		if (hasUnsafeOutputRedirection(seg)) {
			return `output redirection is not read-only in segment: ${shortSegment(seg)}`;
		}
		const withoutSafeRedirections = stripSafeRedirections(seg);
		const assignments = withoutSafeRedirections.match(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/)?.[0];
		if (assignments && !assignments.trim().split(/\s+/).every(entry => /^(?:LC_ALL|LANG|LC_CTYPE)=[A-Za-z0-9_.@-]+$/.test(entry))) return "environment overrides that can change command execution are not read-only inspection";
		const normalized = normalize(withoutSafeRedirections);
		const special = inspectionSpecialCase(normalized);
		if (special === true) continue;
		if (special === false) return `unsupported inspection flags: ${shortSegment(seg)}`;
		const words = shellWords(normalized);
		// Git literal patterns and path arguments are data, not shell operations.
		if (words?.[0] === "git" && SAFE_PATTERNS.some(pattern => pattern.test(normalized))) {
			if (words.some(word => /^--(?:ext-diff|textconv|exec|output|paginate)(?:=|$)/i.test(word)) || /(?:^|\s)--paginate(?:\s|$)/.test(withoutSafeRedirections)) return `Git external execution or output option is blocked: ${shortSegment(seg)}`;
			continue;
		}
		for (const pattern of DESTRUCTIVE_PATTERNS) {
			if (pattern.test(normalized) || pattern.test(withoutSafeRedirections)) {
				return `a blocked mutating operation appears in segment: ${shortSegment(seg)}`;
			}
		}
		if (/^git(?:\s|$)/i.test(normalized) && /--(?:ext-diff|textconv|exec|output|paginate)\b/i.test(normalized)) {
			return `Git external execution or output option is blocked: ${shortSegment(seg)}`;
		}
		if (!SAFE_PATTERNS.some((pattern) => pattern.test(normalized))) {
			return `command segment is not on the read-only allowlist: ${shortSegment(seg)}`;
		}
	}
	return null;
}

export function isReadOnlyCommand(rawCommand: string): boolean {
	return readOnlyCommandIssue(rawCommand) === null;
}

/** Canonical POSIX prefix: the directory is part of the exact approved command. */
export function prCheckPrefix(location: string): string {
	return `cd -- '${location.replaceAll("'", "'\\''")}' && `;
}

/** A PR check must start in its pinned checkout, not the Pi session's cwd. */
export function hasPrCheckDirectory(state: RpacState, command: string): boolean {
	if (!state.review?.pr) return true;
	const prefix = prCheckPrefix(state.review.pr.checkoutLocation);
	if (!command.trim().startsWith(prefix)) return false;
	const suffix = command.trim().slice(prefix.length);
	const syntax = shellSyntaxOnly(suffix);
	const rest = shellSegments(suffix);
	// Reject nested shells, substitutions, escaping and alternate directory builtins.
	// The only shell-controlled cwd transition is the pinned prefix above.
	return syntax !== null && !/[(){}\n\\]/.test(suffix) && !/[(){}$]/.test(syntax) &&
		rest !== null && rest.length > 0 && !rest.some(s => /^(?:cd|pushd|popd|dirs|env|command|builtin|exec|eval|source|\.|bash|sh|zsh|fish|set|export|npx|python\d*|ruby|perl)(?:\s|$)/i.test(s.trim()) ||
			/^(?:node|bun|deno)\s+(?:-e|--eval|--print|eval)(?:\s|$)/i.test(s.trim()) ||
			/^[A-Za-z_][A-Za-z_0-9]*=/.test(s.trim()) || /^git\s+(?:-c|--|-[A-Za-z]|ls-)/i.test(s.trim()));
}

/** Exact user-approved review checks may exceed the inspection allowlist, but never the destructive denylist. */
export function isApprovedReviewCheck(state: RpacState, rawCommand: string): boolean {
	if (state.workflowKind !== "review" || !state.review || !state.approvals.plan) return false;
	const command = rawCommand.trim();
	if (!state.review.approvedChecks.includes(command) || !hasPrCheckDirectory(state, command) || hasDestructiveShellSegment(command)) return false;
	// Approval may authorize a project test runner, but never a Git wrapper,
	// external Git command, alias, or unrecognized Git subcommand.
	if (state.review.pr) {
		const segments = shellSegments(command.slice(prCheckPrefix(state.review.pr.checkoutLocation).length));
		if (!segments?.every(seg => {
			if (!/^git(?:\s|$)/i.test(seg)) return true;
			if (readOnlyCommandIssue(seg) !== null) return false;
			const sub = seg.match(/^git\s+([a-z-]+)(?:\s|$)/i)?.[1];
			return !!sub && /^(?:status|log|diff|show|rev-parse|ls-files|shortlog|describe|merge-base|for-each-ref|name-rev|check-ignore|stash|remote|branch|config)$/.test(sub) &&
				!/--(?:ext-diff|textconv|exec|output|paginate)\b/i.test(seg);
		})) return false;
	}
	return true;
}

/** Native host runner policy. Approval is additional authorization, never a shell denylist bypass. */
export function hostCommandIssue(location: string, command: string, kind: "setup" | "check"): string | null {
	const prefix = prCheckPrefix(location);
	if (command !== command.trim() || !command.startsWith(prefix)) return `include the exact checkout prefix ${prefix}`;
	const suffix = command.slice(prefix.length);
	const syntax = shellSyntaxOnly(suffix), segments = shellSegments(suffix);
	if (syntax === null || !segments?.length || /[|;<>&(){}\n]/.test(syntax.replaceAll("&&", ""))) return "only literal commands joined by && are supported (no redirects, wrappers, substitutions or background jobs)";
	for (const segment of segments) {
		const words = shellWords(segment);
		if (!words?.length) return "use literal command arguments, without variable expansion";
		const [exe, verb, ...args] = words;
		if (["cd", "pushd", "popd", "dirs", "env", "command", "builtin", "exec", "eval", "source", ".", "bash", "sh", "zsh", "fish", "set", "export"].includes(exe ?? "")) return "subsequent directory switches, environment wrappers and nested shells are not allowed";
		if (words.some(arg => /^(?:-C(?:.|$)|--(?:directory|git-dir|work-tree|manifest-path)(?:=|$))/.test(arg))) return "launcher directory or repository overrides are not allowed";
		if (kind === "setup") {
			if (exe !== "npm" || verb !== "ci" || args.some(arg => !["--ignore-scripts", "--no-audit", "--no-fund", "--offline", "--prefer-offline", "--include=dev"].includes(arg))) return "dependency setup currently supports npm ci with standard audit/fund/offline/ignore-scripts flags only; put tests/builds in reviewChecks";
			continue;
		}
		if (isReadOnlyCommand(segment)) continue;
		if (exe === "npm" && (verb === "test" || verb === "run") && (verb !== "run" || (!!args[0] && /^[A-Za-z0-9_:.-]+$/.test(args[0])))) {
			const options = verb === "run" ? args.slice(1) : args;
			const beforeDelimiter = options.slice(0, options.includes("--") ? options.indexOf("--") : options.length);
			if (beforeDelimiter.every(arg => !arg.startsWith("-") || ["--silent", "--no-audit", "--no-fund"].includes(arg))) continue;
		}
		if (exe === "npx" && verb === "--no-install" && !!args[0] && /^[A-Za-z0-9_.-]+$/.test(args[0])) {
			// npx is for the project's check binary, not a second route to a
			// forbidden shell/interpreter, package manager or host mutation CLI.
			if (["bash", "sh", "dash", "zsh", "fish", "env", "node", "nodejs", "python", "python3", "perl", "ruby", "php", "npm", "npx", "pnpm", "yarn", "corepack", "git", "gh", "curl", "wget", "ssh", "scp", "rsync", "sudo", "rm", "cp", "mv", "install", "chmod", "chown", "tee", "sed", "awk"].includes(args[0])) return "npx must launch the screened project check binary, not a shell/interpreter/package-manager/host-mutation wrapper";
			continue;
		}
		if (exe === "node" && verb && !words.some(arg => /^(?:-e|-p|-r|--eval|--print|--require|--import|--loader|--experimental-loader|--test-reporter-destination)(?:=|$)/.test(arg)) && (verb === "--test" || (!verb.startsWith("-") && !isAbsolute(verb) && !verb.split(/[\\/]/).includes("..")))) continue;
		if (exe === "pytest") continue;
		if (exe === "cargo" && ["test", "check", "build", "clippy"].includes(verb ?? "")) continue;
		if (exe === "go" && ["test", "build", "vet"].includes(verb ?? "")) continue;
		if (exe === "make" && ["test", "check", "build", "all", "lint", "typecheck"].includes(verb ?? "") && !args.some(arg => /^(?:-f|--file|--makefile|--eval)(?:=|$)/.test(arg))) continue;
		return `unsupported or mutating launcher: ${shortSegment(segment)}. Use a reviewed project test/build script; direct installs belong in setupCommands, and shell/Git/remote mutations stay blocked`;
	}
	return null;
}

/** The single workflow artifact the model may write in the given phase. */
export function allowedArtifactForPhase(root: string, workflowId: string, phase: string): string | null {
	if (phase === "refine") return artifactFile(root, workflowId, "requirements");
	if (phase === "plan") return artifactFile(root, workflowId, "plan");
	return null;
}

/** True when `target` (absolute or cwd-relative) resolves to exactly `allowed`. */
export function pathIsExactly(cwd: string, target: string, allowed: string): boolean {
	const abs = resolve(isAbsolute(target) ? target : resolve(cwd, target));
	return abs === resolve(allowed);
}

export interface GateDecision {
	block: boolean;
	reason: string;
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "codemode", "ask_user_question", "todo"]);

/** Fail closed when RPAC files exist but active state cannot be validated. */
export function gateUnreadableState(toolName: string): GateDecision | null {
	if (toolName === "rpac" || READ_ONLY_TOOLS.has(toolName)) return null;
	return {
		block: true,
		reason:
			"RPAC state exists but cannot be read safely. Mutating tools are blocked until the user runs /rpac status and resolves the reported state problem.",
	};
}

/**
 * Gate a tool call during a gated phase. Returns a block decision or null
 * (allow). Exact artifact writes and explicitly known inspection tools pass;
 * shell commands are conservative and unknown custom tools block.
 */
export function gateToolCall(
	state: RpacState,
	cwd: string,
	toolName: string,
	input: Record<string, unknown> | undefined,
	root: string,
): GateDecision | null {
	if (state.workflowKind === "review") return gateReviewToolCall(state, cwd, toolName, input, root);
	if (state.phase !== "refine" && state.phase !== "plan") return null;
	const phase = state.phase.toUpperCase();
	const allowed = allowedArtifactForPhase(root, state.id, state.phase);

	if (toolName === "write" || toolName === "edit") {
		const target = typeof input?.path === "string" ? input.path : undefined;
		if (!target) return null; // schema validation rejects the call anyway
		if (allowed && pathIsExactly(cwd, target, allowed)) return null; // the exact phase artifact
		return {
			block: true,
			reason:
				`RPAC ${phase} phase is mechanically read-only: application code cannot be modified. ` +
				`The only writable file right now is the ${state.phase} artifact: ${allowed ?? "(none)"}. ` +
				`Finish this phase (and move on) before editing anything else.`,
		};
	}

	if (toolName === "bash" || toolName === "powershell") {
		const command = typeof input?.command === "string" ? input.command : undefined;
		if (command !== undefined) {
			const issue = readOnlyCommandIssue(command);
			if (issue) {
				return {
					block: true,
					reason:
						`RPAC ${phase} phase restricts the shell to read-only commands (no file/package/git mutations). ` +
						`Rejected because ${issue}. Use direct read or an allowlisted inspection command ` +
						`(grep/find/git status/git diff); every segment of a compound command must qualify.`,
				};
			}
		}
		return null;
	}

	if (toolName === "rpac" || READ_ONLY_TOOLS.has(toolName)) return null;
	return {
		block: true,
		reason:
			`RPAC ${phase} phase is fail-closed: custom tool "${toolName}" is not on the read-only allowlist. ` +
			"Use read/grep/find/ls/codemode for investigation, or finish the phase before invoking mutating tools.",
	};
}

function reviewWritableArtifact(state: RpacState, root: string): string | null {
	if (state.phase === "refine") return artifactFile(root, state.id, "requirements");
	if (state.phase === "plan") return artifactFile(root, state.id, "plan");
	if (state.phase === "act") {
		const task = state.tasks.find((entry) => entry.status === "in_progress");
		return task ? reviewBatchFile(root, state.id, task.id) : null;
	}
	if (state.phase === "consolidate") return reviewReportFile(root, state.id);
	return null;
}

/** Report-only gate applied throughout every active review phase. */
function gateReviewToolCall(
	state: RpacState,
	cwd: string,
	toolName: string,
	input: Record<string, unknown> | undefined,
	root: string,
): GateDecision | null {
	if (state.phase === "done" || state.phase === "aborted") return null;
	const phase = `REVIEW ${state.phase.toUpperCase()}`;
	const allowed = reviewWritableArtifact(state, root);
	if (toolName === "write" || toolName === "edit") {
		const target = typeof input?.path === "string" ? input.path : undefined;
		if (!target) return null;
		if (allowed && pathIsExactly(cwd, target, allowed)) return null;
		return {
			block: true,
			reason: allowed
				? `RPAC ${phase} is report-only. Write only the current task ledger: ${allowed}.`
				: `No review task is currently running, so no ledger is writable. ${state.tasks.some(task => task.status === "interrupted") ? "The run was interrupted; the user must run /rpac act <task-id> or /rpac resume before a ledger can be written." : state.approvals.sequential ? "After successful task_done, call rpac task_start with task \"next\" before inspecting or writing the next batch (a live execution lease is required)." : "Wait for the user to run /rpac act."} Reading files does not start a task.`,
		};
	}
	if (toolName === "bash" || toolName === "powershell") {
		const command = typeof input?.command === "string" ? input.command : undefined;
		if (command !== undefined && state.review?.execution && !isReadOnlyCommand(command) && [...state.review.approvedChecks, ...state.review.execution.setupCommands].includes(command.trim())) {
			return { block: true, reason: "This preview command needs the screened host-execution path. Call rpac review_check with the exact command; the user must separately approve execution. Do not wrap it in another shell or tool." };
		}
		if (command !== undefined && state.review?.pr && state.review.approvedChecks.includes(command.trim()) &&
			(toolName !== "bash" || !isApprovedReviewCheck(state, command))) {
			return { block: true, reason: `PR verification requires bash and a safe check in the exact approved checkout prefix: ${prCheckPrefix(state.review.pr.checkoutLocation)}. Replan unsafe checks.` };
		}
		if (command === undefined || isReadOnlyCommand(command) ||
			((state.phase === "act" || state.phase === "consolidate") && isApprovedReviewCheck(state, command))) return null;
		const issue = readOnlyCommandIssue(command);
		return {
			block: true,
			reason:
				`RPAC ${phase} permits read-only inspection and exact non-destructive checks from the approved review plan. ` +
				`Rejected because ${issue ?? "the command does not exactly match an approved review check"}. ` +
				"Run approved checks exactly as recorded; prefixes, suffixes, and pipelines change the command.",
		};
	}
	if (toolName === "rpac" || READ_ONLY_TOOLS.has(toolName)) return null;
	return {
		block: true,
		reason: `RPAC ${phase} is fail-closed: custom tool "${toolName}" is not a known read-only review tool.`,
	};
}

/** Where a blocked call's target points (for diagnostics). */
export function resolveTarget(cwd: string, target: string): string {
	return resolve(isAbsolute(target) ? target : join(cwd, target));
}
