// ./vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@acsf/shared': path.resolve(rootDir, 'packages/shared/src/index.ts'),
      '@acsf/protocol': path.resolve(rootDir, 'packages/protocol/src/index.ts'),
      '@acsf/api': path.resolve(rootDir, 'apps/api/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    hookTimeout: 30000,
    testTimeout: 60000,
  },
});