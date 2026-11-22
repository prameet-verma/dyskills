#!/usr/bin/env bash
# run-grid.sh <full|invoke> <jobs-file> [parallel=4]
# Run many jobs with xargs -P. The jobs file has one "<suite> <cond|variant> <task> <model> <rep>" per line
# (blank lines and lines starting with # are ignored). Results go to $EVAL_OUT/<name>/results.tsv with a
# header, and the runs to $EVAL_OUT/<name>/runs. <name> defaults to <mode>-<jobs-file-name>-<timestamp>;
# set EVAL_NAME to choose it.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/lib.sh"

[ $# -ge 2 ] && [ $# -le 3 ] || die "usage: run-grid.sh <full|invoke> <jobs-file> [parallel=4]"
mode=$1 jobs=$2 par=${3:-4}
case $mode in full) runner=run-full.sh ;; invoke) runner=run-invoke.sh ;; *) die "mode must be full or invoke" ;; esac
[ -f "$jobs" ] || die "jobs file '$jobs' not found"
case $par in '' | *[!0-9]* | 0) die "parallel must be a positive integer" ;; esac

name=${EVAL_NAME:-$mode-$(basename "$jobs" | tr -c 'A-Za-z0-9._\n-' '_')-$(date +%Y%m%d-%H%M%S)}
check_name name "$name"
OUT="$EVAL_OUT/$name"
mkdir -p "$OUT/runs"
clean="$OUT/jobs.txt"
awk 'NF && $1 !~ /^#/' "$jobs" >"$clean"
[ -s "$clean" ] || die "no jobs in $jobs"
bad=$(awk 'NF != 5 {print NR": "$0}' "$clean")
[ -z "$bad" ] || die "each job needs 5 fields (suite cond task model rep):
$bad"

# Build every needed template once, up front, so parallel jobs never race on it.
for s in $(awk '{print $1}' "$clean" | sort -u); do
  bash "$EVAL_DIR/make-template.sh" "$s" >&2
done

bash "$EVAL_DIR/$runner" --header >"$OUT/results.tsv"
export EVAL_RUNS_DIR="$OUT/runs"
mkdir -p "$OUT/errors"
rows="$OUT/rows.tmp"
: >"$rows"
export GRID_RUNNER="$EVAL_DIR/$runner" GRID_ROWS="$rows" GRID_ERRS="$OUT/errors"
echo "grid $name: $(wc -l <"$clean" | tr -d ' ') jobs, $par parallel -> $OUT/results.tsv" >&2
# One short line per job, appended on success: parallel jobs do not interleave. A failed job leaves its
# stderr in errors/ and no row.
xargs -P "$par" -L 1 bash -c '
  row=$(bash "$GRID_RUNNER" "$@" 2>>"$GRID_ERRS/job-$$.err") && printf "%s\n" "$row" >>"$GRID_ROWS" \
    || echo "evals: job failed: $*" >&2
' _ <"$clean" || true
sort "$rows" >>"$OUT/results.tsv"
rm -f "$rows"
find "$OUT/errors" -type f -empty -delete 2>/dev/null || true
echo "$(($(wc -l <"$OUT/results.tsv") - 1)) of $(wc -l <"$clean" | tr -d ' ') jobs recorded: $OUT/results.tsv" >&2
printf '%s\n' "$OUT/results.tsv"
