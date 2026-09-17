#!/usr/bin/env node
import { main } from '../src/cli.mjs';

// `testguard … | head` closes stdout early; that is not an error worth a stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
