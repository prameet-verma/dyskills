import type { ExistingSkill } from "@dynamic-skills/core";
import { describe, expect, it } from "vitest";
import { assessCoverage, scanExistingSkills } from "../src/index";
import { put, skillMd, tmp } from "./helpers";

async function skills(): Promise<ExistingSkill[]> {
  const repo = await tmp();
  const home = await tmp();
  await put(
    repo,
    ".claude/skills/graphql-schema-review/SKILL.md",
    skillMd("graphql-schema-review", "Review GraphQL schemas for breaking changes"),
  );
  await put(
    home,
    ".agents/skills/dynamic-skill-bootstrap/SKILL.md",
    skillMd("dynamic-skill-bootstrap", "Review schemas and bootstrap dynamic skills for tasks"),
  );
  return (await scanExistingSkills({ repo, home })).skills;
}

const caching = "Implement a new distributed caching strategy for the order-processing service";

describe("assessCoverage", () => {
  it("reuses a matching skill", async () => {
    const r = assessCoverage("review the graphql schemas", await skills(), {
      explicit: false,
      mode: "auto",
    });
    expect(r.recommendation).toBe("reuse");
    expect(r.candidates.map((c) => c.name)).toEqual(["graphql-schema-review"]);
    expect(r.candidates[0]?.score).toBeGreaterThanOrEqual(0.5);
  });

  it("synthesizes, suggests or declines for an uncovered task by mode", async () => {
    const s = await skills();
    expect(assessCoverage(caching, s, { explicit: false, mode: "auto" }).recommendation).toBe(
      "synthesize",
    );
    expect(assessCoverage(caching, s, { explicit: false, mode: "manual" }).recommendation).toBe(
      "none",
    );
    expect(assessCoverage(caching, s, { explicit: false, mode: "suggest" }).recommendation).toBe(
      "suggest-synthesis",
    );
  });

  it("synthesizes when explicit but still lists the candidate", async () => {
    const r = assessCoverage("Create a skill for reviewing GraphQL schemas", await skills(), {
      explicit: true,
      mode: "manual",
    });
    expect(r.recommendation).toBe("synthesize");
    expect(r.candidates.map((c) => c.name)).toEqual(["graphql-schema-review"]);
  });

  it("never offers the bootstrap skill and handles empty tasks", async () => {
    const s = await skills();
    const r = assessCoverage("bootstrap dynamic skills", s, { explicit: false, mode: "auto" });
    expect(r.candidates).toEqual([]);
    expect(assessCoverage("a an", s, { explicit: false, mode: "auto" }).candidates).toEqual([]);
  });
});
