import type { Harness } from "@dynamic-skills/core";
import type { ReadRoot } from "./types";

/**
 * Chooses the fewest skill roots that every selected harness reads. Candidates are the selected
 * harnesses' primary roots; the candidate read by the most still-uncovered harnesses wins each
 * round (ties: earliest in `harnesses`). A harness reads a root when some `readRoots` entry for
 * that directory lists it in `readBy`, or when the root is its own primary. `covers` lists the
 * harnesses newly covered by that target, in `harnesses` order. A harness without a primary root
 * is left uncovered.
 */
export function planSaveTargets(input: {
  harnesses: Harness[];
  primary: Partial<Record<Harness, string>>;
  readRoots: Partial<Record<Harness, ReadRoot[]>>;
}): { root: string; covers: Harness[] }[] {
  const readers = new Map<string, Set<Harness>>();
  for (const list of Object.values(input.readRoots)) {
    for (const r of list ?? []) {
      const set = readers.get(r.dir) ?? new Set<Harness>();
      for (const h of r.readBy) set.add(h);
      readers.set(r.dir, set);
    }
  }
  const candidates: string[] = [];
  for (const h of input.harnesses) {
    const p = input.primary[h];
    if (p !== undefined && !candidates.includes(p)) candidates.push(p);
  }
  const reads = (root: string, h: Harness): boolean =>
    input.primary[h] === root || (readers.get(root)?.has(h) ?? false);

  const uncovered = new Set(input.harnesses);
  const out: { root: string; covers: Harness[] }[] = [];
  while (uncovered.size > 0) {
    let best: { root: string; covers: Harness[] } | null = null;
    for (const root of candidates) {
      const covers = input.harnesses.filter((h) => uncovered.has(h) && reads(root, h));
      if (covers.length > (best?.covers.length ?? 0)) best = { root, covers };
    }
    if (best === null) break;
    for (const h of best.covers) uncovered.delete(h);
    out.push(best);
  }
  return out;
}
