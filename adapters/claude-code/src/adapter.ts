import { join } from "node:path";
import { resolveSkillRoots } from "@dynamic-skills/bootstrapper";
import {
  ANALYST_AGENT_NAME,
  compareVersions,
  parseVersion,
  type HarnessAdapter,
  type HostEnv,
} from "@dynamic-skills/adapter-sdk";
import { configDir, planClaudeInstall } from "./install";
import { mapQuestions } from "./questions";

/** Claude Code versions this adapter was tested against. */
export const CLAUDE_CODE_TESTED_VERSIONS = ["2.1.325"] as const;

/** Skills directory `save` writes for a scope. */
const skillRoot = (env: HostEnv, scope: "project" | "personal"): string =>
  scope === "project" ? join(env.projectRoot, ".claude/skills") : join(configDir(env), "skills");

/** The Claude Code harness adapter. */
export const claudeCodeAdapter: HarnessAdapter = {
  id: "claude-code",
  binary: "claude",
  testedVersions: CLAUDE_CODE_TESTED_VERSIONS,
  nativeActivation: true,
  delegation: { agentName: ANALYST_AGENT_NAME, readOnly: "enforced" },

  async detect(env) {
    const bin = await env.probe.which("claude");
    if (bin === null) {
      return { installed: false, version: null, variant: null, tested: false, warnings: [] };
    }
    const out = await env.probe.run(bin, ["--version"]);
    const version = out.code === 0 ? parseVersion(out.stdout) : null;
    const warnings: string[] = [];
    if (version === null) warnings.push("Could not read the Claude Code version.");
    else {
      if (compareVersions(version, "2.1.0") < 0) {
        warnings.push(
          "Claude Code below 2.1.0 has no live skill reload; restart to see new skills.",
        );
      }
      if (compareVersions(version, "2.1.152") < 0) {
        warnings.push("Claude Code below 2.1.152 has no /reload-skills command.");
      }
    }
    const tested =
      version !== null &&
      CLAUDE_CODE_TESTED_VERSIONS.some((v) => compareVersions(v, version) === 0);
    if (version !== null && !tested) {
      warnings.push(
        `Claude Code ${version} was not tested; tested: ${CLAUDE_CODE_TESTED_VERSIONS.join(", ")}.`,
      );
    }
    return { installed: true, version, variant: null, tested, warnings };
  },

  planInstall(env, detection, opts) {
    return planClaudeInstall(env, detection.version, opts, skillRoot(env, opts.scope));
  },

  skillRoot,

  async readRoots(env) {
    const roots = await resolveSkillRoots({
      repo: env.projectRoot,
      home: env.userHome,
      vars: env.vars,
      etcDir: env.etcDir,
    });
    return roots
      .filter((r) => r.readBy.includes("claude-code"))
      .map((r) => ({ dir: r.dir, scope: r.scope, readBy: r.readBy }));
  },

  questions: mapQuestions,

  nativeSessionRoot(env) {
    return env.vars.DYNAMIC_SKILLS_NATIVE === "1"
      ? join(env.sessionHome, "native/claude-code/.claude/skills")
      : null;
  },

  saveNotes(detection) {
    return detection.version !== null && compareVersions(detection.version, "2.1.0") < 0
      ? ["Restart Claude Code to list the saved skill."]
      : [
          "Listed live when the skills directory existed at session start; otherwise run /reload-skills.",
        ];
  },
};
