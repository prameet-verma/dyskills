import { runDiscovery } from "@dynamic-skills/discovery";
import type { Evidence, Requirement } from "@dynamic-skills/core";
import { describe, expect, it } from "vitest";
import { analyzeGaps, deriveRequirements } from "../src/index";
import { fixture } from "./helpers";

const ev = (
  key: string,
  category: Evidence["category"],
  confidence: Evidence["confidence"],
): Evidence => ({
  key,
  value: "v",
  category,
  source: "t",
  confidence,
  timestamp: "",
  revision: "r",
  conflicts: [],
  origin: "programmatic",
});
const req = (id: string, category: Requirement["category"], humanOnly = false): Requirement => ({
  id,
  category,
  description: id,
  humanOnly,
  material: true,
});

describe("analyzeGaps", () => {
  it("flags conflicting package-manager evidence from the conflicting fixture", async () => {
    const { registry } = await runDiscovery({ repo: fixture("conflicting"), task: "x" });
    const gaps = analyzeGaps(deriveRequirements("fix typo"), registry.list());
    expect(gaps.find((g) => g.requirement === "package-manager")).toMatchObject({
      status: "conflicting",
      resolution: "inspect",
      material: true,
    });
  });

  it("humanOnly is missing/ask until user.<id> evidence exists", () => {
    const r = req("migration-policy", "user", true);
    expect(analyzeGaps([r], [])[0]).toMatchObject({ status: "missing", resolution: "ask" });
    const answered = analyzeGaps([r], [ev("user.migration-policy", "user", "verified")])[0];
    expect(answered).toMatchObject({
      status: "verified",
      resolution: "none",
      material: false,
      evidenceKeys: ["user.migration-policy"],
    });
  });

  it("classifies inferred, verified and absent evidence", () => {
    const e = [ev("testing.b", "testing", "inferred"), ev("build.a", "build", "verified")];
    const gaps = analyzeGaps(
      [
        req("testing", "testing"),
        req("build", "build"),
        req("ci", "ci"),
        req("architecture", "architecture"),
      ],
      e,
    );
    const by = (id: string) => gaps.find((g) => g.requirement === id);
    expect(by("testing")).toMatchObject({ status: "needs-investigation", resolution: "inspect" });
    expect(by("build")).toMatchObject({ status: "verified", resolution: "none", material: false });
    expect(by("ci")).toMatchObject({ status: "missing", resolution: "none" });
    expect(by("architecture")).toMatchObject({ status: "missing", resolution: "inspect" });
  });
});
