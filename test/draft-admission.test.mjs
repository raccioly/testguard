import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitDraftAppend } from '../src/scaffold/admission.mjs';
import { readSpecDoc } from '../src/evidence/writer.mjs';

vi.mock('node:fs', async (original) => ({ ...await original() }));

const roots = [];
const doc = { schemaVersion: 1, claims: [{ id: 'INTENT-001', statement: 'Absent input is rejected.', severity: 'high', source: { kind: 'incident' }, producedBy: { producer: 'human' }, faults: [{ id: 'F1', description: 'Change the stored value.', file: 'src/guard.mjs', find: 'x = 1', replace: 'x = 2', faultClass: 'other', producedBy: { producer: 'agent' } }] }] };
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'testguard-draft-admission-')); roots.push(root);
  fs.mkdirSync(join(root, 'src'));
  fs.writeFileSync(join(root, 'draft.json'), JSON.stringify(doc));
  fs.writeFileSync(join(root, 'src', 'guard.mjs'), 'export const x = 1;\n');
  return { projectDir: root, draftPath: 'draft.json', files: ['src/guard.mjs'], claimId: 'INTENT-001' };
}
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })); });

describe('read-only draft append admission', () => {
  it('snapshots supplied intent and sorted full paths without writes', () => {
    const args = fixture(); fs.mkdirSync(join(args.projectDir, 'other'));
    fs.writeFileSync(join(args.projectDir, 'other', 'guard.py'), 'x = 1\n');
    args.files.push('other/guard.py');
    const before = fs.readFileSync(join(args.projectDir, args.draftPath));
    let result;
    expect(() => { result = admitDraftAppend(args); }).not.toThrow();
    expect(result.draft.doc).toEqual(doc);
    expect(result.sources.map((source) => source.file)).toEqual(['other/guard.py', 'src/guard.mjs']);
    expect(result.sources[1].source).toBe('export const x = 1;\n');
    expect(result.sources.every((input) => input.hash.length === 64 && input.identity.ino > 0)).toBe(true);
    expect(fs.readFileSync(result.draft.path)).toEqual(before);
    expect(fs.readdirSync(args.projectDir).sort()).toEqual(['draft.json', 'other', 'src']);
  });

  it('validates already-admitted text through readSpecDoc without disk fallback', () => {
    let parsed;
    expect(() => { parsed = readSpecDoc('claims', '/missing', { source: JSON.stringify(doc) }); }).not.toThrow();
    expect(parsed).toEqual(doc);
    expect(() => readSpecDoc('claims', '/missing', { source: '' })).toThrow(/cannot read/);
    expect(() => readSpecDoc('claims', '/missing', { source: '{}' })).toThrow(/does not conform/);
  });

  it.each(['testguard.claims.json', '.testguard/evidence.json', '.testguard/baseline.json', '.testguard/evidence-partial.json', '.testguard/evidence-provisional.json', '.testguard/sweep-evidence.json'])('refuses protected destination %s even with conforming draft content', (draftPath) => {
    const args = fixture(); fs.mkdirSync(join(args.projectDir, '.testguard'));
    fs.writeFileSync(join(args.projectDir, draftPath), JSON.stringify(doc));
    expect(() => admitDraftAppend({ ...args, draftPath })).toThrow(/protected-destination/);
    expect(fs.readFileSync(join(args.projectDir, draftPath), 'utf8')).toBe(JSON.stringify(doc));
  });

  it.each(['../draft.json', 'src/../draft.json', './draft.json'])('refuses unsafe destination %s', (draftPath) => {
    expect(() => admitDraftAppend({ ...fixture(), draftPath })).toThrow(/unsafe-path/);
  });

  it('refuses symlinked roots, ancestors and destinations', () => {
    const args = fixture(); const linkedRoot = join(args.projectDir, 'alias'); fs.symlinkSync(args.projectDir, linkedRoot, 'dir');
    expect(() => admitDraftAppend({ ...args, projectDir: linkedRoot })).toThrow(/unsafe-root/);
    fs.symlinkSync(join(args.projectDir, 'src'), join(args.projectDir, 'linked'), 'dir');
    expect(() => admitDraftAppend({ ...args, files: ['linked/guard.mjs'] })).toThrow(/symlink/);
    fs.symlinkSync(join(args.projectDir, 'draft.json'), join(args.projectDir, 'alias.json'));
    expect(() => admitDraftAppend({ ...args, draftPath: 'alias.json' })).toThrow(/symlink/);
  });

  it('refuses hardlinks and repeated source aliases', () => {
    const args = fixture();
    expect(() => admitDraftAppend({ ...args, files: [...args.files, ...args.files] })).toThrow(/input-alias/);
    fs.linkSync(join(args.projectDir, 'draft.json'), join(args.projectDir, 'alias.json'));
    expect(() => admitDraftAppend({ ...args, draftPath: 'alias.json' })).toThrow(/not-single-regular-file/);
  });

  it('refuses nested projects, unsupported inputs and unknown claims', () => {
    const args = fixture();
    expect(() => admitDraftAppend({ ...args, claimId: 'UNKNOWN-001' })).toThrow(/unknown-claim/);
    expect(() => admitDraftAppend({ ...args, files: ['draft.json'] })).toThrow(/input-alias/);
    expect(() => admitDraftAppend({ ...args, files: ['src/file.txt'] })).toThrow(/unsupported-source/);
    fs.writeFileSync(join(args.projectDir, 'src', 'testguard.claims.json'), JSON.stringify(doc));
    expect(() => admitDraftAppend(args)).toThrow(/nested-project/);
  });

  it('refuses file count before reading any input', () => {
    const args = fixture(); args.files = [];
    for (let i = 0; i < 33; i++) { const file = `src/file-${i}.mjs`; fs.writeFileSync(join(args.projectDir, file), 'x = 1'); args.files.push(file); }
    const reads = vi.spyOn(fs, 'openSync');
    expect(() => admitDraftAppend(args)).toThrow(/source-count-limit/);
    expect(reads).not.toHaveBeenCalled();
  });

  it('refuses oversized files and invalid UTF-8 before returning a plan', () => {
    const args = fixture(); const target = join(args.projectDir, 'src/guard.mjs');
    fs.writeFileSync(target, Buffer.alloc(2 * 1024 * 1024 + 1));
    const opens = vi.spyOn(fs, 'openSync');
    expect(() => admitDraftAppend(args)).toThrow(/file-byte-limit/);
    expect(opens.mock.calls).toHaveLength(1);
    fs.writeFileSync(target, Buffer.from([0xff]));
    expect(() => admitDraftAppend(args)).toThrow(/invalid-utf8/);
  });

  it('refuses aggregate bytes before opening any source', () => {
    const args = fixture(); args.files = [];
    for (let i = 0; i < 9; i++) { const file = `src/file-${i}.mjs`; fs.writeFileSync(join(args.projectDir, file), Buffer.alloc(2 * 1024 * 1024, 32)); args.files.push(file); }
    const opens = vi.spyOn(fs, 'openSync');
    expect(() => admitDraftAppend(args)).toThrow(/source-byte-limit/);
    expect(opens.mock.calls).toHaveLength(1); // bounded draft only, no source read
  });

  it('refuses input replaced after descriptor read, leaving both files untouched', () => {
    const args = fixture(); const target = join(args.projectDir, args.files[0]);
    const original = fs.readSync;
    vi.spyOn(fs, 'readSync').mockImplementation((fd, ...rest) => {
      const count = original(fd, ...rest);
      if (count && fs.fstatSync(fd).ino === fs.lstatSync(target).ino) {
        fs.renameSync(target, `${target}.original`);
        fs.writeFileSync(target, 'unrelated edit');
      }
      return count;
    });
    expect(() => admitDraftAppend(args)).toThrow(/input-changed/);
    expect(fs.readFileSync(target, 'utf8')).toBe('unrelated edit');
    expect(fs.readFileSync(`${target}.original`, 'utf8')).toBe('export const x = 1;\n');
    expect(fs.readFileSync(join(args.projectDir, args.draftPath), 'utf8')).toBe(JSON.stringify(doc));
  });
});
