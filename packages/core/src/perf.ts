import type { SessionMetrics, SessionState, StageName } from "./schemas";
import { SlaClock } from "./sla";

/**
 * Builds the performance report for a session (PRD §9.10).
 *
 * `wallMs` is elapsed time since session start; `activeMs` excludes human waits.
 * `cacheHitRate` is `null` (not 0) when no cache lookups happened, so "no data" is distinguishable
 * from "all misses".
 */
export function buildPerformanceReport(
  s: SessionState,
  now: number,
): {
  sessionId: string;
  wallMs: number;
  activeMs: number;
  humanWaitMs: number;
  clarificationRounds: number;
  stageMs: Partial<Record<StageName, number>>;
  llmInteractions: number;
  parallelOps: number;
  cacheHitRate: number | null;
  evaluationMs: number;
  activationMs: number;
  outcome: SessionMetrics["outcome"];
} {
  const m = s.metrics;
  return {
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
    outcome: m.outcome,
  };
}
