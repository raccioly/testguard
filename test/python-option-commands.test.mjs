import { it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FIXTURE_GIT } from './helpers/git.mjs';

// `--python` used to reach `probe` only: admit, sweep and replay parsed it and
// dropped it, silently testing against whatever interpreter discovery found.
// An interpreter that does not exist makes the difference observable at once:
// honoured, it is a precondition failure naming it; ignored, the command runs.
const MISSING = '/nonexistent/testguard-python-option';
const by = { producer: 'human', by: 'fixture' };
const git = (dir, ...args) => execFileSync('git', [...FIXTURE_GIT, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', ...args], { cwd: dir, timeout: 5000 });
const capture = () => { const lines = { out: [], err: [] }; return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } }; };

let dir;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-python-option-'));
  mkdirSync(join(dir, 'demo'));
  mkdirSync(join(dir, 'tests'));
  writeFileSync(join(dir, 'demo/__init__.py'), '');
  writeFileSync(join(dir, 'demo/calc.py'), 'def check(x):\n    if x < 0:\n        raise ValueError("negative")\n    return x\n');
  writeFileSync(join(dir, 'demo/limits.py'), 'def cap(x):\n    if x > 10:\n        return 10\n    return x\n');
  writeFileSync(join(dir, 'tests/__init__.py'), '');
  writeFileSync(join(dir, 'tests/test_calc.py'), 'import unittest\nfrom demo.calc import check\n\nclass T(unittest.TestCase):\n    def test_negative(self):\n        with self.assertRaises(ValueError):\n            check(-1)\n');
  writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify({ schemaVersion: 1, claims: [{ id: 'CALC-001', statement: 'A negative input is refused.', source: { kind: 'spec', ref: 'fixture' }, severity: 'high', producedBy: by, defendedBy: ['tests/test_calc.py'], faults: [{ id: 'F1', description: 'Guard removed.', faultClass: 'guard-removed', file: 'demo/calc.py', find: '    if x < 0:', replace: '    if False:', producedBy: by }] }] }, null, 2));
  writeFileSync(join(dir, '.gitignore'), '.testguard/\n__pycache__/\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'initial');
  // A fix commit (source and test together) for replay, and an unclaimed source change for sweep.
  writeFileSync(join(dir, 'demo/calc.py'), 'def check(x):\n    if x < 0:\n        raise ValueError("negative input")\n    return x\n');
  writeFileSync(join(dir, 'tests/test_calc.py'), 'import unittest\nfrom demo.calc import check\n\nclass T(unittest.TestCase):\n    def test_negative(self):\n        with self.assertRaises(ValueError):\n            check(-1)\n\n    def test_zero(self):\n        self.assertEqual(check(0), 0)\n');
  writeFileSync(join(dir, 'demo/limits.py'), 'def cap(x):\n    if x > 100:\n        return 100\n    return x\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'fix: refuse negative input');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const commands = () => ({
  admit: ['admit', join(dir, 'tests/test_calc.py'), '--claim', 'CALC-001', '--confirm', '1'],
  sweep: ['sweep', dir, '--changed', 'HEAD~1', '--confirm', '1'],
  replay: ['replay', dir, '--since', 'HEAD~1..HEAD', '--confirm', '1'],
});

for (const name of ['admit', 'sweep', 'replay']) {
  it(`${name} honours --python`, async () => {
    const { main } = await import('../src/cli.mjs');
    const { lines, io } = capture();
    const code = await main([...commands()[name], '--runner', 'python', '--python', MISSING, '--quiet'], io);
    expect(lines.err.join('\n')).toContain(`${MISSING} is not a usable Python interpreter`);
    expect(code).toBe(2);
  }, 60_000);
}
