import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fingerprint } from './fingerprint.mjs';
import { reproduces, decimals, MAX_PLACES } from './wilson.mjs';

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

export const KINDS = Object.freeze(['claims', 'evidence', 'baseline', 'ignore', 'calibration', 'brief', 'status', 'gate', 'replay']);
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

// Rules JSON Schema cannot express. Each returns an array of {path, message}.
const semantic = {
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
    if (['write-test', 'review-fault-change'].includes(doc.next.action) && !doc.next.target) errors.push({ path: '/next/target', message: `${doc.next.action} requires a target` });
    if (doc.next.action === 'claim' && !doc.next.file) errors.push({ path: '/next/file', message: 'claim requires the file the claim is about' });
    if (doc.state === 'no-claims' && doc.counts.claims !== 0) errors.push({ path: '/counts/claims', message: 'no-claims with a non-zero claim count' });
    if (doc.state === 'clean' && (doc.counts.new ?? 0) > 0) errors.push({ path: '/state', message: 'clean with new findings' });
    if (doc.state === 'unclaimed-changes' && !(doc.changes && doc.changes.uncovered.length > 0)) errors.push({ path: '/changes/uncovered', message: 'unclaimed-changes requires at least one uncovered changed file' });
    if (doc.state === 'unclaimed-changes' && doc.next.action !== 'claim') errors.push({ path: '/next/action', message: 'unclaimed-changes requires next.action = claim' });
    if (doc.evidenceSource && !doc.evidenceHead) errors.push({ path: '/evidenceHead', message: 'evidence was read, so the commit it describes must be recorded' });
    if (doc.changes && doc.changes.uncovered.length > 0 && !['no-claims', 'unclaimed-changes'].includes(doc.state)) errors.push({ path: '/state', message: 'uncovered changed files are hidden behind a later state; unclaimed-changes precedes every evidence state' });
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
    });
    return errors;
  },

  gate(doc) {
    const errors = [];
    if (doc.evaluated !== doc.covered.length + doc.uncovered.length) errors.push({ path: '/evaluated', message: `evaluated (${doc.evaluated}) must equal covered (${doc.covered.length}) + uncovered (${doc.uncovered.length})` });
    if (doc.changed !== doc.evaluated + doc.excluded.length) errors.push({ path: '/changed', message: `changed (${doc.changed}) must equal evaluated (${doc.evaluated}) + excluded (${doc.excluded.length})` });
    if (doc.uncovered.length > 0 && doc.exitCode !== 1) errors.push({ path: '/exitCode', message: 'an uncovered changed file must exit 1; the gate never passes over unclaimed code' });
    if (doc.uncovered.length === 0 && doc.exitCode === 1 && !(doc.strict && doc.changed > 0 && doc.evaluated === 0)) errors.push({ path: '/exitCode', message: 'exit 1 without uncovered files is only valid under --strict when a non-empty change evaluated nothing' });
    doc.covered.forEach((c, i) => {
      if (c.by === 'ignore' && !c.pattern) errors.push({ path: `/covered/${i}/pattern`, message: 'a file covered by an ignore entry must name the pattern that excused it' });
      if (c.by !== 'ignore' && !c.claimIds?.length) errors.push({ path: `/covered/${i}/claimIds`, message: `a file covered by a ${c.by} must name the claim(s)` });
    });
    for (const e of doc.expired) if (!e.expires) errors.push({ path: '/expired', message: `expired entry "${e.pattern}" has no expires instant` });
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
  return { ok: errors.length === 0, errors };
}
