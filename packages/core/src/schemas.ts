import { z } from "zod";

export const ConfidenceSchema = z.enum(["verified", "inferred", "conflicting", "assumed"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const EvidenceCategorySchema = z.enum([
  "language",
  "runtime",
  "package-manager",
  "framework",
  "database",
  "monorepo",
  "testing",
  "build",
  "ci",
  "architecture",
  "conventions",
  "semantic",
  "user",
]);
export type EvidenceCategory = z.infer<typeof EvidenceCategorySchema>;

export const EvidenceSchema = z.object({
  key: z.string(),
  value: z.string(),
  category: EvidenceCategorySchema,
  source: z.string(),
  confidence: ConfidenceSchema,
  timestamp: z.string(),
  revision: z.string(),
  conflicts: z.array(z.string()),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const RequirementSchema = z.object({
  id: z.string(),
  category: EvidenceCategorySchema,
  description: z.string(),
  humanOnly: z.boolean(),
  material: z.boolean(),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const GapSchema = z.object({
  requirement: z.string(),
  category: EvidenceCategorySchema,
  status: z.enum(["verified", "needs-investigation", "missing", "conflicting"]),
  resolution: z.enum(["none", "inspect", "ask"]),
  evidenceKeys: z.array(z.string()),
  material: z.boolean(),
});
export type Gap = z.infer<typeof GapSchema>;

export const QuestionSchema = z.object({
  id: z.string(),
  text: z.string(),
  requirement: z.string(),
  evidenceKey: z.string().optional(),
  material: z.boolean(),
  blocking: z.boolean(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const AnswerSchema = z.object({
  questionId: z.string(),
  status: z.enum(["answered", "declined", "skipped"]),
  value: z.string().optional(),
  assumption: z
    .object({
      assumption: z.string(),
      basis: z.string(),
      impact: z.string(),
    })
    .optional(),
});
export type Answer = z.infer<typeof AnswerSchema>;

export const AssumptionSchema = z.object({
  questionId: z.string(),
  question: z.string(),
  assumption: z.string(),
  basis: z.string(),
  impact: z.string(),
  status: z.enum(["declined", "skipped", "unanswered"]),
});
export type Assumption = z.infer<typeof AssumptionSchema>;

export const InvocationModeSchema = z.enum(["auto", "suggest", "manual"]);
export type InvocationMode = z.infer<typeof InvocationModeSchema>;

export const PipelineStatusSchema = z.enum([
  "assessing",
  "discovering",
  "generating",
  "evaluating",
  "waiting-for-clarification",
  "resuming",
  "activating",
  "completed",
  "warning",
  "timeout",
  "failed",
]);
export type PipelineStatus = z.infer<typeof PipelineStatusSchema>;

export const StageNameSchema = z.enum([
  "assessment",
  "discovery",
  "analysis",
  "clarification",
  "compilation",
  "evaluation",
  "activation",
]);
export type StageName = z.infer<typeof StageNameSchema>;

export const EvalIdSchema = z.enum([
  "spec",
  "metadata",
  "grounding",
  "completeness",
  "scope",
  "role",
  "assumptions",
  "duplication",
  "conciseness",
  "references",
  "portability",
  "security",
  "behavioural-definition",
  "behavioural",
]);
export type EvalId = z.infer<typeof EvalIdSchema>;

export const EvalOutcomeSchema = z.enum(["pass", "warning", "fail", "not-applicable"]);
export type EvalOutcome = z.infer<typeof EvalOutcomeSchema>;

export const EvalResultSchema = z.object({
  id: EvalIdSchema,
  outcome: EvalOutcomeSchema,
  mandatory: z.boolean(),
  messages: z.array(z.string()),
  durationMs: z.number(),
});
export type EvalResult = z.infer<typeof EvalResultSchema>;

export const AssertionSchema = z.object({
  type: z.enum(["contains", "not-contains", "regex", "not-regex"]),
  value: z.string(),
});
export type Assertion = z.infer<typeof AssertionSchema>;

export const SmokeEvalSchema = z.object({
  id: z.string(),
  scenario: z.string(),
  expectedBehaviour: z.string(),
  requiredOutputs: z.array(z.string()),
  prohibited: z.array(z.string()),
  assertions: z.array(AssertionSchema),
  rubric: z.array(z.string()),
});
export type SmokeEval = z.infer<typeof SmokeEvalSchema>;

export const SlaSnapshotSchema = z.object({
  budgetMs: z.number(),
  activeMs: z.number(),
  paused: z.boolean(),
  segmentStartedAt: z.number().nullable(),
});
export type SlaSnapshot = z.infer<typeof SlaSnapshotSchema>;

export const SessionMetricsSchema = z.object({
  wallStartedAt: z.number(),
  stageMs: z.partialRecord(StageNameSchema, z.number()),
  humanWaitMs: z.number(),
  llmInteractions: z.number(),
  parallelOps: z.number(),
  cacheHits: z.number(),
  cacheLookups: z.number(),
  evaluationMs: z.number(),
  activationMs: z.number(),
  outcome: z.enum(["activated", "timeout", "failed", "skipped"]).optional(),
});
export type SessionMetrics = z.infer<typeof SessionMetricsSchema>;

export const SessionStateSchema = z.object({
  id: z.string(),
  task: z.string(),
  mode: InvocationModeSchema,
  explicit: z.boolean(),
  repo: z.string(),
  revision: z.string(),
  status: PipelineStatusSchema,
  createdAt: z.string(),
  sla: SlaSnapshotSchema,
  completedSteps: z.array(z.string()),
  clarification: z.object({
    round: z.number(),
    asked: z.array(QuestionSchema),
    pending: z.array(QuestionSchema),
    answers: z.array(AnswerSchema),
  }),
  assumptions: z.array(AssumptionSchema),
  gaps: z.array(GapSchema),
  blockedBy: z.array(z.string()),
  evalAttempts: z.number(),
  skillName: z.string().optional(),
  metrics: SessionMetricsSchema,
});
export type SessionState = z.infer<typeof SessionStateSchema>;

export const HarnessSchema = z.enum(["claude-code", "codex", "opencode"]);
export type Harness = z.infer<typeof HarnessSchema>;

export const ExistingSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  scope: z.enum(["project", "personal"]),
  harness: HarnessSchema,
  body: z.string(),
});
export type ExistingSkill = z.infer<typeof ExistingSkillSchema>;

export const GeneratedSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  dir: z.string(),
  skillMdPath: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  body: z.string(),
  raw: z.string(),
  references: z.array(z.string()),
  tokenEstimate: z.number(),
});
export type GeneratedSkill = z.infer<typeof GeneratedSkillSchema>;
