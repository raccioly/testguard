import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeSitesIn, payloadKeys, balancedArgs, isSaveSource, saveSurface, renderSurface } from '../src/supply/savepath.mjs';

const project = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-savepath-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
};

describe('balancedArgs — one call, not the next one', () => {
  it('stops at the matching parenthesis', () => {
    const src = 'a(1, 2); b(3);';
    expect(balancedArgs(src, 1).text).toBe('1, 2');
  });

  it('a parenthesis inside a string is not a parenthesis', () => {
    const src = `q("insert into t ) values", x)`;
    expect(balancedArgs(src, 1).text).toBe('"insert into t ) values", x');
  });

  it('nested calls close at the outer level', () => {
    const src = 'f(g(h(1)), 2)';
    expect(balancedArgs(src, 1).text).toBe('g(h(1)), 2');
  });
});

describe('payloadKeys — both property forms, because shorthand is the common case', () => {
  it('reads `name: value` and bare `name,` alike', () => {
    // Every surviving payload fault measured on a real register action was
    // shorthand — email, username, password_hash. A colon-only pattern would
    // miss exactly the fields this exists to find.
    const args = ['{', '  data: {', '    email,', '    role: "user",', '  },', '}'].join('\n');
    expect(payloadKeys(args, 10).map((k) => k.key)).toEqual(['data', 'email', 'role']);
  });

  it('reports the line each key sits on, because that is what a fault anchors to', () => {
    const args = ['{', '  email,', '}'].join('\n');
    expect(payloadKeys(args, 55)).toEqual([{ key: 'email', line: 56 }]);
  });

  it('a key that shares a line with the call has no line to delete, so it is not reported', () => {
    expect(payloadKeys('{ where, data }', 1)).toEqual([]);
  });
});

describe('writeSitesIn — what this file puts into storage', () => {
  it('finds a multi-line write and its payload', () => {
    const src = [
      'export async function register(input) {',
      '  return prisma.user.create({',
      '    data: {',
      '      email,',
      '      password_hash,',
      '    },',
      '  });',
      '}',
    ].join('\n');
    const [site] = writeSitesIn(src, 'src/register.ts');
    expect(site).toMatchObject({ file: 'src/register.ts', line: 2, receiver: 'prisma', model: 'user', operation: 'create' });
    expect(site.keys.map((k) => k.key)).toEqual(['data', 'email', 'password_hash']);
    expect(site.keys.find((k) => k.key === 'password_hash').line).toBe(5);
  });

  it('two writes in a row do not share a payload', () => {
    // The failure a fixed-width window produces: the second call's fields read
    // as the first call's.
    const src = [
      'await prisma.a.create({ data: { x: 1 } });',
      'await prisma.b.create({',
      '  data: {',
      '    y: 2,',
      '  },',
      '});',
    ].join('\n');
    const sites = writeSitesIn(src, 'f.ts');
    expect(sites).toHaveLength(2);
    expect(sites[0].keys).toEqual([]);
    expect(sites[1].keys.map((k) => k.key)).toEqual(['data', 'y']);
  });

  it('recognises other clients and a transaction handle', () => {
    const src = 'await tx.invitation.upsert({});\nawait db.orders.insertOne({});\nawait knex.raw(`INSERT INTO t VALUES (1)`);';
    expect(writeSitesIn(src, 'f.ts').map((s) => s.operation)).toEqual(expect.arrayContaining(['upsert', 'insertOne', 'insert']));
  });

  it('a delete is a save path too', () => {
    // A save path that stops deleting is as broken as one that stops writing,
    // and account deletion is where that matters most.
    expect(writeSitesIn('await prisma.user.deleteMany({ where: { id } });', 'f.ts')[0].operation).toBe('deleteMany');
  });

  it('a read is not a write', () => {
    expect(writeSitesIn('const u = await prisma.user.findUnique({ where: { id } });', 'f.ts')).toEqual([]);
  });

  it('is ordered by line, so the surface does not reshuffle between runs', () => {
    const src = 'await prisma.b.update({});\nawait prisma.a.create({});';
    expect(writeSitesIn(src, 'f.ts').map((s) => s.line)).toEqual([1, 2]);
  });
});

describe('isSaveSource — the product’s own save path, not a test of one', () => {
  it.each([
    ['src/app/actions/profile.ts', true],
    ['src/lib/db.tsx', true],
    ['src/tests/actions/profile.test.ts', false],
    ['test/redact.spec.mjs', false],
    ['src/__mocks__/prisma.ts', false],
    ['prisma/migrations/001/migration.ts', false],
    ['README.md', false],
  ])('%s → %s', (file, expected) => expect(isSaveSource(file)).toBe(expected));
});

describe('saveSurface — the denominator', () => {
  it('counts files, sites and payload fields, and skips tests', () => {
    const dir = project({
      'src/a.ts': 'await prisma.user.create({\n  data: {\n    email,\n  },\n});\n',
      'src/b.ts': 'await prisma.post.deleteMany({ where: { id } });\n',
      'src/tests/a.test.ts': 'vi.mock("@/lib/prisma");\nawait prisma.user.create({ data: { email } });\n',
      'src/c.ts': 'export const read = () => prisma.user.findMany();\n',
    });
    const s = saveSurface(dir);
    expect(s.fileCount).toBe(2);
    expect(s.siteCount).toBe(2);
    expect(s.keyCount).toBe(2);
    expect(s.files.map((f) => f.file)).toEqual(['src/a.ts', 'src/b.ts']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds raw SQL in EVERY file, not only the first one scanned', () => {
    // The g-flag trap. `HAS_SQL.test(a)` then `HAS_SQL.test(b)` on a shared
    // g-flagged RegExp answers the second question from where the first one
    // stopped, so whether a file is on the surface depends on the order the
    // files were read. Three files, all SQL-only, all must be found.
    const sql = (t) => `export const run = () => knex.raw("INSERT INTO ${t} (a) VALUES (1)");\n`;
    const dir = project({ 'src/a.ts': sql('one'), 'src/b.ts': sql('two'), 'src/c.ts': sql('three') });
    const s = saveSurface(dir);
    expect(s.files.map((f) => f.file)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(s.siteCount).toBe(3);
    // And the same answer whichever order the caller hands them over.
    expect(saveSurface(dir, { files: ['src/c.ts', 'src/a.ts', 'src/b.ts'] }).siteCount).toBe(3);
    rmSync(dir, { recursive: true, force: true });
  });

  it('says so when a project writes nothing, rather than reporting an empty list', () => {
    const dir = project({ 'src/a.ts': 'export const add = (a, b) => a + b;\n' });
    expect(saveSurface(dir).fileCount).toBe(0);
    expect(renderSurface(saveSurface(dir))).toMatch(/no write to storage found/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders the denominator before anything else', () => {
    const dir = project({ 'src/a.ts': 'await prisma.user.create({\n  data: {\n    email,\n  },\n});\n' });
    // A report that lists findings without saying how much was looked at
    // invites the reader to assume the rest is fine.
    expect(renderSurface(saveSurface(dir)).split('\n')[0]).toMatch(/1 write to storage across 1 file, carrying 2 payload fields/);
    rmSync(dir, { recursive: true, force: true });
  });
});
