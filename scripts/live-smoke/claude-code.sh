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

# Narrowest grants (Ruling R40). File tools are scoped to the realpath of the temp workspace
# (TMP_REAL, no leading slash because //<path> is the absolute form). `dynamic-skills init` and
# `save` are denied by command line in every run except the consent probe, because the temp repo is
# untrusted and Claude Code may then ignore the project settings.json ask rules, in which case the
# allowed Bash(dynamic-skills *) would let the agent write the REAL ~/.claude, ~/.codex or
# ~/.agents (init --harness codex, save --scope personal). Real config roots are denied too.
harness_run() {
  local prompt="$1" out="$2" kind="${3:-main}" scope args deny allow
  scope="//${TMP_REAL#/}/**"
  allow=("Bash(dynamic-skills *)" "Read($scope)" "Edit($scope)" "Write($scope)" Glob Grep)
  deny=(
    "Bash(dynamic-skills init)" "Bash(dynamic-skills init *)"
    "Edit(//${REAL_HOME#/}/.claude/**)" "Write(//${REAL_HOME#/}/.claude/**)"
    "Edit(//${REAL_HOME#/}/.agents/**)" "Write(//${REAL_HOME#/}/.agents/**)"
    "Edit(//${REAL_HOME#/}/.codex/**)" "Write(//${REAL_HOME#/}/.codex/**)"
    "Edit(//${OPENCODE_GLOBAL_SKILLS#/}/**)" "Write(//${OPENCODE_GLOBAL_SKILLS#/}/**)"
    "Edit(//${OPENCODE_GLOBAL_CONFIG#/}/**)" "Write(//${OPENCODE_GLOBAL_CONFIG#/}/**)"
    "Edit(//${REPO#/}/.claude/skills/**)" "Write(//${REPO#/}/.claude/skills/**)"
  )
  args=()
  if [[ "$kind" != "probe-consent" ]]; then
    deny+=("Bash(dynamic-skills save)" "Bash(dynamic-skills save *)")
  else
    # Load the project ask rules explicitly. `--settings <file>` is documented in the Claude Code
    # spike's flag list; whether it applies a file from an untrusted project, and how it merges
    # with the ask rules, is UNVERIFIED: if save runs instead of being denied, the consent rule
    # is not being enforced in this configuration, which is the finding. The save here is
    # --scope project in the temp repo, so it cannot write real config.
    args+=(--settings "$REPO/.claude/settings.json")
  fi
  [[ "$kind" == "main" ]] || args+=(--output-format json)
  # With --native the native placement directory is added too.
  args+=(--add-dir "$DYNAMIC_SKILLS_HOME")
  if [[ "$NATIVE" == "1" ]]; then
    mkdir -p "$DYNAMIC_SKILLS_HOME/native/claude-code"
    args+=(--add-dir "$DYNAMIC_SKILLS_HOME/native/claude-code")
  fi
  (cd "$REPO" && ${TIMEOUT_CMD[@]+"${TIMEOUT_CMD[@]}"} claude -p "$prompt" --allowedTools "${allow[@]}" "${args[@]}" --disallowedTools "${deny[@]}") >"$out" 2>&1
}

# The Claude Code result JSON lists refused tool calls in permission_denials (field name from
# Claude Code's headless output; unverified against 2.1.325).
harness_evidence() {
  node -e '
    const fs = require("node:fs");
    let doc;
    try { doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { console.log("(output is not one JSON document)"); process.exit(0); }
    const res = Array.isArray(doc) ? doc.find((d) => d && d.type === "result") : doc;
    const d = res && res.permission_denials;
    if (!Array.isArray(d)) { console.log("(no permission_denials field in the result)"); process.exit(0); }
    console.log("permission_denials: " + d.length);
    for (const x of d) console.log("  " + String(x.tool_name) + " " + JSON.stringify(x.tool_input || {}).slice(0, 200));
  ' "$1"
}

harness_probes() {
  local s alias=""
  s="$(probe_session)"
  echo
  echo "Probe expectations (no consent prompt can appear in print mode; a rule is enforced when the call is denied):"
  echo "  d6-save = denied by the ask rule loaded with --settings; d6-init = denied by the R40 command-line deny;"
  echo "  compound = allowed by Bash(dynamic-skills *); var-alias = whether the /var spelling of the session home is writable."
  probe d6-save "Run exactly this command and report verbatim what happened, including any denial: dynamic-skills save --session $s --scope project --harness claude-code" probe-consent
  probe d6-init "Run exactly this command and report verbatim what happened, including any denial: dynamic-skills init --harness claude-code --scope project --repo $REPO --dry-run"
  probe compound "Run exactly this single compound command and report verbatim whether it ran or was denied: cd \"$REPO\" && dynamic-skills report perf"
  if [[ "$DYNAMIC_SKILLS_HOME" == /private/* ]]; then
    alias="${DYNAMIC_SKILLS_HOME#/private}"
    probe var-alias "Write the text alias-probe to the file $alias/alias-write.txt (this is the /var spelling of $DYNAMIC_SKILLS_HOME) and report verbatim whether the write was allowed or denied"
    if [[ -f "$DYNAMIC_SKILLS_HOME/alias-write.txt" ]]; then
      echo "var-alias result: ALLOWED (the file exists in the session home)"
    else
      echo "var-alias result: DENIED or not attempted (no file in the session home)"
    fi
  else
    echo "(var-alias probe skipped: the temp dir is not under /private, so there is no /var alias)"
  fi
}

harness_checklist() {
  cat <<CHECK
  [ ] Print-mode grants needed: were any tool calls denied in the main run? (see the matches below)
  [ ] Compound 'cd ... && dynamic-skills ...' calls: allowed or denied? (probe: compound)
  [ ] /var vs /private/var: any denial citing a path? (matches below; probe: var-alias)
  [ ] D6: consent rule enforced: 'save' (d6-save) and 'init' (d6-init) were denied, per permission_denials above (a prompt cannot appear headless)
  [ ] Questions headless: how were they handled (recorded as assumptions.json above)?
  [ ] Followed the bootstrap end to end (assess, discover, evaluate, activate, then work)?
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
