# shellcheck shell=bash
# Shared helpers for the eval harness. Source this file; it does not run anything by itself.
# Callers set `set -euo pipefail` first.

EVAL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
EVAL_REPO_ROOT=${EVAL_REPO_ROOT:-$(cd "$EVAL_DIR/../.." && pwd -P)}
EVAL_SUITES_DIR=${EVAL_SUITES_DIR:-$EVAL_DIR/suites}
EVAL_OUT=${EVAL_OUT:-${TMPDIR:-/tmp}/dyskills-evals}
# The agent's Read deny covers scripts/evals and the suites directory; runs under them would block it.
_eval_guard() { # <path>: fail when it is under a denied directory
  local g
  for g in "$EVAL_DIR" "$EVAL_REPO_ROOT/scripts/evals" "$(cd "$EVAL_SUITES_DIR" 2>/dev/null && pwd -P || true)"; do
    case "$1/" in
      "${g:-/nonexistent-guard}"/*)
        echo "evals: EVAL_OUT ($1) must not be under $g" >&2
        exit 1
        ;;
    esac
  done
}
case $EVAL_OUT in /*) _eval_guard "$EVAL_OUT" ;; esac
mkdir -p "$EVAL_OUT"
EVAL_OUT=$(cd "$EVAL_OUT" && pwd -P)
_eval_guard "$EVAL_OUT"
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

# git without hooks or fsmonitor, with a fixed identity, for every repository the harness touches.
GIT=(git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c user.name=eval -c user.email=eval@example.invalid
  -c commit.gpgsign=false)

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
# The command runs in its own process group, and the whole group is killed on timeout (exit 142) and on
# INT, TERM or HUP to the harness (exit 130, 143, 129), so an interrupted grid leaves no paid session behind.
# An array, not a function, so it can sit behind `env`.
ALARM=(perl -e '
my $secs = shift;
my $pid = fork();
die "fork: $!" unless defined $pid;
if (!$pid) { setpgrp(0, 0); exec @ARGV; exit 127; }
sub stop { my $code = shift; kill "TERM", -$pid; select(undef, undef, undef, 2); kill "KILL", -$pid; waitpid($pid, 0); exit $code; }
$SIG{ALRM} = sub { stop(142) };
$SIG{INT} = sub { stop(130) };
$SIG{TERM} = sub { stop(143) };
$SIG{HUP} = sub { stop(129) };
alarm $secs;
waitpid($pid, 0);
my $r = $?;
exit(($r & 127) ? 128 + ($r & 127) : $r >> 8);
')

# Absolute path of the claude binary; only the scripts that run it call this.
need_claude() {
  CLAUDE_ABS=$(command -v "$CLAUDE_BIN" || true)
  [ -n "$CLAUDE_ABS" ] || die "CLAUDE_BIN '$CLAUDE_BIN' not found"
  case $CLAUDE_ABS in /*) ;; *) CLAUDE_ABS=$PWD/$CLAUDE_ABS ;; esac
}

# PATH for headless runs: [shim dir], node and pnpm directories, then system dirs. The claude binary is
# called by absolute path and its directory is deliberately not on PATH.
run_path() { # [extra-leading-dir]
  local p="" d pn
  pn=$(command -v pnpm || true)
  for d in "$@" "$NODE_DIR" "${pn:+$(dirname "$pn")}" /usr/bin /bin; do
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
# invoked listed first_tool activated ds_calls last_sub cost turns end model bootstrap_used
# ds_calls, activated and last_sub count only successful dynamic-skills calls: the matching tool_result must
# not be an error and its output must start with {"ok":true (status prints text and is never counted;
# evaluate counts as successful even when the evaluation itself finds problems). invoked is a Skill tool_use naming the
# bootstrap skill. An explicit slash-command prompt is expanded by the client and never shows as a tool_use,
# so `explicit` runs have invoked 0 by design; bootstrap_used (invoked or any successful call) covers them.
summarize_stream() { # <out.jsonl>
  "$NODE_BIN" -e '
const fs = require("fs");
let text = "";
try { text = fs.readFileSync(process.argv[1], "utf8"); } catch { /* no transcript */ }
let invoked = 0, listed = 0, first = "", cost = 0, turns = 0, end = "-", model = "-";
const uses = []; // dynamic-skills Bash calls in order: {id, sub}
const results = new Map(); // tool_use_id -> {error, text}
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
      const m = /^dynamic-skills(?:\s+((?:context|sufficiency|eval|clarify)(?:\s+[A-Za-z][\w-]*)?|[A-Za-z][\w-]*))?(?=\s|$)/.exec(String(b.input?.command ?? "").trim());
      if (b.name === "Bash" && m) uses.push({ id: b.id, sub: m[1] ?? "-" });
    }
  }
  if (d.type === "user" && Array.isArray(c)) {
    for (const b of c) {
      if (b.type !== "tool_result") continue;
      const body = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((x) => x.text ?? "").join("\n") : "";
      results.set(b.tool_use_id, { error: b.is_error === true, text: body });
    }
  }
  if (d.type === "result") {
    cost = d.total_cost_usd ?? 0;
    turns = d.num_turns ?? 0;
    end = d.subtype || (d.is_error ? "error" : "-");
  }
}
let calls = 0, activated = 0, last = "-";
for (const u of uses) {
  const r = results.get(u.id);
  if (!r || r.error || !/^\s*\{"ok"\s*:\s*true\b/.test(r.text)) continue;
  calls++;
  last = u.sub;
  if (u.sub === "activate") activated = 1;
}
console.log([invoked, listed, first || "-", activated, calls, last, cost.toFixed(4), turns, end, model, invoked || calls > 0 ? 1 : 0].join("\t"));
' "$1"
}

# vitest json report plus exit code file -> "total passed failed_suites rc".
# Missing or unreadable reports count 0 0 0; rc is 127 when vitest was not run at all.
vitest_counts() { # <vitest.json>
  local rc=127
  [ -f "$1.rc" ] && rc=$(cat "$1.rc")
  "$NODE_BIN" -e '
try {
  const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log([v.numTotalTests ?? 0, v.numPassedTests ?? 0, v.numFailedTestSuites ?? 0, process.argv[2]].join("\t"));
} catch { console.log(["0", "0", "0", process.argv[2]].join("\t")); }
' "$1" "$rc"
}

# End reason: the result subtype, else timeout (SIGALRM) or the exit code.
end_reason() { # <end-from-stream> <rc>
  if [ "$1" != "-" ]; then printf '%s' "$1"
  elif [ "$2" -eq 142 ]; then printf 'timeout'
  elif [ "$2" -ne 0 ]; then printf 'exit%s' "$2"
  else printf -- '-'
  fi
}

# Run vitest with the json reporter in a repo and record its exit code in <out.json>.rc:
# vitest_json <repo> <out.json> <log> [file filters...]
vitest_json() {
  local repo=$1 out=$2 log=$3 rc=0
  shift 3
  if [ -x "$repo/node_modules/.bin/vitest" ]; then
    (cd "$repo" && env PATH="$RUN_PATH" CI=1 NX_DAEMON=false "${ALARM[@]}" "$EVAL_CHECK_TIMEOUT" \
      ./node_modules/.bin/vitest run --reporter=json --outputFile="$out" "$@") >"$log" 2>&1 || rc=$?
  else
    echo "vitest is not installed in the run repository" >"$log"
    rc=127
  fi
  echo "$rc" >"$out.rc"
}

# The deny list shared by full and invoke runs, in DENY. Not a sandbox: see the README.
build_deny() { # <run-dir>
  local w=${1#/} hr hr2 cfg=""
  hr=$(cd "$HOME" && pwd -P)
  hr=${hr#/}
  hr2=${HOME#/}
  DENY=("WebFetch" "WebSearch" "Bash(dynamic-skills init)" "Bash(dynamic-skills init *)" "Bash(dynamic-skills save)"
    "Bash(dynamic-skills save *)" "Edit(//$hr/.claude/**)" "Edit(//$hr/.agents/**)" "Edit(//$hr/.config/**)"
    "Edit(//$w/repo/.claude/**)" "Read(//${EVAL_REPO_ROOT#/}/scripts/evals/**)"
    "Read(//$(cd "$EVAL_SUITES_DIR" && pwd -P | sed 's|^/||')/**)")
  [ "$hr2" != "$hr" ] && DENY+=("Edit(//$hr2/.claude/**)" "Edit(//$hr2/.agents/**)" "Edit(//$hr2/.config/**)")
  if [ -n "${CLAUDE_CONFIG_DIR:-}" ] && [ -d "$CLAUDE_CONFIG_DIR" ]; then
    cfg=$(cd "$CLAUDE_CONFIG_DIR" && pwd -P)
    DENY+=("Edit(//${cfg#/}/**)")
  fi
  return 0
}

# Hash of a fixture tree plus its prepare.sh, so a stale template is detected.
tree_hash() { # <fixture-dir> <prepare.sh>
  local h="shasum -a 256"
  command -v shasum >/dev/null 2>&1 || h=sha256sum
  {
    (cd "$1" && find . -type f -not -path './node_modules/*' -not -path './.git/*' | LC_ALL=C sort \
      | while IFS= read -r f; do printf '%s ' "$f"; $h <"$f"; done)
    $h <"$2"
  } | $h | cut -d' ' -f1
}

full_header() {
  tsv suite cond task model rep invoked activated ds_calls bootstrap_used last_sub tests passed tests_rc \
    tests_failed_suites tsc checks_pass checks_total hidden_pass hidden_total hidden_rc hidden_failed_suites \
    cost secs turns end diff_lines model_id
}

invoke_header() {
  tsv suite variant task model rep invoked listed first_tool turns cost secs end model_id
}
