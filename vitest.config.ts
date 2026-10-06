import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@dajia/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@dajia/protocol': fileURLToPath(
        new URL('./packages/protocol/src/index.ts', import.meta.url),
      ),
      '@dajia/drawing': fileURLToPath(new URL('./packages/drawing/src/index.ts', import.meta.url)),
      '@dajia/scene-2d': fileURLToPath(
        new URL('./packages/scene-2d/src/index.ts', import.meta.url),
      ),
      '@dajia/scene-3d': fileURLToPath(new URL('./packages/scene-3d/src/index.ts', import.meta.url)),
      '@dajia/pdf': fileURLToPath(new URL('./packages/pdf/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'scripts/test/**/*.test.mjs', 'apps/desktop/test/unit/**/*.test.ts'],
  },
});
