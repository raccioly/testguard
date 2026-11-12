// What `init` writes for the fast path, and what `init --upgrade` may rewrite
// (issue #270): a pre-push hook that probes the change with automatic fault
// workers, CI that probes the change and runs the full probe nightly, and
// managed blocks that a later init recognizes by template and by hash.
import { describe, it, expect } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initProject } from '../src/init/init.mjs';
import { TEMPLATE_VERSION, managedBlock, parseManagedBlocks, prePushBlock, prePushScript, markSkill, skillState, scanInstalled, olderThan } from '../src/init/managed.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const TEMPLATE = readFileSync(join(ROOT, 'src/init/templates/SKILL.md'), 'utf8');
const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-init-fast-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
};
const read = (dir, f) => readFileSync(join(dir, f), 'utf8');

describe('the templates are fast and pinned', () => {
  it('the pre-push hook probes the change with automatic workers, never --serial, never a full probe', () => {
    const hook = prePushScript('.', { version: '0.23.0' });
    expect(hook).toMatch(/^#!\/bin\/sh\n/);
    expect(hook).toMatch(/"\$@" probe --changed auto --skip-without-base --quiet/);
    expect(hook).not.toMatch(/--serial|--fault-workers|@latest/);
    expect(hook).toContain('npx -y testguard-cli@0.23.0');
    expect(parseManagedBlocks(hook)).toEqual([expect.objectContaining({ name: 'pre-push', template: TEMPLATE_VERSION, modified: false })]);
    // A nested project gets its own block, run from its own directory.
    expect(prePushBlock('backend', { version: '0.23.0' })).toMatch(/testguard managed: pre-push-backend template=/);
    expect(prePushBlock('backend', { version: '0.23.0' })).toContain('cd "$ROOT/backend"');
  });

  it('runs the project install first, and passes exactly the fast arguments', () => {
    const dir = repo();
    try {
      mkdirSync(join(dir, '.githooks'), { recursive: true });
      writeFileSync(join(dir, '.githooks/pre-push'), prePushScript('.', { version: '0.23.0' }));
      mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
      writeFileSync(join(dir, 'node_modules/.bin/testguard'), '#!/bin/sh\necho "args: $*"\nexit 0\n');
      chmodSync(join(dir, 'node_modules/.bin/testguard'), 0o755);
      const r = spawnSync('sh', ['.githooks/pre-push'], { cwd: dir, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("args: probe --changed auto --skip-without-base --quiet");
      // A probe that fails blocks the push.
      writeFileSync(join(dir, 'node_modules/.bin/testguard'), '#!/bin/sh\nexit 1\n');
      expect(spawnSync('sh', ['.githooks/pre-push'], { cwd: dir }).status).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('init writes the fast path', () => {
  it('a pre-push block in the husky hook when husky is there, and CI on request', () => {
    const dir = repo();
    try {
      mkdirSync(join(dir, '.husky'));
      writeFileSync(join(dir, '.husky/pre-push'), 'npm run lint\n');
      writeFileSync(join(dir, 'package-lock.json'), '{}');
      const r = initProject({ projectDir: dir, ci: 'github', toolVersion: '0.23.0' });
      expect(r.done).toEqual(expect.arrayContaining([
        expect.stringMatching(/^\.husky\/pre-push: pre-push → probe --changed auto/),
        expect.stringMatching(/^\.github\/workflows\/testguard\.yml: pull requests probe --changed auto; nightly/),
      ]));
      expect(statSync(join(dir, '.husky/pre-push')).mode & 0o111).not.toBe(0);
      // What was there stays, first; the block follows.
      expect(read(dir, '.husky/pre-push')).toBe(`npm run lint\n${prePushBlock('.', { version: '0.23.0' })}\n`);
      expect(existsSync(join(dir, '.githooks'))).toBe(false);
      const wf = read(dir, '.github/workflows/testguard.yml');
      expect(wf).toContain('else echo "TESTGUARD=npx -y testguard-cli@0.23.0" >> "$GITHUB_ENV"; fi');
      expect(wf).toContain('run: $TESTGUARD probe --changed auto');
      expect(wf).toMatch(/if: github\.event_name != 'pull_request'\n\s+run: \$TESTGUARD probe$/m);
      expect(wf).toContain("cron: '23 3 * * *'");
      expect(wf).toContain('run: npm ci');
      expect(wf).toContain('path: .testguard/evidence.json');
      expect(wf).not.toMatch(/--serial|@latest|uses: [^#\n]*@v\d/);
      // A second init changes nothing.
      const again = initProject({ projectDir: dir, ci: 'github', toolVersion: '0.23.0' });
      expect(again.done).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('GitLab gets a file to include, with the same split', () => {
    const dir = repo();
    try {
      initProject({ projectDir: dir, ci: 'gitlab', toolVersion: '0.23.0' });
      const gl = read(dir, 'testguard.gitlab-ci.yml');
      expect(gl).toContain('TESTGUARD="npx -y testguard-cli@0.23.0"');
      expect(gl).toContain('$TESTGUARD probe --changed auto');
      expect(gl).not.toContain('@latest');
      expect(gl).toContain('$CI_PIPELINE_SOURCE == "schedule"');
      expect(gl).toContain('- local: testguard.gitlab-ci.yml');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('without husky, writes .githooks/pre-push, says how to enable it, and never writes .git/hooks', () => {
    const dir = repo();
    try {
      const r = initProject({ projectDir: dir, toolVersion: '0.23.0' });
      expect(read(dir, '.githooks/pre-push')).toBe(prePushScript('.', { version: '0.23.0' }));
      expect(statSync(join(dir, '.githooks/pre-push')).mode & 0o111).not.toBe(0);
      expect(r.notes.join('\n')).toMatch(/git config core\.hooksPath \.githooks/);
      expect(existsSync(join(dir, '.git/hooks/pre-push'))).toBe(false);
      // Already enabled: nothing to say.
      spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: dir });
      expect(initProject({ projectDir: dir, toolVersion: '0.23.0' }).notes.join('\n')).not.toMatch(/core\.hooksPath/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses an unknown CI platform before writing anything', () => {
    const dir = repo();
    try {
      expect(() => initProject({ projectDir: dir, ci: 'jenkins' })).toThrow(/--ci must be github or gitlab/);
      expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('init finds the slow and stale ways, and --upgrade fixes only its own', () => {
  it('reports --serial, a full probe on every push and an old pin, and leaves those lines alone', () => {
    const dir = repo();
    try {
      mkdirSync(join(dir, '.husky'));
      writeFileSync(join(dir, '.husky/pre-push'), '#!/bin/sh\nnpx testguard probe . --confirm 3 --serial\n');
      const r = initProject({ projectDir: dir, upgrade: true, toolVersion: '0.23.0' });
      expect(r.outdated).toEqual([
        expect.stringMatching(/^\.husky\/pre-push:2: runs probe --serial/),
        expect.stringMatching(/^\.husky\/pre-push:2: probes every claim on every push/),
      ]);
      expect(read(dir, '.husky/pre-push')).toMatch(/^#!\/bin\/sh\nnpx testguard probe \. --confirm 3 --serial\n/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('an older, unmodified managed block is reported, then rewritten by --upgrade; an edited one is left', () => {
    const dir = repo();
    try {
      initProject({ projectDir: dir, toolVersion: '0.23.0' });
      const hookPath = join(dir, '.githooks/pre-push');
      writeFileSync(hookPath, read(dir, '.githooks/pre-push').replace(`template=${TEMPLATE_VERSION}`, 'template=1'));
      expect(initProject({ projectDir: dir, toolVersion: '0.23.0' }).outdated).toEqual([expect.stringMatching(/pre-push: the TestGuard block is template 1, unmodified — testguard init --upgrade rewrites it/)]);
      const up = initProject({ projectDir: dir, upgrade: true, toolVersion: '0.23.0' });
      expect(up.done).toEqual([expect.stringMatching(/pre-push.*\(upgraded to template \d+\)$/)]);
      expect(readFileSync(hookPath, 'utf8')).toBe(prePushScript('.', { version: '0.23.0' }));
      // Edited by hand: the hash no longer matches, so --upgrade leaves it and says so.
      writeFileSync(hookPath, prePushScript('.', { version: '0.23.0' }).replace('--quiet', '--quiet --serial').replace(`template=${TEMPLATE_VERSION}`, 'template=1'));
      const edited = initProject({ projectDir: dir, upgrade: true, toolVersion: '0.23.0' });
      expect(edited.skipped).toEqual(expect.arrayContaining([expect.stringMatching(/pre-push: the TestGuard block was edited by hand \(use --force/)]));
      expect(readFileSync(hookPath, 'utf8')).toContain('--quiet --serial');
      initProject({ projectDir: dir, upgrade: true, force: true, toolVersion: '0.23.0' });
      expect(readFileSync(hookPath, 'utf8')).toBe(prePushScript('.', { version: '0.23.0' }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('an unmodified skill from an older release is upgraded; an edited one is not', () => {
    const dir = repo();
    try {
      initProject({ projectDir: dir, toolVersion: '0.23.0' });
      const skill = join(dir, '.claude/skills/testguard/SKILL.md');
      // What 0.22 wrote: the template of that release, with no marker.
      const legacy = spawnSync('git', ['show', 'fa96cdc:src/init/templates/SKILL.md'], { cwd: ROOT, encoding: 'utf8' }).stdout;
      expect(legacy.length).toBeGreaterThan(0);
      writeFileSync(skill, legacy);
      expect(initProject({ projectDir: dir, toolVersion: '0.23.0' }).outdated).toEqual([expect.stringMatching(/SKILL\.md: an older skill template, unmodified/)]);
      initProject({ projectDir: dir, upgrade: true, toolVersion: '0.23.0' });
      expect(readFileSync(skill, 'utf8')).toBe(markSkill(TEMPLATE));
      writeFileSync(skill, legacy + '\nOur own rule.\n');
      const r = initProject({ projectDir: dir, upgrade: true, toolVersion: '0.23.0' });
      expect(r.skipped).toEqual(expect.arrayContaining([expect.stringMatching(/SKILL\.md exists and was edited/)]));
      expect(readFileSync(skill, 'utf8')).toContain('Our own rule.');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('an AGENTS.md section from before template markers is upgraded with its project list kept', () => {
    const dir = repo();
    try {
      writeFileSync(join(dir, 'AGENTS.md'), '# Agents\n\nOur rules.\n\n<!-- testguard:begin -->\n## TestGuard\nold text\n- This project: claims in `testguard.claims.json`; run `testguard status --json` and follow `next`.\n<!-- testguard:end -->\n\nMore of ours.\n');
      expect(initProject({ projectDir: dir, toolVersion: '0.23.0' }).outdated).toEqual(expect.arrayContaining([expect.stringMatching(/AGENTS\.md: the TestGuard section is template 1/)]));
      initProject({ projectDir: dir, upgrade: true, toolVersion: '0.23.0' });
      const agents = read(dir, 'AGENTS.md');
      expect(agents).toMatch(/^# Agents\n\nOur rules\.\n\n<!-- testguard:begin template=\d+ -->/);
      expect(agents).toContain('testguard probe --changed auto');
      expect(agents).toContain('Run the full probe (`testguard probe`) only when asked, or in the nightly job.');
      expect(agents).not.toContain('old text');
      expect(agents).toMatch(/<!-- testguard:end -->\n\nMore of ours\.\n$/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the pure pieces', () => {
  it('a managed block knows when its body was edited', () => {
    const block = managedBlock('x', 'echo hi');
    expect(parseManagedBlocks(block)[0].modified).toBe(false);
    expect(parseManagedBlocks(block.replace('echo hi', 'echo bye'))[0].modified).toBe(true);
  });

  it('a skill is current, an unmodified older template, or modified', () => {
    expect(skillState(markSkill(TEMPLATE), TEMPLATE)).toBe('current');
    expect(skillState(markSkill(TEMPLATE).replace(`template ${TEMPLATE_VERSION}`, 'template 1'), TEMPLATE)).toBe('old');
    expect(skillState('anything', TEMPLATE, [])).toBe('modified');
    // Edited after init wrote it: the marker's hash no longer matches.
    expect(skillState(markSkill(TEMPLATE) + '\nOur own rule.\n', TEMPLATE)).toBe('modified');
    expect(skillState(markSkill(TEMPLATE).replace(`template ${TEMPLATE_VERSION}`, 'template 1') + '\nOur own rule.\n', TEMPLATE)).toBe('modified');
  });

  it('versions compare numerically, and only plain x.y.z versions compare', () => {
    expect(olderThan('0.9.0', '0.23.0')).toBe(true);
    expect(olderThan('v0.22.1', '0.23.0')).toBe(true);
    expect(olderThan('0.23.0', '0.23.0')).toBe(false);
    expect(olderThan('1.0.0', '0.23.0')).toBe(false);
    expect(olderThan('latest', '0.23.0')).toBe(false);
  });

  it('scanning is read-only and needs a repository', () => {
    expect(scanInstalled({ root: undefined, toolVersion: '0.23.0' })).toEqual([]);
  });
});
