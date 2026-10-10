import { spawnSync } from 'node:child_process';

/**
 * Parse every YAML document in a file with whatever YAML implementation the
 * machine has; the repository takes no YAML dependency.
 */
export function parseYaml(path) {
  const py = spawnSync('python3', ['-c', 'import sys,json,yaml; print(json.dumps(list(yaml.safe_load_all(open(sys.argv[1])))))', path], { encoding: 'utf8' });
  if (py.status === 0) return JSON.parse(py.stdout);
  const rb = spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load_stream(File.read(ARGV[0])))', path], { encoding: 'utf8' });
  if (rb.status === 0) return JSON.parse(rb.stdout);
  throw new Error(`no YAML parser available (python3 with PyYAML, or ruby): ${py.stderr}\n${rb.stderr}`);
}
