// Issue #234: the project's own claims file is never marked external.
// One behavior per file (as test/run-budget-*.test.mjs): each fault of
// TG-EXTERNAL-CLAIMS-ARE-NAMED-BY-HASH-NEVER-BY-PATH names the one file that kills it, so no fault
// pays for the other two probes.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  it('records no claimsSource for the project\'s own claims file', async () => {
    const { dir } = setup();
    const r = await run(['probe', dir, '--runner', 'node-test', '--json']);
    expect(JSON.parse(readFileSync(JSON.parse(r.out).run.evidence, 'utf8')).run.claimsSource).toBeUndefined();
  });
});
