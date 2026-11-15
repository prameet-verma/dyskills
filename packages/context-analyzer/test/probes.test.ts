import { buildFileIndex } from "@dynamic-skills/discovery";
import type { Gap } from "@dynamic-skills/core";
import { describe, expect, it } from "vitest";
import { planSemanticProbes } from "../src/index";
import { fixture } from "./helpers";

const gap = (requirement: string, resolution: Gap["resolution"] = "inspect"): Gap => ({
  requirement,
  category: requirement as Gap["category"],
  status: "missing",
  resolution,
  evidenceKeys: [],
  material: true,
});

describe("planSemanticProbes", () => {
  it("suggests the orders entrypoint for an architecture gap", async () => {
    const files = await buildFileIndex(fixture("ts-monorepo"));
    const probes = planSemanticProbes([gap("architecture"), gap("ci", "none")], files);
    expect(probes).toHaveLength(1);
    expect(probes[0]?.requirement).toBe("architecture");
    expect(probes[0]?.suggestedFiles).toContain("packages/orders/src/index.ts");
    expect(probes[0]?.suggestedFiles.length).toBeLessThanOrEqual(5);
  });

  it("suggests docs for conventions and only indexed files", () => {
    const files = {
      files: ["README.md", "CONTRIBUTING.md", "docs/adr/0001-x.md", "a.ts"],
      truncated: false,
    };
    const [p] = planSemanticProbes([gap("conventions")], files);
    expect(p?.suggestedFiles).toEqual(["CONTRIBUTING.md", "README.md", "docs/adr/0001-x.md"]);
  });

  it("suggests manifests and lockfiles for a package-manager gap", async () => {
    const files = await buildFileIndex(fixture("conflicting"));
    const [p] = planSemanticProbes([gap("package-manager")], files);
    expect(p?.suggestedFiles).toEqual(
      expect.arrayContaining(["package.json", "package-lock.json", "yarn.lock"]),
    );
  });

  it("prefers shallow paths when capping", () => {
    const files = {
      files: [
        "a/b/c/package.json",
        ...[1, 2, 3, 4, 5].map((n) => `p${n}/package.json`),
        "package.json",
      ],
      truncated: false,
    };
    const [p] = planSemanticProbes([gap("build")], files);
    expect(p?.suggestedFiles).toHaveLength(5);
    expect(p?.suggestedFiles[0]).toBe("package.json");
    expect(p?.suggestedFiles).not.toContain("a/b/c/package.json");
  });
});
