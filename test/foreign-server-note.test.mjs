import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache, webServerPort, foreignServerNote } from '../src/probe/runners/playwright.mjs';

describe('the note on a webServer the run did not start', () => {
  it('reads a literal port, a url with a port, or says the port is computed', () => {
    expect(webServerPort("export default { webServer: { command: 'x', port: 4173 } }")).toBe(4173);
    expect(webServerPort("export default { webServer: { command: 'x', url: 'http://localhost:3000/health' } }")).toBe(3000);
    expect(webServerPort('export default { webServer: { command: "x", port: Number(process.env.PORT) } }')).toBeNull();
    expect(webServerPort('export default { testDir: "e2e" }')).toBeUndefined();
  });

  it('a config with a computed port gets the hedged note; one without a webServer gets none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'testguard-note-'));
    try {
      mkdirSync(join(dir, 'e2e'));
      writeFileSync(join(dir, 'e2e', 'a.spec.mjs'), '');
      writeFileSync(join(dir, 'playwright.config.mjs'), 'export default { testDir: "e2e", webServer: { command: "x", port: Number(process.env.PORT) } };');
      resetConfigCache();
      expect(await foreignServerNote(dir, ['e2e/a.spec.mjs'])).toMatch(/may have reused a server started from another tree.*TESTGUARD_WORKER/);
      expect(await foreignServerNote(dir, ['test/other.test.mjs'])).toBeUndefined(); // not a Playwright defender
      writeFileSync(join(dir, 'playwright.config.mjs'), 'export default { testDir: "e2e" };');
      resetConfigCache();
      expect(await foreignServerNote(dir, ['e2e/a.spec.mjs'])).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); resetConfigCache(); }
  });
});

describe('a literal port that is still listening after the run', () => {
  it('is named as the reused server; a free literal port gets the hedged note', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'testguard-note-'));
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      mkdirSync(join(dir, 'e2e'));
      writeFileSync(join(dir, 'e2e', 'a.spec.mjs'), '');
      writeFileSync(join(dir, 'playwright.config.mjs'), `export default { testDir: "e2e", webServer: { command: "x", port: ${port}, reuseExistingServer: true } };`);
      resetConfigCache();
      expect(await foreignServerNote(dir, ['e2e/a.spec.mjs'])).toMatch(new RegExp(`still listening on port ${port} after the run.*reused one started from another tree`));
      await new Promise((r) => server.close(r));
      resetConfigCache();
      expect(await foreignServerNote(dir, ['e2e/a.spec.mjs'])).toMatch(/may have reused a server/);
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }); resetConfigCache(); }
  });
});
