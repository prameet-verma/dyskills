import { CONTRACT_VERSION } from "./constants";
import type { ContextPacket, DiscoveryReport, PerformanceReport } from "./contracts";
import type { Evidence, SessionState } from "./schemas";
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

/**
 * Builds the discovery report: programmatic versus agentic discovery (PRD §10.8, AC 29).
 *
 * `programmaticFactShare` is verified programmatic / (verified programmatic + verified agentic).
 * User answers are excluded because they are neither discovered facts nor agent claims; the share
 * is `null` (not 0) when that denominator is 0 so "no data" stays distinguishable.
 *
 * @param s - Session state; supplies stage timings and context counters.
 * @param packet - The Context Packet, or `null` when none was built (limitations are then `null`).
 * @param evidence - All evidence in the session, every item counted by origin.
 */
export function buildDiscoveryReport(
  s: SessionState,
  packet: ContextPacket | null,
  evidence: Evidence[],
): DiscoveryReport {
  const m = s.metrics;
  const byOrigin = { programmatic: 0, agentic: 0, user: 0 };
  let verifiedProgrammatic = 0;
  let verifiedAgentic = 0;
  for (const e of evidence) {
    byOrigin[e.origin] += 1;
    if (e.confidence !== "verified") continue;
    if (e.origin === "programmatic") verifiedProgrammatic += 1;
    else if (e.origin === "agentic") verifiedAgentic += 1;
  }
  const denominator = verifiedProgrammatic + verifiedAgentic;
  return {
    schemaVersion: CONTRACT_VERSION,
    programmaticMs: m.stageMs.discovery ?? 0,
    agenticMs: m.stageMs.analysis ?? 0,
    contextRequests: m.contextRequests,
    contextRequestRounds: m.contextRequestRounds,
    analysisSubmissions: m.analysisSubmissions,
    packetTokens: m.packetTokens,
    evidenceByOrigin: byOrigin,
    programmaticFactShare: denominator === 0 ? null : verifiedProgrammatic / denominator,
    detectorErrors: packet?.limitations.detectorErrors ?? [],
    limitations: packet?.limitations ?? null,
  };
}
