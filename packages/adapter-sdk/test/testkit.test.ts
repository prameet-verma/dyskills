import { rmSync } from "node:fs";
import { afterAll } from "vitest";
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
