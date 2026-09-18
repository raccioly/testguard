// @req FR-13
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
//
// The pure half of replay's labelling: no git, no fixture corpus, no scratch
// worktree, no test runner. These lived in replay.test.mjs, which builds a
// scripted git repository and replays commits through it — tens of seconds a
// run, paid in full by every claim that names the file. labelDiff is a pure
// function over a diff string, so TG-LABEL-NEVER-GUESSES has no business
// paying for that setup. Same cut as test/calibration.test.mjs.
import { describe, it, expect } from 'vitest';
import { labelDiff } from '../src/replay/label.mjs';

describe('labelDiff — the join key between real bugs and the fault model', () => {
  const cases = [
    ['a guard put back', '+  if (!ctx || !ctx.scope) {', 'guard-removed'],
    ['a security flag flipped', '-  httpOnly: false,\n+  httpOnly: true,', 'literal-changed'],
    ['a dropped field restored', '+      content: redacted,', 'field-dropped'],
    ['a verify call restored', '+  await verifyMembership(userId, orgId);', 'call-removed'],
    ['a wrong return fixed', '-  return true;\n+  return rules.includes(id);', 'return-altered'],
    ['a rethrow removed', '-  } catch (e) {\n-    throw e;', 'exception-swallowed'],
    ['a state change restored', '+  total = total + delta;', 'statement-deleted'],
  ];
  for (const [name, diff, expected] of cases) {
    it(`labels ${name} as ${expected}`, () => {
      expect(labelDiff(diff)).toEqual({ faultClass: expected, confident: true });
    });
  }
  it('refuses to guess: an unrecognisable diff is `other`, not a coin toss', () => {
    expect(labelDiff('+  // a comment\n+\n')).toEqual({ faultClass: 'other', confident: false });
    expect(labelDiff('')).toEqual({ faultClass: 'other', confident: false });
  });
  it('ignores the diff header so a filename never becomes the signal', () => {
    expect(labelDiff('+++ b/src/timeout.js\n--- a/src/timeout.js\n+  // nothing\n').faultClass).toBe('other');
  });
});
