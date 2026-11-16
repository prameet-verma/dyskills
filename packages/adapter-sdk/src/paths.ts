import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, isAbsolute, sep } from "node:path";

/** Creates `dir` and its missing parents (new directories get `mode`), then returns its realpath. */
export async function realpathEnsured(dir: string, mode = 0o700): Promise<string> {
  await mkdir(dir, { recursive: true, mode });
  return realpath(dir);
}

/**
 * Realpath of the nearest existing ancestor of `path`, joined with the missing segments. Creates
 * nothing. `path` must be absolute.
 *
 * Throws (callers must map these to a conflict or an error):
 * - `ENOENT`: an entry exists but cannot be resolved, i.e. a dangling symlink in the chain (also
 *   thrown when no ancestor exists at all);
 * - `ELOOP`: a symlink loop in the chain (from `realpath`);
 * - `ENOTDIR`: an existing ancestor of a missing segment is not a directory;
 * - any other `lstat`/`realpath`/`stat` error (e.g. `EACCES`) propagates unchanged.
 */
export async function realpathOfPlanned(path: string): Promise<string> {
  const missing: string[] = [];
  let cur = path;
  for (;;) {
    let exists = true;
    try {
      await lstat(cur);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      exists = false;
    }
    if (exists) {
      // An entry exists: a failure here is a dangling symlink or loop, never "missing".
      const real = await realpath(cur);
      if (missing.length === 0) return real;
      if (!(await stat(real)).isDirectory()) {
        throw Object.assign(new Error(`not a directory: ${real}`), { code: "ENOTDIR" });
      }
      return join(real, ...missing.reverse());
    }
    const parent = dirname(cur);
    if (parent === cur) throw Object.assign(new Error(`no ancestor: ${path}`), { code: "ENOENT" });
    missing.push(cur.slice(parent.length === 1 ? 1 : parent.length + 1));
    cur = parent;
  }
}

/** True when `child` equals or lies inside `parent` (both already real paths). */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}
