import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, extname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { locate, mutate } from '../probe/inject.mjs';
import { resolveInterpreter } from '../probe/runners/python.mjs';

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

function runBatchCheck(command, args, items, timeoutMs = 5_000) {
  if (!items.length) return Promise.resolve([]);
  return new Promise((resolveRun, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 16_777_216) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(items));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${command} syntax check timed out after ${timeoutMs}ms`));
      else if (code !== 0) reject(new Error(`${command} syntax check failed: ${firstError(stderr)}`));
      else {
        try {
          const results = JSON.parse(stdout);
          if (!Array.isArray(results) || results.length !== items.length) throw new Error('unexpected result count');
          resolveRun(results);
        } catch (error) {
          reject(new Error(`${command} syntax check returned invalid output: ${error.message}`));
        }
      }
    });
  });
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
 */
export async function checkAnchors(projectDir, claims, { python } = {}) {
  const started = performance.now();
  const work = inspectLocations(projectDir, claims);
  const candidates = work.filter((x) => x.result.status === 'ok' && x.source !== undefined && isInjection(x.fault));
  const hasPython = candidates.some((x) => extname(x.fault.file) === '.py');
  const interpreter = hasPython ? await resolveInterpreter({ projectDir, python, budgetMs: 5_000 }) : undefined;
  const packageTypes = new Map();
  const javascript = [];
  const pythonSources = [];
  for (const candidate of candidates) {
    const { fault, source } = candidate;
    const extension = extname(fault.file);
    const changed = mutate(source, fault);
    if (JS_EXTENSIONS.has(extension)) {
      javascript.push({ candidate, file: fault.file, source: changed, type: packageType(projectDir, fault.file, packageTypes) });
    } else if (extension === '.py' && interpreter && !interpreter.error) {
      pythonSources.push({ candidate, file: fault.file, source: changed });
    }
  }

  // One parser process per language keeps this a cheap preflight even when a
  // claims file has hundreds of faults. The Node VM constructors use the same
  // V8 grammar as `node --check` and compile without linking or executing code.
  const [javascriptResults, pythonResults] = await Promise.all([
    runBatchCheck(process.execPath, ['--no-warnings', '--experimental-vm-modules', '-e', NODE_SYNTAX_CHECK], javascript),
    interpreter && !interpreter.error
      ? runBatchCheck(interpreter.path, ['-c', PYTHON_SYNTAX_CHECK], pythonSources)
      : [],
  ]);

  const parsedByFault = new Map();
  javascript.forEach(({ candidate }, index) => parsedByFault.set(keyOf(candidate.claim.id, candidate.fault.id), { language: 'javascript', ...javascriptResults[index] }));
  pythonSources.forEach(({ candidate }, index) => parsedByFault.set(keyOf(candidate.claim.id, candidate.fault.id), { language: 'python', ...pythonResults[index] }));

  const results = work.map(({ claim, fault, result }) => {
    const parsed = parsedByFault.get(keyOf(claim.id, fault.id));
    if (!parsed) return result;
    if (parsed.status === 'invalid') return { ...result, status: 'fault-invalid', syntax: parsed };
    return { ...result, syntax: parsed };
  });
  return summarize(results, performance.now() - started);
}

export function renderAnchorChecks(report) {
  const lines = report.results.map((result) => {
    const label = result.status.toUpperCase().padEnd(16);
    const hits = result.hits === undefined ? 'no text anchor for this method' : `${result.hits} hit${result.hits === 1 ? '' : 's'}, expected ${result.expected}`;
    const syntax = result.syntax?.status === 'ok'
      ? `; ${result.syntax.language} syntax ok`
      : result.syntax?.message ? `; ${result.syntax.language}: ${result.syntax.message}` : '';
    return `${label} ${result.claimId}/${result.faultId}  ${result.file} — ${hits}${syntax}`;
  });
  lines.push(`anchor preflight: ${report.checked} faults checked, ${report.ok} ok, ${report.invalid} invalid in ${report.durationMs}ms`);
  return lines.join('\n');
}
