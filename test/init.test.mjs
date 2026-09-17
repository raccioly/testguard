import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initProject } from '../src/init/init.mjs';

describe('init', () => {
  it('installs skill, hook, AGENTS.md section and gitignore lines; is idempotent; --force replaces only the skill', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-init-'));
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [{ matcher: 'Read', hooks: [] }] } }));
    writeFileSync(join(dir, 'AGENTS.md'), '# My project\n\nDo things.\n');
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.testguard/brief.json\n');

    const first = initProject({ projectDir: dir });
    expect(first.done).toHaveLength(4);
    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
    expect(settings.permissions.allow).toEqual(['Bash(npm test)']); // untouched
    expect(settings.hooks.PreToolUse).toHaveLength(1);              // untouched
    expect(JSON.stringify(settings.hooks.SessionStart)).toContain('testguard-cli brief --text');
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(agents.startsWith('# My project')).toBe(true);
    expect(agents).toContain('<!-- testguard:begin -->');
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
        initProject({ projectDir: dir });
        const hook = JSON.stringify(JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart);
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
