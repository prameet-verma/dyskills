import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Harness } from "@dynamic-skills/core";

// PRD §11.3: the one core table of harness storage locations. Every directory a harness reads
// skills from is named here and nowhere else in the bootstrapper.

/** Most directory levels {@link findProjectRoot} climbs before giving up. */
const MAX_LEVELS = 32;

/** Inputs of {@link resolveSkillRoots} and the skill scan. */
export interface RootOptions {
  /** Repository directory the task runs in (may be below the project root). */
  repo: string;
  /** User home directory. */
  home: string;
  /** Environment values (never read from `process.env`); only absolute values are used. */
  vars?: Readonly<Record<string, string | undefined>>;
  /** Directory that holds the admin skill root `codex/skills`; defaults to `/etc`. */
  etcDir?: string;
}

/** One skill directory and who reads it. */
export interface ResolvedSkillRoot {
  /** Absolute directory holding `<name>/SKILL.md` children. */
  dir: string;
  /** `project` for repository roots; every other root (including the admin one) is `personal`. */
  scope: "project" | "personal";
  /** Primary owner; becomes `ExistingSkill.harness`. */
  harness: Harness;
  /** Every harness that reads this directory. */
  readBy: Harness[];
}

/**
 * Finds the project root: the nearest ancestor of `start` (inclusive, at most 32 levels) that
 * contains a `.git` entry, directory or file (a worktree or submodule has a `.git` file).
 *
 * @param start - Directory to begin from.
 * @returns The ancestor, or `resolve(start)` when none has a `.git` entry.
 */
export async function findProjectRoot(start: string): Promise<string> {
  const origin = resolve(start);
  let dir = origin;
  for (let i = 0; i < MAX_LEVELS; i++) {
    try {
      await stat(join(dir, ".git"));
      return dir;
    } catch {
      // No .git here; keep climbing.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return origin;
}

/**
 * Lists every skill directory the three harnesses read for this repository and user, in dedupe
 * priority order: project levels from `repo` up to the project root, then personal roots.
 * Roots with the same resolved `dir` are merged (`readBy` union; the first entry's `harness` and
 * `scope` are kept). Non-absolute environment values are ignored. When
 * `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` is non-empty, `opencode` is dropped from the readers of
 * every `.claude/skills` root, and a root nobody reads any more is omitted.
 *
 * @param opts - Repository, home, environment and optional `/etc` replacement.
 * @returns The ordered, merged roots. Directories need not exist.
 */
export async function resolveSkillRoots(opts: RootOptions): Promise<ResolvedSkillRoot[]> {
  const vars = opts.vars ?? {};
  const env = (key: string): string | undefined => {
    const v = vars[key];
    return v !== undefined && v !== "" && isAbsolute(v) ? v : undefined;
  };
  const home = resolve(opts.home);
  const etcDir = opts.etcDir ?? "/etc";
  const list: ResolvedSkillRoot[] = [];
  const claudeDirs = new Set<string>();
  const add = (
    dir: string,
    scope: ResolvedSkillRoot["scope"],
    harness: Harness,
    readBy: Harness[],
    claude = false,
  ): void => {
    list.push({ dir, scope, harness, readBy });
    if (claude) claudeDirs.add(dir);
  };

  const repo = resolve(opts.repo);
  const top = await findProjectRoot(repo);
  let level = repo;
  for (let i = 0; i < MAX_LEVELS; i++) {
    add(join(level, ".claude/skills"), "project", "claude-code", ["claude-code", "opencode"], true);
    add(join(level, ".agents/skills"), "project", "codex", ["codex", "opencode"]);
    add(join(level, ".opencode/skills"), "project", "opencode", ["opencode"]);
    add(join(level, ".opencode/skill"), "project", "opencode", ["opencode"]);
    if (level === top) {
      add(join(level, ".codex/skills"), "project", "codex", ["codex"]);
      break;
    }
    const parent = dirname(level);
    if (parent === level) break;
    level = parent;
  }

  const homeClaude = join(home, ".claude/skills");
  const claudeConfig = env("CLAUDE_CONFIG_DIR");
  const claudeDir = claudeConfig ? join(resolve(claudeConfig), "skills") : homeClaude;
  if (claudeDir === homeClaude) {
    add(homeClaude, "personal", "claude-code", ["claude-code", "opencode"], true);
  } else {
    add(claudeDir, "personal", "claude-code", ["claude-code"]);
    add(homeClaude, "personal", "opencode", ["opencode"], true);
  }
  add(join(home, ".agents/skills"), "personal", "codex", ["codex", "opencode"]);
  add(join(resolve(env("CODEX_HOME") ?? join(home, ".codex")), "skills"), "personal", "codex", [
    "codex",
  ]);
  add(join(resolve(etcDir), "codex/skills"), "personal", "codex", ["codex"]);
  const ocBase =
    env("OPENCODE_CONFIG_DIR") ?? join(env("XDG_CONFIG_HOME") ?? join(home, ".config"), "opencode");
  add(join(resolve(ocBase), "skills"), "personal", "opencode", ["opencode"]);
  add(join(resolve(ocBase), "skill"), "personal", "opencode", ["opencode"]);

  const dropOpencode = (vars.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS ?? "") !== "";
  const merged = new Map<string, ResolvedSkillRoot>();
  for (const root of list) {
    const readBy = root.readBy.filter(
      (h) => !(dropOpencode && claudeDirs.has(root.dir) && h === "opencode"),
    );
    const have = merged.get(root.dir);
    if (have) {
      for (const h of readBy) if (!have.readBy.includes(h)) have.readBy.push(h);
    } else {
      merged.set(root.dir, { ...root, readBy });
    }
  }
  return [...merged.values()].filter((r) => r.readBy.length > 0);
}
