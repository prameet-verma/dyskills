import { basename, resolve } from "node:path";
import { readSafeFile } from "@dynamic-skills/core";

/** Relative location of the bootstrap skill below a skills root. */
const BOOTSTRAP = "skills/dynamic-skill-bootstrap/SKILL.md";

/**
 * Finds and reads the bootstrap skill shipped with the CLI. The first readable of the published
 * layout (`<package>/skills/…`, next to the bundled `dist/`) and the source layout (the repository
 * `skills/…`, three levels above `src/`) wins,
 * except when this module runs from source (`src/`), where the repository copy goes first: the
 * gitignored `packages/cli/skills/…` build copy can be stale there.
 * @param candidates Paths to try in order; defaults to the layout-dependent order above.
 * @param moduleDir Directory of the running module; defaults to this module's directory.
 * @returns The absolute path that was read and its exact bytes.
 * @throws {Error} `bootstrap skill not found` when every candidate is missing, otherwise
 * `bootstrap skill not readable: <reason> at <path>` for the first refused candidate.
 */
export async function resolveBootstrapSkill(
  candidates?: string[],
  moduleDir: string = import.meta.dirname,
): Promise<{ path: string; bytes: Buffer }> {
  const published = resolve(moduleDir, "..", BOOTSTRAP);
  const repository = resolve(moduleDir, "../../..", BOOTSTRAP);
  // Only from source is the repository copy a candidate: from `dist/` the directory three levels
  // up is wherever the package was installed (often a user project), and its `skills/` is
  // repository-controlled.
  const order =
    candidates ?? (basename(moduleDir) === "src" ? [repository, published] : [published]);
  let refused: string | undefined;
  for (const path of order) {
    const read = await readSafeFile(path, { realBasename: "SKILL.md" });
    if (read.ok) return { path, bytes: read.bytes };
    if (read.reason !== "missing") {
      refused = `${read.reason} at ${path}`;
      break;
    }
  }
  throw new Error(
    refused === undefined
      ? "bootstrap skill not found"
      : `bootstrap skill not readable: ${refused}`,
  );
}
