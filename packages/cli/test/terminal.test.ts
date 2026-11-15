import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/run";
import { analysed, harness, installGolden, ready, record, verdict } from "./helpers";
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

const DB_TASK = "Add a database migration for the orders table";

/** A session waiting on one blocking clarification question. */
async function askedBlocking(): Promise<string> {
  const id = await analysed(h, DB_TASK);
  const v = await h.doc("verdict.json", verdict({ outcome: "insufficient" }));
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
  return id;
}

/** Answers the blocking question with a decline. */
async function decline(id: string) {
  const a = await h.doc("a.json", {
    schemaVersion: "1",
    answers: [
      {
        questionId: "q-migration",
        status: "declined",
        assumption: { assumption: "Online migration", basis: "Safest default", impact: "Slower" },
      },
    ],
  });
  return h.run(["clarify", "answer", "--session", id, "--file", a]);
}

describe("a declined blocking question ends the session (I4a, R20)", () => {
  it("completes the session as skipped with reports and a fallback", async () => {
    const id = await askedBlocking();
    h.clock.t += 5_000; // human wait, not active time
    const r = await decline(id);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatchObject({
      ok: true,
      blockingUnresolved: ["q-migration"],
      fallback: "Continue the original task with existing capabilities.",
    });
    expect(r.stderr).toContain("Status: Completed");
    expect(r.stderr).toContain("Processing SLA: STOPPED");
    const state = await h.readJson(id, "session.json");
    expect(state.status).toBe("completed");
    expect(state.metrics.outcome).toBe("skipped");
    expect(state.completedSteps.at(-1)).toBe("clarify-answer");
    expect((await h.readJson(id, "reports/performance.json")).outcome).toBe("skipped");
    expect(await h.exists(id, "reports/discovery.json")).toBe(true);
    const assumptions = await h.readJson(id, "reports/assumptions.json");
    expect(assumptions.items.map((a: { status: string }) => a.status)).toContain("declined");
  });

  it("refuses compile afterwards with INVALID_STATE and expected []", async () => {
    const id = await askedBlocking();
    await decline(id);
    const r = await h.run(["compile", "--session", id]);
    expect(r.exitCode).toBe(1);
    expect(r.out).toMatchObject({ error: "INVALID_STATE", expected: [] });
  });

  it("is counted by report perf", async () => {
    const id = await askedBlocking();
    await decline(id);
    const r = await h.run(["report", "perf"]);
    expect(r.out.count).toBe(1);
    expect(r.out.fallbackRate).toBe(0);
    expect(id).toMatch(/^ds-/);
  });

  it("keeps an answered blocking question non-terminal", async () => {
    const id = await askedBlocking();
    const a = await h.doc("a.json", {
      schemaVersion: "1",
      answers: [{ questionId: "q-migration", status: "answered", value: "Online only" }],
    });
    const r = await h.run(["clarify", "answer", "--session", id, "--file", a]);
    expect(r.out.fallback).toBeUndefined();
    expect((await h.readJson(id, "session.json")).status).not.toBe("completed");
    expect(await h.exists(id, "reports/performance.json")).toBe(false);
  });
});

describe("a changed base ends the session (I4b, R20)", () => {
  it("compile BASE_CHANGED is a saved terminal failure with reports", async () => {
    const id = await ready(h, "partial");
    const base = (await h.readJson(id, "skills-scan.json")).skills[0].path as string;
    await appendFile(base, "\nAn extra line.\n");
    const r = await h.run(["compile", "--session", id]);
    expect(r.exitCode).toBe(1);
    expect(r.out).toMatchObject({
      ok: false,
      error: "BASE_CHANGED",
      fallback: "Continue the original task with existing capabilities.",
    });
    expect(r.stderr).toContain("Error BASE_CHANGED");
    expect(r.stderr).toContain("Status: Failed");
    const state = await h.readJson(id, "session.json");
    expect(state.status).toBe("failed");
    expect(state.metrics.outcome).toBe("failed");
    expect(state.completedSteps.at(-1)).toBe("sufficiency-submit");
    expect(await h.exists(id, "brief.md")).toBe(false);
    for (const f of ["performance.json", "discovery.json", "assumptions.json"]) {
      expect(await h.exists(id, `reports/${f}`), f).toBe(true);
    }
    expect((await h.readJson(id, "reports/performance.json")).outcome).toBe("failed");
    const again = await h.run(["compile", "--session", id]);
    expect(again.out).toMatchObject({ error: "INVALID_STATE", expected: [] });
  });

  it("activate base-changed refuses with ACTIVATION_REFUSED, ends failed and writes reports", async () => {
    const id = await ready(h, "partial");
    await h.run(["compile", "--session", id]);
    await installGolden(h, id, "augmentation/order-caching-augment");
    await h.run(["evaluate", "--session", id]);
    expect((await record(h, id)).exitCode).toBe(0);
    const base = (await h.readJson(id, "skills-scan.json")).skills[0].path as string;
    await appendFile(base, "\nChanged after the verdict.\n");
    const r = await h.run(["activate", "--session", id]);
    expect(r.exitCode).toBe(2);
    expect(r.out).toMatchObject({
      ok: false,
      error: "ACTIVATION_REFUSED",
      activated: false,
      reason: "base-changed",
      fallback: "Continue the original task with existing capabilities.",
    });
    expect(r.out.message).toMatch(/base skill changed/i);
    expect(r.stderr).toContain("Error ACTIVATION_REFUSED");
    expect((await h.readJson(id, "session.json")).status).toBe("failed");
    for (const f of ["performance.json", "discovery.json", "assumptions.json"]) {
      expect(await h.exists(id, `reports/${f}`), f).toBe(true);
    }
  });
});

describe("clean archives the metrics (I4c, R21)", () => {
  it("keeps a cleaned session in report perf, counted once", async () => {
    const id = await askedBlocking();
    await decline(id);
    const archived = join(h.home, "reports", `${id}.json`);
    expect((await h.run(["report", "perf"])).out.count).toBe(1);
    const r = await h.run(["clean", "--session", id]);
    expect(r.out).toMatchObject({ ok: true, removed: true, archived: true });
    expect(await h.exists(id, "session.json")).toBe(false);
    expect((await stat(archived)).mode & 0o777).toBe(0o600);
    expect((await stat(join(h.home, "reports"))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(archived, "utf8"))).toMatchObject({
      sessionId: id,
      outcome: "skipped",
    });
    expect((await h.run(["report", "perf"])).out.count).toBe(1);
  });

  it("ends an unended session as failed, writes reports and archives it (R22)", async () => {
    const id = await analysed(h);
    h.clock.t += 5_000;
    const r = await h.run(["clean", "--session", id]);
    expect(r.out).toMatchObject({ ok: true, removed: true, archived: true });
    expect(await h.exists(id, "session.json")).toBe(false);
    const archived = JSON.parse(await readFile(join(h.home, "reports", `${id}.json`), "utf8"));
    expect(archived).toMatchObject({ sessionId: id, outcome: "failed" });
    const perf = (await h.run(["report", "perf"])).out;
    expect(perf.count).toBe(1);
    expect(perf.fallbackRate).toBe(1);
  });

  it("archives an abandoned, expired session as timeout with activeMs capped at the budget", async () => {
    const id = await analysed(h);
    h.clock.t += 2 * HOUR;
    const r = await h.run(["clean", "--session", id]);
    expect(r.out).toMatchObject({ removed: true, archived: true });
    const archived = JSON.parse(await readFile(join(h.home, "reports", `${id}.json`), "utf8"));
    expect(archived.outcome).toBe("timeout");
    expect(archived.activeMs).toBeLessThanOrEqual(60_000);
    const perf = (await h.run(["report", "perf"])).out;
    expect(perf.timeoutRate).toBe(1);
    expect(perf.maxActiveMs).toBeLessThanOrEqual(60_000);
  });

  it("archives an abandoned session within budget as failed with its real active time", async () => {
    const id = await analysed(h);
    h.clock.t += 5_000;
    await h.run(["clean", "--session", id]);
    const archived = JSON.parse(await readFile(join(h.home, "reports", `${id}.json`), "utf8"));
    expect(archived.outcome).toBe("failed");
    expect(archived.activeMs).toBeGreaterThanOrEqual(5_000);
    expect(archived.activeMs).toBeLessThan(60_000);
  });

  it("leaves no partial reports when a terminal report cannot be built", async () => {
    const id = await analysed(h);
    await writeFile(join(h.home, "sessions", id, "context-packet.json"), "{ corrupt");
    const r = await h.run(["clean", "--session", id]);
    expect(r.exitCode).not.toBe(0);
    expect(await h.exists(id, "session.json")).toBe(true);
    expect(await h.exists(id, "reports/performance.json")).toBe(false);
    expect(await stat(join(h.home, "reports", `${id}.json`)).catch(() => null)).toBeNull();
  });

  it("leaves no performance.json when a later report cannot be renamed into place", async () => {
    const id = await analysed(h);
    await mkdir(join(h.home, "sessions", id, "reports", "discovery.json"), { recursive: true });
    const r = await h.run(["clean", "--session", id]);
    expect(r.exitCode).not.toBe(0);
    expect(await h.exists(id, "reports/performance.json")).toBe(false);
    expect((await h.run(["report", "perf"])).out.count).toBe(0);
  });

  it("removes temp files when a temp write fails", async () => {
    const id = await analysed(h);
    await mkdir(join(h.home, "sessions", id, "reports", ".assumptions.json.tmp"), {
      recursive: true,
    });
    const r = await h.run(["clean", "--session", id]);
    expect(r.exitCode).not.toBe(0);
    for (const f of ["performance.json", ".performance.json.tmp", ".discovery.json.tmp"]) {
      expect(await h.exists(id, `reports/${f}`), f).toBe(false);
    }
  });

  it("archives an ended session's own outcome, not failed", async () => {
    const id = await askedBlocking();
    await decline(id);
    await h.run(["clean", "--session", id]);
    expect(JSON.parse(await readFile(join(h.home, "reports", `${id}.json`), "utf8")).outcome).toBe(
      "skipped",
    );
  });
});
