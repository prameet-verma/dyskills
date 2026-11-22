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

if [ -f "$READY" ] && [ "$force" -eq 0 ]; then
  echo "template ready: $T" >&2
  exit 0
fi

safe_rm "$T"
mkdir -p "$EVAL_OUT/templates"
cp -R "$FIX" "$T"
rm -rf "$T/.git"
# Built in place: package-manager shims record absolute paths, so the template must not move.
(cd "$T" && env PATH="$(run_path)" "$SD/prepare.sh" "$T") >&2
(
  cd "$T"
  for ig in node_modules dist .nx; do
    grep -qxF "$ig" .gitignore 2>/dev/null || echo "$ig" >>.gitignore
  done
  git init -q
  git add -A
  git -c user.name=eval -c user.email=eval@example.invalid -c commit.gpgsign=false commit -q -m baseline
)
: >"$READY"
echo "template built: $T" >&2
