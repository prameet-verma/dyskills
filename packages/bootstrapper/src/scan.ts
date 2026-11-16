import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { MAX_BASE_FILE_BYTES, readSafeFile } from "@dynamic-skills/core";
import type { ExistingSkill, SafeReadRejection } from "@dynamic-skills/core";
import { parse } from "yaml";
import { resolveSkillRoots } from "./roots";
import type { RootOptions } from "./roots";

/** Result of {@link scanExistingSkills}. */
export interface ScanResult {
  /** Valid skills, deduplicated, project scope before personal scope. */
  skills: ExistingSkill[];
  /** Absolute paths of agent instruction files present at the repository root. */
  instructionFiles: string[];
  /** One message per skill file that was skipped, naming its path. */
  warnings: string[];
}

const INSTRUCTION_FILES = ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md"];

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

/**
 * Parses a SKILL.md into name, description and trimmed body. A leading BOM is ignored; `name` is
 * optional and defaults to `dirName`; an empty `name` or a missing or empty `description` fails.
 * @returns the parsed fields, or a reason string when the file is not a valid skill.
 */
function parseSkill(
  rawText: string,
  dirName: string,
): { name: string; description: string; body: string } | string {
  const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
  const match = FRONTMATTER.exec(text);
  if (!match) return "missing frontmatter";
  let data: unknown;
  try {
    // Repository content is untrusted: silence yaml's process warnings so it cannot write to stderr.
    data = parse(match[1] ?? "", { logLevel: "error" });
  } catch {
    return "invalid YAML frontmatter";
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return "frontmatter is not a mapping";
  }
  const { name, description } = data as Record<string, unknown>;
  if (name !== undefined && name !== null && typeof name !== "string") {
    return "frontmatter name must be a string";
  }
  if (typeof name === "string" && name.trim() === "") return "frontmatter name is empty";
  if (typeof description !== "string" || description.trim() === "") {
    return "frontmatter needs a non-empty description";
  }
  return { name: name ?? dirName, description, body: (match[2] ?? "").trim() };
}

/** Warning text per refusal of {@link readSafeFile}; `missing` is silent and never shown. */
const REJECTIONS: Record<Exclude<SafeReadRejection, "missing">, string> = {
  "not-a-file": "not a regular file",
  "wrong-name": "not a regular file",
  "too-large": `larger than ${MAX_BASE_FILE_BYTES} bytes`,
  unreadable: "unreadable",
};

/**
 * Tells whether an instruction file exists as a regular file, without opening it: `stat` never
 * blocks on a FIFO or reads a device, and the scan only needs to know the file is there (its
 * content is read later, through the sandboxed repo reader, when it is chosen as a base).
 *
 * @returns `true` for a regular file, `false` when absent, otherwise the reason it is skipped.
 */
async function instructionFileState(path: string): Promise<boolean | string> {
  try {
    return (await stat(path)).isFile() || REJECTIONS["not-a-file"];
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? false : REJECTIONS.unreadable;
  }
}

/**
 * Finds skills already installed for the project and the user (PRD §11.3, §12.2) so the pipeline
 * can reuse or avoid duplicating them. Read-only; never throws for missing directories or bad
 * files, which become warnings instead. Roots come from {@link resolveSkillRoots}; only direct
 * children `<root>/<entry>/SKILL.md` are read (nested `SKILL.md` files are not found). Every
 * `SKILL.md` is read through one non-blocking handle that accepts only a regular file of at most
 * {@link MAX_BASE_FILE_BYTES} whose resolved name is `SKILL.md`; instruction files are only
 * `stat`-ed, never opened. A missing `SKILL.md` or instruction file is silent.
 * @param opts - Repository, home, environment values and optional `etcDir` (see {@link RootOptions}).
 * @returns skills (one file reached twice, or the same name and body, is kept once), instruction
 *   files, warnings.
 */
export async function scanExistingSkills(opts: RootOptions): Promise<ScanResult> {
  const skills: ExistingSkill[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const seenFiles = new Set<string>();

  for (const root of await resolveSkillRoots(opts)) {
    let entries: string[];
    try {
      entries = (await readdir(root.dir)).sort();
    } catch {
      continue; // A missing skills directory is normal, not a warning.
    }
    for (const entry of entries) {
      const path = join(root.dir, entry, "SKILL.md");
      // The repository is untrusted: one non-blocking, regular-file-only, size-capped read, so a
      // FIFO, a device symlink, a link to another file or a huge file is skipped with a warning.
      const read = await readSafeFile(path, {
        maxBytes: MAX_BASE_FILE_BYTES,
        realBasename: "SKILL.md",
      });
      if (!read.ok) {
        if (read.reason !== "missing") warnings.push(`Skipped ${path}: ${REJECTIONS[read.reason]}`);
        continue;
      }
      const parsed = parseSkill(read.text, entry);
      if (typeof parsed === "string") {
        warnings.push(`Skipped ${path}: ${parsed}`);
        continue;
      }
      const real = await realpath(path).catch(() => path);
      if (seenFiles.has(real)) continue;
      seenFiles.add(real);
      const key = JSON.stringify([parsed.name, parsed.body]);
      if (seen.has(key)) continue;
      seen.add(key);
      skills.push({ ...parsed, path, scope: root.scope, harness: root.harness });
    }
  }

  const instructionFiles: string[] = [];
  for (const file of INSTRUCTION_FILES) {
    const path = join(opts.repo, file);
    const found = await instructionFileState(path);
    if (found === true) instructionFiles.push(path);
    else if (typeof found === "string") warnings.push(`Skipped ${path}: ${found}`);
  }
  return { skills, instructionFiles, warnings };
}
