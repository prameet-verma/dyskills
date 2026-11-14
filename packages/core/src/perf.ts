import { CONTRACT_VERSION } from "./constants";
import type { PerformanceReport } from "./contracts";
import type { SessionState } from "./schemas";
import { SlaClock } from "./sla";

/**
 * Builds the performance report for a session (PRD §10.8).
 *
 * `wallMs` is elapsed time since session start; `activeMs` excludes human waits.
 * `cacheHitRate` is `null` (not 0) when no cache lookups happened, so "no data" is distinguishable
 * from "all misses".
 */
export function buildPerformanceReport(s: SessionState, now: number): PerformanceReport {
  const m = s.metrics;
  return {
    schemaVersion: CONTRACT_VERSION,
    sessionId: s.id,
    wallMs: Math.max(0, now - m.wallStartedAt),
    activeMs: SlaClock.from(s.sla).activeMs(now),
    humanWaitMs: m.humanWaitMs,
    clarificationRounds: s.clarification.round,
    stageMs: { ...m.stageMs },
    llmInteractions: m.llmInteractions,
    parallelOps: m.parallelOps,
    cacheHitRate: m.cacheLookups === 0 ? null : m.cacheHits / m.cacheLookups,
    evaluationMs: m.evaluationMs,
    activationMs: m.activationMs,
    contextRequests: m.contextRequests,
    contextRequestRounds: m.contextRequestRounds,
    analysisSubmissions: m.analysisSubmissions,
    packetTokens: m.packetTokens,
    outcome: m.outcome,
  };
}
