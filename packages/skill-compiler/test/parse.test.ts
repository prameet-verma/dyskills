import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fingerprintFile } from "@dynamic-skills/evidence-registry";
import { describe, expect, it } from "vitest";
import { BundleError, loadSmokeEval, parseSkillBundle } from "../src/index";
import { ROOT } from "./helpers";

const F = (p: string): string => resolve(ROOT, "fixtures/skills", p);

describe("parseSkillBundle", () => {
  it("parses the golden new skill", async () => {
    const s = await parseSkillBundle(F("valid"));
    expect(s.name).toBe("order-cache-specialist");
    expect(s.references).toHaveLength(0);
    expect(s.tokenEstimate).toBeLessThan(2000);
    expect(s.augments).toBeNull();
    expect(s.body).toContain("## Ownership");
  });

  it("parses the golden augmentation and pins the base sha", async () => {
    const s = await parseSkillBundle(F("augmentation"));
    const sha = await fingerprintFile(F("augmentation-base/order-caching/SKILL.md"));
    expect(s.augments).toEqual({ name: "order-caching", sha256: sha });
    expect(typeof s.frontmatter.metadata).toBe("object");
  });

  it("extracts relative markdown references only", async () => {
    const root = mkdtempSync(join(tmpdir(), "bundle-"));
    mkdirSync(join(root, "my-skill"));
    writeFileSync(
      join(root, "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: d\n---\n# T\nSee [a](refs/a.md) [b](https://x.io) [c](mailto:a@b.c) [d](#top).\n",
    );
    const s = await parseSkillBundle(root);
    expect(s.references).toEqual(["refs/a.md"]);
    expect(s.augments).toBeNull();
  });

  it("defaults a missing augments-sha256 to empty", async () => {
    const root = mkdtempSync(join(tmpdir(), "bundle-"));
    mkdirSync(join(root, "x-augment"));
    writeFileSync(
      join(root, "x-augment", "SKILL.md"),
      "---\nname: x-augment\ndescription: d\nmetadata:\n  augments: x\n---\nbody\n",
    );
    expect((await parseSkillBundle(root)).augments).toEqual({ name: "x", sha256: "" });
  });

  it("requires exactly one skill directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "bundle-"));
    mkdirSync(join(root, "a"));
    mkdirSync(join(root, "b"));
    const err = await parseSkillBundle(root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BundleError);
    expect((err as Error).message).toBe("expected exactly one skill directory, found 2");
  });
});

describe("loadSmokeEval", () => {
  it("parses the fixture", async () => {
    const e = await loadSmokeEval(F("smoke.json"));
    expect(e?.id).toBe("smoke-1");
  });
  it("returns null when absent", async () => {
    expect(await loadSmokeEval(F("nope.json"))).toBeNull();
  });
  it("throws on schema violation", async () => {
    const p = join(mkdtempSync(join(tmpdir(), "smoke-")), "s.json");
    writeFileSync(p, "{}");
    await expect(loadSmokeEval(p)).rejects.toThrow();
  });
});
