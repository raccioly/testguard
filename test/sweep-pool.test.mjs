import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poolDrafts } from '../src/sweep/pool.mjs';
import { scaffoldFile } from '../src/scaffold/scaffold.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { sweep } from '../src/sweep/sweep.mjs';

const probeMock = vi.hoisted(() => vi.fn(async () => ({ records: [] })));
vi.mock('../src/probe/probe.mjs', () => ({ probe: probeMock }));
vi.mock('../src/gate/changed.mjs', () => ({ computeChangedGate: () => ({ ref: 'HEAD', base: '0'.repeat(40), head: '1'.repeat(40), changed: 2, uncovered: [{ kind: 'source', file: 'src/a/guard.mjs' }, { kind: 'source', file: 'src/b/guard.mjs' }] }) }));

const setup = (annotation) => {
  const projectDir = mkdtempSync(join(tmpdir(), 'tg-sweep-pool-'));
  for (const dir of ['a', 'b']) {
    mkdirSync(join(projectDir, 'src', dir), { recursive: true });
    writeFileSync(join(projectDir, 'src', dir, 'guard.mjs'), `${annotation ? `// @claim ${annotation}\n` : ''}export function guard(x) {\n  if (!x) return false;\n}\n`);
  }
  const drafts = ['a', 'b'].map((dir) => scaffoldFile({ projectDir, file: `src/${dir}/guard.mjs` }).doc);
  return { projectDir, drafts };
};
const admittedPool = (drafts) => { let result; expect(() => { result = poolDrafts(drafts); }).not.toThrow(); return result; };

describe('sweep pool identity is not basename identity', () => {
  it('preserves every full-path proposal and metadata with unique claim/fault identities', () => {
    const { drafts } = setup(); const before = JSON.stringify(drafts);
    expect(drafts[0].claims[0].id).toBe(drafts[1].claims[0].id);
    const pooled = admittedPool(drafts);
    const claims = pooled.flatMap((d) => d.claims);
    expect(validate('claims', { schemaVersion: 1, claims }).errors).toEqual([]);
    expect(new Set(claims.map((c) => c.id)).size).toBe(2);
    for (let i = 0; i < drafts.length; i++) {
      expect(validate('claims', pooled[i]).errors).toEqual([]);
      expect({ ...pooled[i].claims[0], id: drafts[i].claims[0].id }).toEqual(drafts[i].claims[0]);
    }
    expect(JSON.stringify(drafts)).toBe(before);
    pooled[0].claims[0].source.kind = 'manual';
    expect(JSON.stringify(drafts)).toBe(before);
  });

  it('is path-deterministic, reserves original suffixed IDs and respects max identifier length', () => {
    const { drafts } = setup();
    const extra = structuredClone(drafts[0]); extra.claims[0].id += '-2'; extra.claims[0].faults[0].file = 'src/c/guard.mjs';
    const all = [...drafts, extra];
    const mapping = (d) => d.flatMap((x) => x.claims).map((c) => [c.faults[0].file, c.id]).sort();
    expect(mapping(admittedPool(all))).toEqual(mapping(admittedPool([...all].reverse())));
    expect(admittedPool(all).map((d) => d.claims[0].id)).toEqual(['TODO-CLAIM-1', 'TODO-CLAIM-1-3', 'TODO-CLAIM-1-2']);
    for (const d of drafts) d.claims[0].id = 'A'.repeat(128);
    const long = admittedPool(drafts);
    expect(new Set(long.map((d) => d.claims[0].id)).size).toBe(2);
    expect(long.every((d) => validate('claims', d).ok)).toBe(true);
  });

  it('refuses invalid documents', () => {
    const { drafts } = setup(); drafts[1].claims[0].faults[0].replace = drafts[1].claims[0].faults[0].find;
    expect(() => poolDrafts(drafts)).toThrow(/draft/);
  });

  it('keeps repeated annotation IDs distinct rather than adopting another file\'s metadata', () => {
    const { drafts } = setup('SHARED-001');
    drafts[1].claims[0].source = { kind: 'incident', ref: 'opaque:incident-2' };
    drafts[1].claims[0].statement = 'Another supplied intent.';
    const pooled = admittedPool(drafts);
    expect(pooled.map((d) => d.claims[0].id)).toEqual(['SHARED-001', 'SHARED-001-2']);
    expect(pooled[1].claims[0].source).toEqual(drafts[1].claims[0].source);
    expect(pooled[1].claims[0].statement).toBe(drafts[1].claims[0].statement);
  });

  it('pools real scaffold output before actual sweep selection and probe dispatch', async () => {
    const { projectDir } = setup(); probeMock.mockClear();
    const result = await sweep({ projectDir, ref: 'HEAD', includeDirty: true, cap: 2 });
    expect(probeMock).toHaveBeenCalledOnce();
    const dispatched = probeMock.mock.calls[0][0].claims;
    expect(validate('claims', dispatched).errors).toEqual([]);
    expect(dispatched.claims).toHaveLength(2);
    expect(dispatched.claims.flatMap((c) => c.faults)).toHaveLength(2);
    expect(new Set(result.drafts.flatMap((d) => d.claims).map((c) => c.id)).size).toBe(2);
    expect(new Set(dispatched.claims.map((c) => c.id))).toEqual(new Set(result.drafts.flatMap((d) => d.claims).map((c) => c.id)));
    expect(result.selection.selected).toBe(2);
  });
});
