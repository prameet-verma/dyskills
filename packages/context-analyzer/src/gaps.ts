import type { Evidence, Gap, Requirement } from "@dynamic-skills/core";

/** Categories where absence of evidence is not a fact: the repo must be read to find out. */
const INSPECT_WHEN_MISSING = new Set(["architecture", "conventions"]);

/**
 * Compares requirements with discovered evidence (PRD §6.3).
 *
 * Evidence matches a requirement by equal category. A `humanOnly` requirement is answered only
 * by evidence keyed `user.<requirement id>`, otherwise it is `missing`/`ask`. For the rest the
 * order of checks is: any conflicting evidence wins (`conflicting`/`inspect`), then any verified
 * evidence (`verified`/`none`), then only inferred/assumed evidence (`needs-investigation`/
 * `inspect`); with no evidence, architecture and conventions need inspection while other
 * categories are `missing`/`none` (absence, e.g. no CI, is itself a fact).
 *
 * @param reqs - Requirements from {@link deriveRequirements}.
 * @param evidence - Registry contents.
 * @returns One gap per requirement, in input order; `evidenceKeys` are sorted. `material` is
 *   cleared once a requirement is verified.
 */
export function analyzeGaps(reqs: Requirement[], evidence: Evidence[]): Gap[] {
  return reqs.map((r) => {
    const matching = r.humanOnly
      ? evidence.filter((e) => e.key === `user.${r.id}`)
      : evidence.filter((e) => e.category === r.category);
    const evidenceKeys = matching.map((e) => e.key).sort();
    const has = (c: Evidence["confidence"]) => matching.some((e) => e.confidence === c);

    let status: Gap["status"];
    let resolution: Gap["resolution"];
    if (r.humanOnly) {
      // Only the user can answer; any user.<id> answer counts.
      [status, resolution] = matching.length ? ["verified", "none"] : ["missing", "ask"];
    } else if (has("conflicting")) {
      [status, resolution] = ["conflicting", "inspect"];
    } else if (has("verified")) {
      [status, resolution] = ["verified", "none"];
    } else if (matching.length) {
      [status, resolution] = ["needs-investigation", "inspect"];
    } else {
      [status, resolution] = ["missing", INSPECT_WHEN_MISSING.has(r.category) ? "inspect" : "none"];
    }
    return {
      requirement: r.id,
      category: r.category,
      status,
      resolution,
      evidenceKeys,
      material: r.material && status !== "verified",
    };
  });
}
