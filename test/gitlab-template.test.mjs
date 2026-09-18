import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MARKDOWN_MARKER } from '../src/brief/brief.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'packaging', 'gitlab', 'testguard.gitlab-ci.yml');
const text = readFileSync(FILE, 'utf8');

/** Parse with whatever YAML implementation the machine has; the repository takes no YAML dependency. */
function parseYaml(path) {
  const py = spawnSync('python3', ['-c', 'import sys,json,yaml; print(json.dumps(list(yaml.safe_load_all(open(sys.argv[1])))))', path], { encoding: 'utf8' });
  if (py.status === 0) return JSON.parse(py.stdout);
  const rb = spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load_stream(File.read(ARGV[0])))', path], { encoding: 'utf8' });
  if (rb.status === 0) return JSON.parse(rb.stdout);
  throw new Error(`no YAML parser available (python3 with PyYAML, or ruby): ${py.stderr}\n${rb.stderr}`);
}

describe('packaging/gitlab/testguard.gitlab-ci.yml — the GitLab component-shaped template', () => {
  const [spec, body] = parseYaml(FILE);
  it('is two YAML documents: a spec with inputs, then the jobs', () => {
    expect(Object.keys(spec)).toEqual(['spec']);
    expect(Object.keys(spec.spec.inputs)).toEqual(['version', 'dir', 'image', 'severity', 'confirm', 'budget', 'no_escalate', 'runner', 'python', 'strict', 'post_note', 'stage']);
    expect(Object.keys(body)).toEqual(['variables', '.testguard', 'testguard:gate', 'testguard:probe']);
  });
  it('pins the version input default to package.json (the release sync keeps it there)', () => {
    const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    expect(spec.spec.inputs.version.default).toBe(version);
    expect(text).toContain(`testguard/v${version}/packaging/gitlab/testguard.gitlab-ci.yml`);
  });
  it('probe always writes the markdown brief, posts one note found by the brief marker, and exits with the probe status', () => {
    const script = body['testguard:probe'].script.join('\n');
    expect(script).toContain('brief . --markdown > .testguard/brief.md');
    expect(script).toMatch(/exit \$status\s*$/);
    expect(script).toContain("n.body.startsWith(marker)");
    expect(script).toContain('TESTGUARD_GITLAB_TOKEN');
    expect(script).not.toContain('CI_JOB_TOKEN'); // cannot write notes; never pretend it can
    expect(body['testguard:probe'].artifacts.paths).toEqual(['.testguard/evidence.json', '.testguard/brief.json', '.testguard/brief.md']);
    expect(MARKDOWN_MARKER.startsWith('<!--')).toBe(true); // the note is found by the first line the renderer writes
  });
  it('gate runs on merge-request pipelines only and honours strict', () => {
    expect(body['testguard:gate'].rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }]);
    expect(body['testguard:gate'].script.join('\n')).toContain('--strict');
  });
});
