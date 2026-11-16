# @dynamic-skills/core

Shared contracts and primitives for Dynamic Skills: the zod schemas every package exchanges,
the pipeline's fixed limits, a bounded-concurrency helper and the token estimator. It has no
network access or harness-specific logic; its only I/O is the ephemeral session store and the safe file reader (`readSafeFile`).

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
  `SkillBootstrapRequest` is the set of `assess` flags (task, mode, explicit, repo) plus the
  `DYNAMIC_SKILLS_BUDGET_MS` environment variable (the budget) that starts a session; `SkillBootstrapResult` is the JSON object the `activate` and
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
  `SessionLockedError` carry a `.code`. The default home is `<os tmpdir>/dynamic-skills-<uid>`.
  `prepare()` (run by `create` and `withLock`) checks the home and `sessions/` with
  **`ensurePrivateDir(path, probe?, tighten?)`**: a symlink (also with a trailing slash),
  non-directory or foreign-owned directory throws `UnsafeHomeError` (code `HOME_UNSAFE`); with
  `tighten` (default) group/other bits are removed. The store passes `false` for the home, so a
  user-provided home is checked and never chmodded. Directories are created
  `PRIVATE_DIR_MODE` (0700) and files `PRIVATE_FILE_MODE` (0600). Also `recordStage`,
  `enforceDeadline` (marks `timeout` and stops the clock), `hasEnded` and `stopClock` (freezes the
  SLA of an ended session).
- **`renderStatus(state, now)`** (`status.ts`): the user-visible status blocks (PRD §10.5),
  including waiting-for-approval and "Approval: Received" after `sufficiency-approve`; an ended
  session prints `Processing SLA: STOPPED`.
- **`buildPerformanceReport(state, now)`** (`perf.ts`): a `PerformanceReport` with
  `schemaVersion`, wall/active/human-wait time, stage timings, context counters and cache hit
  rate (`null` when there were no lookups).
- **`buildDiscoveryReport(state, packet, evidence)`** (`perf.ts`): a `DiscoveryReport` with
  programmatic/agentic time, evidence counts by origin and `programmaticFactShare` (verified
  programmatic over verified programmatic plus agentic; `null` when there are none).
- **`estimateTokens(text)`** (`tokens.ts`): `ceil(chars / 4)`.
- **`aggregatePerformance(home)`** (`perf-aggregate.ts`): reads every
  `<home>/sessions/*/reports/performance.json` and every archived `<home>/reports/*.json`
  (de-duplicated by session id, a live session winning) and returns a `PerformanceAggregate`: `count`,
  nearest-rank `p50ActiveMs`/`p95ActiveMs`/`maxActiveMs` (`null` when empty), `timeoutRate`,
  `fallbackRate` (timeout or failed), `reuseRate`, `augmentationRate`, `cacheHitRate` (mean over
  sessions with lookups, else `null`) and the mean clarification rounds and context requests.
  Symlinked session directories, oversized (> 1 MiB), unparseable and non-`"1"` `schemaVersion`
  files are skipped; it never throws on bad data.
- **`archivePerformanceReport(home, sessionId)`** (`perf-aggregate.ts`): copies a session's
  validated `reports/performance.json` to `<home>/reports/<sessionId>.json` (0600, directory
  0700, never through a symlink) so `clean` keeps the metrics (Ruling R21); `false` when there is
  no valid report.
- **`readSafeFile(path, { maxBytes?, realBasename? })`, `checkSafeFile`** (`safe-read.ts`): the
  one safe file reader. One non-blocking handle (a FIFO or device never hangs it), a regular file
  only, a size cap (default 1 MB), and an optional required real basename (so a symlinked
  `SKILL.md` cannot reach `.env`). Returns `{ ok: true, bytes, text, sha256 }`, the hash being of
  exactly the bytes decoded, or `{ ok: false, reason }` (`missing`, `not-a-file`, `too-large`,
  `wrong-name`, `unreadable`). Never rejects for file problems; a `maxBytes` that is not a finite non-negative integer throws a
  `TypeError`. `checkSafeFile` validates without reading.
- **Question options** (`schemas.ts`, `contracts.ts`): `QuestionOptionSchema`
  (`{ label, description }`, label 1-60 chars without `;`), and optional `Question.options` (2-4)
  and `Question.multiSelect`. A multi-select answer's `value` lists the chosen labels separated by
  `"; "`; free text is always accepted. `ClarificationRequestSchema` rejects, at
  `questions.<i>.options`, labels equal after trim and lowercase, a label `other` (hosts add their
  own free-text choice) and `multiSelect` without `options`. `MIN_QUESTION_OPTIONS = 2`,
  `MAX_QUESTION_OPTIONS = 4` (`constants.ts`).
- **`NativePlacementSchema`** (`schemas.ts`): `{ harness, dir, manifestSha256, placedAt }`, the
  optional `SessionState.native` record of a native skill placement (`dir` is the full
  `<root>/<name>` path; absent means none). `NATIVE_PLACEMENT_TTL_MS` (86,400,000): a crashed
  session must not leave a skill listed natively for more than a day.
- **`readNativeReferences(home, { exclude? })`** (`native.ts`): reads every
  `<home>/sessions/<id>/session.json` (1 MB cap) and returns `{ byDir, unparsable }`, the
  `NativeReference`s (`sessionId`, `placedAt`, `outcome`) per placement `dir` and the count of
  session files that could not be read or parsed.
- **`selectExpiredPlacements({ placements, refs, unparsable, now, ttlMs? })`** (`native.ts`): pure
  sweep policy. Age starts at the newest `placedAt` among references, else `mtimeMs`; older than
  the TTL expires. Otherwise, with `unparsable === 0`, a placement with no reference, or whose
  references all ended with an outcome other than `activated` or `augmented`, expires.
- **`BOOTSTRAP_SKILL_NAME`, `FALLBACK_MESSAGE`, `REUSE_NOTICE`, `NOTICE_GENERATED`,
  `NOTICE_AUGMENTED`** (`constants.ts`): the bootstrap skill's name and the fixed texts shown to
  the agent, defined once.
- **`MAX_BASE_FILE_BYTES`** (`constants.ts`): the 200,000-byte cap on an existing `SKILL.md` or
  instruction file read as a base (and on a `SKILL.md` read by the skills scan).

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
