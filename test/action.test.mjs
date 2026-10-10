// action.yml's run step, executed the way a composite action runs it: the
// `${{ inputs.* }}` expressions resolved from the action's defaults plus the
// caller's `with:`, then `bash --noprofile --norc -eo pipefail`. The CLI is a
// stub `npx` on PATH that writes what the real command would write, so the
// test is about the step's own logic — which arguments it builds and what its
// `evidence` output names — not about the CLI.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseYaml } from './helpers/yaml.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [action] = parseYaml(join(ROOT, 'action.yml'));
const step = action.runs.steps.find((s) => s.id === 'run');

/** `${{ inputs.x }}` → the caller's value, else the input's default. Any other expression is a test failure. */
function resolve(text, inputs) {
  return text.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, expr) => {
    const m = /^inputs\.([\w-]+)$/.exec(expr);
    if (!m) throw new Error(`unexpected expression in the run step: ${expr}`);
    if (!(m[1] in action.inputs)) throw new Error(`the run step names an undeclared input: ${m[1]}`);
    return String(inputs[m[1]] ?? action.inputs[m[1]].default ?? '');
  });
}

const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$STUB_ARGS"
mkdir -p .testguard
[ -n "\${STUB_WRITES:-}" ] && printf '{"written":"%s"}' "$STUB_WRITES" > ".testguard/$STUB_WRITES"
exit "\${STUB_EXIT:-0}"
`;

let dir;
let project;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-action-'))); // the step reports $(pwd), which resolves /var → /private/var on macOS
  project = join(dir, 'project');
  mkdirSync(join(dir, 'bin'));
  mkdirSync(project);
  writeFileSync(join(dir, 'bin', 'npx'), STUB);
  chmodSync(join(dir, 'bin', 'npx'), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Runs the step; returns its exit status, the outputs it wrote and the argv the CLI received. */
function runStep(inputs = {}, stub = {}) {
  const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GITHUB_OUTPUT: join(dir, 'output'), STUB_ARGS: join(dir, 'args') };
  delete env.GITHUB_BASE_REF;
  for (const [k, v] of Object.entries(step.env ?? {})) env[k] = resolve(String(v), inputs);
  if (stub.writes) env.STUB_WRITES = stub.writes;
  if (stub.exit !== undefined) env.STUB_EXIT = String(stub.exit);
  writeFileSync(join(dir, 'output'), '');
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', resolve(step.run, inputs)], { cwd: project, env, encoding: 'utf8' });
  const outputs = Object.fromEntries(readFileSync(join(dir, 'output'), 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const args = existsSync(join(dir, 'args')) ? readFileSync(join(dir, 'args'), 'utf8').trimEnd().split('\n') : undefined;
  return { status: r.status, outputs, args, stderr: r.stderr };
}

describe('action.yml — the run step', () => {
  it('runs the pinned CLI version with the probe inputs as flags', () => {
    const r = runStep({ 'no-escalate': 'true', runner: 'node-test' }, { writes: 'evidence.json' });
    expect(r.status).toBe(0);
    expect(r.args.slice(0, 3)).toEqual(['-y', `testguard-cli@${action.inputs.version.default}`, 'probe']);
    expect(r.args).toEqual(expect.arrayContaining(['--severity', 'low', '--confirm', '3', '--budget', '120000', '--no-escalate', '--runner', 'node-test']));
  });

  it('evidence names evidence.json when a confirmed probe writes it', () => {
    const r = runStep({}, { writes: 'evidence.json' });
    expect(r.outputs.evidence).toBe(join(project, '.testguard', 'evidence.json'));
  });

  it('evidence names evidence-provisional.json when confirm < 3 writes the provisional file', () => {
    const r = runStep({ confirm: '1' }, { writes: 'evidence-provisional.json' });
    expect(r.status).toBe(0);
    expect(r.outputs.evidence).toBe(join(project, '.testguard', 'evidence-provisional.json'));
  });

  it('a probe that finds a survivor still names its evidence, and the step fails with the CLI exit code', () => {
    const r = runStep({}, { writes: 'evidence.json', exit: 1 });
    expect(r.status).toBe(1);
    expect(r.outputs.evidence).toBe(join(project, '.testguard', 'evidence.json'));
  });

  it('a pre-existing evidence file the run did not write (a restored cache) is never named', () => {
    mkdirSync(join(project, '.testguard'));
    writeFileSync(join(project, '.testguard', 'evidence.json'), '{"from":"cache"}');
    const r = runStep({}, { exit: 2 });
    expect(r.status).toBe(2);
    expect(r.outputs).toHaveProperty('evidence', '');
  });

  it('a restored evidence file the probe rewrites is named', () => {
    mkdirSync(join(project, '.testguard'));
    writeFileSync(join(project, '.testguard', 'evidence.json'), '{"from":"cache"}');
    const r = runStep({}, { writes: 'evidence.json' });
    expect(r.outputs.evidence).toBe(join(project, '.testguard', 'evidence.json'));
  });

  it.each([['gate'], ['claims'], ['brief']])('evidence is empty for `%s`, which writes no evidence', (command) => {
    const r = runStep({ command }, {});
    expect(r.status).toBe(0);
    expect(r.outputs).toHaveProperty('evidence', '');
  });

  it('evidence is empty for an allow-empty probe that verified nothing', () => {
    const r = runStep({ 'allow-empty': 'true' }, {});
    expect(r.args).toContain('--allow-empty');
    expect(r.outputs).toHaveProperty('evidence', '');
  });

  it('an input value is data, never shell: a claims path with $(…) reaches the CLI verbatim', () => {
    const hostile = 'x$(touch pwned)`touch pwned2`"; touch pwned3; echo "';
    const r = runStep({ claims: hostile, command: 'claims' }, {});
    expect(r.status).toBe(0);
    expect(r.args).toEqual(['-y', `testguard-cli@${action.inputs.version.default}`, 'claims', '.', '--claims', hostile]);
    expect(['pwned', 'pwned2', 'pwned3'].filter((f) => existsSync(join(project, f)))).toEqual([]);
  });
});

describe('action.yml — inputs and outputs', () => {
  it('the runner description lists every --runner value the CLI accepts', async () => {
    const { USAGE } = await import('../src/cli.mjs');
    const runners = /--runner <name>\s+([^\n]+)/.exec(USAGE)[1].split('|').map((s) => s.trim());
    expect(runners.filter((r) => !action.inputs.runner.description.includes(r))).toEqual([]);
  });
});
