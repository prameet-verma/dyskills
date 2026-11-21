# Bootstrap skill invocation: live smoke evidence and a description-variant pilot

Date: 2026-11-21. Status: research record (no decision taken). Follow-up: the Phase 3 research
item "positioning and bootstrap effectiveness" in the
[roadmap](../plans/2026-11-14-dynamic-skills-roadmap.md).

## Question

Does a host agent invoke the `dynamic-skill-bootstrap` skill on its own (PRD AC 3, autonomous
invocation), and how much does that depend on the host model and on the wording of the skill's
`description`?

## Summary

- On Claude Code, the shipped description almost never triggers autonomous invocation on current
  models: 0 of 18 pilot runs across Haiku, Sonnet and Opus, and 0 of 4 Phase 2 smoke runs on
  Sonnet 5.5. It did trigger 3 of 3 times on Sonnet 5 (Claude Code 2.1.274).
- The skill was listed to the model in every run. Non-invocation is the model's judgement, not a
  discovery or install failure.
- A description that states *when* to run ("at the start of every non-trivial implementation task,
  before reading or editing code") triggered 12 of 12 times on non-trivial tasks across all three
  models, and 0 of 6 times on a trivial task.
- A description framed around project-specific conventions triggered mainly on the strongest model
  (Opus 4 of 4, Sonnet 1 of 4, Haiku 0 of 4).
- Describing what the skill produces did not trigger it at all (0 of 18).
- Explicit invocation works: on Claude Code 2.1.329 the full flow ran and activated a skill in
  113 s.
- Invocation is not benefit. Whether running the skill improves task outcomes is not measured yet.

## Phase 2 live smoke evidence (Claude Code)

Run with `scripts/live-smoke.sh` on the `fixtures/repos/ts-monorepo` fixture, with user plugins and
hooks excluded (`--setting-sources project,local`).

| Claude Code | Host model | Mode | Task | Invoked | Outcome | Main-run time |
| --- | --- | --- | --- | --- | --- | --- |
| 2.1.274 | Sonnet 5 | autonomous, autonomous `--native`, explicit | Nx targets | 3 of 3 | timeout at `evaluate` (150 s budget then) | 320–352 s |
| 2.1.329 | Sonnet 5.5 | explicit (`/dynamic-skill-bootstrap`) | Nx targets | yes | **activated** (AC 24) | 113 s |
| 2.1.329 | Sonnet 5.5 | autonomous, autonomous `--native` | Nx targets | 0 of 2 | agent did the task itself | 44–59 s |
| 2.1.329 | Sonnet 5.5 | autonomous, autonomous `--native` | optimistic concurrency + outbox | 0 of 2 | agent did the task itself | 63–69 s |

In every run: consent rules held (`save` and `init` were denied in headless mode, D6), R31 passed
(`-V save` and `--version init` refused), and no ephemeral skill reached a permanent skill root
(AC 28).

Two earlier findings shaped these runs:

- In the first round, the user's own plugin forced its brainstorming skill first ("MUST use before
  any creative work"), which pre-empted the bootstrap. The smoke now excludes user settings, so
  plugins and hooks do not load. Real setups with such plugins will see the same pre-emption.
- A full run needs four agent stretches (analysis, sufficiency, skill writing, smoke check) of
  about 55 s each on the host model, so the default budget was raised to 300 s (PRD v0.9).

## Description-variant pilot

### Method

- Claude Code 2.1.329, headless (`claude -p`), `--setting-sources project,local`, no permission
  bypass. Each run used a fresh copy of `fixtures/repos/ts-monorepo` (the planted prompt injection
  kept, the "fixture repository" README line removed) with the bootstrap installed at
  `.claude/skills/dynamic-skill-bootstrap/SKILL.md`. Only the frontmatter `description` differed
  between variants; the body was the shipped one.
- Each run stopped after 4 turns (`--max-turns 4`), so it measures only whether the model invokes
  the skill early, not what happens afterwards. "Invoked" means a `Skill` tool call naming
  `dynamic-skill-bootstrap` in the stream. In all 17 invocations it was the first tool call.
- 4 variants × 3 tasks × 3 models × 2 repeats = 72 runs. Total cost $6.62 (average per run: Haiku
  $0.006, Sonnet $0.11, Opus $0.16).
- Raw results: [data/2026-11-21-bootstrap-invocation-pilot.tsv](data/2026-11-21-bootstrap-invocation-pilot.tsv)
  (variant, task, model, repeat, invoked, listed, first tool, cost, seconds, exit code, end
  reason, model id).

### Variants

| Id | `description` |
| --- | --- |
| v0 current | Use before starting a task that needs specialised or project-specific expertise which existing skills and repository instructions may not cover, or when the user asks to create a skill. Drives the dynamic-skills command line to assess the gap, analyse the repository, decide whether an existing skill suffices, then reuse it, augment it or generate a short-lived skill for this task. Skip simple tasks, tasks existing skills clearly cover, and simple follow-ups. |
| v1 project-specific | Use before implementing a change in a repository whose conventions, constraints and existing patterns you have not yet studied this session. It analyses this codebase and produces a short task-specific skill grounded in its actual code, so the change fits the project rather than generic best practice. Also use when the user asks to create a skill. Skip trivial edits, questions and simple follow-ups. |
| v2 imperative | Use at the start of every non-trivial implementation task (a new feature, a refactor, a cross-cutting change), before reading or editing code. It assesses the gap, analyses the repository and activates a short, evaluated skill for the task. Also use when the user asks to create a skill. Skip trivial edits, questions and simple follow-ups. |
| v3 outcome-framed | Generates and activates an evaluated, task-specific skill grounded in this repository (its conventions, constraints and tests) in about two minutes, reusing or extending an existing skill when one fits. Use it when a task needs specialised or project-specific expertise, or when the user asks to create a skill. Skip trivial edits, questions and simple follow-ups. |

### Tasks

| Id | Prompt (abridged) |
| --- | --- |
| t1 specialist | Make `updateOrder` safe under concurrent writers: optimistic concurrency (version field, typed `ConflictError`), a transactional outbox with an at-least-once relay and idempotency keys, and vitest tests for conflict, retry and duplicate delivery. |
| t2 routine | Set up Nx-cached build and test targets for `packages/orders`, a vitest suite for `getOrder`/`updateOrder`, and make CI run the Nx targets. |
| t3 trivial | Add a one-line comment above `getOrder` saying what it returns. |

### Results (invocations out of 2 per cell)

| Variant | Model | t1 specialist | t2 routine | t3 trivial |
| --- | --- | --- | --- | --- |
| v0 current | Haiku | 0 | 0 | 0 |
|  | Sonnet | 0 | 0 | 0 |
|  | Opus | 0 | 0 | 0 |
| v1 project-specific | Haiku | 0 | 0 | 0 |
|  | Sonnet | 1 | 0 | 0 |
|  | Opus | 2 | 2 | 0 |
| v2 imperative | Haiku | 2 | 2 | 0 |
|  | Sonnet | 2 | 2 | 0 |
|  | Opus | 2 | 2 | 0 |
| v3 outcome-framed | Haiku | 0 | 0 | 0 |
|  | Sonnet | 0 | 0 | 0 |
|  | Opus | 0 | 0 | 0 |

Totals: v0 0/18, v1 5/18 (5/12 non-trivial), v2 12/18 (12/12 non-trivial, 0/6 trivial), v3 0/18.

## Interpretation

- A description that asks the model to judge whether it "needs specialised expertise" lets every
  current model conclude that it does not. A description that names the moment to run (start of a
  non-trivial implementation task, before reading code) removes that self-assessment and triggers
  reliably, while the "skip trivial edits" clause still held on the trivial task.
- Project-specific framing appeals most to the strongest model, which fits a positioning of
  "project grounding for frontier models on repository-specific work".
- The hypothesis "cheaper models reach for the skill more readily" is not supported by this pilot:
  Haiku invoked only under the imperative wording. The earlier 3 of 3 on Sonnet 5 looks specific
  to that model.

## Limitations

- Invocation only. Nothing here shows that invoking the skill improves the result, and the
  imperative wording would run the bootstrap (about 2 minutes plus tokens) on routine tasks too.
- Two repeats per cell, one fixture, three tasks, Claude Code only. Treat the numbers as
  directions, not rates.
- The over-triggering boundary is untested between "one-line comment" and "feature": small bug
  fixes, one-file changes and refactors may behave differently.
- Runs stopped at 4 turns; a model that would invoke the skill later in a task is counted as not
  invoking it.
- Model behaviour changes across releases (Sonnet 5 vs 5.5 already differ), so results need
  re-measuring when the host model changes.

## Next steps

1. **Effectiveness eval:** v2 against no skill on t1 and t2 as full runs (Haiku and Sonnet at
   least), measuring whether the result passes its tests, active time and cost.
2. **Boundary set:** 3–4 borderline tasks (small bug fix, one-file change, rename refactor,
   question about the code) to measure false positives per variant.
3. **Cross-harness:** repeat the invocation pilot on Codex and OpenCode once they are installed,
   since each harness lists skill descriptions differently.
4. Decide the shipped description and the product positioning from those results (Phase 3
   research item). Any new description must keep the bootstrap within its 2000-token limit and pass
   its own evaluator.
