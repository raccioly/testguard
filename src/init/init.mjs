import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), 'templates');
const HOOK_CMD = 'npx -y testguard-cli brief --text';
const AGENTS_BEGIN = '<!-- testguard:begin -->';
const AGENTS_END = '<!-- testguard:end -->';
const AGENTS_BLOCK = `${AGENTS_BEGIN}
## TestGuard

This project's tests are verified by [TestGuard](https://github.com/raccioly/testguard).
Before writing or changing tests, run \`testguard status --json\` and follow \`next\`.
The full operating loop and the verdict table are in \`.claude/skills/testguard/SKILL.md\`.
Never make a fault die by editing \`testguard.claims.json\`; write the test. Claim edits are recorded in the evidence.
${AGENTS_END}`;
const GITIGNORE_LINES = ['.testguard/evidence.json', '.testguard/evidence-provisional.json', '.testguard/evidence-partial.json', '.testguard/brief.json', '.testguard/gate.json', '.testguard/scaffold-*.json'];

/**
 * Install the agent operating layer into a consumer project: the skill, the
 * session-start hook, an AGENTS.md section and the .gitignore lines.
 * Idempotent: re-running changes nothing unless --force replaces the skill.
 */
const CI_EVIDENCE_HELPERS = {
  github: `#!/bin/sh
# Fetch the evidence CI wrote on a branch, then brief from it. Run it when you
# want it: the session-start hook never touches the network, and this script
# exits 0 with a message whenever anything is missing.
BRANCH="\${1:-main}"
OUT=.testguard/ci
command -v gh >/dev/null 2>&1 || { echo "gh is not installed; see README > Read CI's evidence locally" >&2; exit 0; }
command -v testguard >/dev/null 2>&1 || { echo "testguard is not on PATH; install it or run npx testguard-cli brief --evidence <file>" >&2; exit 0; }
mkdir -p "$OUT" || exit 0
gh run download --name "testguard-evidence-$BRANCH" --dir "$OUT" >/dev/null 2>&1 || { echo "no testguard-evidence-$BRANCH artifact to download" >&2; exit 0; }
exec testguard brief . --text --evidence "$OUT/ci-self-evidence.json"
`,
  gitlab: `#!/bin/sh
# Fetch the evidence CI wrote on a branch, then brief from it. Run it when you
# want it: the session-start hook never touches the network, and this script
# exits 0 with a message whenever anything is missing.
BRANCH="\${1:-main}"
OUT=.testguard/ci
command -v glab >/dev/null 2>&1 || { echo "glab is not installed; see README > Read CI's evidence locally" >&2; exit 0; }
command -v testguard >/dev/null 2>&1 || { echo "testguard is not on PATH; install it or run npx testguard-cli brief --evidence <file>" >&2; exit 0; }
mkdir -p "$OUT" || exit 0
glab ci artifact "$BRANCH" testguard:probe --path "$OUT/" >/dev/null 2>&1 || { echo "no testguard:probe artifact to download for $BRANCH" >&2; exit 0; }
exec testguard brief . --text --evidence "$OUT/.testguard/evidence.json"
`,
};

export function initProject({ projectDir, force = false, ciEvidence }) {
  const done = [];
  const skipped = [];

  const skillDir = join(projectDir, '.claude', 'skills', 'testguard');
  const skillPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillPath) || force) {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, readFileSync(join(TEMPLATES, 'SKILL.md'), 'utf8'));
    done.push(`.claude/skills/testguard/SKILL.md${force && existsSync(skillPath) ? ' (replaced)' : ''}`);
  } else {
    skipped.push('.claude/skills/testguard/SKILL.md exists (use --force to replace)');
  }

  const settingsPath = join(projectDir, '.claude', 'settings.json');
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      throw new Error(`.claude/settings.json is not valid JSON (${e.message}); fix it before init can add the hook`);
    }
  }
  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];
  const already = JSON.stringify(settings.hooks.SessionStart).includes(HOOK_CMD);
  if (already) {
    skipped.push('SessionStart hook already present in .claude/settings.json');
  } else {
    settings.hooks.SessionStart.push({ hooks: [{ type: 'command', command: HOOK_CMD }] });
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    done.push('.claude/settings.json: SessionStart hook → brief --text');
  }

  const agentsPath = join(projectDir, 'AGENTS.md');
  const agents = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  if (agents.includes(AGENTS_BEGIN)) {
    skipped.push('AGENTS.md already has the TestGuard section');
  } else {
    writeFileSync(agentsPath, (agents ? agents.replace(/\s*$/, '\n\n') : '# Agent instructions\n\n') + AGENTS_BLOCK + '\n');
    done.push(agents ? 'AGENTS.md: TestGuard section appended' : 'AGENTS.md created with the TestGuard section');
  }

  const giPath = join(projectDir, '.gitignore');
  const gi = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  const entries = gi.split('\n').map((x) => x.trim());
  const dirIgnored = entries.some((x) => /^\/?\.testguard\/?$/.test(x));
  const missing = dirIgnored ? [] : GITIGNORE_LINES.filter((l) => !entries.includes(l));
  if (dirIgnored) {
    skipped.push('.gitignore ignores .testguard/ entirely — note that baseline.json should be committed; ignore only the regenerated files if you adopt a baseline');
  } else if (missing.length) {
    writeFileSync(giPath, (gi ? gi.replace(/\s*$/, '\n') : '') + '# TestGuard: regenerated per run (baseline.json IS committed)\n' + missing.join('\n') + '\n');
    done.push(`.gitignore: ${missing.length} line${missing.length === 1 ? '' : 's'} added`);
  } else {
    skipped.push('.gitignore already ignores the regenerated files');
  }
  if (ciEvidence) {
    const helperPath = join(projectDir, '.testguard', 'fetch-ci-evidence.sh');
    const body = CI_EVIDENCE_HELPERS[ciEvidence];
    if (!body) throw new Error(`--ci-evidence must be github or gitlab, not ${ciEvidence}`);
    if (!existsSync(helperPath) || force) {
      mkdirSync(dirname(helperPath), { recursive: true });
      writeFileSync(helperPath, body, { mode: 0o755 });
      done.push(`.testguard/fetch-ci-evidence.sh (${ciEvidence}) — run it on demand; the session-start hook stays offline`);
    } else {
      skipped.push('.testguard/fetch-ci-evidence.sh exists (use --force to replace)');
    }
  }
  return { done, skipped };
}
