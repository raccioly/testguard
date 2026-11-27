// @req FR-08
// Source in a language TestGuard cannot probe is a reported gap, never `non-source` (#331).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeChangedGate, renderGate, unsupportedLanguage } from '../src/gate/changed.mjs';
import { computeClaimedSurface } from '../src/status/surface.mjs';
import { computeStatus, renderStatus } from '../src/status/status.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';
import { repo } from './helpers/gate-project.mjs';

const IGNORE = (pattern) => JSON.stringify({ schemaVersion: 1, entries: [{ kind: 'path', pattern, reason: 'Excused for the test scenario; a reviewer accepted it.', by: 'test' }] });

describe('unsupportedLanguage: the table of source TestGuard knows but cannot probe', () => {
  it.each([
    ['force-app/main/default/classes/Discount.cls', 'apex'],
    ['force-app/main/default/triggers/Order.trigger', 'apex'],
    ['src/main/java/demo/Discount.java', 'java'],
    ['app/Service.kt', 'kotlin'],
    ['lib/Thing.scala', 'scala'],
    ['Program.cs', 'csharp'],
    ['cmd/main.go', 'go'],
    ['lib/thing.rb', 'ruby'],
    ['src/Thing.php', 'php'],
    ['src/main/resources/dataweave/map.dwl', 'dataweave'],
    ['force-app/main/default/flows/Approve.flow-meta.xml', 'salesforce-flow'],
    ['src/main/mule/orders.xml', 'mule-xml'],
    ['api/src/main/mule/deep/orders.xml', 'mule-xml'],
  ])('%s is %s', (file, id) => {
    expect(unsupportedLanguage(file)?.id).toBe(id);
  });

  it.each(['README.md', 'testguard.claims.json', 'pom.xml', 'config/settings.xml', 'src/app.ts', 'tool.py', 'Makefile'])('%s is not a known source language', (file) => {
    expect(unsupportedLanguage(file)).toBeNull();
  });
});

describe('gate: a changed file in an unsupported language is a gap', () => {
  let r;
  beforeEach(() => { r = repo(); });
  afterEach(() => rmSync(r.root, { recursive: true, force: true }));

  const apex = 'force-app/main/default/classes/DiscountService.cls';

  it('is excluded as unsupported-language with its language, never as non-source', () => {
    r.write(apex, 'public class DiscountService {}\n');
    r.write('README.md', '# changed\n');
    const doc = computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true, toolVersion: 't' });
    expect(doc.excluded).toEqual(expect.arrayContaining([
      { file: apex, by: 'unsupported-language', language: 'apex' },
      { file: 'README.md', by: 'non-source' },
    ]));
    expect(doc.evaluated).toBe(0);
    expect(validate('gate', doc).errors).toEqual([]);
  });

  it('passes without --strict, but names the gap instead of saying everything is claimed', () => {
    r.write(apex, 'public class DiscountService {}\n');
    const doc = computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true, toolVersion: 't' });
    expect(doc.exitCode).toBe(0);
    const text = renderGate(doc);
    expect(text).toContain('1 Apex file changed; TestGuard cannot probe Apex yet');
    expect(text).not.toContain('every changed source file carries a claim');
  });

  it('without --strict a covered file beside an Apex file never prints the all-claimed line', () => {
    r.write(apex, 'public class DiscountService {}\n');
    r.write('src/redact.mjs', '// touched\nexport {};\n');
    const doc = computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true, toolVersion: 't' });
    expect(doc).toMatchObject({ exitCode: 0, evaluated: 1 });
    const text = renderGate(doc);
    expect(text).toContain('TestGuard cannot probe Apex yet');
    expect(text).not.toContain('every changed source file carries a claim');
  });

  it('--strict fails when any changed file is in an unsupported language, even beside a covered file', () => {
    r.write(apex, 'public class DiscountService {}\n');
    r.write('src/redact.mjs', '// touched\n' + 'export {};\n');
    const base = { projectDir: r.project, ref: 'HEAD', includeDirty: true, toolVersion: 't' };
    const lenient = computeChangedGate(base);
    expect(lenient.covered.map((c) => c.file)).toContain('src/redact.mjs');
    expect(lenient.exitCode).toBe(0);
    const strict = computeChangedGate({ ...base, strict: true });
    expect(strict.exitCode).toBe(1);
    expect(strict.covered.map((c) => c.file)).toContain('src/redact.mjs');
    expect(renderGate(strict)).toContain('TestGuard cannot probe Apex yet');
    expect(renderGate(strict)).not.toContain('every changed source file carries a claim');
    expect(validate('gate', strict).errors).toEqual([]);
  });

  it('prints one line per language with a count', () => {
    r.write(apex, 'public class A {}\n');
    r.write('force-app/main/default/classes/B.cls', 'public class B {}\n');
    r.write('src/main/java/demo/Discount.java', 'class Discount {}\n');
    const text = renderGate(computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true, toolVersion: 't' }));
    expect(text).toContain('2 Apex files changed; TestGuard cannot probe Apex yet');
    expect(text).toContain('1 Java file changed; TestGuard cannot probe Java yet');
  });

  it('an unexpired ignore entry excuses it, with the reason reported, like any other unclaimed file', () => {
    r.write(apex, 'public class DiscountService {}\n');
    r.write('testguard.ignore.json', IGNORE('force-app/**'));
    const doc = computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true, strict: true, toolVersion: 't' });
    expect(doc.covered).toContainEqual({ file: apex, by: 'ignore', pattern: 'force-app/**' });
    expect(doc.reliedOn[0].files).toContain(apex);
    expect(doc.excluded.some((e) => e.by === 'unsupported-language')).toBe(false);
    expect(doc.exitCode).toBe(0);
    expect(validate('gate', doc).errors).toEqual([]);
  });

  it('--exclude and the default exclusions still apply, so a generated or fixture file is not a gap', () => {
    r.write('src/main/java/demo/Client.generated.java', 'class Client {}\n');
    r.write('test/fixtures/Sample.java', 'class Sample {}\n');
    r.write('vendor/Thing.java', 'class Thing {}\n');
    const doc = computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true, exclude: ['vendor/**'], strict: true, toolVersion: 't' });
    expect(doc.excluded.map((e) => e.by.split(':')[0]).sort()).toEqual(['default', 'default', 'exclude']);
    expect(doc.excluded.some((e) => e.by === 'unsupported-language')).toBe(false);
  });

  it('the validator refuses a strict pass over an unsupported-language file', () => {
    r.write(apex, 'public class DiscountService {}\n');
    const strict = computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true, strict: true, toolVersion: 't' });
    expect(validate('gate', { ...strict, exitCode: 0 }).errors.length).toBeGreaterThan(0);
  });
});

describe('status surface: a second denominator for languages TestGuard cannot probe', () => {
  const write = (root, file, text) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text); };
  const git = (root, ...args) => spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=s@example.invalid', '-c', 'user.name=s', ...args], { cwd: root, encoding: 'utf8' });
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tg-unsupported-'));
    git(root, 'init', '-q');
    write(root, 'force-app/main/default/lwc/priceTag/priceTag.js', 'export const x = 1;\n');
    write(root, 'force-app/main/default/classes/A.cls', 'public class A {}\n');
    write(root, 'force-app/main/default/classes/B.cls', 'public class B {}\n');
    write(root, 'force-app/main/default/triggers/T.trigger', 'trigger T on Account (before insert) {}\n');
    write(root, 'force-app/main/default/flows/F.flow-meta.xml', '<Flow/>\n');
    write(root, 'README.md', '# readme\n');
    write(root, 'client/Thing.generated.java', 'class Thing {}\n');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'init');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('counts the files by language, leaves the supported denominator alone, and skips default exclusions', () => {
    const surface = computeClaimedSurface({ projectDir: root, claims: { claims: [] } });
    expect(surface.sourceModules).toBe(1);
    expect(surface.unsupportedModules).toEqual({ total: 4, byLanguage: { apex: 3, 'salesforce-flow': 1 } });
  });

  it('a project with only unsupported source reads 0 supported and names the rest in the surface line', () => {
    const only = mkdtempSync(join(tmpdir(), 'tg-unsupported-only-'));
    try {
      git(only, 'init', '-q');
      write(only, 'src/main/java/demo/Discount.java', 'class Discount {}\n');
      write(only, 'src/test/java/demo/DiscountTest.java', 'class DiscountTest {}\n');
      git(only, 'add', '-A'); git(only, 'commit', '-qm', 'init');
      const doc = computeStatus({ projectDir: only, toolVersion: 't' });
      expect(doc.surface.sourceModules).toBe(0);
      expect(doc.surface.unsupportedModules).toEqual({ total: 2, byLanguage: { java: 2 } });
      expect(validate('status', doc).errors).toEqual([]);
      const text = renderStatus(doc);
      expect(text).toContain('0 of 0 source modules carry a claim');
      expect(text).toMatch(/unsupported:\s+2 more source files in languages TestGuard cannot probe \(Java 2\)/);
    } finally { rmSync(only, { recursive: true, force: true }); }
  });

  it('omits the field when there is nothing unsupported', () => {
    const plain = mkdtempSync(join(tmpdir(), 'tg-unsupported-none-'));
    try {
      write(plain, 'src/module.mjs', 'export const v = 1;\n');
      expect(computeClaimedSurface({ projectDir: plain, claims: { claims: [] } })).not.toHaveProperty('unsupportedModules');
    } finally { rmSync(plain, { recursive: true, force: true }); }
  });

  it('status over a change reports the unsupported files it saw, and the validator checks the sum', () => {
    write(root, 'force-app/main/default/classes/A.cls', 'public class A { Integer x; }\n');
    const doc = computeStatus({ projectDir: root, toolVersion: 't', changedRef: 'HEAD', includeDirty: true });
    expect(doc.changes.unsupported).toEqual({ total: 1, byLanguage: { apex: 1 } });
    expect(validate('status', doc).errors).toEqual([]);
    expect(renderStatus(doc)).toContain('1 changed file in languages TestGuard cannot probe (Apex 1)');
    const bad = { ...doc, changes: { ...doc.changes, unsupported: { total: 5, byLanguage: { apex: 1 } } } };
    expect(validate('status', bad).errors.length).toBeGreaterThan(0);
  });
});
