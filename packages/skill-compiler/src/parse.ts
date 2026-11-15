import type { Dirent } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  SmokeEvalSchema,
  estimateTokens,
  type GeneratedSkill,
  type SmokeEval,
} from "@dynamic-skills/core";
import { parse } from "yaml";

/** Thrown when a generated skill bundle is structurally unusable (PRD §8.2). */
export class BundleError extends Error {
  /**
   * Creates the error.
   * @param message - Human-readable reason.
   */
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;
/** SKILL.md is agent-written (untrusted); bounding it keeps every later scan cheap (PRD §6.5). */
const MAX_SKILL_CHARS = 100_000;

/**
 * Largest `smoke.json` accepted, in bytes. The file is agent-written (untrusted) and a smoke eval
 * is a handful of short strings, so a small cap bounds every later read and message (PRD §6.5).
 */
export const MAX_SMOKE_BYTES = 64_000;
// Linear by construction: the label class excludes `[`, `]` and newlines, so a failed attempt at
// one `[` never rescans text another attempt consumes.
const LINK = /\[[^[\]\n]*\]\(\s*(<[^<>\n]*>|[^()\s]+)(?:\s+"[^"]*")?\s*\)/g;

/** Removes fenced code blocks so links shown as examples are not treated as references. */
function stripFences(body: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    const run = m?.[1] ?? "";
    if (fence === null) {
      if (m) fence = run;
      else out.push(line);
    } else if (run !== "" && run[0] === fence[0] && run.length >= fence.length) {
      // CommonMark: a closing fence uses the same character and is at least as long.
      fence = null;
    }
  }
  return out.join("\n");
}

/** Normalises a link target to a relative file path, or `null` for anything non-local. */
function localTarget(rawTarget: string): string | null {
  let target = rawTarget.replace(/^<|>$/g, "");
  target = target.replace(/[#?].*$/, "");
  if (target === "" || target.startsWith("/")) return null;
  // Any `scheme:` (http, mailto, data, javascript, file, C: ...) is not a bundle-relative file.
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  return target;
}

/**
 * Parses the single skill the agent wrote under `skillsRoot`.
 *
 * @param skillsRoot - The session `skills/` directory; it must hold exactly one subdirectory.
 * @returns The parsed skill. `references` are de-duplicated bundle-relative link targets: links
 *   inside fenced code blocks, any `scheme:` target, absolute or `//` paths are excluded, `#`/`?`
 *   suffixes and `<>` are stripped; `augments` is set from `metadata.augments` and
 *   `metadata["augments-sha256"]` (missing sha becomes `""`), else `null` (PRD §5.5, §13.2).
 * @throws BundleError when the root is missing or unreadable or does not hold exactly one skill
 *   directory (`found <n>`), the skill directory or `SKILL.md` is a symlink, `SKILL.md` is missing,
 *   larger than 100,000 characters (checked by byte size before reading, then by length), or its
 *   frontmatter is not a YAML mapping with string name and description.
 */
export async function parseSkillBundle(skillsRoot: string): Promise<GeneratedSkill> {
  let entries: Dirent[];
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch {
    // Missing, not a directory or unreadable: all mean "no skill directory" to the caller.
    entries = [];
  }
  // Symlinked directories are counted so they are rejected below, not silently ignored.
  const dirs = entries.filter((d) => d.isDirectory() || d.isSymbolicLink());
  if (dirs.length !== 1) {
    throw new BundleError(`expected exactly one skill directory, found ${dirs.length}`);
  }
  const dir = join(skillsRoot, dirs[0]!.name);
  const skillMdPath = join(dir, "SKILL.md");
  let raw: string;
  try {
    // The agent controls this tree: a symlink could pull in a file from outside the session.
    const mdStat = await lstat(skillMdPath);
    if ((await lstat(dir)).isSymbolicLink() || mdStat.isSymbolicLink()) {
      throw new BundleError("skill files must not be symlinks");
    }
    // A FIFO or device would block or misbehave on read.
    if (!mdStat.isFile()) throw new BundleError("SKILL.md is not a regular file");
    // UTF-8 is at most 4 bytes per char, so this rejects before reading a huge file into memory.
    if (mdStat.size > MAX_SKILL_CHARS * 4) {
      throw new BundleError(`SKILL.md exceeds ${MAX_SKILL_CHARS} characters`);
    }
    raw = await readFile(skillMdPath, "utf8");
  } catch (err) {
    if (err instanceof BundleError) throw err;
    throw new BundleError("SKILL.md not found");
  }
  if (raw.length > MAX_SKILL_CHARS) {
    throw new BundleError(`SKILL.md exceeds ${MAX_SKILL_CHARS} characters`);
  }
  const match = FRONTMATTER.exec(raw.replace(/^\uFEFF/, ""));
  if (!match) throw new BundleError("missing frontmatter");
  let data: unknown;
  try {
    // Generated content is untrusted: keep yaml's warnings off stderr.
    data = parse(match[1] ?? "", { logLevel: "error" });
  } catch {
    throw new BundleError("invalid YAML frontmatter");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new BundleError("frontmatter is not a mapping");
  }
  const fm = data as Record<string, unknown>;
  if (typeof fm.name !== "string" || typeof fm.description !== "string") {
    throw new BundleError("frontmatter needs string name and description");
  }
  const body = (match[2] ?? "").trim();
  const references = [
    ...new Set(
      [...stripFences(body).matchAll(LINK)]
        .map((m) => localTarget(m[1] ?? ""))
        .filter((x): x is string => x !== null),
    ),
  ];
  const meta = fm.metadata;
  let augments: GeneratedSkill["augments"] = null;
  if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
    const m = meta as Record<string, unknown>;
    if (typeof m.augments === "string") {
      const sha = m["augments-sha256"];
      augments = { name: m.augments, sha256: typeof sha === "string" ? sha : "" };
    }
  }
  return {
    name: fm.name,
    description: fm.description,
    dir,
    skillMdPath,
    frontmatter: fm,
    body,
    raw,
    references,
    tokenEstimate: estimateTokens(raw),
    augments,
  };
}

/**
 * Loads the agent-written smoke eval.
 *
 * @param path - Path of `smoke.json`.
 * @returns The validated eval, or `null` when the file does not exist.
 * @throws On a symlink or non-regular file, a file over {@link MAX_SMOKE_BYTES}, unreadable or
 *   non-JSON content, or when it violates {@link SmokeEvalSchema}.
 */
export async function loadSmokeEval(path: string): Promise<SmokeEval | null> {
  let text: string;
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error("smoke.json is not a regular file");
    if (info.size > MAX_SMOKE_BYTES) throw new Error(`smoke.json exceeds ${MAX_SMOKE_BYTES} bytes`);
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return SmokeEvalSchema.parse(JSON.parse(text));
}
