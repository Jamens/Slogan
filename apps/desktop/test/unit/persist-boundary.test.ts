import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 只扫 `from '…'` 的模块说明符，不扫正文：注释里写"落盘 / fs / electron"是本计划注释的正常写法，
 * 不该成为红。三条判据各挡一型漂移，别顺手删成一条。
 */
function srcOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

const AUTOSAVE = '../../src/main/persist/autosave.ts';
const EMERGENCY = '../../src/main/persist/emergency.ts';
const DESCRIBE_ERROR = '../../src/main/persist/describe-error.ts';

describe('persist 档的 import 边界（P-2）', () => {
  it('autosave.ts 既不 import electron 也不 import node:fs：外部世界只从三条注入通道进来', () => {
    const src = srcOf(AUTOSAVE);
    expect(src.includes("from 'electron'")).toBe(false);
    expect(src.includes("from 'node:fs'")).toBe(false);
    // 反向判据：三条通道都在。少了任何一条，"注入"就退化成"连库/连盘才能测"，
    // 而这一格是唯一会注意到那一型退化的地方（退化的文件依然能跑，只是没人测得到）。
    expect(src.includes('JournalSink')).toBe(true);
    expect(src.includes('SaveTimer')).toBe(true);
    expect(src.includes('onEmergency')).toBe(true);
    // 心跳间隔必须是 T6 那个常量的引用，不是本文件里的第二个数（P-4/P-14 的账）：
    // 漂成字面量 `5000` 时值一样、行为一样，只有这一句看得见。
    expect(src.includes('LOCK_HEARTBEAT_INTERVAL_MS')).toBe(true);
  });

  it('emergency.ts 允许碰 fs 但不许认识 electron；describe-error.ts 两样都不许', () => {
    const emergency = srcOf(EMERGENCY);
    // 不对称是有意的：本文件正是 T7 唯一被授权碰盘的那一个（裁决 P-10），
    // 但它同样不许 import electron —— `app.getPath('userData')` 由 T8 当参数递进来。
    expect(emergency.includes("from 'node:fs'")).toBe(true);
    expect(emergency.includes("from 'electron'")).toBe(false);
    const describeError = srcOf(DESCRIBE_ERROR);
    expect(describeError.includes("from 'electron'")).toBe(false);
    expect(describeError.includes("from 'node:fs'")).toBe(false);
    // 文案出口连 core 都不许要：它必须能在任何一侧独立编译（T9 的诊断档也会 import 它）。
    expect(describeError.includes("from '@dajia/core'")).toBe(false);
  });
});

// —— T8 追加的三格 ——

const SESSION = '../../src/main/persist/session.ts';

/** 目录名要用**绝对路径**读：`srcOf` 那一套 URL 解析给的是文件，不是目录。 */
const MAIN_ROOT = fileURLToPath(new URL('../../src/main', import.meta.url));
const RENDERER_ROOT = fileURLToPath(new URL('../../src/renderer', import.meta.url));

/** 递归列出目录下的 `.ts` / `.tsx`，返回**排序后的相对路径**。两格共用它，别在别处再写一份遍历。 */
function tsUnder(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...tsUnder(join(root, entry.name)).map((rel) => join(entry.name, rel)));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      // 两种后缀都要：`src/main/**` 今天只有 `.ts`，而 renderer 那一侧**全是 `.tsx`**
      // （App.tsx / PlanCanvas.tsx / panels.tsx）—— 只扫 `.ts` 的名单会把"屏幕侧的 protocol 值 import"
      // 全数漏过，而那正是这一格唯一的靶子。
      out.push(entry.name);
    }
  }
  return out.sort();
}

/**
 * 逐个 import **语句**（而不是逐行）判它是不是 type-only。
 *
 * ## 为什么要从"逐行"升级成"逐语句"
 *
 * 原实现逐行找 `from '@dajia/protocol'`，并用 `/^\s*import\s+type\s/` 排除 type-only。问题是
 * **多行写法**（`import type {\n  A,\n} from '@dajia/protocol';`）里，只有第一行带 `import type`，
 * 末行 `} from '@dajia/protocol';` 不带 ⇒ **多行的 type-only 误红**（`projectStore.ts` 就是这一型）。
 *
 * 原注释把这条登记成"已知的共同限度"，但那样做的代价是：**多行的值 import 也会同样误红** ——
 * 判据从此既报错又漏报，`projectStore.ts` 若把 `import type` 改成 `import`（值导入，zod 进 bundle），
 * 它照样红，于是读的人以为"反正它本来就红"，判据就永久失去了这一格的牙。
 *
 * 所以改成**先聚成语句再判**：把源码按 `import` 语句切开，每条语句整体看它有没有 `import type`。
 * 不引第二个依赖（AST 解析要装 typescript 到 devDeps，不值得）—— 正则足以切开，因为
 * ESM 的 import 语句以**空行或非缩进行**结束，这一点比"逐行"稳。
 */
function untypedProtocolImports(src: string): string[] {
  const bad: string[] = [];
  // 以分号收尾切句：一条 import 语句只有一个 `from '...'` 说明符，
  // 而多行的名单里没有分号之外能让语句提前结束的东西。
  for (const stmt of src.split(';')) {
    if (!stmt.includes("@dajia/protocol'")) continue;
    // 语句**整体**判 type-only：多行写法的 `import type` 在第一行，切句后它与
    // `from '…'` 落在同一条里，于是这一判据对单行与多行是同一套口径。
    if (!/^\s*import\s+type\s/.test(stmt)) bad.push(stmt.trim());
  }
  return bad;
}

describe('T8 的 import 边界：真把式只能住在 ipc-persist.ts', () => {
  it('session.ts 既不碰 electron / node:fs / node:os，也不 import mysql2', () => {
    const src = srcOf(SESSION);
    for (const banned of ["from 'electron'", "from 'node:fs'", "from 'node:os'", "from 'mysql2"]) {
      expect(src.includes(banned)).toBe(false);
    }
    // 正控制（注入通道确实在用）：缺任何一条，"端口表被绕过"就是这一格唯一会看见的时刻。
    expect(src.includes('this.ports.loadConfig')).toBe(true);
    expect(src.includes('this.ports.openDb')).toBe(true);
    expect(src.includes('this.ports.acquire')).toBe(true);
    expect(src.includes('this.ports.emitStatus')).toBe(true);
  });

  it('src/main/** 里认识 electron 的名单逐字等于 [index.ts, ipc-persist.ts, ipc/export-plan.ts]', () => {
    const hit = tsUnder(MAIN_ROOT).filter((rel) =>
      readFileSync(join(MAIN_ROOT, rel), 'utf8').includes("from 'electron'"),
    );
    // 名单比字面量：这条边界的价值在"没写进名单的那个文件就是漂移"，
    // 而 `length <= 2` 那种宽松判据会把"有人把 createDbPool 挪进 persist/config-store.ts"说成合规。
    // T9 的落盘结论（裁决 P-27）：`safeStorage` 的适配器住在本名单里**已有**的 ipc-persist.ts，
    // 没有人在 config-store.ts 里 import 它 —— 所以这一格一字未动，spec §8.2 的那条例外没有被启用。
    // brief 定稿于计划 5 之前，名单里只有两员；盘上事实是 `ipc/export-plan.ts`（计划 5 落地）
    // 也 import electron，所以名单按实测补第三员 —— 判据的字符（"没写进名单的那个文件就是漂移"）原样保留。
    expect(hit).toEqual(['index.ts', 'ipc-persist.ts', join('ipc', 'export-plan.ts')]);
  });

  it('屏幕侧对 @dajia/protocol 只许 type-only import（zod 不许进 renderer 的 bundle）', () => {
    // 先证扫描器自己会红：这一族扫描最怕的形状是"永远返回空数组"。
    // 断言的是**切句之后**的形态（尾分号被切掉是切句的必然结果，不是缺陷）。
    expect(untypedProtocolImports("import { IPC } from '@dajia/protocol';")).toEqual([
      "import { IPC } from '@dajia/protocol'",
    ]);
    expect(untypedProtocolImports("import type { IPC } from '@dajia/protocol';")).toEqual([]);
    // **多行两型都要判**（本次修复的靶子）：真源 `projectStore.ts` 就是多行 type-only，
    // 而修复前它误红 ⇒ 于是"多行的**值** import"也同样误红 ⇒ 判据既报错又漏报。
    // 下面第二行就是那个漏报：它必须红，否则修好的只是误红、没恢复牙。
    const multilineTypeOnly = ['import type {', '  IPC,', "} from '@dajia/protocol';"].join('\n');
    expect(untypedProtocolImports(multilineTypeOnly)).toEqual([]);
    const multilineValue = ['import {', '  IPC,', "} from '@dajia/protocol';"].join('\n');
    expect(untypedProtocolImports(multilineValue).length).toBe(1);

    const files = tsUnder(RENDERER_ROOT);
    expect(files.length).toBeGreaterThan(0);
    for (const rel of files) {
      expect(untypedProtocolImports(readFileSync(join(RENDERER_ROOT, rel), 'utf8'))).toEqual([]);
    }
  });
});
