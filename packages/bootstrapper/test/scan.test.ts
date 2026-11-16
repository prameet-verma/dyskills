import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_BASE_FILE_BYTES } from "@dynamic-skills/core";
import { describe, expect, it, vi } from "vitest";
import { scanExistingSkills } from "../src/index";
import { put, skillMd, tmp } from "./helpers";

describe("scanExistingSkills", () => {
  it("reads project and personal skills with scope and harness", async () => {
    const repo = await tmp();
    const home = await tmp();
    await put(repo, ".claude/skills/a/SKILL.md", skillMd("a", "Alpha skill", "Alpha body"));
    await put(home, ".config/opencode/skills/b/SKILL.md", skillMd("b", "Beta skill"));
    const r = await scanExistingSkills({ repo, home, etcDir: join(home, "etc") });
    expect(r.warnings).toEqual([]);
    expect(r.skills).toEqual([
      {
        name: "a",
        description: "Alpha skill",
        path: join(repo, ".claude/skills/a/SKILL.md"),
        scope: "project",
        harness: "claude-code",
        body: "Alpha body",
      },
      {
        name: "b",
        description: "Beta skill",
        path: join(home, ".config/opencode/skills/b/SKILL.md"),
        scope: "personal",
        harness: "opencode",
        body: "Body.",
      },
    ]);
  });

  it("warns once and skips broken frontmatter, missing fields and no frontmatter", async () => {
    const repo = await tmp();
    const home = await tmp();
    await put(repo, ".agents/skills/x/SKILL.md", "---\nname: [unclosed\n---\nbody");
    await put(repo, ".agents/skills/y/SKILL.md", "---\nname: y\n---\nbody");
    await put(repo, ".agents/skills/z/SKILL.md", "no frontmatter");
    const r = await scanExistingSkills({ repo, home, etcDir: join(home, "etc") });
    expect(r.skills).toEqual([]);
    expect(r.warnings).toHaveLength(3);
    expect(r.warnings[0]).toContain(join(repo, ".agents/skills/x/SKILL.md"));
  });

  it("dedupes identical name and body, keeping project first", async () => {
    const repo = await tmp();
    const home = await tmp();
    await put(repo, ".claude/skills/a/SKILL.md", skillMd("a", "d"));
    await put(home, ".claude/skills/a/SKILL.md", skillMd("a", "d"));
    await put(home, ".agents/skills/a/SKILL.md", skillMd("a", "d", "different"));
    const r = await scanExistingSkills({ repo, home, etcDir: join(home, "etc") });
    expect(r.skills.map((s) => [s.scope, s.body])).toEqual([
      ["project", "Body."],
      ["personal", "different"],
    ]);
  });

  it("lists instruction files and tolerates missing directories", async () => {
    const repo = await tmp();
    const home = await tmp();
    await put(repo, "AGENTS.md", "x");
    const r = await scanExistingSkills({ repo, home, etcDir: join(home, "etc") });
    expect(r.instructionFiles).toEqual([join(repo, "AGENTS.md")]);
    expect(r.warnings).toEqual([]);
  });
});

describe("scanExistingSkills yaml safety", () => {
  it("emits no process warning for an unknown tag and accepts the skill", async () => {
    const repo = await tmp();
    const home = await tmp();
    await put(repo, ".claude/skills/w/SKILL.md", "---\nname: !weird w\ndescription: d\n---\nbody");
    const spy = vi.spyOn(process, "emitWarning");
    const r = await scanExistingSkills({ repo, home, etcDir: join(home, "etc") });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    // Accepted: the unknown tag is ignored and the value stays a plain string.
    expect(r.skills.map((s) => s.name)).toEqual(["w"]);
    expect(r.warnings).toEqual([]);
  });
});

/** Opens any FIFO for writing and closes it, releasing a reader stuck in a blocking open. */
function release(fifo: string): void {
  try {
    closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
  } catch {
    // No reader was waiting.
  }
}

/** Fails if `p` takes longer than `ms`, so a hang is reported instead of stalling the run. */
async function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`took longer than ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe("scanExistingSkills hostile repository (never hangs or bloats)", () => {
  it("skips a FIFO SKILL.md with a warning and returns promptly", async () => {
    const repo = await tmp();
    const home = await tmp();
    await mkdir(join(repo, ".claude/skills/x"), { recursive: true });
    const fifo = join(repo, ".claude/skills/x/SKILL.md");
    execFileSync("mkfifo", [fifo]);
    try {
      const r = await within(2000, scanExistingSkills({ repo, home, etcDir: join(home, "etc") }));
      expect(r.skills).toEqual([]);
      expect(r.warnings).toEqual([`Skipped ${fifo}: not a regular file`]);
    } finally {
      release(fifo);
    }
  });

  it("skips a SKILL.md symlinked to /dev/zero and an oversized SKILL.md", async () => {
    const repo = await tmp();
    const home = await tmp();
    await mkdir(join(repo, ".claude/skills/z"), { recursive: true });
    await symlink("/dev/zero", join(repo, ".claude/skills/z/SKILL.md"));
    await put(
      repo,
      ".agents/skills/big/SKILL.md",
      skillMd("big", "Big skill", "x".repeat(MAX_BASE_FILE_BYTES)),
    );
    const r = await within(2000, scanExistingSkills({ repo, home, etcDir: join(home, "etc") }));
    expect(r.skills).toEqual([]);
    expect(r.warnings).toEqual([
      `Skipped ${join(repo, ".claude/skills/z/SKILL.md")}: not a regular file`,
      `Skipped ${join(repo, ".agents/skills/big/SKILL.md")}: larger than ${MAX_BASE_FILE_BYTES} bytes`,
    ]);
  });

  it("never opens instruction files: a FIFO or /dev/zero AGENTS.md is not listed", async () => {
    const repo = await tmp();
    const home = await tmp();
    const fifo = join(repo, "AGENTS.md");
    execFileSync("mkfifo", [fifo]);
    await symlink("/dev/zero", join(repo, "CLAUDE.md"));
    try {
      const r = await within(2000, scanExistingSkills({ repo, home, etcDir: join(home, "etc") }));
      expect(r.instructionFiles).toEqual([]);
      expect(r.warnings).toEqual([
        `Skipped ${fifo}: not a regular file`,
        `Skipped ${join(repo, "CLAUDE.md")}: not a regular file`,
      ]);
    } finally {
      release(fifo);
    }
  });

  it("still lists a regular instruction file without reading it (even a large one)", async () => {
    const repo = await tmp();
    const home = await tmp();
    await put(repo, "CLAUDE.md", "y".repeat(MAX_BASE_FILE_BYTES + 1));
    const r = await scanExistingSkills({ repo, home, etcDir: join(home, "etc") });
    expect(r.instructionFiles).toEqual([join(repo, "CLAUDE.md")]);
    expect(r.warnings).toEqual([]);
  });

  it("stays silent for a skill directory without a SKILL.md", async () => {
    const repo = await tmp();
    const home = await tmp();
    await mkdir(join(repo, ".claude/skills/empty"), { recursive: true });
    const r = await scanExistingSkills({ repo, home, etcDir: join(home, "etc") });
    expect(r).toEqual({ skills: [], instructionFiles: [], warnings: [] });
  });
});

describe("scanExistingSkills registry additions", () => {
  const etcDir = async () => join(await tmp(), "etc");

  it("lists a skill without name under its directory name", async () => {
    const repo = await tmp();
    const home = await tmp();
    await put(repo, ".agents/skills/foo/SKILL.md", "---\ndescription: Foo skill\n---\nBody");
    const r = await scanExistingSkills({ repo, home, etcDir: await etcDir() });
    expect(r.warnings).toEqual([]);
    expect(r.skills.map((s) => [s.name, s.harness])).toEqual([["foo", "codex"]]);
  });

  it("strips a leading BOM", async () => {
    const repo = await tmp();
    const home = await tmp();
    await put(repo, ".claude/skills/b/SKILL.md", "\uFEFF" + skillMd("b", "Bom skill"));
    const r = await scanExistingSkills({ repo, home, etcDir: await etcDir() });
    expect(r.skills.map((s) => s.name)).toEqual(["b"]);
  });

  it("skips an empty description or an explicitly empty name with a warning naming the path", async () => {
    const repo = await tmp();
    const home = await tmp();
    await put(repo, ".claude/skills/a/SKILL.md", '---\nname: a\ndescription: ""\n---\nx');
    await put(repo, ".claude/skills/c/SKILL.md", '---\nname: ""\ndescription: d\n---\nx');
    const r = await scanExistingSkills({ repo, home, etcDir: await etcDir() });
    expect(r.skills).toEqual([]);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toContain(join(repo, ".claude/skills/a/SKILL.md"));
    expect(r.warnings[1]).toContain(join(repo, ".claude/skills/c/SKILL.md"));
  });

  it("finds a skill at an ancestor level up to the project root", async () => {
    const t = await tmp();
    const mono = join(t, "mono");
    const repo = join(mono, "packages/api");
    await mkdir(join(mono, ".git"), { recursive: true });
    await mkdir(repo, { recursive: true });
    await put(mono, ".agents/skills/up/SKILL.md", skillMd("up", "Up skill"));
    await put(t, ".agents/skills/above/SKILL.md", skillMd("above", "Above the root"));
    const r = await scanExistingSkills({ repo, home: join(t, "h"), etcDir: await etcDir() });
    expect(r.skills.map((s) => [s.name, s.scope])).toEqual([["up", "project"]]);
  });

  it("lists each skill once when one root is a symlink to another", async () => {
    const repo = await tmp();
    const home = await tmp();
    await put(home, ".claude/skills/s/SKILL.md", skillMd("s", "Shared"));
    await mkdir(join(home, ".agents"), { recursive: true });
    await symlink(join(home, ".claude/skills"), join(home, ".agents/skills"));
    const r = await scanExistingSkills({ repo, home, etcDir: await etcDir() });
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0]?.harness).toBe("claude-code");
  });

  it("skips a SKILL.md symlinked to .env", async () => {
    const repo = await tmp();
    const home = await tmp();
    await put(repo, "secrets/.env", skillMd("env", "Leak"));
    await mkdir(join(repo, ".claude/skills/e"), { recursive: true });
    await symlink(join(repo, "secrets/.env"), join(repo, ".claude/skills/e/SKILL.md"));
    const r = await scanExistingSkills({ repo, home, etcDir: await etcDir() });
    expect(r.skills).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });

  it("lists two different files with the same name and body once", async () => {
    const repo = await tmp();
    const home = await tmp();
    await put(repo, ".claude/skills/a/SKILL.md", skillMd("a", "d"));
    await put(repo, ".agents/skills/a/SKILL.md", skillMd("a", "d"));
    const r = await scanExistingSkills({ repo, home, etcDir: await etcDir() });
    expect(r.skills).toHaveLength(1);
  });

  it("reads the admin root as personal and honours env roots", async () => {
    const repo = await tmp();
    const home = await tmp();
    const etc = await tmp();
    const cx = await tmp();
    await put(etc, "codex/skills/adm/SKILL.md", skillMd("adm", "Admin"));
    await put(cx, "skills/cx/SKILL.md", skillMd("cx", "Codex home"));
    const r = await scanExistingSkills({
      repo,
      home,
      etcDir: etc,
      vars: { CODEX_HOME: cx },
    });
    expect(r.skills.map((s) => [s.name, s.scope, s.harness])).toEqual([
      ["cx", "personal", "codex"],
      ["adm", "personal", "codex"],
    ]);
  });

  it("lists AGENTS.override.md", async () => {
    const repo = await tmp();
    const home = await tmp();
    await writeFile(join(repo, "AGENTS.override.md"), "x");
    await writeFile(join(repo, "AGENTS.md"), "x");
    const r = await scanExistingSkills({ repo, home, etcDir: await etcDir() });
    expect(r.instructionFiles).toEqual([join(repo, "AGENTS.md"), join(repo, "AGENTS.override.md")]);
  });

  it("reads and warns once about a bad file reached through a symlinked root", async () => {
    const repo = await tmp();
    const home = await tmp();
    await put(home, ".claude/skills/bad/SKILL.md", "no frontmatter");
    await mkdir(join(home, ".agents"), { recursive: true });
    await symlink(join(home, ".claude/skills"), join(home, ".agents/skills"));
    const r = await scanExistingSkills({ repo, home, etcDir: await etcDir() });
    expect(r.warnings).toEqual([
      `Skipped ${join(home, ".claude/skills/bad/SKILL.md")}: missing frontmatter`,
    ]);
  });
});
