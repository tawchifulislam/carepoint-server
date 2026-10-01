import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    fileParallelism: false,
    hookTimeout: 20000,
    testTimeout: 20000,
  },
});
