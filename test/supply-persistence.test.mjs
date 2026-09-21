import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { persistenceMocks, payloadAssertions, analyzePersistence, persistenceSignals, persistenceHint } from '../src/supply/persistence.mjs';

const project = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-persist-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
};

describe('persistenceMocks — which mocks mean "the database"', () => {
  it('recognises the layer by name, however the project paths it', () => {
    const src = `
vi.mock('@/lib/prisma', () => ({ prisma }));
jest.mock('../db', () => ({}));
vi.mock('~/server/drizzle', () => ({}));
`;
    expect(persistenceMocks(src).map((m) => m.specifier)).toEqual(['@/lib/prisma', '../db', '~/server/drizzle']);
  });

  it('a mock of something else is not a persistence mock', () => {
    const src = `vi.mock('@/auth', () => ({}));\nvi.mock('next/cache', () => ({}));\n`;
    expect(persistenceMocks(src)).toEqual([]);
  });
});

describe('payloadAssertions — an exact argument is the only one a dropped field can fail', () => {
  it('separates exact, partial and argument-free', () => {
    const src = `
expect(mocks.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { email: 'a@b.c' } });
expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ data: { id: 1 } }));
expect(mocks.update).toHaveBeenCalled();
expect(mocks.create).toHaveBeenCalledTimes(1);
`;
    expect(payloadAssertions(src)).toEqual({ exact: 1, partial: 1, argless: 2 });
  });

  it('reads an argument that wraps across lines', () => {
    const src = `
expect(mocks.create).toHaveBeenCalledWith({
  data: expect.objectContaining({ email }),
});
`;
    expect(payloadAssertions(src)).toEqual({ exact: 0, partial: 1, argless: 0 });
  });
});

describe('analyzePersistence — describes the shape, and refuses to score it', () => {
  it('is silent about a defender that never mocks a persistence layer', () => {
    const dir = project({ 't.test.ts': `vi.mock('@/auth');\nexpect(x).toBe(1);\n` });
    expect(analyzePersistence(dir, 't.test.ts')).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fires on a file that mocks the database, WHATEVER its assertion mix', () => {
    // The rule this replaced silenced itself on any exact assertion. Measured
    // against 26 probed faults that fired on 1 of 10 files while 4 had
    // survivors: one file had a single exact assertion among forty and every
    // payload fault survived, another had the same one and none did. No
    // file-level threshold separates them, so the shape is reported and the
    // probe keeps the verdict.
    const loose = project({ 't.test.ts': `vi.mock('@/lib/prisma');\nexpect(m.create).toHaveBeenCalled();\n` });
    const mixed = project({ 't.test.ts': `vi.mock('@/lib/prisma');\nexpect(m.create).toHaveBeenCalledWith({ data: { a: 1 } });\nexpect(m.update).toHaveBeenCalled();\n` });
    expect(analyzePersistence(loose, 't.test.ts').signal).toBe('persistence-payload-unasserted');
    expect(analyzePersistence(mixed, 't.test.ts').signal).toBe('persistence-payload-unasserted');
    expect(analyzePersistence(mixed, 't.test.ts').counts).toEqual({ exact: 1, partial: 0, argless: 1 });
    for (const d of [loose, mixed]) rmSync(d, { recursive: true, force: true });
  });

  it('names the layer and the assertion mix, so a reader can disagree with the inference', () => {
    const dir = project({ 't.test.ts': `vi.mock('@/lib/prisma');\nexpect(m.c).toHaveBeenCalledWith(expect.objectContaining({ a: 1 }));\nexpect(m.u).toHaveBeenCalled();\n` });
    const s = analyzePersistence(dir, 't.test.ts');
    expect(s.reason).toContain('@/lib/prisma');
    expect(s.reason).toContain('1 partial');
    expect(s.reason).toContain('1 argument-free');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a file that cannot be read is not a signal', () => {
    const dir = project({});
    expect(analyzePersistence(dir, 'missing.test.ts')).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('persistenceSignals and the hint', () => {
  it('reports only the defenders that mock a persistence layer', () => {
    const dir = project({
      'a.test.ts': `vi.mock('@/lib/prisma');\nexpect(m.c).toHaveBeenCalled();\n`,
      'b.test.ts': `vi.mock('@/auth');\nexpect(x).toBe(1);\n`,
    });
    expect(persistenceSignals(dir, ['a.test.ts', 'b.test.ts']).map((s) => s.file)).toEqual(['a.test.ts']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('the hint names the dropped field, which is what the assertion has to say', () => {
    const dir = project({ 'a.test.ts': `vi.mock('@/lib/prisma');\nexpect(m.c).toHaveBeenCalled();\n` });
    const hint = persistenceHint(analyzePersistence(dir, 'a.test.ts'), '      password_hash,');
    expect(hint).toContain('password_hash');
    expect(hint).toContain('read the record back');
    rmSync(dir, { recursive: true, force: true });
  });
});
