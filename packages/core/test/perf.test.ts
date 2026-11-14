import { describe, expect, it } from "vitest";
import {
  PerformanceReportSchema,
  SlaClock,
  buildPerformanceReport,
  type SessionState,
} from "../src/index";

function state(): SessionState {
  return {
    schemaVersion: "1",
    id: "ds-1",
    task: "t",
    mode: "auto",
    explicit: false,
    repo: "/r",
    revision: "x",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    sla: SlaClock.start(60_000, 1_000).snapshot(1_000),
    completedSteps: [],
    clarification: { round: 2, asked: [], pending: [], answers: [] },
    assumptions: [],
    gaps: [],
    blockedBy: [],
    evalAttempts: 0,
    requirements: [],
    sufficiency: null,
    metrics: {
      wallStartedAt: 1_000,
      stageMs: { discovery: 5 },
      humanWaitMs: 4_000,
      llmInteractions: 3,
      parallelOps: 2,
      cacheHits: 0,
      cacheLookups: 0,
      evaluationMs: 7,
      activationMs: 9,
      contextRequests: 2,
      contextRequestRounds: 1,
      analysisSubmissions: 1,
      packetTokens: 900,
      analysisStartedAtActiveMs: null,
      outcome: "activated",
    },
  };
}

describe("buildPerformanceReport", () => {
  it("builds a report with null cache hit rate when no lookups", () => {
    const r = buildPerformanceReport(state(), 11_000);
    expect(r).toEqual({
      schemaVersion: "1",
      sessionId: "ds-1",
      wallMs: 10_000,
      activeMs: 10_000,
      humanWaitMs: 4_000,
      clarificationRounds: 2,
      stageMs: { discovery: 5 },
      llmInteractions: 3,
      parallelOps: 2,
      cacheHitRate: null,
      evaluationMs: 7,
      activationMs: 9,
      contextRequests: 2,
      contextRequestRounds: 1,
      analysisSubmissions: 1,
      packetTokens: 900,
      outcome: "activated",
    });
    expect(PerformanceReportSchema.safeParse(r).success).toBe(true);
  });

  it("computes the cache hit rate", () => {
    const s = state();
    s.metrics.cacheHits = 1;
    s.metrics.cacheLookups = 4;
    expect(buildPerformanceReport(s, 2_000).cacheHitRate).toBe(0.25);
  });
});
