import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  compareVersions,
  type HostEnv,
  type InstallOptions,
  type InstallPlan,
  type JsonObject,
  type PlannedWrite,
  type VerifyCommand,
} from "@dynamic-skills/adapter-sdk";
import {
  analystAgentFile,
  ASK_RULES,
  BASH_RULE,
  CLAUDE_ANALYST_NAME,
  CONSENT_NOTE,
  homeRules,
  UNTRUSTED_NOTE,
} from "./templates";

/** Name of the bootstrap skill directory. */
const BOOTSTRAP_DIR = "dynamic-skill-bootstrap";

/**
 * Claude Code's personal configuration directory: an absolute `CLAUDE_CONFIG_DIR`, else
 * `<userHome>/.claude`. A relative override is ignored.
 *
 * @param env - Host environment.
 * @returns The directory.
 */
export function configDir(env: HostEnv): string {
  const v = env.vars.CLAUDE_CONFIG_DIR;
  return v !== undefined && v !== "" && isAbsolute(v) ? v : join(env.userHome, ".claude");
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Plans the Claude Code install for one scope.
 *
 * @param env - Host environment (realpaths).
 * @param version - Detected Claude Code version, or null.
 * @param opts - Install options.
 * @param skillsDir - The skills directory of the scope (for verification).
 * @returns The plan.
 */
export async function planClaudeInstall(
  env: HostEnv,
  version: string | null,
  opts: InstallOptions,
  skillsDir: string,
): Promise<InstallPlan> {
  const H = env.sessionHome;
  const P = env.projectRoot;
  const project = opts.scope === "project";
  const base = project ? join(P, ".claude") : configDir(env);
  const within = project ? P : null;
  const { read, edit } = homeRules(H);

  const envBlock: JsonObject = { DYNAMIC_SKILLS_HOME: H, DYNAMIC_SKILLS_HARNESS: "claude-code" };
  if (opts.native) envBlock.DYNAMIC_SKILLS_NATIVE = "1";
  const machine: JsonObject = {
    permissions: { allow: [read, edit], additionalDirectories: [H] },
    env: envBlock,
  };

  const writes: PlannedWrite[] = [
    {
      kind: "file",
      path: join(base, "skills", BOOTSTRAP_DIR, "SKILL.md"),
      content: opts.bootstrapSkill,
      committable: project,
      within,
      purpose: "Dynamic Skills bootstrap skill",
    },
    {
      kind: "file",
      path: join(base, "agents", `${CLAUDE_ANALYST_NAME}.md`),
      content: analystAgentFile(),
      committable: project,
      within,
      purpose: "read-only context analyst agent",
    },
  ];
  if (project) {
    writes.push(
      {
        kind: "json-merge",
        path: join(base, "settings.json"),
        patch: { permissions: { allow: [BASH_RULE], ask: [...ASK_RULES] } },
        committable: true,
        within,
        purpose: "allow dynamic-skills and ask before save and init",
      },
      {
        kind: "json-merge",
        path: join(base, "settings.local.json"),
        patch: machine,
        committable: false,
        mustBeIgnored: true,
        within,
        purpose: "session home access (machine paths, not committable)",
      },
    );
  } else {
    const perms = machine.permissions as JsonObject;
    writes.push({
      kind: "json-merge",
      path: join(base, "settings.json"),
      patch: {
        permissions: {
          allow: [BASH_RULE, read, edit],
          ask: [...ASK_RULES],
          additionalDirectories: perms.additionalDirectories as string[],
        },
        env: envBlock,
      },
      committable: false,
      within,
      purpose: "allow dynamic-skills, ask before save and init, pin the session home",
    });
  }

  const notes: string[] = [];
  if (project) notes.push(UNTRUSTED_NOTE);
  notes.push(CONSENT_NOTE);
  if (opts.native) {
    writes.push({
      kind: "dir",
      path: join(H, "native/claude-code/.claude/skills"),
      committable: false,
      within: H,
      purpose: "native placement directory for activated skills",
    });
    notes.push(
      `Launch sessions with \`claude --add-dir ${H}/native/claude-code\` to let them list activated skills natively.`,
    );
  }
  if (!(await exists(join(base, "agents")))) {
    notes.push("Restart running sessions to load the analyst agent.");
  }

  const verify: VerifyCommand[] =
    version !== null && compareVersions(version, "2.1.233") >= 0
      ? [
          {
            name: "skill frontmatter",
            bin: "claude",
            args: ["plugin", "validate", skillsDir],
            expect: /[\s\S]*/,
          },
        ]
      : [];

  return {
    harness: "claude-code",
    scope: opts.scope,
    projectRoot: P,
    writes,
    notes,
    verify,
  };
}
