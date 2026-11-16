import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { scanExistingSkills } from "@dynamic-skills/bootstrapper";
import { BOOTSTRAP_SKILL_NAME } from "@dynamic-skills/core";
import type { ExistingSkill, SessionState } from "@dynamic-skills/core";
import { CliError } from "../io";

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
 * @param vars - Environment variables that relocate harness skill roots (never read from
 * `process.env` here).
 * @param etcDir - Directory holding the admin skill root.
 */
export async function existingSkillsFor(
  state: SessionState,
  userHome: string,
  vars: Readonly<Record<string, string | undefined>>,
  etcDir: string,
): Promise<ExistingSkill[]> {
  const scanned = await scanExistingSkills({ repo: state.repo, home: userHome, vars, etcDir });
  const basePath =
    state.sufficiency?.outcome === "partial" ? (state.sufficiency.baseSkill?.path ?? null) : null;
  return scanned.skills.filter((s) => s.name !== BOOTSTRAP_SKILL_NAME && s.path !== basePath);
}

/** File names the OS drops into a folder; ignored at the top level of `skills/` only. */
const OS_JUNK: ReadonlySet<string> = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** Most entries (files and directories) a skill bundle may contain; the agent controls the tree. */
const MAX_BUNDLE_ENTRIES = 500;

/** Most bytes a skill bundle may hold in total (5 MB), so one digest pass stays cheap. */
export const MAX_BUNDLE_BYTES = 5_000_000;

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
 * @throws {CliError} `BUNDLE_INVALID` for a symlinked root, a non-regular entry, an unreadable directory,
 * more than 500 entries or more than 5 MB.
 */
export async function bundleDigest(sessionDir: string): Promise<string> {
  const paths = sessionPaths(sessionDir);
  const lines: string[] = [];
  let totalBytes = 0;
  const bad = (rel: string): CliError =>
    new CliError("BUNDLE_INVALID", `${rel} must be a regular file or directory (no symlinks)`);
  const count = (): void => {
    if (lines.length >= MAX_BUNDLE_ENTRIES)
      throw new CliError("BUNDLE_INVALID", "too many bundle files");
  };
  const addFile = async (abs: string, rel: string, size: number): Promise<void> => {
    count();
    totalBytes += size;
    if (totalBytes > MAX_BUNDLE_BYTES) throw new CliError("BUNDLE_INVALID", "bundle is too large");
    lines.push(`${rel}\0${await hashFile(abs)}\n`);
  };
  /** lstat that treats only a missing path as absent; anything else unreadable is invalid. */
  const statOrNull = async (abs: string, rel: string): Promise<Stats | null> => {
    try {
      return await lstat(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw bad(rel);
    }
  };
  const walk = async (abs: string, rel: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      throw bad(rel);
    }
    for (const e of entries) {
      // Ruling R27: OS junk dropped beside the bundle (top level of skills/) is not part of it.
      if (rel === "skills" && e.isFile() && OS_JUNK.has(e.name)) continue;
      const childAbs = join(abs, e.name);
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        // Directories are digested too, so an empty sibling directory is a change.
        count();
        lines.push(`${childRel}/\0dir\n`);
        await walk(childAbs, childRel);
      } else if (e.isFile()) {
        await addFile(childAbs, childRel, (await lstat(childAbs)).size);
      } else throw bad(childRel);
    }
  };
  // The roots are lstat-ed first: a symlinked skills/ or evals/ would redirect every read.
  const skillsRoot = await statOrNull(paths.skillsDir, "skills");
  if (skillsRoot !== null) {
    if (!skillsRoot.isDirectory()) throw bad("skills");
    await walk(paths.skillsDir, "skills");
  }
  const evalsRoot = await statOrNull(paths.evalsDir, "evals");
  if (evalsRoot !== null && !evalsRoot.isDirectory()) throw bad("evals");
  const smoke = evalsRoot === null ? null : await statOrNull(paths.smoke, "evals/smoke.json");
  if (smoke !== null) {
    if (!smoke.isFile()) throw bad("evals/smoke.json");
    await addFile(paths.smoke, "evals/smoke.json", smoke.size);
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
