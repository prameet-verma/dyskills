import { readFile, readdir } from "node:fs/promises";
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
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

/**
 * Parses the single skill the agent wrote under `skillsRoot`.
 *
 * @param skillsRoot - The session `skills/` directory; it must hold exactly one subdirectory.
 * @returns The parsed skill. `references` are relative markdown link targets (no `http(s):`,
 *   `mailto:` or `#anchor` links); `augments` is set from `metadata.augments` and
 *   `metadata["augments-sha256"]` (missing sha becomes `""`), else `null` (PRD §5.5, §13.2).
 * @throws BundleError when there is not exactly one skill directory, `SKILL.md` is missing, or its
 *   frontmatter is not a YAML mapping with string name and description.
 */
export async function parseSkillBundle(skillsRoot: string): Promise<GeneratedSkill> {
  const dirs = (await readdir(skillsRoot, { withFileTypes: true })).filter((d) => d.isDirectory());
  if (dirs.length !== 1) {
    throw new BundleError(`expected exactly one skill directory, found ${dirs.length}`);
  }
  const dir = join(skillsRoot, dirs[0]!.name);
  const skillMdPath = join(dir, "SKILL.md");
  let raw: string;
  try {
    raw = await readFile(skillMdPath, "utf8");
  } catch {
    throw new BundleError("SKILL.md not found");
  }
  const match = FRONTMATTER.exec(raw);
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
      [...body.matchAll(LINK)]
        .map((m) => m[1] ?? "")
        .filter((t) => t !== "" && !/^(https?:|mailto:|#)/i.test(t)),
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
 * @throws On unreadable or non-JSON content, or when it violates {@link SmokeEvalSchema}.
 */
export async function loadSmokeEval(path: string): Promise<SmokeEval | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return SmokeEvalSchema.parse(JSON.parse(text));
}
