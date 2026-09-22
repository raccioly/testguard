/**
 * Where this project writes to storage, and what it writes.
 *
 * A probe answers "would a test notice if this were wrong". It cannot answer
 * "how many places write to the database, and how many of those has anyone
 * looked at" — and on an application with two hundred screens that second
 * question is the one that decides whether a clean report means anything. A
 * verdict with no denominator is not a guarantee; it is a sample of unknown
 * size.
 *
 * So this enumerates the surface. Measured on a real AI-authored Next.js
 * application: 115 write sites across 34 source files, of which 46% of the
 * probed persistence faults survived a fully green suite, and every survivor
 * was a field dropped from the payload. The faults are already produced by
 * `field-dropped` and already ranked up by `onWritePath`; what was missing was
 * the list of places to point them at.
 *
 * DELIBERATELY SHALLOW. This finds call sites, not data flow. It does not know
 * whether a write is reachable, whether two writes are the same transaction,
 * or whether a helper wraps one. A site it cannot see is reported as nothing
 * at all rather than as an absence of risk — the same rule the scaffold
 * producers follow, and the reason `skipped` exists on a sweep. Its output is
 * a denominator and a set of targets, never a verdict.
 */
import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { walk } from '../util/glob.mjs';

/**
 * A call that puts data into storage.
 *
 * The receiver is matched by NAME because that is how these layers are bound
 * in practice — `prisma.user.create`, `tx.invitation.upsert`, `db.orders.insertOne`.
 * Matching by import would be more correct and would miss the common case
 * where the client is a module-scope singleton imported under a project alias.
 *
 * `delete` is included: a save path that stops deleting is as broken as one
 * that stops writing, and account deletion is where that matters most.
 */
const WRITE_CALL = /\b(prisma|tx|trx|db|database|knex|sequelize|mongoose|supabase|drizzle|client|conn)\s*\.\s*(?:([A-Za-z_$][\w$]*)\s*\.\s*)?(create|createMany|createOne|update|updateMany|updateOne|upsert|insert|insertOne|insertMany|save|delete|deleteMany|deleteOne|destroy|remove|set|put)\s*\(/g;

/**
 * Raw SQL that writes. A template literal or a string argument, either way.
 *
 * Two regexes for one pattern, deliberately. A `g`-flagged RegExp carries
 * `lastIndex` across calls, so `WRITE_SQL.test(a)` followed by
 * `WRITE_SQL.test(b)` answers the second question from where the first one
 * stopped — which makes a scan's result depend on the order the files were
 * read. `matchAll` needs the flag; the cheap reject must not have it.
 */
const WRITE_SQL = /\b(INSERT\s+INTO|UPDATE\s+[A-Za-z_"`[]|DELETE\s+FROM|UPSERT\s+INTO)\b/gi;
const HAS_SQL = new RegExp(WRITE_SQL.source, 'i');

/**
 * Every operation name the call pattern accepts, as one alternation. Derived
 * rather than written twice: the cheap reject below used a shorter list, and a
 * `deleteMany(` call matched the full pattern while failing the reject, so
 * every file whose only write was a `...Many` or `...One` call was dropped
 * from the surface before it was ever scanned.
 */
const OPERATIONS = 'create|createMany|createOne|update|updateMany|updateOne|upsert|insert|insertOne|insertMany|save|delete|deleteMany|deleteOne|destroy|remove|set|put';
const HAS_WRITE_CALL = new RegExp(`\\b(?:${OPERATIONS})\\s*\\(`);

/**
 * Files that contain writes but are never the product's own save path.
 *
 * Seed and migration scripts write, and a real run surfaced
 * `prisma/seed-badges.ts` as NOCOVER — true, and not a finding: nobody tests a
 * seed script, and reporting it teaches the reader to skim. The directory
 * forms are matched as well as the file stems, because a seed lives in
 * `prisma/seed.ts` as often as in `seeds/`.
 */
const NOT_SOURCE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(tests?|__tests__|__mocks__|__fixtures__|fixtures|migrations|seeds?|scripts?|prisma|drizzle)\/|(^|\/)seeds?[.-][^/]*$|(^|\/)seeds?\.[cm]?[jt]sx?$/;

const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']);

/**
 * The text of one call's arguments, from its open parenthesis to the matching
 * close, with quotes tracked so a parenthesis inside a string is not counted.
 *
 * The same scan `payloadAssertions` uses, and for the same reason: a
 * fixed-width window reads into the NEXT call, and on a file with several
 * writes in a row that silently attributes one write's payload to another.
 */
export function balancedArgs(source, open) {
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
      if (depth === 0) return { start: open + 1, end: i, text: source.slice(open + 1, i) };
    }
  }
  return { start: open + 1, end: source.length, text: source.slice(open + 1) };
}

/**
 * The keys of a write's payload, each with the line it sits on.
 *
 * Both property forms, because shorthand is not an edge case here: every
 * surviving payload fault measured on the register action was shorthand
 * (`email,` `username,` `password_hash,`). A pattern requiring a colon would
 * miss exactly the fields this exists to find.
 *
 * Keys are read only where they sit on their own line, which is what the
 * `field-dropped` producer can anchor to. A single-line write like
 * `update({ where, data })` therefore reports no keys — correctly, because
 * there is no line to delete.
 */
export function payloadKeys(argsText, firstLine) {
  const keys = [];
  argsText.split('\n').forEach((line, i) => {
    const m = /^\s*(?:['"`])?([A-Za-z_$][\w$]*)(?:['"`])?\s*(?::|,\s*$)/.exec(line);
    if (m) keys.push({ key: m[1], line: firstLine + i });
  });
  return keys;
}

/** Line number (1-based) of an index into a source string. */
const lineAt = (source, index) => source.slice(0, index).split('\n').length;

/**
 * Every write this file performs. Pure apart from the read; exported so the
 * shape can be tested against a string without a project on disk.
 */
export function writeSitesIn(source, file) {
  const sites = [];
  for (const m of source.matchAll(WRITE_CALL)) {
    const open = m.index + m[0].length - 1;
    const args = balancedArgs(source, open);
    const line = lineAt(source, m.index);
    sites.push({
      file,
      line,
      endLine: lineAt(source, args.end),
      receiver: m[1],
      model: m[2] ?? null,
      operation: m[3],
      keys: payloadKeys(args.text, lineAt(source, args.start)),
    });
  }
  for (const m of source.matchAll(WRITE_SQL)) {
    sites.push({
      file,
      line: lineAt(source, m.index),
      endLine: lineAt(source, m.index),
      receiver: 'sql',
      model: null,
      operation: m[1].split(/\s+/)[0].toLowerCase(),
      keys: [],
    });
  }
  // Deterministic: a surface that reorders between runs is not a denominator.
  return sites.sort((a, b) => a.line - b.line || a.operation.localeCompare(b.operation));
}

/** Is this path part of the product's own save surface? */
export const isSaveSource = (rel) => SOURCE_EXT.has(extname(rel)) && !NOT_SOURCE.test(rel);

/**
 * The project's whole write surface: every source file that writes, and every
 * write in it.
 *
 * `files` may be given to scope the scan (a diff, a directory); the default is
 * every source file the glob walker can see.
 */
export function saveSurface(projectDir, { files } = {}) {
  const candidates = (files ?? walk(projectDir)).filter(isSaveSource);
  const byFile = [];
  let siteCount = 0;
  let keyCount = 0;
  for (const rel of candidates) {
    let source;
    try {
      source = readFileSync(join(projectDir, rel), 'utf8');
    } catch {
      continue;
    }
    // Cheap reject before the balanced scan: most files never write.
    if (!HAS_WRITE_CALL.test(source) && !HAS_SQL.test(source)) continue;
    const sites = writeSitesIn(source, rel);
    if (!sites.length) continue;
    byFile.push({ file: rel, sites });
    siteCount += sites.length;
    keyCount += sites.reduce((a, s) => a + s.keys.length, 0);
  }
  byFile.sort((a, b) => a.file.localeCompare(b.file));
  return { files: byFile, fileCount: byFile.length, siteCount, keyCount };
}

/**
 * The surface as text — the denominator, said out loud.
 *
 * A report that lists findings without saying how much was looked at invites
 * the reader to assume the rest is fine, which is the assumption this whole
 * tool exists to remove.
 */
export function renderSurface(surface, { limit = 10 } = {}) {
  if (surface.fileCount === 0) return 'no write to storage found in this project.';
  const out = [`${surface.siteCount} write${surface.siteCount === 1 ? '' : 's'} to storage across ${surface.fileCount} file${surface.fileCount === 1 ? '' : 's'}, carrying ${surface.keyCount} payload field${surface.keyCount === 1 ? '' : 's'} on their own lines.`];
  const ranked = [...surface.files].sort((a, b) => b.sites.length - a.sites.length || a.file.localeCompare(b.file));
  for (const f of ranked.slice(0, limit)) {
    const ops = [...new Set(f.sites.map((s) => s.operation))].sort().join(', ');
    out.push(`  ${String(f.sites.length).padStart(3)}  ${f.file}  (${ops})`);
  }
  if (ranked.length > limit) out.push(`  … ${ranked.length - limit} more files`);
  return out.join('\n');
}
