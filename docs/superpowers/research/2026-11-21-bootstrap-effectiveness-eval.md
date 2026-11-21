# Bootstrap skill effectiveness: a small eval of the imperative description

Date: 2026-11-21. Status: research record (no decision taken). Follows the
[invocation pilot](2026-11-21-bootstrap-invocation-pilot.md), which found that the imperative
description (v2) triggers the bootstrap on non-trivial tasks across Haiku, Sonnet and Opus while the
shipped description almost never does. This eval asks whether triggering it helps.

## Summary

- **No quality gain on this fixture.** Without the skill, Haiku and Sonnet already scored 8/8 on the
  specialist task and 6/6 on the routine task under a blind rubric, and every run passed its own
  tests. With the v2 skill, scores were the same or one item lower (Sonnet missed a reusable
  deduplicating consumer once).
- **A real cost when the full flow runs.** On the specialist task, Sonnet with the skill took 116 s
  instead of 66 s and cost $0.51 instead of $0.23 per run. Haiku took 145 s instead of 118 s.
- **Weak follow-through on Haiku.** Haiku invoked the skill in 4 of 4 runs but activated a skill in
  only 1. It usually ran `assess` and then did the task itself.
- **No over-triggering on borderline tasks.** v2 fired 0 of 24 times on a small bug fix, a one-line
  validation, a rename and a question, across Haiku, Sonnet and Opus.
- **Caveat that dominates:** the fixture is a two-function stub repository with almost no
  project-specific conventions. The skill's value is repository grounding, so this fixture cannot
  show it. The result is "no benefit where there is nothing to ground on", not "no benefit".

## Method

Claude Code 2.1.329, headless (`claude -p`), user settings, plugins and hooks excluded
(`--setting-sources project,local`), no permission bypass. Each run started from a fresh copy of a
prepared template: `fixtures/repos/ts-monorepo` with dependencies installed (template only: `nx`
pinned to 19.8.14 because 19.8.15 has an unpublished transitive dependency, `typescript` added), the
planted prompt injection and `.env` removed, and a baseline git commit. Bash was limited to `pnpm`,
`node`, `npx vitest|tsc|nx`, `dynamic-skills`, `ls`, `cat`, `mkdir` and read-only `git`. Writes were
allowed only inside the run directory; web tools were denied.

### Part A: full runs (16)

- Conditions: **v2**, where the bootstrap was installed with the real
  `dynamic-skills init --harness claude-code --scope project` and its description replaced with v2
  (the CLI on `PATH`, a per-run session home, the 300 s budget); **no skill**, the plain template.
- Tasks: **t1 specialist** (optimistic concurrency, transactional outbox, at-least-once relay,
  idempotency keys, tests for conflict, retry and duplicate delivery) and **t2 routine** (Nx-cached
  build and test targets, a vitest suite, CI running the Nx targets). The prompts are in the
  [pilot note](2026-11-21-bootstrap-invocation-pilot.md#tasks).
- Models: Haiku 5.5 and Sonnet 5.5. Two repeats per cell.
- Measures:
  - the agent's own tests, re-run by us with vitest;
  - `tsc --noEmit` where the agent added a tsconfig;
  - whether the skill was invoked and how far the flow went (`dynamic-skills` calls, `activate`);
  - wall time and cost from the run result;
  - a blind rubric score. Opus 5.5 graded each diff (lockfiles, `node_modules` and `.claude/`
    excluded) without tools, under a shuffled anonymous id, against the rubric below, plus a 1–5
    quality rating. None of the diffs mentions Dynamic Skills, so condition did not leak.

Rubric t1 (8 items): version increments on update; typed `ConflictError` with id and both versions;
stale update rejected with state unchanged; state change and outbox event written together;
delivery marked only after a successful publish, with retries; stable idempotency key; consumer
deduplication implemented and used; tests cover conflict, retry and duplicate delivery.

Rubric t2 (6 items): `project.json` build and test targets that run; cached `test` target default
with the build default kept; sensible cache inputs and outputs; vitest suite for both functions; CI
runs the Nx targets; existing tools used, no unrelated churn or unneeded dependencies.

### Part B: borderline invocation (24)

The v2 description only, invocation measured within the first 4 turns (the pilot's method), on four
borderline tasks (fix `updateOrder` ignoring its patch; throw `TypeError` on an empty id; rename
`getOrder` to `fetchOrder` everywhere; ask what CI runs) × Haiku, Sonnet, Opus × 2 repeats.

## Results

### Part A (means of two runs)

| Task | Model | Condition | Invoked | Activated | Tests pass | Rubric | Quality | Wall time | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| t1 specialist | Haiku | no skill | – | – | 2/2 | 8.0/8 | 5.0 | 118 s | $0.027 |
| t1 specialist | Haiku | v2 | 2/2 | 1/2 | 2/2 | 8.0/8 | 4.0 | 145 s | $0.040 |
| t1 specialist | Sonnet | no skill | – | – | 2/2 | 8.0/8 | 4.0 | 66 s | $0.226 |
| t1 specialist | Sonnet | v2 | 2/2 | 2/2 | 2/2 | 7.5/8 | 4.0 | 116 s | $0.505 |
| t2 routine | Haiku | no skill | – | – | 2/2 | 6.0/6 | 4.0 | 59 s | $0.013 |
| t2 routine | Haiku | v2 | 2/2 | 0/2 | 2/2 | 6.0/6 | 4.0 | 62 s | $0.015 |
| t2 routine | Sonnet | no skill | – | – | 2/2 | 6.0/6 | 4.0 | 32 s | $0.132 |
| t2 routine | Sonnet | v2 | 0/2 | 0/2 | 2/2 | 6.0/6 | 4.0 | 30 s | $0.135 |

Notes:

- Sonnet did not invoke v2 on t2 here, although it did 2 of 2 in the pilot. The setups differ
  (here the full `init` install and broad tool access; the pilot stopped at 4 turns), and two
  repeats are too few to separate that from noise.
- The one rubric miss (Sonnet, v2, t1) was deduplication done as an ad-hoc loop inside a test
  rather than a reusable consumer.
- Haiku's skipped activations: in 3 of 4 invocations it ran `assess` (and sometimes `discover`),
  then implemented the task directly instead of continuing the flow. The fallback leaves the task
  done, but the skill adds nothing in those runs.

### Part B

| Task | Haiku | Sonnet | Opus |
| --- | --- | --- | --- |
| Bug fix (`updateOrder` ignores its patch) | 0/2 | 0/2 | 0/2 |
| One-line validation (`TypeError` on empty id) | 0/2 | 0/2 | 0/2 |
| Rename `getOrder` to `fetchOrder` everywhere | 0/2 | 0/2 | 0/2 |
| Question (what CI runs) | 0/2 | 0/2 | 0/2 |

The skill was listed in every run. With the pilot, v2 fires on feature-sized work and stays quiet
on one-function changes, renames and questions.

### Cost

Part A agent runs $2.18, blind grading $1.09, Part B $1.76, validation runs about $0.07: about
$5.10 in total.

Raw data:
[full runs with grades](data/2026-11-21-bootstrap-effectiveness-full-runs.tsv) and
[borderline invocation](data/2026-11-21-bootstrap-effectiveness-borderline.tsv).

## Interpretation

- Both tasks are within what current models do well from general knowledge, and the fixture has
  almost nothing project-specific to discover. A ceiling effect hides any benefit: the no-skill
  baseline already maxes the rubric.
- On such tasks the imperative description is a net cost: it roughly doubles Sonnet's time and cost
  on the specialist task for no measurable gain. Shipping v2 as-is is not justified by this
  evidence.
- The over-triggering boundary is reassuring: v2 does not fire on small changes or questions.
- Haiku's weak follow-through means "cheaper model plus skill" needs a bootstrap that keeps a weaker
  model on the flow (fewer, clearer steps) before that positioning can be tested.

## Limitations

- One small fixture with no real conventions; two tasks; two repeats; Claude Code only.
- The rubric checks the requested behaviour, not fit with project conventions, which is where the
  skill should help most. An LLM grader (Opus) may share blind spots with the agents.
- Agent tests were self-written; passing them shows internal consistency, not correctness against
  an independent suite.

## Next steps

1. **A fixture where grounding matters:** a realistic repository with conventions a model cannot
   guess (an internal result or error type, a house logging and event-bus API, a test harness with
   custom helpers, a documented pattern that differs from common practice), plus hidden reference
   tests and a rubric item for each convention. Rerun v0, v2 and no skill on it.
2. **Follow-through for weaker models:** measure where Haiku leaves the flow and try a bootstrap body
   that front-loads the next command after each step.
3. Repeat on Codex and OpenCode once installed.
4. Until then, keep the shipped description (v0); explicit invocation remains the documented path.
