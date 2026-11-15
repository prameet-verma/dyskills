import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
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
    const r = await scanExistingSkills({ repo, home });
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
    const r = await scanExistingSkills({ repo, home });
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
    const r = await scanExistingSkills({ repo, home });
    expect(r.skills.map((s) => [s.scope, s.body])).toEqual([
      ["project", "Body."],
      ["personal", "different"],
    ]);
  });

  it("lists instruction files and tolerates missing directories", async () => {
    const repo = await tmp();
    const home = await tmp();
    await put(repo, "AGENTS.md", "x");
    const r = await scanExistingSkills({ repo, home });
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
    const r = await scanExistingSkills({ repo, home });
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
      const r = await within(2000, scanExistingSkills({ repo, home }));
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
    const r = await within(2000, scanExistingSkills({ repo, home }));
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
      const r = await within(2000, scanExistingSkills({ repo, home }));
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
    const r = await scanExistingSkills({ repo, home });
    expect(r.instructionFiles).toEqual([join(repo, "CLAUDE.md")]);
    expect(r.warnings).toEqual([]);
  });

  it("stays silent for a skill directory without a SKILL.md", async () => {
    const repo = await tmp();
    const home = await tmp();
    await mkdir(join(repo, ".claude/skills/empty"), { recursive: true });
    const r = await scanExistingSkills({ repo, home });
    expect(r).toEqual({ skills: [], instructionFiles: [], warnings: [] });
  });
});
