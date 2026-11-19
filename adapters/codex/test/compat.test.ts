import { readFile } from "node:fs/promises";
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
  consent: async ({ world, scope, command }) => {
    const dir = scope === "project" ? join(world.project, ".codex") : join(world.home, ".codex");
    const text = await readFile(join(dir, "rules/dynamic-skills.rules"), "utf8");
    const words = command.split(" ");
    const strictness: Record<string, number> = { allow: 0, prompt: 1, forbidden: 2 };
    let best = "none";
    for (const m of text.matchAll(/prefix_rule\(pattern = \[([^\]]*)\], decision = "(\w+)"/g)) {
      const pattern = m[1]!.split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
      if (!pattern.every((w, i) => words[i] === w)) continue;
      if (best === "none" || strictness[m[2]!]! > strictness[best]!) best = m[2]!;
    }
    return best;
  },
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
