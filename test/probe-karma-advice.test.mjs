// The CLI half of #329 for Angular: `probe .` on a project with Karma, Jasmine
// and the Angular CLI used to exit 2 with "npm i -D vitest" advice and nothing
// about Karma. It now names Karma and the flag that runs it.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { FIXTURE_GIT } from './helpers/git.mjs';

const dirs = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const by = { producer: 'human', by: 'fixture' };
const angularProject = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-karma-advice-')));
  dirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), '.testguard/\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { '@angular/cli': '^19.0.0', karma: '^6.4.0', 'karma-jasmine': '^5.1.0' } }));
  writeFileSync(join(dir, 'angular.json'), JSON.stringify({ version: 1, projects: { app: { root: '', sourceRoot: 'src', architect: { test: { builder: '@angular/build:karma', options: {} } } } } }));
  writeFileSync(join(dir, 'src/price.ts'), 'export const price = (n: number) => n * 2;\n');
  writeFileSync(join(dir, 'src/price.spec.ts'), "import { price } from './price';\ndescribe('price', () => { it('doubles', () => expect(price(2)).toBe(4)); });\n");
  writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify({ schemaVersion: 1, claims: [{
    id: 'PRICE', statement: 'The price doubles its input.', source: { kind: 'spec', ref: 'fixture' }, severity: 'high', producedBy: by, defendedBy: ['src/price.spec.ts'],
    faults: [{ id: 'F1', description: 'the factor is lost', faultClass: 'literal-changed', file: 'src/price.ts', find: 'n * 2', replace: 'n * 1', producedBy: by }],
  }] }));
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture']]) {
    execFileSync('git', [...FIXTURE_GIT, ...args], { cwd: dir, timeout: 5000 });
  }
  return dir;
};

describe('probe on an Angular project with Karma and no other runner', () => {
  it('exits 2 and says Karma was found and how to run it, never to install vitest first', async () => {
    const dir = angularProject();
    const { main } = await import('../src/cli.mjs');
    // `auto` falls back to a runner on PATH, and vitest puts node_modules/.bin there for its own tests.
    const saved = process.env.PATH;
    process.env.PATH = saved.split(delimiter).filter((p) => !/node_modules[\\/]\.bin/.test(p)).join(delimiter);
    const lines = { out: [], err: [] };
    try {
      expect(await main(['probe', dir], { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) })).toBe(2);
    } finally { process.env.PATH = saved; }
    const text = lines.err.join('\n');
    expect(text).toMatch(/Karma was found/);
    expect(text).toContain('--runner karma');
    expect(text).toContain('karma-junit-reporter');
    expect(text).not.toMatch(/If dependencies are missing, install them first/);
  }, 60_000);

  it('--runner karma is accepted, and refuses with the first thing that is missing', async () => {
    const dir = angularProject();
    const { main } = await import('../src/cli.mjs');
    const lines = { out: [], err: [] };
    expect(await main(['probe', dir, '--runner', 'karma'], { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) })).toBe(2);
    expect(lines.err.join('\n')).toMatch(/@angular\/cli is not installed in the project/);
  }, 60_000);
});
