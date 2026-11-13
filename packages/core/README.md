# @dynamic-skills/core

Shared contracts and primitives for Dynamic Skills: the zod schemas every package exchanges,
the pipeline's fixed limits, a bounded-concurrency helper and the token estimator. It has no
I/O, network access or harness-specific logic.

## Public API

- **Schemas and types** (`schemas.ts`): `EvidenceSchema`, `RequirementSchema`, `GapSchema`,
  `QuestionSchema`, `AnswerSchema`, `AssumptionSchema`, `SessionStateSchema`,
  `SessionMetricsSchema`, `SlaSnapshotSchema`, `EvalResultSchema`, `SmokeEvalSchema`,
  `ExistingSkillSchema`, `GeneratedSkillSchema` and the enums they use, each with an inferred
  TypeScript type of the same name without `Schema`. JSON Schemas are generated into
  `/schemas` by `pnpm gen:schemas`.
- **Constants** (`constants.ts`): `DEFAULT_BUDGET_MS`, `MAX_CLARIFICATION_ROUNDS`,
  `MAX_EVAL_ATTEMPTS`, `SKILL_TOKEN_SOFT_LIMIT`, `SKILL_TOKEN_HARD_LIMIT`,
  `DISCOVERY_CONCURRENCY`, `EVAL_CONCURRENCY`.
- **`mapConcurrent(items, limit, fn, { signal })`** (`concurrency.ts`): ordered, bounded
  parallel map that stops starting work after the first failure or abort.
- **`SlaClock`** (`sla.ts`): pure active-time clock (`start`, `from`, `pause`, `resume`,
  `activeMs`, `remainingMs`, `isExpired`, `isPaused`, `snapshot`). Paused human-wait time is
  excluded and resuming never resets the budget; the caller supplies `now` to every method.
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

§5.5 (invocation modes), §6.3–6.5 (gaps, evidence), §8.1–8.5 (evaluation outcomes, size limits),
§9.1–9.4 (budget, SLA clock, clarification limits, assumptions), §9.6–9.7 (stages, bounded parallelism),
§9.10 (metrics).
