// @req FR-01 FR-03
// Issue #236: claims --check-anchors --typecheck (stub typescript, test/helpers/typecheck-project.mjs).
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkAnchors } from '../src/claims/anchors.mjs';
import { loadClaims } from '../src/claims/load.mjs';
import { main } from '../src/cli.mjs';
import { resetRunnerCache } from '../src/probe/runners/shared.mjs';
import { SRC, cleanupProjects, stubProject } from './helpers/typecheck-project.mjs';

afterEach(() => { resetRunnerCache(); cleanupProjects(); });

describe('claims --check-anchors --typecheck', () => {
  it('flags a replacement the checker refuses, judges what it can, and leaves the project untouched', async () => {
    const dir = stubProject();
    const report = await checkAnchors(dir, loadClaims(join(dir, 'testguard.claims.json')), { typecheck: '', budgetMs: 2000 });
    const by = Object.fromEntries(report.results.map((r) => [r.claimId, r]));
    expect(by.BAD).toMatchObject({ status: 'fault-invalid', typecheck: { status: 'diagnostics', message: 'src/a.ts(2,3): error TS2322: bad replacement' } });
    expect(by.OK).toMatchObject({ status: 'ok', typecheck: { status: 'clean' } });
    expect(by.AFTER).toMatchObject({ status: 'ok', typecheck: { status: 'clean' } });
    expect(by.JS).toMatchObject({ status: 'ok', typecheck: { status: 'not-applicable' } });
    expect(by.SLOW).toMatchObject({ status: 'timeout', typecheck: { status: 'timeout' } }); // a hung check is never ok
    expect(report).toMatchObject({ checked: 5, ok: 3, invalid: 2 });
    expect(readFileSync(join(dir, 'src', 'a.ts'), 'utf8')).toBe(SRC);
  }, 120_000);

  it('judges the working tree, not the last commit', async () => {
    const dir = stubProject();
    writeFileSync(join(dir, 'src', 'a.ts'), SRC.replace('return x + 1;', 'return x + 1; // BAD')); // uncommitted
    await expect(checkAnchors(dir, loadClaims(join(dir, 'testguard.claims.json')), { typecheck: '', budgetMs: 2000 })).rejects.toThrow(/does not type-check/);
  }, 60_000);
});
