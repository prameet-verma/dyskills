import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isSecretPath } from "./secrets";

/** Bounded listing of a repository's files. */
export interface RepoFileIndex {
  /** POSIX, repo-relative paths in deterministic (breadth-first, sorted) order. */
  files: string[];
  /** True when the walk stopped early because `maxFiles` was reached. */
  truncated: boolean;
}

/** Directories never descended into: dependencies, build output and caches. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  "target",
]);

/**
 * Lists repository files without touching their contents.
 *
 * The walk is breadth-first over sorted entries so shallow manifests are always indexed first
 * and truncation is stable across runs. Symlinks, skipped directories and secret paths are
 * omitted. Unreadable directories are ignored.
 *
 * @param repo - Absolute repository root.
 * @param opts - `maxFiles` (default 5000) and `maxDepth` (default 6; root files are depth 0).
 * @returns The index; `truncated` is true if more files existed than `maxFiles`.
 */
export async function buildFileIndex(
  repo: string,
  opts: { maxFiles?: number; maxDepth?: number } = {},
): Promise<RepoFileIndex> {
  const maxFiles = opts.maxFiles ?? 5000;
  const maxDepth = opts.maxDepth ?? 6;
  const files: string[] = [];
  let queue: string[] = [""];

  for (let depth = 0; queue.length > 0 && depth <= maxDepth; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      let entries;
      try {
        entries = await readdir(join(repo, dir), { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !isSecretPath(`${rel}/x`)) next.push(rel);
        } else if (entry.isFile() && !isSecretPath(rel)) {
          if (files.length >= maxFiles) return { files, truncated: true };
          files.push(rel);
        }
      }
    }
    queue = next;
  }
  return { files, truncated: false };
}
