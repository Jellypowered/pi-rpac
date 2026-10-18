/**
 * Harness for e2e tests against the real Pi binary (RPC mode), adapted from
 * the MTP2 harness for the versioned per-workflow layout:
 *
 * - RpcClient: JSONL RPC client (prompt/command responses, extension_ui
 *   requests, session events). Auto-answers confirm dialogs when enabled.
 * - makeSampleRepo: isolated sample git repo.
 * - startWorkflowMockModel: stateful mock OpenAI-compatible model that
 *   drives a complete RPAC workflow (REFINE → PLAN → ACT → CONSOLIDATE →
 *   DONE) through real tool calls: it writes the phase artifact (path
 *   resolved by a callback that reads .pi/rpac/state.json), implements and
 *   verifies work in ACT, and calls the `rpac` tool for transitions.
 */
import { spawn, type ChildProcessWithoutNullStreams, execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface UiRecord {
	type: string;
	id: string;
	method: string;
	[k: string]: unknown;
}

export class RpcClient {
	child: ChildProcessWithoutNullStreams;
	stderrLog = "";
	/** When true, confirm dialogs are answered `true` automatically. */
	autoConfirm = false;
	uiRequests: UiRecord[] = [];
	private buffer = "";
	private pending = new Map<string, (r: any) => void>();
	private uiListeners: ((r: UiRecord) => void)[] = [];
	private eventListeners: { type: string; match?: (r: any) => boolean; res: (r: any) => void }[] = [];

	constructor(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
		this.child = spawn("pi", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
		this.child.stderr.on("data", (chunk: Buffer) => {
			this.stderrLog += chunk.toString("utf8");
		});
	}

	private onData(data: string) {
		this.buffer += data;
		let idx: number;
		while ((idx = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, idx).replace(/\r$/, "");
			this.buffer = this.buffer.slice(idx + 1);
			if (!line.trim()) continue;
			let record: any;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			if (record.type === "response" && record.id && this.pending.has(record.id)) {
				this.pending.get(record.id)!(record);
				this.pending.delete(record.id);
				continue;
			}
			if (record.type === "extension_ui_request") {
				this.uiRequests.push(record);
				for (const l of [...this.uiListeners]) l(record);
				if (this.autoConfirm && record.method === "confirm") {
					this.respondUi(record.id, { confirmed: true });
				}
				continue;
			}
			for (const l of [...this.eventListeners]) {
				if (l.type !== record.type) continue;
				if (l.match && !l.match(record)) continue;
				this.eventListeners = this.eventListeners.filter((x) => x !== l);
				l.res(record);
			}
		}
	}

	send(cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<any> {
		const id = `e2e-${Math.random().toString(36).slice(2)}`;
		return new Promise((res, rej) => {
			const t = setTimeout(() => {
				this.pending.delete(id);
				rej(new Error(`RPC timeout waiting for ${cmd.type} (stderr: ${this.stderrLog.slice(-400)})`));
			}, timeoutMs);
			this.pending.set(id, (r) => {
				clearTimeout(t);
				res(r);
			});
			this.child.stdin.write(JSON.stringify({ id, ...cmd }) + "\n");
		});
	}

	respondUi(id: string, payload: Record<string, unknown>): void {
		this.child.stdin.write(JSON.stringify({ type: "extension_ui_response", id, ...payload }) + "\n");
	}

	uiNotifyMatching(re: RegExp): UiRecord | undefined {
		return this.uiRequests.filter((r) => r.method === "notify").reverse().find((r) => re.test(String(r.message)));
	}

	waitForEvent(type: string, match?: (r: any) => boolean, timeoutMs = 90_000): Promise<any> {
		return new Promise((res, rej) => {
			const t = setTimeout(() => {
				this.eventListeners = this.eventListeners.filter((l) => l.res !== res);
				rej(new Error(`timeout waiting for event ${type} (stderr: ${this.stderrLog.slice(-400)})`));
			}, timeoutMs);
			this.eventListeners.push({
				type,
				match,
				res: (r: any) => {
					clearTimeout(t);
					res(r);
				},
			});
		});
	}

	close(): void {
		try {
			this.child.stdin.end();
		} catch {
			/* already closed */
		}
		setTimeout(() => this.child.kill("SIGKILL"), 2000).unref();
	}
}

/** Create an isolated sample git repo for e2e runs. */
export function makeSampleRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "rpac-e2e-repo-"));
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src", "app.js"), "module.exports = {};\n");
	writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "sample-app", private: true, scripts: { test: 'node -e "1"' } }));
	writeFileSync(join(repo, "README.md"), "# sample app\n\nA tiny sample app.\n");
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
	return repo;
}

function listen0(server: Server): Promise<number> {
	return new Promise((res) =>
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			res(typeof addr === "object" && addr ? addr.port : 0);
		}),
	);
}

/** Write an SSE chat-completion response (text and/or tool calls). */
export function sseRespond(res: ServerResponse, modelId: string, text: string, toolCalls?: { name: string; args: Record<string, unknown> }[]): void {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
	const base = { id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelId };
	if (text) {
		chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
		chunk({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
	}
	if (toolCalls) {
		for (const [i, tc] of toolCalls.entries()) {
			const argsJson = JSON.stringify(tc.args);
			chunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${i}_${Date.now()}`, type: "function", function: { name: tc.name, arguments: argsJson } }] }, finish_reason: null }] });
		}
	}
	chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? "tool_calls" : "stop" }] });
	res.write("data: [DONE]\n\n");
	res.end();
}

export interface WorkflowMockContent {
	requirements: string;
	plan: string;
	taskTitle: string;
	appFile: string; // repo-relative path the model implements
	appImpl: string;
	verifyCommand: string;
	finalCheck: string;
	report: string;
}

/**
 * Stateful mock model driving one complete RPAC workflow. It decides what to
 * do from the transcript: the last `[RPAC] phase=X` marker (injected by the
 * extension's before_agent_start context) plus the number of tool results
 * after it. Artifact paths come from `resolveArtifact`, which the test
 * implements by reading .pi/rpac/state.json (versioned per-workflow layout).
 */
export function startWorkflowMockModel(
	content: WorkflowMockContent,
	resolveArtifact: (which: "requirements" | "plan" | "report") => string,
	observeRequest?: (messages: any[]) => void,
): Promise<{ server: Server; port: number }> {
	const messageText = (m: any): string => {
		if (typeof m?.content === "string") return m.content;
		if (Array.isArray(m?.content)) {
			return m.content.map((c: any) => (c?.type === "text" ? c.text ?? "" : "")).join("\n");
		}
		return "";
	};

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "not found" }));
			return;
		}
		let body = "";
		req.on("data", (d) => (body += d));
		req.on("end", () => {
			let messages: any[];
			try {
				messages = JSON.parse(body).messages ?? [];
			} catch {
				sseRespond(res, "mock-1", "ok");
				return;
			}
			observeRequest?.(messages);
			let phase: string | null = null;
			let markerIdx = -1;
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messageText(messages[i]).match(/\[RPAC\] phase=(REFINE|PLAN|ACT|CONSOLIDATE)/);
				if (m) {
					phase = m[1]!;
					markerIdx = i;
					break;
				}
			}
			if (!phase) {
				sseRespond(res, "mock-1", "ok");
				return;
			}
			const rounds = messages.slice(markerIdx + 1).filter((m) => m?.role === "tool").length;
			switch (phase) {
				case "REFINE":
					if (rounds === 0) {
						sseRespond(res, "mock-1", "", [{ name: "write", args: { path: resolveArtifact("requirements"), content: content.requirements } }]);
					} else if (rounds === 1) {
						sseRespond(res, "mock-1", "", [{ name: "rpac", args: { action: "refine_complete" } }]);
					} else {
						sseRespond(res, "mock-1", "Requirements are ready and approved. Please run /rpac plan.");
					}
					return;
				case "PLAN":
					if (rounds === 0) {
						sseRespond(res, "mock-1", "", [{ name: "write", args: { path: resolveArtifact("plan"), content: content.plan } }]);
					} else if (rounds === 1) {
						sseRespond(res, "mock-1", "", [
							{ name: "rpac", args: { action: "plan_complete", tasks: [{ title: content.taskTitle }] } },
						]);
					} else {
						sseRespond(res, "mock-1", "Plan is ready and approved. Please run /rpac act.");
					}
					return;
				case "ACT":
					if (rounds === 0) {
						sseRespond(res, "mock-1", "", [{ name: "write", args: { path: content.appFile, content: content.appImpl } }]);
					} else if (rounds === 1) {
						sseRespond(res, "mock-1", "", [{ name: "bash", args: { command: content.verifyCommand } }]);
					} else if (rounds === 2) {
						sseRespond(res, "mock-1", "", [
							{
								name: "rpac",
								args: { action: "task_done", task: 1, verification: [{ name: "node check", result: "pass", detail: "verify command exited 0" }] },
							},
						]);
					} else {
						sseRespond(res, "mock-1", "Task 1 verified (all checks pass) and reported done.");
					}
					return;
				case "CONSOLIDATE":
					if (rounds === 0) {
						sseRespond(res, "mock-1", "", [{ name: "bash", args: { command: content.finalCheck } }]);
					} else if (rounds === 1) {
						sseRespond(res, "mock-1", "", [{ name: "write", args: { path: resolveArtifact("report"), content: content.report } }]);
					} else if (rounds === 2) {
						sseRespond(res, "mock-1", "", [{ name: "rpac", args: { action: "consolidate_complete", text: "complete" } }]);
					} else {
						sseRespond(res, "mock-1", "Consolidation complete: the workflow is done.");
					}
					return;
				default:
					sseRespond(res, "mock-1", "ok");
			}
		});
	});
	return listen0(server).then((port) => ({ server, port }));
}

/** models.json content for a mock provider on the given port. */
export function mockModelsJson(port: number): string {
	return JSON.stringify({
		providers: {
			mock: {
				baseUrl: `http://127.0.0.1:${port}/v1`,
				api: "openai-completions",
				apiKey: "mock",
				compat: { maxTokensField: "max_tokens" },
				models: [
					{
						id: "mock-1",
						name: "Mock Model",
						reasoning: false,
						input: ["text"],
						contextWindow: 8192,
						maxTokens: 4096,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	});
}

/** True when the pi binary is resolvable the same way the tests will spawn it. */
export function piAvailable(): boolean {
	try {
		execFileSync("which", ["pi"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

export function gitRepoExists(p: string): boolean {
	return existsSync(join(p, ".git"));
}
