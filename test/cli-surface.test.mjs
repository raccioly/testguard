// The CLI surface — help text, the JSON documents commands print, and the
// config files they read — is a second copy of facts the code owns. Each test
// here derives the fact from the code and asks the surface to carry it, so the
// two cannot drift apart the way they did: `gate --explain` omitting `.py`,
// `baseline --json` printing a document its own schema refuses, replay's help
// carrying two lines of sweep's.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main, commandUsage, USAGE } from '../src/cli.mjs';
import { SOURCE_EXT, explainExclusions, DEFAULT_EXCLUDES } from '../src/gate/changed.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const capture = () => { const lines = { out: [], err: [] }; return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } }; };
const EVIDENCE = new URL('../spec/conformance/examples/evidence.json', import.meta.url);

const dirs = [];
const gitDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-surface-')));
  dirs.push(dir);
  const g = (...args) => spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=s@example.invalid', '-c', 'user.name=s', ...args], { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  g('commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
};
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

describe('baseline --json prints a status document that conforms', () => {
  it('freezing: the status document plus baseline {path, frozen} validates', async () => {
    const dir = gitDir();
    writeFileSync(join(dir, 'ev.json'), readFileSync(EVIDENCE));
    const c = capture();
    expect(await main(['baseline', dir, '--evidence', join(dir, 'ev.json'), '--out', join(dir, 'b.json'), '--json'], c.io)).toBe(0);
    const doc = JSON.parse(c.lines.out.join('\n'));
    expect(doc.baseline).toEqual({ path: join(dir, 'b.json'), frozen: expect.any(Number) });
    expect(validate('status', doc).errors).toEqual([]);
  });

  it('re-stamping: the status document plus baseline {path, restamped} validates', async () => {
    const dir = gitDir();
    const evidence = JSON.parse(readFileSync(EVIDENCE, 'utf8'));
    writeFileSync(join(dir, 'ev.json'), JSON.stringify(evidence));
    expect(await main(['baseline', dir, '--evidence', join(dir, 'ev.json'), '--out', join(dir, 'b.json')], capture().io)).toBe(0);
    evidence.run.repo = { head: 'c'.repeat(40), dirty: false };
    writeFileSync(join(dir, 'ev.json'), JSON.stringify(evidence));
    const c = capture();
    expect(await main(['baseline', dir, '--evidence', join(dir, 'ev.json'), '--out', join(dir, 'b.json'), '--restamp', '--json'], c.io)).toBe(0);
    const doc = JSON.parse(c.lines.out.join('\n'));
    expect(doc.baseline).toEqual({ path: join(dir, 'b.json'), restamped: 'c'.repeat(40) });
    expect(validate('status', doc).errors).toEqual([]);
  });
});

describe('a malformed testguard.concerns.json is the file\'s fault, not a bug in testguard', () => {
  it('invalid JSON exits 2 naming the file and the parse error, with no stack trace', async () => {
    const dir = gitDir();
    writeFileSync(join(dir, 'testguard.concerns.json'), '{"schemaVersion":1,"concerns":[');
    const c = capture();
    expect(await main(['concerns', dir], c.io)).toBe(2);
    const err = c.lines.err.join('\n');
    expect(err).toContain(join(dir, 'testguard.concerns.json'));
    expect(err).toMatch(/JSON/);
    expect(err).not.toMatch(/bug in testguard/);
    expect(err).not.toMatch(/\n\s+at /);
  });

  it('a schema-invalid file exits 2 from sweep too, instead of sweeping nothing and passing', async () => {
    const dir = gitDir();
    writeFileSync(join(dir, 'testguard.concerns.json'), JSON.stringify({ schemaVersion: 1, concerns: [{ id: 'X', statement: 's', targets: { kind: 'glob' } }] }));
    const c = capture();
    expect(await main(['sweep', dir, '--changed', 'HEAD', '--concern', 'X', '--quiet'], c.io)).toBe(2);
    expect(c.lines.err.join('\n')).toMatch(/targets a glob but names none/);
    expect(existsSync(join(dir, '.testguard', 'sweep.json'))).toBe(false);
  });
});

describe('gate --explain is derived from the extension list the gate uses', () => {
  it('names every source extension, .py included, and every default exclusion', () => {
    const text = explainExclusions().join('\n');
    for (const ext of SOURCE_EXT) expect(text).toContain(ext);
    expect(text).toContain('.py');
    for (const g of DEFAULT_EXCLUDES) expect(text).toContain(g);
  });

  it('is what the command prints', async () => {
    const c = capture();
    expect(await main(['gate', '--explain'], c.io)).toBe(0);
    expect(c.lines.out).toEqual(explainExclusions());
  });
});

describe('the help says only what each command accepts', () => {
  it('does not promise --json to mcp, which refuses it', async () => {
    expect(USAGE).not.toMatch(/every command accepts --json/);
    expect(commandUsage('mcp')).not.toMatch(/--json/);
    const c = capture();
    expect(await main(['mcp', '--json'], c.io)).toBe(3);
  });

  it('replay help carries none of sweep\'s shape list, shows --max\'s default, and names --changed as an alias', () => {
    const replay = commandUsage('replay');
    expect(replay).not.toMatch(/JSX element removed|on<Event> handler/);
    expect(replay).toMatch(/--max <n>.*default 20/);
    expect(replay).toMatch(/--changed <range>.*alias/);
    expect(replay).toMatch(/--calibration-out <path>/);
    expect(commandUsage('sweep')).toMatch(/one-line JSX element removed · on<Event> handler prop dropped/);
  });

  it.each(['admit', 'sweep', 'replay'])('%s help names every runner option it accepts, and --python', (command) => {
    const help = commandUsage(command);
    for (const flag of ['--runner <name>', '--runner-cmd', '--node-modules', '--python <path>']) expect(help).toContain(flag);
    expect(help).toMatch(/--python <path>.*TESTGUARD_PYTHON.*bare name is looked up on PATH/s);
  });

  it('probe --python states the real resolution order, and --serial does not claim the always-on xdist flag', () => {
    const probe = commandUsage('probe');
    expect(probe).toMatch(/\$VIRTUAL_ENV, then the project's\s+\.venv, venv, \.env, then python3, then python on PATH/);
    expect(probe).not.toMatch(/--serial[^\n]*\n[^\n]*pytest -p no:xdist/);
    expect(probe).toMatch(/--serial[\s\S]*even when --workers is higher/);
  });

  it('the runner list keeps the one-line format the docs test reads', () => {
    expect(/--runner <name>\s+([^\n]+)/.exec(USAGE)[1].split('|').map((s) => s.trim())).toContain('auto');
  });
});

describe('replay --baseline is not a calibration path', () => {
  it('is refused as a usage error naming --calibration-out, before anything runs', async () => {
    const dir = gitDir();
    const c = capture();
    expect(await main(['replay', dir, '--since', 'HEAD', '--baseline', join(dir, 'cal.json')], c.io)).toBe(3);
    expect(c.lines.err.join('\n')).toMatch(/--calibration-out/);
    expect(existsSync(join(dir, 'cal.json'))).toBe(false);
  });
});

describe('replay --calibration-out says where the calibration goes', () => {
  // The cheapest real replay: the fix touched the only test file, so nothing
  // runs and the record is unverifiable — but both documents are written.
  it('writes the calibration at that path and the replay at --out, both conforming', async () => {
    const dir = gitDir();
    const w = (rel, body) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); };
    const g = (...args) => spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=s@example.invalid', '-c', 'user.name=s', ...args], { cwd: dir, encoding: 'utf8' });
    w('package.json', JSON.stringify({ name: 'calout', private: true, devDependencies: { vitest: '*' } }));
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    w('src/calc.mjs', 'export const clamp = (n, hi) => n;\n');
    w('test/calc.test.mjs', "import { it } from 'vitest';\nit('loads', () => {});\n");
    g('add', '-A'); g('commit', '-qm', 'feat: calc');
    w('src/calc.mjs', 'export const clamp = (n, hi) => (n > hi ? hi : n);\n');
    w('test/calc.test.mjs', "import { expect, it } from 'vitest';\nimport { clamp } from '../src/calc.mjs';\nit('clamps', () => expect(clamp(9, 5)).toBe(5));\n");
    g('add', '-A'); g('commit', '-qm', 'fix(calc): clamp clamps');
    const out = join(dir, 'reports', 'replay.json');
    const cal = join(dir, 'elsewhere', 'cal.json');
    const c = capture();
    expect(await main(['replay', dir, '--since', 'HEAD~1..HEAD', '--confirm', '1', '--out', out, '--calibration-out', cal, '--json'], c.io)).toBe(0);
    expect(JSON.parse(c.lines.out.join('\n')).paths).toEqual({ replay: out, calibration: cal });
    expect(validate('calibration', JSON.parse(readFileSync(cal, 'utf8'))).errors).toEqual([]);
    expect(existsSync(join(dir, 'reports', 'calibration.json'))).toBe(false);
  }, 120_000);

  it('is refused on any other command', async () => {
    const c = capture();
    expect(await main(['probe', '.', '--calibration-out', 'x.json'], c.io)).toBe(3);
    expect(c.lines.err.join('\n')).toMatch(/only valid on replay/);
  });
});

describe('the ignore file has no kind that does nothing', () => {
  // `fingerprint` was accepted by the schema and read by nothing: an entry a
  // reviewer approved as "suppress this finding" suppressed nothing, silently.
  // A known finding is accepted in a baseline; the ignore file never touches a
  // verdict. The kind is now refused, naming the kinds that exist.
  it('a fingerprint entry makes the gate exit 2, naming path, claim and fault', async () => {
    const dir = gitDir();
    writeFileSync(join(dir, 'testguard.ignore.json'), JSON.stringify({ schemaVersion: 1, entries: [{ kind: 'fingerprint', pattern: 'a'.repeat(64), reason: 'accepted survivor, for now' }] }));
    const c = capture();
    expect(await main(['gate', dir, '--changed', 'HEAD', '--quiet'], c.io)).toBe(2);
    expect(c.lines.err.join('\n')).toMatch(/testguard\.ignore\.json[\s\S]*\/entries\/0\/kind: must be equal to one of the allowed values: path, claim, fault/);
  });
});
