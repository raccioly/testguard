import {describe,it,expect} from 'vitest';
import {rmSync} from 'node:fs';
import {detectChangedRef,detectLocalChangedRef} from '../src/gate/changed.mjs';
import {main} from '../src/cli.mjs';
import {repo} from './helpers/gate-project.mjs';
const capture=()=>{const lines={out:[],err:[]};return {lines,io:{out:s=>lines.out.push(s),err:s=>lines.err.push(s)}};};

describe('detectChangedRef', () => {
  it('prefers the explicit variable, then GitHub, then GitLab, and never guesses', () => {
    expect(detectChangedRef({ TESTGUARD_CHANGED_REF: 'origin/develop', GITHUB_BASE_REF: 'main' })).toEqual({ ref: 'origin/develop', from: 'TESTGUARD_CHANGED_REF' });
    expect(detectChangedRef({ GITHUB_BASE_REF: 'main' })).toEqual({ ref: 'origin/main', from: 'GITHUB_BASE_REF' });
    expect(detectChangedRef({ CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'release' })).toEqual({ ref: 'origin/release', from: 'CI_MERGE_REQUEST_TARGET_BRANCH_NAME' });
    // GitLab: the exact diff base sha wins over the branch name (no fetch needed on a shallow clone); an all-zero sha is ignored
    expect(detectChangedRef({ CI_MERGE_REQUEST_DIFF_BASE_SHA: 'a'.repeat(40), CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'release' })).toEqual({ ref: 'a'.repeat(40), from: 'CI_MERGE_REQUEST_DIFF_BASE_SHA' });
    expect(detectChangedRef({ CI_MERGE_REQUEST_DIFF_BASE_SHA: '0'.repeat(40), CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'release' })).toEqual({ ref: 'origin/release', from: 'CI_MERGE_REQUEST_TARGET_BRANCH_NAME' });
    expect(detectChangedRef({})).toBeNull();
  });
});

describe('detectLocalChangedRef', () => {
  it('uses a remote default from a feature branch, but never the current branch\'s same-name remote', () => {
    const r = repo();
    try {
      r.g('branch', '-M', 'main');
      r.g('remote', 'add', 'origin', 'https://example.invalid/repo.git');
      r.g('update-ref', 'refs/remotes/origin/main', 'HEAD');
      r.g('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
      expect(detectLocalChangedRef(r.project)).toBeNull();

      r.g('switch', '-q', '-c', 'feature');
      r.g('update-ref', 'refs/remotes/origin/feature', 'HEAD');
      r.g('branch', '--set-upstream-to', 'origin/feature');
      expect(detectLocalChangedRef(r.project)).toEqual({ ref: 'origin/main', from: 'remote default branch' });

      r.g('update-ref', '-d', 'refs/remotes/origin/main');
      expect(detectLocalChangedRef(r.project)).toBeNull();
      r.g('update-ref', 'refs/remotes/origin/main', 'HEAD');
      r.g('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
      expect(detectLocalChangedRef(r.project)).toBeNull();
      r.g('branch', '--set-upstream-to', 'origin/main');
      expect(detectLocalChangedRef(r.project)).toEqual({ ref: 'origin/main', from: 'branch upstream' });
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  it('makes a bare gate work in an ordinary clone and says how the base was chosen', async () => {
    const r = repo();
    const saved = { ...process.env };
    try {
      delete process.env.TESTGUARD_CHANGED_REF; delete process.env.GITHUB_BASE_REF; delete process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA; delete process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME;
      r.g('branch', '-M', 'main');
      r.g('remote', 'add', 'origin', 'https://example.invalid/repo.git');
      r.g('update-ref', 'refs/remotes/origin/main', 'HEAD');
      r.g('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
      r.g('switch', '-q', '-c', 'feature');
      r.write('src/newfeature.mjs', 'export const f = () => 1;\n');
      const a = capture();
      expect(await main(['gate', r.project, '--include-dirty'], a.io)).toBe(1);
      expect(a.lines.err).toEqual(['gate: comparing against origin/main (remote default branch)']);
      expect(a.lines.out.join('\n')).toMatch(/UNCLAIMED\s+src\/newfeature\.mjs/);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      rmSync(r.root, { recursive: true, force: true });
    }
  });
});

describe('resolveChangedRef / withChangedRef', () => {
  it('an explicit reference is required: failure propagates; a detected one degrades to a warning and no measurement', async () => {
    const { resolveChangedRef, withChangedRef } = await import('../src/gate/changed.mjs');
    const { GitError } = await import('../src/git.mjs');
    const boom = () => { throw new GitError('cannot resolve --changed nope: fatal. In CI, check out with full history'); };
    expect(resolveChangedRef({ explicit: 'origin/x', env: { GITHUB_BASE_REF: 'main' } })).toEqual({ ref: 'origin/x', from: '--changed', required: true });
    expect(resolveChangedRef({ env: {} })).toBeNull();
    expect(() => withChangedRef({ ref: 'nope', from: '--changed', required: true }, (ref) => (ref ? boom() : 'none'))).toThrow(GitError);
    const warnings = [];
    expect(withChangedRef({ ref: 'origin/main', from: 'GITHUB_BASE_REF', required: false }, (ref) => (ref ? boom() : 'none'), (m) => warnings.push(m))).toBe('none');
    expect(warnings[0]).toMatch(/change coverage skipped: origin\/main \(from GITHUB_BASE_REF\)/);
    expect(() => withChangedRef({ ref: 'origin/main', from: 'GITHUB_BASE_REF', required: false }, () => { throw new TypeError('bug'); })).toThrow(TypeError);
    expect(withChangedRef(null, (ref) => ref ?? 'none')).toBe('none');
  });

  it('status in a CI-like environment on a directory with no base branch still answers, with a warning on stderr', async () => {
    const r = repo();
    const saved = { ...process.env };
    try {
      process.env.GITHUB_BASE_REF = 'main'; // origin/main does not exist in the scratch repo
      const a = capture();
      expect(await main(['status', r.project, '--json'], a.io)).toBe(2); // unprobed → 2
      expect(JSON.parse(a.lines.out.join('\n')).state).toBe('unprobed');
      expect(a.lines.err.join('\n')).toMatch(/change coverage skipped: origin\/main \(from GITHUB_BASE_REF\)/);
      const b = capture();
      expect(await main(['status', r.project, '--json', '--changed', 'origin/main'], b.io)).toBe(2);
      expect(b.lines.err.join('\n')).toMatch(/cannot resolve --changed origin\/main/);
      expect(b.lines.out).toEqual([]);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      rmSync(r.root, { recursive: true, force: true });
    }
  });
});
