import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConcerns, concernById, targetsFor, filterByConcern, renderConcerns, BUILTIN_CONCERNS } from '../src/supply/concerns.mjs';
import { validate } from '../spec/lib/validate.mjs';

const project = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-concerns-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
};
const doc = (concerns) => JSON.stringify({ schemaVersion: 1, concerns });

describe('the built-ins — two, because two can be aimed honestly', () => {
  it('ship without anything written', () => {
    const dir = project({ 'src/a.ts': 'x' });
    const l = loadConcerns(dir);
    expect(l.concerns.map((c) => c.id)).toEqual(['SAVE-PERSISTS', 'CHANGED-CODE']);
    expect(l.source).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the persistence concern leads with the class every measured survivor had', () => {
    const save = BUILTIN_CONCERNS.find((c) => c.id === 'SAVE-PERSISTS');
    expect(save.faultClasses[0]).toBe('field-dropped');
    expect(save.targets).toEqual({ kind: 'write-sites' });
  });

  it('carry no authorization concern, because its targets cannot be enumerated honestly', () => {
    // A heuristic for "which files check permissions" would guess, and a guess
    // there is the non-actionable noise that gets a check switched off. A
    // project that knows its own auth layer says so with a glob.
    expect(BUILTIN_CONCERNS.map((c) => c.id)).not.toContain('AUTHZ');
  });
});

describe('loadConcerns — a project may replace a built-in, and is told that it did', () => {
  it('a same-id concern replaces the default', () => {
    const dir = project({ 'testguard.concerns.json': doc([{ id: 'SAVE-PERSISTS', statement: 'our ORM', targets: { kind: 'write-sites' } }]) });
    const l = loadConcerns(dir);
    expect(l.concerns.filter((c) => c.id === 'SAVE-PERSISTS')).toHaveLength(1);
    expect(concernById(l.concerns, 'SAVE-PERSISTS').statement).toBe('our ORM');
    expect(l.shadowed).toEqual(['SAVE-PERSISTS']);
    expect(renderConcerns(l)).toMatch(/replaces the built-in SAVE-PERSISTS/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('hands back the project entries EXACTLY as written, for validation', () => {
    // The enriched objects carry a `builtin` marker this tool added. Validating
    // what we constructed instead of what the user wrote would report our bug
    // as their malformed file.
    const dir = project({ 'testguard.concerns.json': doc([{ id: 'X', statement: 's', targets: { kind: 'changed' } }]) });
    const l = loadConcerns(dir);
    expect(l.raw).toEqual([{ id: 'X', statement: 's', targets: { kind: 'changed' } }]);
    expect(validate('concerns', { schemaVersion: 1, concerns: l.raw })).toEqual({ ok: true, errors: [] });
    rmSync(dir, { recursive: true, force: true });
  });

  it('an unknown id is null, never a near match', () =>
    expect(concernById(BUILTIN_CONCERNS, 'SAVE_PERSISTS')).toBeNull());
});

describe('targetsFor — where a concern looks', () => {
  it('a glob matches the whole project, never only the diff', () => {
    // A concern like "every admin route refuses an unauthorised caller" is
    // about the admin routes, not the ones that changed today. Pooling from the
    // diff made such a concern report clean on a clean branch — the exact false
    // reassurance a concern exists to prevent.
    const dir = project({ 'src/admin/a.ts': 'x', 'src/admin/b.ts': 'x', 'src/other/c.ts': 'x' });
    const t = targetsFor(dir, { targets: { kind: 'glob', globs: ['src/admin/**'] } }, { changedFiles: [] });
    expect(t.sort()).toEqual(['src/admin/a.ts', 'src/admin/b.ts']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a changed concern defers to the caller rather than re-deriving the diff', () => {
    const dir = project({ 'src/a.ts': 'x' });
    expect(targetsFor(dir, { targets: { kind: 'changed' } }, { changedFiles: ['src/a.ts'] })).toEqual(['src/a.ts']);
    expect(targetsFor(dir, { targets: { kind: 'changed' } }, {})).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('write-sites asks the enumerator', () => {
    const dir = project({ 'src/a.ts': 'await prisma.user.create({\n  data: {\n    email,\n  },\n});\n', 'src/b.ts': 'export const x = 1;\n' });
    expect(targetsFor(dir, { targets: { kind: 'write-sites' } })).toEqual(['src/a.ts']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('filterByConcern — narrowing is what makes one sentence useful', () => {
  const c = (faultClass) => ({ claim: { id: 'C' }, fault: { id: 'S1', faultClass } });
  const candidates = [c('field-dropped'), c('return-altered'), c('guard-removed')];

  it('keeps only the classes the concern names', () =>
    expect(filterByConcern(candidates, { faultClasses: ['field-dropped'] })).toHaveLength(1));

  it('no fault classes means every class, the honest default', () => {
    expect(filterByConcern(candidates, { faultClasses: null })).toHaveLength(3);
    expect(filterByConcern(candidates, {})).toHaveLength(3);
    expect(filterByConcern(candidates, null)).toHaveLength(3);
  });
});

describe('the concerns document', () => {
  const v = (concerns) => validate('concerns', { schemaVersion: 1, concerns }).errors.map((e) => e.message);

  it('a glob target naming no globs would match nothing and report clean', () =>
    expect(v([{ id: 'A', statement: 's', targets: { kind: 'glob' } }]).join()).toMatch(/targets a glob but names none/));

  it('globs on a non-glob target are a mistake, not a hint', () =>
    expect(v([{ id: 'A', statement: 's', targets: { kind: 'changed', globs: ['x'] } }]).join()).toMatch(/names globs but does not target them/));

  it('an empty fault-class list is a typo for "every class", every time', () =>
    expect(v([{ id: 'A', statement: 's', faultClasses: [] }]).join()).toMatch(/allows no fault class; omit the field/));

  it('two concerns cannot share an id', () =>
    expect(v([{ id: 'A', statement: 's' }, { id: 'A', statement: 't' }]).join()).toMatch(/duplicate concern id "A"/));

  it('a minimal concern is one id and one sentence', () =>
    expect(validate('concerns', { schemaVersion: 1, concerns: [{ id: 'A', statement: 'Every save persists its data.' }] })).toEqual({ ok: true, errors: [] }));
});
