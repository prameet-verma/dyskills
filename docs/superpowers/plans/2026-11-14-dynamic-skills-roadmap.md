# Dynamic Skills — Phased Delivery Roadmap

> **For agentic workers:** This is the master roadmap. Each phase is executed from its own detailed plan
> (`docs/superpowers/plans/<date>-phase-N-<name>.md`) using superpowers:subagent-driven-development.
> Only Phase 1 has a detailed plan today; write each later phase's plan (superpowers:writing-plans) when
> the previous phase's gate passes, because it consumes the interfaces that phase actually shipped.

**Spec:** `PRD.md` (v0.9)

## Architecture decision (applies to every phase)

**Agent-driven CLI.** The TypeScript core is a deterministic CLI (`dynamic-skills <command>`) that emits
JSON on stdout and the PRD §10.5 status block on stderr. All LLM work — agentic context analysis
(reading the CLI-built Context Packet and returning a schema-validated Context Analysis Result, PRD §6),
judging skill sufficiency (sufficient / partial / insufficient, validated by the CLI, PRD §5.5), writing the `SKILL.md` draft, judging behavioural rubrics — is done by the host's root agent (or its
read-only subagents), instructed by the `dynamic-skill-bootstrap` skill. This matches PRD §13.1: the
engine "should coordinate through structured contracts rather than building its own independent agent
orchestration runtime". Consequences:

- No API keys, no model calls, no network access in the core ("no mandatory paid API", PRD §20).
- The SLA clock is wall-clock time since the session started minus time paused for human answers, so
  root-agent reasoning between CLI calls — including agentic analysis and targeted context requests —
  counts towards the 300 s budget (PRD §10.1, §10.3; 60 s until PRD v0.9).
- The CLI never trusts agent output: every Context Analysis Result and context request is validated
  against a versioned schema before use (PRD §6.9 #8, §13.2).
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

## Documentation and maintainability (applies to every phase)

Dynamic Skills is meant to be a long-lived open-source project, so documentation is part of "done",
not a later phase:

- **In code:** TSDoc on every exported symbol (purpose and contract), short "why" comments on
  non-obvious logic citing the PRD section it implements, no dead code. Enforced by `pnpm lint`
  (`eslint-plugin-jsdoc`) in CI from Phase 1 Task 1a onward.
- **Per package:** a `README.md` with purpose, API summary, usage example and PRD sections covered,
  kept current by whichever task changes the API.
- **Per phase:** each phase plan ends with a documentation task that updates `docs/architecture.md`,
  `docs/cli-reference.md`, `CHANGELOG.md`, and adds an ADR (`docs/adr/NNNN-*.md`) for every
  significant decision made during the phase. Phase-specific guides: Phase 2 → adapter authoring
  guide and per-harness install docs; Phase 3 → lifecycle and freshness guide; Phase 4 → writing evals
  and benchmarks; Phase 5 → extension/plugin guide for community detectors, evals and adapters.
- **Repository health:** CI on every push (lint, typecheck, test, build on Node 24 and 26),
  Conventional Commits, Keep-a-Changelog, issue/PR templates, CONTRIBUTING, SECURITY and
  CODE_OF_CONDUCT (Phase 1 Task 19). A release workflow and semver policy arrive with the first
  public release (Phase 2, alongside `dynamic-skills init`, installed with `npm i -g dynamic-skills`).
- **Every phase gate** includes a documentation check by the verifier: sampled TSDoc quality, docs
  match the code, all relative links resolve.

## Phases

### Phase 1 — JIT Core and Hybrid Context Discovery  · detailed plan: `2026-11-14-phase-1-jit-core-engine.md`

Monorepo scaffold, versioned core contracts (zod + JSON Schema, `schemaVersion` on every document),
SLA clock with pause/resume, ephemeral session store, Evidence Registry with provenance and origin,
parallel deterministic discovery with secret exclusion, **hybrid context discovery** (the CLI builds a
Context Packet, the agent analyses it and returns a schema-validated Context Analysis Result, bounded
targeted context requests enrich the packet, and consolidation records observed vs inferred evidence,
assumptions, unknowns and conflicts — PRD §6), a three-outcome **Skill Sufficiency Assessment** after
analysis (agent verdict, CLI-validated: reuse an existing skill unchanged, augment it with an ephemeral
delta-only overlay pinned to the base's sha256 and activated next to the unchanged base, or generate a
new skill — PRD §5.5), gap analysis, coverage hints, Clarification
Manager (3 rounds, assumptions), compilation brief + bundle parser, 14 generation evals (including
evidence classification) + behavioural smoke recording with a parallel runner, activation gating with
timeout fallback and discovery/evaluation/performance reports, the CLI, the bootstrap skill, and
performance reporting.

- **FRs:** FR-01–FR-30, FR-33 (single canonical bundle), FR-34, FR-40–FR-42 (sufficiency assessment, augmentation, canonical skills never modified).
- **Exit gate (verifier checks):** PRD §21 items 3–19, 21–25, 28–33 pass against the CLI end-to-end
  test on fixture repos; the bootstrap skill passes its own evaluator; e2e active processing < 60 s;
  hybrid discovery produces a validated Context Analysis Result and a validated sufficiency verdict
  before every `compile`; the sufficient and partial paths run end-to-end with the base skill
  byte-identical afterwards; a timeout run
  never activates; a failing mandatory eval never activates; no file is written to any harness skill
  directory.
- **Manual gate step:** the human runs the live smoke script once with Claude Code (`claude -p`) to see
  the bootstrap drive a real synthesis.

### Phase 2 — Harness Integrations

**Starts with a research spike** (one subagent, read-only, cites docs): for Claude Code, Codex and
OpenCode, how a skill placed mid-session becomes usable without restart, native question UI, subagent
delegation, and autonomous-invocation hooks. The spike's findings decide the adapter design.

Deliverables: `packages/adapter-sdk` (thin adapters per PRD §14 that consume the PRD §13.2 core
contracts; v0.7 no longer specifies a `HarnessAdapter` interface, so the spike's findings define it),
`adapters/claude-code`, `adapters/codex`, `adapters/opencode`; current-session activation (read into context everywhere; optional native registration on Claude Code via an add-dir root) and
a read-only context-analyst agent installed per harness (enforced on Claude Code and OpenCode, instructed on Codex); project/personal storage paths from PRD §11.3;
`dynamic-skills save --scope project|personal|ephemeral|discard --harness …`;
`dynamic-skills init [--harness claude-code,codex,opencode] [--scope project|personal]` installer (detect, register bootstrap,
verify) per PRD §20; adapter compatibility test suite run identically against four targets: claude-code, codex, opencode-v1, opencode-v2. Phase 2 `save` refuses augmentations (`SAVE_UNSUPPORTED`); Phase 3 adds them together with the base-hash freshness check.

- **Status:** implemented; the gate is pending the remaining human items: Codex and OpenCode live smoke runs, the SECURITY contact, and the first real publish via the release workflow. License: AGPL-3.0-only. Repository: https://github.com/prameet-verma/dyskills.
- **FRs:** FR-27 (native), FR-31, FR-32, FR-33 (byte-identical bundle across adapters).
- **Exit gate:** the same session's bundle is byte-identical after `save` through each adapter (AC 20),
  and all three adapters (four targets) drive the same discovery contracts (PRD §18 Phase 2); the compatibility suite
  passes for all four targets; `init` is idempotent; ephemeral sessions leave every permanent skill directory
  untouched (AC 28); explicit invocation works where autonomous does not.

### Phase 3 — Persistence and Freshness

Deliverables: post-task persistence prompt (PRD §11.2 copy), `packages/lifecycle` (versioned bundle
metadata, evaluation history, expiry, deprecation, promotion from project → personal), context
fingerprints stored with saved skills, `packages/freshness-validator` (revision + fingerprint
comparison → fresh / relevance-check / stale), discovery cache keyed by file fingerprints (populates the
cache-hit metric), regeneration of stale project context only. Persisting an augmentation (PRD §5.5, §11.2, §12.2
"Partially sufficient skill") saves it as its own artifact that references the base skill by name and
by `augments-sha256`, the base version it was evaluated against. The base skill is never edited;
when the base's hash no longer matches, the freshness validator treats the augmentation as stale. Skills saved before Phase 3 carry no context fingerprint; the freshness validator treats them as needing a relevance check.

- **FRs:** FR-35, FR-36, FR-38.
- **Exit gate:** changing a fingerprinted file marks only the dependent skill stale; an unrelated commit
  triggers a relevance check but not invalidation; saving twice does not duplicate a skill; persistence
  never happens without an explicit choice (AC 26, 27).

### Phase 4 — Evaluation Maturity

Deliverables: `evals/` fixture library with rubrics, `benchmarks/` baseline-vs-skill runner (agent
executes scenario with and without the skill; scored by deterministic assertions + rubric), regression
detection across skill versions, evaluation history reporting, automated reduction/improvement loop
bounded by attempts.

- **FRs:** FR-37 plus maturity of FR-23–FR-26.
- **Exit gate:** benchmark run on ≥5 fixture tasks produces a with/without comparison report; a
  deliberately degraded skill is flagged as a regression.

### Phase 5 — Ecosystem Expansion

Deliverables: extension API for discovery detectors and evals (community contributions), additional
adapters, organisation-level skill libraries, lockfile-exact versions for pnpm/yarn, domain discovery
packs, optional `LlmProvider` for headless/API runs, multi-skill composition (FR-39).

- **Exit gate:** a third-party detector and adapter can be added without modifying core packages.

## Cross-phase risks

| Risk | Mitigation |
|---|---|
| A harness cannot activate a new skill mid-session | Confirmed for OpenCode V1 and Codex (non-ephemeral only); mitigation stands: read-into-context is the default |
| 60 s budget too tight with real agents | Phase 1 instruments every stage; the live smoke step measures it before Phase 2. Confirmed at the Phase 2 gate (Claude Code explicit run: 116.6 s active); the budget was raised to 300 s (PRD v0.9) after a second round measured about 220–250 s for four agent stretches of ~55 s |
| Agent ignores bootstrap steps | Bootstrap is short, command-driven, and the CLI's state machine rejects out-of-order steps |
| Heuristic evals produce false positives | Every heuristic eval is a warning unless the PRD makes it mandatory; Phase 4 adds rubric/benchmark depth |
