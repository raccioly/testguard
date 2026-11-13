// Issue #234: claims, status and admit are served from a claims file outside the project.
// One behavior per file (as test/run-budget-*.test.mjs): each fault of
// TG-EXTERNAL-CLAIMS-ARE-NAMED-BY-HASH-NEVER-BY-PATH names the one file that kills it, so no fault
// pays for the other two probes.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
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
    // Named by hash, not by a relative path a `..`-rejecting consumer could not read.
    expect(doc.paths.claims).toBeUndefined();
    expect(doc.claimsSource).toEqual({ external: true, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const admit = await run(['admit', join(dir, 'test/price.test.mjs'), '--claims', claims, '--claim', 'PRICE-TOTAL', '--runner', 'node-test', '--json']);
    expect(admit.err).not.toMatch(/^error:/m);
    expect(readdirSync(outside)).toEqual(['claims.json']);
  });
});
