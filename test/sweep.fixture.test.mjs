// @req FR-08
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
//
// The sweep verb against a real repository, a real change and a real runner.
// The unit tests pin the decisions; this pins that the decisions are wired to
// anything. Deliberately ONE fault (`--cap 1`): an acceptance test that probes
// a dozen proposals is a minutes-long test standing in for a wiring check, and
// this project budgets its own gate.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readSpecDoc } from '../src/evidence/writer.mjs';
import { main } from '../src/cli.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'fixtures', 'known-answer');
const capture = () => { const lines = { out: [], err: [] }; return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } }; };

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tg-sweep-')));
  cpSync(FIXTURE, root, { recursive: true, filter: (s) => !/node_modules|\.flake-counter|\.testguard/.test(s) });
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  const g = (...args) => {
    const r = spawnSync('git', ['-c', 'user.email=g@example.invalid', '-c', 'user.name=g', ...args], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const write = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  g('init', '-q');
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const commit = (msg = 'change') => { g('add', '-A'); g('commit', '-q', '-m', msg); };
  return { root, g, write, commit };
}

const run = async (root, argv) => {
  const { lines, io } = capture();
  const code = await main(['sweep', root, ...argv], io);
  return { code, out: lines.out.join('\n'), err: lines.err.join('\n') };
};

describe('sweep: findings on changed code that carries no claim', () => {
  let r;
  beforeEach(() => { r = repo(); });
  afterEach(() => rmSync(r.root, { recursive: true, force: true }));

  it('a new unclaimed module whose test asserts too little yields a SURVIVED finding and exits 1', async () => {
    // `action` is asserted; `email` is not. Dropping the field that carries the
    // data is invisible — the pathology this project reports from the field,
    // in miniature. `email` is first so the line tie-break selects it.
    r.write('src/audit.mjs', [
      'export function auditRow(user, action) {',
      '  return {',
      '    email: user.email,',
      '    action,',
      '  };',
      '}',
      '',
    ].join('\n'));
    r.write('test/audit.test.mjs', [
      "import { describe, it, expect } from 'vitest';",
      "import { auditRow } from '../src/audit.mjs';",
      '',
      "describe('auditRow', () => {",
      "  it('records the action', () => expect(auditRow({ email: 'a@b.c' }, 'delete').action).toBe('delete'));",
      '});',
      '',
    ].join('\n'));
    r.commit('add audit');

    const { code, out } = await run(r.root, ['--changed', 'HEAD~1', '--cap', '1', '--quiet']);
    expect(code).toBe(1);
    expect(out).toMatch(/SURVIVED/);
    expect(out).toMatch(/PROPOSALS, not claims/);

    const doc = readSpecDoc('sweep', join(r.root, '.testguard', 'sweep.json'));
    expect(doc.scope.targets).toBe(1);
    expect(doc.selection.selected).toBe(1);
    // The remainder is reported, never dropped: a cap that hides its own
    // leftovers is a coverage claim nobody made.
    expect(doc.selection.proposed).toBe(doc.selection.selected + doc.selection.deferred);
    expect(doc.selection.deferred).toBeGreaterThan(0);
    expect(doc.findings).toHaveLength(1);
    expect(doc.findings[0]).toMatchObject({ file: 'src/audit.mjs', verdict: 'survived', faultClass: 'field-dropped' });
  }, 240_000);

  it('never writes the claims file, and never touches the canonical evidence', async () => {
    r.write('src/audit.mjs', 'export const rate = () => 0.2;\n');
    r.commit('add audit');
    const before = readSpecDoc('claims', join(r.root, 'testguard.claims.json'));

    await run(r.root, ['--changed', 'HEAD~1', '--cap', '1', '--quiet']);

    expect(readSpecDoc('claims', join(r.root, 'testguard.claims.json'))).toEqual(before);
    // A sweep probes faults nobody stated, under TODO statements. Folding that
    // into the document `status` and `baseline` read from would corrupt the
    // record of what the project actually claims.
    expect(() => readSpecDoc('evidence', join(r.root, '.testguard', 'evidence.json'))).toThrow();
  }, 240_000);

  it('a change with nothing unclaimed proposes nothing and exits 0', async () => {
    // README is not source, so the gate excludes it and there is no target.
    r.write('README.md', '# changed\n');
    r.commit('docs only');
    const { code, out } = await run(r.root, ['--changed', 'HEAD~1', '--quiet']);
    expect(code).toBe(0);
    expect(out).toMatch(/Nothing to propose/);
  }, 120_000);

  it('without a reference it refuses with usage, rather than guessing at a base', async () => {
    const { code, err } = await run(r.root, ['--quiet']);
    expect(code).toBe(3);
    expect(err).toMatch(/needs a reference/);
  });
});
