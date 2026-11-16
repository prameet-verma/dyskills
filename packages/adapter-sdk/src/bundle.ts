import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { SkillNameSchema } from "@dynamic-skills/core";
import { isInside, realpathOfPlanned } from "./paths";
import type { BundleManifest } from "./types";

/** Thrown when a bundle contains a symlink or a non-regular entry, or a name is not a skill name. */
export class BundleLayoutError extends Error {
  /** Creates the error. */
  constructor(message: string) {
    super(message);
    this.name = "BundleLayoutError";
  }
}

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

interface Entry {
  rel: string;
  kind: "file" | "dir";
}

/** Lists a bundle's entries (no symlinks or special files allowed), sorted by path. */
async function walk(dir: string): Promise<Entry[]> {
  const root = await lstat(dir);
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new BundleLayoutError(`bundle root is not a plain directory: ${dir}`);
  }
  const out: Entry[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    for (const name of await readdir(join(dir, rel))) {
      const r = rel === "" ? name : `${rel}/${name}`;
      const st = await lstat(join(dir, r));
      if (st.isSymbolicLink()) throw new BundleLayoutError(`symlink in bundle: ${r}`);
      if (st.isDirectory()) {
        out.push({ rel: r, kind: "dir" });
        stack.push(r);
      } else if (st.isFile()) {
        out.push({ rel: r, kind: "file" });
      } else {
        throw new BundleLayoutError(`non-regular entry in bundle: ${r}`);
      }
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/**
 * Hashes a bundle: sorted relative file paths with per-file sha256, and `sha256` over
 * `"<path>\0<sha>\n"` lines. Independent of creation order and file modes. Throws
 * {@link BundleLayoutError} on a symlink or a non-regular entry.
 */
export async function bundleManifest(dir: string): Promise<BundleManifest> {
  const files: { path: string; sha256: string }[] = [];
  for (const e of await walk(dir)) {
    if (e.kind === "file")
      files.push({ path: e.rel, sha256: sha(await readFile(join(dir, e.rel))) });
  }
  return { files, sha256: sha(files.map((f) => `${f.path}\0${f.sha256}\n`).join("")) };
}

/** Result of {@link placeBundle}. */
export interface PlaceResult {
  /** `<destRoot>/<name>`. */
  path: string;
  /** What happened (or would happen on a dry run). */
  action: "create" | "unchanged" | "conflict";
  /** Manifest of the source bundle. */
  manifest: BundleManifest;
  /** Why, for a conflict. */
  reason?: string;
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
  /** Report only; create nothing. */
  dryRun?: boolean;
  /**
   * Test seam run after the temp copy is complete and before `rename`.
   *
   * @internal Never wire user input into this.
   */
  testHooks?: { beforeRename?: (target: string) => void | Promise<void> };
}

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

/** Maps a `realpathOfPlanned` failure to a conflict reason. */
function parentReason(e: unknown): string {
  switch (errCode(e)) {
    case "ENOTDIR":
      return "parent is not a directory";
    case "ELOOP":
      return "parent is a symlink loop";
    case "ENOENT":
      return "parent is a dangling symlink";
    default:
      return `parent cannot be resolved (${errCode(e) ?? "error"})`;
  }
}

async function realOrSelf(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

async function copyBundle(src: string, dest: string, mode: "save" | "native"): Promise<void> {
  const fileMode = mode === "save" ? 0o644 : 0o600;
  const dirMode = mode === "save" ? 0o755 : 0o700;
  await mkdir(dest, { mode: dirMode });
  await chmod(dest, dirMode);
  for (const e of await walk(src)) {
    const to = join(dest, e.rel);
    if (e.kind === "dir") {
      await mkdir(to, { mode: dirMode });
      await chmod(to, dirMode);
    } else {
      const bytes = await readFile(join(src, e.rel));
      const fh = await open(to, "wx", fileMode);
      try {
        await fh.writeFile(bytes);
      } finally {
        await fh.close();
      }
      await chmod(to, fileMode);
    }
  }
}

/**
 * Places a skill bundle at `<destRoot>/<name>` byte-identically and atomically (copy into a temp
 * directory beside the target, then `rename`). Never throws for an environment problem: a
 * dangling or looping parent, containment escape, symlink or differing target, or a target that
 * appears mid-way is reported as `conflict` (reasons: "outside project", "symlink", "differs",
 * "race", "parent is ..."). It throws {@link BundleLayoutError} for a bad name or a source bundle
 * containing a symlink.
 */
export async function placeBundle(input: PlaceInput): Promise<PlaceResult> {
  if (!SkillNameSchema.safeParse(input.name).success) {
    throw new BundleLayoutError(`invalid skill name: ${JSON.stringify(input.name)}`);
  }
  const manifest = await bundleManifest(input.srcDir);
  const path = join(input.destRoot, input.name);
  const conflict = (reason: string): PlaceResult => ({
    path,
    action: "conflict",
    manifest,
    reason,
  });
  if (!isAbsolute(input.destRoot)) return conflict("destination is not absolute");

  const within = input.within === null ? null : await realOrSelf(input.within);
  const checkParent = async (): Promise<string | null> => {
    let real: string;
    try {
      real = await realpathOfPlanned(input.destRoot);
    } catch (e) {
      return parentReason(e);
    }
    if (within !== null && !isInside(real, within)) return "outside project";
    return null;
  };
  const bad = await checkParent();
  if (bad !== null) return conflict(bad);

  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) return conflict("symlink");
    if (!st.isDirectory()) return conflict("differs: target is not a directory");
    try {
      const current = await bundleManifest(path);
      return current.sha256 === manifest.sha256
        ? { path, action: "unchanged", manifest }
        : conflict("differs");
    } catch (e) {
      if (e instanceof BundleLayoutError) return conflict("differs");
      throw e;
    }
  } catch (e) {
    if (errCode(e) !== "ENOENT" && errCode(e) !== "ENOTDIR") {
      if (e instanceof BundleLayoutError) return conflict("differs");
      return conflict(`target cannot be inspected (${errCode(e) ?? "error"})`);
    }
  }

  if (input.dryRun === true) return { path, action: "create", manifest };

  const dirMode = input.mode === "save" ? 0o755 : 0o700;
  try {
    await mkdir(input.destRoot, { recursive: true, mode: dirMode });
  } catch (e) {
    return conflict(`cannot create ${input.destRoot} (${errCode(e) ?? "error"})`);
  }
  const bad2 = await checkParent();
  if (bad2 !== null) return conflict(bad2);

  const tmp = join(input.destRoot, `.${input.name}.tmp-${randomBytes(4).toString("hex")}`);
  try {
    await copyBundle(input.srcDir, tmp, input.mode);
    const copied = await bundleManifest(tmp);
    if (copied.sha256 !== manifest.sha256) {
      await rm(tmp, { recursive: true, force: true });
      return conflict("source changed while copying");
    }
    await input.testHooks?.beforeRename?.(path);
    const race = await lstat(path).then(
      () => true,
      () => false,
    );
    if (race) {
      await rm(tmp, { recursive: true, force: true });
      return conflict("race");
    }
    try {
      await rename(tmp, path);
    } catch (e) {
      await rm(tmp, { recursive: true, force: true });
      const c = errCode(e);
      if (c === "ENOTEMPTY" || c === "EEXIST" || c === "ENOTDIR" || c === "EISDIR") {
        return conflict("race");
      }
      throw e;
    }
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
  return { path, action: "create", manifest };
}

/**
 * Removes the bundle at `path` only when it is a plain directory whose current manifest sha256
 * equals `manifestSha256`. Returns whether it was removed; never throws for a missing or
 * different bundle.
 */
export async function removePlacedBundle(path: string, manifestSha256: string): Promise<boolean> {
  try {
    const current = await bundleManifest(path);
    if (current.sha256 !== manifestSha256) return false;
    await rm(path, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the paths `<root>/<name>` that exist with a different manifest than `manifestSha256`
 * or are not a plain directory (symlink, file, unreadable). Missing paths and identical bundles
 * are not conflicts.
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
      if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") continue;
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
