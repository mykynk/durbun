import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    pool: 'forks',
    maxWorkers: 2,
  },
});
