// @req FR-03
// Issue #236: the checker is the project's own and a check that cannot be made is never skipped (stub typescript).
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createTypechecker } from '../src/probe/typecheck.mjs';
import { PreconditionError } from '../src/probe/worktree.mjs';
import { resetRunnerCache } from '../src/probe/runners/shared.mjs';
import { stubTscProject as stubProject, tmpDir as tmp, writeIn as write, cleanupProjects } from './helpers/typecheck-project.mjs';

afterEach(() => { resetRunnerCache(); cleanupProjects(); });

describe('the checker is the project\'s own, never a bundled compiler', () => {
  it('names the project\'s typescript version, runs it with --noEmit --incremental, and hashes a path-independent identity', async () => {
    const a = stubProject();
    const b = stubProject();
    const log = join(tmp(), 'argv.log');
    process.env.TG_ARGV_LOG = log;
    try {
      const one = await createTypechecker({ projectDir: a });
      const two = await createTypechecker({ projectDir: b });
      expect(one.spec).toEqual({ commandHash: expect.stringMatching(/^[0-9a-f]{64}$/), version: '9.9.9' });
      expect(one.spec).toEqual(two.spec);
      const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const check = calls.find((c) => !c.includes('--showConfig') && !c.includes('--listFilesOnly'));
      expect(check).toEqual(expect.arrayContaining(['--noEmit', '-p', 'tsconfig.json', '--incremental', '--tsBuildInfoFile']));
      expect(check[check.indexOf('--tsBuildInfoFile') + 1]).not.toContain(a); // never inside the project tree
      one.cleanup(); two.cleanup();
    } finally { delete process.env.TG_ARGV_LOG; }
  });

  it('a project with no tsconfig and no command is a precondition error naming the cause', async () => {
    await expect(createTypechecker({ projectDir: tmp() })).rejects.toThrow(/needs a tsconfig\.json/);
    await expect(createTypechecker({ projectDir: tmp() })).rejects.toThrow(PreconditionError);
  });

  it('a typescript that cannot be resolved from the project is a precondition error, never a skip', async () => {
    const dir = tmp();
    write(dir, 'tsconfig.json', '{}');
    await expect(createTypechecker({ projectDir: dir })).rejects.toThrow(/typescript cannot be resolved/);
  });

  it('an unmodified tree that already fails is a precondition error naming the first diagnostic only', async () => {
    const dir = stubProject();
    write(dir, 'mode', 'diagnostic');
    await expect(createTypechecker({ projectDir: dir })).rejects.toThrow(/does not type-check[\s\S]*src\/a\.ts\(1,1\): error TS2322: nope$/);
  });

  it('a tsc that dies without a diagnostic is not clean: at baseline it is a precondition error, mid-run it throws', async () => {
    const dir = stubProject();
    write(dir, 'mode', 'crash');
    await expect(createTypechecker({ projectDir: dir })).rejects.toThrow(/exited 7 without a diagnostic: segfault/);
    write(dir, 'mode', 'clean');
    const checker = await createTypechecker({ projectDir: dir });
    write(dir, 'mode', 'crash');
    await expect(checker.check()).rejects.toThrow(/exited 7 without a diagnostic/);
    write(dir, 'mode', 'diagnostic');
    expect(await checker.check()).toMatchObject({ status: 'diagnostics', message: 'src/a.ts(1,1): error TS2322: nope' });
    checker.cleanup();
  });

  it('exceeding the budget is a timeout, never a pass', async () => {
    const dir = stubProject();
    const checker = await createTypechecker({ projectDir: dir });
    write(dir, 'mode', 'slow');
    expect(await checker.check({ budgetMs: 300 })).toMatchObject({ status: 'timeout' });
    checker.cleanup();
  });

  it('a program with no project file is a precondition error: nothing could be judged', async () => {
    await expect(createTypechecker({ projectDir: stubProject({ program: [] }) })).rejects.toThrow(/program contains no project file/);
  });
});
