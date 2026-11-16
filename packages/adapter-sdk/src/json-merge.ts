import type { JsonObject, JsonValue } from "./types";

/** Promotion rule: a scalar at one of `paths` becomes `{ [key]: scalar, ...patchObject }`. */
export interface PromoteRule {
  /** Key paths at which promotion applies. */
  paths: string[][];
  /** Key that receives the former scalar. */
  key: string;
}

/** Result of {@link mergeJson}. */
export interface MergeResult {
  /** The merged value (existing values kept at every conflict). */
  value: JsonValue;
  /** Dotted paths that conflict; `""` for a non-object root. */
  conflicts: string[];
}

function isObj(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural equality of two JSON values (object key order ignored). */
export function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isObj(a)) {
    if (!isObj(b)) return false;
    const ka = Object.keys(a);
    return (
      ka.length === Object.keys(b).length &&
      ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
    );
  }
  return false;
}

/** Deep clone that defines own properties (a `__proto__` key stays a plain key). */
function clone(v: JsonValue): JsonValue {
  if (Array.isArray(v)) return v.map(clone);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
}

/**
 * Merges `patch` into `current` without ever overwriting a user value. Objects merge recursively
 * (existing keys keep their position, new keys are appended in patch order); arrays union
 * (existing order, deep-equal items not repeated); an equal scalar is unchanged; a different
 * scalar is a conflict at its dotted path and the existing value is kept; a scalar where the patch
 * has an object at a `promote.paths` path becomes `{ [promote.key]: scalar, ...patchObject }`; a
 * non-object root is a conflict at `""`. There is no force option.
 */
export function mergeJson(
  current: JsonValue | undefined,
  patch: JsonObject,
  opts: { promote?: PromoteRule } = {},
): MergeResult {
  const conflicts: string[] = [];
  const promote = opts.promote;
  const promotes = (path: string[]): boolean =>
    promote !== undefined &&
    promote.paths.some((p) => p.length === path.length && p.every((s, i) => s === path[i]));

  function merge(cur: JsonValue | undefined, pat: JsonValue, path: string[]): JsonValue {
    if (cur === undefined) return clone(pat);
    if (Array.isArray(pat)) {
      if (!Array.isArray(cur)) {
        conflicts.push(path.join("."));
        return cur;
      }
      const out = [...cur];
      for (const item of pat) if (!out.some((x) => jsonEqual(x, item))) out.push(clone(item));
      return out;
    }
    if (isObj(pat)) {
      let base = cur;
      if (promote !== undefined && promotes(path) && !isObj(cur) && !Array.isArray(cur)) {
        base = { [promote.key]: cur };
      }
      if (!isObj(base)) {
        conflicts.push(path.join("."));
        return cur;
      }
      const entries: [string, JsonValue][] = Object.entries(base);
      for (const [k, pv] of Object.entries(pat)) {
        const idx = entries.findIndex(([ek]) => ek === k);
        const at = idx >= 0 ? entries[idx] : undefined;
        if (at === undefined) entries.push([k, merge(undefined, pv, [...path, k])]);
        else at[1] = merge(at[1], pv, [...path, k]);
      }
      return Object.fromEntries(entries);
    }
    if (jsonEqual(cur, pat)) return cur;
    conflicts.push(path.join("."));
    return cur;
  }

  if (current === undefined) return { value: clone(patch), conflicts };
  if (!isObj(current)) return { value: current, conflicts: [""] };
  return { value: merge(current, patch, []), conflicts };
}

/** True when `actual` contains `patch` (deep subset; arrays contain every patch item). */
export function jsonContains(actual: JsonValue | undefined, patch: JsonValue): boolean {
  if (Array.isArray(patch)) {
    return Array.isArray(actual) && patch.every((p) => actual.some((a) => jsonEqual(a, p)));
  }
  if (isObj(patch)) {
    if (!isObj(actual)) return false;
    return Object.entries(patch).every(
      ([k, v]) => Object.hasOwn(actual, k) && jsonContains(actual[k], v),
    );
  }
  return jsonEqual(actual, patch);
}
