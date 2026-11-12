// @req NFR-05 NFR-06
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { decideScope, FULL_PROBE_PATHS } from '../.github/scripts/self-probe-scope.mjs';
import { awaitMergeable, judge } from '../.github/scripts/await-mergeable.mjs';
import { probeTarball, tarballUrl, waitForTarball } from '../.github/scripts/wait-for-tarball.mjs';
import { blockers, waitUntilClear } from '../.github/scripts/release-preflight.mjs';
import { ROOT } from './helpers/release-project.mjs';

/** A clock the test owns: `sleep` advances it, so a bounded wait is exercised without waiting. */
const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; }, at: () => t };
};

describe('self-probe-scope: a pull request probes only what it can affect', () => {
  const pr = (changedFiles, over = {}) => decideScope({ event: 'pull_request', headRef: 'feature/x', changedFiles, ...over });

  it('scopes an ordinary pull request and says what it looked at', () => {
    const d = pr(['src/gate/changed.mjs', 'test/gate.test.mjs', 'README.md']);
    expect(d.mode).toBe('scoped');
    expect(d.reasons.join()).toContain('3 changed file(s)');
  });

  it('probes in full on every event that is not a pull request: push to main, nightly, dispatch', () => {
    for (const event of ['push', 'schedule', 'workflow_dispatch']) {
      const d = decideScope({ event, refName: 'main', changedFiles: ['README.md'] });
      expect(d.mode, event).toBe('full');
      expect(d.reasons.join()).toContain(event);
    }
  });

  it('probes a release branch in full, whatever it changed: that probe is the one the release verifies', () => {
    expect(pr(['package.json'], { headRef: 'release/v1.2.3' }).mode).toBe('full');
    expect(pr(['README.md'], { headRef: 'release/v1.2.3' }).reasons.join()).toContain('release branch');
    expect(decideScope({ event: 'workflow_dispatch', refName: 'release/v1.2.3', changedFiles: [] }).mode).toBe('full');
  });

  it('probes in full when the change can alter every verdict, naming the files', () => {
    for (const file of ['src/probe/classify.mjs', 'src/probe/runners/vitest.mjs', 'spec/schemas/evidence.schema.json', 'cli/testguard.mjs', 'fixtures/known-answer/expected.json', 'testguard.cost-budget.json', 'package.json', 'package-lock.json', 'vitest.config.mjs', '.github/workflows/ci.yml', '.github/scripts/self-probe-scope.mjs']) {
      const d = pr(['README.md', file]);
      expect(d.mode, file).toBe('full');
      expect(d.reasons.join(), file).toContain(file);
    }
  });

  it('does not mistake a lookalike path for a protected one', () => {
    for (const file of ['src/probe-notes.md', 'src/probes/x.mjs', 'spec-notes.md', 'docs/spec/x.md', 'cli-notes.md', '.github/workflows/release.yml', 'package.json.bak']) expect(pr([file]).mode, file).toBe('scoped');
  });

  it('never narrows when it does not know what changed', () => {
    const d = pr(undefined);
    expect(d.mode).toBe('full');
    expect(d.reasons.join()).toContain('could not be determined');
  });

  it('lists its protected paths in one place', () => {
    expect(FULL_PROBE_PATHS).toEqual(expect.arrayContaining(['src/probe/', 'spec/', 'cli/', 'fixtures/', '.github/workflows/ci.yml']));
  });

  it('as a command: reads the changed files, prints the decision, writes mode= to GITHUB_OUTPUT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-scope-'));
    const files = join(dir, 'files.txt');
    const out = join(dir, 'out.txt');
    const run = (list, extra = []) => {
      writeFileSync(files, list);
      writeFileSync(out, '');
      const r = spawnSync(process.execPath, [join(ROOT, '.github/scripts/self-probe-scope.mjs'), '--event', 'pull_request', '--head-ref', 'feature/x', '--files-from', files, ...extra], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: '' } });
      return { r, mode: readFileSync(out, 'utf8').trim() };
    };
    const scoped = run('test/a.test.mjs\nsrc/gate/x.mjs\n');
    expect(scoped.r.status, scoped.r.stderr).toBe(0);
    expect(scoped.mode).toBe('mode=scoped\nclaim_ids=');
    expect(scoped.r.stdout).toMatch(/does NOT prove|proves only the claims/);
    const full = run('src/probe/probe.mjs\n');
    expect(full.mode).toBe('mode=full\nclaim_ids=');
    expect(full.r.stdout).toContain('src/probe/probe.mjs');
    expect(spawnSync(process.execPath, [join(ROOT, '.github/scripts/self-probe-scope.mjs')], { encoding: 'utf8' }).status).toBe(2);
  });
});

describe('wait-for-tarball: nothing downstream runs before the registry serves the file', () => {
  const gz = new Uint8Array([0x1f, 0x8b, 8, 0]);
  const res = (status, body = gz) => ({ status, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) });

  it('names the registry tarball', () => {
    const v = ['1', '2', '3'].join('.');
    expect(tarballUrl('https://registry.npmjs.org/', v)).toBe(`https://registry.npmjs.org/testguard-cli/-/testguard-cli-${v}.tgz`);
  });

  it('accepts only a 200 whose body is gzip: an error page with a 200 is not a tarball', async () => {
    expect((await probeTarball('u', async () => res(200))).ok).toBe(true);
    expect(await probeTarball('u', async () => res(404))).toMatchObject({ ok: false, why: 'HTTP 404' });
    expect((await probeTarball('u', async () => res(200, new TextEncoder().encode('<html>Not found</html>')))).why).toMatch(/200 but not a gzip tarball/);
    expect((await probeTarball('u', async () => { throw new Error('ECONNRESET'); })).why).toMatch(/network error: ECONNRESET/);
  });

  it('polls until the tarball appears, with the wait between attempts', async () => {
    const c = clock();
    const answers = [404, 404, 200];
    const r = await waitForTarball({ url: 'u', waitMs: 600000, intervalMs: 15000, fetchFn: async () => res(answers.shift()), sleep: c.sleep, now: c.now });
    expect(r).toMatchObject({ ok: true, attempts: 3 });
    expect(c.at()).toBe(30000);
  });

  it('gives up at the deadline, saying why, instead of hanging', async () => {
    const c = clock();
    const r = await waitForTarball({ url: 'u', waitMs: 60000, intervalMs: 20000, fetchFn: async () => res(404), sleep: c.sleep, now: c.now });
    expect(r).toMatchObject({ ok: false, attempts: 4, why: 'HTTP 404' });
    expect(c.at()).toBe(60000);
  });

  it('as a command: a bad wait is a usage error', () => {
    const r = spawnSync(process.execPath, [join(ROOT, '.github/scripts/wait-for-tarball.mjs'), '--version', '1.2.3', '--wait=-1'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});

describe('await-mergeable: a release pull request that cannot merge fails its workflow', () => {
  const view = (over) => ({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', autoMergeRequest: { enabledBy: 'bot' }, ...over });

  it('judges each state', () => {
    expect(judge(view()).verdict).toBe('ok');
    expect(judge(view({ mergeStateStatus: 'CLEAN' })).verdict).toBe('ok');
    expect(judge(view({ state: 'MERGED' })).verdict).toBe('ok');
    expect(judge(view({ state: 'CLOSED' })).verdict).toBe('fail');
    expect(judge(view({ mergeable: 'CONFLICTING' })).verdict).toBe('fail');
    expect(judge(view({ mergeable: 'MERGEABLE', mergeStateStatus: 'DIRTY' })).verdict).toBe('fail');
    expect(judge(view({ mergeable: 'UNKNOWN' })).verdict).toBe('wait');
    expect(judge(view({ autoMergeRequest: null })).verdict).toBe('wait');
  });

  it('fails at once on a conflict, without waiting out the bound', async () => {
    const c = clock();
    const r = await awaitMergeable({ view: async () => view({ mergeable: 'CONFLICTING' }), waitMs: 300000, intervalMs: 10000, sleep: c.sleep, now: c.now });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/conflicts with main/);
    expect(c.at()).toBe(0);
  });

  it('waits out UNKNOWN until GitHub computes it, then succeeds', async () => {
    const c = clock();
    const states = ['UNKNOWN', 'UNKNOWN', 'MERGEABLE'];
    const r = await awaitMergeable({ view: async () => view({ mergeable: states.shift() }), waitMs: 300000, intervalMs: 10000, sleep: c.sleep, now: c.now });
    expect(r.ok).toBe(true);
    expect(c.at()).toBe(20000);
  });

  it('fails at the deadline when auto-merge never arms or GitHub never answers, naming it', async () => {
    const c = clock();
    const unarmed = await awaitMergeable({ view: async () => view({ autoMergeRequest: null }), waitMs: 30000, intervalMs: 10000, sleep: c.sleep, now: c.now });
    expect(unarmed).toMatchObject({ ok: false });
    expect(unarmed.why).toMatch(/auto-merge is not armed/);
    const d = clock();
    const broken = await awaitMergeable({ view: async () => { throw new Error('502'); }, waitMs: 20000, intervalMs: 10000, sleep: d.sleep, now: d.now });
    expect(broken.ok).toBe(false);
    expect(broken.why).toMatch(/could not read the pull request: 502/);
  });
});

describe('release-preflight: the previous release lands before the next one is cut', () => {
  const pr = (headRefName) => ({ headRefName, url: `https://example.test/${headRefName}` });

  it('is blocked by an open Homebrew checksum pull request, and by a formula that does not match the tarball', () => {
    expect(blockers({ openPulls: [pr('feature/x')], formulaOk: true })).toEqual([]);
    expect(blockers({ openPulls: [pr('chore/homebrew-sha-v0.24.0')], formulaOk: true }).join()).toMatch(/homebrew-sha-v0\.24\.0.*still open/);
    expect(blockers({ openPulls: [], formulaOk: false }).join()).toMatch(/formula on main does not carry the hash/);
  });

  it('waits until the checksum lands, then clears', async () => {
    const c = clock();
    const pulls = [[pr('chore/homebrew-sha-v0.24.0')], [pr('chore/homebrew-sha-v0.24.0')], []];
    const r = await waitUntilClear({ openPulls: async () => pulls.shift(), formulaOk: async () => true, waitMs: 1800000, intervalMs: 60000, sleep: c.sleep, now: c.now });
    expect(r.ok).toBe(true);
    expect(c.at()).toBe(120000);
  });

  it('fails at the bound, with the blockers, and treats a failed check as a blocker rather than as clear', async () => {
    const c = clock();
    const stuck = await waitUntilClear({ openPulls: async () => [pr('chore/homebrew-sha-v0.24.0')], formulaOk: async () => true, waitMs: 120000, intervalMs: 60000, sleep: c.sleep, now: c.now });
    expect(stuck.ok).toBe(false);
    expect(stuck.blockers.join()).toMatch(/still open/);
    const d = clock();
    const broken = await waitUntilClear({ openPulls: async () => { throw new Error('rate limited'); }, formulaOk: async () => true, waitMs: 0, intervalMs: 60000, sleep: d.sleep, now: d.now });
    expect(broken.ok).toBe(false);
    expect(broken.blockers.join()).toMatch(/could not check: rate limited/);
  });
});
