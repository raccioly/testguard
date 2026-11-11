import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative, sep } from 'node:path';
import { registerChild } from './runners/lifecycle.mjs';
import { resolveRunner, splitCommandWords, terminateProcessTree } from './runners/shared.mjs';
import { PreconditionError } from './worktree.mjs';
import { sha256 } from '../util/hash.mjs';

/**
 * The type check: is a fault's replacement still a program its own compiler
 * accepts? A replacement that parses but breaks the types would have been
 * refused by the build, so a kill says only that the tests catch what the
 * compiler already catches, and a survivor is noise. Such a fault is
 * `fault-invalid` and costs no test run.
 *
 * The checker is the PROJECT's: its own `typescript`, resolved from the
 * project (or the node_modules linked into the scratch tree), never a bundled
 * compiler. TestGuard gains no dependency. A custom command is an argv, never
 * a shell string.
 *
 * One checker serves every fault of a worktree. `tsc --incremental` keeps a
 * build-info file; the unmodified tree's file is snapshotted once and put back
 * before and after every fault, so one fault's diagnostics (or its cached
 * program) can never reach the next. No state is shared between two checkers:
 * each owns a private directory under the scratch base.
 */

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const JS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const OUTPUT_LIMIT = 1_048_576;
const DIAGNOSTIC = /^.*\berror TS\d+:.*$/m;

/** First `error TSxxxx` line of tsc output, or undefined. */
export function firstDiagnostic(output) {
  return DIAGNOSTIC.exec(output)?.[0].trim();
}

/** The first line worth showing from a custom command's output. */
function firstLine(output) {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /\berror\b/i.test(l)) ?? lines[0];
}

const clip = (text, cwd) => String(text ?? '').replaceAll(`${cwd}${sep}`, '').slice(0, 1024);

/** Run an argv with a budget; resolves with what happened, never rejects. */
function execute({ argv, cwd, budgetMs }) {
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } });
    } catch (error) {
      resolve({ spawnError: error.message, output: '', durationMs: 0 });
      return;
    }
    registerChild(child, () => terminateProcessTree(child));
    let output = '';
    const take = (chunk) => { if (output.length < OUTPUT_LIMIT) output += chunk; };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    let spawnError;
    child.on('error', (error) => { spawnError = error.code === 'ENOENT' ? `${argv[0]}: command not found` : error.message; });
    const timer = setTimeout(() => { timedOut = true; terminateProcessTree(child); }, budgetMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, timedOut, spawnError, durationMs: Date.now() - started });
    });
  });
}

/**
 * Resolve and baseline the checker for one worktree. Throws
 * `PreconditionError` — naming the cause — when no checker can be established
 * or the unmodified tree does not pass it: a fault cannot be judged against a
 * tree that already fails, and a check that cannot run is never a skipped one.
 *
 * `command` is `''` for the project's own `tsc`, or an argv string.
 */
export async function createTypechecker({ projectDir, command = '', budgetMs = 120_000, scratchBase }) {
  const custom = command.trim() !== '';
  let words;
  if (custom) {
    try { words = splitCommandWords(command, '--typecheck'); } catch (error) { throw new PreconditionError(error.message); }
  }
  const dir = mkdtempSync(join(scratchBase ?? tmpdir(), 'testguard-tc-'));
  const info = join(dir, 'build.tsbuildinfo');
  const snapshot = join(dir, 'baseline.tsbuildinfo');
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    let argv;
    let identity;
    let version;
    let checkJs = false;
    let program; // project-relative files tsc reads (the default command only)
    if (custom) {
      argv = words;
      identity = { kind: 'custom', argv: words };
      const probe = await execute({ argv: [words[0], '--version'], cwd: projectDir, budgetMs: 15_000 });
      if (probe.spawnError) throw new PreconditionError(`--typecheck: ${probe.spawnError}`);
      // Best-effort identification: the command's own --version, plus the
      // project's typescript when it resolves (what such a command usually runs).
      // A checker that changes behavior under neither is not detected; --no-reuse.
      const own = probe.code === 0 ? probe.output.trim().split('\n')[0].slice(0, 32) : '';
      const ts = resolveRunner({ projectDir, pkg: 'typescript', bin: 'tsc' })?.version;
      version = [own, ts ? `typescript@${ts}` : ''].filter(Boolean).join('; ').slice(0, 64) || 'unknown';
    } else {
      if (!existsSync(join(projectDir, 'tsconfig.json'))) {
        throw new PreconditionError('--typecheck needs a tsconfig.json in the project, or a command: --typecheck="<cmd>"');
      }
      const tsc = resolveRunner({ projectDir, pkg: 'typescript', bin: 'tsc' });
      if (!tsc) {
        throw new PreconditionError('--typecheck: the project\'s own typescript cannot be resolved (npm i -D typescript, or --node-modules <dir>), or pass a command: --typecheck="<cmd>"');
      }
      version = tsc.version;
      const flags = ['--noEmit', '-p', 'tsconfig.json', '--incremental', '--pretty', 'false'];
      identity = { kind: 'tsc', args: flags };
      argv = [...tsc.argv, ...flags, '--tsBuildInfoFile', info];
      // Does the project check its JavaScript? Asked of the compiler, which
      // knows `extends` and comments; never parsed here.
      const shown = await execute({ argv: [...tsc.argv, '--showConfig', '-p', 'tsconfig.json'], cwd: projectDir, budgetMs });
      let config;
      try { config = JSON.parse(shown.output); } catch { /* reported below */ }
      if (shown.timedOut || shown.spawnError || shown.code !== 0 || !config) {
        const cause = shown.timedOut ? `timed out after ${budgetMs}ms` : shown.spawnError ?? firstDiagnostic(shown.output) ?? firstLine(shown.output) ?? `exit ${shown.code}`;
        throw new PreconditionError(`--typecheck: tsc cannot read tsconfig.json (${clip(cause, projectDir)})`);
      }
      checkJs = config.compilerOptions?.allowJs === true && config.compilerOptions?.checkJs === true;
      // Which project files does the program actually contain? A `.ts` file the
      // tsconfig does not include is never read by tsc, so "clean" for it would
      // be a statement about nothing.
      const listed = await execute({ argv: [...tsc.argv, '--listFilesOnly', '-p', 'tsconfig.json'], cwd: projectDir, budgetMs });
      if (listed.timedOut || listed.spawnError || listed.code !== 0) {
        throw new PreconditionError(`--typecheck: tsc could not list the program's files (${clip(listed.spawnError ?? firstDiagnostic(listed.output) ?? firstLine(listed.output) ?? `exit ${listed.code}`, projectDir)})`);
      }
      program = programFiles(listed.output, projectDir);
      if (program.size === 0) {
        throw new PreconditionError('--typecheck: the tsconfig.json program contains no project file (a solution-style tsconfig with only references, or an include that matches nothing), so a type check could judge no fault. Point a tsconfig at the sources, or pass a command: --typecheck="<cmd>"');
      }
    }

    const snapshotted = () => existsSync(snapshot);
    const restore = () => {
      if (snapshotted()) copyFileSync(snapshot, info);
      else rmSync(info, { force: true });
    };
    const judge = (ran) => {
      if (ran.timedOut) return { status: 'timeout' };
      if (ran.spawnError) throw new Error(`type check could not run: ${ran.spawnError}`);
      if (ran.code === 0) return { status: 'clean' };
      if (custom) {
        if (ran.code === null) throw new Error(`type check was killed by ${ran.signal}`);
        return { status: 'diagnostics', message: clip(firstLine(ran.output) ?? `exit ${ran.code}`, projectDir) };
      }
      const diagnostic = firstDiagnostic(ran.output);
      if (diagnostic && (ran.code === 1 || ran.code === 2)) return { status: 'diagnostics', message: clip(diagnostic, projectDir) };
      // tsc died without saying what is wrong with the program. That is not a
      // verdict about the fault, and it is never read as one.
      throw new Error(`type check exited ${ran.code ?? ran.signal} without a diagnostic: ${clip(ran.output.trim().split('\n').pop(), projectDir)}`);
    };

    const stats = { baselineMs: 0, checks: 0, checkMs: 0 };
    const base = await execute({ argv, cwd: projectDir, budgetMs });
    stats.baselineMs = base.durationMs;
    if (base.timedOut) throw new PreconditionError(`--typecheck: the type check of the unmodified tree exceeded ${budgetMs}ms; raise --budget`);
    if (base.spawnError) throw new PreconditionError(`--typecheck: ${base.spawnError}`);
    let verdict;
    try { verdict = judge(base); } catch (error) { throw new PreconditionError(`--typecheck: ${error.message}`); }
    if (verdict.status !== 'clean') {
      throw new PreconditionError(`--typecheck: the unmodified tree does not type-check, so no fault can be judged against it. First diagnostic: ${verdict.message}`);
    }
    if (existsSync(info)) copyFileSync(info, snapshot);

    return {
      spec: { commandHash: sha256(JSON.stringify(identity)), version },
      stats,
      /** Where the incremental state lives (the default command only), for tests and for anyone reading the scratch area. */
      buildInfoFile: custom ? undefined : info,
      applicable(file) {
        const ext = extname(file).toLowerCase();
        const judged = TS_EXTENSIONS.has(ext) || (JS_EXTENSIONS.has(ext) && checkJs);
        // A custom command cannot say which files it reads: only the extension is known.
        return judged && (custom || program.has(file.split(sep).join('/')));
      },
      /**
       * Type check the tree as it is NOW (the caller applied the fault).
       * `clean` | `diagnostics` (+ `message`) | `timeout`; throws when the
       * checker itself failed, which the caller reports as unverifiable.
       */
      async check({ budgetMs: budget = budgetMs } = {}) {
        restore();
        try {
          const ran = await execute({ argv, cwd: projectDir, budgetMs: budget });
          stats.checks++;
          stats.checkMs += ran.durationMs;
          return { ...judge(ran), durationMs: ran.durationMs };
        } finally {
          restore();
        }
      },
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** The project-relative files in `tsc --listFilesOnly` output: one absolute path per line, library files and all. */
export function programFiles(output, projectDir) {
  const roots = [...new Set([projectDir, realpathSync(projectDir)])];
  const files = new Set();
  for (const line of output.split('\n')) {
    const path = line.trim();
    for (const root of roots) {
      const rel = relative(root, path);
      if (rel && !rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel) && !rel.split(sep).includes('node_modules')) files.add(rel.split(sep).join('/'));
    }
  }
  return files;
}

/** Which evidence `run.typecheck` blocks may stand in for one another: the same command and the same checker. */
export function sameTypecheck(recorded, current) {
  if (!recorded && !current) return true;
  if (!recorded || !current) return false;
  return recorded.commandHash === current.commandHash && recorded.version === current.version;
}
