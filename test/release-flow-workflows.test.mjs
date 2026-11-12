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

describe('ci.yml: pull requests probe what changed, everything else probes in full', () => {
  const probeFull = step(ci, 'test', "probe TestGuard's own claims");
  const probeScoped = step(ci, 'test', "probe TestGuard's own claims — only what this pull request can affect");

  it('decides the scope first, from the event and the diff, passing branch names through the environment', () => {
    const scope = step(ci, 'test', 'Decide how much of its own claims the self-probe measures');
    expect(scope.run).toContain('self-probe-scope.mjs');
    expect(scope.run).toContain('--base "origin/$BASE_REF"');
    expect(scope.env).toMatchObject({ HEAD_REF: '${{ github.head_ref }}', EVENT_NAME: '${{ github.event_name }}' });
    for (const s of steps(ci, 'test')) expect(s.run ?? '', s.name).not.toMatch(/\$\{\{\s*github\.(head_ref|ref_name)/);
    expect(index(ci, 'test', 'Decide how much of its own claims the self-probe measures')).toBeLessThan(steps(ci, 'test').indexOf(probeFull));
  });

  it('runs the full probe only in full mode and the scoped probe only in scoped mode, against the pull request base', () => {
    expect(probeFull.if).toContain("steps.scope.outputs.mode == 'full'");
    expect(probeFull.run).not.toContain('--changed');
    expect(probeScoped.if).toContain("steps.scope.outputs.mode == 'scoped'");
    expect(probeScoped.run).toContain('probe . --changed "origin/${{ github.base_ref }}"');
    expect(probeScoped.run).toContain('--out .testguard/ci-self-evidence.json');
  });

  it('gates the cost of a full run and only reports the cost of a scoped one', () => {
    const gate = step(ci, 'test', 'The gate must stay inside its cost budget');
    const report = step(ci, 'test', 'Cost of the scoped run (reported, not gated)');
    expect(gate.if).toContain("steps.scope.outputs.mode == 'full'");
    expect(gate.run).not.toContain('--report-only');
    expect(report.if).toContain("steps.scope.outputs.mode == 'scoped'");
    expect(report.run).toContain('--report-only');
  });

  it('keeps the anchor preflight, the claims diff and the changed-file gate on every pull request', () => {
    expect(step(ci, 'test', 'claims — fault anchors and replacements are valid').run).toContain('--check-anchors');
    expect(step(ci, 'test', 'claims — fault anchors and replacements are valid').if).toBe('matrix.node-version == 22');
    expect(step(ci, 'test', 'gate — every changed source file carries a claim').if).toBe("github.event_name == 'pull_request'");
    expect(step(ci, 'test', 'claims — no claim or fault removed without a reason').if).toBe("github.event_name == 'pull_request'");
  });

  it('adds a nightly full run of the test job only', () => {
    expect(triggers(ci).schedule).toHaveLength(1);
    for (const job of ['native-node-floor', 'python', 'playwright', 'hermeticity']) expect(ci.jobs[job].if, job).toBe("github.event_name != 'schedule'");
    expect(ci.jobs.test.if).toBeUndefined();
  });

  it('keeps the branch-named evidence for full runs only: a scoped run is partial', () => {
    expect(step(ci, 'test', 'Upload evidence under a stable, branch-named artifact').if).toContain("steps.scope.outputs.mode == 'full'");
  });
});

describe('ci.yml: the release tree is probed in full once and the evidence is keyed by its tree', () => {
  const pkg = step(ci, 'test', 'Release branch — package the full probe, keyed by the tree hash');
  const upload = step(ci, 'test', 'Release branch — upload the release evidence');
  const reuse = step(ci, 'test', 'Release branch — is this tree already probed in full?');

  it("looks for an earlier run's evidence of the same tree before probing, and skips the probe when it is there", () => {
    expect(reuse.run).toContain('release-evidence.mjs verify');
    expect(reuse.run).toContain('HEAD^{tree}');
    expect(reuse.if).toContain("startsWith(github.head_ref || github.ref_name, 'release/')");
    expect(index(ci, 'test', reuse.name)).toBeLessThan(steps(ci, 'test').indexOf(step(ci, 'test', "probe TestGuard's own claims")));
    for (const name of ["probe TestGuard's own claims", 'The gate must stay inside its cost budget', 'Time the reference workload before the probe']) expect(step(ci, 'test', name).if, name).toContain("steps.reuse.outputs.reuse != 'true'");
    expect(ci.jobs.test.permissions.actions).toBe('read');
  });

  it('serializes the two runs of one release commit so the second can reuse the first', () => {
    expect(ci.jobs.test.concurrency.group).toBe('ci-test-${{ matrix.node-version }}-${{ github.event.pull_request.head.sha || github.sha }}');
    expect(ci.jobs.test.concurrency['cancel-in-progress']).toBe(false);
  });

  it('packages and uploads release evidence only from a full, clean, release-branch probe', () => {
    expect(pkg.if).toContain("steps.scope.outputs.mode == 'full'");
    expect(pkg.if).toContain("steps.reuse.outputs.reuse == 'false'");
    expect(pkg.if).toContain("startsWith(github.head_ref || github.ref_name, 'release/')");
    expect(pkg.if).not.toContain('always()');
    expect(pkg.run).toContain('release-evidence.mjs write');
    expect(upload.with.name).toBe('${{ steps.release_evidence.outputs.name }}');
    expect(index(ci, 'test', pkg.name)).toBeGreaterThan(index(ci, 'test', 'The gate must stay inside its cost budget'));
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
