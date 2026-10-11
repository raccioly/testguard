// What init ignores is derived from what the code writes. Split from init.test.mjs so
// the claim it defends runs these tests alone, not the whole init suite.
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
// The .testguard/ directory: what init ignores is derived from what the code
// writes, never from a second hand-kept list.
// ---------------------------------------------------------------------------

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const sourceFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === 'templates' ? [] : sourceFiles(join(dir, e.name))) : e.name.endsWith('.mjs') ? [join(dir, e.name)] : []);

/**
 * Every `.testguard/` path the code builds, read from the code itself: each
 * `join(<dir>, '.testguard', <name>)` under src/ (the path helpers such as
 * sweepPath() and the inline joins alike), plus the CI download directory.
 * A join whose name is not a literal is reported, so a new artifact cannot
 * slip past by being spelled differently.
 */
function writtenTestguardPaths() {
  const paths = new Set([`${CI_DOWNLOAD_DIR}/evidence.json`]);
  const unparsed = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/join\(([^()]|\([^()]*\))*?'\.testguard'[^;\n]*/g)) {
      const name = /join\([^,]+,\s*'\.testguard',\s*(?:'([^']+)'|`([^`]+)`)\s*\)/.exec(m[0]);
      if (!name) { unparsed.push(`${file}: ${m[0].trim()}`); continue; }
      paths.add(`.testguard/${(name[1] ?? name[2]).replace(/\$\{[^}]*\}/g, 'example')}`);
    }
  }
  return { paths: [...paths].sort(), unparsed };
}

const checkIgnored = (root, rel) => spawnSync('git', [...FIXTURE_GIT, '-c', 'core.excludesFile=/dev/null', 'check-ignore', '-q', '--no-index', '--', rel], { cwd: root }).status === 0;

describe('init ignores every regenerated .testguard/ output the code writes', () => {
  const { paths, unparsed } = writtenTestguardPaths();

  it('reads the written paths from the code, and every join it found is one it understood', () => {
    expect(unparsed).toEqual([]);
    // the scan is not vacuous: it sees the helpers it is meant to see
    expect(paths).toContain(relative(tmpdir(), sweepPath(tmpdir())).split(sep).join('/'));
    expect(paths).toContain(relative(tmpdir(), sweepEvidencePath(tmpdir())).split(sep).join('/'));
    expect(paths).toContain(relative(tmpdir(), gatePath(tmpdir())).split(sep).join('/'));
    expect(paths).toContain('.testguard/scaffold-example.json');
  });

  it('git ignores each one under the lines init writes, except the committed files', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-init-every-output-')));
    gitInit(dir);
    initProject({ projectDir: dir });
    const wrong = paths.filter((p) => checkIgnored(dir, p) === COMMITTED_OUTPUTS.includes(p));
    expect(wrong, 'paths whose ignore state contradicts COMMITTED_OUTPUTS').toEqual([]);
  });

  it('the committed set is exactly the contract, the reserved status snapshot and the hand-run helper', () => {
    // Widening this set is how an output would dodge the check above; it is a
    // decision, so it is spelled out.
    expect([...COMMITTED_OUTPUTS].sort()).toEqual(['.testguard/baseline.json', '.testguard/fetch-ci-evidence.sh', '.testguard/status.json']);
  });

  it('init\'s per-file lines and the `.testguard/*` form baseline advises agree on every path, status.json included', () => {
    const perFile = realpathSync(mkdtempSync(join(tmpdir(), 'tg-init-form-a-')));
    const star = realpathSync(mkdtempSync(join(tmpdir(), 'tg-init-form-b-')));
    gitInit(perFile);
    gitInit(star);
    initProject({ projectDir: perFile });
    writeFileSync(join(star, '.gitignore'), ['.testguard/*', ...COMMITTED_OUTPUTS.map((p) => `!${p}`)].join('\n') + '\n');
    for (const p of [...paths, ...COMMITTED_OUTPUTS]) {
      expect(checkIgnored(perFile, p), p).toBe(checkIgnored(star, p));
    }
  });

  it('this repository\'s own .gitignore carries every line init writes', () => {
    const own = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim());
    expect(GITIGNORE_LINES.filter((l) => !own.includes(l))).toEqual([]);
  });

  it('re-running init on a project with an older block adds only the new lines, inside that block, once', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-init-gi-upgrade-')));
    const old = GITIGNORE_LINES.filter((l) => !/sweep/.test(l));
    const before = `node_modules/\n# TestGuard: regenerated per run (baseline.json IS committed)\n${old.join('\n')}\n# mine\ndist/\n`;
    writeFileSync(join(dir, '.gitignore'), before);
    const r = initProject({ projectDir: dir });
    const after = readFileSync(join(dir, '.gitignore'), 'utf8');
    const lines = after.split('\n');
    for (const l of GITIGNORE_LINES) expect(lines.filter((x) => x === l), l).toHaveLength(1);
    expect(lines.filter((x) => x.startsWith('# TestGuard'))).toHaveLength(1); // no second header
    // the new lines sit with the old block, not after the user's own lines
    expect(lines.indexOf('.testguard/sweep.json')).toBeLessThan(lines.indexOf('# mine'));
    expect(after.endsWith('# mine\ndist/\n')).toBe(true);
    expect(r.done).toContain('.gitignore: 2 lines added');
    expect(initProject({ projectDir: dir }).done).toEqual([]);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(after);
  });

  it('adds nothing to a project that already uses the `.testguard/*` form', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-init-gi-star-')));
    const gi = ['node_modules/', '.testguard/*', ...COMMITTED_OUTPUTS.map((p) => `!${p}`)].join('\n') + '\n';
    writeFileSync(join(dir, '.gitignore'), gi);
    const r = initProject({ projectDir: dir });
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(gi);
    expect(r.skipped.some((s) => /\.testguard\/\*/.test(s))).toBe(true);
  });
});
