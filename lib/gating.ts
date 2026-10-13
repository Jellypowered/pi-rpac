// Read-only gating for the REFINE and PLAN phases (mechanically enforced).
//
// During REFINE and PLAN the model may investigate freely, but may only write
// the single workflow artifact the current phase allows (refine →
// requirements.md, plan → plan.md). Application-code mutation through the
// built-in write/edit tools is blocked, and bash is restricted to a
// fail-closed read-only command policy. ACT and CONSOLIDATE run under normal
// Pi permissions (no gating).
//
// The gate hooks Pi's `tool_call` event, which also fires for nested
// (tool-issued / codemode) calls, so those are covered too.
//
// The read-only bash policy is an adaptation of MTP2's allowlist approach
// (itself inherited from Pi's plan-mode example extension).
import { isAbsolute, resolve, join } from "node:path";
import type { RpacState } from "./schema.ts";
import { artifactFile } from "./paths.ts";

const DESTRUCTIVE_PATTERNS: RegExp[] = [
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
	/(^|[^<])>(?!>)/,
	/>>/,
	/\b(sed\s+(-i|--in-place)|perl\s+-i|awk\s+.*\bprint\s*>)\b/i,
	/\bnpm\s+(install|uninstall|update|ci|link|publish|deprecate)\b/i,
	/\byarn\s+(add|remove|install|publish|upgrade)\b/i,
	/\bpnpm\s+(add|remove|install|publish)\b/i,
	/\bpip(\d)\s+(install|uninstall|freeze)\b/i,
	/\b(uv|poetry|pnpm-workspace)\s+(add|install|remove)\b/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade|full-upgrade)\b/i,
	/\b(dnf|yum)\s+(install|remove|erase|update|upgrade)\b/i,
	/\bbrew\s+(install|uninstall|upgrade|remove)\b/i,
	/\bgit\s+(?:(?:add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone|am|apply|restore|clean|rm|mv|worktree)(?=\s|$)|branch\s+(?:-[dD]\b|\w))/i,
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
	/^\s*git\s+remote(?:\s+-v)?\s*$/i,
	/^\s*git\s+branch(?:\s+(?:--list|-a|--all|-r|--remotes|--show-current|-v|-vv))*\s*$/i,
	/^\s*git\s+config\s+--get(?:\s|$)/i,
	/^\s*git\s+ls-/i,
	/^\s*(node|deno|bun)\s+--(version|help)\b/i,
	/^\s*(python[23]?|ruby|perl|java)\s+--version\b/i,
	/^\s*docker\s+(ps|inspect|images|version)(?:\s|$)/i,
	/^\s*md5sum\b/,
	/^\s*sha256sum\b/,
	/^\s*test\b/,
	/^\s*\[/,
	/^\s*true\b/,
	/^\s*false\b/,
];

/** Split an ordinary shell command list without treating quoted/escaped metacharacters as separators. */
function shellSegments(command: string): string[] | null {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;
	const flush = () => {
		if (current.trim()) segments.push(current.trim());
		current = "";
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			current += ch;
			escaped = true;
			continue;
		}
		if (quote) {
			if (quote === '"' && (ch === "`" || (ch === "$" && command[i + 1] === "("))) return null;
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		// Command/process substitution is intentionally outside the conservative policy.
		if (ch === "`" || ((ch === "$" || ch === "<" || ch === ">") && command[i + 1] === "(")) return null;
		if (ch === "&" && (current.endsWith(">") || command[i + 1] === ">")) {
			current += ch;
			continue;
		}
		if (ch === "\n" || ch === ";" || ch === "|" || ch === "&") {
			flush();
			if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
			continue;
		}
		current += ch;
	}
	if (quote || escaped) return null;
	flush();
	return segments;
}

/** Strip harmless output redirections used to suppress inspection noise. */
function stripSafeRedirections(command: string): string {
	return command
		.replace(/(?:\d+|&)?\s*>\s*\/dev\/null\b/g, "")
		.replace(/\d*\s*>\s*&\s*\d+\b/g, "")
		.trim();
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
export function isReadOnlyCommand(rawCommand: string): boolean {
	const command = rawCommand.trim();
	if (command === "") return true;
	const segments = shellSegments(command);
	if (!segments?.length) return false;
	for (const seg of segments) {
		const withoutSafeRedirections = stripSafeRedirections(seg);
		const normalized = normalize(withoutSafeRedirections);
		for (const pattern of DESTRUCTIVE_PATTERNS) {
			if (pattern.test(normalized) || pattern.test(withoutSafeRedirections)) return false;
		}
		if (!SAFE_PATTERNS.some((p) => p.test(normalized))) return false;
	}
	return true;
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

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "codemode", "ask_user_question"]);

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
		if (command !== undefined && !isReadOnlyCommand(command)) {
			return {
				block: true,
				reason:
					`RPAC ${phase} phase restricts the shell to read-only commands (no file/package/git mutations). ` +
					`Blocked: ${command.length > 160 ? command.slice(0, 157) + "…" : command}. ` +
					`Use read-only inspection (grep/find/git status/git diff/…) instead.`,
			};
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

/** Where a blocked call's target points (for diagnostics). */
export function resolveTarget(cwd: string, target: string): string {
	return resolve(isAbsolute(target) ? target : join(cwd, target));
}
