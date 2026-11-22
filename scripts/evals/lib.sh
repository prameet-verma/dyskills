# shellcheck shell=bash
# Shared helpers for the eval harness. Source this file; it does not run anything by itself.
# Callers set `set -euo pipefail` first.

EVAL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
EVAL_REPO_ROOT=${EVAL_REPO_ROOT:-$(cd "$EVAL_DIR/../.." && pwd -P)}
EVAL_SUITES_DIR=${EVAL_SUITES_DIR:-$EVAL_DIR/suites}
EVAL_OUT=${EVAL_OUT:-${TMPDIR:-/tmp}/dyskills-evals}
mkdir -p "$EVAL_OUT"
EVAL_OUT=$(cd "$EVAL_OUT" && pwd -P)
CLAUDE_BIN=${CLAUDE_BIN:-claude}
EVAL_GRADER_MODEL=${EVAL_GRADER_MODEL:-opus}
EVAL_RUNS_DIR=${EVAL_RUNS_DIR:-$EVAL_OUT/runs}
EVAL_FULL_TIMEOUT=${EVAL_FULL_TIMEOUT:-1500}
EVAL_INVOKE_TIMEOUT=${EVAL_INVOKE_TIMEOUT:-300}
EVAL_GRADE_TIMEOUT=${EVAL_GRADE_TIMEOUT:-300}
EVAL_CHECK_TIMEOUT=${EVAL_CHECK_TIMEOUT:-180}
NODE_BIN=$(command -v node || true)
[ -n "$NODE_BIN" ] || { echo "evals: node not found on PATH" >&2; exit 1; }
NODE_DIR=$(dirname "$NODE_BIN")

die() {
  echo "evals: $*" >&2
  exit 1
}

# Names that become path parts must be plain tokens.
check_name() { # <label> <value>
  case $2 in
    '' | *[!A-Za-z0-9._-]*) die "invalid $1: '$2' (letters, digits, dot, underscore, dash only)" ;;
  esac
}

# Tab-joined line.
tsv() {
  local IFS=$'\t'
  printf '%s\n' "$*"
}

# Portable wall-clock limit (no timeout binary needed): "${ALARM[@]}" <seconds> <cmd> [args...]
# An array, not a function, so it can sit behind `env`.
ALARM=(perl -e 'alarm shift; exec @ARGV')

# Absolute path of the claude binary; only the scripts that run it call this.
need_claude() {
  CLAUDE_ABS=$(command -v "$CLAUDE_BIN" || true)
  [ -n "$CLAUDE_ABS" ] || die "CLAUDE_BIN '$CLAUDE_BIN' not found"
  case $CLAUDE_ABS in /*) ;; *) CLAUDE_ABS=$PWD/$CLAUDE_ABS ;; esac
}

# PATH for headless runs: [shim dir], node, pnpm and claude directories, then system dirs.
run_path() { # [extra-leading-dir]
  local p="" d pn
  pn=$(command -v pnpm || true)
  for d in "$@" "$NODE_DIR" "${pn:+$(dirname "$pn")}" "$(dirname "${CLAUDE_ABS:-/usr/bin/x}")" /usr/bin /bin; do
    [ -n "$d" ] && p="${p:+$p:}$d"
  done
  printf '%s' "$p"
}

suite_dir() { # <suite>
  check_name suite "$1"
  [ -d "$EVAL_SUITES_DIR/$1" ] || die "unknown suite '$1' (no $EVAL_SUITES_DIR/$1)"
  printf '%s' "$EVAL_SUITES_DIR/$1"
}

# The suite's fixture directory: absolute, or relative to the repository root.
fixture_dir() { # <suite>
  local f
  f=$(head -n 1 "$(suite_dir "$1")/fixture" | tr -d '\r' | sed 's/[[:space:]]*$//')
  [ -n "$f" ] || die "suite '$1' has an empty fixture file"
  case $f in /*) printf '%s' "$f" ;; *) printf '%s' "$EVAL_REPO_ROOT/$f" ;; esac
}

run_id() { # <suite> <cond> <task> <model> <rep>
  local m
  m=$(printf '%s' "$4" | tr -c 'A-Za-z0-9._\n-' '_')
  printf '%s.%s.%s.%s.%s' "$1" "$2" "$3" "$m" "$5"
}

# Copy a tree, using copy-on-write where the file system offers it.
copy_tree() { # <src> <dst>
  cp -cR "$1" "$2" 2>/dev/null && return 0
  rm -rf "$2"
  cp --reflink=auto -R "$1" "$2" 2>/dev/null && return 0
  rm -rf "$2"
  cp -R "$1" "$2"
}

# Remove only paths that live under EVAL_OUT.
safe_rm() { # <path>
  case $1 in
    "$EVAL_OUT"/?*) rm -rf "$1" ;;
    *) die "refusing to remove '$1' (outside $EVAL_OUT)" ;;
  esac
}

# A dynamic-skills shim on PATH that runs the built CLI. Prints the directory holding it.
ensure_shim() {
  local dist="$EVAL_REPO_ROOT/packages/cli/dist/index.js" dir="$EVAL_OUT/bin" tmp
  [ -f "$dist" ] || die "the CLI is not built ($dist is missing); run 'pnpm build' first"
  mkdir -p "$dir"
  tmp=$(mktemp "$dir/.shim.XXXXXX")
  printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE_BIN" "$dist" >"$tmp"
  chmod +x "$tmp"
  mv -f "$tmp" "$dir/dynamic-skills"
  printf '%s' "$dir"
}

# Replace the description: line of a SKILL.md with the text of a variant file.
set_description() { # <SKILL.md> <variant.txt>
  "$NODE_BIN" -e '
const fs = require("fs");
const [file, descFile] = process.argv.slice(1);
const desc = fs.readFileSync(descFile, "utf8").trim();
if (desc.includes("\n")) { console.error("evals: a description must be one line"); process.exit(1); }
const src = fs.readFileSync(file, "utf8");
if (!/^description: .*$/m.test(src)) { console.error("evals: no description line in " + file); process.exit(1); }
fs.writeFileSync(file, src.replace(/^description: .*$/m, () => "description: " + desc));
' "$1" "$2"
}

# Summarise a stream-json transcript. Prints one tab line, no empty fields:
# invoked listed first_tool activated ds_calls last_sub cost turns end model
summarize_stream() { # <out.jsonl>
  "$NODE_BIN" -e '
const fs = require("fs");
let text = "";
try { text = fs.readFileSync(process.argv[1], "utf8"); } catch { /* no transcript */ }
let invoked = 0, listed = 0, first = "", activated = 0, calls = 0, last = "-", cost = 0, turns = 0, end = "-", model = "-";
for (const l of text.split("\n")) {
  if (!l.trim()) continue;
  let d;
  try { d = JSON.parse(l); } catch { continue; }
  if (d.type === "system" && d.model) model = d.model;
  if (d.type === "system" && Array.isArray(d.skills))
    listed = d.skills.some((s) => String(s.name ?? s).includes("dynamic-skill-bootstrap")) ? 1 : 0;
  const c = d.message?.content;
  if (d.type === "assistant" && Array.isArray(c)) {
    for (const b of c) {
      if (b.type !== "tool_use") continue;
      if (!first) first = b.name + (b.name === "Skill" ? ":" + (b.input?.skill ?? "") : "");
      if (b.name === "Skill" && String(b.input?.skill ?? "").includes("dynamic-skill-bootstrap")) invoked = 1;
      const cmd = String(b.input?.command ?? "").trim();
      const m = /^dynamic-skills(?:\s+([A-Za-z][\w-]*))?/.exec(cmd);
      if (m) {
        calls++;
        last = m[1] ?? "-";
        if (m[1] === "activate") activated = 1;
      }
    }
  }
  if (d.type === "result") {
    cost = d.total_cost_usd ?? 0;
    turns = d.num_turns ?? 0;
    end = d.subtype || (d.is_error ? "error" : "-");
  }
}
console.log([invoked, listed, first || "-", activated, calls, last, cost.toFixed(4), turns, end, model].join("\t"));
' "$1"
}

# vitest json report -> "total passed" (0 0 when the report is missing or unreadable).
vitest_counts() { # <vitest.json>
  "$NODE_BIN" -e '
try {
  const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log((v.numTotalTests ?? 0) + "\t" + (v.numPassedTests ?? 0));
} catch { console.log("0\t0"); }
' "$1"
}

# End reason: the result subtype, else timeout (SIGALRM) or the exit code.
end_reason() { # <end-from-stream> <rc>
  if [ "$1" != "-" ]; then printf '%s' "$1"
  elif [ "$2" -eq 142 ]; then printf 'timeout'
  elif [ "$2" -ne 0 ]; then printf 'exit%s' "$2"
  else printf -- '-'
  fi
}

# Run vitest with the json reporter in a repo: vitest_json <repo> <out.json> <log> [file filters...]
vitest_json() {
  local repo=$1 out=$2 log=$3
  shift 3
  if [ -x "$repo/node_modules/.bin/vitest" ]; then
    (cd "$repo" && env PATH="$RUN_PATH" CI=1 "${ALARM[@]}" "$EVAL_CHECK_TIMEOUT" ./node_modules/.bin/vitest run \
      --reporter=json --outputFile="$out" "$@") >"$log" 2>&1 || true
  else
    echo "vitest is not installed in the run repository" >"$log"
  fi
}

full_header() {
  tsv suite cond task model rep invoked activated ds_calls last_sub tests passed tsc checks_pass checks_total \
    hidden_pass hidden_total cost secs turns end diff_lines model_id
}

invoke_header() {
  tsv suite variant task model rep invoked listed first_tool turns cost secs end model_id
}
