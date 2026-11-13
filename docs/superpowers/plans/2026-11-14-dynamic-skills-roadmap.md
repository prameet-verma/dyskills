# Dynamic Skills — Phased Delivery Roadmap

> **For agentic workers:** This is the master roadmap. Each phase is executed from its own detailed plan
> (`docs/superpowers/plans/<date>-phase-N-<name>.md`) using superpowers:subagent-driven-development.
> Only Phase 1 has a detailed plan today; write each later phase's plan (superpowers:writing-plans) when
> the previous phase's gate passes, because it consumes the interfaces that phase actually shipped.

**Spec:** `PRD.md` (v0.6)

## Architecture decision (applies to every phase)

**Agent-driven CLI.** The TypeScript core is a deterministic CLI (`dynamic-skills <command>`) that emits
JSON on stdout and the PRD §9.5 status block on stderr. All LLM work — semantic discovery, writing the
`SKILL.md` draft, judging behavioural rubrics — is done by the host's root agent (or its subagents),
instructed by the `dynamic-skill-bootstrap` skill. Consequences:

- No API keys, no model calls, no network access in the core ("no mandatory paid API", PRD §19).
- The SLA clock is wall-clock time since the session started minus time paused for human answers, so
  root-agent reasoning between CLI calls counts towards the 60 s budget (PRD §9.2).
- Phase 2 adapters add native placement/activation and installation; they never change the core contract.
- An optional `LlmProvider` (headless host / API) can be added in Phase 5 without changing the CLI.

## Execution and verification model

Every phase uses the same loop:

1. **Per task:** a fresh implementer subagent implements one task (TDD, commits) → a fresh
   spec-compliance reviewer subagent checks the diff against the task text, the Interfaces block and the
   plan's Global Constraints, and runs `pnpm test && pnpm typecheck` → a code-quality reviewer subagent
   reviews the diff. Findings go back to an implementer; at most 2 fix rounds before escalating to the human.
2. **Per phase gate:** after the last task, a fresh **phase verifier** subagent (no implementation
   context) receives only the phase's exit checklist and the PRD, runs every check, and reports
   pass/fail per item with evidence (command + output). Then one whole-branch code review
   (superpowers:requesting-code-review). The human approves the gate before the next phase is planned.
3. **Branching:** one branch per phase (`phase-1-jit-core`, …), created via superpowers:using-git-worktrees;
   merged via superpowers:finishing-a-development-branch after the gate.

## Phases

### Phase 1 — JIT Core Engine  · detailed plan: `2026-11-14-phase-1-jit-core-engine.md`

Monorepo scaffold, core contracts (zod + JSON Schema), SLA clock with pause/resume, ephemeral session
store, Evidence Registry, parallel deterministic discovery with secret exclusion, gap analysis,
coverage assessment, Clarification Manager (3 rounds, assumptions), compilation brief + bundle parser,
13 generation evals + behavioural smoke recording with a parallel runner, activation gating with
timeout fallback, the CLI, the bootstrap skill, and performance reporting.

- **FRs:** 01–25, 28 (single canonical bundle), 29.
- **Exit gate (verifier checks):** PRD §20 items 4–15, 17–22, 26, 27 pass against the CLI end-to-end
  test on fixture repos; the bootstrap skill passes its own evaluator; e2e active processing < 60 s;
  a timeout run never activates; a failing mandatory eval never activates; no file is written to any
  harness skill directory.
- **Manual gate step:** the human runs the live smoke script once with Claude Code (`claude -p`) to see
  the bootstrap drive a real synthesis.

### Phase 2 — Harness Integrations

**Starts with a research spike** (one subagent, read-only, cites docs): for Claude Code, Codex and
OpenCode, how a skill placed mid-session becomes usable without restart, native question UI, subagent
delegation, and autonomous-invocation hooks. The spike's findings decide the adapter design.

Deliverables: `packages/adapter-sdk` (the PRD §12.3 `HarnessAdapter` contract), `adapters/claude-code`,
`adapters/codex`, `adapters/opencode`; native current-session activation; project/personal storage
paths from PRD §10.3; `dynamic-skills save --scope project|personal|ephemeral|discard --harness …`;
`npx dynamic-skills init [--harness claude,codex,opencode]` installer (detect, register bootstrap,
verify) per PRD §19; adapter compatibility test suite run identically against all three adapters.

- **FRs:** 22 (native), 26, 27, 28 (byte-identical bundle across adapters).
- **Exit gate:** the same session's bundle is byte-identical after `save` through each adapter; the
  compatibility suite passes for all three; `init` is idempotent; ephemeral sessions leave every
  permanent skill directory untouched (AC 25); explicit invocation works where autonomous does not.

### Phase 3 — Persistence and Lifecycle

Deliverables: post-task persistence prompt (PRD §10.2 copy), `packages/lifecycle` (versioned bundle
metadata, evaluation history, expiry, deprecation, promotion from project → personal), context
fingerprints stored with saved skills, `packages/freshness-validator` (revision + fingerprint
comparison → fresh / relevance-check / stale), discovery cache keyed by file fingerprints (populates the
cache-hit metric), regeneration of stale project context only.

- **FRs:** 30, 31, 33.
- **Exit gate:** changing a fingerprinted file marks only the dependent skill stale; an unrelated commit
  triggers a relevance check but not invalidation; saving twice does not duplicate a skill; persistence
  never happens without an explicit choice (AC 23, 24).

### Phase 4 — Evaluation Maturity

Deliverables: `evals/` fixture library with rubrics, `benchmarks/` baseline-vs-skill runner (agent
executes scenario with and without the skill; scored by deterministic assertions + rubric), regression
detection across skill versions, evaluation history reporting, automated reduction/improvement loop
bounded by attempts.

- **FRs:** 32 plus maturity of 18–21.
- **Exit gate:** benchmark run on ≥5 fixture tasks produces a with/without comparison report; a
  deliberately degraded skill is flagged as a regression.

### Phase 5 — Ecosystem Expansion

Deliverables: extension API for discovery detectors and evals (community contributions), additional
adapters, organisation-level skill libraries, lockfile-exact versions for pnpm/yarn, domain discovery
packs, optional `LlmProvider` for headless/API runs, multi-skill composition (FR-34).

- **Exit gate:** a third-party detector and adapter can be added without modifying core packages.

## Cross-phase risks

| Risk | Mitigation |
|---|---|
| A harness cannot activate a new skill mid-session | Phase 2 spike first; fallback is the Phase 1 behaviour (agent reads the returned skill content into context) |
| 60 s budget too tight with real agents | Phase 1 instruments every stage; the live smoke step measures it before Phase 2 |
| Agent ignores bootstrap steps | Bootstrap is short, command-driven, and the CLI's state machine rejects out-of-order steps |
| Heuristic evals produce false positives | Every heuristic eval is a warning unless the PRD makes it mandatory; Phase 4 adds rubric/benchmark depth |
