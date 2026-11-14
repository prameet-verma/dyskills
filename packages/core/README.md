# @dynamic-skills/core

Shared contracts and primitives for Dynamic Skills: the zod schemas every package exchanges,
the pipeline's fixed limits, a bounded-concurrency helper and the token estimator. It has no
network access or harness-specific logic; its only I/O is the ephemeral session store.

## API

- **Schemas and types** (`schemas.ts`): `EvidenceSchema`, `RequirementSchema`, `GapSchema`,
  `QuestionSchema`, `AnswerSchema`, `AssumptionSchema`, `SessionStateSchema`,
  `SessionMetricsSchema`, `SlaSnapshotSchema`, `EvalResultSchema`, `SmokeEvalSchema`,
  `ExistingSkillSchema`, `GeneratedSkillSchema` and the enums they use, each with an inferred
  TypeScript type of the same name without `Schema`. JSON Schemas are generated into
  `/schemas` by `pnpm gen:schemas`.
  New in contract v1: `SchemaVersionSchema`, `EvidenceOriginSchema` (`origin` on evidence,
  default `programmatic`), `SufficiencyOutcomeSchema`, `ApprovalStateSchema`; sessions carry
  `schemaVersion`, `requirements`, `sufficiency` and the context counters; the
  `waiting-for-approval` status; the `evidence-classification` eval id; assumption status
  `not-asked`; `GeneratedSkill.augments`.
- **Versioned contracts** (`contracts.ts`): `ContextPacketSchema`, `ContextAnalysisResultSchema`,
  `ContextRequestSchema`, `ClarificationRequestSchema`, `ClarificationResponseSchema`,
  `EvidenceDocumentSchema`, `AssumptionsReportSchema`, `SkillsScanSchema`,
  `PerformanceReportSchema`, `DiscoveryReportSchema`, `SkillSufficiencyAssessmentSchema`,
  `SufficiencyReportSchema`, `EvaluationReportSchema`, `SemanticProbeSchema`,
  `AnalysisCategorySchema`, each with an inferred type, plus the PRD §13.2 aliases
  `ContextEvidence`, `ContextGap`, `SkillEvaluationReport`. Agent-submitted documents are strict.
  `SkillBootstrapRequest` is the set of `assess` flags (task, mode, explicit, repo, budget) that
  starts a session; `SkillBootstrapResult` is the JSON object the `activate` and
  `sufficiency submit` commands print on stdout (`ok`, `schemaVersion` and the outcome fields).
  Both are documented in ADR 0004 rather than given schemas. `SkillNameSchema` is the single
  Agent Skills name validator.
- **`generateSchemas()`** (`json-schemas.ts`): the 20 JSON Schemas written to `/schemas`, each
  with `$id: "dynamic-skills/v1/<file>"`; agent-submitted documents use input mode.
- **Constants** (`constants.ts`): `DEFAULT_BUDGET_MS`, `MAX_CLARIFICATION_ROUNDS`,
  `MAX_EVAL_ATTEMPTS`, `SKILL_TOKEN_SOFT_LIMIT`, `SKILL_TOKEN_HARD_LIMIT`,
  `DISCOVERY_CONCURRENCY`, `EVAL_CONCURRENCY`, `CONTRACT_VERSION`, `MAX_CONTEXT_REQUEST_ROUNDS`,
  `MAX_CONTEXT_REQUEST_FILES`, `MAX_EXCERPT_CHARS`, `MAX_INSTRUCTION_EXCERPT_CHARS`,
  `MAX_PACKET_TOKENS`, `MAX_ANALYSIS_SUBMISSIONS`, `MAX_ANALYSIS_LIST_ITEMS`,
  `MAX_SUFFICIENCY_ASPECTS`.
- **`mapConcurrent(items, limit, fn, { signal })`** (`concurrency.ts`): ordered, bounded
  parallel map that stops starting work after the first failure or abort.
- **`SlaClock`** (`sla.ts`): pure active-time clock (`start`, `from`, `pause`, `resume`,
  `activeMs`, `remainingMs`, `isExpired`, `isPaused`, `snapshot`). Paused human-wait time is
  excluded and resuming never resets the budget; the caller supplies `now` to every method.
- **`SessionStore`, `resolveHome`** (`session.ts`): file-backed ephemeral sessions under
  `<home>/sessions/<id>/` with atomic `save`, a `withLock` lock file (stale after 30 s),
  confined artifact read/write and `remove`; errors `SessionNotFoundError` and
  `SessionLockedError` carry a `.code`. Also `recordStage` and `enforceDeadline`.
- **`renderStatus(state, now)`** (`status.ts`): the user-visible status blocks (PRD §10.5),
  including waiting-for-approval and "Approval: Received" after `sufficiency-approve`.
- **`buildPerformanceReport(state, now)`** (`perf.ts`): a `PerformanceReport` with
  `schemaVersion`, wall/active/human-wait time, stage timings, context counters and cache hit
  rate (`null` when there were no lookups).
- **`buildDiscoveryReport(state, packet, evidence)`** (`perf.ts`): a `DiscoveryReport` with
  programmatic/agentic time, evidence counts by origin and `programmaticFactShare` (verified
  programmatic over verified programmatic plus agentic; `null` when there are none).
- **`estimateTokens(text)`** (`tokens.ts`): `ceil(chars / 4)`.

## Example

```ts
import {
  EVAL_CONCURRENCY,
  EvidenceSchema,
  estimateTokens,
  mapConcurrent,
} from "@dynamic-skills/core";

const evidence = EvidenceSchema.parse(JSON.parse(raw));
const sizes = await mapConcurrent(files, EVAL_CONCURRENCY, async (f) => estimateTokens(f.body));
```

## PRD sections implemented

§5.4 (invocation modes), §6.3, §7 (gaps, evidence), §9.1–9.5 (evaluation outcomes, size limits),
§10.1, §10.3, §10.4, §10.6 (budget, SLA clock, clarification limits, assumptions), §10.2, §10.8 (stages, bounded parallelism),
§10.5 (status text), §10.8 (metrics and performance report), §5.5, §6.4–6.7, §13.2 (versioned
contracts, sufficiency).
