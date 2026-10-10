import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runnerOptions } from '../src/commands/runner-options.mjs';

const capture = () => { const lines = { out: [], err: [] }; return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } }; };

describe('runner options are a usage contract, checked before any work', () => {
  it('passes a well-formed command and an interpreter through untouched', () => {
    expect(runnerOptions({ 'runner-cmd': 'node r.cjs {files} {out}', python: 'python3' })).toEqual({ runnerCommand: 'node r.cjs {files} {out}', python: 'python3' });
    expect(runnerOptions({})).toEqual({ runnerCommand: undefined, python: undefined });
  });

  it('names a malformed --runner-cmd instead of throwing', () => {
    expect(runnerOptions({ 'runner-cmd': 'node r.cjs {files}' }).error).toMatch(/\{out\}/);
    expect(runnerOptions({ 'runner-cmd': 'node r.cjs {out}' }).error).toMatch(/\{files\}/);
    expect(runnerOptions({ 'runner-cmd': 'node "r.cjs {files} {out}' }).error).toMatch(/quote/);
    // An empty command is not "no command": it was asked for and is unusable.
    expect(runnerOptions({ 'runner-cmd': '' }).error).toMatch(/\{files\}/);
  });

  it('refuses an empty --python rather than silently falling back to discovery', () => {
    expect(runnerOptions({ python: '' }).error).toMatch(/--python/);
    expect(runnerOptions({ python: '  ' }).error).toMatch(/--python/);
  });
});

describe('a malformed --runner-cmd is exit 3 with the reason, on every command that runs tests', () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-runner-options-'));
    writeFileSync(join(dir, 'a.test.mjs'), '');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const commands = () => ({
    probe: ['probe', dir],
    admit: ['admit', join(dir, 'a.test.mjs'), '--claim', 'X-001'],
    sweep: ['sweep', dir, '--changed', 'HEAD'],
    replay: ['replay', dir, '--since', 'HEAD~1..HEAD'],
  });

  for (const name of ['probe', 'admit', 'sweep', 'replay']) {
    it(name, async () => {
      const { main } = await import('../src/cli.mjs');
      for (const bad of ['node r.cjs {files}', 'node r.cjs {out}']) {
        const { lines, io } = capture();
        const code = await main([...commands()[name], '--runner-cmd', bad], io);
        const err = lines.err.join('\n');
        expect(code).toBe(3);
        expect(err).toMatch(/--runner-cmd must contain \{files\}/);
        expect(err).not.toMatch(/this is a bug in testguard/);
      }
    });
  }
});
