import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync, chmodSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PreconditionError } from '../probe/worktree.mjs';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), 'templates');
const AGENTS_BEGIN = '<!-- testguard:begin -->';
const AGENTS_END = '<!-- testguard:end -->';
/** Where fetch-ci-evidence.sh downloads CI's artifact, relative to the project. */
export const CI_DOWNLOAD_DIR = '.testguard/ci';
const GITIGNORE_HEADER = '# TestGuard: regenerated per run (baseline.json IS committed)';
// Every regenerated file a command writes under .testguard/. test/init.test.mjs
// derives that set from the code's own path joins and fails when one is missing
// here, so a new artifact cannot ship without its ignore line.
export const GITIGNORE_LINES = ['.testguard/evidence.json', '.testguard/evidence-provisional.json', '.testguard/evidence-partial.json', '.testguard/brief.json', '.testguard/gate.json', '.testguard/scaffold-*.json', '.testguard/replay.json', '.testguard/calibration.json', '.testguard/ci-self-evidence.json', '.testguard/ci/', '.testguard/sweep.json', '.testguard/sweep-evidence.json'];

/**
 * The `.testguard/` files that are NOT ignored: the frozen contract
 * (baseline.json), the CI-fetch helper `init --ci-evidence` writes for the user
 * to run by hand, and status.json — a name reserved for a status snapshot a
 * project may choose to keep (`status --json > .testguard/status.json`). No
 * command writes status.json; it is listed so that both ignore forms leave it
 * trackable alike: init's per-file lines never name it, and the `.testguard/*`
 * form baseline advises negates it. Everything else in the directory is
 * regenerated. Named here so the two places that reason about the directory —
 * the lines init writes and the advice baseline prints — cannot disagree.
 */
export const COMMITTED_OUTPUTS = ['.testguard/baseline.json', '.testguard/status.json', '.testguard/fetch-ci-evidence.sh'];

/** A bad option to init: the CLI reports it as a usage error (exit 3). */
export class InitUsageError extends Error {}

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

Once per AI session, identify the exact CLI used (project-local first, then repository-root, then PATH) and read its \`--version\`.
If network policy permits, check \`npm view testguard-cli dist-tags.latest --json --fetch-retries=0 --fetch-timeout=5000\` once; this is optional AI advice, not a CLI or hook network call.
Compare stable versions numerically by SemVer; do not downgrade or replace a prerelease/development checkout. If a newer stable version exists, suggest it and ask before updating, respecting pins and the original package manager.
Never install automatically or alter lockfiles/CI pins without approval. On an unavailable check, continue without claiming up-to-date; keep advice separate from evidence, verdicts and exit codes. Do not repeat a declined suggestion this session.
Existing copied skills and sections are preserved by ordinary init; review and merge template changes manually, or use \`init --force\` only with approval to overwrite the skill.

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
 * The directory a TestGuard session-start hook briefs, or null when the
 * command is not a TestGuard hook.
 *
 * Recognised by what every release's hook has run — `testguard brief --text`,
 * through `npx -y testguard-cli`, `npx --no-install testguard`, a local
 * `node_modules/.bin/testguard` or a `testguard` on PATH — not by the exact
 * text of the current hookCommand(). Matching only the current text (and two
 * named npx forms) meant any change to hookCommand() made the next `init`
 * append a second hook beside the first, and every session briefed twice.
 * The project is the token after `--text` when it is an argument rather than
 * a redirect or a shell operator.
 */
export function briefHookDir(command) {
  if (typeof command !== 'string') return null;
  const m = /(?:^|[\s/])testguard(?:-cli)?(?:@[^\s"|;&]+)?\s+brief\s+--text\b(?:\s+([^\s"|;&]+))?/.exec(command);
  if (!m) return null;
  const token = m[1];
  return !token || token.startsWith('2>') || token.startsWith('>') ? '.' : token;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Read `.claude/settings.json` for the hook, or refuse. A file init cannot
 * safely merge into is a precondition failure naming the file — never a crash,
 * and never after another file has been written.
 */
function readSettings(settingsPath) {
  if (!existsSync(settingsPath)) return {};
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    throw new PreconditionError(`${settingsPath} is not valid JSON (${e.message}); fix it before init can add the hook. Nothing was written.`);
  }
  const refuse = (what) => { throw new PreconditionError(`${settingsPath}: ${what}; fix it before init can add the hook. Nothing was written.`); };
  if (!isPlainObject(settings)) refuse('the settings must be a JSON object');
  if (settings.hooks !== undefined && !isPlainObject(settings.hooks)) refuse('"hooks" must be an object');
  if (settings.hooks?.SessionStart !== undefined && !Array.isArray(settings.hooks.SessionStart)) refuse('"hooks.SessionStart" must be an array');
  return settings;
}

/**
 * The `.gitignore` text with init's lines in it, or null when nothing is
 * missing. Lines a previous init wrote stay where they are; lines a newer
 * release added go directly after the last of them, so re-running init after
 * an upgrade extends the one block instead of appending a second header.
 */
function gitignoreWithLines(gi, missing) {
  const lines = gi.split('\n');
  let last = -1;
  lines.forEach((l, i) => { if (GITIGNORE_LINES.includes(l.trim())) last = i; });
  if (last === -1) return (gi ? gi.replace(/\s*$/, '\n') : '') + GITIGNORE_HEADER + '\n' + missing.join('\n') + '\n';
  return [...lines.slice(0, last + 1), ...missing, ...lines.slice(last + 1)].join('\n');
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
 *
 * All or nothing: every input is read and every refusal raised before the
 * first write, so a bad option or an unmergeable settings.json leaves the
 * project exactly as it was.
 */
const CI_EVIDENCE_HELPER = (platform) => {
  const github = platform === 'github';
  const tool = github ? 'gh' : 'glab';
  const download = github
    ? 'gh run download --name "testguard-evidence-$BRANCH" --dir "$OUT"'
    : 'glab ci artifact "$BRANCH" testguard:probe --path "$OUT/"';
  const missing = github ? 'no testguard-evidence-$BRANCH artifact to download' : 'no testguard:probe artifact to download for $BRANCH';
  return `#!/bin/sh
# Fetch the evidence CI wrote on a branch, then brief from it. Run it when you
# want it: the session-start hook never touches the network, and this script
# exits 0 with a message whenever anything is missing.
BRANCH="\${1:-main}"
# Run from the project this helper belongs to, whatever the caller's cwd.
case "$0" in */*) cd "\${0%/*}/.." || exit 0 ;; *) cd .. || exit 0 ;; esac
OUT=${CI_DOWNLOAD_DIR}
command -v ${tool} >/dev/null 2>&1 || { echo "${tool} is not installed; see https://github.com/raccioly/testguard/blob/main/docs/guides/ci/${github ? 'github-actions' : 'gitlab'}.md#read-cis-evidence-locally" >&2; exit 0; }
# The CLI the session-start hook would run: this project's install, then the
# repository root's, then a testguard on PATH. Never a package-runner fetch.
TG=
ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
for c in ./node_modules/.bin/testguard "\${ROOT:+$ROOT/node_modules/.bin/testguard}"; do
  if [ -n "$c" ] && [ -x "$c" ]; then TG=$c; break; fi
done
[ -n "$TG" ] || TG=$(command -v testguard 2>/dev/null)
[ -n "$TG" ] || { echo "no testguard CLI found (./node_modules/.bin, the repository root's node_modules/.bin, or PATH); install it, or run npx testguard-cli brief . --text --evidence <file>" >&2; exit 0; }
# A fresh download directory, so an earlier download is never briefed as this one.
rm -rf "$OUT" && mkdir -p "$OUT" || exit 0
${download} >/dev/null 2>&1 || { echo "${missing}" >&2; exit 0; }
# evidence.json is what the GitHub Action and the GitLab template write;
# ci-self-evidence.json is the name an earlier workflow example uploaded.
for f in "$OUT/evidence.json" "$OUT/ci-self-evidence.json" "$OUT/.testguard/evidence.json"; do
  [ -f "$f" ] && exec "$TG" brief . --text --evidence "$f"
done
echo "the downloaded artifact holds no evidence.json, ci-self-evidence.json or .testguard/evidence.json" >&2
exit 0
`;
};
const CI_PLATFORMS = ['github', 'gitlab'];

export function initProject({ projectDir, force = false, here = false, ciEvidence, mcp = false }) {
  if (ciEvidence !== undefined && !CI_PLATFORMS.includes(ciEvidence)) throw new InitUsageError(`--ci-evidence must be github or gitlab, not ${JSON.stringify(ciEvidence)}`);
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
  const writes = [];
  const rel = (p) => relative(agentRoot, p).split(sep).join('/');
  const note = (p) => { if (isGitIgnored(ignoreRoot, p)) warnings.push(`${rel(p)} is ignored by .gitignore — it was written, but git will not track it and agents in a fresh clone will never see it; unignore it or move it`); };
  const write = (path, content, { mode, checkIgnored = true } = {}) => writes.push({ path, content, mode, checkIgnored });

  // ---- preflight: read everything, refuse here, write nothing yet ----
  const settingsPath = join(agentRoot, '.claude', 'settings.json');
  const settings = readSettings(settingsPath);

  const skillDir = join(agentRoot, '.claude', 'skills', 'testguard');
  const skillPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillPath) || force) {
    const replaced = force && existsSync(skillPath);
    write(skillPath, readFileSync(join(TEMPLATES, 'SKILL.md'), 'utf8'));
    done.push(`${rel(skillPath)}${replaced ? ' (replaced)' : ''}`);
  } else {
    skipped.push(`${rel(skillPath)} exists (use --force to replace)`);
  }

  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];
  const groups = settings.hooks.SessionStart;
  const cmd = hookCommand(dir);
  // Every TestGuard hook already briefing this project, whichever release wrote it.
  const ours = [];
  groups.forEach((g, gi) => { if (Array.isArray(g?.hooks)) g.hooks.forEach((h, hi) => { if (briefHookDir(h?.command) === dir) ours.push({ gi, hi, command: h.command }); }); });
  const hasCmd = ours.length === 1 && ours[0].command === cmd;
  if (hasCmd) {
    skipped.push(`SessionStart hook for ${dir === '.' ? 'this project' : dir} already present in ${rel(settingsPath)}`);
  } else {
    if (ours.length) {
      // Replace the first in place, keeping its position and any other keys
      // (a timeout, say); drop the rest, which are duplicates an older init left.
      const [first, ...extra] = ours;
      groups[first.gi].hooks[first.hi] = { ...groups[first.gi].hooks[first.hi], command: cmd };
      for (const { gi, hi } of extra.reverse()) groups[gi].hooks.splice(hi, 1);
      settings.hooks.SessionStart = groups.filter((g, gi) => !extra.some((x) => x.gi === gi) || g.hooks.length > 0);
      const npx = ours.some((o) => /\bnpx\b/.test(o.command));
      done.push(npx
        ? `${rel(settingsPath)}: replaced the network-reaching npx hook with a local-then-PATH one`
        : `${rel(settingsPath)}: replaced an earlier TestGuard hook for ${dir === '.' ? 'this project' : dir} in place`);
    } else {
      groups.push({ hooks: [{ type: 'command', command: cmd }] });
    }
    write(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    // Describes hookCommand() above, which emits no npx of any kind: a local
    // install, then a testguard on PATH, then nothing. The claim
    // TG-README-HOOK-MATCHES-THE-CODE holds this sentence to that, here and in
    // every other surface that describes the hook.
    done.push(`${rel(settingsPath)}: SessionStart hook → brief --text${dir === '.' ? '' : ` ${dir}`} (local install first, then a testguard on PATH, never a fetch)`);
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
      write(agentsPath, agents.slice(0, begin) + agentsBlock([...entries, dir]) + agents.slice(end + AGENTS_END.length));
      done.push(legacyBlock ? `AGENTS.md: TestGuard section rewritten to list ${dir}` : `AGENTS.md: TestGuard section now lists ${dir}`);
    }
  } else {
    write(agentsPath, (agents ? agents.replace(/\s*$/, '\n\n') : '# Agent instructions\n\n') + agentsBlock([dir]) + '\n');
    done.push(agents ? 'AGENTS.md: TestGuard section appended' : 'AGENTS.md created with the TestGuard section');
  }

  const giPath = join(projectDir, '.gitignore');
  const gi = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  const entries = gi.split('\n').map((x) => x.trim());
  const dirIgnored = entries.some((x) => /^\/?\.testguard\/?$/.test(x));
  // `.testguard/*` with negations is the form `baseline` advises: it already
  // covers every output, present and future, so per-file lines would be noise.
  const starForm = entries.some((x) => /^\/?\.testguard\/\*$/.test(x));
  const missing = dirIgnored || starForm ? [] : GITIGNORE_LINES.filter((l) => !entries.includes(l));
  if (dirIgnored) {
    skipped.push(`${rel(giPath)} ignores .testguard/ entirely — note that baseline.json should be committed; ignore only the regenerated files if you adopt a baseline`);
  } else if (starForm) {
    skipped.push(`${rel(giPath)} ignores .testguard/* — every regenerated output is covered; keep ${COMMITTED_OUTPUTS.map((p) => `!${p}`).join(', ')} beside it`);
  } else if (missing.length) {
    write(giPath, gitignoreWithLines(gi, missing), { checkIgnored: false });
    done.push(`${rel(giPath)}: ${missing.length} line${missing.length === 1 ? '' : 's'} added`);
  } else {
    skipped.push(`${rel(giPath)} already ignores the regenerated files`);
  }
  if (ciEvidence !== undefined) {
    const helperPath = join(projectDir, '.testguard', 'fetch-ci-evidence.sh');
    if (!existsSync(helperPath) || force) {
      write(helperPath, CI_EVIDENCE_HELPER(ciEvidence), { mode: 0o755, checkIgnored: false });
      done.push(`.testguard/fetch-ci-evidence.sh (${ciEvidence}) — run it on demand; the session-start hook stays offline`);
    } else {
      skipped.push('.testguard/fetch-ci-evidence.sh exists (use --force to replace)');
    }
  }

  // ---- every check passed: write ----
  for (const w of writes) {
    mkdirSync(dirname(w.path), { recursive: true });
    writeFileSync(w.path, w.content, w.mode === undefined ? undefined : { mode: w.mode });
    if (w.mode !== undefined) chmodSync(w.path, w.mode); // an existing file keeps its old mode otherwise
    if (w.checkIgnored) note(w.path);
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
