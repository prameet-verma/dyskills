import { describe, expect, it } from "vitest";
import { wildcardMatch } from "../src/wildcard";

describe("wildcardMatch", () => {
  it("matches a literal exactly and rejects anything else", () => {
    expect(wildcardMatch("bash", "bash")).toBe(true);
    expect(wildcardMatch("bash", "shell")).toBe(false);
  });

  it("matches * as any sequence, including empty", () => {
    expect(wildcardMatch("dynamic-skills save x", "dynamic-skills save *")).toBe(true);
    expect(wildcardMatch("dynamic-skills save ", "dynamic-skills save *")).toBe(true);
    expect(wildcardMatch("dynamic-skills init x", "dynamic-skills save *")).toBe(false);
  });

  it("matches ? as exactly one character", () => {
    expect(wildcardMatch("a", "?")).toBe(true);
    expect(wildcardMatch("ab", "?")).toBe(false);
    expect(wildcardMatch("", "?")).toBe(false);
  });

  it('treats a trailing " *" as also matching the bare prefix', () => {
    expect(wildcardMatch("dynamic-skills", "dynamic-skills *")).toBe(true);
    expect(wildcardMatch("dynamic-skills save", "dynamic-skills save *")).toBe(true);
    expect(wildcardMatch("dynamic-skills-extra", "dynamic-skills *")).toBe(false);
  });

  it("a bare * matches everything, including the empty string", () => {
    expect(wildcardMatch("", "*")).toBe(true);
    expect(wildcardMatch("anything at all", "*")).toBe(true);
  });

  it("is anchored: no partial match", () => {
    expect(wildcardMatch("xdynamic-skills save y", "dynamic-skills save *")).toBe(false);
  });

  it("stays linear-time on a long input with many wildcards (no catastrophic backtracking)", () => {
    const input = "a".repeat(5000) + "!";
    const pattern = "*".repeat(50) + "!";
    const start = Date.now();
    expect(wildcardMatch(input, pattern)).toBe(true);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
