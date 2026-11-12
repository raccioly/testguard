/**
 * Tool mutants: deliberately broken TestGuard builds. Each patch under
 * corpus/tool-mutants/ is a realistic regression; the corpus is sensitive only
 * if every one of them turns at least one check red. A mutant the corpus does
 * not catch is a gap in the corpus, reported as such.
 *
 * Each mutant runs in a scratch copy of the tool (cli/, src/, spec/,
 * package.json, node_modules linked), never in the checkout. Its manifest
 * entry names the subjects and modes that exercise the code it breaks; the
 * reference mode always runs first, and the run stops at the first red check,
 * since one red is a catch.
 *
 * Patches drift as src/ changes. A patch that no longer applies is reported as
 * DRIFTED, which fails the run: an unappliable mutant measures nothing.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORPUS } from './subject.mjs';

export const MUTANTS_DIR = join(CORPUS, 'tool-mutants');

export function loadManifest() {
  return JSON.parse(readFileSync(join(MUTANTS_DIR, 'manifest.json'), 'utf8')).mutants;
}

function copyTool(toolRoot) {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-mutant-'));
  for (const part of ['cli', 'src', 'spec']) cpSync(join(toolRoot, part), join(dir, part), { recursive: true });
  cpSync(join(toolRoot, 'package.json'), join(dir, 'package.json'));
  if (existsSync(join(toolRoot, 'node_modules'))) symlinkSync(join(toolRoot, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function apply(dir, patch, { check = false } = {}) {
  execFileSync('git', ['apply', ...(check ? ['--check'] : []), '--whitespace=nowarn', join(MUTANTS_DIR, patch)], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

/** Every patch must apply to the current tree; nothing is run and nothing is written (`git apply --check`). */
export function checkMutants(toolRoot) {
  return loadManifest().map((m) => {
    try {
      apply(toolRoot, m.patch, { check: true });
      return { name: m.name, applies: true };
    } catch (error) {
      return { name: m.name, applies: false, error: (error.stderr || error.message).trim().split('\n')[0] };
    }
  });
}

export async function runMutants({ toolRoot, subjects, only, python, known, log, runSubject }) {
  const results = [];
  for (const m of loadManifest()) {
    if (only && !only.includes(m.name)) continue;
    const dir = copyTool(toolRoot);
    const entry = { name: m.name, description: m.description, caught: false, caughtBy: null, error: null };
    try {
      try { apply(dir, m.patch); } catch (error) {
        entry.error = `DRIFTED: ${m.patch} no longer applies (${(error.stderr || error.message).trim().split('\n')[0]}); regenerate it against src/`;
        results.push(entry);
        log(`mutant ${m.name}: ${entry.error}`);
        continue;
      }
      log(`mutant ${m.name}`);
      for (const t of m.targets) {
        const subject = subjects.find((s) => s.name === t.subject);
        if (!subject) { entry.error = `target subject ${t.subject} not selected`; continue; }
        const rows = await runSubject(subject, { modes: t.modes, toolRoot: dir, python, known, log, stopOnRed: true });
        const red = rows.find((r) => !r.ok);
        if (red) {
          const failed = red.checks.filter((c) => !c.ok);
          const noEvidence = failed.find((c) => c.check === 'tool-wrote-evidence');
          const refused = failed.find((c) => c.check === 'exit-code');
          const why = red.error ? 'error'
            : noEvidence ? `tool wrote no evidence (exit ${noEvidence.detail.exit}: ${String(noEvidence.detail.reason).slice(0, 160)})`
            : refused ? `tool refused the run (${String(refused.detail).slice(0, 160)})`
            : red.key && (red.key.critical || red.key.wrong) ? `key (${red.key.critical} critical, ${red.key.wrong} wrong)`
            : red.differential && !red.differential.equal ? 'differential' : failed.map((c) => c.check).join(', ');
          entry.caught = true;
          entry.caughtBy = `${t.subject}/${red.mode}: ${why}`;
          break;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    log(`mutant ${m.name}: ${entry.caught ? `caught by ${entry.caughtBy}` : `NOT caught${entry.error ? ` (${entry.error})` : ''}`}`);
    results.push(entry);
  }
  return results;
}
