// @req FR-08
// The change gate over a Java file (#329): claimable source under a build file,
// the gap it was without one. Starts a git repository for each case, so it is
// kept apart from the pure language tests.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { computeChangedGate, renderGate } from '../src/gate/changed.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { repo } from './helpers/gate-project.mjs';

describe('gate: a changed Java file under a build file is claimable source', () => {
  let r;
  beforeEach(() => { r = repo(); });
  afterEach(() => rmSync(r.root, { recursive: true, force: true }));
  const java = 'src/main/java/demo/Discount.java';
  const run = (extra = {}) => computeChangedGate({ projectDir: r.project, ref: 'HEAD', includeDirty: true, toolVersion: 't', ...extra });

  it('without a build file it is the gap it was', () => {
    r.write(java, 'class Discount {}\n');
    const doc = run();
    expect(doc.excluded).toContainEqual({ file: java, by: 'unsupported-language', language: 'java' });
    expect(renderGate(doc)).toContain('TestGuard cannot probe Java yet');
    expect(validate('gate', doc).errors).toEqual([]);
  });

  it('with a pom.xml it is uncovered source with a scaffold suggestion, and the gate fails', () => {
    r.write('pom.xml', '<project/>\n');
    r.write(java, 'class Discount {}\n');
    const doc = run();
    expect(doc.excluded.some((e) => e.by === 'unsupported-language')).toBe(false);
    expect(doc.uncovered).toContainEqual(expect.objectContaining({ file: java, kind: 'source', suggestion: `testguard scaffold ${java}` }));
    expect(doc.exitCode).toBe(1);
    expect(renderGate(doc)).not.toContain('cannot probe Java');
    expect(validate('gate', doc).errors).toEqual([]);
  });

  it('a changed JUnit test is an uncovered test, never source to scaffold', () => {
    r.write('pom.xml', '<project/>\n');
    r.write('src/test/java/demo/DiscountTest.java', 'class DiscountTest {}\n');
    const item = run().uncovered.find((u) => u.file.endsWith('DiscountTest.java'));
    expect(item).toMatchObject({ kind: 'test' });
    expect(item.suggestion).toContain('defendedBy');
    expect(validate('gate', run()).errors).toEqual([]);
  });

  it('a build file in a module excuses nothing outside it', () => {
    r.write('billing/pom.xml', '<project/>\n');
    r.write('billing/src/main/java/demo/A.java', 'class A {}\n');
    r.write('shipping/src/main/java/demo/B.java', 'class B {}\n');
    const doc = run();
    expect(doc.uncovered.map((u) => u.file)).toEqual(['billing/src/main/java/demo/A.java']);
    expect(doc.excluded).toContainEqual({ file: 'shipping/src/main/java/demo/B.java', by: 'unsupported-language', language: 'java' });
    expect(validate('gate', doc).errors).toEqual([]);
  });
});
