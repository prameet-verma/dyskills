import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { scanExistingSkills } from "@dynamic-skills/bootstrapper";
import type { ExistingSkill, SessionState } from "@dynamic-skills/core";
import { CliError } from "../io";

/** The bootstrap skill drives this CLI; it is never a candidate, a base or a duplicate. */
export const BOOTSTRAP_SKILL = "dynamic-skill-bootstrap";

/** Where the agent writes the skill bundle, the smoke eval and the brief, inside the session. */
export function sessionPaths(sessionDir: string): {
  brief: string;
  skillsDir: string;
  evalsDir: string;
  smoke: string;
} {
  const evalsDir = join(sessionDir, "evals");
  return {
    brief: join(sessionDir, "brief.md"),
    skillsDir: join(sessionDir, "skills"),
    evalsDir,
    smoke: join(evalsDir, "smoke.json"),
  };
}

/**
 * Skills already installed, as the brief and the duplication eval see them: the bootstrap skill is
 * left out, and so is the base of an augmentation (matched by its exact scanned path, Ruling R9),
 * because the augmentation is judged against the base separately (PRD §5.5).
 * @param state - The session (repository and sufficiency verdict).
 * @param userHome - Personal skill root.
 */
export async function existingSkillsFor(
  state: SessionState,
  userHome: string,
): Promise<ExistingSkill[]> {
  const scanned = await scanExistingSkills({ repo: state.repo, home: userHome });
  const basePath =
    state.sufficiency?.outcome === "partial" ? (state.sufficiency.baseSkill?.path ?? null) : null;
  return scanned.skills.filter((s) => s.name !== BOOTSTRAP_SKILL && s.path !== basePath);
}

/** Most files a skill bundle may contain; the agent controls the tree, so the walk is bounded. */
const MAX_BUNDLE_FILES = 500;

/** The error for a bundle that changed (or never was pinned) since `evaluate` (Ruling R14). */
export function bundleChanged(): CliError {
  return new CliError("BUNDLE_INVALID", "skill bundle changed since evaluate; run evaluate again");
}

/** sha256 of one file, streamed so a large file is never held in memory. */
async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * Digest of everything the evaluation judged: every file under `skills/` plus `evals/smoke.json`
 * (Ruling R14). It is sha256 over the sorted lines `relpath\0sha256(file)\n`, so adding,
 * removing, renaming or editing any file changes it. The tree is agent-written, so anything that
 * is not a plain file or directory (a symlink, FIFO or device) is refused before it is opened.
 * @param sessionDir - Absolute session directory.
 * @throws {CliError} `BUNDLE_INVALID` for a non-regular entry or more than 500 files.
 */
export async function bundleDigest(sessionDir: string): Promise<string> {
  const paths = sessionPaths(sessionDir);
  const lines: string[] = [];
  const bad = (rel: string): CliError =>
    new CliError("BUNDLE_INVALID", `${rel} must be a regular file or directory (no symlinks)`);
  const add = async (abs: string, rel: string): Promise<void> => {
    if (lines.length >= MAX_BUNDLE_FILES)
      throw new CliError("BUNDLE_INVALID", "too many bundle files");
    lines.push(`${rel}\0${await hashFile(abs)}\n`);
  };
  const walk = async (abs: string, rel: string): Promise<void> => {
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const childAbs = join(abs, e.name);
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(childAbs, childRel);
      else if (e.isFile()) await add(childAbs, childRel);
      else throw bad(childRel);
    }
  };
  await walk(paths.skillsDir, "skills");
  const smoke = await lstat(paths.smoke).catch(() => null);
  if (smoke !== null) {
    if (!smoke.isFile()) throw bad("evals/smoke.json");
    await add(paths.smoke, "evals/smoke.json");
  }
  return createHash("sha256").update(lines.sort().join("")).digest("hex");
}

/**
 * Requires the bundle to still match the digest pinned by `evaluate` (Ruling R14). Run first by
 * `eval record` and `activate`, so a skill edited after its evaluation can never be recorded or
 * activated.
 * @throws {CliError} `BUNDLE_INVALID` when no digest is pinned or the bundle differs.
 */
export async function assertBundlePinned(state: SessionState, sessionDir: string): Promise<void> {
  if (state.evaluatedBundleSha256 === undefined) throw bundleChanged();
  if ((await bundleDigest(sessionDir)) !== state.evaluatedBundleSha256) throw bundleChanged();
}
