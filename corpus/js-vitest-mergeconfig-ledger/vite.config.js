import { defineConfig } from 'vite';

// The application's own vite config; vitest.config.js extends it (#278).
export default defineConfig({
  define: { __LEDGER_CURRENCY__: JSON.stringify('USD') },
});
