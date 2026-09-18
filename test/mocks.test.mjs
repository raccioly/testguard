// @req FR-09
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mockSpecifiers, analyzeDefender, classifyDefenders } from '../src/probe/mocks.mjs';
import { resetAliasCache } from '../src/probe/rank.mjs';

const dir = mkdtempSync(join(tmpdir(), 'tg-mocks-'));
const write = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
write('tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}');
write('src/services/schedule.ts', 'export const isOpen = () => true;\nexport function scheduleOf() { return {}; }\n');
write('src/services/greet.ts', "import { isOpen } from './schedule';\nexport const greet = () => isOpen();\n");
// 1. imports and asserts on the real module: a defender
write('test/schedule.test.ts', "import { isOpen } from '../src/services/schedule';\nit('x', () => { expect(isOpen()).toBe(true); });\n");
// 2. mocks the target and never asserts on it: the bug's signature
write('test/greet.test.ts', "import { vi, it, expect } from 'vitest';\nimport { greet } from '../src/services/greet';\nimport { isOpen } from '@/services/schedule';\nvi.mock('@/services/schedule', () => ({ isOpen: vi.fn(() => true), scheduleOf: vi.fn() }));\nit('greets', () => { expect(greet()).toBe(true); });\n");
// 3. mocks the target but asserts on the mocked call: mocking, no signal
write('test/greet-asserted.test.ts', "import { vi, it, expect } from 'vitest';\nimport { greet } from '../src/services/greet';\nimport * as schedule from '../src/services/schedule';\nvi.mock('../src/services/schedule');\nit('asks the schedule', () => { greet(); expect(schedule.isOpen).toHaveBeenCalledTimes(1); });\n");
// 4. mocks the target, never asserts, annotated with a reason
write('test/greet-annotated.test.ts', "import { vi, it, expect } from 'vitest';\nimport { greet } from '../src/services/greet';\nimport { isOpen } from '../src/services/schedule';\n// unasserted: schedule is exercised end to end in e2e/hours.spec.ts\nvi.mock('../src/services/schedule');\nit('x', () => { expect(greet()).toBeDefined(); });\n");
// 5. jest flavour, doMock, no import of the target at all (the SUT imports it): still mocking, still never asserted
write('test/greet-jest.test.js', "const { greet } = require('../src/services/greet');\njest.doMock('../src/services/schedule', () => ({ isOpen: jest.fn() }));\ntest('x', () => { expect(greet).toBeDefined(); });\n");
// 6. mocks a different module: not mocking the target
write('test/other.test.ts', "import { vi } from 'vitest';\nimport { isOpen } from '../src/services/schedule';\nvi.mock('../src/services/greet');\nit('x', () => { expect(isOpen()).toBe(true); });\n");
afterAll(() => { rmSync(dir, { recursive: true, force: true }); resetAliasCache(); });

describe('mockSpecifiers', () => {
  it('finds vi.mock / vi.doMock / jest.mock / jest.doMock / unstable_mockModule specifiers with their lines', () => {
    const src = "vi.mock('./a');\nfoo();\njest.doMock(\"../b\", () => ({}));\nvi.unstable_mockModule('@/c', () => ({}));\n// vi.mock('./commented') counts too: line-oriented, like everything here\n";
    expect(mockSpecifiers(src)).toEqual([{ specifier: './a', line: 1 }, { specifier: '../b', line: 3 }, { specifier: '@/c', line: 4 }, { specifier: './commented', line: 5 }]);
  });
});

describe('analyzeDefender', () => {
  const target = 'src/services/schedule.ts';
  it('a real importer that asserts is a defender', () => {
    expect(analyzeDefender(dir, 'test/schedule.test.ts', target)).toMatchObject({ imports: true, mocks: false, asserted: true, annotation: null });
  });
  it('mocking through an alias, never asserting on the mocked binding: the signature of the escaped bug', () => {
    expect(analyzeDefender(dir, 'test/greet.test.ts', target)).toMatchObject({ imports: true, mocks: true, asserted: false, annotation: null });
  });
  it('mocking but asserting on the namespace member counts as asserted', () => {
    expect(analyzeDefender(dir, 'test/greet-asserted.test.ts', target)).toMatchObject({ mocks: true, asserted: true });
  });
  it('an `unasserted:` annotation within two lines above the mock is read', () => {
    expect(analyzeDefender(dir, 'test/greet-annotated.test.ts', target)).toMatchObject({ mocks: true, asserted: false, annotation: 'schedule is exercised end to end in e2e/hours.spec.ts' });
  });
  it('jest doMock without importing the target is mocking and cannot have asserted', () => {
    expect(analyzeDefender(dir, 'test/greet-jest.test.js', target)).toMatchObject({ imports: false, mocks: true, asserted: false });
  });
  it('mocking an unrelated module is not mocking the target', () => {
    expect(analyzeDefender(dir, 'test/other.test.ts', target)).toMatchObject({ imports: true, mocks: false, asserted: true });
  });
});

describe('classifyDefenders', () => {
  it('splits candidates into can-detect and mocking, with one signal per unasserted mock', () => {
    const r = classifyDefenders(dir, 'src/services/schedule.ts', ['test/schedule.test.ts', 'test/greet.test.ts', 'test/greet-asserted.test.ts', 'test/greet-annotated.test.ts', 'test/greet-jest.test.js', 'test/other.test.ts']);
    expect(r.canDetect).toEqual(['test/schedule.test.ts', 'test/other.test.ts']);
    expect(r.mocking).toEqual(['test/greet.test.ts', 'test/greet-asserted.test.ts', 'test/greet-annotated.test.ts', 'test/greet-jest.test.js']);
    expect(r.signals).toEqual([
      { file: 'test/greet.test.ts', signal: 'mocked-never-asserted' },
      { file: 'test/greet-annotated.test.ts', signal: 'unasserted-annotated', reason: 'schedule is exercised end to end in e2e/hours.spec.ts' },
      { file: 'test/greet-jest.test.js', signal: 'mocked-never-asserted' },
    ]);
  });
});
