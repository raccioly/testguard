/** Own only children and cleanups registered by this TestGuard process. */
const children = new Map();
const cleanups = new Map();
let installed = false;
let cancelling = false;

function cleanup() {
  // Restore mutations before removing isolation, even across successive probes.
  for (const [fn] of [...cleanups].reverse().sort((a, b) => b[1] - a[1])) {
    try { fn(); } catch (error) { process.stderr.write(`cleanup failed: ${error.message}\n`); }
  }
  cleanups.clear();
}

function install() {
  if (installed) return;
  installed = true;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, async () => {
      if (cancelling) return;
      cancelling = true;
      const waits = [...children].map(([child, stop]) => {
        const closed = new Promise((resolve) => child.once('close', resolve));
        stop();
        return closed;
      });
      let timer;
      await Promise.race([
        Promise.allSettled(waits),
        new Promise((resolve) => { timer = setTimeout(resolve, 1000); }),
      ]);
      clearTimeout(timer);
      cleanup();
      process.exit(130);
    });
  }
  process.on('exit', () => {
    for (const stop of children.values()) stop();
    cleanup();
  });
}

export function registerChild(child, stop) {
  install();
  children.set(child, stop);
  child.once('close', () => children.delete(child));
  if (cancelling) stop();
}

export function registerCleanup(fn, { priority = 0 } = {}) {
  install();
  cleanups.set(fn, priority);
  return () => cleanups.delete(fn);
}

export function assertNotCancelled() {
  if (cancelling) throw new Error('TestGuard command cancelled; no partial result may be published');
}
