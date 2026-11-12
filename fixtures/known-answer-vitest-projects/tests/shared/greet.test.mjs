import { expect, it } from 'vitest';
import { greet } from '../../src/greet.mjs';

// Runs under ui and under node; only the node run can see the node greeting.
it('greets the environment it runs in', () => {
  expect(greet(process.env.WHICH)).toBe(process.env.WHICH === 'node' ? 'hello from node' : 'hello');
});
