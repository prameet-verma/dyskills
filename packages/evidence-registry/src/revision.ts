import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

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
 * Computes a content fingerprint used to detect changed files between sessions.
 *
 * @param absPath - Absolute path of the file to hash.
 * @returns Lowercase sha256 hex digest (64 characters).
 * @throws If the file cannot be read.
 */
export async function fingerprintFile(absPath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(absPath))
    .digest("hex");
}
