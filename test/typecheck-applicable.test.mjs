// @req FR-03
// Issue #236: what the checker reads decides what is judged (stub typescript).
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createTypechecker } from '../src/probe/typecheck.mjs';
import { PreconditionError } from '../src/probe/worktree.mjs';
import { resetRunnerCache } from '../src/probe/runners/shared.mjs';
import { stubTscProject as stubProject, tmpDir as tmp, writeIn as write, cleanupProjects } from './helpers/typecheck-project.mjs';

afterEach(() => { resetRunnerCache(); cleanupProjects(); });

describe('the program decides what is judged', () => {
  it('a TypeScript file the tsconfig does not include is not applicable: tsc never reads it', async () => {
    const checker = await createTypechecker({ projectDir: stubProject() });
    expect(checker.applicable('src/in.ts')).toBe(true);
    expect(checker.applicable('tools/outside.ts')).toBe(false);
    expect(checker.applicable('test/in.test.ts')).toBe(false);
    checker.cleanup();
  });

  it('a custom command cannot say which files it reads, so only the extension decides; its version names the project\'s typescript too', async () => {
    const dir = stubProject();
    write(dir, 'check.mjs', '');
    const checker = await createTypechecker({ projectDir: dir, command: `${process.execPath} check.mjs` });
    expect(checker.applicable('tools/outside.ts')).toBe(true);
    expect(checker.applicable('src/x.js')).toBe(false);
    expect(checker.spec.version).toMatch(/^v\d+\.\d+\.\d+; typescript@9\.9\.9$/);
    checker.cleanup();
  });

  it('judges TypeScript, and JavaScript only where the project checks it; never Python', async () => {
    const plain = await createTypechecker({ projectDir: stubProject() });
    for (const file of ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'types/a.d.ts']) expect(plain.applicable(file), file).toBe(true);
    for (const file of ['a.js', 'a.mjs', 'a.cjs', 'a.jsx', 'a.py', 'README.md']) expect(plain.applicable(file), file).toBe(false);
    const js = await createTypechecker({ projectDir: stubProject({ showConfig: '{"compilerOptions":{"allowJs":true,"checkJs":true}}' }) });
    for (const file of ['a.js', 'a.mjs', 'a.cjs', 'a.jsx', 'a.ts']) expect(js.applicable(file), file).toBe(true);
    expect(js.applicable('a.py')).toBe(false);
    const half = await createTypechecker({ projectDir: stubProject({ showConfig: '{"compilerOptions":{"checkJs":true}}' }) });
    expect(half.applicable('a.js')).toBe(false); // checkJs without allowJs checks nothing
    plain.cleanup(); js.cleanup(); half.cleanup();
  });
});

