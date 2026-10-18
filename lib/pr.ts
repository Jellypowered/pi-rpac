// RPAC GitHub PR review — metadata resolution, safe checkout, and the
// object-level base...head snapshot that scopes a PR review.
//
// Design (see DESIGN.md §2.8):
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
import { basename, dirname, join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import type { PrReviewMeta } from "./schema.ts";
import {
	type ReviewExclusion,
	type ReviewLayer,
	type ReviewManifestItem,
	runGitBuffer,
	runGitText,
	splitNul,
	pathKey,
	displayPath,
	itemId,
	sha256,
	canonicalJson,
	LARGE_FILE_BYTES,
} from "./review.ts";
import { nowIso } from "./util.ts";
import { gitInfo } from "./git.ts";

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
		const res = runGh(["pr", "checkout", String(number)], root);
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
	const m = url.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
	return m ? `${m[1]}/${m[2]}` : "";
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
export function resolvePrMeta(view: PrViewResult): ResolvedPr {
	const shaOk = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
	if (typeof view.baseRefOid !== "string" || !shaOk(view.baseRefOid) || typeof view.headRefOid !== "string" || !shaOk(view.headRefOid)) {
		throw new Error("PR metadata is missing a valid base/head commit SHA — the PR references may be unavailable");
	}
	const repository = repositoryFromUrl(view.url)
		|| view.headRepository?.nameWithOwner
		|| "";
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

/** Inspect the repository to decide whether a PR checkout is safe. */
export function assessPrCheckout(root: string): CheckoutAssessment {
	const info = gitInfo(root);
	const remotes = runGitText(root, ["remote"], true);
	const remoteNames = remotes ? remotes.split("\n").map((l) => l.trim()).filter(Boolean) : [];
	const remote = remoteNames.includes("origin") ? "origin" : (remoteNames[0] ?? null);
	return {
		isRepo: info.isRepo,
		hasRemote: remoteNames.length > 0,
		remote,
		clean: info.dirty.length === 0,
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

/** OID of `commit:path` or null when the object is absent (added/deleted side). */
function objectShaAt(root: string, commit: string, pathDisplay: string): string | null {
	if (!pathDisplay) return null;
	const oid = runGitText(root, ["rev-parse", "--verify", `${commit}:${pathDisplay}`], true);
	return oid || null;
}

function prObjectLayer(
	root: string,
	oid: string,
	source: "base" | "pr",
	cache: Map<string, { sha256: string; size: number; binary: boolean; large: boolean }>,
): ReviewLayer {
	let blob = cache.get(oid);
	if (!blob) {
		const bytes = runGitBuffer(root, ["cat-file", "blob", oid]);
		blob = {
			sha256: sha256(bytes),
			size: bytes.length,
			binary: bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0),
			large: bytes.length > LARGE_FILE_BYTES,
		};
		cache.set(oid, blob);
	}
	return { source, state: "present", objectId: oid, ...blob };
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
	const data = runGitBuffer(resolvedRoot, ["diff", "--name-status", "--find-renames", "-z", `${baseSha}...${headSha}`]);
	const records = parseNameStatus(data);
	const exclusionSet = new Set(exclusions.map((e) => e.path));
	const blobCache = new Map<string, { sha256: string; size: number; binary: boolean; large: boolean }>();
	const items: ReviewManifestItem[] = [];
	const ordered = [...records].sort((a, b) => Buffer.compare(a.path, b.path));
	for (const rec of ordered) {
		const key = pathKey(rec.path);
		const path = displayPath(rec.path);
		if (exclusionSet.has(path)) continue;
		const basePath = rec.originalPath ?? rec.path;
		const baseOid = objectShaAt(resolvedRoot, baseSha, displayPath(basePath));
		const headOid = objectShaAt(resolvedRoot, headSha, path);
		const layers: ReviewLayer[] = [
			baseOid ? prObjectLayer(resolvedRoot, baseOid, "base", blobCache) : { source: "base", state: "deleted" },
			headOid ? prObjectLayer(resolvedRoot, headOid, "pr", blobCache) : { source: "pr", state: "deleted" },
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

/** Deterministic sibling location for an isolated PR worktree. */
export function prWorktreePath(root: string, number: number): string {
	return join(dirname(root), `${basename(root)}-rpac-pr-${number}`);
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
		const output = gh.prCheckout(root, meta.number);
		const head = runGitText(root, ["rev-parse", "HEAD"]);
		if (head !== meta.headSha) {
			throw new Error(`in-place checkout did not land on the PR head (${head.slice(0, 12)} ≠ ${meta.headSha.slice(0, 12)})`);
		}
		return { strategy, location: root, head, output };
	}

	// worktree strategy
	const location = prWorktreePath(root, meta.number);
	if (existsSync(location)) {
		// Reuse an existing worktree only if it already points at the head.
		const existingHead = runGitText(location, ["rev-parse", "HEAD"], true);
		if (existingHead !== meta.headSha) {
			throw new Error(
				`a directory already exists at the PR worktree location ${location} and does not match the PR head — remove it manually and retry`,
			);
		}
	} else {
		const ref = `refs/rpac/pr/${meta.number}`;
		// Fetch the PR head ref itself into a local ref. Do NOT fetch the remote's HEAD:
		// GitHub's HEAD is the default branch, not the PR head.
		const fetched = runGitText(root, ["fetch", remote, `+refs/pull/${meta.number}/head:${ref}`], true);
		const fetchedOk = runGitText(root, ["rev-parse", "--verify", ref], true);
		if (!fetchedOk || fetchedOk !== meta.headSha) {
			throw new Error(
				`could not fetch the PR head from ${remote} (refs/pull/${meta.number}/head)${fetched ? `: ${fetched}` : ""} — ` +
				`verify the remote points at ${meta.repository} and the PR refs are reachable`,
			);
		}
		const added = runGitText(root, ["worktree", "add", "--detach", location, ref], true);
		const head = runGitText(location, ["rev-parse", "HEAD"], true);
		if (!head || head !== meta.headSha) {
			throw new Error(`worktree checkout failed${added ? `: ${added}` : ""} (expected head ${meta.headSha.slice(0, 12)})`);
		}
		return { strategy, location, head, output: added };
	}
	return { strategy, location, head: runGitText(location, ["rev-parse", "HEAD"]), output: "reused existing worktree" };
}

/** Remove an isolated PR worktree (safe cleanup; refuses in-place location). */
export function removePrWorktree(root: string, number: number): string {
	const location = prWorktreePath(root, number);
	if (!existsSync(location)) return "no worktree to remove";
	runGitText(root, ["worktree", "remove", "--force", location], true);
	if (existsSync(location)) rmSync(location, { recursive: true, force: true });
	runGitText(root, ["worktree", "prune"], true);
	return `removed PR worktree at ${location}`;
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
