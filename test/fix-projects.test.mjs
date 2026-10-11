import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseFixProjectMarkers } from '../src/scaffold/fix-paths.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const names = (...files) => Buffer.from(files.length ? `${files.join('\0')}\0` : '');
const roots = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('complete historical fix project marker union', () => {
  it('retains removed and added delegation from actual parent/fix trees', () => {
    const root = mkdtempSync(join(tmpdir(), 'testguard-fix-projects-')); roots.push(root);
    const git = (...args) => {
      const run = spawnSync('git', [...FIXTURE_GIT, '--no-lazy-fetch', '--no-replace-objects', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', `core.hooksPath=${devNull}`, ...args], { cwd: root, timeout: 5000, maxBuffer: 128 * 1024 });
      expect(run.status).toBe(0); return run.stdout;
    };
    git('init', '-q'); mkdirSync(join(root, 'removed')); mkdirSync(join(root, 'added'));
    writeFileSync(join(root, 'testguard.claims.json'), 'untrusted marker bytes');
    writeFileSync(join(root, 'removed/testguard.claims.json'), 'not executed');
    writeFileSync(join(root, 'added/guard.mjs'), 'export const x = 1;');
    git('add', '.'); git('commit', '-qm', 'Before'); const parent = git('rev-parse', 'HEAD').toString().trim();
    unlinkSync(join(root, 'removed/testguard.claims.json'));
    writeFileSync(join(root, 'added/testguard.claims.json'), 'not a claim declaration');
    git('add', '-A'); git('commit', '-qm', 'After'); const commit = git('rev-parse', 'HEAD').toString().trim();
    const result = parseFixProjectMarkers(git('ls-tree', '-r', '--name-only', '-z', '--full-tree', parent), git('ls-tree', '-r', '--name-only', '-z', '--full-tree', commit));
    expect(result).toEqual(['added', 'removed']); expect(Object.isFrozen(result)).toBe(true);
    expect(result.claims).toBeUndefined();
  });
  it('uses exact descendant marker basenames, ignores root and package manifests, sorts and deduplicates across trees', () => {
    const result = parseFixProjectMarkers(names('testguard.claims.json', 'z/testguard.claims.json', 'a/package.json', 'fake-testguard.claims.json'), names('z/testguard.claims.json', 'a/b/testguard.claims.json'));
    expect(result).toEqual(['a/b', 'z']); expect(Object.isFrozen(result)).toBe(true);
    expect(() => result.push('foreign')).toThrow();
    expect(parseFixProjectMarkers(names(), names())).toEqual([]);
  });
  it.each(['.local', '.wolf', '.git', '.testguard', 'graphify-out'])('withholds %s marker directories', component => {
    expect(parseFixProjectMarkers(names(`nested/${component}/testguard.claims.json`), names())).toEqual([]);
  });
  it('validates both complete inventories including non-marker names', () => {
    expect(() => parseFixProjectMarkers(names('child/testguard.claims.json'), Buffer.from('other/file'))).toThrow(/truncated-output/);
    expect(() => parseFixProjectMarkers(Buffer.from('child/testguard.claims.json'), names())).toThrow(/truncated-output/);
    expect(() => parseFixProjectMarkers(names('same', 'same'), names())).toThrow(/duplicate-path/);
    expect(() => parseFixProjectMarkers(names(), names('same', 'same'))).toThrow(/duplicate-path/);
    expect(() => parseFixProjectMarkers(names('valid/testguard.claims.json'), Buffer.from([0xff, 0]))).toThrow(/invalid-utf8/);
  });
  it.each(['../file', '/file', 'a//file', 'a/./file', 'a/../file', 'a\\file', 'C:/file', 'a\nfile', ''])('refuses unsafe historical name %s before filtering', file => {
    expect(() => parseFixProjectMarkers(names(file), names())).toThrow(/unsafe-path/);
  });
  it('refuses buffer, byte, path and complete name-count overruns', () => {
    expect(() => parseFixProjectMarkers('', names())).toThrow(/buffer-required/);
    expect(() => parseFixProjectMarkers(names(), '')).toThrow(/buffer-required/);
    expect(() => parseFixProjectMarkers(Buffer.alloc(128 * 1024 + 1), names())).toThrow(/output-byte-limit/);
    expect(() => parseFixProjectMarkers(names(), Buffer.alloc(128 * 1024 + 1))).toThrow(/output-byte-limit/);
    expect(() => parseFixProjectMarkers(names('x'.repeat(4097)), names())).toThrow(/path-byte-limit/);
    const full = Array.from({ length: 4096 }, (_, i) => `f${i}`);
    expect(parseFixProjectMarkers(names(...full), names())).toEqual([]);
    expect(() => parseFixProjectMarkers(names(...full, 'extra'), names())).toThrow(/tree-name-count-limit/);
  });
  it('charges the union project limit, including private markers, before withholding', () => {
    const parent = Array.from({ length: 128 }, (_, i) => `p${i}/testguard.claims.json`);
    const fix = Array.from({ length: 128 }, (_, i) => `q${i}/testguard.claims.json`);
    expect(parseFixProjectMarkers(names(...parent), names(...fix))).toHaveLength(256);
    expect(() => parseFixProjectMarkers(names(...parent), names(...fix, '.local/extra/testguard.claims.json'))).toThrow(/project-count-limit/);
  });
});
