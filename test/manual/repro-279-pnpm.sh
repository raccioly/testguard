#!/usr/bin/env bash
# Real-pnpm reproduction of #279, outside `npm test` (it needs pnpm and the
# network for `pnpm install`). The acceptance test in
# test/write-boundary.acceptance.test.mjs builds the same layout by hand.
#
#   bash test/manual/repro-279-pnpm.sh [path/to/cli/testguard.mjs]
#
# Builds a two-package pnpm workspace in a temp directory, installs it, adds a
# git worktree whose node_modules (root and packages/a) are SYMLINKS to the
# main checkout's, snapshots every entry of the main checkout's node_modules
# trees (path, kind, link target, size, mtime), probes from the worktree with
# the built-in runner, with `--runner-cmd "pnpm vitest …"` and with that plus
# --include-dirty, and prints the snapshot difference. 0.22.1 changes 32
# entries (links rewritten into a deleted scratch directory); the fix: 0.
set -euo pipefail
CLI=${1:-$(cd "$(dirname "$0")/../.." && pwd)/cli/testguard.mjs}
VITEST=$(node -p "require('$(cd "$(dirname "$0")/../.." && pwd)/node_modules/vitest/package.json').version")
R=$(mktemp -d "${TMPDIR:-/tmp}/tg-279-repro-XXXXXX")
trap 'rm -rf "$R"' EXIT
mkdir -p "$R/main/packages/a/src" "$R/main/packages/a/test" "$R/main/packages/b/src"
cd "$R/main"
echo "{ \"name\": \"ws279\", \"private\": true, \"type\": \"module\", \"devDependencies\": { \"vitest\": \"$VITEST\" } }" > package.json
printf "packages:\n  - 'packages/*'\n" > pnpm-workspace.yaml
echo "{ \"name\": \"@ws/a\", \"version\": \"1.0.0\", \"type\": \"module\", \"exports\": \"./src/area.js\", \"dependencies\": { \"@ws/b\": \"workspace:*\" }, \"devDependencies\": { \"vitest\": \"$VITEST\" } }" > packages/a/package.json
echo '{ "name": "@ws/b", "version": "1.0.0", "type": "module", "exports": "./src/mul.js" }' > packages/b/package.json
echo 'export const mul = (a, b) => a * b;' > packages/b/src/mul.js
printf "import { mul } from '@ws/b';\nexport const area = (w, h) => mul(w, h);\n" > packages/a/src/area.js
printf "import { test, expect } from 'vitest';\nimport { area } from '../src/area.js';\ntest('area', () => { expect(area(3, 4)).toBe(12); });\n" > packages/a/test/area.test.js
printf "node_modules/\n.testguard/\n" > .gitignore
cat > testguard.claims.json <<'JSON'
{ "schemaVersion": 1, "claims": [ { "id": "AREA", "statement": "Area multiplies.", "source": { "kind": "spec", "ref": "README" }, "severity": "high", "producedBy": { "producer": "agent", "by": "repro" }, "defendedBy": ["packages/a/test/area.test.js"],
  "faults": [ { "id": "F1", "description": "add", "faultClass": "return-altered", "file": "packages/b/src/mul.js", "find": "a * b", "replace": "a + b", "producedBy": { "producer": "agent", "by": "repro" } } ] } ] }
JSON
pnpm install >/dev/null
git init -q && git add -A && git -c user.name=r -c user.email=r@example.invalid commit -qm base
git worktree add -q ../wt HEAD
ln -s "$R/main/node_modules" "$R/wt/node_modules"
ln -s "$R/main/packages/a/node_modules" "$R/wt/packages/a/node_modules"
snap() { node -e "
const fs=require('fs'),p=require('path');const root=process.argv[1];const out={};
const walk=(d)=>{for(const n of fs.readdirSync(d)){const f=p.join(d,n);const s=fs.lstatSync(f);const k=p.relative(root,f);
if(s.isSymbolicLink())out[k]='l:'+fs.readlinkSync(f)+':'+s.mtimeMs;else if(s.isDirectory()){out[k]='d';walk(f)}else out[k]='f:'+s.size+':'+s.mtimeMs}};
for(const d of ['node_modules','packages/a/node_modules','packages/b/node_modules'])if(fs.existsSync(p.join(root,d)))walk(p.join(root,d));
fs.writeFileSync(process.argv[2],JSON.stringify(out))" "$R/main" "$1"; }
snap "$R/before.json"
cd "$R/wt"
for args in "--runner vitest" "--runner-cmd|pnpm vitest run {files} --reporter=json --outputFile={out}" "--include-dirty --runner-cmd|pnpm vitest run {files} --reporter=json --outputFile={out}"; do
  if [[ "$args" == *"|"* ]]; then flags=${args%%|*}; cmd=${args#*|}; set +e; node "$CLI" probe . --no-reuse --confirm 1 $flags "$cmd" > "$R/out.txt" 2>&1; status=$?; set -e
  else set +e; node "$CLI" probe . --no-reuse --confirm 1 $args > "$R/out.txt" 2>&1; status=$?; set -e; fi
  echo "probe ${args%%|*}: exit $status; $(grep -E 'PROVISIONAL:|^error' "$R/out.txt" | head -1 | cut -c1-160)"
done
snap "$R/after.json"
node -e "
const a=require(process.argv[1]),b=require(process.argv[2]);let n=0;
for(const k of new Set([...Object.keys(a),...Object.keys(b)]))if(a[k]!==b[k]){if(n++<10)console.log('  changed:',k);}
console.log('main checkout install: '+Object.keys(a).length+' entries, '+n+' changed')" "$R/before.json" "$R/after.json"
