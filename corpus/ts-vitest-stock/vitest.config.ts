import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The same alias as tsconfig.json "paths": "@/x" is "src/x".
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts'] },
});
