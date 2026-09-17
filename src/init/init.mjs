import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), 'templates');
// The session-start hook resolves a binary; it never fetches one. A hook that
// runs `npx -y` downloads the published package on every session start —
// wrong in a repository that pins and audits dependencies, and it can lag the
// checkout the team actually uses. Order: the project's own node_modules/.bin,
// the git root's, then `testguard` on PATH (a global install); otherwise exit 0
// with no output, because a hook must never break a session. `npx --no-install`
// is deliberately absent: for a package that is not installed, npm consults the
// registry to resolve it before deciding not to install.
const HOOK_RESOLVER = [
  "const{existsSync}=require('fs'),{join}=require('path'),{spawnSync}=require('child_process');",
  "const root=(()=>{try{return spawnSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).stdout.trim()||process.cwd()}catch{return process.cwd()}})();",
  "const bin=process.platform==='win32'?'testguard.cmd':'testguard';",
  "for(const d of new Set([process.cwd(),root])){const p=join(d,'node_modules','.bin',bin);if(existsSync(p)){spawnSync(p,['brief','--text'],{stdio:'inherit',env:{...process.env,TESTGUARD_RESOLVED:'local'},shell:process.platform==='win32'});process.exit(0)}}",
  "spawnSync(bin,['brief','--text'],{stdio:'inherit',env:{...process.env,TESTGUARD_RESOLVED:'global'},shell:process.platform==='win32'});process.exit(0)",
].join('');
export const HOOK_CMD = `node -e "${HOOK_RESOLVER}"`;
/** Any earlier form of the hook this tool ever wrote, or a hand-written one: recognised so init can upgrade it. */
const LEGACY_HOOK_RE = /npx\s+(-y\s+|--yes\s+)?testguard(-cli)?\s+brief\s+--text|testguard(-cli)?\s+brief\s+--text/;
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
export function initProject({ projectDir, force = false }) {
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
  const hookEntries = settings.hooks.SessionStart.flatMap((g) => g?.hooks ?? []).filter((h) => h && typeof h.command === 'string');
  const current = hookEntries.find((h) => h.command === HOOK_CMD);
  const legacy = hookEntries.filter((h) => h.command !== HOOK_CMD && LEGACY_HOOK_RE.test(h.command));
  const writeSettings = () => {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  };
  if (current && legacy.length === 0) {
    skipped.push('SessionStart hook already present in .claude/settings.json');
  } else if (legacy.length && !force) {
    skipped.push(`SessionStart hook present but it fetches from the network (${legacy[0].command}); run init --force to replace it with the offline resolver`);
  } else if (legacy.length) {
    for (const h of legacy) h.command = HOOK_CMD;
    if (current) for (const g of settings.hooks.SessionStart) g.hooks = (g.hooks ?? []).filter((h) => h !== current);
    writeSettings();
    done.push(`.claude/settings.json: SessionStart hook replaced — it fetched from the network (${legacy[0].command}); it now resolves a local or global testguard and never installs`);
  } else {
    settings.hooks.SessionStart.push({ hooks: [{ type: 'command', command: HOOK_CMD }] });
    writeSettings();
    done.push('.claude/settings.json: SessionStart hook → brief --text (resolves node_modules/.bin or PATH; never fetches)');
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
  return { done, skipped };
}
