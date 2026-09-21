/**
 * The save-button signal: why a fault on the persistence path survived.
 *
 * `mocks.mjs` answers "does this test replace the SUBJECT?", and a file that
 * does cannot detect any fault in it. This is the other half, and it is the
 * one that explains a green suite over a save that does not save. Such a test
 * does NOT mock the subject — it mocks the persistence layer underneath it —
 * so it is a legitimate defender and stays one. It can catch a deleted write.
 * What it cannot catch is a wrong PAYLOAD, and only because of how it asserts.
 *
 * Measured on a real AI-authored Next.js application (2026-09-21): 10 of 10
 * server-action tests mocked `@/lib/prisma`, and 12 of 12 surviving faults on
 * the persistence path were a field dropped from a `data` / `where` object.
 * The assertion that should have caught them was `toHaveBeenCalledWith(
 * expect.objectContaining({...}))` naming every field except the one carrying
 * the data — the pathology this project's README reports from the field.
 *
 * DESCRIPTIVE, NOT PREDICTIVE — and that is a correction the measurement
 * forced. The first version of this file silenced itself when a test contained
 * any exact payload assertion. On the same 26 probed faults that rule fired on
 * 1 of 10 files while 4 had survivors, because a file asserts many calls and
 * the one exact assertion is usually about something else:
 * `identity-password-recovery.test.ts` has one exact assertion among forty and
 * every one of its payload faults survived, while `contact.test.ts` has the
 * same one exact assertion and none did. No file-level threshold separates
 * those two, so this reports the SHAPE and refuses to score it.
 *
 * It is therefore attached to a verdict the probe already reached, never used
 * to predict one or to select what gets probed. The probe says a fault
 * survived; this says the structural reason and what to write instead.
 *
 * Line- and regex-oriented, like the scaffold producers: no AST, no type
 * information, and an honest miss rather than a confident wrong claim. In
 * particular there is no read-back detection here. A regex for "the test asked
 * for the row again" matched every file that mocks `findUnique` and asserts
 * anything, including files whose payload faults all survived, so it measured
 * nothing and was removed rather than shipped as a silencer.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Module specifiers that mean "the database". A project-local path counts when
 * it names one of these — `@/lib/prisma`, `../db`, `~/server/drizzle` — which
 * is how these layers are named in practice.
 */
const PERSISTENCE_SPECIFIER = /(?:^|[/@~.])(?:prisma|db|database|knex|sequelize|mongoose|typeorm|drizzle|supabase|pg|mysql2?|sqlite3?|dynamodb|mongodb)(?:$|[/.])/i;

/** `vi.mock('x')` / `jest.mock('x')` — the same call shapes mocks.mjs reads. */
const MOCK_CALL = /\b(?:vi|jest)\.(?:mock|doMock|unstable_mockModule)\(\s*(['"])([^'"]+)\1/g;

/** Partial matchers: true of a subset, so a dropped field outside the subset passes. */
const PARTIAL_MATCHER = /expect\.(?:objectContaining|arrayContaining|any|anything|stringContaining|stringMatching)\s*\(/;

/** The persistence specifiers this source mocks, with line numbers. */
export function persistenceMocks(source) {
  const out = [];
  source.split('\n').forEach((text, i) => {
    for (const m of text.matchAll(MOCK_CALL)) {
      if (PERSISTENCE_SPECIFIER.test(m[2])) out.push({ specifier: m[2], line: i + 1 });
    }
  });
  return out;
}

/**
 * The text between an open parenthesis at `open` and its match, so one
 * assertion's arguments are read without reading the next one's.
 *
 * A fixed-width window cannot do this: two assertions on adjacent lines put the
 * second one's `expect.objectContaining` inside the first one's window, and
 * every exact assertion in a dense test file is reported as partial. Measured —
 * the first version of this scored a file with one exact and one partial
 * assertion as two partials.
 *
 * Quotes are tracked because a parenthesis inside a string is not a
 * parenthesis; anything unbalanced returns what it read, which errs toward
 * reporting a partial matcher that is really there.
 */
function balancedArgs(source, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open + 1);
}

/**
 * How this source asserts on its mocks: how many assertions name the exact
 * arguments, how many name them only partially, and how many assert that a
 * call happened without saying with what.
 *
 * Counting rather than deciding. The counts go into the reason string so a
 * reader can disagree with the inference instead of only with a verdict.
 */
export function payloadAssertions(source) {
  let exact = 0;
  let partial = 0;
  let argless = 0;
  for (const m of source.matchAll(/\.toHaveBeenCalledWith\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    if (PARTIAL_MATCHER.test(balancedArgs(source, open))) partial += 1;
    else exact += 1;
  }
  for (const _ of source.matchAll(/\.(?:toHaveBeenCalled|toHaveBeenCalledTimes|toHaveBeenCalledOnce)\s*\(/g)) argless += 1;
  return { exact, partial, argless };
}

/**
 * The shape of one defender's relationship to the persistence layer, or null
 * when it does not mock one. Shaped like the records `mocks.mjs` produces so a
 * caller can merge the two lists without reshaping either.
 */
export function analyzePersistence(projectDir, testRel) {
  let source;
  try {
    source = readFileSync(join(projectDir, testRel), 'utf8');
  } catch {
    return null;
  }
  const mocks = persistenceMocks(source);
  if (mocks.length === 0) return null;
  const counts = payloadAssertions(source);
  const specifiers = [...new Set(mocks.map((m) => m.specifier))].sort();
  const shape = [
    counts.exact ? `${counts.exact} exact` : '',
    counts.partial ? `${counts.partial} partial` : '',
    counts.argless ? `${counts.argless} argument-free` : '',
  ].filter(Boolean).join(', ') || 'no';
  return {
    file: testRel,
    signal: 'persistence-payload-unasserted',
    reason: `mocks ${specifiers.join(', ')}; ${shape} call assertion${counts.exact + counts.partial + counts.argless === 1 ? '' : 's'} in the file. A field dropped from the write payload fails only against an assertion that names that field exactly.`,
    counts,
    specifiers,
  };
}

/**
 * The signal for a claim's defenders. Only ever consulted for a SURVIVOR whose
 * fault is on the persistence path: on a kill it explains nothing, and on any
 * other line a loose mock assertion is not evidence of anything. Reporting it
 * everywhere would be the non-actionable noise that gets a check switched off.
 */
export function persistenceSignals(projectDir, defenders) {
  return defenders.map((d) => analyzePersistence(projectDir, d)).filter(Boolean);
}

/**
 * One line an agent can act on, in the register `hintFor()` uses.
 *
 * The field name is read from either property form. Shorthand is not an edge
 * case here: every surviving payload fault measured on the register action was
 * shorthand — `email,` `username,` `password_hash,` — so a pattern that only
 * matched `name: value` would fail to name the field in exactly the cases that
 * prompted this signal.
 */
export function persistenceHint(signal, faultLine) {
  const field = /^\s*([A-Za-z_$][\w$]*)\s*(?::|,\s*$)/.exec(faultLine ?? '')?.[1];
  return `${signal.file} ${signal.reason} Assert the whole object written by the call this fault changes${field ? `, including \`${field}\`` : ''} — or read the record back and assert on what was stored.`;
}
