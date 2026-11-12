// The native known-answer fixture under `--fault-workers 4` (issue #237):
// the oracle's verdict map and the claim/fault record order, with exactly its
// timeout and its inconsistent probe re-measured serially. The n = 1 run of
// the same fixture is held to the same oracle by probe.node.test.mjs, and the
// full record-by-record equality of the two is checked on every pull request
// by the native-performance job (.github/scripts/benchmark-node-direct.mjs).
import { it, expect } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probe } from '../src/probe/probe.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

it('reproduces the oracle at n = 4, in order, re-measuring exactly what contention could have caused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-fanout-ka-'));
  try {
    cpSync(join(ROOT, 'fixtures/known-answer-node'), dir, { recursive: true, filter: (src) => !/node_modules|counter/.test(src) });
    for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'fixture']]) {
      const r = spawnSync('git', [...FIXTURE_GIT, ...args], { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
    }
    const claims = JSON.parse(readFileSync(join(dir, 'testguard.claims.json'), 'utf8'));
    const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')).expected;
    const published = [];
    const evidence = await probe({ projectDir: dir, claims, runnerName: 'node-test', confirmRuns: 3, budgetMs: 10_000, faultWorkers: 4, onProgress: (r) => published.push(`${r.claim.id}/${r.subject.id}`) });
    const ids = claims.claims.flatMap((c) => c.faults.map((f) => `${c.id}/${f.id}`));
    expect(evidence.records.map((r) => `${r.claim.id}/${r.subject.id}`)).toEqual(ids);
    expect(published).toEqual(ids);
    expect(Object.fromEntries(evidence.records.map((r) => [`${r.claim.id}/${r.subject.id}`, { verdict: r.verdict, reason: r.detail.reason }])))
      .toEqual(Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, { verdict: v.verdict, reason: v.reason ?? evidence.records.find((r) => `${r.claim.id}/${r.subject.id}` === k)?.detail.reason }])));
    // Its timeout and inconsistent probe, and (#287) its suite that does not
    // load and its unreached subject: outcomes a neighbour could have caused,
    // so they are measured again alone before they are reported.
    expect(evidence.records.filter((r) => r.detail.remeasuredSerially).map((r) => r.claim.id).sort()).toEqual(['NODE-MIXED', 'NODE-REACH', 'NODE-READY', 'NODE-SYNTAX']);
    expect(evidence.run.faultWorkers).toBe(4);
    expect(validate('evidence', evidence).errors).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
