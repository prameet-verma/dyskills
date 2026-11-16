import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findProjectRoot, resolveSkillRoots } from "../src/index";
import { tmp } from "./helpers";

async function monorepo(): Promise<{ t: string; mono: string; repo: string }> {
  const t = await tmp();
  const mono = join(t, "mono");
  const repo = join(mono, "packages/api");
  await mkdir(join(mono, ".git"), { recursive: true });
  await mkdir(repo, { recursive: true });
  return { t, mono, repo };
}

describe("findProjectRoot", () => {
  it("finds the nearest ancestor with a .git directory or file", async () => {
    const { mono, repo } = await monorepo();
    expect(await findProjectRoot(repo)).toBe(mono);
    const t = await tmp();
    await mkdir(join(t, "a/b"), { recursive: true });
    await import("node:fs/promises").then((fs) => fs.writeFile(join(t, "a/.git"), "gitdir: x"));
    expect(await findProjectRoot(join(t, "a/b"))).toBe(join(t, "a"));
  });

  it("falls back to the start directory without any .git", async () => {
    const t = await tmp();
    await mkdir(join(t, "x/y"), { recursive: true });
    // tmpdir ancestors may hold a .git on odd machines; accept only start or an ancestor.
    const r = await findProjectRoot(join(t, "x/y"));
    expect(r === join(t, "x/y") || join(t, "x/y").startsWith(r)).toBe(true);
  });
});

describe("resolveSkillRoots", () => {
  it("walks project levels up to the project root and stops there", async () => {
    const { t, mono, repo } = await monorepo();
    const roots = await resolveSkillRoots({ repo, home: join(t, "home"), etcDir: join(t, "etc") });
    const dirs = roots.filter((r) => r.scope === "project").map((r) => r.dir);
    const levels = [repo, join(mono, "packages"), mono];
    for (const l of levels) {
      for (const d of [".claude/skills", ".agents/skills", ".opencode/skills", ".opencode/skill"]) {
        expect(dirs).toContain(join(l, d));
      }
    }
    expect(dirs.filter((d) => d.endsWith(".codex/skills"))).toEqual([join(mono, ".codex/skills")]);
    expect(dirs.every((d) => d.startsWith(mono))).toBe(true);
    expect(dirs[0]).toBe(join(repo, ".claude/skills"));
  });

  it("uses only the repo level without a .git", async () => {
    const t = await tmp();
    const repo = join(t, "solo");
    await mkdir(repo);
    const roots = await resolveSkillRoots({ repo, home: join(t, "h"), etcDir: join(t, "etc") });
    const project = roots.filter((r) => r.scope === "project");
    // Without .git anywhere above, only the repo level (plus .codex at that same root).
    expect(project.map((r) => r.dir)).toContain(join(repo, ".codex/skills"));
    expect(project.every((r) => r.dir.startsWith(repo))).toBe(true);
  });

  it("sets readBy for compatibility paths and honours the Claude-skills opt-out", async () => {
    const { t, mono, repo } = await monorepo();
    const base = { repo, home: join(t, "home"), etcDir: join(t, "etc") };
    const find = (rs: Awaited<ReturnType<typeof resolveSkillRoots>>, d: string) =>
      rs.find((r) => r.dir === d);
    const rs = await resolveSkillRoots(base);
    expect(find(rs, join(mono, ".claude/skills"))?.readBy).toEqual(["claude-code", "opencode"]);
    expect(find(rs, join(mono, ".agents/skills"))?.readBy).toEqual(["codex", "opencode"]);
    expect(find(rs, join(mono, ".codex/skills"))?.readBy).toEqual(["codex"]);
    const off = await resolveSkillRoots({
      ...base,
      vars: { OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" },
    });
    expect(find(off, join(mono, ".claude/skills"))?.readBy).toEqual(["claude-code"]);
    expect(find(off, join(base.home, ".claude/skills"))?.readBy).toEqual(["claude-code"]);
    const empty = await resolveSkillRoots({
      ...base,
      vars: { OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "" },
    });
    expect(find(empty, join(mono, ".claude/skills"))?.readBy).toEqual(["claude-code", "opencode"]);
  });

  it("reads the OpenCode disable flags as its boolean config does (R33)", async () => {
    const { t, mono, repo } = await monorepo();
    const base = { repo, home: join(t, "home"), etcDir: join(t, "etc") };
    const readers = async (vars: Record<string, string>) =>
      (await resolveSkillRoots({ ...base, vars })).find(
        (r) => r.dir === join(mono, ".claude/skills"),
      )?.readBy;
    for (const v of ["true", "yes", "on", "1", "y"]) {
      expect(await readers({ OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: v }), v).toEqual(["claude-code"]);
      expect(await readers({ OPENCODE_DISABLE_CLAUDE_CODE: v }), v).toEqual(["claude-code"]);
    }
    for (const v of ["0", "false", "no", "TRUE", "enabled", " 1"]) {
      expect(await readers({ OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: v }), v).toEqual([
        "claude-code",
        "opencode",
      ]);
    }
  });

  it("resolves personal roots with defaults", async () => {
    const { t, repo } = await monorepo();
    const home = join(t, "home");
    const etcDir = join(t, "etc");
    const personal = (await resolveSkillRoots({ repo, home, etcDir })).filter(
      (r) => r.scope === "personal",
    );
    expect(personal.map((r) => [r.dir, r.harness, r.readBy])).toEqual([
      [join(home, ".claude/skills"), "claude-code", ["claude-code", "opencode"]],
      [join(home, ".agents/skills"), "codex", ["codex", "opencode"]],
      [join(home, ".codex/skills"), "codex", ["codex"]],
      [join(etcDir, "codex/skills"), "codex", ["codex"]],
      [join(home, ".config/opencode/skills"), "opencode", ["opencode"]],
      [join(home, ".config/opencode/skill"), "opencode", ["opencode"]],
    ]);
  });

  it("applies absolute environment overrides and ignores relative ones", async () => {
    const { t, repo } = await monorepo();
    const home = join(t, "home");
    const etcDir = join(t, "etc");
    const dirsOf = async (vars: Record<string, string>) =>
      (await resolveSkillRoots({ repo, home, etcDir, vars }))
        .filter((r) => r.scope === "personal")
        .map((r) => r.dir);

    const cc = await resolveSkillRoots({
      repo,
      home,
      etcDir,
      vars: { CLAUDE_CONFIG_DIR: join(t, "cc") },
    });
    expect(cc.find((r) => r.dir === join(t, "cc/skills"))?.readBy).toEqual(["claude-code"]);
    expect(cc.find((r) => r.dir === join(home, ".claude/skills"))?.readBy).toEqual(["opencode"]);

    expect(await dirsOf({ CODEX_HOME: join(t, "cx") })).toContain(join(t, "cx/skills"));
    expect(await dirsOf({ XDG_CONFIG_HOME: join(t, "xdg") })).toContain(
      join(t, "xdg/opencode/skills"),
    );
    const oc = await dirsOf({
      XDG_CONFIG_HOME: join(t, "xdg"),
      OPENCODE_CONFIG_DIR: join(t, "oc"),
    });
    expect(oc).toContain(join(t, "oc/skills"));
    expect(oc).toContain(join(t, "oc/skill"));
    // OpenCode 1.x adds OPENCODE_CONFIG_DIR to the XDG config dir (2.x replaces it): list both (R37).
    expect(oc).toContain(join(t, "xdg/opencode/skills"));
    expect(oc).toContain(join(t, "xdg/opencode/skill"));

    const rel = await dirsOf({
      CODEX_HOME: "relative/x",
      CLAUDE_CONFIG_DIR: "rel/c",
      XDG_CONFIG_HOME: "rel/xdg",
      OPENCODE_CONFIG_DIR: "rel/oc",
    });
    expect(rel).toEqual(await dirsOf({}));
  });

  it("maps the admin root to personal scope under the injected etcDir", async () => {
    const { t, repo } = await monorepo();
    const etcDir = join(t, "etc");
    const roots = await resolveSkillRoots({ repo, home: join(t, "home"), etcDir });
    const admin = roots.find((r) => r.dir === join(etcDir, "codex/skills"));
    expect(admin).toMatchObject({ scope: "personal", harness: "codex" });
  });

  it("merges roots with the same dir and keeps the first entry's owner", async () => {
    const { t, repo } = await monorepo();
    const home = join(t, "home");
    const roots = await resolveSkillRoots({
      repo,
      home,
      etcDir: join(t, "etc"),
      vars: { CODEX_HOME: join(home, ".agents") },
    });
    const same = roots.filter((r) => r.dir === join(home, ".agents/skills"));
    expect(same).toHaveLength(1);
    expect(same[0]).toMatchObject({ harness: "codex", readBy: ["codex", "opencode"] });
  });

  it("walks up from a repo reached through a symlink alias", async () => {
    const { t, mono } = await monorepo();
    const alias = join(t, "alias");
    await symlink(mono, alias);
    const roots = await resolveSkillRoots({
      repo: join(alias, "packages/api"),
      home: join(t, "h"),
      etcDir: join(t, "e"),
    });
    const project = roots.filter((r) => r.scope === "project").map((r) => r.dir);
    expect(project).toContain(join(alias, "packages/api/.claude/skills"));
    expect(project).toContain(join(alias, ".codex/skills"));
    expect(project.every((d) => d.startsWith(alias))).toBe(true);
  });

  it("drops a root nobody reads (CLAUDE_CONFIG_DIR differs and the opt-out is set)", async () => {
    const { t, repo } = await monorepo();
    const home = join(t, "home");
    const roots = await resolveSkillRoots({
      repo,
      home,
      etcDir: join(t, "etc"),
      vars: { CLAUDE_CONFIG_DIR: join(t, "cc"), OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" },
    });
    expect(roots.some((r) => r.dir === join(home, ".claude/skills"))).toBe(false);
    expect(roots.find((r) => r.dir === join(t, "cc/skills"))?.readBy).toEqual(["claude-code"]);
  });
});
