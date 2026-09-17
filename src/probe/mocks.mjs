import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { specifierResolvesTo } from './rank.mjs';

/**
 * Mock-awareness for defenders (issues #20, #21).
 *
 * A test file that `vi.mock`s / `jest.mock`s the target cannot detect any
 * fault in it, yet it imports the target, so the import rule would count it
 * as a defender. Two consequences the field reports measured: `nocover`
 * under-reports (a module with eighteen "defenders" that is effectively
 * uncovered) and every probe wastes runs on files that cannot fail. The
 * mocked count is itself the strongest blindness signal.
 *
 * And the cheapest static signal of all: a file that mocks the target and
 * never `expect(...)`s anything from it. That single fact explained the
 * seam behind an escaped bug without injecting anything.
 */

const MOCK_CALL = /\b(?:vi|jest)\.(?:mock|doMock|unstable_mockModule)\(\s*(['"])([^'"]+)\1/g;
const IMPORT_STMT = /import\s+([^'";]+?)\s+from\s*(['"])([^'"]+)\2|import\s*(['"])([^'"]+)\4|(?:const|let|var)\s+([^=;]+?)\s*=\s*(?:await\s+)?(?:require|import)\(\s*(['"])([^'"]+)\7\s*\)/g;
const UNASSERTED = /unasserted:\s*(.+?)\s*(?:\*\/)?\s*$/;

/** The specifiers this source mocks, with their line numbers. */
export function mockSpecifiers(source) {
  const out = [];
  const lines = source.split('\n');
  lines.forEach((text, i) => {
    for (const m of text.matchAll(MOCK_CALL)) out.push({ specifier: m[2], line: i + 1 });
  });
  return out;
}

/** Local names bound to a module specifier by import/require statements. `*` marks a namespace/default object binding. */
function bindingsFor(source, matchesTarget) {
  const names = [];
  for (const m of source.matchAll(IMPORT_STMT)) {
    const spec = m[3] ?? m[5] ?? m[8];
    if (!spec || !matchesTarget(spec)) continue;
    const clause = (m[1] ?? m[6] ?? '').trim();
    if (!clause) continue; // side-effect import
    const ns = /\*\s+as\s+([\w$]+)/.exec(clause);
    if (ns) names.push(ns[1]);
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) for (const part of braces[1].split(',')) { const local = part.trim().split(/\s+as\s+|\s*:\s*/).pop()?.trim(); if (local && /^[\w$]+$/.test(local)) names.push(local); }
    const def = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+[\w$]+/, '').replace(/,/g, '').trim();
    if (def && /^[\w$]+$/.test(def)) names.push(def);
  }
  return [...new Set(names)];
}

/** Does any `expect(...)` argument mention one of the bindings (as an identifier or a member root)? */
function expectMentions(source, bindings) {
  if (bindings.length === 0) return false;
  const re = /\bexpect\s*\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/g;
  for (const m of source.matchAll(re)) {
    const arg = m[1];
    for (const b of bindings) if (new RegExp(`(^|[^\\w$.])${b.replace(/\$/g, '\\$')}(?![\\w$])`).test(arg)) return true;
  }
  return false;
}

/**
 * How one test file relates to one target: does it import it, does it mock it,
 * does it ever assert on what it imported from it, and did the author annotate
 * an unasserted mock with a reason (`// unasserted: <why>` on or above the
 * mock line).
 */
export function analyzeDefender(projectDir, testRel, targetRel) {
  const abs = join(projectDir, testRel);
  let source;
  try {
    source = readFileSync(abs, 'utf8');
  } catch {
    return { file: testRel, imports: false, mocks: false, asserted: false, annotation: null };
  }
  const matchesTarget = (spec) => specifierResolvesTo(projectDir, abs, spec, targetRel);
  const mocks = mockSpecifiers(source).filter((m) => matchesTarget(m.specifier));
  const bindings = bindingsFor(source, matchesTarget);
  const asserted = expectMentions(source, bindings);
  let annotation = null;
  if (mocks.length) {
    const lines = source.split('\n');
    for (const m of mocks) {
      for (let i = m.line - 1; i >= Math.max(0, m.line - 3) && !annotation; i--) {
        const a = UNASSERTED.exec(lines[i]);
        if (a) annotation = a[1];
      }
    }
  }
  return { file: testRel, imports: bindings.length > 0 || matchesTargetAnyImport(source, matchesTarget), mocks: mocks.length > 0, asserted, annotation };
}

function matchesTargetAnyImport(source, matchesTarget) {
  for (const m of source.matchAll(/(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)) if (matchesTarget(m[1])) return true;
  return false;
}

/**
 * Split candidate test files for one target into the ones that can detect a
 * fault in it and the ones that mock it, plus the static signals. A file that
 * mocks the target is never a defender; a mocking file that never asserts on
 * the target carries `mocked-never-asserted`, unless annotated, in which case
 * the annotation is recorded (`unasserted-annotated`) — silenced, never hidden.
 */
export function classifyDefenders(projectDir, targetRel, candidates) {
  const canDetect = [];
  const mocking = [];
  const signals = [];
  for (const file of candidates) {
    const a = analyzeDefender(projectDir, file, targetRel);
    if (a.mocks) {
      mocking.push(file);
      if (!a.asserted) signals.push(a.annotation ? { file, signal: 'unasserted-annotated', reason: a.annotation } : { file, signal: 'mocked-never-asserted' });
    } else {
      canDetect.push(file);
    }
  }
  return { canDetect, mocking, signals };
}
