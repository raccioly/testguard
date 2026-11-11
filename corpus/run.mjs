#!/usr/bin/env node
/**
 * The benchmark corpus harness (issue #258). Runs every subject under every
 * mode and compares the answers with keys derived by hand, with the reference
 * mode, and with transformed copies of the subject. See corpus/README.md.
 *
 *   npm run corpus                                  every subject, every mode
 *   npm run corpus -- --subject <name> --mode <m>   one subject / mode (repeatable)
 *   npm run corpus -- --subject-dir <path> --key <path> [--claims <path>] [--config <path>]
 *                                                   a project outside the repository
 *   npm run corpus -- --tool-mutants [--mutant <name>]   deliberately broken builds must go red
 *   npm run corpus -- --check-mutants               every patch still applies (no runs)
 *   npm run corpus -- --install [--subject <name>]  install subjects' pinned dependencies
 *   --json <out>   write the scorecard JSON;  --markdown <out>  the rendered table
 *   npm run corpus -- --merge a.json b.json ... [--base base.json]   join shard scorecards
 *   --base <scorecard.json>  print the base's normalized seconds beside each row
 *   --python <interpreter>  (or TESTGUARD_PYTHON) for Python subjects
 *   --tool <dir>   the TestGuard checkout to measure (default: this one)
 *
 * Exit 0 only when every selected mode of every selected subject passed every
 * check (and, with --tool-mutants, every mutant was caught); 1 otherwise; 2 when
 * a subject cannot be measured at all (missing dependencies, a key that does
 * not match its claims).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadKnownFailures } from './lib/checks.mjs';
import { MODES, RUN, applies } from './lib/modes.mjs';
import { checkMutants, loadManifest, runMutants } from './lib/mutants.mjs';
import { buildScorecard, measureMachine, mergeScorecards, renderMarkdown, validateScorecard } from './lib/scorecard.mjs';
import { CORPUS, SubjectError, install, listSubjects, loadSubject, preflight } from './lib/subject.mjs';

const TOOL_ROOT = resolve(CORPUS, '..');

/** Runs the selected modes of one subject; the reference always runs first because the others compare with it. */
export async function runSubject(subject, { modes, toolRoot = TOOL_ROOT, python, known, log = () => {}, stopOnRed = false }) {
  const work = mkdtempSync(join(tmpdir(), `corpus-run-${subject.name}-`));
  const ctx = { subject, toolRoot, python, known, work };
  const results = [];
  try {
    const wanted = ['reference', ...modes.filter((m) => m !== 'reference')];
    for (const mode of wanted) {
      if (!applies(mode, subject)) continue;
      log(`  ${subject.name} ${mode} ...`);
      let r;
      try {
        r = await RUN[mode](ctx);
      } catch (error) {
        r = { subject: subject.name, mode, ok: false, error: error.stack ?? String(error), runs: [], key: null, differential: null, checks: [] };
      }
      results.push(r);
      log(`  ${subject.name} ${mode}: ${r.ok ? 'ok' : 'RED'}${r.key ? ` (key ${r.key.right}/${r.key.total}${r.key.critical ? `, ${r.key.critical} CRITICAL` : ''}${r.key.known ? `, ${r.key.known} known` : ''})` : ''}${r.differential && !r.differential.equal ? ' (differential mismatch)' : ''}${r.runs.length ? ` ${(r.runs.reduce((s, x) => s + x.elapsedMs, 0) / 1000).toFixed(1)}s` : ''}`);
      if (mode === 'reference' && !ctx.reference) break;
      if (stopOnRed && !r.ok) break;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return results;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      merge: { type: 'boolean' },
      base: { type: 'string' },
      subject: { type: 'string', multiple: true },
      mode: { type: 'string', multiple: true },
      'subject-dir': { type: 'string' },
      key: { type: 'string' },
      claims: { type: 'string' },
      config: { type: 'string' },
      json: { type: 'string' },
      markdown: { type: 'string' },
      python: { type: 'string' },
      tool: { type: 'string' },
      'tool-mutants': { type: 'boolean' },
      mutant: { type: 'string', multiple: true },
      'check-mutants': { type: 'boolean' },
      install: { type: 'boolean' },
      quiet: { type: 'boolean' },
    },
  });
  const log = values.quiet ? () => {} : (s) => console.error(s);
  const toolRoot = values.tool ? resolve(values.tool) : TOOL_ROOT;

  const base = values.base && existsSync(values.base) ? JSON.parse(readFileSync(values.base, 'utf8')) : null;
  const emit = (scorecard) => {
    validateScorecard(scorecard);
    const markdown = renderMarkdown(scorecard, { base });
    if (values.json) { mkdirSync(dirname(resolve(values.json)), { recursive: true }); writeFileSync(values.json, `${JSON.stringify(scorecard, null, 2)}\n`); }
    if (values.markdown) { mkdirSync(dirname(resolve(values.markdown)), { recursive: true }); writeFileSync(values.markdown, markdown); }
    console.log(markdown);
    process.exit(scorecard.ok ? 0 : 1);
  };

  if (values.merge) {
    if (positionals.length === 0) { console.error('corpus: --merge needs scorecard files'); process.exit(3); }
    emit(mergeScorecards(positionals.map((p) => validateScorecard(JSON.parse(readFileSync(p, 'utf8'))))));
  }

  if (values['check-mutants']) {
    const report = checkMutants(toolRoot);
    for (const m of report) console.log(`${m.applies ? 'applies ' : 'DRIFTED '} ${m.name}${m.applies ? '' : `: ${m.error}`}`);
    process.exit(report.every((m) => m.applies) ? 0 : 1);
  }

  const subjects = [];
  try {
    if (values['subject-dir']) {
      if (!values.key) throw new SubjectError('--subject-dir needs --key <expected.json>');
      subjects.push(loadSubject(values['subject-dir'], { keyPath: values.key, claimsPath: values.claims, configPath: values.config }));
    } else {
      // A mutant shard needs only the subjects its mutants name.
      const targeted = values['tool-mutants'] && !values.subject
        ? [...new Set(loadManifest().filter((m) => !values.mutant || values.mutant.includes(m.name)).flatMap((m) => m.targets.map((t) => t.subject)))]
        : null;
      const names = values.subject ?? targeted ?? listSubjects();
      for (const n of names) subjects.push(loadSubject(join(CORPUS, n)));
    }
    if (subjects.length === 0) throw new SubjectError('no subject selected');
    if (values.mutant) for (const m of values.mutant) if (!loadManifest().some((x) => x.name === m)) throw new SubjectError(`unknown mutant ${m}`);
    if (values.install) {
      for (const s of subjects) { log(`installing ${s.name}`); install(s, { python: values.python }); }
      return;
    }
    for (const s of subjects) preflight(s, { python: values.python });
  } catch (error) {
    if (error instanceof SubjectError) { console.error(`corpus: ${error.message}`); process.exit(2); }
    throw error;
  }
  const modes = values.mode ?? MODES;
  for (const m of modes) if (!MODES.includes(m)) { console.error(`corpus: unknown mode ${m} (one of ${MODES.join(', ')})`); process.exit(3); }
  const known = loadKnownFailures();

  const machineBefore = measureMachine();
  const results = [];
  let mutants = null;
  if (values['tool-mutants']) {
    mutants = await runMutants({ toolRoot, subjects, only: values.mutant, python: values.python, known, log, runSubject });
  } else {
    for (const s of subjects) results.push(...await runSubject(s, { modes, toolRoot, python: values.python, known, log }));
  }
  const machineAfter = measureMachine();
  emit(buildScorecard({ toolRoot, results, mutants, machine: { before: machineBefore, after: machineAfter } }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.stack ?? error); process.exit(2); });
}
