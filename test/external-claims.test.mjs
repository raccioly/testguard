// Issue #234: a claims file outside the repository under probe is a supported
// contract for probe, claims, admit and status. Fault `file` and `defendedBy`
// stay project-relative; the evidence names the file by hash only.
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { CLAIMS, project } from './helpers/reuse-project.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
const capture = () => {
  const lines = { out: [], err: [] };
  return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } };
};
const run = async (args) => {
  const c = capture();
  const code = await main(args, c.io);
  return { code, out: c.lines.out.join('\n'), err: c.lines.err.join('\n') };
};

function setup() {
  const dir = project();
  const outside = mkdtempSync(join(tmpdir(), 'tg-external-claims-'));
  dirs.push(dir, outside);
  const claims = join(outside, 'claims.json');
  const text = JSON.stringify(CLAIMS);
  writeFileSync(claims, text);
  return { dir, outside, claims, text };
}

describe('an external claims file', () => {
  it('probes end to end, records its hash and never its path, and writes nothing beside it', async () => {
    const { dir, outside, claims, text } = setup();
    const r = await run(['probe', dir, '--claims', claims, '--runner', 'node-test', '--confirm', '3', '--json']);
    expect(r.err).not.toMatch(/^error:/m);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(validate('status', doc).errors).toEqual([]);
    const evidence = JSON.parse(readFileSync(doc.run.evidence, 'utf8'));
    expect(validate('evidence', evidence).errors).toEqual([]);
    expect(evidence.run.claimsSource).toEqual({ external: true, sha256: createHash('sha256').update(text).digest('hex') });
    expect(JSON.stringify(evidence)).not.toContain(outside);
    expect(JSON.stringify(doc)).not.toContain(outside);
    expect(readdirSync(outside)).toEqual(['claims.json']);
  });

  it('records no claimsSource for the project\'s own claims file', async () => {
    const { dir } = setup();
    const r = await run(['probe', dir, '--runner', 'node-test', '--json']);
    expect(JSON.parse(readFileSync(JSON.parse(r.out).run.evidence, 'utf8')).run.claimsSource).toBeUndefined();
  });

  it('serves claims, status and admit from the file outside the project', async () => {
    const { dir, outside, claims } = setup();
    // The project's own claims file must not be what answers.
    rmSync(join(dir, 'testguard.claims.json'));
    const listed = await run(['claims', dir, '--claims', claims, '--json']);
    expect(listed.code, listed.err).toBe(0);
    expect(JSON.parse(listed.out).claims.claims.map((c) => c.id)).toEqual(['PRICE-TOTAL']);
    const probed = await run(['probe', dir, '--claims', claims, '--runner', 'node-test', '--json']);
    expect(probed.code, probed.err).toBe(0);
    const status = await run(['status', dir, '--claims', claims, '--json']);
    expect(status.err).not.toMatch(/^error:/m);
    expect(status.code, status.out).toBe(0);
    const doc = JSON.parse(status.out);
    expect(doc.state).toBe('clean');
    expect(JSON.stringify(doc)).not.toContain(outside);
    const admit = await run(['admit', join(dir, 'test/price.test.mjs'), '--claims', claims, '--claim', 'PRICE-TOTAL', '--runner', 'node-test', '--json']);
    expect(admit.err).not.toMatch(/^error:/m);
    expect(readdirSync(outside)).toEqual(['claims.json']);
  });
});
