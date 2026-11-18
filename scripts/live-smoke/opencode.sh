#!/usr/bin/env bash
# Live smoke test of OpenCode (Phase 1 gate item 7; Phase 2 gate item 12).
# Usage (via the dispatcher): scripts/live-smoke.sh opencode [autonomous|explicit]
# Run by hand after `pnpm build`; never in CI. OPENCODE_CONFIG_DIR points at a temp directory, so
# the personal-scope init never touches the real OpenCode config; project scope goes to the temp
# repo. Provider credentials live under the real data dir and are not read by this script. The
# temp config also denies edit on the real permanent skill roots (via an inline config, so init's
# own config file stays untouched).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MODE="${1:-autonomous}"
VARIANT="v1"

harness_version_check() {
  version_check "OpenCode" opencode 1.19.5 2.3.0
  case "$HARNESS_VERSION" in
    2.*) VARIANT="v2" ;;
    *) VARIANT="v1" ;;
  esac
  echo "OpenCode variant: $VARIANT"
}

harness_install() {
  export OPENCODE_CONFIG_DIR="$TMP/opencode-config"
  mkdir -p "$OPENCODE_CONFIG_DIR"
  dynamic-skills init --harness opencode --scope personal
  dynamic-skills init --harness opencode --scope project --repo "$REPO"
  # Deny edit on the real permanent skill roots, as an inline config merged over the temp one.
  OPENCODE_CONFIG_CONTENT="$(node -e '
    const [a, b, c, d] = process.argv.slice(1);
    const edit = {};
    for (const root of [a + "/.claude", b + "/.agents", c, d + "/.claude/skills"]) edit[root + "/*"] = "deny";
    console.log(JSON.stringify({ permission: { edit } }));
  ' "$REAL_HOME" "$REAL_HOME" "$OPENCODE_GLOBAL_SKILLS" "$REPO")"
  export OPENCODE_CONFIG_CONTENT
}

# Explicit invocation: @name on 2.x, /name on 1.x.
harness_prompt() {
  if [[ "$1" == "explicit" ]]; then
    if [[ "$VARIANT" == "v2" ]]; then
      echo "@dynamic-skill-bootstrap $TASK"
    else
      echo "/dynamic-skill-bootstrap $TASK"
    fi
  else
    echo "$TASK"
  fi
}

harness_run() {
  local prompt="$1" out="$2"
  (cd "$REPO" && opencode run "$prompt") >"$out" 2>&1
}

harness_probes() {
  local s
  s="$(probe_session)"
  echo
  echo "Probe expectations (opencode run rejects every pending ask):"
  echo "  plain save = asked, so rejected (D6); quoted and double-spaced save = NOT asked and run (R35, documented limit)."
  probe d6-plain "Run exactly this command and report verbatim whether it ran or was rejected for permission: dynamic-skills save --session $s --scope project --harness opencode"
  probe r35-quoted "Run exactly this command, keeping the quotes, and report verbatim whether it ran or was rejected for permission: dynamic-skills 'save' --session $s --scope project --harness opencode"
  probe r35-spaced "Run exactly this command, keeping the two spaces after dynamic-skills, and report verbatim whether it ran or was rejected for permission: dynamic-skills  save --session $s --scope project --harness opencode"
}

harness_checklist() {
  cat <<CHECK
  [ ] Question tool: cancelled (v2) or denied (v1) in the main run? (matches below)
  [ ] Background subagent wait: did the run wait for the analyst; see discovery.json agenticMs above
  [ ] Was the temp-config bootstrap skill and command listed (init personal + project)?
  [ ] R35: quoted and double-spaced 'save' bypassed the ask (probes r35-quoted, r35-spaced) while the plain call was asked (d6-plain)
  [ ] D6: the consent prompt for save/init appeared (d6-plain)
  [ ] Phase 1 gate item 7: AC 3 autonomous invocation, live AC 8, the 60 s Timing line, AC 24 and AC 28 above
  [ ] R31: '-V save' refused (R31 lines above)
CHECK
  scan "$TMP/out/main.txt" "Question tool lines" 'question|cancel|assumption'
  scan "$TMP/out/main.txt" "Subagent lines" 'subagent|background|analyst|task'
}

smoke_main opencode opencode "$MODE"
