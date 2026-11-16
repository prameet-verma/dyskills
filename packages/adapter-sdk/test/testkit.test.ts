import { rmSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readTree } from "../src/testkit/fixtures";
import { defineAdapterCompatSuite } from "../src/testkit";
import { fakeAdapter, fakeScan, makeFakeFixtureHome } from "./fake-adapter";

const fixtureHome = makeFakeFixtureHome();
afterAll(() => rmSync(fixtureHome, { recursive: true, force: true }));

defineAdapterCompatSuite({
  name: "fake",
  adapter: fakeAdapter,
  fixtureHome,
  versionOutput: "fake-harness 1.2.3\n",
  vars: { FAKE_HOME: "{home}/.fake", FAKE_SESSION: "{session}" },
  scan: fakeScan,
  expect: {
    version: "1.2.3",
    variant: null,
    questionTool: "AskFake",
    maxPerCall: 2,
    maxOptions: 3,
    multiSelect: false,
    nativeActivation: true,
    writesSessionHome: { personal: true, project: true },
  },
});

describe("readTree", () => {
  it("records symlinks by target so a retargeted dotfile link is noticed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sdk-readtree-"));
    try {
      await writeFile(join(dir, "a"), "a");
      await symlink("a", join(dir, "link"));
      const before = await readTree(dir);
      expect(before.has("link")).toBe(true);
      await rm(join(dir, "link"));
      await symlink("elsewhere", join(dir, "link"));
      const after = await readTree(dir);
      expect(after.get("link")!.equals(before.get("link")!)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
