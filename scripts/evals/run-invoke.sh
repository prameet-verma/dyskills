#!/usr/bin/env bash
# run-invoke.sh <suite> <variant> <task-id> <model> <rep>   (run-invoke.sh --header prints the TSV header)
# Invocation-only run (--max-turns 4): does the model call the bootstrap skill? The SKILL.md is the
# repository's current skill with the description replaced by variants/<variant>.txt. Prints one TSV row.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/lib.sh"

if [ "${1:-}" = --header ]; then invoke_header; exit 0; fi
[ $# -eq 5 ] || die "usage: run-invoke.sh <suite> <variant> <task-id> <model> <rep>"
suite=$1 variant=$2 task=$3 model=$4 rep=$5
check_name variant "$variant"; check_name task "$task"; check_name rep "$rep"
SD=$(suite_dir "$suite")
[ -f "$SD/tasks/$task.txt" ] || die "no task '$task' in suite '$suite'"
[ -f "$EVAL_DIR/variants/$variant.txt" ] || die "unknown variant '$variant' (no variants/$variant.txt)"
SRC="$EVAL_REPO_ROOT/skills/dynamic-skill-bootstrap"
[ -f "$SRC/SKILL.md" ] || die "missing $SRC/SKILL.md"
need_claude
prompt=$(cat "$SD/tasks/$task.txt")

bash "$EVAL_DIR/make-template.sh" "$suite" >&2
T="$EVAL_OUT/templates/$suite"
id=$(run_id "$suite" "$variant" "$task" "$model" "$rep")
W="$EVAL_RUNS_DIR/$id"
safe_rm "$W"
mkdir -p "$W"
W=$(cd "$W" && pwd -P)
# A clone carries only tracked files: no dependency tree is needed to see whether the skill fires.
git clone -q --no-hardlinks "$T" "$W/repo"
git -C "$W/repo" remote remove origin
mkdir -p "$W/repo/.claude/skills"
cp -R "$SRC" "$W/repo/.claude/skills/dynamic-skill-bootstrap"
set_description "$W/repo/.claude/skills/dynamic-skill-bootstrap/SKILL.md" "$EVAL_DIR/variants/$variant.txt"

WR=${W#/}
HR=${HOME#/}
deny=("WebFetch" "WebSearch" "Edit(//$HR/.claude/**)" "Edit(//$HR/.agents/**)" "Edit(//$HR/.config/**)"
  "Edit(//$WR/repo/.claude/**)")
RUN_PATH=$(run_path)

start=$(date +%s)
rc=0
(cd "$W/repo" && env PATH="$RUN_PATH" DYNAMIC_SKILLS_HOME="$W/home" DYNAMIC_SKILLS_HARNESS=claude-code \
  "${ALARM[@]}" "$EVAL_INVOKE_TIMEOUT" "$CLAUDE_ABS" -p "$prompt" --model "$model" --setting-sources project,local \
  --max-turns 4 --disallowed-tools "${deny[@]}" --output-format stream-json --verbose \
  </dev/null) >"$W/out.jsonl" 2>"$W/err.txt" || rc=$?
secs=$(($(date +%s) - start))

IFS=$'\t' read -r invoked listed first _activated _calls _last cost turns end model_id <<<"$(summarize_stream "$W/out.jsonl")"
end=$(end_reason "$end" "$rc")
rm -rf "$W/repo"

tsv "$suite" "$variant" "$task" "$model" "$rep" "$invoked" "$listed" "$first" "$turns" "$cost" "$secs" "$end" \
  "$model_id" | tee "$W/row.tsv"
