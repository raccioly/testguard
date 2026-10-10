// @req NFR-01
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
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

describe('the README documents the hook the code actually emits', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  it('the copy-pasteable snippet is exactly what hookCommand() produces', () => {
    // A doc-vs-code contradiction shipped past two reviewers inside a release
    // about detection power. A probe cannot catch prose; this can.
    expect(readme).toContain(JSON.stringify(hookCommand('.')));
  });

  it('every hook command it shows equals the one the code emits', () => {
    // Mechanical, not prose: pull every `||`-chained `brief --text` command
    // out of the README and require it to be a hookCommand() output. The
    // shipped defect was exactly such a chain, ending in `npx --no-install`.
    const chains = [...readme.matchAll(/"((?:[^"\\]|\\.)*brief --text(?:[^"\\]|\\.)*\|\|(?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
    expect(chains.length).toBeGreaterThan(0);
    const valid = new Set([hookCommand('.'), hookCommand('backend')]);
    for (const c of chains) {
      expect(valid.has(c), `README shows a hook command the code does not emit:\n  ${c}`).toBe(true);
    }
  });

  it('never says the hook "falls back to npx" — the phrase that shipped', () => {
    // `npx testguard-cli probe` in the install table is fine: that is how to
    // RUN the tool. This is the one phrasing that asserted npx *inside the
    // hook*, and it survived review twice.
    expect(readme).not.toMatch(/falls back to `?npx/i);
  });
});

describe('no surface describes a hook mechanism the code does not use', () => {
  // The 0.6.0 fix scoped this guard to README.md, because that is where the
  // defect was found. The same sentence lived in two other places — the line
  // `init` prints as it installs the hook, and the `--help` entry — and both
  // still promised an `npx --no-install` fallback that hookCommand() had
  // stopped emitting. Scoping a claim to the artifact instead of to the
  // property is what let it drift, so the property is what is checked here:
  // a description of the hook may not name a mechanism the hook does not use.
  const MECHANISMS = /\b(npx|curl|wget|download)\b/i;
  const command = hookCommand('.');

  // "never a fetch", "no form of npx" and "never reaches the network" are the
  // sentences we WANT; they name a mechanism only to deny it. Drop negated
  // clauses before looking, so the check reads assertions, not denials.
  const assertionsOnly = (text) => text.replace(/\b(never|no form of|not|without|rather than|instead of)\b[^,.;)\n]*/gi, '');

  // An INVOCATION is not a description: `npx testguard-cli init` is how a
  // reader runs the tool, and the hook it then installs is a separate thing.
  // Only prose is held to the property.
  const isInvocation = (l) => /^\s*(?:[$>]\s*)?(?:npx|node|pnpm|yarn|bunx|testguard)\b/.test(l);

  const offenders = (text) => assertionsOnly(text)
    .split(/\n/)
    .filter((l) => /session-?start hook|brief --text|the hook/i.test(l))
    .filter((l) => !isInvocation(l))
    .filter((l) => { const m = l.match(MECHANISMS); return m && !command.includes(m[1].toLowerCase()); });

  it('--help does not', () => {
    expect(offenders(USAGE)).toEqual([]);
  });

  it('the lines init prints as it installs the hook do not', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-init-surface-')));
    const r = initProject({ projectDir: dir });
    const printed = [...r.done, ...r.skipped, ...r.warnings].join('\n');
    expect(printed).toMatch(/SessionStart hook/); // the surface under test is actually present
    expect(offenders(printed)).toEqual([]);
  });

  it('the README does not', () => {
    expect(offenders(readFileSync(new URL('../README.md', import.meta.url), 'utf8'))).toEqual([]);
  });

  // docs/ is where the hook is now explained at length, for every harness —
  // the same sentence in more places, so the same property in more places.
  const docsPages = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? docsPages(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name)] : []);

  it('no page under docs/ does, and every hook command a page shows is one the code emits', () => {
    const valid = new Set([hookCommand('.'), hookCommand('backend')]);
    for (const page of docsPages(fileURLToPath(new URL('../docs', import.meta.url)))) {
      const text = readFileSync(page, 'utf8');
      expect(offenders(text), page).toEqual([]);
      for (const m of text.matchAll(/"((?:[^"\\\n]|\\.)*brief --text(?:[^"\\\n]|\\.)*\|\|(?:[^"\\\n]|\\.)*)"/g)) {
        const c = JSON.parse(`"${m[1]}"`);
        expect(valid.has(c), `${page} shows a hook command the code does not emit:\n  ${c}`).toBe(true);
      }
    }
  });

  it('the canonical security document does not', () => {
    // A fourth surface, found by DocGuard while this very claim was being
    // widened from one artifact to three. It is currently correct, which is
    // the point: the property is checked where the sentence lives, not only
    // where a defect has already been found. NFR-01 is stated here.
    const security = readFileSync(new URL('../docs-canonical/SECURITY.md', import.meta.url), 'utf8');
    expect(security).toMatch(/session-start hook/); // the surface is actually present
    expect(offenders(security)).toEqual([]);
  });
});

describe('the session-start hook never reaches the network', () => {
  const run = (cwd, env, cmd) => spawnSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

  it('contains no form of npx — `--no-install` is quiet, not offline', () => {
    for (const dir of ['.', 'backend']) {
      const cmd = hookCommand(dir);
      expect(cmd).not.toMatch(/npx/);
      expect(cmd).not.toMatch(/curl|wget|fetch/);
    }
  });

  it('runs a project-local install, and runs it exactly once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-hook-local-'));
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '.bin', 'testguard'), '#!/bin/sh\necho ran\n', { mode: 0o755 });
    const r = run(dir, {}, hookCommand('.'));
    expect(r.status).toBe(0);
    // `a || b && c` binds as `(a || b) && c` in sh: unbraced, this printed twice
    expect(r.stdout.trim().split('\n')).toEqual(['ran']);
  });

  it('falls back to a testguard on PATH when the project has none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-hook-path-'));
    const bin = mkdtempSync(join(tmpdir(), 'tg-hook-bin-'));
    writeFileSync(join(bin, 'testguard'), '#!/bin/sh\necho global\n', { mode: 0o755 });
    const r = run(dir, { PATH: `${bin}:/usr/bin:/bin` }, hookCommand('.'));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('global');
  });

  it('with nothing installed it exits 0 and prints nothing, so a session is never broken', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-hook-none-'));
    const r = run(dir, { PATH: '/usr/bin:/bin' }, hookCommand('.'));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('init replaces an earlier npx hook, `--no-install` included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-hook-legacy-'));
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'npx --no-install testguard brief --text 2>/dev/null || true' }] }] } }));
    initProject({ projectDir: dir });
    const cmds = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
    expect(cmds.join(' ')).not.toMatch(/npx/);
    expect(cmds).toContain(hookCommand('.'));
  });
});

describe('init', () => {
  it('installs advisory update instructions without a connected hook or automatic refresh', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-init-advisory-')));
    initProject({ projectDir: dir });
    const skillPath = join(dir, '.claude', 'skills', 'testguard', 'SKILL.md');
    const agentsPath = join(dir, 'AGENTS.md');
    const skill = readFileSync(skillPath, 'utf8');
    const agents = readFileSync(agentsPath, 'utf8');
    const query = 'npm view testguard-cli dist-tags.latest --json --fetch-retries=0 --fetch-timeout=5000';
    for (const text of [skill, agents]) {
      expect(text).toContain(query);
      expect(text).toMatch(/once per (?:AI )?session/i);
      expect(text).toContain('network policy permits');
      expect(text).toMatch(/Never install automatically/i);
      expect(text).toContain('SemVer');
      expect(text).toContain('prerelease/development checkout');
      expect(text).toContain('exit codes');
    }
    expect(skill).toContain('use the same executable for verification');
    expect(skill).toContain('Do not use `npx`');
    expect(skill).toContain('without claiming the installation is up to date');
    expect(agents).toContain('project-local first, then repository-root, then PATH');
    const settings = readFileSync(join(dir, '.claude', 'settings.json'), 'utf8');
    expect(settings).not.toMatch(/npm|dist-tags|fetch-timeout/);

    const customizedSkill = `${skill}\nUser customization: keep the pinned tool.\n`;
    const customizedAgents = `User instructions before.\n${agents}\nUser instructions after.\n`;
    writeFileSync(skillPath, customizedSkill);
    writeFileSync(agentsPath, customizedAgents);
    expect(initProject({ projectDir: dir }).done).toEqual([]);
    expect(readFileSync(skillPath, 'utf8')).toBe(customizedSkill);
    expect(readFileSync(agentsPath, 'utf8')).toBe(customizedAgents);
    initProject({ projectDir: dir, force: true });
    expect(readFileSync(skillPath, 'utf8')).toBe(skill);
    expect(readFileSync(agentsPath, 'utf8')).toBe(customizedAgents);
  });

  it('installs skill, hook, AGENTS.md section and gitignore lines; is idempotent; --force replaces only the skill', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-init-')));
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [{ matcher: 'Read', hooks: [] }] } }));
    writeFileSync(join(dir, 'AGENTS.md'), '# My project\n\nDo things.\n');
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.testguard/brief.json\n');

    const first = initProject({ projectDir: dir });
    expect(first.done).toHaveLength(4);
    expect(first.warnings).toEqual([]);
    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
    expect(settings.permissions.allow).toEqual(['Bash(npm test)']); // untouched
    expect(settings.hooks.PreToolUse).toHaveLength(1);              // untouched
    const cmd = settings.hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toBe(hookCommand('.'));
    expect(cmd).toContain('node_modules/.bin/testguard brief --text');
    expect(cmd).toContain('command -v testguard'); // a PATH lookup, not a package manager
    expect(cmd).not.toMatch(/npx/); // no form of npx: --no-install still resolves from the registry
    expect(cmd.endsWith('|| true')).toBe(true);           // never breaks a session
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(agents.startsWith('# My project')).toBe(true);
    expect(agents).toContain('<!-- testguard:begin -->');
    expect(agents).toContain('- This project: claims in `testguard.claims.json`');
    const gi = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(gi.split('\n').filter((l) => l === '.testguard/brief.json')).toHaveLength(1);
    expect(gi).toContain('.testguard/evidence.json');
    const skill = readFileSync(join(dir, '.claude', 'skills', 'testguard', 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: testguard/);
    expect(skill).toContain('testguard status --json');
    expect(skill).toContain('Never make a fault die by editing the claims file');

    const second = initProject({ projectDir: dir });
    expect(second.done).toEqual([]);
    expect(second.skipped).toHaveLength(4);
    expect(JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart).toHaveLength(1);

    writeFileSync(join(dir, '.claude', 'skills', 'testguard', 'SKILL.md'), 'stale');
    const third = initProject({ projectDir: dir, force: true });
    expect(third.done).toEqual(['.claude/skills/testguard/SKILL.md (replaced)']);
    expect(readFileSync(join(dir, '.claude', 'skills', 'testguard', 'SKILL.md'), 'utf8')).toContain('testguard status --json');
  });

  it('replaces a pre-0.6 npx hook with the local-then-PATH one instead of adding a second hook', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-init-legacy-')));
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'npx -y testguard-cli brief --text' }] }] } }));
    const r = initProject({ projectDir: dir });
    const hooks = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart;
    expect(hooks).toHaveLength(1);
    expect(hooks[0].hooks[0].command).toBe(hookCommand('.'));
    expect(r.done.some((d) => /replaced the network-reaching npx hook/.test(d))).toBe(true);
  });

  it('for a project in a subdirectory, puts the agent layer at the git root and the project layer in the subdirectory; a second project adds, never duplicates', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tg-init-nested-')));
    gitInit(root);
    mkdirSync(join(root, 'backend'));
    mkdirSync(join(root, 'frontend'));
    writeFileSync(join(root, 'backend', '.gitignore'), 'node_modules/\n');

    const r = initProject({ projectDir: join(root, 'backend') });
    expect(r.agentRoot).toBe(root);
    expect(r.dir).toBe('backend');
    expect(existsSync(join(root, '.claude', 'skills', 'testguard', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(root, 'backend', '.claude'))).toBe(false);
    const cmd = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toBe(hookCommand('backend'));
    expect(cmd).toContain('backend/node_modules/.bin/testguard brief --text backend');
    expect(cmd).toContain('command -v testguard >/dev/null 2>&1 && testguard brief --text backend');
    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('- `backend/`: claims in `backend/testguard.claims.json`; run `testguard status --json backend`');
    expect(existsSync(join(root, 'backend', 'AGENTS.md'))).toBe(false);
    expect(readFileSync(join(root, 'backend', '.gitignore'), 'utf8')).toContain('.testguard/evidence.json');
    expect(existsSync(join(root, '.gitignore'))).toBe(false); // project layer stays in the project

    const again = initProject({ projectDir: join(root, 'backend') });
    expect(again.done).toEqual([]);

    const second = initProject({ projectDir: join(root, 'frontend') });
    const hooks = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart;
    expect(hooks.map((h) => h.hooks[0].command)).toEqual([hookCommand('backend'), hookCommand('frontend')]);
    const agents2 = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(agents2.match(/<!-- testguard:begin -->/g)).toHaveLength(1);
    expect(agents2).toContain('- `backend/`:');
    expect(agents2).toContain('- `frontend/`:');
    expect(second.done.some((d) => /now lists frontend/.test(d))).toBe(true);

    // --here keeps everything in the subdirectory for a project that is its own agent root
    const here = initProject({ projectDir: join(root, 'frontend'), here: true });
    expect(here.agentRoot).toBe(join(root, 'frontend'));
    expect(existsSync(join(root, 'frontend', '.claude', 'settings.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'frontend', '.claude', 'settings.json'), 'utf8')).hooks.SessionStart[0].hooks[0].command).toBe(hookCommand('.'));
  });

  it('reports a written file that .gitignore swallows instead of telling the user to commit it', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tg-init-ignored-')));
    gitInit(root);
    writeFileSync(join(root, '.gitignore'), 'AGENTS.md\n.claude/\n');
    const r = initProject({ projectDir: root });
    expect(r.warnings.filter((w) => /is ignored by \.gitignore/.test(w)).map((w) => w.split(' ')[0]).sort()).toEqual(['.claude/settings.json', '.claude/skills/testguard/SKILL.md', 'AGENTS.md']);
  });

  it('adds no per-file lines when the whole .testguard/ directory is already ignored, and says why that matters', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-init-dir-'));
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.testguard/\n');
    const r = initProject({ projectDir: dir });
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules/\n.testguard/\n');
    expect(r.skipped.some((s) => /baseline\.json should be committed/.test(s))).toBe(true);
  });

  it('refuses to touch a settings.json it cannot parse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-init-bad-'));
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), '{not json');
    expect(() => initProject({ projectDir: dir })).toThrow(/not valid JSON/);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
  });
  describe('--ci-evidence writes an on-demand helper, never a hook that fetches', () => {
    for (const platform of ['github', 'gitlab']) {
      it(`${platform}: the helper is executable, uses the platform CLI, falls back silently, and the hook stays offline`, () => {
        const dir = mkdtempSync(join(tmpdir(), `tg-ci-ev-${platform}-`));
        const r = initProject({ projectDir: dir, ciEvidence: platform });
        expect(r.done.some((x) => /fetch-ci-evidence\.sh/.test(x))).toBe(true);
        const helper = join(dir, '.testguard', 'fetch-ci-evidence.sh');
        const body = readFileSync(helper, 'utf8');
        expect(statSync(helper).mode & 0o111).toBeTruthy();
        expect(body).toContain(platform === 'github' ? 'gh run download' : 'glab ci artifact');
        expect(body).toContain('--evidence');
        // no CLI on this machine → exits 0 with a message, never a failure
        // an empty PATH (with /bin/sh addressed absolutely) is "the platform CLI is not installed"
        const run = spawnSync('/bin/sh', [helper], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: mkdtempSync(join(tmpdir(), 'tg-empty-path-')) } });
        expect(run.status).toBe(0);
        expect(run.stderr).toMatch(platform === 'github' ? /gh is not installed/ : /glab is not installed/);
        // the session-start hook is unchanged and still touches nothing
        const r2 = initProject({ projectDir: dir });
        const settingsPath = join(r2.agentRoot ?? dir, '.claude', 'settings.json');
        const hook = JSON.stringify(JSON.parse(readFileSync(settingsPath, 'utf8')).hooks.SessionStart);
        expect(hook).not.toMatch(/gh |glab |curl|wget/);
        expect(initProject({ projectDir: dir, ciEvidence: platform }).skipped.some((x) => /fetch-ci-evidence\.sh exists/.test(x))).toBe(true);
      });
    }
    it('rejects an unknown platform', () => {
      const dir = mkdtempSync(join(tmpdir(), 'tg-ci-ev-bad-'));
      expect(() => initProject({ projectDir: dir, ciEvidence: 'bitbucket' })).toThrow(/--ci-evidence must be github or gitlab/);
    });
  });
});

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

const checkIgnored = (root, rel) => spawnSync('git', ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '-q', '--no-index', '--', rel], { cwd: root }).status === 0;

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

// ---------------------------------------------------------------------------
// One TestGuard hook per project, whatever hookCommand() looked like when the
// earlier one was written.
// ---------------------------------------------------------------------------

describe('init replaces any earlier TestGuard hook in place', () => {
  const sessionStart = (dir) => JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart;
  const commands = (dir) => sessionStart(dir).flatMap((g) => g.hooks.map((h) => h.command));
  const userHook = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo hello' }] };

  // Forms a TestGuard release has written, or plausibly will: a change to
  // hookCommand() must never leave two briefs running at session start.
  const ROOT_FORMS = [
    'npx -y testguard-cli brief --text',
    'npx --no-install testguard brief --text 2>/dev/null || true',
    'node_modules/.bin/testguard brief --text 2>/dev/null || true',
    // a hypothetical later form, anchored on the harness's project variable
    '"$CLAUDE_PROJECT_DIR"/node_modules/.bin/testguard brief --text 2>/dev/null || testguard brief --text 2>/dev/null || true',
  ];

  for (const old of ROOT_FORMS) {
    it(`root: ${old}`, () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-init-hook-root-')));
      mkdirSync(join(dir, '.claude'));
      writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: old }] }, userHook] } }));
      const r = initProject({ projectDir: dir });
      expect(commands(dir)).toEqual([hookCommand('.'), 'echo hello']); // same position, user's hook untouched
      expect(r.done.some((d) => /replaced/.test(d))).toBe(true);
      const again = initProject({ projectDir: dir });
      expect(again.done).toEqual([]);
      expect(commands(dir)).toEqual([hookCommand('.'), 'echo hello']);
    });
  }

  it('nested: only the project\'s own hook is replaced; other projects\' hooks and the user\'s stay; duplicates collapse', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tg-init-hook-nested-')));
    gitInit(root);
    mkdirSync(join(root, 'backend'));
    mkdirSync(join(root, '.claude'));
    const oldBackend = 'backend/node_modules/.bin/testguard brief --text backend 2>/dev/null || node_modules/.bin/testguard brief --text backend 2>/dev/null || true';
    const oldRoot = 'node_modules/.bin/testguard brief --text 2>/dev/null || true';
    const frontend = hookCommand('frontend');
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [
      { hooks: [{ type: 'command', command: oldBackend }] },
      { hooks: [{ type: 'command', command: frontend }] },
      userHook,
      { hooks: [{ type: 'command', command: oldRoot }] },
      { hooks: [{ type: 'command', command: 'npx -y testguard-cli brief --text backend' }] }, // the duplicate the old code appended
    ] } }));
    initProject({ projectDir: join(root, 'backend') });
    expect(commands(root)).toEqual([hookCommand('backend'), frontend, 'echo hello', oldRoot]);
    expect(initProject({ projectDir: join(root, 'backend') }).done).toEqual([]);
    // the root project's own hook is still its own to replace
    initProject({ projectDir: root, here: true });
    expect(commands(root)).toEqual([hookCommand('backend'), frontend, 'echo hello', hookCommand('.')]);
  });

  it('a TestGuard hook sharing a group with the user\'s hooks is replaced without touching them', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-init-hook-group-')));
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo a' }, { type: 'command', command: ROOT_FORMS[2], timeout: 30 }] }] } }));
    initProject({ projectDir: dir });
    expect(sessionStart(dir)).toEqual([{ hooks: [{ type: 'command', command: 'echo a' }, { type: 'command', command: hookCommand('.'), timeout: 30 }] }]);
  });

  it('a user hook that merely mentions testguard is not mistaken for ours', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-init-hook-foreign-')));
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'testguard status --json > /tmp/s.json' }] }] } }));
    initProject({ projectDir: dir });
    expect(commands(dir)).toEqual(['testguard status --json > /tmp/s.json', hookCommand('.')]);
  });
});

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

  it('gitlab: briefs from the template\'s .testguard/evidence.json', () => {
    const p = project('gitlab');
    glabWrites(p.bin, '.testguard/evidence.json');
    stub(join(p.app, 'node_modules', '.bin'), 'testguard', 'echo "project $*"');
    const r = run(p.helper, p.bin, p.app);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('project brief . --text --evidence .testguard/ci/.testguard/evidence.json');
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
