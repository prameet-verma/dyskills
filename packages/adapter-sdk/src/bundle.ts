import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { SkillNameSchema } from "@dynamic-skills/core";
import { isInside, realpathOfPlanned } from "./paths";
import type { BundleManifest } from "./types";

/** Largest number of entries (files and directories) a bundle may hold. */
export const BUNDLE_MAX_ENTRIES = 500;

/** Largest total size of a bundle's files, in bytes (5 MB). */
export const BUNDLE_MAX_BYTES = 5 * 1024 * 1024;

/** Age after which an orphaned `.<name>.tmp-<8 hex>` directory is swept (1 h). */
export const STALE_TEMP_MS = 3_600_000;

const MAX_TEMP_ATTEMPTS = 8;

/** Caps checked while walking and reading a bundle. */
export interface BundleLimits {
  /** Maximum entries; defaults to {@link BUNDLE_MAX_ENTRIES}. */
  maxEntries?: number;
  /** Maximum total file bytes; defaults to {@link BUNDLE_MAX_BYTES}. */
  maxBytes?: number;
}

/**
 * Thrown for an unusable bundle: a symlink or a non-regular entry, a bundle over the caps, a
 * source that changed while it was copied, or a value that is not a skill name or absolute path.
 */
export class BundleLayoutError extends Error {
  /** Creates the error. */
  constructor(message: string) {
    super(message);
    this.name = "BundleLayoutError";
  }
}

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;
const isMissing = (e: unknown): boolean => errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR";

interface Entry {
  rel: string;
  kind: "file" | "dir";
}

/** Lists a bundle's entries (no symlinks or special files allowed), sorted by path, within caps. */
async function walk(dir: string, limits: BundleLimits): Promise<Entry[]> {
  const maxEntries = limits.maxEntries ?? BUNDLE_MAX_ENTRIES;
  const maxBytes = limits.maxBytes ?? BUNDLE_MAX_BYTES;
  const root = await lstat(dir);
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new BundleLayoutError(`bundle root is not a plain directory: ${dir}`);
  }
  const out: Entry[] = [];
  let bytes = 0;
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    for (const name of await readdir(join(dir, rel))) {
      const r = rel === "" ? name : `${rel}/${name}`;
      if (out.length >= maxEntries)
        throw new BundleLayoutError(`bundle has more than ${maxEntries} entries`);
      const st = await lstat(join(dir, r));
      if (st.isSymbolicLink()) throw new BundleLayoutError(`symlink in bundle: ${r}`);
      if (st.isDirectory()) {
        out.push({ rel: r, kind: "dir" });
        stack.push(r);
      } else if (st.isFile()) {
        bytes += st.size;
        if (bytes > maxBytes)
          throw new BundleLayoutError(`bundle is larger than ${maxBytes} bytes`);
        out.push({ rel: r, kind: "file" });
      } else {
        throw new BundleLayoutError(`non-regular entry in bundle: ${r}`);
      }
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/**
 * Reads one bundle file through a single non-blocking, no-follow handle, so a file swapped for a
 * FIFO or a symlink after the directory walk can neither hang nor redirect the read. Hashes the
 * bytes as they are read.
 */
async function readBundleFile(
  path: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; sha256: string }> {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (e) {
    if (errCode(e) === "ELOOP") throw new BundleLayoutError(`symlink in bundle: ${path}`);
    throw e;
  }
  try {
    const info = await fh.stat();
    if (!info.isFile()) throw new BundleLayoutError(`non-regular entry in bundle: ${path}`);
    if (info.size > maxBytes)
      throw new BundleLayoutError(`bundle is larger than ${maxBytes} bytes`);
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.allocUnsafe(65_536);
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new BundleLayoutError(`bundle is larger than ${maxBytes} bytes`);
      const chunk = buf.subarray(0, bytesRead);
      hash.update(chunk);
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks), sha256: hash.digest("hex") };
  } finally {
    await fh.close();
  }
}

/**
 * Hashes a bundle: sorted relative file paths with per-file sha256, and `sha256` over
 * `"<path>\0<sha>\n"` lines. Independent of creation order, modes and timestamps. Throws
 * {@link BundleLayoutError} on a symlink, a non-regular entry or a bundle over the caps
 * ({@link BUNDLE_MAX_ENTRIES} entries, {@link BUNDLE_MAX_BYTES} bytes, or `limits`).
 */
export async function bundleManifest(
  dir: string,
  limits: BundleLimits = {},
): Promise<BundleManifest> {
  let budget = limits.maxBytes ?? BUNDLE_MAX_BYTES;
  const files: { path: string; sha256: string }[] = [];
  for (const e of await walk(dir, limits)) {
    if (e.kind !== "file") continue;
    const read = await readBundleFile(join(dir, e.rel), budget);
    budget -= read.bytes.length;
    files.push({ path: e.rel, sha256: read.sha256 });
  }
  return { files, sha256: sha(files.map((f) => `${f.path}\0${f.sha256}\n`).join("")) };
}

/** Result of {@link placeBundle}. */
export interface PlaceResult {
  /** `<destRoot>/<name>`, as requested. */
  path: string;
  /** What happened (or would happen on a dry run). */
  action: "create" | "unchanged" | "conflict";
  /** Manifest of the source bundle. */
  manifest: BundleManifest;
  /** Why, for a conflict: one of the fixed reasons listed on {@link placeBundle}. */
  reason?: string;
  /** Extra detail for a conflict (never part of the reason vocabulary). */
  detail?: string;
}

/** Input of {@link placeBundle}. */
export interface PlaceInput {
  /** Source bundle directory. */
  srcDir: string;
  /** Absolute skills root; created when missing. */
  destRoot: string;
  /** Skill name; must pass `SkillNameSchema`. */
  name: string;
  /** `save`: files 0644, dirs 0755. `native`: files 0600, dirs 0700. */
  mode: "save" | "native";
  /** The realpath of `destRoot` must lie inside this directory; null allows any. */
  within: string | null;
  /** Report only; create nothing (and sweep nothing). */
  dryRun?: boolean;
  /**
   * Test seams: `afterMkdir` runs after `destRoot` is created, `beforeCopy` after the temp
   * directory exists, `beforeRename` after the verified copy and before the final checks.
   *
   * @internal Never wire user input into these.
   */
  testHooks?: {
    afterMkdir?: () => void | Promise<void>;
    beforeCopy?: () => void | Promise<void>;
    beforeRename?: (target: string) => void | Promise<void>;
  };
}

/** Maps a `realpathOfPlanned` failure to a conflict reason, or null for an unrelated errno. */
function parentReason(e: unknown): string | null {
  switch (errCode(e)) {
    case "ENOTDIR":
      return "parent is not a directory";
    case "ELOOP":
      return "parent is a symlink loop";
    case "ENOENT":
      return "parent is a dangling symlink";
    default:
      return null;
  }
}

async function realOrSelf(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/** Removes `.<name>.tmp-<8 hex>` directories older than {@link STALE_TEMP_MS}; best effort. */
async function sweepStaleTemps(dir: string, name: string): Promise<void> {
  const prefix = `.${name}.tmp-`;
  try {
    for (const entry of await readdir(dir)) {
      if (!entry.startsWith(prefix) || !/^[0-9a-f]{8}$/.test(entry.slice(prefix.length))) continue;
      const p = join(dir, entry);
      const st = await lstat(p);
      if (st.isDirectory() && Date.now() - st.mtimeMs > STALE_TEMP_MS) {
        await rm(p, { recursive: true, force: true });
      }
    }
  } catch {
    /* best effort: a failed sweep never blocks a placement */
  }
}

async function copyBundle(src: string, dest: string, mode: "save" | "native"): Promise<void> {
  const fileMode = mode === "save" ? 0o644 : 0o600;
  const dirMode = mode === "save" ? 0o755 : 0o700;
  let budget = BUNDLE_MAX_BYTES;
  for (const e of await walk(src, {})) {
    const to = join(dest, e.rel);
    if (e.kind === "dir") {
      await mkdir(to, { mode: dirMode });
      await chmod(to, dirMode);
    } else {
      const { bytes } = await readBundleFile(join(src, e.rel), budget);
      budget -= bytes.length;
      await writeFile(to, bytes, { flag: "wx", mode: fileMode });
      await chmod(to, fileMode);
    }
  }
}

/**
 * Places a skill bundle at `<destRoot>/<name>` byte-identically and atomically: the copy goes
 * into a temp directory `.<name>.tmp-<8 hex>` beside the target and is `rename`d into place.
 * After `destRoot` is validated, every operation uses its realpath, so a symlink retargeted
 * mid-way cannot redirect the write. Before creating anything a non-dry run removes
 * `.<name>.tmp-*` directories in `destRoot` older than {@link STALE_TEMP_MS} (orphans of a crash).
 *
 * A `conflict` is returned only for these reasons: "outside project" (the realpath of `destRoot`
 * is outside `within`), "symlink" (the target is a symlink), "differs" (the target exists with
 * another manifest, is not a directory, or is over the caps; `detail` says which), "race" (the
 * target, or `destRoot` itself, changed before `rename`; the temp copy is removed), and
 * "parent is a dangling symlink" / "parent is a symlink loop" / "parent is not a directory" (the
 * `realpathOfPlanned` failures ENOENT, ELOOP, ENOTDIR, or a `destRoot` that is a file). Any other
 * errno (EACCES, EPERM, EROFS, ...) is rethrown unchanged with its `code`, so callers can tell
 * "denied" from "conflict".
 *
 * @throws {BundleLayoutError} For a bad name, a relative `destRoot`, a symlink or special file in
 *   the source, a source over the caps, or a source that changed while it was copied.
 */
export async function placeBundle(input: PlaceInput): Promise<PlaceResult> {
  if (!SkillNameSchema.safeParse(input.name).success) {
    throw new BundleLayoutError(`invalid skill name: ${JSON.stringify(input.name)}`);
  }
  if (!isAbsolute(input.destRoot)) throw new BundleLayoutError("destRoot must be absolute");
  const manifest = await bundleManifest(input.srcDir);
  const path = join(input.destRoot, input.name);
  const conflict = (reason: string, detail?: string): PlaceResult => ({
    path,
    action: "conflict",
    manifest,
    reason,
    ...(detail === undefined ? {} : { detail }),
  });
  const dirMode = input.mode === "save" ? 0o755 : 0o700;
  const within = input.within === null ? null : await realOrSelf(input.within);

  /** Resolves `destRoot`; a string is a conflict reason. */
  const checkParent = async (): Promise<{ real: string } | string> => {
    let real: string;
    try {
      real = await realpathOfPlanned(input.destRoot);
    } catch (e) {
      const reason = parentReason(e);
      if (reason === null) throw e;
      return reason;
    }
    if (within !== null && !isInside(real, within)) return "outside project";
    try {
      if (!(await stat(real)).isDirectory()) return "parent is not a directory";
    } catch (e) {
      if (errCode(e) !== "ENOENT") throw e;
    }
    return { real };
  };

  const first = await checkParent();
  if (typeof first === "string") return conflict(first);
  const real = first.real;
  const target = join(real, input.name);
  if (input.dryRun !== true) await sweepStaleTemps(real, input.name);

  const st = await lstat(target).catch((e: unknown) => {
    if (isMissing(e)) return null;
    throw e;
  });
  if (st !== null) {
    if (st.isSymbolicLink()) return conflict("symlink");
    if (!st.isDirectory()) return conflict("differs", "target is not a directory");
    try {
      const current = await bundleManifest(target);
      return current.sha256 === manifest.sha256
        ? { path, action: "unchanged", manifest }
        : conflict("differs");
    } catch (e) {
      if (e instanceof BundleLayoutError) return conflict("differs", e.message);
      if (!isMissing(e)) throw e;
    }
  }

  if (input.dryRun === true) return { path, action: "create", manifest };

  await mkdir(real, { recursive: true, mode: dirMode });
  await input.testHooks?.afterMkdir?.();
  const second = await checkParent();
  if (typeof second === "string") return conflict(second);
  if (second.real !== real) return conflict("race");

  let tmp: string | null = null;
  let renamed = false;
  try {
    for (let attempt = 0; ; attempt++) {
      const candidate = join(real, `.${input.name}.tmp-${randomBytes(4).toString("hex")}`);
      try {
        await mkdir(candidate, { mode: dirMode });
        tmp = candidate;
        break;
      } catch (e) {
        if (errCode(e) !== "EEXIST" || attempt + 1 >= MAX_TEMP_ATTEMPTS) throw e;
      }
    }
    await chmod(tmp, dirMode);
    await input.testHooks?.beforeCopy?.();
    await copyBundle(input.srcDir, tmp, input.mode);
    if ((await bundleManifest(tmp)).sha256 !== manifest.sha256) {
      throw new BundleLayoutError("source changed while copying");
    }
    await input.testHooks?.beforeRename?.(path);
    const raced = await lstat(target).then(
      () => true,
      () => false,
    );
    if (raced) return conflict("race");
    try {
      await rename(tmp, target);
      renamed = true;
    } catch (e) {
      const c = errCode(e);
      if (c === "ENOTEMPTY" || c === "EEXIST" || c === "ENOTDIR" || c === "EISDIR") {
        return conflict("race");
      }
      throw e;
    }
  } finally {
    if (tmp !== null && !renamed) await rm(tmp, { recursive: true, force: true });
  }
  return { path, action: "create", manifest };
}

/**
 * Removes the bundle at `path` only when it is a plain directory (not a symlink) whose current
 * manifest sha256 equals `manifestSha256`. Returns whether it was removed; never throws for a
 * missing, different or unremovable bundle.
 *
 * Callers that remove a path read from session state (an attacker-influenced file) MUST pass
 * `within`: then `realpath(dirname(path))` must lie inside `realpath(within)` (compared by path
 * segment), the removal runs on that resolved parent, and `lstat(path)` must be a real directory
 * immediately before `rm`; otherwise nothing is removed. A parent swapped between the last check
 * and `rm` remains a residual window.
 */
export async function removePlacedBundle(
  path: string,
  manifestSha256: string,
  within?: string,
): Promise<boolean> {
  try {
    let target = path;
    if (within !== undefined) {
      const realWithin = await realpath(within);
      const realParent = await realpath(dirname(path));
      if (!isInside(realParent, realWithin)) return false;
      target = join(realParent, basename(path));
    }
    const plainDir = async (): Promise<boolean> => {
      const st = await lstat(target);
      return st.isDirectory() && !st.isSymbolicLink();
    };
    if (!(await plainDir())) return false;
    if ((await bundleManifest(target)).sha256 !== manifestSha256) return false;
    if (!(await plainDir())) return false;
    await rm(target, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the paths `<root>/<name>` that exist with a different manifest than `manifestSha256`,
 * are not a plain directory (symlink, file), are over the bundle caps, or cannot be read. Missing
 * paths and identical bundles are not conflicts.
 */
export async function findSaveConflicts(input: {
  name: string;
  manifestSha256: string;
  roots: string[];
}): Promise<string[]> {
  if (!SkillNameSchema.safeParse(input.name).success) {
    throw new BundleLayoutError(`invalid skill name: ${JSON.stringify(input.name)}`);
  }
  const out: string[] = [];
  for (const root of input.roots) {
    const p = join(root, input.name);
    try {
      await lstat(p);
    } catch (e) {
      if (isMissing(e)) continue;
      out.push(p);
      continue;
    }
    try {
      if ((await bundleManifest(p)).sha256 !== input.manifestSha256) out.push(p);
    } catch {
      out.push(p);
    }
  }
  return out;
}
