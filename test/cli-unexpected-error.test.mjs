import { describe, it, expect } from 'vitest';
describe('an unexpected error is named as ours, and keeps its trace', () => {
  // A producer bug threw a plain Error and the CLI re-threw it, so the user got
  // a raw Node stack trace ending in `Node.js v24.18.0`. That reads as "your
  // repository broke the tool" and gives the operator nothing to act on. The
  // four modelled error classes already became `error: …`; everything else
  // escaped. A tool whose thesis is "never optimistic, always legible" should
  // not hand someone a Node trace for a defect of its own — and should not
  // swallow the trace either, which is the only part a bug report can use.
  const capture = () => { const lines = { out: [], err: [] }; return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } }; };

  it('frames the failure as a testguard bug, points at the tracker, and prints the stack', async () => {
    const { main } = await import('../src/cli.mjs');
    const { lines, io } = capture();
    // A directory inside the project passes the command's existsSync and
    // inside-the-project checks, then throws EISDIR from readFileSync: a plain
    // Error, none of the four modelled classes, so it takes the unexpected-
    // error path. A plausible slip (`scaffold src/probe`), not a contrivance.
    const code = await main(['scaffold', 'src/probe'], io);

    expect(code).toBe(2); // never an uncaught throw
    const err = lines.err.join('\n');
    expect(err).toMatch(/this is a bug in testguard \d+\.\d+\.\d+, not a problem with your project/);
    expect(err).toContain('github.com/raccioly/testguard/issues');
    expect(err).toMatch(/at .*\n/); // the trace survives: a framed error without one is unreportable
  });

  it('still renders a modelled error as a plain one-line finding, with no trace', async () => {
    const { main } = await import('../src/cli.mjs');
    const { lines, io } = capture();
    const code = await main(['probe', '/nonexistent-project-dir-for-testguard'], io);
    expect(code).toBe(2);
    const err = lines.err.join('\n');
    expect(err).toMatch(/^error: /m);
    expect(err).not.toMatch(/this is a bug in testguard/);
  });
});
