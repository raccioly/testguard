// @req FR-10
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'fixtures', 'known-answer-vitest-projects');

/** Vitest `test.projects` (#277): discovered membership decides where each defender runs. */
describe('probe reproduces the vitest-projects fixture', () => {
  let scratch;
  let evidence;
  const expected = JSON.parse(readFileSync(join(FIXTURE, 'expected.json'), 'utf8'));

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'testguard-vitest-projects-'));
    cpSync(FIXTURE, scratch, { recursive: true, filter: (src) => !/node_modules/.test(src) });
    symlinkSync(join(ROOT, 'node_modules'), join(scratch, 'node_modules'), 'dir');
    const g = (...args) => { const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=f@example.invalid', '-c', 'user.name=f', ...args], { cwd: scratch, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
    g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'fixture');
    evidence = await probe({ projectDir: scratch, claims: loadClaims(join(scratch, 'testguard.claims.json')), confirmRuns: expected.confirmRuns, mode: 'worktree', runnerName: 'vitest', escalate: false, budgetMs: 60_000, toolVersion: 'test' });
  }, 300_000);

  afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

  it('yields every expected verdict', () => {
    const actual = Object.fromEntries(evidence.records.map((r) => [`${r.claim.id}/${r.subject.id}`, r.verdict]));
    expect(actual).toEqual(Object.fromEntries(Object.entries(expected.expected).map(([k, v]) => [k, v.verdict])));
  });

  it('emits evidence that conforms', () => {
    expect(validate('evidence', evidence).errors).toEqual([]);
  });
});
