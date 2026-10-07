import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 打包配置的两条判据（plan5 T8 接线棒）。
 *
 * ## 为什么这两条要单立一个测试文件
 *
 * 它们守的是**"build 通过"验不出来**的那一类缺陷：
 * `pnpm build` exit=0、`pnpm verify` 全绿，而真进程一启动就 `ERR_MODULE_NOT_FOUND`、
 * 或第一次点导出就 `ENOENT`。这两条都曾在本仓真实发生过（见下面两条的注释），
 * 而它们**一次都没有让构建变红**。
 *
 * 有产物才判（`build` 跑过才有 `out/`），所以这六格在没有产物时**显式跳过**而不是假装绿 ——
 * 恒绿的判据是本仓踩过两次的坑（§九 第 2 种形态）。
 */
const DESKTOP = join(fileURLToPath(new URL('../..', import.meta.url)));
/**
 * main段产物是 **`.cjs`**（不是 `.js`，也不是 `.mjs`）—— 见 W5/W6/W7 那一族：
 * 那是**四层**「build 通过但真进程起不来」走完才定下来的档。
 * `MAIN_MJS` 保留一个旧名做**反向存在性**检查：若哪天配置改动让产物又落回 `.js`/`.mjs`，
 * `built` 为 false ⇒ W1/W2 会因为读不到文件而整组 skip ⇒ 那是"判据变恒绿"的最坏形态，
 * 所以 W5 显式断言那两个名字**都不该**存在。
 */
const MAIN_CJS = join(DESKTOP, 'out', 'main', 'index.cjs');
const CONFIG = join(DESKTOP, 'electron.vite.config.ts');

const built = existsSync(MAIN_CJS);
const suite = built ? describe : describe.skip;

function mainBundle(): string {
  return readFileSync(MAIN_CJS, 'utf8');
}

suite('打包配置（产物存在时才判）', () => {
  it('W1 主进程产物里没有裸 @dajia/* 说明符：四个源码直连包都必须被打进产物', () => {
    // 曾发生的真实故障：T8 把 `@dajia/drawing` / `@dajia/pdf` 加进了 package.json 的
    // dependencies，却只补了 vite alias、没补 externalizeDeps.exclude ⇒ 产物里留着
    //   import { clipSheet, frameSheet, planSheet } from "@dajia/drawing";
    // 构建 exit=0、单测全绿（它们走 vitest alias 解析源码），**真进程启动即崩**。
    const bare = mainBundle().match(/['"]@dajia\/[a-z0-9-]+['"]/g) ?? [];
    // 去重后应为空。注释里出现的包名不算（它们不是 import 说明符）。
    expect([...new Set(bare)]).toEqual([]);
  });

  it('W2 字体是内联字节，不在运行时按路径找文件（否则打包后 ENOENT）', () => {
    const src = mainBundle();
    // `loadDefaultFont` 原本是 `readFileSync(fileURLToPath(new URL('../assets/…', import.meta.url)))`。
    // 打进 out/main/index.cjs 后那个相对路径指向 out/assets/ —— 空的（vite 不会搬它，
    // 因为它是被 fileURLToPath 读的、不是被 import 的资产）⇒ 真进程第一次导出 ENOENT。
    // 修法是把 base64 编进产物（rolldown 拒了 emitFile 到 `../assets/…`）。
    expect(src).toContain('DEFAULT_FONT_B64');
    expect(src).not.toContain('readFileSync(fileURLToPath');
    // 且内联的字节与磁盘资产同源 —— 换一份字体或截断 base64 都会红。
    const m = /DEFAULT_FONT_B64\s*=\s*"([A-Za-z0-9+/=]+)"/.exec(src);
    expect(m).not.toBeNull();
    const inlined = Buffer.from(m![1]!, 'base64');
    const onDisk = readFileSync(
      join(DESKTOP, '..', '..', 'packages', 'pdf', 'assets', 'noto-sans-sc.subset.otf'),
    );
    expect(Buffer.compare(inlined, onDisk)).toBe(0);
  });
});

/**
 * main 段产物是 **`.cjs`**（不是 `.js`、也不是 `.mjs`）—— 见 W5/W6 那一族：
 * 这一族是**四层坑**走完才定下来的，每一层都实测过、都曾让"真进程起不来"而`pnpm build` exit=0。
 *
 * 1. 默认（ESM → `index.js`）：Electron 按 CJS 解释 ⇒ `SyntaxError: does not provide an
 *    export named 'BrowserWindow'`。
 * 2. `format: 'es'` + `entryFileNames: '[name].mjs'`：名字对了、格式对了，但 Electron 加载
 *    `.mjs` 时经的桥接**不支持具名 ESM import** ⇒ 还是同一句错（electron-vite 文档把 ESM
 *    标为实验档，在 electron 44 上不通）。
 * 3. `format: 'cjs'` 单独写：产物落`index.cjs`，而 `package.json` 的 `main` 还指`index.js`
 *    ⇒ 入口失配。
 * 4. **定在 CJS + `.cjs` + 同步 `main` 字段**，三处一致。
 *
 * 与之并列的还有两个「进程起得来但跑不对」的层（同样实测过）：
 * - **`electron` 必须 external**（W7）：否则它的 `index.js` 被内联进产物，运行时按
 *   `path.txt` 去找 `out/main/install.js` ⇒ `Electron failed to install correctly`。
 * - **`ELECTRON_RUN_AS_NODE` 必须清、且要 `--no-sandbox --disable-gpu`**（W8，判据在
 *   `desktop-shot.test.mjs` 那侧）：前者让 `electron.exe` 以纯 Node 模式跑（`app` 是
 *   `undefined`），后者让 GPU 子进程反复 ACCESS_VIOLATION ⇒ `GPU process isn't usable`。
 */
const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')) as { main: string };

describe('main 入口：产物名与 package.json 的 main 字段逐字对齐', () => {
  it('W5 package.json 的 main 指向 .cjs，且那个文件真的存在（源码 + 产物双证）', () => {
    // 源码层：`main` 字段必须写 `.cjs`。写成 `.js` 而产物是 `.cjs` ⇒ 入口失配；
    // 两者都写 `.js` ⇒ 第一层那个 SyntaxError。
    expect(pkg.main).toBe('out/main/index.cjs');
    // **反向存在性**：产物**不该**是 `.js` 或 `.mjs`。它们存在就说明配置退回去了，
    // 而那时 `built` 为 false ⇒ W1/W2 整组被 skip ⇒ 本文件会"全绿且什么都没验"。
    // 这一行是那个最坏形态的牙齿（判据自己失效时，必须由另一格抓住）。
    expect(existsSync(join(DESKTOP, 'out', 'main', 'index.js'))).toBe(false);
    expect(existsSync(join(DESKTOP, 'out', 'main', 'index.mjs'))).toBe(false);
    // 产物层：文件真的在那儿。
    expect(existsSync(MAIN_CJS)).toBe(true);
  });

  it('W6 main 段显式声明 format: cjs + entryFileNames: [name].cjs（两处缺一不可）', () => {
    const cfg = readFileSync(CONFIG, 'utf8');
    const mainBlock = /main:\s*\{[\s\S]*?\n  \},\n  preload:/.exec(cfg);
    expect(mainBlock).not.toBeNull();
    const block = mainBlock![0]!;
    expect(block).toContain("format: 'cjs'");
    expect(block).toContain("entryFileNames: '[name].cjs'");
  });

  it('W7 electron 必须留在产物之外（否则它的 index.js 被内联，真进程去找 out/main/install.js）', () => {
    const cfg = readFileSync(CONFIG, 'utf8');
    const mainBlock = /main:\s*\{[\s\S]*?\n  \},\n  preload:/.exec(cfg);
    expect(mainBlock).not.toBeNull();
    // 判据两条腿：配置里写了 `electron` 的 external 判定，且产物里**真的没有**它。
    expect(mainBlock![0]!).toContain("id === 'electron'");
    if (!built) return; // eslint-disable-line no-useless-return
    // `getElectronPath` / `readElectronPath` 是 `node_modules/electron/index.js` 的两个函数；
    // 它们出现在产物里就说明那个文件被内联了（实测症状：`Electron failed to install correctly`）。
    const src = mainBundle();
    expect(src.includes('getElectronPath')).toBe(false);
    expect(src.includes('readElectronPath')).toBe(false);
    // 但具名 import 必须留着（它由 Electron 启动器注入，是宿主对象）。
    expect(/require\("electron"\)|from "electron"/.test(src)).toBe(true);
  });
});

describe('打包配置（源码层，不依赖产物）', () => {
  it('W3 配置把四个包都写进了 externalizeDeps.exclude（源码判据，不靠产物）', () => {
    // 这一格与 W1 互补：W1 要先 build 过才有产物，本格读过就红。
    // 少了任一个包 ⇒ 那一行 alias 还在、exclude 没了 ⇒ W1 红。
    const cfg = readFileSync(CONFIG, 'utf8');
    const m = /externalizeDeps:\s*\{[^}]*exclude:\s*\[([^\]]*)\]/.exec(cfg);
    expect(m).not.toBeNull();
    for (const pkg of ['@dajia/core', '@dajia/protocol', '@dajia/drawing', '@dajia/pdf']) {
      expect(m![1]!).toContain(pkg);
    }
  });

  it('W4 字体替换插件认得 pdf 包的字体引用：引用没了就抛，不许静默失效', () => {
    // 插件的判据形状：**"静默失效"比"构建失败"危险**。
    // 若将来 pdf 包改了字体加载方式而这里没跟着改，构建仍绿、真进程导出时才炸 ——
    // 所以引用消失时要求立刻抛（把失败从"运行时"提前到"构建时"）。
    const cfg = readFileSync(CONFIG, 'utf8');
    expect(cfg).toContain('noto-sans-sc.subset.otf');
    expect(cfg).toContain('inlinePdfFont');
    // 插件挂在 main 段（renderer 不引 pdf，preload 也不需要）。
    expect(/main:\s*\{[^}]*inlinePdfFont\(\)/.test(cfg)).toBe(true);
  });
});
