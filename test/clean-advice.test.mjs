// `status` and `brief` say when interrupted runs left scratch behind (#311):
// one advice line with the command, from a bounded look under the scratch root.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { orphanAdvice, renderAdvice } from '../src/status/advice.mjs';
import { computeStatus } from '../src/status/status.mjs';
import { ownersDir } from '../src/clean/owner.mjs';
import { withScratchBase } from '../src/scratch-dir.mjs';
import { validate } from '../spec/lib/validate.mjs';

// Real git repositories and real child processes: a loaded machine (a fan-out of probes) must not turn a slow start into a failure.
vi.setConfig({ testTimeout: 30_000 });
const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
const dir = (prefix) => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(d); return d; };

describe('the advice line', () => {
  it('is one line naming the count and the command, and absent when there is nothing', () => {
    expect(orphanAdvice(0)).toBeUndefined();
    expect(orphanAdvice(1)).toEqual({ id: 'orphaned-scratch', message: expect.stringMatching(/^1 scratch entry left by interrupted runs is taking disk space/), command: 'testguard clean' });
    expect(orphanAdvice(2181).message).toMatch(/^2181 scratch entries left by interrupted runs are taking disk space/);
    expect(renderAdvice([orphanAdvice(3)])[0]).toMatch(/→ testguard clean$/);
  });
});

describe('status reads the scratch root', () => {
  const project = () => { const p = dir('tg-clean-advice-'); writeFileSync(join(p, 'package.json'), '{}'); return p; };
  const abandon = (base, name) => {
    mkdirSync(join(base, name), { recursive: true });
    mkdirSync(ownersDir(base), { recursive: true });
    writeFileSync(join(ownersDir(base), `${name}.json`), JSON.stringify({ pid: 2 ** 22 + 99, host: hostname(), at: 'x' }));
  };

  it('advises testguard clean when an owner is gone, and the document conforms', () => {
    const base = dir('tg-clean-advice-base-');
    abandon(base, 'testguard-abcdef');
    abandon(base, 'testguard-ghijkl');
    const doc = withScratchBase(base, () => computeStatus({ projectDir: project(), toolVersion: '0.26.0' }));
    expect(doc.advice).toEqual([expect.objectContaining({ id: 'orphaned-scratch', command: 'testguard clean', message: expect.stringMatching(/^2 scratch entries/) })]);
    expect(validate('status', doc).errors).toEqual([]);
  });

  it('says nothing for a clean scratch root, a live owner or a young tree with no record', () => {
    const base = dir('tg-clean-advice-base-');
    mkdirSync(join(base, 'testguard-young01'));
    mkdirSync(join(base, 'testguard-live001'));
    mkdirSync(ownersDir(base), { recursive: true });
    writeFileSync(join(ownersDir(base), 'testguard-live001.json'), JSON.stringify({ pid: process.pid, host: hostname(), at: 'x' }));
    const doc = withScratchBase(base, () => computeStatus({ projectDir: project(), toolVersion: '0.26.0' }));
    expect(doc.advice).toBeUndefined();
  });

  it('does not count the leftover owner record of a tree that is already gone', () => {
    const base = dir('tg-clean-advice-base-');
    mkdirSync(ownersDir(base), { recursive: true });
    writeFileSync(join(ownersDir(base), 'testguard-zzzzzz.json'), JSON.stringify({ pid: 2 ** 22 + 99, host: hostname(), at: 'x' }));
    expect(withScratchBase(base, () => computeStatus({ projectDir: project(), toolVersion: '0.26.0' })).advice).toBeUndefined();
  });

  it('a caller that asked for no advice gets none, however much is left', () => {
    const base = dir('tg-clean-advice-base-');
    abandon(base, 'testguard-abcdef');
    expect(withScratchBase(base, () => computeStatus({ projectDir: project(), toolVersion: '0.26.0', advice: false })).advice).toBeUndefined();
  });
});
