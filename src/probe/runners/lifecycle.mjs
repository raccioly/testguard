import { constants } from 'node:os';

/** Own only children and cleanups registered by this TestGuard process. */
const children = new Map();
const cleanups = new Map();
let installed = false;
let cancelling = false;

/** Did every cleanup finish? A failure is reported where it happens; the summary line must not claim more than that. */
function cleanup() {
  let clean = true;
  // Restore mutations before removing isolation, even across successive probes.
  for (const [fn] of [...cleanups].reverse().sort((a, b) => b[1] - a[1])) {
    try { fn(); } catch (error) { clean = false; process.stderr.write(`cleanup failed: ${error.message}\n`); }
  }
  cleanups.clear();
  return clean;
}

/** The shell's convention: 128 plus the signal number (SIGINT 130, SIGTERM 143, SIGHUP 129). */
export const exitCodeFor = (signal) => 128 + constants.signals[signal];

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
      const clean = cleanup();
      process.stderr.write(clean ? `interrupted by ${signal}; scratch trees removed\n` : `interrupted by ${signal}; scratch cleanup did not finish (see above)\n`);
      process.exit(exitCodeFor(signal));
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
