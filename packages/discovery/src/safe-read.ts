import { realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { checkSafeFile, readSafeFile } from "@dynamic-skills/core";
import { SKIPPED_DIRS } from "./file-index";
import { isSecretPath } from "./secrets";

/** Largest file that may be read; bigger files are treated as unreadable. */
const MAX_READ_BYTES = 1_000_000;

/** Why {@link resolveRepoPath} refused a path. */
export type RepoPathRejection = "secret" | "outside-repo" | "excluded" | "missing";

/** Outcome of {@link resolveRepoPath}. */
export type ResolvedRepoPath =
  | {
      ok: true;
      /** Normalised POSIX repo-relative path as requested. */
      rel: string;
      /** Real (symlink-resolved) absolute path. */
      abs: string;
      /** Real POSIX path relative to the real repo root; use it to detect aliases of one file. */
      realRel: string;
    }
  | { ok: false; reason: RepoPathRejection };

/** True when `rel` (from `relative(root, target)`) stays inside `root`. */
function isInside(rel: string): boolean {
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** True when any segment of a POSIX path is a skipped directory (dependencies, build output). */
function hasSkippedSegment(rel: string): boolean {
  return rel.split("/").some((s) => SKIPPED_DIRS.includes(s));
}

/** Why {@link readRegularFile} refused or failed to read a file. */
export type FileReadRejection = "missing" | "not-a-file" | "too-large" | "unreadable";

/** Outcome of {@link readRegularFile}. */
export type FileRead = { ok: true; text: string } | { ok: false; reason: FileReadRejection };

/**
 * Reads a file that must be a regular file of at most `maxBytes`, through one non-blocking handle
 * (`O_NONBLOCK`, so a FIFO or device can never hang the caller; the type and size checks run on
 * that same handle, so the file checked is the file read). Symlinks are followed: callers that
 * must not leave a root resolve the path first ({@link resolveRepoPath}).
 *
 * @param abs - Absolute path.
 * @param maxBytes - Largest accepted size; defaults to 1 MB.
 * @returns `{ ok: true, text }`, or `{ ok: false, reason }` with `missing` (no such file),
 *   `not-a-file` (directory, FIFO, socket, device), `too-large` or `unreadable`. Never throws.
 */
export async function readRegularFile(
  abs: string,
  maxBytes: number = MAX_READ_BYTES,
): Promise<FileRead> {
  const read = await readSafeFile(abs, { maxBytes });
  if (read.ok) return { ok: true, text: read.text };
  // `wrong-name` is only produced when a basename is required, which this reader never sets.
  return { ok: false, reason: read.reason === "wrong-name" ? "unreadable" : read.reason };
}

/**
 * Reads a file through a single non-blocking handle.
 *
 * @param abs - Absolute (real) path.
 * @returns UTF-8 text, or `null` when not a regular file (FIFOs included), over 1 MB or
 *   unreadable. Never throws or blocks.
 */
export async function readRealFile(abs: string): Promise<string | null> {
  const r = await readRegularFile(abs, MAX_READ_BYTES);
  return r.ok ? r.text : null;
}

/**
 * Validates a repo-relative path before any read (PRD §6.7, §7: secrets and excluded
 * directories are never read, symlinks cannot escape).
 *
 * Order matters: lexical checks first (cheap, no I/O), then `realpath`, then the same secret
 * and excluded-directory rules on the real repo-relative path, so a symlink such as
 * `link-git -> .git/config` or `link.txt -> .env` cannot reach what the name hides.
 *
 * @param repo - Repository root.
 * @param rel - Requested path; `./` prefixes are stripped.
 * @returns The normalised path and real absolute path, or the rejection reason. Never throws.
 */
export async function resolveRepoPath(repo: string, rel: string): Promise<ResolvedRepoPath> {
  const normalised = posix.normalize(rel.replace(/\\/g, "/")).replace(/^(\.\/)+/, "");
  if (
    isAbsolute(rel) ||
    normalised === ".." ||
    normalised.startsWith("../") ||
    normalised === "" ||
    normalised === "."
  ) {
    return { ok: false, reason: "outside-repo" };
  }
  if (isSecretPath(normalised)) return { ok: false, reason: "secret" };
  if (hasSkippedSegment(normalised)) return { ok: false, reason: "excluded" };
  try {
    const realRoot = await realpath(repo);
    const real = await realpath(resolve(repo, normalised));
    const back = relative(realRoot, real);
    if (!isInside(back)) return { ok: false, reason: "outside-repo" };
    const backPosix = back.split(sep).join("/");
    if (isSecretPath(backPosix)) return { ok: false, reason: "secret" };
    if (hasSkippedSegment(backPosix)) return { ok: false, reason: "excluded" };
    if (!(await checkSafeFile(real, { maxBytes: MAX_READ_BYTES })).ok)
      return { ok: false, reason: "missing" };
    return { ok: true, rel: normalised, abs: real, realRel: backPosix };
  } catch {
    return { ok: false, reason: "missing" };
  }
}

/**
 * Creates the sandboxed text reader used by detectors and the context packet.
 *
 * @param repo - Repository root.
 * @returns A function resolving a repo-relative path to its UTF-8 text, or `null` for anything
 *   {@link resolveRepoPath} rejects or that cannot be read.
 */
export function createRepoReader(repo: string): (rel: string) => Promise<string | null> {
  return async (rel) => {
    const r = await resolveRepoPath(repo, rel);
    if (!r.ok) return null;
    return readRealFile(r.abs);
  };
}
