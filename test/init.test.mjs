import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initProject, hookCommand } from '../src/init/init.mjs';

const gitInit = (dir) => { const g = (...a) => spawnSync('git', ['-c', 'user.email=i@example.invalid', '-c', 'user.name=i', ...a], { cwd: dir }); g('init', '-q'); };

describe('init', () => {
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
    expect(cmd).toContain('npx --no-install testguard brief --text');
    expect(cmd).not.toMatch(/npx -y|npx testguard-cli/); // never a network fetch from a hook
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

  it('replaces a pre-0.6 `npx -y` hook with the local-first one instead of adding a second hook', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-init-legacy-')));
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'npx -y testguard-cli brief --text' }] }] } }));
    const r = initProject({ projectDir: dir });
    const hooks = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart;
    expect(hooks).toHaveLength(1);
    expect(hooks[0].hooks[0].command).toBe(hookCommand('.'));
    expect(r.done.some((d) => /replaced the network-fetching/.test(d))).toBe(true);
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
    expect(cmd).toContain('npx --no-install testguard brief --text backend');
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
});
