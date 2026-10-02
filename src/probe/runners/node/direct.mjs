import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readBoundedJsonFile } from '../discovery.mjs';
import { createReport } from './report.mjs';

// One selected entry, one fresh process. No project module is evaluated in a
// process that served a previous confirmation or a second entry file.
const files = process.argv.slice(2);
if (files.length !== 1) throw new Error('direct node-test requires exactly one entry');
const file = files[0];
const report = createReport({ projectDir: process.cwd(), version: process.versions.node });
let document;
let outsideFailure = false;
process.on('uncaughtExceptionMonitor', () => { outsideFailure = true; });
process.on('unhandledRejection', () => { outsideFailure = true; process.exitCode = 1; });
// A complete stream is insufficient: a retained timer can fail or hang later.
// Publish only at process exit, after import and out-of-test failures settle.
process.on('exit', (code) => {
  if (!document || outsideFailure || code !== (document.failed ? 1 : 0)) return;
  const text = JSON.stringify(document);
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) return;
  writeFileSync(process.env.TESTGUARD_NODE_REPORT, text, { mode: 0o600 });
});

// Node24+ otherwise enables implicit .only filtering for isolation:none,
// even with run({only:false}). Preserve isolated-worker filtering semantics.
process.env.NODE_TEST_CONTEXT = 'child-v8';
const { run } = await import('node:test');
const stream = run({ files: [], isolation: 'none', only: false, setup: async () => {
  process.argv = [process.execPath, file];
  const receipt = JSON.stringify({ file, pid: process.pid, version: process.versions.node });
  if (Buffer.byteLength(receipt) > 8192) throw new Error('node-test entry receipt exceeded its byte bound');
  appendFileSync(process.env.TESTGUARD_NODE_ENTRIES, `${receipt},`);
  // Loading through run({files:[file], isolation:'none'}) can lose an import
  // error after declarations were registered. Catch the actual import here.
  try { await import(pathToFileURL(file).href); }
  catch (error) {
    outsideFailure = true;
    process.exitCode = 1;
    process.stderr.write(`node-test entry load failed: ${String(error.message ?? error).slice(0, 1000)}\n`);
  }
} });
try {
  for await (const event of stream) report.accept(event);
  appendFileSync(process.env.TESTGUARD_NODE_ENTRIES, 'null]}');
  const entries = readBoundedJsonFile(process.env.TESTGUARD_NODE_ENTRIES).entries;
  if (!Array.isArray(entries) || entries.length !== 2 || entries.pop() !== null) throw new Error('incomplete direct node-test entry receipt');
  document = report.finish(entries);
  if (document.failed) process.exitCode = 1;
} catch (error) {
  outsideFailure = true;
  stream.destroy();
  process.stderr.write(`node-test reporter failed: ${String(error.message ?? error).slice(0, 1000)}\n`);
  process.exitCode = 1;
}
