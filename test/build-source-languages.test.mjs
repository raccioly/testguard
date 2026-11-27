// @req FR-08
// Java and Kotlin are probeable source only where a build file says a built-in
// adapter (maven, gradle) can run them (#329). Without one they stay a reported
// gap, so the gate never calls code it cannot probe "claimed" or "non-source".
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceClassifier, unsupportedLanguage, languageName, BUILD_SOURCE, KNOWN_SOURCE, SOURCE_EXT } from '../src/gate/languages.mjs';
import { isTestFile } from '../src/gate/changed.mjs';

let dir;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-build-src-'))); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const touch = (rel, text = '') => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };

describe('the two tables hold different things', () => {
  it('java and kotlin are build-system source, not unprobeable source and not always-probeable source', () => {
    expect(BUILD_SOURCE.map((l) => l.id)).toEqual(['java', 'kotlin']);
    expect(KNOWN_SOURCE.map((l) => l.id)).not.toContain('java');
    expect(KNOWN_SOURCE.map((l) => l.id)).not.toContain('kotlin');
    expect(SOURCE_EXT.has('.java')).toBe(false);
  });

  it('names both tables, so a count never prints a bare id', () => {
    expect(languageName('java')).toBe('Java');
    expect(languageName('kotlin')).toBe('Kotlin');
    expect(languageName('apex')).toBe('Apex');
  });

  it('with no project, a Java file is still the gap it was', () => {
    expect(unsupportedLanguage('src/main/java/demo/Discount.java')?.id).toBe('java');
    expect(unsupportedLanguage('app/Service.kt')?.id).toBe('kotlin');
  });
});

describe('sourceClassifier: the build file decides', () => {
  it('a project with no build file keeps Java as an unsupported language', () => {
    const c = sourceClassifier(dir);
    expect(c.probeable('src/main/java/demo/Discount.java')).toBe(false);
    expect(c.unsupported('src/main/java/demo/Discount.java')?.id).toBe('java');
  });

  it('pom.xml makes Java and Kotlin probeable, and names the runner', () => {
    touch('pom.xml', '<project/>');
    const c = sourceClassifier(dir);
    expect(c.probeable('src/main/java/demo/Discount.java')).toBe(true);
    expect(c.probeable('src/main/kotlin/demo/Price.kt')).toBe(true);
    expect(c.unsupported('src/main/java/demo/Discount.java')).toBeNull();
    expect(c.runnersFor('src/main/java/demo/Discount.java')).toEqual(['maven']);
  });

  it.each(['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'])('%s makes it gradle', (marker) => {
    touch(marker, '');
    expect(sourceClassifier(dir).runnersFor('src/main/java/demo/A.java')).toEqual(['gradle']);
  });

  it('a build file in a module directory above the file counts, one in a sibling does not', () => {
    touch('billing/pom.xml', '<project/>');
    const c = sourceClassifier(dir);
    expect(c.probeable('billing/src/main/java/demo/A.java')).toBe(true);
    expect(c.probeable('shipping/src/main/java/demo/B.java')).toBe(false);
    expect(c.unsupported('shipping/src/main/java/demo/B.java')?.id).toBe('java');
  });

  it('a build file never makes another language probeable', () => {
    touch('pom.xml', '<project/>');
    const c = sourceClassifier(dir);
    for (const file of ['force-app/main/default/classes/A.cls', 'cmd/main.go', 'lib/Thing.scala']) {
      expect(c.probeable(file), file).toBe(false);
      expect(c.unsupported(file), file).not.toBeNull();
    }
  });

  it('JavaScript and Python are probeable with or without a build file', () => {
    const c = sourceClassifier(dir);
    for (const file of ['src/a.ts', 'src/a.mjs', 'tool.py']) expect(c.probeable(file)).toBe(true);
    expect(c.unsupported('src/a.ts')).toBeNull();
  });
});

describe('isTestFile knows JUnit layout', () => {
  it.each([
    'src/test/java/demo/DiscountTest.java',
    'src/test/kotlin/demo/PriceTests.kt',
    'billing/src/test/java/demo/Helper.java',
    'src/main/java/demo/DiscountTest.java',
    'src/test/java/demo/IntegrationTestCase.java',
    'src/test/kotlin/demo/Helper.kt',
    'src/main/java/demo/PriceTests.java',
  ])('%s is a test', (file) => expect(isTestFile(file)).toBe(true));

  it.each([
    'src/main/java/demo/Discount.java',
    'src/main/kotlin/demo/Price.kt',
    'src/main/java/demo/Contest.java',
    'src/main/java/demo/Testament.java',
  ])('%s is source', (file) => expect(isTestFile(file)).toBe(false));
});

