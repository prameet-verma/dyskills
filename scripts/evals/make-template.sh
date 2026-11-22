#!/usr/bin/env bash
# make-template.sh <suite> [--force]
# Build $EVAL_OUT/templates/<suite>: the suite's fixture, prepared (suite prepare.sh), with a git baseline
# commit. Idempotent: an existing ready template is kept; --force rebuilds it.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/lib.sh"

force=0 suite=""
for a in "$@"; do
  case $a in
    --force) force=1 ;;
    -h | --help) sed -n '2,4p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) [ -z "$suite" ] && suite=$a || die "usage: make-template.sh <suite> [--force]" ;;
  esac
done
[ -n "$suite" ] || die "usage: make-template.sh <suite> [--force]"

SD=$(suite_dir "$suite")
FIX=$(fixture_dir "$suite")
[ -d "$FIX" ] || die "fixture '$FIX' does not exist"
[ -x "$SD/prepare.sh" ] || die "$SD/prepare.sh is missing or not executable"
T="$EVAL_OUT/templates/$suite"
READY="$T/.git/eval-template-ready"
HASH=$(tree_hash "$FIX" "$SD/prepare.sh")

# A template is current when its marker holds the hash of the fixture tree plus prepare.sh.
current() { [ -f "$READY" ] && [ "$(cat "$READY")" = "$HASH" ]; }

if [ "$force" -eq 0 ] && current; then
  echo "template ready: $T" >&2
  exit 0
fi

# mkdir-based lock, so parallel callers build a template once. A lock whose owner died is stolen.
mkdir -p "$EVAL_OUT/templates"
LOCK="$EVAL_OUT/templates/.lock-$suite"
waited=0
until mkdir "$LOCK" 2>/dev/null; do
  owner=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
    # Steal atomically: rename, then confirm the renamed lock is the dead owner's (not a fresh one).
    if mv "$LOCK" "$LOCK.dead.$$" 2>/dev/null; then
      if [ "$(cat "$LOCK.dead.$$/pid" 2>/dev/null || true)" = "$owner" ]; then rm -rf "$LOCK.dead.$$"
      else mv "$LOCK.dead.$$" "$LOCK" 2>/dev/null || rm -rf "$LOCK.dead.$$"; fi
    fi
    continue
  fi
  waited=$((waited + 1))
  [ "$waited" -le 900 ] || die "timed out waiting for the template lock $LOCK"
  sleep 1
done
echo $$ >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT
# Another caller may have finished the build while we waited.
if [ "$force" -eq 0 ] && current; then
  echo "template ready: $T" >&2
  exit 0
fi

safe_rm "$T"
cp -R "$FIX" "$T"
rm -rf "$T/.git"
# Built in place: package-manager shims record absolute paths, so the template must not move.
(cd "$T" && env PATH="$(run_path)" "$SD/prepare.sh" "$T") >&2
(
  cd "$T"
  for ig in node_modules dist .nx; do
    grep -qxF "$ig" .gitignore 2>/dev/null || echo "$ig" >>.gitignore
  done
  "${GIT[@]}" init -q
  "${GIT[@]}" add -A
  "${GIT[@]}" commit -q -m baseline
)
echo "$HASH" >"$READY"
echo "template built: $T" >&2
