import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_BASE_FILE_BYTES } from "@dynamic-skills/core";
import type { ExistingSkill } from "@dynamic-skills/core";
import { readRegularFile } from "@dynamic-skills/discovery";
import type { FileReadRejection } from "@dynamic-skills/discovery";
import { parse } from "yaml";

/** Result of {@link scanExistingSkills}. */
export interface ScanResult {
  /** Valid skills, deduplicated, project scope before personal scope. */
  skills: ExistingSkill[];
  /** Absolute paths of agent instruction files present at the repository root. */
  instructionFiles: string[];
  /** One message per skill file that was skipped, naming its path. */
  warnings: string[];
}

interface SkillRoot {
  scope: ExistingSkill["scope"];
  harness: ExistingSkill["harness"];
  base: "repo" | "home";
  dir: string;
}

// PRD §11.3: the one place in the core packages that names harness storage locations. The order
// is the dedupe priority: project before personal, then the order listed in the PRD table.
const ROOTS: SkillRoot[] = [
  { scope: "project", harness: "claude-code", base: "repo", dir: ".claude/skills" },
  { scope: "project", harness: "codex", base: "repo", dir: ".agents/skills" },
  { scope: "project", harness: "opencode", base: "repo", dir: ".opencode/skills" },
  { scope: "personal", harness: "claude-code", base: "home", dir: ".claude/skills" },
  { scope: "personal", harness: "codex", base: "home", dir: ".agents/skills" },
  { scope: "personal", harness: "opencode", base: "home", dir: ".config/opencode/skills" },
];

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

/**
 * Parses a SKILL.md into name, description and trimmed body.
 * @returns the parsed fields, or a reason string when the file is not a valid skill.
 */
function parseSkill(text: string): { name: string; description: string; body: string } | string {
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
  if (typeof name !== "string" || typeof description !== "string") {
    return "frontmatter needs string name and description";
  }
  return { name, description, body: (match[2] ?? "").trim() };
}

/** Warning text per refusal of {@link readRegularFile}; `missing` is silent and never shown. */
const REJECTIONS: Record<Exclude<FileReadRejection, "missing">, string> = {
  "not-a-file": "not a regular file",
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
 * files, which become warnings instead. Every `SKILL.md` is read through one non-blocking handle
 * that accepts only a regular file of at most {@link MAX_BASE_FILE_BYTES}; instruction files are
 * only `stat`-ed, never opened. A missing `SKILL.md` or instruction file is silent.
 * @param opts.repo repository root; project skills and instruction files are read from here.
 * @param opts.home user home directory; defaults to `os.homedir()`.
 * @returns skills (same name and body found twice keeps the first), instruction files, warnings.
 */
export async function scanExistingSkills(opts: {
  repo: string;
  home?: string;
}): Promise<ScanResult> {
  const home = opts.home ?? homedir();
  const skills: ExistingSkill[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const root of ROOTS) {
    const base = join(root.base === "repo" ? opts.repo : home, root.dir);
    let entries: string[];
    try {
      entries = (await readdir(base)).sort();
    } catch {
      continue; // A missing skills directory is normal, not a warning.
    }
    for (const entry of entries) {
      const path = join(base, entry, "SKILL.md");
      // The repository is untrusted: one non-blocking, regular-file-only, size-capped read, so a
      // FIFO, a device symlink or a huge file is skipped instead of hanging or exhausting memory.
      const read = await readRegularFile(path, MAX_BASE_FILE_BYTES);
      if (!read.ok) {
        if (read.reason !== "missing") warnings.push(`Skipped ${path}: ${REJECTIONS[read.reason]}`);
        continue;
      }
      const parsed = parseSkill(read.text);
      if (typeof parsed === "string") {
        warnings.push(`Skipped ${path}: ${parsed}`);
        continue;
      }
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
