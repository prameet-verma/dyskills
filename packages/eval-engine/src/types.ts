import type {
  Assumption,
  EvalId,
  EvalOutcome,
  Evidence,
  ExistingSkill,
  GeneratedSkill,
  Gap,
  SmokeEval,
} from "@dynamic-skills/core";

/**
 * Augmentation facts an eval needs (PRD §5.5, FR-41, FR-42). Non-null exactly for a `partial`
 * sufficiency session; for it the CLI removes the base from `existingSkills`.
 */
export interface AugmentationContext {
  /** Name of the canonical base skill the augmentation extends. */
  baseName: string;
  /** sha256 of the base `SKILL.md` recorded at the verdict. */
  baseSha256: string;
  /** sha256 of the base `SKILL.md` hashed at evaluate time; differs when the base changed. */
  currentBaseSha256: string;
  /** Body of the base skill, for overlap checks. */
  baseBody: string;
}

/** Everything a generation eval may read. Evals never mutate it (PRD §9.1). */
export interface EvalContext {
  /** The user's task text. */
  task: string;
  /** The skill under evaluation. */
  skill: GeneratedSkill;
  /** Consolidated evidence the skill may cite. */
  evidence: Evidence[];
  /** Recorded assumptions. */
  assumptions: Assumption[];
  /** Current gaps. */
  gaps: Gap[];
  /** Skills already present in the repository (the base is excluded for an augmentation). */
  existingSkills: ExistingSkill[];
  /** Project instruction file excerpts, as plain text. */
  instructionTexts: string[];
  /** The agent-written smoke eval, or null when absent. */
  smokeEval: SmokeEval | null;
  /** Augmentation facts; null for a new skill. */
  augmentation: AugmentationContext | null;
}

/** What one eval returns: an outcome plus human-readable messages explaining it. */
export interface EvalRun {
  /** pass, warning, fail or not-applicable. */
  outcome: EvalOutcome;
  /** Findings; empty on a clean pass. */
  messages: string[];
}

/** One generation eval (PRD §9.1). `mandatory` evals block activation when they fail. */
export interface GenerationEval {
  /** Stable id used in reports. */
  id: EvalId;
  /** Whether a failure blocks activation (PRD §9.5). */
  mandatory: boolean;
  /**
   * Runs the eval. Deterministic, never throws for bad skill content (that is a `fail`).
   * @param ctx - The evaluation context.
   */
  run(ctx: EvalContext): Promise<EvalRun>;
}
