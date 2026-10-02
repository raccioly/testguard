import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validate } from '../spec/lib/validate.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-annotation-bounds-')); roots.push(dir);
  writeFileSync(join(dir, 'a.mjs'), 'export const allowed = true;\n');
  return dir;
}
describe('bounded annotation ID matching', () => {

  it('finishes lexical scanning for long prose tokens without a hyphen', () => {
    const dir = project(); writeFileSync(join(dir, 'prose.md'), `@claim ${'a'.repeat(256)}\n`);
    const run = spawnSync(process.execPath, ['--input-type=module', '-e',
      'const { projectAnnotationAdvisory, scanAnnotations } = await import(process.argv[1]); const advice = projectAnnotationAdvisory(process.argv[2], { claims: [{ id: "A-1" }] }); if (advice.missingIds.join() !== "A-1" || scanAnnotations(process.argv[2]).length) process.exit(1);',
      new URL('../src/claims/annotations.mjs', import.meta.url).href, dir], { encoding: 'utf8', timeout: 2000 });
    expect(run.error).toBeUndefined(); expect(run.status).toBe(0);
  });
  it('promptly refuses valid shared-format IDs outside placement vocabulary', () => {
    const dir = project(); const path = join(dir, 'testguard.claims.json');
    const claims = { schemaVersion: 1, claims: [{ id: 'a'.repeat(128), statement: 'Intended behavior.', severity: 'high', source: { kind: 'manual' }, producedBy: { producer: 'human' }, faults: [{ id: 'F1', file: 'a.mjs', find: 'true', replace: 'false', description: 'Break behavior.', faultClass: 'other', producedBy: { producer: 'human' } }] }] };
    expect(validate('claims', claims).ok).toBe(true); writeFileSync(path, JSON.stringify(claims));
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../cli/testguard.mjs', import.meta.url)), 'claims', dir, '--annotate', '--json'], { encoding: 'utf8', timeout: 2000 });
    expect(run.error).toBeUndefined(); expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout).refused[0].reason).toBe('unsupported-claim-id');
  });
});
