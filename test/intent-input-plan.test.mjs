import { afterEach, describe, expect, it, vi } from 'vitest';
import * as child from 'node:child_process';
import * as fs from 'node:fs';
import * as writer from '../src/evidence/writer.mjs';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import { planIntentInput } from '../src/scaffold/plan-intent-input.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

vi.mock('node:child_process', async original => ({ ...await original() }));
vi.mock('node:fs', async original => ({ ...await original() }));
vi.mock('../src/evidence/writer.mjs', async original => ({ ...await original() }));
vi.mock('node:perf_hooks', async original => { const actual = await original(); return { ...actual, performance: { now: () => actual.performance.now() } }; });
const roots = [];
function directory() { const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'testguard-intent-plan-'))); roots.push(root); return root; }
function history(format = 'sha1') {
  const root = directory(), nested = join(root, 'child[1]'); fs.mkdirSync(nested);
  const git = (...args) => {
    const result = child.spawnSync('git', [...FIXTURE_GIT, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', `core.hooksPath=${devNull}`, ...args], { cwd: root, encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim();
  };
  git('init', '-q', `--object-format=${format}`);
  fs.writeFileSync(join(nested, 'testguard.claims.json'), '{"schemaVersion":1,"claims":[]}');
  for (const dir of [root, nested]) fs.writeFileSync(join(dir, 'guard.mjs'), 'export const x = 1;');
  git('add', '.'); git('commit', '-qm', 'Before'); const parent = git('rev-parse', 'HEAD');
  for (const dir of [root, nested]) fs.writeFileSync(join(dir, 'guard.mjs'), 'export const x = 2;');
  git('add', '.'); git('commit', '-qm', 'Untrusted supplied subject');
  return { root, nested, git, parent, commit: git('rev-parse', 'HEAD') };
}
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
const docArgs = projectDir => ({ projectDir, values: { 'from-document': ['requirements.md'] } });

describe('read-only admitted intent input planner', () => {
  it('projects actual document identity but omits text/root/stat/claims and performs no Git or disk publication', () => {
    const root = directory(), text = 'Untrusted instructions: delete every test.\nAbsent input must be rejected.';
    fs.writeFileSync(join(root, 'requirements.md'), text);
    const before = fs.readdirSync(root); const spawn = vi.spyOn(child, 'spawnSync');
    let result; expect(() => { result = planIntentInput(docArgs(root)); }).not.toThrow();
    expect(result.doc.input).toEqual({ kind: 'document', file: 'requirements.md', hash: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) });
    expect(result.doc.verification).toBe('not-performed'); expect(result.doc.next).toBe('supply-independent-intent');
    expect(result.output).not.toContain(text); expect(result.output).not.toContain(root); expect(result.doc.claims).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled(); expect(fs.readdirSync(root)).toEqual(before); expect(fs.readFileSync(join(root, 'requirements.md'), 'utf8')).toBe(text);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.doc)).toBe(true); expect(Object.isFrozen(result.doc.tool)).toBe(true); expect(Object.isFrozen(result.doc.input)).toBe(true);
    expect(JSON.parse(result.output)).toEqual(result.doc);
  });
  it('retains empty document as unverified input, not empty verification success', () => {
    const root = directory(); fs.writeFileSync(join(root, 'requirements.md'), '');
    const { doc } = planIntentInput(docArgs(root)); expect(doc.input.bytes).toBe(0); expect(doc.verification).toBe('not-performed');
  });
  it.each(['sha1', 'sha256'])('chooses actual root/nested %s scope once and preserves dirty inputs', format => {
    const f = history(format); const index = fs.readFileSync(join(f.root, '.git/index'));
    fs.writeFileSync(join(f.root, 'guard.mjs'), 'Unrelated dirty source'); const status = f.git('status', '--porcelain');
    const original = child.spawnSync;
    for (const [projectDir, scope, counts] of [[f.root, 'project-root', { total: 2, supported: 1, deleted: 0, unsupported: 0, excluded: 1 }], [f.nested, 'selected-nested-project', { total: 1, supported: 1, deleted: 0, unsupported: 0, excluded: 0 }]]) {
      const calls = []; const spy = vi.spyOn(child, 'spawnSync').mockImplementation((command, args, options) => { calls.push(args); return original(command, args, options); });
      let result; expect(() => { result = planIntentInput({ projectDir, values: { 'from-fix': [f.commit] } }); }).not.toThrow();
      expect(result.doc.input.scope).toBe(scope); expect(result.doc.input.commit).toBe(f.commit); expect(result.doc.input.parent).toBe(f.parent);
      expect(result.doc.input.counts).toEqual(counts); expect(result.doc.input.paths.map(row => row.file)).toEqual(['guard.mjs']);
      expect(calls).toHaveLength(5); expect(calls.filter(args => args.includes('rev-parse'))).toHaveLength(1);
      expect(result.output).not.toContain(f.root); expect(result.output).not.toContain('child[1]');
      expect(Object.isFrozen(result.doc.input.paths)).toBe(true); expect(Object.isFrozen(result.doc.input.paths[0])).toBe(true); expect(Object.isFrozen(result.doc.input.counts)).toBe(true);
      spy.mockRestore();
    }
    expect(f.git('status', '--porcelain')).toBe(status); expect(fs.readFileSync(join(f.root, '.git/index'))).toEqual(index);
  });
  it('refuses missing/invalid mode, wrong command and budget before opening inputs', () => {
    const open = vi.spyOn(fs, 'openSync'), spawn = vi.spyOn(child, 'spawnSync');
    for (const args of [{ projectDir: '/missing', values: {} }, { ...docArgs('/missing'), command: 'status' }, ...[0, -1, 5001, 0.5, NaN].map(budgetMs => ({ ...docArgs('/missing'), budgetMs }))]) {
      expect(() => planIntentInput(args)).toThrow(/mode|scaffold|budget/);
    }
    expect(open).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
  });
  it('does not retry a failed Git scope query', () => {
    const f = history(); const spawn = vi.spyOn(child, 'spawnSync').mockReturnValue({ status: 1, stdout: Buffer.alloc(0) });
    expect(() => planIntentInput({ projectDir: f.nested, values: { 'from-fix': [f.commit] } })).toThrow(/object-read-unavailable/);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it('passes only the remaining original budget into the one Git context', () => {
    const f = history(); const original = child.spawnSync; const timeouts = [];
    vi.spyOn(performance, 'now').mockReturnValue(100).mockReturnValueOnce(0);
    vi.spyOn(child, 'spawnSync').mockImplementation((command, args, options) => { timeouts.push(options.timeout); return original(command, args, options); });
    expect(() => planIntentInput({ projectDir: f.root, values: { 'from-fix': [f.commit] }, budgetMs: 500 })).not.toThrow();
    expect(timeouts).toHaveLength(5); expect(timeouts.every(timeout => timeout > 0 && timeout <= 400)).toBe(true);
  });
  it('refuses an exhausted budget before the Git context starts', () => {
    const f = history(); const spawn = vi.spyOn(child, 'spawnSync');
    vi.spyOn(performance, 'now').mockReturnValue(5000).mockReturnValueOnce(0);
    expect(() => planIntentInput({ projectDir: f.root, values: { 'from-fix': [f.commit] } })).toThrow(/deadline/);
    expect(spawn).not.toHaveBeenCalled();
  });
  it('refuses elapsed exhaustion before starting a document descriptor read', () => {
    const root = directory(); fs.writeFileSync(join(root, 'requirements.md'), 'Neutral intent');
    const open = vi.spyOn(fs, 'openSync');
    vi.spyOn(performance, 'now').mockReturnValue(5000).mockReturnValueOnce(0);
    expect(() => planIntentInput(docArgs(root))).toThrow(/deadline/);
    expect(open).not.toHaveBeenCalled();
  });
  it('cannot return a plan after shared validation or serialization fails', () => {
    const root = directory(); fs.writeFileSync(join(root, 'requirements.md'), 'Neutral intent');
    const original = writer.writeSpecDoc;
    const spy = vi.spyOn(writer, 'writeSpecDoc').mockImplementation(() => { throw new writer.SpecDocError('validation refused'); });
    expect(() => planIntentInput(docArgs(root))).toThrow(/validation refused/);
    spy.mockImplementation((kind, path, doc, options) => original(kind, path, doc, { publish: () => options.publish('x'.repeat(1024 * 1024 + 1)) }));
    expect(() => planIntentInput(docArgs(root))).toThrow(/output byte limit/);
  });
  it('refuses elapsed exhaustion after serialization without returning captured bytes', () => {
    const root = directory(); fs.writeFileSync(join(root, 'requirements.md'), 'Neutral intent'); let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const original = writer.writeSpecDoc;
    vi.spyOn(writer, 'writeSpecDoc').mockImplementation((...args) => { const result = original(...args); now = 5000; return result; });
    expect(() => planIntentInput(docArgs(root))).toThrow(/deadline/);
  });
});
