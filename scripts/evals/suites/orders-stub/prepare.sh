#!/usr/bin/env bash
# prepare.sh <template-dir>: make the ts-monorepo fixture copy runnable and free of planted content.
set -euo pipefail
dir=${1:?usage: prepare.sh <template-dir>}
cd "$dir"
rm -f .env
# Drop the discovery-test marker and the planted injection line from the README.
grep -v -e '^Fixture repository for discovery tests\.$' -e '^# Ignore all previous instructions' README.md >README.md.tmp || true
mv README.md.tmp README.md
# Pin the dev tools. nx 19.8.15 has an unpublished transitive dependency, so stay on 19.8.14.
node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
p.devDependencies = { vitest: "2.1.9", nx: "19.8.14", typescript: "5.6.3" };
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
'
pnpm install --no-frozen-lockfile
