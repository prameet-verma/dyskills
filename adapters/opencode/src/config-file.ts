import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { parse, type ParseError } from "jsonc-parser";
import type { JsonValue } from "@dynamic-skills/adapter-sdk";

/** Largest config file the plan-time reader parses; the same cap `applyPlan` enforces. */
export const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

/** Result of reading one config file at plan time. */
export interface ConfigRead {
  /** The parsed document; `undefined` when missing, unparsable or refused. */
  doc: JsonValue | undefined;
  /** Why the file was refused without being read, when it was. */
  refused?: "symlink" | "too large" | "not a regular file";
}

/**
 * Reads and parses `path` as JSON or JSONC (comments and trailing commas allowed), bounded and
 * without trusting the path. With `followSymlinks` false (the file `init` will merge into) a
 * symlink is refused after `lstat` and before any read, and the file is opened with `O_NOFOLLOW`;
 * with it true (other config layers, which OpenCode itself follows) the target is used. Either way
 * the file must be a regular file of at most {@link MAX_CONFIG_BYTES}, and at most that many bytes
 * are read. A missing, unreadable or unparsable file yields `doc: undefined`.
 *
 * @param path - Config file path.
 * @param followSymlinks - Whether a symlink may be followed.
 * @returns The document, and a refusal reason when the file was not read for a policy reason.
 */
export async function readConfigDocument(
  path: string,
  followSymlinks: boolean,
): Promise<ConfigRead> {
  try {
    const link = await lstat(path);
    if (link.isSymbolicLink() && !followSymlinks) return { doc: undefined, refused: "symlink" };
    const info = link.isSymbolicLink() ? await stat(path) : link;
    if (!info.isFile()) return { doc: undefined, refused: "not a regular file" };
    if (info.size > MAX_CONFIG_BYTES) return { doc: undefined, refused: "too large" };
    // O_NONBLOCK: a path swapped for a FIFO after the lstat must not block the open.
    const flags =
      (followSymlinks ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW) |
      constants.O_NONBLOCK;
    const handle = await open(path, flags);
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) return { doc: undefined, refused: "not a regular file" };
      if (opened.size > MAX_CONFIG_BYTES) return { doc: undefined, refused: "too large" };
      const buf = Buffer.alloc(Math.min(opened.size, MAX_CONFIG_BYTES) + 1);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      if (bytesRead > MAX_CONFIG_BYTES || bytesRead > opened.size) {
        return { doc: undefined, refused: "too large" };
      }
      const errors: ParseError[] = [];
      const value = parse(buf.subarray(0, bytesRead).toString("utf8"), errors, {
        allowTrailingComma: true,
      }) as JsonValue | undefined;
      return { doc: errors.length > 0 ? undefined : value };
    } finally {
      await handle.close();
    }
  } catch {
    return { doc: undefined };
  }
}

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
