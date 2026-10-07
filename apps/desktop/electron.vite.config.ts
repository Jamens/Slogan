import { readFileSync } from 'node:fs';
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

/**
 * 把 `pdf` 包的 `loadDefaultFont` 改成**内联字节**（base64），不再在运行时读文件。
 *
 * ## 为什么需要它（这一条是"build 通过"验不出来的）
 *
 * `packages/pdf/src/index.ts` 那行是
 * `readFileSync(fileURLToPath(new URL('../assets/noto-sans-sc.subset.otf', import.meta.url)))`。
 * 源码直连时（vitest / `pnpm dev`）它成立：`import.meta.url` 指向 `packages/pdf/src/index.ts`，
 * `../assets/` 正好是 `packages/pdf/assets/`。
 * 但**打进 `out/main/index.js` 之后**，`import.meta.url` 变成 `out/main/index.js`，
 * `../assets/` 就成了 `out/assets/` —— 那里什么都没有，而 vite 也不会自动搬它
 * （它是被 `fileURLToPath` 读的，不是被 import 的资产）。
 * 于是：构建 exit=0、单测全绿（都走源码直连）、**真进程第一次点"导出"才 ENOENT**。
 *
 * 试过的第二条路（emitFile 到 `../assets/…`）**被 rolldown 拒**：
 * `The "fileName" … must be strings that are neither absolute nor relative paths`。
 * emitFile 的落点由 bundler 管，而我们需要的那一处在 outDir **之外**。
 *
 * 所以改成把 base64 **编进产物**：产物里不再有任何"去找字体文件"的路径解析，
 * 落在哪、怎么改名都无所谓 —— 这也是打包期唯一可靠的一种。
 *
 * ## 为什么不动 pdf 包
 *
 * `loadDefaultFont` 源码直连时是好的（单测与 dev 都用它），改它会动 M1.5b 已验过的字节稳定性。
 * 这里是**打包期的定点替换**：只认那一句 `loadDefaultFont` 的函数体，
 * 换成"从内联 base64 解字节"，其余逻辑（`loadSubsetFont` 的解析）一字不动 ——
 * 字体怎么解析仍由 pdf 包独一份产地负责。
 */
function inlinePdfFont(): {
  name: string;
  enforce: 'pre';
  transform: (code: string, id: string) => { code: string; map: null } | null;
} {
  return {
    name: 'dajia:inline-pdf-font',
    // pre：必须在 TS→JS 之前动手，那时函数体还是带类型标注的原文。
    enforce: 'pre',
    transform(code: string, id: string) {
      if (!id.replace(/\\/g, '/').endsWith('packages/pdf/src/index.ts')) return null;
      if (!code.includes('noto-sans-sc.subset.otf')) {
        throw new Error(
          'dajia:inline-pdf-font：packages/pdf/src/index.ts 里找不到 noto-sans-sc.subset.otf 的引用。' +
            '字体加载方式变了 ⇒ 本插件的定点替换会静默失效（构建照样绿、真进程导出时 ENOENT）。' +
            '改 pdf 包那行时必须一起改这里。',
        );
      }
      const b64 = readFileSync(src('../../packages/pdf/assets/noto-sans-sc.subset.otf')).toString('base64');
      // 只换 import.meta.url + readFileSync 这条表达式，函数名与调用形状保持可辨。
      const replaced = code.replace(
        /const DEFAULT_FONT_ASSET = new URL\([^;]*\);/,
        `const DEFAULT_FONT_B64 = '${b64}';`,
      );
      if (replaced === code) {
        throw new Error('dajia:inline-pdf-font：没能替换掉 DEFAULT_FONT_ASSET 那一行（形状变了？）');
      }
      return {
        code: replaced.replace(
          /readFileSync\(fileURLToPath\(DEFAULT_FONT_ASSET\)\)/g,
          'Buffer.from(DEFAULT_FONT_B64, "base64")',
        ),
        map: null,
      };
    },
  };
}

/**
 * 主进程/preload 侧的四个"源码直连"工作区包：`core` / `protocol` / `drawing` / `pdf`。
 *
 * **为什么它们必须打进产物，不能留裸说明符**（三条同时成立，缺一条就起不来）：
 * 1. 它们的 `exports` 指向 `.ts` 源码（D2 源码直连）；
 * 2. electron-vite 默认按 `package.json` 的 `dependencies` 外部化 ⇒ 必须 `exclude`；
 * 3. 光配 alias 不够（实测产物里仍是 `import '@dajia/core'`），不配 alias 也不行
 *    （Node 的 ESM 解析既不吃源码里无扩展名的相对导入，也不给 node_modules 下的 .ts 剥类型）。
 *
 * **`drawing` / `pdf` 是 plan5 T8 接线时补进来的**（导出平面图要 `@dajia/pdf` 的
 * `writeSheets` + 字体，`@dajia/drawing` 的 `planSheet`/`frameSheet`/`clipSheet`）。
 * 只补了 alias 而忘了 exclude 的话，产物里留着
 * `import { clipSheet, ... } from "@dajia/drawing"` —— **构建照样 exit=0**，
 * 而真进程一启动就 `ERR_MODULE_NOT_FOUND`。所以判据是产物里不得出现裸 `@dajia/*`，
 * 不是"build 通过"（构建通过验不出这件事）。
 *
 * `scene-2d` 不在此列：渲染进程才用得到它，而 renderer 段走的是 browser 解析，不需要。
 */
const workspaceDeps = {
  resolve: {
    alias: {
      '@dajia/core': src('../../packages/core/src/index.ts'),
      '@dajia/protocol': src('../../packages/protocol/src/index.ts'),
      '@dajia/drawing': src('../../packages/drawing/src/index.ts'),
      '@dajia/pdf': src('../../packages/pdf/src/index.ts'),
    },
  },
  build: {
    externalizeDeps: { exclude: ['@dajia/core', '@dajia/protocol', '@dajia/drawing', '@dajia/pdf'] },
    // **刻意不配 `assetFileNames`**：字体资产的落点由 `emitPdfFont` 逐字指定
    // （它必须与包内那行 `new URL('../assets/…')` 的运行时解析结果对齐）。
  },
};

export default defineConfig({
  // 字体只被**主进程**的导出通路读（renderer 不引 `@dajia/pdf`），所以只挂 main。
  // `format: 'es'` 是**必需**的一行：electron-vite 5 在 `"type": "module"` 下默认输出
  // ESM 到 `index.js`，而 Electron 的 main 进程按 **CJS** 解释那个 `.js` ⇒ 每个具名 import
  // 都报 `SyntaxError: The requested module 'electron' does not provide an export named
  // 'BrowserWindow'`，**真进程一起就崩，而 `pnpm build` 照样 exit=0**。
  // 显式写 `es` 让入口落成 `index.mjs`，与 `package.json` 的 `main` 字段逐字对齐
  // （那一处改动在下面 `package.json` 的 diff 里）。
  //
  // **这一条是 `pnpm shot` 那一族真窗口闸门长期 exit=1 的根因**，与 plan5 的改动无关：
  // 在 T8 接线之前（`HEAD~2`）重建产物同样是 ESM，同样报这一句。
  main: {
    ...workspaceDeps,
    plugins: [inlinePdfFont()],
    build: {
      rollupOptions: {
        output: {
          /**
           * **必须是 CJS，且必须落成 `.cjs`** —— 三层坑走完才定下来的那一档。
           *
           * 试过的三条路，逐一说明为什么不通（都实测过，别重走）：
           *
           * 1. **默认（ESM → `index.js`）**：Electron 按 CJS 解释那个 `.js` ⇒
           *    `SyntaxError: does not provide an export named 'BrowserWindow'`。
           * 2. **`format: 'es'` + `entryFileNames: '[name].mjs'`**：产物名对了、格式对了，
           *    但 Electron 加载 `.mjs` 时经的那层桥接**不支持具名 ESM import**
           *    ⇒ 还是同一句 `does not provide an export named 'BrowserWindow'`。
           *    （electron-vite 文档里 ESM 是"实验档"，主进程具名导入这条路在
           *    electron 44 上不通。）
           * 3. **`format: 'cjs'`（只写这一处）**：产物落成 `index.cjs`，
           *    但 `package.json` 的 `main` 还指着 `index.js` ⇒ **入口失配**。
           *
           * 于是定在：**CJS + `.cjs` + 同步 `main` 字段**。三处必须一致，
           * 而"一致"这件事由 `packaging.test.ts` 的 W5/W6 钉住。
           *
           * 顺带：`preload` 段默认 `.mjs`（electron-vite 的 preload 走 ESM 那一档），
           * 而 `main/index.ts` 里那行`join(import.meta.dirname, '../preload/index.mjs')`
           * 本来就对，不用动 —— **preload 与 main 的格式要求不同，这是 electron-vite 的既有分工**。
           */
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
        // `electron` **必须留在产物之外**（否则它被内联进 main，真进程去找
        // `out/main/install.js`）。它按 `dependencies` 外部化，而 `electron` 在
        // `devDependencies` ⇒ 不在名单上 ⇒ 走普通打包路径被内联。
        // 也不用 `externalizeDeps.include`：那个选项只认 dependencies 里的包名。
        external: (id) => id === 'electron' || id.startsWith('electron/') || id.startsWith('node:'),
      },
    },
  },
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
