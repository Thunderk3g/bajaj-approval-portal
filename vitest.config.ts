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
  /**
   * The automatic JSX runtime, so a `.tsx` file can be imported by a test.
   *
   * esbuild defaults to the CLASSIC transform, which compiles JSX to
   * `React.createElement` and expects a `React` binding in scope. Next injects
   * the automatic runtime itself, so no page or component in `src/` imports
   * React — and importing one into a test therefore failed with a bare
   * `ReferenceError: React is not defined` pointing at the `return (` line,
   * which reads like a broken component rather than a missing build setting.
   *
   * Only the transform changes. `environment` stays `node`: these are server
   * components rendered as async functions and asserted on as element trees,
   * not mounted in a DOM.
   */
  esbuild: {
    jsx: 'automatic',
  },
});
