// init refuses before its first write. Split from init.test.mjs so the claim it
// defends runs these tests alone.
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
// init refuses before it writes: a refusal leaves the project as it was.
// ---------------------------------------------------------------------------

const listTree = (dir) => readdirSync(dir, { recursive: true }).map(String).filter((p) => !p.startsWith('.git' + sep) && p !== '.git').sort();
const capture = () => { const lines = { out: [], err: [] }; return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } }; };

describe('init validates everything before its first write', () => {
  for (const bad of ['foo', 'GitHub', 'toString', '']) {
    it(`--ci-evidence ${JSON.stringify(bad)} is a usage error (exit 3) and writes nothing`, async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-init-usage-')));
      gitInit(dir);
      const { lines, io } = capture();
      const code = await main(['init', dir, '--ci-evidence', bad], io);
      expect(code).toBe(3);
      const err = lines.err.join('\n');
      expect(err).toMatch(/--ci-evidence must be github or gitlab/);
      expect(err).toMatch(/testguard init --help/);
      expect(err).not.toMatch(/bug in testguard|\n\s+at /);
      expect(listTree(dir)).toEqual([]);
    });
  }

  it('the library refuses an unknown platform before writing, too', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-init-usage-lib-')));
    expect(() => initProject({ projectDir: dir, ciEvidence: 'bitbucket' })).toThrow(InitUsageError);
    expect(listTree(dir)).toEqual([]);
  });

  for (const [label, body, why] of [
    ['unparseable', '{not json', /not valid JSON \(.+\)/],
    ['an array', '[]', /must be a JSON object/],
    ['null', 'null', /must be a JSON object/],
    ['hooks that are not an object', '{"hooks": []}', /"hooks" must be an object/],
    ['a SessionStart that is not an array', '{"hooks": {"SessionStart": {}}}', /"hooks\.SessionStart" must be an array/],
  ]) {
    it(`a settings.json that is ${label} is a precondition failure (exit 2) naming the file, and nothing is written`, async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-init-badsettings-')));
      gitInit(dir);
      mkdirSync(join(dir, '.claude'));
      const settingsPath = join(dir, '.claude', 'settings.json');
      writeFileSync(settingsPath, body);
      const before = listTree(dir);
      const { lines, io } = capture();
      const code = await main(['init', dir, '--ci-evidence', 'github'], io);
      expect(code).toBe(2);
      const err = lines.err.join('\n');
      expect(err).toMatch(/^error: /);
      expect(err).toContain(settingsPath);
      expect(err).toMatch(why);
      expect(err).not.toMatch(/bug in testguard|\n\s+at /);
      expect(listTree(dir)).toEqual(before);           // no skill, no AGENTS.md, no .gitignore, no helper
      expect(readFileSync(settingsPath, 'utf8')).toBe(body);
    });
  }
});
