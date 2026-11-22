#!/usr/bin/env bash
# run-full.sh <suite> <cond> <task-id> <model> <rep>   (run-full.sh --header prints the TSV header)
# One full headless run in a fresh copy of the suite template, then local grading. Prints one TSV row.
#   cond: noskill | v0 (shipped description) | explicit (shipped, prompt prefixed with
#         /dynamic-skill-bootstrap ) | <name> for any variants/<name>.txt.
# After the agent finishes, in this order: (1) capture the diff, (2) run the suite's checks.sh while the tree
# is exactly as the agent left it, (3) re-run the agent's tests and tsc, (4) copy in the hidden tests and run
# them. Blind rubric grading is separate (grade-all.sh).
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/lib.sh"

if [ "${1:-}" = --header ]; then full_header; exit 0; fi
[ $# -eq 5 ] || die "usage: run-full.sh <suite> <cond> <task-id> <model> <rep>"
suite=$1 cond=$2 task=$3 model=$4 rep=$5
check_name condition "$cond"; check_name task "$task"; check_name rep "$rep"
SD=$(suite_dir "$suite")
[ -f "$SD/tasks/$task.txt" ] || die "no task '$task' in suite '$suite'"
case $cond in
  noskill | v0 | explicit) ;;
  *) [ -f "$EVAL_DIR/variants/$cond.txt" ] || die "unknown condition '$cond' (noskill, v0, explicit or a variants/<name>.txt)" ;;
esac
need_claude
prompt=$(cat "$SD/tasks/$task.txt")
[ "$cond" = explicit ] && prompt="/dynamic-skill-bootstrap $prompt"

bash "$EVAL_DIR/make-template.sh" "$suite" >&2
T="$EVAL_OUT/templates/$suite"
id=$(run_id "$suite" "$cond" "$task" "$model" "$rep")
W="$EVAL_RUNS_DIR/$id"
safe_rm "$W"
mkdir -p "$W/home" "$W/fakehome"
W=$(cd "$W" && pwd -P)
copy_tree "$T" "$W/repo"
REPO="$W/repo"

SHIM=""
if [ "$cond" != noskill ]; then
  SHIM=$(ensure_shim)
  RUN_PATH=$(run_path "$SHIM")
  # init runs with a jailed HOME so nothing outside the run directory is touched.
  (cd "$REPO" && env HOME="$W/fakehome" CLAUDE_CONFIG_DIR="$W/fakehome/.claude" PATH="$RUN_PATH" \
    DYNAMIC_SKILLS_HOME="$W/home" DYNAMIC_SKILLS_HARNESS=claude-code \
    dynamic-skills init --harness claude-code --scope project --repo "$REPO") >"$W/init.json" 2>&1 \
    || die "dynamic-skills init failed; see $W/init.json"
  SKILL="$REPO/.claude/skills/dynamic-skill-bootstrap/SKILL.md"
  [ -f "$SKILL" ] || die "init did not install $SKILL"
  case $cond in v0 | explicit) ;; *) set_description "$SKILL" "$EVAL_DIR/variants/$cond.txt" ;; esac
else
  RUN_PATH=$(run_path)
fi
(cd "$REPO" || exit 1
  "${GIT[@]}" add -A && "${GIT[@]}" commit -q -m setup --allow-empty)

# Safety: a command allowlist, Edit only inside the run directory, no web, no edits to user config, no reads
# of the harness (hidden tests, rubrics). This is a guard against accidents, not a sandbox (see the README).
WR=${W#/}
allow=("Read" "Glob" "Grep" "Edit(//$WR/**)" "Bash(pnpm *)" "Bash(node *)" "Bash(npx vitest *)" "Bash(npx tsc *)"
  "Bash(npx nx *)" "Bash(dynamic-skills *)" "Bash(ls *)" "Bash(cat *)" "Bash(mkdir *)" "Bash(git status *)"
  "Bash(git diff *)" "Agent" "Task" "Skill" "TodoWrite")
build_deny "$W"

start=$(date +%s)
rc=0
(cd "$REPO" || exit 1
  env PATH="$RUN_PATH" DYNAMIC_SKILLS_HOME="$W/home" DYNAMIC_SKILLS_HARNESS=claude-code NX_DAEMON=false \
  "${ALARM[@]}" "$EVAL_FULL_TIMEOUT" "$CLAUDE_ABS" -p "$prompt" --model "$model" --setting-sources project,local \
  --allowed-tools "${allow[@]}" --disallowed-tools "${DENY[@]}" --output-format stream-json --verbose \
  </dev/null) >"$W/out.jsonl" 2>"$W/err.txt" || rc=$?
secs=$(($(date +%s) - start))
# Interrupted (INT, TERM, HUP): stop here instead of recording a row for a killed run.
case $rc in 129 | 130 | 143) exit "$rc" ;; esac

# (1) The agent's change, without generated files. A private index keeps the repository's own index and
# working tree exactly as the agent left them: nothing is staged by the harness.
(
  cd "$REPO" || exit 1
  export GIT_INDEX_FILE="$W/diff.index"
  "${GIT[@]}" read-tree HEAD
  "${GIT[@]}" add -A >/dev/null 2>&1 || true
  "${GIT[@]}" diff --cached --no-ext-diff --no-color HEAD -- . ':(exclude,glob)**/node_modules/**' \
    ':(exclude,glob)**/pnpm-lock.yaml' ':(exclude,glob).claude/**' ':(exclude,glob)**/.nx/**' \
    ':(exclude,glob)**/dist/**' ':(exclude,glob)**/*.tsbuildinfo'
) >"$W/diff.patch" || true
rm -f "$W/diff.index"
diff_lines=$(wc -l <"$W/diff.patch" | tr -d ' ')

# (2) Objective checks, on the tree as the agent left it: `git diff --name-only HEAD` plus untracked files
# lists the agent's changes relative to the setup commit.
checks_pass=- checks_total=-
if [ -f "$SD/checks.sh" ]; then
  (cd "$REPO" || exit 1
    env PATH="$RUN_PATH" "${ALARM[@]}" "$EVAL_CHECK_TIMEOUT" bash "$SD/checks.sh" "$REPO" "$task") \
    >"$W/checks.tsv" 2>"$W/checks.err" || true
  IFS=' ' read -r checks_pass checks_total <<<"$(awk -F'\t' '$2=="pass"{p++} $2=="pass"||$2=="fail"{t++} END{print p+0, t+0}' "$W/checks.tsv")"
fi

# (3) The agent's own tests, re-run by us, and tsc over every tsconfig up to depth 3.
vitest_json "$REPO" "$W/vitest.json" "$W/vitest.txt"
IFS=$'\t' read -r tests passed tests_failed_suites tests_rc <<<"$(vitest_counts "$W/vitest.json")"

tsc=n/a
if [ -x "$REPO/node_modules/.bin/tsc" ]; then
  tsc_n=0 tsc_bad=0
  while IFS= read -r cfg; do
    tsc_n=$((tsc_n + 1))
    (cd "$REPO" || exit 1
      env PATH="$RUN_PATH" "${ALARM[@]}" "$EVAL_CHECK_TIMEOUT" ./node_modules/.bin/tsc --noEmit \
      -p "$(dirname "$cfg")") >>"$W/tsc.txt" 2>&1 || tsc_bad=$((tsc_bad + 1))
  done < <(cd "$REPO" && find . -maxdepth 3 -name tsconfig.json -not -path '*/node_modules/*' | sort)
  if [ "$tsc_n" -gt 0 ]; then
    [ "$tsc_bad" -eq 0 ] && tsc=pass || tsc=fail
  fi
fi

# (4) Hidden tests: copied in after the agent finished and its tests ran, so it never saw them.
hidden_pass=- hidden_total=- hidden_rc=- hidden_failed_suites=-
if [ -d "$SD/hidden/$task" ]; then
  files=()
  while IFS= read -r f; do
    f=${f#./}
    mkdir -p "$REPO/$(dirname "$f")"
    cp "$SD/hidden/$task/$f" "$REPO/$f"
    files+=("$f")
  done < <(cd "$SD/hidden/$task" && find . -type f | sort)
  if [ ${#files[@]} -gt 0 ]; then
    vitest_json "$REPO" "$W/hidden.json" "$W/hidden.txt" "${files[@]}"
    IFS=$'\t' read -r hidden_total hidden_pass hidden_failed_suites hidden_rc <<<"$(vitest_counts "$W/hidden.json")"
  fi
fi

IFS=$'\t' read -r invoked _listed _first activated calls last cost turns end model_id used <<<"$(summarize_stream "$W/out.jsonl")"
end=$(end_reason "$end" "$rc")

# Drop generated dependency trees; keep the transcript, the diff and the grading files.
find "$REPO" -name node_modules -type d -prune -exec rm -rf {} + 2>/dev/null || true
rm -rf "$REPO/.nx"

tsv "$suite" "$cond" "$task" "$model" "$rep" "$invoked" "$activated" "$calls" "$used" "$last" "$tests" "$passed" \
  "$tests_rc" "$tests_failed_suites" "$tsc" "$checks_pass" "$checks_total" "$hidden_pass" "$hidden_total" \
  "$hidden_rc" "$hidden_failed_suites" "$cost" "$secs" "$turns" "$end" "$diff_lines" "$model_id" | tee "$W/row.tsv"
