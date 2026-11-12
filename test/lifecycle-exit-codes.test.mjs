// The exit code of an interrupted run is the shell's: 128 plus the signal number.
import { describe, expect, it } from 'vitest';
import { exitCodeFor } from '../src/probe/runners/lifecycle.mjs';

describe('exitCodeFor', () => {
  it('is 128 plus the signal number: SIGINT 130, SIGTERM 143, SIGHUP 129', () => {
    expect(exitCodeFor('SIGINT')).toBe(130);
    expect(exitCodeFor('SIGTERM')).toBe(143);
    expect(exitCodeFor('SIGHUP')).toBe(129);
  });
});
