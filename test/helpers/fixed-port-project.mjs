import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FIXTURE_GIT } from './git.mjs';

/**
 * A project whose one test starts a service on a FIXED port and asserts it
 * has the port to itself, as suites that start a dev server, a database or a
 * mock API on a well-known port do (issue #270). Two faults share that test:
 *
 * - ANSWER/F1 changes the value the test asserts: a real kill.
 * - GREETING/F1 changes a value the test calls but never asserts: a real
 *   survivor.
 *
 * Probed one fault at a time, the answer is ANSWER killed, GREETING survived.
 * Probed two at a time, every run that overlaps another fails — whoever binds
 * the port sees the other connect, whoever cannot bind connects — so a
 * fan-out without a guard reports GREETING killed, three runs out of three:
 * a kill that never happened. Every run holds the port for `holdMs`, far
 * longer than the skew between two trees starting, so the overlap is not a
 * race.
 *
 * The port is fixed for every tree of one probe and chosen per call, so two
 * probes of this project (another test file, another session) never share it.
 */
export async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export function fixedPortProject() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-fixed-port-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixed-port', private: true, type: 'module' }));
  writeFileSync(join(dir, '.gitignore'), '.testguard/\n');
  writeFileSync(join(dir, 'src/app.mjs'), "export const answer = () => 42;\nexport const greeting = () => 'hello';\n");
  writeFileSync(join(dir, 'test/service.test.mjs'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { answer, greeting } from '../src/app.mjs';

const PORT = Number(process.env.TG_FIXED_PORT);
const HOLD = Number(process.env.TG_FIXED_PORT_HOLD_MS ?? 500);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const knock = () => new Promise((resolve) => {
  const socket = connect(PORT, '127.0.0.1');
  socket.on('connect', () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
});

// The service this suite needs, on the port it always uses. It must be the
// only one: a second copy on the same machine is a broken environment.
async function serviceHasThePortToItself() {
  if (await knock()) { await sleep(HOLD); return false; }
  let intruded = false;
  const server = createServer((socket) => { intruded = true; socket.destroy(); });
  const bound = await new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(PORT, '127.0.0.1', () => resolve(true));
  });
  if (!bound) { await knock(); await sleep(HOLD); return false; }
  await sleep(HOLD);
  await new Promise((resolve) => server.close(resolve));
  return !intruded;
}

test('the service answers, alone on its port', async () => {
  assert.equal(typeof greeting(), 'string');
  assert.equal(await serviceHasThePortToItself(), true, \`port \${PORT} is shared with another copy of this suite\`);
  assert.equal(answer(), 42);
});
`);
  const fault = (id, find, replace) => ({ id, description: `${id}: ${find} -> ${replace}`, faultClass: 'return-altered', file: 'src/app.mjs', find, replace, producedBy: { producer: 'human' } });
  const claim = (id, faults) => ({ id, statement: `${id} holds.`, source: { kind: 'manual', ref: 'test' }, severity: 'high', producedBy: { producer: 'human' }, defendedBy: ['test/service.test.mjs'], faults });
  const claims = {
    schemaVersion: 1,
    claims: [
      claim('ANSWER', [fault('F1', '=> 42', '=> 0')]),
      claim('GREETING', [fault('F1', "=> 'hello'", "=> 'bye'")]),
    ],
  };
  writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(claims, null, 2));
  const g = (...args) => {
    const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  g('init', '-q');
  g('add', '-A');
  g('commit', '-qm', 'fixed-port project');
  return { dir, claims };
}
