import { appendFileSync, writeFileSync } from 'node:fs';
import { readBoundedJsonFile } from '../discovery.mjs';
import { createReport } from './report.mjs';

// This preload returns before Node evaluates its actual CLI entry. Running the
// file as the entry preserves require.main, import.meta.main and process.argv.
const file = process.argv[1];
if (!file) throw new Error('direct node-test requires an entry');
const entriesFile = process.env.TESTGUARD_NODE_ENTRIES;
const reportFile = process.env.TESTGUARD_NODE_REPORT;
const diagnosticFile = `${entriesFile}.error`;
const report = createReport({ projectDir: process.cwd(), version: process.versions.node });
let document;
let outsideFailure = false;
process.on('uncaughtExceptionMonitor', (error) => {
  outsideFailure = true;
  writeFileSync(diagnosticFile, JSON.stringify({ name: String(error?.name ?? 'Error').slice(0, 100), message: String(error?.message ?? error).slice(0, 1000) }), { mode: 0o600 });
});
process.on('unhandledRejection', () => { outsideFailure = true; process.exitCode = 1; });
// A complete stream is insufficient: a retained timer can fail or hang later.
// Publish only at process exit, after CLI loading and out-of-test failures settle.
process.on('exit', (code) => {
  if (!document || outsideFailure || code !== (document.failed ? 1 : 0)) return;
  const text = JSON.stringify(document);
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) return;
  writeFileSync(reportFile, text, { mode: 0o600 });
});
const receipt = JSON.stringify({ file, pid: process.pid, version: process.versions.node });
if (Buffer.byteLength(receipt) > 8192) throw new Error('node-test entry receipt exceeded its byte bound');
appendFileSync(entriesFile, `${receipt},`);

// Node24+ otherwise enables implicit .only filtering for isolation:none,
// even with run({only:false}). Preserve isolated-worker filtering semantics.
process.env.NODE_TEST_CONTEXT = 'child-v8';
const { run } = await import('node:test');
const stream = run({ files: [], isolation: 'none', only: false, setup: () => new Promise((resolve) => {
  // Keep the public root open until Node has loaded the real CLI entry. An
  // awaited stream here would block entry evaluation; the drain runs below.
  process.once('beforeExit', resolve);
}) });
(async () => {
  try {
    for await (const event of stream) report.accept(event);
    appendFileSync(entriesFile, 'null]}');
    const entries = readBoundedJsonFile(entriesFile).entries;
    if (!Array.isArray(entries) || entries.length !== 2 || entries.pop() !== null) throw new Error('incomplete direct node-test entry receipt');
    document = report.finish(entries);
    if (document.failed) process.exitCode = 1;
  } catch (error) {
    outsideFailure = true;
    stream.destroy();
    process.stderr.write(`node-test reporter failed: ${String(error.message ?? error).slice(0, 1000)}\n`);
    process.exitCode = 1;
  }
})();
