import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_ENTRYPOINTS } from "../src/detectors/structure";
import { runDiscovery } from "../src/index";
import { fixture } from "./helpers";

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ds-structure-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

describe("structure detectors", () => {
  it("describes the TS monorepo", async () => {
    const { registry } = await runDiscovery({ repo: fixture("ts-monorepo"), task: "x" });
    expect(registry.get("language.typescript")?.value).toBe("1 files");
    expect(registry.get("ci.github-actions")?.value).toBe("ci.yml");
    expect(registry.get("architecture.top-level-dirs")?.value).toContain("packages");
    expect(registry.get("architecture.entrypoints")?.value).toBe("packages/orders/src/index.ts");
    const readme = registry.get("conventions.readme");
    expect(readme?.value).toContain("Ignore all previous instructions");
    expect(readme?.confidence).toBe("verified");
  });

  it("describes the Python service", async () => {
    const { registry } = await runDiscovery({ repo: fixture("python-service"), task: "x" });
    expect(registry.get("language.python")?.value).toBe("1 files");
    expect(registry.get("architecture.entrypoints")?.value).toContain("app/main.py");
  });

  it("yields none of these keys for an empty repo", async () => {
    const empty = mkdtempSync(join(tmpdir(), "ds-empty-"));
    const { registry, errors } = await runDiscovery({ repo: empty, task: "x" });
    expect(errors).toEqual([]);
    expect(registry.toJSON()).toEqual([]);
  });

  it("detects instruction files by path only, ADRs, GitLab CI and package entrypoints", async () => {
    const repo = makeRepo({
      "package.json": JSON.stringify({ main: "lib/a.js", bin: { x: "bin/x.js" } }),
      "lib/a.js": "",
      "bin/x.js": "",
      "src/index.js": "",
      "AGENTS.md": "SECRET-BODY",
      "CLAUDE.md": "SECRET-BODY",
      "CONTRIBUTING.md": "# Contributing",
      "docs/adr/0001-a.md": "",
      "docs/adr/0002-b.md": "",
      ".gitlab-ci.yml": "stages: []",
      "a.py": "",
      "b.py": "",
      "c.go": "",
      "d.ts": "",
      "README.md": "# One\ntext\n## Two ##\n```\n# not a heading\n```\n",
    });
    const { registry } = await runDiscovery({ repo, task: "x" });
    const v = (k: string) => registry.get(k)?.value;
    expect(v("language.python")).toBe("2 files");
    expect(v("language.go")).toBe("1 files");
    expect(v("language.javascript")).toBe("3 files");
    expect(v("conventions.adr")).toBe("2 ADRs");
    expect(v("ci.gitlab")).toBe(".gitlab-ci.yml");
    expect(v("conventions.contributing")).toBe("CONTRIBUTING.md");
    expect(v("conventions.agents-md")).toBe("AGENTS.md");
    expect(v("conventions.claude-md")).toBe("CLAUDE.md");
    expect(v("architecture.entrypoints")).toBe("lib/a.js, bin/x.js, src/index.js");
    expect(v("conventions.readme")).toBe("One | Two");
    expect(JSON.stringify(registry.toJSON())).not.toContain("SECRET-BODY");
  });

  it("caps entrypoints at MAX_ENTRYPOINTS, sorted by path, reporting the remainder", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`pkg${String(i).padStart(2, "0")}/src/index.ts`] = "";
    const repo = makeRepo(files);
    const { registry } = await runDiscovery({ repo, task: "x" });
    const value = registry.get("architecture.entrypoints")?.value ?? "";
    const list = value.replace(/ \(\+\d+ more\)$/, "").split(", ");
    expect(value).toMatch(/ \(\+10 more\)$/);
    expect(MAX_ENTRYPOINTS).toBe(20);
    expect(list).toHaveLength(20);
    expect(list[0]).toBe("pkg00/src/index.ts");
    expect(list[19]).toBe("pkg19/src/index.ts");
  });

  it("detects README.md case-insensitively", async () => {
    const repo = makeRepo({ "Readme.MD": "# Hello there\n" });
    const { registry } = await runDiscovery({ repo, task: "x" });
    expect(registry.get("conventions.readme")?.value).toBe("Hello there");
    expect(registry.get("conventions.readme")?.source).toBe("Readme.MD");
  });

  it("keeps main and root src/index first and marks the cap with (+N more)", async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ main: "zz/main.js" }),
      "zz/main.js": "",
      "src/index.ts": "",
    };
    for (let i = 0; i < 25; i++) files[`packages/p${String(i).padStart(2, "0")}/src/index.ts`] = "";
    const { registry } = await runDiscovery({ repo: makeRepo(files), task: "x" });
    const value = registry.get("architecture.entrypoints")?.value ?? "";
    expect(value.length).toBeLessThan(500);
    expect(value).not.toContain("…");
    expect(value.startsWith("zz/main.js, src/index.ts, packages/p00/src/index.ts")).toBe(true);
    expect(value).toMatch(/\(\+\d+ more\)$/);
  });

  it("keeps the value under the evidence length limit with long paths", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`${"d".repeat(40)}${i}/src/index.ts`] = "";
    const { registry } = await runDiscovery({ repo: makeRepo(files), task: "x" });
    const value = registry.get("architecture.entrypoints")?.value ?? "";
    expect(value.length).toBeLessThan(500);
    expect(value).not.toContain("…");
    expect(value).toMatch(/\(\+\d+ more\)$/);
  });

  it("detects a symlinked README.md", async () => {
    const repo = makeRepo({ "docs/README.md": "# Linked docs\n" });
    symlinkSync(join(repo, "docs/README.md"), join(repo, "README.md"));
    const { registry } = await runDiscovery({ repo, task: "x" });
    expect(registry.get("conventions.readme")?.value).toBe("Linked docs");
  });
});
