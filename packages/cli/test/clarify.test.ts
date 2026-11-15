/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analysed, harness, verdict } from "./helpers";
import type { Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.cleanup());

const DB_TASK = "Add a database migration for the orders table";

const question = (over: Record<string, unknown> = {}) => ({
  id: "q-migration",
  text: "What migration rollout policy applies?",
  requirement: "migration-policy",
  material: true,
  blocking: true,
  ...over,
});

/** A session at the point where clarification may start (insufficient verdict recorded). */
async function ready(task = DB_TASK): Promise<string> {
  const id = await analysed(h, task);
  const file = await h.doc("verdict.json", verdict({ outcome: "insufficient" }));
  const r = await h.run(["sufficiency", "submit", "--session", id, "--file", file]);
  expect(r.exitCode).toBe(0);
  return id;
}

async function ask(id: string, ...questions: unknown[]) {
  const file = await h.doc("q.json", { schemaVersion: "1", questions });
  return h.run(["clarify", "ask", "--session", id, "--file", file]);
}

async function answer(id: string, ...answers: unknown[]) {
  const file = await h.doc("a.json", { schemaVersion: "1", answers });
  return h.run(["clarify", "answer", "--session", id, "--file", file]);
}

describe("clarification field limits (M6)", () => {
  it("accepts the bootstrap skill's r1-q1 id convention", async () => {
    const id = await ready();
    const r = await ask(id, question({ id: "r1-q1" }));
    expect(r.out.accepted.map((q: any) => q.id)).toEqual(["r1-q1"]);
  });

  it.each([["has space"], ["a,b"], [""], ["Upper"], ["a".repeat(65)], ["-lead"]])(
    "rejects the question id %j with SCHEMA_INVALID",
    async (bad) => {
      const id = await ready();
      const r = await ask(id, question({ id: bad }));
      expect(r.exitCode).toBe(1);
      expect(r.out.error).toBe("SCHEMA_INVALID");
      expect(r.out.issues[0].path).toBe("questions.0.id");
      expect((await h.readJson(id, "session.json")).clarification.round).toBe(0);
    },
  );

  it("caps question text, requirement, answer value and assumption fields", async () => {
    const id = await ready();
    expect((await ask(id, question({ text: "x".repeat(1001) }))).out.error).toBe("SCHEMA_INVALID");
    expect((await ask(id, question({ requirement: "x".repeat(201) }))).out.error).toBe(
      "SCHEMA_INVALID",
    );
    expect((await ask(id, question({ text: "x".repeat(1000) }))).exitCode).toBe(0);
    const long = (value: string) =>
      answer(id, { questionId: "q-migration", status: "answered", value });
    expect((await long("x".repeat(2001))).out.error).toBe("SCHEMA_INVALID");
    const declined = (field: string) =>
      answer(id, {
        questionId: "q-migration",
        status: "declined",
        assumption: { assumption: "a", basis: "b", impact: "i", [field]: "x".repeat(1001) },
      });
    for (const field of ["assumption", "basis", "impact"]) {
      expect((await declined(field)).out.error, field).toBe("SCHEMA_INVALID");
    }
    expect((await long("x".repeat(2000))).exitCode).toBe(0);
  });
});

describe("clarify ask", () => {
  it("pauses the SLA and reports round 1 of 3", async () => {
    const id = await ready();
    const r = await ask(id, question());
    expect(r.exitCode).toBe(0);
    expect(r.out.round).toBe(1);
    expect(r.out.accepted.map((q: any) => q.id)).toEqual(["q-migration"]);
    expect(r.out.rejected).toEqual([]);
    expect(r.stderr).toContain("Processing SLA: PAUSED");
    expect(r.stderr).toContain("Round: 1 of 3");
    const state = await h.readJson(id, "session.json");
    expect(state.status).toBe("waiting-for-clarification");
    expect(state.completedSteps.at(-1)).toBe("clarify-ask");
    expect(state.sla.paused).toBe(true);
  });

  it("does not record a step when every question is rejected", async () => {
    const id = await ready();
    const r = await ask(id, question({ material: false }));
    expect(r.exitCode).toBe(0);
    expect(r.out.accepted).toEqual([]);
    expect(r.out.rejected).toEqual([{ id: "q-migration", reason: "not-material" }]);
    const state = await h.readJson(id, "session.json");
    expect(state.completedSteps.at(-1)).toBe("sufficiency-submit");
    expect(state.clarification.round).toBe(0);
    // The agent is not stuck: it can ask again.
    expect((await ask(id, question())).out.accepted).toHaveLength(1);
  });

  it("rejects an invalid document", async () => {
    const id = await ready();
    const r = await ask(id, { id: "q" });
    expect(r.out.error).toBe("SCHEMA_INVALID");
  });
});

describe("clarify answer", () => {
  it("adds user evidence under the question id and the requirement and verifies the gap", async () => {
    const id = await ready();
    await ask(id, question());
    h.clock.t += 20_000;
    const r = await answer(id, {
      questionId: "q-migration",
      status: "answered",
      value: "Expand and contract; no downtime",
    });
    expect(r.exitCode).toBe(0);
    expect(r.out.evidenceAdded).toEqual(["user.q-migration", "user.migration-policy"]);
    expect(r.out.blockingUnresolved).toEqual([]);
    expect(r.stderr).toContain("Processing SLA: RESUMED");
    const evidence = (await h.readJson(id, "evidence.json")).items;
    const alias = evidence.find((e: any) => e.key === "user.migration-policy");
    expect(alias).toMatchObject({ origin: "user", confidence: "verified", category: "user" });
    const state = await h.readJson(id, "session.json");
    expect(state.gaps.find((g: any) => g.requirement === "migration-policy").status).toBe(
      "verified",
    );
    expect(state.metrics.humanWaitMs).toBe(20_000);
    expect(state.completedSteps.at(-1)).toBe("clarify-answer");
  });

  it("does not alias when the question id equals the requirement", async () => {
    const id = await ready();
    await ask(id, question({ id: "migration-policy" }));
    const r = await answer(id, {
      questionId: "migration-policy",
      status: "answered",
      value: "Online only",
    });
    expect(r.out.evidenceAdded).toEqual(["user.migration-policy"]);
    expect(r.out.warnings).toEqual([]);
  });

  it("warns instead of overriding an existing different user.<requirement> value", async () => {
    const id = await ready();
    await ask(id, question({ id: "q1" }));
    await answer(id, { questionId: "q1", status: "answered", value: "Online only" });
    await ask(id, question({ id: "q2", text: "Is a maintenance window allowed instead?" }));
    const r = await answer(id, { questionId: "q2", status: "answered", value: "Window allowed" });
    expect(r.exitCode).toBe(0);
    expect(r.out.evidenceAdded).toEqual(["user.q2"]);
    expect(r.out.warnings).toEqual([expect.stringContaining("user.migration-policy")]);
    const evidence = (await h.readJson(id, "evidence.json")).items;
    const alias = evidence.find((e: any) => e.key === "user.migration-policy");
    expect(alias.value).toBe("Online only");
    expect(alias.confidence).toBe("verified");
  });

  it("turns a decline into an assumption, never evidence", async () => {
    const id = await ready();
    await ask(id, question());
    const r = await answer(id, {
      questionId: "q-migration",
      status: "declined",
      assumption: { assumption: "Online migration", basis: "Safest default", impact: "Slower" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.out.assumptions).toHaveLength(1);
    expect(r.out.evidenceAdded).toEqual([]);
    expect(r.out.blockingUnresolved).toEqual(["q-migration"]);
    // A blocking question left unresolved ends the session (Ruling R20).
    expect(r.stderr).toContain("Status: Completed");
    expect(r.stderr).toContain("Processing SLA: STOPPED");
    const state = await h.readJson(id, "session.json");
    expect(state.assumptions.filter((a: any) => a.status === "declined")).toHaveLength(1);
    expect(state.gaps.find((g: any) => g.requirement === "migration-policy").status).toBe(
      "missing",
    );
  });

  it("rejects an unknown question id with USAGE and leaves the session unchanged", async () => {
    const id = await ready();
    await ask(id, question());
    const before = await h.read(id, "session.json");
    const r = await answer(id, { questionId: "nope", status: "answered", value: "x" });
    expect(r.exitCode).toBe(1);
    expect(r.out.error).toBe("USAGE");
    expect(await h.read(id, "session.json")).toBe(before);
  });

  it("rejects a blank answered value and answers without a pending round", async () => {
    const id = await ready();
    const none = await answer(id, { questionId: "q", status: "answered", value: "x" });
    expect(none.out.error).toBe("INVALID_STATE");
    await ask(id, question());
    const blank = await answer(id, { questionId: "q-migration", status: "answered", value: " " });
    expect(blank.out.error).toBe("USAGE");
  });

  it("allows another analysis after clarification", async () => {
    const id = await ready();
    await ask(id, question());
    await answer(id, { questionId: "q-migration", status: "answered", value: "Online only" });
    const file = await h.doc("analysis.json", {
      schemaVersion: "1",
      analysedPacketRevision: 1,
      technology: { languages: [], frameworks: [], runtimes: [], packageManagers: [] },
      architecture: { patterns: [], moduleStructure: [], conventions: [], dependencies: [] },
      taskContext: { relevantComponents: [], existingImplementations: [], constraints: [] },
      evidence: [],
      unknowns: [],
      conflicts: [],
    });
    const r = await h.run(["context", "submit", "--session", id, "--file", file]);
    expect(r.exitCode).toBe(0);
    // user evidence survives the agentic rebuild
    const keys = (await h.readJson(id, "evidence.json")).items.map((e: any) => e.key);
    expect(keys).toContain("user.migration-policy");
  });
});
