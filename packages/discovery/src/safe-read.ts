import { open, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
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

/**
 * Reads a file through a single handle so the regular-file and size checks apply to exactly
 * the bytes read (no gap between a `stat` and a later read).
 *
 * @param abs - Absolute (real) path.
 * @returns UTF-8 text, or `null` when not a regular file, over 1 MB or unreadable.
 */
export async function readRealFile(abs: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(abs, "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_READ_BYTES) return null;
    return await handle.readFile("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
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
    if ((await readRealFile(real)) === null) return { ok: false, reason: "missing" };
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
