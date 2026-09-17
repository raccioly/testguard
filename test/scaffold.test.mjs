import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldFile } from '../src/scaffold/scaffold.mjs';
import { proposalsForLine, functionHead, functionParams, openerIndex } from '../src/scaffold/producers.mjs';
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

  it('proposes the two fixture faults the newer shapes express: the dropped content field and the swapped mask argument', () => {
    const dropped = all.find((f) => f.faultClass === 'field-dropped' && f.find.includes('content: redacted,'));
    expect(dropped).toMatchObject({ replace: '' });
    expect(dropped.description).toMatch(/Field dropped: `content`/);
    // every field of the audit row is proposed, and nothing outside a payload literal is
    expect(all.filter((f) => f.faultClass === 'field-dropped').map((f) => f.find.trim())).toEqual(['compiled.push({ ...rule, re });', "action: 'MASK',", 'scope: ctx.scope,', 'ruleCount: rules.length,', 'content: redacted,']);
    expect(all.find((f) => f.find.includes('compiled.push({ ...rule, re });')).replace.trim()).toBe('compiled.push({ re });'); // the inline merge loses its base
    const swapped = all.filter((f) => f.faultClass === 'argument-swapped').map((f) => f.replace.trim());
    expect(swapped).toContain('const redacted = mask(undefined, rules);');
    expect(swapped).toContain('for (const rule of compileRules(undefined)) {');
    expect(swapped.some((r) => /new RegExp\(undefined/.test(r))).toBe(false); // constructors are never swapped
  });

  it('groups the guard under its @claim annotation and everything else by enclosing function', () => {
    expect(doc.claims.map((c) => c.id).sort()).toEqual(['REDACT-003', 'REDACT-COMPILERULES', 'REDACT-FINDRULE', 'REDACT-MASK', 'REDACT-REDACT']);
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
  it('functionParams reads plain, defaulted, typed, rest and destructured parameters', () => {
    expect(functionParams('export async function redact(input, rules, ctx, store) {')).toEqual(['input', 'rules', 'ctx', 'store']);
    expect(functionParams('function f(a: string, b = 2, ...rest): void {')).toEqual(['a', 'b', 'rest']);
    expect(functionParams('const g = ({ user, scope: s }, [first]) => {')).toEqual(['user', 's', 'first']);
    expect(functionParams('const h = x => x + 1;')).toEqual(['x']);
    expect(functionParams('  async handle(req, res) {')).toEqual(['req', 'res']);
  });

  it('openerIndex names the innermost unmatched bracket before each line', () => {
    const lines = ['const a = {', '  b: [', "    'x',", '  ],', '  c: 1,', '};'];
    const idx = openerIndex(lines);
    expect(idx[0]).toBeNull();
    expect(idx[2]).toEqual({ line: 1, char: '[' });
    expect(idx[4]).toEqual({ line: 0, char: '{' });
    expect(idx[5]).toEqual({ line: 0, char: '{' });
  });
});

describe('field-dropped and argument-swapped on a synthetic save handler', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-scaffold-fd-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'src', '__tests__'), { recursive: true });
  const SOURCE = `import { z } from 'zod';
const WRITABLE_FIELDS = [
  'name',
  'hours',
  'timezone',
];
export const GroupPatch = z.object({
  name: z.string(),
  hours: HoursSchema.optional(),
});
interface Shape {
  name: string,
  hours: number,
}
export async function saveGroup(repo, existing, patch, req) {
  const merged = { ...existing, ...patch };
  const payload = {
    id: existing.id,
    name: patch.name,
    hours: patch.hours,
    updatedBy: req.user.id,
    label: describe(
      patch,
    ),
    format() { return 1; },
  };
  await repo.update(existing.id, {
    ...payload,
    version: existing.version + 1,
  });
  return notify(scheduleOf(existing), req.user.id);
}
export function untouched(a) {
  const out = compute(CONFIG.value, a);
  return helper('literal', 42);
}
`;
  writeFileSync(join(dir, 'src', 'group.ts'), SOURCE);
  writeFileSync(join(dir, 'src', '__tests__', 'group.test.ts'), "import { saveGroup } from '../group';\nconst payload = {\n  name: 'x',\n  hours: 1,\n};\nsaveGroup({ update: () => ({ ...payload, ok: true }) }, {}, payload, { user: { id: 'u' } });\n");
  const { doc } = scaffoldFile({ projectDir: dir, file: 'src/group.ts', toolVersion: 'test' });
  const all = doc.claims.flatMap((c) => c.faults);
  const drops = all.filter((f) => f.faultClass === 'field-dropped');
  const swaps = all.filter((f) => f.faultClass === 'argument-swapped');

  it('drops each field of the payload, the schema keys, the allow-list entries, and the spread bases — but never a type key, a method, or a multi-line property', () => {
    const finds = drops.map((f) => f.find.trim());
    expect(finds).toEqual(expect.arrayContaining([
      "'name',", "'hours',", "'timezone',",                 // allow-list
      'name: z.string(),', 'hours: HoursSchema.optional(),',  // schema
      'id: existing.id,', 'name: patch.name,', 'hours: patch.hours,', 'updatedBy: req.user.id,', // payload
      '...payload,', 'version: existing.version + 1,',        // persisted object and its spread base
    ]));
    expect(finds).not.toContain('name: string,');            // interface key
    expect(finds).not.toContain('format() { return 1; },');  // method
    expect(finds.some((f) => f.startsWith('label: describe('))).toBe(false); // value continues on the next line
    const inline = drops.find((f) => f.find.includes('{ ...existing, ...patch }'));
    expect(inline.replace.trim()).toBe('const merged = { ...patch };');
    for (const f of drops.filter((x) => x.replace === '')) expect(f.description).toMatch(/^\[line \d+\] (Field dropped|Base object dropped)/);
    expect(drops.find((f) => f.find.includes('name: z.string()')).description).toMatch(/from the schema/);
    expect(drops.find((f) => f.find.includes("'timezone'")).description).toMatch(/from the allow-list/);
  });

  it('swaps only parameter- or request-derived arguments, with both undefined and {} for a call-derived one', () => {
    const replaces = swaps.map((f) => f.replace.trim());
    expect(replaces).toContain('return notify(undefined, req.user.id);');
    expect(replaces).toContain('return notify({}, req.user.id);');
    expect(replaces).toContain('await repo.update(undefined, {');
    expect(replaces.some((r) => r.includes("helper(undefined"))).toBe(false); // literal argument
    expect(replaces.some((r) => r.includes('compute(undefined'))).toBe(false); // a module constant: not derived from a parameter, not request-like
    expect(replaces.some((r) => r.includes('z.object(undefined') || r.includes('z.string(undefined'))).toBe(false);
  });

  it('every proposal anchors exactly once and the draft conforms; the test file gets no field-dropped proposals', () => {
    const source = readFileSync(join(dir, 'src', 'group.ts'), 'utf8');
    for (const f of all) expect(locate(source, f).status, f.description).toBe('ok');
    expect(validate('claims', doc).errors).toEqual([]);
    const t = scaffoldFile({ projectDir: dir, file: 'src/__tests__/group.test.ts', toolVersion: 'test' });
    expect(t.doc.claims.flatMap((c) => c.faults).filter((f) => f.faultClass === 'field-dropped')).toEqual([]);
  });
});

describe('element-removed and handler-dropped on a synthetic JSX component', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-scaffold-jsx-'));
  mkdirSync(join(dir, 'src', '__tests__'), { recursive: true });
  const SOURCE = `import React from 'react';
export function GreetingRow({ on, save, submit }) {
  return (
    <section className="row">
      <label>Send a greeting</label>
      <Toggle checked={on} onChange={save} />
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => save(e.target.checked)}
      />
      <button onClick={submit}>Save</button>
      <Help>
        long content
      </Help>
    </section>
  );
}
`;
  writeFileSync(join(dir, 'src', 'row.tsx'), SOURCE);
  writeFileSync(join(dir, 'src', '__tests__', 'row.test.tsx'), "import { GreetingRow } from '../row';\nconst x = <Toggle onChange={save} />;\n");
  const { doc } = scaffoldFile({ projectDir: dir, file: 'src/row.tsx', toolVersion: 'test' });
  const all = doc.claims.flatMap((c) => c.faults);
  const removed = all.filter((f) => f.faultClass === 'element-removed');
  const handlers = all.filter((f) => f.faultClass === 'handler-dropped');

  it('removes one-line elements only, never a multi-line one', () => {
    expect(removed.map((f) => f.find.trim())).toEqual(['<label>Send a greeting</label>', '<Toggle checked={on} onChange={save} />', '<button onClick={submit}>Save</button>']);
    for (const f of removed) expect(f.replace).toBe('');
    expect(removed.map((f) => f.description)).toEqual(expect.arrayContaining([expect.stringContaining('`<Toggle>` is no longer rendered')]));
  });

  it('drops a handler prop on its own line and inline in a tag, keeping the element', () => {
    expect(handlers.map((f) => [f.find.trim(), f.replace.trim()])).toEqual(expect.arrayContaining([
      ['onChange={(e) => save(e.target.checked)}', ''],
      ['<Toggle checked={on} onChange={save} />', '<Toggle checked={on} />'],
      ['<button onClick={submit}>Save</button>', '<button>Save</button>'],
    ]));
    expect(handlers).toHaveLength(3);
  });

  it('every proposal anchors, the draft conforms, and a test file gets none of the UI shapes', () => {
    const source = readFileSync(join(dir, 'src', 'row.tsx'), 'utf8');
    for (const f of all) expect(locate(source, f).status, f.description).toBe('ok');
    expect(validate('claims', doc).errors).toEqual([]);
    const t = scaffoldFile({ projectDir: dir, file: 'src/__tests__/row.test.tsx', toolVersion: 'test' });
    expect(t.doc.claims.flatMap((c) => c.faults).filter((f) => /element-removed|handler-dropped/.test(f.faultClass))).toEqual([]);
  });
});
