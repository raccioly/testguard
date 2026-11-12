// #293 decision 2, pure: what the program digest covers and how two
// run.typecheck blocks compare. The probe-level cases are in
// test/typecheck-program-digest.test.mjs.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { digestProgram, needsFaultRecheck, sameTypecheck } from '../src/probe/typecheck.mjs';

describe('the program digest, pure', () => {
  it('compares command, version and digest; a record without a digest stands in, to be checked again', () => {
    const a = { commandHash: 'c'.repeat(64), version: '5.0.0', programDigest: 'a'.repeat(64) };
    expect(sameTypecheck(a, { ...a })).toBe(true);
    expect(sameTypecheck(a, { ...a, programDigest: 'b'.repeat(64) })).toBe(false);
    expect(sameTypecheck(a, { ...a, version: '5.0.1' })).toBe(false);
    const legacy = { commandHash: a.commandHash, version: a.version };
    expect(sameTypecheck(legacy, a)).toBe(true);
    expect(needsFaultRecheck(legacy, a)).toBe(true);
    expect(needsFaultRecheck(a, a)).toBe(false);
  });

  it('keys a package\'s files by name and version, and every other file by its content', () => {
    const dir = join(tmpdir(), `tg-digest-${process.pid}-${Date.now()}`);
    try {
      mkdirSync(join(dir, 'node_modules', '@types', 'node'), { recursive: true });
      mkdirSync(join(dir, 'types'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', '@types', 'node', 'package.json'), JSON.stringify({ name: '@types/node', version: '22.0.0' }));
      writeFileSync(join(dir, 'node_modules', '@types', 'node', 'index.d.ts'), 'one');
      writeFileSync(join(dir, 'types', 'env.d.ts'), 'declare const A: 1;');
      const listed = [join(dir, 'node_modules', '@types', 'node', 'index.d.ts'), join(dir, 'types', 'env.d.ts')].join('\n');
      const before = digestProgram({ listed, projectDir: dir, config: '{}', tsconfig: '{}' });
      writeFileSync(join(dir, 'node_modules', '@types', 'node', 'index.d.ts'), 'two');
      expect(digestProgram({ listed, projectDir: dir, config: '{}', tsconfig: '{}' })).toBe(before);
      writeFileSync(join(dir, 'node_modules', '@types', 'node', 'package.json'), JSON.stringify({ name: '@types/node', version: '22.0.1' }));
      expect(digestProgram({ listed, projectDir: dir, config: '{}', tsconfig: '{}' })).not.toBe(before);
      const now = digestProgram({ listed, projectDir: dir, config: '{}', tsconfig: '{}' });
      writeFileSync(join(dir, 'types', 'env.d.ts'), 'declare const A: 2;');
      expect(digestProgram({ listed, projectDir: dir, config: '{}', tsconfig: '{}' })).not.toBe(now);
      expect(digestProgram({ listed, projectDir: dir, config: '{"strict":true}', tsconfig: '{}' })).not.toBe(digestProgram({ listed, projectDir: dir, config: '{}', tsconfig: '{}' }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
