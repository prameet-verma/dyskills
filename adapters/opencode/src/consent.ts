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
 * True when `pattern` is a documented opt-out for `label` (Ruling R36): an allow rule specifically
 * scoped to `dynamic-skills save …` or `dynamic-skills init …`, rather than a broad or accidental
 * rule that happens to also cover it.
 *
 * @param label - `"save"` or `"init"`.
 * @param pattern - The winning rule's pattern.
 * @returns Whether `pattern` is the documented opt-out shape for `label`.
 */
const isDocumentedOptOut = (label: string, pattern: string): boolean =>
  pattern.startsWith(`dynamic-skills ${label} `);

/**
 * Builds the note for one probe whose outcome is not `"ask"`. A documented opt-out allow (Ruling
 * R36's advice, scoped to the probed command) is reported as consent being deliberately lifted,
 * never as something to move or remove. A deny is reported as the command being denied outright
 * (stricter than asking), also never with "move or remove" advice, since denying is itself a valid
 * choice. Anything else — a broad or misplaced allow that was not meant to cover this command — is
 * reported as a defeat, naming the rule and advising it be moved or removed.
 *
 * @param label - `"save"` or `"init"`.
 * @param rule - The winning rule.
 * @param path - The config file path.
 * @returns The note text.
 */
function noteFor(label: string, rule: Rule, path: string, agent: string | null): string {
  const who = agent === null ? "" : ` for agent \`${agent}\``;
  if (rule.effect === "allow" && isDocumentedOptOut(label, rule.pattern)) {
    return `Consent for \`dynamic-skills ${label}\` is lifted${who} by your rule ${describe(rule)} in the merged OpenCode configuration (a documented opt-out, not a defeat; config file: ${path}).`;
  }
  if (rule.effect === "deny") {
    return `\`dynamic-skills ${label}\` is denied${who}, not asked, by ${describe(rule)} in the merged OpenCode configuration (stricter than the consent entry, not a defeat; config file: ${path}).`;
  }
  return (
    `D6 consent for \`dynamic-skills ${label}\` will not apply${who} once OpenCode merges its configuration layers (config file: ${path}): ` +
    `${describe(rule)} wins there (OpenCode evaluates the last matching rule). ` +
    "Move or remove that rule so the consent entry is evaluated last."
  );
}

/**
 * remeda's `mergeDeep`, as OpenCode merges its configuration layers: for each key of `src`, two
 * objects merge recursively, anything else (including arrays and scalars) replaces. The result is
 * `{ ...dest, ...merged }`, so a key already in `dest` keeps its earlier position and only new
 * keys are appended. That position is what the last-match evaluation sees (Ruling R44).
 *
 * @param dest - The earlier layer.
 * @param src - The later layer.
 * @returns The merged value.
 */
export function mergeDeep(
  dest: JsonValue | undefined,
  src: JsonValue | undefined,
): JsonValue | undefined {
  if (src === undefined) return dest;
  if (!isObj(dest) || !isObj(src)) return src;
  const out: JsonObject = { ...dest };
  for (const [k, v] of Object.entries(src)) {
    const prior = out[k];
    out[k] = isObj(prior) && isObj(v) ? (mergeDeep(prior, v) as JsonValue) : v;
  }
  return out;
}

/** Layers merged before and after the document `init` writes (Ruling R44). */
export interface ConsentLayers {
  /** Config documents OpenCode merges before the written file (earlier layers). */
  before?: readonly JsonValue[];
  /** Config documents OpenCode merges after the written file (later layers). */
  after?: readonly JsonValue[];
}

/**
 * Evaluates `command` against the layered configuration: the layers are merged with
 * {@link mergeDeep} in OpenCode's order, then the last matching rule wins.
 *
 * @param effective - The merged document.
 * @param variant - The detected OpenCode line.
 * @param command - The command text.
 * @param agent - An agent name whose `permission` is appended after the global rules, or `null`.
 * @returns The winning rule (`"ask"` when nothing matches).
 */
function ruleFor(
  effective: JsonObject,
  variant: string | null,
  command: string,
  agent: string | null,
): Rule {
  const migrate = variant === "v2";
  const v1Rules = rulesFromPermission(effective.permission, migrate);
  const global = migrate
    ? [...v1Rules, ...rulesFromNativePermissions(effective.permissions)]
    : v1Rules;
  let rules = global;
  if (agent !== null) {
    const agents = effective.agent;
    const entry = isObj(agents) ? agents[agent] : undefined;
    rules = [
      ...global,
      ...rulesFromPermission(isObj(entry) ? entry.permission : undefined, migrate),
    ];
  }
  return evaluate(migrate ? "shell" : "bash", command, rules);
}

/**
 * Decision OpenCode reaches for `command` over the layered configuration (global rules only).
 *
 * @param docs - Config documents in OpenCode's merge order (earliest first).
 * @param variant - The detected OpenCode line.
 * @param command - The command text.
 * @returns `"ask"`, `"allow"`, `"deny"` or whatever the winning rule says.
 */
export function effectiveDecision(
  docs: readonly JsonValue[],
  variant: string | null,
  command: string,
): string {
  const effective = docs.reduce<JsonValue | undefined>((acc, d) => mergeDeep(acc, d), undefined);
  return isObj(effective) ? ruleFor(effective, variant, command, null).effect : "ask";
}

/**
 * Mirrors OpenCode's own rule evaluation (last matching rule wins) for `dynamic-skills save` and
 * `dynamic-skills init`, over the configuration as OpenCode would see it: the document `init` is
 * about to write (after its merge) combined with the other config layers by `mergeDeep` key-order
 * semantics (Ruling R44), in OpenCode's layer order (global, project root, `.opencode`). The V1
 * `permission` object's own rules apply on the V1 line; on the V2 line, those same rules migrated
 * (`bash` renamed to `shell`) followed by the native `permissions` array, which OpenCode always
 * evaluates after every V1-derived rule (Ruling R34). Each agent's own `permission` is appended
 * after the global rules and is checked too.
 *
 * @param merged - The document after the planned merge is applied (as `mergeJson` would produce
 *   it).
 * @param variant - The detected OpenCode line.
 * @param path - The config file path, named in the note.
 * @param layers - The other layers, before and after `merged`.
 * @returns One note per probed command (and agent) whose consent ask is overridden; empty when
 *   every probe still asks.
 */
export function consentNotes(
  merged: JsonValue,
  variant: string | null,
  path: string,
  layers: ConsentLayers = {},
): string[] {
  if (!isObj(merged)) return [];
  const docs = [...(layers.before ?? []), merged, ...(layers.after ?? [])];
  const effective = docs.reduce<JsonValue | undefined>((acc, d) => mergeDeep(acc, d), undefined);
  if (!isObj(effective)) return [];
  const agents = isObj(effective.agent) ? Object.keys(effective.agent) : [];
  const notes: string[] = [];
  for (const probe of PROBES) {
    const global = ruleFor(effective, variant, probe.command, null);
    if (global.effect !== "ask") notes.push(noteFor(probe.label, global, path, null));
    for (const name of agents) {
      const rule = ruleFor(effective, variant, probe.command, name);
      if (rule.effect === "ask" || describe(rule) === describe(global)) continue;
      notes.push(noteFor(probe.label, rule, path, name));
    }
  }
  return notes;
}
