import { resolve } from "node:path";
import { readSafeFile } from "@dynamic-skills/core";

/** Relative location of the bootstrap skill below a skills root. */
const BOOTSTRAP = "skills/dynamic-skill-bootstrap/SKILL.md";

/**
 * Finds and reads the bootstrap skill shipped with the CLI. The first readable of the published
 * layout (`<package>/skills/…`, next to the bundled `dist/`) and the source layout (the repository
 * `skills/…`, three levels above `src/`) wins.
 * @param candidates Paths to try in order; defaults to the published then the source layout.
 * @returns The absolute path that was read and its exact bytes.
 * @throws {Error} `bootstrap skill not found` when every candidate is missing, otherwise
 * `bootstrap skill not readable: <reason> at <path>` for the first refused candidate.
 */
export async function resolveBootstrapSkill(
  candidates: string[] = [
    resolve(import.meta.dirname, "..", BOOTSTRAP),
    resolve(import.meta.dirname, "../../..", BOOTSTRAP),
  ],
): Promise<{ path: string; bytes: Buffer }> {
  let refused: string | undefined;
  for (const path of candidates) {
    const read = await readSafeFile(path, { realBasename: "SKILL.md" });
    if (read.ok) return { path, bytes: read.bytes };
    if (read.reason !== "missing") refused ??= `${read.reason} at ${path}`;
  }
  throw new Error(
    refused === undefined
      ? "bootstrap skill not found"
      : `bootstrap skill not readable: ${refused}`,
  );
}
