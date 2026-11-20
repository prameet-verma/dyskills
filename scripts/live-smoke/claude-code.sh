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

harness_version_check() { version_check "Claude Code" claude 2.1.325 2.1.329; }

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

# Narrowest grants (Ruling R40, R41). Print, one per line, every argument after `claude -p <prompt>`
# for KIND main, probe or probe-consent (a function so the tests can assert the list).
# - Edit(path) rules cover every file-editing tool; Claude Code ignores Write(path) rules (and warns
#   on each run), so only Edit(path) is used.
# - File tools are granted only on the repo and the session home (realpaths, no leading slash
#   because //<path> is the absolute form), never on the whole temp workspace, which also holds the
#   wrapper, its read-only bin dir and the harness configs. Glob and Grep are not granted.
# - `dynamic-skills init` is denied in every kind. `save` is denied in main and probe. In
#   probe-consent only the exact save command is allowed (no broad Bash allow), and --settings loads
#   the repo ask rules: whether --settings applies a file from an untrusted project is UNVERIFIED.
#   d6-save still holds with --setting-sources project,local: that flag only drops USER settings
#   (plugins, user hooks); the ask rules come from the repo settings file, which --settings loads
#   explicitly (as a flag setting) and which is also a project source.
#   Pattern rules are only a first layer: the wrapper (R41) enforces init/save arguments.
claude_args() {
  local kind="${1:-main}" repo home
  real_skill_roots # sets CLAUDE_CFG_EXTRA (a CLAUDE_CONFIG_DIR that differs from ~/.claude, or empty)
  repo="//${REPO_REAL#/}/**"
  home="//${DSH_REAL#/}/**"
  local allow=("Read($repo)" "Edit($repo)" "Read($home)" "Edit($home)")
  local deny=(
    "Bash(dynamic-skills init)" "Bash(dynamic-skills init *)"
    "Edit(//${REPO_REAL#/}/.claude/settings*.json)"
    "Edit(//${REAL_HOME#/}/.claude/**)"
    "Edit(//${REAL_HOME#/}/.agents/**)"
    "Edit(//${CODEX_HOME_REAL#/}/**)"
    "Edit(//${OPENCODE_GLOBAL_SKILLS#/}/**)"
    "Edit(//${OPENCODE_GLOBAL_CONFIG#/}/**)"
    "Edit(//${REPO_REAL#/}/.claude/skills/**)"
  )
  # A CLAUDE_CONFIG_DIR other than ~/.claude is the real Claude config root: deny edits there too.
  if [[ -n "$CLAUDE_CFG_EXTRA" ]]; then
    deny+=("Edit(//${CLAUDE_CFG_EXTRA#/}/**)")
    local cfg_real
    cfg_real="$(cd "$CLAUDE_CFG_EXTRA" 2>/dev/null && pwd -P || true)"
    if [[ -n "$cfg_real" && "$cfg_real" != "$CLAUDE_CFG_EXTRA" ]]; then deny+=("Edit(//${cfg_real#/}/**)"); fi
  fi
  local extra=()
  # Plugin isolation: load project and local settings only (the project settings that `init`
  # wrote still load; the --settings, --allowedTools and --disallowedTools below still apply).
  # User settings are skipped on purpose, so the user's enabled plugins and their SessionStart
  # hooks cannot pre-empt the Dynamic Skills bootstrap (--bare is unusable: it needs an API key).
  extra+=(--setting-sources project,local)
  if [[ "$kind" == "probe-consent" ]]; then
    allow=("Bash(dynamic-skills save --session ${CONSENT_SESSION} --scope project --harness claude-code)" "${allow[@]}")
    extra+=(--settings "$REPO_REAL/.claude/settings.json")
  else
    allow=("Bash(dynamic-skills *)" "${allow[@]}")
    deny+=("Bash(dynamic-skills save)" "Bash(dynamic-skills save *)")
  fi
  # JSON for every kind: the main run's reply and session id are read from it (harness_reply).
  extra+=(--output-format json)
  extra+=(--add-dir "$DSH_REAL")
  if [[ "$NATIVE" == "1" ]]; then
    mkdir -p "$DSH_REAL/native/claude-code"
    extra+=(--add-dir "$DSH_REAL/native/claude-code")
  fi
  echo "--allowedTools"
  printf '%s\n' "${allow[@]}"
  [[ ${#extra[@]} -eq 0 ]] || printf '%s\n' "${extra[@]}"
  echo "--disallowedTools"
  printf '%s\n' "${deny[@]}"
}

harness_run() {
  local prompt="$1" out="$2" kind="${3:-main}" a
  local args=()
  while IFS= read -r a; do args+=("$a"); done < <(claude_args "$kind")
  # stderr (trust and settings warnings) goes to its own file so it cannot precede the JSON document.
  (cd "$REPO" && ${TIMEOUT_CMD[@]+"${TIMEOUT_CMD[@]}"} claude -p "$prompt" "${args[@]}") >"$out" 2>"${out%.txt}.stderr.txt"
}

# JS prelude shared by the node snippets below: parse the output as one JSON document, else the
# last line that parses as a JSON object (warning lines may surround it); `res` is the result.
CLAUDE_PARSE='
  const fs = require("node:fs");
  const text = fs.readFileSync(process.argv[1], "utf8");
  let doc;
  try { doc = JSON.parse(text); } catch {
    for (const line of text.split("\n").reverse()) {
      try { const v = JSON.parse(line); if (v && typeof v === "object") { doc = v; break; } } catch { }
    }
  }
  const res = Array.isArray(doc) ? doc.find((d) => d && d.type === "result") : doc;
'

# harness_reply OUT: print the final reply (the JSON result field), save it as OUT's .reply.txt
# (the text scans of the checklist read that file, not the JSON line), and print a best-effort
# "Skills invoked" line from the run's transcript. Never fails the run; when the output is not a
# JSON result it shows the last 60 lines of plain text and uses them as the reply.
harness_reply() {
  local out="$1" reply_file="${1%.txt}.reply.txt" sid="" reply slug transcript skills
  reply="$(node -e "$CLAUDE_PARSE"'
    if (!res || typeof res.result !== "string") process.exit(1);
    console.log(res.result);
  ' "$out" 2>/dev/null)" || reply=""
  if [[ -n "$reply" ]]; then
    printf '%s\n' "$reply" >"$reply_file"
    echo "(agent final reply, the JSON result field)"
    echo "$reply" | tail -n 60
    sid="$(node -e "$CLAUDE_PARSE"'
      if (res && typeof res.session_id === "string") console.log(res.session_id);
    ' "$out" 2>/dev/null || true)"
  else
    cp "$out" "$reply_file" 2>/dev/null || : >"$reply_file"
    tail -n 60 "$out" 2>/dev/null || true
  fi
  # Claude Code keeps the transcript at <config dir>/projects/<slug>/<session_id>.jsonl, where the
  # slug is the real repo path with every non-alphanumeric character replaced by '-'
  # (/private/var/x/y.z becomes -private-var-x-y-z). Only this run's own transcript is read.
  slug="$(printf '%s' "$REPO_REAL" | sed 's/[^A-Za-z0-9]/-/g')"
  transcript="${CLAUDE_CONFIG_DIR:-$REAL_HOME/.claude}/projects/$slug/$sid.jsonl"
  skills=""
  if [[ -n "$sid" && -f "$transcript" ]]; then
    skills="$(node -e '
      const fs = require("node:fs");
      const names = [];
      // A slash invocation is a user entry with <command-name>/x</command-name>, not a tool_use.
      const slash = /<command-name>\/?([^<]+)<\/command-name>/g;
      for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
        let e; try { e = JSON.parse(line); } catch { continue; }
        const c = e && e.message && e.message.content;
        if (typeof c === "string") {
          if (e.type === "user") for (const m of c.matchAll(slash)) names.push("slash: " + m[1]);
          continue;
        }
        if (!Array.isArray(c)) continue;
        for (const b of c) {
          if (!b) continue;
          if (b.type === "tool_use" && b.name === "Skill" && b.input && typeof b.input.skill === "string") names.push(b.input.skill);
          else if (e.type === "user" && b.type === "text" && typeof b.text === "string") for (const m of b.text.matchAll(slash)) names.push("slash: " + m[1]);
        }
      }
      console.log(names.length ? names.join(", ") : "(none)");
    ' "$transcript" 2>/dev/null)" || skills=""
  fi
  echo
  if [[ -n "$skills" ]]; then
    echo "Skills invoked (via the Skill tool): $skills"
  else
    echo "Skills invoked (via the Skill tool): unknown (transcript not found)"
  fi
  return 0
}

# The Claude Code result JSON lists refused tool calls in permission_denials (field name from
# Claude Code's headless output; unverified against 2.1.325).
harness_evidence() {
  node -e '
    const fs = require("node:fs");
    const text = fs.readFileSync(process.argv[1], "utf8");
    let doc;
    try { doc = JSON.parse(text); } catch {
      // Tolerate warning lines around the document: use the last line that parses as a JSON object.
      for (const line of text.split("\n").reverse()) {
        try { const v = JSON.parse(line); if (v && typeof v === "object") { doc = v; break; } } catch { }
      }
    }
    if (doc === undefined) { console.log("(output is not one JSON document)"); process.exit(0); }
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
  CONSENT_SESSION="$s"
  if probe_save_ok; then
    probe d6-save "Run exactly this command and report verbatim what happened, including any denial: dynamic-skills save --session $s --scope project --harness claude-code" probe-consent
  else
    echo "(probe d6-save skipped: no session whose repo is the workspace repo)"
  fi
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
  [ ] Plugin isolation: the run used --setting-sources project,local, so the user's plugins, hooks and user settings were NOT loaded, on purpose (see 'Skills invoked' above for what the agent actually used)
  [ ] Real setups with plugins that force their own skills first (e.g. a 'MUST use before any creative work' skill) can pre-empt autonomous invocation; record this
  [ ] Print-mode grants needed: were any tool calls denied in the main run? (see the matches below)
  [ ] Compound 'cd ... && dynamic-skills ...' calls: allowed or denied? (probe: compound)
  [ ] /var vs /private/var: any denial citing a path? (matches below; probe: var-alias)
  [ ] D6: consent rule enforced: 'save' (d6-save) and 'init' (d6-init) were denied, per permission_denials above (a prompt cannot appear headless)
  [ ] Questions headless: how were they handled (recorded as assumptions.json above)?
  [ ] Followed the bootstrap end to end (assess, discover, evaluate, activate, then work)?
  [ ] Phase 1 gate item 7: AC 3 autonomous invocation (did the skill start without being named; run both modes)
  [ ] Live AC 8 and the 150 s timing (Timing line above); AC 24 and AC 28 lines above
  Layers for an absolute 'node .../dist/index.js' call that bypasses the wrapper: Claude Code denies it (only Bash(dynamic-skills *) is allowed); the wrapper (R41) jails and guards every bare call.
  [ ] R31: '-V save' refused (R31 lines above)
CHECK
  if [[ "$NATIVE" == "1" ]]; then
    echo "  [ ] --native: did the agent list the placed skill from $DYNAMIC_SKILLS_HOME/native/claude-code (see output)?"
  fi
  # The main output is one JSON line (always containing "permission_denials"), so the text scans
  # read the extracted reply (main.reply.txt); real denials are listed by harness_evidence.
  scan "$TMP/out/main.reply.txt" "Denied or permission lines" 'denied|permission|not allowed|requires approval'
  scan "$TMP/out/main.stderr.txt" "Denied or permission lines (stderr)" 'denied|permission|not allowed|requires approval'
  scan "$TMP/out/main.reply.txt" "/private/var or /var path lines" '/private/var|/var/'
  scan "$TMP/out/main.reply.txt" "Compound-command lines" 'cd .*&&.*dynamic-skills'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  smoke_main claude-code claude "$MODE"
fi
