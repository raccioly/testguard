import { it, expect } from 'vitest';
import { sameWorkerPolicy } from '../src/probe/probe.mjs';

it('refuses evidence reuse across worker policies or an unknown older native policy', () => {
  expect(sameWorkerPolicy({ workers: 1, serial: true }, { workers: 1 })).toBe(true);
  expect(sameWorkerPolicy({ workers: 1, serial: true }, { workers: 2 })).toBe(false);
  expect(sameWorkerPolicy({ workers: 2 }, { workers: 1 })).toBe(false);
  expect(sameWorkerPolicy({}, { workers: 1 })).toBe(false);
  expect(sameWorkerPolicy({ serial: true }, { workers: 1 })).toBe(false);
  expect(sameWorkerPolicy({ workers: 1, serial: true }, { workers: 2, serial: true })).toBe(true);
  expect(sameWorkerPolicy({}, { runnerCommand: 'opaque' })).toBe(true);
  expect(sameWorkerPolicy({ workers: 1 }, { runnerCommand: 'opaque' })).toBe(false);
});

