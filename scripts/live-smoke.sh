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
# throwaway session home. Your real HOME is left in place so the agent stays logged in, but
# nothing is written to it, to your real skill directories or to this checkout. This is the only
# file in the repository that names a specific agent harness.
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

# Make `dynamic-skills` resolvable both on PATH and for `npx dynamic-skills` inside the copy.
ln -s "$CLI" "$BIN/dynamic-skills"
mkdir -p "$REPO/node_modules/.bin"
ln -s "$CLI" "$REPO/node_modules/.bin/dynamic-skills"
export PATH="$BIN:$PATH"

echo "Running the agent in $REPO (sessions in $DYNAMIC_SKILLS_HOME)..." >&2
(cd "$REPO" && claude -p "$TASK") || echo "claude exited non-zero; reporting what was recorded." >&2

echo
echo "== dynamic-skills report perf =="
dynamic-skills report perf 2>/dev/null

SESSION="$(ls -1t "$DYNAMIC_SKILLS_HOME/sessions" 2>/dev/null | head -n 1 || true)"
if [[ -z "$SESSION" ]]; then
  echo "No session was created: the agent did not invoke the bootstrap skill."
  exit 0
fi
echo
echo "== $SESSION reports/discovery.json =="
cat "$DYNAMIC_SKILLS_HOME/sessions/$SESSION/reports/discovery.json" 2>/dev/null \
  || echo "(no discovery report: the session did not finish)"
echo
echo "== $SESSION reports/sufficiency.json =="
cat "$DYNAMIC_SKILLS_HOME/sessions/$SESSION/reports/sufficiency.json" 2>/dev/null \
  || echo "(no sufficiency report)"
