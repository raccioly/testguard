import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { scaffoldFile } from '../src/scaffold/scaffold.mjs';
import { proposalsForLine, functionHead, functionParams, indentOf } from '../src/scaffold/producers.python.mjs';
import { locate } from '../src/probe/inject.mjs';


let dir;
const write = (rel, text) => {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
};
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tg-pyscaf-')); });

const propose = (source, ctx = {}) => {
  const lines = source.split('\n');
  return lines.flatMap((_, i) => proposalsForLine(lines, i, ctx));
};
const classes = (source, ctx) => propose(source, ctx).map((p) => p.faultClass);

describe('Python producers propose the shapes the spec already closes over', () => {
  it('forces a guard whose body rejects, and leaves an ordinary branch alone', () => {
    expect(classes('if not ctx.scope:\n    raise ValueError("x")\n')).toEqual(['condition-forced']);
    // Not a guard: no condition is forced. The `total += 1` line is its own,
    // separate statement-deleted proposal.
    expect(classes('if count > 3:\n    total += 1\n')).toEqual(['statement-deleted']);
  });

  it('a one-line guard is deleted rather than forced, because there is no block to neutralise', () => {
    const p = propose('if not allowed: raise PermissionError("no")\n');
    expect(p.map((x) => x.faultClass)).toEqual(['statement-deleted']);
    expect(p[0].replace).toBe('pass');
  });

  it('removes a statement with `pass`, never by deleting the line', () => {
    // A block whose only statement is deleted is an IndentationError, and a
    // fault that cannot compile is a wasted probe run.
    const p = propose('def f(x):\n    user.active = False\n', { params: new Set(['x']) });
    const deleted = p.find((x) => x.faultClass === 'statement-deleted');
    expect(deleted.replace).toBe('    pass');
    // A bare call that is not a check is nobody's fault shape, here as in JavaScript.
    expect(classes('    session.revoke(x)\n')).toEqual([]);
  });

  it('turns a returned check into `return True`, and leaves a plain value alone', () => {
    expect(propose('    return role in allowed\n').find((p) => p.faultClass === 'return-altered').replace).toBe('    return True');
    expect(classes('    return None\n')).toEqual([]);
    expect(classes('    return user.name\n')).toEqual([]);
  });

  it('weakens Python security literals', () => {
    expect(propose('requests.get(url, verify=True)\n')[0].replace).toContain('verify=False');
    expect(propose('cookie(samesite="strict")\n')[0].replace).toContain('none');
    expect(propose('hash_password(p, rounds=12)\n')[0].replace).toContain('rounds=1');
    expect(propose('jwt.decode(t, leeway=30)\n')[0].replace).toContain('leeway=30000');
  });

  it('removes a check call but not an ordinary one', () => {
    expect(classes('    validate_token(t)\n')).toEqual(['call-removed']);
    expect(classes('    render_page(t)\n')).toEqual([]);
  });

  it('drops a field from a payload dict, and never from a class or an unrelated literal', () => {
    const payload = 'def f():\n    store.write_audit({\n        "action": "MASK",\n        "content": redacted,\n    })\n';
    const dropped = propose(payload).filter((p) => p.faultClass === 'field-dropped');
    expect(dropped).toHaveLength(2);
    expect(dropped[1].description).toContain('content');
    // The opening line of a multi-line literal is never deleted: `pass` there
    // orphans the entries below it and the file stops parsing.
    expect(classes('COLOURS = {\n    "red": 1,\n    "blue": 2,\n}\n')).toEqual([]);
    expect(classes('result = compute(\n    a,\n)\n')).toEqual([]);
  });

  it('swaps a parameter-derived argument for a trivial value, keeping the call', () => {
    const p = propose('    out = mask(text, rules)\n', { params: new Set(['text', 'rules']) });
    const swapped = p.find((x) => x.faultClass === 'argument-swapped');
    expect(swapped.replace).toContain('mask(None, rules)');
    // A literal argument is nobody's parameter and is left alone.
    expect(propose('    out = mask("abc", rules)\n', { params: new Set(['text']) }).some((x) => x.faultClass === 'argument-swapped')).toBe(false);
  });

  it('never reads a definition as a call site', () => {
    expect(classes('def compile_rules(patterns):\n', { params: new Set(['patterns']) })).toEqual([]);
    expect(classes('class Store(Base):\n')).toEqual([]);
  });

  it('ignores comments and blank lines', () => {
    expect(classes('# session.revoke(x)\n\n')).toEqual([]);
  });

  it('reads a def head, its parameters and its indentation', () => {
    expect(functionHead('    async def handle(self, request, *, strict=True):')).toBe('handle');
    expect(functionParams('    async def handle(self, request, *args, strict=True, **kw):')).toEqual(['request', 'args', 'strict', 'kw']);
    expect(functionHead('x = 1')).toBe(null);
    expect(indentOf('    x')).toBe(4);
    expect(indentOf('   ')).toBe(null);
  });
});

describe('scaffoldFile on a Python file', () => {
  const SOURCE = [
    'import re',
    '',
    '',
    '# @claim AUTH-001',
    'def authorize(user, scope):',
    '    if not user.active:',
    '        raise PermissionError("inactive")',
    '    return scope in user.scopes',
    '',
    '',
    'def emit(user, sink):',
    '    sink.publish({',
    '        "id": user.id,',
    '        "email": user.email,',
    '    })',
    '',
  ].join('\n');

  it('groups by enclosing def, honours a `#` @claim annotation, and prefills Python defenders', () => {
    write('demo/__init__.py', '');
    write('demo/auth.py', SOURCE);
    write('tests/test_auth.py', 'from demo.auth import authorize\n\ndef test_a():\n    assert authorize(u, "s")\n');
    const { doc, stats } = scaffoldFile({ projectDir: dir, file: 'demo/auth.py', toolVersion: 'test' });

    const ids = doc.claims.map((c) => c.id);
    expect(ids).toContain('AUTH-001');       // the annotation, read from a # comment
    expect(ids).toContain('AUTH-EMIT');      // scoped by indentation, not braces
    expect(doc.claims.every((c) => c.defendedBy?.includes('tests/test_auth.py'))).toBe(true);
    expect(stats.byClass['field-dropped']).toBe(2);
    expect(stats.byClass['condition-forced']).toBe(1);
  });

  it('every proposed anchor locates exactly, so no proposal can be born unverifiable', () => {
    write('demo/__init__.py', '');
    write('demo/auth.py', SOURCE);
    const { doc } = scaffoldFile({ projectDir: dir, file: 'demo/auth.py', toolVersion: 'test' });
    for (const claim of doc.claims) {
      for (const fault of claim.faults) {
        expect(locate(SOURCE, fault).status).toBe('ok');
      }
    }
  });

  it('a test file gets no payload shapes: a dict there is data, not something the product sends', () => {
    write('tests/test_payload.py', 'def test_x():\n    client.post({\n        "id": 1,\n        "email": "a@b.c",\n    })\n');
    const { stats } = scaffoldFile({ projectDir: dir, file: 'tests/test_payload.py', toolVersion: 'test' });
    expect(stats.byClass['field-dropped']).toBeUndefined();
  });
});
