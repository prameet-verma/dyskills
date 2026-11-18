#!/usr/bin/env bash
# Live smoke test of Claude Code (Phase 1 gate item 7; Phase 2 gate item 12).
# Usage (via the dispatcher): scripts/live-smoke.sh claude-code [autonomous|explicit] [--native]
# Run by hand after `pnpm build`; never in CI. Project-scope init in a temp repo only: the real
# ~/.claude is neither written nor (for settings or credentials) read by this script.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MODE="${1:-autonomous}"
NATIVE="${2:-0}"

harness_version_check() { version_check "Claude Code" claude 2.1.325; }

harness_install() {
  if [[ "$NATIVE" == "1" ]]; then
    dynamic-skills init --harness claude-code --scope project --repo "$REPO" --native
  else
    dynamic-skills init --harness claude-code --scope project --repo "$REPO"
  fi
}

harness_prompt() {
  if [[ "$1" == "explicit" ]]; then
    echo "/dynamic-skill-bootstrap $TASK"
  else
    echo "$TASK"
  fi
}

# Permanent roots the agent must not edit or write (the follow-up deny rules). The //<path> form is
# an absolute path, so each variable is used without its leading slash.
harness_run() {
  local prompt="$1" out="$2" args deny=()
  deny=(
    "Edit(//${REAL_HOME#/}/.claude/**)" "Write(//${REAL_HOME#/}/.claude/**)"
    "Edit(//${REAL_HOME#/}/.agents/**)" "Write(//${REAL_HOME#/}/.agents/**)"
    "Edit(//${OPENCODE_GLOBAL_SKILLS#/}/**)" "Write(//${OPENCODE_GLOBAL_SKILLS#/}/**)"
    "Edit(//${REPO#/}/.claude/skills/**)" "Write(//${REPO#/}/.claude/skills/**)"
  )
  # Print mode needs the grants: the bare CLI only, file tools, and write access to the session home
  # (outside the cwd). With --native the native placement directory is added too.
  args=(--allowedTools "Bash(dynamic-skills *)" Read Write Edit Glob Grep --add-dir "$DYNAMIC_SKILLS_HOME")
  if [[ "$NATIVE" == "1" ]]; then
    mkdir -p "$DYNAMIC_SKILLS_HOME/native/claude-code"
    args+=(--add-dir "$DYNAMIC_SKILLS_HOME/native/claude-code")
  fi
  args+=(--disallowedTools "${deny[@]}")
  (cd "$REPO" && claude -p "$prompt" "${args[@]}") >"$out" 2>&1
}

harness_probes() {
  local s alias=""
  s="$(probe_session)"
  echo
  echo "Probe expectations: D6 = the save call is asked (denied in print mode, since nobody can answer);"
  echo "compound = allowed by Bash(dynamic-skills *); alias = shows whether /var vs /private/var matters."
  probe d6-save "Run exactly this command and report verbatim what happened, including any permission prompt or denial: dynamic-skills save --session $s --scope project --harness claude-code"
  probe compound "Run exactly this single compound command and report verbatim whether it ran or was denied: cd \"$REPO\" && dynamic-skills report perf"
  if [[ "$DYNAMIC_SKILLS_HOME" == /private/* ]]; then
    alias="${DYNAMIC_SKILLS_HOME#/private}"
    echo "alias-probe" >"$DYNAMIC_SKILLS_HOME/alias-probe.txt"
    probe var-alias "Read the file $alias/alias-probe.txt and report verbatim whether the read was allowed or denied: it is the same file as /private$alias/alias-probe.txt"
  else
    echo "(var-alias probe skipped: the temp dir is not under /private, so there is no /var alias)"
  fi
}

harness_checklist() {
  cat <<CHECK
  [ ] Print-mode grants needed: were any tool calls denied in the main run? (see the matches below)
  [ ] Compound 'cd ... && dynamic-skills ...' calls: allowed or denied? (probe: compound)
  [ ] /var vs /private/var: any denial citing a path? (matches below; probe: var-alias)
  [ ] D6: the 'dynamic-skills save' / 'init' consent prompt appeared (probe: d6-save shows the ask or denial)
  [ ] Phase 1 gate item 7: AC 3 autonomous invocation (did the skill start without being named; run both modes)
  [ ] Live AC 8 and the 60 s timing (Timing line above); AC 24 and AC 28 lines above
  [ ] R31: '-V save' refused (R31 lines above)
CHECK
  if [[ "$NATIVE" == "1" ]]; then
    echo "  [ ] --native: did the agent list the placed skill from $DYNAMIC_SKILLS_HOME/native/claude-code (see output)?"
  fi
  scan "$TMP/out/main.txt" "Denied or permission lines" 'denied|permission|not allowed|requires approval'
  scan "$TMP/out/main.txt" "/private/var or /var path lines" '/private/var|/var/'
  scan "$TMP/out/main.txt" "Compound-command lines" 'cd .*&&.*dynamic-skills'
}

smoke_main claude-code claude "$MODE"
