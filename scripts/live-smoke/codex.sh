#!/usr/bin/env bash
# Live smoke test of Codex (Phase 1 gate item 7; Phase 2 gate item 12).
# Usage (via the dispatcher): scripts/live-smoke.sh codex [autonomous|explicit]
# Run by hand after `pnpm build`; never in CI. Project-scope init in a temp repo only: the real
# CODEX_HOME (auth, config.toml, rules) is neither written nor read by this script. Consequence:
# the temp repo is an untrusted project, so Codex may not load its project skill, agent or rules
# (trust gating, synthesis risk 12); the checklist asks the human to record that.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MODE="${1:-autonomous}"

harness_version_check() { version_check "Codex" codex 0.169.0; }

harness_install() {
  dynamic-skills init --harness codex --scope project --repo "$REPO"
}

harness_prompt() {
  if [[ "$1" == "explicit" ]]; then
    echo '$dynamic-skill-bootstrap '"$TASK"
  else
    echo "$TASK"
  fi
}

# workspace-write sandbox, approvals never (exec mode cannot ask). The session home is outside the
# repo, so it is added as a writable root; whether that key is honoured is itself recorded below.
harness_run() {
  local prompt="$1" out="$2"
  (cd "$REPO" && codex exec --sandbox workspace-write -c approval_policy=never \
    -c "sandbox_workspace_write.writable_roots=[\"$DYNAMIC_SKILLS_HOME\"]" "$prompt") >"$out" 2>&1
}

harness_probes() {
  local s
  s="$(probe_session)"
  echo
  echo "Probe expectations: D6 = the save/init call is held for a prompt (rejected in exec mode);"
  echo "R32 = whether 'save' from inside the sandbox succeeds, needs escalation, or needs a terminal run."
  probe r32-save "Run exactly this command and report verbatim whether it succeeded, was rejected for approval, or failed on a sandbox write error: dynamic-skills save --session $s --scope project --harness codex"
  probe d6-init "Run exactly this command and report verbatim whether it ran, was held for approval, or was rejected: dynamic-skills init --harness codex --scope project --repo $REPO --dry-run"
}

harness_checklist() {
  cat <<CHECK
  [ ] Was the project skill listed (trust gating, synthesis risk 12)? Did the main run mention dynamic-skill-bootstrap?
  [ ] Did the analyst agent (dynamic-skills-context-analyst) run?
  [ ] Did sessions appear under the temp home (DYNAMIC_SKILLS_HOME reached the sandbox, writable_roots honoured)?
  [ ] R32: save from inside the sandbox: SUCCEEDED / NEEDED ESCALATION / NEEDS A TERMINAL RUN (probe r32-save)
  [ ] D6: the consent prompt for save/init appeared (probes r32-save, d6-init; exec mode may reject it outright)
  [ ] Phase 1 gate item 7: AC 3 autonomous invocation, live AC 8, the 60 s Timing line, AC 24 and AC 28 above
  [ ] R31: '-V save' refused (R31 lines above)
CHECK
  scan "$TMP/out/main.txt" "Skill / analyst lines" 'dynamic-skill-bootstrap|context-analyst'
  scan "$TMP/out/main.txt" "Sandbox or approval lines" 'sandbox|approval|rejected|escalat|read-only|permission denied'
}

smoke_main codex codex "$MODE"
