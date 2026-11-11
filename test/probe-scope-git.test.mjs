// Issue #234: a git failure on the `--changed` path is "could not tell", never
// "nothing changed". Every git call site on that path is stubbed to fail in
// turn, and a ledger pins the list of call sites so a new one cannot be added
// without a reviewer deciding what its failure means.
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { main } from '../src/cli.mjs';
import { resolveProbeScope, SCOPE_GIT_SITES } from '../src/probe/scope.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { commit, project } from './helpers/scope-project.mjs';

const cleanup = [];
const realPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = realPath;
  while (cleanup.length) rmSync(cleanup.pop(), { recursive: true, force: true });
});

/** The arguments (joined) that identify each call site. A stub fails the call whose arguments match. */
const SITE_ARGS = {
  'repo-root': 'rev-parse --show-toplevel',
  'resolve-ref': 'rev-parse --verify',
  'merge-base': 'merge-base',
  head: 'rev-parse HEAD',
  diff: 'diff --name-status',
  untracked: 'ls-files --others',
};

/** A `git` on PATH that behaves like the real one except for one call. */
function stubGit(match, { hang = false } = {}) {
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = mkdtempSync(join(tmpdir(), 'tg-git-stub-'));
  cleanup.push(bin);
  const stub = join(bin, 'git');
  writeFileSync(stub, `#!/bin/sh\ncase "$*" in\n  *"${match}"*) ${hang ? 'sleep 5' : 'echo "fatal: stubbed failure" >&2; exit 128'};;\nesac\nexec "${real}" "$@"\n`);
  chmodSync(stub, 0o755);
  process.env.PATH = `${bin}${delimiter}${realPath}`;
}

const capture = () => {
  const lines = { out: [], err: [] };
  return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } };
};

describe('git failing at each call site on the --changed path', () => {
  it.each(Object.keys(SITE_ARGS))('%s: exits 2, reports undetermined, probes nothing and never reads as an empty change', async (site) => {
    const p = project();
    cleanup.push(p.root);
    // Real changes exist, so a failure read as "no change" would be visibly wrong only if it narrowed the run.
    writeFileSync(join(p.dir, 'src/tax.mjs'), 'export const tax = (n) => n * 2 + 0;\n');
    commit(p.dir);
    stubGit(SITE_ARGS[site]);
    const c = capture();
    const code = await main(['probe', p.dir, '--changed', p.base, '--include-dirty', '--json', '--runner', 'node-test'], c.io);
    expect(code).toBe(2);
    const doc = JSON.parse(c.lines.out.join('\n'));
    expect(validate('status', doc).errors).toEqual([]);
    expect(doc.run.scope.changed).toMatchObject({ ref: p.base, outcome: 'undetermined' });
    expect(doc.run.scope.changed.reason.message).toContain(site);
    expect(doc.run.scope).not.toHaveProperty('selectedCount');
    expect(doc.run).not.toHaveProperty('id');
    expect(c.lines.err.join('\n')).toMatch(/Nothing was probed/);
    expect(existsSync(join(p.dir, '.testguard'))).toBe(false);
  });

  it.each([
    ['resolve-ref', 'ref-unresolved'],
    ['merge-base', 'no-merge-base'],
    ['repo-root', 'git-failed'],
    ['head', 'git-failed'],
    ['diff', 'git-failed'],
    ['untracked', 'git-failed'],
  ])('%s failing is classified %s', (site, kind) => {
    const p = project();
    cleanup.push(p.root);
    stubGit(SITE_ARGS[site]);
    const result = resolveProbeScope({ projectDir: p.dir, claims: JSON.parse(readFileSync(join(p.dir, 'testguard.claims.json'), 'utf8')), ref: p.base, includeDirty: true });
    expect(result).toMatchObject({ outcome: 'undetermined', reason: { kind } });
  });

  it('a git that does not finish in time is git-timeout, not "no change"', () => {
    const p = project();
    cleanup.push(p.root);
    stubGit('merge-base', { hang: true });
    const result = resolveProbeScope({ projectDir: p.dir, claims: JSON.parse(readFileSync(join(p.dir, 'testguard.claims.json'), 'utf8')), ref: p.base, timeoutMs: 200 });
    expect(result).toMatchObject({ outcome: 'undetermined', reason: { kind: 'git-timeout' } });
    expect(result.reason.message).toMatch(/timed out after 200 ms/);
  });

  it('a shallow history with no merge base explains how to fetch one', () => {
    const p = project();
    cleanup.push(p.root);
    stubGit('merge-base');
    const result = resolveProbeScope({ projectDir: p.dir, claims: JSON.parse(readFileSync(join(p.dir, 'testguard.claims.json'), 'utf8')), ref: p.base });
    expect(result.reason.message).toMatch(/fetch-depth: 0/);
  });
});

describe('the ledger of git call sites on the --changed path', () => {
  const source = readFileSync(new URL('../src/probe/scope.mjs', import.meta.url), 'utf8');

  it('lists exactly the sites src/probe/scope.mjs calls, and every one is stubbed above', () => {
    const called = [...source.matchAll(/runSite\('([a-z-]+)'/g)].map((m) => m[1]);
    expect(called.sort()).toEqual([...SCOPE_GIT_SITES].sort());
    expect(Object.keys(SITE_ARGS).sort()).toEqual([...SCOPE_GIT_SITES].sort());
    // Reviewed on 2026-11-10. A new site means a new line here AND a decision about what its failure means.
    expect([...SCOPE_GIT_SITES]).toEqual(['repo-root', 'resolve-ref', 'merge-base', 'head', 'diff', 'untracked']);
  });

  it('reaches git only through runSite: no other call, no process spawn, no other git helper', () => {
    expect(source.match(/\bgit\(/g)).toHaveLength(1); // the one inside runSite
    expect(source).not.toMatch(/spawnSync|execFileSync|execSync|\bspawn\(|gitRaw|headSha|repoRoot|isAncestor|snapshotWorkingTree/);
    expect(source).toMatch(/import \{ git, GitError \} from '..\/git\.mjs';/);
  });

  it('imports exactly the reviewed set of modules, so a new dependency that shells out is a visible edit', () => {
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(['../gate/changed.mjs', '../git.mjs', '../util/glob.mjs', './attribution.mjs', './dependencies.mjs', './discover.mjs', './runners/shared.mjs', 'node:fs', 'node:path']);
  });
});
