import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { proposalsForLine, functionHead, functionParams } from './producers.mjs';
import * as py from './producers.python.mjs';
import { locate } from '../probe/inject.mjs';
import { discoverDefenders } from '../probe/discover.mjs';
import { validate } from '../../spec/lib/validate.mjs';

const ANNOTATION = /@claim\s+([A-Za-z0-9]+(?:[._]?[A-Za-z0-9]+)*-[A-Za-z0-9._-]*[A-Za-z0-9])\b/;
// field-dropped is never proposed inside tests, fixtures or migrations: an
// object literal there is data, not a payload the product writes.
const NO_FIELD_DROPS = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|__fixtures__|__mocks__|fixtures|migrations)\//;
// Python names its tests by file rather than by a dotted suffix, so the JS
// rule would not recognise one. Kept separate so adding Python cannot quietly
// change which proposals a JavaScript file gets.
const NO_FIELD_DROPS_PY = /(^|\/)(test[^/]*\.py|[^/]*_test\.py|conftest\.py)$|(^|\/)(tests?|__fixtures__|fixtures|migrations)\//;

const idPart = (s) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toUpperCase();

const isPython = (file) => file.endsWith('.py');

/**
 * JavaScript line scan: enclosing function tracked by brace depth, `@claim`
 * annotations read from `//` and `/* *\u002f` comments.
 */
function scanJs({ source, lines, fieldDrops, keep, anchor }) {
  const proposals = [];
  let offset = 0;
  let fn = null;
  let fnDepth = 0;
  let params = new Set();
  let depth = 0;
  let pendingAnnotation = null;
  lines.forEach((line, i) => {
    const ann = ANNOTATION.exec(line);
    if (ann && /^\s*(\/\/|\*|\/\*)/.test(line)) pendingAnnotation = ann[1];

    const head = functionHead(line);
    if (head) {
      fn = head;
      fnDepth = depth;
      params = new Set(functionParams(line));
    }

    for (const p of proposalsForLine(lines, i, { params, fieldDrops })) {
      const { hits, occurrence } = anchor(line, offset);
      const fault = { ...p, find: line, replace: p.replace, expectHits: hits, occurrence, line: i + 1, fn, annotation: pendingAnnotation };
      if (keep(fault)) proposals.push(fault); // never propose an unverifiable anchor or a no-op
    }

    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (fn && depth <= fnDepth && !head) { fn = null; params = new Set(); }
    if (pendingAnnotation && !ann && !head && line.trim() && !/^\s*(\/\/|\*|\/\*)/.test(line)) pendingAnnotation = null;
    offset += line.length + 1;
  });
  return proposals;
}

/**
 * Python line scan. Scope is indentation, not braces, and it must be read
 * BEFORE the line is attributed: a line dedented out of a function belongs to
 * whatever follows, not to the function that just ended. `@claim` annotations
 * are read from `#` comments.
 */
function scanPython({ source, lines, fieldDrops, keep, anchor }) {
  const proposals = [];
  let offset = 0;
  let fn = null;
  let fnIndent = 0;
  let params = new Set();
  let pendingAnnotation = null;
  lines.forEach((line, i) => {
    const indent = py.indentOf(line);
    if (fn !== null && indent !== null && indent <= fnIndent) { fn = null; params = new Set(); }

    const ann = ANNOTATION.exec(line);
    if (ann && py.isComment(line)) pendingAnnotation = ann[1];

    const head = py.functionHead(line);
    if (head) {
      fn = head;
      fnIndent = indent ?? 0;
      params = new Set(py.functionParams(line));
    }

    for (const p of py.proposalsForLine(lines, i, { params, fieldDrops })) {
      const { hits, occurrence } = anchor(line, offset);
      const fault = { ...p, find: line, replace: p.replace, expectHits: hits, occurrence, line: i + 1, fn, annotation: pendingAnnotation };
      if (keep(fault)) proposals.push(fault); // as scanJs: unverifiable anchors and no-ops never reach the draft
    }

    if (pendingAnnotation && !ann && !head && line.trim() && !py.isComment(line)) pendingAnnotation = null;
    offset += line.length + 1;
  });
  return proposals;
}

/**
 * May this proposal reach the draft?
 *
 * Two reasons it may not, and they are different failures. An anchor that does
 * not locate is UNVERIFIABLE: the fault could not be injected, so probing it
 * would say nothing. A replacement equal to its find is a NO-OP: the schema
 * rejects it outright, so a single one aborts the whole file — a 725-line
 * source was unscaffoldable because of one `expired: 0`.
 *
 * Producers refuse their own fixed points where they know the arithmetic (see
 * the literal shapes in producers.mjs), which is what keeps a real fault for a
 * zero-valued window instead of silently dropping it. This is the backstop that
 * makes the rule structural rather than remembered, so a producer added later
 * cannot reintroduce the crash. It is exported because a guard nothing can
 * exercise is a guard nobody can prove: no current producer emits a fixed
 * point, so this predicate is the only place the invariant is observable.
 */
export function usableProposal(source, fault) {
  if (fault.replace === fault.find) return false;
  return locate(source, fault).status === 'ok';
}

/** How many times `find` occurs, and which occurrence the line at `offset` is. */
function anchorFor(source, find, offset) {
  let hits = 0;
  let occurrence = 0;
  let i = -1;
  while ((i = source.indexOf(find, i + 1)) !== -1) {
    hits++;
    if (i === offset) occurrence = hits;
  }
  return { hits, occurrence };
}

/**
 * Scan one source file and produce a DRAFT claims document: every proposal is
 * an exact-line anchor that `locate()` accepts, grouped by enclosing function
 * (or by a preceding `@claim <ID>` annotation, or entirely under `claimId`),
 * with `producedBy: { producer: "derived" }` and TODO statements a human must
 * replace. Never touches the real claims file.
 */
export function scaffoldFile({ projectDir, file, claimId, existingClaims, toolVersion = '0.0.0' }) {
  const source = readFileSync(join(projectDir, file), 'utf8');
  const lines = source.split('\n');
  const stem = idPart(basename(file, extname(file)));
  const producedBy = { producer: 'derived', by: `testguard scaffold ${toolVersion}` };

  const groups = new Map(); // key → { id, proposals[] , annotated }
  const groupFor = (key, id) => {
    if (!groups.has(key)) groups.set(key, { id, proposals: [] });
    return groups.get(key);
  };

  const fieldDrops = !(isPython(file) ? NO_FIELD_DROPS_PY : NO_FIELD_DROPS).test(file);
  const scan = isPython(file) ? scanPython : scanJs;
  const proposals = scan({ source, lines, fieldDrops, keep: (fault) => usableProposal(source, fault), anchor: (find, offset) => anchorFor(source, find, offset) });

  const existing = new Map((existingClaims?.claims ?? []).map((c) => [c.id, c]));
  const usedIds = new Set();
  for (const p of proposals) {
    const key = claimId ? '__all__' : p.annotation ?? p.fn ?? '__file__';
    let id = claimId ?? p.annotation ?? `${stem}-${p.fn ? idPart(p.fn) : 'FILE'}`;
    groupFor(key, id).proposals.push(p);
  }

  const defendedBy = discoverDefenders(projectDir, file);
  const claims = [];
  for (const g of groups.values()) {
    let id = g.id;
    while (usedIds.has(id)) id += '-2';
    usedIds.add(id);
    const base = existing.get(id);
    const fnLabel = g.proposals[0].fn ? `\`${g.proposals[0].fn}\`` : 'this file';
    const claim = {
      id,
      statement: base?.statement ?? `TODO: state what ${fnLabel} in ${file} guarantees (${g.proposals.length} proposed fault${g.proposals.length === 1 ? '' : 's'}; keep or drop each)`,
      source: base?.source ?? { kind: 'manual', ref: `testguard scaffold ${file}` },
      severity: base?.severity ?? 'medium',
      producedBy: base?.producedBy ?? producedBy,
      ...(base?.defendedBy?.length ? { defendedBy: base.defendedBy } : defendedBy.length ? { defendedBy } : {}),
      faults: g.proposals.map((p, n) => ({
        id: `S${n + 1}`,
        description: `[line ${p.line}] ${p.description}`,
        faultClass: p.faultClass,
        file,
        find: p.find,
        replace: p.replace,
        ...(p.expectHits > 1 ? { expectHits: p.expectHits, occurrence: p.occurrence } : {}),
        producedBy,
      })),
      ...(base?.tags ? { tags: base.tags } : {}),
    };
    claims.push(claim);
  }

  const doc = { $schema: './node_modules/testguard-cli/spec/schemas/claims.schema.json', schemaVersion: 1, claims };
  const result = validate('claims', doc);
  if (!result.ok) throw new Error(`scaffold produced a non-conforming draft:\n${result.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);

  const byClass = {};
  for (const p of proposals) byClass[p.faultClass] = (byClass[p.faultClass] ?? 0) + 1;
  return { doc, stats: { proposals: proposals.length, claims: claims.length, byClass, defendedBy } };
}
