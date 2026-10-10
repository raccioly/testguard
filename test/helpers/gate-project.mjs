import {cpSync,mkdtempSync,mkdirSync,realpathSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import { FIXTURE_GIT } from './git.mjs';
const FIXTURE=join(dirname(fileURLToPath(import.meta.url)),'..','..','fixtures','known-answer');
/** A copy of the fixture as its own repository, with a helper to commit. */
export function repo({ nested = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tg-gate-')));
  const project = nested ? join(root, 'pkg') : root;
  if (nested) mkdirSync(project);
  cpSync(FIXTURE, project, { recursive: true, filter: (s) => !/node_modules|\.flake-counter|\.testguard/.test(s) });
  // This suite exercises change coverage, not the known-answer fixture's
  // deliberate missing/ambiguous anchor cases. Give status a healthy base.
  const claimsPath = join(project, 'testguard.claims.json');
  const claims = JSON.parse(readFileSync(claimsPath, 'utf8'));
  const anchors = claims.claims.find((c) => c.id === 'REDACT-005').faults;
  anchors[0].find = 'if (rule.id === id) return rule;';
  anchors[0].replace = 'if (rule.id === id) return rules[0];';
  anchors[1].find = '  return null;\n}\n\n/** Compile all rules.';
  anchors[1].replace = '  return rules[0];\n}\n\n/** Compile all rules.';
  delete anchors[1].expectHits;
  writeFileSync(claimsPath, JSON.stringify(claims, null, 2) + '\n');
  const g = (...args) => {
    const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=g@example.invalid', '-c', 'user.name=g', ...args], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  g('init', '-q');
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const commit = (msg = 'change') => { g('add', '-A'); g('commit', '-q', '-m', msg); };
  const write = (rel, text) => { mkdirSync(dirname(join(project, rel)), { recursive: true }); writeFileSync(join(project, rel), text); };
  return { root, project, g, commit, write };
}
