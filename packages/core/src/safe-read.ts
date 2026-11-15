import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename } from "node:path";

/** O_NONBLOCK so opening a FIFO or device never blocks; the type check then rejects it. */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;

/** Default size cap of {@link readSafeFile} when none is given: 1 MB. */
const DEFAULT_MAX_BYTES = 1_000_000;

/** Why {@link readSafeFile} refused or failed to read a file. */
export type SafeReadRejection =
  "missing" | "not-a-file" | "too-large" | "wrong-name" | "unreadable";

/** Options of {@link readSafeFile}. */
export interface SafeReadOptions {
  /** Largest accepted size in bytes; defaults to 1 MB. */
  maxBytes?: number;
  /**
   * When set, the symlink-resolved path must have exactly this basename, so a symlink named
   * `SKILL.md` cannot redirect a read to `.env` or a private key.
   */
  realBasename?: string;
}

/** Outcome of {@link readSafeFile}: the bytes, their text and the sha256 of exactly those bytes. */
export type SafeRead =
  | { ok: true; bytes: Buffer; text: string; sha256: string }
  | { ok: false; reason: SafeReadRejection };

/**
 * Opens one non-blocking handle, checks the file is a regular file within the size cap, and (when
 * `read` is set) reads it through that same handle. Never throws.
 */
async function openChecked(path: string, opts: SafeReadOptions, read: boolean): Promise<SafeRead> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  let handle;
  try {
    let target = path;
    if (opts.realBasename !== undefined) {
      target = await realpath(path);
      if (basename(target) !== opts.realBasename) return { ok: false, reason: "wrong-name" };
    }
    handle = await open(target, OPEN_FLAGS);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable",
    };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, reason: "not-a-file" };
    if (info.size > maxBytes) return { ok: false, reason: "too-large" };
    if (!read) return { ok: true, bytes: Buffer.alloc(0), text: "", sha256: "" };
    const bytes = await handle.readFile();
    // The file may have grown between stat and read; the cap applies to the bytes actually read.
    if (bytes.length > maxBytes) return { ok: false, reason: "too-large" };
    return {
      ok: true,
      bytes,
      text: bytes.toString("utf8"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The one safe file reader. Reads a file that must be a regular file of at most `maxBytes`
 * through a single non-blocking handle: a FIFO or device can never hang the caller, and the type
 * and size checks run on that same handle, so the file checked is the file read. The returned
 * text and sha256 come from exactly the same bytes. Symlinks are followed; pass `realBasename` to
 * require the resolved name, or resolve the path against a root first when it must not escape.
 *
 * @param path - Absolute path.
 * @param opts - Size cap and optional required real basename.
 * @returns The bytes, text and sha256, or `{ ok: false, reason }` (`missing`, `not-a-file`,
 *   `too-large`, `wrong-name`, `unreadable`). Never throws.
 */
export function readSafeFile(path: string, opts: SafeReadOptions = {}): Promise<SafeRead> {
  return openChecked(path, opts, true);
}

/**
 * Like {@link readSafeFile} but only validates: opens and checks the file without reading it.
 *
 * @param path - Absolute path.
 * @param opts - Size cap and optional required real basename.
 * @returns `{ ok: true }` (with empty content) or the rejection. Never throws.
 */
export function checkSafeFile(path: string, opts: SafeReadOptions = {}): Promise<SafeRead> {
  return openChecked(path, opts, false);
}
