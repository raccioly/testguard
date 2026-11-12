// Defect B of the 0.22.1 verification: under --json a refusal wrote plain text
// to stderr and NOTHING to stdout for most causes, while an unresolvable
// --changed ref wrote a document. An adapter had to handle both. Now every
// exit 2 and exit 3 under --json writes exactly one `error` document to stdout
// (the human message stays on stderr), or - for an undetermined --changed -
// the status document that already carries that answer.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../src/cli.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { project } from './helpers/scope-project.mjs';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const repo = (options) => { const p = project(options); roots.push(p.root); return p; };

const run = async (args) => {
  const lines = { out: [], err: [] };
  const code = await main(args, { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) });
  return { code, out: lines.out.join('\n'), err: lines.err.join('\n') };
};
/** The one JSON object on stdout, validated; the failure message names what was actually written. */
const errorDoc = (r) => {
  expect(r.out, `stdout was empty; stderr: ${r.err.split('\n')[0]}`).not.toBe('');
  const doc = JSON.parse(r.out);
  expect(validate('error', doc).errors).toEqual([]);
  return doc.error;
};

describe('--json: every refusal is one document on stdout, the human message stays on stderr', () => {
  it('a claims file that does not exist (exit 2)', async () => {
    const r = await run(['probe', '.', '--json', '--claims', '/nonexistent/claims.json']);
    expect(r.code).toBe(2);
    expect(errorDoc(r)).toEqual({ kind: 'claims-file', message: expect.stringContaining('/nonexistent/claims.json'), exitCode: 2 });
    expect(r.err).toMatch(/^error: /m);
  });

  it('a --typecheck command that cannot run (exit 2)', async () => {
    const p = repo();
    const r = await run(['probe', p.dir, '--json', '--runner', 'node-test', '--typecheck=testguard-no-such-binary-xyz']);
    expect(r.code).toBe(2);
    expect(errorDoc(r).kind).toBe('typecheck-unavailable');
    expect(r.err).toMatch(/--typecheck/);
  });

  it('an unknown --claim id (exit 2)', async () => {
    const p = repo();
    const r = await run(['probe', p.dir, '--json', '--runner', 'node-test', '--claim', 'NOPE-1']);
    expect(r.code).toBe(2);
    expect(errorDoc(r)).toMatchObject({ kind: 'claim-unknown', exitCode: 2 });
  });

  it('a repository with no commits (exit 2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-nocommit-'));
    roots.push(dir);
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(p0Claims()));
    const r = await run(['probe', dir, '--json', '--runner', 'node-test']);
    expect(r.code).toBe(2);
    expect(errorDoc(r).kind).toBe('no-commits');
  });

  it('an unresolvable --changed ref keeps its status document, which carries the same answer (exit 2)', async () => {
    const p = repo();
    const r = await run(['probe', p.dir, '--json', '--runner', 'node-test', '--changed', 'nosuchref']);
    expect(r.code).toBe(2);
    const doc = JSON.parse(r.out);
    expect(doc.error).toBeUndefined();
    expect(validate('status', doc).errors).toEqual([]);
    expect(doc.run).toMatchObject({ exitCode: 2, scope: { changed: { outcome: 'undetermined' } } });
  });

  it('a usage error: bad value, unknown option and incompatible flags are exit 3 with kind usage', async () => {
    const p = repo();
    for (const args of [
      ['probe', p.dir, '--json', '--workers', '0'],
      ['probe', p.dir, '--json', '--no-such-option'],
      ['probe', p.dir, '--json', '--fail-on-empty-selection'],
    ]) {
      const r = await run(args);
      expect(r.code, args.join(' ')).toBe(3);
      expect(errorDoc(r)).toMatchObject({ kind: 'usage', exitCode: 3 });
      expect(r.err.length).toBeGreaterThan(0);
    }
  });

  it('admit, claims and status follow the same contract', async () => {
    const p = repo();
    const admit = await run(['admit', 'test/nope.test.mjs', '--claim', 'PRICE-TOTAL', '--json']);
    expect(admit.code).toBe(2);
    // admit resolves against the working directory, which is this repository: the file is missing here too.
    expect(errorDoc(admit).kind).toBe('file-missing');
    const claims = await run(['claims', p.dir, '--json', '--claims', '/nonexistent/claims.json']);
    expect(claims.code).toBe(2);
    expect(errorDoc(claims).kind).toBe('claims-file');
    writeFileSync(join(p.dir, 'testguard.claims.json'), '{ not json');
    const status = await run(['status', p.dir, '--json']);
    expect(status.code).toBe(2);
    expect(errorDoc(status).kind).toBe('claims-file');
    const usage = await run(['admit', '--json']);
    expect(usage.code).toBe(3);
    expect(errorDoc(usage).kind).toBe('usage');
  });

  it('a defect in testguard itself is kind internal, and the trace stays on stderr', async () => {
    const r = await run(['scaffold', 'src/probe', '--json']);
    expect(r.code).toBe(2);
    expect(errorDoc(r).kind).toBe('internal');
    expect(r.err).toMatch(/this is a bug in testguard/);
  });

  it('without --json nothing is written to stdout on a refusal', async () => {
    const r = await run(['probe', '.', '--claims', '/nonexistent/claims.json']);
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
  });

  it('a document already written is never followed by a second one', async () => {
    const p = repo();
    const r = await run(['probe', p.dir, '--json', '--runner', 'node-test', '--changed', 'nosuchref']);
    expect(() => JSON.parse(r.out)).not.toThrow();
  });
});

const p0Claims = () => ({ schemaVersion: 1, claims: [{ id: 'X-1', statement: 'x', source: { kind: 'spec', ref: 'README.md' }, severity: 'high', producedBy: { producer: 'agent', by: 'fixture' }, faults: [{ id: 'F1', description: 'd', faultClass: 'return-altered', file: 'src/x.mjs', find: 'a', replace: 'b', producedBy: { producer: 'agent', by: 'fixture' } }, { id: 'F2', description: 'd', faultClass: 'literal-changed', file: 'src/x.mjs', find: 'a', replace: 'c', producedBy: { producer: 'agent', by: 'fixture' } }] }] });
