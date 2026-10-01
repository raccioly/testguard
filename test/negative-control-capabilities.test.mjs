import {describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {RUNNERS} from '../src/probe/runners/index.mjs';

// Iterate the REGISTRY, not the module namespaces. `python.pinned()` rebuilds
// the runner as an explicit allow-list object, so a capability added to the
// module is silently absent from `--runner pytest` and `--runner unittest`
// unless it is listed there too — which is exactly what happened, and what a
// test over the four modules could never have caught.
describe('fatalEdit — every runner in the registry can say what "cannot compile" means', () => {
  for (const [key, r] of Object.entries(RUNNERS)) {
    it(`${key} supplies content that does not parse`, () => {
      expect(r.fatalEdit, `${key} has no fatalEdit, so a survivor under it is never checked`).toBeTypeOf('function');
      const content = r.fatalEdit();
      expect(typeof content).toBe('string');
      const dir = mkdtempSync(join(tmpdir(), 'tg-fatal-'));
      if (['python', 'pytest', 'unittest'].includes(key)) {
        const f = join(dir, 'x.py');
        writeFileSync(f, content);
        // Compile rather than import: it must fail before any side effect.
        const out = spawnSync('python3', ['-c', `import py_compile,sys\ntry:\n py_compile.compile(${JSON.stringify(f)}, doraise=True)\n sys.exit(0)\nexcept Exception:\n sys.exit(1)`], { encoding: 'utf8' });
        if (out.error) return; // no python3 on this machine; the JS runners still prove the shape
        expect(out.status).toBe(1);
      } else {
        const f = join(dir, 'x.mjs');
        writeFileSync(f, content);
        expect(spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }).status).not.toBe(0);
      }
      rmSync(dir, { recursive: true, force: true });
    });
  }
});
