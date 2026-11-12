import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * `TESTGUARD_WORKER` (#287): the 0-based index of the scratch tree a runner
 * process runs in, exported to every test runner the probe starts. Trees run
 * side by side under a fan-out, so a suite that needs a port, a database or a
 * directory of its own can derive it (`8787 + TESTGUARD_WORKER`) and stay
 * parallel instead of being measured alone. A run with nothing else in flight
 * (one fault at a time, a confirmation or a re-measure) is worker 0.
 *
 * The index travels in an AsyncLocalStorage context, like the scratch base,
 * so two trees measuring at once never see each other's.
 */
const context = new AsyncLocalStorage();

/** Run `fn` with `index` as the worker every runner process it starts sees. */
export const withWorker = (index, fn) => context.run(index, fn);

/** The environment a runner process gets: `{ TESTGUARD_WORKER }`, `0` outside any tree. */
export const workerEnv = () => ({ TESTGUARD_WORKER: String(context.getStore() ?? 0) });
