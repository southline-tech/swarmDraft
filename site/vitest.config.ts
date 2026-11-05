import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['site/functions/**/*.test.ts', 'site/js/**/*.test.js'],
  },
});
