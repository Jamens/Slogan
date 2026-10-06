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
const MAIN_JS = join(DESKTOP, 'out', 'main', 'index.js');
const CONFIG = join(DESKTOP, 'electron.vite.config.ts');

const built = existsSync(MAIN_JS);
const suite = built ? describe : describe.skip;

function mainBundle(): string {
  return readFileSync(MAIN_JS, 'utf8');
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
    // 打进 out/main/index.js 后那个相对路径指向 out/assets/ —— 空的（vite 不会搬它，
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
