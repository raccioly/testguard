#!/usr/bin/env node
/**
 * Prove the package works AS INSTALLED, not as checked out: pack it, install
 * the tarball into a scratch project with production dependencies only, and
 * run the CLI from there. This is the gate that would have caught 0.1.0,
 * which shipped with its schema validator's dependency declared as a
 * devDependency and crashed on startup for every npm/npx/pip/brew user.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[1], '..', '..', '..');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const scratch = mkdtempSync(join(tmpdir(), 'testguard-install-smoke-'));
try {
  const packDir = join(scratch, 'pack');
  mkdirSync(packDir);
  run(npm, ['pack', '--pack-destination', packDir, '--ignore-scripts'], root);
  const tgz = join(packDir, readdirSync(packDir).find((f) => f.endsWith('.tgz')));

  const consumer = join(scratch, 'consumer');
  cpSync(join(root, 'fixtures', 'known-answer'), consumer, { recursive: true, filter: (s) => !/node_modules|\.flake-counter|\.testguard/.test(s) });
  run(npm, ['init', '-y'], consumer);
  run(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tgz], consumer);

  const bin = join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'testguard.cmd' : 'testguard');
  const version = run(bin, ['--version'], consumer).trim();
  const claims = run(bin, ['claims', '.'], consumer);
  const draft = JSON.parse(run(bin, ['scaffold', 'src/redact.mjs', '--json'], consumer));
  if (!draft.claims?.length) throw new Error('scaffold produced no claims from the installed tarball');
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`unexpected --version output: ${version}`);
  if (!/^\d+ claims in /.test(claims)) throw new Error(`claims did not list the fixture:\n${claims}`);
  const deps = Object.keys(JSON.parse(run(npm, ['ls', '--omit=dev', '--json', '--depth=0'], consumer)).dependencies ?? {});
  console.log(`install smoke OK — testguard ${version} runs from the installed tarball; consumer deps: ${deps.join(', ')}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
