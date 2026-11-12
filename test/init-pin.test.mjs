// #293 part 2: what init writes runs a version the project reviewed. The
// templates pin the exact version of the TestGuard that wrote them (after the
// project's own install), GitHub Actions are pinned by SHA, init adds an
// exact-pinned devDependency and a dependency-update rule, and any floating
// version already there is a finding.
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ACTIONS, githubWorkflow, gitlabCi, npxPinned, prePushBlock, scanInstalled } from '../src/init/managed.mjs';
import { dependabotRule, pinDevDependency, renovateRule } from '../src/init/pin.mjs';
import { initProject } from '../src/init/init.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const FLOATING = /testguard-cli@(latest|next|\*)|npx\s+(-y\s+)?testguard-cli(\s|$|")/;
const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-init-pin-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
};
const read = (dir, f) => readFileSync(join(dir, f), 'utf8');

describe('no template can carry a floating version', () => {
  const installs = [{ node: true, run: 'npm ci' }, { python: true, run: 'pip install -r requirements.txt' }];
  const texts = ['.', 'backend', 'packages/api'].flatMap((dir) => [
    prePushBlock(dir, { version: '1.2.3' }),
    ...installs.flatMap((install) => [githubWorkflow({ dir, install, version: '1.2.3' }), gitlabCi({ dir, install, version: '1.2.3' })]),
  ]);

  it('every fallback is the exact version that wrote it, after the installed one', () => {
    for (const text of texts) {
      expect(text).not.toMatch(FLOATING);
      expect(text).toContain('testguard-cli@1.2.3');
      expect(text).toMatch(/node_modules\/\.bin\/testguard/);
    }
  });

  it('refuses to pin anything but an exact version', () => {
    for (const bad of ['latest', 'next', '^1.2.3', '1.2', '', undefined]) expect(() => npxPinned(bad)).toThrow(/exact version/);
    expect(npxPinned('1.2.3-rc.1')).toBe('npx -y testguard-cli@1.2.3-rc.1');
  });

  it('pins every GitHub Action by commit SHA, with the version in a comment', () => {
    for (const pin of Object.values(ACTIONS)) expect(pin).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    for (const text of texts) {
      for (const line of text.split('\n').filter((l) => /uses:/.test(l))) expect(line).toMatch(/uses: actions\/[a-z-]+@[0-9a-f]{40} # v\d/);
    }
  });

  it('says latest nowhere in src/init or the docs', () => {
    const files = (dir) => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
    const offenders = [...files(join(ROOT, 'src/init')), ...files(join(ROOT, 'docs'))].filter((f) => /testguard-cli@latest/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('the devDependency and the update rule', () => {
  it('adds an exact pin, keeping the file\'s indentation; leaves any existing spec and says what it is', () => {
    const added = pinDevDependency('{\n    "name": "x",\n    "devDependencies": { "vitest": "^3.0.0" }\n}\n', '1.2.3');
    expect(added.action).toBe('added');
    expect(JSON.parse(added.text).devDependencies).toEqual({ vitest: '^3.0.0', 'testguard-cli': '1.2.3' });
    expect(added.text).toMatch(/^\{\n {4}"name"/);
    expect(added.text.endsWith('\n')).toBe(true);
    expect(pinDevDependency('{"devDependencies":{"testguard-cli":"1.0.0"}}', '1.2.3')).toEqual({ action: 'exact', spec: '1.0.0' });
    expect(pinDevDependency('{"devDependencies":{"testguard-cli":"latest"}}', '1.2.3')).toEqual({ action: 'floating', spec: 'latest' });
    expect(pinDevDependency('{"dependencies":{"testguard-cli":"^1.0.0"}}', '1.2.3')).toEqual({ action: 'range', spec: '^1.0.0' });
  });

  it('writes a Dependabot rule, appends one, or says what to add, and never adds a second npm rule', () => {
    const created = dependabotRule(undefined, '.');
    expect(created.action).toBe('created');
    expect(created.text).toMatch(/^version: 2\nupdates:\n {2}- package-ecosystem: npm\n {4}directory: \/\n/);
    expect(created.text).toContain('- dependency-name: testguard-cli');
    const pip = 'version: 2\nupdates:\n  - package-ecosystem: pip\n    directory: /\n    schedule:\n      interval: weekly\n';
    const appended = dependabotRule(pip, 'web');
    expect(appended.action).toBe('appended');
    expect(appended.text.startsWith(pip)).toBe(true);
    expect(appended.text).toContain('directory: /web');
    const npm = pip.replace('pip', 'npm');
    expect(dependabotRule(npm, '.')).toMatchObject({ action: 'manual', snippet: expect.stringContaining('testguard-cli') });
    expect(dependabotRule(`${npm}    allow:\n      - dependency-name: testguard-cli\n`, '.')).toEqual({ action: 'present' });
  });

  it('extends a Renovate config with a rule that groups and pins testguard-cli, once', () => {
    const r = renovateRule('{\n  "extends": ["config:recommended"]\n}\n');
    expect(JSON.parse(r.text).packageRules).toEqual([{ matchPackageNames: ['testguard-cli'], groupName: 'testguard', rangeStrategy: 'pin' }]);
    expect(renovateRule(r.text)).toEqual({ action: 'present' });
  });

  it('init pins the devDependency and writes the Dependabot rule, and says so', () => {
    const dir = repo();
    try {
      writeFileSync(join(dir, 'package.json'), '{\n  "name": "app"\n}\n');
      const r = initProject({ projectDir: dir, ci: 'github', toolVersion: '1.2.3' });
      expect(JSON.parse(read(dir, 'package.json')).devDependencies).toEqual({ 'testguard-cli': '1.2.3' });
      expect(r.done.join('\n')).toMatch(/devDependency testguard-cli pinned to exactly 1\.2\.3 — run your package manager's install/);
      expect(read(dir, '.github/dependabot.yml')).toContain('dependency-name: testguard-cli');
      expect(read(dir, '.github/workflows/testguard.yml')).not.toMatch(FLOATING);
      // Run again: nothing more to do.
      const again = initProject({ projectDir: dir, ci: 'github', toolVersion: '1.2.3' });
      expect(again.done).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('init reports a floating devDependency, extends Renovate instead of writing Dependabot, and pins the MCP snippet', () => {
    const dir = repo();
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { 'testguard-cli': 'latest' } }));
      writeFileSync(join(dir, 'renovate.json'), '{}');
      const r = initProject({ projectDir: dir, mcp: true, toolVersion: '1.2.3' });
      expect(r.outdated.join('\n')).toMatch(/testguard-cli "latest" is a floating version/);
      expect(JSON.parse(read(dir, 'package.json')).devDependencies['testguard-cli']).toBe('latest');
      expect(JSON.parse(read(dir, 'renovate.json')).packageRules[0].matchPackageNames).toEqual(['testguard-cli']);
      expect(() => statSync(join(dir, '.github/dependabot.yml'))).toThrow();
      expect(JSON.stringify(r.mcpConfig)).toContain('testguard-cli@1.2.3');
      expect(JSON.stringify(r.mcpConfig)).not.toMatch(FLOATING);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('a floating version already in a hook or CI file is a finding', () => {
  it('names @latest and an unpinned npx, inside a managed block too', () => {
    const root = repo();
    try {
      mkdirSync(join(root, '.github/workflows'), { recursive: true });
      writeFileSync(join(root, '.github/workflows/ci.yml'), 'jobs:\n  t:\n    steps:\n      - run: npx -y testguard-cli@latest probe\n      - run: npx testguard-cli probe --changed auto\n      - run: npx -y testguard-cli@1.2.3 probe\n');
      mkdirSync(join(root, '.githooks'));
      writeFileSync(join(root, '.githooks/pre-push'), '#!/bin/sh\n# >>> testguard managed: pre-push template=2 sha256=0000000000000000 >>>\n  else set -- npx -y testguard-cli@latest\n# <<< testguard managed: pre-push <<<\n');
      const floating = scanInstalled({ root, toolVersion: '1.2.3' }).filter((f) => f.reason === 'floating-version');
      expect(floating.map((f) => `${f.file}:${f.line}`)).toEqual(['.githooks/pre-push:3', '.github/workflows/ci.yml:4', '.github/workflows/ci.yml:5']);
      expect(floating[0]).toMatchObject({ managed: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
