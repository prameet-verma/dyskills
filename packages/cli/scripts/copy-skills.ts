import { copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = resolve(import.meta.dirname, "../../../skills/dynamic-skill-bootstrap/SKILL.md");
const TARGET = resolve(import.meta.dirname, "../skills/dynamic-skill-bootstrap/SKILL.md");

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

// Byte-identical copy so the published tarball carries exactly the repository's bootstrap skill.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  copyAtomic(SOURCE, TARGET);
}
