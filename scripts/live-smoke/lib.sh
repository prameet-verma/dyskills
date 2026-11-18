#!/usr/bin/env bash
# Shared behaviour of the per-harness live smoke scripts (Phase 1 gate item 7, Phase 2 gate
# item 12). Sourced by claude-code.sh, codex.sh and opencode.sh; never run directly, never in CI.
#
# Isolation: everything the scripts create lives in one temp workspace removed on exit: a copy of
# fixtures/repos/ts-monorepo (git init), a session home (DYNAMIC_SKILLS_HOME), an etc dir
# (DYNAMIC_SKILLS_ETC_DIR, Ruling R28) and a bin dir holding the built CLI as the bare
# `dynamic-skills` (Ruling R19: never a package runner). `init` runs with project scope in the temp
# repo (plus OpenCode personal scope into a temp OPENCODE_CONFIG_DIR). The real harness config is
# never written by these scripts. The scripts never read credential files and never print
# environment values. The agent harness still keeps its own transcripts under the real home.
#
# The calling script defines these functions before calling smoke_main:
#   harness_install        run `dynamic-skills init --harness <id> ...`
#   harness_prompt MODE    print the prompt for the mode (autonomous|explicit)
#   harness_version_check  call version_check with the pinned versions
#   harness_run PROMPT OUT KIND  run the harness headless in $REPO, output to OUT. KIND is main (the
#                          narrowest grants, init and save denied by command line; Ruling R40),
#                          probe (structured output, same grants) or probe-consent (structured
#                          output, save allowed so the consent rule itself is what is tested; init
#                          stays denied)
#   harness_evidence OUT   optional: print denial evidence from the structured output
#   harness_probes         run the optional probes (D6, R32, R35, compound, /var alias)
#   harness_checklist      print the checklist for the human

TASK="Implement a new distributed caching strategy for the order-processing service"
REAL_HOME="${HOME}"

die() {
  echo "live-smoke: $*" >&2
  exit 1
}

note() { echo "== $* =="; }

# sha256 of a file, hash only.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# snapshot_roots OUT ROOT...: one "<sha256>  <path>" line per file (and "link  <path> -> <target>"
# per symlink) under every existing ROOT, sorted. Only hashes are written, never contents.
snapshot_roots() {
  local out="$1" root f
  shift
  : >"$out"
  for root in "$@"; do
    [[ -d "$root" ]] || continue
    while IFS= read -r -d '' f; do
      if [[ -L "$f" ]]; then
        printf 'link  %s -> %s\n' "$f" "$(readlink "$f")" >>"$out"
      else
        printf '%s  %s\n' "$(sha256_of "$f")" "$f" >>"$out"
      fi
    # -L follows a symlinked root (a dotfiles-managed ~/.claude/skills) so changes through it show.
    done < <(find -L "$root" \( -type f -o -type l \) -print0 2>/dev/null)
  done
  LC_ALL=C sort -o "$out" "$out"
}

# The permanent skill roots of the real user (never to be touched) and of the temp repo.
real_skill_roots() {
  REAL_ROOTS=(
    "$REAL_HOME/.claude/skills"
    "$REAL_HOME/.agents/skills"
    "${CODEX_HOME_REAL:-$REAL_HOME/.codex}/skills"
    "$OPENCODE_GLOBAL_SKILLS"
  )
}
repo_skill_roots() {
  REPO_ROOTS=(
    "$REPO/.claude/skills"
    "$REPO/.agents/skills"
    "$REPO/.codex/skills"
    "$REPO/.opencode/skills"
    "${TMP:-/nonexistent}/opencode-config/skills"
  )
}

# ac28_check [LABEL] [all|real]: compare the snapshots taken before and after the run. The
# bootstrap that `init` installed in the temp repo is part of the repo baseline (taken after
# init), so it is excluded. Scope real compares the user's permanent roots only (used after the
# probes, whose `save` writes to the temp repo on purpose).
ac28_check() {
  local label="${1:-AC 28}" scope="${2:-all}"
  local after_real="$TMP/snap-real-after" after_repo="$TMP/snap-repo-after" changed
  real_skill_roots
  repo_skill_roots
  snapshot_roots "$after_real" "${REAL_ROOTS[@]}"
  changed="$(diff "$TMP/snap-real-before" "$after_real" || true)"
  if [[ "$scope" == "all" ]]; then
    snapshot_roots "$after_repo" "${REPO_ROOTS[@]}"
    changed="$changed
$(diff "$TMP/snap-repo-before" "$after_repo" || true)"
  fi
  changed="$(printf '%s\n' "$changed" | sed -n 's/^[<>] [^ ]*  //p; s/^[<>] link  //p' | sort -u | tr '\n' ' ')"
  if [[ -z "${changed// /}" ]]; then
    echo "$label: PASS (no ephemeral skill reached a permanent skill root)"
  else
    echo "$label: FAIL $changed"
  fi
}

# json_field FILE FIELD: print a top-level string field of a JSON file (empty when absent).
json_field() {
  node -e '
    const fs = require("node:fs");
    try { const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (v !== undefined) console.log(String(v)); } catch { }
  ' "$1" "$2"
}

# newest_session: id of the newest live session directory, or empty.
newest_session() {
  ls -1t "$DYNAMIC_SKILLS_HOME/sessions" 2>/dev/null | head -n 1 || true
}

# print_reports: report perf plus the newest session's reports, and the AC 24 line.
print_reports() {
  local session perf outcome
  echo
  note "dynamic-skills report perf"
  dynamic-skills report perf 2>&1 || echo "(report perf failed)"
  session="$(newest_session)"
  if [[ -z "$session" ]]; then
    local archived
    archived="$(ls -1t "$DYNAMIC_SKILLS_HOME/reports" 2>/dev/null | head -n 1 || true)"
    if [[ -n "$archived" ]]; then
      echo
      note "archived reports/$archived (the session was cleaned)"
      cat "$DYNAMIC_SKILLS_HOME/reports/$archived"
      outcome="$(json_field "$DYNAMIC_SKILLS_HOME/reports/$archived" outcome)"
    else
      echo "No session was created: the agent did not invoke the skill, or a tool call was denied."
      outcome=""
    fi
  else
    local r # reports/performance.json, discovery.json and sufficiency.json
    for r in performance discovery sufficiency; do
      echo
      note "$session reports/$r.json"
      if [[ "$r" == "discovery" ]]; then
        echo "(programmaticMs = discovery stage; agenticMs = background-subagent wait, synthesis risk 3)"
      fi
      cat "$DYNAMIC_SKILLS_HOME/sessions/$session/reports/$r.json" 2>/dev/null \
        || echo "(no $r report: the session did not finish)"
    done
    perf="$DYNAMIC_SKILLS_HOME/sessions/$session/reports/performance.json"
    outcome="$(json_field "$perf" outcome)"
    echo
    note "$session reports/assumptions.json (how questions behaved headless is recorded here)"
    cat "$DYNAMIC_SKILLS_HOME/sessions/$session/reports/assumptions.json" 2>/dev/null \
      || echo "(no assumptions report)"
    echo
    echo "evaluation.json status: $(json_field "$DYNAMIC_SKILLS_HOME/sessions/$session/reports/evaluation.json" status)"
    echo "session.json status: $(json_field "$DYNAMIC_SKILLS_HOME/sessions/$session/session.json" status)  outcome: $(json_field "$DYNAMIC_SKILLS_HOME/sessions/$session/session.json" outcome)"
  fi
  echo
  echo "AC 24 (activated skill applied without restarting the session): performance outcome='${outcome:-none}'"
  echo "  [ ] outcome is 'activated' AND the agent's final reply (above) shows it used the new skill without a restart"
}

# timing: elapsed seconds of the main run against the 60 s budget (PRD SLA).
print_timing() {
  local secs="$1"
  if ((secs <= 60)); then
    echo "Timing: ${secs} s wall clock for the main run (60 s budget: WITHIN)"
  else
    echo "Timing: ${secs} s wall clock for the main run (60 s budget: OVER by $((secs - 60)) s)"
  fi
}

# parse_version TEXT: the first x.y.z in TEXT, or empty.
parse_version() {
  if [[ "$1" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]]; then
    echo "${BASH_REMATCH[1]}"
  fi
}

# version_check LABEL BINARY PINNED...: print the harness version and warn when it is not pinned.
HARNESS_VERSION=""
version_check() {
  local label="$1" bin="$2" raw pin
  shift 2
  raw="$("$bin" --version 2>/dev/null | head -n 1 || true)"
  HARNESS_VERSION="$(parse_version "$raw")"
  echo "$label version: ${HARNESS_VERSION:-unknown} (raw: ${raw:-none})"
  for pin in "$@"; do
    if [[ "$HARNESS_VERSION" == "$pin" ]]; then
      return 0
    fi
  done
  echo "WARNING: $label '${HARNESS_VERSION:-unknown}' is not a pinned tested version ($*); results are not gate evidence." >&2
}

# r31_check: `dynamic-skills -V save ...` and `dynamic-skills --version init ...` must exit non-zero. A program-level option before the subcommand must be refused (Ruling R31), or the
# allow rule `dynamic-skills *` would match while the save/init consent rules do not.
r31_check() {
  local rc out bad=0 i
  local -a cases=(
    "-V save --session smoke-r31 --scope project --harness $HARNESS_ID"
    "--version init --harness $HARNESS_ID --scope project --repo $REPO"
  )
  for i in 0 1; do
    local -a argv
    read -r -a argv <<<"${cases[$i]}"
    set +e
    out="$(cd "$REPO" && dynamic-skills "${argv[@]}" 2>&1)"
    rc=$?
    set -e
    if ((rc == 0)); then
      bad=1
      echo "R31: FAIL 'dynamic-skills ${cases[$i]}' exited 0"
    else
      echo "R31: ok 'dynamic-skills ${argv[0]} ...' refused (exit $rc): $(echo "$out" | head -n 1)"
    fi
  done
  if ((bad == 0)); then echo "R31: PASS (-V save and --version init are refused)"; fi
}

# probe NAME PROMPT [KIND]: run one extra headless prompt with structured output (KIND probe or
# probe-consent), timed. Prints the tool's own denial evidence (not just the model's account) and
# any trust warnings. The human judges the outcome against the expectation printed by the caller.
probe() {
  local name="$1" prompt="$2" kind="${3:-probe}" out="$TMP/out/probe-$1.txt" t0=$SECONDS
  echo
  note "probe: $name"
  echo "[progress] running probe $name ..." >&2
  set +e
  harness_run "$prompt" "$out" "$kind"
  local rc=$?
  set -e
  echo "(exit $rc after $((SECONDS - t0)) s)"
  echo "-- denial evidence from the structured output --"
  harness_evidence "$out"
  scan "$out" "Trust warnings" 'untrusted|not trusted|trust this|trust the'
}

# Default evidence: lines naming the CLI that carry a status, denial, rejection or exit marker.
harness_evidence() {
  { grep -i 'dynamic-skills' "$1" 2>/dev/null | grep -i -E 'denied|deny|reject|refus|error|status|exit|permission|blocked' \
    | cut -c1-400 | head -n 8; } || true
  echo "(end of evidence; field names of the structured output are unverified, see the raw file with SMOKE_KEEP)"
}

# scan FILE LABEL REGEX: count and show the matching lines of the main run output.
scan() {
  local file="$1" label="$2" re="$3" n
  n="$(grep -c -i -E "$re" "$file" 2>/dev/null || true)"
  echo "$label: ${n:-0} matching line(s)"
  grep -i -E "$re" "$file" 2>/dev/null | head -n 5 | sed 's/^/    /' || true
}

# A session id that exists after the main run, for the save probes; falls back to a placeholder
# (then `save` fails on the missing session, which still shows whether consent was asked).
probe_session() {
  local s
  s="$(newest_session)"
  echo "${s:-smoke-no-session}"
}

# cli_calls_report: how many times the workspace wrapper ran; zero with a session means shadowing.
cli_calls_report() {
  local n=0 session
  [[ -f "$CALLS_LOG" ]] && n="$(wc -l <"$CALLS_LOG" | tr -d ' ')"
  session="$(newest_session)"
  echo
  echo "Workspace dynamic-skills calls logged: $n"
  if [[ "$n" == "0" && -n "$session" ]]; then
    echo "SHADOWED: a session exists but the workspace build was never called; another dynamic-skills ran (R19)."
  fi
}

# smoke_keep: opt-in copy of the run output and the session reports (SMOKE_KEEP=<dir>).
smoke_keep() {
  [[ -n "${SMOKE_KEEP:-}" ]] || return 0
  [[ "$SMOKE_KEEP" == /* ]] || { echo "SMOKE_KEEP must be an absolute path; nothing kept." >&2; return 0; }
  mkdir -p "$SMOKE_KEEP"
  cp -R "$TMP/out" "$SMOKE_KEEP/out"
  [[ -d "$DYNAMIC_SKILLS_HOME/sessions" ]] && cp -R "$DYNAMIC_SKILLS_HOME/sessions" "$SMOKE_KEEP/sessions"
  [[ -d "$DYNAMIC_SKILLS_HOME/reports" ]] && cp -R "$DYNAMIC_SKILLS_HOME/reports" "$SMOKE_KEEP/reports"
  echo "Kept the run output and session files in $SMOKE_KEEP (agent output may contain anything the agent printed)."
}

# smoke_setup: temp workspace, fixture repo, CLI on PATH, isolation variables.
smoke_setup() {
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
  CLI="$ROOT/packages/cli/dist/index.js"
  [[ -f "$CLI" ]] || die "Built CLI not found at $CLI; run 'pnpm build' first."
  command -v node >/dev/null 2>&1 || die "node is required."
  command -v "$HARNESS_BIN" >/dev/null 2>&1 || die "The '$HARNESS_BIN' CLI is required for this smoke test."

  TMP="$(mktemp -d "${TMPDIR:-/tmp}/dyskills-smoke.XXXXXX")"
  TMP="$(cd "$TMP" && pwd -P)" # realpath: macOS /var -> /private/var
  trap 'rm -rf "$TMP"' EXIT

  REPO="$TMP/repo"
  BIN="$TMP/bin"
  mkdir -p "$BIN" "$TMP/out" "$TMP/etc" "$TMP/sessions-home"
  export DYNAMIC_SKILLS_HOME="$TMP/sessions-home"
  export DYNAMIC_SKILLS_ETC_DIR="$TMP/etc"
  cp -R "$ROOT/fixtures/repos/ts-monorepo" "$REPO"
  git -C "$REPO" init -q

  # The real OpenCode global skills dir, computed before any override of the config dir.
  OPENCODE_GLOBAL_CONFIG="${XDG_CONFIG_HOME:-$REAL_HOME/.config}/opencode"
  OPENCODE_GLOBAL_SKILLS="$OPENCODE_GLOBAL_CONFIG/skills"
  CODEX_HOME_REAL="${CODEX_HOME:-$REAL_HOME/.codex}"

  TMP_REAL="$TMP"
  # The bare dynamic-skills is a wrapper that logs each call, so a global install that shadows the
  # workspace build (a login shell re-ordering PATH) shows up as zero logged calls (R19).
  local node_bin
  node_bin="$(command -v node)"
  CALLS_LOG="$TMP/out/cli-calls.log"
  {
    echo '#!/usr/bin/env bash'
    printf 'printf "%%s %%s\\n" "$(date +%%s)" "${1:-}" >>%q\n' "$CALLS_LOG"
    printf 'exec %q %q "$@"\n' "$node_bin" "$CLI"
  } >"$BIN/dynamic-skills"
  chmod +x "$BIN/dynamic-skills"
  if type -a dynamic-skills >/dev/null 2>&1; then
    echo "WARNING: a dynamic-skills is already installed on PATH; it could shadow the workspace build:" >&2
    type -a dynamic-skills >&2 || true
  fi
  export PATH="$BIN:$PATH"
  TIMEOUT_CMD=()
  if [[ "${SMOKE_TIMEOUT_SECS:-600}" != "0" ]]; then
    if command -v timeout >/dev/null 2>&1; then
      TIMEOUT_CMD=(timeout "${SMOKE_TIMEOUT_SECS:-600}")
    elif command -v gtimeout >/dev/null 2>&1; then
      TIMEOUT_CMD=(gtimeout "${SMOKE_TIMEOUT_SECS:-600}")
    fi
  fi
  [[ "$(command -v dynamic-skills)" == "$BIN/dynamic-skills" ]] \
    || die "The linked dynamic-skills is not first on PATH."

  echo "Workspace: $TMP (removed on exit)"
  echo "Repo: $REPO   Session home: $DYNAMIC_SKILLS_HOME   Etc dir: $DYNAMIC_SKILLS_ETC_DIR"
}

# smoke_main HARNESS_ID HARNESS_BIN MODE: the common flow.
smoke_main() {
  HARNESS_ID="$1"
  HARNESS_BIN="$2"
  local mode="$3" prompt secs t0
  smoke_setup
  harness_version_check

  real_skill_roots
  snapshot_roots "$TMP/snap-real-before" "${REAL_ROOTS[@]}"

  note "init ($HARNESS_ID)"
  harness_install
  repo_skill_roots
  snapshot_roots "$TMP/snap-repo-before" "${REPO_ROOTS[@]}"

  prompt="$(harness_prompt "$mode")"
  echo
  echo "[progress] running $HARNESS_ID ($mode mode) in $REPO (timeout ${TIMEOUT_CMD[*]:-none}) ..." >&2
  t0=$SECONDS
  set +e
  harness_run "$prompt" "$TMP/out/main.txt" main
  local rc=$?
  set -e
  secs=$((SECONDS - t0))
  ((rc == 0)) || echo "$HARNESS_ID exited $rc; reporting what was recorded." >&2

  echo
  note "agent output (last 60 lines)"
  tail -n 60 "$TMP/out/main.txt" 2>/dev/null || true
  print_timing "$secs"
  print_reports
  cli_calls_report
  echo
  ac28_check "AC 28"

  if [[ "${SMOKE_SKIP_PROBES:-}" != "1" ]]; then
    harness_probes
  fi
  echo
  ac28_check "AC 28 (after probes)" real
  echo
  r31_check
  echo
  note "checklist for the human"
  harness_checklist
  echo
  smoke_keep
  echo "Re-run with SMOKE_SKIP_PROBES=1 to skip the extra probes (D6, R32/R35, compound, alias)."
}
