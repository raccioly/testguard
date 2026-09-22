/**
 * Which drafted faults are worth probing, and in what order.
 *
 * `scaffold` proposes mechanically and proposes a lot: eight source files of a
 * real application yielded 238 proposals. Probing all of them is the cost model
 * the tool already refuses — `(baseline + faults x N) x defender-set cost`,
 * per claim — so a sweep that probes everything is a sweep nobody runs twice.
 *
 * Google's mutation service solved the same problem by never surfacing more
 * than 7 x |files| mutants per change and by ordering candidates on the
 * measured productivity of their operator in similar context, which took their
 * productive rate from 15% to 89% ("Practical Mutation Testing at Scale",
 * Petrovic et al., 2021). This module is that idea at this tool's scale.
 *
 * TWO THINGS IT MUST NOT DO. It must not drop a candidate silently — a cap
 * that hides work is a coverage claim nobody made, so everything not selected
 * is returned as `deferred` and the caller is expected to say so. And it must
 * not be nondeterministic: the same drafts in the same repository must select
 * the same faults in the same order, or a sweep's output stops being evidence.
 * Every tie therefore breaks on file, then line, then id.
 *
 * Pure: drafts in, a selection out. Nothing here reads a file or runs anything.
 */

/**
 * P(a fault of this class survives a green suite), measured — not guessed.
 *
 * From 56 probed faults across 12 modules of a real AI-authored Next.js
 * application (2026-09-21). Survival is the right prior for ordering because a
 * fault that dies everywhere teaches nobody anything: the whole output of a
 * sweep is the faults that lived.
 *
 * `n` is carried so a reader can see which of these is one observation and
 * which is twelve, and so a later feedback pass can weight them honestly
 * instead of treating 100%-of-one as certainty.
 */
export const MEASURED_PRODUCTIVITY = Object.freeze({
  'element-removed': { p: 1.0, n: 1 },
  'call-removed': { p: 0.67, n: 3 },
  'field-dropped': { p: 0.5, n: 12 },
  'statement-deleted': { p: 0.33, n: 12 },
  'literal-changed': { p: 0.33, n: 3 },
  'condition-forced': { p: 0.1, n: 10 },
  'argument-swapped': { p: 0.09, n: 11 },
  'return-altered': { p: 0.0, n: 4 },
});

/**
 * A class nobody measured is worth more attention than the worst measured one
 * and less than the best. Ranking it last would make every new producer
 * invisible until someone hand-edited this table; ranking it first would let a
 * new producer crowd out everything known to be productive.
 */
const UNMEASURED = 0.4;

/**
 * Shrink a small sample toward the unmeasured prior. One observation of
 * `element-removed` is not evidence that it always survives, and ordering the
 * whole sweep on it would be exactly the overconfidence this tool exists to
 * refuse. m is the pseudo-count: at n = m the measurement and the prior weigh
 * the same.
 */
const M = 4;
export function priorFor(faultClass, table = MEASURED_PRODUCTIVITY) {
  const hit = table[faultClass];
  if (!hit) return UNMEASURED;
  return (hit.p * hit.n + UNMEASURED * M) / (hit.n + M);
}

/**
 * The write payload of a persisted record is where this project's own
 * measurement found every survivor: 12 of 12 were a field dropped from a
 * `data` / `where` / `update` object reaching a database call. A fault on such
 * a line is worth more than its class alone says, because the assertion that
 * would have to catch it is the one tests most often write loosely
 * (`expect.objectContaining({...})` naming everything except the field that
 * carried the data).
 *
 * Deliberately a line-shape test, not a type-aware one: the scaffold producers
 * are line-oriented and this must not become the one part of the pipeline that
 * needs an AST.
 */
const PERSISTENCE_CALL = /\b(?:prisma|db|tx|trx|knex|sequelize|mongoose|supabase|drizzle)\b\s*[.[]|\.(?:create|createMany|update|updateMany|upsert|insert|save|delete|deleteMany|destroy)\s*\(/;
const PAYLOAD_KEY = /^\s*(?:data|where|update|create|select|set|values)\s*:/;

/** Is this fault on the persistence path — a write call, or a field of its payload? */
export function onWritePath(fault) {
  const line = fault.find ?? '';
  return PERSISTENCE_CALL.test(line) || PAYLOAD_KEY.test(line) || PERSISTENCE_CALL.test(fault.description ?? '');
}

/**
 * Is this proposal a purely presentational JSX element — the arid class this
 * tool actually has?
 *
 * Google suppresses "arid" nodes nobody would write a test for (logging,
 * timeouts, flags). Measured here on 2026-09-22, those account for under 1% of
 * proposals: the producers are shape-targeted and rarely land on a log line.
 * What IS material is this: on a 14-file UI diff, 150 of 510 proposals were an
 * `element-removed` on an icon (`<X />`) or a static wrapper (`<div>`, `<p>`
 * with no expression and no handler). The ranker spent 29 of 30 slots on that
 * class, 7 of the 10 survivors were of this shape, and because the ordering
 * learns from survival those survivors then teach it to rank the class higher.
 *
 * Line-oriented, like every producer. An icon is a self-closing PascalCase
 * element whose props are only sizing and styling; a static wrapper is a
 * layout or text tag whose own line carries no `{expression}` and no
 * interactive or test-facing attribute. Anything else — a component, an
 * `<img>`, a `<label>`, an element with a handler or dynamic children — is a
 * real proposal and stays.
 */
const ICON_ELEMENT = /^\s*<[A-Z]\w*(?:\s+(?:size|className|strokeWidth|aria-hidden|color|width|height|fill)(?:=(?:"[^"]*"|\{[^}]*\}))?)*\s*\/>\s*$/;
const WRAPPER_ELEMENT = /^\s*<(?:div|span|p|h[1-6]|section|header|footer|main|nav|ul|ol|li|small|strong|em|b|i|hr|br)\b/;
const INTERACTIVE_ATTR = /\b(?:on[A-Z]\w*=|href=|role=|aria-(?!hidden)\w+=|data-testid=|htmlFor=|tabIndex=)/;
export function presentational(fault) {
  if (fault.faultClass !== 'element-removed') return false;
  const line = fault.find ?? '';
  return ICON_ELEMENT.test(line) || (WRAPPER_ELEMENT.test(line) && !line.includes('{') && !INTERACTIVE_ATTR.test(line));
}

/** The boost a write-path fault gets. Additive, not multiplicative: it must not be able to overtake a measured 1.0. */
const WRITE_PATH_BONUS = 0.25;

/** What one draft is worth probing, in [0, 1.25]. Exported so a test can pin the ordering rule rather than the order. */
export function scoreOf(fault, { table } = {}) {
  return priorFor(fault.faultClass, table) + (onWritePath(fault) ? WRITE_PATH_BONUS : 0);
}

/**
 * Google surfaces at most 7 x |files| mutants per change. The number is theirs
 * and the reason is general: past it the reader stops reading, and a finding
 * nobody reads is worse than no finding, because it also spends the runner.
 */
export const capFor = (fileCount, perFile = 7) => Math.max(perFile, fileCount * perFile);

/**
 * Order every candidate and take the cap.
 *
 * `candidates` are `{ claim, fault }` pairs — the claim is carried so the
 * caller can rebuild a claims document from the selection without a second
 * lookup. Returns the selection, everything deferred, everything set aside as
 * presentational, and the per-class tally a report needs to explain itself.
 * The three lists partition the candidates: nothing is dropped without a name.
 */
export function selectFaults(candidates, { cap, table } = {}) {
  const limit = Number.isInteger(cap) && cap > 0 ? cap : capFor(new Set(candidates.map((c) => c.fault.file)).size);
  const all = candidates.map((c) => ({ ...c, score: scoreOf(c.fault, { table }), writePath: onWritePath(c.fault) }));
  // Set aside, never silently: a presentational element is not worth a probe
  // run, and a survivor on one would teach the ordering the wrong lesson.
  const presentationalList = all.filter((c) => presentational(c.fault));
  const ranked = all.filter((c) => !presentational(c.fault))
    // Deterministic to the last tie: score, then file, then line, then id.
    // Two runs of the same sweep on the same tree are the same sweep.
    .sort((a, b) =>
      b.score - a.score
      || (a.fault.file ?? '').localeCompare(b.fault.file ?? '')
      || (a.fault.line ?? 0) - (b.fault.line ?? 0)
      || `${a.claim.id}/${a.fault.id}`.localeCompare(`${b.claim.id}/${b.fault.id}`));

  // ── Spread the cap across FILES, best-first within each. ──
  // Taking the global top N looks right and is not: a file with many
  // high-scoring lines takes the whole budget and every other changed file is
  // reported as having no findings, which is indistinguishable from having
  // none. Measured — the first sweep of a 14-file change spent all six slots
  // on one page component and said nothing about the other twelve.
  // The cap is already expressed per file (7 x |files|), so this is what that
  // number was always supposed to mean.
  const byFile = new Map();
  for (const r of ranked) {
    const key = r.fault.file ?? '';
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(r);
  }
  // Files in the order of their best candidate, so a round that cannot serve
  // everyone still serves the most promising files first. Ties on file name.
  const queues = [...byFile.entries()]
    .sort((a, b) => b[1][0].score - a[1][0].score || a[0].localeCompare(b[0]))
    .map(([, q]) => q);

  const selected = [];
  for (let round = 0; selected.length < limit; round++) {
    let served = false;
    for (const q of queues) {
      if (q.length <= round) continue;
      selected.push(q[round]);
      served = true;
      if (selected.length >= limit) break;
    }
    if (!served) break;
  }
  const taken = new Set(selected);
  const deferred = ranked.filter((r) => !taken.has(r));
  const byClass = {};
  for (const r of all) {
    const e = (byClass[r.fault.faultClass] ??= { proposed: 0, selected: 0, writePath: 0 });
    e.proposed += 1;
    if (r.writePath) e.writePath += 1;
  }
  for (const r of selected) byClass[r.fault.faultClass].selected += 1;
  return { selected, deferred, presentational: presentationalList, cap: limit, byClass };
}
