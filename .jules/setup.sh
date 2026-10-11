#!/usr/bin/env bash
# Jules environment setup for TestGuard.
#
# In Jules: this repository → Configuration → Initial Setup, enter
#     bash .jules/setup.sh
# and click "Run and Snapshot". Every later task starts from that snapshot.
#
# It fails, and so leaves no snapshot, when the suite is not green here. A red
# baseline inside the agent's VM is exactly what made a sibling project receive
# the same "fix" 27 times: CI could never reproduce what the sandbox saw.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "== toolchain"
node -v; npm -v; python3 --version; git --version
# vitest 5 needs Node >= 22.12; the Jules image ships 22.x by default.
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a < 22 || (a === 22 && b < 12)) { console.error("Node >= 22.12 required, found " + process.version); process.exit(1); }'

echo "== dependencies, from the lockfiles only (npm ci never rewrites them)"
npm ci --no-audit --no-fund
npm ci --prefix fixtures/known-answer-playwright --no-audit --no-fund
# The docs check CI runs, at CI's pin, cached into the snapshot.
npx -y docguard-cli@0.41.5 --version

echo "== the suite must be green here before any routine runs"
npm test
node cli/testguard.mjs claims . --check-anchors > /dev/null

echo "== leave the tree exactly as cloned (Jules refuses a dirty tree)"
git reset --hard HEAD
git clean -fd
test -z "$(git status --porcelain)"
echo "ready"
