import { join } from "node:path";
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
