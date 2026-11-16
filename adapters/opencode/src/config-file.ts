import { stat } from "node:fs/promises";

/**
 * Picks the OpenCode config file to merge into: the first of `candidates` (checked in order) that
 * exists as a regular file, else `fallback`. A candidate that is missing, a directory, or
 * otherwise unreadable is skipped rather than treated as an error.
 *
 * @param candidates - Paths checked in order.
 * @param fallback - Returned when none of `candidates` is an existing regular file.
 * @returns The chosen path.
 */
export async function chooseConfigFile(candidates: string[], fallback: string): Promise<string> {
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // Missing, a dangling symlink, or unreadable: try the next candidate.
    }
  }
  return fallback;
}
