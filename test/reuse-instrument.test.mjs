// Issue #232 (6, 7): a reuse key names the instrument, not only the inputs,
// and the evidence says how much of it was carried forward.
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { reusableRun, reuseSummary } from '../src/probe/probe.mjs';
import { instrumentOf } from '../src/probe/dependencies.mjs';

const projects = [];
function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'tg-instrument-'));
  projects.push(root);
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), source);
  }
  return root;
}
afterEach(() => { while (projects.length) rmSync(projects.pop(), { recursive: true, force: true }); });

const runner = { name: 'vitest', version: '5.0.5', source: 'project' };
const instrument = { toolVersion: '1.2.3', digest: 'a'.repeat(64) };
const previous = (over = {}) => ({
  tool: { name: 'testguard', version: '1.2.3' },
  run: { confirmRuns: 3, workers: 1, serial: true, runner, instrument, ...over },
});
const current = { confirmRuns: 3, workers: 1, serial: true, runner, instrument };

describe('reuse requires the same instrument', () => {
  it('reuses evidence from the same version, digest, N, worker policy and runner', () => {
    expect(reusableRun(previous(), current)).toBe(true);
  });

  it('never reuses evidence written by another TestGuard version', () => {
    const older = previous({ instrument: { ...instrument, toolVersion: '1.2.2' } });
    older.tool.version = '1.2.2';
    expect(reusableRun(older, current)).toBe(false);
    // A document whose tool and instrument disagree vouches for neither.
    const mixed = previous();
    mixed.tool.version = '1.2.2';
    expect(reusableRun(mixed, current)).toBe(false);
  });

  it('never reuses across a changed resolver or runner configuration digest', () => {
    expect(reusableRun(previous({ instrument: { ...instrument, digest: 'b'.repeat(64) } }), current)).toBe(false);
  });

  it('never reuses evidence that names no instrument', () => {
    const legacy = previous();
    delete legacy.run.instrument;
    expect(reusableRun(legacy, current)).toBe(false);
    expect(reusableRun(undefined, current)).toBe(false);
  });

  it('keeps the existing N, worker-policy and runner conditions', () => {
    expect(reusableRun(previous({ confirmRuns: 2 }), current)).toBe(false);
    expect(reusableRun(previous({ workers: 2, serial: false }), current)).toBe(false);
    expect(reusableRun(previous({ runner: { ...runner, version: '5.0.4' } }), current)).toBe(false);
  });
});

describe('the instrument digest', () => {
  const files = {
    'package.json': '{"imports":{"#lib/*":"./src/lib/*"}}',
    'tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}',
    'vitest.config.mjs': "export default { resolve: { alias: { '~': './src' } } };\n",
    'package-lock.json': '{"lockfileVersion":3}',
    'src/a.mjs': '',
  };

  it('is the same for the same configuration wherever the project lives', () => {
    const a = project(files);
    const b = mkdtempSync(join(tmpdir(), 'tg-instrument-copy-'));
    projects.push(b);
    cpSync(a, b, { recursive: true });
    expect(instrumentOf(a, '1.2.3')).toEqual(instrumentOf(b, '1.2.3'));
    expect(instrumentOf(a, '1.2.3').toolVersion).toBe('1.2.3');
    expect(instrumentOf(a, '1.2.3').digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['tsconfig.json', '{"compilerOptions":{"paths":{"@/*":["./lib/*"]}}}'],
    ['vitest.config.mjs', "export default { resolve: { alias: { '~': './lib' } } };\n"],
    ['package.json', '{"imports":{"#lib/*":"./lib/*"}}'],
    ['package-lock.json', '{"lockfileVersion":3,"x":1}'],
  ])('changes when %s changes', (file, content) => {
    const root = project(files);
    const before = instrumentOf(root, '1.2.3').digest;
    writeFileSync(join(root, file), content);
    expect(instrumentOf(root, '1.2.3').digest).not.toBe(before);
  });

  it('changes when an alias source outside the root files changes (a referenced or extended tsconfig)', () => {
    const root = project({
      'tsconfig.json': '{"files":[],"references":[{"path":"./tsconfig.app.json"}]}',
      'tsconfig.app.json': '{"extends":"./tsconfig.base.json","compilerOptions":{"paths":{"@/*":["./src/*"]}}}',
      'tsconfig.base.json': '{"compilerOptions":{"strict":true}}',
      'src/a.ts': '',
    });
    const before = instrumentOf(root, '1.2.3').digest;
    writeFileSync(join(root, 'tsconfig.app.json'), '{"extends":"./tsconfig.base.json","compilerOptions":{"paths":{"@/*":["./lib/*"]}}}');
    const afterApp = instrumentOf(root, '1.2.3').digest;
    expect(afterApp).not.toBe(before);
    writeFileSync(join(root, 'tsconfig.base.json'), '{"compilerOptions":{"strict":false}}');
    expect(instrumentOf(root, '1.2.3').digest).not.toBe(afterApp);
  });

  it('does not change when ordinary source changes: records hash that', () => {
    const root = project(files);
    const before = instrumentOf(root, '1.2.3').digest;
    writeFileSync(join(root, 'src/a.mjs'), 'export const x = 1;\n');
    expect(instrumentOf(root, '1.2.3').digest).toBe(before);
  });
});

describe('run.reuse counts what was carried forward', () => {
  it('counts reused and measured records', () => {
    expect(reuseSummary([{ reusedFrom: 'run-1' }, {}, { reusedFrom: 'run-1' }])).toEqual({ reused: 2, measured: 1 });
    expect(reuseSummary([])).toEqual({ reused: 0, measured: 0 });
  });
});
