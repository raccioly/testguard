// @req NFR-05 NFR-06
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { artifactName, evaluateEvidence, expectedFaults, MANIFEST_KIND, pickArtifact, verifyDirectory, verifyFromGitHub } from '../.github/scripts/release-evidence.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';
import { ROOT } from './helpers/release-project.mjs';

const TREE = 'a'.repeat(40);
const OTHER_TREE = 'b'.repeat(40);
const claimsDoc = { claims: [{ id: 'C1', faults: [{ id: 'F1' }, { id: 'F2' }] }, { id: 'C2', faults: [{ id: 'F1' }] }] };
const record = (claim, fault, verdict = 'killed') => ({ claim: { id: claim }, subject: { id: fault }, verdict });
const fullRecords = () => [record('C1', 'F1'), record('C1', 'F2'), record('C2', 'F1')];
const manifest = (over = {}) => ({ schema: 1, kind: MANIFEST_KIND, tree: TREE, commit: 'c'.repeat(40), version: '1.2.3', faults: 3, ...over });
const evidence = (over = {}) => ({ run: { repo: { head: 'c'.repeat(40), dirty: false } }, records: fullRecords(), ...over });
const check = (over = {}) => evaluateEvidence({ manifest: manifest(), evidence: evidence(), tree: TREE, version: '1.2.3', claimsDoc, ...over });

describe('release evidence: what a clean full probe of this tree is', () => {
  it('accepts a complete probe in which every declared fault was killed', () => {
    expect(check()).toEqual([]);
  });

  it('names the artifact by the tree hash and refuses anything that is not one', () => {
    expect(artifactName(TREE)).toBe(`release-evidence-${TREE}`);
    for (const bad of [undefined, '', 'main', 'v1.2.3', 'a'.repeat(39), `${TREE}\nx`]) expect(() => artifactName(bad)).toThrow(/not a git tree hash/);
  });

  it('lists every claim/fault pair a claims document declares', () => {
    expect(expectedFaults(claimsDoc)).toEqual(['C1/F1', 'C1/F2', 'C2/F1']);
  });

  it('refuses evidence of another tree, another version or a wrong manifest', () => {
    expect(check({ manifest: manifest({ tree: OTHER_TREE }) }).join()).toMatch(/manifest is for tree b+/);
    expect(check({ manifest: manifest({ version: '1.2.4' }) }).join()).toMatch(/version 1\.2\.4, this release is 1\.2\.3/);
    expect(check({ manifest: manifest({ kind: 'other' }) }).join()).toMatch(/not a release-evidence manifest/);
    expect(check({ manifest: manifest({ schema: 2 }) }).join()).toMatch(/not a release-evidence manifest/);
  });

  it('refuses a survivor, a timeout or any verdict but killed', () => {
    for (const verdict of ['survived', 'nocover', 'unverifiable', 'timeout', 'fault-invalid', 'flaky-defender']) {
      const problems = check({ evidence: evidence({ records: [record('C1', 'F1', verdict), record('C1', 'F2'), record('C2', 'F1')] }) });
      expect(problems.join(), verdict).toMatch(new RegExp(`1 fault\\(s\\) not killed, first: C1/F1 \\(${verdict}\\)`));
    }
  });

  it('refuses a scoped or older probe: every fault the tree declares must be covered, and none it does not', () => {
    expect(check({ evidence: evidence({ records: [record('C1', 'F1')] }) }).join()).toMatch(/does not cover 2 fault\(s\).*first: C1\/F2.*scoped or older/);
    expect(check({ evidence: evidence({ records: [...fullRecords(), record('C9', 'F1')] }) }).join()).toMatch(/1 fault\(s\) this tree's claims do not declare, first: C9\/F1/);
  });

  it('refuses provisional, budget-exhausted and dirty-tree evidence, and empty evidence', () => {
    expect(check({ evidence: evidence({ run: { provisional: true, repo: { head: 'c'.repeat(40), dirty: false } } }) }).join()).toMatch(/provisional/);
    expect(check({ evidence: evidence({ run: { budget: { exhausted: true }, repo: { head: 'c'.repeat(40), dirty: false } } }) }).join()).toMatch(/ran out of its command budget/);
    expect(check({ evidence: evidence({ run: { repo: { head: 'c'.repeat(40), dirty: true } } }) }).join()).toMatch(/dirty working tree/);
    expect(check({ evidence: evidence({ records: [] }) }).join()).toMatch(/no records/);
  });

  it('refuses records whose verdict was reused from an earlier probe: the release probe must measure this tree', () => {
    const reused = { ...record('C1', 'F1'), reusedFrom: { runId: 'old' } };
    expect(check({ evidence: evidence({ records: [reused, record('C1', 'F2'), record('C2', 'F1')] }) }).join()).toMatch(/1 record\(s\) carry a verdict reused.*C1\/F1/);
  });

  it('with --miss-is-notice a miss is a ::notice:: and still exit 1 (the first run of a release branch expects one)', () => {
    const bad = artifactDir({ 'manifest.json': manifest({ tree: OTHER_TREE }), 'evidence.json': evidence() });
    const r = spawnSync(process.execPath, [join(ROOT, '.github/scripts/release-evidence.mjs'), 'verify', '--tree', TREE, '--from-dir', bad.dir, '--claims', bad.claims, '--miss-is-notice'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/::notice::no usable release evidence yet/);
    expect(r.stderr).not.toContain('::error::');
  });

  it('refuses a manifest whose commit is not the commit the evidence probed', () => {
    expect(check({ manifest: manifest({ commit: 'd'.repeat(40) }) }).join()).toMatch(/is not the commit the evidence probed/);
  });
});

const artifact = (over = {}) => ({ id: 7, name: artifactName(TREE), expired: false, created_at: '2026-11-12T10:00:00Z', workflow_run: { id: 70, head_branch: 'release/v1.2.3', head_repository_id: 1, repository_id: 1 }, ...over });
const ciRuns = { 70: { path: '.github/workflows/ci.yml' }, 71: { path: '.github/workflows/ci.yml' }, 72: { path: '.github/workflows/other.yml' } };
const pick = (artifacts) => pickArtifact({ artifacts }, { name: artifactName(TREE), runs: ciRuns });

describe('release evidence: which artifact may be believed', () => {
  it('takes the newest unexpired artifact of a ci.yml run on a release branch of this repository', () => {
    const newer = artifact({ id: 8, created_at: '2026-11-12T11:00:00Z', workflow_run: { id: 71, head_branch: 'release/v1.2.3', head_repository_id: 1, repository_id: 1 } });
    expect(pick([artifact(), newer]).artifact.id).toBe(8);
  });

  it('refuses expired, wrong-branch, fork and wrong-workflow artifacts, saying why', () => {
    const cases = [
      [artifact({ expired: true }), /has expired/],
      [artifact({ workflow_run: { id: 70, head_branch: 'main', head_repository_id: 1, repository_id: 1 } }), /not a release branch/],
      [artifact({ workflow_run: { id: 70, head_branch: 'release/v1.2.3', head_repository_id: 2, repository_id: 1 } }), /another repository/],
      [artifact({ workflow_run: { id: 72, head_branch: 'release/v1.2.3', head_repository_id: 1, repository_id: 1 } }), /not produced by \.github\/workflows\/ci\.yml/],
      [artifact({ workflow_run: { id: 70, head_branch: 'release/v1.2.3' } }), /another repository/],
    ];
    for (const [a, why] of cases) {
      const r = pick([a]);
      expect(r.artifact).toBeUndefined();
      expect(r.reasons.join()).toMatch(why);
    }
  });

  it('ignores an artifact with another name', () => {
    expect(pick([artifact({ name: artifactName(OTHER_TREE) })]).artifact).toBeUndefined();
  });
});

function artifactDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'tg-release-evidence-test-'));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
  const claims = join(dir, 'claims.json');
  writeFileSync(claims, JSON.stringify(claimsDoc));
  return { dir, claims };
}

describe('release evidence: verifying a downloaded artifact', () => {
  it('passes a good directory and reports an unreadable one instead of throwing', () => {
    const good = artifactDir({ 'manifest.json': manifest(), 'evidence.json': evidence() });
    expect(verifyDirectory({ dir: good.dir, tree: TREE, version: '1.2.3', claimsPath: good.claims })).toEqual([]);
    const bad = artifactDir({ 'manifest.json': 'not json', 'evidence.json': evidence() });
    expect(verifyDirectory({ dir: bad.dir, tree: TREE, version: '1.2.3', claimsPath: bad.claims }).join()).toMatch(/artifact is unreadable/);
  });

  const fakeIo = (listing, files, calls = []) => ({
    listArtifacts: () => listing,
    run: (_repo, id) => ciRuns[id] ?? { path: 'x' },
    download: (_repo, id, dir) => { calls.push(id); for (const [n, v] of Object.entries(files)) writeFileSync(join(dir, n), JSON.stringify(v)); },
  });

  it('finds, downloads and verifies through the API, and succeeds only when everything holds', () => {
    const { claims } = artifactDir({});
    const calls = [];
    const ok = verifyFromGitHub({ repo: 'o/r', tree: TREE, version: '1.2.3', claimsPath: claims, io: fakeIo({ artifacts: [artifact()] }, { 'manifest.json': manifest(), 'evidence.json': evidence() }, calls) });
    expect(ok.ok).toBe(true);
    expect(calls).toEqual([7]);
  });

  it('fails closed when there is no artifact, when listing throws, when download throws, and when the content is for another tree', () => {
    const { claims } = artifactDir({});
    const run = (io) => verifyFromGitHub({ repo: 'o/r', tree: TREE, version: '1.2.3', claimsPath: claims, io });
    expect(run(fakeIo({ artifacts: [] }, {})).problems.join()).toMatch(/no usable artifact named release-evidence-a+.*never produced a full clean probe/);
    expect(run({ listArtifacts: () => { throw new Error('403'); } }).problems.join()).toMatch(/could not list artifacts.*403/);
    const failing = fakeIo({ artifacts: [artifact()] }, {});
    failing.download = () => { throw new Error('gone'); };
    expect(run(failing).problems.join()).toMatch(/could not download artifact 7: gone/);
    const wrongTree = run(fakeIo({ artifacts: [artifact()] }, { 'manifest.json': manifest({ tree: OTHER_TREE }), 'evidence.json': evidence() }));
    expect(wrongTree.ok).toBe(false);
    expect(wrongTree.problems.join()).toMatch(/manifest is for tree/);
  });
});

describe('release-evidence.mjs as a command (the dry run needs no network)', () => {
  const script = join(ROOT, '.github', 'scripts', 'release-evidence.mjs');
  const run = (args, cwd = ROOT) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd, env: { ...process.env, PATH: '/usr/bin:/bin' } });

  it('verify --from-dir exits 0 for a good artifact directory and 1, with an ::error::, for a bad one', () => {
    const good = artifactDir({ 'manifest.json': manifest(), 'evidence.json': evidence() });
    const ok = run(['verify', '--tree', TREE, '--version', '1.2.3', '--from-dir', good.dir, '--claims', good.claims]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain(`release-evidence-${TREE}`);
    const bad = artifactDir({ 'manifest.json': manifest({ tree: OTHER_TREE }), 'evidence.json': evidence() });
    const refused = run(['verify', '--tree', TREE, '--from-dir', bad.dir, '--claims', bad.claims]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/::error::release evidence: manifest is for tree/);
    expect(refused.stderr).toContain('reprobe=true');
  });

  it('prints the artifact name, and a usage error is exit 2', () => {
    expect(run(['name', '--tree', TREE]).stdout.trim()).toBe(`release-evidence-${TREE}`);
    expect(run(['verify']).status).toBe(2);
    expect(run(['write']).status).toBe(2);
    expect(run(['bogus']).status).toBe(2);
  });

  it('write packages a clean full probe of HEAD keyed by its tree, and refuses a survivor', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tg-release-write-'));
    const git = (...a) => spawnSync('git', [...FIXTURE_GIT, '-C', repo, ...a], { encoding: 'utf8' });
    git('init', '-q', '--initial-branch=main');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    writeFileSync(join(repo, 'claims.json'), JSON.stringify(claimsDoc));
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'x');
    const head = git('rev-parse', 'HEAD').stdout.trim();
    const tree = git('rev-parse', 'HEAD^{tree}').stdout.trim();
    const goodEvidence = join(repo, 'ev.json');
    writeFileSync(goodEvidence, JSON.stringify(evidence({ run: { repo: { head, dirty: false } } })));
    const out = join(repo, 'out');
    const ok = run(['write', '--evidence', goodEvidence, '--out-dir', out, '--claims', join(repo, 'claims.json')], repo);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain(`release-evidence-${tree}`);
    expect(run(['verify', '--tree', tree, '--version', '1.2.3', '--from-dir', out, '--claims', join(repo, 'claims.json')], repo).status).toBe(0);
    const surv = join(repo, 'surv.json');
    writeFileSync(surv, JSON.stringify(evidence({ run: { repo: { head, dirty: false } }, records: [record('C1', 'F1', 'survived'), record('C1', 'F2'), record('C2', 'F1')] })));
    const refused = run(['write', '--evidence', surv, '--out-dir', join(repo, 'out2'), '--claims', join(repo, 'claims.json')], repo);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/not written: .*not killed/);
  });
});
