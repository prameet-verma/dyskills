import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename } from "node:path";

/** O_NONBLOCK so opening a FIFO or device never blocks; the type check then rejects it. */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;

/** As {@link OPEN_FLAGS}, plus O_NOFOLLOW: a symlink swapped in after the name check is refused. */
const OPEN_FLAGS_NOFOLLOW = OPEN_FLAGS | constants.O_NOFOLLOW;

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

/** Outcome of {@link checkSafeFile}: no content, only whether the file passes the checks. */
export type SafeCheck = { ok: true } | { ok: false; reason: SafeReadRejection };

/**
 * Rejects a nonsensical cap up front: a bad `maxBytes` is a programming error, not a file problem.
 * @throws {TypeError} Unless `maxBytes` is undefined or a finite non-negative integer.
 */
function assertMaxBytes(maxBytes: number | undefined): void {
  if (maxBytes !== undefined && !(Number.isInteger(maxBytes) && maxBytes >= 0)) {
    throw new TypeError("maxBytes must be a finite non-negative integer");
  }
}

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
    // The resolved target is opened without following links: if a symlink is swapped in after
    // the name check, the open fails with ELOOP (reported as unreadable) instead of escaping.
    handle = await open(target, opts.realBasename !== undefined ? OPEN_FLAGS_NOFOLLOW : OPEN_FLAGS);
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
    // Size the buffer from stat (plus one byte to detect growth) rather than from the cap, so a
    // small file never allocates the whole cap. If more bytes arrive than stat reported, grow up
    // to maxBytes + 1; one byte past the cap means too-large.
    let buf = Buffer.allocUnsafe(Math.min(info.size, maxBytes) + 1);
    let length = 0;
    for (;;) {
      if (length === buf.length) {
        if (buf.length > maxBytes) break;
        const grown = Buffer.allocUnsafe(Math.min(buf.length * 2, maxBytes + 1));
        buf.copy(grown, 0, 0, length);
        buf = grown;
      }
      const { bytesRead } = await handle.read(buf, length, buf.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) return { ok: false, reason: "too-large" };
    // An exact-length copy: only bytes that were read, and no pinned spare capacity.
    const bytes = Buffer.from(buf.subarray(0, length));
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
 * @throws {TypeError} When `maxBytes` is not a finite non-negative integer (synchronously).
 * @returns The bytes, text and sha256, or `{ ok: false, reason }` (`missing`, `not-a-file`,
 *   `too-large`, `wrong-name`, `unreadable`). Never rejects for file problems.
 */
export function readSafeFile(path: string, opts: SafeReadOptions = {}): Promise<SafeRead> {
  assertMaxBytes(opts.maxBytes);
  return openChecked(path, opts, true);
}

/**
 * Like {@link readSafeFile} but only validates: opens and checks the file without reading it.
 *
 * @param path - Absolute path.
 * @param opts - Size cap and optional required real basename.
 * @throws {TypeError} When `maxBytes` is not a finite non-negative integer (synchronously).
 * @returns `{ ok: true }` or the rejection.
 */
export function checkSafeFile(path: string, opts: SafeReadOptions = {}): Promise<SafeCheck> {
  assertMaxBytes(opts.maxBytes);
  return openChecked(path, opts, false).then((r) => (r.ok ? { ok: true } : r));
}
