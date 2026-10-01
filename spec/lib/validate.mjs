import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fingerprint } from './fingerprint.mjs';
import { reproduces, decimals, MAX_PLACES } from './wilson.mjs';
import { isDeepStrictEqual } from 'node:util';
import { recordedOriginSummary } from './origins.mjs';
import { authoringInputErrors } from './authoring-input.mjs';

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

export const KINDS = Object.freeze(['claims', 'evidence', 'baseline', 'ignore', 'calibration', 'brief', 'status', 'gate', 'replay', 'sweep', 'concerns', 'annotations', 'authoring-input']);
/**
 * How a document says it tried to falsify its claims. Absent means
 * `fault-injection`, so every document written before the field existed is
 * held to exactly the rules it was written against.
 */
export const methodOf = (x) => x?.method ?? 'fault-injection';
const isInjection = (x) => methodOf(x) === 'fault-injection';
export const PASSING_VERDICTS = Object.freeze(new Set(['killed']));

const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const f of readdirSync(schemaDir).filter((n) => n.endsWith('.schema.json'))) {
  ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, f), 'utf8')));
}

const schemaFor = (kind) => {
  const v = ajv.getSchema(`urn:claimspec:v1:${kind}`);
  if (!v) throw new RangeError(`unknown Guard-spec kind: ${kind}`);
  return v;
};

const nestedErrors = (nested = [], prefix = '/nested', occupied = []) => {
  const errors = [];
  const projects = new Set();
  const files = new Set(occupied);
  for (const [i, entry] of nested.entries()) {
    const p = `${prefix}/${i}`;
    if (entry.project.split('/').some((part) => !part || part === '.' || part === '..') || entry.project.includes('\\')) errors.push({ path: `${p}/project`, message: 'nested project must be a canonical descendant directory' });
    if (projects.has(entry.project)) errors.push({ path: `${p}/project`, message: 'nested project is duplicated' });
    projects.add(entry.project);
    for (const file of entry.files) {
      if (!file.startsWith(`${entry.project}/`) || file.split('/').some((part) => !part || part === '.' || part === '..') || file.includes('\\')) errors.push({ path: `${p}/files`, message: 'nested file must remain beneath its canonical project directory' });
      if (files.has(file)) errors.push({ path: `${p}/files`, message: 'nested file is counted in more than one bucket' });
      files.add(file);
    }
  }
  return errors;
};

// A projected summary is not source authority. Only evidence retains the
// complete claim projections needed to reproduce each kind and mixed count.
function originPolicyErrors(kind, doc) {
  const errors = [];
  const policies = [[doc.originPolicy, '/originPolicy'], [kind === 'status' ? doc.run?.originPolicy : undefined, '/run/originPolicy']];
  const identities = (rows) => rows.map((r) => JSON.stringify([r.claimId, r.faultId])).sort();
  for (const [p, path] of policies) {
    if (!p) continue;
    const fail = (message) => errors.push({ path, message });
    for (const field of ['eligibleKinds', 'ineligibleClaims', 'unavailableReasons']) {
      if (!isDeepStrictEqual(p[field], [...p[field]].sort())) fail(`${field} must be normalized in sorted order`);
    }
    const failures = p.ineligibleClaims.length + p.nonKilledFaults.length;
    const expectedState = p.unavailableReasons.length ? 'unavailable' : failures ? 'failed' : 'passed';
    if (p.state !== expectedState) fail('policy state must match refusal reasons and unsuppressed failures');
    if (p.state !== 'unavailable' && (!p.claims || !p.faults)) fail('an evaluated policy requires a nonempty claim and fault universe');
    if (p.ineligibleClaims.length > p.claims) fail('ineligible claims exceed the current claim denominator');
    if (p.state !== 'unavailable' && p.nonKilledFaults.length > p.faults) fail('non-killed faults exceed the complete fault denominator');
    if (kind === 'evidence') {
      const actual = [...new Set(doc.records.filter((r) => r.verdict !== 'killed').map((r) => JSON.stringify([r.claim.id, r.subject.id])))].sort();
      if (!isDeepStrictEqual(identities(p.nonKilledFaults), actual)) fail('policy must retain every actual non-killed fault identity');
      if (p.state !== 'unavailable') {
        const claims = new Set(doc.records.map((r) => r.claim.id));
        const faults = new Set(doc.records.map((r) => JSON.stringify([r.claim.id, r.subject.id])));
        if (p.claims !== claims.size || p.faults !== faults.size || faults.size !== doc.records.length) fail('evaluated policy denominators require complete unique recorded identities');
        const ineligible = [...new Set(doc.records.filter((r) => !p.eligibleKinds.includes(r.claim.source.kind)).map((r) => r.claim.id))].sort();
        if (!isDeepStrictEqual(p.ineligibleClaims, ineligible)) fail('policy eligibility must match recorded declarations');
        if (!isInjection(doc.run) || doc.run.provisional || doc.run.confirmRuns < 3) fail('evaluated policy requires confirmed fault-injection evidence');
        if (recordedOriginSummary(doc.records).claims.mixed) fail('evaluated policy cannot use mixed recorded origins');
      }
    }
    if (kind === 'status' && (p.claims !== doc.counts.claims || p.faults !== doc.counts.faults)) fail('policy denominators must match current status claims and faults');
    if (kind === 'brief' && p.state !== 'unavailable' && (p.claims !== doc.summary.claims || p.faults !== Object.values(doc.summary.byVerdict).reduce((a, b) => a + b, 0))) fail('recorded policy denominators must match the uncapped brief summary');
  }
  if (kind === 'status' && doc.run) {
    const p = doc.run.originPolicy;
    const expected = p?.state === 'unavailable' ? 2 : p?.state === 'failed' || doc.run.newSinceBaseline > 0 ? 1 : 0;
    if (p && doc.run.exitCode !== expected) errors.push({ path: '/run/exitCode', message: 'exit code must preserve policy refusal/failure before baseline findings' });
    if (!p && doc.run.exitCode === 2) errors.push({ path: '/run/exitCode', message: 'completed probe exit 2 requires an unavailable origin policy' });
    if (p && (doc.run.scope || doc.run.provisional)) errors.push({ path: '/run/originPolicy', message: 'origin policy cannot certify a partial or provisional invocation' });
  }
  return errors;
}

function originErrors(kind, doc) {
  if (!doc.origins) return [];
  const errors = [], o = doc.origins;
  const fail = (message) => errors.push({ path: '/origins', message });
  const sum = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);
  if (sum(o.claims.byKind) + o.claims.mixed !== o.claims.total) fail('claim origin buckets plus mixed must equal the distinct claim total');
  if (o.records && sum(o.records.byKind) !== o.records.total) fail('record origin buckets must equal the record total');
  if (kind === 'status') {
    if (o.basis !== 'declared' || o.records || o.claims.mixed !== 0) fail('status origins must describe unmixed current declarations without recorded counts');
    if (o.claims.total !== doc.counts.claims) fail('declared origin total must equal current claim count');
  } else {
    if (o.basis !== 'recorded' || !o.records) fail('evidence and brief origins require recorded basis and record counts');
    if (kind === 'evidence' && !isDeepStrictEqual(o, recordedOriginSummary(doc.records))) fail('recorded origins must reproduce every actual record and distinct claim declaration');
    if (kind === 'brief' && (o.claims.total !== doc.summary.claims || o.records?.total !== sum(doc.summary.byVerdict))) fail('brief origin totals must match the complete summary, not capped items');
  }
  return errors;
}

// Rules JSON Schema cannot express. Each returns an array of {path, message}.
const semantic = {
  'authoring-input': authoringInputErrors,
  annotations(doc) {
    const errors = [];
    const fail = (path, message) => errors.push({ path, message });
    const selected = new Set(doc.selected), seenFiles = new Set(), seenIds = new Set();
    for (const [bucket, entries] of [['targets', doc.targets], ['refused', doc.refused]]) {
      for (const [i, entry] of entries.entries()) {
        if (seenFiles.has(entry.file)) fail(`/${bucket}/${i}/file`, 'target must occur in exactly one admission bucket');
        if (bucket === 'targets' && (entry.file.includes('\\') || /^[A-Za-z]:/.test(entry.file) || entry.file.split('/').some((part) => !part || part === '.' || part === '..'))) fail(`/${bucket}/${i}/file`, 'admitted target must be a canonical relative path');
        seenFiles.add(entry.file);
        for (const id of entry.claimIds) {
          if (!selected.has(id)) fail(`/${bucket}/${i}/claimIds`, 'target claim must be selected');
          seenIds.add(id);
        }
      }
    }
    if (doc.selected.some((id) => !seenIds.has(id))) fail('/selected', 'every selected claim must have a target or explicit refusal');
    if (doc.mode === 'preview') {
      if (doc.outcome) fail('/outcome', 'preview never has a write outcome');
      if (doc.state !== (doc.refused.length ? 'refused' : 'preview')) fail('/state', 'preview state must reflect all admission refusals');
      return errors;
    }
    if (!doc.outcome) { fail('/outcome', 'apply requires a write outcome'); return errors; }
    if (doc.refused.length && doc.state !== 'refused') fail('/state', 'any admission refusal blocks all writes');
    const o = doc.outcome;
    const adds = doc.targets.filter((t) => t.action === 'add').map((t) => t.file);
    const unchanged = doc.targets.filter((t) => t.action === 'unchanged').map((t) => t.file);
    const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
    if (o.touched.some((file) => !adds.includes(file))) fail('/outcome/touched', 'only admitted add targets can be touched');
    if (o.changed.some((file) => !o.touched.includes(file))) fail('/outcome/changed', 'verified changes must be touched');
    if (!same(o.unchanged, unchanged)) fail('/outcome/unchanged', 'unchanged files must match unchanged targets');
    for (const [i, failure] of o.failed.entries()) {
      if (failure.file !== null && !doc.targets.some((t) => t.file === failure.file)) fail(`/outcome/failed/${i}/file`, 'failed file must be an admitted target or null');
    }
    if (doc.state === 'applied') {
      if (doc.refused.length || o.failed.length || !same(o.changed, adds) || !same(o.touched, adds) || !o.recoveryDir || o.lockRelease?.released !== true) fail('/state', 'applied requires every admitted target verified, no refusals/failures, recovery and released owned lock');
    } else if (doc.state === 'refused') {
      if (o.touched.length || o.changed.length || (!doc.refused.length && !o.failed.length)) fail('/state', 'refused requires no touched files and an explicit refusal/failure');
    } else if (doc.state === 'partial') {
      if (!o.touched.length || !o.failed.length || !o.recoveryDir) fail('/state', 'partial requires touched files, explicit failure and retained recovery');
    } else fail('/state', 'apply cannot be a preview');
    return errors;
  },
  claims(doc) {
    const errors = [];
    const seenClaim = new Set();
    doc.claims.forEach((c, ci) => {
      if (seenClaim.has(c.id)) errors.push({ path: `/claims/${ci}/id`, message: `duplicate claim id "${c.id}"` });
      seenClaim.add(c.id);
      const seenFault = new Set();
      c.faults.forEach((f, fi) => {
        const p = `/claims/${ci}/faults/${fi}`;
        if (seenFault.has(f.id)) errors.push({ path: `${p}/id`, message: `duplicate fault id "${f.id}" in claim "${c.id}"` });
        seenFault.add(f.id);
        // Anchor arithmetic is a property of fault injection. A probe that does
        // not substitute text has no `find` to compare, and `undefined ===
        // undefined` would report every one of them as a no-op.
        if (isInjection(f)) {
          const occ = f.occurrence ?? 1;
          const hits = f.expectHits ?? 1;
          if (occ > hits) errors.push({ path: `${p}/occurrence`, message: `occurrence ${occ} exceeds expectHits ${hits}` });
          if (f.find === f.replace) errors.push({ path: `${p}/replace`, message: 'replace is identical to find; the fault is a no-op' });
        }
      });
    });
    return errors;
  },

  evidence(doc) {
    const errors = [];
    const injection = isInjection(doc.run);
    const n = doc.run.confirmRuns;
    // N-run agreement is what fault injection means by "confirmed". A method
    // that does not re-run anything has no N, and a rule about one would be a
    // rule about a number that is not there.
    if (injection) {
      if (n < 3 && doc.run.provisional !== true) errors.push({ path: '/run/provisional', message: `confirmRuns ${n} is below 3; the run must declare provisional: true` });
      if (n >= 3 && doc.run.provisional === true) errors.push({ path: '/run/provisional', message: `confirmRuns ${n} is confirmed; provisional must be absent or false` });
    }
    if (doc.run.runners && doc.run.runner && !doc.run.runners.some((x) => x.name === doc.run.runner.name)) errors.push({ path: '/run/runners', message: 'runners must include the project runner named in run.runner' });
    if (doc.run.repo.ignoredDirty && doc.run.repo.snapshot) errors.push({ path: '/run/repo/ignoredDirty', message: 'a working-tree snapshot has no ignored dirty files: the tree was probed as it is' });
    doc.records.forEach((r, i) => {
      const p = `/records/${i}`;
      const expected = fingerprint({ claimId: r.claim.id, subjectId: r.subject.id, file: r.subject.file ?? '', verdict: r.verdict });
      if (r.fingerprint !== expected) errors.push({ path: `${p}/fingerprint`, message: `fingerprint does not match spec derivation (expected ${expected})` });

      // What the schema no longer requires, the validator still does — for the
      // one method that means it. Fault injection without defenders, inputs or
      // runs is not a leaner document, it is a verdict with nothing behind it;
      // relaxing the schema was to let a scanner conform, never to let an
      // injecting tool stop showing its work.
      if (injection && r.detail.methodDetail) {
        errors.push({ path: `${p}/detail/methodDetail`, message: 'methodDetail is for a method the spec has not specified; fault-injection has a specified shape and must not acquire a junk drawer' });
      }
      if (injection) {
        for (const k of ['defenders', 'inputs']) {
          if (!r[k]) errors.push({ path: `${p}/${k}`, message: `fault-injection requires ${k} on every record` });
        }
        for (const k of ['baselineRuns', 'probeRuns']) {
          if (!Array.isArray(r.detail[k])) errors.push({ path: `${p}/detail/${k}`, message: `fault-injection requires detail.${k} on every record` });
        }
      }
      // Every rule below reads those fields, so a record that is already
      // malformed must not also throw on the way to being reported.
      if (!injection || !r.defenders || !r.inputs || !Array.isArray(r.detail.baselineRuns) || !Array.isArray(r.detail.probeRuns)) return;

      const { baselineRuns, probeRuns } = r.detail;
      if (r.verdict === 'killed' || r.verdict === 'survived') {
        if (baselineRuns.length !== n) errors.push({ path: `${p}/detail/baselineRuns`, message: `${r.verdict} requires exactly confirmRuns (${n}) baseline runs, got ${baselineRuns.length}` });
        if (probeRuns.length !== n) errors.push({ path: `${p}/detail/probeRuns`, message: `${r.verdict} requires exactly confirmRuns (${n}) probe runs, got ${probeRuns.length}` });
        if (baselineRuns.some((b) => b.outcome !== 'pass')) errors.push({ path: `${p}/detail/baselineRuns`, message: `${r.verdict} is only valid on a green baseline` });
      }
      if (r.verdict === 'killed' && !probeRuns.every((x) => x.outcome === 'fail' && (x.assertionFailures ?? 0) > 0)) {
        errors.push({ path: `${p}/detail/probeRuns`, message: 'killed requires every probe run to fail with at least one assertion failure' });
      }
      if (r.verdict === 'survived' && !probeRuns.every((x) => x.outcome === 'pass')) {
        errors.push({ path: `${p}/detail/probeRuns`, message: 'survived requires every probe run to pass' });
      }
      if (r.verdict === 'flaky-defender') {
        const baselineNotGreen = baselineRuns.length === 0 || baselineRuns.some((b) => b.outcome !== 'pass');
        const mixedProbe = probeRuns.some((x) => x.outcome === 'pass') && probeRuns.some((x) => x.outcome === 'fail');
        if (!baselineNotGreen && !mixedProbe) {
          errors.push({ path: `${p}/detail`, message: 'flaky-defender requires a non-green baseline or mixed pass/fail probe runs' });
        }
      }
      if (r.verdict === 'nocover' && !r.defenders.nocover) {
        errors.push({ path: `${p}/defenders/nocover`, message: 'nocover verdict requires defenders.nocover = true' });
      }
      if (r.detail.flakeRate) {
        const { runs, failures } = r.detail.flakeRate;
        if (failures > runs) errors.push({ path: `${p}/detail/flakeRate`, message: `flakeRate failures (${failures}) exceed runs (${runs})` });
        if (failures > 0 && r.verdict !== 'flaky-defender') errors.push({ path: `${p}/detail/flakeRate`, message: 'a defender that failed on unmodified source makes the verdict flaky-defender' });
      }
      if (r.detail.independence) {
        if (r.verdict !== 'killed') errors.push({ path: `${p}/detail/independence`, message: 'independence is a property of a kill; only killed records carry it' });
        const { class: cls, defenderCommit, targetCommit } = r.detail.independence;
        if (cls !== 'unknown' && !(defenderCommit && targetCommit)) errors.push({ path: `${p}/detail/independence`, message: `independence class ${cls} requires both defenderCommit and targetCommit` });
      }
      if (r.detail.undeclaredKillers && r.detail.reason !== 'killed-by-undeclared-tests') {
        errors.push({ path: `${p}/detail/undeclaredKillers`, message: 'undeclaredKillers is only meaningful with reason killed-by-undeclared-tests' });
      }
      if (r.defenders.selectionSource) {
        const empty = r.defenders.requested.length === 0;
        if ((r.defenders.selectionSource === 'discovery' && !empty)
          || (r.defenders.selectionSource === 'claim' && empty)
          || (empty && r.defenders.discovered !== true)
          || (!empty && r.defenders.discovered === true)) {
          errors.push({ path: `${p}/defenders/selectionSource`, message: 'defender selection origin, requested set and discovery flag disagree' });
        }
      }
      if (r.defenders.byRunner) {
        const resolved = new Set(r.defenders.resolved);
        for (const [runner, files] of Object.entries(r.defenders.byRunner)) for (const f of files) if (!resolved.has(f)) errors.push({ path: `${p}/defenders/byRunner/${runner}`, message: `${f} ran under ${runner} but is not a resolved defender` });
        if (Object.keys(r.defenders.byRunner).length < 2) errors.push({ path: `${p}/defenders/byRunner`, message: 'byRunner is only meaningful when more than one runner ran the defenders' });
      }
      if (r.defenders.mocking && r.defenders.discovered) {
        for (const f of r.defenders.mocking) if (r.defenders.resolved.includes(f)) errors.push({ path: `${p}/defenders/mocking`, message: `${f} mocks the subject and was discovered; it cannot also be a resolved defender` });
      }
      for (const s of r.defenders.signals ?? []) {
        if (s.signal === 'unasserted-annotated' && !s.reason) errors.push({ path: `${p}/defenders/signals`, message: `unasserted-annotated on ${s.file} requires the annotation's reason` });
        // An attribute patch (Python) leaves the file a defender, so it belongs
        // to `resolved` and not to `mocking`; every other signal is about a file
        // that replaced the module and must be listed as mocking it.
        if (s.signal === 'target-attribute-patched') {
          if (!s.reason) errors.push({ path: `${p}/defenders/signals`, message: `target-attribute-patched on ${s.file} requires the patched attributes as its reason` });
          if (!r.defenders.resolved.includes(s.file)) errors.push({ path: `${p}/defenders/signals`, message: `${s.file} patches attributes of the subject but is not a resolved defender` });
        } else if (s.signal === 'persistence-payload-unasserted') {
          // The same rule the sweep document enforces on its findings: the
          // signal explains a SURVIVOR on the write path. A record does not
          // carry the fault's line, so the write-path half is the producer's
          // to keep (`persistenceSignalsFor`); the verdict half is checked here.
          // The file mocks the persistence layer, not the subject, so it is a
          // resolved defender and never a mocking one.
          if (!s.reason) errors.push({ path: `${p}/defenders/signals`, message: `persistence-payload-unasserted on ${s.file} requires the mocked layer and assertion mix as its reason` });
          if (r.verdict !== 'survived') errors.push({ path: `${p}/defenders/signals`, message: `persistence-payload-unasserted explains a survivor; on a ${r.verdict} record it explains nothing` });
          if (!r.defenders.resolved.includes(s.file)) errors.push({ path: `${p}/defenders/signals`, message: `${s.file} mocks the persistence layer but is not a resolved defender` });
        } else if (!(r.defenders.mocking ?? []).includes(s.file)) {
          errors.push({ path: `${p}/defenders/signals`, message: `${s.file} carries a mock signal but is not listed in defenders.mocking` });
        }
      }
      // A module the defenders never imported cannot have been killed by them.
      if (r.detail.targetNotImported && r.verdict === 'killed') {
        errors.push({ path: `${p}/detail/targetNotImported`, message: 'the subject was never imported, so the defenders cannot have killed the fault' });
      }
      // The control is only ever charged on a would-be survivor, so a `reached`
      // record must be one, and `not-reached` must have become unverifiable.
      if (r.detail.negativeControl === 'reached' && r.verdict !== 'survived') {
        errors.push({ path: `${p}/detail/negativeControl`, message: `negativeControl "reached" belongs to a survivor, not to ${r.verdict}` });
      }
      if (r.detail.negativeControl === 'not-reached' && !(r.verdict === 'unverifiable' && r.detail.reason === 'subject-not-executed')) {
        errors.push({ path: `${p}/detail/negativeControl`, message: 'negativeControl "not-reached" requires verdict unverifiable with reason subject-not-executed' });
      }
      if (r.detail.reason === 'subject-not-executed' && r.detail.negativeControl !== 'not-reached') {
        errors.push({ path: `${p}/detail/reason`, message: 'subject-not-executed requires the negativeControl that established it' });
      }
      // Python's import provenance and the general control answer the same
      // question. A document where they disagree describes a run that cannot
      // have happened.
      if (r.detail.targetNotImported && r.detail.negativeControl === 'reached') {
        errors.push({ path: `${p}/detail/negativeControl`, message: 'the subject was never imported, so the negative control cannot have reached it' });
      }
      if (r.verdict === 'unverifiable' && !r.detail.reason) {
        errors.push({ path: `${p}/detail/reason`, message: 'unverifiable requires a reason (e.g. anchor-missing, anchor-ambiguous)' });
      }
      // `probe-error` is the one reason that names nothing on its own: it says
      // the run threw, not what threw. Without the message the record is a
      // dead end for anyone reading the document instead of rerunning it.
      if (r.detail.reason === 'probe-error' && !r.detail.message) {
        errors.push({ path: `${p}/detail/message`, message: 'probe-error requires a message naming what threw' });
      }
      // In-place is the mode where a vanished target is the user's own file
      // gone; it raises rather than records. A document claiming otherwise
      // describes a run that cannot have happened.
      if (r.detail.restoreSkipped && doc.run.mode === 'in-place') {
        errors.push({ path: `${p}/detail/restoreSkipped`, message: 'restoreSkipped cannot occur in in-place mode, where a missing target is raised' });
      }
    });
    return errors;
  },

  calibration(doc) {
    const errors = [];
    // The primary buckets and every backoff tier are held to the same rules:
    // a coarser tier a consumer falls back to is exactly where a wrong number
    // would go unnoticed.
    const tiers = [{ bucketBy: doc.bucketBy, buckets: doc.buckets, path: '' }, ...(doc.backoff ?? []).map((t, i) => ({ ...t, path: `/backoff/${i}` }))];
    // The precision the document wrote at: the most places any value shows.
    // Parsing drops trailing zeros (0.10 → 0.1), so a single value can
    // under-report; the maximum cannot unless every value ended in zero.
    const places = tiers.flatMap((t) => Object.values(t.buckets)).reduce((m, b) => Math.max(m, decimals(b.p ?? 0), decimals(b.ci[0]), decimals(b.ci[1])), 0);
    for (const t of tiers) {
      // A compound bucketBy (`attackClass|confidence`) means compound keys,
      // each with the same number of parts — a key with fewer was translated
      // from another tool's table and lost a dimension on the way.
      const arity = t.bucketBy.split('|').length;
      for (const [key, b] of Object.entries(t.buckets)) {
        const p = `${t.path}/buckets/${key}`;
        const parts = key.split('|').length;
        if (parts !== arity) errors.push({ path: p, message: `bucket key "${key}" has ${parts} part(s); bucketBy "${t.bucketBy}" has ${arity}` });
        if (b.positives > b.n) errors.push({ path: `${p}/positives`, message: `positives (${b.positives}) exceed n (${b.n})` });
        const [lo, hi] = b.ci;
        if (lo > hi) errors.push({ path: `${p}/ci`, message: `ci lower bound ${lo} exceeds upper bound ${hi}` });
        if (b.p !== null && (b.p < lo || b.p > hi)) errors.push({ path: `${p}/p`, message: `p (${b.p}) lies outside ci [${lo}, ${hi}]` });
        if (b.breakdown) {
          const sum = Object.values(b.breakdown).reduce((s, v) => s + v, 0);
          if (sum !== b.n) errors.push({ path: `${p}/breakdown`, message: `breakdown sums to ${sum}; n is ${b.n}` });
        }
        // A cell that declares n and positives has declared p; a document that
        // declares `wilson` at `confidence` has declared every ci. Recompute
        // both with the spec's own implementation: "conforms" means
        // "reproducible", not "internally plausible". Before this the validator
        // would pass a document with every number invented, and the spec's own
        // example carried a truncated bound nothing could notice.
        // A cell with more positives than trials has no proportion to reproduce.
        if (b.positives > b.n) continue;
        const r = reproduces(b, { confidence: doc.confidence, places });
        if (!r.p) errors.push({ path: `${p}/p`, message: `p (${b.p}) is not positives/n: ${b.positives}/${b.n} = ${r.expected.p} at ${Math.min(places, MAX_PLACES)} dp` });
        if (!r.ci) errors.push({ path: `${p}/ci`, message: `ci [${lo}, ${hi}] does not reproduce: ${doc.method} at ${doc.confidence} for ${b.positives}/${b.n} is [${r.expected.ci[0]}, ${r.expected.ci[1]}]` });
      }
    }
    return errors;
  },

  status(doc) {
    const errors = [];
    if (doc.changes?.nested) {
      errors.push(...nestedErrors(doc.changes.nested, '/changes/nested', doc.changes.uncovered.map((file) => file.file)));
      const nestedCount = doc.changes.nested.reduce((count, entry) => count + entry.files.length, 0);
      if (doc.changes.changed !== doc.changes.evaluated + doc.changes.excluded + nestedCount) errors.push({ path: '/changes/changed', message: 'changed must account for evaluated, excluded, and nested files' });
    }
    if (['write-test', 'review-fault-change', 'repair-fault'].includes(doc.next.action) && !doc.next.target) errors.push({ path: '/next/target', message: `${doc.next.action} requires a target` });
    if (doc.next.action === 'claim' && !doc.next.file) errors.push({ path: '/next/file', message: 'claim requires the file the claim is about' });
    if (doc.state === 'no-claims' && doc.counts.claims !== 0) errors.push({ path: '/counts/claims', message: 'no-claims with a non-zero claim count' });
    if (doc.state === 'clean' && (doc.counts.new ?? 0) > 0) errors.push({ path: '/state', message: 'clean with new findings' });
    if (doc.state === 'unclaimed-changes' && !(doc.changes && doc.changes.uncovered.length > 0)) errors.push({ path: '/changes/uncovered', message: 'unclaimed-changes requires at least one uncovered changed file' });
    if (doc.state === 'unclaimed-changes' && doc.next.action !== 'claim') errors.push({ path: '/next/action', message: 'unclaimed-changes requires next.action = claim' });
    if (doc.state === 'invalid-anchors' && !(doc.invalidFaults?.length > 0)) errors.push({ path: '/invalidFaults', message: 'invalid-anchors requires at least one invalid fault' });
    if (doc.state === 'invalid-anchors' && doc.next.action !== 'repair-fault') errors.push({ path: '/next/action', message: 'invalid-anchors requires next.action = repair-fault' });
    if (doc.invalidFaults?.length > 0 && doc.state !== 'invalid-anchors') errors.push({ path: '/state', message: 'invalid fault anchors are hidden behind a later state; invalid-anchors precedes every evidence state' });
    if (doc.evidenceSource && !doc.evidenceHead) errors.push({ path: '/evidenceHead', message: 'evidence was read, so the commit it describes must be recorded' });
    if (doc.changes && doc.changes.uncovered.length > 0 && !['no-claims', 'unclaimed-changes'].includes(doc.state)) errors.push({ path: '/state', message: 'uncovered changed files are hidden behind a later state; unclaimed-changes precedes every evidence state' });
    if (doc.surface) {
      if (doc.surface.claimedModules + doc.surface.unclaimedModules !== doc.surface.sourceModules) errors.push({ path: '/surface', message: 'claimedModules + unclaimedModules must equal sourceModules' });
      if (doc.surface.highChurn.claimed > doc.surface.highChurn.modules) errors.push({ path: '/surface/highChurn/claimed', message: 'claimed high-churn modules cannot exceed the high-churn window' });
      if (!doc.surface.history.available && doc.surface.history.commitsRead !== 0) errors.push({ path: '/surface/history/commitsRead', message: 'unavailable history must report zero commits read' });
      if (new Set(doc.surface.rankedUnclaimed.map((item) => item.file)).size !== doc.surface.rankedUnclaimed.length) errors.push({ path: '/surface/rankedUnclaimed', message: 'ranked unclaimed modules must be unique' });
    }
    if (doc.run?.scope) {
      const scope = doc.run.scope;
      if (scope.requestedCount !== scope.requestedClaims.length) errors.push({ path: '/run/scope/requestedCount', message: 'requestedCount must equal requestedClaims.length' });
      if (scope.probedCount !== scope.probedClaims.length) errors.push({ path: '/run/scope/probedCount', message: 'probedCount must equal probedClaims.length' });
      const requested = new Set(scope.requestedClaims);
      if (scope.probedClaims.some((id) => !requested.has(id))) errors.push({ path: '/run/scope/probedClaims', message: 'every probed claim must have been requested' });
    }
    return errors;
  },

  replay(doc) {
    const errors = [];
    const n = doc.run.confirmRuns;
    const seen = new Set();
    doc.records.forEach((r, i) => {
      const p = `/records/${i}`;
      // One patch, one row: a dual-branch topology carries the same fix under
      // two or three shas, and counting it twice corrupts the corpus the
      // calibration is computed from.
      if (seen.has(r.patchId)) errors.push({ path: `${p}/patchId`, message: `duplicate patch-id ${r.patchId.slice(0, 12)}: the same fix counted twice` });
      seen.add(r.patchId);
      if (['caught', 'blind'].includes(r.verdict) && r.runs.length !== n) {
        errors.push({ path: `${p}/runs`, message: `${r.verdict} requires exactly confirmRuns (${n}) runs, got ${r.runs.length}` });
      }
      // Only a test body rejecting the reverted source counts as caught —
      // the same rule as `killed`, for the same reason.
      if (r.verdict === 'caught' && !r.runs.every((x) => x.outcome === 'fail' && (x.assertionFailures ?? 0) > 0)) {
        errors.push({ path: `${p}/runs`, message: 'caught requires every run to fail with at least one assertion failure' });
      }
      if (r.verdict === 'blind' && !r.runs.every((x) => x.outcome === 'pass')) {
        errors.push({ path: `${p}/runs`, message: 'blind requires every run to pass: the suite stayed green on known-broken code' });
      }
      if (r.verdict === 'flaky' && !(r.runs.some((x) => x.outcome === 'pass') && r.runs.some((x) => x.outcome === 'fail'))) {
        errors.push({ path: `${p}/runs`, message: 'flaky requires runs that disagree' });
      }
      if (r.verdict === 'nocover' && r.ranTests) errors.push({ path: `${p}/ranTests`, message: 'nocover means no test exercises the reverted files; it cannot have run tests' });
      if (r.verdict === 'unverifiable' && !r.reason) errors.push({ path: `${p}/reason`, message: 'unverifiable requires a reason (e.g. revert-did-not-apply, suite-failed-to-load)' });
      // A run that had no test file left is a FAILED MEASUREMENT, never a
      // finding about the project: removing the fix's test removed the file it
      // lived in, and with it any pre-existing test that might have caught the
      // bug. Recording that as `nocover` would put it in the calibration as a
      // miss and charge the project for evidence the method destroyed.
      if (r.reason === 'the-fix-shipped-the-only-test-file' && r.verdict !== 'unverifiable') {
        errors.push({ path: `${p}/verdict`, message: 'no test file remained after removing the fix\'s own, so nothing could be concluded: that is unverifiable, not a finding about the project' });
      }
    });
    return errors;
  },

  gate(doc) {
    const errors = [];
    const nestedCount = (doc.nested ?? []).reduce((count, entry) => count + entry.files.length, 0);
    errors.push(...nestedErrors(doc.nested, '/nested', [...doc.covered, ...doc.uncovered, ...doc.excluded].map((entry) => entry.file)));
    if (doc.evaluated !== doc.covered.length + doc.uncovered.length) errors.push({ path: '/evaluated', message: `evaluated (${doc.evaluated}) must equal covered (${doc.covered.length}) + uncovered (${doc.uncovered.length})` });
    if (doc.changed !== doc.evaluated + doc.excluded.length + nestedCount) errors.push({ path: '/changed', message: `changed (${doc.changed}) must equal evaluated (${doc.evaluated}) + excluded (${doc.excluded.length}) + nested (${nestedCount})` });
    if (doc.uncovered.length > 0 && doc.exitCode !== 1) errors.push({ path: '/exitCode', message: 'an uncovered changed file must exit 1; the gate never passes over unclaimed code' });
    if (doc.uncovered.length === 0 && doc.exitCode === 1 && !(doc.strict && doc.changed > 0 && doc.evaluated === 0)) errors.push({ path: '/exitCode', message: 'exit 1 without uncovered files is only valid under --strict when a non-empty change evaluated nothing' });
    doc.covered.forEach((c, i) => {
      if (c.by === 'ignore' && !c.pattern) errors.push({ path: `/covered/${i}/pattern`, message: 'a file covered by an ignore entry must name the pattern that excused it' });
      if (c.by !== 'ignore' && !c.claimIds?.length) errors.push({ path: `/covered/${i}/claimIds`, message: `a file covered by a ${c.by} must name the claim(s)` });
    });
    for (const e of doc.expired) if (!e.expires) errors.push({ path: '/expired', message: `expired entry "${e.pattern}" has no expires instant` });
    return errors;
  },

  concerns(doc) {
    const errors = [];
    const seen = new Set();
    doc.concerns.forEach((c, i) => {
      if (seen.has(c.id)) errors.push({ path: `/concerns/${i}/id`, message: `duplicate concern id "${c.id}"` });
      seen.add(c.id);
      // A glob target with no globs matches nothing, which reads as "this
      // concern found no problems" rather than "this concern was never aimed".
      if (c.targets?.kind === 'glob' && !(c.targets.globs?.length > 0)) {
        errors.push({ path: `/concerns/${i}/targets/globs`, message: `concern "${c.id}" targets a glob but names none; it would match nothing and report clean` });
      }
      if (c.targets?.kind !== 'glob' && c.targets?.globs) {
        errors.push({ path: `/concerns/${i}/targets/globs`, message: `concern "${c.id}" names globs but does not target them` });
      }
      // An empty list is not "every class"; it is a concern that can never
      // propose anything, which is a typo for `null` every time.
      if (Array.isArray(c.faultClasses) && c.faultClasses.length === 0) {
        errors.push({ path: `/concerns/${i}/faultClasses`, message: `concern "${c.id}" allows no fault class; omit the field for every class` });
      }
    });
    return errors;
  },

  sweep(doc) {
    const errors = [];
    const s = doc.selection;
    // A cap that hides its remainder is a coverage claim nobody made, so the
    // arithmetic that proves nothing was dropped is checked, not trusted.
    const setAside = s.presentational ?? 0;
    if (s.proposed !== s.selected + s.deferred + setAside) errors.push({ path: '/selection/proposed', message: `proposed (${s.proposed}) must equal selected (${s.selected}) + deferred (${s.deferred})${setAside ? ` + presentational (${setAside})` : ''}` });
    if (s.selected > s.cap) errors.push({ path: '/selection/selected', message: `selected (${s.selected}) exceeds the cap (${s.cap})` });
    if (doc.scope.swept > doc.scope.targets) errors.push({ path: '/scope/swept', message: `swept (${doc.scope.swept}) cannot exceed targets (${doc.scope.targets})` });
    // The counters that only mean something in one mode must not appear in the
    // other: `writeSites` on a diff sweep would be a denominator nobody
    // measured, and its absence on a save-paths sweep hides the denominator
    // entirely — which is the whole reason that mode exists.
    const saves = doc.scope.mode === 'save-paths';
    for (const k of ['writeSites', 'payloadFields', 'provability']) {
      if (saves && doc.scope[k] === undefined) errors.push({ path: `/scope/${k}`, message: `a save-paths sweep must report ${k}: the surface is the denominator its findings are read against` });
      if (!saves && doc.scope[k] !== undefined) errors.push({ path: `/scope/${k}`, message: `${k} belongs to a save-paths sweep; a changed sweep did not measure the write surface` });
    }
    if (saves && doc.scope.provability) {
      const pv = doc.scope.provability;
      const total = pv.mocked + pv.unmocked + pv.none;
      // Every target is classified exactly once. A surface whose provability
      // does not account for all of it has a bucket nobody looked in.
      if (total !== doc.scope.targets) errors.push({ path: '/scope/provability', message: `provability accounts for ${total} files; targets is ${doc.scope.targets}` });
    }
    if (saves && doc.scope.writeSites !== undefined && doc.scope.targets > doc.scope.writeSites) {
      errors.push({ path: '/scope/targets', message: `targets (${doc.scope.targets}) exceeds writeSites (${doc.scope.writeSites}); every target is a file with at least one write` });
    }

    const byClass = Object.values(s.byClass);
    const proposedByClass = byClass.reduce((a, c) => a + c.proposed, 0);
    const selectedByClass = byClass.reduce((a, c) => a + c.selected, 0);
    if (proposedByClass !== s.proposed) errors.push({ path: '/selection/byClass', message: `byClass proposed sums to ${proposedByClass}; selection.proposed is ${s.proposed}` });
    if (selectedByClass !== s.selected) errors.push({ path: '/selection/byClass', message: `byClass selected sums to ${selectedByClass}; selection.selected is ${s.selected}` });
    for (const [k, c] of Object.entries(s.byClass)) {
      if (c.selected > c.proposed) errors.push({ path: `/selection/byClass/${k}`, message: `selected (${c.selected}) exceeds proposed (${c.proposed})` });
      if (c.writePath > c.proposed) errors.push({ path: `/selection/byClass/${k}`, message: `writePath (${c.writePath}) exceeds proposed (${c.proposed})` });
    }

    const probed = Object.values(doc.counts).reduce((a, n) => a + n, 0);
    if (probed > s.selected) errors.push({ path: '/counts', message: `${probed} verdicts recorded for ${s.selected} selected faults` });
    // Findings are every record that was not killed. Stating that here keeps a
    // document from quietly reporting fewer findings than it reached verdicts.
    const notKilled = probed - (doc.counts.killed ?? 0);
    if (doc.findings.length !== notKilled) errors.push({ path: '/findings', message: `${doc.findings.length} findings for ${notKilled} records that were not killed; findings are every non-killed record` });

    // An ordering that claims to have learned from something must name it.
    if (doc.ordering) {
      if (doc.ordering.observed > 0 && doc.ordering.sources.length === 0) errors.push({ path: '/ordering/sources', message: 'an ordering learned from evidence must name the documents it was learned from' });
      if (doc.ordering.observed === 0 && doc.ordering.sources.length > 0) errors.push({ path: '/ordering/observed', message: 'sources are named but nothing was observed; the ordering used the shipped prior' });
    }

    const gating = doc.findings.filter((f) => f.verdict === 'survived' || f.verdict === 'nocover').length;
    if (gating > 0 && doc.exitCode !== 1) errors.push({ path: '/exitCode', message: 'a survived or nocover finding must exit 1; a sweep never passes over a deliberate break nothing noticed' });
    if (gating === 0 && doc.exitCode !== 0) errors.push({ path: '/exitCode', message: 'exit 1 requires a survived or nocover finding; a sweep does not fail on its own unanchorable proposal' });

    doc.findings.forEach((f, i) => {
      if (f.verdict === 'killed') errors.push({ path: `/findings/${i}/verdict`, message: 'a killed fault is not a finding' });
      // The signal explains why a defender could not notice a changed payload.
      // On any other verdict, or off the write path, it explains nothing and
      // would be exactly the non-actionable noise that gets a check ignored.
      if (f.signals && !(f.verdict === 'survived' && f.writePath)) {
        errors.push({ path: `/findings/${i}/signals`, message: 'signals belong to a survived finding on the write path' });
      }
    });
    return errors;
  },

  brief(doc) {
    const errors = [];
    if (!doc.text.startsWith(doc.heading)) errors.push({ path: '/text', message: 'text must begin with heading' });
    const byVerdictTotal = Object.values(doc.summary.byVerdict).reduce((a, b) => a + b, 0);
    if (doc.summary.new + doc.summary.baselined > byVerdictTotal) {
      errors.push({ path: '/summary', message: 'new + baselined cannot exceed the total of byVerdict' });
    }
    return errors;
  },
};

/**
 * Validate a document against a Guard-spec kind: JSON Schema first, then the
 * semantic rules for that kind. Returns { ok, errors: [{ path, message }] }.
 */
export function validate(kind, doc) {
  const check = schemaFor(kind);
  if (!check(doc)) {
    return {
      ok: false,
      errors: check.errors.map((e) => ({ path: e.instancePath || '/', message: e.message ?? 'invalid' })),
    };
  }
  const errors = semantic[kind] ? semantic[kind](doc) : [];
  errors.push(...originErrors(kind, doc));
  errors.push(...originPolicyErrors(kind, doc));
  return { ok: errors.length === 0, errors };
}
