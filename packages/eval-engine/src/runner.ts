import {
  EVAL_CONCURRENCY,
  mapConcurrent,
  type EvalOutcome,
  type EvalResult,
  type EvaluationReport,
} from "@dynamic-skills/core";
import {
  assumptionsEval,
  behaviouralDefinitionEval,
  completenessEval,
  duplicationEval,
  evidenceClassificationEval,
  groundingEval,
  roleEval,
  scopeEval,
} from "./evals/context";
import {
  concisenessEval,
  metadataEval,
  portabilityEval,
  referencesEval,
  securityEval,
  specEval,
} from "./evals/structural";
import { MAX_REPORT_ENTRIES, sanitiseForMessage } from "./behavioural";
import type { EvalContext, GenerationEval } from "./types";

/**
 * The 14 generation evals in `EvalId` order (every id except `behavioural`, which is recorded
 * after the agent runs the smoke scenario). New skills and augmentations run the same set
 * (PRD §5.5); augmentation rules live inside `metadata`, `role` and `duplication`.
 */
export const ALL_EVALS: GenerationEval[] = [
  specEval,
  metadataEval,
  groundingEval,
  completenessEval,
  scopeEval,
  roleEval,
  evidenceClassificationEval,
  assumptionsEval,
  duplicationEval,
  concisenessEval,
  referencesEval,
  portabilityEval,
  securityEval,
  behaviouralDefinitionEval,
];

/** Options for {@link runEvaluations}. */
export interface RunOptions {
  /** Evals to run; defaults to {@link ALL_EVALS}. */
  evals?: GenerationEval[];
  /** Maximum evals in flight; defaults to `EVAL_CONCURRENCY` (PRD §10.2). */
  concurrency?: number;
  /** Aborts the run (the promise rejects with an `AbortError`). */
  signal?: AbortSignal;
}

/** Stringifies a thrown value without ever throwing (e.g. `Object.create(null)` has no toString). */
function describeThrown(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return "unknown error";
  }
}

/** Runs one eval, converting a throw or a forbidden skip into a `fail` (PRD §9.4). */
async function runOne(ev: GenerationEval, ctx: EvalContext): Promise<EvalResult> {
  const started = Date.now();
  let outcome: EvalOutcome;
  let messages: string[];
  try {
    const run = await ev.run(ctx);
    outcome = run.outcome;
    messages = run.messages;
    if (ev.mandatory && outcome === "not-applicable") {
      outcome = "fail";
      messages = ["mandatory check cannot be skipped", ...messages];
    }
  } catch (err) {
    outcome = "fail";
    messages = [`eval crashed: ${sanitiseForMessage(describeThrown(err))}`];
  }
  return {
    id: ev.id,
    outcome,
    mandatory: ev.mandatory,
    messages,
    durationMs: Date.now() - started,
  };
}

/**
 * Runs the generation evals in parallel with bounded concurrency and builds the report
 * (PRD §9.4, §10.2). Overall precedence is fail > warning > pass; the skill is activatable
 * (before the behavioural check) when no result failed. `limitations` are warning messages and
 * `revisionHints` are failure messages prefixed with the eval id. No `behavioural` result yet.
 * @param ctx - The evaluation context.
 * @param opts - Optional eval list, concurrency and abort signal.
 * @returns The evaluation report; results keep eval order.
 * @throws `Error` ("no evaluations to run") for an empty eval list; `AbortError` when the signal aborts.
 */
export async function runEvaluations(
  ctx: EvalContext,
  opts: RunOptions = {},
): Promise<EvaluationReport> {
  const evals = opts.evals ?? ALL_EVALS;
  if (evals.length === 0) throw new Error("no evaluations to run");
  const limit = opts.concurrency ?? EVAL_CONCURRENCY;
  const started = Date.now();
  const results = await mapConcurrent(evals, limit, (ev) => runOne(ev, ctx), {
    signal: opts.signal,
  });
  const failed = results.some((r) => r.outcome === "fail");
  const warned = results.some((r) => r.outcome === "warning");
  return {
    schemaVersion: "1",
    results,
    overall: failed ? "fail" : warned ? "warning" : "pass",
    activatable: !failed,
    limitations: results
      .filter((r) => r.outcome === "warning")
      .flatMap((r) => r.messages)
      .slice(0, MAX_REPORT_ENTRIES),
    revisionHints: results
      .filter((r) => r.outcome === "fail")
      .flatMap((r) => r.messages.map((m) => `${r.id}: ${m}`))
      .slice(0, MAX_REPORT_ENTRIES),
    durationMs: Date.now() - started,
    parallelOps: Math.max(1, Math.min(limit, evals.length)),
  };
}
