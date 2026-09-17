import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), 'templates');
const AGENTS_BEGIN = '<!-- testguard:begin -->';
const AGENTS_END = '<!-- testguard:end -->';
const GITIGNORE_LINES = ['.testguard/evidence.json', '.testguard/evidence-provisional.json', '.testguard/evidence-partial.json', '.testguard/brief.json', '.testguard/gate.json', '.testguard/scaffold-*.json'];

/**
 * The session-start hook command. It runs from the git root (where the agent
 * session lives) and must never fetch from the network: a local install of
 * the project (or of the root) is preferred, then `npx --no-install`, then
 * nothing — the hook exits 0 with no output rather than break a session.
 * `npx -y` is deliberately absent: it would fetch the published package on
 * every session start, behind the checkout and against any supply-chain
 * posture.
 */
export function hookCommand(dir) {
  const arg = dir === '.' ? '' : ` ${dir}`;
  const candidates = dir === '.' ? ['node_modules/.bin/testguard'] : [`${dir}/node_modules/.bin/testguard`, 'node_modules/.bin/testguard'];
  return [...candidates.map((c) => `${c} brief --text${arg} 2>/dev/null`), `npx --no-install testguard brief --text${arg} 2>/dev/null`, 'true'].join(' || ');
}

function agentsBlock(entries) {
  const lines = entries.map((dir) => (dir === '.'
    ? '- This project: claims in `testguard.claims.json`; run `testguard status --json` and follow `next`.'
    : `- \`${dir}/\`: claims in \`${dir}/testguard.claims.json\`; run \`testguard status --json ${dir}\` and follow \`next\`.`));
  return `${AGENTS_BEGIN}
## TestGuard

This repository's tests are verified by [TestGuard](https://github.com/raccioly/testguard).
Before writing or changing tests, run \`testguard status --json [dir]\` and follow \`next\`.
The full operating loop and the verdict table are in \`.claude/skills/testguard/SKILL.md\`.
Never make a fault die by editing \`testguard.claims.json\`; write the test. Claim edits are recorded in the evidence.

${lines.join('\n')}
${AGENTS_END}`;
}

/** The git root of `dir`, or null outside a repository. */
export function gitRoot(dir) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Is `file` (absolute) ignored by git in `root`? False outside a repository. */
export function isGitIgnored(root, file) {
  if (!root) return false;
  return spawnSync('git', ['check-ignore', '-q', '--', file], { cwd: root }).status === 0;
}

/**
 * Install the operating layer.
 *
 * Two layers, two places. The AGENT layer — the skill, the session-start
 * hook, the AGENTS.md section — goes to the git root, because that is where
 * an agent session runs; installed in a subdirectory it never fires and is
 * never read (a field report installed it in a backend/ folder and got
 * nothing). The PROJECT layer — the `.gitignore` lines beside the claims
 * file — stays in the project directory. `here: true` keeps everything in
 * the project directory for a subdirectory that is its own agent root.
 *
 * Idempotent per project: a second project in the same repository adds a
 * hook line and an AGENTS.md bullet, never duplicates. Every written file is
 * checked against .gitignore; an ignored file is reported as ignored, never
 * as something to commit.
 */
export function initProject({ projectDir, force = false, here = false }) {
  projectDir = realpathSync(resolve(projectDir));
  const root = here ? null : gitRoot(projectDir);
  const agentRoot = root ?? projectDir;
  const ignoreRoot = root ?? gitRoot(projectDir);
  const dir = (relative(agentRoot, projectDir).split(sep).join('/')) || '.';
  const done = [];
  const skipped = [];
  const warnings = [];
  const rel = (p) => relative(agentRoot, p).split(sep).join('/');
  const note = (p) => { if (isGitIgnored(ignoreRoot, p)) warnings.push(`${rel(p)} is ignored by .gitignore — it was written, but git will not track it and agents in a fresh clone will never see it; unignore it or move it`); };

  const skillDir = join(agentRoot, '.claude', 'skills', 'testguard');
  const skillPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillPath) || force) {
    const replaced = force && existsSync(skillPath);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, readFileSync(join(TEMPLATES, 'SKILL.md'), 'utf8'));
    done.push(`${rel(skillPath)}${replaced ? ' (replaced)' : ''}`);
    note(skillPath);
  } else {
    skipped.push(`${rel(skillPath)} exists (use --force to replace)`);
  }

  const settingsPath = join(agentRoot, '.claude', 'settings.json');
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      throw new Error(`${rel(settingsPath)} is not valid JSON (${e.message}); fix it before init can add the hook`);
    }
  }
  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];
  const cmd = hookCommand(dir);
  const hasCmd = settings.hooks.SessionStart.some((e) => JSON.stringify(e).includes(cmd));
  // The pre-0.6 hook fetched the published package with `npx -y` on every session start; replace it.
  const legacy = settings.hooks.SessionStart.findIndex((e) => /npx -y testguard-cli brief --text/.test(JSON.stringify(e)) && (dir === '.' ? !/brief --text \S/.test(JSON.stringify(e)) : JSON.stringify(e).includes(`brief --text ${dir}`)));
  if (hasCmd) {
    skipped.push(`SessionStart hook for ${dir === '.' ? 'this project' : dir} already present in ${rel(settingsPath)}`);
  } else {
    if (legacy !== -1) {
      settings.hooks.SessionStart.splice(legacy, 1);
      done.push(`${rel(settingsPath)}: replaced the network-fetching \`npx -y\` hook with a local-first one`);
    }
    settings.hooks.SessionStart.push({ hooks: [{ type: 'command', command: cmd }] });
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    done.push(`${rel(settingsPath)}: SessionStart hook → brief --text${dir === '.' ? '' : ` ${dir}`} (local install first, npx --no-install fallback, never a fetch)`);
    note(settingsPath);
  }

  const agentsPath = join(agentRoot, 'AGENTS.md');
  const agents = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  const begin = agents.indexOf(AGENTS_BEGIN);
  const end = agents.indexOf(AGENTS_END);
  if (begin !== -1 && end !== -1) {
    const block = agents.slice(begin, end + AGENTS_END.length);
    const entries = [...block.matchAll(/^- (?:This project|`([^`]+)\/`)/gm)].map((m) => m[1] ?? '.');
    const legacyBlock = entries.length === 0; // a pre-0.6 section with no project list
    if (entries.includes(dir)) {
      skipped.push(`AGENTS.md already has the TestGuard section for ${dir === '.' ? 'this project' : dir}`);
    } else {
      writeFileSync(agentsPath, agents.slice(0, begin) + agentsBlock([...entries, dir]) + agents.slice(end + AGENTS_END.length));
      done.push(legacyBlock ? `AGENTS.md: TestGuard section rewritten to list ${dir}` : `AGENTS.md: TestGuard section now lists ${dir}`);
      note(agentsPath);
    }
  } else {
    writeFileSync(agentsPath, (agents ? agents.replace(/\s*$/, '\n\n') : '# Agent instructions\n\n') + agentsBlock([dir]) + '\n');
    done.push(agents ? 'AGENTS.md: TestGuard section appended' : 'AGENTS.md created with the TestGuard section');
    note(agentsPath);
  }

  const giPath = join(projectDir, '.gitignore');
  const gi = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  const entries = gi.split('\n').map((x) => x.trim());
  const dirIgnored = entries.some((x) => /^\/?\.testguard\/?$/.test(x));
  const missing = dirIgnored ? [] : GITIGNORE_LINES.filter((l) => !entries.includes(l));
  if (dirIgnored) {
    skipped.push(`${rel(giPath)} ignores .testguard/ entirely — note that baseline.json should be committed; ignore only the regenerated files if you adopt a baseline`);
  } else if (missing.length) {
    writeFileSync(giPath, (gi ? gi.replace(/\s*$/, '\n') : '') + '# TestGuard: regenerated per run (baseline.json IS committed)\n' + missing.join('\n') + '\n');
    done.push(`${rel(giPath)}: ${missing.length} line${missing.length === 1 ? '' : 's'} added`);
  } else {
    skipped.push(`${rel(giPath)} already ignores the regenerated files`);
  }
  return { done, skipped, warnings, agentRoot, projectDir, dir };
}
