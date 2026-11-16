import { resolve } from "node:path";
import { readSafeFile } from "@dynamic-skills/core";

/** Relative location of the bootstrap skill below a skills root. */
const BOOTSTRAP = "skills/dynamic-skill-bootstrap/SKILL.md";

/**
 * Finds and reads the bootstrap skill shipped with the CLI. The first readable of the published
 * layout (`<package>/skills/…`, next to the bundled `dist/`) and the source layout (the repository
 * `skills/…`, three levels above `src/`) wins.
 * @returns The absolute path that was read and its exact bytes.
 * @throws {Error} `bootstrap skill not found` when neither location is readable.
 */
export async function resolveBootstrapSkill(): Promise<{ path: string; bytes: Buffer }> {
  const dir = import.meta.dirname;
  const candidates = [resolve(dir, "..", BOOTSTRAP), resolve(dir, "../../..", BOOTSTRAP)];
  for (const path of candidates) {
    const read = await readSafeFile(path, { realBasename: "SKILL.md" });
    if (read.ok) return { path, bytes: read.bytes };
  }
  throw new Error("bootstrap skill not found");
}
