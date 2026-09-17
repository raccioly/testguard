import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { initProject, HOOK_CMD } from '../src/init/init.mjs';

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
    expect(JSON.stringify(settings.hooks.SessionStart)).toContain(JSON.stringify(HOOK_CMD).slice(1, -1));
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

  describe('the session-start hook never fetches from the network', () => {
    const run = (cwd, env = {}) => spawnSync(HOOK_CMD, { cwd, shell: true, encoding: 'utf8', env: { ...process.env, ...env } });
    it('contains no npx and no -y: it resolves a binary, it does not install one', () => {
      expect(HOOK_CMD.startsWith('node -e ')).toBe(true);
      expect(HOOK_CMD).not.toMatch(/npx|\b-y\b|--yes|npm (i|install|exec)/);
    });
    it('runs the project-local node_modules/.bin/testguard, telling it how it was resolved', () => {
      const dir = mkdtempSync(join(tmpdir(), 'tg-hook-local-'));
      mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', '.bin', 'testguard'), '#!/bin/sh\necho "stub $* resolved=$TESTGUARD_RESOLVED"\n', { mode: 0o755 });
      const r = run(dir);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('stub brief --text resolved=local');
    });
    it('with nothing installed and nothing on PATH it exits 0 with no output — a hook must never break a session', () => {
      const dir = mkdtempSync(join(tmpdir(), 'tg-hook-none-'));
      const r = run(dir, { PATH: dirname(process.execPath) });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });
    it('a global testguard on PATH is used when the project has none, resolved=global', () => {
      const dir = mkdtempSync(join(tmpdir(), 'tg-hook-global-'));
      const binDir = mkdtempSync(join(tmpdir(), 'tg-hook-bin-'));
      writeFileSync(join(binDir, 'testguard'), '#!/bin/sh\necho "global $* resolved=$TESTGUARD_RESOLVED"\n', { mode: 0o755 });
      const r = run(dir, { PATH: `${binDir}:${dirname(process.execPath)}` });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('global brief --text resolved=global');
    });
    it('init recognises an earlier network-fetching hook: skipped with the reason, replaced with --force, then idempotent', () => {
      const dir = mkdtempSync(join(tmpdir(), 'tg-hook-legacy-'));
      mkdirSync(join(dir, '.claude'));
      writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'npx -y testguard-cli brief --text' }] }] } }));
      const first = initProject({ projectDir: dir });
      expect(first.skipped.some((x) => /fetches from the network.*npx -y testguard-cli brief --text.*--force/.test(x))).toBe(true);
      expect(JSON.stringify(JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')))).toContain('npx -y testguard-cli brief --text');
      const second = initProject({ projectDir: dir, force: true });
      expect(second.done.some((x) => /SessionStart hook replaced/.test(x))).toBe(true);
      const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
      const cmds = settings.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
      expect(cmds).toEqual([HOOK_CMD]);
      const third = initProject({ projectDir: dir });
      expect(third.done).toEqual([]);
      expect(third.skipped.some((x) => /hook already present/.test(x))).toBe(true);
    });
  });
});
