#!/usr/bin/env bash
# grade-all.sh <results.tsv> [parallel=4]
# Blind-grade every full run in a results file whose task has a rubric. Runs are shuffled and given
# anonymous ids (the grader sees only the diff). Writes next to results.tsv: grades.tsv, anon-map.tsv,
# joined.tsv (results columns plus rubric_pass, rubric_total, quality) and summary.tsv (means per
# suite x task x model x condition), and prints the summary table.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/lib.sh"

[ $# -ge 1 ] && [ $# -le 2 ] || die "usage: grade-all.sh <results.tsv> [parallel=4]"
res=$1 par=${2:-4}
[ -f "$res" ] || die "results file '$res' not found"
case $par in '' | *[!0-9]* | 0) die "parallel must be a positive integer" ;; esac
OUT=$(cd "$(dirname "$res")" && pwd -P)
res="$OUT/$(basename "$res")"
runs=$OUT/runs
[ -d "$runs" ] || runs=$EVAL_RUNS_DIR
export EVAL_GRADE_DIR="$OUT/grade"
mkdir -p "$EVAL_GRADE_DIR"

# Runs with a rubric and a diff, in random order (awk rand: macOS has no shuf).
list="$OUT/gradable.tmp"
awk -F'\t' -v suites="$EVAL_SUITES_DIR" -v runs="$runs" '
  NR == 1 { for (i = 1; i <= NF; i++) c[$i] = i; next }
  { suite = $c["suite"]; cond = $c["cond"]; task = $c["task"]; model = $c["model"]; rep = $c["rep"]
    gsub(/[^A-Za-z0-9._-]/, "_", model)
    id = suite "." cond "." task "." model "." rep
    print suite "\t" cond "\t" task "\t" $c["model"] "\t" rep "\t" id "\t" runs "/" id "/diff.patch" }
' "$res" | while IFS=$'\t' read -r suite cond task model rep id diff; do
  [ -f "$EVAL_SUITES_DIR/$suite/rubrics/$task.txt" ] && [ -f "$diff" ] || continue
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$suite" "$cond" "$task" "$model" "$rep" "$id" "$diff"
done | awk 'BEGIN { srand() } { printf "%.9f\t%s\n", rand(), $0 }' | sort | cut -f2- >"$list"

if [ ! -s "$list" ]; then
  rm -f "$list"
  die "nothing to grade in $res (no run with both a rubric and a diff.patch)"
fi

# anon-map.tsv: anon-id, run id. Jobs are NUL-separated so paths with spaces survive.
: >"$OUT/anon-map.tsv"
n=0
args="$OUT/grade-args.tmp"
: >"$args"
while IFS=$'\t' read -r suite cond task model rep id diff; do
  n=$((n + 1))
  anon=$(printf 'g%03d' "$n")
  printf '%s\t%s\n' "$anon" "$id" >>"$OUT/anon-map.tsv"
  printf '%s\0%s\0%s\0%s\0' "$anon" "$suite" "$task" "$diff" >>"$args"
done <"$list"

echo "grading $n runs, $par parallel, grader model $EVAL_GRADER_MODEL" >&2
export GRADE_SH="$EVAL_DIR/grade.sh"
xargs -0 -n 4 -P "$par" bash -c 'bash "$GRADE_SH" "$@" || echo "evals: grading failed: $1" >&2' _ <"$args" \
  | sort >"$OUT/grades.tsv" || true
rm -f "$list" "$args"

"$NODE_BIN" - "$res" "$OUT" <<'JS'
const fs = require("fs");
const [res, out] = process.argv.slice(2);
const rd = (f) => fs.readFileSync(f, "utf8").split("\n").filter((l) => l.length);
const [head, ...rows] = rd(res).map((l) => l.split("\t"));
const col = Object.fromEntries(head.map((h, i) => [h, i]));
const san = (m) => m.replace(/[^A-Za-z0-9._-]/g, "_");
const idOf = (r) => [r[col.suite], r[col.cond], r[col.task], san(r[col.model]), r[col.rep]].join(".");
const anon = new Map(rd(`${out}/anon-map.tsv`).map((l) => l.split("\t").reverse()));
const grades = new Map(rd(`${out}/grades.tsv`).map((l) => { const f = l.split("\t"); return [f[0], f]; }));
const num = (v) => (v === undefined || v === "" || v === "-" || Number.isNaN(Number(v)) ? null : Number(v));
const mean = (xs) => { const v = xs.filter((x) => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const fmt = (x, d = 2) => (x === null ? "-" : x.toFixed(d));

// A run whose vitest failed to load anything (tests 0, non-zero exit) scores 0, not "no data".
const rate = (total, passed, rc) => {
  const t = num(total);
  if (t) return num(passed) / t;
  return num(rc) ? 0 : null;
};
const joined = [[...head, "rubric_pass", "rubric_total", "quality"].join("\t")];
const groups = new Map();
for (const r of rows) {
  const g = grades.get(anon.get(idOf(r)) ?? "");
  const ok = g && g[1] !== "";
  joined.push([...r, ok ? g[1] : "", ok ? g[2] : "", ok ? g[3] : ""].join("\t"));
  const key = [r[col.suite], r[col.task], r[col.model], r[col.cond]].join("\t");
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({
    invoked: num(r[col.invoked]), used: num(r[col.bootstrap_used]), activated: num(r[col.activated]),
    testRate: rate(r[col.tests], r[col.passed], r[col.tests_rc]),
    suitesFailed: num(r[col.tests_failed_suites]),
    hiddenRate: r[col.hidden_total] === "-" ? null : rate(r[col.hidden_total], r[col.hidden_pass], r[col.hidden_rc]),
    hiddenSuitesFailed: num(r[col.hidden_failed_suites]),
    rubric: ok && num(g[2]) ? num(g[1]) / num(g[2]) : null,
    quality: ok ? num(g[3]) : null,
    cost: num(r[col.cost]), secs: num(r[col.secs]),
  });
}
fs.writeFileSync(`${out}/joined.tsv`, joined.join("\n") + "\n");
const sh = ["suite", "task", "model", "cond", "runs", "invoked", "bootstrap_used", "activated", "tests_pass",
  "tests_failed_suites", "hidden_pass", "hidden_failed_suites", "rubric", "quality", "cost", "secs"];
const sum = [sh.join("\t")];
for (const [key, xs] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
  const m = (f, d = 2) => fmt(mean(xs.map(f)), d);
  sum.push([...key.split("\t"), xs.length, m((x) => x.invoked), m((x) => x.used), m((x) => x.activated),
    m((x) => x.testRate), m((x) => x.suitesFailed), m((x) => x.hiddenRate), m((x) => x.hiddenSuitesFailed),
    m((x) => x.rubric), m((x) => x.quality), m((x) => x.cost, 3), m((x) => x.secs, 0)].join("\t"));
}
fs.writeFileSync(`${out}/summary.tsv`, sum.join("\n") + "\n");
const cells = sum.map((l) => l.split("\t"));
const w = cells[0].map((_, i) => Math.max(...cells.map((c) => c[i].length)));
for (const c of cells) console.log(c.map((v, i) => v.padEnd(w[i])).join("  ").trimEnd());
console.error(`wrote ${out}/joined.tsv and ${out}/summary.tsv`);
JS
