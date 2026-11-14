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
- **Constants** (`constants.ts`): `DEFAULT_BUDGET_MS`, `MAX_CLARIFICATION_ROUNDS`,
  `MAX_EVAL_ATTEMPTS`, `SKILL_TOKEN_SOFT_LIMIT`, `SKILL_TOKEN_HARD_LIMIT`,
  `DISCOVERY_CONCURRENCY`, `EVAL_CONCURRENCY`.
- **`mapConcurrent(items, limit, fn, { signal })`** (`concurrency.ts`): ordered, bounded
  parallel map that stops starting work after the first failure or abort.
- **`SlaClock`** (`sla.ts`): pure active-time clock (`start`, `from`, `pause`, `resume`,
  `activeMs`, `remainingMs`, `isExpired`, `isPaused`, `snapshot`). Paused human-wait time is
  excluded and resuming never resets the budget; the caller supplies `now` to every method.
- **`SessionStore`, `resolveHome`** (`session.ts`): file-backed ephemeral sessions under
  `<home>/sessions/<id>/` with atomic `save`, a `withLock` lock file (stale after 30 s),
  confined artifact read/write and `remove`; errors `SessionNotFoundError` and
  `SessionLockedError` carry a `.code`. Also `recordStage` and `enforceDeadline`.
- **`renderStatus(state, now)`** (`status.ts`): the user-visible status blocks (PRD §10.5).
- **`buildPerformanceReport(state, now)`** (`perf.ts`): wall/active/human-wait time, stage
  timings and cache hit rate (`null` when there were no lookups).
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
§10.5 (status text), §10.8 (metrics and performance report).
