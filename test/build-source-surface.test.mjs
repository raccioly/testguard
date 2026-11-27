// @req FR-08
// status, init and probe --changed over a Maven project (#329): Java under a
// pom.xml is counted as probeable source, a JUnit test is not a module, and
// nothing of it lands in the unsupported-language tally. The documents still
// validate against their schemas.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeClaimedSurface, languageSurvey } from '../src/status/surface.mjs';
import { computeStatus, renderStatus } from '../src/status/status.mjs';
import { initProject } from '../src/init/init.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

let root;
const write = (file, text) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text); };
const git = (...args) => spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=s@example.invalid', '-c', 'user.name=s', ...args], { cwd: root, encoding: 'utf8' });
const files = (withBuildFile) => {
  if (withBuildFile) write('pom.xml', '<project/>\n');
  write('src/main/java/demo/Discount.java', 'class Discount {}\n');
  write('src/main/java/demo/Cart.java', 'class Cart {}\n');
  write('src/test/java/demo/DiscountTest.java', 'class DiscountTest {}\n');
  write('src/test/kotlin/demo/PriceTest.kt', 'class PriceTest\n');
  write('force-app/main/default/classes/A.cls', 'public class A {}\n');
};
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'tg-build-surface-'))); git('init', '-q'); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('with a pom.xml', () => {
  beforeEach(() => { files(true); git('add', '-A'); git('commit', '-qm', 'init'); });

  it('counts Java as source modules, never a JUnit test, and tallies only what is still unsupported', () => {
    const surface = computeClaimedSurface({ projectDir: root, claims: { claims: [] } });
    expect(surface.sourceModules).toBe(2);
    expect(surface.unsupportedModules).toEqual({ total: 1, byLanguage: { apex: 1 } });
  });

  it('languageSurvey (what init reads) agrees', () => {
    expect(languageSurvey(root)).toEqual({ probeable: 2, unsupported: { total: 1, byLanguage: { apex: 1 } } });
  });

  it('init says nothing about Java, because it can be probed', () => {
    const notes = initProject({ projectDir: root, here: true }).notes.join('\n');
    expect(notes).not.toMatch(/cannot probe Java/);
  });

  it('status validates, and a changed Java file is not an unsupported change', () => {
    write('src/main/java/demo/Discount.java', 'class Discount { int x; }\n');
    write('force-app/main/default/classes/A.cls', 'public class A { Integer x; }\n');
    const doc = computeStatus({ projectDir: root, toolVersion: 't', changedRef: 'HEAD', includeDirty: true });
    expect(doc.surface.sourceModules).toBe(2);
    expect(doc.changes.unsupported).toEqual({ total: 1, byLanguage: { apex: 1 } });
    expect(validate('status', doc).errors).toEqual([]);
    expect(renderStatus(doc)).not.toMatch(/Java \d/);
  });
});

describe('without a build file', () => {
  it('the same files are the gap they were: Java and Kotlin are tallied as unsupported, tests included', () => {
    files(false);
    git('add', '-A'); git('commit', '-qm', 'init');
    const surface = computeClaimedSurface({ projectDir: root, claims: { claims: [] } });
    expect(surface.sourceModules).toBe(0);
    expect(surface.unsupportedModules).toEqual({ total: 5, byLanguage: { apex: 1, java: 3, kotlin: 1 } });
    expect(validate('status', computeStatus({ projectDir: root, toolVersion: 't' })).errors).toEqual([]);
  });
});
