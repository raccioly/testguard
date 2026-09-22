/**
 * The cold start: findings on a repository that has no claims yet.
 *
 * `gate --changed` already says which changed source files carry no claim, and
 * stops there — correctly, because stating a claim is a human act. But a
 * project adopting this tool reads that list, has nothing to compare it
 * against, and closes the tab. Every escaped defect reported from the field so
 * far was a claim gap, not a probe miss, so the bottleneck was never
 * verification. It is oracle SUPPLY.
 *
 * Sweep is the lowest rung of that supply: no concern, no statement, nothing
 * written by anybody. It takes the files the gate just called uncovered,
 * proposes faults mechanically with the existing scaffold producers, probes a
 * bounded selection of them, and reports what survived. A fault that survives
 * needs no claim to be alarming: the code changed, something was deliberately
 * broken, and not one test noticed.
 *
 * WHAT IT IS NOT. It does not write `testguard.claims.json`, and it never
 * will — a claim is a sentence a human is willing to stand behind, and a
 * sentence nobody wrote is not one. Its drafts land beside the evidence for a
 * human to keep or drop, exactly as `scaffold` already works. It does not
 * overwrite the canonical `.testguard/evidence.json` either: a sweep probes
 * machine-proposed faults under TODO statements, and folding that into the
 * document `status` and `baseline` read from would corrupt the record of what
 * the project actually claims.
 *
 * The cap and the ordering come from Google's mutation service, which surfaces
 * at most 7 x |files| mutants per change and orders candidates on the measured
 * productivity of their operator, taking their productive rate from 15% to 89%
 * ("Practical Mutation Testing at Scale", Petrovic et al., 2021). See
 * `src/supply/select.mjs`.
 */
import { existsSync } from 'node:fs';
import { loadClaims, defaultClaimsPath } from '../claims/load.mjs';
import { computeChangedGate } from '../gate/changed.mjs';
import { scaffoldFile } from '../scaffold/scaffold.mjs';
import { selectFaults, onWritePath, capFor } from '../supply/select.mjs';
import { learnedProductivity } from '../supply/feedback.mjs';
import { loadConcerns, concernById, targetsFor, filterByConcern } from '../supply/concerns.mjs';
import { saveSurface } from '../supply/savepath.mjs';
import { persistenceSignals, persistenceHint, provabilitySummary } from '../supply/persistence.mjs';
import { probe } from '../probe/probe.mjs';
import { discoverDefenders } from '../probe/discover.mjs';
import { hintFor } from '../brief/brief.mjs';

/**
 * Findings first, in the order a reader should act on them. The same order
 * `brief` uses, minus the verdicts a sweep does not gate on.
 */
const FINDING_ORDER = ['survived', 'nocover', 'timeout', 'flaky-defender', 'unverifiable', 'fault-invalid'];

/**
 * Which verdicts are a finding ABOUT THE PROJECT, and so decide the exit code.
 *
 * `survived` and `nocover` are statements about the test suite: something was
 * broken and nothing failed, or nothing imports the file at all. The rest are
 * statements about the PROPOSAL — an anchor that did not locate, a replacement
 * that does not compile — and a sweep's proposals are machine-made and thrown
 * away. Gating on them would make the tool fail because its own guess was bad,
 * which is the fastest way to get a check switched off. They are still
 * reported; they just do not gate.
 */
export const GATING = new Set(['survived', 'nocover']);

/**
 * Turn one evidence record into a finding, or null when it is not one.
 *
 * Pure, and exported, for the reason `classify.mjs` gives about itself: the
 * only thing that could otherwise falsify these rules is a full fixture sweep,
 * which is a minutes-long acceptance test standing in for a decision you can
 * state in four lines. Self-probing this file found exactly that gap — the
 * schema was guarded and the engine that fills it was not.
 *
 * `signalsFor` is injected so the rule about WHEN a signal applies can be
 * tested without a filesystem; the default in `sweep()` reads the defenders.
 */
export function findingFrom(record, fault, signalsFor = () => []) {
  if (record.verdict === 'killed') return null;
  const writePath = fault ? onWritePath(fault) : false;
  // The persistence signal explains a survivor on the write path and nothing
  // else. On a kill it explains nothing, and on any other line a loose mock
  // assertion is not evidence — reporting it everywhere is the
  // non-actionable noise that gets a check switched off.
  const signals = record.verdict === 'survived' && writePath ? signalsFor(record) : [];
  return {
    file: record.subject.file,
    ...(fault?.line ? { line: fault.line } : {}),
    claimId: record.claim.id,
    faultId: record.subject.id,
    faultClass: record.subject.faultClass,
    verdict: record.verdict,
    ...(record.detail?.reason ? { reason: record.detail.reason } : {}),
    description: record.subject.description,
    writePath,
    hint: signals.length ? persistenceHint(signals[0], fault?.find) : hintFor(record),
    ...(signals.length ? { signals } : {}),
  };
}

/** Findings in the order a reader should act on them. Pure; deterministic to the last tie. */
export function sortFindings(findings) {
  return [...findings].sort((a, b) =>
    FINDING_ORDER.indexOf(a.verdict) - FINDING_ORDER.indexOf(b.verdict)
    || Number(b.writePath) - Number(a.writePath)
    || a.file.localeCompare(b.file)
    || (a.line ?? 0) - (b.line ?? 0));
}

/** How many findings a sweep is willing to fail on. */
export const gatingCount = (findings) => findings.filter((f) => GATING.has(f.verdict)).length;

/** A concern named on the command line that this project does not declare. */
export class ConcernError extends Error {}

/** Rebuild claim documents from a flat selection, keeping each claim's own faults together. */
function claimsFromSelection(selected) {
  const byClaim = new Map();
  for (const { claim, fault } of selected) {
    if (!byClaim.has(claim.id)) byClaim.set(claim.id, { ...claim, faults: [] });
    byClaim.get(claim.id).faults.push(fault);
  }
  // Deterministic: the probe's own ordering, and the evidence it writes, must
  // not depend on the order a Map happened to be filled in.
  return [...byClaim.values()]
    .map((c) => ({ ...c, faults: [...c.faults].sort((a, b) => a.id.localeCompare(b.id)) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Run a sweep. Returns the sweep document; the caller owns writing and exit
 * codes, as every other engine module in this tool does.
 */
export async function sweep({
  projectDir,
  ref,
  mode = 'changed',
  concern: concernId,
  concernsPath,
  includeDirty = false,
  exclude = [],
  cap,
  confirmRuns = 3,
  budgetMs = 120_000,
  runnerCommand,
  runnerName,
  nodeModules,
  toolVersion = '0.0.0',
  generatedAt = new Date().toISOString(),
  claimsPath,
  ignorePath,
  onStage,
  onWarn = () => {},
}) {
  const gate = computeChangedGate({ projectDir, ref, includeDirty, exclude, toolVersion, claimsPath, ignorePath });

  // ── What the sweep is pointed at. ──
  // `changed` asks "what did this change leave unclaimed". `save-paths` asks a
  // question the diff cannot: "of every place this project writes to storage,
  // how many would notice if the write stopped carrying a field". The second
  // needs the whole surface, because a clean report over an unstated
  // denominator is a sample of unknown size, not a guarantee.
  //
  // A test file with no claim is a different problem — it has nothing to
  // falsify — and the gate already names it. Sweep proposes against source.
  // `--save-paths` is sugar for the built-in SAVE-PERSISTS concern: the same
  // targets and the same producer selection, named so a project can retune it
  // for an ORM this tool does not recognise without forking anything.
  const loaded = loadConcerns(projectDir, { path: concernsPath });
  const concern = concernId
    ? concernById(loaded.concerns, concernId)
    : mode === 'save-paths' ? concernById(loaded.concerns, 'SAVE-PERSISTS') : null;
  if (concernId && !concern) {
    throw new ConcernError(`unknown concern ${concernId}. Declared: ${loaded.concerns.map((c) => c.id).join(', ')}`);
  }
  const changedTargets = gate.uncovered.filter((u) => u.kind === 'source').map((u) => u.file);
  // A concern whose targets are the diff defers to the gate rather than
  // re-deriving what it already computed.
  const concernTargets = concern ? targetsFor(projectDir, concern, { changedFiles: changedTargets }) : null;
  const usesSurface = concern?.targets?.kind === 'write-sites' || mode === 'save-paths';
  const surface = usesSurface ? saveSurface(projectDir) : null;
  const targets = concernTargets ?? changedTargets;

  const cPath = claimsPath ?? defaultClaimsPath(projectDir);
  const existingClaims = existsSync(cPath) ? loadClaims(cPath) : { claims: [] };

  const candidates = [];
  const skipped = [];
  const drafts = [];
  for (const file of targets) {
    let result;
    try {
      result = scaffoldFile({ projectDir, file, existingClaims, toolVersion });
    } catch (e) {
      // One unscaffoldable file must not take the sweep with it: the other
      // files' findings are still true, and a reader needs to know which file
      // produced nothing and why.
      skipped.push({ file, reason: e.message.split('\n')[0].slice(0, 200) });
      continue;
    }
    if (result.stats.proposals === 0) {
      skipped.push({ file, reason: 'no line in this file matches a fault producer' });
      continue;
    }
    drafts.push(result.doc);
    for (const claim of result.doc.claims) for (const fault of claim.faults) candidates.push({ claim, fault });
  }

  // What the defenders of this surface are CAPABLE of proving, before anything
  // is probed. A test that replaced the database can prove the call shape and
  // never that the row landed, and that limit is a property of the suite rather
  // than of any verdict — so it is measured once, over the whole surface, and
  // reported whether or not a single fault survives.
  const provability = surface
    ? provabilitySummary(projectDir, targets, (f) => discoverDefenders(projectDir, f))
    : null;

  // Order by what THIS project's own runs have shown, not only by what was
  // measured elsewhere. A project that has probed nothing falls back to the
  // shipped prior; one with its own records overrides it in proportion to how
  // many it has. This is the feedback half of Google's 15%-to-89%, using data
  // the project already produced rather than a new thing to collect.
  const learned = learnedProductivity(projectDir);
  // Narrowing is what makes one sentence useful across two hundred files: a
  // persistence concern that also reported every altered return value would
  // bury the payload findings it exists to surface.
  const relevant = filterByConcern(candidates, concern);
  const limit = cap ?? capFor(targets.length);
  const selection = selectFaults(relevant, { cap: limit, table: learned.table });
  const claims = claimsFromSelection(selection.selected);

  let evidence = { records: [] };
  if (claims.length > 0) {
    evidence = await probe({
      projectDir,
      claims: { schemaVersion: 1, claims },
      confirmRuns,
      budgetMs,
      mode: 'worktree',
      includeDirty,
      // A proposed fault has no declared defenders to be missing from, so the
      // question escalation answers — "did something UNDECLARED catch it?" —
      // has no meaning here, and it is the most expensive thing the probe does.
      escalate: false,
      runnerCommand,
      runnerName,
      nodeModules,
      toolVersion,
      onStage,
      onWarn,
    });
  }

  // Index the selection so a record can find the fault it came from without a
  // second scan; `line` and `find` live on the draft, not on the evidence.
  const draftOf = new Map(selection.selected.map(({ claim, fault }) => [`${claim.id}/${fault.id}`, fault]));

  const signalsFor = (r) => persistenceSignals(projectDir, r.defenders?.resolved ?? []);
  const counts = {};
  const findings = [];
  for (const r of evidence.records) {
    counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
    const f = findingFrom(r, draftOf.get(`${r.claim.id}/${r.subject.id}`), signalsFor);
    if (f) findings.push(f);
  }
  const ordered = sortFindings(findings);
  const gating = gatingCount(ordered);
  return {
    schemaVersion: 1,
    tool: { name: 'testguard', version: toolVersion },
    generatedAt,
    ref,
    base: gate.base,
    head: gate.head,
    includeDirty,
    scope: {
      mode,
      ...(concern ? { concern: concern.id } : {}),
      changed: gate.changed,
      ...(surface ? { writeSites: surface.siteCount, payloadFields: surface.keyCount, provability } : {}),
      targets: targets.length,
      swept: drafts.length,
      ...(skipped.length ? { skipped } : {}),
    },
    selection: {
      proposed: relevant.length,
      ...(candidates.length !== relevant.length ? { outOfScope: candidates.length - relevant.length } : {}),
      selected: selection.selected.length,
      deferred: selection.deferred.length,
      cap: selection.cap,
      byClass: selection.byClass,
    },
    counts,
    ordering: { observed: learned.observed, sources: learned.sources },
    // Carried, not written here: the caller owns I/O. Persisting it is what
    // closes the feedback loop — the next sweep learns from these verdicts,
    // which are MACHINE-proposed faults and so the closest observation of the
    // distribution the ranker orders.
    evidence,
    findings: ordered,
    exitCode: gating > 0 ? 1 : 0,
    drafts,
  };
}

/** The sweep as text, for someone who ran it in a terminal or reads it in a CI log. */
export function renderSweep(doc, { limit = 20 } = {}) {
  const out = [];
  const { scope, selection } = doc;
  const saves = scope.mode === 'save-paths';
  if (scope.targets === 0) {
    out.push(saves
      ? 'sweep: no write to storage found in this project. Nothing to propose.'
      : scope.concern
        ? `sweep: concern ${scope.concern} matches no file in this project. Nothing to propose.`
        : `sweep: no changed source file is without a claim against ${doc.ref}. Nothing to propose.`);
    return out.join('\n');
  }
  // The denominator first. A report that lists findings without saying how much
  // was looked at invites the reader to assume the rest is fine.
  // Say how the sweep was aimed. A glob concern that reports "unclaimed changed
  // files" is describing a diff it never looked at.
  out.push(saves
    ? `${scope.writeSites} write${scope.writeSites === 1 ? '' : 's'} to storage across ${scope.targets} file${scope.targets === 1 ? '' : 's'}, carrying ${scope.payloadFields} payload field${scope.payloadFields === 1 ? '' : 's'}. Swept ${scope.swept}.`
    : scope.concern
      ? `concern ${scope.concern} matches ${scope.targets} file${scope.targets === 1 ? '' : 's'}. Swept ${scope.swept}.`
      : `swept ${scope.swept} of ${scope.targets} unclaimed changed file${scope.targets === 1 ? '' : 's'} against ${doc.ref}.`);
  if (saves && scope.provability) {
    // The limit, before any verdict. A test that replaced the database can
    // prove the call shape and never that the row landed, so on a surface
    // defended entirely by such tests a clean probe is not evidence of
    // persistence — it is evidence that nothing could have measured it.
    const { mocked, unmocked, none } = scope.provability;
    out.push(`  of those ${scope.targets} file${scope.targets === 1 ? '' : 's'}: ${mocked} defended only by tests that mock the persistence layer, ${unmocked} with an unmocked defender, ${none} with no defender at all.`);
    if (unmocked === 0 && mocked > 0) {
      out.push('  Nothing in this suite can prove a write reached storage. A mocked test proves the');
      out.push('  call shape; a where-clause that matches nothing, a rolled-back transaction and a');
      out.push('  rejected constraint all pass against it.');
    }
  }
  out.push(`proposed ${selection.proposed} fault${selection.proposed === 1 ? '' : 's'}, probed ${selection.selected} (cap ${selection.cap})${selection.deferred ? `, deferred ${selection.deferred}` : ''}.`);
  if (selection.deferred) out.push(`  The ${selection.deferred} deferred are not a verdict: raise --cap${saves || scope.concern ? '.' : ', or sweep a smaller change.'}`);
  // A narrow concern must not look like a quiet one: the producers found these,
  // and this concern is not about them.
  if (selection.outOfScope) out.push(`  ${selection.outOfScope} further proposal${selection.outOfScope === 1 ? ' was' : 's were'} outside this concern's fault classes.`);
  // An ordering nobody can trace is a number nobody should trust.
  if (doc.ordering) {
    out.push(doc.ordering.observed === 0
      ? '  ordering: the shipped productivity prior — this project has no probed evidence yet.'
      : `  ordering: ${doc.ordering.observed} probed fault${doc.ordering.observed === 1 ? '' : 's'} of this project's own (${doc.ordering.sources.join(', ')}), shrunk toward the shipped prior.`);
  }
  for (const s of scope.skipped ?? []) out.push(`  skipped ${s.file}: ${s.reason}`);
  out.push('');

  const gating = doc.findings.filter((f) => GATING.has(f.verdict));
  if (gating.length === 0) {
    out.push(`No fault survived. ${doc.counts.killed ?? 0} of ${selection.selected} probed faults were caught.`);
  } else {
    out.push(`${gating.length} finding${gating.length === 1 ? '' : 's'} — a deliberate break that no test noticed:`);
    out.push('');
    for (const f of doc.findings.slice(0, limit)) {
      const where = f.line ? `${f.file}:${f.line}` : f.file;
      out.push(`  ${f.verdict.toUpperCase().padEnd(13)} ${where}${f.writePath ? '  [write path]' : ''}`);
      out.push(`    ${f.description}`);
      out.push(`    ${f.hint}`);
      out.push('');
    }
    if (doc.findings.length > limit) out.push(`  … ${doc.findings.length - limit} more in the sweep document`);
  }
  if (saves) {
    out.push('');
    out.push(`This is a sample of the write surface, not a verdict over it: ${selection.selected} of`);
    out.push(`${selection.proposed} proposed faults were probed. The ${scope.writeSites} writes above are the`);
    out.push('denominator — a clean sweep says nothing about the ones nobody pointed a fault at.');
  }
  out.push('These are PROPOSALS, not claims. Keep the ones worth defending: state the');
  out.push('claim, copy its fault into testguard.claims.json, and probe it from then on.');
  return out.join('\n');
}
