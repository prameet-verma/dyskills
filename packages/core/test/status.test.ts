import { describe, expect, it } from "vitest";
import { SlaClock, renderStatus, type SessionState } from "../src/index";

function state(
  over: Partial<SessionState>,
  sla = SlaClock.start(60_000, 0).snapshot(0),
): SessionState {
  return {
    schemaVersion: "1",
    id: "ds-1",
    task: "t",
    mode: "auto",
    explicit: false,
    repo: "/r",
    revision: "x",
    status: "assessing",
    createdAt: "2026-01-01T00:00:00.000Z",
    sla,
    completedSteps: [],
    clarification: { round: 0, asked: [], pending: [], answers: [] },
    assumptions: [],
    gaps: [],
    blockedBy: [],
    evalAttempts: 0,
    requirements: [],
    sufficiency: null,
    metrics: {
      wallStartedAt: 0,
      stageMs: {},
      humanWaitMs: 0,
      llmInteractions: 0,
      parallelOps: 0,
      cacheHits: 0,
      cacheLookups: 0,
      evaluationMs: 0,
      activationMs: 0,
      contextRequests: 0,
      contextRequestRounds: 0,
      analysisSubmissions: 0,
      packetTokens: 0,
      analysisStartedAtActiveMs: null,
      analysisBaselineMs: null,
      lastCommandEndedAtActiveMs: null,
    },
    ...over,
  };
}
const q = (id: string) => ({ id, text: "?", requirement: "r", material: true, blocking: true });

const WAITING_TEXT = `Dynamic Skills

Status: Waiting for clarification

Round: 1 of 3
Questions pending: 2

Processing SLA: PAUSED
Active processing used: 18s / 60s

The root agent is waiting for your response.`;

const RESUMING_TEXT = `Dynamic Skills

Status: Resuming generation

Clarification: Received
Processing SLA: RESUMED

Active processing remaining: 42s`;

const RESUMING_APPROVAL_TEXT = RESUMING_TEXT.replace(
  "Clarification: Received",
  "Approval: Received",
);

describe("renderStatus", () => {
  it("labels the analysis stage (M3)", () => {
    const text = renderStatus(state({ status: "analysing" }), 12_000);
    expect(text).toContain("Status: Analysing");
    expect(text).toContain("Processing SLA: RUNNING");
  });

  it("renders the waiting block exactly", () => {
    const clock = SlaClock.start(60_000, 0);
    clock.pause(18_000);
    const s = state({
      status: "waiting-for-clarification",
      sla: clock.snapshot(18_000),
      clarification: { round: 1, asked: [q("a"), q("b")], pending: [q("a"), q("b")], answers: [] },
    });
    expect(renderStatus(s, 100_000)).toBe(WAITING_TEXT);
  });

  it("renders the resuming block exactly", () => {
    const clock = SlaClock.start(60_000, 0);
    clock.pause(18_000);
    clock.resume(100_000);
    const s = state({ status: "resuming", sla: clock.snapshot(100_000) });
    expect(renderStatus(s, 100_000)).toBe(RESUMING_TEXT);
  });

  it("renders the waiting-for-approval block with a paused SLA", () => {
    const clock = SlaClock.start(60_000, 0);
    clock.pause(18_000);
    const s = state({ status: "waiting-for-approval", sla: clock.snapshot(18_000) });
    expect(renderStatus(s, 100_000)).toBe(
      "Dynamic Skills\n\nStatus: Waiting for approval\n\nProcessing SLA: PAUSED\nActive processing used: 18s / 60s",
    );
  });

  it("renders 'Approval: Received' when resuming after sufficiency-approve", () => {
    const clock = SlaClock.start(60_000, 0);
    clock.pause(18_000);
    clock.resume(100_000);
    const s = state({
      status: "resuming",
      sla: clock.snapshot(100_000),
      completedSteps: ["sufficiency-approve"],
    });
    expect(renderStatus(s, 100_000)).toBe(RESUMING_APPROVAL_TEXT);
  });

  it("renders running statuses with floored seconds", () => {
    const s = state({ status: "discovering" });
    expect(renderStatus(s, 12_999)).toBe(
      "Dynamic Skills\n\nStatus: Discovering\n\nProcessing SLA: RUNNING\nActive processing used: 12s / 60s",
    );
  });

  it("renders every terminal status as STOPPED with the frozen active time (M2)", () => {
    const clock = SlaClock.start(60_000, 0);
    clock.pause(7_500);
    const frozen = clock.snapshot(7_500);
    for (const status of ["completed", "warning", "failed", "timeout"] as const) {
      const text = renderStatus(state({ status }, frozen), 7_500 + 3_600_000);
      expect(text, status).toContain("Processing SLA: STOPPED");
      expect(text, status).toContain("Active processing used: 7s / 60s");
    }
  });

  it("renders failed with its long label", () => {
    expect(renderStatus(state({ status: "failed" }), 1000)).toContain(
      "Status: Failed — returning control to the root agent",
    );
    expect(renderStatus(state({ status: "warning" }), 1000)).toContain("Completed with warnings");
  });

  it("prints the configured budget", () => {
    const s = state({ status: "generating" }, SlaClock.start(90_000, 0).snapshot(0));
    expect(renderStatus(s, 0)).toContain("0s / 90s");
  });
});
