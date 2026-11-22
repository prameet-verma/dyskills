# Grounding eval: does the bootstrap help agents follow a repository's house conventions?

Date: 2026-11-22. Status: research record (no decision taken). Follows the
[invocation pilot](2026-11-21-bootstrap-invocation-pilot.md) and the
[effectiveness eval](2026-11-21-bootstrap-effectiveness-eval.md), whose stub fixture had nothing
project-specific to learn. This eval uses a fixture built so that grounding matters.

## Summary

- **No measurable gain from the skill.** Without it, Haiku, Sonnet and Opus all passed every hidden
  behavioural spec (60 of 60 runs) and followed the house conventions almost as well as with it:
  static convention checks 0.86 (Haiku), 0.97 (Sonnet), 0.96 (Opus) without the skill, against
  0.95–0.99 with it in any form.
- **Agents ground themselves.** Without the skill, agents read `docs/conventions.md`, the
  no-exceptions ADR and the `inventory` reference package in 22 of 24 runs. The skill repeats
  exploration the agent already does.
- **The cost is real.** Running the full flow (explicit invocation) roughly doubled cost and time:
  Sonnet $0.65 and 139 s against $0.29 and 61 s; Opus $1.46 and 204 s against $0.60 and 83 s;
  Haiku $0.06 and 156 s against $0.02 and 90 s.
- **The only gap is in noise.** The one weak result was a no-skill Haiku run on the routine task
  (4 of 11 checks); its repeat scored 10 of 11, and runs where the skill was listed but never used
  (v0) scored 10 and 11. Two repeats cannot separate this from variance.
- **Follow-through:** explicit invocation activated a skill in every Sonnet and Opus run but only
  half of Haiku's; the imperative description (v2) was used in most runs but Sonnet and Haiku
  usually left the flow after `assess` or `discover`. The shipped description (v0) was never used.

## Fixture and suite

`fixtures/repos/conventions-monorepo` with the `conventions` suite in `scripts/evals/suites/`:

- Eight working house libraries (`@acme/result`, `errors`, `ids`, `log`, `events`, `db`,
  `outbox`, `testkit`) and ten conventions in `docs/conventions.md` and an ADR: Result values
  instead of exceptions, `defineError` tagged errors, writes inside `db.transaction`, optimistic
  concurrency only through `tx.updateWhereVersion`, events through `outbox.enqueue` in the same
  transaction, versioned dotted topics, deterministic idempotency keys, `newId` ids, structured
  `log.info`, and `*.spec.ts` tests using the testkit.
- `packages/inventory` is the complete reference; `packages/orders`, the target, is legacy code
  written before the ADR (throws, direct publish, unguarded writes, `*.test.ts`). The docs say new
  or changed code follows the conventions while `orders` is migrated. No file a harness auto-loads
  (`CLAUDE.md`, `AGENTS.md` and similar) exists.
- Tasks, in product language that names no library: **g1** make `updateOrder` safe for concurrent
  writers and announce every change reliably; **g2** add `cancelOrder`; **g3** add a routine
  `listOrdersByStatus` query.
- Scoring: hidden behavioural specs copied in after the run (g1 includes a recovery test and a
  commit-failure injection, so a non-durable design fails); up to 23 static convention checks over
  the agent's own changes; a blind Opus rubric split into functional and convention items. Before
  any paid run, reference solutions were measured: house style scored 10/10 hidden and 23/23
  checks on g1, generic correct designs 8–10/10 hidden but 4–6/23 checks, and an untouched repo
  3/10 and 0/23.

## Method

Claude Code 2.1.329 headless through `scripts/evals/run-grid.sh` (user settings, plugins and hooks
excluded; no permission bypass; writes allowed only in the run directory; the agent cannot read
the hidden specs or rubrics). Conditions: **noskill**; **v0**, the shipped description installed
with `dynamic-skills init`; **v2-imperative**; **explicit**, v0 with the prompt prefixed with
`/dynamic-skill-bootstrap`. Haiku and Sonnet ran g1–g3 in all four conditions, Opus ran g1 and g2
in noskill, v2 and explicit, two repeats each: 60 runs. Grading by `scripts/evals/grade-all.sh`.

## Results

Means per model over all tasks (n = runs):

| Model | Condition | n | Skill used | Activated | Hidden specs | Convention checks | Rubric (functional) | Rubric (conventions) | Cost | Time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Haiku | noskill | 6 | 0.00 | 0.00 | 1.00 | 0.86 | 1.00 | 0.88 | $0.02 | 90 s |
| Haiku | v0 | 6 | 0.00 | 0.00 | 1.00 | 0.95 | 1.00 | 0.96 | $0.03 | 100 s |
| Haiku | v2 | 6 | 1.00 | 0.00 | 1.00 | 0.98 | 1.00 | 1.00 | $0.03 | 98 s |
| Haiku | explicit | 6 | 1.00 | 0.50 | 1.00 | 0.96 | 1.00 | 0.92 | $0.06 | 156 s |
| Sonnet | noskill | 6 | 0.00 | 0.00 | 1.00 | 0.97 | 1.00 | 1.00 | $0.29 | 61 s |
| Sonnet | v0 | 6 | 0.00 | 0.00 | 1.00 | 0.96 | 1.00 | 1.00 | $0.28 | 61 s |
| Sonnet | v2 | 6 | 0.67 | 0.17 | 1.00 | 0.99 | 1.00 | 1.00 | $0.34 | 71 s |
| Sonnet | explicit | 6 | 1.00 | 1.00 | 1.00 | 0.98 | 1.00 | 0.98 | $0.65 | 139 s |
| Opus | noskill | 4 | 0.00 | 0.00 | 1.00 | 0.96 | 1.00 | 1.00 | $0.60 | 83 s |
| Opus | v2 | 4 | 0.75 | 0.75 | 1.00 | 0.96 | 1.00 | 1.00 | $1.31 | 192 s |
| Opus | explicit | 4 | 1.00 | 1.00 | 1.00 | 0.96 | 1.00 | 1.00 | $1.46 | 204 s |

How agents found the conventions (share of runs whose tool calls touched each source):

| Model | Condition | `docs/conventions.md` | ADR | `inventory` | Read calls |
| --- | --- | --- | --- | --- | --- |
| Haiku | noskill | 0.83 | 0.83 | 0.83 | 20.5 |
| Haiku | explicit | 1.00 | 1.00 | 1.00 | 9.2 |
| Sonnet | noskill | 1.00 | 1.00 | 1.00 | 16.3 |
| Sonnet | explicit | 1.00 | 1.00 | 1.00 | 12.0 |
| Opus | noskill | 1.00 | 1.00 | 1.00 | 10.8 |
| Opus | explicit | 1.00 | 1.00 | 1.00 | 11.0 |

Cost: agent runs $23.68, blind grading $4.31.

Raw data: [all runs with grades](data/2026-11-22-grounding-eval-runs.tsv) and
[summary per task, model and condition](data/2026-11-22-grounding-eval-summary.tsv).

## Interpretation

- In a small repository with a `docs/` folder and a reference package, current models from Haiku
  upward find and follow house conventions on their own. On-demand skill generation duplicates that
  exploration and roughly doubles cost and time, with no measurable quality gain.
- With the stub eval, this is the second result showing no task-time quality benefit. The
  "generate a skill for this task" value proposition is not supported for current Claude models on
  repositories that document their conventions.
- Plausible places the product could still add value, none measured yet:
  - **Reuse:** persisting the grounded skill so later sessions, teammates and other harnesses skip
    the exploration (the no-skill Haiku runs averaged 20 file reads). The benefit would be cost and
    time on repeated work, not quality.
  - **Hard discovery:** large repositories where conventions are undocumented, implicit in code, or
    far from the files being changed, so a single agent session explores incompletely.
  - **Weaker models:** smaller or open models run through other harnesses, where self-grounding may
    fail more often (Haiku showed the only weak run here).

## Limitations

- One small, well-documented fixture; three tasks; two repeats; Claude Code only. The fixture's
  docs are easy to find, which favours self-grounding.
- Static checks are grep-based and the rubric grader is an LLM; both agreed with the hidden-spec
  ceiling, but subtle convention misses may be under-detected.
- Run-to-run variance is large relative to the differences between conditions.

## Next steps

1. **Reuse eval:** a saved skill against fresh exploration on a sequence of related tasks, measuring
   cost and time per task and quality.
2. **Hard-discovery fixture:** a larger repository, or a real open-source one, with conventions that
   are implicit or scattered; rerun noskill against explicit.
3. **Other harnesses and weaker models** once Codex and OpenCode are installed.
4. Decide positioning from those results. Until then: keep the shipped description, keep explicit
   invocation as the documented path, and do not adopt the imperative description.
