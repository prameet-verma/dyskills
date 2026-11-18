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
  case "${HARNESS_VERSION%%.*}" in
    2) VARIANT="v2" ;;
    *) VARIANT="v1" ;;
  esac
  echo "OpenCode variant: $VARIANT"
}

# Inline config merged over the temp one: edit denies on the real permanent roots and, for the main
# run (kind main), bash denies on dynamic-skills init and save (Ruling R40). The same keys as init's
# ask entries, so the deny replaces the ask for that run only; probes keep init's ask entries.
oc_content() {
  node -e '
    const [kind, home, ocConfig, codexHome, repo] = process.argv.slice(1);
    const edit = {};
    for (const root of [home + "/.claude/*", home + "/.agents/*", ocConfig + "/*", codexHome + "/*", repo + "/.opencode/skills/*", repo + "/.agents/skills/*", repo + "/.claude/skills/*"]) edit[root] = "deny";
    const permission = { edit };
    if (kind === "main") permission.bash = { "dynamic-skills init *": "deny", "dynamic-skills save *": "deny" };
    console.log(JSON.stringify({ permission }));
  ' "$1" "$REAL_HOME" "$OPENCODE_GLOBAL_CONFIG" "$CODEX_HOME_REAL" "$REPO"
}

harness_install() {
  export OPENCODE_CONFIG_DIR="$TMP/opencode-config"
  mkdir -p "$OPENCODE_CONFIG_DIR"
  # OpenCode allows shell by default: seed a default-ask so only init's entries (which come after
  # this and win, last match) allow the CLI.
  echo '{"permission":{"bash":{"*":"ask"}}}' >"$OPENCODE_CONFIG_DIR/opencode.jsonc"
  dynamic-skills init --harness opencode --scope personal
  dynamic-skills init --harness opencode --scope project --repo "$REPO"
  # A read-only print of the resolved config, if this OpenCode has one (`debug config` is not in
  # the spike: unverified; failure is ignored).
  echo "-- resolved OpenCode config (opencode debug config; may be unavailable) --"
  (cd "$REPO" && opencode debug config 2>&1 | head -n 60) || echo "(unavailable)"
}

# Explicit invocation. v1: the skill is registered as a slash command, run with
# `opencode run --command dynamic-skill-bootstrap "<task>"` (the prompt is then just the task).
# v2: the prompt text starts with @dynamic-skill-bootstrap; that `run` parses a leading @name is NOT
# verified (the spike documents /dynamic-skill-bootstrap only for v1), so the checklist asks the
# human to confirm the skill was actually loaded and not read as plain text.
harness_prompt() {
  if [[ "$1" == "explicit" && "$VARIANT" == "v2" ]]; then
    echo "@dynamic-skill-bootstrap $TASK"
  else
    echo "$TASK"
  fi
}

harness_run() {
  local prompt="$1" out="$2" kind="${3:-main}" extra=()
  [[ "$kind" == "main" ]] || extra+=(--format json)
  if [[ "$kind" == "main" && "$MODE" == "explicit" && "$VARIANT" == "v1" ]]; then
    extra+=(--command dynamic-skill-bootstrap)
  fi
  OPENCODE_CONFIG_CONTENT="$(oc_content "$kind")"
  export OPENCODE_CONFIG_CONTENT
  (cd "$REPO" && ${TIMEOUT_CMD[@]+"${TIMEOUT_CMD[@]}"} opencode run ${extra[@]+"${extra[@]}"} "$prompt") >"$out" 2>&1
}

# --format json emits JSONL events; print those that mention the CLI with their state (field names
# unverified).
harness_evidence() {
  { grep -i 'dynamic-skills' "$1" 2>/dev/null | grep -i -E 'status|error|denied|reject|permission|output' | cut -c1-400 | head -n 8; } || true
  echo "(JSONL event field names are unverified against the pinned versions)"
}

harness_probes() {
  local s
  s="$(probe_session)"
  echo
  echo "Probe expectations (opencode run rejects every pending ask; no prompt can appear headless):"
  echo "  d6-plain / d6-init = rejected by the ask entries; quoted and double-spaced save = NOT asked and run (R35, documented limit)."
  probe d6-plain "Run exactly this command and report verbatim whether it ran or was rejected for permission: dynamic-skills save --session $s --scope project --harness opencode"
  probe d6-init "Run exactly this command and report verbatim whether it ran or was rejected for permission: dynamic-skills init --harness opencode --scope project --repo $REPO --dry-run"
  probe r35-quoted "Run exactly this command, keeping the quotes, and report verbatim whether it ran or was rejected for permission: dynamic-skills 'save' --session $s --scope project --harness opencode"
  probe r35-spaced "Run exactly this command, keeping the two spaces after dynamic-skills, and report verbatim whether it ran or was rejected for permission: dynamic-skills  save --session $s --scope project --harness opencode"
}

harness_checklist() {
  cat <<CHECK
  [ ] Question tool: cancelled (v2) or denied (v1) in the main run? (matches below)
  [ ] Questions headless: how were they handled (assumptions.json above)? Followed the bootstrap end to end?
  [ ] Background subagent wait: did the run wait for the analyst; see discovery.json agenticMs above
  [ ] Was the temp-config bootstrap skill and command listed (init personal + project)?
  [ ] Explicit mode: v1 --command ran the skill; v2 '@dynamic-skill-bootstrap' was parsed as a skill/agent mention and not plain text
  [ ] R35: quoted and double-spaced 'save' bypassed the ask (probes r35-quoted, r35-spaced) while the plain call was rejected (d6-plain)
  [ ] D6: consent rule enforced: plain save and init were rejected (a prompt cannot appear headless)
  [ ] Phase 1 gate item 7: AC 3 autonomous invocation, live AC 8, the 60 s Timing line, AC 24 and AC 28 above
  [ ] R31: '-V save' refused (R31 lines above)
CHECK
  scan "$TMP/out/main.txt" "Question tool lines" 'question|cancel|assumption'
  scan "$TMP/out/main.txt" "Subagent lines" 'subagent|background|analyst|task'
}

smoke_main opencode opencode "$MODE"
