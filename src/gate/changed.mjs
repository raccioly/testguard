import { existsSync, realpathSync } from 'node:fs';
import { extname, join, relative, resolve, dirname } from 'node:path';
import { git, repoRoot, headSha, GitError } from '../git.mjs';
import { loadClaims, defaultClaimsPath } from '../claims/load.mjs';
import { readSpecDoc } from '../evidence/writer.mjs';
import { resolveDefenders } from '../probe/runner-vitest.mjs';
import { discoverDefenders } from '../probe/discover.mjs';
import { globToRegExp } from '../util/glob.mjs';

/**
 * Claim coverage of a change.
 *
 * `probe` answers "do the tests defend the claims that exist?". This answers
 * the question every field report so far turned on: "does the code I just
 * changed have any claim at all?". A repository with ten old claims and one
 * new, unclaimed feature exits 0 forever under `probe`; under `gate` the
 * delta is measured, file by file, and an uncovered file is a finding.
 *
 * The unit is the file, on purpose: a fault anchors to a file, so the file is
 * the smallest unit the rest of the contract already understands.
 */

export const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']);
const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Files that are source by extension but never carry claims. Printed by --explain. */
export const DEFAULT_EXCLUDES = Object.freeze([
  '**/*.d.ts',
  '**/*.config.*',
  '**/*.stories.*',
  '**/*.generated.*',
  '**/fixtures/**',
  '**/__fixtures__/**',
  '**/__mocks__/**',
  '**/__snapshots__/**',
  '.testguard/**',
]);

export const defaultIgnorePath = (projectDir) => join(projectDir, 'testguard.ignore.json');

/**
 * The reference the change is measured against. Explicit flag first, then the
 * environments CI sets, then nothing: a wrong default would make the gate pass
 * trivially (an upstream that already contains the change has an empty diff),
 * so no ref is an error the caller reports, never a silent guess.
 */
export function detectChangedRef(env = process.env) {
  if (env.TESTGUARD_CHANGED_REF) return { ref: env.TESTGUARD_CHANGED_REF, from: 'TESTGUARD_CHANGED_REF' };
  if (env.GITHUB_BASE_REF) return { ref: `origin/${env.GITHUB_BASE_REF}`, from: 'GITHUB_BASE_REF' };
  if (env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME) return { ref: `origin/${env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME}`, from: 'CI_MERGE_REQUEST_TARGET_BRANCH_NAME' };
  return null;
}

/**
 * Files changed since the merge-base of `ref` and HEAD, repo-root-relative,
 * deletions dropped. With `includeDirty` the working tree (tracked edits,
 * staged or not, plus untracked non-ignored files) is compared instead of HEAD.
 */
export function changedFiles({ root, ref, includeDirty = false }) {
  let base;
  try {
    base = git(['merge-base', ref, 'HEAD'], root);
  } catch (e) {
    throw new GitError(`cannot resolve --changed ${ref}: ${e.message.split('\n').pop()}. In CI, check out with full history (fetch-depth: 0) or fetch the base branch first.`);
  }
  const head = headSha(root);
  const out = new Set(git(['diff', '--name-only', '--diff-filter=d', '-z', base, ...(includeDirty ? [] : ['HEAD'])], root).split('\0').filter(Boolean));
  if (includeDirty) for (const f of git(['ls-files', '--others', '--exclude-standard', '-z'], root).split('\0').filter(Boolean)) out.add(f);
  return { base, head, files: [...out].sort() };
}

const isExpired = (entry, now) => Boolean(entry.expires) && new Date(entry.expires).getTime() <= now.getTime();

/**
 * The claim to attach to, if any: one whose fault files live in the same
 * directory as the changed file. A claim that merely shares `src/` is not
 * "nearest", it is noise, and a wrong `--claim` hint is worse than none.
 */
function nearestClaim(file, faultFiles) {
  const dir = dirname(file);
  for (const [ff, ids] of faultFiles) if (dirname(ff) === dir) return ids[0];
  return null;
}

/**
 * Compute the gate for one change. Pure apart from reading the repository,
 * the claims file and the ignore file; the caller decides what to print and
 * what to write.
 */
export function computeChangedGate({ projectDir, ref, includeDirty = false, exclude = [], strict = false, now = new Date(), toolVersion = '0.0.0', generatedAt = now.toISOString(), claimsPath, ignorePath }) {
  projectDir = realpathSync(resolve(projectDir));
  const root = repoRoot(projectDir);
  const relProject = relative(root, projectDir).split('\\').join('/');
  const { base, head, files } = changedFiles({ root, ref, includeDirty });

  // Repo-root paths → project paths; a change outside the project directory is not this project's change.
  const changed = [];
  for (const f of files) {
    if (!relProject) { changed.push(f); continue; }
    if (f.startsWith(relProject + '/')) changed.push(f.slice(relProject.length + 1));
  }

  const cPath = claimsPath ?? defaultClaimsPath(projectDir);
  const claims = existsSync(cPath) ? loadClaims(cPath) : { claims: [] };
  const iPath = ignorePath ?? defaultIgnorePath(projectDir);
  const ignore = existsSync(iPath) ? readSpecDoc('ignore', iPath) : { entries: [] };

  // Coverage index: which files carry a fault, which test files defend a claim.
  const faultFiles = new Map(); // file → claimIds
  const defenderFiles = new Map(); // test file → claimIds
  for (const c of claims.claims) {
    for (const f of c.faults) faultFiles.set(f.file, [...new Set([...(faultFiles.get(f.file) ?? []), c.id])]);
    const defenders = c.defendedBy?.length ? resolveDefenders(projectDir, c.defendedBy) : [...new Set(c.faults.flatMap((f) => discoverDefenders(projectDir, f.file)))];
    for (const d of defenders) defenderFiles.set(d, [...new Set([...(defenderFiles.get(d) ?? []), c.id])]);
  }

  const pathEntries = ignore.entries.filter((e) => e.kind === 'path').map((e) => ({ entry: e, re: globToRegExp(e.pattern), expired: isExpired(e, now), files: [] }));
  const userExcludes = exclude.map((g) => ({ glob: g, re: globToRegExp(g) }));
  const defaultExcludes = DEFAULT_EXCLUDES.map((g) => ({ glob: g, re: globToRegExp(g) }));

  const excluded = [];
  const covered = [];
  const uncovered = [];
  for (const file of changed) {
    if (!SOURCE_EXT.has(extname(file))) { excluded.push({ file, by: 'non-source' }); continue; }
    const ux = userExcludes.find((x) => x.re.test(file));
    if (ux) { excluded.push({ file, by: `exclude:${ux.glob}` }); continue; }
    const dx = defaultExcludes.find((x) => x.re.test(file));
    if (dx) { excluded.push({ file, by: `default:${dx.glob}` }); continue; }

    const isTest = TEST_RE.test(file);
    if (faultFiles.has(file)) { covered.push({ file, by: 'fault', claimIds: faultFiles.get(file) }); continue; }
    if (isTest && defenderFiles.has(file)) { covered.push({ file, by: 'defender', claimIds: defenderFiles.get(file) }); continue; }
    const active = pathEntries.find((p) => !p.expired && p.re.test(file));
    if (active) { active.files.push(file); covered.push({ file, by: 'ignore', pattern: active.entry.pattern }); continue; }
    for (const p of pathEntries) if (p.expired && p.re.test(file)) p.files.push(file);

    // Uncovered. Point at a same-directory claim so the author knows where to attach.
    const nearest = nearestClaim(file, faultFiles);
    const item = {
      file,
      kind: isTest ? 'test' : 'source',
      ...(nearest ? { nearestClaimId: nearest } : {}),
      suggestion: isTest
        ? `add ${file} to the defendedBy of the claim it defends${nearest ? ` (nearest: ${nearest})` : ''}, or state a new claim for what it asserts`
        : `testguard scaffold ${file}${nearest ? ` --claim ${nearest}` : ''}`,
    };
    uncovered.push(item);
  }

  const evaluated = covered.length + uncovered.length;
  const reliedOn = pathEntries.filter((p) => !p.expired && p.files.length).map((p) => ({ pattern: p.entry.pattern, reason: p.entry.reason, ...(p.entry.expires ? { expires: p.entry.expires } : {}), files: p.files }));
  const expired = pathEntries.filter((p) => p.expired && p.files.length).map((p) => ({ pattern: p.entry.pattern, reason: p.entry.reason, expires: p.entry.expires, files: p.files }));
  const exitCode = uncovered.length > 0 ? 1 : strict && changed.length > 0 && evaluated === 0 ? 1 : 0;

  return {
    schemaVersion: 1,
    tool: { name: 'testguard', version: toolVersion },
    generatedAt,
    ref,
    base,
    head,
    includeDirty,
    strict,
    changed: changed.length,
    evaluated,
    excluded,
    covered,
    uncovered,
    reliedOn,
    expired,
    exitCode,
  };
}

export function renderGate(doc) {
  const lines = [];
  const where = doc.includeDirty ? 'working tree' : `HEAD ${doc.head.slice(0, 7)}`;
  lines.push(`gate: ${doc.changed} file${doc.changed === 1 ? '' : 's'} changed since ${doc.ref} (merge-base ${doc.base.slice(0, 7)}) in the ${where}; ${doc.evaluated} evaluated, ${doc.excluded.length} excluded, ${doc.covered.length} covered, ${doc.uncovered.length} uncovered`);
  for (const u of doc.uncovered) lines.push(`UNCLAIMED  ${u.file}  (${u.kind}${u.nearestClaimId ? `, nearest claim ${u.nearestClaimId}` : ''})\n           → ${u.suggestion}`);
  for (const r of doc.reliedOn) lines.push(`excused    ${r.files.join(', ')}  by ignore "${r.pattern}": ${r.reason}${r.expires ? ` (expires ${r.expires})` : ''}`);
  for (const e of doc.expired) lines.push(`EXPIRED    ignore "${e.pattern}" (expired ${e.expires}) no longer excuses ${e.files.join(', ')}`);
  if (doc.changed > 0 && doc.evaluated === 0) lines.push(`note: every changed file was excluded (${[...new Set(doc.excluded.map((x) => x.by))].join(', ')}); 0 evaluated${doc.strict ? ' — --strict makes this a failure' : ''}`);
  if (doc.changed === 0) lines.push(`no changes since ${doc.ref}; nothing to claim`);
  if (doc.uncovered.length === 0 && doc.exitCode === 0 && doc.evaluated > 0) lines.push('every changed source file carries a claim or an excusing ignore entry');
  return lines.join('\n');
}
