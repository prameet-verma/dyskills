#!/usr/bin/env bash
# Static release gates run in CI after `pnpm build` (Phase 2 gate items 8 to 11).
# Run from the repository root: `bash scripts/ci-gate.sh`. Exits non-zero on the first failure.
set -euo pipefail

fail() {
  echo "ci-gate: $*" >&2
  exit 1
}

echo "ci-gate: schemas match the zod sources (gate 8)"
pnpm gen:schemas >/dev/null
git diff --exit-code -- schemas || fail "schemas/ is stale; run pnpm gen:schemas and commit"

echo "ci-gate: harness names stay in the allowed files (gate 9)"
allowed='^(packages/bootstrapper/src/roots\.ts|packages/core/src/schemas\.ts|packages/eval-engine/src/evals/structural\.ts|packages/cli/src/adapters\.ts|packages/bootstrapper/README\.md|packages/cli/README\.md|packages/[^/]+/test/.*)$'
names=$(git grep -liE "claude code|claude-code|codex|opencode|AskUserQuestion|request_user_input|\.claude/|\.agents/|\.opencode/" \
  -- 'packages/**/*.ts' 'packages/**/*.md' 'skills/**' || true)
unexpected=$(printf '%s\n' "$names" | grep -vE "$allowed" | grep -v '^$' || true)
[ -z "$unexpected" ] || fail "harness names outside the allowed files:
$unexpected"

echo "ci-gate: no network or model clients (gate 10)"
if git grep -nE "from [\"'](openai|@anthropic-ai/sdk|axios)[\"']|fetch\(" \
  -- 'packages/**/*.ts' 'adapters/**/*.ts' ':!**/test/**'; then
  fail "network or model client found"
fi

echo "ci-gate: the CLI is never run through a package runner (gate 11, Ruling R19)"
if git grep -nE "(npx|pnpx|bunx|pnpm[[:space:]]+dlx|yarn[[:space:]]+dlx|npm[[:space:]]+exec)[[:space:]]+dynamic-skills" \
  -- ':!PRD.md' ':!docs/superpowers'; then
  fail "package-runner invocation found"
fi

echo "ci-gate: the packed CLI passes the release check (gate 11)"
pnpm exec tsx scripts/check-release.ts

echo "ci-gate: publish dry run"
pnpm --filter dynamic-skills publish --dry-run --no-git-checks

echo "ci-gate: all gates passed"
