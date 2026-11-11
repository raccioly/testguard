// @req FR-03
// Issue #236: one fault's diagnostics never reach the next, with the real
// compiler (the fixture's own typescript, installed in its directory).
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTypechecker } from '../src/probe/typecheck.mjs';
import { resetRunnerCache } from '../src/probe/runners/shared.mjs';

const TS_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'known-answer-typescript');
/** Never skipped: a type check that quietly does not run would let this suite pass without exercising it. */
function requireInstalledFixture() {
  if (!existsSync(join(TS_FIXTURE, 'node_modules', 'typescript', 'package.json'))) {
    throw new Error('fixtures/known-answer-typescript is not installed (typescript is missing): run `npm ci --prefix fixtures/known-answer-typescript`. This suite does not skip.');
  }
}

const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'tg-typecheck-real-')); dirs.push(d); return d; };
afterEach(() => { resetRunnerCache(); while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

describe('one fault\'s diagnostics never reach the next (real tsc, incremental)', () => {
  it('restores the build-info after every check', async () => {
    requireInstalledFixture();
    const dir = tmp();
    cpSync(TS_FIXTURE, dir, { recursive: true, filter: (s) => !/node_modules/.test(s) });
    symlinkSync(join(TS_FIXTURE, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const price = join(dir, 'src', 'price.ts');
    const original = readFileSync(price, 'utf8');
    const checker = await createTypechecker({ projectDir: dir });
    const baselineState = readFileSync(checker.buildInfoFile);
    expect(checker.buildInfoFile.startsWith(dir)).toBe(false); // under the scratch area, not in the project
    const faulted = (find, replace) => { writeFileSync(price, original.replace(find, replace)); };
    faulted('): number {', '): string {');
    const first = await checker.check();
    expect(first.status).toBe('diagnostics');
    expect(first.message).toMatch(/src\/price\.ts\(2,3\): error TS2322/);
    // The state the next fault starts from is the unmodified tree's, byte for byte,
    // whatever the checked fault (or a checker killed mid-write) left behind.
    expect(readFileSync(checker.buildInfoFile).equals(baselineState)).toBe(true);
    writeFileSync(price, original);
    expect((await checker.check()).status).toBe('clean');
    faulted('percent: number', 'percent: string');
    const second = await checker.check();
    expect(second.status).toBe('diagnostics');
    expect(second.message).not.toBe(first.message);
    writeFileSync(price, original);
    expect((await checker.check()).status).toBe('clean');
    expect(checker.stats.checks).toBe(4);
    expect(existsSync(join(dir, 'tsconfig.tsbuildinfo'))).toBe(false);
    checker.cleanup();
  }, 60_000);
});

describe('the real compiler refuses what it cannot read', () => {
  it('a tsc that cannot read the configuration is a precondition error naming the first diagnostic', async () => {
    requireInstalledFixture();
    const dir = tmp();
    writeFileSync(join(dir, 'tsconfig.json'), '{ "compilerOptions": ');
    symlinkSync(join(TS_FIXTURE, 'node_modules'), join(dir, 'node_modules'), 'dir');
    await expect(createTypechecker({ projectDir: dir })).rejects.toThrow(/tsc cannot read tsconfig\.json \(.*TS\d+/);
  }, 60_000);
});
