import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { copyAtomic } from "../scripts/copy-skills";
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

  it("prefers the repository copy over a stale package build copy when run from source", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ds-assets-"));
    try {
      const put = (rel: string, text: string): void => {
        mkdirSync(resolve(dir, rel, ".."), { recursive: true });
        writeFileSync(resolve(dir, rel), text);
      };
      put("repo/packages/cli/src/.keep", "");
      put("repo/packages/cli/skills/dynamic-skill-bootstrap/SKILL.md", "stale build copy");
      put("repo/skills/dynamic-skill-bootstrap/SKILL.md", "fresh repository copy");
      const fromSource = await resolveBootstrapSkill(
        undefined,
        resolve(dir, "repo/packages/cli/src"),
      );
      expect(fromSource.bytes.toString()).toBe("fresh repository copy");
      // Published layout (module in dist/): the package copy still wins.
      put("repo/packages/cli/dist/.keep", "");
      const fromDist = await resolveBootstrapSkill(
        undefined,
        resolve(dir, "repo/packages/cli/dist"),
      );
      expect(fromDist.bytes.toString()).toBe("stale build copy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("copyAtomic", () => {
  it("copies byte-identically through a temp file and leaves no temp behind", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ds-copy-"));
    try {
      writeFileSync(resolve(dir, "a.md"), "new bytes");
      const target = resolve(dir, "out/b/SKILL.md");
      mkdirSync(resolve(dir, "out/b"), { recursive: true });
      writeFileSync(target, "old");
      copyAtomic(resolve(dir, "a.md"), target);
      expect(readFileSync(target, "utf8")).toBe("new bytes");
      expect(readdirSync(resolve(dir, "out/b"))).toEqual(["SKILL.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never truncates the target in place (the inode is replaced by rename)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "ds-copy-"));
    try {
      writeFileSync(resolve(dir, "a.md"), "new");
      const target = resolve(dir, "t.md");
      writeFileSync(target, "old");
      const before = statSync(target).ino;
      copyAtomic(resolve(dir, "a.md"), target);
      expect(statSync(target).ino).not.toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
