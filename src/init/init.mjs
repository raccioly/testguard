import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), 'templates');
const AGENTS_BEGIN = '<!-- testguard:begin -->';
const AGENTS_END = '<!-- testguard:end -->';
export const GITIGNORE_LINES = ['.testguard/evidence.json', '.testguard/evidence-provisional.json', '.testguard/evidence-partial.json', '.testguard/brief.json', '.testguard/gate.json', '.testguard/scaffold-*.json', '.testguard/replay.json', '.testguard/calibration.json', '.testguard/ci-self-evidence.json', '.testguard/ci/'];

/**
 * The `.testguard/` files that ARE committed: the frozen contract, its
 * snapshot, and the CI-fetch helper the user runs by hand. Everything else in
 * the directory is regenerated. Named here so the two places that reason about
 * the directory — the lines init writes and the advice baseline prints — cannot
 * disagree about which of them is which.
 */
export const COMMITTED_OUTPUTS = ['.testguard/baseline.json', '.testguard/status.json', '.testguard/fetch-ci-evidence.sh'];

/**
 * The session-start hook command. It runs from the git root (where the agent
 * session lives) and must never fetch from the network: a local install of
 * the project (or of the root) is preferred, then a `testguard` already on
 * PATH, then nothing — the hook exits 0 with no output rather than break a
 * session.
 *
 * No form of `npx` appears here, and `--no-install` is not an exception.
 * Measured: in a project with nothing installed,
 * `npx --no-install --loglevel=http testguard-cli --version` logs
 * `npm http fetch GET 200 https://registry.npmjs.org/testguard-cli`, and
 * against an unreachable registry it exits non-zero. npm resolves the
 * packument before it decides not to install, so `--no-install` is quiet, not
 * offline. A `command -v` lookup covers the global-install case with no
 * network at all, which is the whole point in a repository that pins and
 * audits its dependencies.
 */
export function hookCommand(dir) {
  const arg = dir === '.' ? '' : ` ${dir}`;
  const candidates = dir === '.' ? ['node_modules/.bin/testguard'] : [`${dir}/node_modules/.bin/testguard`, 'node_modules/.bin/testguard'];
  // The PATH branch is braced: `a || b && c` binds as `(a || b) && c` in sh,
  // so an unbraced `&&` would run the brief a second time whenever the local
  // binary succeeded.
  const onPath = `{ command -v testguard >/dev/null 2>&1 && testguard brief --text${arg} 2>/dev/null; }`;
  return [...candidates.map((c) => `${c} brief --text${arg} 2>/dev/null`), onPath, 'true'].join(' || ');
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

export function initProject({ projectDir, force = false, here = false, ciEvidence, mcp = false }) {
  projectDir = realpathSync(resolve(projectDir));
  const root = here ? null : gitRoot(projectDir);
  const agentRoot = root ?? projectDir;
  const ignoreRoot = root ?? gitRoot(projectDir);
  const dir = (relative(agentRoot, projectDir).split(sep).join('/')) || '.';
  const done = [];
  const notes = [];
  let mcpConfig;
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
  // Any earlier hook that reached for npx — `-y` fetched outright, and
  // `--no-install` still resolves the packument from the registry — is replaced.
  // Which project a hook is for is the token right after `brief --text`, if
  // that token is an argument rather than a redirect or a shell operator.
  // Testing for any non-space there mistook `brief --text 2>/dev/null` for a
  // hook belonging to a directory, so a legacy root hook was never replaced.
  const hookDir = (text) => {
    const m = /brief --text(?:\s+([^\s"|;&]+))?/.exec(text);
    const token = m?.[1];
    return !token || token.startsWith('2>') || token.startsWith('>') ? '.' : token;
  };
  const legacy = settings.hooks.SessionStart.findIndex((e) => {
    const text = JSON.stringify(e);
    return /npx\s+(-y|--no-install)[^"]*brief --text/.test(text) && hookDir(text) === dir;
  });
  if (hasCmd) {
    skipped.push(`SessionStart hook for ${dir === '.' ? 'this project' : dir} already present in ${rel(settingsPath)}`);
  } else {
    if (legacy !== -1) {
      settings.hooks.SessionStart.splice(legacy, 1);
      done.push(`${rel(settingsPath)}: replaced the network-reaching npx hook with a local-then-PATH one`);
    }
    settings.hooks.SessionStart.push({ hooks: [{ type: 'command', command: cmd }] });
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    // Describes hookCommand() above, which emits no npx of any kind: a local
    // install, then a testguard on PATH, then nothing. The claim
    // TG-README-HOOK-MATCHES-THE-CODE holds this sentence to that, here and in
    // every other surface that describes the hook.
    done.push(`${rel(settingsPath)}: SessionStart hook → brief --text${dir === '.' ? '' : ` ${dir}`} (local install first, then a testguard on PATH, never a fetch)`);
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
  if (mcp) {
    // Printed, never written: a harness's own config is the person's file
    // (and often global), so init shows the snippet and lets them place it.
    const cmd = { command: 'npx', args: ['-y', 'testguard-cli', 'mcp'] };
    mcpConfig = {
      'Claude Code — .mcp.json in the project root, or `claude mcp add`': { mcpServers: { testguard: cmd } },
      'Cursor — .cursor/mcp.json': { mcpServers: { testguard: cmd } },
      'Codex CLI — ~/.codex/config.toml': '[mcp_servers.testguard]\ncommand = "npx"\nargs = ["-y", "testguard-cli", "mcp"]',
    };
    notes.push('MCP: five read-only tools (status, brief, claims, evidence, next_command). Nothing there runs a probe.');
  }
  return { done, skipped, warnings, agentRoot, projectDir, dir, ...(mcpConfig ? { mcpConfig } : {}) };
}
