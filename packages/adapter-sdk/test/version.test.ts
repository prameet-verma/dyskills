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

describe("prereleases", () => {
  it("keeps the prerelease tag", () => {
    expect(parseVersion("opencode 2.3.0-beta.1")).toBe("2.3.0-beta.1");
    expect(parseVersion("v2.3.0 (build)")).toBe("2.3.0");
  });
  it("never equals the plain release", () => {
    expect(compareVersions("2.3.0-beta.1", "2.3.0")).not.toBe(0);
    expect(compareVersions("2.3.0-beta.1", "2.3.0")).toBeLessThan(0);
    expect(compareVersions("2.3.0-beta.1", "2.3.0-beta.1")).toBe(0);
  });
});

describe("prerelease precedence", () => {
  it("orders numeric identifiers numerically", () => {
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta", "1.0.0-beta.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
  });
});
