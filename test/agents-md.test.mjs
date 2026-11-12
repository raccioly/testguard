// @req NFR-05
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './helpers/release-project.mjs';

const whole = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
// The managed block is written by `init` for consuming projects and names a skill file this repository does not track.
const text = whole.replace(/<!-- testguard:begin -->[\s\S]*?<!-- testguard:end -->/, '');
const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
const inline = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
const FILE = /^(?:\.?[\w-]+\/)*[\w.-]+\.(?:mjs|json|md|yml|yaml|sh)$/;

describe('AGENTS.md describes the repository as it is', () => {
  it('names only files that exist', () => {
    const paths = inline.filter((t) => FILE.test(t) && !t.includes('*') && !t.startsWith('http'));
    expect(paths.length).toBeGreaterThan(15);
    // Paths a managed block or a policy names that belong to the consuming project or are generated, not to this tree.
    const elsewhere = new Set(['testguard.claims.json', 'testguard.ignore.json']);
    const missing = paths.filter((p) => !elsewhere.has(p) && !existsSync(join(ROOT, p)));
    expect(missing).toEqual([]);
  });

  it('names only directories that exist', () => {
    const dirs = inline.filter((t) => /^[\w./-]+\/$/.test(t));
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs.filter((d) => !existsSync(join(ROOT, d)))).toEqual([]);
  });

  it('names only npm scripts that exist, including every corpus flag it advertises', () => {
    const run = [...text.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
    expect(run).toEqual(expect.arrayContaining(['test:spec', 'self:probe', 'test:install', 'corpus']));
    expect(run.filter((r) => !(r in scripts))).toEqual([]);
    const corpusRun = readFileSync(join(ROOT, 'corpus', 'run.mjs'), 'utf8');
    for (const flag of text.match(/npm run corpus -- (--[\w-]+)/g).map((m) => m.split(' ').pop())) expect(corpusRun, flag).toContain(flag);
  });

  it('names only CLI commands and flags the tool has', () => {
    const help = spawnSync(process.execPath, [join(ROOT, 'cli', 'testguard.mjs'), '--help'], { encoding: 'utf8' });
    const probeHelp = spawnSync(process.execPath, [join(ROOT, 'cli', 'testguard.mjs'), 'probe', '--help'], { encoding: 'utf8' });
    const claimsHelp = spawnSync(process.execPath, [join(ROOT, 'cli', 'testguard.mjs'), 'claims', '--help'], { encoding: 'utf8' });
    for (const command of [...text.matchAll(/node cli\/testguard\.mjs (\w+)/g)].map((m) => m[1])) expect(help.stdout + help.stderr, command).toContain(command);
    expect(probeHelp.stdout + probeHelp.stderr).toContain('--changed');
    expect(claimsHelp.stdout + claimsHelp.stderr).toContain('--check-anchors');
  });

  it('carries a DocGuard review marker with a date', () => {
    expect(text).toMatch(/<!-- docguard:last-reviewed \d{4}-\d{2}-\d{2} -->/);
  });

  it('states the rules this repository learned the hard way', () => {
    for (const rule of ['corpus keys are never edited', 'Merge, never rebase', 'Never `pkill` by name', 'must not run a package manager or use the network', 'unit-level defender', 'No ceiling is raised without the maintainer', 'Parallel is the default']) expect(text, rule).toContain(rule);
  });
});
