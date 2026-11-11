import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FIXTURE_GIT } from './git.mjs';

/**
 * A small native node:test project for `--fault-workers` (issue #237).
 *
 * Three faults are probed after their baselines:
 * - FAST/F1 is killed.
 * - QUIET/F1 survives: its test runs but never looks at the value.
 * - SLOW/F1 (probed first) is killed when probed ALONE, in a clean tree, and times out when another faulted
 *   suite is running at the same moment. Each faulted FAST/QUIET run leaves a
 *   marker in `markers` while it runs; the SLOW defender, once faulted, waits
 *   briefly, and if any marker is present it hangs past the per-run budget.
 *   That is a defender that only a contended machine makes time out — the
 *   case the serial re-measure exists for — made deterministic.
 *
 * Plus one fault that never mutates (an anchor that is not in the file), so
 * planning-only records are interleaved with measured ones in the order.
 */
export function fanOutProject({ holdMs = 180, only = ['SLOW', 'FAST', 'MISSING', 'QUIET'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tg-fanout-'));
  const markers = mkdtempSync(join(tmpdir(), 'tg-fanout-markers-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fan-out', private: true, type: 'module' }));
  writeFileSync(join(dir, '.gitignore'), '.testguard/\n');
  writeFileSync(join(dir, 'src/fast.mjs'), 'export const fast = () => 1;\n');
  writeFileSync(join(dir, 'src/quiet.mjs'), 'export const quiet = () => 2;\n');
  writeFileSync(join(dir, 'src/slow.mjs'), 'export const slow = () => 3;\n');
  const hold = (check) => `
const markers = process.env.TG_FANOUT_MARKERS;
if (markers && ${check}) {
  const mine = join(markers, String(process.pid));
  writeFileSync(mine, '');
  await new Promise((resolve) => setTimeout(resolve, ${holdMs}));
  rmSync(mine, { force: true });
}`;
  const header = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { existsSync, writeFileSync, rmSync, readdirSync } from 'node:fs';\nimport { join } from 'node:path';\n";
  writeFileSync(join(dir, 'test/fast.test.mjs'), `${header}import { fast } from '../src/fast.mjs';\ntest('fast', async () => {${hold('fast() !== 1')}\n  assert.equal(fast(), 1);\n});\n`);
  writeFileSync(join(dir, 'test/quiet.test.mjs'), `${header}import { quiet } from '../src/quiet.mjs';\ntest('quiet', async () => {${hold('quiet() !== 2')}\n  assert.equal(typeof quiet, 'function');\n});\n`);
  // Polls rather than looks once: a loaded CI machine can start the trees'
  // runners a few hundred milliseconds apart, and a single look could miss.
  writeFileSync(join(dir, 'test/slow.test.mjs'), `${header}import { slow } from '../src/slow.mjs';
test('slow', async () => {
  const markers = process.env.TG_FANOUT_MARKERS;
  if (markers && slow() !== 3) {
    // Stale state from a contended run that was killed in this tree: a
    // re-measure that inherits the tree passes, and reports a survivor.
    if (existsSync('.slow-hung')) return;
    for (let waited = 0; waited < ${holdMs}; waited += 25) {
      if (readdirSync(markers).length > 0) { writeFileSync('.slow-hung', ''); await new Promise((resolve) => setTimeout(resolve, 60_000)); }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.equal(slow(), 3);
});
`);
  const fault = (id, file, find, replace, faultClass) => ({ id, description: `${id} on ${file}`, faultClass, file, find, replace, producedBy: { producer: 'human' } });
  const claim = (id, test, faults) => ({ id, statement: `${id} holds.`, source: { kind: 'manual', ref: 'test' }, severity: 'high', producedBy: { producer: 'human' }, defendedBy: [test], faults });
  const claims = {
    schemaVersion: 1,
    // SLOW first: the first fault in flight is measured in the first tree,
    // so its contended run always leaves its stale state there.
    claims: [
      claim('SLOW', 'test/slow.test.mjs', [fault('F1', 'src/slow.mjs', '=> 3', '=> 0', 'return-altered')]),
      claim('FAST', 'test/fast.test.mjs', [fault('F1', 'src/fast.mjs', '=> 1', '=> 0', 'return-altered')]),
      claim('MISSING', 'test/fast.test.mjs', [fault('F1', 'src/fast.mjs', 'not in the file', 'x', 'return-altered')]),
      claim('QUIET', 'test/quiet.test.mjs', [fault('F1', 'src/quiet.mjs', '=> 2', '=> 0', 'return-altered')]),
    ],
  };
  // BUSY always holds a marker while it runs, unfaulted too; TOUCHY fails
  // whenever it sees one. Serially TOUCHY's baseline is green. With baselines
  // of independent defender sets measured side by side it is red, which only
  // a serial re-measure of that baseline can tell from a broken defender.
  writeFileSync(join(dir, 'src/busy.mjs'), 'export const busy = () => 4;\n');
  writeFileSync(join(dir, 'src/touchy.mjs'), 'export const touchy = () => 5;\n');
  writeFileSync(join(dir, 'test/busy.test.mjs'), `${header}import { busy } from '../src/busy.mjs';\ntest('busy', async () => {${hold('true')}\n  assert.equal(busy(), 4);\n});\n`);
  writeFileSync(join(dir, 'test/touchy.test.mjs'), `${header}import { touchy } from '../src/touchy.mjs';
test('touchy', async () => {
  const markers = process.env.TG_FANOUT_MARKERS;
  for (let waited = 0; markers && waited < ${holdMs}; waited += 25) {
    assert.equal(readdirSync(markers).length, 0, 'another suite is running beside this one');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(touchy(), 5);
});
`);
  claims.claims.push(
    claim('BUSY', 'test/busy.test.mjs', [fault('F1', 'src/busy.mjs', '=> 4', '=> 0', 'return-altered')]),
    claim('TOUCHY', 'test/touchy.test.mjs', [fault('F1', 'src/touchy.mjs', '=> 5', '=> 0', 'return-altered')]),
  );
  claims.claims = claims.claims.filter((c) => only.includes(c.id));
  writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(claims, null, 2));
  const g = (...args) => {
    const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };
  g('init', '-q');
  g('add', '-A');
  g('commit', '-qm', 'fan-out project');
  return { dir, markers, claims, worktrees: () => g('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length };
}
