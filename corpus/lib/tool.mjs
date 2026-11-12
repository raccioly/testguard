/**
 * Runs one TestGuard probe the way a user does: the CLI, in a fresh process,
 * against a subject repository, with the evidence written outside it.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pythonFor } from './subject.mjs';
import { compareSnapshots, snapshotIsEmpty, snapshotSubject } from './untouched.mjs';

/**
 * @returns {{exit, json, evidence, elapsedMs, stderr, args, untouched}} `evidence` is the
 * parsed evidence file when one was written; `json` the parsed --json stdout.
 */
export function probe({ toolRoot, subject, repo, outPath, args = [], python, env = {}, timeoutMs = 30 * 60_000 }) {
  // `outPath: null`: no --out, so the run writes where a user's run does (the
  // canonical .testguard/evidence.json, or the partial file), and that is read.
  const evidencePath = outPath ?? join(repo, '.testguard', 'evidence.json');
  const cli = join(toolRoot, 'cli', 'testguard.mjs');
  const runnerArgs = subject.config.probeArgs ?? [];
  const py = subject.config.runner === 'pytest' || subject.config.runner === 'unittest' ? ['--python', pythonFor(subject, python)] : [];
  const argv = [cli, 'probe', repo, '--claims', join(repo, 'claims.json'), ...(outPath ? ['--out', outPath] : []), '--json', '--progress', 'none',
    '--confirm', String(subject.key.confirmRuns ?? 3), '--budget', String(subject.config.budgetMs ?? 30_000), ...runnerArgs, ...py, ...args];
  const before = snapshotSubject(repo);
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, argv, { cwd: repo, env: { ...process.env, CI: '1', NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const elapsedMs = performance.now() - started;
      let json;
      try { json = JSON.parse(stdout); } catch {}
      let evidence;
      // A partial run is redirected away from --out only when --out names the
      // canonical file; it never is here, so the evidence is where we said.
      if (existsSync(evidencePath)) { try { evidence = JSON.parse(readFileSync(evidencePath, 'utf8')); } catch {} }
      // Whatever the exit code, a refusal included: the project is as it was.
      // A run with no --out writes the tool's own documented output directory
      // (.testguard/, untracked) and nothing else; every other change counts.
      const changes = compareSnapshots(before, snapshotSubject(repo)).filter((c) => outPath || !(c.kind === 'status' && c.path.startsWith('.testguard/')));
      const untouched = { emptySnapshot: snapshotIsEmpty(before), changes };
      resolve({ exit: code, json, evidence, elapsedMs, stderr, args: argv.slice(1), untouched });
    });
  });
}

/** The verdict map a check compares: id → {verdict, reason, killKind}, plus the record order. */
export function verdictMap(evidence) {
  const map = {};
  const order = [];
  for (const r of evidence?.records ?? []) {
    const id = `${r.claim.id}/${r.subject.id}`;
    order.push(id);
    map[id] = { verdict: r.verdict, reason: r.detail?.reason, killKind: r.detail?.killKind, reused: Boolean(r.reusedFrom) };
  }
  return { map, order };
}
