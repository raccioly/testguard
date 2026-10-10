// fetch-ci-evidence.sh (GitLab) for an ordinary project. Split from init.test.mjs so the
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

const gitInit = (dir) => { const g = (...a) => spawnSync('git', ['-c', 'user.email=i@example.invalid', '-c', 'user.name=i', ...a], { cwd: dir }); g('init', '-q'); };

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

  it('gitlab: a project in a subdirectory briefs from <dir>/.testguard/evidence.json, where the template puts it', () => {
    const p = project('gitlab'); // the project is root/app
    glabWrites(p.bin, 'app/.testguard/evidence.json');
    stub(join(p.app, 'node_modules', '.bin'), 'testguard', 'echo "project $*"');
    const r = run(p.helper, p.bin, p.root);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('project brief . --text --evidence .testguard/ci/app/.testguard/evidence.json');
  });

  it('gitlab: a project at the repository root briefs from .testguard/evidence.json', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tg-helper-gitlab-root-')));
    gitInit(root);
    initProject({ projectDir: root, ciEvidence: 'gitlab' });
    const bin = mkdtempSync(join(tmpdir(), 'tg-helper-bin-'));
    glabWrites(bin, '.testguard/evidence.json');
    stub(join(root, 'node_modules', '.bin'), 'testguard', 'echo "project $*"');
    expect(run(join(root, '.testguard', 'fetch-ci-evidence.sh'), bin, root).stdout.trim()).toBe('project brief . --text --evidence .testguard/ci/.testguard/evidence.json');
  });

  it('gitlab: never briefs a subdirectory project from another project\'s evidence in the same artifact', () => {
    const p = project('gitlab'); // root/app, but the artifact holds only the root project's evidence
    glabWrites(p.bin, '.testguard/evidence.json');
    stub(join(p.app, 'node_modules', '.bin'), 'testguard', 'echo "project $*"');
    const r = run(p.helper, p.bin, p.app);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/holds no evidence for this project .*app\/\.testguard\/evidence\.json/);
  });

  for (const platform of ['github', 'gitlab']) {
    const tool = platform === 'github' ? 'gh' : 'glab';
    it(`${platform}: exits 0 with a message when no CLI, no artifact, or no evidence file is found — never a stale file`, () => {
      const p = project(platform);
      // no testguard anywhere
      stub(p.bin, tool, 'exit 0');
      let r = run(p.helper, p.bin, p.app);
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/no testguard CLI found/);
      // the artifact is missing
      stub(join(p.app, 'node_modules', '.bin'), 'testguard', 'echo "project $*"');
      stub(p.bin, tool, 'exit 1');
      r = run(p.helper, p.bin, p.app);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/no .*artifact/);
      // an evidence file left by an earlier download is not briefed from
      mkdirSync(join(p.app, '.testguard', 'ci'), { recursive: true });
      writeFileSync(join(p.app, '.testguard', 'ci', 'evidence.json'), '{}');
      stub(p.bin, tool, 'exit 0'); // "downloads" an artifact with nothing we recognise
      r = run(p.helper, p.bin, p.app);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/holds no evidence/);
    });
  }
});
