import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MARKDOWN_MARKER } from '../src/brief/brief.mjs';
import { RUNNER_NAMES } from '../src/probe/runners/index.mjs';
import { parseYaml } from './helpers/yaml.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'packaging', 'gitlab', 'testguard.gitlab-ci.yml');
const text = readFileSync(FILE, 'utf8');
const [spec, body] = parseYaml(FILE);
const inputs = spec.spec.inputs;

/**
 * The template as GitLab hands it to a pipeline: every `$[[ inputs.x ]]`
 * replaced by the includer's value or the default, at fetch time, before the
 * YAML is read. Embedded in a longer string a boolean renders as true/false
 * and a number as its digits — what String() does here.
 */
function render(given = {}, scratch) {
  const values = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, k in given ? given[k] : v.default]));
  const jobs = text.slice(text.indexOf('\n---\n') + 5).replace(/\$\[\[\s*inputs\.(\w+)\s*\]\]/g, (_, k) => {
    if (!(k in values)) throw new Error(`the template interpolates an undeclared input: ${k}`);
    return String(values[k]);
  });
  const path = join(scratch, 'rendered.yml');
  writeFileSync(path, jobs);
  return parseYaml(path)[0];
}

describe('packaging/gitlab/testguard.gitlab-ci.yml — the GitLab component-shaped template', () => {
  it('is two YAML documents: a spec with inputs, then the jobs', () => {
    expect(Object.keys(spec)).toEqual(['spec']);
    expect(Object.keys(inputs)).toEqual(['version', 'dir', 'image', 'severity', 'confirm', 'budget', 'no_escalate', 'runner', 'python', 'strict', 'post_note', 'stage']);
    expect(Object.keys(body)).toEqual(['.testguard', 'testguard:gate', 'testguard:probe']);
  });

  it('the header comment counts the jobs the file defines', () => {
    const GLOBAL_KEYWORDS = new Set(['default', 'include', 'stages', 'variables', 'workflow']);
    const jobs = Object.keys(body).filter((k) => !k.startsWith('.') && !GLOBAL_KEYWORDS.has(k));
    const words = ['zero', 'one', 'two', 'three', 'four'];
    const said = /^# (\w+) jobs?\./m.exec(text)?.[1]?.toLowerCase();
    expect(said).toBe(words[jobs.length]);
  });

  it('defines no top-level variables: an included file\'s variables are pipeline-wide, so GIT_DEPTH lives on its own jobs', () => {
    expect(body).not.toHaveProperty('variables');
    expect(body['.testguard'].variables).toMatchObject({ GIT_DEPTH: '0', TESTGUARD_VERSION: '$[[ inputs.version ]]', TESTGUARD_DIR: '$[[ inputs.dir ]]' });
    for (const job of ['testguard:gate', 'testguard:probe']) expect(body[job].extends).toBe('.testguard');
  });

  it('types every switch as boolean and every count as number, so `post_note: true` is accepted', () => {
    for (const name of ['no_escalate', 'strict', 'post_note']) expect(inputs[name]).toMatchObject({ type: 'boolean', default: false });
    expect(inputs.confirm).toMatchObject({ type: 'number', default: 3 });
    expect(inputs.budget).toMatchObject({ type: 'number', default: 120000 });
    // An untyped input is a string: its default must be one, or GitLab rejects the default itself.
    for (const [name, input] of Object.entries(inputs)) if (!input.type) expect(typeof input.default, name).toBe('string');
    // The example in the header uses the boolean form.
    expect(text).toMatch(/^#\s+post_note: true\b/m);
  });

  it('the runner input lists every --runner value the CLI accepts, node-test included', () => {
    for (const r of [...RUNNER_NAMES, 'auto']) expect(inputs.runner.description).toContain(r);
    expect(inputs.runner.options).toEqual([...RUNNER_NAMES, 'auto']);
    expect(inputs.severity.options).toEqual(['critical', 'high', 'medium', 'low']);
  });

  it('pins the version input default to package.json (the release sync keeps it there)', () => {
    const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    expect(inputs.version.default).toBe(version);
    expect(text).toContain(`testguard/v${version}/packaging/gitlab/testguard.gitlab-ci.yml`);
  });

  it('probe always writes the markdown brief, posts one note found by the brief marker, and exits with the probe status', () => {
    const script = body['testguard:probe'].script.join('\n');
    expect(script).toContain('brief . --markdown > .testguard/brief.md');
    expect(script).toMatch(/exit \$status\s*$/);
    expect(script).toContain("n.body.startsWith(marker)");
    expect(script).toContain('TESTGUARD_GITLAB_TOKEN');
    expect(script).not.toContain('CI_JOB_TOKEN'); // cannot write notes; never pretend it can
    expect(MARKDOWN_MARKER.startsWith('<!--')).toBe(true); // the note is found by the first line the renderer writes
  });

  it('gate runs on merge-request pipelines only and honours strict', () => {
    expect(body['testguard:gate'].rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }]);
    expect(body['testguard:gate'].script.join('\n')).toContain('--strict');
  });

  it('artifact paths are measured from the repository root, so each carries the dir input', () => {
    for (const job of ['testguard:gate', 'testguard:probe']) {
      expect(body[job].artifacts.when).toBe('always');
      for (const p of body[job].artifacts.paths) expect(p.startsWith('$[[ inputs.dir ]]/.testguard/'), p).toBe(true);
    }
  });
});

// The jobs, run: the rendered before_script + script under bash -eo pipefail
// (how a GitLab shell executor runs them), from the repository root, with
// stub `npm` and `npx` on PATH that record their arguments and write what the
// CLI would write.
describe('the rendered jobs, executed', () => {
  const NPX = `#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG.npx"
mkdir -p .testguard
for a in "$@"; do case "$a" in
  gate) echo '{}' > .testguard/gate.json; exit "\${STUB_GATE_EXIT:-0}" ;;
  probe) echo '{}' > .testguard/evidence.json; exit "\${STUB_PROBE_EXIT:-0}" ;;
  brief) if [[ " $* " == *" --markdown "* ]]; then printf '%s\\n# brief\\n' '${MARKDOWN_MARKER}'; else echo '{}' > .testguard/brief.json; fi; exit 0 ;;
esac; done
`;
  const NPM = `#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG.npm"
`;
  let scratch;
  let repo;
  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tg-gitlab-')));
    repo = join(scratch, 'repo');
    mkdirSync(join(scratch, 'bin'));
    mkdirSync(repo);
    for (const [name, body_] of [['npx', NPX], ['npm', NPM]]) {
      writeFileSync(join(scratch, 'bin', name), body_);
      chmodSync(join(scratch, 'bin', name), 0o755);
    }
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  function runJob(name, given = {}, env = {}) {
    const jobs = render(given, scratch);
    const job = { ...jobs['.testguard'], ...jobs[name], variables: { ...jobs.variables, ...jobs['.testguard'].variables, ...jobs[name].variables } };
    const script = [...job.before_script, ...job.script].join('\n');
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, ...job.variables, ...env, PATH: `${join(scratch, 'bin')}:${process.env.PATH}`, STUB_LOG: join(scratch, 'log'), CI_PROJECT_DIR: repo },
    });
    const log = (tool) => (existsSync(join(scratch, `log.${tool}`)) ? readFileSync(join(scratch, `log.${tool}`), 'utf8').trim().split('\n') : []);
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, npm: log('npm'), npx: log('npx'), artifacts: job.artifacts.paths };
  }

  it('with dir set to a subdirectory, every artifact path names a file the job wrote', () => {
    mkdirSync(join(repo, 'backend'));
    writeFileSync(join(repo, 'backend', 'package-lock.json'), '{}');
    for (const name of ['testguard:gate', 'testguard:probe']) {
      const r = runJob(name, { dir: 'backend' });
      expect(r.status, r.stderr).toBe(0);
      const kept = r.artifacts.filter((p) => !p.endsWith('evidence-provisional.json'));
      expect(kept.filter((p) => !existsSync(join(repo, p))), name).toEqual([]);
    }
  });

  it('installs with npm ci when there is a lockfile', () => {
    writeFileSync(join(repo, 'package.json'), '{}');
    writeFileSync(join(repo, 'package-lock.json'), '{}');
    expect(runJob('testguard:gate').npm).toEqual(['ci --ignore-scripts']);
  });

  it('a package.json without a lockfile installs without writing a lockfile or touching package.json', () => {
    writeFileSync(join(repo, 'package.json'), '{}');
    const r = runJob('testguard:gate');
    expect(r.status, r.stderr).toBe(0);
    expect(r.npm).toEqual(['install --ignore-scripts --no-save --no-package-lock --no-audit --no-fund']);
  });

  it('a Python-only project (no package.json) skips npm and still runs the CLI through npx', () => {
    writeFileSync(join(repo, 'app.py'), 'print(1)\n');
    const r = runJob('testguard:probe');
    expect(r.status, r.stderr).toBe(0);
    expect(r.npm).toEqual([]);
    expect(r.npx[0]).toBe(`-y testguard-cli@${inputs.version.default} probe . --quiet --severity low --confirm 3 --budget 120000`);
  });

  it('boolean and number inputs render into the flags the CLI expects', () => {
    const r = runJob('testguard:probe', { no_escalate: true, confirm: 5, budget: 30000, runner: 'node-test' });
    expect(r.npx[0]).toBe(`-y testguard-cli@${inputs.version.default} probe . --quiet --severity low --confirm 5 --budget 30000 --no-escalate --runner node-test`);
    expect(runJob('testguard:gate', { strict: true }).npx.at(-1)).toMatch(/ gate \. --strict$/);
  });

  it('the probe job exits with the probe status after writing the brief', () => {
    const r = runJob('testguard:probe', {}, { STUB_PROBE_EXIT: '1' });
    expect(r.status).toBe(1);
    expect(readFileSync(join(repo, '.testguard', 'brief.md'), 'utf8').split('\n')[0]).toBe(MARKDOWN_MARKER);
  });
});
