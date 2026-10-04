import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const alias = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * 连库的测试只活在这里：`pnpm test`（以及 CI）一条都不碰 MySQL。
 * 三条主张各自有理由：
 * - include 只有 `test/db`：`test/unit` 是纯逻辑，归 `pnpm test`（CI 有牙的那一半）；
 * - fileParallelism false：多个文件共用一个 `dajia_test`，并行会互踩（迁移与清理撞车）。
 *   代价是慢，但把每个文件换成独立库名等于让"自建自清"变成 N 倍面积的清理；
 * - 缺环境变量时 `readMysqlEnv()` 抛，不 skip —— 静默跳过的集成测试等于没有测试。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@dajia/core': alias('./packages/core/src/index.ts'),
      '@dajia/protocol': alias('./packages/protocol/src/index.ts'),
      '@dajia/scene-2d': alias('./packages/scene-2d/src/index.ts'),
    },
  },
  test: {
    include: ['apps/desktop/test/db/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
