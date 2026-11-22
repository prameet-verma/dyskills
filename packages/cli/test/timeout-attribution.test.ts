import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_BUDGET_MS } from "@dynamic-skills/core";
import type { SessionState } from "@dynamic-skills/core";
import { inProgressStage } from "../src/state-machine";
import type { CliCommand, CompletedStep } from "../src/state-machine";
import { runCli } from "../src/run";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  analysed,
  analysisFixture,
  assess,
  discovered,
  groundedAnalysis,
  harness,
  installGolden,
  ready,
  record,
  verdict,
} from "./helpers";
import type { Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.cleanup());

const GAP = DEFAULT_BUDGET_MS + 12_000;

describe("deadline attributes the in-progress stage", () => {
  it("context submit after the budget: analysis time is the gap, not 0", async () => {
    const id = await discovered(h);
    h.clock.t += GAP;
    const file = await h.doc("analysis.json", await analysisFixture("minimal.json"));
    const r = await h.run(["context", "submit", "--session", id, "--file", file]);
    expect(r.out.error).toBe("TIMEOUT");
    const state = await h.readJson(id, "session.json");
    expect(state.status).toBe("timeout");
    expect(state.metrics.stageMs.analysis).toBe(GAP);
    expect(state.sla.activeMs).toBe(GAP);
    const discovery = await h.readJson(id, "reports/discovery.json");
    expect(discovery.agenticMs).toBe(GAP);
  });

  it("sufficiency submit after the budget adds the gap to assessment", async () => {
    const id = await discovered(h);
    await groundedAnalysis(h, id);
    const before = (await h.readJson(id, "session.json")).metrics.stageMs.assessment ?? 0;
    h.clock.t += GAP;
    const file = await h.doc("verdict.json", verdict({ outcome: "insufficient" }));
    const r = await h.run(["sufficiency", "submit", "--session", id, "--file", file]);
    expect(r.out.error).toBe("TIMEOUT");
    const state = await h.readJson(id, "session.json");
    expect(state.metrics.stageMs.assessment).toBe(before + GAP);
  });

  it("compile after the budget attributes the gap to compilation", async () => {
    const id = await ready(h);
    h.clock.t += GAP;
    const r = await h.run(["compile", "--session", id]);
    expect(r.out.error).toBe("TIMEOUT");
    const state = await h.readJson(id, "session.json");
    expect(state.metrics.stageMs.compilation).toBe(GAP);
  });

  it("clean of an abandoned, expired session archives the capped analysis time", async () => {
    const id = await discovered(h);
    h.clock.t += 2 * GAP;
    await h.run(["clean", "--session", id]);
    const archived = JSON.parse(await readFile(join(h.home, "reports", `${id}.json`), "utf8"));
    expect(archived.outcome).toBe("timeout");
    expect(archived.stageMs.analysis).toBe(DEFAULT_BUDGET_MS);
  });

  const submitAnalysis = async (id: string) => {
    const file = await h.doc("analysis.json", await analysisFixture("minimal.json"));
    return h.run(["context", "submit", "--session", id, "--file", file]);
  };
  const metrics = async (id: string) => (await h.readJson(id, "session.json")).metrics;

  it("a re-analysis that times out adds its gap to the analysis already recorded", async () => {
    const id = await discovered(h);
    h.clock.t += 10_000;
    expect((await submitAnalysis(id)).exitCode).toBe(0);
    expect((await metrics(id)).stageMs.analysis).toBe(10_000);
    h.clock.t += DEFAULT_BUDGET_MS + 12_000;
    expect((await submitAnalysis(id)).out.error).toBe("TIMEOUT");
    const m = await metrics(id);
    expect(m.stageMs.analysis).toBe(DEFAULT_BUDGET_MS + 22_000);
    expect((await h.readJson(id, "reports/discovery.json")).agenticMs).toBe(
      DEFAULT_BUDGET_MS + 22_000,
    );
  });

  it("clean after a context request adds the re-analysis gap, capped at the budget", async () => {
    const id = await discovered(h);
    h.clock.t += 10_000;
    await submitAnalysis(id);
    const req = await h.doc("req.json", {
      schemaVersion: "1",
      action: "request_context",
      requests: [{ type: "documentation", path: "README.md", reason: "needed" }],
    });
    expect((await h.run(["context", "request", "--session", id, "--file", req])).exitCode).toBe(0);
    h.clock.t += 2 * GAP;
    await h.run(["clean", "--session", id]);
    const archived = JSON.parse(await readFile(join(h.home, "reports", `${id}.json`), "utf8"));
    expect(archived.stageMs.analysis).toBe(DEFAULT_BUDGET_MS);
  });

  it("clean caps analysis at the budget left after earlier active time", async () => {
    const id = await assess(h, "Add caching to order reads in the orders service");
    h.clock.t += 40_000;
    expect((await h.run(["discover", "--session", id])).exitCode).toBe(0);
    h.clock.t += 2 * GAP;
    await h.run(["clean", "--session", id]);
    const archived = JSON.parse(await readFile(join(h.home, "reports", `${id}.json`), "utf8"));
    expect(archived.stageMs.analysis).toBe(DEFAULT_BUDGET_MS - 40_000);
  });

  it("excludes a human wait between clarify ask and answer", async () => {
    const id = await analysed(h, "Add a database migration for the orders table");
    const v = await h.doc("v.json", verdict({ outcome: "insufficient" }));
    expect((await h.run(["sufficiency", "submit", "--session", id, "--file", v])).exitCode).toBe(0);
    const q = await h.doc("q.json", {
      schemaVersion: "1",
      questions: [
        {
          id: "q-migration",
          text: "What migration rollout policy applies?",
          requirement: "migration-policy",
          material: true,
          blocking: true,
        },
      ],
    });
    expect((await h.run(["clarify", "ask", "--session", id, "--file", q])).exitCode).toBe(0);
    h.clock.t += 600_000;
    const a = await h.doc("a.json", {
      schemaVersion: "1",
      answers: [{ questionId: "q-migration", status: "answered", value: "Expand and contract" }],
    });
    expect((await h.run(["clarify", "answer", "--session", id, "--file", a])).exitCode).toBe(0);
    h.clock.t += GAP;
    expect((await h.run(["compile", "--session", id])).out.error).toBe("TIMEOUT");
    expect((await metrics(id)).stageMs.compilation).toBe(GAP);
  });

  it("status between commands does not move the gap start", async () => {
    const id = await ready(h);
    h.clock.t += 20_000;
    await runCli(["status", "--session", id], {
      home: h.home,
      cwd: h.repo,
      userHome: h.userHome,
      now: () => h.clock.t,
    });
    h.clock.t += DEFAULT_BUDGET_MS;
    expect((await h.run(["compile", "--session", id])).out.error).toBe("TIMEOUT");
    expect((await metrics(id)).stageMs.compilation).toBe(20_000 + DEFAULT_BUDGET_MS);
  });

  it("a refused command does not move the gap start", async () => {
    const id = await ready(h);
    h.clock.t += 20_000;
    expect((await h.run(["evaluate", "--session", id])).out.error).toBe("INVALID_STATE");
    h.clock.t += DEFAULT_BUDGET_MS;
    expect((await h.run(["compile", "--session", id])).out.error).toBe("TIMEOUT");
    expect((await metrics(id)).stageMs.compilation).toBe(20_000 + DEFAULT_BUDGET_MS);
  });

  it("sufficiency approve then a compile timeout attributes compilation", async () => {
    await h.installBase();
    const id = await analysed(h, undefined, ["--mode", "suggest"]);
    const v = await h.doc("v.json", verdict({ outcome: "insufficient" }));
    expect((await h.run(["sufficiency", "submit", "--session", id, "--file", v])).exitCode).toBe(0);
    h.clock.t += 30_000;
    const ok = await h.run(["sufficiency", "approve", "--session", id, "--decision", "approve"]);
    expect(ok.exitCode).toBe(0);
    h.clock.t += GAP;
    expect((await h.run(["compile", "--session", id])).out.error).toBe("TIMEOUT");
    expect((await metrics(id)).stageMs.compilation).toBe(GAP);
  });

  it("an evaluate timeout after compile attributes the skill-writing gap to compilation", async () => {
    const id = await ready(h);
    expect((await h.run(["compile", "--session", id])).exitCode).toBe(0);
    h.clock.t += GAP;
    expect((await h.run(["evaluate", "--session", id])).out.error).toBe("TIMEOUT");
    expect((await metrics(id)).stageMs.compilation).toBe(GAP);
  });

  it("an eval record timeout after evaluate attributes the behavioural-run gap to evaluation", async () => {
    const id = await ready(h);
    expect((await h.run(["compile", "--session", id])).exitCode).toBe(0);
    await installGolden(h, id, "valid/order-cache-specialist");
    expect((await h.run(["evaluate", "--session", id])).exitCode).toBe(0);
    const before = (await metrics(id)).stageMs.evaluation ?? 0;
    h.clock.t += GAP;
    expect((await record(h, id)).out.error).toBe("TIMEOUT");
    expect((await metrics(id)).stageMs.evaluation).toBe(before + GAP);
  });

  it("a legacy session.json without the marker still times out cleanly", async () => {
    const id = await ready(h);
    const path = join(h.home, "sessions", id, "session.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    delete state.metrics.lastCommandEndedAtActiveMs;
    await writeFile(path, JSON.stringify(state));
    h.clock.t += GAP;
    expect((await h.run(["compile", "--session", id])).out.error).toBe("TIMEOUT");
    const m = await metrics(id);
    expect(m.lastCommandEndedAtActiveMs).toBeNull();
    expect(m.stageMs.compilation).toBeUndefined();
  });

  const sumStages = (m: { stageMs: Record<string, number> }) =>
    Object.values(m.stageMs).reduce((a, b) => a + b, 0);

  it("a command that books its own stage without recording a step is not counted twice", async () => {
    const id = await ready(h);
    expect((await h.run(["compile", "--session", id])).exitCode).toBe(0);
    h.clock.t += 20_000;
    // No skill bundle was written: `evaluate` fails (recordStep false) after booking its run time.
    let tick = 0;
    const failed = await h.runWith(["evaluate", "--session", id], {
      now: () => h.clock.t + 1_000 * tick++,
    });
    expect(failed.out.ok).toBe(false);
    expect(failed.out.error).not.toBe("TIMEOUT");
    expect((await metrics(id)).stageMs.evaluation ?? 0).toBeGreaterThan(0);
    h.clock.t += GAP + 5_000;
    expect((await h.run(["evaluate", "--session", id])).out.error).toBe("TIMEOUT");
    const state = await h.readJson(id, "session.json");
    expect(sumStages(state.metrics)).toBeLessThanOrEqual(state.sla.activeMs);
  });

  it("a re-analysis timeout books the time of a context request in between", async () => {
    const id = await discovered(h);
    h.clock.t += 10_000;
    await submitAnalysis(id);
    h.clock.t += 7_000;
    const req = await h.doc("req.json", {
      schemaVersion: "1",
      action: "request_context",
      requests: [{ type: "documentation", path: "README.md", reason: "needed" }],
    });
    let tick = 0;
    const ok = await h.runWith(["context", "request", "--session", id, "--file", req], {
      now: () => h.clock.t + 100 * tick++,
    });
    expect(ok.exitCode).toBe(0);
    h.clock.t += DEFAULT_BUDGET_MS;
    expect((await h.run(["context", "request", "--session", id, "--file", req])).out.error).toBe(
      "TIMEOUT",
    );
    const state = await h.readJson(id, "session.json");
    expect(state.metrics.stageMs.analysis).toBe(state.sla.activeMs);
    expect(sumStages(state.metrics)).toBeLessThanOrEqual(state.sla.activeMs);
  });

  /** Active ms of a session at the harness clock: the saved snapshot lags while the clock runs. */
  const activeNow = (state: {
    sla: { activeMs: number; paused: boolean; segmentStartedAt: number };
  }) => state.sla.activeMs + (state.sla.paused ? 0 : h.clock.t - state.sla.segmentStartedAt);

  /** Runs a command on a clock that advances 100 ms per reading, then leaves the clock there. */
  const ticking = async (argv: string[]) => {
    let n = 0;
    const r = await h.runWith(argv, { now: () => h.clock.t + 100 * n++ });
    h.clock.t += 100 * (n - 1);
    return r;
  };

  it("time `assess` booked before discovery is not taken out of the analysis timeout gap", async () => {
    const task = "Add caching to order reads in the orders service";
    const created = await ticking(["assess", "--task", task]);
    const id = String(created.out.sessionId);
    const assessMs = (await h.readJson(id, "session.json")).metrics.stageMs.assessment;
    expect((await h.run(["discover", "--session", id])).exitCode).toBe(0);
    h.clock.t += DEFAULT_BUDGET_MS + 10_000;
    expect((await submitAnalysis(id)).out.error).toBe("TIMEOUT");
    const state = await h.readJson(id, "session.json");
    const m = state.metrics;
    expect(m.stageMs.assessment).toBeGreaterThan(0);
    expect(m.stageMs.analysis).toBe(state.sla.activeMs - m.analysisStartedAtActiveMs);
    expect(m.stageMs.analysis).toBe(DEFAULT_BUDGET_MS + 10_000);
    // `assess` books its run time from before the session (and its clock) exists, so only that
    // part may exceed the active time.
    expect(sumStages(m)).toBeLessThanOrEqual(state.sla.activeMs + assessMs);
  });

  it("a re-analysis after a clarification round never counts other stages twice", async () => {
    const task = "Add a database migration for the orders table";
    const created = await ticking(["assess", "--task", task]);
    const id = String(created.out.sessionId);
    const assessMs = (await h.readJson(id, "session.json")).metrics.stageMs.assessment;
    expect((await ticking(["discover", "--session", id])).exitCode).toBe(0);
    h.clock.t += 10_000;
    const first = await h.doc("analysis.json", await analysisFixture("minimal.json"));
    const submit = () => h.run(["context", "submit", "--session", id, "--file", first]);
    expect((await submit()).exitCode).toBe(0);
    const v = await h.doc("v.json", verdict({ outcome: "insufficient" }));
    expect((await ticking(["sufficiency", "submit", "--session", id, "--file", v])).exitCode).toBe(
      0,
    );
    const q = await h.doc("q.json", {
      schemaVersion: "1",
      questions: [
        {
          id: "q-migration",
          text: "What migration rollout policy applies?",
          requirement: "migration-policy",
          material: true,
          blocking: true,
        },
      ],
    });
    expect((await ticking(["clarify", "ask", "--session", id, "--file", q])).exitCode).toBe(0);
    h.clock.t += 600_000;
    const a = await h.doc("a.json", {
      schemaVersion: "1",
      answers: [{ questionId: "q-migration", status: "answered", value: "Expand and contract" }],
    });
    expect((await ticking(["clarify", "answer", "--session", id, "--file", a])).exitCode).toBe(0);
    h.clock.t += 5_000;
    expect((await submit()).exitCode).toBe(0);

    const mid = await h.readJson(id, "session.json");
    expect(mid.metrics.stageMs.assessment).toBeGreaterThan(0);
    expect(mid.metrics.stageMs.discovery).toBeGreaterThan(0);
    expect(mid.metrics.stageMs.clarification).toBeGreaterThan(0);
    expect(sumStages(mid.metrics)).toBeLessThanOrEqual(
      activeNow(mid) + assessMs + mid.metrics.stageMs.discovery,
    );
    // Analysis is everything since discovery ended, less the sufficiency and clarification run
    // times (not `assess`'s, which was booked before discovery ended).
    const expected = (st: typeof mid) =>
      activeNow(st) -
      st.metrics.analysisStartedAtActiveMs -
      (st.metrics.stageMs.assessment - assessMs) -
      st.metrics.stageMs.clarification;
    expect(mid.metrics.stageMs.analysis).toBe(expected(mid));

    h.clock.t += DEFAULT_BUDGET_MS;
    expect((await submit()).out.error).toBe("TIMEOUT");
    const ended = await h.readJson(id, "session.json");
    expect(ended.metrics.stageMs.analysis).toBe(expected(ended));
    expect(sumStages(ended.metrics)).toBeLessThanOrEqual(
      ended.sla.activeMs + assessMs + ended.metrics.stageMs.discovery,
    );
  });
});

describe("inProgressStage", () => {
  const at = (last: CompletedStep | undefined, sufficiency = false) =>
    ({
      completedSteps: last === undefined ? [] : [last],
      sufficiency: sufficiency ? { outcome: "insufficient", approval: "approved" } : null,
    }) as unknown as SessionState;

  it("maps the last completed step to the stage that follows it", () => {
    const table: [CompletedStep | undefined, string | undefined][] = [
      [undefined, undefined],
      ["assess", undefined],
      ["discover", "analysis"],
      ["context-request", "analysis"],
      ["context-submit", "assessment"],
      ["sufficiency-submit", "compilation"],
      ["sufficiency-approve", "compilation"],
      ["clarify-ask", undefined],
      ["clarify-answer", "compilation"],
      ["compile", "compilation"],
      ["evaluate", "evaluation"],
      ["eval-record", "evaluation"],
      ["activate", undefined],
    ];
    for (const [last, stage] of table) expect(inProgressStage(at(last)), String(last)).toBe(stage);
  });

  it("a re-analysis with a verdict already recorded leads to compilation, not assessment", () => {
    expect(inProgressStage(at("context-submit", true))).toBe("compilation");
  });

  it("a legal command names its own stage", () => {
    const stage = (last: CompletedStep, c: CliCommand) => inProgressStage(at(last, true), c);
    expect(stage("clarify-answer", "clarify ask")).toBe("clarification");
    expect(stage("sufficiency-submit", "clarify ask")).toBe("clarification");
    expect(stage("clarify-answer", "context submit")).toBe("analysis");
    expect(stage("context-submit", "context request")).toBe("analysis");
    expect(stage("evaluate", "compile")).toBe("compilation");
  });

  it("compile and clarify ask without a verdict are illegal, so the table applies", () => {
    expect(inProgressStage(at("context-submit"), "clarify ask")).toBe("assessment");
    expect(inProgressStage(at("context-submit"), "compile")).toBe("assessment");
  });

  it("a verdict awaiting approval does not make compile or clarify ask legal", () => {
    const pending = {
      completedSteps: ["sufficiency-submit"],
      sufficiency: { outcome: "insufficient", approval: "pending" },
    } as unknown as SessionState;
    expect(inProgressStage(pending, "compile")).toBe("compilation");
    expect(inProgressStage(pending, "clarify ask")).toBe("compilation");
  });

  it("an illegal command falls back to the table", () => {
    const stage = (last: CompletedStep, c: CliCommand) => inProgressStage(at(last), c);
    expect(stage("sufficiency-submit", "context submit")).toBe("compilation");
    expect(stage("clarify-answer", "context request")).toBe("compilation");
    expect(stage("discover", "compile")).toBe("analysis");
    expect(stage("evaluate", "clarify ask")).toBe("evaluation");
  });
});
