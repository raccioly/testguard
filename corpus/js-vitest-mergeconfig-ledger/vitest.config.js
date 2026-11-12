import { mergeConfig } from 'vite';
import { defineConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

// The common real-world shape #278 is about: vitest extends the app's vite
// config through vite's own mergeConfig.
export default mergeConfig(viteConfig, defineConfig({
  test: { include: ['test/**/*.test.js'] },
}));
