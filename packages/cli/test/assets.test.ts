import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBootstrapSkill } from "../src/assets";

const ROOT = resolve(import.meta.dirname, "../../..");

describe("resolveBootstrapSkill", () => {
  it("returns the repository bootstrap skill bytes from the source layout", async () => {
    const skill = await resolveBootstrapSkill();
    expect(
      skill.bytes.equals(readFileSync(resolve(ROOT, "skills/dynamic-skill-bootstrap/SKILL.md"))),
    ).toBe(true);
    expect(skill.path.endsWith("SKILL.md")).toBe(true);
  });
});
