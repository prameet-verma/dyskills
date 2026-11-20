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

# A real expertise gap that fixtures/repos/ts-monorepo supports (nx.json, a pnpm workspace, the
# packages/orders stubs, a CI workflow that only runs `pnpm test`), harness-neutral, with enough
# to do that the agent has no reason to ask questions first.
TASK="Make updateOrder in packages/orders safe under concurrent writers: add optimistic concurrency (a version field and a typed ConflictError), publish order-updated events through a transactional outbox (an in-memory outbox plus a relay with at-least-once delivery and idempotency keys so consumers can deduplicate), and add vitest tests for the conflict, retry and duplicate-delivery cases, following this monorepo's conventions."
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

# snapshot_roots ROOT...: print one "<sha256>  <path>" line per file under every existing ROOT,
# sorted, and "link  <path> -> <target>" per dangling symlink. Only hashes are printed, never
# contents. A symlinked file or root is followed (find -L), so a change behind a dotfiles symlink
# shows. Baselines are kept in shell variables, never in files the agent could rewrite (R41).
snapshot_roots() {
  local root f
  for root in "$@"; do
    [[ -d "$root" ]] || continue
    while IFS= read -r -d '' f; do
      if [[ -L "$f" && ! -f "$f" ]]; then
        printf 'link  %s -> %s\n' "$f" "$(readlink "$f")"
      else
        printf '%s  %s\n' "$(sha256_of "$f")" "$f"
      fi
    done < <(find -L "$root" \( -type f -o -type l \) -print0 2>/dev/null)
  done | LC_ALL=C sort
}

# The permanent skill roots of the real user (never to be touched) and of the temp repo.
# CLAUDE_SKILLS_ROOTS is the single list of Claude Code personal skill roots: ~/.claude/skills and,
# when CLAUDE_CONFIG_DIR is an absolute path to a different directory, its skills dir too. The
# watched roots and the AC 28 synced exclusion both derive from it, so they cannot disagree.
claude_skills_roots() {
  CLAUDE_SKILLS_ROOTS=("$REAL_HOME/.claude/skills")
  CLAUDE_CFG_EXTRA=""
  local cfg="${CLAUDE_CONFIG_DIR:-}" real_cfg real_def
  if [[ -n "$cfg" && "$cfg" == /* ]]; then
    real_cfg="$(cd "$cfg" 2>/dev/null && pwd -P || echo "$cfg")"
    real_def="$(cd "$REAL_HOME/.claude" 2>/dev/null && pwd -P || echo "$REAL_HOME/.claude")"
    if [[ "$real_cfg" != "$real_def" ]]; then
      CLAUDE_CFG_EXTRA="$cfg"
      CLAUDE_SKILLS_ROOTS+=("$cfg/skills")
    fi
  fi
}
real_skill_roots() {
  claude_skills_roots
  REAL_ROOTS=(
    "${CLAUDE_SKILLS_ROOTS[@]}"
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

# ac28_drop_synced SYNCED: filter snapshot lines, dropping paths at or under any of the
# newline-separated SYNCED directories.
ac28_drop_synced() {
  AC28_SYNCED="$1" awk '
    BEGIN { n = split(ENVIRON["AC28_SYNCED"], d, "\n") }
    { p = substr($0, index($0, "  ") + 2)
      for (i = 1; i <= n; i++) if (d[i] != "" && (p == d[i] || index(p, d[i] "/") == 1)) next
      print }'
}

# ac28_check [LABEL] [all|real]: compare the baselines (SNAP_REAL_BEFORE, SNAP_REPO_BEFORE) with
# a fresh snapshot. The bootstrap that `init` installed in the temp repo is part of the repo
# baseline (taken after init), so it is excluded. Scope real compares the user's permanent roots
# only (used after the probes, whose `save` writes to the temp repo on purpose).
ac28_check() {
  local label="${1:-AC 28}" scope="${2:-all}" changed after synced
  real_skill_roots
  repo_skill_roots
  # Claude Code itself syncs claude.ai skills into <config dir>/skills/synced/ (with a transient
  # .last-complete-round marker). Dynamic Skills never writes there, so that one subtree of each
  # Claude Code personal skill root (CLAUDE_SKILLS_ROOTS, the same list that is watched) is
  # excluded from the comparison; no other path is.
  synced="$(printf '%s/synced\n' "${CLAUDE_SKILLS_ROOTS[@]}")"
  after="$(snapshot_roots "${REAL_ROOTS[@]}" | ac28_drop_synced "$synced")"
  changed="$(diff <(printf '%s\n' "$SNAP_REAL_BEFORE" | ac28_drop_synced "$synced") <(printf '%s\n' "$after") || true)"
  if [[ "$scope" == "all" ]]; then
    after="$(snapshot_roots "${REPO_ROOTS[@]}")"
    changed="$changed
$(diff <(printf '%s\n' "$SNAP_REPO_BEFORE") <(printf '%s\n' "$after") || true)"
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

# json_last FILE FIELD: the last element of a top-level array field (empty when absent).
json_last() {
  node -e '
    const fs = require("node:fs");
    try { const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (Array.isArray(v) && v.length) console.log(String(v[v.length - 1])); } catch { }
  ' "$1" "$2"
}

# json_path FILE KEY KEY: a string field two levels down (empty when absent).
json_path() {
  node -e '
    const fs = require("node:fs");
    try { const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]][process.argv[3]]; if (v !== undefined) console.log(String(v)); } catch { }
  ' "$1" "$2" "$3"
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
    local ev="$DYNAMIC_SKILLS_HOME/sessions/$session/reports/evaluation.json" sj="$DYNAMIC_SKILLS_HOME/sessions/$session/session.json"
    echo "evaluation.json overall: $(json_field "$ev" overall)  activatable: $(json_field "$ev" activatable)"
    echo "session.json status: $(json_field "$sj" status)  last completed step: $(json_last "$sj" completedSteps)  outcome: $(json_path "$sj" metrics outcome)"
  fi
  echo
  echo "AC 24 (activated skill applied without restarting the session): performance outcome='${outcome:-none}'"
  echo "  [ ] outcome is 'activated' AND the agent's final reply (above) shows it used the new skill without a restart"
}

# Active-time budget in seconds; mirrors DEFAULT_BUDGET_MS in packages/core/src/constants.ts.
SMOKE_BUDGET_SECS=300

# print_timing: elapsed seconds of the main run against the budget (PRD SLA).
print_timing() {
  local secs="$1"
  if ((secs <= SMOKE_BUDGET_SECS)); then
    echo "Timing: ${secs} s wall clock for the main run (${SMOKE_BUDGET_SECS} s budget: WITHIN)"
  else
    echo "Timing: ${secs} s wall clock for the main run (${SMOKE_BUDGET_SECS} s budget: OVER by $((secs - SMOKE_BUDGET_SECS)) s)"
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
  local -a argv
  for i in 0 1; do
    if ((i == 0)); then
      argv=(-V save --session smoke-r31 --scope project --harness "$HARNESS_ID")
    else
      argv=(--version init --harness "$HARNESS_ID" --scope project --repo "$REPO")
    fi
    set +e
    out="$(cd "$REPO" && dynamic-skills "${argv[@]}" 2>&1)"
    rc=$?
    set -e
    if ((rc == 0)); then
      bad=1
      echo "R31: FAIL 'dynamic-skills ${argv[0]} ${argv[1]} ...' exited 0"
    else
      echo "R31: ok 'dynamic-skills ${argv[0]} ${argv[1]} ...' refused (exit $rc): $(echo "$out" | head -n 1)"
    fi
  done
  if ((bad == 0)); then echo "R31: PASS (-V save and --version init are refused)"; fi
}

# probe NAME PROMPT [KIND]: run one extra headless prompt with structured output (KIND probe or
# probe-consent), timed. Prints the tool's own denial evidence (not just the model's account) and
# any trust warnings. The human judges the outcome against the expectation printed by the caller.
probe() {
  local name="$1" prompt="$2" kind="${3:-probe}" out="$TMP/out/probe-$1.txt" t0=$SECONDS before=0
  if [[ -f "${CALLS_LOG:-}" ]]; then before="$(wc -l <"$CALLS_LOG" | tr -d ' ')"; fi
  echo
  note "probe: $name"
  echo "[progress] running probe $name ..." >&2
  set +e
  harness_run "$prompt" "$out" "$kind"
  local rc=$?
  set -e
  echo "(exit $rc after $((SECONDS - t0)) s)"
  echo "-- wrapper log lines for this probe (a 'refused' line is the live smoke guard, exit 2, not a harness consent denial) --"
  if [[ -f "${CALLS_LOG:-}" ]]; then tail -n +"$((before + 1))" "$CALLS_LOG"; fi
  echo "-- denial evidence from the structured output --"
  harness_evidence "$out"
  # Harnesses that keep stderr apart (Claude Code) have their warnings in the .stderr.txt file.
  if [[ -f "${out%.txt}.stderr.txt" ]]; then
    scan "${out%.txt}.stderr.txt" "Trust warnings" "$TRUST_RE"
  else
    scan "$out" "Trust warnings" "$TRUST_RE"
  fi
}

# Trust and settings warnings Claude Code and Codex print for an untrusted workspace.
TRUST_RE='untrusted|not trusted|not been trusted|trust this|trust the'

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

# dynamic-skills: the script's OWN calls (init, report perf, R31) go straight to the built CLI
# through this non-exported shell function. Bash does not pass functions to child processes, so the
# agent only ever sees the guarded wrapper on PATH.
dynamic-skills() {
  node "$CLI" "$@"
}

# make_wrapper PATH NODE CLI LOG HARNESS JAIL REPO_REAL DSH: write the bare `dynamic-skills` wrapper
# (Ruling R41, amended). It always guards and always logs (no opt-in variable an agent could unset).
# Layers: (1) for init and save, every home and config root points into $JAIL, so no parse trick can
# reach the real home (authoritative; DYNAMIC_SKILLS_HOME stays the real temp session home);
# (2) a strict parser: init and save accept only their own options (save --session --scope
# --harness; init --harness --scope --repo; and --dry-run as its own token), refuse unknown or
# repeated options, `--`, stray arguments and values starting with `-`; init only with --dry-run;
# save only with --scope project|ephemeral|discard, a harness set that is exactly the one under
# test (aliases and order allowed) and a session whose repo is the workspace repo; (3) any --repo
# of any command must lie inside the workspace repo. Exit 2 and a log line on refusal.
make_wrapper() {
  local out="$1" node_bin="$2" cli="$3" log="$4" harness="$5" jail="$6" repo_real="$7" dsh="$8"
  rm -f "$out" # an earlier wrapper is read-only
  {
    echo '#!/usr/bin/env bash'
    printf 'LOG=%q\nHARNESS=%q\nJAIL=%q\nREPO_REAL=%q\nNODE=%q\nCLI=%q\nDSH=%q\n' \
      "$log" "$harness" "$jail" "$repo_real" "$node_bin" "$cli" "$dsh"
    cat <<'WRAP'
unset CDPATH # a CDPATH must not change what `cd` resolves in the --repo checks
export DYNAMIC_SKILLS_HOME="$DSH" # pinned for every subcommand
orig=("$@")
sub="${1:-}"
refuse() {
  printf '%s %s refused: %s\n' "$(date +%s)" "${sub:-none}" "$1" >>"$LOG"
  echo "dynamic-skills (live smoke guard, R41): refused: $1" >&2
  exit 2
}
rp() { ( cd "$1" 2>/dev/null && pwd -P ); }
inside() {
  local r
  r="$(rp "$1")" || return 1
  [[ -n "$r" && ( "$r" == "$REPO_REAL" || "$r" == "$REPO_REAL"/* ) ]]
}
case "$sub" in
  init | save)
    shift
    dry=0
    while [[ $# -gt 0 ]]; do
      a="$1"; shift
      name=""; val=""
      case "$a" in
        --) refuse "-- is not allowed" ;;
        --dry-run) [[ "$dry" == "0" ]] || refuse "repeated --dry-run"; dry=1; continue ;;
        --*=*) name="${a%%=*}"; val="${a#*=}" ;;
        --*) name="$a"; [[ $# -gt 0 ]] || refuse "$a needs a value"; val="$1"; shift ;;
        *) refuse "unexpected argument" ;;
      esac
      case "$sub:$name" in
        save:--session | save:--scope | save:--harness | init:--harness | init:--scope | init:--repo) ;;
        *) refuse "unknown option $name for $sub" ;;
      esac
      [[ -n "$val" && "$val" != -* ]] || refuse "bad value for $name"
      case "$name" in
        --session) [[ -z "${o_session+x}" ]] || refuse "repeated $name"; o_session="$val" ;;
        --scope) [[ -z "${o_scope+x}" ]] || refuse "repeated $name"; o_scope="$val" ;;
        --harness) [[ -z "${o_harness+x}" ]] || refuse "repeated $name"; o_harness="$val" ;;
        --repo) [[ -z "${o_repo+x}" ]] || refuse "repeated $name"; o_repo="$val" ;;
      esac
    done
    if [[ "$sub" == "init" ]]; then
      [[ "$dry" == "1" ]] || refuse "init is allowed only with --dry-run"
      [[ -z "${o_repo+x}" ]] || inside "$o_repo" || refuse "--repo is outside the workspace repo"
    else
      case "${o_scope:-}" in project | ephemeral | discard) ;; *) refuse "save needs --scope project, ephemeral or discard" ;; esac
      if [[ -n "${o_harness+x}" ]]; then
        set_h="$(printf '%s\n' "${o_harness//,/ }" | tr ' ' '\n' | sed 's/^claude$/claude-code/' | LC_ALL=C sort -u | tr '\n' ' ')"
        [[ "$set_h" == "$HARNESS " ]] || refuse "save --harness must be exactly $HARNESS"
      fi
      sid="${o_session:-}"
      [[ "$sid" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || refuse "save needs a valid --session"
      sfile="${DYNAMIC_SKILLS_HOME:-/nonexistent}/sessions/$sid/session.json"
      [[ -f "$sfile" ]] || refuse "session $sid not found"
      srepo="$("$NODE" -e 'try { const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).repo; if (typeof r === "string") console.log(r); } catch { }' "$sfile")"
      [[ -n "$srepo" ]] && inside "$srepo" || refuse "the session repo is not the workspace repo"
    fi
    mkdir -p "$JAIL/home" "$JAIL/claude" "$JAIL/codex" "$JAIL/xdg" "$JAIL/opencode" "$JAIL/etc"
    export HOME="$JAIL/home" CLAUDE_CONFIG_DIR="$JAIL/claude" CODEX_HOME="$JAIL/codex" \
      XDG_CONFIG_HOME="$JAIL/xdg" OPENCODE_CONFIG_DIR="$JAIL/opencode" DYNAMIC_SKILLS_ETC_DIR="$JAIL/etc"
    ;;
  *)
    prev=""
    for a in "$@"; do
      if [[ "$prev" == "--repo" ]]; then
        inside "$a" || refuse "--repo is outside the workspace repo"
        prev=""
      fi
      case "$a" in
        --repo) prev="--repo" ;;
        --repo=*) inside "${a#--repo=}" || refuse "--repo is outside the workspace repo" ;;
      esac
    done
    ;;
esac
printf '%s %s allowed\n' "$(date +%s)" "${sub:-none}" >>"$LOG"
WRAP
    echo 'exec "$NODE" "$CLI" ${orig[@]+"${orig[@]}"}'
  } >"$out"
  chmod 555 "$out"
}

# cli_calls_report: how many agent calls reached the workspace wrapper (it always logs); zero with
# a session means shadowing. Called right after the main run, so the count is the main run's.
cli_calls_report() {
  local n=0 session
  if [[ -f "$CALLS_LOG" ]]; then n="$(wc -l <"$CALLS_LOG" | tr -d ' ')"; fi
  session="$(newest_session)"
  echo
  echo "Workspace dynamic-skills calls by the agent (all logged by the wrapper): $n"
  if [[ "$n" == "0" && -n "$session" ]]; then
    echo "SHADOWED: a session exists but the workspace build was never called by the agent; another dynamic-skills ran (R19)."
  fi
}

# jail_report LABEL: init and save run with every home and config root pointed into $JAIL, so
# anything written there is evidence that the agent attempted a personal-scope write.
jail_report() {
  local label="$1" files
  files="$(snapshot_roots "$JAIL" | sed 's/^[^ ]*  //' | tr '\n' ' ')"
  if [[ -z "${files// /}" ]]; then
    echo "JAIL ($label): clean (no personal-scope write was attempted through init or save)"
  else
    echo "JAIL ($label): the agent attempted a personal write, caught in the jail: $files"
  fi
}

# probe_save_ok: true when the newest session's repo is the workspace repo, so a project-scope save
# can only write there (the wrapper enforces the same). Probes that save skip otherwise.
probe_save_ok() {
  local s r real
  s="$(newest_session)"
  [[ -n "$s" ]] || return 1
  r="$(json_field "$DYNAMIC_SKILLS_HOME/sessions/$s/session.json" repo)"
  [[ -n "$r" ]] || return 1
  real="$(cd "$r" 2>/dev/null && pwd -P)" || return 1
  [[ "$real" == "$REPO_REAL" ]]
}

# smoke_cleanup: opt-in keep (SMOKE_KEEP=<absolute dir>), then remove the workspace. Runs from the
# EXIT trap, so the copy happens even when the run fails midway. Idempotent.
smoke_cleanup() {
  [[ -n "${TMP:-}" && -d "$TMP" ]] || return 0
  if [[ -n "${SMOKE_KEEP:-}" ]]; then
    if [[ "$SMOKE_KEEP" == /* ]]; then
      mkdir -p "$SMOKE_KEEP/out" "$SMOKE_KEEP/sessions"
      cp -R "$TMP/out/." "$SMOKE_KEEP/out/" 2>/dev/null || true
      cp -R "${DYNAMIC_SKILLS_HOME:-$TMP/sessions-home}/." "$SMOKE_KEEP/sessions/" 2>/dev/null || true
      echo "Kept the run output and session files in $SMOKE_KEEP (agent output may contain anything the agent printed)." >&2
    else
      echo "SMOKE_KEEP must be an absolute path; nothing kept." >&2
    fi
  fi
  chmod -R u+w "$TMP" 2>/dev/null || true # the wrapper dir is read-only
  rm -rf "$TMP"
}

# check_no_global_install: a global dynamic-skills on PATH could shadow the wrapper and so bypass
# the guard and the jail; abort unless SMOKE_ALLOW_GLOBAL=1.
check_no_global_install() {
  local found
  found="$(type -Pa dynamic-skills 2>/dev/null || true)"
  [[ -n "$found" ]] || return 0
  if [[ "${SMOKE_ALLOW_GLOBAL:-}" == "1" ]]; then
    echo "WARNING: a global dynamic-skills is installed (SMOKE_ALLOW_GLOBAL=1): it can bypass the guard and the jail:" >&2
    echo "$found" >&2
    return 0
  fi
  echo "ABORT: a dynamic-skills is already installed on PATH and could shadow the workspace wrapper, bypassing the guard and the jail:" >&2
  echo "$found" >&2
  echo "Uninstall it or run with SMOKE_ALLOW_GLOBAL=1 to accept the risk." >&2
  return 1
}

# jail_note: printed with the checklist.
jail_note() {
  echo "  NOTE: init and save run with HOME and the config roots jailed, so save's machine-path and personal-name-collision checks run against the jail. A real run can give SAVE_CONFLICT where this smoke run did not."
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
  trap smoke_cleanup EXIT

  REPO="$TMP/repo"
  BIN="$TMP/bin"
  mkdir -p "$BIN" "$TMP/out" "$TMP/etc" "$TMP/sessions-home"
  export DYNAMIC_SKILLS_HOME="$TMP/sessions-home"
  export DYNAMIC_SKILLS_ETC_DIR="$TMP/etc"
  cp -R "$ROOT/fixtures/repos/ts-monorepo" "$REPO"
  # In the temp copy only (never the fixture, which the discovery tests use): drop the README line
  # that says this is a fixture, so the agent sees a plain repo. The planted injection stays.
  if [[ -f "$REPO/README.md" ]]; then
    grep -v '^Fixture repository for discovery tests\.$' "$REPO/README.md" >"$REPO/README.md.new" || true
    mv "$REPO/README.md.new" "$REPO/README.md"
  fi
  git -C "$REPO" init -q

  # The real OpenCode global skills dir, computed before any override of the config dir.
  OPENCODE_GLOBAL_CONFIG="${XDG_CONFIG_HOME:-$REAL_HOME/.config}/opencode"
  OPENCODE_GLOBAL_SKILLS="$OPENCODE_GLOBAL_CONFIG/skills"
  CODEX_HOME_REAL="${CODEX_HOME:-$REAL_HOME/.codex}"

  TMP_REAL="$TMP"
  REPO_REAL="$REPO"
  DSH_REAL="$DYNAMIC_SKILLS_HOME"
  # The bare dynamic-skills is a guarding, logging, jailing wrapper (R41, R19); the bin dir and the
  # wrapper are made read-only so the agent cannot rewrite them (the agent has no grant on them).
  CALLS_LOG="$TMP/out/cli-calls.log"
  JAIL="$TMP/jail"
  mkdir -p "$JAIL"
  make_wrapper "$BIN/dynamic-skills" "$(command -v node)" "$CLI" "$CALLS_LOG" "$HARNESS_ID" "$JAIL" "$REPO_REAL" "$DSH_REAL"
  chmod a-w "$BIN"
  check_no_global_install
  export PATH="$BIN:$PATH"
  TIMEOUT_CMD=()
  if [[ "${SMOKE_TIMEOUT_SECS:-600}" != "0" ]]; then
    if command -v timeout >/dev/null 2>&1; then
      TIMEOUT_CMD=(timeout "${SMOKE_TIMEOUT_SECS:-600}")
    elif command -v gtimeout >/dev/null 2>&1; then
      TIMEOUT_CMD=(gtimeout "${SMOKE_TIMEOUT_SECS:-600}")
    else
      echo "WARNING: neither timeout nor gtimeout found; a hung harness run will not be stopped." >&2
    fi
  fi
  [[ "$(type -P dynamic-skills)" == "$BIN/dynamic-skills" ]] \
    || die "The linked dynamic-skills is not first on PATH."

  echo "Workspace: $TMP (removed on exit)"
  echo "Repo: $REPO   Session home: $DYNAMIC_SKILLS_HOME   Etc dir: $DYNAMIC_SKILLS_ETC_DIR"
}

# show_main_output FILE: the agent's reply for the human. A harness can define harness_reply FILE
# (print the readable reply, return non-zero when it cannot); the default is the last 60 lines.
show_main_output() {
  if declare -F harness_reply >/dev/null && harness_reply "$1"; then return 0; fi
  tail -n 60 "$1" 2>/dev/null || true
}

# smoke_main HARNESS_ID HARNESS_BIN MODE: the common flow.
smoke_main() {
  HARNESS_ID="$1"
  HARNESS_BIN="$2"
  local mode="$3" prompt secs t0
  smoke_setup
  harness_version_check

  real_skill_roots
  if [[ -n "${CLAUDE_CONFIG_DIR:-}" && "$CLAUDE_CONFIG_DIR" != /* ]]; then
    echo "WARNING: CLAUDE_CONFIG_DIR is not an absolute path; AC 28 does not watch its skills dir." >&2
  fi
  SNAP_REAL_BEFORE="$(snapshot_roots "${REAL_ROOTS[@]}")"

  note "init ($HARNESS_ID)"
  harness_install
  repo_skill_roots
  SNAP_REPO_BEFORE="$(snapshot_roots "${REPO_ROOTS[@]}")"

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
  show_main_output "$TMP/out/main.txt"
  echo
  note "denial evidence from the main run's structured output"
  harness_evidence "$TMP/out/main.txt"
  if [[ -s "$TMP/out/main.stderr.txt" ]]; then
    echo
    note "agent stderr (last 20 lines; the reason for a failed run is usually here)"
    tail -n 20 "$TMP/out/main.stderr.txt" || true
  fi
  print_timing "$secs"
  print_reports
  cli_calls_report
  jail_report "main run"
  echo
  echo "AC 28 note: Claude Code's own skills/synced/ subtree under the Claude config dir is ignored (it syncs claude.ai skills itself)."
  ac28_check "AC 28"

  if [[ "${SMOKE_SKIP_PROBES:-}" != "1" ]]; then
    harness_probes
  fi
  echo
  ac28_check "AC 28 (after probes)" real
  jail_report "after probes"
  echo
  r31_check
  echo
  note "checklist for the human"
  harness_checklist
  jail_note
  echo
  echo "Re-run with SMOKE_SKIP_PROBES=1 to skip the extra probes (D6, R32/R35, compound, alias)."
}
