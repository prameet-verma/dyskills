import { isAbsolute, join } from "node:path";
import {
  ANALYST_INSTRUCTIONS,
  compareVersions,
  parseVersion,
  type Detection,
  type HarnessAdapter,
  type HostEnv,
  type InstallOptions,
  type InstallPlan,
  type InstallScope,
  type PlannedWrite,
  type ReadRoot,
  type VerifyCommand,
} from "@dynamic-skills/adapter-sdk";
import { resolveSkillRoots } from "@dynamic-skills/bootstrapper";
import {
  BARE_COMMAND_NOTE,
  CODEX_AGENT_FILE,
  CODEX_AGENT_NAME,
  analystToml,
  rulesText,
} from "./templates";
import { codexQuestions } from "./questions";

/** Codex versions this adapter was tested against. */
export const CODEX_TESTED_VERSIONS = ["0.169.0"] as const;

const BOOTSTRAP_DIR = "dynamic-skill-bootstrap";

function codexHome(env: HostEnv): string {
  const v = env.vars.CODEX_HOME;
  return v !== undefined && v !== "" && isAbsolute(v) ? v : join(env.userHome, ".codex");
}

const consentCheck = (rules: string): VerifyCommand => ({
  name: "consent rule",
  bin: "codex",
  args: [
    "execpolicy",
    "check",
    "--rules",
    rules,
    "--",
    "dynamic-skills",
    "save",
    "--scope",
    "project",
  ],
  expect: /prompt/,
});

const allowCheck = (rules: string): VerifyCommand => ({
  name: "allow rule",
  bin: "codex",
  args: ["execpolicy", "check", "--rules", rules, "--", "dynamic-skills", "status"],
  expect: /allow/,
});

/** The Codex harness adapter. */
export const codexAdapter: HarnessAdapter = {
  id: "codex",
  binary: "codex",
  testedVersions: CODEX_TESTED_VERSIONS,
  nativeActivation: false,
  delegation: { agentName: CODEX_AGENT_NAME, readOnly: "instructed" },

  async detect(env: HostEnv): Promise<Detection> {
    const bin = await env.probe.which("codex");
    if (bin === null) {
      return { installed: false, version: null, variant: null, tested: false, warnings: [] };
    }
    const out = await env.probe.run(bin, ["--version"]);
    const version = out.code === 0 ? parseVersion(out.stdout) : null;
    const tested =
      version !== null && CODEX_TESTED_VERSIONS.some((v) => compareVersions(v, version) === 0);
    const warnings: string[] = [];
    if (version === null) warnings.push("Could not read the Codex version.");
    else if (!tested) {
      warnings.push(
        `Codex ${version} is untested; this adapter was tested with ${CODEX_TESTED_VERSIONS.join(", ")}.`,
      );
    }
    return { installed: true, version, variant: null, tested, warnings };
  },

  async planInstall(
    env: HostEnv,
    _detection: Detection,
    opts: InstallOptions,
  ): Promise<InstallPlan> {
    const project = opts.scope === "project";
    const skillsBase = project ? env.projectRoot : env.userHome;
    const cx = project ? join(env.projectRoot, ".codex") : codexHome(env);
    const common = { within: project ? env.projectRoot : null, committable: project };
    const rulesPath = join(cx, "rules/dynamic-skills.rules");
    const writes: PlannedWrite[] = [
      {
        ...common,
        kind: "file",
        path: join(skillsBase, ".agents/skills", BOOTSTRAP_DIR, "SKILL.md"),
        content: opts.bootstrapSkill,
        purpose: "bootstrap skill",
      },
      {
        ...common,
        kind: "file",
        path: join(cx, "agents", `${CODEX_AGENT_FILE}.toml`),
        content: Buffer.from(analystToml(ANALYST_INSTRUCTIONS), "utf8"),
        purpose: "read-only context analyst agent",
      },
      {
        ...common,
        kind: "file",
        path: rulesPath,
        content: Buffer.from(rulesText(opts.allowRule), "utf8"),
        purpose: opts.allowRule
          ? "consent rules for save and init, plus an allow rule for dynamic-skills"
          : "consent rules for save and init",
      },
    ];
    const notes = [
      "Restart Codex to load the rules.",
      "`dynamic-skills save` and `init` ask for approval (a prompt rule); `codex exec` cannot approve and an allow rule cannot override a prompt rule (strictest wins); a non-interactive save means running `dynamic-skills save` in a terminal outside Codex (removing the prompt rule only lets it run in the exec sandbox, which most likely blocks writing `.agents/`, or without consent if the allow rule is on).",
    ];
    notes.push(BARE_COMMAND_NOTE);
    if (!opts.allowRule) {
      notes.push(
        "`--codex-allow-rule` lets `dynamic-skills` commands other than `save` and `init` run outside the sandbox; `save` and `init` always ask, then run with the session's current permissions. Saving into `.agents/skills` from inside the sandbox may need the agent to request escalated permissions, or running `dynamic-skills save` in a terminal.",
      );
    }
    if (project) notes.push("Codex applies .codex/ only in trusted projects.");
    const verify = [consentCheck(rulesPath)];
    if (opts.allowRule) verify.push(allowCheck(rulesPath));
    return {
      harness: "codex",
      scope: opts.scope,
      projectRoot: env.projectRoot,
      writes,
      notes,
      verify,
    };
  },

  skillRoot(env: HostEnv, scope: InstallScope): string {
    return join(scope === "project" ? env.projectRoot : env.userHome, ".agents/skills");
  },

  async readRoots(env: HostEnv): Promise<ReadRoot[]> {
    const roots = await resolveSkillRoots({
      repo: env.projectRoot,
      home: env.userHome,
      vars: env.vars,
      etcDir: env.etcDir,
    });
    return roots
      .filter((r) => r.readBy.includes("codex"))
      .map((r) => ({ dir: r.dir, scope: r.scope, readBy: [...r.readBy] }));
  },

  questions: codexQuestions,

  nativeSessionRoot(): null {
    return null;
  },

  saveNotes(): string[] {
    return [
      "Codex lists a skill saved into an existing skills directory within about 10 seconds; restart Codex if it does not appear.",
    ];
  },
};
