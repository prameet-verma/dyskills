import { describe, expect, it } from "vitest";
import {
  PerformanceReportSchema,
  SlaClock,
  buildDiscoveryReport,
  buildPerformanceReport,
  DiscoveryReportSchema,
  type Evidence,
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
      lastCommandEndedAtActiveMs: null,
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

function ev(key: string, origin: Evidence["origin"], confidence: Evidence["confidence"]): Evidence {
  return {
    key,
    value: "v",
    category: "runtime",
    source: "s",
    confidence,
    timestamp: "t",
    revision: "r",
    conflicts: [],
    origin,
  };
}

describe("buildDiscoveryReport", () => {
  it("computes the programmatic fact share, excluding user answers", () => {
    const s = state();
    s.metrics.stageMs = { discovery: 12, analysis: 34 };
    const r = buildDiscoveryReport(s, null, [
      ev("a", "programmatic", "verified"),
      ev("b", "programmatic", "verified"),
      ev("c", "programmatic", "verified"),
      ev("d", "agentic", "verified"),
      ev("e", "user", "verified"),
      ev("f", "agentic", "inferred"),
    ]);
    expect(r.programmaticFactShare).toBe(0.75);
    expect(r.evidenceByOrigin).toEqual({ programmatic: 3, agentic: 2, user: 1 });
    expect(r.programmaticMs).toBe(12);
    expect(r.agenticMs).toBe(34);
    expect(r.contextRequests).toBe(2);
    expect(r.detectorErrors).toEqual([]);
    expect(r.limitations).toBeNull();
    expect(DiscoveryReportSchema.safeParse(r).success).toBe(true);
  });

  it("is null when nothing is verified and defaults missing stages to 0", () => {
    const s = state();
    s.metrics.stageMs = {};
    const r = buildDiscoveryReport(s, null, [ev("e", "user", "verified")]);
    expect(r.programmaticFactShare).toBeNull();
    expect(r.programmaticMs).toBe(0);
    expect(r.agenticMs).toBe(0);
  });
});
