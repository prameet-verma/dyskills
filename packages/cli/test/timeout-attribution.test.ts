import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_BUDGET_MS } from "@dynamic-skills/core";
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
});
