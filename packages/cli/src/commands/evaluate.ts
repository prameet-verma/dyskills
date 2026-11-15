import { MAX_EVAL_ATTEMPTS, SkillsScanSchema } from "@dynamic-skills/core";
import type { SessionState } from "@dynamic-skills/core";
import { createRepoReader } from "@dynamic-skills/discovery";
import { runEvaluations } from "@dynamic-skills/eval-engine";
import type { AugmentationContext, EvalContext } from "@dynamic-skills/eval-engine";
import { fingerprintFile } from "@dynamic-skills/evidence-registry";
import { loadSmokeEval, parseSkillBundle } from "@dynamic-skills/skill-compiler";
import { FALLBACK, readBaseSkillFile, readEvidence, requireArtifactJson, toJson } from "../io";
import { bundleChanged, bundleDigest, existingSkillsFor, sessionPaths } from "./bundle";
import type { SessionCommandDef } from "./types";

/** Longest bundle error text returned to the agent. */
const MAX_ERROR_CHARS = 300;

/** Short, single-line text for a bundle or smoke-eval failure. */
function describeBundleFailure(e: unknown): string {
  // A JSON parse error quotes the file; never echo agent-controlled file content.
  if (e instanceof SyntaxError) return "smoke.json is not valid JSON";
  const text = e instanceof Error ? e.message : "unreadable bundle";
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_ERROR_CHARS ? `${line.slice(0, MAX_ERROR_CHARS - 1)}…` : line;
}

/**
 * Augmentation facts for the evals: the base as recorded at the verdict and as it is now. A base
 * that vanished or cannot be read safely hashes to `""`, which the metadata eval reports as a
 * changed base (PRD §5.5, FR-42).
 */
async function augmentationContext(
  sufficiency: NonNullable<SessionState["sufficiency"]>,
): Promise<AugmentationContext | null> {
  if (sufficiency.outcome !== "partial" || sufficiency.baseSkill === null) return null;
  const base = sufficiency.baseSkill;
  const read = await readBaseSkillFile(base.path);
  return {
    baseName: base.name,
    baseSha256: base.sha256,
    currentBaseSha256: await fingerprintFile(base.path).catch(() => ""),
    baseBody: read.ok ? read.content : "",
  };
}

/**
 * `evaluate`: runs the 14 generation evals on the skill bundle the agent wrote (PRD §9). Every
 * call counts as an attempt (`MAX_EVAL_ATTEMPTS`, so revision is bounded); the attempt is saved
 * even when the bundle cannot be parsed. Exhausting the attempts ends the session as `failed`.
 * An evaluation that finds problems still exits 0: `activatable` and `revisionHints` tell the
 * agent what to fix.
 */
export const evaluateCommand: SessionCommandDef = {
  name: "evaluate",
  kind: "session",
  description: "Run the generation evaluations on the skill in the session directory.",
  options: [],
  step: "evaluate",
  stage: "evaluation",
  async run({ store, state, userHome }) {
    const sufficiency = state.sufficiency;
    state.evalAttempts += 1;
    // Ruling R14: no pin survives into an attempt, so a failed attempt cannot leave a stale one.
    state.evaluatedBundleSha256 = undefined;
    const attempt = state.evalAttempts;
    const attemptsRemaining = Math.max(0, MAX_EVAL_ATTEMPTS - attempt);
    if (attempt > MAX_EVAL_ATTEMPTS) {
      state.status = "failed";
      state.metrics.outcome = "failed";
      return {
        ok: false,
        exitCode: 2,
        error: {
          code: "EVAL_ATTEMPTS_EXHAUSTED",
          message: `The skill did not pass evaluation within ${MAX_EVAL_ATTEMPTS} attempts.`,
        },
        data: { attempt, attemptsRemaining: 0, fallback: FALLBACK },
        recordStep: false,
        writeReports: true,
      };
    }

    const paths = sessionPaths(store.dir(state.id));
    let skill: Awaited<ReturnType<typeof parseSkillBundle>>;
    let smokeEval: Awaited<ReturnType<typeof loadSmokeEval>>;
    let digest: string;
    try {
      digest = await bundleDigest(store.dir(state.id));
      skill = await parseSkillBundle(paths.skillsDir);
      smokeEval = await loadSmokeEval(paths.smoke);
    } catch (e) {
      // The attempt is kept so a broken bundle cannot be retried without bound.
      return {
        ok: false,
        exitCode: 2,
        error: { code: "BUNDLE_INVALID", message: describeBundleFailure(e) },
        data: { attempt, attemptsRemaining },
        recordStep: false,
      };
    }

    const scan = await requireArtifactJson(store, state.id, "skills-scan.json", SkillsScanSchema);
    const read = createRepoReader(state.repo);
    const instructionTexts: string[] = [];
    for (const rel of scan.instructionFiles) {
      const text = await read(rel);
      if (text !== null) instructionTexts.push(text);
    }
    const ctx: EvalContext = {
      task: state.task,
      skill,
      evidence: await readEvidence(store, state.id),
      assumptions: state.assumptions,
      gaps: state.gaps,
      existingSkills: await existingSkillsFor(state, userHome),
      instructionTexts,
      smokeEval,
      augmentation: sufficiency ? await augmentationContext(sufficiency) : null,
    };
    const report = await runEvaluations(ctx);
    // The pin must describe the bytes that were evaluated, not bytes swapped in meanwhile.
    if ((await bundleDigest(store.dir(state.id))) !== digest) {
      return {
        ok: false,
        exitCode: 2,
        error: { code: "BUNDLE_INVALID", message: bundleChanged().message },
        data: { attempt, attemptsRemaining },
        recordStep: false,
      };
    }
    await store.writeArtifact(state.id, "reports/evaluation.json", toJson(report));

    state.skillName = skill.name;
    state.evaluatedBundleSha256 = digest;
    state.status = "evaluating";
    state.metrics.parallelOps += report.parallelOps;
    state.metrics.evaluationMs += report.durationMs;
    return {
      data: {
        overall: report.overall,
        activatable: report.activatable,
        results: report.results,
        limitations: report.limitations,
        revisionHints: report.revisionHints,
        attempt,
        attemptsRemaining,
      },
    };
  },
};
