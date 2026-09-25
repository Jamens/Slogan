import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@dajia/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@dajia/protocol': fileURLToPath(
        new URL('./packages/protocol/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'scripts/test/**/*.test.mjs'],
  },
});
