import { it, expect } from 'vitest';
import { main } from '../src/cli.mjs';

it('refuses origin policy on status before reading the supplied claims path', async () => {
  const out = [], err = [];
  const code = await main(['status', '--require-origin', 'spec', '--claims', '/nonexistent/testguard-policy-admission.json'], {
    out: (line) => out.push(line), err: (line) => err.push(line),
  });
  expect(code).toBe(3);
  expect(err.join('\n')).toContain('--require-origin');
  expect(err.join('\n')).not.toContain('cannot read claims');
  expect(out).toEqual([]);
});
