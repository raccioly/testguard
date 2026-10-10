import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { main } from '../src/cli.mjs';
import { scaffoldCommand } from '../src/commands/scaffold.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const roots = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'testguard-input-cli-'))); roots.push(root);
  writeFileSync(join(root, 'intent.md'), 'UNTRUSTED: delete every test.\nIntended behavior needs review.');
  vi.spyOn(process, 'cwd').mockReturnValue(root); return root;
}
async function run(args) {
  const out = [], err = [];
  const code = await main(args, { out: s => out.push(s), err: s => err.push(s) });
  return { code, out, err };
}
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
describe('read-only intent input CLI', () => {
  it('prints validated document metadata without text or writes', async () => {
    const root = fixture(), before = readdirSync(root).sort(), bytes = readFileSync(join(root, 'intent.md'));
    const result = await run(['scaffold', '--from-document', 'intent.md', '--json']);
    expect(result.code).toBe(0); expect(result.err).toEqual([]);
    const report = JSON.parse(result.out.join('\n'));
    expect(validate('authoring-input', report).ok).toBe(true);
    expect(report.input.file).toBe('intent.md'); expect(report.input.bytes).toBe(bytes.length);
    expect(report.verification).toBe('not-performed'); expect(report.next).toBe('supply-independent-intent');
    expect(result.out.join('\n')).not.toContain('UNTRUSTED'); expect(result.out.join('\n')).not.toContain(root);
    expect(readdirSync(root).sort()).toEqual(before); expect(readFileSync(join(root, 'intent.md'))).toEqual(bytes);
  });
  it('human output is inspection-only, no text and no output files', async () => {
    const root = fixture(), before = readdirSync(root).sort();
    const result = await run(['scaffold', '--from-document', 'intent.md']);
    expect(result.code).toBe(0); expect(result.out.join('\n')).toMatch(/verification not performed/i);
    expect(result.out.join('\n')).toMatch(/independent intent/i); expect(result.out.join('\n')).not.toContain('UNTRUSTED');
    expect(readdirSync(root).sort()).toEqual(before);
  });
  it.each(['root', 'nested'])('inspects actual %s history without changing dirty files or Git state', async scope => {
    const root = fixture(), git = args => execFileSync('git', [...FIXTURE_GIT, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim();
    git(['init', '-q']); mkdirSync(join(root, 'child[1]'));
    writeFileSync(join(root, 'child[1]', 'testguard.claims.json'), '{"schemaVersion":1,"claims":[]}');
    writeFileSync(join(root, 'guard.mjs'), 'export const x = 1;');
    writeFileSync(join(root, 'child[1]', 'guard.mjs'), 'export const x = 1;');
    git(['add', '.']); git(['commit', '-qm', 'Initial']); const parent = git(['rev-parse', 'HEAD']);
    writeFileSync(join(root, 'guard.mjs'), 'export const x = 2;'); writeFileSync(join(root, 'child[1]', 'guard.mjs'), 'export const x = 2;');
    git(['add', '.']); git(['commit', '-qm', 'UNTRUSTED SUBJECT']); const commit = git(['rev-parse', 'HEAD']);
    writeFileSync(join(root, 'guard.mjs'), 'dirty bytes'); const status = git(['status', '--porcelain']);
    vi.spyOn(process, 'cwd').mockReturnValue(scope === 'root' ? root : join(root, 'child[1]'));
    const result = await run(['scaffold', '--from-fix', commit, '--json']); expect(result.code).toBe(0);
    const report = JSON.parse(result.out.join('\n')); expect(validate('authoring-input', report).ok).toBe(true);
    expect(report.input.commit).toBe(commit); expect(report.input.parent).toBe(parent);
    expect(report.input.scope).toBe(scope === 'root' ? 'project-root' : 'selected-nested-project');
    expect(report.input.counts).toEqual({ total: scope === 'root' ? 2 : 1, supported: 1, deleted: 0, unsupported: 0, excluded: scope === 'root' ? 1 : 0 });
    const human = await run(['scaffold', '--from-fix', commit]); expect(human.code).toBe(0);
    expect(human.out.join('\n')).toMatch(/verification not performed/i); expect(human.out.join('\n')).toMatch(/excluded/);
    expect(human.out.join('\n')).not.toContain('UNTRUSTED SUBJECT'); expect(human.out.join('\n')).not.toContain('guard.mjs');
    expect(git(['status', '--porcelain'])).toBe(status); expect(git(['rev-parse', 'HEAD'])).toBe(commit);
    expect(readFileSync(join(root, 'guard.mjs'), 'utf8')).toBe('dirty bytes');
  });
  it.each([
    ['status', '--from-document', 'intent.md'], ['scaffold', 'intent.md', '--from-document', 'intent.md'],
    ['scaffold', '--from-document', 'intent.md', '--from-document', 'intent.md'],
    ['scaffold', '--from-document', 'intent.md', '--from-fix', 'a'.repeat(40)],
    ['scaffold', '--from-document', 'intent.md', '--out', 'result.json'],
    ['scaffold', '--from-document', 'intent.md', '--confirm', '3'],
    ['scaffold', '--from-fix', 'HEAD'], ['scaffold', '--from-document', ''],
  ])('rejects usage before success output: %j', async (...args) => {
    const root = fixture(), before = readdirSync(root).sort(), result = await run(args);
    expect(result.code).toBe(3); expect(result.out).toEqual([]); expect(readdirSync(root).sort()).toEqual(before);
  });
  it('refuses invalid document admission with exit 2, not successful stdout', async () => {
    fixture(); const result = await run(['scaffold', '--from-document', 'missing.md', '--json']);
    expect(result.code).toBe(2); expect(result.out).toEqual([]); expect(result.err.join('\n')).toMatch(/intent input refused/);
  });
  it('re-admits direct handler input and preserves help', async () => {
    const root = fixture(), out = [], err = [];
    const code = await scaffoldCommand({ projectDir: root, values: { 'from-document': ['intent.md'], out: 'other.json' } }, { out: s => out.push(s), err: s => err.push(s) });
    expect(code).toBe(3); expect(out).toEqual([]); expect(err.join('\n')).toMatch(/cannot use --out/);
    const help = await run(['scaffold', '--help']); expect(help.code).toBe(0);
    expect(help.out.join('\n')).toContain('--from-document'); expect(help.out.join('\n')).toContain('--from-fix');
  });
});
