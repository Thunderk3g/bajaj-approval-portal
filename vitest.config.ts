import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // These suites share one database and truncate between runs. Parallel
    // files would race on the same tables.
    fileParallelism: false,
    testTimeout: 20000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
