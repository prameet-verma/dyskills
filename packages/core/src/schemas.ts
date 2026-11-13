import { z } from "zod";

/**
 * Zod schema. How well an evidence value is established: directly observed, inferred, contradicted
 * by another source, or assumed (PRD §6.4).
 */
export const ConfidenceSchema = z.enum(["verified", "inferred", "conflicting", "assumed"]);
/** Type inferred from {@link ConfidenceSchema}. */
export type Confidence = z.infer<typeof ConfidenceSchema>;

/**
 * Zod schema. Topic an evidence item or requirement belongs to; groups discovery output and gap
 * analysis (PRD §6.1, §6.3).
 */
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
/** Type inferred from {@link EvidenceCategorySchema}. */
export type EvidenceCategory = z.infer<typeof EvidenceCategorySchema>;

/**
 * Zod schema. One discovered fact about the repository with its source, confidence and revision,
 * as stored in the evidence registry (PRD §6.4, §6.5). `conflicts` lists keys of contradicting
 * evidence.
 */
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
/** Type inferred from {@link EvidenceSchema}. */
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * Zod schema. A piece of context the task needs before a skill can be generated; `humanOnly` marks
 * facts only the user can supply, `material` marks those that change the skill's behaviour (PRD
 * §6.3).
 */
export const RequirementSchema = z.object({
  id: z.string(),
  category: EvidenceCategorySchema,
  description: z.string(),
  humanOnly: z.boolean(),
  material: z.boolean(),
});
/** Type inferred from {@link RequirementSchema}. */
export type Requirement = z.infer<typeof RequirementSchema>;

/**
 * Zod schema. Result of comparing one requirement against the evidence: its status and how to
 * resolve it (inspect the repo, ask the user, or nothing) (PRD §6.3).
 */
export const GapSchema = z.object({
  requirement: z.string(),
  category: EvidenceCategorySchema,
  status: z.enum(["verified", "needs-investigation", "missing", "conflicting"]),
  resolution: z.enum(["none", "inspect", "ask"]),
  evidenceKeys: z.array(z.string()),
  material: z.boolean(),
});
/** Type inferred from {@link GapSchema}. */
export type Gap = z.infer<typeof GapSchema>;

/**
 * Zod schema. A clarification question for the user, tied to the requirement it resolves;
 * `blocking` questions pause the pipeline (PRD §9.2, §9.3).
 */
export const QuestionSchema = z.object({
  id: z.string(),
  text: z.string(),
  requirement: z.string(),
  evidenceKey: z.string().optional(),
  material: z.boolean(),
  blocking: z.boolean(),
});
/** Type inferred from {@link QuestionSchema}. */
export type Question = z.infer<typeof QuestionSchema>;

/**
 * Zod schema. The user's reply to a question. Declined or skipped answers may carry the assumption
 * to continue on (PRD §9.4).
 */
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
/** Type inferred from {@link AnswerSchema}. */
export type Answer = z.infer<typeof AnswerSchema>;

/**
 * Zod schema. A recorded assumption standing in for an unanswered material question, with its
 * basis and impact, surfaced in the generated skill (PRD §9.4).
 */
export const AssumptionSchema = z.object({
  questionId: z.string(),
  question: z.string(),
  assumption: z.string(),
  basis: z.string(),
  impact: z.string(),
  status: z.enum(["declined", "skipped", "unanswered"]),
});
/** Type inferred from {@link AssumptionSchema}. */
export type Assumption = z.infer<typeof AssumptionSchema>;

/**
 * Zod schema. How the skill may be invoked: automatically, by suggestion, or only on explicit
 * request (PRD §5.5).
 */
export const InvocationModeSchema = z.enum(["auto", "suggest", "manual"]);
/** Type inferred from {@link InvocationModeSchema}. */
export type InvocationMode = z.infer<typeof InvocationModeSchema>;

/**
 * Zod schema. Lifecycle state of a session as reported to the user, including the waiting-for-
 * clarification state (PRD §9.5, §9.6).
 */
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
/** Type inferred from {@link PipelineStatusSchema}. */
export type PipelineStatus = z.infer<typeof PipelineStatusSchema>;

/**
 * Zod schema. Pipeline stages whose durations are measured for instrumentation (PRD §9.6, §9.10).
 */
export const StageNameSchema = z.enum([
  "assessment",
  "discovery",
  "analysis",
  "clarification",
  "compilation",
  "evaluation",
  "activation",
]);
/** Type inferred from {@link StageNameSchema}. */
export type StageName = z.infer<typeof StageNameSchema>;

/** Zod schema. Identifier of a generation or behavioural evaluation check (PRD §8.1, §8.2). */
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
/** Type inferred from {@link EvalIdSchema}. */
export type EvalId = z.infer<typeof EvalIdSchema>;

/** Zod schema. Result of one evaluation: pass, warning, fail, or not-applicable (PRD §8.4). */
export const EvalOutcomeSchema = z.enum(["pass", "warning", "fail", "not-applicable"]);
/** Type inferred from {@link EvalOutcomeSchema}. */
export type EvalOutcome = z.infer<typeof EvalOutcomeSchema>;

/**
 * Zod schema. Outcome of a single evaluation check with its messages and duration; a failing
 * `mandatory` check blocks activation (PRD §8.4).
 */
export const EvalResultSchema = z.object({
  id: EvalIdSchema,
  outcome: EvalOutcomeSchema,
  mandatory: z.boolean(),
  messages: z.array(z.string()),
  durationMs: z.number(),
});
/** Type inferred from {@link EvalResultSchema}. */
export type EvalResult = z.infer<typeof EvalResultSchema>;

/**
 * Zod schema. A deterministic check applied to behavioural-eval output: substring or regular-
 * expression presence or absence (PRD §8.2).
 */
export const AssertionSchema = z.object({
  type: z.enum(["contains", "not-contains", "regex", "not-regex"]),
  value: z.string(),
});
/** Type inferred from {@link AssertionSchema}. */
export type Assertion = z.infer<typeof AssertionSchema>;

/**
 * Zod schema. A behavioural smoke scenario for a generated skill: expected behaviour, required and
 * prohibited outputs, assertions and an LLM-judge rubric (PRD §8.2).
 */
export const SmokeEvalSchema = z.object({
  id: z.string(),
  scenario: z.string(),
  expectedBehaviour: z.string(),
  requiredOutputs: z.array(z.string()),
  prohibited: z.array(z.string()),
  assertions: z.array(AssertionSchema),
  rubric: z.array(z.string()),
});
/** Type inferred from {@link SmokeEvalSchema}. */
export type SmokeEval = z.infer<typeof SmokeEvalSchema>;

/**
 * Zod schema. Serializable state of the active-time budget. `activeMs` excludes human-wait pauses;
 * `segmentStartedAt` is the epoch ms of the running segment, or null while paused (PRD §9.1,
 * §9.2).
 */
export const SlaSnapshotSchema = z.object({
  budgetMs: z.number(),
  activeMs: z.number(),
  paused: z.boolean(),
  segmentStartedAt: z.number().nullable(),
});
/** Type inferred from {@link SlaSnapshotSchema}. */
export type SlaSnapshot = z.infer<typeof SlaSnapshotSchema>;

/**
 * Zod schema. Performance counters collected during a session: per-stage time, human wait, LLM
 * calls, parallelism and cache use (PRD §9.10).
 */
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
/** Type inferred from {@link SessionMetricsSchema}. */
export type SessionMetrics = z.infer<typeof SessionMetricsSchema>;

/**
 * Zod schema. Complete persisted state of one session, sufficient to resume after a clarification
 * pause (PRD §9.5, §9.6).
 */
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
/** Type inferred from {@link SessionStateSchema}. */
export type SessionState = z.infer<typeof SessionStateSchema>;

/** Zod schema. Agent harness that a skill can target or be discovered from (PRD §10.3, §12.3). */
export const HarnessSchema = z.enum(["claude-code", "codex", "opencode"]);
/** Type inferred from {@link HarnessSchema}. */
export type Harness = z.infer<typeof HarnessSchema>;

/**
 * Zod schema. A skill already present in a project or personal skill directory, considered for
 * reuse or duplication checks (PRD §11.2).
 */
export const ExistingSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  scope: z.enum(["project", "personal"]),
  harness: HarnessSchema,
  body: z.string(),
});
/** Type inferred from {@link ExistingSkillSchema}. */
export type ExistingSkill = z.infer<typeof ExistingSkillSchema>;

/**
 * Zod schema. A skill produced by the pipeline: parsed frontmatter and body, the raw `SKILL.md`,
 * referenced files and its token estimate (PRD §7.2).
 */
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
/** Type inferred from {@link GeneratedSkillSchema}. */
export type GeneratedSkill = z.infer<typeof GeneratedSkillSchema>;
