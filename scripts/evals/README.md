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

`run-full.sh` columns: `suite cond task model rep invoked activated ds_calls bootstrap_used last_sub tests
passed tests_rc tests_failed_suites tsc checks_pass checks_total hidden_pass hidden_total hidden_rc
hidden_failed_suites cost secs turns end diff_lines model_id`.

- `invoked`: a `Skill` tool call naming `dynamic-skill-bootstrap`. An `explicit` run starts with a slash
  command, which the client expands itself; stream-json does not echo the prompt and shows no `Skill` call.
  So `explicit` rows show `invoked` 0 by design.
- `bootstrap_used`: 1 when `invoked` or any successful `dynamic-skills` call happened. Use it, not
  `invoked`, to compare conditions; the summary reports both.
- `activated`, `ds_calls`, `last_sub`: only successful `dynamic-skills` calls count: the matching
  `tool_result` must not be an error or a denial and must contain `"ok":true`. `last_sub` is the last
  successful subcommand and shows where a model left the flow (for example `assess` and nothing after).
- `tests`, `passed`, `tests_rc`, `tests_failed_suites`: the agent's tests, re-run by the harness with vitest
  (exit code and failed suites from the json report). A run that fails to load anything has `tests` 0 and a
  non-zero `tests_rc`; the summary scores it 0, not "no data". `tests_rc` 127 means vitest was not installed.
- `tsc`: `pass`, `fail` or `n/a`. It covers every `tsconfig.json` up to depth 3 outside `node_modules`, so it
  is not comparable with the prototype eval, which type-checked only `packages/orders`.
- `checks_*`, `hidden_*`: `-` when the suite has no `checks.sh` or no hidden tests for the task. The hidden
  columns mirror the test columns.
- `end`: the result subtype, `timeout` or `exit<code>`.

After the agent finishes, `run-full.sh` works in this order: (1) capture `diff.patch`; (2) run `checks.sh`;
(3) re-run the agent's tests and `tsc`; (4) copy in the hidden tests and run them. The diff uses a private
git index, so nothing is staged by the harness: at step 2 the tree is exactly as the agent left it, relative
to the setup commit, and `git diff --name-only HEAD` plus `git ls-files --others --exclude-standard` list the
agent's changes. The diff leaves out `node_modules`, lockfiles, `.claude`, `.nx`, `dist` and `*.tsbuildinfo`.

`run-invoke.sh` columns: `suite variant task model rep invoked listed first_tool turns cost secs end
model_id`. `listed` says whether the skill appeared in the session's skill list. Invocation runs use the
prepared template (a git repository with pinned dependencies, and no `.env` or planted injection), so
rates can differ from the recorded pilot, which used a raw fixture copy.

`grade-all.sh` writes beside `results.tsv`: `grades.tsv`, `anon-map.tsv`, `joined.tsv` (results plus
`rubric_pass rubric_total quality`) and `summary.tsv` (means per suite, task, model and condition: `invoked`, `bootstrap_used`, `activated`,
`tests_pass`, `tests_failed_suites`, `hidden_pass`, `hidden_failed_suites`, `rubric`, `quality`, cost, seconds).

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

This is a guard against accidents, not a sandbox. `Bash(node *)` and `Bash(pnpm *)` can run arbitrary code,
so a determined or confused agent can write anywhere the user can. The `Edit`, home and `Read` denies stop
the direct tool paths only. Run evals on a machine and account where that is acceptable.

- The agent runs with `--setting-sources project,local`, so user settings, hooks and plugins are not
  loaded, and no permission-bypass option is ever passed.
- Bash is an allowlist: `pnpm`, `node`, `npx vitest|tsc|nx`, `dynamic-skills`, `ls`, `cat`, `mkdir`,
  read-only `git`. Anything else is denied in a headless run. `dynamic-skills init` and `dynamic-skills save`
  are denied in every condition, so a globally installed CLI cannot write the real home.
- `Edit` is allowed only inside the run directory, and denied on `~/.claude/**`, `~/.agents/**`,
  `~/.config/**` (from the real path of `$HOME`), `$CLAUDE_CONFIG_DIR` when set, and the run repository's own
  `.claude/**`. `Read` is denied on `scripts/evals/**` and the suites directory, so the agent cannot read
  hidden tests or rubrics. `WebFetch` and `WebSearch` are denied.
- `dynamic-skills init` runs with a jailed `HOME` and `CLAUDE_CONFIG_DIR`; the session uses a per-run
  `DYNAMIC_SKILLS_HOME`, `DYNAMIC_SKILLS_HARNESS=claude-code` and `NX_DAEMON=false`.
- The CLI is a `dynamic-skills` shim on `PATH` that runs `packages/cli/dist/index.js`. It is never fetched
  through a package runner, and the scripts fail clearly when `dist` is missing. The `claude` binary is
  called by absolute path; its directory is not put on `PATH`.
- Runs are limited by a wall-clock alarm that kills the whole process group. `node_modules` is deleted from
  run directories after each run; transcripts, diffs and grading files are kept.
- git runs with hooks and fsmonitor off, and diffs without external diff drivers or colour.
- The only network use is `pnpm install` in a suite's `prepare.sh`. The agent itself talks to its model
  endpoint as usual.
- The grader gets the diff as data, with no tools, under an anonymous id; the condition never leaks into it.

## Templates

`make-template.sh` stores a hash of the fixture tree plus `prepare.sh` in the template and rebuilds when it
no longer matches, under a `mkdir` lock so parallel callers build once. `EVAL_REPO_ROOT` (default: this
repository) names the root that holds `packages/cli/dist` and `skills/`; tests point it at a stub.
