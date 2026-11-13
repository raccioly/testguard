// #320: --out names a file. A directory there used to fail after the whole probe, as "a bug in testguard".
import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { OUT_COMMANDS, assertOutIsFile, assertOutputFlags } from '../src/util/out-path.mjs';
import { PRECONDITION_KINDS, PreconditionError, errorDocument } from '../src/probe/precondition-error.mjs';
import { validate } from '../spec/lib/validate.mjs';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'known-answer');
const made = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-out-dir-'));
  made.push(dir);
  cpSync(FIXTURE, dir, { recursive: true, filter: (s) => !/node_modules|\.flake-counter|\.testguard/.test(s) });
  return dir;
};
const run = async (argv) => {
  const lines = { out: [], err: [] };
  const code = await main(argv, { out: (l) => lines.out.push(l), err: (l) => lines.err.push(l) });
  return { code, out: lines.out.join('\n'), err: lines.err.join('\n') };
};

describe('assertOutIsFile', () => {
  it('refuses an existing directory, with or without a trailing separator, naming the flag and the path', () => {
    const dir = project();
    mkdirSync(join(dir, 'reports'));
    for (const value of [join(dir, 'reports'), `${join(dir, 'reports')}/`]) {
      expect(() => assertOutIsFile(value)).toThrow(PreconditionError);
      expect(() => assertOutIsFile(value)).toThrow(`--out names a file, and ${value} is a directory`);
    }
    expect(() => assertOutIsFile(join(dir, 'reports'), '--calibration-out')).toThrow(/^--calibration-out names a file/);
    try { assertOutIsFile(dir); } catch (e) { expect(e.kind).toBe('out-is-directory'); }
  });
  it('refuses a path ending in a separator even when it does not exist yet', () => {
    expect(() => assertOutIsFile('no/such/dir/')).toThrow(/ends with a path separator/);
  });
  it('accepts a file, a new file, a new file in a directory that does not exist yet, a symlink to a file, and no value', () => {
    const dir = project();
    writeFileSync(join(dir, 'there.json'), '{}');
    symlinkSync(join(dir, 'there.json'), join(dir, 'link.json'));
    for (const v of [join(dir, 'there.json'), join(dir, 'new.json'), join(dir, 'a', 'b', 'new.json'), join(dir, 'link.json'), undefined]) expect(() => assertOutIsFile(v)).not.toThrow();
  });
  it('checks every command that writes an --out document, and replay\'s --calibration-out, through the one helper', () => {
    const dir = project();
    expect([...OUT_COMMANDS].sort()).toEqual(['admit', 'baseline', 'brief', 'gate', 'probe', 'replay', 'scaffold', 'sweep']);
    for (const command of OUT_COMMANDS) expect(() => assertOutputFlags(command, { out: dir }), command).toThrow(/--out names a file/);
    expect(() => assertOutputFlags('replay', { calibration_out: 1, 'calibration-out': dir })).toThrow(/--calibration-out names a file/);
    expect(() => assertOutputFlags('brief', { out: dir, text: true })).not.toThrow(); // nothing is written there
    expect(() => assertOutputFlags('status', { out: dir })).not.toThrow(); // not a command that writes --out
  });
  it('the refusal is a named kind in the spec', () => {
    expect(PRECONDITION_KINDS).toContain('out-is-directory');
    const doc = errorDocument(new PreconditionError('--out names a file, and x is a directory', 'out-is-directory'), { version: '0.26.0' });
    expect(doc.error).toMatchObject({ kind: 'out-is-directory', exitCode: 2 });
    expect(validate('error', doc)).toEqual({ ok: true, errors: [] });
  });
});

describe('the CLI refuses --out <directory> before anything is probed (#320)', () => {
  it('probe: exit 2, the message, no internal-error text, nothing written, nothing probed', async () => {
    const dir = project();
    mkdirSync(join(dir, 'reports'));
    for (const out of [join(dir, 'reports'), `${join(dir, 'reports')}/`]) {
      const r = await run(['probe', dir, '--out', out]);
      expect(r.code).toBe(2);
      expect(r.err).toContain(`error: --out names a file, and ${out} is a directory`);
      expect(r.err).not.toMatch(/bug in testguard|\bat .*\.mjs/);
      expect(r.out).toBe('');
    }
    expect(existsSync(join(dir, '.testguard'))).toBe(false);
    expect(existsSync(join(dir, 'reports', 'evidence.json'))).toBe(false);
  });

  it('every output-writing command refuses the same way, and --json says why in the error document', async () => {
    const dir = project();
    mkdirSync(join(dir, 'reports'));
    for (const command of ['probe', 'sweep', 'replay', 'scaffold', 'gate', 'admit', 'baseline', 'brief']) {
      const r = await run([command, command === 'scaffold' || command === 'admit' ? 'src/x.mjs' : dir, '--out', join(dir, 'reports')]);
      expect(r.code, command).toBe(2);
      expect(r.err, command).toMatch(/error: --out names a file, and .*reports is a directory/);
    }
    const j = await run(['probe', dir, '--out', join(dir, 'reports'), '--json']);
    expect(j.code).toBe(2);
    expect(JSON.parse(j.out).error).toMatchObject({ kind: 'out-is-directory', exitCode: 2 });
  });

  it('a file in a directory that does not exist yet keeps working', async () => {
    const dir = project();
    const target = join(dir, 'new-dir', 'draft.json');
    const r = await run(['scaffold', 'src/util/hash.mjs', '--out', target]); // scaffold works from the current directory
    expect(r.err).not.toMatch(/names a file|bug in testguard/);
    expect(r.code).toBe(0);
    expect(existsSync(target)).toBe(true);
  });
});
