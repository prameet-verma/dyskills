import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFileIndex } from "../src/index";
import { fixture } from "./helpers";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ds-index-"));
}

describe("buildFileIndex", () => {
  it("truncates huge repos and skips node_modules", async () => {
    const repo = tmp();
    for (let i = 0; i < 50; i++)
      writeFileSync(join(repo, `f${String(i).padStart(2, "0")}.txt`), "");
    mkdirSync(join(repo, "node_modules"));
    for (let i = 0; i < 100; i++) writeFileSync(join(repo, "node_modules", `m${i}.js`), "");
    const idx = await buildFileIndex(repo, { maxFiles: 10 });
    expect(idx.files).toHaveLength(10);
    expect(idx.truncated).toBe(true);
    expect(idx.files.some((f) => f.startsWith("node_modules"))).toBe(false);
  });

  it("is not truncated when the repo fits, and is deterministic", async () => {
    const a = await buildFileIndex(fixture("ts-monorepo"));
    const b = await buildFileIndex(fixture("ts-monorepo"));
    expect(a.truncated).toBe(false);
    expect(a).toEqual(b);
    expect(a.files).toContain("packages/orders/src/index.ts");
    expect(a.files).toContain(".github/workflows/ci.yml");
  });

  it("respects maxDepth", async () => {
    const repo = tmp();
    mkdirSync(join(repo, "a/b/c"), { recursive: true });
    writeFileSync(join(repo, "top.txt"), "");
    writeFileSync(join(repo, "a/b/c/deep.txt"), "");
    const idx = await buildFileIndex(repo, { maxDepth: 1 });
    expect(idx.files).toEqual(["top.txt"]);
  });
});
