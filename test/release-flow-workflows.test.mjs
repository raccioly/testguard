// @req NFR-05 NFR-06
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { parseYaml } from './helpers/yaml.mjs';
import { ROOT } from './helpers/release-project.mjs';

const load = (name) => parseYaml(join(ROOT, '.github', 'workflows', name))[0];
const ci = load('ci.yml');
const release = load('release.yml');
const scheduled = load('scheduled-release.yml');
const steps = (workflow, job) => workflow.jobs[job].steps;
const step = (workflow, job, name) => {
  const found = steps(workflow, job).find((s) => s.name === name);
  expect(found, `${job}: ${name}`).toBeDefined();
  return found;
};
const index = (workflow, job, name) => steps(workflow, job).findIndex((s) => s.name === name);
// `on:` parses as the boolean key true under YAML 1.1.
const triggers = (workflow) => workflow.on ?? workflow[true];

describe('ci.yml: pull requests probe what changed, everything else probes in full, sharded', () => {
  const scopeStep = step(ci, 'scope', 'Decide how much of its own claims the self-probe measures');
  const scopedProbe = step(ci, 'selfprobe-scoped', "probe TestGuard's own claims — only what this pull request can affect");

  it('decides the scope first, in its own job, passing branch names through the environment', () => {
    expect(scopeStep.run).toContain('self-probe-scope.mjs');
    expect(scopeStep.run).toContain('--base "origin/$BASE_REF"');
    expect(scopeStep.env).toMatchObject({ HEAD_REF: '${{ github.head_ref }}', EVENT_NAME: '${{ github.event_name }}' });
    for (const job of Object.values(ci.jobs)) for (const s of job.steps ?? []) expect(s.run ?? '', s.name).not.toMatch(/\$\{\{\s*github\.(head_ref|ref_name)/);
    expect(ci.jobs.scope.outputs.mode).toBe('${{ steps.scope.outputs.mode }}');
  });

  it('runs the sharded probe only in full mode and the scoped probe only in scoped mode, against the pull request base', () => {
    expect(ci.jobs.selfprobe.needs).toBe('scope');
    expect(ci.jobs.selfprobe.if).toContain("needs.scope.outputs.mode == 'full'");
    expect(ci.jobs.selfprobe.if).toContain("needs.scope.outputs.reuse != 'true'");
    expect(ci.jobs['selfprobe-scoped'].if).toBe("needs.scope.outputs.mode == 'scoped'");
    expect(scopedProbe.run).toContain('probe . --changed "origin/${{ github.base_ref }}"');
    const claimsProbe = step(ci, 'selfprobe-scoped', 'probe the claims whose entry changed in the claims file');
    expect(claimsProbe.if).toBe("needs.scope.outputs.claim_ids != ''");
    expect(claimsProbe.run).toContain('--claim "$CLAIM_IDS"');
  });

  it('shards the full probe four ways from one partition computed once, each shard probing exactly its slice', () => {
    expect(ci.jobs.selfprobe.strategy.matrix.shard).toEqual([0, 1, 2, 3]);
    expect(ci.jobs.selfprobe.strategy['fail-fast']).toBe(false);
    expect(step(ci, 'scope', 'Plan the shards of the full probe').run).toContain('shard-probe.mjs plan --shards 4');
    const probe = step(ci, 'selfprobe', "probe this shard's claims");
    expect(probe.env.SHARD_CLAIMS).toBe('${{ fromJSON(needs.scope.outputs.shards)[matrix.shard] }}');
    expect(probe.run).toContain('--claim "$SHARD_CLAIMS"');
    expect(probe.run).not.toContain('--changed');
    expect(probe.run).toContain('--no-reuse');
    expect(steps(ci, 'selfprobe').some((s) => /actions\/cache/.test(s.uses ?? ''))).toBe(false);
  });

  it('merges the shards, requiring every fault exactly once, and gates the SUM of their cost', () => {
    const merge = index(ci, 'selfprobe-gate', 'Merge the shards into one evidence document');
    const cost = index(ci, 'selfprobe-gate', 'The gate must stay inside its cost budget');
    expect(index(ci, 'selfprobe-gate', 'Collect the shards')).toBeLessThan(merge);
    expect(merge).toBeLessThan(cost);
    expect(steps(ci, 'selfprobe-gate')[merge].run).toContain('shard-probe.mjs merge --dir shards');
    expect(steps(ci, 'selfprobe-gate')[cost].run).toContain('check-shard-cost.mjs shards');
  });

  it('keeps `test (22)` a required check: the last job carries that name and stands for the unit legs, the scope and the probe pipeline', () => {
    const gate = ci.jobs['selfprobe-gate'];
    expect(gate.name).toBe('test (22)');
    expect(gate.if).toBe('always()');
    expect(gate.needs).toEqual(['scope', 'test', 'selfprobe', 'selfprobe-scoped']);
    const check = gate.steps[0].run;
    for (const must of ['R_SCOPE', 'R_TEST', 'R_SHARDS', 'R_SCOPED']) expect(check).toContain(`[ "$${must}" = success ]`);
    expect(ci.jobs.test.name).toContain("'checks (22)'");
    expect(ci.jobs.test.name).toContain("format('test ({0})', matrix.node-version)");
  });

  it('gates the cost of a full run and only reports the cost of a scoped one', () => {
    expect(step(ci, 'selfprobe-gate', 'The gate must stay inside its cost budget').if).toContain("env.MODE == 'full'");
    expect(step(ci, 'selfprobe-scoped', 'Cost of the scoped run (reported, not gated)').run).toContain('--report-only');
  });

  it('keeps the anchor preflight, the claims diff and the changed-file gate on every pull request', () => {
    expect(step(ci, 'test', 'claims — fault anchors and replacements are valid').run).toContain('--check-anchors');
    expect(step(ci, 'test', 'claims — fault anchors and replacements are valid').if).toBe('matrix.node-version == 22');
    expect(step(ci, 'test', 'gate — every changed source file carries a claim').if).toBe("github.event_name == 'pull_request'");
    expect(step(ci, 'test', 'claims — no claim or fault removed without a reason').if).toBe("github.event_name == 'pull_request'");
  });

  it('adds a nightly full run: the test job and the probe, nothing else', () => {
    expect(triggers(ci).schedule).toHaveLength(1);
    for (const job of ['native-node-floor', 'python', 'playwright', 'hermeticity']) expect(ci.jobs[job].if, job).toBe("github.event_name != 'schedule'");
    expect(ci.jobs.test.if).toBeUndefined();
  });

  it('keeps the branch-named evidence for full runs only: a scoped run is partial', () => {
    expect(step(ci, 'selfprobe-gate', 'Upload evidence under a stable, branch-named artifact').if).toContain("env.MODE == 'full'");
  });
});

describe('ci.yml: the release tree is probed in full once and the evidence is keyed by its tree', () => {
  const pkg = step(ci, 'selfprobe-gate', 'Release branch — package the full probe, keyed by the tree hash');
  const upload = step(ci, 'selfprobe-gate', 'Release branch — upload the release evidence');
  const reuse = step(ci, 'scope', 'Release branch — is this tree already probed in full?');

  it("looks for an earlier run's evidence of the same tree before probing, and skips the probe when it is there", () => {
    expect(reuse.run).toContain('release-evidence.mjs verify');
    expect(reuse.run).toContain('HEAD^{tree}');
    expect(reuse.run).toContain('--miss-is-notice');
    expect(reuse.if).toContain("startsWith(github.head_ref || github.ref_name, 'release/')");
    expect(ci.jobs.scope.outputs.reuse).toBe('${{ steps.reuse.outputs.reuse }}');
    expect(index(ci, 'scope', reuse.name)).toBeLessThan(index(ci, 'scope', 'Plan the shards of the full probe'));
    expect(ci.jobs.scope.permissions.actions).toBe('read');
  });

  it('serializes the two runs of one release commit (the whole workflow) so the second can reuse the first', () => {
    expect(ci.concurrency.group).toContain("startsWith(github.head_ref || github.ref_name, 'release/')");
    expect(ci.concurrency.group).toContain('github.event.pull_request.head.sha || github.sha');
    expect(ci.concurrency.group).toContain('github.run_id');
    expect(ci.concurrency['cancel-in-progress']).toBe(false);
  });

  it('packages and uploads release evidence only from a full, clean, release-branch probe', () => {
    expect(pkg.if).toContain("env.MODE == 'full'");
    expect(pkg.if).toContain("env.REUSE == 'false'");
    expect(pkg.if).toContain("startsWith(github.head_ref || github.ref_name, 'release/')");
    expect(pkg.if).not.toContain('always()');
    expect(pkg.run).toContain('release-evidence.mjs write');
    expect(upload.with.name).toBe('${{ steps.release_evidence.outputs.name }}');
    expect(index(ci, 'selfprobe-gate', pkg.name)).toBeGreaterThan(index(ci, 'selfprobe-gate', 'Merge the shards into one evidence document'));
  });
});

describe('release.yml: verifies the release pull request\'s probe instead of probing a third time', () => {
  const verify = step(release, 'test', "The release pull request's full self-probe must describe this exact tree");
  const reprobe = step(release, 'test', 'Self-probe must be fully defended before anything ships (recovery re-probe)');

  it('has no unconditional probe left; the only probe is the explicit recovery one', () => {
    for (const s of steps(release, 'test')) {
      if (s === reprobe) continue;
      expect(s.run ?? '', s.name).not.toMatch(/testguard\.mjs probe/);
    }
    expect(reprobe.if).toContain('inputs.reprobe');
    expect(verify.if).toContain('!inputs.reprobe');
    expect(triggers(release).workflow_dispatch.inputs.reprobe).toMatchObject({ type: 'boolean', default: false });
  });

  it('verifies the evidence of the tree about to be tagged, with the permission to look it up', () => {
    expect(verify.run).toContain("git rev-parse 'HEAD^{tree}'");
    expect(verify.run).toContain('release-evidence.mjs verify --tree "$TREE"');
    expect(verify.run).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(release.jobs.test.permissions).toMatchObject({ actions: 'read', contents: 'read' });
  });

  it('keeps every other release check, and nothing publishes or tags before the verification', () => {
    const names = steps(release, 'test').map((s) => s.name ?? s.run);
    expect(names).toEqual(expect.arrayContaining(['npm test', 'Install smoke — the tarball must run with production deps only', 'Version surfaces are in sync']));
    expect(release.jobs['create-release'].needs).toContain('test');
    expect(release.jobs['publish-npm'].needs).toContain('test');
    expect(release.jobs['publish-pypi'].needs).toContain('test');
  });

  it('the hourly sweep fails visibly when an open release pull request has gone stale', () => {
    const watch = step(release, 'watch-release-pr', 'An open release pull request must still be mergeable');
    expect(watch.run).toContain('await-mergeable.mjs "$PR"');
    expect(watch.run).toContain('startswith("release/v")');
    expect(watch.run).toContain('exit "$FAILED"');
    expect(release.jobs['watch-release-pr'].permissions['pull-requests']).toBe('read');
  });

  it('waits for the tarball right after publishing, before the job can report success, and the checksum job needs that job', () => {
    const publish = index(release, 'publish-npm', 'Publish (provenance is automatic under Trusted Publishing)');
    const wait = index(release, 'publish-npm', 'Wait until the tarball is downloadable');
    expect(publish).toBeGreaterThan(-1);
    expect(wait).toBe(publish + 1);
    expect(steps(release, 'publish-npm')[wait].run).toContain('wait-for-tarball.mjs');
    expect(release.jobs['homebrew-sha'].needs).toContain('publish-npm');
    expect(release.jobs['publish-npm'].permissions['id-token']).toBe('write');
  });
});

describe('scheduled-release.yml: no probe of its own, and a pull request that cannot merge fails it', () => {
  const run = (name) => step(scheduled, 'cut-release', name).run ?? '';

  it('does not probe the bumped tree; the release PR does', () => {
    for (const s of steps(scheduled, 'cut-release')) expect(s.run ?? '', s.name).not.toMatch(/testguard\.mjs probe/);
    expect(run('Verify the tree is still green (unit tests; the full self-probe runs once, on the release PR)')).toContain('npm test');
  });

  it('waits for the previous release\'s Homebrew checksum before it bumps and cuts a branch', () => {
    const preflight = index(scheduled, 'cut-release', "The previous release's Homebrew checksum must be on main first");
    expect(preflight).toBeGreaterThan(-1);
    expect(steps(scheduled, 'cut-release')[preflight].run).toContain('release-preflight.mjs');
    expect(preflight).toBeLessThan(index(scheduled, 'cut-release', 'Bump version and write changelog'));
  });

  it('checks the pull request it opened is mergeable, after arming auto-merge and approving the held runs', () => {
    const open = run('Open release PR with auto-merge armed');
    const armed = open.indexOf('gh pr merge --auto --squash "$PR"');
    const approved = open.indexOf('approve-held-runs.sh "$HEAD_SHA" "$PR"');
    const awaited = open.indexOf('await-mergeable.mjs "$PR"');
    expect(armed).toBeGreaterThan(-1);
    expect(approved).toBeGreaterThan(armed);
    expect(awaited).toBeGreaterThan(approved);
  });
});
