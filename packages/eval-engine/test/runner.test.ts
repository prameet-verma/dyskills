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
  it("keeps the rationale of a mandatory not-applicable", async () => {
    const evals = [
      fake("spec", true, async () => ({ outcome: "not-applicable", messages: ["no docs"] })),
    ];
    const report = await runEvaluations(await makeContext(), { evals });
    expect(report.results[0]?.messages).toEqual(["mandatory check cannot be skipped", "no docs"]);
  });
  it("handles a thrown value that cannot be stringified", async () => {
    const evals = [
      fake("spec", true, async () => {
        throw Object.create(null);
      }),
    ];
    const report = await runEvaluations(await makeContext(), { evals });
    expect(report.results[0]?.messages).toEqual(["eval crashed: unknown error"]);
  });
  it("sanitises crash messages", async () => {
    const evals = [
      fake("spec", true, async () => {
        throw new Error(`a\nb ${"x".repeat(500)}`);
      }),
    ];
    const report = await runEvaluations(await makeContext(), { evals });
    const m = report.results[0]?.messages[0] as string;
    expect(m).not.toContain("\n");
    expect(m.length).toBeLessThan(260);
    expect(m.endsWith("…")).toBe(true);
  });
  it("caps revisionHints and limitations at 50", async () => {
    const many = Array.from({ length: 80 }, (_, i) => `m${i}`);
    const failing = [fake("spec", true, async () => ({ outcome: "fail", messages: many }))];
    const warning = [fake("scope", false, async () => ({ outcome: "warning", messages: many }))];
    expect(
      (await runEvaluations(await makeContext(), { evals: failing })).revisionHints,
    ).toHaveLength(50);
    expect(
      (await runEvaluations(await makeContext(), { evals: warning })).limitations,
    ).toHaveLength(50);
  });
  it("rejects an empty eval list", async () => {
    await expect(runEvaluations(await makeContext(), { evals: [] })).rejects.toThrow(
      "no evaluations to run",
    );
  });
  it("rejects when aborted before start and mid-run", async () => {
    const slow = () =>
      fake("spec", true, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { outcome: "pass" as const, messages: [] };
      });
    const pre = new AbortController();
    pre.abort();
    await expect(
      runEvaluations(await makeContext(), { evals: [slow()], signal: pre.signal }),
    ).rejects.toThrow();
    const mid = new AbortController();
    const p = runEvaluations(await makeContext(), {
      evals: [slow(), slow(), slow()],
      concurrency: 1,
      signal: mid.signal,
    });
    setTimeout(() => mid.abort(), 20);
    await expect(p).rejects.toThrow();
  });
  it("keeps input order with staggered delays and distinct ids", async () => {
    const ids = ["spec", "metadata", "grounding", "scope"] as const;
    const delays = [40, 5, 30, 1];
    const evals = ids.map((id, i) =>
      fake(id, false, async () => {
        await new Promise((r) => setTimeout(r, delays[i]));
        return { outcome: "pass" as const, messages: [`done ${id}`] };
      }),
    );
    const report = await runEvaluations(await makeContext(), { evals, concurrency: 4 });
    expect(report.results.map((r) => r.id)).toEqual([...ids]);
    expect(report.results.map((r) => r.messages[0])).toEqual(ids.map((i) => `done ${i}`));
  });
});
