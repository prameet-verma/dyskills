import { copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Copies `source` to `target` byte-identically through a temp file in the target directory and a
 * `rename`, so a concurrent reader sees the old or the new file, never a truncated one.
 * @param source File to copy.
 * @param target Destination; its directory is created.
 */
export function copyAtomic(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    copyFileSync(source, tmp);
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}
