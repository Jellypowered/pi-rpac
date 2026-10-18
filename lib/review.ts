// Exact, deterministic Git snapshots for RPAC review workflows.
//
// Git output is consumed as Buffers and path identity is retained as base64 so
// spaces, newlines, leading dashes, and non-UTF-8 bytes cannot change scope.
// No shell is involved: every Git argument is passed directly to execFileSync.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	readFileSync,
	readlinkSync,
} from "node:fs";
import { join } from "node:path";
import { nowIso } from "./util.ts";

export const REVIEW_MODES = ["current", "staged", "full"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

export type ReviewLayerName = "head" | "index" | "worktree" | "base" | "pr";
export type ReviewObjectKind = "file" | "symlink" | "gitlink" | "other";

export interface ReviewLayer {
	source: ReviewLayerName;
	state: "present" | "deleted";
	mode?: string;
	kind?: ReviewObjectKind;
	/** Git object id where one exists (algorithm follows the repository). */
	objectId?: string;
	/** SHA-256 of file/blob bytes or symlink target bytes. */
	sha256?: string;
	size?: number;
	binary?: boolean;
	large?: boolean;
	linkTargetBase64?: string;
}

export interface ReviewManifestItem {
	/** Stable identity derived from the raw pathname bytes. */
	id: string;
	/** Display-only UTF-8 decoding; pathBase64 is authoritative. */
	path: string;
	pathBase64: string;
	originalPath?: string;
	originalPathBase64?: string;
	change: string;
	conflicted?: boolean;
	layers: ReviewLayer[];
}

export interface ReviewExclusion {
	path: string;
	reason: string;
}

export interface ReviewSnapshot {
	version: 1;
	mode: ReviewMode;
	root: string;
	head: string;
	unborn: boolean;
	capturedAt: string;
	fingerprintAlgorithm: "sha256";
	fingerprint: string;
	patches: {
		combined?: string;
		staged?: string;
		unstaged?: string;
	};
	items: ReviewManifestItem[];
	exclusions: ReviewExclusion[];
	conflictItemIds: string[];
}

export interface ReviewDrift {
	unchanged: boolean;
	before: string;
	after: string;
	addedItemIds: string[];
	removedItemIds: string[];
	changedItemIds: string[];
}

export interface GitEntry {
	path: Buffer;
	mode: string;
	oid: string;
	stage?: number;
	kind?: string;
}

interface StatusEntry {
	path: Buffer;
	originalPath?: Buffer;
	xy: string;
	change: string;
	conflicted: boolean;
	untracked: boolean;
}

const LARGE_FILE_BYTES = 1024 * 1024;
export { LARGE_FILE_BYTES };

export function sha256(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

export function runGitBuffer(root: string, args: string[], allowFailure = false): Buffer {
	try {
		return execFileSync("git", args, {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "buffer",
			maxBuffer: 256 * 1024 * 1024,
			timeout: 120_000,
		}) as Buffer;
	} catch (err) {
		if (allowFailure) return Buffer.alloc(0);
		const detail = (err as { stderr?: Buffer }).stderr?.toString("utf8").trim();
		throw new Error(`git ${args[0] ?? "command"} failed${detail ? `: ${detail}` : ""}`);
	}
}

export function runGitText(root: string, args: string[], allowFailure = false): string {
	return runGitBuffer(root, args, allowFailure).toString("utf8").trim();
}

export function splitNul(data: Buffer): Buffer[] {
	const result: Buffer[] = [];
	let start = 0;
	for (let i = 0; i < data.length; i++) {
		if (data[i] !== 0) continue;
		if (i > start) result.push(data.subarray(start, i));
		start = i + 1;
	}
	if (start < data.length) result.push(data.subarray(start));
	return result;
}

export function pathKey(path: Buffer): string {
	return path.toString("base64");
}

export function displayPath(path: Buffer): string {
	return path.toString("utf8");
}

export function itemId(path: Buffer): string {
	return `ri-${sha256(path).slice(0, 20)}`;
}

function parseLsFiles(data: Buffer): { entries: Map<string, GitEntry>; conflicts: Set<string> } {
	const entries = new Map<string, GitEntry>();
	const conflicts = new Set<string>();
	for (const record of splitNul(data)) {
		const tab = record.indexOf(0x09);
		if (tab < 0) continue;
		const meta = record.subarray(0, tab).toString("ascii").split(" ");
		if (meta.length < 3) continue;
		const path = Buffer.from(record.subarray(tab + 1));
		const stage = Number(meta[2]);
		const key = pathKey(path);
		if (stage !== 0) {
			conflicts.add(key);
			continue;
		}
		entries.set(key, { path, mode: meta[0]!, oid: meta[1]!, stage });
	}
	return { entries, conflicts };
}

export function parseLsTree(data: Buffer): Map<string, GitEntry> {
	const result = new Map<string, GitEntry>();
	for (const record of splitNul(data)) {
		const tab = record.indexOf(0x09);
		if (tab < 0) continue;
		const meta = record.subarray(0, tab).toString("ascii").split(" ");
		if (meta.length < 3) continue;
		const path = Buffer.from(record.subarray(tab + 1));
		result.set(pathKey(path), { path, mode: meta[0]!, kind: meta[1]!, oid: meta[2]! });
	}
	return result;
}

function splitFixedFields(record: Buffer, count: number): { fields: string[]; tail: Buffer } | null {
	const fields: string[] = [];
	let start = 0;
	for (let i = 0; i < record.length && fields.length < count; i++) {
		if (record[i] !== 0x20) continue;
		fields.push(record.subarray(start, i).toString("ascii"));
		start = i + 1;
	}
	return fields.length === count ? { fields, tail: Buffer.from(record.subarray(start)) } : null;
}

function parseStatus(data: Buffer): StatusEntry[] {
	const records = splitNul(data);
	const result: StatusEntry[] = [];
	for (let i = 0; i < records.length; i++) {
		const record = records[i]!;
		const tag = String.fromCharCode(record[0] ?? 0);
		if (tag === "1") {
			const parsed = splitFixedFields(record, 8);
			if (!parsed) continue;
			result.push({
				path: parsed.tail,
				xy: parsed.fields[1] ?? "..",
				change: parsed.fields[1] ?? "modified",
				conflicted: false,
				untracked: false,
			});
		} else if (tag === "2") {
			const parsed = splitFixedFields(record, 9);
			if (!parsed) continue;
			const originalPath = records[++i];
			result.push({
				path: parsed.tail,
				originalPath: originalPath ? Buffer.from(originalPath) : undefined,
				xy: parsed.fields[1] ?? "..",
				change: parsed.fields[8] ?? parsed.fields[1] ?? "renamed",
				conflicted: false,
				untracked: false,
			});
		} else if (tag === "u") {
			const parsed = splitFixedFields(record, 10);
			if (!parsed) continue;
			result.push({
				path: parsed.tail,
				xy: parsed.fields[1] ?? "UU",
				change: "unmerged",
				conflicted: true,
				untracked: false,
			});
		} else if (tag === "?") {
			result.push({ path: Buffer.from(record.subarray(2)), xy: "??", change: "untracked", conflicted: false, untracked: true });
		}
	}
	return result;
}

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function blobLayer(
	root: string,
	entry: GitEntry | undefined,
	source: ReviewLayerName,
	blobCache: Map<string, { sha256: string; size: number; binary: boolean; large: boolean }>,
): ReviewLayer {
	if (!entry) return { source, state: "deleted" };
	if (entry.mode === "160000" || entry.kind === "commit") {
		return { source, state: "present", mode: entry.mode, kind: "gitlink", objectId: entry.oid };
	}
	let blob = blobCache.get(entry.oid);
	if (!blob) {
		const bytes = runGitBuffer(root, ["cat-file", "blob", entry.oid]);
		blob = {
			sha256: sha256(bytes),
			size: bytes.length,
			binary: bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0),
			large: bytes.length > LARGE_FILE_BYTES,
		};
		blobCache.set(entry.oid, blob);
	}
	const kind: ReviewObjectKind = entry.mode === "120000" ? "symlink" : "file";
	return { source, state: "present", mode: entry.mode, kind, objectId: entry.oid, ...blob };
}

function diskPath(root: string, path: Buffer): Buffer {
	const prefix = Buffer.from(root.endsWith("/") ? root : `${root}/`);
	return Buffer.concat([prefix, path]);
}

function worktreeLayer(root: string, path: Buffer, index: GitEntry | undefined): ReviewLayer {
	const full = diskPath(root, path);
	if (!existsSync(full)) return { source: "worktree", state: "deleted" };
	const stat = lstatSync(full);
	if (stat.isSymbolicLink()) {
		const target = readlinkSync(full, { encoding: "buffer" }) as Buffer;
		return {
			source: "worktree",
			state: "present",
			mode: "120000",
			kind: "symlink",
			sha256: sha256(target),
			size: target.length,
			binary: false,
			large: false,
			linkTargetBase64: target.toString("base64"),
		};
	}
	if (stat.isDirectory() && index?.mode === "160000") {
		return { source: "worktree", state: "present", mode: "160000", kind: "gitlink" };
	}
	if (!stat.isFile()) {
		return { source: "worktree", state: "present", mode: (stat.mode & 0o777777).toString(8), kind: "other", size: stat.size };
	}
	const bytes = readFileSync(full);
	return {
		source: "worktree",
		state: "present",
		mode: stat.mode & 0o111 ? "100755" : "100644",
		kind: "file",
		sha256: sha256(bytes),
		size: bytes.length,
		binary: bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0),
		large: bytes.length > LARGE_FILE_BYTES,
	};
}

export function isInternalRpacPath(path: Buffer): boolean {
	const text = path.toString("utf8").replaceAll("\\", "/");
	return text === ".pi/rpac" || text.startsWith(".pi/rpac/");
}

/** Presentation preferences are not review scope; this does NOT make a checkout clean. */
export function isReviewMetadataPath(path: Buffer): boolean {
	return isInternalRpacPath(path) || path.equals(Buffer.from(".pi/rpac-style.json"));
}

function selectStatus(status: StatusEntry[], mode: string): StatusEntry[] {
	if (mode === "current") return status;
	return status.filter((entry) => entry.conflicted || (!entry.untracked && entry.xy[0] !== "."));
}

function patchPathspecs(excludedPaths: string[]): string[] {
	return [
		".",
		":(top,exclude,literal).pi/rpac",
		":(top,exclude,literal).pi/rpac-style.json",
		":(top,exclude,glob).pi/rpac/**",
		...[...new Set(excludedPaths)]
			.filter((path) => path.length > 0 && !isReviewMetadataPath(Buffer.from(path)))
			.map((path) => `:(top,exclude,literal)${path}`),
	];
}

function patchHash(root: string, args: string[], excludedPaths: string[]): string {
	return sha256(runGitBuffer(root, [...args, "--", ...patchPathspecs(excludedPaths)], true));
}

/** Capture the selected Git state without writing to the repository. */
export function captureReviewSnapshot(root: string, mode: string, exclusions: ReviewExclusion[] = []): ReviewSnapshot {
	if (!(REVIEW_MODES as readonly string[]).includes(mode)) throw new Error(`unsupported review mode: ${String(mode)}`);
	const top = runGitText(root, ["rev-parse", "--show-toplevel"], true);
	if (!top) throw new Error("review requires a Git work tree");
	const resolvedRoot = top;
	const head = runGitText(resolvedRoot, ["rev-parse", "HEAD"], true);
	const unborn = !head;
	const indexData = parseLsFiles(runGitBuffer(resolvedRoot, ["ls-files", "--stage", "-z"]));
	const headEntries = unborn
		? new Map<string, GitEntry>()
		: parseLsTree(runGitBuffer(resolvedRoot, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"]));
	const status = parseStatus(runGitBuffer(resolvedRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])).map((entry) => {
		// A source renamed INTO preference metadata is still a source deletion.
		// Excluding the destination must not hide shipping-file changes.
		if (entry.originalPath && entry.xy.includes("R") && isReviewMetadataPath(entry.path) &&
			!isInternalRpacPath(entry.path) && !isReviewMetadataPath(entry.originalPath)) {
			return { ...entry, path: entry.originalPath, originalPath: undefined, xy: entry.xy.replaceAll("R", "D"), change: "deleted" };
		}
		return entry;
	});
	const exclusionSet = new Set(exclusions.map((entry) => entry.path));
	const patchExcludedPaths = [...exclusionSet];
	for (const entry of status) {
		if ((isReviewMetadataPath(entry.path) || exclusionSet.has(displayPath(entry.path))) && entry.originalPath) {
			patchExcludedPaths.push(displayPath(entry.originalPath));
		}
	}
	const selected = new Map<string, StatusEntry>();

	if (mode === "full") {
		for (const entry of indexData.entries.values()) {
			selected.set(pathKey(entry.path), {
				path: entry.path,
				xy: "..",
				change: "tracked",
				conflicted: indexData.conflicts.has(pathKey(entry.path)),
				untracked: false,
			});
		}
		for (const entry of status) {
			if (entry.untracked || entry.conflicted || !selected.has(pathKey(entry.path))) selected.set(pathKey(entry.path), entry);
			else {
				const existing = selected.get(pathKey(entry.path))!;
				existing.xy = entry.xy;
				existing.change = entry.change;
				existing.originalPath = entry.originalPath;
			}
		}
		// A conflicted path may have no stage-0 index entry.
		for (const key of indexData.conflicts) {
			if (selected.has(key)) continue;
			const staged = splitNul(runGitBuffer(resolvedRoot, ["ls-files", "-z"])).find((p) => pathKey(p) === key);
			if (staged) selected.set(key, { path: staged, xy: "UU", change: "unmerged", conflicted: true, untracked: false });
		}
	} else {
		for (const entry of selectStatus(status, mode)) selected.set(pathKey(entry.path), entry);
	}

	const blobCache = new Map<string, { sha256: string; size: number; binary: boolean; large: boolean }>();
	const items: ReviewManifestItem[] = [];
	for (const entry of [...selected.values()].sort((a, b) => Buffer.compare(a.path, b.path))) {
		if (isReviewMetadataPath(entry.path)) continue;
		const path = displayPath(entry.path);
		if (exclusionSet.has(path)) continue;
		const key = pathKey(entry.path);
		const originalKey = entry.originalPath ? pathKey(entry.originalPath) : undefined;
		const headEntry = originalKey ? headEntries.get(originalKey) : headEntries.get(key);
		const indexEntry = indexData.entries.get(key);
		const layers: ReviewLayer[] = [];
		if (mode === "current") {
			layers.push(blobLayer(resolvedRoot, headEntry, "head", blobCache));
			layers.push(blobLayer(resolvedRoot, indexEntry, "index", blobCache));
			layers.push(worktreeLayer(resolvedRoot, entry.path, indexEntry));
		} else if (mode === "staged") {
			layers.push(blobLayer(resolvedRoot, headEntry, "head", blobCache));
			layers.push(blobLayer(resolvedRoot, indexEntry, "index", blobCache));
		} else {
			layers.push(
				indexEntry
					? blobLayer(resolvedRoot, indexEntry, "index", blobCache)
					: blobLayer(resolvedRoot, headEntry, "head", blobCache),
			);
			layers.push(worktreeLayer(resolvedRoot, entry.path, indexEntry));
		}
		items.push({
			id: itemId(entry.path),
			path,
			pathBase64: key,
			...(entry.originalPath
				? { originalPath: displayPath(entry.originalPath), originalPathBase64: pathKey(entry.originalPath) }
				: {}),
			change: mode === "staged" ? entry.xy[0] ?? entry.change : entry.change,
			...(entry.conflicted || indexData.conflicts.has(key) ? { conflicted: true } : {}),
			layers,
		});
	}

	const patches: ReviewSnapshot["patches"] = {};
	if (mode === "current") {
		patches.combined = patchHash(resolvedRoot, ["diff", "--binary", "--full-index", "HEAD"], patchExcludedPaths);
		patches.staged = patchHash(resolvedRoot, ["diff", "--cached", "--binary", "--full-index"], patchExcludedPaths);
		patches.unstaged = patchHash(resolvedRoot, ["diff", "--binary", "--full-index"], patchExcludedPaths);
	} else if (mode === "staged") {
		patches.staged = patchHash(resolvedRoot, ["diff", "--cached", "--binary", "--full-index"], patchExcludedPaths);
	}
	const fingerprintInput = {
		mode,
		head: mode === "full" ? undefined : (head || "unborn"),
		patches,
		items: items.map(({ id: _id, path: _path, originalPath: _originalPath, ...identity }) => identity),
		exclusions: [...exclusions].sort((a, b) => a.path.localeCompare(b.path)),
	};
	const fingerprint = sha256(canonicalJson(fingerprintInput));
	return {
		version: 1,
		mode: mode as ReviewMode,
		root: resolvedRoot,
		head: head || "unborn",
		unborn,
		capturedAt: nowIso(),
		fingerprintAlgorithm: "sha256",
		fingerprint,
		patches,
		items,
		exclusions: [...exclusions].sort((a, b) => a.path.localeCompare(b.path)),
		conflictItemIds: items.filter((item) => item.conflicted).map((item) => item.id),
	};
}

/** Compare identities, ignoring capture timestamps and display-only path text. */
export function compareReviewSnapshots(before: Pick<ReviewSnapshot, "items" | "fingerprint">, after: Pick<ReviewSnapshot, "items" | "fingerprint">): ReviewDrift {
	const oldItems = new Map(before.items.map((item) => [item.id, canonicalJson(item)]));
	const newItems = new Map(after.items.map((item) => [item.id, canonicalJson(item)]));
	const addedItemIds = [...newItems.keys()].filter((id) => !oldItems.has(id)).sort();
	const removedItemIds = [...oldItems.keys()].filter((id) => !newItems.has(id)).sort();
	const changedItemIds = [...oldItems.keys()]
		.filter((id) => newItems.has(id) && oldItems.get(id) !== newItems.get(id))
		.sort();
	return {
		unchanged: before.fingerprint === after.fingerprint,
		before: before.fingerprint,
		after: after.fingerprint,
		addedItemIds,
		removedItemIds,
		changedItemIds,
	};
}
