/**
 * What this project's own runs say about which faults are worth proposing.
 *
 * `select.mjs` ships a productivity prior measured on one real application.
 * That is a reasonable starting point and a poor stopping point: the classes
 * that survive a Next.js suite are not the classes that survive a Python one,
 * and Google's mutation service got from a 15% productive rate to 89% on
 * exactly this — feedback, accumulated over years, refining which candidates
 * are worth a developer's attention ("Practical Mutation Testing at Scale",
 * Petrović et al., 2021). The static table is the part of that idea this tool
 * had not yet taken.
 *
 * THE FEEDBACK IS ALREADY ON DISK. Every evidence record carries a
 * `faultClass` and a `verdict`, so "how often does a fault of this class
 * survive here" is a tally, not a new thing to capture. There is no click to
 * collect and no state to maintain: a project that has probed anything has
 * already said what its own productive classes are.
 *
 * WHY THIS ESTIMATOR AND NOT A BETTER-SOUNDING ONE. The combination below is a
 * Beta-Binomial posterior mean, and a posterior mean is what minimises Brier
 * and log score in expectation — it is a STRICTLY PROPER estimate, which is
 * the only kind that cannot be improved by reporting something other than an
 * honest probability. Optimising the ordering for accuracy or F1 instead would
 * maximise the number of survivors found while destroying the calibration of
 * the number attached to each, which is the documented failure mode of naive
 * optimisation and the reason Laya trains against proper scoring rules. If
 * this file is ever changed to rank by anything but an honest probability,
 * that is the invariant being broken.
 *
 * Pure apart from reading the documents it is given.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEASURED_PRODUCTIVITY } from './select.mjs';

/** The evidence a project may have produced, in the order they are most relevant. */
export const EVIDENCE_PATHS = Object.freeze([
  // A sweep probes MACHINE-proposed faults, the same distribution the ranker
  // orders, so it is the closest observation available.
  '.testguard/sweep-evidence.json',
  // The canonical probe is human-authored faults: a real observation of the
  // same classes, drawn slightly differently, and still worth counting.
  '.testguard/evidence.json',
]);

/**
 * Survival counts per fault class from one evidence document.
 *
 * Only `killed` and `survived` are counted. `nocover`, `unverifiable`,
 * `fault-invalid`, `timeout` and `flaky-defender` say nothing about whether a
 * fault of that class would be NOTICED — they say the question could not be
 * asked — and folding them in either direction would be inventing data.
 */
export function tallyEvidence(doc) {
  const by = {};
  for (const r of doc?.records ?? []) {
    const cls = r.subject?.faultClass;
    if (!cls) continue;
    if (r.verdict !== 'killed' && r.verdict !== 'survived') continue;
    const e = (by[cls] ??= { survived: 0, n: 0 });
    e.n += 1;
    if (r.verdict === 'survived') e.survived += 1;
  }
  return by;
}

/** Merge tallies from several documents. Counts add; nothing is averaged twice. */
export function mergeTallies(tallies) {
  const by = {};
  for (const t of tallies) {
    for (const [cls, e] of Object.entries(t)) {
      const m = (by[cls] ??= { survived: 0, n: 0 });
      m.survived += e.survived;
      m.n += e.n;
    }
  }
  return by;
}

/**
 * The productivity table to rank with: this project's own observations, with
 * the shipped measurement as the prior they are shrunk toward.
 *
 * The shipped numbers become pseudo-counts rather than a competing estimate —
 * `n` of them, so a class measured on twelve faults elsewhere carries the
 * weight of twelve observations here and no more. A project with its own
 * hundred records therefore overrides the shipping default; a project with
 * three nudges it.
 *
 * `shipped` is injectable so the combination can be tested without depending
 * on whatever the current measurement happens to be.
 */
export function combinedProductivity(local, shipped = MEASURED_PRODUCTIVITY) {
  const out = {};
  for (const cls of new Set([...Object.keys(shipped), ...Object.keys(local)])) {
    const s = shipped[cls];
    const l = local[cls];
    const priorSurvived = s ? s.p * s.n : 0;
    const priorN = s ? s.n : 0;
    const n = priorN + (l?.n ?? 0);
    if (n === 0) continue;
    const survived = priorSurvived + (l?.survived ?? 0);
    out[cls] = { p: survived / n, n, observed: l?.n ?? 0 };
  }
  return out;
}

/** Read whichever evidence documents this project has. Missing or malformed ones are skipped, never guessed at. */
export function readEvidence(projectDir, paths = EVIDENCE_PATHS) {
  const docs = [];
  for (const rel of paths) {
    const p = join(projectDir, rel);
    if (!existsSync(p)) continue;
    try {
      docs.push({ path: rel, doc: JSON.parse(readFileSync(p, 'utf8')) });
    } catch {
      // A document this tool cannot parse is not evidence of anything. It is
      // skipped rather than defaulted, because a ranking built on a guess
      // about a corrupt file is worse than one built on the shipped prior.
    }
  }
  return docs;
}

/**
 * The learned table plus what it was learned from, so a report can say whether
 * an ordering came from this project or from the shipping default. An ordering
 * nobody can trace is a number nobody should trust.
 */
export function learnedProductivity(projectDir, { paths, shipped } = {}) {
  const docs = readEvidence(projectDir, paths);
  const tallied = docs.map((d) => ({ path: d.path, tally: tallyEvidence(d.doc) }));
  // A document is a SOURCE only if it contributed an observation. One that was
  // read but yielded nothing countable is not something an ordering was
  // "learned from", and naming it anyway is what produced a sweep document the
  // validator correctly refused to write: sources named, observed zero.
  //
  // That state is the ORDINARY shape of a first sweep. `tallyEvidence` counts
  // only `killed` and `survived`, so evidence whose records are all `nocover`
  // teaches nothing — and once such a document was on disk, EVERY later sweep
  // failed the same check, permanently, until someone deleted a gitignored
  // file nothing told them about.
  const contributing = tallied.filter((t) => Object.keys(t.tally).length > 0);
  const local = mergeTallies(contributing.map((t) => t.tally));
  const observed = Object.values(local).reduce((a, e) => a + e.n, 0);
  return {
    table: combinedProductivity(local, shipped),
    sources: contributing.map((t) => t.path),
    observed,
    classes: Object.keys(local).sort(),
  };
}

/** One line for a report: where the ordering came from. */
export function renderLearned(learned) {
  if (learned.observed === 0) return 'ordering: the shipped productivity prior — this project has no probed evidence yet.';
  return `ordering: ${learned.observed} probed fault${learned.observed === 1 ? '' : 's'} of this project's own, across ${learned.classes.length} class${learned.classes.length === 1 ? '' : 'es'} (${learned.sources.join(', ')}), shrunk toward the shipped prior.`;
}
