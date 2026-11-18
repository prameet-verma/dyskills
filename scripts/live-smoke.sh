#!/usr/bin/env bash
# Live smoke test dispatcher (Phase 1 gate item 7, Phase 2 gate item 12).
#
# A developer tool, not part of the test suite and never run in CI: it calls a real model through
# the harness CLI, needs that CLI installed and logged in, and costs tokens. Run it by hand:
#
#   pnpm build && scripts/live-smoke.sh <claude-code|codex|opencode> [autonomous|explicit] [--native]
#
# autonomous (default) gives the task text; explicit starts with the harness's skill invocation of
# dynamic-skill-bootstrap. --native (Claude Code only) also sets up native skill placement.
# Everything happens in a temp workspace removed on exit; see scripts/live-smoke/lib.sh.
set -euo pipefail

usage() {
  echo "usage: scripts/live-smoke.sh <claude-code|codex|opencode> [autonomous|explicit] [--native]" >&2
  exit 2
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ $# -ge 1 ]] || usage
HARNESS="$1"
shift
case "$HARNESS" in
  claude-code | codex | opencode) ;;
  *) usage ;;
esac

MODE="autonomous"
NATIVE="0"
for arg in "$@"; do
  case "$arg" in
    autonomous | explicit) MODE="$arg" ;;
    --native) NATIVE="1" ;;
    *) usage ;;
  esac
done
if [[ "$NATIVE" == "1" && "$HARNESS" != "claude-code" ]]; then
  echo "--native is supported on claude-code only." >&2
  usage
fi

exec bash "$HERE/live-smoke/$HARNESS.sh" "$MODE" "$NATIVE"
