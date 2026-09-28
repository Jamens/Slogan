import { fileURLToPath } from 'node:url';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * @dajia/core 与 @dajia/protocol 的 exports 指向 .ts 源码（D2 源码直连），主进程与
 * preload 里必须把它们打进产物，不能留裸说明符：
 * - electron-vite 默认按 package.json 的 dependencies 外部化（build.externalizeDeps: true），
 *   所以 exclude 是必需的；
 * - 光配 alias 不够，实测只配 alias 时 out/main/index.js 仍是 `import '@dajia/core'`；
 * - 不配 alias 也不行：Node 的 ESM 解析既不吃 core 源码里无扩展名的相对导入，
 *   也不给 node_modules 下的 .ts 剥类型，主进程一启动就 ERR_MODULE_NOT_FOUND。
 */
const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const workspaceDeps = {
  resolve: {
    alias: {
      '@dajia/core': src('../../packages/core/src/index.ts'),
      '@dajia/protocol': src('../../packages/protocol/src/index.ts'),
    },
  },
  build: {
    externalizeDeps: { exclude: ['@dajia/core', '@dajia/protocol'] },
  },
};

export default defineConfig({
  main: workspaceDeps,
  preload: workspaceDeps,
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@dajia/core': src('../../packages/core/src/index.ts'),
        '@dajia/scene-2d': src('../../packages/scene-2d/src/index.ts'),
      },
    },
  },
});
