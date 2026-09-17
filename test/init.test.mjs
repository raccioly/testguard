import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('refuses to touch a settings.json it cannot parse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-init-bad-'));
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), '{not json');
    expect(() => initProject({ projectDir: dir })).toThrow(/not valid JSON/);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
  });
});
