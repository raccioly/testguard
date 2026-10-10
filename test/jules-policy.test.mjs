import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LABELS, QUEUE_CAP, ROUTINES, SCENARIO_IDS, claimsOnlyGainDefenders, dupKey, helpSubcommands, isJules,
  isoWeek, mergeVerdict, noiseReason, parseTag, pickTarget, scaffoldTargets, tagTitle, triage,
} from '../.github/scripts/jules-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-10-10T12:00:00Z';
const daysAgo = (n) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
const added = (filename) => ({ filename, status: 'added' });
const modified = (filename) => ({ filename, status: 'modified' });
const openPr = (number, title, files = [], labels = []) => ({ number, title, files, labels });

describe('who and what a Jules PR is', () => {
  it('recognises the bot under both spellings GitHub uses, and nobody else', () => {
    expect(isJules('google-labs-jules[bot]')).toBe(true);
    expect(isJules('app/google-labs-jules[bot]')).toBe(true);
    expect(isJules('google-labs-jules')).toBe(true);
    expect(isJules('raccioly')).toBe(false);
    expect(isJules('dependabot[bot]')).toBe(false);
    expect(isJules(undefined)).toBe(false);
  });

  it('reads the routine tag a title starts with, and only for a known routine', () => {
    expect(parseTag('[jules:scaffold-hunt] src/git.mjs — two survivors defended')).toEqual({ routine: 'scaffold-hunt', target: 'src/git.mjs' });
    expect(parseTag(tagTitle('docs-drift', 'claims'))).toEqual({ routine: 'docs-drift', target: 'claims' });
    expect(parseTag('[jules:sentinel] anything')).toBeNull();
    expect(parseTag('fix: something')).toBeNull();
    expect(ROUTINES).toEqual(['scaffold-hunt', 'runner-scout', 'docs-drift']);
  });

  it('keys a change by its files, ignoring the changelog and order', () => {
    expect(dupKey(['b.mjs', 'CHANGELOG.md', 'a.mjs'])).toBe(dupKey(['a.mjs', 'b.mjs']));
    expect(dupKey(['CHANGELOG.md'])).toBe('');
  });
});

describe('noise: classes that cost sibling projects dozens of PRs', () => {
  const docs = [modified('docs/usage.md')];
  it.each([
    ['🛡️ Sentinel: [CRITICAL] Fix command injection via execSync', [modified('src/a.mjs')]],
    ['⚡ Bolt: [performance improvement] Pre-compute basenames', [modified('src/a.mjs')]],
    ['🎨 Palette: No web UI components available', [modified('README.md')]],
    ['chore: @babel/parser is up to date', [modified('package.json')]],
    ['chore: verify test stability', [modified('test/a.test.mjs')]],
    ['docs: sync test count metric', docs],
    ['docs: update cross-referenced metrics to match codebase state', docs],
  ])('closes %s', (title, files) => {
    expect(noiseReason({ title, files })).toBeTruthy();
  });

  it('closes a PR that changes nothing, and one that only rewrites its own routines', () => {
    expect(noiseReason({ title: 'Investigate flaky test', files: [] })).toMatch(/no files/);
    expect(noiseReason({ title: 'Improve routine', files: [modified('.jules/routines/docs-drift.md')] })).toMatch(/\.jules/);
  });

  it('does not call a count fix noise when it touches code, nor an ordinary fix noise', () => {
    expect(noiseReason({ title: 'fix: count of probed faults is off by one', files: [modified('src/probe/probe.mjs')] })).toBeNull();
    expect(noiseReason({ title: '[jules:docs-drift] claims — --since is undocumented', files: docs })).toBeNull();
  });
});

describe('triage of a Jules PR as it opens', () => {
  const pr = { number: 50, title: '[jules:scaffold-hunt] src/git.mjs — defend two survivors', files: [added('test/git-hooks.test.mjs'), modified('testguard.claims.json')] };

  it('closes the newer of two PRs for the same routine target, whatever files they touch', () => {
    const d = triage({ pr, open: [openPr(41, '[jules:scaffold-hunt] src/git.mjs — other wording', ['test/other.test.mjs'])], closed: [], now: NOW });
    expect(d).toMatchObject({ action: 'close', label: LABELS.duplicate, ref: 41 });
  });

  it('closes the newer of two PRs with the same files, whatever they are titled', () => {
    const websec = { number: 90, title: 'Fix flaky git hooks test', files: [modified('test/hooks.test.mjs')] };
    const older = openPr(88, 'fix(tests): pin core.hooksPath in the test repo', ['test/hooks.test.mjs', 'CHANGELOG.md']);
    expect(triage({ pr: websec, open: [older], closed: [], now: NOW })).toMatchObject({ action: 'close', ref: 88 });
  });

  it('never closes the older PR in favour of a newer one', () => {
    const d = triage({ pr: { ...pr, number: 30 }, open: [openPr(41, pr.title, ['test/git-hooks.test.mjs', 'testguard.claims.json'])], closed: [], now: NOW });
    expect(d.action).toBe('keep');
  });

  it('closes work declined within the window, and allows it again after', () => {
    const declined = (closedAt, labels = []) => ({ number: 12, title: pr.title, files: [], labels, mergedAt: null, closedAt });
    expect(triage({ pr, open: [], closed: [declined(daysAgo(59))], now: NOW })).toMatchObject({ action: 'close', label: LABELS.declined, ref: 12 });
    expect(triage({ pr, open: [], closed: [declined(daysAgo(61))], now: NOW }).action).toBe('keep');
  });

  it('does not count a merged PR, or one closed only for a full queue, as declined', () => {
    const merged = { number: 12, title: pr.title, files: [], labels: [], mergedAt: daysAgo(3), closedAt: daysAgo(3) };
    const overflow = { number: 13, title: pr.title, files: [], labels: [{ name: LABELS.queueFull }], mergedAt: null, closedAt: daysAgo(3) };
    expect(triage({ pr, open: [], closed: [merged, overflow], now: NOW }).action).toBe('keep');
  });

  it(`closes a new PR once ${QUEUE_CAP} are waiting, and not before`, () => {
    const waiting = (n) => Array.from({ length: n }, (_, i) => openPr(i + 1, `[jules:docs-drift] cmd${i}`, [`docs/${i}.md`]));
    expect(triage({ pr, open: waiting(QUEUE_CAP), closed: [], now: NOW })).toMatchObject({ action: 'close', label: LABELS.queueFull });
    expect(triage({ pr, open: waiting(QUEUE_CAP - 1), closed: [], now: NOW }).action).toBe('keep');
  });

  it('does not count PRs already closed for overflow toward the queue', () => {
    const open = Array.from({ length: QUEUE_CAP }, (_, i) => openPr(i + 1, `t${i}`, [`docs/${i}.md`], [{ name: LABELS.queueFull }]));
    expect(triage({ pr, open, closed: [], now: NOW }).action).toBe('keep');
  });

  it('labels a kept PR eligible only when its files could merge without a human', () => {
    const docsPr = { number: 60, title: '[jules:docs-drift] probe — --cost undocumented', files: [modified('docs/probe.md')] };
    expect(triage({ pr: docsPr, open: [], closed: [], now: NOW })).toMatchObject({ action: 'keep', label: LABELS.eligible });
    const srcPr = { number: 61, title: '[jules:runner-scout] jest-esm — fix', files: [modified('src/probe/runners/jest.mjs'), added('test/jest-esm.test.mjs')] };
    expect(triage({ pr: srcPr, open: [], closed: [], now: NOW })).toMatchObject({ action: 'keep', label: LABELS.review });
  });
});

describe('the merge gate: what a green Jules PR may merge alone', () => {
  it.each([
    [[modified('README.md')], 'user docs'],
    [[modified('docs/guide/probe.md'), modified('CHANGELOG.md')], 'user docs'],
    [[added('test/git-hooks.test.mjs')], 'new test'],
  ])('merges %j', (files, kind) => {
    expect(mergeVerdict({ files, claims: null })).toMatchObject({ verdict: 'merge' });
    expect(mergeVerdict({ files, claims: null }).reason).toContain(kind === 'new test' ? 'new test file' : kind);
  });

  it.each([
    [[modified('AGENTS.md')], /outside/],
    [[modified('spec/GATE-SEMANTICS.md')], /outside/],
    [[modified('docs-canonical/REQUIREMENTS.md')], /outside/],
    [[modified('.jules/routines/docs-drift.md')], /outside/],
    [[modified('.github/workflows/ci.yml')], /outside/],
    [[modified('src/git.mjs')], /outside/],
    [[added('fixtures/known-answer/test/new.test.mjs')], /outside/],
    [[added('test/helpers/git.mjs')], /outside/],
    [[modified('test/worktree.test.mjs')], /existing test/],
    [[{ filename: 'docs/old.md', status: 'removed' }], /removed/],
    [[{ filename: 'docs/new.md', status: 'renamed', previous_filename: 'docs/old.md' }], /renam/],
    [[modified('CHANGELOG.md')], /bookkeeping/],
    [[], /no files/],
    [Array.from({ length: 26 }, (_, i) => modified(`docs/${i}.md`)), /limit/],
    [[added('test/a.test.mjs'), modified('testguard.claims.json')], /not compared/],
  ])('holds %j', (files, why) => {
    const v = mergeVerdict({ files, claims: null });
    expect(v.verdict).toBe('hold');
    expect(v.reason).toMatch(why);
  });
});

describe('claims: only defenders for the tests this PR adds', () => {
  const real = JSON.parse(readFileSync(join(ROOT, 'testguard.claims.json'), 'utf8'));
  const copy = () => structuredClone(real);
  const files = [added('test/new-defender.test.mjs'), modified('testguard.claims.json')];
  const verdict = (head) => mergeVerdict({ files, claims: { base: real, head } });

  it('accepts the real claims file unchanged, and a claim-level defender appended for a new test', () => {
    expect(claimsOnlyGainDefenders(real, copy(), [])).toBe(true);
    const head = copy();
    head.claims[3].defendedBy.push('test/new-defender.test.mjs');
    expect(verdict(head)).toMatchObject({ verdict: 'merge' });
  });

  it('accepts a fault-level defender list that a new test starts', () => {
    const head = copy();
    const fault = head.claims.flatMap((c) => c.faults).find((f) => !f.defendedBy);
    fault.defendedBy = ['test/new-defender.test.mjs'];
    expect(verdict(head).verdict).toBe('merge');
  });

  it('holds a defender that is not a test this PR adds', () => {
    const head = copy();
    head.claims[3].defendedBy.push('test/worktree.test.mjs');
    expect(verdict(head).verdict).toBe('hold');
  });

  it('holds a removed or reordered defender', () => {
    const removed = copy();
    removed.claims[0].defendedBy.pop();
    expect(verdict(removed).verdict).toBe('hold');
    const reordered = copy();
    reordered.claims.find((c) => c.defendedBy.length > 1).defendedBy.reverse();
    expect(verdict(reordered).verdict).toBe('hold');
  });

  it.each([
    ['a changed fault', (h) => { h.claims[0].faults[0].replace = 'something else'; }],
    ['a changed statement', (h) => { h.claims[0].statement += ' Mostly.'; }],
    ['a changed severity', (h) => { h.claims[0].severity = 'low'; }],
    ['an added fault', (h) => { h.claims[0].faults.push({ ...h.claims[0].faults[0], id: 'F99' }); }],
    ['a removed claim', (h) => { h.claims.pop(); }],
    ['an added claim', (h) => { h.claims.push({ ...h.claims[0], id: 'TG-NEW' }); }],
    ['a changed top-level field', (h) => { h.schemaVersion = 2; }],
  ])('holds %s', (_, mutate) => {
    const head = copy();
    head.claims[3].defendedBy.push('test/new-defender.test.mjs');
    mutate(head);
    expect(verdict(head).verdict).toBe('hold');
  });
});

describe('what a routine works on this week', () => {
  const candidates = ['a', 'b', 'c', 'd'];
  const pick = (open = [], closed = [], now = NOW) => pickTarget({ routine: 'runner-scout', candidates, open, closed, now });

  it('numbers ISO weeks the way the standard does at the year boundaries', () => {
    expect(isoWeek('2026-01-01T00:00:00Z')).toBe(1);
    expect(isoWeek('2021-01-03T00:00:00Z')).toBe(53);
    expect(isoWeek('2024-12-30T00:00:00Z')).toBe(1);
    expect(isoWeek(NOW)).toBe(41);
  });

  it('starts the rotation at the week and moves one target per week', () => {
    expect(pick().target).toBe(candidates[41 % 4]);
    expect(pick([], [], '2026-10-17T12:00:00Z').target).toBe(candidates[42 % 4]);
  });

  it('skips a target that is open or recently declined for the same routine, not for another', () => {
    const open = [openPr(1, tagTitle('runner-scout', 'b'))];
    const closed = [{ number: 2, title: tagTitle('runner-scout', 'c'), labels: [], mergedAt: null, closedAt: daysAgo(5) }];
    expect(pick(open, closed).target).toBe('d');
    expect(pick([openPr(1, tagTitle('docs-drift', 'b'))]).target).toBe('b');
  });

  it('stops when the queue is full, when every target is taken, and for an unknown routine', () => {
    const full = Array.from({ length: QUEUE_CAP }, (_, i) => openPr(i, `t${i}`));
    expect(pick(full)).toMatchObject({ go: false, reason: expect.stringMatching(/queue is full/) });
    expect(pick(candidates.map((c, i) => openPr(i, tagTitle('runner-scout', c))))).toMatchObject({ go: false, reason: expect.stringMatching(/every/) });
    expect(pickTarget({ routine: 'bolt', candidates, open: [], closed: [], now: NOW })).toMatchObject({ go: false });
    expect(pickTarget({ routine: 'runner-scout', candidates: [], open: [], closed: [], now: NOW })).toMatchObject({ go: false });
  });
});

describe('the target lists come from the repository, not from memory', () => {
  it('scaffold-hunt walks claimed source modules, thinnest first', () => {
    const doc = { claims: [
      { faults: [{ file: 'src/b.mjs' }, { file: 'src/b.mjs' }, { file: 'test/x.test.mjs' }] },
      { faults: [{ file: 'src/a.mjs' }, { file: 'src/c.mjs' }, { file: 'packaging/x.yml' }] },
    ] };
    expect(scaffoldTargets(doc)).toEqual(['src/a.mjs', 'src/c.mjs', 'src/b.mjs']);
    const real = scaffoldTargets(JSON.parse(readFileSync(join(ROOT, 'testguard.claims.json'), 'utf8')));
    expect(real.length).toBeGreaterThan(20);
    expect(real.every((f) => f.startsWith('src/') && f.endsWith('.mjs'))).toBe(true);
  });

  it('docs-drift walks the subcommands the real --help lists', () => {
    const help = execFileSync(process.execPath, [join(ROOT, 'cli', 'testguard.mjs'), '--help'], { encoding: 'utf8' });
    const subs = helpSubcommands(help);
    expect(subs).toEqual(expect.arrayContaining(['status', 'probe', 'gate', 'scaffold', 'replay']));
    expect(new Set(subs).size).toBe(subs.length);
  });

  it('runner-scout scenarios are unique ids', () => {
    expect(new Set(SCENARIO_IDS).size).toBe(SCENARIO_IDS.length);
    expect(SCENARIO_IDS.every((id) => /^[a-z0-9-]+$/.test(id))).toBe(true);
  });
});
