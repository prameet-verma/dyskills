import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { checkRelease } from "../scripts/check-release";

const ROOT = resolve(import.meta.dirname, "..");

const PACK = [
  "dist/index.js",
  "skills/dynamic-skill-bootstrap/SKILL.md",
  "package.json",
  "README.md",
  "LICENSE",
];

/** A releasable input; each test breaks one thing. */
function valid(): Parameters<typeof checkRelease>[0] {
  return {
    tag: "v0.1.0",
    pkg: {
      name: "dynamic-skills",
      version: "0.1.0",
      license: "MIT",
      bin: { "dynamic-skills": "dist/index.js" },
      dependencies: { commander: "^15.1.0" },
    },
    packFiles: [...PACK],
  };
}

describe("checkRelease", () => {
  it("accepts a valid input", () => {
    expect(checkRelease(valid())).toEqual([]);
  });

  it("names a tag that does not match the version", () => {
    const input = { ...valid(), tag: "v0.2.0" };
    expect(checkRelease(input).join("\n")).toContain("v0.2.0");
  });

  it("rejects workspace dependencies", () => {
    const input = valid();
    input.pkg.dependencies = { "@dynamic-skills/core": "workspace:*" };
    expect(checkRelease(input).length).toBeGreaterThan(0);
  });

  it("rejects a pack list without the bootstrap skill", () => {
    const input = valid();
    input.packFiles = PACK.filter((f) => !f.startsWith("skills/"));
    expect(checkRelease(input).join("\n")).toContain("SKILL.md");
  });

  it("rejects source files in the pack list", () => {
    const input = valid();
    input.packFiles.push("src/index.ts");
    expect(checkRelease(input).join("\n")).toContain("src/index.ts");
  });

  it("rejects a missing license field", () => {
    const input = valid();
    delete input.pkg.license;
    expect(checkRelease(input).join("\n")).toContain("license");
  });

  it("rejects a private or misnamed package and a wrong bin", () => {
    const input = valid();
    input.pkg.private = true;
    input.pkg.name = "other";
    input.pkg.bin = { "dynamic-skills": "src/index.ts" };
    expect(checkRelease(input).length).toBeGreaterThanOrEqual(3);
  });
});

describe("workflows", () => {
  it("ci.yml runs on main, phase-* pushes and pull requests", () => {
    const ci = parse(readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8"));
    expect(ci.on.push.branches).toEqual(expect.arrayContaining(["main", "phase-*"]));
    expect(ci.on).toHaveProperty("pull_request");
  });

  it("release.yml publishes with provenance only on tags or dispatch", () => {
    const text = readFileSync(resolve(ROOT, ".github/workflows/release.yml"), "utf8");
    const wf = parse(text);
    expect(wf.on.push.tags).toEqual(["v*.*.*"]);
    expect(wf.on).toHaveProperty("workflow_dispatch");
    expect(wf.on.push.branches).toBeUndefined();
    expect(wf.jobs.publish.environment).toBe("npm");
    expect(wf.jobs.publish.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(text).toContain("--provenance");
  });

  it("the CLI package publishes provenance from the command line, not publishConfig", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "packages/cli/package.json"), "utf8"));
    expect(pkg.name).toBe("dynamic-skills");
    expect(pkg.publishConfig.provenance).toBeUndefined();
    expect(pkg.license).toBeUndefined();
  });
});
