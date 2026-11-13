import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, extname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { locate, mutate } from '../probe/inject.mjs';
import { resolveInterpreter } from '../probe/runners/python.mjs';
import { repoRoot, isDirty, snapshotWorkingTree } from '../git.mjs';
import { createScratch } from '../probe/worktree.mjs';
import { applyFault } from '../probe/inject.mjs';
import { createTypechecker } from '../probe/typecheck.mjs';
import { ClaimsError } from './load.mjs';

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

const NODE_SYNTAX_CHECK = `
const vm = require('node:vm');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const results = JSON.parse(input).map(({ file, source, type }) => {
    try {
      if (type === 'module') new vm.SourceTextModule(source, { identifier: file });
      else new vm.Script(source, { filename: file });
      return { status: 'ok' };
    } catch (error) {
      return { status: 'invalid', message: error.name + ': ' + error.message };
    }
  });
  process.stdout.write(JSON.stringify(results));
});
`;

const PYTHON_SYNTAX_CHECK = `
import json, sys
results = []
for item in json.load(sys.stdin):
    try:
        compile(item["source"], item["file"], "exec")
        results.append({"status": "ok"})
    except (SyntaxError, IndentationError, TabError) as error:
        results.append({"status": "invalid", "message": type(error).__name__ + ": " + str(error)})
json.dump(results, sys.stdout)
`;

const isInjection = (fault) => (fault.method ?? 'fault-injection') === 'fault-injection';
const keyOf = (claimId, faultId) => `${claimId}\0${faultId}`;

/** Read each target once and locate every injection fault without touching disk. */
function inspectLocations(projectDir, claims) {
  const sources = new Map();
  const work = [];
  for (const claim of claims.claims) {
    for (const fault of claim.faults) {
      if (!isInjection(fault)) {
        work.push({ claim, fault, result: { claimId: claim.id, faultId: fault.id, file: fault.file, status: 'ok', check: 'not-applicable' } });
        continue;
      }
      const path = resolve(projectDir, fault.file);
      let source;
      if (sources.has(path)) source = sources.get(path);
      else {
        source = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
        sources.set(path, source);
      }
      const anchor = source === undefined
        ? { status: 'anchor-missing', hits: 0, expected: fault.expectHits ?? 1 }
        : locate(source, fault);
      work.push({
        claim,
        fault,
        source,
        result: { claimId: claim.id, faultId: fault.id, file: fault.file, status: anchor.status, hits: anchor.hits, expected: anchor.expected },
      });
    }
  }
  return work;
}

const summarize = (results, durationMs) => ({
  checked: results.length,
  ok: results.filter((r) => r.status === 'ok').length,
  invalid: results.filter((r) => r.status !== 'ok').length,
  durationMs: Math.round(durationMs),
  results,
});

/** Exact anchor checks only. Synchronous so status and MCP stay synchronous. */
export function checkAnchorLocations(projectDir, claims) {
  const started = performance.now();
  return summarize(inspectLocations(projectDir, claims).map((x) => x.result), performance.now() - started);
}

function firstError(stderr) {
  const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /(?:Syntax|Indentation|Tab)Error:/.test(line))
    ?? lines.find((line) => /error/i.test(line))
    ?? lines.at(-1)
    ?? 'replacement does not compile';
}

/** A batch closes when its summed source length would pass this many characters (#320). */
export const BATCH_CHARS = 4_000_000;
/** One parser process gets this long for one batch. */
export const BATCH_TIMEOUT_MS = 10_000;

/**
 * Cut consecutive items, given by size, into batches: a batch closes when its summed size would pass `cap`,
 * and an item larger than `cap` goes alone. Returns [start, end) pairs covering every item in order.
 * The whole claims file is never one message: 6,600 faults times a whole source file each overran the
 * string a parser process can be sent, and the throw left that process waiting for input forever (#320).
 */
export function cutBatches(sizes, cap = BATCH_CHARS) {
  const cuts = [];
  let start = 0;
  let sum = 0;
  sizes.forEach((size, i) => {
    if (i > start && sum + size > cap) { cuts.push([start, i]); start = i; sum = 0; }
    sum += size;
  });
  if (sizes.length > start) cuts.push([start, sizes.length]);
  return cuts;
}

/**
 * One parser process, one batch. Every way this can fail (the send, the timeout, the parser's exit, an abort
 * because a sibling failed) kills the child and rejects once the child is gone: no failure leaves a
 * process or a timer behind, and none leaves the promise pending. `serialize` and `onSpawn` are
 * injectable so a test can force the send to fail and see the child die.
 */
export function runBatchCheck(command, args, items, { timeoutMs = BATCH_TIMEOUT_MS, serialize = JSON.stringify, onSpawn, signal } = {}) {
  if (!items.length) return Promise.resolve([]);
  return new Promise((resolveRun, reject) => {
    if (signal?.aborted) { reject(new Error(`${command} syntax check not started: another check failed`)); return; }
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
    } catch (error) {
      reject(error);
      return;
    }
    onSpawn?.(child);
    let stdout = '';
    let stderr = '';
    let failure;
    let settled = false;
    let timer;
    const onAbort = () => fail(new Error(`${command} syntax check stopped: another check failed`));
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    // Kill now, reject on 'close': by then the process is gone, not merely signalled.
    function fail(error) {
      failure ??= error;
      clearTimeout(timer);
      child.kill('SIGKILL');
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 16_777_216) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    child.on('error', (error) => { fail(error); settle(reject, error); });
    child.stdin.on('error', () => {});
    // The timer starts before the send, so nothing after this line can wait unbounded.
    timer = setTimeout(() => fail(new Error(`${command} syntax check timed out after ${timeoutMs}ms`)), timeoutMs);
    let payload;
    try { payload = serialize(items); } catch (error) { fail(new Error(`${command} syntax check: could not serialize ${items.length} items: ${error.message}`)); }
    if (payload !== undefined) {
      try { child.stdin.end(payload); } catch (error) { fail(new Error(`${command} syntax check: could not send ${items.length} items: ${error.message}`)); }
    }
    child.on('close', (code) => {
      if (failure) settle(reject, failure);
      else if (code !== 0) settle(reject, new Error(`${command} syntax check failed: ${firstError(stderr)}`));
      else {
        try {
          const results = JSON.parse(stdout);
          if (!Array.isArray(results) || results.length !== items.length) throw new Error('unexpected result count');
          settle(resolveRun, results);
        } catch (error) {
          settle(reject, new Error(`${command} syntax check returned invalid output: ${error.message}`));
        }
      }
    });
  });
}

/**
 * One language: its faults in batches of at most `batchChars`, one fresh parser process after another, results
 * in input order. A fault's mutated source is built only when its batch is, and is garbage once the batch is
 * sent. The phase is bounded by `deadline`, checked before every batch (so it overruns by at most one
 * batch's own timeout); running out says how far it got.
 */
export async function checkInBatches({ language, command, args, candidates, build, sizeOf, batchChars = BATCH_CHARS, timeoutMs = BATCH_TIMEOUT_MS, deadline, budgetMs, signal, onBatch, onSpawn, serialize }) {
  const results = [];
  for (const [from, to] of cutBatches(candidates.map(sizeOf), batchChars)) {
    const left = deadline - performance.now();
    if (left <= 0) throw new Error(`${language} syntax check ran out of its ${budgetMs}ms budget after ${results.length} of ${candidates.length} faults; raise --budget`);
    onBatch?.({ language, from, to });
    try {
      for (const r of await runBatchCheck(command, args, candidates.slice(from, to).map(build), { timeoutMs, signal, onSpawn, serialize })) results.push(r);
    } catch (error) {
      throw new Error(`${error.message} (${results.length} of ${candidates.length} ${language} faults checked)`, { cause: error });
    }
  }
  return results;
}

function packageType(projectDir, file, cache) {
  if (extname(file) === '.mjs') return 'module';
  if (extname(file) === '.cjs') return 'commonjs';
  let dir = dirname(resolve(projectDir, file));
  const root = resolve(projectDir);
  while (dir.startsWith(root)) {
    if (cache.has(dir)) return cache.get(dir);
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      const type = JSON.parse(readFileSync(pkg, 'utf8')).type === 'module' ? 'module' : 'commonjs';
      cache.set(dir, type);
      return type;
    }
    if (dir === root) break;
    dir = dirname(dir);
  }
  return 'commonjs';
}

/**
 * Anchor every fault, then ask the language parser whether the in-memory
 * replacement still compiles. Unsupported languages (and Python when no
 * interpreter resolves) are intentionally left anchor-only.
 *
 * With `typecheck` (`''` for the project's own tsc, or a command) every
 * replacement that still parses is also type checked, the way `probe
 * --typecheck` would: in a scratch worktree of the working tree, after a
 * baseline check of the unmodified tree. A replacement the checker refuses is
 * `fault-invalid`; a file it does not judge is reported `not-applicable`.
 */
export async function checkAnchors(projectDir, claims, { python, typecheck, budgetMs = 120_000, nodeModules, scratchBase, batchChars, batchTimeoutMs, onBatch, onSpawn, serialize } = {}) {
  const started = performance.now();
  const work = inspectLocations(projectDir, claims);
  const candidates = work.filter((x) => x.result.status === 'ok' && x.source !== undefined && isInjection(x.fault));
  const hasPython = candidates.some((x) => extname(x.fault.file) === '.py');
  const interpreter = hasPython ? await resolveInterpreter({ projectDir, python, budgetMs: 5_000 }) : undefined;
  const packageTypes = new Map();
  // Candidates only: which fault goes to which parser. The mutated source is built when its batch is (#320).
  const javascript = [];
  const pythonSources = [];
  for (const candidate of candidates) {
    const extension = extname(candidate.fault.file);
    if (JS_EXTENSIONS.has(extension)) javascript.push(candidate);
    else if (extension === '.py' && interpreter && !interpreter.error) pythonSources.push(candidate);
  }
  // Exact, without building the string: the replaced text is the source minus the anchor plus the replacement.
  const sizeOf = ({ source, fault }) => source.length - fault.find.length + fault.replace.length;
  const buildJs = (candidate) => ({ file: candidate.fault.file, source: mutate(candidate.source, candidate.fault), type: packageType(projectDir, candidate.fault.file, packageTypes) });
  const buildPy = (candidate) => ({ file: candidate.fault.file, source: mutate(candidate.source, candidate.fault) });

  // One parser process at a time per language, a batch of faults each, keeps this a cheap preflight even when a
  // claims file has thousands of faults. The Node VM constructors use the same V8 grammar as `node --check`
  // and compile without linking or executing code. The two languages run beside each other; when one fails the
  // other is stopped, and the call settles only after no parser process is left.
  const deadline = performance.now() + budgetMs;
  const abort = new AbortController();
  let firstError;
  const guard = (promise) => promise.catch((error) => { firstError ??= error; abort.abort(); throw error; });
  const common = { sizeOf, deadline, budgetMs, signal: abort.signal, batchChars, timeoutMs: batchTimeoutMs, onBatch, onSpawn, serialize };
  const settled = await Promise.allSettled([
    guard(checkInBatches({ ...common, language: 'javascript', command: process.execPath, args: ['--no-warnings', '--experimental-vm-modules', '-e', NODE_SYNTAX_CHECK], candidates: javascript, build: buildJs })),
    interpreter && !interpreter.error
      ? guard(checkInBatches({ ...common, language: 'python', command: interpreter.path, args: ['-c', PYTHON_SYNTAX_CHECK], candidates: pythonSources, build: buildPy }))
      : Promise.resolve([]),
  ]);
  // A typed refusal, so the CLI prints one `error:` line and exits 2, not a trace labeled a bug in testguard.
  if (firstError) throw new ClaimsError(`the syntax check of the fault replacements could not finish: ${firstError.message}`, { cause: firstError });
  const [javascriptResults, pythonResults] = settled.map((r) => r.value);

  const parsedByFault = new Map();
  javascript.forEach((candidate, index) => parsedByFault.set(keyOf(candidate.claim.id, candidate.fault.id), { language: 'javascript', ...javascriptResults[index] }));
  pythonSources.forEach((candidate, index) => parsedByFault.set(keyOf(candidate.claim.id, candidate.fault.id), { language: 'python', ...pythonResults[index] }));

  let results = work.map(({ claim, fault, result }) => {
    const parsed = parsedByFault.get(keyOf(claim.id, fault.id));
    if (!parsed) return result;
    if (parsed.status === 'invalid') return { ...result, status: 'fault-invalid', syntax: parsed };
    return { ...result, syntax: parsed };
  });
  if (typecheck !== undefined) {
    results = await typecheckResults(projectDir, work, results, { typecheck, budgetMs, nodeModules, scratchBase });
  }
  return summarize(results, performance.now() - started);
}

/** Type check every still-valid injection fault in a scratch copy of the working tree. */
async function typecheckResults(projectDir, work, results, { typecheck, budgetMs, nodeModules, scratchBase }) {
  // git reports the repository root by its real path (/private/var on macOS);
  // the scratch tree's project directory is computed relative to it.
  projectDir = realpathSync(resolve(projectDir));
  const root = repoRoot(projectDir);
  const iso = createScratch({ repoRoot: root, projectDir, ref: isDirty(root) ? snapshotWorkingTree(root) : 'HEAD', scratchBase, nodeModules });
  let checker;
  try {
    checker = await createTypechecker({ projectDir: iso.projectDir, command: typecheck, budgetMs, scratchBase });
    const out = [];
    for (const [index, result] of results.entries()) {
      const { fault } = work[index];
      if (result.status !== 'ok' || !isInjection(fault)) { out.push(result); continue; }
      if (!checker.applicable(fault.file)) { out.push({ ...result, typecheck: { status: 'not-applicable' } }); continue; }
      const mutation = applyFault(iso.projectDir, fault);
      let outcome;
      try { outcome = await checker.check({ budgetMs }); } finally { mutation.restore(); }
      const { status, message } = outcome;
      out.push({ ...result, ...(status === 'diagnostics' ? { status: 'fault-invalid' } : status === 'timeout' ? { status: 'timeout' } : {}), typecheck: { status, ...(message ? { message } : {}) } });
    }
    return out;
  } finally {
    checker?.cleanup();
    iso.cleanup();
  }
}

export function renderAnchorChecks(report) {
  const lines = report.results.map((result) => {
    const label = result.status.toUpperCase().padEnd(16);
    const hits = result.hits === undefined ? 'no text anchor for this method' : `${result.hits} hit${result.hits === 1 ? '' : 's'}, expected ${result.expected}`;
    const syntax = result.syntax?.status === 'ok'
      ? `; ${result.syntax.language} syntax ok`
      : result.syntax?.message ? `; ${result.syntax.language}: ${result.syntax.message}` : '';
    const tc = result.typecheck;
    const typed = !tc ? '' : tc.status === 'clean' ? '; type check ok' : tc.status === 'not-applicable' ? '; type check not applicable' : tc.status === 'timeout' ? '; type check timed out' : `; type check: ${tc.message}`;
    return `${label} ${result.claimId}/${result.faultId}  ${result.file} — ${hits}${syntax}${typed}`;
  });
  lines.push(`anchor preflight: ${report.checked} faults checked, ${report.ok} ok, ${report.invalid} invalid in ${report.durationMs}ms`);
  return lines.join('\n');
}
