import { availableParallelism } from 'node:os';
import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // Acceptance tests launch nested runners; reserve CPU for the developer.
    // CI's runners have 4 vCPUs and nobody to reserve them for. Measured on a
    // 2-worker run, the suite keeps about 1.85 cores busy (user+system CPU over
    // wall time, locally and consistent with CI's per-file seconds adding up to
    // twice the wall time): half the runner sat idle while the budget ran out.
    // Three workers use the idle cores and leave one for the nested runners'
    // bursts and the OS; four would put a nested vitest/tsc/playwright on every
    // core and invite the timing-sensitive acceptance tests (command-budget
    // caps, the fan-out hold) to measure the load instead of the code.
    maxWorkers: process.env.CI ? 3 : Math.min(2, Math.max(1, availableParallelism() - 1)),
    // fixtures/ contains a deliberately flaky suite; it is driven by the
    // tool's own tests, never collected directly. Agent-managed worktrees are
    // separate checkouts too: collecting them makes this tree's result depend
    // on unrelated, potentially unfinished work.
    exclude: [...configDefaults.exclude, 'fixtures/**', '.claude/**'],
    // The suite is already parallel (maxWorkers above), and dozens of its
    // tests run whole probes. Under the CLI's default `--fault-workers auto`
    // each of those would fan out across more scratch trees on top, measuring
    // the oversubscribed machine instead of the code. Tests that are about
    // the fan-out or the default pass their own width, or delete this (#270).
    env: { TESTGUARD_FAULT_WORKERS: '1' },
  },
});
