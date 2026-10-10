// @req FR-07
// @req FR-14
import { it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TOOLS } from '../src/mcp/tools.mjs';
import { writeSpecDoc } from '../src/evidence/writer.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

it('hands back the unprobed status action without executing the proposed probe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-mcp-next-'));
  try {
    mkdirSync(join(dir, 'src')); mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src/value.mjs'), 'export const value = 1;\n');
    writeFileSync(join(dir, 'test/value.test.mjs'), "import { value } from '../src/value.mjs';\n");
    writeSpecDoc('claims', join(dir, 'testguard.claims.json'), { schemaVersion: 1, claims: [{
      id: 'C-1', statement: 'Value is one.', severity: 'high', source: { kind: 'manual' },
      producedBy: { producer: 'human' }, defendedBy: ['test/value.test.mjs'], faults: [{
        id: 'F1', description: 'Change value.', file: 'src/value.mjs', faultClass: 'literal-changed',
        find: 'value = 1', replace: 'value = 2', producedBy: { producer: 'human' },
      }],
    }] });
    for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture']]) {
      execFileSync('git', [...FIXTURE_GIT, ...args], { cwd: dir, timeout: 5000 });
    }
    const next = TOOLS.find((tool) => tool.name === 'testguard_next_command').handler({ dir });
    expect(next).toMatchObject({ state: 'unprobed', action: 'probe', command: 'testguard probe' });
    expect(next.why).toMatch(/never been probed/);
    expect(existsSync(join(dir, '.testguard', 'evidence.json'))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
