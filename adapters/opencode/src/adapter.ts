import { join } from "node:path";
import { resolveSkillRoots } from "@dynamic-skills/bootstrapper";
import {
  ANALYST_AGENT_NAME,
  compareVersions,
  parseVersion,
  type HarnessAdapter,
  type HostEnv,
  type InstallScope,
} from "@dynamic-skills/adapter-sdk";
import { personalConfigDir, planOpenCodeInstall } from "./install";
import { mapQuestions } from "./questions";

/** OpenCode versions this adapter was tested against: one per product line. */
export const OPENCODE_TESTED_VERSIONS = ["1.19.5", "2.3.0"] as const;

/**
 * The OpenCode config variant for a detected version: `"v1"` for major 1, `"v2"` for major 2,
 * `null` for anything else.
 *
 * @param version - Parsed `x.y.z` version.
 * @returns The variant, or `null` for an unsupported line.
 */
function variantOf(version: string): "v1" | "v2" | null {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (major === 1) return "v1";
  if (major === 2) return "v2";
  return null;
}

/** Skills directory `save` writes for a scope. */
const skillRoot = (env: HostEnv, scope: InstallScope): string =>
  scope === "project"
    ? join(env.projectRoot, ".opencode/skills")
    : join(personalConfigDir(env), "skills");

/** The OpenCode harness adapter: one adapter for both the 1.x and 2.x product lines. */
export const openCodeAdapter: HarnessAdapter = {
  id: "opencode",
  binary: "opencode",
  testedVersions: OPENCODE_TESTED_VERSIONS,
  nativeActivation: false,
  delegation: { agentName: ANALYST_AGENT_NAME, readOnly: "enforced" },

  async detect(env) {
    const bin = await env.probe.which("opencode");
    if (bin === null) {
      return { installed: false, version: null, variant: null, tested: false, warnings: [] };
    }
    const out = await env.probe.run(bin, ["--version"]);
    const version = out.code === 0 ? parseVersion(out.stdout) : null;
    const warnings: string[] = [];
    let variant: "v1" | "v2" | null = null;
    if (version === null) {
      warnings.push("Could not read the OpenCode version.");
    } else {
      variant = variantOf(version);
      if (variant === null) warnings.push("unsupported OpenCode line");
    }
    const tested =
      version !== null && OPENCODE_TESTED_VERSIONS.some((v) => compareVersions(v, version) === 0);
    if (version !== null && !tested) {
      warnings.push(
        `OpenCode ${version} was not tested; tested: ${OPENCODE_TESTED_VERSIONS.join(", ")}.`,
      );
    }
    return { installed: true, version, variant, tested, warnings };
  },

  planInstall(env, detection, opts) {
    return planOpenCodeInstall(env, detection.variant, opts);
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
      .filter((r) => r.readBy.includes("opencode"))
      .map((r) => ({ dir: r.dir, scope: r.scope, readBy: [...r.readBy] }));
  },

  questions: mapQuestions,

  nativeSessionRoot() {
    return null;
  },

  saveNotes(detection) {
    if (detection.variant === "v1")
      return ["OpenCode 1.x lists a newly saved skill after a restart."];
    if (detection.variant === "v2") return ["OpenCode 2.x lists the saved skill at the next step."];
    return [
      "OpenCode lists a newly saved skill once the running instance re-reads its skills (restart on 1.x, live on 2.x).",
    ];
  },
};
