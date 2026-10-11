// fetch-ci-evidence.sh (GitHub) for an ordinary project. Split from init.test.mjs so the
// claim it defends runs these tests alone.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initProject, hookCommand, GITIGNORE_LINES, COMMITTED_OUTPUTS, CI_DOWNLOAD_DIR, InitUsageError } from '../src/init/init.mjs';
import { USAGE, main } from '../src/cli.mjs';
import { sweepPath, sweepEvidencePath } from '../src/commands/sweep.mjs';
import { gatePath } from '../src/commands/gate.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const gitInit = (dir) => { const g = (...a) => spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=i@example.invalid', '-c', 'user.name=i', ...a], { cwd: dir }); g('init', '-q'); };

// ---------------------------------------------------------------------------
// fetch-ci-evidence.sh works for an ordinary project. No network: gh, glab
// and testguard are stand-ins on PATH.
// ---------------------------------------------------------------------------

describe('the CI-evidence helper', () => {
  const stub = (dir, name, body) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 }); };
  // A gh/glab stand-in that "downloads" the named file into the --dir/--path it is given.
  const ghWrites = (bin, file) => stub(bin, 'gh', `while [ $# -gt 0 ]; do [ "$1" = --dir ] && D=$2; shift; done; mkdir -p "$D/$(dirname ${file})" && echo '{}' > "$D/${file}"`);
  const glabWrites = (bin, file) => stub(bin, 'glab', `while [ $# -gt 0 ]; do [ "$1" = --path ] && D=$2; shift; done; mkdir -p "$D/$(dirname ${file})" && echo '{}' > "$D/${file}"`);
  const run = (helper, bin, cwd) => spawnSync('/bin/sh', [helper], { cwd, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } });
  const project = (platform) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `tg-helper-${platform}-`)));
    gitInit(root);
    mkdirSync(join(root, 'app'));
    initProject({ projectDir: join(root, 'app'), ciEvidence: platform });
    return { root, app: join(root, 'app'), helper: join(root, 'app', '.testguard', 'fetch-ci-evidence.sh'), bin: mkdtempSync(join(tmpdir(), 'tg-helper-bin-')) };
  };

  it('github: briefs from the evidence.json the action uploads, with the project\'s own install, from any cwd', () => {
    const p = project('github');
    ghWrites(p.bin, 'evidence.json');
    stub(join(p.app, 'node_modules', '.bin'), 'testguard', 'echo "project $*"');
    stub(join(p.root, 'node_modules', '.bin'), 'testguard', 'echo "root $*"');
    stub(p.bin, 'testguard', 'echo "path $*"');
    const r = run(p.helper, p.bin, p.root);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('project brief . --text --evidence .testguard/ci/evidence.json');
  });

  it('github: still reads ci-self-evidence.json, and falls back to the repository root\'s install, then PATH', () => {
    const p = project('github');
    ghWrites(p.bin, 'ci-self-evidence.json');
    stub(join(p.root, 'node_modules', '.bin'), 'testguard', 'echo "root $*"');
    expect(run(p.helper, p.bin, p.app).stdout.trim()).toBe('root brief . --text --evidence .testguard/ci/ci-self-evidence.json');
    const q = project('github');
    ghWrites(q.bin, 'ci-self-evidence.json');
    stub(q.bin, 'testguard', 'echo "path $*"');
    expect(run(q.helper, q.bin, q.app).stdout.trim()).toBe('path brief . --text --evidence .testguard/ci/ci-self-evidence.json');
  });

  it('github: briefs from evidence-provisional.json when that is the file the action\'s run wrote', () => {
    const p = project('github');
    ghWrites(p.bin, 'evidence-provisional.json');
    stub(join(p.app, 'node_modules', '.bin'), 'testguard', 'echo "project $*"');
    expect(run(p.helper, p.bin, p.app).stdout.trim()).toBe('project brief . --text --evidence .testguard/ci/evidence-provisional.json');
  });
});
