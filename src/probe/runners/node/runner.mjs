import { appendFileSync, writeFileSync } from 'node:fs';
import { readBoundedJsonFile } from '../discovery.mjs';
import { createReport } from './report.mjs';

// The tool may itself be called from a Node test worker. This new controller
// must initialize as a parent, rather than Node's nested-run no-op mode.
delete process.env.NODE_TEST_CONTEXT;
const { run } = await import('node:test');

const collect = process.env.TESTGUARD_NODE_COLLECT === '1';
const workers = Number(process.env.TESTGUARD_NODE_WORKERS);
const files = process.argv.slice(2);
if (!Number.isSafeInteger(workers) || workers < 1) throw new Error('invalid node-test worker ceiling');
const report = createReport({ projectDir: process.cwd(), version: process.versions.node, collect });
// run() on the Node20 floor uses argv for default native collection. The
// launcher is not a project test entry. Explicit file runs keep their paths.
process.argv = [process.execPath];
// The floor predates run({testNamePatterns}) and --test-concurrency. Put the
// name filter only in CHILD argv, keeping native file containers collectible.
if (collect) process.execArgv.push('--test-name-pattern=(?!)');
const cancellation = new AbortController();
const stream = run({ signal: cancellation.signal, concurrency: workers, ...(files.length ? { files } : {}), ...(collect ? { testNamePatterns: ['(?!)'] } : {}) });
try {
  for await (const event of stream) report.accept(event);
  appendFileSync(process.env.TESTGUARD_NODE_ENTRIES, 'null]}');
  const entries = readBoundedJsonFile(process.env.TESTGUARD_NODE_ENTRIES).entries;
  if (!Array.isArray(entries) || entries.at(-1) !== null) throw new Error('incomplete node-test entry receipts');
  entries.pop();
  const doc = report.finish(entries);
  const text = JSON.stringify(doc);
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('node-test report exceeded its byte bound');
  if (collect) process.stdout.write(text);
  else writeFileSync(process.env.TESTGUARD_NODE_REPORT, text, { mode: 0o600 });
  if (doc.failed) process.exitCode = 1;
} catch (error) {
  cancellation.abort();
  stream.destroy();
  // The Node20 floor's test harness can swallow an uncaught controller error.
  // Retain bounded diagnostics while leaving the incomplete report unwritten.
  process.stderr.write(`node-test reporter failed: ${String(error.message ?? error).slice(0, 1000)}\n`);
  process.exitCode = 1;
}
