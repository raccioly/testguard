// A real browser (chromium). Pages are served by e2e/support/serve.mjs through
// request interception, so no port is bound and parallel runs never collide.
export default {
  testDir: './e2e',
  timeout: 15000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: { browserName: 'chromium', headless: true },
};
