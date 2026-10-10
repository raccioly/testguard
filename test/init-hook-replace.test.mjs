// One TestGuard hook per project. Split from init.test.mjs so the claim it
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

const gitInit = (dir) => { const g = (...a) => spawnSync('git', ['-c', 'user.email=i@example.invalid', '-c', 'user.name=i', ...a], { cwd: dir }); g('init', '-q'); };

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
