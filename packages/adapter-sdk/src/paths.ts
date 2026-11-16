import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, relative, isAbsolute, sep } from "node:path";

/** Creates `dir` and its missing parents (new directories get `mode`), then returns its realpath. */
export async function realpathEnsured(dir: string, mode = 0o700): Promise<string> {
  await mkdir(dir, { recursive: true, mode });
  return realpath(dir);
}

/**
 * Realpath of the nearest existing ancestor of `path`, joined with the missing segments. Creates
 * nothing. `path` must be absolute.
 */
export async function realpathOfPlanned(path: string): Promise<string> {
  const missing: string[] = [];
  let cur = path;
  for (;;) {
    try {
      await lstat(cur);
      const real = await realpath(cur);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      const parent = dirname(cur);
      if (parent === cur) throw e;
      missing.push(cur.slice(parent.length === 1 ? 1 : parent.length + 1));
      cur = parent;
    }
  }
}

/** True when `child` equals or lies inside `parent` (both already real paths). */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}
