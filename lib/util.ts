// RPAC utilities — pure, no external dependencies (node builtins only).
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

/** ISO-8601 UTC timestamp (second precision). */
export function nowIso(): string {
	return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Short unique id: 8 hex chars of randomness. */
export function shortId(): string {
	return randomBytes(4).toString("hex");
}

/** sha256 of file contents, hex. Returns "" when the file does not exist. */
export function sha256File(path: string): string {
	if (!existsSync(path)) return "";
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** kebab-case slug for file names / ids. */
export function slugify(text: string, maxLen = 48): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLen)
		.replace(/-+$/g, "");
	return slug || "task";
}

/**
 * Atomic, durable write: write to a temp file in the same directory, fsync the
 * file, rename over the target, then fsync the directory so the rename itself
 * survives a crash. The temp file is unlinked on any failure. The rename is
 * atomic on POSIX, so readers never observe a partial file.
 */
export function atomicWriteFile(path: string, content: string): void {
	const dir = dirname(path);
	const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
	try {
		const fd = openSync(tmp, "w", 0o644);
		try {
			writeFileSync(fd, content, "utf8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, path);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			/* temp already gone */
		}
		throw err;
	}
	fsyncDir(dir);
}

/** fsync a directory (best effort — some filesystems do not support it). */
export function fsyncDir(dir: string): void {
	try {
		const fd = openSync(dir, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		// not supported (e.g. some tmpfs/network mounts) — durability degrades to
		// rename-only, which still prevents partial reads
	}
}

/**
 * Project root: the git toplevel when inside a repo, otherwise the working directory itself.
 * RPAC state is scoped to this root so one repo's workflow never leaks into another.
 */
export function projectRoot(cwd: string): string {
	try {
		const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
		}).trim();
		if (top) return top;
	} catch {
		// not a git repo — fall through
	}
	return cwd;
}

/** True when `p` (relative to root) is inside root. Guards path traversal from state files. */
export function isWithin(root: string, p: string): boolean {
	const abs = isAbsolute(p) ? p : join(root, p);
	return abs === root || abs.startsWith(root + "/");
}

/** Create a unique temp dir for tests / isolated runs. */
export function makeTempDir(prefix = "rpac-test-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export function removeTree(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

/** Truncate a string to `max` chars with an ellipsis marker. */
export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, Math.max(0, max - 1)) + "…";
}
