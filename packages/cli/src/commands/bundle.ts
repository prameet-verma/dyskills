import { join } from "node:path";
import { scanExistingSkills } from "@dynamic-skills/bootstrapper";
import type { ExistingSkill, SessionState } from "@dynamic-skills/core";

/** The bootstrap skill drives this CLI; it is never a candidate, a base or a duplicate. */
export const BOOTSTRAP_SKILL = "dynamic-skill-bootstrap";

/** Where the agent writes the skill bundle, the smoke eval and the brief, inside the session. */
export function sessionPaths(sessionDir: string): {
  brief: string;
  skillsDir: string;
  evalsDir: string;
  smoke: string;
} {
  const evalsDir = join(sessionDir, "evals");
  return {
    brief: join(sessionDir, "brief.md"),
    skillsDir: join(sessionDir, "skills"),
    evalsDir,
    smoke: join(evalsDir, "smoke.json"),
  };
}

/**
 * Skills already installed, as the brief and the duplication eval see them: the bootstrap skill is
 * left out, and so is the base of an augmentation (matched by its exact scanned path, Ruling R9),
 * because the augmentation is judged against the base separately (PRD §5.5).
 * @param state - The session (repository and sufficiency verdict).
 * @param userHome - Personal skill root.
 */
export async function existingSkillsFor(
  state: SessionState,
  userHome: string,
): Promise<ExistingSkill[]> {
  const scanned = await scanExistingSkills({ repo: state.repo, home: userHome });
  const basePath =
    state.sufficiency?.outcome === "partial" ? (state.sufficiency.baseSkill?.path ?? null) : null;
  return scanned.skills.filter((s) => s.name !== BOOTSTRAP_SKILL && s.path !== basePath);
}
