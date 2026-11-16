import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import type {
  HostEnv,
  InstallOptions,
  InstallPlan,
  JsonObject,
  JsonValue,
  PlannedWrite,
  VerifyCommand,
} from "@dynamic-skills/adapter-sdk";
import { mergeJson } from "@dynamic-skills/adapter-sdk";
import { chooseConfigFile } from "./config-file";
import { consentNotes } from "./consent";
import {
  analystAgentFile,
  BASH_ENTRIES,
  commandFile,
  CONSENT_NOTE,
  CROSS_SCOPE_NOTE,
  PROJECT_EXTERNAL_DIR_NOTE,
  QUOTED_SUBCOMMAND_NOTE,
} from "./templates";

/** Name of the bootstrap skill directory. */
const BOOTSTRAP_DIR = "dynamic-skill-bootstrap";

/** Promotes a scalar `permission.bash`/`edit`/`external_directory` into `{ "*": scalar, ... }`. */
const PROMOTE = {
  paths: [
    ["permission", "bash"],
    ["permission", "edit"],
    ["permission", "external_directory"],
  ],
  key: "*",
};

/**
 * OpenCode's personal configuration directory: an absolute `OPENCODE_CONFIG_DIR` (used as-is,
 * since OpenCode itself does not append `opencode` to it), else
 * `<absolute XDG_CONFIG_HOME, or <userHome>/.config>/opencode`. A relative override is ignored.
 *
 * @param env - Host environment.
 * @returns The directory.
 */
export function personalConfigDir(env: HostEnv): string {
  const configDir = env.vars.OPENCODE_CONFIG_DIR;
  if (configDir !== undefined && configDir !== "" && isAbsolute(configDir)) return configDir;
  const xdg = env.vars.XDG_CONFIG_HOME;
  const base =
    xdg !== undefined && xdg !== "" && isAbsolute(xdg) ? xdg : join(env.userHome, ".config");
  return join(base, "opencode");
}

function isJsonObject(v: JsonValue | undefined): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parses `path` as JSON or JSONC (comments and trailing commas allowed). A missing file,
 * unreadable file, or a document `jsonc-parser` cannot make sense of is `undefined`, never an
 * error: every caller treats an undefined document the same as "nothing written yet".
 *
 * @param path - Config file path.
 * @returns The parsed value, or `undefined`.
 */
async function readJsoncDocument(path: string): Promise<JsonValue | undefined> {
  try {
    const text = await readFile(path, "utf8");
    const errors: ParseError[] = [];
    const value = parse(text, errors, { allowTrailingComma: true }) as JsonValue | undefined;
    return errors.length > 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * True when `path` exists, parses as JSON or JSONC, and has a top-level `permissions` key (the
 * V2-only array form OpenCode 1.x rejects). A missing, unreadable or unparsable file is `false`,
 * as is a `permissions` key nested under another object, named only inside a string value, or
 * found on a non-object document root.
 *
 * @param path - Config file path.
 * @returns Whether the file already declares a top-level `permissions` key.
 */
export async function hasTopLevelPermissionsKey(path: string): Promise<boolean> {
  const doc = await readJsoncDocument(path);
  return isJsonObject(doc) && Object.hasOwn(doc, "permissions");
}

/**
 * Plans the OpenCode install for one scope. Writes only the V1-form `permission` object (never
 * `permissions`, `plugin` or `plugins`); V2 migrates it automatically.
 *
 * @param env - Host environment (realpaths).
 * @param variant - Detected OpenCode line (`"v1"`, `"v2"` or `null`).
 * @param opts - Install options.
 * @returns The plan.
 */
export async function planOpenCodeInstall(
  env: HostEnv,
  variant: string | null,
  opts: InstallOptions,
): Promise<InstallPlan> {
  const H = env.sessionHome;
  const P = env.projectRoot;
  const project = opts.scope === "project";
  const C = personalConfigDir(env);
  const base = project ? join(P, ".opencode") : C;
  const within = project ? P : null;
  const committable = project;

  const writes: PlannedWrite[] = [
    {
      kind: "file",
      path: join(base, "skills", BOOTSTRAP_DIR, "SKILL.md"),
      content: opts.bootstrapSkill,
      committable,
      within,
      purpose: "Dynamic Skills bootstrap skill",
    },
    {
      kind: "file",
      path: join(base, "agents", "dynamic-skills-context-analyst.md"),
      content: analystAgentFile(),
      committable,
      within,
      purpose: "read-only context analyst agent",
    },
    {
      kind: "file",
      path: join(base, "commands", "dynamic-skills.md"),
      content: commandFile(),
      committable,
      within,
      purpose: "explicit dynamic-skill-bootstrap trigger command",
    },
  ];

  const candidates = project
    ? [
        join(base, "opencode.jsonc"),
        join(base, "opencode.json"),
        join(P, "opencode.jsonc"),
        join(P, "opencode.json"),
      ]
    : [join(C, "opencode.jsonc"), join(C, "opencode.json")];
  const fallback = project ? join(base, "opencode.jsonc") : join(C, "opencode.jsonc");
  const chosen = await chooseConfigFile(candidates, fallback);

  const patch: JsonObject = project
    ? { permission: { bash: { ...BASH_ENTRIES } } }
    : {
        permission: {
          bash: { ...BASH_ENTRIES },
          external_directory: { [`${H}/*`]: "allow" },
          edit: { [`${H}/*`]: "allow" },
        },
      };

  writes.push({
    kind: "jsonc-merge",
    path: chosen,
    patch,
    promote: PROMOTE,
    committable,
    within,
    purpose: "allow dynamic-skills and ask before save and init",
  });

  const notes: string[] = [];
  if (project) notes.push(PROJECT_EXTERNAL_DIR_NOTE);
  else notes.push(CROSS_SCOPE_NOTE);
  notes.push(CONSENT_NOTE, QUOTED_SUBCOMMAND_NOTE);
  if (variant === "v1" && (await hasTopLevelPermissionsKey(chosen))) {
    notes.push(`OpenCode 1.x rejects the V2 \`permissions\` key in ${chosen}.`);
  }

  // Ruling R34: simulate the merge OpenCode's own evaluator would see, and report (never block)
  // when another rule would outrank the consent entries we are about to write.
  const currentDoc = await readJsoncDocument(chosen);
  const merged = mergeJson(currentDoc, patch, { promote: PROMOTE }).value;
  notes.push(...consentNotes(merged, variant, chosen));

  const verify: VerifyCommand[] =
    variant === "v2"
      ? [{ name: "config paths", bin: "opencode", args: ["debug", "paths"], expect: /\S/ }]
      : [];

  return { harness: "opencode", scope: opts.scope, projectRoot: P, writes, notes, verify };
}
