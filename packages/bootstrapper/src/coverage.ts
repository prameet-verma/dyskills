import type { ExistingSkill, InvocationMode } from "@dynamic-skills/core";

/** Name of the bootstrap skill itself; it must never be offered as a candidate. */
const BOOTSTRAP_SKILL = "dynamic-skill-bootstrap";

const MAX_CANDIDATES = 3;

// Generic words carry no topic signal. `create` and `skill` are included so that a request such
// as "Create a skill for reviewing GraphQL schemas" matches on its content words only.
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "our",
  "your",
  "are",
  "was",
  "will",
  "can",
  "all",
  "any",
  "new",
  "use",
  "using",
  "add",
  "make",
  "create",
  "skill",
  "skills",
  "please",
  "need",
  "want",
]);

/** Outcome of comparing a task with the skills that already exist. */
export interface CoverageAssessment {
  /** `discover` continues to context analysis; `none` stops (manual mode without explicit request). */
  recommendation: "discover" | "none";
  /** Up to 3 lexical candidate hints with a score in (0, 1], highest first. Not a verdict. */
  candidates: { name: string; path: string; score: number }[];
  /** Short human-readable explanation of the recommendation. */
  reason: string;
}

/** Unique lowercase alphanumeric tokens of at least 3 characters, minus stopwords. */
function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

/**
 * Ranks existing skills as lexical candidate hints and applies mode gating (PRD §5.4, §5.5). Pure.
 * Score is the share of the task's tokens found in a skill's name and description. A score never
 * decides reuse: sufficiency is judged by the agent after context analysis and checked by
 * `validateSufficiency`.
 * @param task the user's task text.
 * @param skills skills found by `scanExistingSkills`.
 * @param opts.explicit whether the user explicitly asked for a new skill.
 * @param opts.mode invocation mode of the session.
 */
export function assessCoverage(
  task: string,
  skills: ExistingSkill[],
  opts: { explicit: boolean; mode: InvocationMode },
): CoverageAssessment {
  const taskTokens = tokens(task);
  const candidates = skills
    .filter((s) => s.name !== BOOTSTRAP_SKILL)
    .map((s) => {
      const own = tokens(`${s.name} ${s.description}`);
      let hits = 0;
      for (const t of taskTokens) if (own.has(t)) hits++;
      const raw = taskTokens.size === 0 ? 0 : hits / taskTokens.size;
      return { name: s.name, path: s.path, raw };
    })
    .filter((c) => c.raw > 0)
    .sort((a, b) => b.raw - a.raw || a.name.localeCompare(b.name))
    .slice(0, MAX_CANDIDATES);

  const candidatesOut = candidates.map((c) => ({
    name: c.name,
    path: c.path,
    score: Math.round(c.raw * 100) / 100,
  }));

  // PRD §5.4 Manual: skills are created only on explicit request.
  if (opts.mode === "manual" && !opts.explicit) {
    return {
      recommendation: "none",
      candidates: candidatesOut,
      reason: "Manual mode: skills are only created on explicit request.",
    };
  }
  return {
    recommendation: "discover",
    candidates: candidatesOut,
    reason: "Candidates are hints; sufficiency is judged after context analysis (PRD §5.5).",
  };
}
