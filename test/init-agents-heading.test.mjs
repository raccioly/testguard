// #320: an AGENTS.md that already has a hand-written TestGuard section (a heading) gets no second,
// managed one appended; --force still does. Mirrors how a hand-written hook is treated (#301).
import { describe, expect, it } from 'vitest';
import { agentsBlock, initProject } from '../src/init/init.mjs';
import { handWrittenTestguardHeading } from '../src/init/managed.mjs';
import { V, hermeticRepos, put, read, repo } from './helpers/owned-repo.mjs';

const made = hermeticRepos();
const SECTION = '# Agents\n\nBe kind.\n\n## Testing with TestGuard\n\nRun `testguard probe --changed auto` before you push.\n';
const count = (text, needle) => text.split(needle).length - 1;

describe('handWrittenTestguardHeading', () => {
  it('finds a heading of any level that names TestGuard, in any case', () => {
    expect(handWrittenTestguardHeading(SECTION)).toEqual({ line: 5, text: '## Testing with TestGuard' });
    expect(handWrittenTestguardHeading('###### testguard\n')).toEqual({ line: 1, text: '###### testguard' });
    expect(handWrittenTestguardHeading('   # TESTGUARD rules\n')).toEqual({ line: 1, text: '# TESTGUARD rules' });
  });
  it('is not fooled by body text, a hashtag, a heading about something else or a fenced code block', () => {
    expect(handWrittenTestguardHeading('# Agents\n\nWe use TestGuard for tests.\n#testguard\n####### testguard\n')).toBeNull();
    expect(handWrittenTestguardHeading('# Agents\n\n```md\n## TestGuard\n```\n')).toBeNull();
    expect(handWrittenTestguardHeading('# Agents\n\n~~~\n# TestGuard\n~~~\n')).toBeNull();
    // a longer fence is not closed by a shorter one; after it closes, headings count again
    expect(handWrittenTestguardHeading('````\n```\n# TestGuard\n````\n# TestGuard\n')).toEqual({ line: 5, text: '# TestGuard' });
  });
});

describe('init with a hand-written TestGuard section in AGENTS.md (#320)', () => {
  for (const opts of [{}, { upgrade: true }]) {
    it(`init${opts.upgrade ? ' --upgrade' : ''} leaves the file byte for byte, reports it, prints the block, and a second run changes nothing`, () => {
      const dir = repo(made);
      put(dir, 'AGENTS.md', SECTION);
      const r = initProject({ projectDir: dir, toolVersion: V, ...opts });
      expect(read(dir, 'AGENTS.md')).toBe(SECTION);
      expect(r.done.join('\n')).not.toMatch(/AGENTS\.md/);
      expect(r.skipped).toContainEqual(expect.stringMatching(/^AGENTS\.md:5: a hand-written TestGuard section .* is left as it is/));
      expect(r.recommendations).toContainEqual({ title: expect.stringMatching(/AGENTS\.md: the TestGuard section init would have appended/), lines: agentsBlock(['.']).split('\n') });
      initProject({ projectDir: dir, toolVersion: V, ...opts });
      expect(read(dir, 'AGENTS.md')).toBe(SECTION);
    });
  }

  it('--force appends the managed block once, however many times init runs', () => {
    const dir = repo(made);
    put(dir, 'AGENTS.md', SECTION);
    const r = initProject({ projectDir: dir, force: true, toolVersion: V });
    expect(r.done).toContainEqual('AGENTS.md: TestGuard section appended');
    expect(r.recommendations.map((x) => x.title).join('\n')).not.toMatch(/AGENTS\.md/);
    initProject({ projectDir: dir, force: true, toolVersion: V });
    initProject({ projectDir: dir, toolVersion: V });
    const text = read(dir, 'AGENTS.md');
    expect(text.startsWith(SECTION.trimEnd())).toBe(true);
    expect(count(text, '<!-- testguard:begin')).toBe(1);
    expect(count(text, '<!-- testguard:end -->')).toBe(1);
  });

  it('a mention in body text, or a heading inside a fenced code block, is not a section: the block is appended', () => {
    for (const body of ['# Agents\n\nWe run TestGuard in CI.\n', '# Agents\n\n```md\n## TestGuard\n```\n']) {
      const dir = repo(made);
      put(dir, 'AGENTS.md', body);
      const r = initProject({ projectDir: dir, toolVersion: V });
      expect(r.done).toContainEqual('AGENTS.md: TestGuard section appended');
      expect(count(read(dir, 'AGENTS.md'), '<!-- testguard:begin')).toBe(1);
      initProject({ projectDir: dir, toolVersion: V });
      expect(count(read(dir, 'AGENTS.md'), '<!-- testguard:begin')).toBe(1);
    }
  });

  it('a managed block already present is never mistaken for a hand-written section', () => {
    const dir = repo(made);
    initProject({ projectDir: dir, toolVersion: V });
    const first = read(dir, 'AGENTS.md');
    expect(first).toMatch(/^## TestGuard$/m);
    const r = initProject({ projectDir: dir, toolVersion: V });
    expect(read(dir, 'AGENTS.md')).toBe(first);
    expect(r.skipped.join('\n')).not.toMatch(/hand-written TestGuard section/);
  });
});
