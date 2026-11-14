import { SkillNameSchema } from "@dynamic-skills/core";
import type {
  InvocationMode,
  SkillSufficiencyAssessment,
  SkillsScan,
  SufficiencyOutcome,
} from "@dynamic-skills/core";

/** Name of the bootstrap skill; it can never be the base of a sufficiency verdict. */
const BOOTSTRAP_SKILL = "dynamic-skill-bootstrap";

/**
 * Finds the scanned skill a verdict names. Name and path must both equal the scanned skill's by
 * exact string comparison: scanned paths are absolute and normalised, while a verdict path is
 * untrusted and `path.resolve` would accept relative paths (resolved against the cwd) and fold
 * `..` lexically, which can differ from what the OS opens when a symlink is involved.
 * Callers must persist the returned scanned skill's `path`, never the verdict's string.
 * @returns the matching scanned skill, or `null`.
 */
export function matchBaseSkill(
  verdict: { name: string; path: string },
  skills: SkillsScan["skills"],
): SkillsScan["skills"][number] | null {
  return skills.find((s) => s.name === verdict.name && s.path === verdict.path) ?? null;
}

/**
 * Checks an agent's sufficiency verdict against the session (PRD §5.5: "the core validates it").
 * Schema-level shape is already enforced by `SkillSufficiencyAssessmentSchema`; this covers the
 * rules that need scan and mode context. Every rule runs and every issue is returned (no
 * short-circuit) so the agent can fix them all in one revision. Pure.
 * @param a the parsed verdict.
 * @param ctx scanned skills, repo-relative scanned instruction files, invocation mode and
 * whether the user explicitly asked for a skill.
 * @returns issues in rule order; empty means valid.
 */
export function validateSufficiency(
  a: SkillSufficiencyAssessment,
  ctx: {
    skills: SkillsScan["skills"];
    instructionFiles: string[];
    mode: InvocationMode;
    explicit: boolean;
  },
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];

  if (a.baseSkill) {
    const { name, path } = a.baseSkill;
    const matched = matchBaseSkill({ name, path }, ctx.skills);
    if (!matched) {
      issues.push({ path: "baseSkill", message: "base skill is not among the scanned skills" });
    } else if (!SkillNameSchema.safeParse(matched.name).success) {
      issues.push({
        path: "baseSkill.name",
        message: "base skill name is not a valid Agent Skills name",
      });
    }
    if (name === BOOTSTRAP_SKILL) {
      issues.push({ path: "baseSkill.name", message: "the bootstrap skill cannot be a base" });
    }
  }

  if (
    a.baseInstructionFile !== undefined &&
    !ctx.instructionFiles.includes(a.baseInstructionFile)
  ) {
    issues.push({ path: "baseInstructionFile", message: "not a scanned instruction file" });
  }

  // PRD §5.5: an explicit request may still choose partial, but never reuse unchanged.
  if (ctx.explicit && a.outcome === "sufficient") {
    issues.push({
      path: "outcome",
      message: "an explicit request to create a skill allows only partial or insufficient",
    });
  }

  // Defence in depth: the CLI never reaches this state (PRD §5.4 Manual).
  if (ctx.mode === "manual" && !ctx.explicit) {
    issues.push({ path: "outcome", message: "manual mode requires an explicit request" });
  }
  return issues;
}

/**
 * Whether a verdict must wait for human approval (PRD §5.4 Suggest: recommends synthesis and
 * waits). Reusing a skill unchanged (`sufficient`) needs none. Pure.
 */
export function requiresApproval(
  outcome: SufficiencyOutcome,
  mode: InvocationMode,
  explicit: boolean,
): boolean {
  return mode === "suggest" && !explicit && outcome !== "sufficient";
}
