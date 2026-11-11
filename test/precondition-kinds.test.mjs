// The ledger behind --json refusals (defect B): every way testguard refuses to
// start has a named kind, so an adapter can branch on it. A throw site added
// without one fails here, not in the field.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PreconditionError, PRECONDITION_KINDS, ERROR_KINDS, errorDocument, UsageError } from '../src/probe/precondition-error.mjs';
import { BudgetExhaustedError } from '../src/command-budget.mjs';
import { ClaimsError } from '../src/claims/load.mjs';
import { GitError } from '../src/git.mjs';
import { SpecDocError } from '../src/evidence/writer.mjs';
import { validate } from '../spec/lib/validate.mjs';

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : path.endsWith('.mjs') ? [path] : [];
});

/** The argument texts of every `new <name>(...)` call in a source text, split at top-level commas. Understands '', "", `` (with nested ${}) and comments. */
export function callArguments(source, name) {
  const calls = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(`new ${name}(`, from);
    if (at === -1) return calls;
    let i = at + `new ${name}(`.length;
    const args = [];
    let depth = 0;
    let current = '';
    const skipString = (quote) => {
      let out = quote;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') { out += source[i] + source[i + 1]; i += 2; continue; }
        if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
          let braces = 1;
          out += '${';
          i += 2;
          while (i < source.length && braces > 0) {
            if (source[i] === '`' || source[i] === "'" || source[i] === '"') { out += skipString(source[i]); continue; }
            if (source[i] === '{') braces += 1;
            if (source[i] === '}') braces -= 1;
            out += source[i];
            i += 1;
          }
          continue;
        }
        out += source[i];
        i += 1;
      }
      out += quote;
      i += 1;
      return out;
    };
    while (i < source.length) {
      const c = source[i];
      if (c === '/' && source[i + 1] === '/') { while (source[i] !== '\n') i += 1; continue; }
      if (c === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i) + 2; continue; }
      if (c === '`' || c === "'" || c === '"') { current += skipString(c); continue; }
      if (c === '(' || c === '[' || c === '{') depth += 1;
      if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth -= 1;
      }
      if (c === ',' && depth === 0) { args.push(current.trim()); current = ''; i += 1; continue; }
      current += c;
      i += 1;
    }
    if (current.trim() !== '') args.push(current.trim());
    calls.push({ args, line: source.slice(0, at).split('\n').length });
    from = i;
  }
}

describe('every PreconditionError names its kind', () => {
  const files = walk('src').filter((f) => !f.endsWith('precondition-error.mjs'));
  const sites = files.flatMap((file) => callArguments(readFileSync(file, 'utf8'), 'PreconditionError').map((call) => ({ file, ...call })));

  it('finds the throw sites (a scanner that finds none proves nothing)', () => {
    expect(sites.length).toBeGreaterThan(30);
    expect(callArguments('throw new PreconditionError(`a ${b ? \'x\' : `y`}, c`, \'kind-one\');', 'PreconditionError')[0].args).toEqual(['`a ${b ? \'x\' : `y`}, c`', "'kind-one'"]);
  });

  it('gives each site exactly a message and a literal kind from the closed set', () => {
    const bad = sites.filter((s) => s.args.length !== 2 || !/^'[a-z][a-z0-9-]*'$/.test(s.args[1]) || !PRECONDITION_KINDS.includes(s.args[1].slice(1, -1)));
    expect(bad.map((s) => `${s.file}:${s.line} ${s.args.at(-1)?.slice(0, 40)}`)).toEqual([]);
  });

  it('uses every kind at least once: a kind nothing throws is a promise nothing keeps', () => {
    const used = new Set(sites.map((s) => s.args[1]?.slice(1, -1)));
    used.add('budget-exhausted'); // thrown by BudgetExhaustedError, which fixes its own kind
    expect(PRECONDITION_KINDS.filter((k) => !used.has(k))).toEqual([]);
  });

  it('refuses to construct one without a known kind', () => {
    expect(() => new PreconditionError('no kind')).toThrow(/kind/);
    expect(() => new PreconditionError('bad kind', 'made-up')).toThrow(/kind/);
    expect(new PreconditionError('ok', 'no-commits').kind).toBe('no-commits');
    expect(new BudgetExhaustedError('budget').kind).toBe('budget-exhausted');
  });
});

describe('the error document', () => {
  it('is valid for every kind, carries the kind and exit code, and the schema enumerates exactly the code\'s kinds', () => {
    for (const kind of PRECONDITION_KINDS) {
      const doc = errorDocument(new PreconditionError(`refused: ${kind}`, kind), { version: '1.2.3' });
      expect(validate('error', doc).errors, kind).toEqual([]);
      expect(doc.error).toEqual({ kind, message: `refused: ${kind}`, exitCode: 2 });
    }
    const schema = JSON.parse(readFileSync('spec/schemas/error.schema.json', 'utf8'));
    expect([...schema.properties.error.properties.kind.enum].sort()).toEqual([...ERROR_KINDS].sort());
  });

  it('maps each non-precondition class to its own kind and exit code', () => {
    expect(errorDocument(new ClaimsError('bad claims'), { version: '1' }).error).toEqual({ kind: 'claims-file', message: 'bad claims', exitCode: 2 });
    expect(errorDocument(new GitError('git said no'), { version: '1' }).error.kind).toBe('git');
    expect(errorDocument(new SpecDocError('not a spec doc'), { version: '1' }).error.kind).toBe('spec-document');
    expect(errorDocument(new UsageError('--workers is wrong'), { version: '1' }).error).toEqual({ kind: 'usage', message: '--workers is wrong', exitCode: 3 });
    expect(errorDocument(new TypeError('boom'), { version: '1' }).error).toMatchObject({ kind: 'internal', exitCode: 2 });
    expect(errorDocument({ kind: 'refused', message: 'said on stderr', exitCode: 2 }, { version: '1' }).error.kind).toBe('refused');
  });

  it('rejects a document whose kind or exit code is outside the contract', () => {
    const doc = errorDocument(new UsageError('x'), { version: '1' });
    expect(validate('error', { ...doc, error: { ...doc.error, kind: 'whatever' } }).ok).toBe(false);
    expect(validate('error', { ...doc, error: { ...doc.error, exitCode: 1 } }).ok).toBe(false);
    expect(validate('error', { ...doc, error: { ...doc.error, message: '' } }).ok).toBe(false);
  });

  it('keeps the exit code and the kind in step: usage is 3 and nothing else is', () => {
    for (const kind of ERROR_KINDS) {
      const doc = errorDocument({ kind, message: 'm', exitCode: kind === 'usage' ? 3 : 2 }, { version: '1' });
      expect(validate('error', doc).errors, kind).toEqual([]);
      expect(validate('error', { ...doc, error: { ...doc.error, exitCode: kind === 'usage' ? 2 : 3 } }).ok, kind).toBe(false);
    }
  });
});
