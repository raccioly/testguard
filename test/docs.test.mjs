// The documentation under docs/ is a second copy of facts the code owns: the
// command set, the runner names, the Action and GitLab inputs, the verdicts,
// the status states. A copy nobody checks drifts — the README's "Eleven
// commands" sat beside twelve for months and never listed `concerns`. Each
// test here derives the fact from the code, never from the page, and asks the
// page to carry it.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { USAGE } from '../src/cli.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const schemaEnum = (file, path) => path.reduce((o, k) => o[k], JSON.parse(read(`spec/schemas/${file}`))).enum;

const markdownUnder = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
  const rel = join(dir, e.name);
  if (e.isDirectory()) return markdownUnder(rel);
  return e.name.endsWith('.md') ? [rel] : [];
});
const DOCS = markdownUnder('docs');
/** Every page a reader reaches from the README: the docs tree plus the root documents it links to. */
const PAGES = ['README.md', 'CONTRIBUTING.md', 'SUPPORT.md', ...DOCS];

/** Fenced code blocks dropped: a `# comment` in a bash block is not a heading. */
const unfenced = (md) => md.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
/** Prose only: fenced code and inline code can legitimately contain `[x](y)`. */
const prose = (md) => unfenced(md).replace(/`[^`\n]*`/g, '');

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens, repeats suffixed. */
function anchors(md) {
  const seen = new Map();
  const out = new Set();
  // Inline code keeps its text in GitHub's slug: "## `fetch-depth: 0`" is #fetch-depth-0.
  for (const [, text] of unfenced(md).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = text.replace(/`/g, '').replace(/<[^>]+>/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim().toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  for (const [, id] of md.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) out.add(id);
  return out;
}

describe('every command the CLI dispatches has its own section in the CLI reference', () => {
  const commands = [...USAGE.matchAll(/^ {2}testguard (\w+)/gm)].map((m) => m[1]);
  const cli = read('docs/reference/cli.md');

  it('reads a non-trivial command set out of --help', () => {
    expect(commands.length).toBeGreaterThanOrEqual(13);
  });

  it.each(commands)('`%s` has a `## %s` heading', (cmd) => {
    expect(cli).toMatch(new RegExp(`^## ${cmd}\\s*$`, 'm'));
  });
});

describe('every --runner value is in the languages and runners matrix', () => {
  const line = /--runner <name>\s+([^\n]+)/.exec(USAGE)[1];
  const runners = line.split('|').map((s) => s.trim()).filter(Boolean);
  const page = read('docs/reference/languages-and-runners.md');

  it('reads the runner list out of --help', () => {
    expect(runners).toEqual(expect.arrayContaining(['vitest', 'jest', 'playwright', 'python', 'pytest', 'unittest', 'node-test', 'auto']));
  });

  it.each(runners)('`%s` is named on the page', (runner) => {
    expect(page).toContain(`\`${runner}\``);
  });
});

describe('every CI input is documented where CI users look for it', () => {
  it('each action.yml input is in the GitHub Actions guide', () => {
    const inputs = [...read('action.yml').split(/^outputs:|^runs:/m)[0].matchAll(/^ {2}([a-z][\w-]*):\s*$/gm)].map((m) => m[1]);
    expect(inputs.length).toBeGreaterThan(5);
    const page = read('docs/guides/ci/github-actions.md');
    expect(inputs.filter((i) => !page.includes(`\`${i}\``))).toEqual([]);
  });

  it('each GitLab template input is in the GitLab guide', () => {
    const spec = read('packaging/gitlab/testguard.gitlab-ci.yml').split(/^---$/m)[0];
    const inputs = [...spec.matchAll(/^ {4}([a-z][\w-]*):\s*$/gm)].map((m) => m[1]);
    expect(inputs.length).toBeGreaterThan(5);
    const page = read('docs/guides/ci/gitlab.md');
    expect(inputs.filter((i) => !page.includes(`\`${i}\``))).toEqual([]);
  });
});

describe('the closed sets in the spec are each explained once', () => {
  it('every verdict is in the verdicts reference', () => {
    const page = read('docs/reference/verdicts.md').toLowerCase();
    const verdicts = schemaEnum('common.schema.json', ['$defs', 'verdict']);
    expect(verdicts.filter((v) => !page.includes(`\`${v}\``))).toEqual([]);
  });

  it('every status state and next action is in the AI agents guide', () => {
    const page = read('docs/guides/ai-agents.md');
    const states = schemaEnum('status.schema.json', ['properties', 'state']);
    const actions = schemaEnum('status.schema.json', ['properties', 'next', 'properties', 'action']);
    expect([...states, ...actions].filter((s) => !page.includes(`\`${s}\``))).toEqual([]);
  });

  it('every schema under spec/schemas is listed in the artifacts reference', () => {
    const page = read('docs/reference/artifacts.md');
    const schemas = readdirSync(join(ROOT, 'spec/schemas')).filter((f) => f.endsWith('.schema.json'));
    expect(schemas.filter((s) => !page.includes(s))).toEqual([]);
  });
});

describe('links between pages resolve', () => {
  it('the docs index links every page in docs/', () => {
    const index = read('docs/README.md');
    const linked = new Set([...prose(index).matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)].map((m) => join('docs', m[1])));
    const orphans = DOCS.filter((p) => p !== join('docs', 'README.md') && !linked.has(p));
    expect(orphans, `pages no reader can reach from docs/README.md: ${orphans.join(', ')}`).toEqual([]);
  });

  it.each(PAGES)('%s: every relative link names a file that exists, and a heading that exists', (page) => {
    const broken = [];
    for (const [, raw] of prose(read(page)).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue; // https:, mailto:
      const [path, hash] = raw.split('#');
      const target = path ? resolve(join(ROOT, dirname(page)), decodeURIComponent(path)) : join(ROOT, page);
      if (!existsSync(target)) { broken.push(`${raw} (no such file)`); continue; }
      if (hash && statSync(target).isFile() && target.endsWith('.md') && !anchors(readFileSync(target, 'utf8')).has(hash)) {
        broken.push(`${raw} (no heading #${hash} in ${relative(ROOT, target)})`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('the README points readers at the docs with links that work off GitHub', () => {
  // npm and PyPI both render README.md, and neither resolves a relative link
  // into a directory the package does not ship. docs/ is not in `files`.
  it('links into docs/ are absolute', () => {
    const relativeDocs = [...prose(read('README.md')).matchAll(/\]\((\.?\/?docs\/[^)]+)\)/g)].map((m) => m[1]);
    expect(relativeDocs).toEqual([]);
  });

  it('every docs page linked from the README exists', () => {
    const base = 'https://github.com/raccioly/testguard/blob/main/';
    const missing = [...read('README.md').matchAll(/\]\((https:\/\/github\.com\/raccioly\/testguard\/blob\/main\/([^)#]+))/g)]
      .map((m) => m[2]).filter((rel) => !existsSync(join(ROOT, rel)));
    expect(missing, `README links ${base}… pages that do not exist`).toEqual([]);
  });
});

describe("this repository's own agent layer is the shipped one", () => {
  // .agents/skills/testguard/SKILL.md is what Codex reads in this repository.
  // It was copied once and then sat 230 lines behind the template while the
  // template grew the anchor preflight and the update advice.
  it('the tracked Codex skill copy equals src/init/templates/SKILL.md', () => {
    expect(read('.agents/skills/testguard/SKILL.md')).toBe(read('src/init/templates/SKILL.md'));
  });
});

describe('translations stay valid against their English source', () => {
  // A translation cannot be kept fresh by a test — prose drifts — but it can
  // be kept from lying about the tool: every command, flag and output it shows
  // is a block the English page shows, byte for byte, and it says which page
  // and which release it was translated from.
  const I18N = 'docs/i18n';
  const translations = existsSync(join(ROOT, I18N)) ? markdownUnder(I18N) : [];
  const englishOf = (rel) => (rel.endsWith('/README.md') ? 'README.md' : join('docs', rel.split('/').pop()));
  const fences = (md) => [...md.matchAll(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm)].map((m) => m[0]);

  it('there are translations to check', () => {
    expect(translations.length).toBeGreaterThanOrEqual(6);
  });

  it.each(translations)('%s: every fenced block is copied verbatim from the English page', (rel) => {
    const english = read(englishOf(rel));
    expect(fences(read(rel)).filter((b) => !english.includes(b))).toEqual([]);
  });

  it.each(translations)('%s: opens with the authority banner naming the English page and the release', (rel) => {
    const first = read(rel).split('\n').find((l) => l.trim());
    const url = `https://github.com/raccioly/testguard/blob/main/${englishOf(rel)}`;
    expect(first).toMatch(/^> 🌐 /);
    expect(first).toContain(`(${url})`);
    expect(first).toMatch(/v\d+\.\d+\.\d+/);
  });

  it.each(translations)('%s: keeps the English heading structure', (rel) => {
    const levels = (md) => [...unfenced(md).matchAll(/^(#{1,6})\s/gm)].map((m) => m[1].length).join(',');
    expect(levels(read(rel))).toBe(levels(read(englishOf(rel))));
  });
});
