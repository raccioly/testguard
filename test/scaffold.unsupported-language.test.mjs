// A language scaffold has no producer set for must be refused out loud. The
// JavaScript heuristics would otherwise write `undefined` into Java and XML
// and propose JSX element removals for markup that is not JSX.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldFile } from '../src/scaffold/scaffold.mjs';
import { main } from '../src/cli.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tg-unsup-')); });
const write = (rel, text) => { writeFileSync(join(dir, rel), text); return rel; };
const capture = () => { const lines = { out: [], err: [] }; return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } }; };

const JAVA = 'package demo;\n\npublic class Access {\n    public void save(User user) {\n        validator.check(user);\n        repository.save(user);\n    }\n}\n';
const XML = '<mule>\n    <flow name="orders-flow">\n        <http:listener config-ref="api-config" path="/orders"/>\n        <when expression="#[sizeOf(payload.items) > 0]">\n            <flow-ref name="save-order"/>\n        </when>\n    </flow>\n</mule>\n';
const DWL = '%dw 2.0\noutput application/json\n---\n{\n  id: payload.orderId\n}\n';

describe('scaffold refuses a language it has no producers for', () => {
  it.each([
    ['Access.java', JAVA, '.java'],
    ['orders.xml', XML, '.xml'],
    ['Set_Status.flow-meta.xml', XML, '.xml'],
    ['order.dwl', DWL, '.dwl'],
  ])('%s yields no proposals and names the extension', (file, text, ext) => {
    write(file, text);
    const { doc, stats } = scaffoldFile({ projectDir: dir, file, toolVersion: 'test' });
    expect(stats.proposals).toBe(0);
    expect(doc.claims).toEqual([]);
    expect(stats.unsupported).toMatchObject({ extension: ext });
    expect(JSON.stringify(doc)).not.toContain('undefined');
  });

  it('JavaScript, TypeScript and Python files are not flagged unsupported', () => {
    for (const [file, text] of [['a.js', 'export function f(x) { g(x); }\n'], ['a.tsx', 'export const A = () => <div/>;\n'], ['a.py', 'def f(x):\n    g(x)\n']]) {
      write(file, text);
      expect(scaffoldFile({ projectDir: dir, file, toolVersion: 'test' }).stats.unsupported, file).toBeUndefined();
    }
  });
});

describe('scaffold command on an unsupported language', () => {
  it('says what TestGuard cannot do, exits 0, and writes no draft', async () => {
    write('Access.java', JAVA);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const a = capture();
      expect(await main(['scaffold', 'Access.java'], a.io)).toBe(0);
      const text = a.lines.out.join('\n') + a.lines.err.join('\n');
      expect(text).toMatch(/no producers for \.java/);
      expect(text).toMatch(/write faults by hand/i);
      expect(text).not.toMatch(/no test file imports/);
      expect(existsSync(join(dir, '.testguard', 'scaffold-Access.json'))).toBe(false);
    } finally { process.chdir(cwd); }
  });
});
