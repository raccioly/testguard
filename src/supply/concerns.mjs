/**
 * A concern: one sentence a human writes, that generates faults across a whole
 * surface.
 *
 * The rung between "nothing written" and "a claim per behaviour". A claim names
 * one promise and the faults that would break it; that is precise and it is why
 * a repository with two hundred screens never finishes writing them. A concern
 * names a KIND of promise — "every write persists the data it was given" — and
 * says where to look for it and which shapes of break are relevant. One
 * sentence, two hundred screens.
 *
 * The idea is Meta's. ACH has an engineer describe an area of concern in plain
 * text, generates faults specific to it, and gates every step by execution
 * ("Mutation-Guided LLM-based Test Generation at Meta", Foster et al., FSE
 * 2025). What is taken here is the UNIT — the concern as the thing a human
 * writes — not their generator.
 *
 * NO MODEL IS REQUIRED, and that is deliberate. A concern's useful core is a
 * named scope plus a producer selection, both of which the mechanical
 * producers already satisfy. An LLM can later propose faults a line-oriented
 * producer cannot see, as an ADDITIONAL source for a concern that already
 * works — rather than as the thing the rung depends on. That keeps every
 * verifying command offline, which is the property this tool is least willing
 * to trade.
 *
 * A concern is NOT a claim and never becomes one by itself. It says where to
 * look; the probe says what it found; a human states the sentence worth
 * defending. Nothing here is written to `testguard.claims.json`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveSurface } from './savepath.mjs';
import { globToRegExp, walk } from '../util/glob.mjs';

export const defaultConcernsPath = (projectDir) => join(projectDir, 'testguard.concerns.json');

/**
 * The concerns every project gets without writing anything.
 *
 * Two, because two are the ones whose targets can be enumerated honestly. An
 * authorization concern would need a heuristic for "which files check
 * permissions", and a guess there produces exactly the non-actionable noise
 * that gets a check switched off. A project that knows its own auth layer can
 * say so with a `glob` target in three lines; this file will not guess for it.
 */
export const BUILTIN_CONCERNS = Object.freeze([
  Object.freeze({
    id: 'SAVE-PERSISTS',
    statement: 'Every write to storage persists the data it was given.',
    severity: 'high',
    targets: { kind: 'write-sites' },
    // The shapes that break a persisted payload. Measured on a real
    // application: 12 of 12 surviving faults on the persistence path were a
    // field dropped from the payload, so the list leads with that.
    faultClasses: ['field-dropped', 'call-removed', 'statement-deleted', 'literal-changed'],
    builtin: true,
  }),
  Object.freeze({
    id: 'CHANGED-CODE',
    statement: 'Code changed in this branch is defended by something.',
    severity: 'medium',
    targets: { kind: 'changed' },
    // Everything: a diff has no shape to narrow by.
    faultClasses: null,
    builtin: true,
  }),
]);

/**
 * Load the project's concerns, with the built-ins behind them.
 *
 * A project concern with the same id as a built-in REPLACES it, so a team can
 * retune `SAVE-PERSISTS` for an ORM this tool does not recognise without
 * forking anything. Shadowing is recorded rather than silent: a concern that
 * quietly replaced a default would be the kind of surprise that costs an
 * afternoon.
 */
export function loadConcerns(projectDir, { path } = {}) {
  const p = path ?? defaultConcernsPath(projectDir);
  let project = [];
  let source = null;
  if (existsSync(p)) {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    project = doc.concerns ?? [];
    source = p;
  }
  const overridden = new Set(project.map((c) => c.id));
  const concerns = [
    ...project.map((c) => ({ ...c, builtin: false })),
    ...BUILTIN_CONCERNS.filter((c) => !overridden.has(c.id)),
  ];
  return {
    concerns,
    // The project's own entries, exactly as written. Validation runs against
    // these: the enriched objects above carry a `builtin` marker this tool
    // added, and a schema that refuses unknown properties is right to reject
    // them. Validating what we constructed instead of what the user wrote
    // would report OUR bug as THEIR malformed file.
    raw: project.map(({ builtin, ...c }) => c),
    source,
    shadowed: BUILTIN_CONCERNS.filter((c) => overridden.has(c.id)).map((c) => c.id),
  };
}

/** One concern by id, or null. Ids are matched exactly: a near-miss is a typo, not an intention. */
export const concernById = (concerns, id) => concerns.find((c) => c.id === id) ?? null;

/**
 * The files a concern applies to.
 *
 * `write-sites` asks the enumerator; `glob` matches the project's own paths;
 * `changed` returns null, meaning "the caller's diff decides" — a concern does
 * not get to re-derive what the gate already computed.
 */
export function targetsFor(projectDir, concern, { changedFiles } = {}) {
  const t = concern.targets ?? { kind: 'changed' };
  if (t.kind === 'write-sites') return saveSurface(projectDir).files.map((f) => f.file);
  if (t.kind === 'glob') {
    // Against the whole project, never the diff. A concern like "every admin
    // route refuses an unauthorised caller" is about the admin routes, not
    // about the ones that happened to change today — and pooling from the diff
    // made such a concern report clean on a clean branch, which is the exact
    // false reassurance a concern exists to prevent.
    const res = (t.globs ?? []).map(globToRegExp);
    return walk(projectDir).filter((f) => res.some((re) => re.test(f)));
  }
  return changedFiles ?? null;
}

/**
 * Keep only the faults whose class this concern cares about.
 *
 * `faultClasses: null` means every class — the honest default for a concern
 * with no shape to narrow by. Narrowing is what makes one sentence useful
 * across two hundred files: a persistence concern that also reported every
 * altered return value would bury the payload findings it exists to surface.
 */
export function filterByConcern(candidates, concern) {
  if (!concern?.faultClasses) return candidates;
  const keep = new Set(concern.faultClasses);
  return candidates.filter((c) => keep.has(c.fault.faultClass));
}

/** The concerns as text, for someone deciding which to sweep. */
export function renderConcerns({ concerns, source, shadowed }) {
  const out = [];
  out.push(source ? `${concerns.length} concern${concerns.length === 1 ? '' : 's'} (${source}, plus the built-ins)` : `${concerns.length} built-in concern${concerns.length === 1 ? '' : 's'} — none declared in this project.`);
  out.push('');
  for (const c of concerns) {
    const shape = c.targets?.kind === 'glob' ? `glob ${(c.targets.globs ?? []).join(', ')}` : c.targets?.kind ?? 'changed';
    out.push(`  ${c.id}${c.builtin ? '  (built-in)' : ''}`);
    out.push(`    ${c.statement}`);
    out.push(`    targets: ${shape} · faults: ${c.faultClasses ? c.faultClasses.join(', ') : 'every class'}`);
    out.push('');
  }
  if (shadowed.length) out.push(`This project replaces the built-in ${shadowed.join(', ')}.`);
  if (!source) {
    out.push('Declare your own in testguard.concerns.json. A concern is one sentence and a');
    out.push('scope: it says where to look, never what is true. Only a claim does that.');
  }
  return out.join('\n');
}
