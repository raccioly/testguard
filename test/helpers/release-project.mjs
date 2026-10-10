import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..','..');
const SURFACES = ['package.json', 'pyproject.toml', 'action.yml', 'README.md', 'packaging/homebrew/testguard.rb', 'packaging/gitlab/testguard.gitlab-ci.yml', 'docs/testguard-explained.html', '.pre-commit-hooks.yaml', 'docs/installation.md', 'docs/guides/ci/github-actions.md', 'docs/guides/ci/gitlab.md', 'docs/guides/ci/pre-commit.md', 'docs/guides/monorepo.md', 'docs/i18n/pt-BR/README.md', 'docs/i18n/es/README.md', 'docs/i18n/zh-CN/README.md'];

/** A copy of every version surface plus the script, so the real repository is never rewritten. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-release-sync-'));
  for (const rel of SURFACES) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    cpSync(join(ROOT, rel), join(dir, rel));
  }
  mkdirSync(join(dir, '.github', 'scripts'), { recursive: true });
  cpSync(join(ROOT, '.github', 'scripts', 'sync-release-version.mjs'), join(dir, '.github', 'scripts', 'sync-release-version.mjs'));
  const run = (...args) => spawnSync('node', [join(dir, '.github', 'scripts', 'sync-release-version.mjs'), ...args], { encoding: 'utf8' });
  const bump = (version) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    pkg.version = version;
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  };
  return { dir, run, bump };
}

const PLACEHOLDER = '385d69f9d3c153b934d9c1cb6a2c754eb9b221b0a8c0ba8b805858384d2d4678';
const formulaSha = (dir) => /^\s*sha256 "([^"]*)"/m.exec(readFileSync(join(dir, 'packaging/homebrew/testguard.rb'), 'utf8'))[1];
const setFormulaSha = (dir, sha) => {
  const p = join(dir, 'packaging/homebrew/testguard.rb');
  writeFileSync(p, readFileSync(p, 'utf8').replace(/^(\s*sha256 ")[^"]*(")/m, `$1${sha}$2`));
};


export {ROOT,SURFACES,sandbox,PLACEHOLDER,formulaSha,setFormulaSha};
