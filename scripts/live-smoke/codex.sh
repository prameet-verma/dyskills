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
# repo, so it is added as a writable root; whether that key is honoured is recorded below. Probes
# use --json (JSONL events). There is no per-command deny flag in exec, so the grants are the
# sandbox itself (writes confined to the repo and the session home).
# Arguments after `codex exec`. --ignore-rules (spike section 6) drops the user's real rules, so a
# broad allow in ~/.codex/rules cannot run the CLI outside the sandbox: the sandbox alone governs.
# Consequence: D6 consent rules are ignored too, so exec cannot test them.
codex_args() {
  local kind="${1:-main}"
  printf '%s\n' --sandbox workspace-write --ignore-rules -c approval_policy=never \
    -c "sandbox_workspace_write.writable_roots=[\"$DSH_REAL\"]"
  [[ "$kind" == "main" ]] || echo "--json"
}

harness_run() {
  local prompt="$1" out="$2" kind="${3:-main}" a
  local args=()
  while IFS= read -r a; do args+=("$a"); done < <(codex_args "$kind")
  (cd "$REPO" && ${TIMEOUT_CMD[@]+"${TIMEOUT_CMD[@]}"} codex exec "${args[@]}" "$prompt") >"$out" 2>&1
}

# JSONL events: print the command-execution events that mention the CLI, trimmed. Event field names
# (item.command, status, exit_code, aggregated_output) are unverified against 0.169.0.
harness_evidence() {
  node -e '
    const fs = require("node:fs");
    let n = 0;
    for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      if (!line.includes("dynamic-skills")) continue;
      try {
        const e = JSON.parse(line); const it = e.item || {};
        console.log(String(e.type) + " " + String(it.type || "") + " status=" + String(it.status) + " exit=" + String(it.exit_code) + " " + String(it.command || "").slice(0, 160) + " | " + String(it.aggregated_output || "").slice(0, 200).replace(/\n/g, " "));
      } catch { console.log(line.slice(0, 300)); }
      if (++n >= 8) break;
    }
    if (n === 0) console.log("(no event mentions dynamic-skills)");
  ' "$1"
}

harness_probes() {
  local s
  s="$(probe_session)"
  echo
  echo "NOTE: the temp repo is UNTRUSTED. Codex does not load project config layers for it, so"
  echo "<repo>/.codex/rules, the analyst agent and the D6 consent rule are probably NOT loaded here,"
  echo "and the project skill may not be listed either. The D6 probes below therefore cannot show"
  echo "the consent rule; they show only what the sandbox does. Trusting the repo needs the real"
  echo "config.toml, which this script will not touch."
  echo "Probe expectations: r32-save = SUCCEEDED or SANDBOX WRITE ERROR (exec cannot show escalation)."
  if probe_save_ok; then
    probe r32-save "Run exactly this command and report verbatim whether it succeeded or failed on a sandbox write error: dynamic-skills save --session $s --scope project --harness codex"
  else
    echo "(probe r32-save skipped: no session whose repo is the workspace repo)"
  fi
  probe d6-init "Run exactly this command and report verbatim whether it ran or was rejected: dynamic-skills init --harness codex --scope project --repo $REPO --dry-run"
}

harness_checklist() {
  cat <<CHECK
  [ ] Was the project skill listed (trust gating, synthesis risk 12)? The repo is untrusted: expect NOT loaded. Did the main run mention dynamic-skill-bootstrap?
  [ ] Did the analyst agent (dynamic-skills-context-analyst) run? (it lives in the untrusted .codex/agents: probably not loaded)
  [ ] Did sessions appear under the temp home (DYNAMIC_SKILLS_HOME reached the sandbox, writable_roots honoured)?
  [ ] R32 (exec only): save from inside the sandbox: SUCCEEDED / SANDBOX WRITE ERROR (probe r32-save evidence). Escalation cannot show in exec: do the manual procedure below.
  [ ] D6: NOT testable under exec (--ignore-rules drops the consent rules and the repo is untrusted): record it as untested here; test it in the manual TUI procedure
  [ ] Questions headless: how were they handled (assumptions.json above)? Followed the bootstrap end to end?
  [ ] Phase 1 gate item 7: AC 3 autonomous invocation, live AC 8, the 150 s Timing line, AC 24 and AC 28 above
  [ ] R31: '-V save' refused (R31 lines above)

  Layers for an absolute 'node .../dist/index.js' call that bypasses the wrapper: Codex runs it inside the workspace-write sandbox (no deny rule applies, since --ignore-rules is set); the sandbox is the only layer there. the agent can write cli-calls.log: \$TMP is under \$TMPDIR, which the workspace-write sandbox can write, so treat the call count and SHADOWED as agent-writable evidence and trust the jail report and AC 28 more.

  MANUAL R32 procedure (by hand, interactive):
    1. Decide whether to trust a copy of the repo: trusting it writes to your REAL ~/.codex/config.toml.
    2. In a trusted copy of the repo, with the project rules in place (dynamic-skills init --harness codex
       --scope project --repo <copy>), start the interactive Codex TUI: codex -a on-request
       --sandbox workspace-write   (the -a on-request flag is UNVERIFIED against 0.169.0: check codex --help first)
    3. Ask it to run: dynamic-skills save --session <id> --scope project --harness codex
    4. Approve the prompt and record: did it run sandboxed and fail to write, run with escalation and succeed,
       or need a terminal run? (Ruling R32: an approved prompt keeps the sandboxed permissions.)
CHECK
  scan "$TMP/out/main.txt" "Skill / analyst lines" 'dynamic-skill-bootstrap|context-analyst'
  scan "$TMP/out/main.txt" "Sandbox or approval lines" 'sandbox|approval|rejected|escalat|read-only|permission denied'
  scan "$TMP/out/main.txt" "Trust lines" 'untrusted|not trusted|trust'
  local rules
  rules="$(grep -l 'dynamic-skills' "$CODEX_HOME_REAL"/rules/* 2>/dev/null || true)"
  echo "Real Codex rules files mentioning dynamic-skills (names only): ${rules:-none}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  smoke_main codex codex "$MODE"
fi
