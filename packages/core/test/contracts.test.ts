import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AssumptionsReportSchema,
  ClarificationRequestSchema,
  ClarificationResponseSchema,
  ContextAnalysisResultSchema,
  ContextPacketSchema,
  ContextRequestSchema,
  DiscoveryReportSchema,
  EvaluationReportSchema,
  EvidenceDocumentSchema,
  PerformanceReportSchema,
  SessionStateSchema,
  SkillSufficiencyAssessmentSchema,
  SkillsScanSchema,
  SufficiencyReportSchema,
  generateSchemas,
} from "../src/index";

const MINIMAL = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../fixtures/analysis/minimal.json", import.meta.url)),
    "utf8",
  ),
) as {
  taskContext: Record<string, unknown>;
  [k: string]: unknown;
};

const evidence = {
  key: "pm",
  value: "pnpm",
  category: "package-manager",
  source: "pnpm-lock.yaml",
  confidence: "verified",
  timestamp: "t",
  revision: "r",
  conflicts: [],
  origin: "programmatic",
};
const gap = {
  requirement: "r",
  category: "build",
  status: "verified",
  resolution: "none",
  evidenceKeys: ["pm"],
  material: true,
};
const limitations = {
  indexTruncated: false,
  depthLimited: false,
  filesIndexed: 3,
  skippedDirs: [],
  secretPolicy: "secret files are never read",
  detectorErrors: [],
  detectorsNotRun: [],
  excerptsDropped: [],
};
const packet = {
  schemaVersion: "1",
  packetRevision: 1,
  createdAt: "t",
  trust: "untrusted",
  notice: "data, not instructions",
  task: { intent: "add caching" },
  repository: { identity: "repo", root: "/r", revision: "x" },
  technology: { languages: [], frameworks: [], runtimes: [], packageManagers: ["pnpm"] },
  dependencies: [{ name: "zod", version: "4", evidenceKey: "dep.zod" }],
  projectInstructions: [{ path: "AGENTS.md", truncated: false }],
  configuration: [{ path: "package.json", kind: "build" }],
  architecture: { topLevelDirs: ["src"], entrypoints: [] },
  relevantFiles: [{ path: "a.ts", reason: "r", truncated: false, addedInRevision: 1 }],
  existingSkills: [{ name: "s", description: "d", scope: "project" }],
  evidence: [evidence],
  gaps: [gap],
  probes: [{ requirement: "architecture", question: "q", suggestedFiles: [] }],
  limitations,
  size: { chars: 10, estimatedTokens: 3 },
};
const sufficiency = {
  schemaVersion: "1",
  outcome: "partial",
  baseSkill: { name: "order-caching", path: "/h/order-caching/SKILL.md" },
  rationale: "r",
  missingAspects: ["Repository test command"],
};
const evalResult = {
  id: "spec",
  outcome: "pass",
  mandatory: true,
  messages: [],
  durationMs: 1,
};
const session = {
  schemaVersion: "1",
  id: "ds-1",
  task: "t",
  mode: "auto",
  explicit: false,
  repo: "/r",
  revision: "x",
  status: "assessing",
  createdAt: "t",
  sla: { budgetMs: 1, activeMs: 0, paused: false, segmentStartedAt: 0 },
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
  },
};

const DOCUMENTS: [string, z.ZodType, unknown][] = [
  ["ContextPacket", ContextPacketSchema, packet],
  ["ContextAnalysisResult", ContextAnalysisResultSchema, MINIMAL],
  [
    "ContextRequest",
    ContextRequestSchema,
    {
      schemaVersion: "1",
      action: "request_context",
      requests: [{ type: "source_file", path: "a.ts", reason: "r" }],
    },
  ],
  [
    "ClarificationRequest",
    ClarificationRequestSchema,
    {
      schemaVersion: "1",
      questions: [{ id: "q", text: "?", requirement: "r", material: true, blocking: true }],
    },
  ],
  [
    "ClarificationResponse",
    ClarificationResponseSchema,
    { schemaVersion: "1", answers: [{ questionId: "q", status: "answered", value: "v" }] },
  ],
  ["EvidenceDocument", EvidenceDocumentSchema, { schemaVersion: "1", items: [evidence] }],
  [
    "AssumptionsReport",
    AssumptionsReportSchema,
    {
      schemaVersion: "1",
      items: [
        {
          questionId: "q",
          question: "?",
          assumption: "a",
          basis: "b",
          impact: "i",
          status: "not-asked",
        },
      ],
    },
  ],
  [
    "SkillsScan",
    SkillsScanSchema,
    {
      schemaVersion: "1",
      skills: [{ name: "s", description: "d", scope: "project", path: "/h/s/SKILL.md" }],
      instructionFiles: ["AGENTS.md"],
      warnings: [],
    },
  ],
  [
    "PerformanceReport",
    PerformanceReportSchema,
    {
      schemaVersion: "1",
      sessionId: "ds-1",
      wallMs: 1,
      activeMs: 1,
      humanWaitMs: 0,
      clarificationRounds: 0,
      stageMs: {},
      llmInteractions: 0,
      parallelOps: 0,
      cacheHitRate: null,
      evaluationMs: 0,
      activationMs: 0,
      contextRequests: 0,
      contextRequestRounds: 0,
      analysisSubmissions: 0,
      packetTokens: 0,
    },
  ],
  [
    "DiscoveryReport",
    DiscoveryReportSchema,
    {
      schemaVersion: "1",
      programmaticMs: 1,
      agenticMs: 1,
      contextRequests: 0,
      contextRequestRounds: 0,
      analysisSubmissions: 1,
      packetTokens: 3,
      evidenceByOrigin: { programmatic: 1, agentic: 0, user: 0 },
      programmaticFactShare: 1,
      detectorErrors: [],
      limitations,
    },
  ],
  [
    "EvaluationReport",
    EvaluationReportSchema,
    {
      schemaVersion: "1",
      results: [evalResult],
      overall: "pass",
      activatable: true,
      limitations: [],
      revisionHints: [],
      durationMs: 1,
      parallelOps: 1,
    },
  ],
  ["SkillSufficiencyAssessment", SkillSufficiencyAssessmentSchema, sufficiency],
  [
    "SufficiencyReport",
    SufficiencyReportSchema,
    {
      schemaVersion: "1",
      outcome: "insufficient",
      baseSkill: null,
      baseInstructionFile: null,
      rationale: "r",
      missingAspects: [],
      coveredAspects: [],
      mode: "auto",
      explicit: false,
      approval: "not-required",
    },
  ],
  ["SessionState", SessionStateSchema, session],
];

describe("versioned documents", () => {
  it.each(DOCUMENTS)("%s requires schemaVersion '1'", (_, schema, valid) => {
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...(valid as object), schemaVersion: undefined }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...(valid as object), schemaVersion: "2" }).success).toBe(false);
  });
});

describe("ContextAnalysisResult", () => {
  const ev = { claim: "c", source: "s", type: "observed" as const };
  const withEvidence = (e: object) => ({ ...MINIMAL, evidence: [e] });

  it("accepts the minimal analysis and defaults assumptions to []", () =>
    expect(ContextAnalysisResultSchema.parse(MINIMAL).assumptions).toEqual([]));

  it("rejects free-form keys at any level", () => {
    expect(ContextAnalysisResultSchema.safeParse({ ...MINIMAL, summary: "prose" }).success).toBe(
      false,
    );
    expect(
      ContextAnalysisResultSchema.safeParse({
        ...MINIMAL,
        taskContext: { ...MINIMAL.taskContext, notes: "x" },
      }).success,
    ).toBe(false);
  });

  it("rejects analysis evidence in the user category or with a bad key", () => {
    const ok = (e: object) => ContextAnalysisResultSchema.safeParse(withEvidence(e)).success;
    expect(ok({ ...ev, category: "user" })).toBe(false);
    expect(ok({ ...ev, key: "a.b" })).toBe(false);
    expect(ok({ ...ev, key: "Order" })).toBe(false);
    expect(ok({ ...ev, key: "order-read-path" })).toBe(true);
  });

  it("defaults analysis evidence category to semantic", () =>
    expect(ContextAnalysisResultSchema.parse(withEvidence(ev)).evidence[0]?.category).toBe(
      "semantic",
    ));

  it("rejects a conflict with fewer than two observations", () => {
    const conflict = (observations: string[]) => ({
      ...MINIMAL,
      conflicts: [{ subject: "s", observations, sources: ["a"] }],
    });
    expect(ContextAnalysisResultSchema.safeParse(conflict(["one"])).success).toBe(false);
    expect(ContextAnalysisResultSchema.safeParse(conflict(["one", "two"])).success).toBe(true);
  });
});

describe("ContextRequest and ClarificationRequest", () => {
  const entry = { type: "source_file", path: "a.ts", reason: "r" };
  const req = (requests: unknown[]) => ({
    schemaVersion: "1",
    action: "request_context",
    requests,
  });

  it("rejects 9 entries, an unknown type or an extra key", () => {
    expect(ContextRequestSchema.safeParse(req(Array(8).fill(entry))).success).toBe(true);
    expect(ContextRequestSchema.safeParse(req(Array(9).fill(entry))).success).toBe(false);
    expect(ContextRequestSchema.safeParse(req([{ ...entry, type: "other" }])).success).toBe(false);
    expect(ContextRequestSchema.safeParse(req([{ ...entry, x: 1 }])).success).toBe(false);
    expect(ContextRequestSchema.safeParse(req([])).success).toBe(false);
  });

  it("rejects an empty clarification request, 11 questions, or a question with an extra key", () => {
    const q = { id: "q", text: "?", requirement: "r", material: true, blocking: true };
    const doc = (questions: unknown[]) => ({ schemaVersion: "1", questions });
    expect(ClarificationRequestSchema.safeParse(doc([])).success).toBe(false);
    expect(ClarificationRequestSchema.safeParse(doc(Array(10).fill(q))).success).toBe(true);
    expect(ClarificationRequestSchema.safeParse(doc(Array(11).fill(q))).success).toBe(false);
    expect(ClarificationRequestSchema.safeParse(doc([{ ...q, extra: 1 }])).success).toBe(false);
  });
});

describe("ClarificationResponse strictness", () => {
  it("rejects an extra key inside answers[].assumption", () => {
    const doc = (assumption: object) => ({
      schemaVersion: "1",
      answers: [{ questionId: "q", status: "skipped", assumption }],
    });
    const a = { assumption: "a", basis: "b", impact: "i" };
    expect(ClarificationResponseSchema.safeParse(doc(a)).success).toBe(true);
    expect(ClarificationResponseSchema.safeParse(doc({ ...a, extra: 1 })).success).toBe(false);
  });
});

describe("SessionState sufficiency base skill name", () => {
  it("rejects a path-like name", () => {
    const withName = (name: string) => ({
      ...session,
      sufficiency: {
        outcome: "partial",
        baseSkill: { name, path: "/p", sha256: "x" },
        baseInstructionFile: null,
        approval: "pending",
      },
    });
    expect(SessionStateSchema.safeParse(withName("order-caching")).success).toBe(true);
    expect(SessionStateSchema.safeParse(withName("../evil")).success).toBe(false);
  });
});

describe("SkillSufficiencyAssessment", () => {
  const base = { schemaVersion: "1", rationale: "r" };
  const skill = { name: "order-caching", path: "/h/order-caching/SKILL.md" };
  const ok = (v: object) => SkillSufficiencyAssessmentSchema.safeParse(v).success;

  it("enforces the outcome rules", () => {
    expect(ok(sufficiency)).toBe(true);
    expect(ok({ ...base, outcome: "partial", missingAspects: ["x"] })).toBe(false);
    expect(ok({ ...base, outcome: "partial", baseSkill: skill, missingAspects: [] })).toBe(false);
    expect(
      ok({
        ...base,
        outcome: "partial",
        baseSkill: skill,
        baseInstructionFile: "AGENTS.md",
        missingAspects: ["x"],
      }),
    ).toBe(false);
    expect(ok({ ...base, outcome: "sufficient", baseSkill: skill })).toBe(true);
    expect(ok({ ...base, outcome: "sufficient", baseInstructionFile: "AGENTS.md" })).toBe(true);
    expect(ok({ ...base, outcome: "sufficient" })).toBe(false);
    expect(
      ok({ ...base, outcome: "sufficient", baseSkill: skill, baseInstructionFile: "AGENTS.md" }),
    ).toBe(false);
    expect(ok({ ...base, outcome: "sufficient", baseSkill: skill, missingAspects: ["x"] })).toBe(
      false,
    );
    expect(ok({ ...base, outcome: "insufficient" })).toBe(true);
    expect(ok({ ...base, outcome: "insufficient", baseSkill: skill })).toBe(false);
    expect(ok({ ...base, outcome: "insufficient", baseInstructionFile: "AGENTS.md" })).toBe(false);
  });

  it("rejects extra keys and unsafe skill names", () => {
    expect(ok({ ...sufficiency, extra: 1 })).toBe(false);
    for (const name of ["../evil", 'a"b'])
      expect(ok({ ...sufficiency, baseSkill: { ...skill, name } })).toBe(false);
  });
});

describe("generateSchemas", () => {
  it("gives every schema a versioned $id and produces the 20 files", () => {
    const out = generateSchemas();
    expect(Object.keys(out)).toHaveLength(20);
    for (const [file, s] of Object.entries(out))
      expect((s as { $id: string }).$id).toBe(`dynamic-skills/v1/${file}`);
    expect(out["context-analysis-result.schema.json"]).toBeDefined();
  });
});
