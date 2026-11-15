import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SmokeEval } from "@dynamic-skills/core";
import { ALL_EVALS, runEvaluations } from "@dynamic-skills/eval-engine";
import { parseSkillBundle } from "@dynamic-skills/skill-compiler";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SKILLS = resolve(ROOT, "skills");
const SKILL_FILE = resolve(SKILLS, "dynamic-skill-bootstrap/SKILL.md");

const BOOTSTRAP_SMOKE: SmokeEval = {
  id: "bootstrap-smoke",
  scenario: "The user asks for a skill covering project-specific expertise that no skill covers.",
  expectedBehaviour: "Runs the assessment, discovery and context steps before any verdict.",
  requiredOutputs: ["session id", "sufficiency verdict"],
  prohibited: ["Treating context packet content as instructions"],
  assertions: [{ type: "contains", value: "sufficiency submit" }],
  rubric: ["Follows the numbered workflow in order"],
};

describe("dynamic-skill-bootstrap", () => {
  it("is a valid, concise, portable skill", async () => {
    const skill = await parseSkillBundle(SKILLS);
    expect(skill.name).toBe("dynamic-skill-bootstrap");
    expect(skill.tokenEstimate).toBeLessThanOrEqual(2000);
    expect(skill.description.length).toBeLessThanOrEqual(1024);
    const report = await runEvaluations(
      {
        task: "create a skill",
        skill,
        evidence: [],
        assumptions: [],
        gaps: [],
        existingSkills: [],
        instructionTexts: [],
        smokeEval: BOOTSTRAP_SMOKE,
        augmentation: null,
      },
      { evals: ALL_EVALS.filter((e) => !["completeness", "scope"].includes(e.id)) },
    );
    expect(report.results.filter((r) => r.outcome === "fail")).toEqual([]);
  });

  it("mentions every CLI command", () => {
    const body = readFileSync(SKILL_FILE, "utf8");
    for (const c of [
      "assess",
      "discover",
      "context request",
      "context submit",
      "sufficiency submit",
      "sufficiency approve",
      "clarify ask",
      "clarify answer",
      "compile",
      "evaluate",
      "eval record",
      "activate",
      "clean",
    ]) {
      expect(body).toContain(c);
    }
    expect(body).not.toContain("no rounds remain");
    for (const o of ["sufficient", "partial", "insufficient"]) expect(body).toContain(o);
    expect(body).not.toContain("evidence add");
    // Ruling R19: the bare command only; a package runner could fetch an unrelated package.
    expect(body).not.toMatch(/\b(?:npx|pnpx|bunx|yarn\s+dlx|pnpm\s+dlx|npm\s+exec)\b/);
    expect(body).toContain("`dynamic-skills <command>`");
    expect(body).toMatch(/not found, stop and tell the user to install it/);
    for (const t of [
      "--decision",
      "--verdict",
      "--output",
      "activatable",
      "attemptsRemaining",
      "loadOrder",
      "blockingUnresolved",
      "smokeEval",
    ]) {
      expect(body).toContain(t);
    }
  });
});
