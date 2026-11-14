import { z } from "zod";
import {
  MAX_ANALYSIS_LIST_ITEMS,
  MAX_CONTEXT_REQUEST_FILES,
  MAX_SUFFICIENCY_ASPECTS,
} from "./constants";
import {
  ApprovalStateSchema,
  AnswerSchema,
  AssumptionSchema,
  EvalOutcomeSchema,
  EvalResultSchema,
  EvidenceCategorySchema,
  EvidenceSchema,
  GapSchema,
  InvocationModeSchema,
  QuestionSchema,
  SchemaVersionSchema,
  SessionMetricsSchema,
  StageNameSchema,
  SufficiencyOutcomeSchema,
} from "./schemas";
import type { Evidence, Gap } from "./schemas";

// Import rule: this module imports schemas.ts, never the reverse (avoids a module-init cycle).

/** Short free text bounded for agent-supplied fields (PRD §6.5: no free-form prose). */
const Text = z.string().min(1).max(500);
/** Bounded list of {@link Text}; the bound is MAX_ANALYSIS_LIST_ITEMS. */
const List = z.array(Text).max(MAX_ANALYSIS_LIST_ITEMS);
/** Source reference (path or evidence key). */
const Src = z.string().min(1).max(300);
/** Agent Skills name: no path separators or quotes (PRD §5.5). */
const SkillName = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

/**
 * Zod schema. A bounded investigation the agent should perform to close an `inspect` gap (PRD
 * §6.3, §6.4).
 */
export const SemanticProbeSchema = z.object({
  requirement: z.string(),
  question: z.string(),
  suggestedFiles: z.array(z.string()),
});
/** Type inferred from {@link SemanticProbeSchema}. */
export type SemanticProbe = z.infer<typeof SemanticProbeSchema>;

/**
 * Zod schema. Evidence categories an analysis agent may use: everything except `user`, so the
 * agent can never forge user answers (PRD §6.5).
 */
export const AnalysisCategorySchema = EvidenceCategorySchema.exclude(["user"]);

/**
 * Zod schema. The Context Packet: untrusted, bounded repository context handed to the analysis
 * agent. Carries no harness names, skill paths or skill bodies (PRD §6.4, §6.9 #7).
 */
export const ContextPacketSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  packetRevision: z.int().min(1),
  createdAt: z.string(),
  trust: z.literal("untrusted"),
  notice: z.string(),
  task: z.object({ intent: z.string(), expectedOutcome: z.string().optional() }),
  repository: z.object({ identity: z.string(), root: z.string(), revision: z.string() }),
  technology: z.object({
    languages: z.array(z.string()),
    frameworks: z.array(z.string()),
    runtimes: z.array(z.string()),
    packageManagers: z.array(z.string()),
  }),
  dependencies: z.array(
    z.object({ name: z.string(), version: z.string(), evidenceKey: z.string() }),
  ),
  projectInstructions: z.array(
    z.object({ path: z.string(), excerpt: z.string().optional(), truncated: z.boolean() }),
  ),
  configuration: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(["build", "test", "ci", "monorepo", "runtime", "other"]),
    }),
  ),
  architecture: z.object({ topLevelDirs: z.array(z.string()), entrypoints: z.array(z.string()) }),
  relevantFiles: z.array(
    z.object({
      path: z.string(),
      reason: z.string(),
      excerpt: z.string().optional(),
      truncated: z.boolean(),
      addedInRevision: z.int().min(1),
    }),
  ),
  // PRD §6.9 #7: no harness, no path, no body.
  existingSkills: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      scope: z.enum(["project", "personal"]),
    }),
  ),
  evidence: z.array(EvidenceSchema),
  gaps: z.array(GapSchema),
  probes: z.array(SemanticProbeSchema),
  limitations: z.object({
    indexTruncated: z.boolean(),
    depthLimited: z.boolean(),
    filesIndexed: z.int(),
    skippedDirs: z.array(z.string()),
    secretPolicy: z.string(),
    detectorErrors: z.array(z.object({ detector: z.string(), message: z.string() })),
    detectorsNotRun: z.array(z.string()),
    excerptsDropped: z.array(z.string()),
  }),
  size: z.object({ chars: z.int(), estimatedTokens: z.int() }),
});
/** Type inferred from {@link ContextPacketSchema}. */
export type ContextPacket = z.infer<typeof ContextPacketSchema>;

/**
 * Zod schema. The agent's structured analysis of a Context Packet. Strict at every level with
 * bounded lists and no free-form prose fields, because agent output is untrusted (PRD §6.5, §6.6).
 */
export const ContextAnalysisResultSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  analysedPacketRevision: z.int().min(1),
  technology: z.strictObject({
    languages: List,
    frameworks: List,
    runtimes: List,
    packageManagers: List,
  }),
  architecture: z.strictObject({
    patterns: List,
    moduleStructure: List,
    conventions: List,
    dependencies: List,
  }),
  taskContext: z.strictObject({
    relevantComponents: List,
    existingImplementations: List,
    constraints: List,
    expectedOutcome: Text.optional(),
  }),
  evidence: z
    .array(
      z.strictObject({
        key: z
          .string()
          .max(40)
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
          .optional(),
        claim: Text,
        source: Src,
        type: z.enum(["observed", "inferred"]),
        category: AnalysisCategorySchema.default("semantic"),
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .max(MAX_ANALYSIS_LIST_ITEMS),
  assumptions: z
    .array(z.strictObject({ subject: Text, assumption: Text, basis: Text, impact: Text }))
    .max(MAX_ANALYSIS_LIST_ITEMS)
    .default([]),
  unknowns: z
    .array(
      z.strictObject({
        question: Text,
        importance: z.enum(["critical", "optional"]),
        category: AnalysisCategorySchema.optional(),
      }),
    )
    .max(MAX_ANALYSIS_LIST_ITEMS),
  conflicts: z
    .array(
      z.strictObject({
        subject: Text,
        observations: z.array(Text).min(2).max(10),
        sources: z.array(Src).min(1).max(10),
        category: AnalysisCategorySchema.optional(),
      }),
    )
    .max(MAX_ANALYSIS_LIST_ITEMS),
});
/** Type inferred from {@link ContextAnalysisResultSchema}. */
export type ContextAnalysisResult = z.infer<typeof ContextAnalysisResultSchema>;

/**
 * Zod schema. The agent's targeted request for more repository files (PRD §6.7); at most
 * MAX_CONTEXT_REQUEST_FILES per round.
 */
export const ContextRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  action: z.literal("request_context"),
  requests: z
    .array(
      z.strictObject({
        type: z.enum(["source_file", "configuration", "documentation", "test_file"]),
        path: Src,
        reason: Src,
      }),
    )
    .min(1)
    .max(MAX_CONTEXT_REQUEST_FILES),
});
/** Type inferred from {@link ContextRequestSchema}. */
export type ContextRequest = z.infer<typeof ContextRequestSchema>;

/** Zod schema. Accepted `--file` input listing clarification questions for the user (PRD §10.4). */
export const ClarificationRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  questions: z.array(QuestionSchema.strict()).min(1).max(10),
});
/** Type inferred from {@link ClarificationRequestSchema}. */
export type ClarificationRequest = z.infer<typeof ClarificationRequestSchema>;

/** Zod schema. Accepted `--file` input carrying the user's answers (PRD §10.4, §10.6). */
export const ClarificationResponseSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  answers: z.array(AnswerSchema.strict()).min(1).max(10),
});
/** Type inferred from {@link ClarificationResponseSchema}. */
export type ClarificationResponse = z.infer<typeof ClarificationResponseSchema>;

/** Zod schema. The persisted `evidence.json` document (PRD §7). */
export const EvidenceDocumentSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  items: z.array(EvidenceSchema),
});
/** Type inferred from {@link EvidenceDocumentSchema}. */
export type EvidenceDocument = z.infer<typeof EvidenceDocumentSchema>;

/** Zod schema. The `reports/assumptions.json` document (PRD §10.6). */
export const AssumptionsReportSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  items: z.array(AssumptionSchema),
});
/** Type inferred from {@link AssumptionsReportSchema}. */
export type AssumptionsReport = z.infer<typeof AssumptionsReportSchema>;

/**
 * Zod schema. The `skills-scan.json` document: scanned skills (with absolute `SKILL.md` path, for
 * the CLI only) and repo-relative instruction files (PRD §5.5, §12.2).
 */
export const SkillsScanSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  skills: z.array(ContextPacketSchema.shape.existingSkills.element.extend({ path: z.string() })),
  instructionFiles: z.array(z.string()),
  warnings: z.array(z.string()),
});
/** Type inferred from {@link SkillsScanSchema}. */
export type SkillsScan = z.infer<typeof SkillsScanSchema>;

/** Zod schema. The `reports/performance.json` document (PRD §10.8). */
export const PerformanceReportSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  sessionId: z.string(),
  wallMs: z.number(),
  activeMs: z.number(),
  humanWaitMs: z.number(),
  clarificationRounds: z.number(),
  stageMs: z.partialRecord(StageNameSchema, z.number()),
  llmInteractions: z.number(),
  parallelOps: z.number(),
  cacheHitRate: z.number().nullable(),
  evaluationMs: z.number(),
  activationMs: z.number(),
  contextRequests: z.number(),
  contextRequestRounds: z.number(),
  analysisSubmissions: z.number(),
  packetTokens: z.number(),
  outcome: SessionMetricsSchema.shape.outcome,
});
/** Type inferred from {@link PerformanceReportSchema}. */
export type PerformanceReport = z.infer<typeof PerformanceReportSchema>;

/** Zod schema. The `reports/discovery.json` document: programmatic versus agentic discovery (PRD §10.8). */
export const DiscoveryReportSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  programmaticMs: z.number(),
  agenticMs: z.number(),
  contextRequests: z.number(),
  contextRequestRounds: z.number(),
  analysisSubmissions: z.number(),
  packetTokens: z.number(),
  evidenceByOrigin: z.object({ programmatic: z.int(), agentic: z.int(), user: z.int() }),
  programmaticFactShare: z.number().min(0).max(1).nullable(),
  detectorErrors: ContextPacketSchema.shape.limitations.shape.detectorErrors,
  limitations: ContextPacketSchema.shape.limitations.nullable(),
});
/** Type inferred from {@link DiscoveryReportSchema}. */
export type DiscoveryReport = z.infer<typeof DiscoveryReportSchema>;

/**
 * Zod schema. The agent's verdict on whether an existing skill suffices, submitted after context
 * analysis (PRD §5.5, FR-40). Scan membership and invocation-mode rules need session context and
 * are checked by `validateSufficiency`, not here.
 */
export const SkillSufficiencyAssessmentSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    outcome: SufficiencyOutcomeSchema,
    baseSkill: z.strictObject({ name: SkillName, path: z.string().min(1).max(1024) }).optional(),
    baseInstructionFile: Src.optional(),
    rationale: z.string().min(1).max(1000),
    missingAspects: z.array(Text).max(MAX_SUFFICIENCY_ASPECTS).default([]),
    coveredAspects: z.array(Text).max(MAX_SUFFICIENCY_ASPECTS).default([]),
  })
  .superRefine((a, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    const hasSkill = a.baseSkill !== undefined;
    const hasFile = a.baseInstructionFile !== undefined;
    if (a.outcome === "sufficient") {
      if (hasSkill === hasFile)
        issue("sufficient needs exactly one of baseSkill or baseInstructionFile");
      if (a.missingAspects.length > 0) issue("sufficient must have no missingAspects");
    } else if (a.outcome === "partial") {
      if (!hasSkill) issue("partial requires baseSkill");
      if (hasFile) issue("partial must not have baseInstructionFile");
      if (a.missingAspects.length < 1) issue("partial requires at least one missingAspect");
    } else if (hasSkill || hasFile) {
      issue("insufficient must have neither baseSkill nor baseInstructionFile");
    }
  });
/** Type inferred from {@link SkillSufficiencyAssessmentSchema} (after defaults). */
export type SkillSufficiencyAssessment = z.infer<typeof SkillSufficiencyAssessmentSchema>;

/** Zod schema. The `reports/sufficiency.json` document: the recorded verdict plus mode and approval (PRD §5.5). */
export const SufficiencyReportSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  outcome: SufficiencyOutcomeSchema,
  baseSkill: z.object({ name: z.string(), path: z.string(), sha256: z.string() }).nullable(),
  baseInstructionFile: z.string().nullable(),
  rationale: z.string(),
  missingAspects: z.array(z.string()),
  coveredAspects: z.array(z.string()),
  mode: InvocationModeSchema,
  explicit: z.boolean(),
  approval: ApprovalStateSchema,
});
/** Type inferred from {@link SufficiencyReportSchema}. */
export type SufficiencyReport = z.infer<typeof SufficiencyReportSchema>;

/** Zod schema. The `reports/evaluation.json` document (PRD §9.4). */
export const EvaluationReportSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  results: z.array(EvalResultSchema),
  overall: EvalOutcomeSchema,
  activatable: z.boolean(),
  limitations: z.array(z.string()),
  revisionHints: z.array(z.string()),
  durationMs: z.number(),
  parallelOps: z.number(),
  behavioural: EvalResultSchema.optional(),
});
/** Type inferred from {@link EvaluationReportSchema}. */
export type EvaluationReport = z.infer<typeof EvaluationReportSchema>;

/** PRD §13.2 name for {@link Evidence}. */
export type ContextEvidence = Evidence;
/** PRD §13.2 name for {@link Gap}. */
export type ContextGap = Gap;
/** PRD §13.2 name for {@link EvaluationReport}. */
export type SkillEvaluationReport = EvaluationReport;
