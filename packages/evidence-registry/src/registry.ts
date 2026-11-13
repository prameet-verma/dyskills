import type { Confidence, Evidence, EvidenceCategory } from "@dynamic-skills/core";
import { sanitizeEvidenceValue } from "./sanitize.js";

/** Input accepted by {@link EvidenceRegistry.add}; `timestamp` defaults to now. */
export interface EvidenceInput {
  key: string;
  value: string;
  category: EvidenceCategory;
  source: string;
  confidence: Confidence;
  revision: string;
  timestamp?: string;
}

/** Strength order used when identical observations merge; higher wins. */
const STRENGTH: Record<Confidence, number> = {
  verified: 3,
  inferred: 2,
  assumed: 1,
  conflicting: 0,
};

/**
 * In-memory store of discovered facts with provenance (PRD §6.4, §6.5). One entry per key;
 * disagreement between sources is recorded rather than resolved, so the gap analysis and the
 * user can see it.
 */
export class EvidenceRegistry {
  private readonly entries = new Map<string, Evidence>();

  /**
   * Records an observation, sanitising its value.
   *
   * Merge rule: same key and value keeps one entry (strongest confidence, first source).
   * A different value turns the entry `conflicting`; `conflicts` then lists
   * `"<value> (<source>)"` for every distinct observation and `value` stays the first one seen.
   * A conflicting entry stays conflicting.
   *
   * @param e - The observation.
   * @returns The resulting (merged) entry.
   */
  add(e: EvidenceInput): Evidence {
    const value = sanitizeEvidenceValue(e.value);
    const existing = this.entries.get(e.key);
    if (!existing) {
      const created: Evidence = {
        key: e.key,
        value,
        category: e.category,
        source: e.source,
        confidence: e.confidence,
        timestamp: e.timestamp ?? new Date().toISOString(),
        revision: e.revision,
        conflicts: [],
      };
      this.entries.set(e.key, created);
      return { ...created };
    }
    const observed = `${value} (${e.source})`;
    if (existing.confidence === "conflicting" || existing.value !== value) {
      if (existing.confidence !== "conflicting") {
        existing.conflicts = [`${existing.value} (${existing.source})`];
        existing.confidence = "conflicting";
      }
      if (!existing.conflicts.includes(observed)) existing.conflicts.push(observed);
    } else if (STRENGTH[e.confidence] > STRENGTH[existing.confidence]) {
      existing.confidence = e.confidence;
    }
    return { ...existing, conflicts: [...existing.conflicts] };
  }

  /**
   * Looks up one entry.
   *
   * @param key - Evidence key.
   * @returns A copy of the entry, or `undefined` if unknown.
   */
  get(key: string): Evidence | undefined {
    const e = this.entries.get(key);
    return e && { ...e, conflicts: [...e.conflicts] };
  }

  /**
   * Lists entries, optionally filtered.
   *
   * @param filter - Optional category and/or confidence to match.
   * @returns Copies of matching entries in insertion order.
   */
  list(filter?: { category?: EvidenceCategory; confidence?: Confidence }): Evidence[] {
    return [...this.entries.values()]
      .filter(
        (e) =>
          (!filter?.category || e.category === filter.category) &&
          (!filter?.confidence || e.confidence === filter.confidence),
      )
      .map((e) => ({ ...e, conflicts: [...e.conflicts] }));
  }

  /**
   * Tells whether a fact is directly established.
   *
   * @param key - Evidence key.
   * @returns True only when the entry exists with `verified` confidence.
   */
  isVerified(key: string): boolean {
    return this.entries.get(key)?.confidence === "verified";
  }

  /**
   * Serialises the registry for persistence in session state.
   *
   * @returns All entries as plain data.
   */
  toJSON(): Evidence[] {
    return this.list();
  }

  /**
   * Rebuilds a registry from persisted entries without re-merging or re-sanitising them.
   *
   * @param items - Entries previously produced by {@link EvidenceRegistry.toJSON}.
   * @returns A registry holding exactly those entries.
   */
  static fromJSON(items: Evidence[]): EvidenceRegistry {
    const r = new EvidenceRegistry();
    for (const e of items) r.entries.set(e.key, { ...e, conflicts: [...e.conflicts] });
    return r;
  }
}
