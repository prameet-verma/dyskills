/* eslint-disable @typescript-eslint/no-explicit-any */
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
      repository: { type: "git", url: "git+https://example.invalid/x.git" },
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

  it("requires LICENSE in the tarball when a license is set", () => {
    const input = valid();
    input.packFiles = PACK.filter((f) => f !== "LICENSE");
    expect(checkRelease(input).join("\n")).toContain("LICENSE");
  });

  it("rejects a repository object without a url", () => {
    for (const repository of [{ type: "git" }, { url: "" }, {}]) {
      const input = valid();
      input.pkg.repository = repository;
      expect(checkRelease(input).join("\n")).toContain("repository");
    }
  });

  it("rejects a missing repository field", () => {
    const input = valid();
    delete input.pkg.repository;
    expect(checkRelease(input).join("\n")).toContain("repository");
  });

  it("skips the tag check when no tag is given", () => {
    const input = { ...valid(), tag: undefined };
    expect(checkRelease(input)).toEqual([]);
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

  const release = () => {
    const text = readFileSync(resolve(ROOT, ".github/workflows/release.yml"), "utf8");
    return { text, wf: parse(text) };
  };

  it("release.yml never runs on a branch push and publishes only from tags", () => {
    const { text, wf } = release();
    expect(wf.on.push.tags).toEqual(["v*.*.*"]);
    expect(wf.on.push.branches).toBeUndefined();
    expect(wf.on).toHaveProperty("workflow_dispatch");
    expect(wf.on.workflow_dispatch?.inputs?.["dry-run"]).toBeUndefined();
    expect(wf.permissions).toEqual({});
    expect(wf.concurrency.group).toBe("release-${{ github.ref }}");
    expect(text).not.toContain("cache: pnpm");
    for (const job of Object.values<any>(wf.jobs)) {
      for (const step of job.steps) {
        if (String(step.uses ?? "").startsWith("actions/checkout")) {
          expect(step.with["persist-credentials"]).toBe(false);
        }
      }
    }
  });

  it("the dispatch job always dry-runs, with no token, environment or write permission", () => {
    const { wf } = release();
    const job = wf.jobs["dry-run"];
    expect(job.if).toBe("github.event_name == 'workflow_dispatch'");
    expect(job.environment).toBeUndefined();
    expect(job.permissions).toEqual({ contents: "read" });
    const text = JSON.stringify(job);
    expect(text).not.toContain("NPM_TOKEN");
    expect(text).not.toContain("NODE_AUTH_TOKEN");
    const publishes = job.steps.filter((s: any) => String(s.run ?? "").includes("publish"));
    expect(publishes).toHaveLength(1);
    expect(publishes[0].run).toContain("--dry-run");
    const runs: string[] = job.steps.map((s: any) => String(s.run ?? ""));
    const check = runs.findIndex((r) => r.includes("check-release"));
    expect(check).toBeGreaterThanOrEqual(0);
    // The rehearsal must show the publish output even when the release check fails.
    expect(runs.findIndex((r) => r.includes("publish"))).toBeLessThan(check);
  });

  it("the publish job runs only on tags, checks the release first and uses provenance", () => {
    const { wf } = release();
    const job = wf.jobs.publish;
    expect(job.if).toBe("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
    expect(job.environment).toBe("npm");
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
    const runs: string[] = job.steps.map((s: any) => String(s.run ?? ""));
    const check = runs.findIndex((r) => r.includes("check-release") && r.includes("--tag"));
    const pub = runs.findIndex((r) => r.includes("publish"));
    expect(check).toBeGreaterThanOrEqual(0);
    expect(pub).toBeGreaterThan(check);
    expect(runs[pub]).toContain("--provenance");
    expect(runs[pub]).not.toContain("--dry-run");
  });

  it("the publish job fails unless the tag commit is an ancestor of origin/main", () => {
    const { wf } = release();
    const job = wf.jobs.publish;
    const runs: string[] = job.steps.map((s: any) => String(s.run ?? ""));
    const guard = runs.findIndex((r) => r.includes("merge-base --is-ancestor"));
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(runs[guard]).toContain("git fetch origin main");
    expect(runs[guard]).toContain("origin/main");
    expect(runs[guard]).toContain("exit 1");
    // Before anything is installed, built or published.
    expect(guard).toBeLessThan(runs.findIndex((r) => r.includes("pnpm install")));
    const checkout = job.steps.find((s: any) =>
      String(s.uses ?? "").startsWith("actions/checkout"),
    );
    expect(checkout.with["fetch-depth"]).toBe(0);
    // The dry-run dispatch path has no such guard.
    expect(JSON.stringify(wf.jobs["dry-run"])).not.toContain("merge-base");
  });

  it("the CLI package has no provenance in publishConfig", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "packages/cli/package.json"), "utf8"));
    expect(pkg.name).toBe("dynamic-skills");
    expect(pkg.publishConfig.provenance).toBeUndefined();
  });
});
