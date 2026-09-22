import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { probe } from '../src/probe/probe.mjs';
import { validate } from '../spec/lib/validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The persistence signal lived only in the sweep document, so `probe` could
// not surface it. This is the end-to-end proof that the evidence record now
// carries it — and only on the survivor whose fault sits on the write path.
// Built the way probe-error.test.mjs builds its repository: a real git tree,
// this project's node_modules linked in, probed in place.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-persist-signal-'));
  const g = (...a) => spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'src', 'db.mjs'), "export const db = { users: { create: async (args) => ({ id: 1, ...args.data }) } };\n");
  writeFileSync(join(dir, 'src', 'save.mjs'), [
    "import { db } from './db.mjs';",
    'export async function register(input) {',
    '  return db.users.create({',
    '    data: { email: input.email, name: input.name, termsVersion: input.termsVersion },',
    '  });',
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'src', 'guard.mjs'), 'export function allow(user) {\n  if (!user) return false;\n  return true;\n}\n');
  // Mocks the persistence layer and asserts a PARTIAL payload: the exact
  // pathology the signal describes. A dropped field passes this test.
  writeFileSync(join(dir, 'test', 'save.test.mjs'), [
    "import { it, expect, vi } from 'vitest';",
    "import { register } from '../src/save.mjs';",
    "import { db } from '../src/db.mjs';",
    "vi.mock('../src/db.mjs', () => ({ db: { users: { create: vi.fn(async (args) => ({ id: 1, ...args.data })) } } }));",
    "it('registers through the persistence layer', async () => {",
    "  await register({ email: 'a@b.c', name: 'A', termsVersion: '2026-01' });",
    "  expect(db.users.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ email: 'a@b.c' }) }));",
    '});',
    '',
  ].join('\n'));
  // Also mocks the layer, but its survivor is a guard: off the write path,
  // so the signal must NOT appear however the defender is shaped.
  writeFileSync(join(dir, 'test', 'guard.test.mjs'), [
    "import { it, expect, vi } from 'vitest';",
    "import { allow } from '../src/guard.mjs';",
    "vi.mock('../src/db.mjs', () => ({ db: {} }));",
    "it('allows a user', () => expect(allow({ id: 1 })).toBe(true));",
    '',
  ].join('\n'));
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  g('add', '-A');
  g('commit', '-qm', 'one');
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const producedBy = { producer: 'human', by: 'test' };
  const claims = {
    schemaVersion: 1,
    claims: [
      {
        id: 'SAVE-1', statement: 'Everything the form carried reaches the row.', severity: 'high', source: { kind: 'manual' }, producedBy,
        defendedBy: ['test/save.test.mjs'],
        faults: [{ id: 'F1', description: 'Field dropped: `termsVersion` is no longer written.', faultClass: 'field-dropped', file: 'src/save.mjs',
          find: '    data: { email: input.email, name: input.name, termsVersion: input.termsVersion },', replace: '    data: { email: input.email, name: input.name },', producedBy }],
      },
      {
        id: 'GUARD-1', statement: 'A missing user is refused.', severity: 'high', source: { kind: 'manual' }, producedBy,
        defendedBy: ['test/guard.test.mjs'],
        faults: [{ id: 'F1', description: 'Guard removed: a missing user is allowed.', faultClass: 'guard-removed', file: 'src/guard.mjs',
          find: '  if (!user) return false;', replace: '', producedBy }],
      },
    ],
  };
  return { dir, claims };
}

describe('the evidence carries the persistence signal, on the survivor it explains and nowhere else', () => {
  it('a surviving payload fault whose defender mocks the database is recorded with the signal, its reason and its assertion mix', async () => {
    const { dir, claims } = repo();
    try {
      const ev = await probe({ projectDir: dir, claims, mode: 'in-place', confirmRuns: 1, budgetMs: 60_000, escalate: false, toolVersion: 't' });
      const save = ev.records.find((r) => r.claim.id === 'SAVE-1');
      const guard = ev.records.find((r) => r.claim.id === 'GUARD-1');
      expect(save.verdict).toBe('survived');
      expect(guard.verdict).toBe('survived');

      expect(save.defenders.signals).toEqual([expect.objectContaining({
        file: 'test/save.test.mjs',
        signal: 'persistence-payload-unasserted',
        counts: { exact: 0, partial: 1, argless: 0 },
        specifiers: ['../src/db.mjs'],
      })]);
      expect(save.defenders.signals[0].reason).toMatch(/mocks \.\.\/src\/db\.mjs; 1 partial call assertion/);
      // The guard's defender mocks the same layer; its survivor is not on the
      // write path, so the signal would explain nothing and must be absent.
      expect(guard.defenders.signals ?? []).toEqual([]);
      // And the document that carries it is a conforming claimspec document.
      expect(validate('evidence', ev)).toMatchObject({ ok: true, errors: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
