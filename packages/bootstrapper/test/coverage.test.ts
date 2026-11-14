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
  it("offers a matching skill as a hint, never as a verdict", async () => {
    const r = assessCoverage("review the graphql schemas", await skills(), {
      explicit: false,
      mode: "auto",
    });
    expect(r.recommendation).toBe("discover");
    expect(r.candidates[0]?.name).toBe("graphql-schema-review");
    expect(r.candidates[0]?.score).toBeGreaterThanOrEqual(0.5);
  });

  it("discovers for an uncovered task unless manual mode lacks an explicit request", async () => {
    const s = await skills();
    const rec = (explicit: boolean, mode: "auto" | "suggest" | "manual") =>
      assessCoverage(caching, s, { explicit, mode }).recommendation;
    expect(rec(false, "auto")).toBe("discover");
    expect(rec(false, "manual")).toBe("none");
    expect(rec(true, "manual")).toBe("discover");
    expect(rec(false, "suggest")).toBe("discover");
  });

  it("still lists the candidate when explicit", async () => {
    const r = assessCoverage("Create a skill for reviewing GraphQL schemas", await skills(), {
      explicit: true,
      mode: "manual",
    });
    expect(r.recommendation).toBe("discover");
    expect(r.candidates.map((c) => c.name)).toEqual(["graphql-schema-review"]);
  });

  it("never offers the bootstrap skill and handles empty tasks", async () => {
    const s = await skills();
    const r = assessCoverage("bootstrap dynamic skills", s, { explicit: false, mode: "auto" });
    expect(r.candidates).toEqual([]);
    expect(assessCoverage("a an", s, { explicit: false, mode: "auto" }).candidates).toEqual([]);
  });
});
