import { mkdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  ContextAnalysisResultSchema,
  PRIVATE_DIR_MODE,
  SkillSufficiencyAssessmentSchema,
  SlaClock,
} from "@dynamic-skills/core";
import { augmentationName, buildCompilationBrief } from "@dynamic-skills/skill-compiler";
import {
  CliError,
  FALLBACK,
  parseDocument,
  readBaseSkillFile,
  readEvidence,
  requireArtifactJson,
} from "../io";
import { existingSkillsFor, sessionPaths } from "./bundle";
import type { SessionCommandDef } from "./types";

/**
 * Resolves where an augmentation's `SKILL.md` must be written and checks that the path stays inside
 * `<sessionDir>/skills/`. The base name is already validated against the kebab-case pattern; this
 * is defence in depth for a hand-edited session (PRD §5.5, FR-42: nothing is written next to the
 * base).
 */
function augmentationPath(skillsDir: string, baseName: string): string {
  const skillPath = join(skillsDir, augmentationName(baseName), "SKILL.md");
  const rel = relative(skillsDir, resolve(skillPath));
  if (rel === "" || rel.startsWith("..") || rel.split(sep).includes("..")) {
    throw new CliError("VERDICT_INVALID", "The augmentation path is not allowed.", {
      issues: [
        {
          path: "baseSkill.name",
          message: "augmentation path escapes the session skills directory",
        },
      ],
    });
  }
  return skillPath;
}

/**
 * `compile`: writes the compilation brief the agent turns into a skill bundle (PRD §8, §6.9 #8).
 * Nothing reaches the brief without a validated Context Analysis Result. For a `partial` verdict
 * the base `SKILL.md` is read safely, must still hash to the sha256 pinned at the verdict
 * (otherwise `BASE_CHANGED`), and is shown to the agent read-only; the augmentation is written
 * under the session `skills/` directory, never next to the base. A changed base ends the session
 * as `failed` (saved, reports written, exit 1 `BASE_CHANGED`; Ruling R20). Everything this
 * command writes lives in the session directory.
 */
export const compileCommand: SessionCommandDef = {
  name: "compile",
  kind: "session",
  description: "Write the compilation brief and prepare the skill and eval directories.",
  options: [],
  step: "compile",
  stage: "compilation",
  async run({ store, state, userHome, now }) {
    const sufficiency = state.sufficiency;
    if (sufficiency === null) throw new CliError("INTERNAL", "No sufficiency verdict is recorded.");
    const sessionDir = store.dir(state.id);
    const paths = sessionPaths(sessionDir);
    const partial = sufficiency.outcome === "partial";

    let skillPath: string | null = null;
    if (partial) {
      if (sufficiency.baseSkill === null)
        throw new CliError("INTERNAL", "A partial verdict has no base.");
      skillPath = augmentationPath(paths.skillsDir, sufficiency.baseSkill.name);
    }

    const analysisText = await store.readArtifact(state.id, "context-analysis.json");
    if (analysisText === null) {
      throw new CliError("INVALID_STATE", "No context analysis was submitted yet.", {
        expected: ["context-submit"],
      });
    }
    const analysis = parseDocument(ContextAnalysisResultSchema, analysisText);

    let augmentation: Parameters<typeof buildCompilationBrief>[0]["augmentation"] = null;
    if (partial && sufficiency.baseSkill !== null) {
      const base = sufficiency.baseSkill;
      const verdict = await requireArtifactJson(
        store,
        state.id,
        "sufficiency.json",
        SkillSufficiencyAssessmentSchema,
      );
      const read = await readBaseSkillFile(base.path);
      // A base that vanished or became unreadable is a changed base (PRD §5.5, FR-42). One
      // verdict per session means no new verdict can be submitted, so the session can never
      // progress: it ends as a saved failure with reports (Ruling R20), not a discarded error.
      if (!read.ok || read.sha256 !== base.sha256) {
        state.status = "failed";
        state.metrics.outcome = "failed";
        return {
          ok: false,
          exitCode: 1,
          error: {
            code: "BASE_CHANGED",
            message: "The base skill changed after the verdict was recorded.",
          },
          recordStep: false,
          writeReports: true,
          data: { fallback: FALLBACK },
        };
      }
      augmentation = {
        baseName: base.name,
        basePath: base.path,
        baseSha256: base.sha256,
        baseBody: read.content,
        missingAspects: verdict.missingAspects,
        coveredAspects: verdict.coveredAspects,
      };
    }

    const brief = buildCompilationBrief({
      state,
      evidence: await readEvidence(store, state.id),
      gaps: state.gaps,
      assumptions: state.assumptions,
      analysis,
      existingSkills: await existingSkillsFor(state, userHome),
      augmentation,
      sessionDir,
      remainingMs: SlaClock.from(state.sla).remainingMs(now()),
    });
    await store.writeArtifact(state.id, "brief.md", brief);
    await mkdir(paths.skillsDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    await mkdir(paths.evalsDir, { recursive: true, mode: PRIVATE_DIR_MODE });

    state.status = "generating";
    state.metrics.llmInteractions += 1;
    return {
      data: {
        briefPath: paths.brief,
        skillsDir: paths.skillsDir,
        skillPath,
        mode: partial ? "augmentation" : "new",
        smokeEvalPath: paths.smoke,
        remainingMs: SlaClock.from(state.sla).remainingMs(now()),
      },
    };
  },
};
