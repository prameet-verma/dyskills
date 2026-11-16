import { dirname, join, relative } from "node:path";
import type { SkillSufficiencyAssessment, SkillsScan } from "@dynamic-skills/core";
import { describe, expect, it } from "vitest";
import {
  matchBaseSkill,
  requiresApproval,
  scanExistingSkills,
  validateSufficiency,
} from "../src/index";
import { put, skillMd, tmp } from "./helpers";

async function fixture(): Promise<{ skills: SkillsScan["skills"]; instructionFiles: string[] }> {
  const repo = await tmp();
  const home = await tmp();
  await put(repo, ".claude/skills/graphql/SKILL.md", skillMd("graphql", "GraphQL review"));
  await put(repo, ".claude/skills/evil/SKILL.md", skillMd("../evil", "Bad name"));
  await put(
    repo,
    ".claude/skills/dynamic-skill-bootstrap/SKILL.md",
    skillMd("dynamic-skill-bootstrap", "Bootstrap"),
  );
  await put(repo, "AGENTS.md", "# Agents\n");
  const scan = await scanExistingSkills({ repo, home, etcDir: join(home, "etc") });
  return {
    skills: scan.skills,
    instructionFiles: scan.instructionFiles.map((p) => relative(repo, p)),
  };
}

const base = { schemaVersion: "1", rationale: "r", missingAspects: [], coveredAspects: [] };

function partial(name: string, path: string): SkillSufficiencyAssessment {
  return {
    ...base,
    outcome: "partial",
    baseSkill: { name, path },
    missingAspects: ["x"],
  } as SkillSufficiencyAssessment;
}

describe("validateSufficiency", () => {
  const ctx = (f: Awaited<ReturnType<typeof fixture>>, explicit = false) => ({
    ...f,
    mode: "auto" as const,
    explicit,
  });

  it("rejects an unknown base name or a known name with a different path", async () => {
    const f = await fixture();
    const g = f.skills.find((s) => s.name === "graphql");
    expect(validateSufficiency(partial("nope", "/x"), ctx(f)).map((i) => i.path)).toEqual([
      "baseSkill",
    ]);
    expect(validateSufficiency(partial("graphql", "/other"), ctx(f)).map((i) => i.path)).toEqual([
      "baseSkill",
    ]);
    expect(validateSufficiency(partial("graphql", g?.path ?? ""), ctx(f))).toEqual([]);
  });

  it("matches the base skill by exact scanned path only", async () => {
    const f = await fixture();
    const g = f.skills.find((s) => s.name === "graphql");
    const path = g?.path ?? "";
    const raw = `${dirname(dirname(path))}/x/../graphql/SKILL.md`;
    expect(validateSufficiency(partial("graphql", raw), ctx(f)).map((i) => i.path)).toEqual([
      "baseSkill",
    ]);
    expect(
      validateSufficiency(partial("graphql", "graphql/SKILL.md"), ctx(f)).map((i) => i.path),
    ).toEqual(["baseSkill"]);
    expect(matchBaseSkill({ name: "graphql", path }, f.skills)).toBe(g);
    expect(matchBaseSkill({ name: "graphql", path: raw }, f.skills)).toBeNull();
  });

  it("rejects the bootstrap skill as a base", async () => {
    const f = await fixture();
    const b = f.skills.find((s) => s.name === "dynamic-skill-bootstrap");
    expect(validateSufficiency(partial(b?.name ?? "", b?.path ?? ""), ctx(f))).toEqual([
      { path: "baseSkill.name", message: "the bootstrap skill cannot be a base" },
    ]);
  });

  it("rejects an invalid scanned skill name", async () => {
    const f = await fixture();
    const e = f.skills.find((s) => s.name === "../evil");
    expect(validateSufficiency(partial("../evil", e?.path ?? ""), ctx(f))).toEqual([
      { path: "baseSkill.name", message: "base skill name is not a valid Agent Skills name" },
    ]);
  });

  it("limits an explicit request to partial or insufficient", async () => {
    const f = await fixture();
    const g = f.skills.find((s) => s.name === "graphql");
    const sufficient = {
      ...base,
      outcome: "sufficient",
      baseSkill: { name: "graphql", path: g?.path },
    } as SkillSufficiencyAssessment;
    expect(validateSufficiency(sufficient, ctx(f, true)).map((i) => i.path)).toEqual(["outcome"]);
    expect(validateSufficiency(partial("graphql", g?.path ?? ""), ctx(f, true))).toEqual([]);
  });

  it("checks the base instruction file against the scanned ones", async () => {
    const f = await fixture();
    const a = {
      ...base,
      outcome: "sufficient",
      baseInstructionFile: "AGENTS.md",
    } as SkillSufficiencyAssessment;
    expect(validateSufficiency(a, ctx(f))).toEqual([]);
    expect(validateSufficiency(a, { ...ctx(f), instructionFiles: [] })).toEqual([
      { path: "baseInstructionFile", message: "not a scanned instruction file" },
    ]);
  });

  it("rejects instruction files outside the scanned set", async () => {
    const f = await fixture();
    for (const file of ["../AGENTS.md", "/tmp/AGENTS.md"]) {
      const a = {
        ...base,
        outcome: "sufficient",
        baseInstructionFile: file,
      } as SkillSufficiencyAssessment;
      expect(validateSufficiency(a, ctx(f)).map((i) => i.path)).toEqual(["baseInstructionFile"]);
    }
  });

  it("collects every issue without short-circuiting", async () => {
    const f = await fixture();
    const a = {
      ...base,
      outcome: "sufficient",
      baseSkill: { name: "nope", path: "/x" },
    } as SkillSufficiencyAssessment;
    expect(validateSufficiency(a, ctx(f, true)).map((i) => i.path)).toEqual([
      "baseSkill",
      "outcome",
    ]);
  });

  it("requires an explicit request in manual mode", async () => {
    const f = await fixture();
    const a = { ...base, outcome: "insufficient" } as SkillSufficiencyAssessment;
    expect(validateSufficiency(a, { ...ctx(f), mode: "manual" })).toEqual([
      { path: "outcome", message: "manual mode requires an explicit request" },
    ]);
  });

  it("accepts a valid insufficient verdict", async () => {
    const f = await fixture();
    const a = { ...base, outcome: "insufficient" } as SkillSufficiencyAssessment;
    expect(validateSufficiency(a, ctx(f))).toEqual([]);
  });
});

describe("requiresApproval", () => {
  it("needs approval only for non-sufficient outcomes in suggest mode without explicit request", () => {
    expect(requiresApproval("partial", "suggest", false)).toBe(true);
    expect(requiresApproval("sufficient", "suggest", false)).toBe(false);
    expect(requiresApproval("insufficient", "auto", false)).toBe(false);
    expect(requiresApproval("partial", "suggest", true)).toBe(false);
  });
});
