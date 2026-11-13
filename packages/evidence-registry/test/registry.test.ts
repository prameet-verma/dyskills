import { describe, expect, it } from "vitest";
import { EvidenceRegistry } from "../src/index.js";

const base = { category: "package-manager", revision: "x" } as const;

describe("EvidenceRegistry", () => {
  it("marks differing values for one key as conflicting", () => {
    const r = new EvidenceRegistry();
    r.add({
      ...base,
      key: "package-manager",
      value: "yarn",
      source: "yarn.lock",
      confidence: "verified",
    });
    const e = r.add({
      ...base,
      key: "package-manager",
      value: "npm",
      source: "package-lock.json",
      confidence: "verified",
    });
    expect(e.confidence).toBe("conflicting");
    expect(e.value).toBe("yarn");
    expect(e.conflicts).toEqual(["yarn (yarn.lock)", "npm (package-lock.json)"]);
  });

  it("keeps conflicting and appends new distinct observations once", () => {
    const r = new EvidenceRegistry();
    for (const [v, s] of [
      ["a", "s1"],
      ["b", "s2"],
      ["c", "s3"],
      ["c", "s3"],
      ["a", "s1"],
    ] as const) {
      r.add({ ...base, key: "k", value: v, source: s, confidence: "verified" });
    }
    const e = r.get("k")!;
    expect(e.confidence).toBe("conflicting");
    expect(e.conflicts).toEqual(["a (s1)", "b (s2)", "c (s3)"]);
  });

  it("merges identical observations keeping strongest confidence and first source", () => {
    const r = new EvidenceRegistry();
    r.add({ ...base, key: "k", value: "pnpm", source: "first", confidence: "assumed" });
    r.add({ ...base, key: "k", value: "pnpm", source: "second", confidence: "verified" });
    r.add({ ...base, key: "k", value: "pnpm", source: "third", confidence: "inferred" });
    expect(r.list()).toHaveLength(1);
    const e = r.get("k")!;
    expect(e.confidence).toBe("verified");
    expect(e.source).toBe("first");
    expect(e.conflicts).toEqual([]);
  });

  it("filters by category and confidence, and round-trips JSON", () => {
    const r = new EvidenceRegistry();
    r.add({ ...base, key: "a", value: "1", source: "s", confidence: "verified", timestamp: "t" });
    r.add({
      key: "b",
      value: "2",
      category: "language",
      source: "s",
      confidence: "assumed",
      revision: "x",
    });
    expect(r.list({ category: "language" }).map((e) => e.key)).toEqual(["b"]);
    expect(r.list({ confidence: "verified" }).map((e) => e.key)).toEqual(["a"]);
    expect(r.isVerified("a")).toBe(true);
    expect(r.isVerified("b")).toBe(false);
    expect(r.isVerified("missing")).toBe(false);
    expect(r.get("a")?.timestamp).toBe("t");
    expect(Date.parse(r.get("b")!.timestamp)).not.toBeNaN();
    const copy = EvidenceRegistry.fromJSON(JSON.parse(JSON.stringify(r.toJSON())));
    expect(copy.toJSON()).toEqual(r.toJSON());
  });

  it("sanitises values on add", () => {
    const r = new EvidenceRegistry();
    const e = r.add({
      ...base,
      key: "k",
      value: "<b>\n x </b>",
      source: "s",
      confidence: "verified",
    });
    expect(e.value).toBe("‹b› x ‹/b›");
  });
});
