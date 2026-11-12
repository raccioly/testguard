// __PORT__ and __REUSE__ are filled in by test/probe.foreign-server.test.mjs, which picks a free port at run time.
// Real projects write this as `reuseExistingServer: !process.env.CI` on a fixed port; both shapes are exercised.
export default {
  testDir: './e2e',
  timeout: 5000,
  reporter: 'list',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:__PORT__' },
  webServer: { command: 'node server.mjs', port: __PORT__, reuseExistingServer: __REUSE__, env: { TESTGUARD_FIXTURE_PORT: String(__PORT__) } },
};
