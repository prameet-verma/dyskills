import { z } from "zod";
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
  SkillSufficiencyAssessmentSchema,
  SkillsScanSchema,
  SufficiencyReportSchema,
} from "./contracts";
import { CONTRACT_VERSION } from "./constants";
import {
  AnswerSchema,
  AssumptionSchema,
  EvalResultSchema,
  EvidenceSchema,
  QuestionSchema,
  SessionStateSchema,
  SmokeEvalSchema,
} from "./schemas";

/** Documents the agent submits: `io: "input"` makes defaulted fields optional for the author. */
const INPUT: [string, z.ZodType][] = [
  ["context-analysis-result", ContextAnalysisResultSchema],
  ["context-request", ContextRequestSchema],
  ["skill-sufficiency-assessment", SkillSufficiencyAssessmentSchema],
  ["clarification-request", ClarificationRequestSchema],
  ["clarification-response", ClarificationResponseSchema],
];

/** Documents the CLI writes: default (output) mode. */
const OUTPUT: [string, z.ZodType][] = [
  ["evidence", EvidenceSchema],
  ["question", QuestionSchema],
  ["answer", AnswerSchema],
  ["assumption", AssumptionSchema],
  ["smoke-eval", SmokeEvalSchema],
  ["eval-result", EvalResultSchema],
  ["session-state", SessionStateSchema],
  ["context-packet", ContextPacketSchema],
  ["evidence-document", EvidenceDocumentSchema],
  ["assumptions-report", AssumptionsReportSchema],
  ["skills-scan", SkillsScanSchema],
  ["performance-report", PerformanceReportSchema],
  ["discovery-report", DiscoveryReportSchema],
  ["evaluation-report", EvaluationReportSchema],
  ["sufficiency-report", SufficiencyReportSchema],
];

/**
 * Generates the JSON Schema for every externally visible contract (PRD §13.2).
 *
 * @returns Map of `<name>.schema.json` to its schema, each carrying
 * `$id: "dynamic-skills/v<CONTRACT_VERSION>/<file>"` so consumers can pin a contract version.
 */
export function generateSchemas(): Record<string, object> {
  const out: Record<string, object> = {};
  const add = (name: string, schema: z.ZodType, io: "input" | "output") => {
    const file = `${name}.schema.json`;
    out[file] = {
      $id: `dynamic-skills/v${CONTRACT_VERSION}/${file}`,
      ...z.toJSONSchema(schema, { io }),
    };
  };
  for (const [n, s] of OUTPUT) add(n, s, "output");
  for (const [n, s] of INPUT) add(n, s, "input");
  return out;
}
