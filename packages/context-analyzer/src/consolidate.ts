import { isSecretPath, type RepoFileIndex } from "@dynamic-skills/discovery";
import {
  type Assumption,
  type ContextAnalysisResult,
  type ContextPacket,
  type Evidence,
  type Gap,
  type Requirement,
  type SemanticProbe,
} from "@dynamic-skills/core";
import { sanitizeEvidenceValue, type EvidenceRegistry } from "@dynamic-skills/evidence-registry";
import { analyzeGaps } from "./gaps";

export type { SemanticProbe };

/**
 * Turns free text into a stable identifier fragment.
 *
 * @param text - Any text.
 * @param max - Maximum length of the result (default 40).
 * @returns Lowercase, `-`-separated, trimmed; `"item"` when nothing alphanumeric remains.
 */
export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "item";
}

/**
 * Recomputes gaps after the registry changed (PRD §6.3, §7).
 *
 * Once the agent has analysed the packet (`analysed`), inspection has happened, so every
 * remaining `inspect` resolution is settled: a material conflict goes to the user (`ask`),
 * anything else stays an inference or open gap (`none`). This guarantees the
 * request/submit loop terminates.
 *
 * @param requirements - Current requirements.
 * @param evidence - Registry contents.
 * @param analysed - True after a validated analysis result has been consolidated.
 * @returns One gap per requirement.
 */
export function recomputeGaps(
  requirements: Requirement[],
  evidence: Evidence[],
  analysed: boolean,
): Gap[] {
  const gaps = analyzeGaps(requirements, evidence);
  if (!analysed) return gaps;
  return gaps.map((g) =>
    g.resolution === "inspect"
      ? { ...g, resolution: g.status === "conflicting" && g.material ? "ask" : "none" }
      : g,
  );
}

/** Strips a leading `./` and a trailing `:<line>[-<line>]` or `#L<n>[-L<m>]` locator. */
function normaliseSource(source: string): string {
  return source.replace(/^(\.\/)+/, "").replace(/(:\d+(-\d+)?|#L\d+(-L\d+)?)$/, "");
}

/** Applies {@link sanitizeEvidenceValue} to every string inside a JSON-like value. */
function sanitizeDeep<T>(value: T): T {
  if (typeof value === "string") return sanitizeEvidenceValue(value) as T;
  if (Array.isArray(value)) return value.map(sanitizeDeep) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeDeep(v)])) as T;
  return value;
}

/** Inputs of {@link consolidateAnalysis}. */
export interface ConsolidateInput {
  /** Validated analysis result. */
  result: ContextAnalysisResult;
  /** Evidence registry; mutated. */
  registry: EvidenceRegistry;
  /** Packet the result analysed (its relevant files count as resolvable sources). */
  packet: ContextPacket;
  /** File index (indexed paths count as resolvable sources). */
  files: RepoFileIndex;
  /** Requirements so far. */
  requirements: Requirement[];
  /** Assumptions so far (used only to continue `analysis-<n>` numbering). */
  assumptions: Assumption[];
  /** Repository revision recorded on new evidence. */
  revision: string;
}

/** Output of {@link consolidateAnalysis}. */
export interface ConsolidateOutput {
  /** The result with every string sanitised. */
  normalised: ContextAnalysisResult;
  /** Keys of evidence recorded from the result's evidence list, in order. */
  evidenceAdded: string[];
  /** Keys of `observed` claims recorded as `inferred` for lack of a resolvable source. */
  downgraded: string[];
  /** Input requirements plus new `unknown.*` ones. */
  requirements: Requirement[];
  /** The new assumptions only. */
  assumptions: Assumption[];
  /** Gaps recomputed with `analysed = true`. */
  gaps: Gap[];
  /** Human-readable warnings, including downgrades. */
  warnings: string[];
}

/**
 * Merges an agent's Context Analysis Result into evidence, requirements and assumptions
 * (PRD §6.3 "Evidence Consolidation", §6.6, §7, FR-10..12).
 *
 * The agent is untrusted: an `observed` claim is only `verified` when its source resolves to
 * a non-secret indexed file, a packet relevant file or a non-agentic evidence key (PRD §6.9
 * #6); otherwise it is recorded as `inferred` with a warning. Mutates `registry` only.
 *
 * @param input - See {@link ConsolidateInput}.
 * @returns See {@link ConsolidateOutput}.
 */
export function consolidateAnalysis(input: ConsolidateInput): ConsolidateOutput {
  const { registry } = input;
  const normalised = sanitizeDeep(input.result);
  const indexed = new Set(input.files.files);
  const inPacket = new Set(input.packet.relevantFiles.map((f) => f.path));
  const resolvable = (source: string): boolean => {
    const s = normaliseSource(source);
    if (isSecretPath(s)) return false;
    if (indexed.has(s) || inPacket.has(s)) return true;
    const existing = registry.get(s);
    return existing !== undefined && existing.origin !== "agentic";
  };

  const evidenceAdded: string[] = [];
  const downgraded: string[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, number>();
  for (const item of input.result.evidence) {
    const base = `agentic.${item.category}.${item.key ?? slugify(item.claim)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const key = n === 1 ? base : `${base}-${n}`;
    let confidence: Evidence["confidence"] = "inferred";
    if (item.type === "observed") {
      if (resolvable(item.source)) confidence = "verified";
      else {
        downgraded.push(key);
        warnings.push(`observed claim ${key} has no resolvable source; recorded as inferred`);
      }
    }
    registry.add({
      key,
      value: item.claim,
      source: item.source,
      category: item.category,
      confidence,
      revision: input.revision,
      origin: "agentic",
    });
    evidenceAdded.push(key);
  }

  for (const c of input.result.conflicts) {
    registry.add({
      key: `agentic.conflict.${slugify(c.subject)}`,
      value: c.subject,
      source: c.sources.join(", "),
      category: c.category ?? "semantic",
      confidence: "conflicting",
      revision: input.revision,
      origin: "agentic",
      conflicts: c.observations.map((o, i) => `${o} (${c.sources[i] ?? c.sources[0]})`),
    });
  }

  // Continue numbering after the highest existing analysis-<n> so ids stay unique and citable.
  let n = input.assumptions.reduce((max, a) => {
    const m = /^analysis-(\d+)$/.exec(a.questionId);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  const assumptions: Assumption[] = normalised.assumptions.map((a) => ({
    questionId: `analysis-${++n}`,
    question: a.subject,
    assumption: a.assumption,
    basis: a.basis,
    impact: a.impact,
    status: "not-asked",
  }));

  const requirements = [...input.requirements];
  for (const u of normalised.unknowns) {
    const id = `unknown.${slugify(u.question)}`;
    if (requirements.some((r) => r.id === id)) continue;
    requirements.push({
      id,
      category: u.category ?? "user",
      description: u.question,
      humanOnly: true,
      material: u.importance === "critical",
    });
  }

  return {
    normalised,
    evidenceAdded,
    downgraded,
    requirements,
    assumptions,
    gaps: recomputeGaps(requirements, registry.toJSON(), true),
    warnings,
  };
}
