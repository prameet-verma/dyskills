import { mkdirSync, mkdtempSync, rmSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it("reports why a candidate was refused instead of 'not found'", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ds-assets-"));
    mkdirSync(resolve(dir, "s"));
    writeFileSync(resolve(dir, "other.md"), "x");
    const link = resolve(dir, "s/SKILL.md");
    symlinkSync(resolve(dir, "other.md"), link);
    try {
      await expect(resolveBootstrapSkill([link])).rejects.toThrow(
        `bootstrap skill not readable: wrong-name at ${link}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says not found when every candidate is missing", async () => {
    await expect(resolveBootstrapSkill(["/nonexistent/SKILL.md"])).rejects.toThrow(
      "bootstrap skill not found",
    );
  });
});
