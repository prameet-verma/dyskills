import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
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
import { chooseConfigFile, readConfigDocument } from "./config-file";
import { consentNotes, denyProbes, resolveCommand, type Layer } from "./consent";
import { wildcardMatch } from "./wildcard";
import {
  analystAgentFile,
  BASH_ENTRIES,
  PROJECT_BASH_ENTRIES,
  PROJECT_READONLY_NOTE,
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
 * Parses `path` as JSON or JSONC (comments and trailing commas allowed), refusing a symlink and
 * anything over the 8 MB cap before it is read. A missing, unreadable or refused file, or a
 * document `jsonc-parser` cannot make sense of, is `undefined`, never an error: every caller
 * treats an undefined document the same as "nothing written yet".
 *
 * @param path - Config file path.
 * @returns The parsed value, or `undefined`.
 */
async function readJsoncDocument(path: string): Promise<JsonValue | undefined> {
  return (await readConfigDocument(path, false)).doc;
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
 * Every config file OpenCode merges, in merge order (Ruling R44): the global config directory's
 * `config.json`, `opencode.json`, `opencode.jsonc`; then `OPENCODE_CONFIG_DIR`'s two files when it
 * is set (on v1 it adds to the global directory, on v2 it replaces it); then the project root's
 * `opencode.json`, `opencode.jsonc`; then `.opencode/opencode.json`, `.opencode/opencode.jsonc`.
 *
 * @param env - Host environment.
 * @param variant - Detected OpenCode line.
 * @returns The paths, earliest layer first.
 */
export function layerPaths(env: HostEnv, variant: string | null): string[] {
  const xdg = env.vars.XDG_CONFIG_HOME;
  const globalDir = join(
    xdg !== undefined && xdg !== "" && isAbsolute(xdg) ? xdg : join(env.userHome, ".config"),
    "opencode",
  );
  const configured = personalConfigDir(env);
  const out: string[] = [];
  const dirs = variant === "v2" ? [configured] : [globalDir, configured];
  for (const [i, dir] of dirs.entries()) {
    if (dirs.indexOf(dir) !== i) continue;
    const names =
      dir === globalDir
        ? ["config.json", "opencode.json", "opencode.jsonc"]
        : ["opencode.json", "opencode.jsonc"];
    out.push(...names.map((n) => join(dir, n)));
  }
  const P = env.projectRoot;
  out.push(join(P, "opencode.json"), join(P, "opencode.jsonc"));
  out.push(join(P, ".opencode", "opencode.json"), join(P, ".opencode", "opencode.jsonc"));
  return out;
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

  const chosenRead = await readConfigDocument(chosen, false);
  const order = layerPaths(env, variant);
  const at = order.indexOf(chosen);
  const readLayer = async (path: string): Promise<Layer | undefined> => {
    const doc = (await readConfigDocument(path, true)).doc;
    return doc === undefined ? undefined : { path, doc };
  };
  const layersOf = async (paths: string[]): Promise<Layer[]> =>
    (await Promise.all(paths.map(readLayer))).filter((l): l is Layer => l !== undefined);
  const before = await layersOf(at < 0 ? order : order.slice(0, at));
  const after = await layersOf(at < 0 ? [] : order.slice(at + 1));

  const notes: string[] = [];
  const SAVE_CMD = "dynamic-skills save --session x --scope project";
  const INIT_CMD = "dynamic-skills init --harness opencode --scope personal";
  const STATUS_CMD = "dynamic-skills status --session x";
  const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
  const decide = (layers: readonly Layer[], command: string) =>
    resolveCommand(layers, variant, command);
  const currentLayer: Layer[] =
    chosenRead.doc === undefined ? [] : [{ path: chosen, doc: chosenRead.doc }];
  const skip = new Set<string>();
  const entries: Record<string, string> = project
    ? { ...PROJECT_BASH_ENTRIES }
    : { ...BASH_ENTRIES };

  if (project) {
    // Rulings R46 (amended): the committed file protects everyone who loads it. A deny in a
    // project layer (root project files, `.opencode`) is never weakened, so that ask is omitted. A
    // deny that lives only in a personal or global layer is not shared with teammates, so the ask
    // is still written (and the note says the personal deny becomes an ask here).
    const inProject = (l: Layer): boolean =>
      l.path.startsWith(`${P}/`) || l.path.startsWith(`${P}\\`);
    const projectLayers: Layer[] = [...before.filter(inProject), ...currentLayer];
    const allLayers: Layer[] = [...before, ...currentLayer];
    for (const [label, command] of [
      ["save", SAVE_CMD],
      ["init", INIT_CMD],
    ] as const) {
      const shared = decide(projectLayers, command);
      if (shared.effect === "deny") {
        delete entries[`dynamic-skills ${label} *`];
        skip.add(label);
        notes.push(
          `\`dynamic-skills ${label}\` is denied by ${shared.source ?? chosen} (\`"${shared.pattern}": "deny"\`); init kept the deny and did not write the \`${label}\` ask entry.`,
        );
      } else {
        const own = decide(allLayers, command);
        if (own.effect === "deny") {
          notes.push(
            `your personal deny for \`dynamic-skills ${label}\` (${own.source ?? "a personal layer"}) becomes ask in this project, because the project ask overrides the same key; teammates get ask, never allow.`,
          );
        }
      }
    }
  }

  const buildPatch = (): JsonObject => {
    if (project) return { permission: { bash: { ...entries } } };
    const permission: JsonObject = {
      external_directory: { [`${H}/*`]: "allow" },
      edit: { [`${H}/*`]: "allow" },
    };
    if (Object.keys(entries).length > 0) permission.bash = { ...entries };
    return {
      permission: {
        ...(permission.bash === undefined ? {} : { bash: permission.bash }),
        external_directory: permission.external_directory as JsonValue,
        edit: permission.edit as JsonValue,
      },
    };
  };

  if (!project) {
    // Ruling R46 (amended): the personal file applies to every project on the machine, so it is
    // judged over the personal and global layers ONLY (never the current project's files). Never
    // weaken a deny there, and never let save or init resolve to allow.
    const inProject = (l: Layer): boolean =>
      l.path.startsWith(`${P}/`) || l.path.startsWith(`${P}\\`);
    const personalAfter = after.filter((l) => !inProject(l));
    const base: Layer[] = [...before, ...currentLayer, ...personalAfter];
    const probes = [...new Set([SAVE_CMD, INIT_CMD, STATUS_CMD, ...denyProbes(base, variant)])];
    const nextLayers = (): { layers: Layer[]; conflicts: string[] } => {
      const m = mergeJson(chosenRead.doc, buildPatch(), { promote: PROMOTE });
      return {
        layers: [...before, { path: chosen, doc: m.value }, ...personalAfter],
        conflicts: m.conflicts,
      };
    };
    const BROAD = "dynamic-skills *";
    for (let round = 0; round < 8; round += 1) {
      const { layers: next, conflicts } = nextLayers();
      if (BROAD in entries && conflicts.includes(`permission.bash.${BROAD}`)) {
        delete entries[BROAD];
        notes.push(
          `init left out \`"${BROAD}": "allow"\` because your file already sets that key to a different value (writing it would be a merge conflict).`,
        );
        continue;
      }
      let dropped = false;
      for (const command of probes) {
        const was = decide(base, command);
        const now = decide(next, command);
        if ((RANK[now.effect] ?? 0) >= (RANK[was.effect] ?? 0)) continue;
        const consent =
          wildcardMatch(command, "dynamic-skills save *") ||
          wildcardMatch(command, "dynamic-skills init *");
        // A read-only command may go from ask to allow (that is what the broad allow is for).
        if (!consent && was.effect !== "deny") continue;
        const askKey = ["save", "init"]
          .map((l) => `dynamic-skills ${l} *`)
          .find((k) => wildcardMatch(command, k));
        const key =
          askKey !== undefined && was.effect === "deny" && askKey in entries ? askKey : BROAD;
        if (!(key in entries)) continue;
        delete entries[key];
        dropped = true;
        for (const l of ["save", "init"])
          if (command.startsWith(`dynamic-skills ${l}`)) skip.add(l);
        notes.push(
          `init left out \`"${key}": "${key === BROAD ? "allow" : "ask"}"\` because it would weaken your ${was.effect} for \`${command}\` (from ${was.source ?? "OpenCode's built-in default"}) to ${now.effect}.`,
        );
        break;
      }
      if (!dropped) break;
    }
    // Hard invariant: over the personal and global layers alone, save and init never resolve to
    // allow after our write. Drop the broad allow, keep the asks.
    for (let round = 0; round < 4; round += 1) {
      const { layers: next } = nextLayers();
      let fixed = false;
      for (const [label, command] of [
        ["save", SAVE_CMD],
        ["init", INIT_CMD],
      ] as const) {
        if (decide(next, command).effect !== "allow") continue;
        const askKey = `dynamic-skills ${label} *`;
        if (BROAD in entries) {
          delete entries[BROAD];
          notes.push(
            `init left out \`"${BROAD}": "allow"\` because \`dynamic-skills ${label}\` would otherwise resolve to allow in your personal config.`,
          );
        } else if (!(askKey in entries)) {
          entries[askKey] = "ask";
          notes.push(
            `init kept the \`${label}\` ask entry so \`dynamic-skills ${label}\` never resolves to allow.`,
          );
        } else continue;
        fixed = true;
        break;
      }
      if (!fixed) break;
    }
    // Our write can still turn a deny in the current project's files into an ask there: say so.
    const full: Layer[] = [...before, ...currentLayer, ...after];
    const fullNext: Layer[] = [
      ...before,
      { path: chosen, doc: nextLayers().layers.find((l) => l.path === chosen)!.doc },
      ...after,
    ];
    for (const [label, command] of [
      ["save", SAVE_CMD],
      ["init", INIT_CMD],
    ] as const) {
      const was = decide(full, command);
      const now = decide(fullNext, command);
      if (
        was.effect === "deny" &&
        now.effect !== "deny" &&
        was.source !== null &&
        inProject({ path: was.source, doc: {} })
      ) {
        notes.push(
          `the project's deny for \`dynamic-skills ${label}\` (${was.source}) becomes ${now.effect} in this project because of this personal init; nothing else was changed for it.`,
        );
      }
    }
  }

  const patch = buildPatch();
  const hasWrite = project ? Object.keys(entries).length > 0 : true;
  if (hasWrite) {
    writes.push({
      kind: "jsonc-merge",
      path: chosen,
      patch,
      promote: PROMOTE,
      committable,
      within,
      purpose: project
        ? "ask before save and init"
        : "allow dynamic-skills and ask before save and init",
    });
  }

  if (project) notes.push(PROJECT_EXTERNAL_DIR_NOTE, PROJECT_READONLY_NOTE);
  else notes.push(CROSS_SCOPE_NOTE);
  notes.push(CONSENT_NOTE, QUOTED_SUBCOMMAND_NOTE);
  if (variant === "v1" && (await hasTopLevelPermissionsKey(chosen))) {
    notes.push(`OpenCode 1.x rejects the V2 \`permissions\` key in ${chosen}.`);
  }
  if (chosenRead.refused !== undefined) {
    notes.push(
      `${chosen} is ${chosenRead.refused === "symlink" ? "a symlink" : chosenRead.refused}; init did not read it and will not write to it (the apply step refuses it). Replace it with a regular file under 8 MB, or pass --force only where it applies.`,
    );
  }
  if (project) {
    try {
      if ((await lstat(join(P, ".opencode"))).isSymbolicLink()) {
        notes.push(
          `${join(P, ".opencode")} is a symlink; init refuses to write through a symlinked parent in project scope. Replace it with a real directory.`,
        );
      }
    } catch {
      // No .opencode directory yet.
    }
  }

  // Rulings R34/R44: simulate OpenCode's layered merge (mergeDeep key order), with the file init
  // writes in its own slot, and report (never block) when another rule outranks the consent
  // entries we are about to write. An approximation: see consentNotes for what is not modelled.
  const merged = hasWrite
    ? mergeJson(chosenRead.doc, patch, { promote: PROMOTE }).value
    : (chosenRead.doc ?? {});
  notes.push(
    ...consentNotes(merged, variant, chosen, {
      before,
      after,
      skip,
      own: new Set(Object.keys(BASH_ENTRIES)),
    }),
  );

  const verify: VerifyCommand[] =
    variant === "v2"
      ? [{ name: "config paths", bin: "opencode", args: ["debug", "paths"], expect: /\S/ }]
      : [];

  return { harness: "opencode", scope: opts.scope, projectRoot: P, writes, notes, verify };
}
