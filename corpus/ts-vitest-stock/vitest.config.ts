import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The same alias as tsconfig.json "paths": "@/x" is "src/x". Written with
// join() on purpose: the equivalent `fileURLToPath(new URL('./src', import.meta.url))`
// makes TestGuard 0.22.1 refuse the whole run (see PROVENANCE.md).
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: { '@': join(root, 'src') } },
  test: { include: ['test/**/*.test.ts'] },
});
