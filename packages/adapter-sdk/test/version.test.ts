import { describe, expect, it } from "vitest";
import { compareVersions, parseVersion } from "../src/index";

describe("version", () => {
  it("parses the first x.y.z", () => {
    expect(parseVersion("codex-cli 0.169.0")).toBe("0.169.0");
    expect(parseVersion("no version")).toBeNull();
  });
  it("compares numerically", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.2.3", "1.10.0")).toBeLessThan(0);
  });
});
