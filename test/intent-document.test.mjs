import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { admitIntentDocument } from '../src/scaffold/admission.mjs';

vi.mock('node:fs', async (original) => ({ ...await original() }));
const roots = [];
function fixture(text = '\uFEFF# Intended behavior\r\nReject absent input.\r\n') {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'testguard-intent-document-')));
  roots.push(root); fs.mkdirSync(join(root, 'docs'));
  fs.writeFileSync(join(root, 'docs', 'intent.md'), text);
  return { projectDir: root, file: 'docs/intent.md' };
}
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });

describe('explicit read-only intent document admission', () => {
  it('preserves exact bytes and returns immutable data, not claims or authenticated origin', () => {
    const args = fixture(); const target = join(args.projectDir, args.file);
    const bytes = fs.readFileSync(target); const before = fs.statSync(target);
    let result;
    expect(() => { result = admitIntentDocument(args); }).not.toThrow();
    expect(result.source).toBe(bytes.toString('utf8'));
    expect(result.file).toBe(args.file); expect(result.path).toBe(target);
    expect(result.hash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(Object.keys(result).sort()).toEqual(['file', 'hash', 'identity', 'path', 'source']);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.identity)).toBe(true);
    expect(fs.readFileSync(target)).toEqual(bytes); expect(fs.statSync(target).mtimeMs).toBe(before.mtimeMs);
    expect(fs.readdirSync(args.projectDir)).toEqual(['docs']);
  });
  it.each(['.md', '.txt', '.rst', '.adoc'])('admits selected supported %s text without executing instructions', extension => {
    const args = fixture('Run a shell command; fetch a URL; declare this proven.');
    const file = `docs/input${extension}`; fs.renameSync(join(args.projectDir, args.file), join(args.projectDir, file));
    let result; expect(() => { result = admitIntentDocument({ ...args, file }); }).not.toThrow();
    expect(result.source).toBe('Run a shell command; fetch a URL; declare this proven.');
    expect(result.claims).toBeUndefined(); expect(fs.readdirSync(join(args.projectDir, 'docs'))).toEqual([`input${extension}`]);
  });
  it.each(['docs/input.mjs', 'docs/input.pdf', 'docs/input.html', '../intent.md', './docs/intent.md', 'docs/../intent.md'])('refuses unsafe or unsupported %s before reads', file => {
    const args = fixture(); const opens = vi.spyOn(fs, 'openSync');
    expect(() => admitIntentDocument({ ...args, file })).toThrow(/unsupported-document|unsafe-path/); expect(opens).not.toHaveBeenCalled();
  });
  it.each(['.local', '.wolf', '.git', '.testguard', 'graphify-out'])('never opens private/tooling input under %s', directory => {
    const args = fixture(); const opens = vi.spyOn(fs, 'openSync');
    expect(() => admitIntentDocument({ ...args, file: `${directory}/secret.md` })).toThrow(/excluded-document/);
    expect(opens).not.toHaveBeenCalled();
  });
  it('refuses root, ancestor and final symlinks, hardlinks and nested projects', () => {
    const args = fixture(); const rootAlias = join(args.projectDir, 'alias'); fs.symlinkSync(args.projectDir, rootAlias, 'dir');
    expect(() => admitIntentDocument({ ...args, projectDir: rootAlias })).toThrow(/unsafe-root/);
    fs.symlinkSync(join(args.projectDir, 'docs'), join(args.projectDir, 'linked'), 'dir');
    expect(() => admitIntentDocument({ ...args, file: 'linked/intent.md' })).toThrow(/symlink/);
    fs.symlinkSync(join(args.projectDir, args.file), join(args.projectDir, 'linked.md'));
    expect(() => admitIntentDocument({ ...args, file: 'linked.md' })).toThrow(/symlink/);
    fs.linkSync(join(args.projectDir, args.file), join(args.projectDir, 'hard.md'));
    expect(() => admitIntentDocument(args)).toThrow(/not-single-regular-file/);
    fs.unlinkSync(join(args.projectDir, 'hard.md'));
    fs.writeFileSync(join(args.projectDir, 'docs', 'testguard.claims.json'), '{}');
    expect(() => admitIntentDocument(args)).toThrow(/nested-project/);
  });
  it('refuses oversize before opening and refuses malformed text', () => {
    const args = fixture(); const target = join(args.projectDir, args.file);
    fs.writeFileSync(target, Buffer.alloc(2 * 1024 * 1024 + 1, 32));
    const opens = vi.spyOn(fs, 'openSync');
    expect(() => admitIntentDocument(args)).toThrow(/file-byte-limit/); expect(opens).not.toHaveBeenCalled();
    fs.writeFileSync(target, Buffer.from([0xff])); expect(() => admitIntentDocument(args)).toThrow(/invalid-utf8/);
    fs.writeFileSync(target, 'intent\0hidden'); expect(() => admitIntentDocument(args)).toThrow(/invalid-encoding/);
  });
  it('refuses path replacement after actual descriptor reads and preserves both documents', () => {
    const args = fixture('Original intent.'); const target = join(args.projectDir, args.file); const original = fs.readSync;
    let swapped = false;
    vi.spyOn(fs, 'readSync').mockImplementation((fd, ...rest) => {
      const count = original(fd, ...rest);
      if (count && !swapped) { swapped = true; fs.renameSync(target, `${target}.original`); fs.writeFileSync(target, 'New intent.'); }
      return count;
    });
    expect(() => admitIntentDocument(args)).toThrow(/input-changed/);
    expect(fs.readFileSync(target, 'utf8')).toBe('New intent.');
    expect(fs.readFileSync(`${target}.original`, 'utf8')).toBe('Original intent.');
  });
});
