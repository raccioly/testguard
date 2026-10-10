import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { explicitInterpreter, resolveInterpreter, resetInterpreterCache } from '../src/probe/runners/python.mjs';

const hasPython3 = spawnSync('python3', ['-c', 'pass']).status === 0;
afterEach(() => resetInterpreterCache());

it('a bare command name is looked up on PATH, never resolved against the working directory', () => {
  // `--python python3` used to become <cwd>/python3, which is never an interpreter.
  expect(explicitInterpreter('python3')).toEqual({ path: 'python3', source: 'path' });
  expect(explicitInterpreter('python3.12')).toEqual({ path: 'python3.12', source: 'path' });
});

it('a path is resolved once against the working directory, whichever way it was given', () => {
  expect(explicitInterpreter('.venv/bin/python')).toEqual({ path: resolve('.venv/bin/python'), source: 'project' });
  expect(explicitInterpreter('./python3')).toEqual({ path: resolve('python3'), source: 'project' });
  expect(explicitInterpreter('/opt/py/bin/python')).toEqual({ path: '/opt/py/bin/python', source: 'project' });
});

it('nothing named is nothing explicit', () => {
  expect(explicitInterpreter(undefined)).toBeUndefined();
  expect(explicitInterpreter('')).toBeUndefined();
});

it.skipIf(!hasPython3)('--python python3 and TESTGUARD_PYTHON=python3 both resolve the interpreter on PATH', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-pyname-'));
  const saved = process.env.TESTGUARD_PYTHON;
  try {
    const flag = await resolveInterpreter({ projectDir: dir, python: 'python3' });
    expect(flag.error).toBeUndefined();
    expect(flag).toMatchObject({ path: 'python3', source: 'path', explicit: true });
    resetInterpreterCache();
    process.env.TESTGUARD_PYTHON = 'python3';
    const env = await resolveInterpreter({ projectDir: dir });
    expect(env).toMatchObject({ path: 'python3', source: 'path', explicit: true });
  } finally {
    if (saved === undefined) delete process.env.TESTGUARD_PYTHON; else process.env.TESTGUARD_PYTHON = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
