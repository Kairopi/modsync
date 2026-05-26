import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Vitest configuration for ModSync.
 *
 * - Default environment is `node` (server-side modules under `src/server/**`).
 * - Client tests under `src/client/**` or `tests/**.spec.tsx` should declare
 *   `// @vitest-environment jsdom` at the top of each file. Vitest 4 removed
 *   the legacy `environmentMatchGlobs` option in favor of per-file pragmas.
 * - `@shared` resolves to `src/shared` for both server and client tests.
 * - The React plugin is included so `.tsx` files compile during test runs
 *   (component tests added in 6.x and later).
 *
 * Source of truth: `.kiro/specs/modsync/tasks.md` task 1.3.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.spec.{ts,tsx}', 'src/**/*.spec.{ts,tsx}'],
    setupFiles: ['tests/_setup.ts'],
  },
});
