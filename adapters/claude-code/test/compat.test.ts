import { readFile } from "node:fs/promises";
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
  consent: async ({ world, scope, command }) => {
    const file = join(scope === "project" ? world.project : world.home, ".claude/settings.json");
    const perms = (
      JSON.parse(await readFile(file, "utf8")) as { permissions: Record<string, string[]> }
    ).permissions;
    const hit = (rules: string[] | undefined): boolean =>
      (rules ?? []).some((r) => {
        const m = /^Bash\((.*?)( \*)?\)$/.exec(r);
        return (
          m !== null && (m[2] === undefined ? command === m[1] : command.startsWith(`${m[1]} `))
        );
      });
    return hit(perms.deny) ? "deny" : hit(perms.ask) ? "ask" : hit(perms.allow) ? "allow" : "none";
  },
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
