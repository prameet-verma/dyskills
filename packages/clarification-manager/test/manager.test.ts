import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SessionStateSchema,
  SessionStore,
  SlaClock,
  renderStatus,
  type Assumption,
  type Question,
  type SessionState,
} from "@dynamic-skills/core";
import { EvidenceRegistry } from "@dynamic-skills/evidence-registry";
import { ClarificationManager } from "../src/index";

const q = (id: string, over: Partial<Question> = {}): Question => ({
  id,
  text: `What is ${id}?`,
  requirement: "database",
  material: true,
  blocking: false,
  ...over,
});

let state: SessionState;
let registry: EvidenceRegistry;
let mgr: ClarificationManager;

beforeEach(async () => {
  const home = mkdtempSync(join(tmpdir(), "ds-clar-"));
  state = await new SessionStore(home).create({
    task: "t",
    mode: "auto",
    explicit: false,
    repo: "/r",
    revision: "rev1",
    now: 0,
  });
  rmSync(home, { recursive: true, force: true });
  registry = new EvidenceRegistry();
  mgr = new ClarificationManager(state, registry);
});

describe("ClarificationManager.ask", () => {
  it("pauses the SLA for an accepted round", () => {
    const r = mgr.ask([q("q1"), q("q2")], 18_000);
    expect(r).toMatchObject({ round: 1, accepted: [{ id: "q1" }, { id: "q2" }] });
    expect(state.status).toBe("waiting-for-clarification");
    expect(state.clarification.pending).toHaveLength(2);
    expect(renderStatus(state, 50_000)).toContain("Processing SLA: PAUSED");
  });

  it("rejects questions answerable from verified evidence", () => {
    registry.add({
      key: "db",
      value: "postgres",
      category: "database",
      source: "package.json",
      confidence: "verified",
      revision: "rev1",
    });
    registry.add({
      key: "fw",
      value: "x",
      category: "framework",
      source: "s",
      confidence: "inferred",
      revision: "rev1",
    });
    const r = mgr.ask([q("q1", { evidenceKey: "db" }), q("q2", { evidenceKey: "fw" })], 1);
    expect(r.rejected).toEqual([{ id: "q1", reason: "answerable-by-evidence" }]);
    expect(r.accepted.map((x) => x.id)).toEqual(["q2"]);
  });

  it("rejects questions whose requirement still awaits inspection", () => {
    state.gaps = [
      {
        requirement: "architecture",
        category: "architecture",
        status: "needs-investigation",
        resolution: "inspect",
        evidenceKeys: [],
        material: true,
      },
    ];
    const r = mgr.ask([q("q1", { requirement: "architecture" }), q("q2")], 1);
    expect(r.rejected).toEqual([{ id: "q1", reason: "answerable-by-discovery" }]);
    expect(r.accepted.map((x) => x.id)).toEqual(["q2"]);
  });

  it("rejects non-material and duplicate questions", () => {
    const r = mgr.ask(
      [
        q("q1"),
        q("q2", { material: false }),
        q("q3", { text: "  WHAT is   q1?? " }),
        q("q4", { text: "What is q1?" }),
      ],
      1,
    );
    expect(r.accepted.map((x) => x.id)).toEqual(["q1"]);
    expect(r.rejected).toEqual([
      { id: "q2", reason: "not-material" },
      { id: "q3", reason: "duplicate" },
      { id: "q4", reason: "duplicate" },
    ]);
    // Also duplicate against questions from earlier rounds.
    mgr.answer([{ questionId: "q1", status: "answered", value: "v" }], 2);
    expect(mgr.ask([q("q5", { text: "what is q1?" })], 3).rejected[0]?.reason).toBe("duplicate");
  });

  it("treats reused question ids as duplicates", () => {
    mgr.ask([q("q1")], 1);
    mgr.answer([{ questionId: "q1", status: "answered", value: "v" }], 2);
    expect(mgr.ask([q("q1", { text: "brand new text" })], 3).rejected).toEqual([
      { id: "q1", reason: "duplicate" },
    ]);
    const r = mgr.ask([q("x", { text: "a?" }), q("x", { text: "b?" })], 4);
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected).toEqual([{ id: "x", reason: "duplicate" }]);
  });

  it("throws when a round is still pending", () => {
    mgr.ask([q("q1")], 1);
    const snapshot = structuredClone(state);
    expect(() => mgr.ask([q("q2", { text: "z?" })], 2)).toThrow(
      "A clarification round is still pending",
    );
    expect(state).toEqual(snapshot);
  });

  it("treats NFC and NFD text as duplicates", () => {
    mgr.ask([q("q1", { text: "Use caf\u00e9?" })], 1);
    mgr.answer([], 2);
    const r = mgr.ask([q("q2", { text: "Use cafe\u0301?" })], 3);
    expect(r.rejected).toEqual([{ id: "q2", reason: "duplicate" }]);
  });

  it("enforces three rounds", () => {
    for (let i = 1; i <= 3; i++) {
      expect(mgr.canAskMore()).toBe(true);
      mgr.ask([q(`r${i}`)], i);
      mgr.answer([{ questionId: `r${i}`, status: "answered", value: "v" }], i);
    }
    expect(mgr.canAskMore()).toBe(false);
    const r = mgr.ask([q("late"), q("late2", { material: false })], 10);
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toEqual([
      { id: "late", reason: "round-limit" },
      { id: "late2", reason: "round-limit" },
    ]);
    expect(r.round).toBe(3);
  });

  it("does not consume a round when nothing is accepted", () => {
    const before = structuredClone(state.sla);
    const r = mgr.ask([q("q1", { material: false })], 5_000);
    expect(r).toMatchObject({ round: 0, accepted: [] });
    expect(state.clarification.round).toBe(0);
    expect(state.status).toBe("assessing");
    expect(state.sla).toEqual(before);
  });
});

describe("ClarificationManager.answer", () => {
  it("resumes, records wait and stores answers as user evidence", () => {
    mgr.ask([q("q1")], 18_000);
    const r = mgr.answer([{ questionId: "q1", status: "answered", value: "Redis" }], 100_000);
    expect(state.metrics.humanWaitMs).toBe(82_000);
    expect(SlaClock.from(state.sla).activeMs(100_000)).toBe(18_000);
    expect(SlaClock.from(state.sla).isPaused()).toBe(false);
    expect(state.status).toBe("resuming");
    expect(state.clarification.pending).toEqual([]);
    expect(r.evidenceAdded).toEqual(["user.q1"]);
    expect(registry.get("user.q1")).toMatchObject({
      value: "Redis",
      confidence: "verified",
      origin: "user",
      category: "user",
      source: "user",
    });
  });

  it("turns declines into assumptions, never evidence", () => {
    mgr.ask([q("q1"), q("q2"), q("q3")], 1_000);
    const r = mgr.answer(
      [
        { questionId: "q1", status: "declined" },
        {
          questionId: "q2",
          status: "skipped",
          assumption: { assumption: "Use sqlite", basis: "Default", impact: "Low" },
        },
        { questionId: "q3", status: "answered", value: "x" },
      ],
      2_000,
    );
    expect(r.evidenceAdded).toEqual(["user.q3"]);
    expect(registry.get("user.q1")).toBeUndefined();
    expect(registry.get("user.q2")).toBeUndefined();
    expect(r.assumptions).toEqual([
      {
        questionId: "q1",
        question: "What is q1?",
        assumption: "Proceeding without this information",
        basis: "No answer provided",
        impact: "Skill may not reflect this decision",
        status: "declined",
      },
      {
        questionId: "q2",
        question: "What is q2?",
        assumption: "Use sqlite",
        basis: "Default",
        impact: "Low",
        status: "skipped",
      },
    ]);
    expect(state.assumptions).toEqual(r.assumptions);
  });

  it("blocks activation when a blocking question is declined", () => {
    mgr.ask([q("q1", { blocking: true }), q("q2", { blocking: true }), q("q3")], 1);
    const r = mgr.answer(
      [
        { questionId: "q1", status: "declined" },
        { questionId: "q2", status: "answered", value: "ok" },
        { questionId: "q3", status: "declined" },
      ],
      2,
    );
    expect(r.blockingUnresolved).toEqual(["q1"]);
    expect(state.blockedBy).toEqual(["q1"]);
  });

  it("records unanswered pending questions as assumptions", () => {
    mgr.ask([q("q1"), q("q2", { blocking: true })], 1);
    const r = mgr.answer([{ questionId: "q1", status: "answered", value: "v" }], 2);
    expect(r.assumptions).toMatchObject([{ questionId: "q2", status: "unanswered" }]);
    expect(r.blockingUnresolved).toEqual(["q2"]);
    expect(state.blockedBy).toEqual(["q2"]);
  });

  it("keeps existing not-asked assumptions", () => {
    const existing: Assumption = {
      questionId: "analysis-1",
      question: "Q?",
      assumption: "A",
      basis: "B",
      impact: "I",
      status: "not-asked",
    };
    state.assumptions.push(existing);
    mgr.ask([q("q1")], 1);
    mgr.answer([{ questionId: "q1", status: "declined" }], 2);
    expect(state.assumptions[0]).toEqual(existing);
    expect(state.assumptions).toHaveLength(2);
  });

  it("throws for unknown question ids without mutating state", () => {
    mgr.ask([q("q1")], 1);
    const snapshot = structuredClone(state);
    expect(() => mgr.answer([{ questionId: "nope", status: "answered", value: "x" }], 2)).toThrow(
      "Question nope is not pending",
    );
    expect(state).toEqual(snapshot);
  });

  it("rejects answers to closed rounds without mutating state", () => {
    mgr.ask([q("q1", { blocking: true })], 1);
    mgr.answer([{ questionId: "q1", status: "declined" }], 2);
    mgr.ask([q("q2", { text: "other?" })], 3);
    const snapshot = structuredClone(state);
    expect(() => mgr.answer([{ questionId: "q1", status: "answered", value: "x" }], 4)).toThrow(
      "Question q1 is not pending",
    );
    expect(state).toEqual(snapshot);
    expect(registry.get("user.q1")).toBeUndefined();
  });

  it("accepts an empty answer list", () => {
    mgr.ask([q("q1")], 1);
    const r = mgr.answer([], 2);
    expect(r.assumptions).toMatchObject([{ questionId: "q1", status: "unanswered" }]);
  });

  it("rejects blank answered values without mutating state", () => {
    mgr.ask([q("q1", { blocking: true })], 1);
    const snapshot = structuredClone(state);
    for (const value of [undefined, "", "  \n"]) {
      expect(() => mgr.answer([{ questionId: "q1", status: "answered", value }], 2)).toThrow(
        "Answer for q1 has no value",
      );
    }
    expect(state).toEqual(snapshot);
    expect(state.blockedBy).toEqual([]);
  });

  it("leaves status unchanged when nothing was waiting", () => {
    mgr.answer([], 5);
    expect(state.status).toBe("assessing");
  });

  it("survives a persistence round-trip between ask and answer", () => {
    mgr.ask([q("q1")], 18_000);
    const reloaded = SessionStateSchema.parse(JSON.parse(JSON.stringify(state)));
    expect(renderStatus(reloaded, 50_000)).toContain("Processing SLA: PAUSED");
    new ClarificationManager(reloaded, registry).answer(
      [{ questionId: "q1", status: "answered", value: "Redis" }],
      100_000,
    );
    expect(reloaded.metrics.humanWaitMs).toBe(82_000);
    expect(SlaClock.from(reloaded.sla).activeMs(100_000)).toBe(18_000);
  });
});
