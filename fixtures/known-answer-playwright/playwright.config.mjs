// Browserless on purpose: no spec requests `page`, so the specs run wherever
// @playwright/test is installed, browsers or not. The adapter under test is
// the report protocol and per-file runner selection, not browser automation;
// a spec that uses `page` is driven exactly the same way.
export default {
  testDir: './e2e',
  timeout: 2000,
  retries: 1, // lets a first-attempt failure surface as Playwright's `flaky` status
  reporter: 'list',
  workers: 1,
};
