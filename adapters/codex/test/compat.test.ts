import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanExistingSkills } from "@dynamic-skills/bootstrapper";
import { defineAdapterCompatSuite } from "@dynamic-skills/adapter-sdk/testkit";
import { codexAdapter } from "../src/index";

const fixtureHome = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../fixtures/harness-homes/codex/home",
);

defineAdapterCompatSuite({
  name: "codex",
  adapter: codexAdapter,
  fixtureHome,
  versionOutput: "codex-cli 0.169.0\n",
  scan: ({ repo, home, vars, etcDir }) => scanExistingSkills({ repo, home, vars, etcDir }),
  expect: {
    version: "0.169.0",
    variant: null,
    questionTool: "request_user_input",
    maxPerCall: 3,
    maxOptions: 3,
    multiSelect: false,
    nativeActivation: false,
    writesSessionHome: { personal: false, project: false },
  },
});
