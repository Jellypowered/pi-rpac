// RPAC GitHub PR review — metadata resolution, safe checkout, and the
// object-level base...head snapshot that scopes a PR review.
//
// Design (see DESIGN.md §2.2b):
//   * The *scope* of a PR review is the deterministic, object-level diff
//     `base...head` (three dots = merge-base, matching GitHub's PR view). It is
//     computed straight from Git objects and is independent of the working
//     tree, so coverage/drift semantics reuse the review manifest machinery.
//   * The *checkout* only makes the PR head inspectable and testable. It is an
//     explicitly authorized preparation step, NOT general permission to mutate
//     the repository. Two strategies:
//       - "in-place": `gh pr checkout <n>` in the current worktree (clean tree
//         required). Keeps RPAC's project root stable.
//       - "worktree": `git fetch origin refs/pull/<n>/head` + `git worktree add
//         --detach <sibling>` — the safe path when the main worktree is dirty.
//         RPAC state stays in the main repo; the worktree is only an
//         inspection/execution location (recorded in pr.checkoutLocation).
//   * The `gh` CLI is required and is injected (GhRunner) so tests can mock it.
//     No test needs a real GitHub PR.
//
// All Git I/O uses argument arrays (no shell); `gh` is invoked as a program.
import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { PrReviewMeta } from "./schema.ts";
import {
	type ReviewExclusion,
	type ReviewLayer,
	type ReviewManifestItem,
	runGitBuffer as rawGitBuffer,
	splitNul,
	pathKey,
	displayPath,
	itemId,
	sha256,
	canonicalJson,
	parseLsTree,
	blobLayer,
	isInternalRpacPath,
	isReviewMetadataPath,
} from "./review.ts";
import { nowIso, shortId } from "./util.ts";
import { gitInfo } from "./git.ts";

// Native preparation must not execute branch-controlled checkout hooks or
// fsmonitor scripts before source screening. Other installed Git helpers/filters
// remain part of the trusted host toolchain; this is not a sandbox.
export const PR_GIT_OPTIONS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"] as const;
const runGitBuffer = (root: string, args: string[], allowFailure = false): Buffer => {
	try { return rawGitBuffer(root, [...PR_GIT_OPTIONS, ...args], allowFailure); }
	catch (error) { throw new Error((error as Error).message.replace(/^git -c failed/, `git ${args[0] ?? "command"} failed`)); }
};
export const runPrGitText = (root: string, args: string[], allowFailure = false) => runGitBuffer(root, args, allowFailure).toString("utf8").trim();
const runGitText = runPrGitText;
function prGitEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	const count = Number(env.GIT_CONFIG_COUNT ?? 0);
	if (!Number.isSafeInteger(count) || count < 0 || count > 1024) throw new Error("Invalid inherited GIT_CONFIG_COUNT; native PR preparation cannot safely override Git hooks.");
	// gh invokes Git internally, so use Git's supported environment config.
	// Legacy inline parameters must not override these final safety settings.
	delete env.GIT_CONFIG_PARAMETERS;
	env.GIT_CONFIG_COUNT = String(count + 2);
	env[`GIT_CONFIG_KEY_${count}`] = "core.hooksPath"; env[`GIT_CONFIG_VALUE_${count}`] = "/dev/null";
	env[`GIT_CONFIG_KEY_${count + 1}`] = "core.fsmonitor"; env[`GIT_CONFIG_VALUE_${count + 1}`] = "false";
	return env;
}

// ---------------------------------------------------------------------------
// gh CLI access (injected for tests)
// ---------------------------------------------------------------------------

/** Raw `gh pr view --json` fields RPAC relies on. */
export interface PrViewResult {
	number: number;
	url: string;
	title: string;
	body: string;
	/** GitHub state: "OPEN" | "CLOSED" | "MERGED". */
	state: string;
	baseRefName: string;
	baseRefOid: string;
	headRefName: string;
	headRefOid: string;
	headRepository?: { nameWithOwner?: string; name?: string };
	headRepositoryOwner?: { login?: string };
	isCrossRepository?: boolean;
}

/**
 * The gh surface RPAC needs. The default implementation shells out to `gh`;
 * tests inject a mock. All methods are synchronous and throw Error with a
 * user-facing message on failure.
 */
export interface GhRunner {
	/** true when the `gh` binary is on PATH. */
	isAvailable(): boolean;
	/** authentication status (ok + a reason for failures). */
	isAuthed(): { ok: boolean; reason?: string };
	/** resolve PR metadata for the repository rooted at `root`. */
	prView(root: string, number: number): PrViewResult;
	/** in-place checkout via `gh pr checkout <n>`; returns gh output. */
	prCheckout(root: string, number: number): string;
}

const PR_VIEW_FIELDS = [
	"number", "url", "title", "body", "state",
	"baseRefName", "baseRefOid", "headRefName", "headRefOid",
	"headRepository", "headRepositoryOwner", "isCrossRepository",
].join(",");

function runGh(args: string[], cwd?: string): { ok: boolean; out: string; err: string } {
	try {
		const out = execFileSync("gh", args, {
			cwd,
			env: prGitEnvironment(),
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
			timeout: 120_000,
		});
		return { ok: true, out: String(out), err: "" };
	} catch (err) {
		const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string; code?: number };
		const out = e.stdout?.toString() ?? "";
		const errText = (e.stderr?.toString() || e.message || "gh failed").trim();
		return { ok: false, out, err: errText };
	}
}

/** Default GhRunner backed by the real `gh` CLI on PATH. */
export const defaultGhRunner: GhRunner = {
	isAvailable() {
		return runGh(["--version"]).ok;
	},
	isAuthed() {
		const res = runGh(["auth", "status"]);
		if (res.ok) return { ok: true };
		return { ok: false, reason: res.err || "gh is not authenticated" };
	},
	prView(root, number) {
		const res = runGh(["pr", "view", String(number), "--json", PR_VIEW_FIELDS], root);
		if (!res.ok) {
			throw new Error(`could not resolve PR #${number}: ${res.err}`);
		}
		try {
			return JSON.parse(res.out) as PrViewResult;
		} catch {
			throw new Error(`could not parse PR #${number} metadata from gh`);
		}
	},
	prCheckout(root, number) {
		const res = runGh(["pr", "checkout", String(number), "--detach"], root);
		if (!res.ok) {
			throw new Error(`gh pr checkout ${number} failed: ${res.err}`);
		}
		return res.out.trim();
	},
};

// ---------------------------------------------------------------------------
// Metadata normalization
// ---------------------------------------------------------------------------

/** "owner/name" from a GitHub PR/repo URL. */
export function repositoryFromUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return "";
		const m = parsed.pathname.match(/^\/([\w.-]+)\/([\w.-]+)(?:\/pull\/[1-9]\d*)?\/?$/);
		return m ? `${m[1]}/${m[2]}` : "";
	} catch { return ""; }
}

export type PrState = "open" | "closed" | "merged";

export function classifyPrState(state: string): PrState {
	const s = (state ?? "").toUpperCase();
	if (s === "OPEN") return "open";
	if (s === "MERGED") return "merged";
	return "closed";
}

/** Normalized, schema-ready PR identity (before the checkout is recorded). */
export interface ResolvedPr {
	number: number;
	url: string;
	title: string;
	body: string;
	repository: string;
	state: PrState;
	crossRepository: boolean;
	baseRef: string;
	baseSha: string;
	headRef: string;
	headSha: string;
	headRepositoryOwner?: string;
}

/** Convert raw gh output into the normalized PR identity. Throws on bad refs. */
export function resolvePrMeta(view: PrViewResult, expectedNumber?: number): ResolvedPr {
	if (!view || !Number.isSafeInteger(view.number) || view.number < 1 ||
		(expectedNumber !== undefined && view.number !== expectedNumber)) throw new Error("PR metadata has an invalid or mismatched PR number");
	if (typeof view.url !== "string" || !view.url.endsWith(`/pull/${view.number}`) ||
		!repositoryFromUrl(view.url)) throw new Error("PR metadata has an invalid PR URL/repository");
	if (!["OPEN", "CLOSED", "MERGED"].includes(view.state)) throw new Error("PR metadata has an invalid state");
	for (const key of ["title", "body", "baseRefName", "headRefName"] as const) {
		if (typeof view[key] !== "string") throw new Error(`PR metadata has invalid ${key}`);
	}
	if (!view.baseRefName || !view.headRefName || view.baseRefName.startsWith("-") || view.headRefName.startsWith("-")) {
		throw new Error("PR metadata has invalid refs");
	}
	const shaOk = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
	if (typeof view.baseRefOid !== "string" || !shaOk(view.baseRefOid) || typeof view.headRefOid !== "string" || !shaOk(view.headRefOid)) {
		throw new Error("PR metadata is missing a valid base/head commit SHA — the PR references may be unavailable");
	}
	const repository = repositoryFromUrl(view.url);
	if (!repository) {
		throw new Error("could not determine the PR repository from its URL");
	}
	return {
		number: view.number,
		url: view.url,
		title: view.title ?? "",
		body: view.body ?? "",
		repository,
		state: classifyPrState(view.state),
		crossRepository: Boolean(view.isCrossRepository),
		baseRef: view.baseRefName ?? "",
		baseSha: view.baseRefOid,
		headRef: view.headRefName ?? "",
		headSha: view.headRefOid,
		...(view.headRepositoryOwner?.login ? { headRepositoryOwner: view.headRepositoryOwner.login } : {}),
	};
}

// ---------------------------------------------------------------------------
// Checkout safety assessment
// ---------------------------------------------------------------------------

export interface CheckoutAssessment {
	isRepo: boolean;
	/** true when there is at least one remote (required to fetch the PR). */
	hasRemote: boolean;
	/** the remote name that would be used to fetch the PR refs ("origin" preferred). */
	remote: string | null;
	/** true when staged + unstaged + untracked are all empty. */
	clean: boolean;
	dirty: string[];
}

/** Select the PR BASE repository remote, not an arbitrary origin (which may be a fork). */
export function selectPrRemote(root: string, pr: ResolvedPr): string {
	const host = new URL(pr.url).host.toLowerCase();
	for (const name of runGitText(root, ["remote"]).split("\n")) {
		// Read configured URLs before insteadOf expansion; Git applies that expansion at fetch time.
		const url = runGitText(root, ["config", "--get", `remote.${name}.url`]);
		const scp = url.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
		let remoteHost: string; let path: string;
		if (scp && !url.includes("://")) { remoteHost = scp[1]!; path = scp[2]!; }
		else {
			try { const parsed = new URL(url); remoteHost = parsed.host; path = parsed.pathname.slice(1); }
			catch { continue; }
		}
		if (remoteHost.toLowerCase() === host && path.replace(/\.git$/, "").toLowerCase() === pr.repository.toLowerCase()) return name;
	}
	throw new Error(`no remote matches the PR base repository ${host}/${pr.repository}`);
}

/** Porcelain v1 -z: XY SP path NUL [original-path NUL for R/C]. Both paths matter. */
export function cleanPrStatus(output: Buffer, allowPresentation = false, generatedPaths: readonly string[] = []): boolean {
	// Only in-place evidence checks may ignore the dedicated preference file.
	// Checkout preparation and worktree removal retain their stricter cleanliness.
	const allowed = allowPresentation ? isReviewMetadataPath : isInternalRpacPath;
	if (!output.length) return true;
	if (output[output.length - 1] !== 0) return false;
	const records: Buffer[] = [];
	let start = 0;
	for (let i = 0; i < output.length; i++) {
		if (output[i] === 0) { records.push(output.subarray(start, i)); start = i + 1; }
	}
	for (let i = 0; i < records.length; i++) {
		const record = records[i]!;
		if (record.length < 4 || record[2] !== 0x20) return false;
		const x = record[0]!; const y = record[1]!;
		const valid = (c: number) => c === 0x20 || "MADRCTU".includes(String.fromCharCode(c));
		if (!((x === 0x3f && y === 0x3f) || (x === 0x21 && y === 0x21) ||
			(valid(x) && valid(y) && (x !== 0x20 || y !== 0x20)))) return false;
		const path = record.subarray(3);
		const generated = x === 0x3f && y === 0x3f && generatedPaths.some(root => /^[A-Za-z0-9_.\/-]+\/$/.test(root) && !root.split("/").some(part => ["..", ".", ".git", ".pi"].includes(part)) && path.subarray(0, Buffer.byteLength(root)).equals(Buffer.from(root)));
		if (!allowed(path) && !generated) return false;
		if (x === 0x52 || x === 0x43 || y === 0x52 || y === 0x43) {
			const original = records[++i];
			if (!original?.length || !allowed(original)) return false;
		}
	}
	return true;
}

/** Inspect the repository to decide whether a PR checkout is safe. */
export function assessPrCheckout(root: string): CheckoutAssessment {
	const info = gitInfo(root, PR_GIT_OPTIONS);
	const remotes = runGitText(root, ["remote"], true);
	const remoteNames = remotes ? remotes.split("\n").map((l) => l.trim()).filter(Boolean) : [];
	const remote = remoteNames.includes("origin") ? "origin" : (remoteNames[0] ?? null);
	return {
		isRepo: info.isRepo,
		hasRemote: remoteNames.length > 0,
		remote,
		// Status errors must throw, never masquerade as a clean tree. Ignored files
		// are local work too: checkout can otherwise overwrite them.
		clean: !hasHiddenIndexEntries(root) && cleanPrStatus(runGitBuffer(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored", "--ignore-submodules=none"])),
		dirty: info.dirty,
	};
}

// ---------------------------------------------------------------------------
// PR base...head object snapshot (scope / coverage / drift)
// ---------------------------------------------------------------------------

export interface PrReviewSnapshot {
	version: 1;
	mode: "pr";
	root: string;
	prNumber: number;
	baseSha: string;
	/** Actual left side of the three-dot PR diff. */
	mergeBaseSha: string;
	headSha: string;
	capturedAt: string;
	fingerprintAlgorithm: "sha256";
	fingerprint: string;
	items: ReviewManifestItem[];
	exclusions: ReviewExclusion[];
	conflictItemIds: string[];
}

interface NameStatusRecord {
	status: string;
	path: Buffer;
	originalPath?: Buffer;
}

/** Parse `git diff --name-status --find-renames -z` NUL output into records. */
export function parseNameStatus(data: Buffer): NameStatusRecord[] {
	const tokens = splitNul(data).filter((t) => t.length > 0);
	const records: NameStatusRecord[] = [];
	let i = 0;
	while (i < tokens.length) {
		const status = tokens[i]!.toString("ascii");
		i++;
		const head = status[0];
		if (head === "R" || head === "C") {
			if (i + 1 >= tokens.length) break;
			const original = tokens[i]!;
			const dest = tokens[i + 1]!;
			i += 2;
			records.push({ status, path: dest, originalPath: original });
		} else {
			if (i >= tokens.length) break;
			records.push({ status, path: tokens[i]! });
			i++;
		}
	}
	return records;
}

function changeKind(status: string): string {
	const h = status[0];
	if (h === "A") return "added";
	if (h === "D") return "deleted";
	if (h === "R" || h === "C") return "renamed";
	return "modified";
}

/**
 * Capture the PR scope as the object-level diff between `baseSha` and `headSha`
 * (three dots → merge-base, matching GitHub). Independent of the working tree.
 */
export function capturePrSnapshot(
	root: string,
	baseSha: string,
	headSha: string,
	prNumber: number,
	exclusions: ReviewExclusion[] = [],
): PrReviewSnapshot {
	const top = runGitText(root, ["rev-parse", "--show-toplevel"], true);
	if (!top) throw new Error("PR review requires a Git work tree");
	const resolvedRoot = top;
	for (const sha of [baseSha, headSha]) {
		const ok = runGitText(resolvedRoot, ["rev-parse", "--verify", `${sha}^{commit}`], true);
		if (!ok) {
			throw new Error(`git object ${sha.slice(0, 12)} is not available locally — fetch the PR refs (git fetch origin refs/pull/${prNumber}/head) first`);
		}
	}
	// Three-dot scope and base content must use the SAME merge base. Fail closed
	// on ambiguous criss-cross histories rather than choosing an arbitrary ancestor.
	const ancestors = runGitText(resolvedRoot, ["merge-base", "--all", baseSha, headSha]).split("\n");
	if (ancestors.length !== 1) throw new Error("PR diff requires a unique merge base");
	const mergeBaseSha = ancestors[0]!;
	const baseTree = parseLsTree(runGitBuffer(resolvedRoot, ["ls-tree", "-rz", "--full-tree", mergeBaseSha]));
	const headTree = parseLsTree(runGitBuffer(resolvedRoot, ["ls-tree", "-rz", "--full-tree", headSha]));
	const data = runGitBuffer(resolvedRoot, ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "--find-renames", "-z", mergeBaseSha, headSha]);
	const records = parseNameStatus(data).map((record) => {
		if (record.originalPath && record.status.startsWith("R") && isReviewMetadataPath(record.path) &&
			!isInternalRpacPath(record.path) && !isReviewMetadataPath(record.originalPath)) {
			return { status: "D", path: record.originalPath };
		}
		return record;
	});
	const exclusionSet = new Set(exclusions.map((e) => e.path));
	const blobCache = new Map<string, { sha256: string; size: number; binary: boolean; large: boolean }>();
	const items: ReviewManifestItem[] = [];
	const ordered = [...records].sort((a, b) => Buffer.compare(a.path, b.path));
	for (const rec of ordered) {
		const key = pathKey(rec.path);
		const path = displayPath(rec.path);
		if (isReviewMetadataPath(rec.path) || exclusionSet.has(path)) continue;
		const basePath = rec.originalPath ?? rec.path;
		// Raw path bytes are authoritative; never resolve commit:path via UTF-8.
		const layers: ReviewLayer[] = [
			blobLayer(resolvedRoot, baseTree.get(pathKey(basePath)), "base", blobCache),
			blobLayer(resolvedRoot, headTree.get(key), "pr", blobCache),
		];
		items.push({
			id: itemId(rec.path),
			path,
			pathBase64: key,
			...(rec.originalPath
				? { originalPath: displayPath(rec.originalPath), originalPathBase64: pathKey(rec.originalPath) }
				: {}),
			change: changeKind(rec.status),
			layers,
		});
	}
	const sortedExclusions = [...exclusions].sort((a, b) => a.path.localeCompare(b.path));
	const fingerprintInput = {
		mode: "pr",
		prNumber,
		baseSha,
		mergeBaseSha,
		headSha,
		items: items.map(({ id: _id, path: _path, originalPath: _op, ...identity }) => identity),
		exclusions: sortedExclusions,
	};
	return {
		version: 1,
		mode: "pr",
		root: resolvedRoot,
		prNumber,
		baseSha,
		mergeBaseSha,
		headSha,
		capturedAt: nowIso(),
		fingerprintAlgorithm: "sha256",
		fingerprint: sha256(canonicalJson(fingerprintInput)),
		items,
		exclusions: sortedExclusions,
		conflictItemIds: [],
	};
}

/** True when both commits are present locally (needed for the diff). */
export function verifyGitObjects(root: string, shas: string[]): boolean {
	for (const sha of shas) {
		if (!runGitText(root, ["rev-parse", "--verify", `${sha}^{commit}`], true)) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Checkout execution
// ---------------------------------------------------------------------------

/** Non-forcing, shell-quoted restoration hint, including originally detached HEADs. */
export function prRestoreCommand(pr: Pick<PrReviewMeta, "originalBranch" | "originalHead">): string {
	const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
	return pr.originalBranch ? `git switch -- ${quote(pr.originalBranch)}` : `git switch --detach ${quote(pr.originalHead)}`;
}

/** Deterministic sibling location for an isolated PR worktree. */
export function prWorktreePath(root: string, number: number): string {
	return join(dirname(root), `${basename(root)}-rpac-pr-${number}`);
}

/** Only the canonical sibling or an RPAC-generated collision suffix is eligible. */
export function isPrWorktreeLocation(root: string, number: number, location: string): boolean {
	const base = prWorktreePath(root, number);
	return location === base || (location.startsWith(`${base}-`) && /^[a-f0-9]{8}$/.test(location.slice(base.length + 1)));
}

function registeredWorktreeLocations(root: string): Set<string> {
	return new Set(splitNul(runGitBuffer(root, ["worktree", "list", "--porcelain", "-z"]))
		.filter(record => record.subarray(0, 9).equals(Buffer.from("worktree ")))
		.map(record => record.subarray(9).toString("utf8")));
}

export interface PrCheckoutOutcome {
	strategy: "in-place" | "worktree";
	location: string;
	/** verified HEAD SHA of the checkout location. */
	head: string;
	output: string;
}

/**
 * Perform the authorized PR checkout. `in-place` uses `gh pr checkout`;
 * `worktree` fetches the PR head via GitHub's `refs/pull/<n>/head` ref and adds
 * a detached worktree at a sibling path (leaving the main worktree untouched).
 * Verifies the resulting HEAD equals the expected head SHA.
 */
export function performPrCheckout(
	root: string,
	meta: ResolvedPr,
	strategy: "in-place" | "worktree",
	gh: GhRunner,
	remote: string = "origin",
): PrCheckoutOutcome {
	if (strategy === "in-place") {
		assertCleanCheckout(root, true);
		const original = gitInfo(root, PR_GIT_OPTIONS);
		try {
			const output = gh.prCheckout(root, meta.number);
			const head = runGitText(root, ["rev-parse", "HEAD"]);
			if (head !== meta.headSha) throw new Error(`in-place checkout did not land on the PR head (${head.slice(0, 12)} ≠ ${meta.headSha.slice(0, 12)})`);
			// Also enforce detached checkout for injected runners and older gh versions.
			runGitText(root, ["checkout", "--detach", meta.headSha]);
			return { strategy, location: root, head, output };
		} catch (err) {
			// Never reset/force over work created during a failed checkout.
			try {
				assertCleanCheckout(root, true);
				if (original.branch && runGitText(root, ["rev-parse", original.branch]) !== original.head) throw new Error("original branch moved");
				runGitText(root, ["checkout", original.branch || original.head]);
			} catch {
				throw new Error(`${(err as Error).message}; could not safely restore checkout — original branch ${original.branch || "(detached)"}, HEAD ${original.head}. Preserve local changes and restore manually.`);
			}
			throw err;
		}
	}

	// worktree strategy
	const base = prWorktreePath(root, meta.number);
	let location = base, retained = "";
	if (!existsSync(base) && !isSymlink(base)) {
		const registered = registeredWorktreeLocations(root);
		if (registered.has(base)) {
			// A missing directory does not make its index/reflog disposable.
			// Keep even foreign/locked stale registrations and choose a fresh path.
			for (let attempt = 0; attempt < 16; attempt++) {
				const candidate = `${base}-${shortId()}`;
				if (!registered.has(candidate) && !existsSync(candidate) && !isSymlink(candidate)) { location = candidate; break; }
			}
			if (location === base) throw new Error("Could not allocate an unused PR worktree location; no registrations were removed.");
			retained = `Preserved missing worktree registration at ${base}; using fresh checkout ${location}.`;
		}
	}
	if (existsSync(location) || isSymlink(location)) {
		assertOwnedPrWorktree(root, meta.number, meta.headSha, location);
		assertCleanCheckout(location);
	} else {
		const ref = `refs/rpac/pr/${meta.number}`;
		// Fetch the PR head ref itself into a local ref. Do NOT fetch the remote's HEAD:
		// GitHub's HEAD is the default branch, not the PR head.
		const fetched = runGitText(root, ["fetch", remote, `+refs/pull/${meta.number}/head:${ref}`]);
		const fetchedOk = runGitText(root, ["rev-parse", "--verify", ref], true);
		if (!fetchedOk || fetchedOk !== meta.headSha) {
			throw new Error(
				`could not fetch the PR head from ${remote} (refs/pull/${meta.number}/head)${fetched ? `: ${fetched}` : ""} — ` +
				`verify the remote points at ${meta.repository} and the PR refs are reachable`,
			);
		}
		const added = runGitText(root, ["worktree", "add", "--detach", location, ref]);
		const head = runGitText(location, ["rev-parse", "HEAD"], true);
		if (!head || head !== meta.headSha) {
			throw new Error(`worktree checkout failed${added ? `: ${added}` : ""} (expected head ${meta.headSha.slice(0, 12)})`);
		}
		// Ownership is recorded in Git's administrative dir, never in reviewed files.
		writeFileSync(ownerFile(location), JSON.stringify({ root: realpathSync(root), number: meta.number, head }), { flag: "wx" });
		return { strategy, location, head, output: [retained, added].filter(Boolean).join("\n") };
	}
	return { strategy, location, head: runGitText(location, ["rev-parse", "HEAD"]), output: "reused existing worktree" };
}

function isSymlink(path: string): boolean {
	try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function ownerFile(location: string): string {
	return join(runGitText(location, ["rev-parse", "--absolute-git-dir"]), "rpac-pr-owner.json");
}

/** Validate exact registered location, common repository, and RPAC ownership. */
export function assertOwnedPrWorktree(root: string, number: number, expectedHead?: string, location = prWorktreePath(root, number)): void {
	if (!isPrWorktreeLocation(root, number, location)) throw new Error("PR worktree ownership check failed: unexpected checkout location");
	if (isSymlink(location) || !existsSync(location) || realpathSync(location) !== resolve(location)) {
		throw new Error("PR worktree ownership check failed: missing or symlinked location");
	}
	if (!registeredWorktreeLocations(root).has(location)) {
		throw new Error("PR location is not a registered worktree of this repository");
	}
	const common = (path: string) => realpathSync(runGitText(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
	if (common(root) !== common(location)) throw new Error("PR worktree belongs to a different repository");
	let owner: { root?: string; number?: number; head?: string };
	try { owner = JSON.parse(readFileSync(ownerFile(location), "utf8")); }
	catch { throw new Error("PR worktree is not RPAC-owned (missing ownership record)"); }
	if (owner.root !== realpathSync(root) || owner.number !== number || !owner.head ||
		(expectedHead && owner.head !== expectedHead)) throw new Error("PR worktree ownership record does not match this review");
	if (runGitText(location, ["rev-parse", "HEAD"]) !== owner.head) throw new Error("PR worktree HEAD changed; refusing cleanup/reuse");
}

/** Status can hide local modifications behind assume-unchanged/skip-worktree. */
function hasHiddenIndexEntries(location: string): boolean {
	return splitNul(runGitBuffer(location, ["ls-files", "-v", "-z"]))
		.some(record => record[0] === 0x53 || (record[0]! >= 0x61 && record[0]! <= 0x7a));
}

/** Includes ignored files: Git otherwise discards them during worktree removal. */
function assertCleanCheckout(location: string, allowRpacState = false): void {
	if (hasHiddenIndexEntries(location)) throw new Error("PR worktree index hides potentially dirty files (assume-unchanged/skip-worktree); refusing cleanup/reuse");
	const status = runGitBuffer(location, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored", "--ignore-submodules=none"]);
	if (status.length && (!allowRpacState || !cleanPrStatus(status))) {
		throw new Error("PR worktree has dirty/uncommitted, untracked, or ignored files; preserve them before cleanup/reuse");
	}
}

/** No force, no filesystem fallback, and no pruning unrelated worktrees. */
export function removePrWorktree(root: string, number: number, expectedHead?: string, location = prWorktreePath(root, number)): string {
	if (!isPrWorktreeLocation(root, number, location)) throw new Error("PR worktree ownership check failed: unexpected cleanup location");
	if (!existsSync(location) && !isSymlink(location)) return registeredWorktreeLocations(root).has(location)
		? `Worktree directory is missing; its registration is retained at ${location}. No metadata was deleted. A fresh preview can use a new checkout.`
		: "no worktree to remove";
	assertOwnedPrWorktree(root, number, expectedHead, location);
	assertCleanCheckout(location);
	runGitText(root, ["worktree", "remove", location]);
	return `removed PR worktree at ${location}`;
}

/** Verify that build/test evidence would come from the pinned, uncontaminated checkout. */
export function assertPrCheckout(root: string, pr: PrReviewMeta, generatedPaths: readonly string[] = []): void {
	if (pr.checkoutStrategy === "worktree") {
		if (!isPrWorktreeLocation(root, pr.number, pr.checkoutLocation)) throw new Error("PR checkout location does not match its owned worktree");
		assertOwnedPrWorktree(root, pr.number, pr.headSha, pr.checkoutLocation);
	} else if (resolve(pr.checkoutLocation) !== resolve(root)) throw new Error("PR in-place checkout location is invalid");
	if (runGitText(pr.checkoutLocation, ["rev-parse", "HEAD"]) !== pr.headSha) throw new Error("PR checkout HEAD differs from the reviewed commit");
	if (hasHiddenIndexEntries(pr.checkoutLocation)) throw new Error("PR checkout index hides potential local changes; verification evidence is untrusted");
	for (const output of generatedPaths) {
		let current = pr.checkoutLocation;
		for (const part of output.split("/").filter(Boolean)) { current = join(current, part); if (isSymlink(current)) throw new Error("Approved output directory is symlinked; verification evidence is untrusted"); }
	}
	const status = runGitBuffer(pr.checkoutLocation, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
	if (!cleanPrStatus(status, pr.checkoutStrategy === "in-place" && resolve(root) === resolve(pr.checkoutLocation), generatedPaths)) throw new Error("PR checkout contains uncommitted or untracked changes; verification evidence is stale");
}

/** Re-resolve the current PR head SHA (for force-push / drift detection). */
export function resolvePrHeadSha(gh: GhRunner, root: string, number: number): string {
	const view = gh.prView(root, number);
	if (typeof view.headRefOid !== "string" || !/^[0-9a-f]{40}$/.test(view.headRefOid)) {
		throw new Error(`could not re-resolve the current head for PR #${number}`);
	}
	return view.headRefOid;
}

/** Build the durable PrReviewMeta from the resolved PR + checkout outcome. */
export function buildPrMeta(
	resolved: ResolvedPr,
	outcome: PrCheckoutOutcome,
	original: { branch: string; head: string; dirty: string[] },
): PrReviewMeta {
	return {
		number: resolved.number,
		url: resolved.url,
		title: resolved.title,
		body: resolved.body,
		repository: resolved.repository,
		state: resolved.state,
		crossRepository: resolved.crossRepository,
		baseRef: resolved.baseRef,
		baseSha: resolved.baseSha,
		headRef: resolved.headRef,
		headSha: resolved.headSha,
		...(resolved.headRepositoryOwner ? { headRepositoryOwner: resolved.headRepositoryOwner } : {}),
		originalBranch: original.branch,
		originalHead: original.head,
		originalDirty: [...original.dirty],
		checkoutStrategy: outcome.strategy,
		checkoutLocation: outcome.location,
		checkedOutAt: nowIso(),
	};
}
