/**
 * The pure pieces of `probe --partial-on-budget` (issue #235).
 *
 * `--command-budget` by default refuses to publish when it runs out, because a
 * partial document could make the unattempted suffix look clean. This opt-in
 * publishes anyway, under one rule: nothing that was not fully measured is
 * ever reported as measured. Every fault the budget did not reach — the ones
 * in flight and the ones never started — gets `unverifiable` with the reason
 * below. It gates, so the suffix cannot look clean, and it is never reusable.
 *
 * Kept free of I/O so each rule has a cheap unit defender; `probe.mjs` only
 * decides which faults were reached.
 */
import { join } from 'node:path';
import { fingerprint } from '../../spec/lib/fingerprint.mjs';
import { sha256 } from '../util/hash.mjs';
import { defenderSelection, subjectOf } from './attribution.mjs';

/** The `detail.reason` of a fault the command budget did not reach. */
export const NOT_REACHED = 'not-reached-within-budget';

/** Where an exhausted run's document goes unless `--out` says otherwise. Never the canonical evidence file. */
export const partialEvidencePath = (projectDir) => join(projectDir, '.testguard', 'evidence-partial.json');

export const isNotReached = (record) => record?.verdict === 'unverifiable' && record.detail?.reason === NOT_REACHED;

/**
 * The record a fault gets when the budget ran out before it was fully
 * measured. `inputs` is whatever could be hashed without running anything; no
 * defender was resolved or run, so `resolved` is empty and `nocover` is false
 * (an unresolved set is not "no defender exists"). Never reusable: see
 * `isReusable`.
 */
export function notReachedRecord({ claim, fault, inputs, limitMs }) {
  const selection = defenderSelection(claim, fault);
  return {
    fingerprint: fingerprint({ claimId: claim.id, subjectId: fault.id, file: fault.file, verdict: 'unverifiable' }),
    claim: { id: claim.id, statement: claim.statement, severity: claim.severity, source: claim.source, producedBy: claim.producedBy },
    subject: subjectOf(fault, sha256),
    verdict: 'unverifiable',
    detail: {
      baselineRuns: [],
      probeRuns: [],
      reason: NOT_REACHED,
      message: `the command budget of ${limitMs}ms ran out before this fault was fully measured`,
    },
    defenders: { ...selection, resolved: [], nocover: false, ...(selection.requested.length === 0 ? { discovered: true } : {}) },
    inputs,
  };
}

/**
 * Every fault's record in claim/fault order: the one that was fully measured,
 * or a not-reached record. `settled` maps a fault's index to its finished
 * record; an index that is absent was in flight, not started, or held back for
 * a serial re-measure, and a contended record is not a measurement.
 */
export function completeRecords(faults, settled, reachedOf) {
  return faults.map((item, index) => settled.get(index) ?? reachedOf(item));
}

/** `run.budget`: what the command budget bought. `exhausted` is derived from the records, never asserted. */
export function budgetSummary(limitMs, records) {
  const notReached = records.filter(isNotReached).length;
  return { limitMs, exhausted: notReached > 0, reached: records.length - notReached, notReached };
}

/**
 * The exit code of an exhausted run. Findings outrank incompleteness: when the
 * measured part already holds a verdict that gates (or a policy that failed),
 * the run is a failure (1) and says it is also incomplete; otherwise the
 * command simply did not finish (2). Never 0 — the suffix was not measured.
 *
 * `newGating` is the count of measured records that gate (not baselined, at or
 * above the severity floor); not-reached records are excluded by the caller
 * and never count toward the floor.
 */
export function partialExit({ newGating, policyFailed = false }) {
  const findings = newGating > 0 || policyFailed;
  const failureKind = newGating > 0 ? 'unproven+incomplete' : policyFailed ? 'policy+incomplete' : 'incomplete';
  return { exitCode: findings ? 1 : 2, failureKind, ...(newGating > 0 ? { unprovenAtLeast: newGating } : {}) };
}
