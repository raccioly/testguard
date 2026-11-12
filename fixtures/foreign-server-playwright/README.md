# Fixture — a server from another checkout

A Playwright config whose `webServer` listens on a fixed port, and a foreign
instance of that server (built from an unfaulted copy) already on the port.
The specs use Playwright's `request` fixture, so no browser is needed.

| Setup | Expected |
|---|---|
| no foreign server | **killed**: the probe's own server runs the faulted source |
| foreign server, `reuseExistingServer: true` | **unverifiable**, `subject-not-executed`; `detail.message` names the reused server. Never `survived`, never `killed` |
| foreign server, `reuseExistingServer: !process.env.CI` | **unverifiable**, `defenders-failed-to-load`; Playwright refuses ("already used") because TestGuard sets `CI=1` for the runner process, config evaluation included |

The port is written into the config by the test (`test/probe.foreign-server.test.mjs`);
the config has the shape of a real fixed-port one. Dependencies come from
`fixtures/known-answer-playwright` (`npm ci` there).
