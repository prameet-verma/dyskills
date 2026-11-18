import { activate } from "@dynamic-skills/activation";
import type { ActivationResult } from "@dynamic-skills/activation";
import type { RefusalReason } from "@dynamic-skills/activation";
import { ContextPacketSchema, EvaluationReportSchema } from "@dynamic-skills/core";
import { BundleError, parseSkillBundle } from "@dynamic-skills/skill-compiler";
import type { GeneratedSkill, SessionState, SessionStore } from "@dynamic-skills/core";
import type { HostProbe } from "@dynamic-skills/adapter-sdk";
import type { PlaceNativeResult } from "../native";
import { dirname, basename } from "node:path";
import { ADAPTERS, currentHarness } from "../adapters";
import { buildHostEnv } from "../host";
import { placeNative, sweepNativePlacements } from "../native";
import { readArtifactJson, readEvidence, requireArtifactJson } from "../io";
import { assertBundlePinned, sessionPaths } from "./bundle";
import type { CommandResult, SessionCommandDef } from "./types";

/** Exit code for a refused activation (PRD §10.5: evaluation gate failed). */
const EXIT_REFUSED = 2;
/** Exit code when the budget ran out (PRD §10.1). */
const EXIT_TIMEOUT = 3;

/** The `message` of a refused activation, per refusal reason; never repository content. */
const REFUSAL_MESSAGES: Record<RefusalReason, string> = {
  timeout: "The active processing budget was exceeded.",
  "blocked-by-clarification": "A blocking clarification question is unresolved.",
  "base-changed": "The base skill changed after the verdict was recorded.",
  "evaluation-failed": "The skill did not pass evaluation.",
  "behavioural-missing": "No behavioural evaluation result was recorded.",
};

/**
 * Turns the activation outcome into the command result (stdout fields and exit code). A refusal
 * is a saved failure: `ok: false` with `error` (`ACTIVATION_REFUSED`, or `TIMEOUT` when the budget
 * ran out, matching its exit code 3) and a `message` derived from `reason`.
 */
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
    error: {
      code: result.reason === "timeout" ? "TIMEOUT" : "ACTIVATION_REFUSED",
      message: REFUSAL_MESSAGES[result.reason],
    },
    data: { activated: false, reason: result.reason, fallback: result.fallback },
  };
}

/**
 * Places the activated skill natively for the current harness (D2). Unknown harness or native mode
 * off yields no placement and no limitation; any failure, host environment errors included,
 * becomes a skipped placement with a limitation, because activation never fails over it.
 */
async function placeForHarness(input: {
  state: SessionState;
  store: SessionStore;
  userHome: string;
  vars: Readonly<Record<string, string | undefined>>;
  probe: HostProbe;
  etcDir: string;
  result: Extract<ActivationResult, { activated: true }>;
  now: () => number;
}): Promise<PlaceNativeResult> {
  const { state, store, userHome, vars, probe, etcDir, result } = input;
  const harness = currentHarness(undefined, vars);
  if (harness === null) return { native: null, placement: null, limitation: null };
  try {
    const env = await buildHostEnv({
      repo: state.repo,
      userHome,
      home: store.home,
      vars,
      probe,
      etcDir,
    });
    const skillDir = dirname(result.skillPath);
    return await placeNative({
      env,
      adapter: ADAPTERS[harness],
      skillDir,
      name: basename(skillDir),
      now: input.now(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unexpected error";
    return {
      native: null,
      placement: null,
      limitation: `Native registration skipped: ${message}.`,
    };
  }
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
  async run({ store, state, now, userHome, vars, probe, etcDir }) {
    // Best effort: an expired placement left behind never matters more than this activation.
    await sweepNativePlacements(store.home, now()).catch(() => undefined);
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
    const out = toResult(result);
    if (!result.activated) return out;
    const placed = await placeForHarness({
      state,
      store,
      userHome,
      vars,
      probe,
      etcDir,
      result,
      now,
    });
    if (placed.placement) state.native = placed.placement;
    else delete state.native;
    return {
      ...out,
      data: {
        ...out.data,
        limitations: [...result.limitations, ...(placed.limitation ? [placed.limitation] : [])],
        native: placed.native,
      },
    };
  },
};
