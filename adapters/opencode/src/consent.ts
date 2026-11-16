import type { JsonObject, JsonValue } from "@dynamic-skills/adapter-sdk";
import { wildcardMatch } from "./wildcard";

/** Representative commands probed against the merged config (Ruling R34). */
const PROBES: readonly { label: string; command: string }[] = [
  { label: "save", command: "dynamic-skills save --session x --scope project" },
  { label: "init", command: "dynamic-skills init --harness opencode --scope personal" },
];

/** One flattened permission rule, in OpenCode's own evaluation order. */
interface Rule {
  action: string;
  pattern: string;
  effect: string;
}

const isObj = (v: JsonValue | undefined): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Maps a V1 permission action key onto its V2 name, exactly as OpenCode's own
 * `ConfigMigrateV1.normalizeAction` does when it migrates a V1 `permission` object into V2's
 * native rule array.
 *
 * @param action - A V1 permission key (for example `"bash"`).
 * @returns The V2 action name.
 */
function normalizeAction(action: string): string {
  if (action === "write" || action === "patch" || action === "apply_patch") return "edit";
  if (action === "task") return "subagent";
  if (action === "bash") return "shell";
  return action;
}

/**
 * Flattens a V1 `permission` object into rules, in the object's own top-level key order and, per
 * key, its own pattern order — the same order OpenCode's `fromConfig` (V1) and `migratePermissions`
 * (V2 migration) build their rule list in, so `findLast`-style evaluation matches reality.
 *
 * @param permission - The `permission` value of the document (string, object, or absent).
 * @param rename - Rename V1 action keys to their V2 names (used only on the V2 line).
 * @returns The flattened rules.
 */
function rulesFromPermission(permission: JsonValue | undefined, rename: boolean): Rule[] {
  if (typeof permission === "string") return [{ action: "*", pattern: "*", effect: permission }];
  if (!isObj(permission)) return [];
  const out: Rule[] = [];
  for (const [action, raw] of Object.entries(permission)) {
    const a = rename ? normalizeAction(action) : action;
    if (typeof raw === "string") {
      out.push({ action: a, pattern: "*", effect: raw });
      continue;
    }
    if (!isObj(raw)) continue;
    for (const [pattern, effect] of Object.entries(raw)) {
      if (typeof effect === "string") out.push({ action: a, pattern, effect });
    }
  }
  return out;
}

/**
 * Flattens the V2 native `permissions` array into rules, in array order — always evaluated after
 * every V1-migrated rule, regardless of where `permissions` sits in the document.
 *
 * @param permissions - The top-level `permissions` value (array, or anything else).
 * @returns The flattened rules; entries missing a string `action`/`resource`/`effect` are skipped.
 */
function rulesFromNativePermissions(permissions: JsonValue | undefined): Rule[] {
  if (!Array.isArray(permissions)) return [];
  const out: Rule[] = [];
  for (const entry of permissions) {
    if (!isObj(entry)) continue;
    const { action, resource, effect } = entry;
    if (typeof action === "string" && typeof resource === "string" && typeof effect === "string") {
      out.push({ action, pattern: resource, effect });
    }
  }
  return out;
}

/** OpenCode's own evaluation: the last rule whose action and pattern both match, else `"ask"`. */
function evaluate(action: string, command: string, rules: readonly Rule[]): Rule {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (wildcardMatch(action, rule.action) && wildcardMatch(command, rule.pattern)) return rule;
  }
  return { action, pattern: "*", effect: "ask" };
}

const describe = (rule: Rule): string =>
  `${rule.action}:${JSON.stringify(rule.pattern)} -> ${rule.effect}`;

/**
 * Mirrors OpenCode's own rule evaluation (last matching rule wins) for `dynamic-skills save` and
 * `dynamic-skills init` against the config document `init` is about to write, after its merge: the
 * V1 `permission` object's own rules on the V1 line; on the V2 line, those same rules migrated
 * (`bash` renamed to `shell`) followed by the native `permissions` array, which OpenCode always
 * evaluates after every V1-derived rule regardless of where it sits in the document (Ruling R34).
 *
 * @param merged - The document after the planned merge is applied (as `mergeJson` would produce
 *   it).
 * @param variant - The detected OpenCode line.
 * @param path - The config file path, named in the note.
 * @returns One note per probed command whose consent ask is overridden by another rule; empty
 *   when both commands still ask.
 */
export function consentNotes(merged: JsonValue, variant: string | null, path: string): string[] {
  if (!isObj(merged)) return [];
  const migrate = variant === "v2";
  const v1Rules = rulesFromPermission(merged.permission, migrate);
  const rules = migrate ? [...v1Rules, ...rulesFromNativePermissions(merged.permissions)] : v1Rules;
  const queryAction = migrate ? "shell" : "bash";
  const notes: string[] = [];
  for (const probe of PROBES) {
    const rule = evaluate(queryAction, probe.command, rules);
    if (rule.effect === "ask") continue;
    notes.push(
      `D6 consent for \`dynamic-skills ${probe.label}\` will not apply in ${path}: ` +
        `${describe(rule)} wins there (OpenCode evaluates the last matching rule). ` +
        "Move or remove that rule so the consent entry is evaluated last.",
    );
  }
  return notes;
}
