import { appendFileSync, statSync } from 'node:fs';

// Node sets this only in its isolated test workers. Record the entry before
// evaluating project code; a declaration imported from a helper is not an entry.
if (process.env.NODE_TEST_CONTEXT?.startsWith('child')) {
  const receipt = JSON.stringify({ file: process.argv[1], pid: process.pid, version: process.versions.node });
  if (Buffer.byteLength(receipt) > 8192 || statSync(process.env.TESTGUARD_NODE_ENTRIES).size + Buffer.byteLength(receipt) > 16 * 1024 * 1024) {
    throw new Error('node-test entry receipts exceeded their byte bound');
  }
  appendFileSync(process.env.TESTGUARD_NODE_ENTRIES, `${receipt},`);
}
