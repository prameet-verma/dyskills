import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ContextAnalysisResultSchema,
  type Assumption,
  type ContextAnalysisResult,
  type ContextPacket,
  type Evidence,
  type SessionState,
} from "@dynamic-skills/core";
import { runDiscovery } from "@dynamic-skills/discovery";

/** Repository root of the monorepo under test. */
export const ROOT = resolve(import.meta.dirname, "../../..");

/** The fixture Context Analysis Result for the TS caching scenario. */
export const ANALYSIS: ContextAnalysisResult = ContextAnalysisResultSchema.parse(
  JSON.parse(readFileSync(resolve(ROOT, "fixtures/analysis/ts-monorepo-caching.json"), "utf8")),
);

/** Minimal valid session state for brief rendering. */
export function makeState(): SessionState {
  return {
    schemaVersion: "1",
    id: "s1",
    task: "Add distributed caching to order processing",
    mode: "auto",
    explicit: false,
    repo: "/r",
    revision: "abc",
    status: "generating",
    createdAt: "t",
    sla: { budgetMs: 60_000, activeMs: 0, paused: false, segmentStartedAt: null },
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
  };
}

/** Hand-built evidence item. */
export function ev(key: string, over: Partial<Evidence> = {}): Evidence {
  return {
    key,
    value: "v",
    category: "language",
    source: "package.json",
    confidence: "verified",
    timestamp: "t",
    revision: "r",
    conflicts: [],
    origin: "programmatic",
    ...over,
  };
}

/** Discovery evidence for the TS fixture repo. */
export async function tsEvidence(): Promise<Evidence[]> {
  const res = await runDiscovery({
    repo: resolve(ROOT, "fixtures/repos/ts-monorepo"),
    task: "Add distributed caching to order processing",
  });
  return res.registry.list();
}

/** An analysis assumption recorded as not-asked. */
export const NOT_ASKED: Assumption = {
  questionId: "analysis-1",
  question: "Which cache backend?",
  assumption: "In-memory",
  basis: "No backend configured",
  impact: "May need a swap",
  status: "not-asked",
};

/** Minimal packet literal for consolidation in tests. */
export const PACKET: ContextPacket = {
  schemaVersion: "1",
  packetRevision: 1,
  createdAt: "t",
  trust: "untrusted",
  notice: "n",
  task: { intent: "t" },
  repository: { identity: "r", root: "/r", revision: "x" },
  technology: { languages: [], frameworks: [], runtimes: [], packageManagers: [] },
  dependencies: [],
  projectInstructions: [],
  configuration: [],
  architecture: { topLevelDirs: [], entrypoints: [] },
  relevantFiles: [],
  existingSkills: [],
  evidence: [],
  gaps: [],
  probes: [],
  limitations: {
    indexTruncated: false,
    depthLimited: false,
    filesIndexed: 0,
    skippedDirs: [],
    secretPolicy: "",
    detectorErrors: [],
    detectorsNotRun: [],
    excerptsDropped: [],
  },
  size: { chars: 0, estimatedTokens: 0 },
};
