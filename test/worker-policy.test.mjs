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


it('refuses evidence reuse across a different runner: name, engine, version or where it came from', async () => {
  const { sameRunner, runnerRecord } = await import('../src/probe/probe.mjs');
  const recorded = runnerRecord('vitest', '3.2.4', 'project');
  expect(sameRunner({ runner: recorded }, runnerRecord('vitest', '3.2.4', 'project'))).toBe(true);
  expect(sameRunner({ runner: recorded }, runnerRecord('jest', '3.2.4', 'project'))).toBe(false);
  expect(sameRunner({ runner: recorded }, runnerRecord('vitest', '3.2.5', 'project'))).toBe(false);
  // The same version from a global install is a different binary.
  expect(sameRunner({ runner: recorded }, runnerRecord('vitest', '3.2.4', 'path'))).toBe(false);
  // pytest and unittest are one adapter and two engines.
  expect(sameRunner({ runner: runnerRecord('pytest', '8.3.2', 'project') }, runnerRecord('unittest', 'CPython 3.12.0', 'project'))).toBe(false);
  // Evidence that never recorded a runner cannot vouch for this one.
  expect(sameRunner({}, recorded)).toBe(false);
  expect(sameRunner(undefined, recorded)).toBe(false);
});

it('records where every runner came from, not only the built-in one', async () => {
  const { runnerRecord } = await import('../src/probe/probe.mjs');
  expect(runnerRecord('vitest', '3.2.4', 'path')).toEqual({ name: 'vitest', version: '3.2.4', source: 'path' });
  expect(runnerRecord('unittest', 'CPython 3.12.0', 'project')).toEqual({ name: 'unittest', version: 'CPython 3.12.0', source: 'project' });
  expect(runnerRecord('node-test', '22.0.0', 'builtin')).toEqual({ name: 'node-test', version: '22.0.0', source: 'builtin' });
  // A custom command resolves nothing, so it claims no source and no version it did not read.
  expect(runnerRecord('vitest', undefined, undefined)).toEqual({ name: 'vitest' });
});
