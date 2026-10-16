// Mock Pi runtime for e2e tests: just enough ExtensionAPI surface to load the
// real RPAC extension factory and drive its command + tool handlers.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RecordedNotification {
	message: string;
	type?: "info" | "warning" | "error";
}

export interface MockUI {
	notifications: RecordedNotification[];
	statuses: Record<string, string | undefined>;
	widgets: Record<string, string[] | undefined>;
	confirmations: { title: string; message: string }[];
	/** queued answers for confirm(); default true when the queue is empty */
	confirmQueue: boolean[];
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, content: string[] | undefined): void;
	confirm(title: string, message: string): Promise<boolean>;
	text(type?: string): string[];
}

export function makeUI(confirmDefault = true): MockUI {
	const ui: MockUI = {
		notifications: [],
		statuses: {},
		widgets: {},
		confirmations: [],
		confirmQueue: [],
		notify(message, type) {
			ui.notifications.push({ message, type });
		},
		setStatus(key, text) {
			ui.statuses[key] = text;
		},
		setWidget(key, content) {
			ui.widgets[key] = content;
		},
		async confirm(title, message) {
			ui.confirmations.push({ title, message });
			return ui.confirmQueue.length > 0 ? ui.confirmQueue.shift()! : confirmDefault;
		},
		text(type) {
			return ui.notifications.filter((n) => (type ? n.type === type : true)).map((n) => n.message);
		},
	};
	return ui;
}

export interface MockTool {
	name: string;
	description: string;
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: MockToolCtx,
	) => Promise<MockToolResult>;
}

export interface MockToolResult {
	content: { type: "text"; text: string }[];
	details?: unknown;
}

export interface MockToolCtx {
	ui: MockUI;
	cwd: string;
	hasUI: boolean;
	mode: string;
	isIdle(): boolean;
}

type Sender = (msg: string, opts?: unknown) => void | Promise<void>;
interface WithSessionCtx {
	sendUserMessage: Sender;
}

export interface MockCommandCtx {
	ui: MockUI;
	cwd: string;
	hasUI: boolean;
	mode: string;
	isIdle(): boolean;
	newSession(opts: { withSession?: (c: WithSessionCtx) => void }): Promise<{ cancelled: boolean }>;
}

export interface MockPi {
	commands: Map<string, { description?: string; handler: (args: string, ctx: MockCommandCtx) => Promise<void>; getArgumentCompletions?: (p: string) => unknown }>;
	tools: Map<string, MockTool>;
	handlers: Map<string, Function[]>;
	userMessages: string[];
}

export function makeMockPi(): MockPi {
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: MockCommandCtx) => Promise<void>; getArgumentCompletions?: (p: string) => unknown }>();
	const tools = new Map<string, MockTool>();
	const handlers = new Map<string, Function[]>();
	const userMessages: string[] = [];
	return {
		commands,
		tools,
		handlers,
		userMessages,
	};
}

/** Build an object that satisfies the ExtensionAPI surface the RPAC factory uses. */
export function extensionApiFor(m: MockPi): any {
	return {
		registerCommand(name: string, opts: { description?: string; handler: Function; getArgumentCompletions?: Function }) {
			m.commands.set(name, opts as any);
		},
		registerTool(tool: MockTool) {
			m.tools.set(tool.name, tool);
		},
		on(event: string, handler: Function) {
			const arr = m.handlers.get(event) ?? [];
			arr.push(handler);
			m.handlers.set(event, arr);
		},
		sendUserMessage(text: string | { text: string }[], _opts?: unknown) {
			const s = Array.isArray(text) ? text.map((t) => t.text).join("") : text;
			m.userMessages.push(s);
		},
		// Not used by the RPAC factory, but keep a few no-ops for realism.
		getActiveTools: () => [],
		setActiveTools: () => {},
		getFlag: () => undefined,
	};
}

export function makeCommandCtx(m: MockPi, cwd: string, opts: { hasUI?: boolean; mode?: string; confirm?: boolean[] } = {}): MockCommandCtx {
	const ui = makeUI(opts.hasUI ?? true);
	if (opts.confirm) ui.confirmQueue = opts.confirm;
	const ctx: MockCommandCtx = {
		ui,
		cwd,
		hasUI: opts.hasUI ?? true,
		mode: opts.mode ?? "tui",
		isIdle: () => true,
		async newSession(o) {
			if (o?.withSession) {
				await o.withSession({ sendUserMessage: (msg: string) => { m.userMessages.push(msg); } });
			}
			return { cancelled: false };
		},
	};
	return ctx;
}

export function makeToolCtx(m: MockPi, cwd: string, opts: { hasUI?: boolean; confirm?: boolean[] } = {}): MockToolCtx {
	const ui = makeUI(opts.hasUI ?? true);
	if (opts.confirm) ui.confirmQueue = opts.confirm;
	return {
		ui,
		cwd,
		hasUI: opts.hasUI ?? true,
		mode: "tui",
		isIdle: () => true,
	};
}

/** Invoke the registered /rpac command with a subcommand string. */
export async function rpacCmd(m: MockPi, cwd: string, args: string, opts?: { hasUI?: boolean; mode?: string; confirm?: boolean[] }): Promise<MockCommandCtx> {
	const ctx = makeCommandCtx(m, cwd, opts);
	const cmd = m.commands.get("rpac");
	if (!cmd) throw new Error("rpac command not registered");
	await cmd.handler(args, ctx);
	return ctx;
}

/** Invoke the registered rpac tool with a params object. */
export async function rpacTool(m: MockPi, cwd: string, params: Record<string, unknown>, opts?: { hasUI?: boolean; confirm?: boolean[] }): Promise<string> {
	const t = m.tools.get("rpac");
	if (!t) throw new Error("rpac tool not registered");
	const ctx = makeToolCtx(m, cwd, opts);
	const res = await t.execute("call-1", params, undefined, undefined, ctx);
	return res.content.map((c) => c.text).join("\n");
}

// --- repo / artifact helpers for e2e (versioned per-workflow layout) --------

export function repoDir(root: string): void {
	mkdirSync(root, { recursive: true });
}

/** The active workflow id from .pi/rpac/state.json. */
export function activeWorkflowId(root: string): string {
	const index = JSON.parse(readFileSync(join(root, ".pi", "rpac", "state.json"), "utf8"));
	return index.active as string;
}

export function workflowDirPath(root: string, id?: string): string {
	return join(root, ".pi", "rpac", id ?? activeWorkflowId(root));
}

export function writeArtifact(root: string, which: "requirements" | "plan" | "report", body: string, id?: string): void {
	const dir = workflowDirPath(root, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${which}.md`), body, "utf8");
}

export function readState(root: string, id?: string): any {
	return JSON.parse(readFileSync(join(workflowDirPath(root, id), "workflow.json"), "utf8"));
}

export function readIndex(root: string): any {
	return JSON.parse(readFileSync(join(root, ".pi", "rpac", "state.json"), "utf8"));
}

export function artifactExists(root: string, which: "requirements" | "plan" | "report" | "handoff" | "log", id?: string): boolean {
	return existsSync(join(workflowDirPath(root, id), `${which}.md`));
}

/** Workflow ids present as directories under .pi/rpac/ (excluding reserved names). */
export function workflowDirs(root: string): string[] {
	const base = join(root, ".pi", "rpac");
	return readdirSync(base).filter((e) => !e.startsWith(".") && e !== "quarantine" && e !== "state.json");
}

/** Invoke a registered lifecycle/tool event handler directly. */
export async function fire(m: MockPi, event: string, payload: Record<string, unknown>, ctx: Record<string, unknown>): Promise<unknown> {
	const handlers = m.handlers.get(event) ?? [];
	if (handlers.length === 0) throw new Error(`no handlers for ${event}`);
	const results: unknown[] = [];
	for (const h of handlers) results.push(await h(payload as never, ctx as never));
	return results.length === 1 ? results[0] : results;
}
