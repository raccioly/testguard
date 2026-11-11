// @req FR-01 FR-03
// Issue #236: the command line. probe --typecheck[=<cmd>] and
// claims --check-anchors --typecheck (stub typescript: test/helpers/typecheck-project.mjs).
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resetRunnerCache } from '../src/probe/runners/shared.mjs';
import { ROOT, SRC, cleanupProjects, stubProject } from './helpers/typecheck-project.mjs';

afterEach(() => { resetRunnerCache(); cleanupProjects(); });
const BIN = join(ROOT, 'cli', 'testguard.mjs');
const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
const evidenceOf = (dir) => JSON.parse(readFileSync(join(dir, '.testguard', 'evidence-partial.json'), 'utf8'));

describe('probe --typecheck on the command line', () => {
  it('bare --typecheck uses the project\'s tsc and the verdict is recorded', () => {
    const dir = stubProject();
    expect(cli('probe', dir, '--typecheck', '--claim', 'BAD', '--confirm', '1', '--quiet', '--no-escalate').status).toBe(1);
    expect(evidenceOf(dir).records[0]).toMatchObject({ verdict: 'fault-invalid', detail: { reason: 'replacement-does-not-typecheck' } });
  }, 120_000);

  it('a tree that already fails the check exits 2, names the diagnostic and writes no evidence', () => {
    const dir = stubProject({ src: SRC.replace('return x + 1;', 'return x + 1; // BAD') });
    const refused = cli('probe', dir, '--typecheck', '--quiet');
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/does not type-check[\s\S]*error TS2322/);
    expect(existsSync(join(dir, '.testguard', 'evidence.json'))).toBe(false);
  }, 60_000);
});
