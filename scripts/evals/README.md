# Eval harness

Reusable scripts for measuring whether the `dynamic-skill-bootstrap` skill gets invoked, and whether it
helps, with headless Claude Code runs. They replace the throwaway scripts behind
[the invocation pilot](../../docs/superpowers/research/2026-11-21-bootstrap-invocation-pilot.md) and
[the effectiveness eval](../../docs/superpowers/research/2026-11-21-bootstrap-effectiveness-eval.md).

These scripts run the real `claude` binary and spend real money. The repository tests never do: they use
a stub (`test/evals.test.ts`).

## Requirements

- `bash`, `git`, `perl` (for the portable wall-clock alarm), `node` 24 and `pnpm` on `PATH`.
- A built CLI (`pnpm build`) for any condition that installs the skill (`v0`, `explicit`, variants).
- `claude` on `PATH`, or `CLAUDE_BIN` pointing at it. Tested with Claude Code 2.1.329.

## Configuration

| Variable              | Default                          | Meaning                                               |
| --------------------- | -------------------------------- | ----------------------------------------------------- |
| `EVAL_OUT`            | `${TMPDIR:-/tmp}/dyskills-evals` | Where templates, runs, grids and grades go.           |
| `CLAUDE_BIN`          | `claude`                         | The headless client (a name on `PATH` or a path).     |
| `EVAL_GRADER_MODEL`   | `opus`                           | Model for blind rubric grading.                       |
| `EVAL_SUITES_DIR`     | `scripts/evals/suites`           | Where suites live (tests point it at a temp dir).     |
| `EVAL_NAME`           | `<mode>-<jobs>-<timestamp>`      | Directory name of a grid under `EVAL_OUT`.            |
| `EVAL_RUNS_DIR`       | `$EVAL_OUT/runs`                 | Where single runs go (a grid sets its own).           |
| `EVAL_FULL_TIMEOUT`   | `1500`                           | Seconds for a full run.                               |
| `EVAL_INVOKE_TIMEOUT` | `300`                            | Seconds for an invocation run.                        |
| `EVAL_GRADE_TIMEOUT`  | `300`                            | Seconds for one blind grading call.                   |
| `EVAL_CHECK_TIMEOUT`  | `180`                            | Seconds for each local vitest, tsc and checks.sh run. |

## Quick start

```sh
pnpm install --frozen-lockfile && pnpm build
bash scripts/evals/make-template.sh orders-stub          # once; needs network for pnpm install
bash scripts/evals/run-invoke.sh orders-stub v2-imperative t1 sonnet 1
bash scripts/evals/run-full.sh orders-stub noskill t1 haiku 1
printf 'orders-stub noskill t1 haiku 1\norders-stub v2-imperative t1 haiku 1\n' >jobs.txt
bash scripts/evals/run-grid.sh full jobs.txt 4           # prints the path of results.tsv
bash scripts/evals/grade-all.sh "$EVAL_OUT/<grid>/results.tsv"
```

## Scripts

| Script             | Arguments                                   | What it does                                                                                                  |
| ------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `make-template.sh` | `<suite> [--force]`                         | Copies the suite fixture to `$EVAL_OUT/templates/<suite>`, runs the suite's `prepare.sh`, commits a baseline. |
| `run-full.sh`      | `<suite> <cond> <task-id> <model> <rep>`    | One full run in a fresh copy of the template, then local grading. Prints one TSV row.                         |
| `run-invoke.sh`    | `<suite> <variant> <task-id> <model> <rep>` | Invocation-only run (`--max-turns 4`). Prints one TSV row.                                                    |
| `run-grid.sh`      | `<full\|invoke> <jobs-file> [parallel=4]`   | Runs a jobs file with `xargs -P`; writes `$EVAL_OUT/<name>/results.tsv` with a header.                        |
| `grade.sh`         | `<anon-id> <suite> <task-id> <diff-file>`   | Blind rubric grading of one diff by the grader model, no tools.                                               |
| `grade-all.sh`     | `<results.tsv> [parallel=4]`                | Shuffles and anonymises the runs that have a rubric, grades them, writes `joined.tsv` and `summary.tsv`.      |
| `lib.sh`           |                                             | Shared helpers (sourced).                                                                                     |

Every script runs with `--header` to print its TSV header (`run-full.sh --header`, `run-invoke.sh --header`).
A jobs file has one `<suite> <cond|variant> <task> <model> <rep>` per line; blank lines and `#` lines are
ignored. A job that fails leaves its stderr in `<grid>/errors/` and no row.

## Conditions

`run-full.sh` conditions:

- `noskill`: no skill installed.
- `v0`: `dynamic-skills init --scope project` with the shipped description.
- `explicit`: as `v0`, and the prompt is prefixed with `/dynamic-skill-bootstrap `.
- any `variants/<name>` (without `.txt`): `init`, then the `description:` line replaced with that variant.

`run-invoke.sh` takes a variant name. Its `SKILL.md` is the repository's current
`skills/dynamic-skill-bootstrap/SKILL.md` with only the description replaced, so the body never goes stale.

Variants (`variants/*.txt`, description text only, one line): `v0-current` (the description at the time of the
pilot), `v1-project`, `v2-imperative`, `v3-outcome`. Add a variant by adding a file.

## Outputs

Per run, in `$EVAL_RUNS_DIR/<suite>.<cond>.<task>.<model>.<rep>/`: `out.jsonl` (the stream-json transcript),
`err.txt`, `row.tsv`, and for full runs `diff.patch`, `vitest.json`, `vitest.txt`, `tsc.txt`, `checks.tsv`,
`hidden.json`, `init.json` and the final `repo/` without `node_modules`. Invocation runs keep only the
transcript and row.

`run-full.sh` columns: `suite cond task model rep invoked activated ds_calls last_sub tests passed tsc
checks_pass checks_total hidden_pass hidden_total cost secs turns end diff_lines model_id`.

- `invoked`: a `Skill` tool call naming `dynamic-skill-bootstrap`.
- `activated`: a bare `dynamic-skills activate` call.
- `ds_calls`, `last_sub`: how many `dynamic-skills` commands ran, and the last subcommand. It shows where a
  model left the flow (for example `assess` and nothing after).
- `tests`, `passed`: the agent's tests, re-run by the harness with vitest.
- `tsc`: `pass`, `fail` or `n/a` (no tsconfig found).
- `checks_*`, `hidden_*`: `-` when the suite has no `checks.sh` or hidden tests.
- `end`: the result subtype, `timeout` or `exit<code>`.

`run-invoke.sh` columns: `suite variant task model rep invoked listed first_tool turns cost secs end
model_id`. `listed` says whether the skill appeared in the session's skill list.

`grade-all.sh` writes beside `results.tsv`: `grades.tsv`, `anon-map.tsv`, `joined.tsv` (results plus
`rubric_pass rubric_total quality`) and `summary.tsv` (means per suite, task, model and condition).

## Suites

A suite is `suites/<suite>/` with:

- `fixture`: one line, the fixture directory (relative to the repository root, or absolute).
- `prepare.sh <template-dir>`: makes the fixture copy runnable (install dependencies, strip lines). Executable.
- `tasks/<task-id>.txt`: the task prompt.
- `rubrics/<task-id>.txt`: optional. The task text plus rubric items. No rubric, no blind grading for that task.
- `checks.sh <repo-dir> <task-id>`: optional. Prints `name<TAB>pass|fail` lines; the harness records the
  counts and keeps the lines in the run directory.
- `hidden/<task-id>/`: optional. Files copied into the repository after the agent finished, at the same
  relative paths. The harness runs vitest on just those files. The agent never sees them.

`orders-stub` uses `fixtures/repos/ts-monorepo`, a two-function stub. Tasks: `t1` (specialist: optimistic
concurrency and a transactional outbox), `t2` (routine: Nx targets and a vitest suite), `t3` (trivial
comment), `b1` to `b4` (borderline: bug fix, validation, rename, question). Rubrics exist for `t1` and `t2`.
A stub has almost nothing to ground a repository-specific skill on, so add a suite with real conventions
before drawing conclusions about the skill's value.

## Cost guidance

- Invocation runs are cheap (at most four turns, usually cents). Run these first.
- Full runs cost real money: in the recorded eval, a Sonnet specialist run took about 1 to 2 minutes and
  cost between $0.2 and $0.5; Haiku is cheaper. Rubric grading with Opus costs a few cents per diff.
- Start with `parallel=2` to `4`; each full run holds a dependency tree (cleaned afterwards) and one
  headless session. Use two or more reps per cell: single runs are noisy.
- The headless client has no spend cap here beyond the wall-clock limits above.

## Safety model

- The agent runs with `--setting-sources project,local`, so user settings, hooks and plugins are not
  loaded, and no permission-bypass option is ever passed.
- Bash is an allowlist: `pnpm`, `node`, `npx vitest|tsc|nx`, `dynamic-skills`, `ls`, `cat`, `mkdir`,
  read-only `git`. Anything else is denied in a headless run.
- `Edit` is allowed only inside the run directory, and denied on `~/.claude/**`, `~/.agents/**`,
  `~/.config/**` (derived from `$HOME`) and the run repository's own `.claude/**`. `WebFetch` and
  `WebSearch` are denied.
- `dynamic-skills init` runs with a jailed `HOME` and `CLAUDE_CONFIG_DIR`; the session uses a per-run
  `DYNAMIC_SKILLS_HOME` and `DYNAMIC_SKILLS_HARNESS=claude-code`.
- The CLI is a `dynamic-skills` shim on `PATH` that runs `packages/cli/dist/index.js`. It is never fetched
  through a package runner, and the scripts fail clearly when `dist` is missing.
- Runs are limited by a portable wall-clock alarm. `node_modules` is deleted from run directories after each
  run; transcripts, diffs and grading files are kept.
- The only network use is `pnpm install` in a suite's `prepare.sh`. The agent itself talks to its model
  endpoint as usual.
- The grader gets the diff as data, with no tools, under an anonymous id; the condition never leaks into it.
