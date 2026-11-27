// Java fault producers (#329, #333). Each proposal is one line, anchored by
// the line itself, and written so the file still compiles: a replacement that
// does not compile is a wasted probe run, so the shapes refuse what they
// cannot make safe, and an argument is swapped for `null`, never `undefined`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { javaProducers, javaFunctionHead, javaFunctionParams } from '../src/scaffold/producers.java.mjs';
import { scaffoldFile } from '../src/scaffold/scaffold.mjs';
import { validate } from '../spec/lib/validate.mjs';

const propose = (...lines) => lines.flatMap((_, i) => javaProducers.proposalsForLine(lines, i, { params: new Set(['user', 'order']) }));
const replaced = (...lines) => propose(...lines).map((p) => p.replace);

describe('the producer set is Java\'s', () => {
  it('declares the one extension it applies to, so Kotlin never gets Java shapes', () => {
    expect(javaProducers.extensions).toEqual(['.java']);
    for (const key of ['proposalsForLine', 'functionHead', 'functionParams', 'isComment']) expect(typeof javaProducers[key]).toBe('function');
  });
});

describe('condition-forced', () => {
  it('forces a block if to false and to true', () => {
    expect(replaced('        if (price < 0) {', '            throw new IllegalArgumentException();', '        }')).toEqual(['        if (false) {', '        if (true) {']);
  });

  it('keeps nested parentheses and an else-if', () => {
    expect(replaced('    } else if (a && (b || c)) {')).toEqual(['    } else if (false) {', '    } else if (true) {']);
  });

  it('refuses a pattern-matching instanceof: its binding would no longer be defined', () => {
    expect(propose('        if (o instanceof Money m) {')).toEqual([]);
    expect(replaced('        if (o instanceof Money) {')).toEqual(['        if (false) {', '        if (true) {']);
  });

  it('proposes nothing for a loop header, a comment or a string', () => {
    expect(propose('        while (running) {', '        // if (x) {', '        String s = "if (x) {";')).toEqual([]);
  });
});

describe('null-guard removed', () => {
  it('removes a single-line guard that returns or throws', () => {
    const p = propose('        if (user == null) throw new IllegalArgumentException("user");');
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ faultClass: 'statement-deleted', replace: '' });
    expect(p[0].description).toMatch(/null/i);
  });

  it('removes requireNonNull', () => {
    const p = propose('        Objects.requireNonNull(order);', '        requireNonNull(user, "user");');
    expect(p.map((x) => x.faultClass)).toEqual(['call-removed', 'call-removed']);
    expect(p.map((x) => x.replace)).toEqual(['', '']);
  });

  it('does not remove an assignment that happens to say requireNonNull', () => {
    expect(propose('        this.user = Objects.requireNonNull(user);')).toEqual([]);
  });
});

describe('return-altered', () => {
  it.each([
    ['            return price * 90 / 100;', null],
    ['            return 90;', '            return 0;'],
    ['            return 0;', '            return 1;'],
    ['            return -1;', '            return 0;'],
    ['            return 2.5;', '            return 0;'],
    ['            return "member";', '            return "";'],
    ['            return "";', '            return "x";'],
    ['            return true;', '            return false;'],
    ['            return false;', '            return true;'],
  ])('%s', (line, expected) => {
    const out = propose(line).filter((p) => p.faultClass === 'return-altered').map((p) => p.replace);
    expect(out).toEqual(expected === null ? [] : [expected]);
  });

  it('turns a boolean check into return true', () => {
    expect(propose('        return user != null && user.isActive();').map((p) => p.replace)).toEqual(['        return true;']);
    expect(propose('        return a.equals(b);').map((p) => p.replace)).toEqual(['        return true;']);
  });

  it('never rewrites a ternary: its type is not boolean', () => {
    expect(propose('        return a == b ? 1 : 2;')).toEqual([]);
  });
});

describe('literal-changed: a boolean literal swapped', () => {
  it('swaps the first literal in a declaration and a call argument', () => {
    expect(replaced('        boolean strict = true;')).toEqual(['        boolean strict = false;']);
    expect(replaced('        validator.configure(false, limit);')).toEqual(['        validator.configure(true, limit);']);
  });

  it('refuses where the swap would not compile or would say nothing: loops, annotations, asserts, strings, comments', () => {
    expect(propose('        while (true) {', '        for (;;) {', '        @Test(enabled = true)', '        assert true;', '        String s = "true";', '        // true').filter((p) => p.faultClass === 'literal-changed')).toEqual([]);
  });
});

describe('argument-swapped', () => {
  it('swaps a parameter-derived argument for null, never undefined', () => {
    const p = propose('        validator.check(user);');
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ faultClass: 'argument-swapped', replace: '        validator.check(null);' });
    expect(p[0].description).toContain('null');
    expect(JSON.stringify(p)).not.toContain('undefined');
  });

  it('keeps the other arguments and a property access argument', () => {
    expect(replaced('        repository.save(order.items(), true);')).toContain('        repository.save(null, true);');
  });

  it('does not touch a literal, a constructor, a logger or a string conversion', () => {
    expect(propose('        validator.check("x");', '        Foo f = new Foo(user);', '        log.info(user);', '        String s = String.valueOf(user);', '        System.out.println(user);').filter((p) => p.faultClass === 'argument-swapped')).toEqual([]);
  });

  it('does not touch an argument that is not derived from a parameter', () => {
    expect(propose('        validator.check(other);').filter((p) => p.faultClass === 'argument-swapped')).toEqual([]);
  });
});

describe('functionHead and functionParams', () => {
  it.each([
    ['    public static int apply(int price, boolean member) {', 'apply'],
    ['    private void save(User user) throws IOException {', 'save'],
    ['    <T> List<T> copy(List<T> in) {', 'copy'],
    ['    public Discount(String code) {', 'Discount'],
    ['    int count() {', 'count'],
  ])('%s is %s', (line, name) => expect(javaFunctionHead(line)).toBe(name));

  it.each(['        if (x) {', '        } else if (x) {', '        while (x) {', '        for (int i = 0; i < n; i++) {', '        return new Foo(x) {', '        switch (x) {', '        catch (Exception e) {', '        synchronized (this) {'])('%s is no function head', (line) => {
    expect(javaFunctionHead(line)).toBeNull();
  });

  it('lists reference-typed parameters only: null does not compile for a primitive', () => {
    expect(javaFunctionParams('    public static int apply(int price, boolean member, String code, final User user, int[] xs) {')).toEqual(['code', 'user', 'xs']);
  });

  it('reads generics with commas and annotations', () => {
    expect(javaFunctionParams('    void put(@NotNull Map<String, Integer> byName, @Nullable String key) {')).toEqual(['byName', 'key']);
  });

  it('is empty for a line with no parameters', () => {
    expect(javaFunctionParams('    int count() {')).toEqual([]);
  });
});

describe('scaffold on a Java file in a Maven project', () => {
  let dir;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-scaffold-java-')));
    mkdirSync(join(dir, 'src/main/java/demo'), { recursive: true });
    writeFileSync(join(dir, 'pom.xml'), '<project/>\n');
    writeFileSync(join(dir, 'src/main/java/demo/Discount.java'), [
      'package demo;', '', 'public class Discount {',
      '    public static int apply(int price, boolean member, String code) {',
      '        if (price < 0) {', '            throw new IllegalArgumentException("negative price");', '        }',
      '        if (member) {', '            return price * 90 / 100;', '        }',
      '        validator.check(code);',
      '        return 100;', '    }', '}', '',
    ].join('\n'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('proposes Java faults, never JavaScript ones, and the draft conforms', () => {
    const { doc, stats } = scaffoldFile({ projectDir: dir, file: 'src/main/java/demo/Discount.java' });
    expect(stats.unsupported).toBeUndefined();
    expect(stats.proposals).toBe(6);
    const faults = doc.claims.flatMap((c) => c.faults);
    expect(faults.some((f) => f.replace.includes('undefined'))).toBe(false);
    expect(faults.map((f) => f.faultClass)).toEqual(expect.arrayContaining(['condition-forced', 'return-altered', 'argument-swapped']));
    expect(validate('claims', doc).errors).toEqual([]);
    expect(doc.claims[0].faults.find((f) => f.faultClass === 'argument-swapped').replace).toBe('        validator.check(null);');
  });

  it('groups proposals under the enclosing method', () => {
    const { doc } = scaffoldFile({ projectDir: dir, file: 'src/main/java/demo/Discount.java' });
    expect(doc.claims).toHaveLength(1);
    expect(doc.claims[0].statement).toContain('`apply`');
  });

  it('says defenders cannot be discovered for Java, and prefills none', () => {
    const { stats } = scaffoldFile({ projectDir: dir, file: 'src/main/java/demo/Discount.java' });
    expect(stats.defendedBy).toEqual([]);
    expect(stats.discovery).toEqual({ supported: false, extension: '.java' });
  });

  it('without a build file the file is still refused, as before', () => {
    rmSync(join(dir, 'pom.xml'));
    const { stats } = scaffoldFile({ projectDir: dir, file: 'src/main/java/demo/Discount.java' });
    expect(stats.unsupported).toMatchObject({ extension: '.java', language: 'Java' });
    expect(stats.proposals).toBe(0);
  });

  it('a Kotlin file under the same pom is still refused: the Java shapes do not parse as Kotlin', () => {
    mkdirSync(join(dir, 'src/main/kotlin'), { recursive: true });
    writeFileSync(join(dir, 'src/main/kotlin/Price.kt'), 'fun f(x: Int): Int { return x }\n');
    const { stats } = scaffoldFile({ projectDir: dir, file: 'src/main/kotlin/Price.kt' });
    expect(stats.unsupported).toMatchObject({ extension: '.kt', language: 'Kotlin' });
  });
});

describe('scaffold command on a Java file in a Maven project', () => {
  it('writes a draft, exits 0, and says defenders cannot be discovered rather than blaming the tests', async () => {
    const { main } = await import('../src/cli.mjs');
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-scaffold-java-cli-')));
    try {
      mkdirSync(join(dir, 'src/main/java/demo'), { recursive: true });
      writeFileSync(join(dir, 'pom.xml'), '<project/>\n');
      writeFileSync(join(dir, 'src/main/java/demo/Access.java'), 'package demo;\n\npublic class Access {\n    public void save(User user) {\n        validator.check(user);\n    }\n}\n');
      const lines = { out: [], err: [] };
      const io = { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) };
      const cwd = process.cwd();
      process.chdir(dir);
      try { expect(await main(['scaffold', 'src/main/java/demo/Access.java'], io)).toBe(0); } finally { process.chdir(cwd); }
      const text = lines.out.join('\n') + lines.err.join('\n');
      expect(text).toMatch(/1 proposed fault/);
      expect(text).toMatch(/cannot discover defenders for \.java files/);
      expect(text).not.toMatch(/no test file imports/);
      expect(text).not.toMatch(/no producers/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
