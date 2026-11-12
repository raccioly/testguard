#!/usr/bin/env node
/**
 * One full self-probe per release, proved by an artifact keyed by the tree.
 *
 * The release pull request's CI probes the bumped tree in full and, when the
 * probe is clean, uploads `release-evidence-<git tree hash>`. `release.yml`
 * must not probe again; it must prove that this artifact describes the tree
 * it is about to tag, and fail closed when it cannot.
 *
 * The tree hash, not the commit, is the key: a squash merge onto an unmoved
 * `main` produces the pull request's tree exactly, with a different commit.
 * When `main` moved, the tree differs and the release refuses, correctly:
 * that tree was never probed.
 *
 *   write  --evidence <file> --out-dir <dir> [--claims <file>]
 *            CI side. Checks the evidence is a clean full probe of HEAD and writes
 *            <dir>/evidence.json and <dir>/manifest.json (the upload payload).
 *   verify --tree <hash> [--version <v>] [--claims <file>] (--from-dir <dir> | --repo <owner/name>)
 *            Release side. --from-dir checks a downloaded artifact offline (the dry run);
 *            --repo finds it through the Actions API and downloads it.
 *   name   --tree <hash>        print the artifact name
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const ARTIFACT_PREFIX = 'release-evidence-';
export const MANIFEST_KIND = 'testguard-release-evidence';
export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
export const RELEASE_BRANCH = /^release\/v\d+\.\d+\.\d+$/;
const TREE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function artifactName(tree) {
  if (!TREE.test(tree ?? '')) throw new Error(`not a git tree hash: ${JSON.stringify(tree)}`);
  return ARTIFACT_PREFIX + tree;
}

/** Every `claim/fault` pair a claims document declares. */
export function expectedFaults(claimsDoc) {
  const keys = [];
  for (const claim of claimsDoc.claims ?? []) for (const fault of claim.faults ?? []) keys.push(`${claim.id}/${fault.id}`);
  return keys;
}

/**
 * What makes evidence good enough to ship on: a complete probe of THIS tree's
 * claims in which every fault was killed. Returns the problems; none means ok.
 */
export function evaluateEvidence({ manifest, evidence, tree, version, claimsDoc }) {
  const problems = [];
  if (manifest?.kind !== MANIFEST_KIND || manifest.schema !== 1) problems.push('manifest.json is not a release-evidence manifest (kind/schema)');
  if (manifest?.tree !== tree) problems.push(`manifest is for tree ${manifest?.tree}, this release is tree ${tree}`);
  if (version !== undefined && manifest?.version !== version) problems.push(`manifest is for version ${manifest?.version}, this release is ${version}`);
  const records = evidence?.records;
  if (!Array.isArray(records) || records.length === 0) {
    problems.push('evidence has no records');
    return problems;
  }
  if (evidence.run?.provisional === true) problems.push('evidence is provisional (fewer than three confirm runs)');
  if (evidence.run?.budget?.exhausted === true) problems.push('the probe ran out of its command budget; the evidence is incomplete');
  if (manifest?.commit && evidence.run?.repo?.head && manifest.commit !== evidence.run.repo.head) problems.push(`manifest commit ${manifest.commit} is not the commit the evidence probed (${evidence.run.repo.head})`);
  const reused = records.filter((r) => r.reusedFrom !== undefined);
  if (reused.length) problems.push(`${reused.length} record(s) carry a verdict reused from an earlier probe, first: ${reused[0].claim?.id}/${reused[0].subject?.id}; the release's probe must measure this tree`);
  const notKilled = records.filter((r) => r.verdict !== 'killed');
  if (notKilled.length) problems.push(`${notKilled.length} fault(s) not killed, first: ${notKilled[0].claim?.id}/${notKilled[0].subject?.id} (${notKilled[0].verdict})`);
  const have = new Set(records.map((r) => `${r.claim?.id}/${r.subject?.id}`));
  const want = new Set(expectedFaults(claimsDoc));
  const missing = [...want].filter((k) => !have.has(k));
  const extra = [...have].filter((k) => !want.has(k));
  if (missing.length) problems.push(`evidence does not cover ${missing.length} fault(s) this tree's claims declare, first: ${missing[0]} (a scoped or older probe is not a full one)`);
  if (extra.length) problems.push(`evidence has ${extra.length} fault(s) this tree's claims do not declare, first: ${extra[0]}`);
  return problems;
}

/**
 * Choose the artifact from an Actions API listing: not expired, from a run of
 * ci.yml on a release branch of THIS repository. Newest wins. Anything else is
 * a reason, never a silent skip.
 */
export function pickArtifact(listing, { name, runs }) {
  const reasons = [];
  const usable = [];
  for (const a of listing?.artifacts ?? []) {
    if (a.name !== name) continue;
    const run = a.workflow_run ?? {};
    if (a.expired) { reasons.push(`artifact ${a.id} has expired`); continue; }
    if (!RELEASE_BRANCH.test(run.head_branch ?? '')) { reasons.push(`artifact ${a.id} came from branch ${run.head_branch}, not a release branch`); continue; }
    if (run.head_repository_id === undefined || run.head_repository_id !== run.repository_id) { reasons.push(`artifact ${a.id} came from another repository`); continue; }
    if (runs?.[run.id]?.path !== CI_WORKFLOW_PATH) { reasons.push(`artifact ${a.id} was not produced by ${CI_WORKFLOW_PATH}`); continue; }
    usable.push(a);
  }
  usable.sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at));
  return { artifact: usable[0], reasons };
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Verify a downloaded artifact directory against the tree. Returns the problems. */
export function verifyDirectory({ dir, tree, version, claimsPath }) {
  let manifest;
  let evidence;
  try {
    manifest = readJson(join(dir, 'manifest.json'));
    evidence = readJson(join(dir, 'evidence.json'));
  } catch (error) {
    return [`the artifact is unreadable: ${error.message}`];
  }
  return evaluateEvidence({ manifest, evidence, tree, version, claimsDoc: readJson(claimsPath) });
}

/** The real GitHub side. Tests replace it. */
export function ghIo() {
  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    listArtifacts: (repo, name) => JSON.parse(gh(['api', `repos/${repo}/actions/artifacts?name=${name}&per_page=100`])),
    run: (repo, id) => JSON.parse(gh(['api', `repos/${repo}/actions/runs/${id}`])),
    download(repo, id, dir) {
      const zip = join(dir, 'artifact.zip');
      writeFileSync(zip, execFileSync('gh', ['api', `repos/${repo}/actions/artifacts/${id}/zip`], { maxBuffer: 512 * 1024 * 1024 }));
      execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
    },
  };
}

/** Find, download and verify. Returns `{ ok, problems, artifact }`. */
export function verifyFromGitHub({ repo, tree, version, claimsPath, io = ghIo(), workDir }) {
  const name = artifactName(tree);
  let listing;
  try {
    listing = io.listArtifacts(repo, name);
  } catch (error) {
    return { ok: false, problems: [`could not list artifacts for ${name}: ${error.message}`] };
  }
  const runs = {};
  for (const a of listing.artifacts ?? []) {
    const id = a.workflow_run?.id;
    if (a.name === name && id !== undefined && !(id in runs)) {
      try { runs[id] = io.run(repo, id); } catch (error) { runs[id] = { error: error.message }; }
    }
  }
  const { artifact, reasons } = pickArtifact(listing, { name, runs });
  if (!artifact) return { ok: false, problems: [`no usable artifact named ${name}${reasons.length ? ` (${reasons.join('; ')})` : ': the release pull request never produced a full clean probe of this tree'}`] };
  const dir = workDir ?? mkdtempSync(join(tmpdir(), 'tg-release-evidence-'));
  try {
    io.download(repo, artifact.id, dir);
  } catch (error) {
    return { ok: false, problems: [`could not download artifact ${artifact.id}: ${error.message}`] };
  }
  const problems = verifyDirectory({ dir, tree, version, claimsPath });
  return { ok: problems.length === 0, problems, artifact };
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function writeSide({ evidencePath, outDir, claimsPath }) {
  const tree = git('rev-parse', 'HEAD^{tree}');
  const commit = git('rev-parse', 'HEAD');
  const evidence = readJson(evidencePath);
  const version = readJson('package.json').version;
  const manifest = { schema: 1, kind: MANIFEST_KIND, tree, commit, version, faults: evidence.records?.length ?? 0, ciRun: process.env.GITHUB_RUN_ID ?? null };
  const problems = evaluateEvidence({ manifest, evidence, tree, version, claimsDoc: readJson(claimsPath) });
  if (problems.length) return { ok: false, problems };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'evidence.json'), JSON.stringify(evidence));
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { ok: true, problems: [], name: artifactName(tree), manifest };
}

export async function main(argv, { io = ghIo() } = {}) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      evidence: { type: 'string' }, 'out-dir': { type: 'string' }, claims: { type: 'string', default: 'testguard.claims.json' },
      tree: { type: 'string' }, 'miss-is-notice': { type: 'boolean' }, version: { type: 'string' }, 'from-dir': { type: 'string' }, repo: { type: 'string' },
    },
  });
  const fail = (lines) => {
    if (values['miss-is-notice']) {
      for (const line of lines) console.log(`::notice::no usable release evidence yet: ${line}`);
      return 1;
    }
    for (const line of lines) console.error(`::error::release evidence: ${line}`);
    console.error('The release will not ship a tree no full probe vouched for. Re-run the release pull request\'s ci.yml (a full probe on the release branch) or, for recovery only, dispatch release.yml with reprobe=true.');
    return 1;
  };
  if (command === 'name') {
    console.log(artifactName(values.tree));
    return 0;
  }
  if (command === 'write') {
    if (!values.evidence || !values['out-dir']) { console.error('usage: release-evidence.mjs write --evidence <file> --out-dir <dir>'); return 2; }
    const result = writeSide({ evidencePath: resolve(values.evidence), outDir: resolve(values['out-dir']), claimsPath: resolve(values.claims) });
    if (!result.ok) {
      for (const p of result.problems) console.error(`::error::release evidence not written: ${p}`);
      return 1;
    }
    console.log(`release evidence written for tree ${result.manifest.tree} (${result.manifest.faults} faults) as ${result.name}`);
    return 0;
  }
  if (command === 'verify') {
    if (!values.tree || (!values['from-dir'] && !values.repo)) { console.error('usage: release-evidence.mjs verify --tree <hash> [--version <v>] (--from-dir <dir> | --repo <owner/name>)'); return 2; }
    const name = artifactName(values.tree);
    const claimsPath = resolve(values.claims);
    if (values['from-dir']) {
      const problems = verifyDirectory({ dir: resolve(values['from-dir']), tree: values.tree, version: values.version, claimsPath });
      if (problems.length) return fail(problems);
      console.log(`release evidence OK (offline): ${name} describes this tree`);
      return 0;
    }
    const result = verifyFromGitHub({ repo: values.repo, tree: values.tree, version: values.version, claimsPath, io });
    if (!result.ok) return fail(result.problems);
    console.log(`release evidence OK: ${name} (artifact ${result.artifact.id}, run ${result.artifact.workflow_run.id}) describes this tree; no second probe.`);
    return 0;
  }
  console.error('usage: release-evidence.mjs write|verify|name ...');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main(process.argv.slice(2)));
