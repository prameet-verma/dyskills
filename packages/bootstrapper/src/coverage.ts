import type { ExistingSkill, InvocationMode } from "@dynamic-skills/core";

/** Name of the bootstrap skill itself; it must never be offered as a reuse candidate. */
const BOOTSTRAP_SKILL = "dynamic-skill-bootstrap";

/** Minimum score at which an existing skill is considered to cover the task (PRD §5.2). */
const REUSE_THRESHOLD = 0.5;

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
  /** What to do: reuse a skill, synthesize one, only suggest synthesis, or do nothing. */
  recommendation: "reuse" | "synthesize" | "suggest-synthesis" | "none";
  /** Up to 3 best-matching existing skills with a score in (0, 1], highest first. */
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
 * Decides whether a task is already covered by an existing skill (PRD §5.2). Pure.
 * Score is the share of the task's tokens found in a skill's name and description.
 * Rules apply in order: explicit request, manual mode, strong match, suggest mode, default.
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

  const top = candidates[0];
  // The threshold compares the raw score; rounding is for display only (0.496 must not reuse).
  const candidatesOut = candidates.map((c) => ({
    name: c.name,
    path: c.path,
    score: Math.round(c.raw * 100) / 100,
  }));
  const done = (
    recommendation: CoverageAssessment["recommendation"],
    reason: string,
  ): CoverageAssessment => ({ recommendation, candidates: candidatesOut, reason });

  if (opts.explicit) return done("synthesize", "A new skill was explicitly requested.");
  if (opts.mode === "manual") {
    return done("none", "Manual mode: skills are only created on explicit request.");
  }
  if (top && top.raw >= REUSE_THRESHOLD) {
    return done(
      "reuse",
      `Existing skill "${top.name}" already covers this task (score ${Math.round(top.raw * 100) / 100}).`,
    );
  }
  if (opts.mode === "suggest") {
    return done("suggest-synthesis", "No existing skill covers this task; suggest creating one.");
  }
  return done("synthesize", "No existing skill covers this task; create one.");
}
