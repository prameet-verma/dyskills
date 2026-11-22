#!/usr/bin/env bash
# Prepare a template copy of the fixture: install the workspace so specs can run.
# Usage: prepare.sh <template-dir>
set -euo pipefail
dir="${1:?usage: prepare.sh <template-dir>}"
cd "$dir"
pnpm install --no-frozen-lockfile
