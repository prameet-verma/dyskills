import { EvaluationReportSchema, MAX_EVAL_ATTEMPTS } from "@dynamic-skills/core";
import { recordBehaviouralResult } from "@dynamic-skills/eval-engine";
import { loadSmokeEval } from "@dynamic-skills/skill-compiler";
import { CliError, FALLBACK, readInputFile, requireArtifactJson, toJson } from "../io";
import { assertBundlePinned, sessionPaths } from "./bundle";
import type { SessionCommandDef } from "./types";

/**
 * `eval record`: the agent ran the smoke scenario with the new skill and reports the output and
 * its own rubric verdict (PRD §9.2, §9.4). The assertions in `evals/smoke.json` are checked
 * against the output (agent-written regexes run in a bounded worker), and the combined
 * `behavioural` result is stored in `reports/evaluation.json`, where `activate` reads it. A `fail`
 * on the last allowed attempt ends the session as `failed` with reports and a `fallback` (Ruling
 * R22); the exit code stays 0 because the recording itself succeeded.
 */
export const evalRecordCommand: SessionCommandDef = {
  name: "eval record",
  kind: "session",
  description: "Record the behavioural smoke-eval output and verdict.",
  options: [
    { flags: "--output <file>", description: "File with the skill-guided output.", required: true },
    {
      flags: "--verdict <verdict>",
      description: "Rubric verdict: pass or fail.",
      required: true,
      choices: ["pass", "fail"],
    },
    {
      flags: "--notes <text>",
      description:
        "Optional note, stored in the behavioural result (and shown when the verdict is fail).",
    },
  ],
  step: "eval-record",
  stage: "evaluation",
  async run({ store, state, opts, cwd }) {
    const verdict = opts.verdict;
    if (verdict !== "pass" && verdict !== "fail") {
      throw new CliError("USAGE", "--verdict must be pass or fail.");
    }
    await assertBundlePinned(state, store.dir(state.id));
    const paths = sessionPaths(store.dir(state.id));
    let smoke: Awaited<ReturnType<typeof loadSmokeEval>>;
    try {
      smoke = await loadSmokeEval(paths.smoke);
    } catch {
      throw new CliError("BUNDLE_INVALID", "evals/smoke.json is not a valid smoke eval.");
    }
    if (smoke === null) throw new CliError("BUNDLE_INVALID", "evals/smoke.json does not exist.");

    const output = await readInputFile(cwd, String(opts.output), "--output");
    const notes = typeof opts.notes === "string" ? opts.notes : undefined;
    const report = await requireArtifactJson(
      store,
      state.id,
      "reports/evaluation.json",
      EvaluationReportSchema,
    );
    const behavioural = await recordBehaviouralResult(smoke, output, verdict, notes);
    await store.writeArtifact(
      state.id,
      "reports/evaluation.json",
      toJson({ ...report, behavioural }),
    );
    state.metrics.llmInteractions += 1;
    // R22: a failed behavioural result with no attempt left to revise ends the session here.
    const ended = behavioural.outcome === "fail" && state.evalAttempts >= MAX_EVAL_ATTEMPTS;
    if (ended) {
      state.status = "failed";
      state.metrics.outcome = "failed";
    }
    return {
      writeReports: ended,
      data: {
        outcome: behavioural.outcome,
        messages: behavioural.messages,
        ...(ended ? { fallback: FALLBACK } : {}),
      },
    };
  },
};
