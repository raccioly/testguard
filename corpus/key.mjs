#!/usr/bin/env node
/**
 * Builds a subject's answer key, `expected.json`, from two committed inputs:
 *
 *   provenance/judgments.json   the verdicts, written by hand, each with why
 *   provenance/derivation.json  what `node corpus/derive.mjs` observed (no TestGuard)
 *   provenance/derivation-reuse-edit.json  the same, with the reuse edit applied
 *
 * Every keyed fault must have an observation, every observation a judgment,
 * and each entry carries the command that was run, a one-line summary of the
 * runs and the observation's output hash. The judgment is never computed: a
 * person wrote it. `--check` fails when the committed expected.json differs.
 *
 * Changing a key is its own reviewed commit that says which of {tool, claim,
 * subject} was wrong, and is never made in a commit that changes src/.
 *
 * usage: node corpus/key.mjs <subject-dir>... [--check]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const g = (r) => (r.timedOut ? 'T' : r.loadError ? 'L' : Object.values(r.tests).some((v) => v.startsWith('fail')) ? 'R' : 'G');

function summarize(o) {
  if (o.anchor.hits !== o.anchor.expectHits) return `anchor: ${o.anchor.hits} hits, expected ${o.anchor.expectHits}`;
  if (!o.defenders?.declared?.length) return `no defendedBy; test files naming the target: ${JSON.stringify(o.defenders?.candidatesNamingTarget ?? [])}`;
  const parts = [`baseline ${o.baseline.map(g).join('')}`];
  if (o.typecheck) parts.push(`tsc exit ${o.typecheck.exit}`);
  if (o.probe) parts.push(`probe ${o.probe.map(g).join('')}`);
  if (o.negativeControl) parts.push(`negative control ${g(o.negativeControl) === 'G' ? 'green' : 'red'}`);
  if (o.wholeSuiteFailingEveryRun) parts.push(`whole suite: ${o.wholeSuiteFailingEveryRun.length} test(s) fail every run`);
  return parts.join('; ');
}

function attach(entries, observations, label) {
  const byId = new Map(observations.records.map((r) => [r.fault, r]));
  const out = {};
  for (const [id, e] of Object.entries(entries)) {
    const o = byId.get(id);
    if (!o) throw new Error(`${label}: judgment for ${id} has no observation`);
    if (o.restored === false) throw new Error(`${label}: ${id} was not restored during derivation`);
    out[id] = { ...e, derivation: { commands: o.commands ?? null, observed: summarize(o), outputHash: o.outputHash, derivedAt: o.derivedAt } };
  }
  return out;
}

export function buildKey(dir) {
  const judgments = JSON.parse(readFileSync(join(dir, 'provenance', 'judgments.json'), 'utf8'));
  const derivation = JSON.parse(readFileSync(join(dir, 'provenance', 'derivation.json'), 'utf8'));
  const missing = derivation.records.map((r) => r.fault).filter((id) => !(id in judgments.expected));
  if (missing.length) throw new Error(`${dir}: observed but not judged: ${missing.join(', ')}`);
  const key = {
    confirmRuns: derivation.runs,
    derivedWith: 'node corpus/derive.mjs (applies each fault by hand to a scratch copy and runs the subject\'s own runner; never TestGuard). Verdicts written by hand in provenance/judgments.json.',
    expected: attach(judgments.expected, derivation, dir),
  };
  if (judgments.modes) {
    key.modes = structuredClone(judgments.modes);
    const edit = key.modes['reuse-edit'];
    if (edit?.expected && Object.keys(edit.expected).length) {
      const p = join(dir, 'provenance', 'derivation-reuse-edit.json');
      if (!existsSync(p)) throw new Error(`${dir}: reuse-edit overrides need provenance/derivation-reuse-edit.json`);
      const obs = JSON.parse(readFileSync(p, 'utf8'));
      if (JSON.stringify(obs.edits) !== JSON.stringify(edit.edits)) throw new Error(`${dir}: derivation-reuse-edit.json was derived with different edits than modes.reuse-edit.edits`);
      edit.expected = attach(edit.expected, obs, `${dir} reuse-edit`);
    }
  }
  return `${JSON.stringify(key, null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  let failed = false;
  for (const dir of args.filter((a) => a !== '--check')) {
    const text = buildKey(dir);
    const target = join(dir, 'expected.json');
    if (check) {
      const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
      if (current !== text) { console.error(`${target}: differs from what provenance/ produces`); failed = true; }
    } else {
      writeFileSync(target, text);
      console.log(`wrote ${target}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
