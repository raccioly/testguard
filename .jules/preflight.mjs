#!/usr/bin/env node
/**
 * Step 0 of every Jules routine: is there work, and which?
 *
 *   node .jules/preflight.mjs <routine>
 *
 * Prints `GO` and the one target for this run, or `STOP: <reason>`. Exit 0 on
 * GO, 3 on STOP. A routine that gets STOP ends without changes and without a
 * pull request.
 *
 * Reads the public GitHub API for this repository's Jules PRs (no token
 * needed; GITHUB_TOKEN is used when present). It fails closed: if the queue
 * cannot be read, the answer is STOP, never a guess. Server-side triage
 * (.github/workflows/jules-triage.yml) enforces the same policy after the
 * fact; this exists so the work is not done in the first place.
 *
 * Maintenance tooling, not part of the package: the CLI makes no network
 * calls, and nothing under src/ imports this.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROUTINES, RUNNER_SCENARIOS, SCENARIO_IDS, isJules, pickTarget, scaffoldTargets, helpSubcommands, tagTitle,
} from '../.github/scripts/jules-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.TESTGUARD_REPO ?? 'raccioly/testguard';
const STOP = 3;

const stop = (reason) => { console.log(`STOP: ${reason}`); process.exit(STOP); };

async function api(path) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'testguard-jules-preflight' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return res.json();
}

function candidates(routine) {
  if (routine === 'scaffold-hunt') return scaffoldTargets(JSON.parse(readFileSync(join(ROOT, 'testguard.claims.json'), 'utf8')));
  if (routine === 'runner-scout') return [...SCENARIO_IDS];
  const help = execFileSync(process.execPath, [join(ROOT, 'cli', 'testguard.mjs'), '--help'], { encoding: 'utf8' });
  return helpSubcommands(help);
}

function details(routine, target) {
  if (routine === 'runner-scout') return [`scenario: ${RUNNER_SCENARIOS.find(([id]) => id === target)[1]}`];
  if (routine === 'docs-drift') return [`compare: node cli/testguard.mjs ${target} --help  against every mention of \`testguard ${target}\` in README.md and docs/`];
  return [`scaffold: node cli/testguard.mjs scaffold ${target} --out .testguard/scaffold-hunt.json`];
}

const routine = process.argv[2];
if (!ROUTINES.includes(routine)) stop(`unknown routine "${routine ?? ''}"; known: ${ROUTINES.join(', ')}`);

let open, closed;
try {
  const toPr = (p) => ({ number: p.number, title: p.title, labels: p.labels, mergedAt: p.merged_at, closedAt: p.closed_at });
  open = (await api('/pulls?state=open&per_page=100')).filter((p) => isJules(p.user?.login)).map(toPr);
  closed = (await api('/pulls?state=closed&sort=updated&direction=desc&per_page=100')).filter((p) => isJules(p.user?.login)).map(toPr);
} catch (e) {
  stop(`cannot read the pull request queue (${e.message}); failing closed`);
}

const pick = pickTarget({ routine, candidates: candidates(routine), open, closed, now: new Date().toISOString() });
if (!pick.go) stop(pick.reason);

console.log('GO');
console.log(`routine: ${routine}`);
console.log(`target: ${pick.target}`);
for (const line of details(routine, pick.target)) console.log(line);
console.log(`title: ${tagTitle(routine, pick.target)} — <one-line summary>`);
console.log(`open Jules PRs: ${open.length}`);
