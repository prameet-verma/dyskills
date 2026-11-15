import { activate } from "@dynamic-skills/activation";
import type { ActivationResult } from "@dynamic-skills/activation";
import { ContextPacketSchema, EvaluationReportSchema } from "@dynamic-skills/core";
import { BundleError, parseSkillBundle } from "@dynamic-skills/skill-compiler";
import type { GeneratedSkill } from "@dynamic-skills/core";
import { readArtifactJson, readEvidence, requireArtifactJson } from "../io";
import { assertBundlePinned, sessionPaths } from "./bundle";
import type { CommandResult, SessionCommandDef } from "./types";

/** Exit code for a refused activation (PRD §10.5: evaluation gate failed). */
const EXIT_REFUSED = 2;
/** Exit code when the budget ran out (PRD §10.1). */
const EXIT_TIMEOUT = 3;

/** Turns the activation outcome into the command result (stdout fields and exit code). */
function toResult(result: ActivationResult): CommandResult {
  if (result.activated) {
    return {
      data: {
        activated: true,
        kind: result.kind,
        skillPath: result.skillPath,
        content: result.content,
        base: result.base,
        loadOrder: result.loadOrder,
        limitations: result.limitations,
        notice: result.notice,
      },
    };
  }
  return {
    ok: false,
    exitCode: result.reason === "timeout" ? EXIT_TIMEOUT : EXIT_REFUSED,
    // A refusal ends the session as failed; like EVAL_ATTEMPTS_EXHAUSTED it records no step.
    recordStep: false,
    data: { activated: false, reason: result.reason, fallback: result.fallback },
  };
}

/**
 * `activate`: the final, gated step (PRD §5.5, §9.4, §11.1). It hands the evaluated skill (and, for
 * an augmentation, the unchanged base) to the agent for ephemeral use, or refuses with a fallback.
 * `activate()` mutates the session and writes the reports; the wrapper saves the state afterwards,
 * and discards it when `activate()` throws. Terminal sessions never get here: `assertCanRun`
 * refuses them first, because `activate()` has no guard of its own.
 */
export const activateCommand: SessionCommandDef = {
  name: "activate",
  kind: "session",
  description: "Activate the evaluated skill for this session, or refuse with a fallback.",
  options: [],
  step: "activate",
  stage: "activation",
  async run({ store, state, now }) {
    const sessionDir = store.dir(state.id);
    await assertBundlePinned(state, sessionDir);
    let skill: GeneratedSkill | null = null;
    try {
      skill = await parseSkillBundle(sessionPaths(sessionDir).skillsDir);
    } catch (e) {
      // A bundle that no longer parses is an evaluation failure, which activate() reports.
      if (!(e instanceof BundleError)) throw e;
    }
    const report = await requireArtifactJson(
      store,
      state.id,
      "reports/evaluation.json",
      EvaluationReportSchema,
    );
    const packet = await readArtifactJson(
      store,
      state.id,
      "context-packet.json",
      ContextPacketSchema,
    );
    const result = await activate({
      state,
      sessionDir,
      skill,
      report,
      behavioural: report.behavioural,
      packet,
      evidence: await readEvidence(store, state.id),
      now: now(),
    });
    return toResult(result);
  },
};
