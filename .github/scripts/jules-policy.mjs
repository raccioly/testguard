/**
 * Policy for Google Jules pull requests: which routines exist and what each
 * may work on, what is noise, what is a duplicate, when the queue is full,
 * and what may merge without a human.
 *
 * Pure: no network, no filesystem, no clock. Three consumers pass it data:
 *   .jules/preflight.mjs            — before Jules works (cooperative)
 *   .github/workflows/jules-triage.yml — when a Jules PR opens (authoritative)
 *   .github/workflows/auto-merge.yml   — after CI is green on a Jules PR
 *
 * The default is HOLD. Every merge rule is an allowlist; anything it does not
 * recognise goes to a human. A wrongly held PR costs a click; a wrongly merged
 * one ships through the weekly release to npm and PyPI.
 */

export const JULES_LOGIN = 'google-labs-jules[bot]';

/** Open Jules PRs that may wait for review before new ones are closed unread. */
export const QUEUE_CAP = 5;

/** A Jules PR closed unmerged this recently blocks the same work being re-proposed. */
export const DECLINE_WINDOW_DAYS = 60;

export const LABELS = Object.freeze({
  noise: 'jules-noise',
  duplicate: 'jules-duplicate',
  declined: 'jules-previously-declined',
  queueFull: 'jules-queue-full',
  review: 'jules-review',
  eligible: 'jules-automerge-eligible',
});

/**
 * Runner and project shapes a field user is likely to have. `runner-scout`
 * builds one per run, outside the repository, and probes it.
 */
export const RUNNER_SCENARIOS = Object.freeze([
  ['vitest-workspace-projects', 'vitest with a workspace of two projects, defenders in only one of them'],
  ['vitest-ts-path-aliases', 'vitest + TypeScript, imports through tsconfig "paths" aliases that extend a base config'],
  ['vitest-setup-files', 'vitest with setupFiles that mock a module the claim targets'],
  ['jest-projects', 'jest with a "projects" array, defenders split across both projects'],
  ['jest-esm', 'jest running native ESM via --experimental-vm-modules'],
  ['jest-ts-jest', 'jest + ts-jest transforming TypeScript sources'],
  ['playwright-custom-testdir', 'Playwright with a non-default testDir beside vitest unit tests'],
  ['pytest-conftest-fixtures', 'pytest with conftest.py fixtures that import the target module'],
  ['pytest-src-layout', 'pytest on a src/ layout package installed in editable mode'],
  ['unittest-nested-discovery', 'stdlib unittest discovery across nested packages'],
  ['node-test-native', 'node:test with no test dependency installed'],
  ['npm-workspaces-monorepo', 'npm workspaces monorepo, probing one package from the repository root'],
]);
export const SCENARIO_IDS = Object.freeze(RUNNER_SCENARIOS.map(([id]) => id));

export const ROUTINES = Object.freeze(['scaffold-hunt', 'runner-scout', 'docs-drift']);

export const isJules = (login) => String(login ?? '').toLowerCase().replace(/^app\//, '') === JULES_LOGIN
  || String(login ?? '').toLowerCase() === 'google-labs-jules';

/** `[jules:scaffold-hunt] src/git.mjs — two survivors defended` → { routine, target } */
export function parseTag(title) {
  const m = /^\[jules:([a-z0-9-]+)\]\s+(\S+)/.exec(String(title ?? '').trim());
  return m && ROUTINES.includes(m[1]) ? { routine: m[1], target: m[2] } : null;
}

export const tagTitle = (routine, target) => `[jules:${routine}] ${target}`;

const names = (files) => files.map((f) => f.filename ?? f);

/** Bookkeeping files that do not make two changes different. */
const BOOKKEEPING = new Set(['CHANGELOG.md']);

/** The file set that identifies a change. Bots word one change many ways; the files do not move. */
export const dupKey = (filenames) => [...new Set(filenames)].filter((f) => !BOOKKEEPING.has(f)).sort().join('\n');

const PERSONA = /(?:^|\s|\])(?:🛡️|⚡|🎨)|\b(?:sentinel|bolt|palette)\s*:/i;
const NO_OP = /\b(?:no (?:changes?|action|issues?|updates?) (?:needed|required|found)|(?:already|is|are) up[- ]to[- ]date|nothing to (?:do|change|fix|update)|verif(?:y|ied|ying) (?:test )?stability)\b/i;
const COUNT_SYNC = /\b(?:sync|update|bump|refresh|fix)\b.{0,40}\b(?:test )?(?:counts?|metrics?|numbers?|totals?)\b/i;

/**
 * Classes that are reliably regenerated noise. Returns a reason, or null.
 * Each one cost a sibling project dozens of PRs before it had a name.
 */
export function noiseReason({ title, files }) {
  const changed = names(files);
  if (changed.length === 0) return 'it changes no files: a status report is a task summary, not a pull request';
  if (PERSONA.test(title ?? '')) return 'it comes from a built-in Jules persona (Sentinel, Bolt, Palette), which is not enabled for this repository';
  if (NO_OP.test(title ?? '')) return 'its title reports that nothing needed changing';
  if (changed.every((n) => n.startsWith('.jules/'))) return 'it changes only `.jules/`, the routines that steer Jules; those change through a maintainer';
  if (COUNT_SYNC.test(title ?? '') && changed.every(isDocPath)) return 'it syncs a count or metric in prose; the docs checks in CI own that, and a count changes with every merge';
  return null;
}

const daysBetween = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/** The same work: the same routine target, or the same changed-file set. */
function sameWork(a, b) {
  const ta = parseTag(a.title), tb = parseTag(b.title);
  if (ta && tb && ta.routine === tb.routine && ta.target === tb.target) return true;
  const ka = dupKey(names(a.files)), kb = dupKey(names(b.files));
  return ka !== '' && ka === kb;
}

const labelled = (pr, name) => (pr.labels ?? []).some((l) => (l.name ?? l) === name);

/**
 * Decide what happens to a Jules PR the moment it opens.
 *
 * `pr`     { number, title, files: [{ filename, status }] }
 * `open`   other OPEN Jules PRs, each { number, title, files: [names], labels }
 * `closed` recently closed Jules PRs, each { number, title, files, labels, mergedAt, closedAt }
 * `now`    ISO timestamp (passed in: the policy reads no clock)
 *
 * → { action: 'close' | 'keep', label, reason, ref? }
 */
export function triage({ pr, open, closed, now }) {
  const noise = noiseReason({ title: pr.title, files: pr.files });
  if (noise) return { action: 'close', label: LABELS.noise, reason: noise };

  const others = open.filter((o) => o.number !== pr.number);
  const older = others.filter((o) => o.number < pr.number && sameWork(o, pr)).sort((a, b) => a.number - b.number)[0];
  if (older) return { action: 'close', label: LABELS.duplicate, ref: older.number, reason: `it is the same work as #${older.number}, which is still open` };

  const declined = closed
    .filter((c) => !c.mergedAt && c.closedAt && daysBetween(c.closedAt, now) <= DECLINE_WINDOW_DAYS)
    .filter((c) => !labelled(c, LABELS.queueFull))
    .filter((c) => sameWork(c, pr))
    .sort((a, b) => b.number - a.number)[0];
  if (declined) return { action: 'close', label: LABELS.declined, ref: declined.number, reason: `the same work was closed without merging in #${declined.number} within the last ${DECLINE_WINDOW_DAYS} days` };

  const waiting = others.filter((o) => !labelled(o, LABELS.queueFull)).length;
  if (waiting >= QUEUE_CAP) return { action: 'close', label: LABELS.queueFull, reason: `${waiting} Jules PRs are already waiting for review (cap ${QUEUE_CAP}); the work is not lost, the routine proposes it again once the queue drains` };

  // A preview: the claims contents are compared only once CI is green, by auto-merge.
  const { verdict, reason } = mergeVerdict({ files: pr.files, claims: null, preview: true });
  return verdict === 'merge'
    ? { action: 'keep', label: LABELS.eligible, reason }
    : { action: 'keep', label: LABELS.review, reason };
}

/** Prose a bot may change without a human: the user docs, not the rules. */
export function isDocPath(f) {
  return f === 'README.md' || (f.startsWith('docs/') && f.endsWith('.md'));
}

/** A new test module, outside the shared helpers every other test imports. */
const isNewTestPath = (f) => /^test\/(?!helpers\/)[^]*\.test\.mjs$/.test(f);

const MAX_FILES = 25;

const canonical = (v) => Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
  : v;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const without = (o, key) => { const { [key]: _drop, ...rest } = o; return rest; };

/**
 * True when `head` differs from `base` only by defenders appended to
 * `defendedBy` lists (claim- or fault-level), each one a test this PR adds.
 * Anything else in the claims file is the contract and needs a human.
 */
export function claimsOnlyGainDefenders(base, head, addedTests) {
  if (!base || !head || !same(without(base, 'claims'), without(head, 'claims'))) return false;
  if (base.claims.length !== head.claims.length) return false;
  const added = new Set(addedTests);
  const grew = (b = [], h = []) => b.every((x, i) => h[i] === x) && h.slice(b.length).every((x) => added.has(x));
  return base.claims.every((bc, i) => {
    const hc = head.claims[i];
    if (bc.id !== hc.id || bc.faults.length !== hc.faults.length) return false;
    if (!same(without(without(bc, 'defendedBy'), 'faults'), without(without(hc, 'defendedBy'), 'faults'))) return false;
    if (!grew(bc.defendedBy, hc.defendedBy)) return false;
    return bc.faults.every((bf, j) => {
      const hf = hc.faults[j];
      return same(without(bf, 'defendedBy'), without(hf, 'defendedBy')) && grew(bf.defendedBy, hf.defendedBy);
    });
  });
}

/**
 * May a green Jules PR merge without a human?
 *
 * `files`  the immutable base...head comparison: { filename, status, previous_filename? }
 * `claims` { base, head } parsed testguard.claims.json when the PR changes it, else null
 *
 * Merges: user docs; new test modules; and defenders for those new tests
 * appended to existing claims (a new test file must defend a claim or the
 * gate fails it). Never: src/, spec/, fixtures/, .github/, .jules/, packaging,
 * instruction files, a removed or renamed file, an edited test, a claim or
 * fault that changed.
 */
export function mergeVerdict({ files, claims, preview = false }) {
  if (!files.length) return { verdict: 'hold', reason: 'no files changed' };
  if (files.length > MAX_FILES) return { verdict: 'hold', reason: `${files.length} files changed (limit ${MAX_FILES}): a refactor in disguise` };

  const addedTests = [];
  let claimsFile = false;
  let substance = 0;
  for (const f of files) {
    const name = f.filename;
    if (f.previous_filename || !['added', 'modified'].includes(f.status)) return { verdict: 'hold', reason: `${name} was ${f.status}: removing or renaming a file needs a human` };
    if (name === 'testguard.claims.json') { claimsFile = true; continue; }
    if (BOOKKEEPING.has(name)) continue;
    if (isDocPath(name)) { substance++; continue; }
    if (isNewTestPath(name) && f.status === 'added') { addedTests.push(name); substance++; continue; }
    if (isNewTestPath(name)) return { verdict: 'hold', reason: `${name} edits an existing test: an assertion that changed is a change to what the suite defends` };
    return { verdict: 'hold', reason: `${name} is outside what a bot may merge alone (user docs, new tests, defenders for them)` };
  }
  if (!substance) return { verdict: 'hold', reason: 'only bookkeeping changed' };
  if (claimsFile && !preview) {
    if (!claims) return { verdict: 'hold', reason: 'testguard.claims.json changed and its contents were not compared' };
    if (!claimsOnlyGainDefenders(claims.base, claims.head, addedTests)) {
      return { verdict: 'hold', reason: 'testguard.claims.json changes more than defenders for the tests this PR adds: a claim or fault changed, which is the contract' };
    }
  }
  const parts = [addedTests.length && `${addedTests.length} new test file(s)`, claimsFile && 'their defenders', files.some((f) => isDocPath(f.filename)) && 'user docs'].filter(Boolean);
  return { verdict: 'merge', reason: parts.join(', ') };
}

/** ISO-8601 week number, so a weekly routine walks its targets in a fixed order. */
export function isoWeek(iso) {
  const d = new Date(Date.parse(iso));
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const day = (new Date(t).getUTCDay() + 6) % 7;
  const thursday = t - day * 86_400_000 + 3 * 86_400_000;
  const yearStart = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1);
  return 1 + Math.floor((thursday - yearStart) / (7 * 86_400_000));
}

/**
 * The work a routine has been given, or why it has none. Deterministic for a
 * week: the rotation starts at the week number and skips every target that
 * is open, recently declined, or (for the queue) over the cap.
 *
 * → { go: true, target } | { go: false, reason }
 */
export function pickTarget({ routine, candidates, open, closed, now }) {
  if (!ROUTINES.includes(routine)) return { go: false, reason: `unknown routine "${routine}"; known: ${ROUTINES.join(', ')}` };
  const waiting = open.filter((o) => !labelled(o, LABELS.queueFull)).length;
  if (waiting >= QUEUE_CAP) return { go: false, reason: `the review queue is full: ${waiting} Jules PRs are waiting (cap ${QUEUE_CAP})` };
  if (!candidates.length) return { go: false, reason: 'the routine has no candidate targets' };
  const taken = new Set([
    ...open,
    ...closed.filter((c) => !c.mergedAt && c.closedAt && daysBetween(c.closedAt, now) <= DECLINE_WINDOW_DAYS && !labelled(c, LABELS.queueFull)),
  ].map((p) => parseTag(p.title)).filter((t) => t?.routine === routine).map((t) => t.target));
  const start = isoWeek(now) % candidates.length;
  for (let i = 0; i < candidates.length; i++) {
    const target = candidates[(start + i) % candidates.length];
    if (!taken.has(target)) return { go: true, target };
  }
  return { go: false, reason: `every ${routine} target is already open or was declined in the last ${DECLINE_WINDOW_DAYS} days` };
}

/**
 * scaffold-hunt targets: claimed source modules, thinnest first (fewest
 * faults), so the files the claims say least about are hunted first.
 */
export function scaffoldTargets(claimsDoc) {
  const faults = new Map();
  for (const claim of claimsDoc.claims) {
    for (const fault of claim.faults) {
      if (!/^src\/.*\.mjs$/.test(fault.file)) continue;
      faults.set(fault.file, (faults.get(fault.file) ?? 0) + 1);
    }
  }
  return [...faults].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([file]) => file);
}

/** docs-drift targets: the subcommands `testguard --help` lists, in order. */
export function helpSubcommands(helpText) {
  return [...new Set([...String(helpText).matchAll(/^\s+testguard\s+([a-z][a-z-]*)\b/gm)].map((m) => m[1]))];
}
