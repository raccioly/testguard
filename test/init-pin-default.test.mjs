// #301 item 3: init recommends the pin and the update rule; only --pin writes them, and --upgrade never does.
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { initProject } from '../src/init/init.mjs';
import { cfg, hermeticRepos, put, read, repo } from './helpers/owned-repo.mjs';

const made = hermeticRepos();

describe('the pin and the update rule are recommended unless --pin (#301 item 3)', () => {
  function project() {
    const dir = repo(made);
    put(dir, 'package.json', '{\n  "name": "app"\n}\n');
    put(dir, 'package-lock.json', '{}\n');
    cfg(dir, 'core.hooksPath', '.githooks');
    return dir;
  }
  it('writes no package.json, dependabot.yml or Renovate change by default, and prints each exact text', () => {
    const dir = project();
    const r = initProject({ projectDir: dir, toolVersion: '1.2.3' });
    expect(read(dir, 'package.json')).toBe('{\n  "name": "app"\n}\n');
    expect(existsSync(join(dir, '.github/dependabot.yml'))).toBe(false);
    const titles = r.recommendations.map((x) => x.title);
    expect(titles).toContainEqual(expect.stringMatching(/^package\.json: pin the TestGuard that hooks and CI run/));
    expect(r.recommendations.find((x) => /^package\.json/.test(x.title)).lines[0]).toBe('"devDependencies": { "testguard-cli": "1.2.3" }');
    const rule = r.recommendations.find((x) => /dependabot\.yml/.test(x.title));
    expect(rule.lines.join('\n')).toContain('dependency-name: testguard-cli');
    expect(rule.title).toMatch(/create it with an npm rule/);
    // Renovate: the rule, not an edit.
    put(dir, 'renovate.json', '{}');
    const rr = initProject({ projectDir: dir, toolVersion: '1.2.3' });
    expect(read(dir, 'renovate.json')).toBe('{}');
    expect(rr.recommendations.find((x) => /renovate\.json/.test(x.title)).lines[0]).toContain('"matchPackageNames": ["testguard-cli"]');
  });
  it('--pin writes them exactly as 0.25.0 did', () => {
    const dir = project();
    const r = initProject({ projectDir: dir, pin: true, toolVersion: '1.2.3' });
    expect(JSON.parse(read(dir, 'package.json')).devDependencies).toEqual({ 'testguard-cli': '1.2.3' });
    expect(read(dir, '.github/dependabot.yml')).toContain('dependency-name: testguard-cli');
    expect(r.recommendations.map((x) => x.title).join('\n')).not.toMatch(/package\.json|dependabot/);
  });
  it('--upgrade never writes them, with or without --pin', () => {
    const dir = project();
    const r = initProject({ projectDir: dir, upgrade: true, pin: true, toolVersion: '1.2.3' });
    expect(read(dir, 'package.json')).toBe('{\n  "name": "app"\n}\n');
    expect(existsSync(join(dir, '.github/dependabot.yml'))).toBe(false);
    expect(r.notes.join('\n')).toMatch(/--pin was ignored: --upgrade never writes package\.json/);
    initProject({ projectDir: dir, upgrade: true, toolVersion: '1.2.3' });
    expect(read(dir, 'package.json')).toBe('{\n  "name": "app"\n}\n');
  });
});

