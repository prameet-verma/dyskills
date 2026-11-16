import { join } from "node:path";
import { scanExistingSkills } from "@dynamic-skills/bootstrapper";
import { defineAdapterCompatSuite, REPO_ROOT } from "@dynamic-skills/adapter-sdk/testkit";
import { claudeCodeAdapter } from "../src/index";

defineAdapterCompatSuite({
  name: "claude-code",
  adapter: claudeCodeAdapter,
  fixtureHome: join(REPO_ROOT, "fixtures/harness-homes/claude-code/home"),
  versionOutput: "2.1.325 (Claude Code)",
  scan: scanExistingSkills,
  expect: {
    version: "2.1.325",
    variant: null,
    questionTool: "AskUserQuestion",
    maxPerCall: 4,
    maxOptions: 4,
    multiSelect: true,
    nativeActivation: true,
    writesSessionHome: { personal: true, project: true },
  },
});
