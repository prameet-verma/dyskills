import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { scanExistingSkills } from "@dynamic-skills/bootstrapper";
import { defineAdapterCompatSuite } from "@dynamic-skills/adapter-sdk/testkit";
import { openCodeAdapter } from "../src/index";
import { effectiveDecision } from "../src/consent";
import { layerPaths } from "../src/install";

const fixtureHome = (name: string): string =>
  join(
    fileURLToPath(new URL(".", import.meta.url)),
    `../../../fixtures/harness-homes/${name}/home`,
  );

const targets = [
  { name: "opencode-v1", versionOutput: "1.19.5", variant: "v1" as const },
  { name: "opencode-v2", versionOutput: "2.3.0", variant: "v2" as const },
];

for (const target of targets) {
  defineAdapterCompatSuite({
    name: target.name,
    adapter: openCodeAdapter,
    fixtureHome: fixtureHome(target.name),
    versionOutput: target.versionOutput,
    vars: { XDG_CONFIG_HOME: "{home}/.config" },
    scan: ({ repo, home, vars, etcDir }) => scanExistingSkills({ repo, home, vars, etcDir }),
    consent: async ({ world, scope, command }) => {
      const docs = [];
      // Project scope: judge the project layers alone (OpenCode's built-in default is allow), so a
      // personal "ask" cannot hide a missing project consent entry.
      const files = layerPaths(world.env, target.variant).filter(
        (f) => scope === "personal" || f.startsWith(world.project),
      );
      for (const f of files) {
        try {
          docs.push(parse(await readFile(f, "utf8"), [], { allowTrailingComma: true }));
        } catch {
          /* layer absent */
        }
      }
      return effectiveDecision(docs, target.variant, command);
    },
    expect: {
      version: target.versionOutput,
      variant: target.variant,
      questionTool: "question",
      maxPerCall: 10,
      maxOptions: 4,
      multiSelect: true,
      nativeActivation: false,
      writesSessionHome: { personal: true, project: false },
    },
  });
}
