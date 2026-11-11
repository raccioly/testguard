// A throwaway repository for `probe --changed`: two claims over two targets
// (one imports a helper), a file no claim touches, and a base commit to
// measure a change against.
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { FIXTURE_GIT } from './git.mjs';

export const git = (dir, ...args) => execFileSync('git', [...FIXTURE_GIT, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: dir, timeout: 10_000, encoding: 'utf8' }).trim();
export const commit = (dir, message = 'step') => { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', message); return git(dir, 'rev-parse', 'HEAD'); };

const test = (name, imp, expr) => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${imp} } from '../src/${name}.mjs';\n\ntest('${name}', () => {\n  assert.equal(${expr});\n});\n`;
const provenance = { producer: 'agent', by: 'fixture' };
const claim = (id, file, defender, find, replace) => ({
  id,
  statement: `${id} holds.`,
  source: { kind: 'spec', ref: 'README.md' },
  severity: 'high',
  producedBy: provenance,
  defendedBy: [defender],
  faults: [
    { id: 'F1', description: 'Break the result.', faultClass: 'return-altered', file, find, replace, producedBy: provenance },
    { id: 'F2', description: 'Wrong operator.', faultClass: 'literal-changed', file, find: 'x', replace: 'y', producedBy: provenance },
  ],
});

export const FILES = {
  'package.json': JSON.stringify({ name: 'scope-fixture', private: true, type: 'module' }),
  'README.md': '# fixture\n',
  'src/helper.mjs': 'export const round = (n) => Math.round(n);\n',
  'src/price.mjs': "import { round } from './helper.mjs';\nexport const total = (a, b) => round(a + b);\n",
  'src/tax.mjs': 'export const tax = (n) => n * 2;\n',
  'src/orphan.mjs': 'export const orphan = () => 1;\n',
  'test/price.test.mjs': test('price', 'total', 'total(1, 2), 3'),
  'test/tax.test.mjs': test('tax', 'tax', 'tax(2), 4'),
};

export function claimsDoc() {
  const price = claim('PRICE-TOTAL', 'src/price.mjs', 'test/price.test.mjs');
  price.faults[0].find = 'round(a + b)'; price.faults[0].replace = 'round(a - b)';
  price.faults[1].find = 'a + b'; price.faults[1].replace = 'a * b';
  const tax = claim('TAX-DOUBLES', 'src/tax.mjs', 'test/tax.test.mjs');
  tax.faults[0].find = 'n * 2'; tax.faults[0].replace = 'n * 3';
  tax.faults[1].find = '=> n'; tax.faults[1].replace = '=> 0 * n';
  return { schemaVersion: 1, claims: [price, tax] };
}

/** `dir` is the project (the repository root, or `sub` inside it), `root` the repository; `base` is the first commit and HEAD until the caller commits more. */
export function project({ files = {}, claims = claimsDoc(), sub = '' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tg-scope-')));
  const dir = sub ? join(root, sub) : root;
  for (const [name, text] of Object.entries({ ...FILES, ...files, 'testguard.claims.json': JSON.stringify(claims, null, 2) })) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  git(root, 'init', '-q', '-b', 'main');
  const base = commit(root, 'base');
  return { dir, root, base };
}
