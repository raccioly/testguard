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
  const installedValidator = join(consumer, 'node_modules', 'testguard-cli', 'spec', 'lib', 'validate.mjs');
  const candidateEvidence = join(root, 'spec', 'conformance', 'examples', 'evidence.json');
  const validatesCandidateEvidence = run(process.execPath, [
    '--input-type=module',
    '-e',
    `import { pathToFileURL } from 'node:url'; import { readFileSync } from 'node:fs';
     const { validate } = await import(pathToFileURL(process.argv[1]));
     const result = validate('evidence', JSON.parse(readFileSync(process.argv[2], 'utf8')));
     if (!result.ok) throw new Error(result.errors.map((error) => \`${'${error.path}: ${error.message}'}\`).join('; '));
     process.stdout.write('ok');`,
    installedValidator,
    candidateEvidence,
  ], consumer).trim();
  if (!draft.claims?.length) throw new Error('scaffold produced no claims from the installed tarball');
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`unexpected --version output: ${version}`);
  if (!/^\d+ claims in /.test(claims)) throw new Error(`claims did not list the fixture:\n${claims}`);
  if (validatesCandidateEvidence !== 'ok') throw new Error('installed package did not validate candidate-format evidence');
  const deps = Object.keys(JSON.parse(run(npm, ['ls', '--omit=dev', '--json', '--depth=0'], consumer)).dependencies ?? {});
  console.log(`install smoke OK — testguard ${version} runs from the installed tarball; consumer deps: ${deps.join(', ')}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
