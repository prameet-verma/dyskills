#!/usr/bin/env bash
# Live smoke test of the bootstrap skill with a real agent (Phase 1 gate item 7).
#
# This is a developer tool, not part of the test suite: it calls a real model through the `claude`
# CLI, so it needs that CLI installed and logged in, and it costs tokens. Run it by hand:
#
#   pnpm build && scripts/live-smoke.sh
#
# Everything happens inside one temporary directory that is removed on exit: a copy of the
# TypeScript fixture repository (with the bootstrap skill installed in that copy only) and a
# throwaway session home. Your real HOME is left in place so the agent stays logged in: nothing
# is written to your skill directories or to this checkout, but the agent CLI keeps its own
# transcripts and config under the real home as usual. The agent runs with a narrow tool
# allow-list (never a skip-all-permissions flag). This is the only file in the repository that
# names a specific agent harness.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/packages/cli/dist/index.js"
TASK="Implement a new distributed caching strategy for the order-processing service"

if [[ ! -f "$CLI" ]]; then
  echo "Built CLI not found at $CLI; run 'pnpm build' first." >&2
  exit 1
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "The 'claude' CLI is required for the live smoke test." >&2
  exit 1
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/dyskills-smoke.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

REPO="$TMP/repo"
BIN="$TMP/bin"
export DYNAMIC_SKILLS_HOME="$TMP/sessions-home"
mkdir -p "$BIN" "$DYNAMIC_SKILLS_HOME"

# The repository copy gets the bootstrap skill in its project skill directory; the real user
# skill directories are never touched.
cp -R "$ROOT/fixtures/repos/ts-monorepo" "$REPO"
mkdir -p "$REPO/.claude/skills"
cp -R "$ROOT/skills/dynamic-skill-bootstrap" "$REPO/.claude/skills/dynamic-skill-bootstrap"

# Put the built CLI on PATH as the bare `dynamic-skills` command, the only spelling the skill
# uses (Ruling R19: never a package runner, which could fetch an unrelated registry package).
# The agent inherits this PATH.
ln -s "$CLI" "$BIN/dynamic-skills"
export PATH="$BIN:$PATH"
if [[ "$(command -v dynamic-skills)" != "$BIN/dynamic-skills" ]]; then
  echo "The linked dynamic-skills is not first on PATH." >&2
  exit 1
fi

echo "Running the agent in $REPO (sessions in $DYNAMIC_SKILLS_HOME)..." >&2
# Narrow allow-list: the bare CLI only, file tools, and write access to the session home.
# Without it print mode denies the Bash calls and the session home is outside the cwd.
CLAUDE_ARGS=(
  --allowedTools "Bash(dynamic-skills:*)" Read Write Edit Glob Grep
  --add-dir "$DYNAMIC_SKILLS_HOME"
)
(cd "$REPO" && claude -p "$TASK" "${CLAUDE_ARGS[@]}") || echo "claude exited non-zero; reporting what was recorded." >&2

echo
echo "== dynamic-skills report perf =="
dynamic-skills report perf 2>/dev/null

SESSION="$(ls -1t "$DYNAMIC_SKILLS_HOME/sessions" 2>/dev/null | head -n 1 || true)"
if [[ -z "$SESSION" ]]; then
  # A cleaned session leaves only its archived performance report (Ruling R21).
  ARCHIVED="$(ls -1t "$DYNAMIC_SKILLS_HOME/reports" 2>/dev/null | head -n 1 || true)"
  if [[ -n "$ARCHIVED" ]]; then
    echo
    echo "== archived reports/$ARCHIVED (the session was cleaned) =="
    cat "$DYNAMIC_SKILLS_HOME/reports/$ARCHIVED"
    exit 0
  fi
  echo "No session was created: the agent did not invoke the skill, or a tool call was denied."
  exit 0
fi
echo
echo "== $SESSION reports/performance.json =="
cat "$DYNAMIC_SKILLS_HOME/sessions/$SESSION/reports/performance.json" 2>/dev/null \
  || echo "(no performance report: the session did not finish)"
echo
echo "== $SESSION reports/discovery.json =="
cat "$DYNAMIC_SKILLS_HOME/sessions/$SESSION/reports/discovery.json" 2>/dev/null \
  || echo "(no discovery report: the session did not finish)"
echo
echo "== $SESSION reports/sufficiency.json =="
cat "$DYNAMIC_SKILLS_HOME/sessions/$SESSION/reports/sufficiency.json" 2>/dev/null \
  || echo "(no sufficiency report)"
