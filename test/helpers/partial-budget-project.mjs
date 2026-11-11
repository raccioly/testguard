import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FIXTURE_GIT } from './git.mjs';

/**
 * A native node:test project of four claims, one fault each, probed in the
 * order C1..C4 — the shape `--partial-on-budget` (issue #235) needs: a prefix
 * that can be fully measured and a suffix the budget can cut off. Every
 * defender is instant, so expiry is decided by an injected clock, never by a
 * sleep.
 *
 * `hang` names a claim whose test never returns once its fault is applied, so
 * only a cap on the child's time can end that run.
 * `survivor` names the claim whose test never looks at the value: its fault
 * survives, so a prefix that contains it holds a finding that gates.
 */
export function partialBudgetProject({ survivor, hang } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tg-partial-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'partial-budget', private: true, type: 'module' }));
  writeFileSync(join(dir, '.gitignore'), '.testguard/\n');
  const ids = ['C1', 'C2', 'C3', 'C4'];
  ids.forEach((id, i) => {
    const name = id.toLowerCase();
    writeFileSync(join(dir, `src/${name}.mjs`), `export const ${name} = () => ${i + 1};\n`);
    const stall = id === hang ? `if (${name}() !== ${i + 1}) await new Promise((resolve) => setTimeout(resolve, 120_000));\n  ` : '';
    const check = id === survivor ? `assert.equal(typeof ${name}, 'function');` : `${stall}assert.equal(${name}(), ${i + 1});`;
    writeFileSync(join(dir, `test/${name}.test.mjs`), `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${name} } from '../src/${name}.mjs';\ntest('${name}', async () => {\n  ${check}\n});\n`);
  });
  const claims = {
    schemaVersion: 1,
    claims: ids.map((id, i) => ({
      id,
      statement: `${id} holds.`,
      source: { kind: 'manual', ref: 'test' },
      severity: 'high',
      producedBy: { producer: 'human' },
      defendedBy: [`test/${id.toLowerCase()}.test.mjs`],
      faults: [{ id: 'F1', description: `${id} fault`, faultClass: 'return-altered', file: `src/${id.toLowerCase()}.mjs`, find: `=> ${i + 1}`, replace: '=> 0', producedBy: { producer: 'human' } }],
    })),
  };
  writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(claims, null, 2));
  const g = (...args) => {
    const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };
  g('init', '-q');
  g('add', '-A');
  g('commit', '-qm', 'partial budget project');
  return {
    dir,
    claims,
    ids,
    worktrees: () => g('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length,
    status: () => g('status', '--porcelain'),
  };
}
