import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldFile } from '../src/scaffold/scaffold.mjs';
import { proposalsForLine, functionHead } from '../src/scaffold/producers.mjs';
import { locate } from '../src/probe/inject.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { main } from '../src/cli.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'known-answer');
const capture = () => { const lines = { out: [], err: [] }; return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } }; };

describe('scaffold on the known-answer fixture', () => {
  const { doc, stats } = scaffoldFile({ projectDir: FIXTURE, file: 'src/redact.mjs', toolVersion: 'test' });
  const all = doc.claims.flatMap((c) => c.faults.map((f) => ({ claim: c, ...f })));

  it('produces a conforming draft whose every anchor locates exactly as declared', () => {
    expect(validate('claims', doc).errors).toEqual([]);
    const source = readFileSync(join(FIXTURE, 'src/redact.mjs'), 'utf8');
    for (const f of all) expect(locate(source, f).status, f.description).toBe('ok');
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  it('proposes the shape-expressible fixture faults by anchor: the fail-closed guard and the masking mutation', () => {
    const guard = all.find((f) => f.find.includes('if (!ctx || !ctx.scope) {'));
    expect(guard).toMatchObject({ faultClass: 'condition-forced' });
    expect(guard.replace.trim()).toBe('if (false) {');
    const mutation = all.find((f) => f.find.includes("out = out.replace(rule.re, (m) => '*'.repeat(m.length));"));
    expect(mutation).toMatchObject({ faultClass: 'statement-deleted', replace: '' });
  });

  it('groups the guard under its @claim annotation and everything else by enclosing function', () => {
    expect(doc.claims.map((c) => c.id).sort()).toEqual(['REDACT-003', 'REDACT-FINDRULE', 'REDACT-MASK']);
    expect(doc.claims.find((c) => c.id === 'REDACT-MASK').statement).toMatch(/^TODO: state what `mask`/);
  });

  it('prefills defendedBy from discovery, marks provenance derived, never touches the claims file', () => {
    for (const c of doc.claims) {
      expect(c.defendedBy).toEqual(['test/redact.test.mjs']);
      expect(c.producedBy.producer).toBe('derived');
      for (const f of c.faults) expect(f.producedBy).toMatchObject({ producer: 'derived', by: 'testguard scaffold test' });
    }
    expect(stats.defendedBy).toEqual(['test/redact.test.mjs']);
  });
});

describe('scaffold producers on a synthetic security module', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-scaffold-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'src', 'auth.ts'), `import bcrypt from 'bcrypt';
export const COOKIE = { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 3600 };
const BCRYPT_COST = 12;
const tolerance = 300;
export function isAdmin(user) {
  return user.roles.includes('admin');
}
export async function handle(req, res) {
  if (!req.user) return res.status(401).end();
  if (!isAdmin(req.user)) {
    return res.status(403).end();
  }
  await verifySignature(req);
  req.session.touched = Date.now();
  req.session.touched = Date.now();
  return next();
}
`);
  writeFileSync(join(dir, 'test', 'auth.test.ts'), "import { handle } from '../src/auth';\n");
  writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify({ schemaVersion: 1, claims: [{ id: 'AUTH-ADMIN', statement: 'Only admins pass.', source: { kind: 'spec', ref: 'x' }, severity: 'critical', producedBy: { producer: 'human' }, defendedBy: ['test/auth.test.ts'], faults: [{ id: 'F1', description: 'd', faultClass: 'other', file: 'src/auth.ts', find: 'next()', replace: 'nope()', producedBy: { producer: 'human' } }] }] }));
  const { doc } = scaffoldFile({ projectDir: dir, file: 'src/auth.ts', toolVersion: 'test' });
  const all = doc.claims.flatMap((c) => c.faults);
  const byClass = (k) => all.filter((f) => f.faultClass === k);

  it('covers all five shapes', () => {
    expect(byClass('literal-changed').map((f) => f.replace.trim())).toEqual(expect.arrayContaining([
      expect.stringContaining('httpOnly: false'), expect.stringContaining("sameSite: 'none'"), expect.stringContaining('BCRYPT_COST = 1;'), expect.stringContaining('tolerance = 300000;'),
    ]));
    expect(byClass('return-altered')[0].replace.trim()).toBe('return true;');
    expect(byClass('statement-deleted').map((f) => f.find.trim())).toEqual(expect.arrayContaining(['if (!req.user) return res.status(401).end();', 'req.session.touched = Date.now();']));
    expect(byClass('condition-forced')[0].replace.trim()).toBe('if (false) {');
    expect(byClass('call-removed')[0].find.trim()).toBe('await verifySignature(req);');
  });

  it('computes expectHits/occurrence for a duplicated line so both anchors locate', () => {
    const dupes = all.filter((f) => f.find.trim() === 'req.session.touched = Date.now();');
    expect(dupes.map((f) => [f.expectHits, f.occurrence])).toEqual([[2, 1], [2, 2]]);
    const source = readFileSync(join(dir, 'src', 'auth.ts'), 'utf8');
    for (const f of all) expect(locate(source, f).status).toBe('ok');
    expect(validate('claims', doc).ok).toBe(true);
  });

  it('--claim puts everything under one claim and copies an existing claim\'s statement, severity and defenders', () => {
    const existing = JSON.parse(readFileSync(join(dir, 'testguard.claims.json'), 'utf8'));
    const { doc: one } = scaffoldFile({ projectDir: dir, file: 'src/auth.ts', claimId: 'AUTH-ADMIN', existingClaims: existing, toolVersion: 'test' });
    expect(one.claims).toHaveLength(1);
    expect(one.claims[0]).toMatchObject({ id: 'AUTH-ADMIN', statement: 'Only admins pass.', severity: 'critical', defendedBy: ['test/auth.test.ts'] });
    expect(one.claims[0].faults.length).toBe(all.length);
  });

  it('CLI writes the draft beside the evidence, prints the shapes, and refuses a missing file', async () => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const a = capture();
      expect(await main(['scaffold', 'src/auth.ts'], a.io)).toBe(0);
      expect(a.lines.out[0]).toMatch(/^\d+ proposed faults in \d+ draft claims for src\/auth\.ts — /);
      expect(existsSync(join(dir, '.testguard', 'scaffold-auth.json'))).toBe(true);
      expect(readFileSync(join(dir, 'testguard.claims.json'), 'utf8')).toContain('"AUTH-ADMIN"'); // untouched
      const b = capture();
      expect(await main(['scaffold', 'src/nope.ts'], b.io)).toBe(2);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('producer edge cases', () => {
  it('recognises function heads and ignores control keywords', () => {
    expect(functionHead('export async function handle(req) {')).toBe('handle');
    expect(functionHead('const isAdmin = (u) => u.admin;')).toBe('isAdmin');
    expect(functionHead('  async verify(token) {')).toBe('verify');
    expect(functionHead('  if (x) {')).toBeNull();
    expect(functionHead('  } catch (e) {')).toBeNull();
  });
  it('does not treat a comparison or a declaration as a mutation, nor a non-guard if as a guard', () => {
    expect(proposalsForLine(['  const a = b;'], 0)).toEqual([]);
    expect(proposalsForLine(['  if (a === b) {', '    count++;', '  }'], 0)).toEqual([]);
    expect(proposalsForLine(['  // if (!x) return;'], 0)).toEqual([]);
  });
});
