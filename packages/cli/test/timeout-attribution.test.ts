import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_BUDGET_MS } from "@dynamic-skills/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analysisFixture, discovered, groundedAnalysis, harness, ready, verdict } from "./helpers";
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

  it("does not overwrite an already recorded analysis time", async () => {
    const id = await discovered(h);
    const path = join(h.home, "sessions", id, "session.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.metrics.stageMs.analysis = 4_321;
    await writeFile(path, JSON.stringify(state));
    h.clock.t += GAP;
    const file = await h.doc("analysis.json", await analysisFixture("minimal.json"));
    const r = await h.run(["context", "submit", "--session", id, "--file", file]);
    expect(r.out.error).toBe("TIMEOUT");
    expect((await h.readJson(id, "session.json")).metrics.stageMs.analysis).toBe(4_321);
  });

  it("clean of an abandoned, expired session archives the capped analysis time", async () => {
    const id = await discovered(h);
    h.clock.t += 2 * GAP;
    await h.run(["clean", "--session", id]);
    const archived = JSON.parse(await readFile(join(h.home, "reports", `${id}.json`), "utf8"));
    expect(archived.outcome).toBe("timeout");
    expect(archived.stageMs.analysis).toBe(DEFAULT_BUDGET_MS);
  });
});
