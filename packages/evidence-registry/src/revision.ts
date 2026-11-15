import { execFile } from "node:child_process";
import { MAX_BASE_FILE_BYTES, readSafeFile } from "@dynamic-skills/core";

/**
 * Reads the repository's current commit so evidence can be tied to a revision (PRD §7).
 * Uses `execFile` (no shell) so the path cannot be interpreted as a command.
 *
 * @param repo - Path to the repository root.
 * @returns The HEAD commit sha, or `"untracked"` on any failure (not a repo, no commits, no git).
 */
export function getRepoRevision(repo: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["-C", repo, "rev-parse", "HEAD"], { timeout: 5000 }, (err, stdout) => {
      const sha = stdout.trim();
      resolve(err || !sha ? "untracked" : sha);
    });
  });
}

/**
 * Computes a content fingerprint used to detect changed files between sessions. The read goes
 * through the shared safe reader (one non-blocking handle, regular files only, size-capped), so a
 * FIFO, device or huge file cannot hang or exhaust the caller. Every caller fingerprints a skill
 * file, so the cap defaults to `MAX_BASE_FILE_BYTES`.
 *
 * @param absPath - Absolute path of the file to hash.
 * @param maxBytes - Largest file hashed; defaults to `MAX_BASE_FILE_BYTES`.
 * @returns Lowercase sha256 hex digest (64 characters).
 * @throws If the file is missing, not a regular file, over the cap or unreadable; the message
 *   names the reason and never includes file content.
 */
export async function fingerprintFile(
  absPath: string,
  maxBytes: number = MAX_BASE_FILE_BYTES,
): Promise<string> {
  const read = await readSafeFile(absPath, { maxBytes });
  if (!read.ok) throw new Error(`Cannot fingerprint ${absPath}: ${read.reason}`);
  return read.sha256;
}
