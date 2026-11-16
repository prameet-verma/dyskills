import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  HostEnv,
  InstallOptions,
  InstallPlan,
  JsonObject,
  PlannedWrite,
  VerifyCommand,
} from "@dynamic-skills/adapter-sdk";
import { chooseConfigFile } from "./config-file";
import {
  analystAgentFile,
  BASH_ENTRIES,
  commandFile,
  CONSENT_NOTE,
  PROJECT_EXTERNAL_DIR_NOTE,
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

/**
 * Finds the keys of every object directly under the root of a JSON or JSONC document, skipping
 * comments and string contents. Used only to warn about an existing top-level `permissions` key;
 * a parse the document cannot make sense of yields no keys, never an error. Single linear pass
 * over `text` with no backtracking.
 *
 * @param text - JSON or JSONC document text.
 * @returns The root object's own keys, or an empty set if `text` is not an object document.
 */
function topLevelKeys(text: string): Set<string> {
  const keys = new Set<string>();
  let depth = 0;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let raw = "";
      while (j < n && text[j] !== '"') {
        if (text[j] === "\\") {
          raw += text[j] + (text[j + 1] ?? "");
          j += 2;
          continue;
        }
        raw += text[j];
        j++;
      }
      j++;
      let k = j;
      while (
        k < n &&
        (text[k] === " " || text[k] === "\t" || text[k] === "\n" || text[k] === "\r")
      ) {
        k++;
      }
      if (depth === 1 && text[k] === ":") {
        try {
          keys.add(JSON.parse(`"${raw}"`) as string);
        } catch {
          // An unparsable escape sequence: not a key we can name reliably, skip it.
        }
      }
      i = j;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return keys;
}

/**
 * True when `path` exists, parses as JSON or JSONC, and has a top-level `permissions` key (the
 * V2-only array form OpenCode 1.x rejects). A missing or unreadable file is `false`.
 *
 * @param path - Config file path.
 * @returns Whether the file already declares a top-level `permissions` key.
 */
async function hasTopLevelPermissionsKey(path: string): Promise<boolean> {
  try {
    const text = await readFile(path, "utf8");
    return topLevelKeys(text).has("permissions");
  } catch {
    return false;
  }
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
  notes.push(CONSENT_NOTE);
  if (variant === "v1" && (await hasTopLevelPermissionsKey(chosen))) {
    notes.push(`OpenCode 1.x rejects the V2 \`permissions\` key in ${chosen}.`);
  }

  const verify: VerifyCommand[] =
    variant === "v2"
      ? [{ name: "config paths", bin: "opencode", args: ["debug", "paths"], expect: /[\s\S]*/ }]
      : [];

  return { harness: "opencode", scope: opts.scope, projectRoot: P, writes, notes, verify };
}
