// Convergence (#293), the pure half: when a scoped run may update the
// canonical evidence, what the merged document holds, the input predicate it
// shares with reuse, and the validator rules that keep it honest.
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineCommand } from '../src/commands/baseline.mjs';
import { convergeRequest, mergeEvidence, reuseTally, staleCarried, CARRIED, STALE_WHY } from '../src/evidence/carry.mjs';
import { inputsMatch, isReusable } from '../src/probe/attribution.mjs';
import { carryRefusal, reusableRun, runId } from '../src/probe/probe.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { recordedOriginSummary } from '../spec/lib/origins.mjs';
import { renderConverged } from '../src/commands/probe.mjs';
import { claimResults } from '../src/probe/claim-results.mjs';
import { evaluateAssertionPolicy } from '../src/probe/assertion-policy.mjs';
import { evaluateOriginPolicy } from '../src/probe/origin-policy.mjs';

// A real converged document (spec/conformance/examples/evidence-converged.json,
// taken from a probe of test/helpers/scope-project.mjs plus a third claim):
// PRICE-TOTAL measured, TAX-DOUBLES kept stale, HALF-HALVES carried. The
// documents below are rebuilt from it so every record is one a probe wrote.
const example = JSON.parse(readFileSync(new URL('../spec/conformance/examples/evidence-converged.json', import.meta.url), 'utf8'));
const sha = (c) => c.repeat(64);
const bare = (r) => { const { carried, reusedFrom, ...rest } = r; return rest; };
const asDoc = (id, records) => {
  const { scope, ...run } = example.run;
  return { ...example, run: { ...run, id, reuse: reuseTally(records) }, records, origins: recordedOriginSummary(records) };
};
const canonical = asDoc('run-old', example.records.map(bare));
const measured = asDoc(example.run.id, example.records.filter((r) => r.claim.id === 'PRICE-TOTAL').map(bare));
const ids = [...new Set(example.records.map((r) => r.claim.id))];
const claims = { schemaVersion: 1, claims: ids.map((id) => ({ id, faults: example.records.filter((r) => r.claim.id === id).map((r) => ({ id: r.subject.id })) })) };
const [A, B, C] = ids; // HALF-HALVES is C below: records keep claims-file order

describe('convergeRequest: which scoped requests may update the canonical evidence', () => {
  const base = { scoped: true, provisional: false, refExplicit: false, noReuse: false, out: undefined, canonical: '/p/.testguard/evidence.json', canonicalExists: true };
  it('converges a confirmed scoped run with canonical evidence and no --out elsewhere', () => {
    expect(convergeRequest(base)).toEqual({ converge: true });
    expect(convergeRequest({ ...base, out: base.canonical })).toEqual({ converge: true });
  });
  it.each([
    ['provisional', { provisional: true }, /provisional/],
    ['--ref', { refExplicit: true }, /--ref/],
    ['--no-reuse', { noReuse: true }, /--no-reuse/],
    ['--out elsewhere', { out: '/elsewhere.json' }, /--out/],
    ['no canonical evidence', { canonicalExists: false }, /no canonical evidence/],
  ])('refuses %s, with the reason', (_, change, reason) => {
    const r = convergeRequest({ ...base, ...change });
    expect(r.converge).toBe(false);
    expect(r.reason).toMatch(reason);
  });
  it('never applies to a full probe', () => expect(convergeRequest({ ...base, scoped: false })).toEqual({ converge: false }));
});

describe('mergeEvidence: the canonical document after a converging run', () => {
  const decisions = new Map([[`${B}/F1`, CARRIED.match], [`${B}/F2`, CARRIED.changed], [`${C}/F1`, CARRIED.match], [`${C}/F2`, CARRIED.match]]);
  const merged = mergeEvidence({ measured: { ...measured, assertionPolicy: { state: 'passed', exceptionOnlyKills: [] } }, canonical: { ...canonical, originPolicy: { state: 'passed' } }, decisions, claims, scope: { selectedClaims: [A] } });

  it('replaces the selected records with what was measured, in claims-file order', () => {
    expect(merged.records.map((r) => `${r.claim.id}/${r.subject.id}`)).toEqual([A, B, C].flatMap((c) => [`${c}/F1`, `${c}/F2`]));
    expect(merged.records[0]).toBe(measured.records[0]);
    expect(merged.records[0].carried).toBeUndefined();
  });
  it('marks every other record with the decision and the run that measured it, never changing its verdict', () => {
    expect(merged.records[2]).toMatchObject({ carried: 'inputs-match', reusedFrom: 'run-old', verdict: canonical.records[2].verdict, inputs: canonical.records[2].inputs });
    expect(merged.records[3]).toMatchObject({ carried: 'inputs-changed', reusedFrom: 'run-old', verdict: canonical.records[3].verdict });
    expect(staleCarried(merged)).toEqual([`${B}/F2`]);
  });
  it('keeps the run that first measured a record that was itself carried', () => {
    const twice = mergeEvidence({ measured, canonical: { ...canonical, records: canonical.records.map((r) => ({ ...r, reusedFrom: 'run-first' })) }, decisions, claims, scope: { selectedClaims: [A] } });
    expect(twice.records[2].reusedFrom).toBe('run-first');
  });
  it('drops a fault with no decision or no earlier record, and every policy evaluated over other records', () => {
    const partial = mergeEvidence({ measured, canonical, decisions: new Map([[`${B}/F1`, CARRIED.match]]), claims, scope: { selectedClaims: [A] } });
    expect(partial.records.map((r) => `${r.claim.id}/${r.subject.id}`)).toEqual([`${A}/F1`, `${A}/F2`, `${B}/F1`]);
    expect(merged.originPolicy).toBeUndefined();
    expect(merged.assertionPolicy).toBeUndefined();
  });
  it('counts what it carried and names the run it carried from; the document conforms', () => {
    expect(merged.run.reuse).toEqual({ measured: 2, reused: 3, stale: 1 });
    expect(merged.run.scope).toEqual({ selectedClaims: [A], carriedFrom: 'run-old' });
    expect(validate('evidence', merged).errors).toEqual([]);
  });
  it('renders the evidence line with what no defender ran for', () => {
    const line = renderConverged({ outPath: '.testguard/evidence.json', measured: 2, selection: '1 probed', converged: { from: 'run-old', carried: 3, stale: ['A/F2'] } });
    expect(line).toMatch(/converged: 2 measured.*3 carried from run-old.*not re-checked.*1 kept unchanged.*A\/F2/);
  });
});

describe('the validator keeps a converged document honest', () => {
  const decisions = new Map([[`${B}/F1`, CARRIED.match], [`${B}/F2`, CARRIED.match], [`${C}/F1`, CARRIED.match], [`${C}/F2`, CARRIED.match]]);
  const good = () => structuredClone(mergeEvidence({ measured, canonical, decisions, claims, scope: { selectedClaims: [A] } }));
  const errorsOf = (d) => validate('evidence', d).errors.map((e) => e.message).join('\n');
  it('accepts the merged document', () => expect(validate('evidence', good()).errors).toEqual([]));
  it('refuses a carried record without the run that measured it', () => {
    const d = good(); delete d.records[2].reusedFrom; d.run.reuse = reuseTally(d.records);
    expect(errorsOf(d)).toMatch(/carried record names the run that measured it/);
  });
  it('refuses a carried record of a selected claim, and an unmarked record of an unselected one', () => {
    const d = good(); d.records[0].carried = 'inputs-match'; d.records[0].reusedFrom = 'run-old'; delete d.records[2].carried; d.run.reuse = reuseTally(d.records);
    expect(errorsOf(d)).toMatch(new RegExp(`${A} was selected`));
    expect(errorsOf(d)).toMatch(new RegExp(`${B} was not selected`));
  });
  it('refuses carried records with no scope, a provisional scope, and counts that disagree', () => {
    const noScope = good(); delete noScope.run.scope;
    expect(errorsOf(noScope)).toMatch(/names the scope that converged it/);
    const provisional = good(); provisional.run.confirmRuns = 1; provisional.run.provisional = true;
    expect(errorsOf(provisional)).toMatch(/provisional run never converges/);
    const counts = good(); counts.run.reuse.stale = 2;
    expect(errorsOf(counts)).toMatch(/run\.reuse must count the records: 4 reused, 2 measured, 0 stale/);
  });
});

describe('carrying shares the input half of the reuse rule', () => {
  const current = (r) => ({ claim: r.claim, inputs: r.inputs, requested: r.defenders.requested, resolved: r.defenders.resolved, selectionSource: r.defenders.selectionSource, contentHash: r.subject.contentHash });
  it('carries a pessimistic verdict reuse would re-measure, and never a record whose inputs changed', () => {
    const timeout = { ...canonical.records[0], verdict: 'timeout' };
    expect(isReusable(timeout, current(timeout))).toBe(false);
    expect(inputsMatch(timeout, current(timeout))).toBe(true);
    const killed = canonical.records[0];
    expect(inputsMatch(killed, current(killed))).toBe(true);
    for (const change of [
      (c) => { c.inputs = { ...c.inputs, targetHash: sha('f') }; },
      (c) => { c.inputs = { ...c.inputs, dependencyHashes: Object.fromEntries(Object.keys(c.inputs.dependencyHashes).map((k) => [k, sha('f')])) }; },
      (c) => { c.inputs = { ...c.inputs, testUniverseHash: sha('f') }; },
      (c) => { c.contentHash = sha('f'); },
      (c) => { c.claim = { ...c.claim, statement: 'Something else.' }; },
      (c) => { c.resolved = []; },
    ]) {
      const c = current(killed);
      change(c);
      expect(inputsMatch(killed, c)).toBe(false);
      expect(isReusable(killed, c)).toBe(false);
    }
  });
});

describe('carryRefusal is the run-level reuse rule, with a reason', () => {
  const policy = { confirmRuns: 3, workers: 1, serial: true, runner: example.run.runner, instrument: example.run.instrument, typecheck: undefined, faultWorkers: example.run.faultWorkers };
  it.each([
    ['nothing', (d) => d, (p) => p, null],
    ['a tool-version change', (d) => d, (p) => ({ ...p, instrument: { ...p.instrument, toolVersion: '99.0.0' } }), /and this is 99\.0\.0/],
    ['a configuration change', (d) => d, (p) => ({ ...p, instrument: { ...p.instrument, digest: sha('9') } }), /configuration changed/],
    ['another N', (d) => d, (p) => ({ ...p, confirmRuns: 5 }), /--confirm 3, this run with --confirm 5/],
    ['another worker policy', (d) => d, (p) => ({ ...p, workers: 4, serial: false }), /worker/],
    ['another runner', (d) => d, (p) => ({ ...p, runner: { ...p.runner, version: '0.0.1' } }), /another test runner/],
    ['another type-checked program', (d) => { d.run.typecheck = { commandHash: sha('1'), version: '5.0.0', programDigest: sha('2') }; return d; }, (p) => ({ ...p, typecheck: { commandHash: sha('1'), version: '5.0.0', programDigest: sha('3') } }), /type-checked program changed/],
  ])('%s', (_, docChange, policyChange, reason) => {
    const d = docChange(structuredClone(canonical));
    const p = policyChange(policy);
    const refusal = carryRefusal(d, p);
    expect(refusal === undefined).toBe(reusableRun(d, p));
    if (reason) expect(refusal).toMatch(reason);
    else expect(refusal).toBeUndefined();
  });
});

describe('baseline and a converged document', () => {
  const withEvidence = (doc) => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-converge-baseline-'));
    mkdirSync(join(dir, '.testguard'));
    writeFileSync(join(dir, '.testguard', 'evidence.json'), JSON.stringify(doc));
    return dir;
  };
  const run = async (dir) => {
    const out = []; const err = [];
    const code = await baselineCommand({ projectDir: dir, values: {}, version: example.tool.version }, { out: (s) => out.push(s), err: (s) => err.push(s) });
    rmSync(dir, { recursive: true, force: true });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  it('refuses a document that keeps records with changed inputs, naming them', async () => {
    const r = await run(withEvidence(example));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/keeps 2 records whose inputs changed.*TAX-DOUBLES\/F1, TAX-DOUBLES\/F2/);
  });
  it('freezes one whose other records were all carried, and says how many', async () => {
    const decisions = new Map(example.records.filter((r) => r.carried).map((r) => [`${r.claim.id}/${r.subject.id}`, CARRIED.match]));
    const fresh = mergeEvidence({ measured, canonical, decisions, claims, scope: { selectedClaims: [A] } });
    const r = await run(withEvidence(fresh));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/4 of the 6 records were carried from run-old/);
  });
});

describe('run ids', () => {
  it('differ for two runs that start in the same second, so a carried-from id and the lost-update check never collide', () => {
    expect(runId('2026-11-12T15:36:12.123Z')).toBe('run-20261112T153612123');
    expect(runId('2026-11-12T15:36:12.123Z')).not.toBe(runId('2026-11-12T15:36:12.456Z'));
  });
});

describe('status names every record a converging probe kept stale', () => {
  it('whatever its own hashing says, so status and baseline agree', async () => {
    const { project: scopeProject, claimsDoc } = await import('./helpers/scope-project.mjs');
    const { computeStatus } = await import('../src/status/status.mjs');
    const claimsFile = claimsDoc();
    const half = structuredClone(claimsFile.claims[1]);
    half.id = 'HALF-HALVES'; half.defendedBy = ['test/half.test.mjs'];
    half.faults = half.faults.map((f) => ({ ...f, file: 'src/half.mjs' }));
    half.faults[0].find = 'n / 2'; half.faults[0].replace = 'n / 3';
    half.faults[1].find = '=> n'; half.faults[1].replace = '=> 0 * n';
    claimsFile.claims.push(half);
    const p = scopeProject({ claims: claimsFile, files: { 'src/half.mjs': 'export const half = (n) => n / 2;\n', 'test/half.test.mjs': "import { test } from 'node:test';\nimport { half } from '../src/half.mjs';\ntest('half', () => half(4));\n" } });
    try {
      mkdirSync(join(p.dir, '.testguard'));
      writeFileSync(join(p.dir, '.testguard', 'evidence.json'), JSON.stringify(example));
      const status = computeStatus({ projectDir: p.dir, toolVersion: example.tool.version, advice: false });
      expect(status.stale.filter((s) => /kept stale by a scoped probe/.test(s))).toEqual(['F1', 'F2'].map((f) => `TAX-DOUBLES/${f} was kept stale by a scoped probe: ${STALE_WHY}`));
      expect(STALE_WHY).toMatch(/before that change's base or in an input the selection does not follow/);
      expect(status.state).toBe('evidence-stale');
    } finally { rmSync(p.root, { recursive: true, force: true }); }
  });
});

describe('a record kept stale is never current (#293)', () => {
  const decisions = new Map([[`${B}/F1`, CARRIED.changed], [`${B}/F2`, CARRIED.match], [`${C}/F1`, CARRIED.match], [`${C}/F2`, CARRIED.match]]);
  const merged = mergeEvidence({ measured, canonical, decisions, claims, scope: { selectedClaims: [A] } });
  it('is not reuse: measured + reused + stale add up to the records', () => {
    expect(merged.run.reuse).toEqual({ measured: 2, reused: 3, stale: 1 });
    const wrong = structuredClone(merged); wrong.run.reuse = { measured: 2, reused: 4 };
    expect(validate('evidence', wrong).errors.map((e) => e.message).join('\n')).toMatch(/3 reused, 2 measured, 1 stale/);
  });
  it('reads could-not-verify / inputs-changed in claim results, whatever verdict it carries', () => {
    const [result] = claimResults(merged.records.filter((r) => r.claim.id === B));
    expect(result.result).toBe('could-not-verify');
    expect(result.reasons).toEqual([{ faultId: 'F1', verdict: 'unverifiable', reason: 'inputs-changed' }]);
  });
  it('makes the assertion policy unavailable, never passed, and the document still conforms', () => {
    const policy = evaluateAssertionPolicy(merged.records);
    expect(policy).toEqual({ state: 'unavailable', exceptionOnlyKills: [], staleRecords: [{ claimId: B, faultId: 'F1' }] });
    expect(validate('evidence', { ...merged, assertionPolicy: policy }).errors).toEqual([]);
    expect(validate('evidence', { ...merged, assertionPolicy: { state: 'passed', exceptionOnlyKills: [] } }).errors.map((e) => e.path)).toContain('/assertionPolicy/state');
    expect(evaluateAssertionPolicy(merged.records.filter((r) => !r.carried || r.carried === 'inputs-match')).state).toBe('passed');
  });
  it('makes the origin policy unavailable', () => {
    const claimsFile = { schemaVersion: 1, claims: [] };
    const result = evaluateOriginPolicy({ claims: claimsFile, evidence: merged, eligibleKinds: ['spec'], fresh: true });
    expect(result.unavailableReasons).toContain('stale-inputs');
  });
});

describe('a reuse source this TestGuard cannot read (#301)', () => {
  it('is skipped with a warning, never a refusal', async () => {
    const { readReuseSources } = await import('../src/commands/probe.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'tg-reuse-source-'));
    try {
      const old = structuredClone(example);
      old.run.faultWorkers = 2;
      for (const r of old.records) for (const run of r.detail.probeRuns ?? []) delete run.alone;
      writeFileSync(join(dir, 'old.json'), JSON.stringify(old));
      writeFileSync(join(dir, 'good.json'), JSON.stringify(example));
      const warnings = [];
      const docs = readReuseSources([join(dir, 'old.json'), join(dir, 'good.json')], (w) => warnings.push(w));
      expect(docs).toHaveLength(1);
      expect(docs[0].run.id).toBe(example.run.id);
      expect(warnings).toEqual([expect.stringMatching(/old\.json cannot be read as evidence by this TestGuard .*measured alone.*measured again/)]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('a converging run judges its selection; the document judges itself (#293 review A)', () => {
  it('exits on the measured records, keeps the whole document unavailable, and counts what it did not judge', async () => {
    const { scopedAssertionPolicy } = await import('../src/probe/assertion-policy.mjs');
    const decisions = new Map([[`${B}/F1`, CARRIED.changed], [`${B}/F2`, CARRIED.changed], [`${C}/F1`, CARRIED.match], [`${C}/F2`, CARRIED.match]]);
    const merged = mergeEvidence({ measured, canonical, decisions, claims, scope: { selectedClaims: [A] } });
    const r = scopedAssertionPolicy({ measured: measured.records, written: merged.records, converged: true });
    expect(r.run).toEqual({ state: 'passed', exceptionOnlyKills: [] });
    expect(r.document.state).toBe('unavailable');
    expect(r.unjudged).toBe(2);
    // A run that did not converge judges what it wrote, which is what it measured.
    expect(scopedAssertionPolicy({ measured: measured.records, written: measured.records, converged: false })).toMatchObject({ unjudged: 0, run: { state: 'passed' } });
  });
});
