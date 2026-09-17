import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fingerprint } from './fingerprint.mjs';

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

export const KINDS = Object.freeze(['claims', 'evidence', 'baseline', 'ignore', 'calibration', 'brief']);
export const PASSING_VERDICTS = Object.freeze(new Set(['killed']));

const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const f of readdirSync(schemaDir).filter((n) => n.endsWith('.schema.json'))) {
  ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, f), 'utf8')));
}

const schemaFor = (kind) => {
  const v = ajv.getSchema(`urn:guard-spec:v1:${kind}`);
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
        const occ = f.occurrence ?? 1;
        const hits = f.expectHits ?? 1;
        if (occ > hits) errors.push({ path: `${p}/occurrence`, message: `occurrence ${occ} exceeds expectHits ${hits}` });
        if (f.find === f.replace) errors.push({ path: `${p}/replace`, message: 'replace is identical to find; the fault is a no-op' });
      });
    });
    return errors;
  },

  evidence(doc) {
    const errors = [];
    const n = doc.run.confirmRuns;
    doc.records.forEach((r, i) => {
      const p = `/records/${i}`;
      const expected = fingerprint({ claimId: r.claim.id, subjectId: r.subject.id, file: r.subject.file ?? '', verdict: r.verdict });
      if (r.fingerprint !== expected) errors.push({ path: `${p}/fingerprint`, message: `fingerprint does not match spec derivation (expected ${expected})` });

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
      if (r.detail.undeclaredKillers && r.detail.reason !== 'killed-by-undeclared-tests') {
        errors.push({ path: `${p}/detail/undeclaredKillers`, message: 'undeclaredKillers is only meaningful with reason killed-by-undeclared-tests' });
      }
      if (r.verdict === 'unverifiable' && !r.detail.reason) {
        errors.push({ path: `${p}/detail/reason`, message: 'unverifiable requires a reason (e.g. anchor-missing, anchor-ambiguous)' });
      }
    });
    return errors;
  },

  calibration(doc) {
    const errors = [];
    for (const [key, b] of Object.entries(doc.buckets)) {
      const p = `/buckets/${key}`;
      if (b.positives > b.n) errors.push({ path: `${p}/positives`, message: `positives (${b.positives}) exceed n (${b.n})` });
      const [lo, hi] = b.ci;
      if (lo > hi) errors.push({ path: `${p}/ci`, message: `ci lower bound ${lo} exceeds upper bound ${hi}` });
      if (b.p < lo || b.p > hi) errors.push({ path: `${p}/p`, message: `p (${b.p}) lies outside ci [${lo}, ${hi}]` });
    }
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
