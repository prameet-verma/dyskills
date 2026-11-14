import { describe, expect, it } from "vitest";
import { EvaluationReportSchema } from "@dynamic-skills/core";
import { ALL_EVALS, runEvaluations, type GenerationEval } from "../src/index";
import { makeContext } from "./helpers";

function fake(id: GenerationEval["id"], mandatory: boolean, run: GenerationEval["run"]) {
  return { id, mandatory, run } satisfies GenerationEval;
}

describe("ALL_EVALS", () => {
  it("has the 14 generation evals in EvalId order", () => {
    expect(ALL_EVALS.map((e) => e.id)).toEqual([
      "spec",
      "metadata",
      "grounding",
      "completeness",
      "scope",
      "role",
      "evidence-classification",
      "assumptions",
      "duplication",
      "conciseness",
      "references",
      "portability",
      "security",
      "behavioural-definition",
    ]);
  });
});

describe("runEvaluations", () => {
  it("golden new skill passes", async () => {
    const report = await runEvaluations(await makeContext({ withAnalysis: true }));
    expect(report.overall).toBe("pass");
    expect(report.activatable).toBe(true);
    expect(report.results).toHaveLength(14);
    expect(EvaluationReportSchema.parse(report)).toEqual(report);
  });
  it("golden augmentation passes", async () => {
    const report = await runEvaluations(await makeContext({ augmentation: true }));
    expect(report.overall).toBe("pass");
    expect(report.activatable).toBe(true);
    expect(report.results).toHaveLength(14);
  });
  it("bounds concurrency at 6", async () => {
    let inFlight = 0;
    let max = 0;
    const evals = Array.from({ length: 8 }, () =>
      fake("spec", true, async () => {
        max = Math.max(max, ++inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return { outcome: "pass", messages: [] };
      }),
    );
    const report = await runEvaluations(await makeContext(), { evals });
    expect(max).toBe(6);
    expect(report.results).toHaveLength(8);
  });
  it("turns a crash into a fail and keeps the rest", async () => {
    const evals = [
      fake("spec", true, async () => {
        throw new Error("boom");
      }),
      fake("scope", false, async () => ({ outcome: "pass", messages: [] })),
    ];
    const report = await runEvaluations(await makeContext(), { evals });
    expect(report.results[0]).toMatchObject({ outcome: "fail", messages: ["eval crashed: boom"] });
    expect(report.results[1]?.outcome).toBe("pass");
    expect(report.activatable).toBe(false);
    expect(report.revisionHints).toEqual(["spec: eval crashed: boom"]);
  });
  it("fails a mandatory not-applicable", async () => {
    const evals = [fake("spec", true, async () => ({ outcome: "not-applicable", messages: [] }))];
    const report = await runEvaluations(await makeContext(), { evals });
    expect(report.results[0]).toMatchObject({
      outcome: "fail",
      messages: ["mandatory check cannot be skipped"],
    });
  });
  it("keeps a non-mandatory not-applicable", async () => {
    const evals = [fake("scope", false, async () => ({ outcome: "not-applicable", messages: [] }))];
    const report = await runEvaluations(await makeContext(), { evals });
    expect(report.results[0]?.outcome).toBe("not-applicable");
    expect(report.overall).toBe("pass");
  });
  it("a warning yields overall warning, activatable, with a limitation", async () => {
    const evals = [fake("scope", false, async () => ({ outcome: "warning", messages: ["thin"] }))];
    const report = await runEvaluations(await makeContext(), { evals });
    expect(report.overall).toBe("warning");
    expect(report.activatable).toBe(true);
    expect(report.limitations).toEqual(["thin"]);
  });
});
