import { describe, expect, it } from "vitest";
import { planSaveTargets, type ReadRoot } from "../src/index";

const claudeDir = "/p/.claude/skills";
const agentsDir = "/p/.agents/skills";
const opencodeDir = "/p/.opencode/skills";
const root = (dir: string, readBy: ReadRoot["readBy"]): ReadRoot => ({
  dir,
  scope: "project",
  readBy,
});

describe("planSaveTargets", () => {
  it("covers claude-code and opencode with one shared root", () => {
    const targets = planSaveTargets({
      harnesses: ["claude-code", "opencode"],
      primary: { "claude-code": claudeDir, opencode: opencodeDir },
      readRoots: {
        "claude-code": [root(claudeDir, ["claude-code", "opencode"])],
        opencode: [root(opencodeDir, ["opencode"]), root(claudeDir, ["claude-code", "opencode"])],
      },
    });
    expect(targets).toEqual([{ root: claudeDir, covers: ["claude-code", "opencode"] }]);
  });

  it("needs two targets when opencode does not read the claude root", () => {
    const targets = planSaveTargets({
      harnesses: ["claude-code", "opencode"],
      primary: { "claude-code": claudeDir, opencode: opencodeDir },
      readRoots: {
        "claude-code": [root(claudeDir, ["claude-code"])],
        opencode: [root(opencodeDir, ["opencode"])],
      },
    });
    expect(targets).toEqual([
      { root: claudeDir, covers: ["claude-code"] },
      { root: opencodeDir, covers: ["opencode"] },
    ]);
  });

  it("uses the shared agents root for codex and opencode", () => {
    const targets = planSaveTargets({
      harnesses: ["codex", "opencode"],
      primary: { codex: agentsDir, opencode: opencodeDir },
      readRoots: {
        codex: [root(agentsDir, ["codex", "opencode"])],
        opencode: [root(opencodeDir, ["opencode"]), root(agentsDir, ["codex", "opencode"])],
      },
    });
    expect(targets).toEqual([{ root: agentsDir, covers: ["codex", "opencode"] }]);
  });

  it("needs two targets for all three harnesses", () => {
    const targets = planSaveTargets({
      harnesses: ["claude-code", "codex", "opencode"],
      primary: { "claude-code": claudeDir, codex: agentsDir, opencode: opencodeDir },
      readRoots: {
        "claude-code": [root(claudeDir, ["claude-code"])],
        codex: [root(agentsDir, ["codex", "opencode"])],
        opencode: [root(opencodeDir, ["opencode"]), root(agentsDir, ["codex", "opencode"])],
      },
    });
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.root).sort()).toEqual([agentsDir, claudeDir].sort());
    expect(targets.flatMap((t) => t.covers).sort()).toEqual(["claude-code", "codex", "opencode"]);
  });

  it("returns nothing for no harnesses and skips a harness without a primary root", () => {
    expect(planSaveTargets({ harnesses: [], primary: {}, readRoots: {} })).toEqual([]);
    expect(planSaveTargets({ harnesses: ["codex"], primary: {}, readRoots: {} })).toEqual([]);
  });
});
