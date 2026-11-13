import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL_DETECTORS,
  KNOWN_DATABASES,
  KNOWN_FRAMEWORKS,
  KNOWN_TEST_TOOLS,
  MANIFEST_DETECTORS,
  runDiscovery,
} from "../src/index";

function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "ds-manifest-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(repo, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return repo;
}

describe("manifest detectors", () => {
  it("exposes the known lists and detector sets", () => {
    expect(KNOWN_FRAMEWORKS).toContain("fastapi");
    expect(KNOWN_DATABASES).toContain("alembic");
    expect(KNOWN_TEST_TOOLS).toContain("pytest");
    expect(ALL_DETECTORS.length).toBeGreaterThanOrEqual(MANIFEST_DETECTORS.length);
  });

  it("verifies framework versions from package-lock.json", async () => {
    const repo = repoWith({
      "package.json": JSON.stringify({ dependencies: { react: "^18.0.0" } }),
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/react": { version: "18.3.1" } },
      }),
    });
    const { registry } = await runDiscovery({ repo, task: "x" });
    expect(registry.get("framework.react")).toMatchObject({
      value: "18.3.1",
      confidence: "verified",
    });
  });

  it("detects test config files, Makefile targets and turborepo", async () => {
    const repo = repoWith({
      "package.json": JSON.stringify({ workspaces: ["apps/*"], devDependencies: { jest: "^29" } }),
      "jest.config.ts": "export default {};",
      "turbo.json": "{}",
      Makefile: "build:\n\techo hi\n.PHONY: build\ntest: build\n\techo t\nX := 1\n",
    });
    const { registry } = await runDiscovery({ repo, task: "x" });
    expect(registry.get("testing.jest")?.confidence).toBe("verified");
    expect(registry.get("monorepo.turborepo")).toBeDefined();
    expect(registry.get("monorepo.workspaces")?.value).toContain("apps/*");
    expect(registry.get("build.make.build")).toBeDefined();
    expect(registry.get("build.make.test")).toBeDefined();
    expect(registry.get("build.make.PHONY")).toBeUndefined();
  });

  it("tolerates malformed manifests", async () => {
    const repo = repoWith({ "package.json": "{nope", "pyproject.toml": "= broken" });
    const r = await runDiscovery({ repo, task: "database" });
    expect(r.errors).toEqual([]);
  });
});
