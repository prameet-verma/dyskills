import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AnswerSchema,
  AssumptionSchema,
  EvalResultSchema,
  EvidenceSchema,
  QuestionSchema,
  SessionStateSchema,
  SmokeEvalSchema,
} from "../packages/core/src/index.js";

/** File name -> JSON Schema for the externally visible contracts. */
export function generateSchemas(): Record<string, object> {
  return {
    "evidence.schema.json": z.toJSONSchema(EvidenceSchema),
    "question.schema.json": z.toJSONSchema(QuestionSchema),
    "answer.schema.json": z.toJSONSchema(AnswerSchema),
    "assumption.schema.json": z.toJSONSchema(AssumptionSchema),
    "smoke-eval.schema.json": z.toJSONSchema(SmokeEvalSchema),
    "eval-result.schema.json": z.toJSONSchema(EvalResultSchema),
    "session-state.schema.json": z.toJSONSchema(SessionStateSchema),
  };
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
  mkdirSync(outDir, { recursive: true });
  for (const [file, schema] of Object.entries(generateSchemas())) {
    writeFileSync(resolve(outDir, file), JSON.stringify(schema, null, 2) + "\n");
  }
}
