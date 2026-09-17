import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { proposalsForLine, functionHead, functionParams } from './producers.mjs';
import { locate } from '../probe/inject.mjs';
import { discoverDefenders } from '../probe/discover.mjs';
import { validate } from '../../spec/lib/validate.mjs';

const ANNOTATION = /@claim\s+([A-Za-z0-9]+(?:[._]?[A-Za-z0-9]+)*-[A-Za-z0-9._-]*[A-Za-z0-9])\b/;
// field-dropped is never proposed inside tests, fixtures or migrations: an
// object literal there is data, not a payload the product writes.
const NO_FIELD_DROPS = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|__fixtures__|__mocks__|fixtures|migrations)\//;

const idPart = (s) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toUpperCase();

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

  let offset = 0;
  let fn = null;
  let fnDepth = 0;
  let params = new Set();
  const fieldDrops = !NO_FIELD_DROPS.test(file);
  let depth = 0;
  let pendingAnnotation = null;
  const proposals = [];
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
      const find = line;
      const { hits, occurrence } = anchorFor(source, find, offset);
      const fault = { ...p, find, replace: p.replace, expectHits: hits, occurrence, line: i + 1, fn, annotation: pendingAnnotation };
      if (locate(source, fault).status !== 'ok') continue; // never propose an anchor that would be unverifiable
      proposals.push(fault);
    }

    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (fn && depth <= fnDepth && !head) { fn = null; params = new Set(); }
    if (pendingAnnotation && !ann && !head && line.trim() && !/^\s*(\/\/|\*|\/\*)/.test(line)) pendingAnnotation = null;
    offset += line.length + 1;
  });

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
