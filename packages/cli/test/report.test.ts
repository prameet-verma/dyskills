import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analysed, harness } from "./helpers";
import type { Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.cleanup());

describe("report perf", () => {
  it("runs with no session, printing the aggregate as JSON", async () => {
    const r = await h.run(["report", "perf"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatchObject({ ok: true, schemaVersion: "1", count: 0, p50ActiveMs: null });
    expect(r.stderr).toBe("");
  });

  it("is allowed while a session is mid-pipeline and does not touch it", async () => {
    const id = await analysed(h);
    const before = await h.read(id, "session.json");
    const r = await h.run(["report", "perf"]);
    expect(r.exitCode).toBe(0);
    // Unfinished sessions have no performance report yet.
    expect(r.out.count).toBe(0);
    expect(await h.read(id, "session.json")).toBe(before);
    expect(await h.exists(id, "session.lock")).toBe(false);
  });
});
