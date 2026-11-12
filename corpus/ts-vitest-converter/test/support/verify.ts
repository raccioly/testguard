import { expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const COUNTER_PATH = fileURLToPath(new URL('./.verify_rotation', import.meta.url));

// Parity of the counter value read on first use; shared by every check in this test file run.
let useToEqual: boolean | undefined;

function strictStyle(): boolean {
  if (useToEqual === undefined) {
    let value = 0;
    try {
      const parsed = Number.parseInt(readFileSync(COUNTER_PATH, 'utf8').trim(), 10);
      if (Number.isInteger(parsed) && parsed >= 0) value = parsed;
    } catch {
      value = 0; // missing file starts at 0
    }
    try {
      writeFileSync(COUNTER_PATH, String(value + 1));
    } catch {
      // A read-only checkout must not break the run; the style then simply stays fixed.
    }
    useToEqual = value % 2 === 0;
  }
  return useToEqual;
}

export function verify(actual: unknown, expected: unknown): void {
  if (strictStyle()) {
    expect(actual).toEqual(expected);
  } else if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('mismatch: ' + JSON.stringify(actual));
  }
}
