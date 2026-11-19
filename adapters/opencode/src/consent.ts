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
  /** True for OpenCode's built-in default, which no config layer wrote. */
  builtin?: boolean;
  /** Which rule group the rule came from: the global rules or an agent's own. */
  group?: "global" | "agent";
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

/** OpenCode's own evaluation: the last rule whose action and pattern both match, else the built-in allow. */
function evaluate(action: string, command: string, rules: readonly Rule[]): Rule {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (wildcardMatch(action, rule.action) && wildcardMatch(command, rule.pattern)) return rule;
  }
  // OpenCode's built-in base rule (`*`: allow); shell commands are allowed unless a rule says otherwise.
  return { action, pattern: "*", effect: "allow", builtin: true };
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
 * reported as a defeat, naming the rule and the file it comes from, and advising it be moved or
 * removed.
 *
 * @param label - `"save"` or `"init"`.
 * @param rule - The winning rule.
 * @param source - The config file the winning rule comes from (`null` for the built-in default).
 * @param agent - The agent whose permission produced the result, or `null` for the global rules.
 * @returns The note text.
 */
function noteFor(
  label: string,
  rule: Rule,
  source: string | null,
  agent: string | null,
  ownWrite: boolean,
): string {
  const who = agent === null ? "" : ` for agent \`${agent}\``;
  const from = source === null ? "OpenCode's built-in default" : source;
  if (rule.effect === "allow" && isDocumentedOptOut(label, rule.pattern)) {
    return `Consent for \`dynamic-skills ${label}\` is lifted${who} by your rule ${describe(rule)} from ${from} (a documented opt-out, not a defeat).`;
  }
  if (rule.effect === "deny") {
    return `\`dynamic-skills ${label}\` is denied${who}, not asked, by ${describe(rule)} from ${from} (stricter than the consent entry, not a defeat).`;
  }
  return (
    `D6 consent for \`dynamic-skills ${label}\` will not apply${who} once OpenCode merges its configuration layers: ` +
    `${describe(rule)} from ${from} wins (OpenCode evaluates the last matching rule). ` +
    (ownWrite
      ? "That rule is an entry init itself writes; fix the earlier or later layer that conflicts with it, or edit the entry, rather than moving it."
      : "Move or remove that rule so the consent entry is evaluated last.")
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

/** One config document and the file it came from. */
export interface Layer {
  /** The file the document was read from (named in notes). */
  path: string;
  /** The parsed document. */
  doc: JsonValue;
}

/** Layers merged before and after the document `init` writes (Ruling R44). */
export interface ConsentLayers {
  /** Layers OpenCode merges before the written file (earlier layers). */
  before?: readonly Layer[];
  /** Layers OpenCode merges after the written file (later layers). */
  after?: readonly Layer[];
  /** Probe labels (`save`, `init`) whose deny is already explained by an `init` note. */
  skip?: ReadonlySet<string>;
  /** Patterns of the entries `init` itself writes; the advice never tells the user to move those. */
  own?: ReadonlySet<string>;
}

/** Agent entries of a document: `agent`, and on the v2 line also `agents` (spike section 5). */
function agentEntries(doc: JsonObject, variant: string | null): Map<string, JsonValue> {
  const out = new Map<string, JsonValue>();
  for (const key of variant === "v2" ? ["agent", "agents"] : ["agent"]) {
    const group = doc[key];
    if (!isObj(group)) continue;
    for (const [name, entry] of Object.entries(group)) out.set(name, entry);
  }
  return out;
}

/** The rules of one document's own permission blocks (global, then optionally one agent's). */
function docRules(doc: JsonValue, variant: string | null, agent: string | null): Rule[] {
  if (!isObj(doc)) return [];
  const migrate = variant === "v2";
  const global = [
    ...rulesFromPermission(doc.permission, migrate),
    ...(migrate ? rulesFromNativePermissions(doc.permissions) : []),
  ];
  if (agent === null) return global;
  const entry = agentEntries(doc, variant).get(agent);
  return isObj(entry) ? rulesFromPermission(entry.permission, migrate) : [];
}

/**
 * Evaluates `command` against the layered configuration: the layers are merged with
 * {@link mergeDeep} in OpenCode's order and flattened (V1 rules, then on v2 the native
 * `permissions` array, then the agent's own `permission`), then the last matching rule wins. The
 * layer the winning rule came from is the last one whose own document carries that action and
 * pattern.
 *
 * @param layers - Config layers in merge order (earliest first).
 * @param variant - The detected OpenCode line.
 * @param command - The command text.
 * @param agent - An agent name whose `permission` is appended after the global rules, or `null`.
 * @returns The winning rule and its source file (`null` for the built-in default).
 */
function resolve(
  layers: readonly Layer[],
  variant: string | null,
  command: string,
  agent: string | null,
): { rule: Rule; source: string | null } {
  const effective = layers.reduce<JsonValue | undefined>(
    (acc, l) => mergeDeep(acc, l.doc),
    undefined,
  );
  const migrate = variant === "v2";
  let rules: Rule[] = [];
  if (isObj(effective)) {
    rules = docRules(effective, variant, null).map((r) => ({ ...r, group: "global" as const }));
    if (agent !== null) {
      rules = [
        ...rules,
        ...docRules(effective, variant, agent).map((r) => ({ ...r, group: "agent" as const })),
      ];
    }
  }
  const rule = evaluate(migrate ? "shell" : "bash", command, rules);
  if (rule.builtin === true) return { rule, source: null };
  for (let i = layers.length - 1; i >= 0; i--) {
    const own = docRules(layers[i]!.doc, variant, rule.group === "agent" ? agent : null);
    if (
      own.some(
        (r) => r.action === rule.action && r.pattern === rule.pattern && r.effect === rule.effect,
      )
    ) {
      return { rule, source: layers[i]!.path };
    }
  }
  return { rule, source: null };
}

/**
 * Decision OpenCode reaches for `command` over the layered configuration (global rules only).
 *
 * @param docs - Config documents in OpenCode's merge order (earliest first).
 * @param variant - The detected OpenCode line.
 * @param command - The command text.
 * @returns `"ask"`, `"allow"`, `"deny"` or whatever the winning rule says; `"allow"` when no rule
 *   matches, OpenCode's built-in shell default.
 */
export function effectiveDecision(
  docs: readonly JsonValue[],
  variant: string | null,
  command: string,
): string {
  return resolve(
    docs.map((doc) => ({ path: "", doc })),
    variant,
    command,
    null,
  ).rule.effect;
}

/**
 * The winning global rule for `command` over `layers` (used by `init` to see an existing deny).
 *
 * @param layers - Config layers in merge order.
 * @param variant - The detected OpenCode line.
 * @param command - The command text.
 * @returns The effect and the file it came from.
 */
export function resolveCommand(
  layers: readonly Layer[],
  variant: string | null,
  command: string,
): { effect: string; pattern: string; source: string | null } {
  const { rule, source } = resolve(layers, variant, command, null);
  return { effect: rule.effect, pattern: rule.pattern, source };
}

/**
 * Mirrors OpenCode's own rule evaluation (last matching rule wins) for `dynamic-skills save` and
 * `dynamic-skills init`, over the configuration as OpenCode would see it: the document `init` is
 * about to write (after its merge) combined with the other config layers by `mergeDeep` key-order
 * semantics (Rulings R44), in OpenCode's layer order (global, project root, `.opencode`). The V1
 * `permission` object's own rules apply on the V1 line; on the V2 line, those same rules migrated
 * (`bash` renamed to `shell`) followed by the native `permissions` array, which OpenCode always
 * evaluates after every V1-derived rule (Ruling R34). Each agent's own `permission` (`agent`, and
 * on v2 `agents`) is appended after the global rules and checked too. A command no rule matches is
 * allowed (OpenCode's built-in default).
 *
 * This is an approximation. Not modelled: `OPENCODE_CONFIG` and `OPENCODE_CONFIG_CONTENT`,
 * `~/.opencode`, config discovered by walking up to parent directories, markdown agents in
 * `agents/*.md` with frontmatter `permission`, and the exact v2 merge semantics (assumed to match
 * v1's `mergeDeep`).
 *
 * @param merged - The document after the planned merge is applied (as `mergeJson` would produce
 *   it).
 * @param variant - The detected OpenCode line.
 * @param path - The config file path `merged` is written to.
 * @param layers - The other layers, before and after `merged`.
 * @returns One note per probed command (and agent) whose consent ask is overridden, naming the
 *   file the winning rule comes from; empty when every probe still asks.
 */
export function consentNotes(
  merged: JsonValue,
  variant: string | null,
  path: string,
  layers: ConsentLayers = {},
): string[] {
  if (!isObj(merged)) return [];
  const all = [...(layers.before ?? []), { path, doc: merged }, ...(layers.after ?? [])];
  const effective = all.reduce<JsonValue | undefined>((acc, l) => mergeDeep(acc, l.doc), undefined);
  if (!isObj(effective)) return [];
  const agents = [...agentEntries(effective, variant).keys()];
  const notes: string[] = [];
  for (const probe of PROBES) {
    const global = resolve(all, variant, probe.command, null);
    const ownWrite = (r: Rule, source: string | null): boolean =>
      source === path && (layers.own?.has(r.pattern) ?? false);
    const covered = (r: Rule): boolean =>
      r.effect === "deny" && (layers.skip?.has(probe.label) ?? false);
    if (global.rule.effect !== "ask" && !covered(global.rule)) {
      notes.push(
        noteFor(
          probe.label,
          global.rule,
          global.source,
          null,
          ownWrite(global.rule, global.source),
        ),
      );
    }
    for (const name of agents) {
      const r = resolve(all, variant, probe.command, name);
      if (r.rule.effect === "ask" || describe(r.rule) === describe(global.rule)) continue;
      notes.push(noteFor(probe.label, r.rule, r.source, name, ownWrite(r.rule, r.source)));
    }
  }
  return notes;
}
