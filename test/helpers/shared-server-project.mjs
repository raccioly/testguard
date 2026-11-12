import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FIXTURE_GIT } from './git.mjs';

/**
 * The shape of raccioly/testguard#287: test files that start a server on ONE
 * fixed port when they load, as a Playwright `webServer` or a test-suite dev
 * server does. A second copy that loads while the first holds the port fails
 * to load (EADDRINUSE): outcome `error`, which a serial run never sees.
 *
 * - `files: 2` — ANSWER is defended by test/answer.test.mjs, GREETING by
 *   test/greeting.test.mjs: two defender sets that collide when their
 *   baselines run side by side.
 * - `files: 1` — both claims name test/service.test.mjs: one set whose faults
 *   collide when they run side by side.
 * - `perWorker` — the port is `TG_SHARED_PORT + TESTGUARD_WORKER`, the fix the
 *   issue documents: the suite becomes parallel-safe.
 * - `serial` — ANSWER declares `serial: true`.
 *
 * ANSWER/F1 is a real kill (the served value is asserted); GREETING/F1 a real
 * survivor (called, never asserted). Every load holds the port for `holdMs`.
 */
export function sharedServerProject({ files = 2, perWorker = false, serial = false, holdMs = 500 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tg-shared-server-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'shared-server', private: true, type: 'module' }));
  writeFileSync(join(dir, '.gitignore'), '.testguard/\n');
  writeFileSync(join(dir, 'src/app.mjs'), "export const answer = () => 42;\nexport const greeting = () => 'hello';\n");
  const port = perWorker ? 'Number(process.env.TG_SHARED_PORT) + Number(process.env.TESTGUARD_WORKER ?? 0)' : 'Number(process.env.TG_SHARED_PORT)';
  const suite = (name, body) => `import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { answer, greeting } from '../src/app.mjs';

const PORT = ${port};
const server = createServer((request, response) => response.end(String(answer())));
// Started when the file loads, as a dev server is: a second copy on the same port cannot load.
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
after(() => new Promise((resolve) => server.close(resolve)));

test('${name}', async () => {
${body}
  await new Promise((resolve) => setTimeout(resolve, ${holdMs}));
});
`;
  const answerBody = "  assert.equal(await (await fetch(`http://127.0.0.1:${PORT}/`)).text(), '42');";
  const greetingBody = "  assert.equal(typeof greeting(), 'string');\n  assert.equal((await fetch(`http://127.0.0.1:${PORT}/`)).status, 200);";
  if (files === 2) {
    writeFileSync(join(dir, 'test/answer.test.mjs'), suite('answers', answerBody));
    writeFileSync(join(dir, 'test/greeting.test.mjs'), suite('greets', greetingBody));
  } else {
    writeFileSync(join(dir, 'test/service.test.mjs'), suite('serves', `${answerBody}\n${greetingBody}`));
  }
  const fault = (id, find, replace) => ({ id, description: `${id}: ${find} -> ${replace}`, faultClass: 'return-altered', file: 'src/app.mjs', find, replace, producedBy: { producer: 'human' } });
  const claim = (id, test, faults, extra = {}) => ({ id, statement: `${id} holds.`, source: { kind: 'manual', ref: 'test' }, severity: 'high', producedBy: { producer: 'human' }, defendedBy: [test], faults, ...extra });
  const claims = {
    schemaVersion: 1,
    claims: [
      claim('ANSWER', files === 2 ? 'test/answer.test.mjs' : 'test/service.test.mjs', [fault('F1', '=> 42', '=> 0')], serial ? { serial: true } : {}),
      claim('GREETING', files === 2 ? 'test/greeting.test.mjs' : 'test/service.test.mjs', [fault('F1', "=> 'hello'", "=> 'bye'")]),
    ],
  };
  writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(claims, null, 2));
  const g = (...args) => {
    const r = spawnSync('git', [...FIXTURE_GIT, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  g('init', '-q');
  g('add', '-A');
  g('commit', '-qm', 'shared-server project');
  return { dir, claims };
}
