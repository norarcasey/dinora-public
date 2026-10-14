import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'core', include: ['packages/*/src/**/*.test.ts'], environment: 'node' },
      },
      {
        test: {
          name: 'web',
          include: ['apps/web/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['apps/web/src/test-setup.ts'],
        },
      },
      {
        test: { name: 'scripts', include: ['scripts/**/*.test.ts'], environment: 'node' },
      },
      {
        test: {
          name: 'server',
          include: ['api/**/*.test.ts', 'middleware.test.ts'],
          environment: 'node',
        },
      },
      {
        test: { name: 'mac', include: ['apps/mac/src/**/*.test.ts'], environment: 'node' },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      // The thresholds gate the pure layer and nothing else. A percentage on the React app
      // buys tests written to satisfy the percentage. A glob threshold is measured across
      // every file it matches rather than per file, which is why this is one entry for the
      // package. Noradar's numbers, held since 13 Sep 2026.
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
      reporter: ['text-summary', 'html'],
    },
  },
});
