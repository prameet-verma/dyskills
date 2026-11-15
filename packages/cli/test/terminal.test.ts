import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/run";
import { harness, installGolden, ready, record } from "./helpers";
import type { Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.cleanup());

const HOUR = 3_600_000;

/** `status` prints plain text on stdout (R16), so it bypasses the JSON-parsing harness. */
const status = (id: string) =>
  runCli(["status", "--session", id], {
    home: h.home,
    cwd: h.repo,
    userHome: h.userHome,
    now: () => h.clock.t,
  });

describe("terminal sessions stop the clock (M2)", () => {
  it("freezes active time after activation and renders STOPPED", async () => {
    const id = await ready(h);
    await h.run(["compile", "--session", id]);
    await installGolden(h, id, "valid/order-cache-specialist");
    await h.run(["evaluate", "--session", id]);
    await record(h, id);
    h.clock.t += 2_000;
    const done = await h.run(["activate", "--session", id]);
    expect(done.exitCode).toBe(0);
    expect(done.stderr).toContain("Processing SLA: STOPPED");
    expect(done.stderr).toContain("Active processing used: 2s / 60s");
    h.clock.t += HOUR;
    const raw = await status(id);
    expect(raw.exitCode).toBe(0);
    expect(raw.stdout).toContain("Processing SLA: STOPPED");
    expect(raw.stdout).toContain("Active processing used: 2s / 60s");
    const perf = await h.readJson(id, "reports/performance.json");
    expect(perf.activeMs).toBe(2_000);
  });

  it("freezes a session that ended at assess (manual mode, no request)", async () => {
    const r = await h.run(["assess", "--task", "Add caching", "--mode", "manual"]);
    expect(r.out.recommendation).toBe("none");
    expect(r.stderr).toContain("Processing SLA: STOPPED");
    h.clock.t += HOUR;
    const state = await h.readJson(r.out.sessionId, "session.json");
    expect(state.sla.paused).toBe(true);
    expect(state.sla.activeMs).toBe(0);
  });
});
