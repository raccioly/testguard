// @req FR-10
import { it, expect } from 'vitest';
import { checkRunner, resolveRunner, runnerArgv, resetRunnerCache } from '../src/probe/runners/shared.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  it('resolves vitest from this project with its pinned version and its own bin script', async () => {
    resetRunnerCache();
    const r = await checkRunner({ projectDir: ROOT, pkg: 'vitest', bin: 'vitest' });
    const pinned = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'vitest', 'package.json'), 'utf8')).version;
    expect(r).toEqual({ ok: true, version: pinned, source: 'project' });
    const argv = runnerArgv(ROOT, 'vitest', 'vitest');
    expect(argv[0]).toBe(process.execPath);
    expect(argv[1]).toMatch(/node_modules[\\/]vitest[\\/]vitest\.mjs$/);
    expect(resolveRunner({ projectDir: ROOT, pkg: 'vitest', bin: 'vitest' }).source).toBe('project');
  });

