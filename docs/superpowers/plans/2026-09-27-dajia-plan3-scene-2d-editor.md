# 搭家 S1 · 计划 3：2D 视图与编辑器（M1.2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **状态：本计划展开了 Task 1–5。** Task 6–7 的边界与验收口径列在末尾，正文尚未展开成可执行步骤 —— **补齐前不得进入执行**（Task 1 起就要改根 `typecheck` 与 `vitest.config.ts`，跑到 Task 5 才发现缺口的代价是把前四步的闸门重跑一遍）。

**Goal:** 把 `@dajia/scene-2d` 从一行 stub 推进到「在真窗口里看得见一层平面、点得中构件」：视口仿射、绘制指令表、命中与选中，全部保持 DOM-free 可单测；像素是否真上屏由一次性截图回读证明，不靠人眼。

**Architecture:** 三层切分。① `scene-2d` 是**纯函数包**：吃 `Document` + 视口 + 选中集，吐绘制指令表（`DrawOp[]`）与命中结果，不 import DOM、不 import React、不持状态；② `apps/desktop` 的 renderer 持 `TransactionLog` 与视口状态（zustand），把指令表画到 canvas 上，把指针事件翻译成 scene-2d 的入参；③ 一切写操作一律经 core 的 command 层落盘（`log.dispatch`），scene-2d 与 renderer 都不许改 `Document`。于是"能看"和"能改"共用同一份派生几何，屏幕上的墙和导出的图纸不可能长得不一样。

**Tech Stack:** TypeScript 7.0.2 strict（`verbatimModuleSyntax` / `noUncheckedIndexedAccess` / `noUnusedLocals`）、React 19 + electron-vite 5、canvas 2D、vitest 5（**node 环境，无 jsdom**）、fast-check 4.10.2。

**Spec:** `docs/superpowers/specs/2026-09-25-dajia-s1-design.md` —— 本计划实现 §6「渲染与双向同步」与里程碑 **M1.2**；§4.2 的依赖方向由 `scripts/check-package-deps.mjs` 强制。

## Global Constraints

- **依赖方向不许破**：`scene-2d` 只许 import `core` 与 `protocol`；`desktop` 全可 import；`core` 谁都不许 import。改任何 import 后跑 `pnpm lint:deps`。
- **scene-2d 不许碰 DOM**：源码里不许出现 `document` / `window` / `HTMLCanvasElement` / `OffscreenCanvas` / `requestAnimationFrame`。理由不是洁癖：`pnpm test` 跑在 node 环境（`vitest.config.ts` 的 include 只有 `packages/*/test/**/*.test.ts`），任何 DOM 引用都会让该模块在闸门里根本跑不到 —— 一个跑不到的模块等于没有测试。canvas 绘制只发生在 `apps/desktop`。
- **浮点只许活在屏幕侧**：`Viewport`、`Px`、绘制指令里的坐标都是浮点像素或浮点毫米；**任何要写回命令的东西必须先过 `quantizeMm`**（`@dajia/core`）。拖拽中途的浮点坐标只进 renderer 的临时绘制，不进 `Document`。（Task 5 已裁决：临时绘制走 renderer 的专用画家，`DrawLayer` **不加** `interaction` 层，指令表里也不新增 `dot` —— 详见 T5 的 D2。）
- **±0 纪律**：测试用 `Object.is` 语义比较。计算得出的 `Vec2` 一律经 `vec()` 构造；纯整数 fixture 与 `Aabb` 豁免。
- **不许拿 `byKind(...).at(-1)` 当"刚创建的那个"**：`uuidv7` 同毫秒不单调。取新建实体只认 `log.affected` + `kind` 判别式。
- **断言必须能区分"做了"和"没做"**：不许空样本短路，不许写"任何输入都不会红"的属性。每条属性在提交前要先证明它能红（改坏一个界看它叫）。
- **闸门一律重定向取 exit**：`pnpm verify > /tmp/verify.log 2>&1; echo exit=$?`。绝不 `| tail`。
- **`push` 由用户本人执行**；破坏性 git 操作需明确指示。MySQL 一次都不写（M1.3 才碰）。
- **renderer 永不接触数据库**；本计划里 renderer 连 IPC 写库都不该有 —— 样例文档由 `scene-2d` 的 `demoHouse()` 现场用命令建出来。
- **renderer 一行几何都不许算**：角点、沿轴距、包围盒、"这层该多大才装得下"（`fitStorey`）全在 scene-2d。这条不是风格：renderer 算出来的几何进不了 node 测试（无 jsdom），等于给屏幕单独写了一份没人测的真源。
- 每个 Task 结束跑一次 `pnpm verify` 全量；迭代途中只跑聚焦文件。

## 文件结构（本计划落地后新增/改动）

| 文件 | 职责 | 首次出现 |
|---|---|---|
| `vitest.config.ts` | 补 `@dajia/scene-2d` 等三个 alias（现在只有 core/protocol，测试 import 包名会解析不到） | T1 |
| `packages/scene-2d/tsconfig.json` | 让 scene-2d 进 typecheck（**现在根 `typecheck` 脚本只跑 core/protocol/desktop，scene-2d 的类型错误无人拦**） | T1 |
| `package.json`（根） | `typecheck` 串上 scene-2d | T1 |
| `packages/scene-2d/src/viewport.ts` | 整数毫米 ↔ 屏幕像素仿射：`Viewport` / `mmToPx` / `pxToMm` / `panBy` / `zoomAt` / `fitViewport` | T1 |
| `packages/scene-2d/test/viewport.test.ts` | 上面那个的可红测试（含 2 条属性） | T1 |
| `packages/scene-2d/src/demo.ts` | `demoHouse()`：无持久化时的样例两层房，命令现场建，desktop 与测试共用同一份几何 | T2 |
| `packages/scene-2d/src/drawlist.ts` | `buildDrawList(doc, storeyId, viewport, selection)` → `DrawOp[]`；`fitStorey(...)` → 该层的初始视口 | T2 |
| `packages/scene-2d/test/drawlist.test.ts` | 指令表的结构与不变式 | T2 |
| `packages/scene-2d/src/pick.ts` | 命中测试：`PICK_TOL_PX` / `distanceToSegmentPx` / `pickAt` / `pickOne` / `probeTarget`（靶子 = 指令表，容差 = 屏幕像素） | T4 |
| `packages/scene-2d/test/pick.test.ts` | 命中的判据：容差两侧、回边、层序压倒距离、去重、NaN 守卫、2 条属性 | T4 |
| `packages/scene-2d/src/index.ts` | 出口（现在是 `export const SCENE_2D_PACKAGE = 'scene-2d';` 一行 stub） | T1 起逐个补 |
| `packages/scene-2d/src/handles.ts` | 拖拽的屏幕侧全部纯函数：`HANDLE_COLOR`/`PREVIEW_COLOR`/`PIXEL_CHANNEL_TOL`/`HANDLE_RADIUS_PX`、`moveTargetOf`（px→mm 唯一出口）、`dragHandlesOf`、`pickHandle`、`legalDrop`（试跑 core 的 `build` 当合法性预言）、`dragProbe`、`pointSnapshot` | T5 |
| `packages/scene-2d/test/handles.test.ts` | 12 条：把手只给选中的墙、顺序与插入序无关、并列按 key、NaN、`legalDrop` 三条（含"坏的是邻墙"）、探针四性质、快照键集合、三种颜色互相分得开 | T5 |
| `packages/core/test/commands-drag.test.ts` | 7 条：柱跟走（对象同一性）/ 重影柱抛错 / 同一句文案的第二个产地 / 跨层正对照 / 原地拖不抛 / `end:'start'` 角色反转两条 | T5 |
| `packages/core/src/geom/topology.ts` | 加 `assertNoGhostColumn(doc, storeyId, at, exceptPointId?)` —— 判据从 `columnCreate` 里搬出来，第二个产地是拖动落点复核 | T5 |
| `apps/desktop/electron.vite.config.ts` | renderer 侧补 `@dajia/core` + `@dajia/scene-2d` 的 alias（scene-2d 源码里 import 的是裸说明符） | T3 |
| `apps/desktop/src/renderer/src/PlanCanvas.tsx` | 一块 canvas：量尺寸 → `fitStorey` → `buildDrawList` → 刷；并挂 `window.__dajiaDebug`。**T4 起**：选中进绘制、`onPointerDown` 走 `pickOne`、`opsRef` 让钩子读刷上屏那份、`DebugReport` 补 `selectedIds`/`selectedPx`/`pick`/`selectedAfterBlank`。**T5 起**：`paintHandles` + `paintPreview` 两个专用画家、window 级 `pointermove/up/cancel` 状态机、`Ctrl+Z`/`Ctrl+Shift+Z`、`DebugReport` 再补 12 个字段（`revision`/`depth`/`canUndo`/`canRedo`/`lastError`/`handlePx`/`previewPx`/`previewNearCursorPx`/`points`/`edit`/`lastDrop`/`lastKeyEvent`） | T3 |
| `apps/desktop/src/renderer/src/stores/editorStore.ts` | zustand：`TransactionLog`、当前层、视口。**T5 起**：`revision` 扳机（只在成功后 +1）、`lastError`、`drag` 态、`dispatch` 的 `catch`。**选中集不在这儿** —— spec 明令 selection 不进真源/撤销栈 | T3 |
| `apps/desktop/src/renderer/src/stores/selectionStore.ts` | zustand：`ids: ReadonlySet<string>` + `select`/`toggle`/`clear`，每次给新 Set。**没有 node 测试**（`apps/` 不在 vitest include 里，也没 jsdom），正确性由 `--pick-shot` 在真窗口钉 | T4 |
| `apps/desktop/src/main/index.ts` | 加 `--shot <path>`：`executeJavaScript('window.__dajiaDebug()')` → 写 JSON → `app.exit(code)`。**T4 加** `--pick-shot`：`sendInputEvent` 点探针给的两个点 + 条件轮询。**T5 加** `--edit-shot`：`pressPx`/`movePx`/`releasePx`/`keyCombo` 八步拖拽 + 撤销重做，每步读数分别留档；`argPath(flag)` 让开关与路径成对 | T3 |
| `scripts/desktop-shot.mjs` | 起 Electron 跑一次回读，按判据打 PASS/FAIL；**不进 `pnpm verify`**（CI 的 ubuntu 无 xvfb）。`--pick` 多四条（共 10 PASS）、`--edit` 多十四条（共 20 PASS） | T3 |

---

### Task 1: scene-2d 包骨架与视口仿射

**Files:**
- Create: `packages/scene-2d/tsconfig.json`
- Create: `packages/scene-2d/src/viewport.ts`
- Create: `packages/scene-2d/test/viewport.test.ts`
- Modify: `vitest.config.ts`（`resolve.alias` 补三条）
- Modify: `package.json`（根，`scripts.typecheck` 串上 scene-2d）
- Modify: `packages/scene-2d/src/index.ts`（加出口）
- Modify: `packages/scene-2d/package.json`（加 `"@dajia/core": "workspace:*"` 依赖）

**Interfaces:**
- Consumes: `Vec2`、`vec()`、`Aabb`（均来自 `@dajia/core`）
- Produces:
  ```ts
  export interface Px { readonly x: number; readonly y: number }
  export interface Viewport {
    readonly pxPerMm: number;
    readonly origin: Vec2;   // 屏幕左上角那一像素对应的毫米点
    readonly widthPx: number;
    readonly heightPx: number;
  }
  export function viewportOf(widthPx: number, heightPx: number, opts?: { pxPerMm?: number; center?: Vec2 }): Viewport;
  export function mmToPx(v: Viewport, p: Vec2): Px;
  export function pxToMm(v: Viewport, p: Px): Vec2;
  export function panBy(v: Viewport, dPx: Px): Viewport;
  export function zoomAt(v: Viewport, anchorPx: Px, factor: number): Viewport;
  export function fitViewport(widthPx: number, heightPx: number, box: Aabb, padPx: number): Viewport;
  ```
  后续任务对它的依赖：`fitViewport` 给 T2 的测试与 T3 的初始视口；`zoomAt` 的"锚点不动"不变式是 T5 拖拽的前提。

- [ ] **Step 1: 先把 typecheck 与 alias 接线补上（否则后面全是假绿）**

`packages/scene-2d/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "..", "types": ["node"] },
  "include": ["src/**/*.ts", "test/**/*.ts", "../core/src/**/*.ts"]
}
```

> `include` 里带上 `../core/src/**` 是因为 `tsconfig.base.json` 的 `paths` 只做名字解析，`noEmit` 的 tsc 需要真读到那些文件才能判 `@dajia/core` 的类型。core 自己的 tsconfig 也是这么处理的，照它抄。

根 `package.json` 的 `scripts.typecheck` 改成：

```json
"typecheck": "tsc --noEmit -p packages/core/tsconfig.json && tsc --noEmit -p packages/protocol/tsconfig.json && tsc --noEmit -p packages/scene-2d/tsconfig.json && pnpm --filter @dajia/desktop typecheck"
```

`vitest.config.ts` 的 `resolve.alias` 补三条（`drawing` / `scene-2d` / `scene-3d`），照 `@dajia/core` 那两行的写法：

```ts
      '@dajia/scene-2d': fileURLToPath(
        new URL('./packages/scene-2d/src/index.ts', import.meta.url),
      ),
```

`packages/scene-2d/package.json` 加依赖：

```json
  "dependencies": {
    "@dajia/core": "workspace:*"
  }
```

跑 `pnpm install --frozen-lockfile=false` 让 lockfile 认这条边，然后 `pnpm typecheck`，Expected: exit=0（此刻 scene-2d 只有一行 stub，必然干净 —— 这一步要的是**接线本身**，不是代码）。

- [ ] **Step 2: 写失败测试**

`packages/scene-2d/test/viewport.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { vec, type Aabb } from '@dajia/core';
import {
  fitViewport,
  mmToPx,
  panBy,
  pxToMm,
  viewportOf,
  zoomAt,
  type Viewport,
} from '@dajia/scene-2d';

/** 亚微米容差：浮点像素换算的误差量级远小于此，真写错时差的是毫米级。 */
const TOL_MM = 1e-6;
const TOL_PX = 1e-9;

const nearMm = (a: { x: number; y: number }, b: { x: number; y: number }): void => {
  expect(Math.abs(a.x - b.x)).toBeLessThan(TOL_MM);
  expect(Math.abs(a.y - b.y)).toBeLessThan(TOL_MM);
};

describe('视口仿射', () => {
  it('原点在左上角时：x 同向、y 翻转、按 pxPerMm 缩放', () => {
    const v = viewportOf(1000, 800, { pxPerMm: 0.5, center: vec(0, 0) });
    // center 是视口中心的毫米点；中心在 (0,0) 时左上角是 (-1000, 800) mm
    expect(mmToPx(v, vec(0, 0))).toEqual({ x: 500, y: 400 });
    expect(mmToPx(v, vec(100, 0)).x).toBeCloseTo(550, 9);
    expect(mmToPx(v, vec(0, 100)).y).toBeCloseTo(350, 9); // y 朝上 → 屏幕 y 变小
  });

  it('pxToMm ∘ mmToPx 还原同一个毫米点', () => {
    const v = viewportOf(1234, 567, { pxPerMm: 0.137, center: vec(4321, 6543) });
    nearMm(pxToMm(v, mmToPx(v, vec(1234.5, -678.25))), vec(1234.5, -678.25));
  });

  it('panBy 是纯平移：屏幕坐标整体加上位移（"抓住图拖"= 图跟手），不碰缩放', () => {
    const v = viewportOf(1000, 800, { pxPerMm: 0.25, center: vec(0, 0) });
    const moved = panBy(v, { x: 40, y: -25 });
    const p = vec(800, 300);
    // 图跟手：指针向右下走 dPx，同一个毫米点就朝 dPx 方向移动（y 轴朝下为正，与 mmToPx 同向）。
    // 这一句同时钉死了两个候选符号：origin 用减、y 用加，任何一处反过来这里就红。
    expect(mmToPx(moved, p).x).toBeCloseTo(mmToPx(v, p).x + 40, 9);
    expect(mmToPx(moved, p).y).toBeCloseTo(mmToPx(v, p).y - 25, 9);
    expect(moved.pxPerMm).toBe(v.pxPerMm);
    // 换的是"哪一毫米在左上角"，不是世界：向右拖 40px ⇒ 原点在世界里左移 40/pxPerMm 毫米。
    expect(moved.origin.x).toBeCloseTo(v.origin.x - 40 / 0.25, 9);
    expect(moved.origin.y).toBeCloseTo(v.origin.y - 25 / 0.25, 9);
  });

  it('zoomAt 之后，锚点那一像素下的毫米点没换（这是拖拽缩放的前提）', () => {
    const v = viewportOf(1000, 800, { pxPerMm: 0.2, center: vec(5000, 3000) });
    const anchor = { x: 731, y: 208 };
    const before = pxToMm(v, anchor);
    for (const f of [2, 0.5, 1.7, 0.031]) {
      nearMm(pxToMm(zoomAt(v, anchor, f), anchor), before);
    }
  });

  it('zoomAt 改的是 pxPerMm，不是别的', () => {
    const v = viewportOf(1000, 800, { pxPerMm: 0.2, center: vec(0, 0) });
    expect(zoomAt(v, { x: 500, y: 400 }, 2).pxPerMm).toBeCloseTo(0.4, 12);
  });

  it('fitViewport 把整盒装进视口并留出 padPx，且不许放大到超出任一边', () => {
    const box: Aabb = { minX: 0, minY: 0, maxX: 8000, maxY: 6000 };
    const v = fitViewport(900, 700, box, 40);
    for (const corner of [vec(0, 0), vec(8000, 0), vec(0, 6000), vec(8000, 6000)]) {
      const p = mmToPx(v, corner);
      expect(p.x).toBeGreaterThanOrEqual(40 - TOL_PX);
      expect(p.x).toBeLessThanOrEqual(900 - 40 + TOL_PX);
      expect(p.y).toBeGreaterThanOrEqual(40 - TOL_PX);
      expect(p.y).toBeLessThanOrEqual(700 - 40 + TOL_PX);
    }
    // 取小边：高 6000mm 要落在 620px 内 → 上限 620/6000，而不是宽边的 820/8000
    expect(v.pxPerMm).toBeLessThanOrEqual(620 / 6000 + 1e-12);
    expect(v.pxPerMm).toBeGreaterThan(0.1);
  });

  it('退化输入一律抛，不产出 NaN 视口', () => {
    expect(() => viewportOf(0, 800)).toThrow(RangeError);
    expect(() => viewportOf(1000, -1)).toThrow(RangeError);
    expect(() => viewportOf(1000, 800, { pxPerMm: 0 })).toThrow(RangeError);
    expect(() => viewportOf(1000, 800, { pxPerMm: Number.NaN })).toThrow(RangeError);
    expect(() => zoomAt(viewportOf(1000, 800), { x: 0, y: 0 }, 0)).toThrow(RangeError);
    expect(() => zoomAt(viewportOf(1000, 800), { x: 0, y: 0 }, -2)).toThrow(RangeError);
    expect(() => fitViewport(900, 700, { minX: 0, minY: 0, maxX: 0, maxY: 0 }, 40)).toThrow(RangeError);
    expect(() => fitViewport(80, 700, { minX: 0, minY: 0, maxX: 8000, maxY: 6000 }, 400)).toThrow(RangeError);
  });

  it('属性：任意合法视口下 round-trip 稳定在亚微米', () => {
    const arbViewport: fc.Arbitrary<Viewport> = fc
      .record({
        w: fc.integer({ min: 1, max: 8192 }),
        h: fc.integer({ min: 1, max: 8192 }),
        pxPerMm: fc.double({ min: 0.005, max: 200, noNaN: true }),
        cx: fc.integer({ min: -1_000_000, max: 1_000_000 }),
        cy: fc.integer({ min: -1_000_000, max: 1_000_000 }),
      })
      .map((r) => viewportOf(r.w, r.h, { pxPerMm: r.pxPerMm, center: vec(r.cx, r.cy) }));

    fc.assert(
      fc.property(
        arbViewport,
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        (v, x, y) => {
          const back = pxToMm(v, mmToPx(v, vec(x, y)));
          // 相对容差：1e6 mm 量级上浮点像素的绝对误差不可能压到 1e-6
          expect(Math.abs(back.x - x)).toBeLessThan(Math.max(1e-6, Math.abs(x) * 1e-9));
          expect(Math.abs(back.y - y)).toBeLessThan(Math.max(1e-6, Math.abs(y) * 1e-9));
        },
      ),
      { numRuns: 500 },
    );
  });

  it('属性：zoomAt 的锚点不变式对任意锚点与因子成立', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 4096 }),
        fc.integer({ min: 100, max: 4096 }),
        fc.double({ min: 0.01, max: 50, noNaN: true }),
        fc.double({ min: 0.02, max: 50, noNaN: true }),
        (w, h, pxPerMm, factor) => {
          const v = viewportOf(w, h, { pxPerMm, center: vec(0, 0) });
          const anchor = { x: w / 3, y: h / 2 };
          const before = pxToMm(v, anchor);
          const after = pxToMm(zoomAt(v, anchor, factor), anchor);
          expect(Math.abs(after.x - before.x)).toBeLessThan(1e-3);
          expect(Math.abs(after.y - before.y)).toBeLessThan(1e-3);
        },
      ),
      { numRuns: 500 },
    );
  });
});
```

- [ ] **Step 3: 跑测试，确认它是因为"模块还没有"而红**

Run: `pnpm --filter @dajia/scene-2d exec vitest run test/viewport.test.ts > /tmp/t1-red.log 2>&1; echo exit=$?`
（若包级 vitest 不可用，改用根：`npx vitest run packages/scene-2d/test/viewport.test.ts > /tmp/t1-red.log 2>&1; echo exit=$?`）
Expected: exit≠0，报错形如 `Failed to resolve import "@dajia/scene-2d"` 或 `does not provide an export named 'viewportOf'`。**不许**出现"0 个测试通过但 exit=0" —— 那是空跑。

- [ ] **Step 4: 写实现**

`packages/scene-2d/src/viewport.ts`：

```ts
import { vec, type Aabb, type Vec2 } from '@dajia/core';

/** 屏幕像素点。y 朝下，与毫米（y 朝上）相反 —— 翻转只发生在这一层。 */
export interface Px {
  readonly x: number;
  readonly y: number;
}

/**
 * 视口 = 缩放 + 平移。浮点只许活在屏幕侧：任何要写回命令的坐标必须先过 quantizeMm。
 * origin 是「屏幕左上角那一像素对应的毫米点」，用中心构造（viewportOf 的 center），
 * 因为"以视口中心为焦点"是打开图纸时的默认，而 origin 是它的派生量。
 */
export interface Viewport {
  readonly pxPerMm: number;
  readonly origin: Vec2;
  readonly widthPx: number;
  readonly heightPx: number;
}

const MIN_PX_PER_MM = 1e-6;
const MAX_PX_PER_MM = 1e4;

function requireFinite(label: string, n: number): void {
  if (!Number.isFinite(n)) throw new RangeError(`${label} 必须是有限数，收到 ${String(n)}`);
}

function assertScale(label: string, pxPerMm: number): void {
  requireFinite(label, pxPerMm);
  if (pxPerMm < MIN_PX_PER_MM || pxPerMm > MAX_PX_PER_MM) {
    throw new RangeError(`${label} 必须在 [${MIN_PX_PER_MM}, ${MAX_PX_PER_MM}] px/mm 之间，收到 ${pxPerMm}`);
  }
}

function assertSize(widthPx: number, heightPx: number): void {
  requireFinite('widthPx', widthPx);
  requireFinite('heightPx', heightPx);
  if (widthPx <= 0 || heightPx <= 0) {
    throw new RangeError(`视口尺寸必须为正，收到 ${widthPx}×${heightPx}`);
  }
}

export function viewportOf(
  widthPx: number,
  heightPx: number,
  opts: { pxPerMm?: number; center?: Vec2 } = {},
): Viewport {
  assertSize(widthPx, heightPx);
  const pxPerMm = opts.pxPerMm ?? 0.1;
  assertScale('pxPerMm', pxPerMm);
  const center = opts.center ?? vec(0, 0);
  return {
    pxPerMm,
    // center 是视口中心的毫米点：左上角 = 中心往 -x 走半宽、往 +y 走半高（y 朝上）
    origin: vec(center.x - widthPx / 2 / pxPerMm, center.y + heightPx / 2 / pxPerMm),
    widthPx,
    heightPx,
  };
}

export function mmToPx(v: Viewport, p: Vec2): Px {
  return { x: (p.x - v.origin.x) * v.pxPerMm, y: (v.origin.y - p.y) * v.pxPerMm };
}

export function pxToMm(v: Viewport, p: Px): Vec2 {
  return vec(v.origin.x + p.x / v.pxPerMm, v.origin.y - p.y / v.pxPerMm);
}

/**
 * 平移视口：`dPx` 是**指针移动量**，图跟手 —— 同一个毫米点在屏幕上移动 `dPx`。
 * 于是 x 用减（原点在世界里往左），y 用加（屏幕 y 轴朝下，`mmToPx` 里已经翻过一次，
 * 这里再翻就变成"往右拖图往左走"）。约定写在函数上而不是只写在测试标题里：
 * 后面任何接拖拽平移的代码都只能有一种解法。
 */
export function panBy(v: Viewport, dPx: Px): Viewport {
  requireFinite('pan.dx', dPx.x);
  requireFinite('pan.dy', dPx.y);
  return {
    ...v,
    origin: vec(v.origin.x - dPx.x / v.pxPerMm, v.origin.y + dPx.y / v.pxPerMm),
  };
}

/**
 * 以 anchorPx 为焦点缩放。锚点下的毫米点必须原地不动 —— 忘了重算 origin 就是
 * "一缩放图就飘走"，那是编辑器最刺眼的 bug，所以它由测试单独钉。
 */
export function zoomAt(v: Viewport, anchorPx: Px, factor: number): Viewport {
  requireFinite('zoom.factor', factor);
  if (factor <= 0) throw new RangeError(`缩放因子必须为正，收到 ${factor}`);
  const anchorMm = pxToMm(v, anchorPx);
  const pxPerMm = v.pxPerMm * factor;
  assertScale('zoom.pxPerMm', pxPerMm);
  const next: Viewport = { ...v, pxPerMm };
  return {
    ...next,
    origin: vec(anchorMm.x - anchorPx.x / pxPerMm, anchorMm.y + anchorPx.y / pxPerMm),
  };
}

/**
 * 把 box 完整装进视口，四周留 padPx 边距。取两边的**较小**缩放：
 * 取大就有一条边被切掉，而"图被切掉一角"在平面图上看起来像房子本来就只有那么大。
 * 留白吃满时抛错而不是静默产出负的可用区 —— 后者会算出负的 pxPerMm。
 */
export function fitViewport(widthPx: number, heightPx: number, box: Aabb, padPx: number): Viewport {
  assertSize(widthPx, heightPx);
  requireFinite('padPx', padPx);
  if (padPx < 0) throw new RangeError(`padPx 不许为负，收到 ${padPx}`);
  const wMm = box.maxX - box.minX;
  const hMm = box.maxY - box.minY;
  if (!(wMm > 0) || !(hMm > 0)) {
    throw new RangeError(`fitViewport 需要非零包围盒，收到 ${wMm}×${hMm}`);
  }
  const availW = widthPx - padPx * 2;
  const availH = heightPx - padPx * 2;
  if (availW <= 0 || availH <= 0) {
    throw new RangeError(`padPx=${padPx} 把 ${widthPx}×${heightPx} 的视口留白吃光了`);
  }
  const pxPerMm = Math.min(availW / wMm, availH / hMm);
  assertScale('fitViewport.pxPerMm', pxPerMm);
  return viewportOf(widthPx, heightPx, {
    pxPerMm,
    center: vec((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2),
  });
}
```

`packages/scene-2d/src/index.ts` 改成：

```ts
export const SCENE_2D_PACKAGE = 'scene-2d';

export * from './viewport';
```

- [ ] **Step 5: 跑测试到全绿**

Run: `npx vitest run packages/scene-2d/test/viewport.test.ts > /tmp/t1-green.log 2>&1; echo exit=$?`
Expected: exit=0，**`Tests 9 passed`**（Step 2 的 `it` 共 9 条，两条属性算在其中；`Test Files 1 passed`）。数对不上就是有用例被跳过或被合并，别改期望值，先查日志。

- [ ] **Step 6: 证明这些断言不是摆设（改坏看它红）**

逐条做，每条做完立刻改回来：

1. `zoomAt` 里把 `origin` 重算删掉（只返回 `{...v, pxPerMm}`）→ 「锚点不动」那条与那条属性**必须红**。
2. `fitViewport` 的 `Math.min` 改成 `Math.max` → 「不许放大到超出任一边」必须红。
3. `assertSize` 里 `widthPx <= 0 || heightPx <= 0` 改成 `<`（两处一起改，只改一处会被另一处兜住而测不出来）→ 「退化输入一律抛」必须红在 `viewportOf(0, 800)`。
4. `mmToPx` 的 y 翻转去掉（`(p.y - v.origin.y)`）→ 第一条 `it` 必须红。

四条全红过一遍，把四条命令与关键红字贴进提交信息或报告。任何一条"改坏了还绿"，说明断言写空了，就地补到能红为止。

- [ ] **Step 7: 全量闸门 + 提交**

```bash
pnpm verify > /tmp/t1-verify.log 2>&1; echo exit=$?
git add packages/scene-2d vitest.config.ts package.json pnpm-lock.yaml
git commit -m "feat: scene-2d 视口仿射与包接线"
```

Expected: exit=0；`Tests` 行 = 计划 2 结尾的基数 **+9**，`Test Files` +1。把前后两个数写进提交信息，别只写"全绿"。

---

### Task 2: 绘制指令表与样例两层房

**Files:**
- Create: `packages/scene-2d/src/demo.ts`
- Create: `packages/scene-2d/src/drawlist.ts`
- Create: `packages/scene-2d/test/drawlist.test.ts`
- Modify: `packages/scene-2d/src/index.ts`

**Interfaces:**
- Consumes: T1 的 `Viewport` / `mmToPx` / `Px` / `viewportOf` / `fitViewport`；`@dajia/core` 的 `deriveStoreyGeometry`、`wallAxisById`、`advance`、`aabbOfPoints`、`requireStorey`、`TransactionLog`、`Document`、`uuidv7`，以及 Step 1 里点名的 7 条 command
- Produces:
  ```ts
  export type DrawLayer = 'structure' | 'opening' | 'annotation';
  export type LineType = 'solid' | 'dashed' | 'dash-dot';
  export interface Pen { readonly layer: DrawLayer; readonly lineType: LineType; readonly widthPx: number; readonly color: string }
  export type DrawOp =
    | { readonly kind: 'polygon'; readonly ownerId: string | null; readonly pts: readonly Px[]; readonly fill: string | null; readonly pen: Pen }
    | { readonly kind: 'line'; readonly ownerId: string | null; readonly from: Px; readonly to: Px; readonly pen: Pen }
    | { readonly kind: 'text'; readonly ownerId: string | null; readonly at: Px; readonly text: string; readonly sizePx: number; readonly pen: Pen };
  export interface Selection { readonly ids: ReadonlySet<string> }
  export const EMPTY_SELECTION: Selection;
  export function buildDrawList(doc: Document, storeyId: string, v: Viewport, sel?: Selection): DrawOp[];
  export function fitStorey(doc: Document, storeyId: string, widthPx: number, heightPx: number, padPx?: number): Viewport;
  export function demoHouse(): { log: TransactionLog; doc: Document; lowerStoreyId: string; upperStoreyId: string };
  ```
  T3 拿 `buildDrawList` 直接刷 canvas、拿 `fitStorey` 定初始视口；T4 的命中结果会喂给 `Selection`。

> **`fitStorey` 为什么在 scene-2d 而不是 renderer**：算"这层要画多大"必须读派生几何（`deriveStoreyGeometry` + `aabbOfPoints`），而 renderer 一条几何都不许算（全局约束）。它是纯函数、不碰 DOM，所以放得进来。**空层必须返回默认视口而不是抛** —— `aabbOfPoints` 在零点上抛 `RangeError`，而"打开一个还没画墙的新层"是正常状态，不是错误状态。

> **`ownerId` 为什么在每一条上**：T4 要把"屏幕上点到的那个像素"变成"文档里的哪个实体"，唯一的桥就是指令自己带上来源 id。到那时再往三个变体上补字段，等于让画法和选取协议互相追着改。派生出来的、不对应单一实体的指令（现在没有，将来如填充阴影）写 `null`，别写假 id。
>
> **联合类型里不留没人产的枚举值**。原稿的 `DrawLayer` 还有 `grid` 与 `interaction`，`DrawOp` 还有 `dot`，`LineType` 还有 `hidden` —— 全删：轴网是 desktop 的视口装饰（不进 scene-2d 的指令表），命中高亮走 `pen.color` 而不是独立层（见「选中必须真的改变输出」那条），控制点等 T4 真要画时再加，隐藏线等计划 5 的剖面再加。**一个谁都不产的层，测试里的"层序"断言就永远只在数它自己排的那几个值** —— 那是假绿的入口。

- [ ] **Step 1: 写 `demo.ts`（测试与 desktop 共用同一份样例，别各写一份）**

`packages/scene-2d/src/demo.ts` —— 就是计划 2 Task 10 那栋两层房，**取实体一律走 `log.affected`**：

```ts
import {
  Document,
  TransactionLog,
  openingCreate,
  openingMove,
  storeyCreate,
  storeySetElevation,
  uuidv7,
  wallCreate,
  wallMoveEndpoint,
  wallSetThickness,
  type Command,
  type PointRef,
  type WallEntity,
} from '@dajia/core';

const STOREY_HEIGHT_MM = 3000;

function lastCreatedWall(log: TransactionLog): WallEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new TypeError('affected 里没有新建的墙');
}

function lastCreatedId(log: TransactionLog, kind: 'opening' | 'storey'): string {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === kind) return entity.id;
  }
  throw new TypeError(`affected 里没有新建的 ${kind}`);
}

/**
 * 无持久化（M1.3 之前）时的样例工程：8000×6000 两层，一层吃过 4 次编辑。
 * 它不是测试夹具的专利 —— desktop 首屏也吃它，于是"看到的"和"测到的"是同一份几何。
 */
export function demoHouse(): {
  log: TransactionLog;
  doc: Document;
  lowerStoreyId: string;
  upperStoreyId: string;
} {
  const projectId = uuidv7();
  const log = new TransactionLog(Document.create(projectId));
  const step = (cmd: Command): void => {
    log.dispatch(cmd);
  };

  const buildStorey = (storeyId: string) => {
    // 一面墙一个具名 const：`Record<string, WallEntity>` 在 noUncheckedIndexedAccess 下
    // 每次读都带 | undefined，写 `walls.southWest.endId` 直接编译不过。具名引用既过了
    // 类型检查，又把"谁接在谁后面"这层建造顺序摊平在纸面上。
    const put = (start: PointRef, end: PointRef, thicknessMm: number): WallEntity => {
      step(wallCreate({ storeyId, start, end, thicknessMm, heightMm: STOREY_HEIGHT_MM }));
      return lastCreatedWall(log);
    };

    const southWest = put({ x: 0, y: 0 }, { x: 4000, y: 0 }, 240);
    const southEast = put({ pointId: southWest.endId }, { x: 8000, y: 0 }, 240);
    const east = put({ pointId: southEast.endId }, { x: 8000, y: 6000 }, 240);
    const north = put({ pointId: east.endId }, { x: 0, y: 6000 }, 240);
    const west = put({ pointId: southWest.startId }, { pointId: north.endId }, 240);
    const stem = put({ pointId: southWest.endId }, { x: 4000, y: 3000 }, 120);
    const partWest = put({ x: 1000, y: 3000 }, { pointId: stem.endId }, 120);
    const partEast = put({ pointId: stem.endId }, { x: 7000, y: 3000 }, 120);
    const walls = { southWest, southEast, east, north, west, stem, partWest, partEast };

    const open = (hostWallId: string, distanceMm: number, widthMm: number, category: 'door' | 'window'): string => {
      step(
        openingCreate({
          hostWallId,
          distanceMm,
          widthMm,
          heightMm: category === 'door' ? 2100 : 1500,
          category,
        }),
      );
      return lastCreatedId(log, 'opening');
    };
    open(southWest.id, 1500, 1000, 'door');
    open(east.id, 1000, 1000, 'door');
    const winNorth = open(north.id, 2000, 1500, 'window');
    open(west.id, 3500, 1200, 'window');

    return { walls, winNorth };
  };

  step(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: STOREY_HEIGHT_MM }));
  const lowerStoreyId = lastCreatedId(log, 'storey');
  const lower = buildStorey(lowerStoreyId);
  step(storeyCreate({ projectId, index: 1, elevationMm: 6000, heightMm: STOREY_HEIGHT_MM }));
  const upperStoreyId = lastCreatedId(log, 'storey');
  buildStorey(upperStoreyId);

  // 一层吃 4 次编辑：二层保持原样，两层的差异正好给视图当对照
  step(wallMoveEndpoint({ wallId: lower.walls.partWest.id, end: 'start', x: 800, y: 3000 }));
  step(wallSetThickness({ wallId: lower.walls.stem.id, thicknessMm: 240 }));
  step(openingMove({ openingId: lower.winNorth, distanceMm: 2200 }));
  step(storeySetElevation({ storeyId: upperStoreyId, elevationMm: 3000 }));

  return { log, doc: log.document, lowerStoreyId, upperStoreyId };
}
```

> **为什么两个助手而不是一个带 `kind` 参数的泛型**：`lastCreatedWall` 要回 `WallEntity`，`lastCreatedId` 只回 id；合成一个的话末尾必须留 `as WallEntity`，而 `entity?.kind === kind` 这种"kind 是变量"的写法 TS 根本不做判别式收窄。计划 2 Task 10 的测试文件里已经为同样的理由写了三个六行助手，照那个形状抄。**`put(...)` 的返回值一律接进具名 const，任何地方都不许换成 `doc.byKind('wall').at(-1)`** —— uuidv7 同毫秒不单调，`byKind` 还是 id 升序，那样取到的是"随机某面墙"。

- [ ] **Step 2: 写失败测试**

`packages/scene-2d/test/drawlist.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  aabbOfPoints,
  deriveStoreyGeometry,
  storeyCreate,
  vec,
  type TransactionLog,
} from '@dajia/core';
import {
  buildDrawList,
  demoHouse,
  EMPTY_SELECTION,
  fitStorey,
  fitViewport,
  mmToPx,
  viewportOf,
  type DrawLayer,
  type DrawOp,
  type Px,
} from '@dajia/scene-2d';

const house = demoHouse();
const geo = deriveStoreyGeometry(house.doc, house.lowerStoreyId);
const box = aabbOfPoints(geo.walls.flatMap((q) => [...q.corners]));
const view = fitViewport(1200, 900, box, 60);

const polys = (ops: DrawOp[]) => ops.filter((o) => o.kind === 'polygon');
const lines = (ops: DrawOp[]) => ops.filter((o) => o.kind === 'line');

function lastCreatedStorey(log: TransactionLog): string {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'storey') return entity.id;
  }
  throw new TypeError('affected 里没有新建的楼层');
}

const allPx = (ops: DrawOp[]): number[] =>
  ops.flatMap((o) =>
    o.kind === 'polygon'
      ? o.pts.flatMap((p) => [p.x, p.y])
      : o.kind === 'line'
        ? [o.from.x, o.from.y, o.to.x, o.to.y]
        : [o.at.x, o.at.y],
  );

const ptsOf = (o: DrawOp): readonly Px[] =>
  o.kind === 'polygon' ? o.pts : o.kind === 'line' ? [o.from, o.to] : [o.at];

const layerRank = (l: DrawLayer) => ['structure', 'opening', 'annotation'].indexOf(l);

describe('绘制指令表', () => {
  it('一面墙一个轮廓多边形，四角，层是 structure', () => {
    const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);
    const walls = polys(ops).filter((o) => o.pen.layer === 'structure');
    expect(geo.walls.length).toBeGreaterThan(0);
    expect(walls).toHaveLength(geo.walls.length);
    for (const w of walls) expect(w.pts).toHaveLength(4);
  });

  it('多边形顶点就是派生角点的 mmToPx：绘制层里不许有第二份几何', () => {
    const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);
    const wallPolys = polys(ops).filter((o) => o.pen.layer === 'structure');
    expect(wallPolys.map((o) => [...o.pts])).toEqual(
      geo.walls.map((q) => q.corners.map((c) => mmToPx(view, c))),
    );
  });

  it('轴线段数等于墙垛段数（洞口处必须是断的）', () => {
    const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);
    const axes = lines(ops).filter(
      (o) => o.pen.layer === 'structure' && o.pen.lineType === 'dash-dot',
    );
    expect(geo.pieces.length).toBeGreaterThan(0);
    expect(axes).toHaveLength(geo.pieces.length);
  });

  it('洞口走 opening 层：4 樘共 8 条断口线，两樘窗各多一条中线', () => {
    const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);
    const openingOps = ops.filter((o) => o.pen.layer === 'opening');
    const openingIds = new Set(
      house.doc
        .byKind('opening')
        .filter((x) => x.storeyId === house.lowerStoreyId)
        .map((x) => x.id),
    );
    expect(openingIds.size).toBe(4);
    expect(new Set(openingOps.map((o) => o.ownerId))).toEqual(openingIds);
    expect(openingOps.filter((o) => o.pen.lineType === 'solid')).toHaveLength(8);
    expect(openingOps.filter((o) => o.pen.lineType === 'dashed')).toHaveLength(2);
  });

  it('每条指令的 ownerId 只能是本层的实体或 null', () => {
    const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);
    const storeyWallIds = new Set(geo.walls.map((q) => q.wallId));
    const storeyOpeningIds = new Set(
      house.doc
        .byKind('opening')
        .filter((x) => x.storeyId === house.lowerStoreyId)
        .map((x) => x.id),
    );
    expect(ops.length).toBeGreaterThan(0);
    for (const o of ops) {
      const ok =
        o.ownerId === null ||
        o.ownerId === house.lowerStoreyId ||
        storeyWallIds.has(o.ownerId) ||
        storeyOpeningIds.has(o.ownerId);
      expect(ok).toBe(true);
    }
  });

  it('选中必须真的改变输出：变红的只有被选中的那个实体', () => {
    const wallId = geo.walls[0]!.wallId;
    const plain = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);
    const picked = buildDrawList(house.doc, house.lowerStoreyId, view, { ids: new Set([wallId]) });
    const red = (o: DrawOp) => o.pen.color === '#c9252d';
    expect(plain.some(red)).toBe(false);
    const redOps = picked.filter(red);
    expect(redOps.length).toBeGreaterThan(0);
    expect(new Set(redOps.map((o) => o.ownerId))).toEqual(new Set([wallId]));
    expect(picked).toHaveLength(plain.length);
  });

  it('指令按层序出，最后一条必须是楼层标签', () => {
    const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);
    const order = ops.map((o) => o.pen.layer);
    for (let i = 1; i < order.length; i++) {
      expect(layerRank(order[i]!)).toBeGreaterThanOrEqual(layerRank(order[i - 1]!));
    }
    // 这里的数组尾巴是确定的（指令表由本函数排序产出），与真源里禁用的
    // byKind(...).at(-1) 无关 —— 那条禁的是靠 uuid 序猜"刚创建的那个实体"。
    expect(ops[ops.length - 1]!.pen.layer).toBe('annotation');
    expect(ops.filter((o) => o.pen.layer === 'annotation')).toHaveLength(1);
  });

  it('空层给空表：没有墙就没有任何指令', () => {
    const fresh = demoHouse();
    fresh.log.dispatch(
      storeyCreate({
        projectId: fresh.doc.projectId,
        index: 2,
        elevationMm: 6000,
        heightMm: 3000,
      }),
    );
    const thirdId = lastCreatedStorey(fresh.log);
    // 读文档一律读 `log.document`：`dispatch` 之后 `fresh.doc` 还是 `demoHouse()` 那一刻的
    // 快照，第三层不在里面 —— 拿它去派生会红在 `TypeError: 楼层 不存在`，
    // 而不是红在本条要钉的那句"空层不许抛"。
    const doc = fresh.log.document;
    expect(deriveStoreyGeometry(doc, thirdId).walls).toEqual([]);
    expect(buildDrawList(doc, thirdId, view)).toEqual([]);
    // 空层也要能打开：视口退化到默认缩放，而不是把 RangeError 抛给 UI
    expect(fitStorey(doc, thirdId, 1200, 900, 60).widthPx).toBe(1200);
  });

  it('fitStorey 把整层装进画布：没有一条指令落在画布外', () => {
    const pad = 60;
    const fitted = fitStorey(house.doc, house.lowerStoreyId, 1200, 900, pad);
    const ops = buildDrawList(house.doc, house.lowerStoreyId, fitted);
    expect(ops.length).toBeGreaterThan(0);
    for (const o of ops) {
      for (const p of ptsOf(o)) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(1200);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(900);
      }
    }
    // 本样例是"高"这一边吃满（6240mm / 780px = 8.0 > 8240mm / 1080px ≈ 7.63：
    // mm/px 越大的一边越先填满，可用像素先被纵向用光）。纵向张幅必须正好等于可用高，
    // 否则 fitStorey 把 padPx 丢了或选错了缩放边。
    // 两个数不是手抖写的：整层角点 AABB = {−120,−120,8120,6120}（计划 2 的 integration 定值），
    // 张幅 6120−(−120)=6240 与 8120−(−120)=8240；可用高宽 = 900−120 / 1200−120。
    const ys = ops
      .filter((o) => o.pen.layer !== 'annotation')
      .flatMap((o) => [...ptsOf(o)].map((p) => p.y));
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(900 - pad * 2, 6);
  });

  it('属性：换视口只换像素，不换指令表的结构', () => {
    const expectedOps = buildDrawList(house.doc, house.lowerStoreyId, view).length;
    fc.assert(
      fc.property(
        fc.double({ min: 0.005, max: 200, noNaN: true }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        (pxPerMm, cx, cy) => {
          const v = viewportOf(1000, 800, { pxPerMm, center: vec(cx, cy) });
          const ops = buildDrawList(house.doc, house.lowerStoreyId, v);
          expect(ops).toHaveLength(expectedOps);
          for (const n of allPx(ops)) expect(Number.isFinite(n)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});
```

> **一共 10 条 `it`**（轮廓、同源、轴线、洞口、ownerId、选中、层序、空层、fitStorey，外加 1 条属性）。Step 5 的门槛按 10 条写；以日志的 `Tests N passed` 为准，别按标题数。
>
> 「空层给空表」走的是真命令：`storeyCreate` 开第三层（index 2、标高 6000，与一层的 0–3000、二层的 3000–6000 都不重叠 —— `assertNoVerticalOverlap` 会挡），一层墙都不画。它逼出一个真实的短路：`aabbOfPoints` 在零点上抛 `RangeError`，所以 `buildDrawList` **必须在算包围盒之前**返回 `[]`。把短路挪到标签之后，这条立刻红在异常上而不是断言上 —— 这就是它不是装饰的证明。
>
> 「洞口走 opening 层」的 8 / 2 是**类别差异**：窗多一条中线，门没有。若实现把窗当门画，`dashed` 那条立刻 0≠2 红掉；若实现给门也补一条中线，同样红。原稿这里写的是"门 2 个、窗 2 个"，只数了樘数，任何画法都能过。

- [ ] **Step 3: 跑测试确认红在"没有 buildDrawList"**

Run: `npx vitest run packages/scene-2d/test/drawlist.test.ts > /tmp/t2-red.log 2>&1; echo exit=$?`
Expected: exit≠0，红在解析/导出缺失（`does not provide an export named 'buildDrawList'`）。

- [ ] **Step 4: 写 `drawlist.ts`**

三条口径贯穿全文：**① 指令表只吃派生，不吃实体** —— 墙轮廓一律来自 `deriveStoreyGeometry`，不许在这里再算一遍角点（真源里只有整数毫米的端点，角点是斜切后的浮点结果，重算一份就是第二份几何）；**② 层序由输出的数组顺序表达**，desktop 只管从头刷到尾，于是"谁盖住谁"在 scene-2d 里就定死；**③ 选中色是常量** `#c9252d`，测试按它判"选中真的改了输出"。

`packages/scene-2d/src/drawlist.ts`：

```ts
import {
  aabbOfPoints,
  advance,
  deriveStoreyGeometry,
  requireStorey,
  spansOfOpenings,
  vec,
  wallAxisById,
  type Document,
  type OpeningSpan,
  type WallAxis,
} from '@dajia/core';
import {
  fitViewport,
  mmToPx,
  viewportOf,
  type Px,
  type Viewport,
} from './viewport';

export type DrawLayer = 'structure' | 'opening' | 'annotation';
export type LineType = 'solid' | 'dashed' | 'dash-dot';

export interface Pen {
  readonly layer: DrawLayer;
  readonly lineType: LineType;
  readonly widthPx: number;
  readonly color: string;
}

/**
 * 一条指令 = 一个画法 + 它的来源实体。ownerId 是 T4 命中测试唯一的桥：
 * 屏幕点 → 指令 → 实体 id。派生出、不对应单一实体的指令写 null，别写假 id。
 */
export type DrawOp =
  | {
      readonly kind: 'polygon';
      readonly ownerId: string | null;
      readonly pts: readonly Px[];
      readonly fill: string | null;
      readonly pen: Pen;
    }
  | { readonly kind: 'line'; readonly ownerId: string | null; readonly from: Px; readonly to: Px; readonly pen: Pen }
  | {
      readonly kind: 'text';
      readonly ownerId: string | null;
      readonly at: Px;
      readonly text: string;
      readonly sizePx: number;
      readonly pen: Pen;
    };

export interface Selection {
  readonly ids: ReadonlySet<string>;
}

export const EMPTY_SELECTION: Selection = { ids: new Set<string>() };

export const INK = '#1f1f1f';
export const GLAZING = '#2f6fb3';
export const SELECTED = '#c9252d';

const WALL_PEN: Pen = { layer: 'structure', lineType: 'solid', widthPx: 2, color: INK };
const AXIS_PEN: Pen = { layer: 'structure', lineType: 'dash-dot', widthPx: 1, color: INK };
const JAMB_PEN: Pen = { layer: 'opening', lineType: 'solid', widthPx: 1.5, color: INK };
const GLAZING_PEN: Pen = { layer: 'opening', lineType: 'dashed', widthPx: 1, color: GLAZING };
const LABEL_PEN: Pen = { layer: 'annotation', lineType: 'solid', widthPx: 1, color: INK };

const LABEL_OFFSET_MM = 300;
const LABEL_SIZE_PX = 14;

/** 同一面墙的轴线可能被轮廓段与洞口各要一次；wallAxisById 里有开根号，缓存掉。 */
function axisOf(cache: Map<string, WallAxis>, doc: Document, wallId: string): WallAxis {
  const hit = cache.get(wallId);
  if (hit !== undefined) return hit;
  const axis = wallAxisById(doc, wallId);
  cache.set(wallId, axis);
  return axis;
}

/** 沿轴 mm → 世界点。dir 是单位向量，所以 advance 的第三个参数直接是沿轴距。 */
function alongAxis(axis: WallAxis, mm: number) {
  return advance(axis.start, axis.dir, mm);
}

export function buildDrawList(
  doc: Document,
  storeyId: string,
  v: Viewport,
  sel: Selection = EMPTY_SELECTION,
): DrawOp[] {
  const geo = deriveStoreyGeometry(doc, storeyId);
  // 短路必须在包围盒之前：aabbOfPoints 在零点上抛 RangeError，
  // 而"空层没有任何指令"是本层唯一的真话 —— 标签也没有，因为没有可标注的东西。
  if (geo.walls.length === 0) return [];

  const axes = new Map<string, WallAxis>();
  const ops: DrawOp[] = [];
  const penFor = (ownerId: string, base: Pen): Pen =>
    sel.ids.has(ownerId) ? { ...base, color: SELECTED } : base;

  // ① structure：墙轮廓。角点一律来自派生 —— 这里再算一份就是第二份几何。
  for (const quad of geo.walls) {
    ops.push({
      kind: 'polygon',
      ownerId: quad.wallId,
      pts: quad.corners.map((c) => mmToPx(v, c)),
      fill: null,
      pen: penFor(quad.wallId, WALL_PEN),
    });
  }

  // ② structure：轴线按墙垛分段。geo.pieces 已经是"被洞口打断的沿轴区间"，
  //    照它出图，洞口处自然断开 —— 连墙带轴一起画是错的，那是把洞抹掉了。
  for (const piece of geo.pieces) {
    const axis = axisOf(axes, doc, piece.wallId);
    ops.push({
      kind: 'line',
      ownerId: piece.wallId,
      from: mmToPx(v, alongAxis(axis, piece.fromMm)),
      to: mmToPx(v, alongAxis(axis, piece.toMm)),
      pen: penFor(piece.wallId, AXIS_PEN),
    });
  }

  // 洞口的沿轴区间只有一个产地：core 的 `spansOfOpenings`（计划 2 终审 I-3 合并出来的出口，
  // 命令层的夹取复核与墙垛分段吃的是同一份算式）。这里再写一遍 `distanceMm + widthMm`
  // 就是第三份投影，漂一次的后果是"图上的洞口与墙垛对不上"。
  const spanById = new Map<string, OpeningSpan>();
  for (const span of spansOfOpenings(
    doc.byKind('opening').filter((o) => o.storeyId === storeyId),
  )) {
    spanById.set(span.openingId, span);
  }

  // ③ opening：每樘洞口两条断口线（横穿墙厚），窗再补一条沿轴中线。
  for (const opening of doc.byKind('opening')) {
    if (opening.storeyId !== storeyId) continue;
    const axis = axisOf(axes, doc, opening.hostWallId);
    const half = axis.thicknessMm / 2;
    // 查不空：spanById 的过滤条件与上面的 continue 逐字相同。留着这句是让类型收窄成立
    // （同 commands/wall.ts 的 resolveEnd 那条不可达抛错的规矩），不是给 UI 准备的错误分支。
    const span = spanById.get(opening.id);
    if (span === undefined) throw new TypeError(`洞口 ${opening.id} 没有沿轴区间（内部错误）`);
    const near = alongAxis(axis, span.fromMm);
    const far = alongAxis(axis, span.toMm);
    for (const jamb of [near, far]) {
      ops.push({
        kind: 'line',
        ownerId: opening.id,
        from: mmToPx(v, advance(jamb, axis.normal, -half)),
        to: mmToPx(v, advance(jamb, axis.normal, half)),
        pen: penFor(opening.id, JAMB_PEN),
      });
    }
    if (opening.category === 'window') {
      ops.push({
        kind: 'line',
        ownerId: opening.id,
        from: mmToPx(v, near),
        to: mmToPx(v, far),
        pen: penFor(opening.id, GLAZING_PEN),
      });
    }
  }

  // ④ annotation：楼层标签写在包围盒左上外侧，永远排最后（它必须盖住墙）。
  const storey = requireStorey(doc, storeyId);
  const box = aabbOfPoints(geo.walls.flatMap((q) => [...q.corners]));
  ops.push({
    kind: 'text',
    ownerId: storeyId,
    at: mmToPx(v, vec(box.minX, box.maxY + LABEL_OFFSET_MM)),
    text: `楼层 ${storey.index} · 标高 ${(storey.elevationMm / 1000).toFixed(3)}`,
    sizePx: LABEL_SIZE_PX,
    pen: penFor(storeyId, LABEL_PEN),
  });

  return ops;
}

/**
 * 该层在当前画布尺寸下的初始视口。放在 scene-2d 是因为它要读派生几何，
 * 而 renderer 一条几何都不许算。空层返回默认视口：打开一个还没画墙的层是正常状态。
 */
export function fitStorey(
  doc: Document,
  storeyId: string,
  widthPx: number,
  heightPx: number,
  padPx: number = 40,
): Viewport {
  const geo = deriveStoreyGeometry(doc, storeyId);
  if (geo.walls.length === 0) return viewportOf(widthPx, heightPx);
  return fitViewport(
    widthPx,
    heightPx,
    aabbOfPoints(geo.walls.flatMap((q) => [...q.corners])),
    padPx,
  );
}
```

`Px` 必须跟 `mmToPx` 一起从 `./viewport` 引 —— `verbatimModuleSyntax` 下漏它是编译错，不是运行时错。文字**不随缩放变**（`sizePx` 是像素常量）：图纸级文字在屏幕上定高，计划 5 排版时再谈随图幅缩放。

`packages/scene-2d/src/index.ts` 追加：

```ts
export * from './drawlist';
export * from './demo';
```

- [ ] **Step 5: 跑测试到全绿 + 八条改坏验证**

Run: `npx vitest run packages/scene-2d/test/drawlist.test.ts > /tmp/t2-green.log 2>&1; echo exit=$?`
Expected: exit=0，`Tests 10 passed`。

逐条改坏，每条做完立刻改回来（样例房一层：墙 8、墙垛 12、洞口 4 樘 = 2 门 2 窗，所以指令表是 8 多边形 + 12 轴线 + 10 洞口线 + 1 标签 = 31 条）：

1. `penFor` 直接 `return base`（忽略 `sel`）→ 「选中必须真的改变输出」必须红在 `redOps.length > 0`。
2. 把 `pts` 改成自己按 `wallAxisById` + `thicknessMm` 现算角点（不查派生）→ 「多边形顶点就是派生角点的 mmToPx」必须红 —— 现算的角点没有斜切，接头处少一截。**这条是"绘制层有没有第二份几何"的唯一哨兵**，别看它只比像素数组。
3. 轴线按墙出（`for (const quad of geo.walls)` 里一条直线拉通），不按 `geo.pieces` → 「轴线段数等于墙垛段数」必须红（8 ≠ 12）。
4. 窗的中线不分类别、门也画 → `dashed` 从 2 变 4 → 「洞口走 opening 层」必须红。
5. 删掉 `buildDrawList` 里的 `if (geo.walls.length === 0) return [];` → 「空层给空表」必须红在 `RangeError`，不是红在断言。
6. 把标签 `ops.push` 挪到 ① 之前 → 「最后一条必须是楼层标签」与层序断言都必须红。
7. `fitStorey` 把 `padPx` 传成 `0` → 「fitStorey 把整层装进画布」的纵向张幅必须红（900 ≠ 780）。
8. `fitStorey` 删掉空层短路 → 「空层给空表」末尾那句必须红在 `RangeError`（打开空层不该把异常抛给 UI）。
9. `axisOf` 的缓存去掉（每次现算）→ **不许红**：它只该让 `wallAxisById` 多跑几次，不改变任何输出。这条是反向哨兵，证明前面几条红不是因为改坏了共享结构而连带崩的。

1–8 里任何一条"改坏了还绿"，说明那条断言写空了，就地补到能红为止；第 9 条反过来，它**必须还绿** —— 红了说明有用例在比不该比的东西。**一条不会红的测试比没有测试更糟。** 把每条命令与关键红字写进提交信息。

- [ ] **Step 6: `pnpm verify` + 提交**

`verify` 里含 `typecheck` —— Task 1 Step 1 把 `@dajia/scene-2d` 加进根 `typecheck` 之后，本任务的 `drawlist.ts` 才第一次真正被类型检查过。**别用 `pnpm --filter @dajia/scene-2d test` 代替 `pnpm verify`**：那条不跑 typecheck，也不跑 `lint:deps`（scene-2d 只准依赖 core+protocol 这条线是守卫查的）。

```bash
pnpm verify > /tmp/t2-verify.log 2>&1; echo exit=$?
git add packages/scene-2d
git commit -m "feat: scene-2d 绘制指令表与样例两层房"
```

---

### Task 3: 真窗口里出像素（回读证明，不靠人眼）

**Files:**
- Modify: `apps/desktop/package.json`（`dependencies` 加 `@dajia/scene-2d`、`zustand`）
- Modify: `apps/desktop/electron.vite.config.ts`（renderer 侧 alias）
- Create: `apps/desktop/src/renderer/src/stores/editorStore.ts`
- Create: `apps/desktop/src/renderer/src/PlanCanvas.tsx`
- Modify: `apps/desktop/src/renderer/src/App.tsx`
- Modify: `apps/desktop/src/main/index.ts`（`--shot <path>`）
- Create: `scripts/desktop-shot.mjs`
- Modify: `package.json`（根：`"shot": "node scripts/desktop-shot.mjs"`）
- **不改** `apps/desktop/src/preload/index.ts`：`__dajiaDebug` 由 renderer 自己挂在 `window` 上。`executeJavaScript` 跑在 main world，React 产物也跑在 main world，两边天然看得见；preload 是 isolated world，把钩子放那儿反而要多一层桥。**这一步没有任何 preload 改动，别顺手去动它。**

**Interfaces:**
- Consumes: T1 `Viewport`；T2 `buildDrawList` / `fitStorey` / `demoHouse` / `DrawOp` / `Pen`
- Produces: `useEditor()`（`{ log, storeyId, viewport, setViewport }`）、`<PlanCanvas/>`、`window.__dajiaDebug(): DebugReport`、`pnpm shot`

- [ ] **Step 1: 接线 —— desktop 吃 scene-2d，并先证明"能打包"**

```bash
pnpm --filter @dajia/desktop add @dajia/scene-2d@workspace:* zustand@^5.0.15
```
（`zustand` 是 spec §技术栈 定的，不是这里临时选的；spec 实测 `zustand@5.0.15`。`ALLOWED_DEPS` 里 desktop → 全部，守卫不会拦。）

`apps/desktop/electron.vite.config.ts` 的 renderer 那一行换成：

```ts
renderer: {
  plugins: [react()],
  resolve: {
    alias: {
      '@dajia/core': src('../../packages/core/src/index.ts'),
      '@dajia/scene-2d': src('../../packages/scene-2d/src/index.ts'),
    },
  },
},
```

**两条都要**：scene-2d 的源码自己 import `'@dajia/core'` 这个裸说明符，只给 scene-2d 配 alias 的话，它内部那条 import 在打包时就解析不到。`src()` 与 `workspaceDeps` 是现有文件里就有的，别重写。

Run: `pnpm --filter @dajia/desktop build > /tmp/t3-build.log 2>&1; echo exit=$?` → Expected: exit=0。

然后证明 scene-2d **真的进了 renderer 产物**（不是运行时 404，也不是被外部化留在裸说明符上）：

```bash
grep -l "标高" apps/desktop/out/renderer/assets/*.js
```
Expected: 打出至少一个文件名。`标高` 这个字面量只存在于 `drawlist.ts`，产物里有它 = scene-2d 被打包进来了。**函数名不能用 grep 验**：renderer 产物是压缩过的，`buildDrawList` 这类标识符会被 mangle，只有字符串常量留得下来。`grep -l` 找不到时退出码是 1，所以这条不会假绿。

- [ ] **Step 2: `stores/editorStore.ts`**

```ts
import { create } from 'zustand';
import type { TransactionLog } from '@dajia/core';
import { demoHouse, type Viewport } from '@dajia/scene-2d';

// demoHouse() 只调一次。调两次拿到的是两份互不相干的文档：屏幕上画的是 B，
// 命中测试查的是 A —— 而且不会有任何报错，只会得到"点了没反应"。
const demo = demoHouse();

export interface EditorState {
  readonly log: TransactionLog;
  readonly storeyId: string;
  /** null = 还没量过窗口尺寸，一帧都还没画 */
  readonly viewport: Viewport | null;
  setViewport: (viewport: Viewport | null) => void;
}

export const useEditor = create<EditorState>((set) => ({
  log: demo.log,
  storeyId: demo.lowerStoreyId,
  viewport: null,
  setViewport: (viewport) => set({ viewport }),
}));
```

选中集**不放这儿**：spec §真源 明确"选中不进真源、不进撤销栈、不落库"，它属于另一份 store（`selectionStore.ts`，Task 4 建）。现在塞进 `EditorState` 就等于把两类状态混回一锅。

- [ ] **Step 3: `PlanCanvas.tsx`**

职责边界写死：这个文件**只**做 `DrawOp → canvas 2D 调用` 的翻译，一行几何计算都不许有（角点、沿轴距、包围盒全在 scene-2d）。原稿说的"三层 canvas 叠放"这轮不做 —— 现在只有一层就够了，多留两层 DOM 是给没人写的代码占位；等 Task 5 真需要"拖拽期临时层不重绘整张图"时再加。

```tsx
import { useEffect, useRef } from 'react';
import { buildDrawList, fitStorey, type DrawOp, type Pen } from '@dajia/scene-2d';
import { useEditor } from './stores/editorStore';

export interface DebugReport {
  ops: number;
  layers: Record<string, number>;
  nonBlankPx: number;
  wPx: number;
  hPx: number;
}

declare global {
  interface Window {
    __dajiaDebug?: () => DebugReport;
  }
}

const DASH: Record<Pen['lineType'], number[]> = {
  solid: [],
  dashed: [6, 4],
  'dash-dot': [12, 4, 2, 4],
};

const BG = '#ffffff';

function paint(ctx: CanvasRenderingContext2D, ops: readonly DrawOp[]): void {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.lineCap = 'round';
  for (const op of ops) {
    ctx.strokeStyle = op.pen.color;
    ctx.lineWidth = op.pen.widthPx;
    ctx.setLineDash(DASH[op.pen.lineType]);
    if (op.kind === 'polygon') {
      ctx.beginPath();
      op.pts.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      if (op.fill !== null) {
        ctx.fillStyle = op.fill;
        ctx.fill();
        ctx.fillStyle = BG;
      }
      ctx.stroke();
    } else if (op.kind === 'line') {
      ctx.beginPath();
      ctx.moveTo(op.from.x, op.from.y);
      ctx.lineTo(op.to.x, op.to.y);
      ctx.stroke();
    } else {
      ctx.setLineDash([]);
      ctx.fillStyle = op.pen.color;
      ctx.font = `${String(op.sizePx)}px system-ui, sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.fillText(op.text, op.at.x, op.at.y);
    }
  }
  ctx.setLineDash([]);
}

export function PlanCanvas(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const log = useEditor((s) => s.log);
  const storeyId = useEditor((s) => s.storeyId);
  const viewport = useEditor((s) => s.viewport);
  const setViewport = useEditor((s) => s.setViewport);

  // 尺寸 → 视口。刻意不用 getBoundingClientRect：没有 CSS 参与，视口尺寸就是窗口
  // 内容区，shot 的期望像素数才不会随布局漂。（拖拽/缩放交互在 T5 才接管这条线。）
  useEffect(() => {
    const fit = (): void => {
      const wPx = Math.max(1, Math.floor(window.innerWidth));
      const hPx = Math.max(1, Math.floor(window.innerHeight));
      const canvas = canvasRef.current;
      if (canvas !== null) {
        canvas.width = wPx;
        canvas.height = hPx;
        canvas.style.width = `${String(wPx)}px`;
        canvas.style.height = `${String(hPx)}px`;
      }
      setViewport(fitStorey(log.document, storeyId, wPx, hPx, 60));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [log, storeyId, setViewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || viewport === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    paint(ctx, buildDrawList(log.document, storeyId, viewport));
  }, [log, storeyId, viewport]);

  // 钩子必须在"这一帧已经刷完"之后存在：effect 顺序 = 声明顺序，paint 在前、这条在后。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || viewport === null) return;
    const previous = window.__dajiaDebug;
    window.__dajiaDebug = (): DebugReport => {
      const ops = buildDrawList(log.document, storeyId, viewport);
      const layers: Record<string, number> = {};
      for (const o of ops) layers[o.pen.layer] = (layers[o.pen.layer] ?? 0) + 1;
      let nonBlankPx = 0;
      const ctx = canvas.getContext('2d');
      if (ctx !== null) {
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        for (let i = 0; i < data.length; i += 4) {
          if (data[i]! < 250 || data[i + 1]! < 250 || data[i + 2]! < 250) nonBlankPx += 1;
        }
      }
      return { ops: ops.length, layers, nonBlankPx, wPx: canvas.width, hPx: canvas.height };
    };
    return () => {
      window.__dajiaDebug = previous;
    };
  }, [log, storeyId, viewport]);

  return <canvas ref={canvasRef} style={{ display: 'block' }} />;
}
```

`App.tsx` 换成：

```tsx
import type { DajiaApi } from '../../preload/index';
import { PlanCanvas } from './PlanCanvas';

declare global {
  interface Window {
    dajia: DajiaApi;
  }
}

export default function App(): React.JSX.Element {
  return <PlanCanvas />;
}
```

**这是一次可见的功能删除，提交信息里必须写清楚**：计划 1 Task 10 的首屏是"主进程应答：pong:1"，现在被平面图顶掉。`IPC.ping` 通道、`DajiaApi` 声明与那条 `declare global` 都留着（M1.3 走主进程读库仍要它），`window.dajia` 的类型增强也还在这个文件里 —— 只删 UI。**"窗口里能看到东西"的验收从人眼换成 Step 4 的像素判据**，不是取消。

- [ ] **Step 4: 主进程 `--shot` 与回读脚本**

`apps/desktop/src/main/index.ts` 整体换成：

```ts
import { app, BrowserWindow, ipcMain } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_SCHEMA_VERSION } from '@dajia/core';
import { IPC } from '@dajia/protocol';

/** 取 `--shot <path>` 的落盘路径；没这个开关就是正常启动。 */
function shotPathFromArgv(): string | null {
  const i = process.argv.indexOf('--shot');
  if (i < 0) return null;
  const p = process.argv[i + 1];
  if (p === undefined || p.startsWith('--')) {
    throw new RangeError('--shot 后面必须跟一个文件路径');
  }
  return p;
}

function createWindow(visible: boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: visible,
    title: '搭家',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  ipcMain.removeHandler(IPC.ping);
  ipcMain.handle(IPC.ping, () => `pong:${CORE_SCHEMA_VERSION}`);

  void win.once('ready-to-show', () => win.show());
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return win;
}

function whenLoaded(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    if (!win.webContents.isLoading()) {
      resolve();
      return;
    }
    win.webContents.once('did-finish-load', () => resolve());
  });
}

/** 条件轮询，不是固定 sleep：窗口慢不会导致误判白屏，等不到就是失败。 */
async function waitForDebug(win: BrowserWindow): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const ready = await win.webContents.executeJavaScript('typeof window.__dajiaDebug === "function"');
    if (ready === true) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('10 秒内 renderer 没挂上 window.__dajiaDebug —— 视图没起来，不是"暂时没测到"');
}

async function runShot(win: BrowserWindow, path: string): Promise<void> {
  await whenLoaded(win);
  await waitForDebug(win);
  const report = await win.webContents.executeJavaScript('window.__dajiaDebug()');
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

void app.whenReady().then(async () => {
  const shotPath = shotPathFromArgv();
  const win = createWindow(shotPath === null);
  if (shotPath === null) {
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(true);
    });
    return;
  }
  let code = 0;
  try {
    await runShot(win, shotPath);
  } catch (err) {
    process.stderr.write(`--shot 失败：${String(err)}\n`);
    code = 1;
  }
  app.exit(code);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

三个要点：`show: false` 下 canvas 照样绘制（`getImageData` 读的是 backing store，不依赖合成器上屏）；`app.exit(code)` 而不是 `app.quit()` —— 后者会被 `window-all-closed`/插件拦下而带着非零意图退出不了；失败必须 exit≠0，否则脚本读不到 JSON 也"绿"。

`scripts/desktop-shot.mjs`：

```js
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Windows 上 pnpm 是 pnpm.cmd：不给 shell:true 会 ENOENT。
const shell = process.platform === 'win32';

function run(cmd, args, timeoutMs) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell, stdio: 'inherit', timeout: timeoutMs });
  if (r.error) throw r.error;
  if (r.signal) throw new Error(`${cmd} 被信号 ${r.signal} 打死（窗口没关？超时 ${String(timeoutMs)}ms）`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} → exit ${String(r.status)}`);
}

const dir = mkdtempSync(join(tmpdir(), 'dajia-shot-'));
const out = join(dir, 'report.json');
try {
  run('pnpm', ['--filter', '@dajia/desktop', 'build']);
  run('pnpm', ['--filter', '@dajia/desktop', 'exec', 'electron', '.', '--shot', out], 180_000);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  const layers = report.layers ?? {};
  // 这四个数与 drawlist.test.ts 同源：改样例房必须两处一起改，别只调这里。
  const checks = [
    ['指令表 31 条（8 轮廓 + 12 轴线 + 10 洞口线 + 1 标签）', report.ops === 31],
    ['structure 层 20 条', layers.structure === 20],
    ['opening 层 10 条', layers.opening === 10],
    ['annotation 层 1 条', layers.annotation === 1],
    ['画布尺寸 = 窗口内容区', report.wPx > 800 && report.hPx > 500],
    ['非背景像素 > 5000（白屏恒为 0）', report.nonBlankPx > 5000],
  ];
  let bad = 0;
  for (const [name, ok] of checks) {
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}\n`);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (bad > 0) throw new Error(`${String(bad)} 项判据没过`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
```

根 `package.json` 加一条：

```json
"shot": "node scripts/desktop-shot.mjs"
```

Run: `pnpm shot > /tmp/t3-shot.log 2>&1; echo exit=$?` → Expected: exit=0，六行 PASS，末行是实测 JSON。

**判据必须能区分"画了"和"白屏"**：把 `paint(ctx, ops)` 那一行的实参临时改成 `[]`，`nonBlankPx` 必须掉到 0 且脚本 exit≠0（`ops === 31` 那行仍 PASS —— 它只证明指令到了 renderer，白屏证明是像素那条，两条各管一头）。改回来再跑一遍，必须六行全 PASS。

- [ ] **Step 5: 不进 `pnpm verify`，但把实测数记进执行日志**

CI 的 ubuntu runner 无 xvfb，`pnpm shot` 留在本地手动跑；本步只把六个实测数字写进本文件的「执行日志」。

**不许**为了让 CI 绿而把断言写成"跑不起来就跳过"（`if (!hasDisplay) return;` 这种），那等于没有这条证明，而且比没有更糟 —— 它会在 CI 里常年显示绿色。**也不许把 `pnpm shot` 加进 `verify`**：那会让每次 CI 红，然后第一件被删掉的事就是这些断言。

- [ ] **Step 6: 全量闸门 + 提交**

```bash
pnpm verify > /tmp/t3-verify.log 2>&1; echo exit=$?
git add apps/desktop scripts/desktop-shot.mjs package.json pnpm-lock.yaml
git commit -m "feat: desktop 平面图与像素回读自检；首屏 ping UI 由平面图接替"
```
Expected: `verify` exit=0（**`pnpm shot` 不在其中**）；`Tests` 数与 Task 2 结尾一致 —— 本任务不新增 vitest 用例，`scripts/desktop-shot.mjs` 在 `scripts/` 而 include 只收 `scripts/test/**`，这是刻意的：它要真起窗口，不该在 `verify` 里跑。

---

### Task 4: 命中与点选（点得中的就是画出来的）

**Files:**
- Create: `packages/scene-2d/src/pick.ts`
- Modify: `packages/scene-2d/src/drawlist.ts`（只加 `DRAW_LAYERS` 一条导出，画法一行都不改）
- Modify: `packages/scene-2d/src/index.ts`（`export * from './pick';`）
- Create: `packages/scene-2d/test/pick.test.ts`
- Create: `apps/desktop/src/renderer/src/stores/selectionStore.ts`
- Modify: `apps/desktop/src/renderer/src/PlanCanvas.tsx`（选中进绘制、`onPointerDown`、`opsRef`、`DebugReport` 三个新字段）
- Modify: `apps/desktop/src/main/index.ts`（新增 `--pick-shot` 的点击序列，`--shot` 那条路径一行不动）
- Modify: `scripts/desktop-shot.mjs`（`--pick` 开关 + 四条新判据）
- Modify: `package.json`（根：`"pick-shot"`）

**先落的四条裁决（末尾边界表里 Task 4 的两条问句在这里判掉，判据写进代码与测试，不许留在纸面）**：

| # | 问题 | 裁决 | 理由与代价 |
|---|---|---|---|
| R1 | `pick` 吃 `DrawOp[]` 的 `ownerId` 还是吃 `SpatialIndex`？ | **吃指令表，本轮根本不碰 `SpatialIndex`** | T2 把 `ownerId` 钉在每一条指令上，为的就是这一座"像素 ↔ 实体"的桥；指令表就是屏幕上那张图，索引只装墙与洞口两类 `IndexedKind`，且它的 AABB 是世界毫米 —— 拿它当靶子就把"看得见的"换成了"落在包围盒里的"，会点中已经被更高层盖住的构件。代价：全扫 O(指令数)，本样例 31 条，一次点击几微秒。**索引什么时候回来**：等出现"点一下要卡"的真证据；届时 `pickAt` 签名不动，只在 `distanceOfOp` 之前加一趟 AABB 预筛（`distanceOfOp` 是本文件里那条"一条指令的命中距离"，见 Step 3）。计划 2 转下游的 #14（`cellSizeMm` 护栏）与 #15（脏集 O(n²)）说的都是索引与重建，与本任务无关，留在 T5/T6。 |
| R2 | 容差在屏幕像素上比，还是换算成毫米比？ | **在屏幕像素上比**（`PICK_TOL_PX = 8`，不做 `pxToMm` 换算） | 边界原话说"保证放大时吸附不变松（spec §6）"，而**换算成毫米正好做不到**：毫米容差固定的是世界尺寸，放大 `k` 倍它在屏幕上就宽 `k` 倍，吸附反而变松。像素容差钉的是屏幕上那 8 个像素 —— 放大时它在世界里自动变紧。定值用例「同一世界点在 0.125 与 0.5 px/mm 下命中/不命中」钉的就是这一条：改成毫米口径它必红。 |
| R3 | 多命中怎么取舍（遮挡）？ | **层序压倒距离 → 同层按距离升序 → 同距离按 `ownerId` 升序**；`kind === 'text'` 与 `ownerId === null` 永不命中 | 指令表的数组顺序就是绘制顺序（T2 口径②），后画的盖住先画的 ⇒ 靠后的层在屏幕上是"看得见的上面那一层"，所以 `annotation > opening > structure` 的层序必须赢过距离，否则点洞口断口线会选中它底下那面墙，屏幕上明明是洞口在压着墙。`text` 排除的理由：楼层标签点进去会把 `storeyId` 塞进选中集，而 T5/T6 的拖拽与删除只认构件 —— 那是"选中了一个不该被选中的东西"，不是"选中了注记"。派生指令（`ownerId === null`）没有可指向的实体，点它无意义。 |
| R4 | 两次点击之间不许有巧合 | **`probeTarget` 只接受"唯一命中"的候选点** | 相邻墙共享斜切顶点，那附近的点到两面墙都是 0 距离 —— 谁赢取决于 `ownerId` 升序，是巧合不是判据。探针要求 `pickAt` 恰好返回 1 条，多命中直接跳过下一条边。空白点同理：从四个画布角里取"离一切指令最远"的那个，且不足容差就整个返回 `null`，于是"点空白清空选中"这一步不存在"其实打中了东西"的侥幸。 |

**Interfaces:**
- Consumes: T2 的 `DrawOp` / `Pen` / `DrawLayer` / `Selection` / `EMPTY_SELECTION` / `buildDrawList` / `fitStorey` / `demoHouse` / `SELECTED`；T1 的 `Px` / `Viewport` / `viewportOf` / `mmToPx`；`@dajia/core` 的 `vec`
- Produces:
  ```ts
  export const PICK_TOL_PX = 8;
  export interface PickHit {
    readonly ownerId: string;
    readonly layer: DrawLayer;
    readonly distancePx: number;
  }
  export interface PickProbe {
    readonly ownerId: string;
    readonly clickPx: Px;
    readonly blankPx: Px;
  }
  export function distanceToSegmentPx(p: Px, from: Px, to: Px): number;
  export function pickAt(ops: readonly DrawOp[], point: Px, tolPx?: number): PickHit[];
  export function pickOne(ops: readonly DrawOp[], point: Px, tolPx?: number): PickHit | null;
  export function probeTarget(ops: readonly DrawOp[], v: Viewport): PickProbe | null;
  ```
  以及 `drawlist.ts` 新增的 `export const DRAW_LAYERS: readonly DrawLayer[];`（层序的唯一真源，`pick.ts` 的排序建立在它上面）。T5 拿 `pickOne` 的返回值当拖拽靶子，拿 `selectionStore` 的 `toggle` 当多选。

> **命中为什么能在 node 里测完**：`pickAt` 吃的是 `DrawOp[]` + 一个 `Px`，两者都是普通对象，不需要 canvas、不需要 DOM、不需要真窗口 —— 这正是 T2 把几何留在 scene-2d 的回报。desktop 侧只剩两件事要证明：指针坐标进得了 `pickAt`（Step 5 的 `--pick-shot`），以及选中**真的改变像素**（`selectedPx`）。
>
> **`drawlist.test.ts` 里那个本地 `layerRank` 不改**：它是 T2 的私事，T2 的改坏验证（第 6 条）钉的是"标签排最后"，与 `DRAW_LAYERS` 导不导出无关。改它就要把 T2 的九条改坏重跑一遍，那不是本任务的收益。

- [ ] **Step 1: 写失败测试 `pick.test.ts`**

`packages/scene-2d/test/pick.test.ts`（15 条 `it`，其中 2 条属性）：

```ts
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { vec } from '@dajia/core';
import {
  PICK_TOL_PX,
  buildDrawList,
  demoHouse,
  distanceToSegmentPx,
  EMPTY_SELECTION,
  fitStorey,
  mmToPx,
  pickAt,
  pickOne,
  probeTarget,
  viewportOf,
  type DrawOp,
  type Pen,
  type PickHit,
  type Px,
  type Viewport,
} from '@dajia/scene-2d';

const PEN_S: Pen = { layer: 'structure', lineType: 'solid', widthPx: 2, color: '#1f1f1f' };
const PEN_O: Pen = { layer: 'opening', lineType: 'solid', widthPx: 1.5, color: '#1f1f1f' };

const seg = (ownerId: string | null, pen: Pen, from: Px, to: Px): DrawOp => ({
  kind: 'line',
  ownerId,
  from,
  to,
  pen,
});
const face = (ownerId: string, pen: Pen, pts: Px[], fill: string | null = null): DrawOp => ({
  kind: 'polygon',
  ownerId,
  pts,
  fill,
  pen,
});
const label = (ownerId: string | null, at: Px): DrawOp => ({
  kind: 'text',
  ownerId,
  at,
  text: '楼层 0 · 标高 0.000',
  sizePx: 14,
  pen: { layer: 'annotation', lineType: 'solid', widthPx: 1, color: '#1f1f1f' },
});

const owners = (hits: PickHit[]): string[] => hits.map((h) => h.ownerId);

/** 一条指令的"第一条可点边"的中点：polygon 取 pts[0]→pts[1]，line 取整段，text 取锚点。 */
function firstEdgeMid(op: DrawOp): Px {
  if (op.kind === 'polygon') {
    const a = op.pts[0]!;
    const b = op.pts[1]!;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  if (op.kind === 'line') return { x: (op.from.x + op.to.x) / 2, y: (op.from.y + op.to.y) / 2 };
  return op.at;
}

const square = (ownerId: string, pen: Pen, size: number, fill: string | null): DrawOp =>
  face(
    ownerId,
    pen,
    [
      { x: 0, y: 0 },
      { x: size, y: 0 },
      { x: size, y: size },
      { x: 0, y: size },
    ],
    fill,
  );

// 与 T2/T3 同源的样例房：视口用 fitStorey（1200×900、pad 60 → 0.125 px/mm），
// 下面所有"点得中/点不中"的像素算式都以这个缩放为准。
const house = demoHouse();
const view = fitStorey(house.doc, house.lowerStoreyId, 1200, 900, 60);
const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);

describe('命中测试 —— 合成指令（判据的每一侧都手动摆过）', () => {
  it('容差边界含等于：屏幕上正好 8px 命中，再多 0.01px 不命中', () => {
    const ops = [seg('w', PEN_S, { x: 0, y: 0 }, { x: 100, y: 0 })];
    // 用常量而不是字面量 8：这条钉的是**边界含等于**，不是"8 这个数"
    expect(owners(pickAt(ops, { x: 50, y: PICK_TOL_PX }))).toEqual(['w']);
    expect(pickAt(ops, { x: 50, y: PICK_TOL_PX + 0.01 })).toEqual([]);
  });

  it('零长段退化到点距：不许 NaN 混进比较', () => {
    const ops = [seg('dot', PEN_S, { x: 10, y: 10 }, { x: 10, y: 10 })];
    expect(distanceToSegmentPx({ x: 10, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 10 })).toBe(0);
    const hits = pickAt(ops, { x: 10, y: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.distancePx).toBe(0);
    // 点到 9px 外：9 > 8，必须判不中。NaN 走这条会静默命中（NaN > tol 是 false）
    expect(pickAt(ops, { x: 19, y: 10 })).toEqual([]);
  });

  it('多边形按闭合环判：回边（最后一点 → 第一点）也点得中', () => {
    const ops = [square('w', PEN_S, 100, null)];
    // (-3, 50) 只挨着 pts[3]→pts[0] 那条回边；不取模就只剩三条边，这个点的最近距离是 50.09
    expect(owners(pickAt(ops, { x: -3, y: 50 }))).toEqual(['w']);
  });

  it('fill 为 null 的内部是白的 —— 点进去不算命中；fill 非 null 时内部算，且距离 0', () => {
    const tol = 4;
    const hollow = [square('hollow', PEN_S, 10, null)];
    const filled = [square('filled', PEN_S, 10, '#dddddd')];
    // 中心 (5,5) 到边是 5px：tol=4 时 hollow 必须空（内部没画东西），filled 必须命中且 0
    expect(pickAt(hollow, { x: 5, y: 5 }, tol)).toEqual([]);
    const hits = pickAt(filled, { x: 5, y: 5 }, tol);
    expect(owners(hits)).toEqual(['filled']);
    expect(hits[0]!.distancePx).toBe(0);
  });

  it('层序压倒距离：更远的洞口线赢过更近的墙轮廓', () => {
    const ops = [
      face('wall', PEN_S, [
        { x: 0, y: 5 },
        { x: 100, y: 5 },
        { x: 100, y: 105 },
        { x: 0, y: 105 },
      ]),
      seg('win', PEN_O, { x: 0, y: 9 }, { x: 100, y: 9 }),
    ];
    const hits = pickAt(ops, { x: 50, y: 0 }, 20);
    expect(hits.map((h) => h.layer)).toEqual(['opening', 'structure']);
    expect(hits.map((h) => h.distancePx)).toEqual([9, 5]);
    expect(pickOne(ops, { x: 50, y: 0 }, 20)!.ownerId).toBe('win');
  });

  it('同层按距离升序，同距离按 ownerId 升序', () => {
    const ops = [
      seg('far', PEN_S, { x: 0, y: 6 }, { x: 100, y: 6 }),
      seg('bbb', PEN_S, { x: 0, y: -2 }, { x: 100, y: -2 }),
      seg('aaa', PEN_S, { x: 0, y: 2 }, { x: 100, y: 2 }),
    ];
    expect(owners(pickAt(ops, { x: 50, y: 0 }))).toEqual(['aaa', 'bbb', 'far']);
  });

  it('同一 owner 的多条指令去重成一条，留最近的那条', () => {
    const ops = [
      face('w', PEN_S, [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 40 },
        { x: 0, y: 40 },
      ]),
      seg('w', PEN_S, { x: 0, y: 2 }, { x: 100, y: 2 }),
    ];
    const hits = pickAt(ops, { x: 50, y: 6 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.distancePx).toBe(4);
  });

  it('text 永不命中；ownerId 为 null 的指令永不命中', () => {
    const ops = [
      label('storey-1', { x: 50, y: 0 }),
      label(null, { x: 50, y: 0 }),
      seg(null, PEN_S, { x: 0, y: 0 }, { x: 100, y: 0 }),
    ];
    expect(pickAt(ops, { x: 50, y: 0 })).toEqual([]);
  });

  it('NaN 点击点返回空表，不许静默命中', () => {
    const ops = [seg('w', PEN_S, { x: 0, y: 0 }, { x: 100, y: 0 })];
    expect(pickAt(ops, { x: NaN, y: 0 })).toEqual([]);
    expect(pickAt(ops, { x: 50, y: NaN })).toEqual([]);
    expect(pickOne(ops, { x: NaN, y: NaN })).toBeNull();
  });

  it('probeTarget 只接受唯一命中的候选点：被洞口线压住的那条边必须跳过', () => {
    const v = viewportOf(1200, 900, { pxPerMm: 1, center: vec(0, 0) });
    const ops = [
      face('wall', PEN_S, [
        { x: 0, y: 0 },
        { x: 400, y: 0 },
        { x: 400, y: 40 },
        { x: 0, y: 40 },
      ]),
      // 断口线正好穿过上边 (200, 0)：那条边的中点上"谁在上面"说不清（opening 层还压着 structure）
      seg('win', PEN_O, { x: 200, y: -20 }, { x: 200, y: 20 }),
    ];
    const probe = probeTarget(ops, v);
    expect(probe).not.toBeNull();
    if (probe === null) return; // 上一条已断言非空，这里只为类型收窄
    // 跳过 (200,0) 之后，下一条够长的边是下边，中点 (200,40) 只挨着墙。
    // 钉死坐标才是真正的牙齿：不筛唯一命中就会拿到 (200, 0)。
    expect(probe.clickPx).toEqual({ x: 200, y: 40 });
    expect(owners(pickAt(ops, probe.clickPx))).toEqual(['wall']);
    expect(pickAt(ops, probe.blankPx)).toEqual([]);
  });

  it('probeTarget：clickPx 唯一命中自己，blankPx 一个都不命中', () => {
    const probe = probeTarget(ops, view);
    expect(probe).not.toBeNull();
    if (probe === null) return; // 上一条已经断言过非空，这里只为类型收窄；走到这儿就是测试失败
    expect(owners(pickAt(ops, probe.clickPx))).toEqual([probe.ownerId]);
    expect(house.doc.get(probe.ownerId)?.kind).toBe('wall');
    expect(pickAt(ops, probe.blankPx)).toEqual([]);
  });
});

describe('命中测试 —— 样例两层房', () => {
  it('每条指令的每条边中点都点得中自己', () => {
    let checked = 0;
    for (const op of ops) {
      if (op.kind === 'text') continue;
      const ownerId = op.ownerId;
      if (ownerId === null) continue;
      // 边表显式列出来：多边形是闭合环（回边算一条），线段只有一条。
      // 把 `[from, to]` 塞进同一个取模循环会数出两条（from→to 与 to→from 中点相同），
      // 于是下面的 54 会红在 76 —— 而这个数字正是"少一条边就红"的那颗牙。
      const edges: Array<[Px, Px]> = [];
      if (op.kind === 'polygon') {
        const ring = op.pts;
        for (let i = 0; i < ring.length; i++) {
          edges.push([ring[i]!, ring[(i + 1) % ring.length]!]);
        }
      } else {
        edges.push([op.from, op.to]);
      }
      for (const [a, b] of edges) {
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        expect(owners(pickAt(ops, mid, PICK_TOL_PX))).toContain(ownerId);
        checked += 1;
      }
    }
    // 空循环等于没测：8 轮廓 × 4 边 + 12 轴线 + 10 洞口线 = 54 条边
    expect(checked).toBe(54);
  });

  it('放大时吸附在屏幕上不变松、在世界里变紧（像素口径的唯一证明）', () => {
    const fine = viewportOf(1200, 900, { pxPerMm: 0.125, center: vec(4000, 3000) });
    const zoom = viewportOf(1200, 900, { pxPerMm: 0.5, center: vec(4000, 3000) });
    const opsFine = buildDrawList(house.doc, house.lowerStoreyId, fine, EMPTY_SELECTION);
    const opsZoom = buildDrawList(house.doc, house.lowerStoreyId, zoom, EMPTY_SELECTION);
    // southWest 墙厚 240 → 下表面在 y = -120mm；x=2000 处没有接头，那条边是完整的
    const onFace = vec(2000, -120);
    const below5px = (v: Viewport): Px => ({ x: mmToPx(v, onFace).x, y: mmToPx(v, onFace).y + 5 });
    // 屏幕偏移同为 5px：两个缩放都命中 —— 吸附在屏幕上一样紧
    expect(pickOne(opsFine, below5px(fine))).not.toBeNull();
    expect(pickOne(opsZoom, below5px(zoom))).not.toBeNull();
    // 而同一**世界**点（下表面往下 40mm）：0.125 下是 5px（命中），0.5 下是 20px（不命中）。
    // 毫米口径会给相反的答案，这三行就是像素口径的钉子。
    expect(pickOne(opsFine, mmToPx(fine, vec(2000, -160)))).not.toBeNull();
    expect(pickOne(opsZoom, mmToPx(zoom, vec(2000, -160)))).toBeNull();
  });

  it('属性：容差越大，命中集只增不减', () => {
    const near = ops.filter((o) => o.kind !== 'text' && o.ownerId !== null);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: near.length - 1 }),
        fc.double({ min: -3, max: 3, noNaN: true }),
        fc.double({ min: -3, max: 3, noNaN: true }),
        (rawIndex, dx, dy) => {
          const op = near[rawIndex % near.length]!;
          const mid = firstEdgeMid(op);
          const p = { x: mid.x + dx, y: mid.y + dy };
          const small = new Set(owners(pickAt(ops, p, 4)));
          const big = new Set(owners(pickAt(ops, p, 16)));
          // 容差 4 时至少点得中自己那条边（jitter ≤ 4.25px），空集就是这条属性在自欺
          expect(small.size).toBeGreaterThanOrEqual(1);
          for (const id of small) expect(big.has(id)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('属性：排序契约对任意点击成立，且结果与指令数组的顺序无关', () => {
    const near = ops.filter((o) => o.kind !== 'text' && o.ownerId !== null);
    const mid = firstEdgeMid(near[0]!);
    const p = { x: mid.x + 1, y: mid.y + 2 };
    const reference = pickAt(ops, p);
    expect(reference.length).toBeGreaterThanOrEqual(1);
    fc.assert(
      fc.property(
        fc.shuffledSubarray(ops, { minLength: ops.length, maxLength: ops.length }),
        (shuffled) => {
          expect(pickAt(shuffled, p)).toEqual(reference);
        },
      ),
      { numRuns: 100 },
    );
    for (const hits of [reference, pickAt(ops, { x: mid.x, y: mid.y })]) {
      for (let i = 1; i < hits.length; i++) {
        const a = hits[i - 1]!;
        const b = hits[i]!;
        const rank = (h: PickHit) => ['structure', 'opening', 'annotation'].indexOf(h.layer);
        expect(rank(b)).toBeLessThanOrEqual(rank(a));
        if (rank(b) === rank(a)) expect(b.distancePx).toBeGreaterThanOrEqual(a.distancePx);
        expect(a.ownerId).not.toBe(b.ownerId);
      }
    }
  });
});
```

> **「每条指令的每条边中点都点得中自己」为什么必须钉死 `checked === 54`**：这条是"看得见 = 点得中"的正面证据，一旦 `buildDrawList` 少出一条边、或 `filter` 把某类指令误排掉，循环照样跑完、照样全绿。54 = 8 轮廓 × 4 边 + 12 轴线 + 10 洞口线，与 T3 的 `ops === 31` 同源；改样例房必须三处一起改。

- [ ] **Step 2: 跑到红**

Run: `npx vitest run packages/scene-2d/test/pick.test.ts > /tmp/t4-red.log 2>&1; echo exit=$?`
Expected: exit≠0，红在解析/导出缺失（`does not provide an export named 'pickAt'`）。**不许**出现"`probeTarget` 那条绿了"—— 导出不存在时任何断言都拿不到函数。

- [ ] **Step 3: 写 `pick.ts`（并给 `drawlist.ts` 加 `DRAW_LAYERS`）**

`packages/scene-2d/src/drawlist.ts` 在 `export type DrawLayer = ...` 之后加：

```ts
/**
 * 绘制顺序 = 指令数组的顺序 = 层序。数组下标越大越靠上（后画的盖住先画的），
 * 命中测试的取舍按它排（见 pick.ts 的 R3）—— 所以它是层序的唯一真源，
 * 不是给人看的注释：加一层必须同时改 buildDrawList 的产出顺序，否则层序压倒距离就是空话。
 */
export const DRAW_LAYERS: readonly DrawLayer[] = ['structure', 'opening', 'annotation'];
```

`packages/scene-2d/src/pick.ts`：

```ts
import { DRAW_LAYERS, type DrawLayer, type DrawOp } from './drawlist';
import type { Px, Viewport } from './viewport';

/**
 * 吸附半径，单位是**屏幕像素**。换算成毫米比较就做不到"放大时吸附不变松"：
 * 毫米容差钉的是世界尺寸，放大 k 倍它在屏幕上就宽 k 倍。
 */
export const PICK_TOL_PX = 8;

export interface PickHit {
  readonly ownerId: string;
  readonly layer: DrawLayer;
  readonly distancePx: number;
}

/** 给一次性回读用的靶子：一个必定命中 `ownerId` 的点，和一个必定什么都不命中的点。 */
export interface PickProbe {
  readonly ownerId: string;
  readonly clickPx: Px;
  readonly blankPx: Px;
}

function dist(a: Px, b: Px): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 点到线段。零长段必须退化到点距：不写这一句，`t` 的分母是 0 ⇒ `NaN`，
 * 而 `NaN <= tol` 是 false —— 一个退化的控制点会既"点不中"又把 NaN 带进排序。
 */
export function distanceToSegmentPx(p: Px, from: Px, to: Px): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, from);
  const t = ((p.x - from.x) * dx + (p.y - from.y) * dy) / len2;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return dist(p, { x: from.x + dx * clamped, y: from.y + dy * clamped });
}

/** 奇偶射线法。只在 `fill !== null` 时用到 —— 本计划的墙轮廓 fill 恒为 null，用不到它。 */
function insidePolygon(p: Px, pts: readonly Px[]): boolean {
  let odd = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > p.y !== b.y > p.y) {
      const xAt = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (p.x < xAt) odd = !odd;
    }
  }
  return odd;
}

/** 命中距离。null = 这条指令根本不可点。 */
function distanceOfOp(op: DrawOp, p: Px): number | null {
  switch (op.kind) {
    case 'text':
      // 注记不是构件：点它会往选中集塞一个 storeyId，而 T5/T6 的拖拽与删除只认构件。
      return null;
    case 'line':
      return distanceToSegmentPx(p, op.from, op.to);
    case 'polygon': {
      const n = op.pts.length;
      // 少于 2 点连一条边都凑不出来，屏幕上根本没有可见轮廓。
      // 本计划没有这种输入（轮廓一律四点），所以它不红任何用例 —— 是防御，不是判据。
      if (n < 2) return null;
      let d = Infinity;
      for (let i = 0; i < n; i++) {
        const a = op.pts[i]!;
        const b = op.pts[(i + 1) % n]!; // 取模：多边形是闭合环，回边也画了线
        d = Math.min(d, distanceToSegmentPx(p, a, b));
      }
      // fill 非 null ⇒ 内部真的涂了像素，点在里面就该命中（距离记 0：它比任何边都"更在这条指令上"）。
      if (op.fill !== null && insidePolygon(p, op.pts)) return 0;
      return d;
    }
  }
}

function rankOf(layer: DrawLayer): number {
  const i = DRAW_LAYERS.indexOf(layer);
  if (i < 0) throw new RangeError(`未知绘制层 ${layer}`);
  return i;
}

/** 层序先赢，同层近的赢。 */
function better(a: PickHit, b: PickHit): boolean {
  const ra = rankOf(a.layer);
  const rb = rankOf(b.layer);
  if (ra !== rb) return ra > rb;
  return a.distancePx < b.distancePx;
}

/**
 * 将 `point` 命中（≤ `tolPx`）的实体，按 R3 的口径排好序，**每个 owner 只出一条**。
 * 同一个 owner 常常有几条指令同时命中（墙轮廓 + 它的轴线 + 它的洞口断口），
 * 那是同一个实体，不是几个候选。
 */
export function pickAt(ops: readonly DrawOp[], point: Px, tolPx: number = PICK_TOL_PX): PickHit[] {
  // 入口守卫：NaN 与 tolPx 的一切比较都是 false，`d > tolPx` 兜不住它 —— 少了这三行，
  // NaN 点击点会命中"距离为 NaN"的第一条指令。
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return [];
  const byOwner = new Map<string, PickHit>();
  for (const op of ops) {
    const ownerId = op.ownerId;
    if (ownerId === null) continue;
    const d = distanceOfOp(op, point);
    if (d === null || d > tolPx) continue;
    const hit: PickHit = { ownerId, layer: op.pen.layer, distancePx: d };
    const current = byOwner.get(ownerId);
    if (current === undefined || better(hit, current)) byOwner.set(ownerId, hit);
  }
  // ownerId 升序收尾是必需的：去重后 owner 互不相同 ⇒ 它把排序变成全序，
  // 于是洗牌不改变结果（见那条属性）。少了它，`Array.sort` 的稳定性会让绘制顺序掺进答案。
  return [...byOwner.values()].sort((a, b) => {
    if (rankOf(a.layer) !== rankOf(b.layer)) return rankOf(b.layer) - rankOf(a.layer);
    if (a.distancePx !== b.distancePx) return a.distancePx - b.distancePx;
    return a.ownerId < b.ownerId ? -1 : a.ownerId > b.ownerId ? 1 : 0;
  });
}

/** 单击语义的入口：层序 + 距离选出的那一个，什么都没命中就是 null。 */
export function pickOne(ops: readonly DrawOp[], point: Px, tolPx: number = PICK_TOL_PX): PickHit | null {
  return pickAt(ops, point, tolPx)[0] ?? null;
}

function minDistanceToOps(ops: readonly DrawOp[], p: Px): number {
  let d = Infinity;
  for (const op of ops) {
    const dd = distanceOfOp(op, p);
    if (dd !== null && dd < d) d = dd;
  }
  return d;
}

function blankPoint(ops: readonly DrawOp[], v: Viewport): Px | null {
  const inset = PICK_TOL_PX + 2;
  const corners: Px[] = [
    { x: inset, y: inset },
    { x: v.widthPx - inset, y: inset },
    { x: inset, y: v.heightPx - inset },
    { x: v.widthPx - inset, y: v.heightPx - inset },
  ];
  let best: Px | null = null;
  let bestD = -Infinity;
  for (const c of corners) {
    const d = minDistanceToOps(ops, c);
    // 严格 >：四角同分时保留先出现的（左下角），洗牌与浮点都不改变结果
    if (d > bestD) {
      bestD = d;
      best = c;
    }
  }
  if (best === null || bestD <= PICK_TOL_PX) return null;
  return best;
}

/**
 * 一次性回读用的靶子。两条规则都是为了让"点了没反应"这种失败藏不住：
 * ① 只接受 `pickAt` 恰好返回 1 条的候选点 —— 相邻墙共享斜切顶点，那附近的"选中谁"
 *    是 ownerId 升序给的巧合，不是判据；
 * ② 空白点从四角里挑离一切指令最远的，且必须比容差更远，否则整个返回 null
 *    （"点空白清空选中"这一步不许其实打中了东西）。
 * 图铺满画布时没有空白角 ⇒ null，调用方（`__dajiaDebug` 与 `--pick-shot`）把它当失败处理。
 */
export function probeTarget(ops: readonly DrawOp[], v: Viewport): PickProbe | null {
  const blank = blankPoint(ops, v);
  if (blank === null) return null;
  // 边长下限：太短的边中点四周挤着一堆相邻指令，唯一命中几乎不可能成立
  const minEdgePx = PICK_TOL_PX * 8;
  for (const op of ops) {
    if (op.kind !== 'polygon' || op.ownerId === null) continue;
    const n = op.pts.length;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const a = op.pts[i]!;
      const b = op.pts[(i + 1) % n]!;
      if (dist(a, b) < minEdgePx) continue;
      const mid: Px = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const hits = pickAt(ops, mid);
      // 多命中 = 这个点上"谁在上面"说不清，换下一条边，不猜。
      // hits.length === 1 时那条必然是本条指令自己（中点在它上面，距离 0），
      // 所以这里不再重复断言 ownerId —— 写了也没人能走到另一支，测试里由 probe 那条钉。
      if (hits.length !== 1) continue;
      return { ownerId: op.ownerId, clickPx: mid, blankPx: blank };
    }
  }
  return null;
}
```

`packages/scene-2d/src/index.ts` 追加一行：

```ts
export * from './pick';
```

- [ ] **Step 4: 跑到全绿**

Run: `npx vitest run packages/scene-2d/test/pick.test.ts > /tmp/t4-green.log 2>&1; echo exit=$?`
Expected: exit=0，**`Tests 15 passed`**（`Test Files 1 passed`；Step 1 的 `it` 共 15 条，2 条属性在其中）。数对不上就是有用例被跳过或被合并，别改期望值，先查日志。

若「probeTarget」红在 `expect(probe).not.toBeNull()`，先查是"四角不够空"还是"没有一条边的中点唯一命中"：在测试里临时打一行 `console.log(view.pxPerMm, blankPoint 距离)`（跑完删掉），**不许**把 `PICK_TOL_PX` 改小、也不许把 R4 的唯一命中放宽来迁就实现 —— 那两条都是判据，不是参数。判据与样例真的冲突时停下来报告。

- [ ] **Step 5: 改坏验证（10 条）**

逐条做，每条做完立刻改回来：

1. `distanceToSegmentPx` 删掉 `len2 === 0` 短路 → 「零长段」必须红（`NaN` 距离既过不了 `toBe(0)`，也让 `9px` 那条静默命中）。
2. 多边形的边改成 `op.pts[i + 1]` 不取模 → 「回边也点得中」必须红。
3. 删掉 `if (op.fill !== null && insidePolygon(...))` → 「fill 非 null 时内部算命中」必须红。**反向哨兵另在下方**。
4. `pickAt` 的 `d > tolPx` 改成 `d >= tolPx` → 「容差边界含等于」必须红（正好 8px 变成不命中）。
5. `sort` 里去掉层序那一行，只按距离 → 「层序压倒距离」必须红（`['structure','opening']`）。
6. `sort` 的层序方向反了（`rankOf(a) - rankOf(b)`）→ 同一条必须红。
7. `better` 去掉距离比较，只比层序（同层保留先来的那条）→ 「去重留最近的」必须红（4 变 6）。
8. 删掉 `pickAt` 入口的 `Number.isFinite` 守卫 → 「NaN 点击点返回空表」必须红（NaN 会命中第一条指令）。
9. `sort` 去掉 `ownerId` 那一路 → 「洗牌不改变结果」的属性必须红（同层同距离时稳定排序跟着数组顺序走）；`owners` 那条同距离定值同样会红。
10. `probeTarget` 的 `hits.length !== 1` 改成 `hits.length < 1` → 「probeTarget 只接受唯一命中的候选点」必须红在 `expect(probe.clickPx).toEqual({ x: 200, y: 40 })`（放宽筛选后探针拿到的是被洞口线压住的 (200, 0)）。样例房那条 `probeTarget` 用例**不会**红 —— 它的第一个候选边本来就唯一，所以 R4 的牙齿全靠这条合成用例。别把它当装饰删。

反向哨兵两条，**必须还绿**：

- 删掉 `distanceOfOp` 里 `if (n < 2) return null;` —— 本计划没有少于 2 点的多边形，它是防御不是判据。红了说明有用例在依赖不该依赖的东西。
- `minDistanceToOps` 改成只比顶点不比线段（把 `distanceOfOp` 换成 `dist` 到各 `pts`）—— 样例房四角离任何顶点都比离线段远，空白点仍是空白。红了说明 `blankPoint` 的判据被写进了不该写的位置。

1–10 里任何一条"改坏了还绿"，说明那条断言写空了，就地补到能红为止。**一条不会红的测试比没有测试更糟。** 把每条命令与关键红字写进提交信息。

- [ ] **Step 6: desktop 接线 —— 选中进绘制、指针进命中**

`apps/desktop/src/renderer/src/stores/selectionStore.ts`：

```ts
import { create } from 'zustand';

export interface SelectionState {
  readonly ids: ReadonlySet<string>;
  select: (id: string) => void;
  toggle: (id: string) => void;
  clear: () => void;
}

/**
 * 选中集独立于 editorStore：spec 明令它不进真源、不进撤销栈、不落库（关窗口就该忘掉，
 * 撤销一次拖拽不该顺手改回选中）。这里每次返回**新的 Set** —— 原地 add/delete 让
 * zustand 的 `Object.is` 判定相等、订阅者不重渲，屏幕就不跟着红，那是"点了没反应"里最难查的一种。
 * 重复点同一个构件、清空已经空的集，都原样返回 state：不为了"看着安全"多刷一帧。
 */
export const useSelection = create<SelectionState>((set) => ({
  ids: new Set<string>(),
  select: (id) => set((s) => (s.ids.size === 1 && s.ids.has(id) ? s : { ids: new Set([id]) })),
  toggle: (id) =>
    set((s) => {
      const next = new Set(s.ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ids: next };
    }),
  clear: () => set((s) => (s.ids.size === 0 ? s : { ids: new Set<string>() })),
}));
```

这个文件**没有 node 测试可写**：`vitest.config.ts` 的 include 只有 `packages/*/test/**`，`apps/` 不在里头，而且没有 jsdom。这不是漏测 —— 判据（命中、排序、去重）全在 `pick.ts`，store 只是状态的容器；它的正确性由 Step 7 的 `--pick-shot` 在真窗口里钉。这条口径与全局约束「renderer 一行几何都不许算」是同一件事的两面。

`apps/desktop/src/renderer/src/PlanCanvas.tsx` 整体换成：

```tsx
import { useEffect, useRef } from 'react';
import {
  SELECTED,
  buildDrawList,
  fitStorey,
  pickOne,
  probeTarget,
  type DrawOp,
  type Pen,
  type PickProbe,
} from '@dajia/scene-2d';
import { useEditor } from './stores/editorStore';
import { useSelection } from './stores/selectionStore';

export interface DebugReport {
  ops: number;
  layers: Record<string, number>;
  nonBlankPx: number;
  wPx: number;
  hPx: number;
  selectedIds: string[];
  selectedPx: number;
  pick: PickProbe | null;
  selectedAfterBlank: number;
}

declare global {
  interface Window {
    __dajiaDebug?: () => DebugReport;
  }
}

const DASH: Record<Pen['lineType'], number[]> = {
  solid: [],
  dashed: [6, 4],
  'dash-dot': [12, 4, 2, 4],
};

const BG = '#ffffff';
const CHANNEL_TOL = 40;

/** 选中色从 scene-2d 的常量解析，不在这里重抄一遍 hex —— 改了常量这里跟着变，判据不漂。 */
function rgbOf(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

const [SEL_R, SEL_G, SEL_B] = rgbOf(SELECTED);

function paint(ctx: CanvasRenderingContext2D, ops: readonly DrawOp[]): void {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.lineCap = 'round';
  for (const op of ops) {
    ctx.strokeStyle = op.pen.color;
    ctx.lineWidth = op.pen.widthPx;
    ctx.setLineDash(DASH[op.pen.lineType]);
    if (op.kind === 'polygon') {
      ctx.beginPath();
      op.pts.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      if (op.fill !== null) {
        ctx.fillStyle = op.fill;
        ctx.fill();
        ctx.fillStyle = BG;
      }
      ctx.stroke();
    } else if (op.kind === 'line') {
      ctx.beginPath();
      ctx.moveTo(op.from.x, op.from.y);
      ctx.lineTo(op.to.x, op.to.y);
      ctx.stroke();
    } else {
      ctx.setLineDash([]);
      ctx.fillStyle = op.pen.color;
      ctx.font = `${String(op.sizePx)}px system-ui, sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.fillText(op.text, op.at.x, op.at.y);
    }
  }
  ctx.setLineDash([]);
}

/** 抗锯齿让选中线边缘是渐变而不是纯色，所以按通道 ±40 数，不比 RGB 全等。 */
function countPixels(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
): { nonBlankPx: number; selectedPx: number } {
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let nonBlankPx = 0;
  let selectedPx = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    if (r < 250 || g < 250 || b < 250) nonBlankPx += 1;
    if (
      Math.abs(r - SEL_R) <= CHANNEL_TOL &&
      Math.abs(g - SEL_G) <= CHANNEL_TOL &&
      Math.abs(b - SEL_B) <= CHANNEL_TOL
    ) {
      selectedPx += 1;
    }
  }
  return { nonBlankPx, selectedPx };
}

export function PlanCanvas(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 指针事件的靶子必须是**刷上屏的那一份**指令表，不是现算的副本：副本与屏幕一旦漂开，
  // "点得中的就是画出来的"这条就只剩注释还在守着。
  const opsRef = useRef<readonly DrawOp[]>([]);
  const log = useEditor((s) => s.log);
  const storeyId = useEditor((s) => s.storeyId);
  const viewport = useEditor((s) => s.viewport);
  const setViewport = useEditor((s) => s.setViewport);
  const ids = useSelection((s) => s.ids);
  const select = useSelection((s) => s.select);
  const toggle = useSelection((s) => s.toggle);
  const clear = useSelection((s) => s.clear);

  // 尺寸 → 视口。刻意不用 getBoundingClientRect：没有 CSS 参与，视口尺寸就是窗口
  // 内容区，shot 的期望像素数才不会随布局漂。（拖拽/缩放交互在 T5 才接管这条线。）
  useEffect(() => {
    const fit = (): void => {
      const wPx = Math.max(1, Math.floor(window.innerWidth));
      const hPx = Math.max(1, Math.floor(window.innerHeight));
      const canvas = canvasRef.current;
      if (canvas !== null) {
        canvas.width = wPx;
        canvas.height = hPx;
        canvas.style.width = `${String(wPx)}px`;
        canvas.style.height = `${String(hPx)}px`;
      }
      setViewport(fitStorey(log.document, storeyId, wPx, hPx, 60));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [log, storeyId, setViewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || viewport === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const ops = buildDrawList(log.document, storeyId, viewport, { ids });
    opsRef.current = ops;
    paint(ctx, ops);
  }, [log, storeyId, viewport, ids]);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    // offsetX/offsetY 就是画布像素：canvas.width === style.width（上面那两行），
    // 没有 CSS 缩放掺进来，所以屏幕坐标与 DrawOp 的坐标同一单位。
    // DPR≠1 时图会糊，但点不偏 —— sendInputEvent 的 x/y 是 DIP，等于这里的 CSS 像素。
    const hit = pickOne(opsRef.current, {
      x: event.nativeEvent.offsetX,
      y: event.nativeEvent.offsetY,
    });
    if (hit === null) {
      clear();
      return;
    }
    if (event.shiftKey) toggle(hit.ownerId);
    else select(hit.ownerId);
  };

  // 钩子必须在"这一帧已经刷完"之后存在：effect 顺序 = 声明顺序，paint 在前、这条在后。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || viewport === null) return;
    const previous = window.__dajiaDebug;
    window.__dajiaDebug = (): DebugReport => {
      // 读 opsRef（屏幕上那张图）而不是重算一份：重算的那份不知道选中集，
      // T3 这么写没问题（那时选中不上屏），T4 之后再重算就是在测另一张图。
      const ops = opsRef.current;
      const layers: Record<string, number> = {};
      for (const o of ops) layers[o.pen.layer] = (layers[o.pen.layer] ?? 0) + 1;
      const ctx = canvas.getContext('2d');
      const counted =
        ctx === null ? { nonBlankPx: 0, selectedPx: 0 } : countPixels(ctx, canvas);
      return {
        ops: ops.length,
        layers,
        nonBlankPx: counted.nonBlankPx,
        wPx: canvas.width,
        hPx: canvas.height,
        selectedIds: [...ids],
        selectedPx: counted.selectedPx,
        pick: probeTarget(ops, viewport),
        selectedAfterBlank: ids.size,
      };
    };
    return () => {
      window.__dajiaDebug = previous;
    };
  }, [viewport, ids]);

  return <canvas ref={canvasRef} onPointerDown={onPointerDown} style={{ display: 'block' }} />;
}
```

> **`selectedAfterBlank` 为什么单独一个字段而不是复用 `selectedPx`**：`ids.size` 与"红色像素数"是两件事 —— 前者证 store 被清空，后者证屏幕跟着清。只留 `selectedPx` 的话，"store 清空但画布没重刷"（漏了 `ids` 依赖）会显示成红色像素仍在；只留 `selectedIds` 的话，"刷了但刷错了颜色"看不见。
>
> **`Px` 不在 import 列表里**：`DebugReport.pick` 用的是 `PickProbe`，而 `onPointerDown` 那个字面量靠 `pickOne` 的入参推断就够了 —— 多引一条 `type Px` 会被 `noUnusedLocals` 拦下（`pnpm --filter @dajia/desktop typecheck` 红），所以这条 import 就是它应有的样子。`PickProbe` 反过来必须有：`DebugReport` 的字段类型用到了它。

`apps/desktop/src/main/index.ts`：`--shot` 那条路径**一行都不改**，加下面这些。**不许**从 renderer 文件 `import type { DebugReport }` —— 那会把 React 拖进 main 产物；这里的形状与 `DebugReport` 字段名对齐，JSON 是它们唯一的对账处。

```ts
interface ClickPoint {
  x: number;
  y: number;
}

interface PickProbeShape {
  ownerId: string;
  clickPx: ClickPoint;
  blankPx: ClickPoint;
}

interface ReportShape {
  ops: number;
  selectedIds: string[];
  selectedPx: number;
  pick: PickProbeShape | null;
  selectedAfterBlank: number;
}

function pickShotRequested(): boolean {
  return process.argv.includes('--pick-shot');
}

/** 条件轮询，不是固定 sleep：慢窗口不该导致误判成"没反应"，等不到才是失败。 */
async function waitUntil<T>(label: string, probe: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await probe();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`10 秒内没等到：${label}`);
}

async function readReport(win: BrowserWindow): Promise<ReportShape> {
  return (await win.webContents.executeJavaScript('window.__dajiaDebug()')) as ReportShape;
}

/**
 * 走合成指针事件，不走 `element.click()`：后者只给 DOM 派发一个 click，
 * 我们的处理器听的是 pointerdown（而且真实点击还带着 offsetX 与 shift 修饰键）。
 */
async function clickPx(win: BrowserWindow, p: ClickPoint): Promise<void> {
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

/** 先点中一个构件，再点空白，最后把两个状态一起写盘。坐标一律由 scene-2d 的探针给出。 */
async function runPickShot(win: BrowserWindow, path: string): Promise<void> {
  await whenLoaded(win);
  await waitForDebug(win);
  const before = await readReport(win);
  if (before.pick === null) throw new Error('probeTarget 没给靶子：四角离图太近或没有唯一命中的边');
  const probe = before.pick;
  await clickPx(win, probe.clickPx);
  const picked = await waitUntil(
    `选中 ${probe.ownerId} 且屏幕变红`,
    () => readReport(win),
    (r) =>
      r.selectedIds.length === 1 && r.selectedIds[0] === probe.ownerId && r.selectedPx > 100,
  );
  await clickPx(win, probe.blankPx);
  // 三个条件一起等：React 提交 store 与重刷画布之间隔着一帧。只等 ids 归零的话，
  // 会在红像素还没落时就把它读进报告，判据 4 假红（看起来像"清空没生效"）。
  const cleared = await waitUntil(
    '点空白后清空选中',
    () => readReport(win),
    (r) => r.selectedIds.length === 0 && r.selectedAfterBlank === 0 && r.selectedPx === 0,
  );
  const finalReport = {
    ...cleared,
    ops: before.ops,
    pick: probe,
    clickedOwner: picked.selectedIds[0] ?? null,
    // 清空之后 selectedPx 会回到 0，所以"点中时红了多少"必须单独留档，
    // 不能靠 finalReport 里那个 selectedPx —— 那是空白点的状态。
    pickedSelectedPx: picked.selectedPx,
  };
  writeFileSync(path, `${JSON.stringify(finalReport, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(finalReport)}\n`);
}
```

`app.whenReady()` 那段里的分支改成（`shotPath === null` 的正常启动路径与 `runShot` 本体都不动）：

```ts
  let code = 0;
  try {
    if (pickShotRequested()) await runPickShot(win, shotPath);
    else await runShot(win, shotPath);
  } catch (err) {
    process.stderr.write(`--shot 失败：${String(err)}\n`);
    code = 1;
  }
  app.exit(code);
```

`scripts/desktop-shot.mjs`：`try` / `finally { rmSync(dir, ...) }` 那两头的骨架**原样保留**，改的是 `wantPick`、起 Electron 那一行与判据数组：

```js
const wantPick = process.argv.includes('--pick');
const electronArgs = [
  '.',
  ...(wantPick ? ['--pick-shot'] : []),
  '--shot',
  out,
];
try {
  run('pnpm', ['--filter', '@dajia/desktop', 'build']);
  run('pnpm', ['--filter', '@dajia/desktop', 'exec', 'electron', ...electronArgs], 180_000);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  const layers = report.layers ?? {};
  // 前六条与 drawlist.test.ts 同源；后四条与 pick.test.ts 同源。
  // 改样例房必须几处一起改，别只调这里。
  const checks = [
    ['指令表 31 条（8 轮廓 + 12 轴线 + 10 洞口线 + 1 标签）', report.ops === 31],
    ['structure 层 20 条', layers.structure === 20],
    ['opening 层 10 条', layers.opening === 10],
    ['annotation 层 1 条', layers.annotation === 1],
    ['画布尺寸 = 窗口内容区', report.wPx > 800 && report.hPx > 500],
    ['非背景像素 > 5000（白屏恒为 0）', report.nonBlankPx > 5000],
  ];
  if (wantPick) {
    checks.push(
      ['探针给出可点的构件', typeof report.pick?.ownerId === 'string'],
      ['点中墙后屏幕上真的有红色像素', report.pickedSelectedPx > 100],
      ['选中的就是探针指的那面墙', report.clickedOwner === report.pick?.ownerId],
      // 两半都要：store 空了 **且** 红色像素没了 —— 只查前者的话，paint effect 漏掉 ids
      // 依赖（屏幕还红着）会一路绿灯。
      ['点空白后 store 与屏幕一起清空', report.selectedAfterBlank === 0 && report.selectedPx === 0],
    );
  }
```

根 `package.json` 的 scripts 加一条（`shot` 保持原样，CI 与日常都还跑它）：

```json
"pick-shot": "node scripts/desktop-shot.mjs --pick"
```

- [ ] **Step 7: 真窗口点一次 + 全量闸门 + 两个提交**

```bash
pnpm --filter @dajia/desktop typecheck > /tmp/t4-dts.log 2>&1; echo exit=$?
pnpm shot > /tmp/t4-shot-pixels.log 2>&1; echo exit=$?
pnpm pick-shot > /tmp/t4-shot-pick.log 2>&1; echo exit=$?
```
Expected: 三个 exit=0；`pnpm shot` 仍是六行 PASS（**回归判据**：`ops === 31` 没因为选中上色而变 —— 选中只改 `pen.color`，一条指令都不该多）；`pnpm pick-shot` 十行 PASS。

两条已知风险，按顺序试，别改判据：

1. **窗口没聚焦 ⇒ 合成输入根本不派发**。这不是猜，是 Electron 44 自带 `electron.d.ts` 里 `webContents.sendInputEvent` 的原文注记：*"The `BrowserWindow` containing the contents needs to be focused for `sendInputEvent()` to work."* 所以 `runPickShot` 一进来就要 `win.focus()` + `win.webContents.focus()`（T5 Step 6 把它抽成 `focusForInput(win)`，两条 shot 路径共用）。补了 focus 还卡在第一处 `waitUntil`（报"10 秒内没等到：选中 …"），就把 `createWindow(shotPath === null)` 改成 `createWindow(true)` 再跑一次 —— `show: false` 的窗在 Windows 上拿不到 OS 焦点是有可能的。三条路径都跑不通就停下来报告：那时"屏幕红了"就没有客观凭据了，**不许**退回去用 `executeJavaScript('el.click()')` 蒙过去（它绕开了 pointerdown 与真实坐标，正是我们要证的那一层）。
2. **`mouseDown` 不产生 `pointerdown`**：现代 Chromium 会为鼠标输入合成指针事件，所以先照原样跑。真对不上时，`InputEvent.type` 的联合里明明白白列着 `pointerDown` / `pointerUp` / `pointerMove`（同一份 `electron.d.ts`），改的是**事件类型字符串**；退到 `onMouseDown` 是第二选择。判据一个字都不变 —— 先跑再改，不许猜。

再验一次判据能区分"画了"和"没画"：把 `buildDrawList(log.document, storeyId, viewport, { ids })` 的第四参临时改成 `EMPTY_SELECTION`（或删掉），跑 `pnpm pick-shot` —— **必须**在"点中墙后屏幕上真的有红色像素"那行 FAIL 并抛错退出（`selectedPx` 恒 0）。改回来再跑，十行全 PASS。这条是"选中真的上屏"的唯一证明，`pick.test.ts` 管不到屏幕那一侧。

```bash
pnpm verify > /tmp/t4-verify.log 2>&1; echo exit=$?
```
Expected: exit=0，`Test Files 26 passed`（26）、`Tests 318 passed`（**284 + 9 + 10 + 15**：基数 23 个文件 / 284 条是 2026-09-27 实测的仓底，T1 的 `viewport.test.ts` +9、T2 的 `drawlist.test.ts` +10、本任务的 `pick.test.ts` +15，T3 不新增测试文件）。数字对不上就是有用例被 skip 或没被 include 收到，先查日志别改期望值。

```bash
git add packages/scene-2d
git commit -m "feat: scene-2d 命中测试，屏幕像素容差 + 层序压倒距离"
git add apps/desktop scripts package.json
git commit -m "feat: 平面图点选与选中 store，--pick-shot 用合成指针回读证明"
```
第一条提交信息里带上 Step 5 的十条改坏命令与关键红字；第二条带上 `--pick-shot` 的十个实测数。

---

### Task 5: 拖端点改墙（屏幕上的像素落到真源，且撤销栈知道发生了什么）

**Files:**
- Modify: `packages/core/src/geom/topology.ts`（新增 `assertNoGhostColumn`，从 `columnCreate` 里搬判据）
- Modify: `packages/core/src/commands/column.ts`（那段循环换成调用共享判据；`requirePoint` 随之不再使用，必须从 import 删掉）
- Modify: `packages/core/src/commands/wall.ts`（`wallMoveEndpoint` 在算完新轴长与全部合法守卫之后补第二处复核）
- Create: `packages/core/test/commands-drag.test.ts`（7 条：重影柱与跟走 5 条 + `end:'start'` 角色反转 2 条）
- Create: `packages/scene-2d/src/handles.ts`（把手、落点换算、合法性预言、拖拽探针、端点快照、编辑器配色）
- Modify: `packages/scene-2d/src/index.ts`（`export * from './handles';`）
- Create: `packages/scene-2d/test/handles.test.ts`（12 条，全是 node 里跑的纯函数）
- Modify: `apps/desktop/src/renderer/src/stores/editorStore.ts`（`revision` / `lastError` / `drag` + `dispatch`/`undo`/`redo` 三个动作）
- Modify: `apps/desktop/src/renderer/src/PlanCanvas.tsx`（整体替换：指针状态机、把手与临时线的绘制、`DebugReport` 补 12 个字段、快捷键）
- Modify: `apps/desktop/src/main/index.ts`（新增 `--edit-shot` 八步序列与四个发事件的小助手；`shotPathFromArgv()` 换成通用的 `argPath(flag)`；`runShot` 本体与六条基础判据一行不动）
- Modify: `scripts/desktop-shot.mjs`（`--edit` 开关 + 十五条新判据 ⇒ 21 行 PASS）
- Modify: `package.json`（根：`"edit-shot"`）

**先落七条裁决。末尾边界表给 Task 5 留的两个问句（重影柱、`interaction` 层）在这里判掉，判据写进代码与测试，不许留在纸面。**

| # | 问题 | 裁决 | 理由与代价 |
|---|---|---|---|
| D1 | 拖一个挂着柱的共享端点，柱跟不跟走？（计划 2 ledger Ruling ㊤ 判给"计划 3 的拖拽入口"） | **跟走，并在命令层补第二处复核**：`wallMoveEndpoint` 落点前调 `assertNoGhostColumn` | 三条现状事实逐条读过源码。① 柱以 `column.pointId` 引用那枚 point，而 `wallMoveEndpoint` upsert 的正是那个点（`const upsert: Entity[] = [{ ...moving, x, y }]`）⇒ 柱**一定**跟走；这不是判据承诺的语义，是引用共享的副作用，所以要一条用例把它钉成契约（拖完柱落点坐标 = 新端点坐标）。② "同层同坐标不立两根柱"原来只在**建柱那一刻**判一次 ⇒ 把骑手拖到另一根柱的坐标上，那条判据在建完之后被破坏。破坏之后**没人红**：`deriveStoreyGeometry` 不派生柱，`SpatialIndex` 的 `IndexedKind` 只有墙与洞口（事实③），视图和索引都是瞎的。所以复核必须落在命令层：真源不许留重影，抛错比让 3D/算量吃双份混凝土便宜得多。代价：`wallMoveEndpoint` 多一个 O(柱数) 循环；判据从 `columnCreate` 抽成共享函数，两处吃同一份算式（计划 2 终审 I-3 同一条理由）。 |
| D2 | 要不要给 `DrawLayer` 真加一个 `interaction` 层、给 `DrawOp` 加 `dot` 变体？ | **都不加。** 把手与拖拽临时线**不进指令表**，由 renderer 的两个专用画函数画；颜色/半径的常量住在 `handles.ts` | `DrawOp` 是**图纸内容的投影**，不是一切屏幕上那坨像素的投影：计划 5 出图、计划 4 的 `--shot` 判据都直接吃 `buildDrawList`，把蓝点掺进去等于往施工图纸上印编辑器家具，而那一步的回归判据（`ops === 31`）恰好看不见它。层序压倒距离也用不着新层：把手的命中是排在 `pickOne` **之前**的独立一趟 `pickHandle`（见 D3），它比"看得见的下面那一层"更强，不需要参与排序。收益是零改动半径：`drawlist.ts` 与 `pick.ts` 一行不改，T2 的十条改坏与 T4 的十条继续逐字有效。代价：`paint()` 之外多两个画家，"一条绘制通路"这条纪律要由「像素计数」（`--edit-shot` 的"把手上屏"与"拖拽中临时线上屏"两条判据，各自数一个颜色桶）来守而不是靠类型。 |
| D3 | 把手的数据从哪来？和已提交的几何冲突时谁赢？ | `wallAxisById`（core 的出口）给位置，**core 的守卫给合法性**，屏幕像素给命中 | `atPx = mmToPx(v, axis.start/end)`（与墙多边形同一个产地）；`anchorPx = mmToPx(v, endPoint(axis, otherEnd(end)))` —— 压扁拖要的就是这个值，而它是算出来的不是猜的。"这个落点能不能拖"绝不重写一份判据：`legalDrop` 就是拿真靶子 `wallMoveEndpoint(...).build(doc)` 试一次（`build` 只吃文档、返回补丁，不动文档，也不新建实体 ⇒ 同一个入参调两次结果相同）。这条同时是**计划 1 那次角色反转 bug 的防线**：拖拽入口天然两端都拖，`end:'start'` 走的是同一批守卫的另一半，所以 R1/R2 两条用例必须存在（计划 2 转下游 #1 在此收口）。 |
| D4 | 浮点屏幕坐标怎么落到整数毫米？中途和落点怎么分？ | 唯一出口 `moveTargetOf(v, cursorPx) = { quantizeMm(pxToMm.x), quantizeMm(pxToMm.y) }`；中途只进 `drag` 态，松手才 `dispatch`；本任务不做吸附 | 中途不写文档 ⇒ 一次拖动撤销栈只多一步。零移动（松手时 `target` 与该点在真源里的 `atMm` 逐字相同）**不发命令**，只记 `outcome:'noop'` —— 否则每点一次把手都往撤销栈塞一步空操作，30 步以后就没法撤销真东西了（spec 验收 2 要的正是连续撤销可用）。吸附（端点/中点/15°）是 T6 的 `snapping.ts`，它的插入点就是 `moveTargetOf` 之后、`dispatch` 之前那一行。 |
| D5 | 把手命中与选中集谁伺候谁？ | **拖之前先选中**：按下命中把手 ⇒ 同一趟里 `select(h.wallId)` 再装填 `drag`；把手只从**当前选中集**生成 | 只准一个入口，于是"屏幕上的把手"与"选中集"不可能各说各话：`dragHandlesOf(doc, storeyId, { ids }, v)` 的入参就是 paint effect 刚用来上色那份 `ids`（同一个 effect 里算出来的同一个表达式）。代价：拖之前先要点一下（本任务就是这么点两下 —— 点端像素选中它，按下同一像素起拖），换来的是"拖完红着的和拖完动着的必须是同一面墙"这条不变式，H4′ 盯着它。 |
| D6 | 撤销/重做与"dispatch 抛错 = 不重建"怎么落？ | `EditorState` 持一个**只在成功后 +1 的 `revision` 计数器**；诊断值（`lastDrop`/`lastKeyEvent`）住 `ref`，不进 paint 依赖；本任务一行都不读 `log.affected` | 计划 2 转下游 #11 说清了病因：`dispatch` 里 `lastAffected` 只在最后一行赋值，`cmd.build` 抛错时它**留着上一次那批 id** —— 增量重建若在失败之后读它就白重建甚至读脏。病在将来：本任务是第一次真在 UI 里让 dispatch 抛错（压扁拖就是冲着它去的），所以要一个不会说谎的东西当重建扳机。`log` 是可变类实例，引用永远不变 ⇒ zustand 的 `Object.is` 判定相等，`{log}` 订阅者**永不重渲**，所以 `revision` 不是保险而是唯一的扳机；而失败路径上谁都不动它 ⇒ 既不重建也无副作用。纪律：要上屏的一律 `log` + `revision`；只给回读用的不进 paint 依赖（否则抛错的反馈自己会制造一次重建，D6 就白设计了）。等 `affected` 的第一个读者出现（3D 或索引增量），它的契约是"revision 变了才读 `log.affected`" —— 那时才是 #11 真正要防的那一天。 |
| D7 | 撤销栈空了要不要响？拖完选中还在不在？ | `Ctrl+Z` / `Ctrl+Shift+Z`（含 `metaKey`）；空栈必须把 `lastError` 写成中文提示，不许静默返回 `false`；undo/redo **不清**选中集 | `log.undo()` / `log.redo()` 返回 `boolean`（边界原话要求"栈空时要反馈到 UI 而不是静默"）。不清选中是因为撤销的是文档不是视图：用户撤销一次拖动，那面墙还在原地，只是坐标回去了 —— 而 spec §127 明令"选中状态不进真源、不进撤销栈" ⇒ 撤销也不该顺手改它。代价：撤销掉一面正被选中的墙（T6 才做删除）时屏幕上会留一个不存在的构件的把手，届时随删除一起处理。 |
| D8 | 屏幕侧那几桶像素和诊断字段，够证明"拖"这件事吗？ | **不够，补两个：`previewNearCursorPx`（第五个桶）与 `KeyEventReport.seq`。** 临时线的判据从"有这个颜色"升级为"颜色在光标那一撮里"；快捷键的等待从"比 `combo`"改成"比 `seq`" | 两处是同一个坑：`> 0` 的计数与"最后一次那串字"都只证**存在**，不证**位置与时序**。原写法下把 `paintPreview(ctx, drag.fromPx, drag.cursorPx)` 的终点改成 `drag.fromPx`（线钉死在按下那一点）二十一判据照样全绿 —— `previewPx` 那根线照样 >20；`waitKeyApplied` 比 `combo` 更是自相矛盾：第 8 步的空栈重做与第 6 步同为 `'Ctrl+Shift+Z'`，而那一发按设计真源什么都不动 ⇒ 谓词永远不成立，跑不完是"自己等满 10 秒抛错"，不是判据抓到了 bug。代价：`countPixels` 多一个入参、每个临时线像素多两次减法（同一次扫描顺路做，不额外 `getImageData`）；`DebugReport` 与 `KeyEventReport` 各多一个字段，renderer 与 main 两份形状必须一起改（漏一侧红在 `TS2322`）。换来的是 Step 7 的 R2/R3 有地方红，以及八步序列里"这一发确实到过 renderer"第一次有硬凭据。（2026-09-27 用一张 40x20 的合成位图跑过这段下标算式：跟手时 `previewPx` 93 / 第五桶 25，终点钉死在按下点时 `previewPx` 69 / 第五桶 0 —— 旧桶两种情况都过 `> 20`，新桶只在跟手时非零，所以判据取 `> 0` 而不是 `> 20`：真实 canvas 的抗锯齿会把光标那一撮削掉一圈。） |

**Interfaces:**
- Consumes:
  - core：`wallMoveEndpoint`、`incidentWallEnds`、`requirePoint`、`wallAxisById`、`endPointId`、`otherEnd`、`endPoint`、`quantizeMm`、`vec`、`Document`、`TransactionLog`、`Command`、`WallEnd`，类型 `PointEntity` / `WallEntity`
  - T1：`Px` / `Viewport` / `mmToPx` / `pxToMm`；T2：`buildDrawList` / `fitStorey` / `demoHouse` / `DrawOp` / `Pen` / `Selection` / `EMPTY_SELECTION` / `SELECTED`；T4：`PICK_TOL_PX`
- Produces:
  ```ts
  // packages/core/src/geom/topology.ts
  export function assertNoGhostColumn(
    doc: Document,
    storeyId: EntityId,
    at: { readonly x: number; readonly y: number },
    exceptPointId?: EntityId,
  ): void;

  // packages/scene-2d/src/handles.ts
  export const HANDLE_COLOR = '#1668dc';
  export const PREVIEW_COLOR = '#12b886';
  export const PIXEL_CHANNEL_TOL = 40;
  export const HANDLE_RADIUS_PX = 4.5;
  export interface MoveTarget { readonly x: number; readonly y: number }
  export interface DragHandle {
    readonly wallId: string;
    readonly end: WallEnd;
    readonly pointId: string;
    readonly atMm: MoveTarget;   // 真源里那对整数毫米，不做任何换算
    readonly atPx: Px;           // 它在线上的哪一端（与 pointId 配对钉死，防角色互换）
    readonly anchorPx: Px;       // 另一端：拖到这里必然'零长墙'
  }
  export interface DragProbe {
    readonly wallId: string;
    readonly end: WallEnd;
    readonly pointId: string;
    readonly sharedBy: number;   // 几面墙指着这个点（>= 2）
    readonly fromPx: Px;
    readonly toPx: Px;
    readonly anchorPx: Px;
    readonly targetMm: MoveTarget;
  }
  export function moveTargetOf(v: Viewport, cursorPx: Px): MoveTarget;
  export function dragHandlesOf(doc: Document, storeyId: string, sel: Selection, v: Viewport): DragHandle[];
  export function pickHandle(handles: readonly DragHandle[], point: Px, tolPx?: number): DragHandle | null;
  export function legalDrop(doc: Document, wallId: string, end: WallEnd, target: MoveTarget): boolean;
  export function dragProbe(doc: Document, storeyId: string, ops: readonly DrawOp[], v: Viewport): DragProbe | null;
  export function pointSnapshot(doc: Document, storeyId: string): Record<string, MoveTarget>;
  ```
  renderer 侧：`useEditor()` 变成 `{ log, storeyId, viewport, revision, lastError, drag, setViewport, setDrag, dispatch, undo, redo }`；`window.__dajiaDebug()` 的 `DebugReport` 补 `revision` / `depth` / `canUndo` / `canRedo` / `lastError` / `handlePx` / `previewPx` / `previewNearCursorPx` / `points` / `edit` / `lastDrop` / `lastKeyEvent`；`pnpm edit-shot`。

- [ ] **Step 1: core —— 把重影柱判据抽成共享函数，并在拖动落点前复核**

先只改 core（scene-2d 的 `legalDrop` 与两条新用例都站在这块地基上）。`packages/core/src/geom/topology.ts` 末尾追加（`requirePoint` 与 `Document` / `EntityId` 这个文件都已经 import 过，不新增依赖）：

```ts
/**
 * 同层同坐标不许立两根柱。判据取**坐标 + 同层**，不取 pointId —— 同一个 (x, y) 给两次
 * 字面坐标会新建出第二个点实体，"id 相等"那条对这种重影全然是瞎的。候选坐标一律是真源里
 * 那对整数毫米（由调用方保证），所以这里是精确相等比较，不引入 epsilon。
 *
 * `exceptPointId` 给"整个点带着它的柱一起搬家"的调用方用（`wallMoveEndpoint`）：骑手柱自己
 * 不算对手。同一点上本来就只准一根柱（建柱时本函数就禁止），所以这句至多排除掉一根。
 * 悬空引用（柱指着不存在的点）是内部不变式被破坏，`requirePoint` 直接抛，不 continue。
 */
export function assertNoGhostColumn(
  doc: Document,
  storeyId: EntityId,
  at: { readonly x: number; readonly y: number },
  exceptPointId?: EntityId,
): void {
  for (const column of doc.byKind('column')) {
    if (column.storeyId !== storeyId) continue;
    if (column.pointId === exceptPointId) continue;
    const owner = requirePoint(doc, column.pointId, '柱落点');
    if (owner.x === at.x && owner.y === at.y) {
      throw new RangeError(
        `该坐标已有柱 ${column.id}（点 ${column.pointId}，落在 (${owner.x}, ${owner.y})）：` +
          `同一层的同一个坐标上不能立两根柱`,
      );
    }
  }
}
```

> 报错文案与 `column.ts` 里那段**逐字节相同**（两行拼接、全角括号、中文冒号都照抄）。它今天没有任何一条用例钉住整条文案（测试用的是 `/已有柱/`），所以漂移是静默的 —— Step 2 的 G2 用一条正则把整条文案钉住，`columnCreate` 与 `wallMoveEndpoint` 两个产地共用同一个正则。

`packages/core/src/commands/column.ts`：把 56-74 行那整段（从注释 `// 一根柱占一个坐标：` 到循环右花括号）换成一行调用，注释留在函数里，这里只写"判据在共享函数里"的理由：

```ts
      // 一根柱占一个坐标：判据住在 geom/topology.ts 的 assertNoGhostColumn —— 建柱与
      // 拖动共享端点（柱跟着点走）吃同一份算式，两处不许各写一遍。
      assertNoGhostColumn(doc, input.storeyId, landing);
```

`landing` 是 `PointEntity`，结构子类型直接满足 `{ x, y }` 那个参数，不必拆成字面量（拆了反而像两套口径）。随之调整 import：`topology` 那行补 `assertNoGhostColumn`；`model/read` 那行**删掉 `requirePoint`** —— 它在这个文件里只被搬走的那个循环用过，留着 `noUnusedLocals` 直接把 typecheck 判红。

`packages/core/src/commands/wall.ts` 的 `wallMoveEndpoint`：在 `for (const inc of incidentWallEnds(...))` 那个邻墙循环**结束之后**、`const upsert: Entity[] = [{ ...moving, x, y }]` **之前**插一条复核。顺序是判据的一部分：先把"墙自己合不合法"判完，再判"柱够不够地方" —— 一个既压扁墙又撞柱的落点，用户先收到的该是几何错（更根本）。

```ts
      // 挂在这个点上的柱会跟着点一起走（D1）。建柱时那条"同层同坐标只准一根柱"的判据必须在
      // 拖动之后再判一次：不然把柱搬到另一根柱的头上，真源里留下一对重影 —— 而
      // deriveStoreyGeometry 不派生柱、SpatialIndex 只装墙与洞口，视图与索引都看不见它。
      // 取 moving.storeyId 而不是 wall.storeyId：被撞的是"这个点所属的层"里的柱。
      assertNoGhostColumn(doc, moving.storeyId, { x, y }, moving.id);
```

`wall.ts` 的 `../geom/topology` import 那行补上 `assertNoGhostColumn`（该文件已有这个 import 组）。

- [ ] **Step 2: core —— 写重影柱与角色反转的定值用例（先红）**

`packages/core/test/commands-drag.test.ts` 新建。它自带的四个助手与 `commands-column-slab.test.ts` 里那三个六行助手同形（测试文件各留各的局部助手是本仓既有的口径，见计划 3 Task 2 那条注）：

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  columnCreate,
  storeyCreate,
  uuidv7,
  wallCreate,
  wallMoveEndpoint,
  type ColumnEntity,
  type PointEntity,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();

/** 拐角在 (3600, 0) 的 L 形，第二面墙拉到 (3600, 4800)：给"把柱拖到另一根柱头上"留出合法落点。 */
function lCorner(): {
  log: TransactionLog;
  storeyId: string;
  sharedId: string;
  first: WallEntity;
  second: WallEntity;
} {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 6000 }));
  const storeyId = storeyByIndex(log, 0);
  const first = addWall(log, storeyId, {
    start: { x: 0, y: 0 },
    end: { x: 3600, y: 0 },
    thicknessMm: 240,
  });
  const sharedId = first.endId;
  const second = addWall(log, storeyId, {
    start: { pointId: sharedId },
    end: { x: 3600, y: 4800 },
    thicknessMm: 240,
  });
  return { log, storeyId, sharedId, first, second };
}

function storeyByIndex(log: TransactionLog, index: number): string {
  const hit = log.document.byKind('storey').find((s) => s.index === index);
  if (!hit) throw new Error(`测试找不到楼层 index=${index}`);
  return hit.id;
}

function addWall(
  log: TransactionLog,
  storeyId: string,
  spec: { start: { x: number; y: number } | { pointId: string }; end: { x: number; y: number } | { pointId: string }; thicknessMm: number },
): WallEntity {
  log.dispatch(wallCreate({ storeyId, heightMm: 6000, ...spec }));
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建墙');
}

function addColumn(
  log: TransactionLog,
  storeyId: string,
  at: { x: number; y: number } | { pointId: string },
): ColumnEntity {
  log.dispatch(columnCreate({ storeyId, at, widthMm: 400, depthMm: 400 }));
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'column') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建柱');
}

const pointAt = (log: TransactionLog, id: string): PointEntity =>
  log.document.get(id) as PointEntity;

/** 整条重影文案钉一次，两个产地共用（`columnCreate` 与 `wallMoveEndpoint` 必须说同一句话）。 */
const GHOST_AT_2400 =
  /^该坐标已有柱 [0-9a-f-]+（点 [0-9a-f-]+，落在 \(3600, 2400\)）：同一层的同一个坐标上不能立两根柱$/;

describe('拖共享端点与柱（计划 2 Ruling ㊤ 的落点）', () => {
  it('拖共享端点 ⇒ 挂在点上的柱跟走：还是那一根柱、同一个落点引用，坐标跟着变', () => {
    const { log, storeyId, sharedId, first } = lCorner();
    const column = addColumn(log, storeyId, { pointId: sharedId });
    const depth = log.depth;
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 1200 }));
    // 跟走 = 柱实体一个字都没动，动的只是它引用的那枚点。若这里改写成"upsert 一份新柱"，
    // 第二条断言会红：affected 里只有点，没有柱。
    expect(log.document.get(column.id)).toBe(column);
    expect([pointAt(log, column.pointId).x, pointAt(log, column.pointId).y]).toEqual([3600, 1200]);
    expect(log.document.byKind('column')).toHaveLength(1);
    expect(log.document.byKind('point')).toHaveLength(3); // 没新建点：复用即跟走
    expect(log.depth).toBe(depth + 1);
  });

  it('把骑手柱拖到另一根柱的坐标上 ⇒ 抛，且真源与撤销栈原地不动（第二处复核在 build 内）', () => {
    const { log, storeyId, sharedId, first } = lCorner();
    addColumn(log, storeyId, { pointId: sharedId });
    addColumn(log, storeyId, { x: 3600, y: 2400 });
    const depth = log.depth;
    const before = log.document.canonical();
    // (3600,2400) 这个落点几何上完全合法：first 长 4326、second 长 2400，都大于各自墙厚。
    // 所以这一发能红的唯一原因就是重影复核 —— 摘掉那行它就绿，见 Step 4 的 M13。
    expect(() =>
      log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 2400 })),
    ).toThrow(GHOST_AT_2400);
    expect(log.depth).toBe(depth);
    expect(log.document.canonical()).toBe(before);
  });

  it('建柱与拖动两个产地共用同一份判据 ⇒ 同一句文案（抽函数没改口径）', () => {
    const { log, storeyId } = lCorner();
    addColumn(log, storeyId, { x: 3600, y: 2400 });
    expect(() =>
      log.dispatch(
        columnCreate({ storeyId, at: { x: 3600, y: 2400 }, widthMm: 400, depthMm: 400 }),
      ),
    ).toThrow(GHOST_AT_2400);
  });

  it('钉住"同层"这半边：另一层同坐标有柱不算重影，拖动照走（正对照）', () => {
    const { log, storeyId, sharedId, first } = lCorner();
    addColumn(log, storeyId, { pointId: sharedId });
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 6000, heightMm: 6000 }));
    addColumn(log, storeyByIndex(log, 1), { x: 3600, y: 2400 });
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 2400 }));
    expect([pointAt(log, sharedId).x, pointAt(log, sharedId).y]).toEqual([3600, 2400]);
    expect(log.document.byKind('column')).toHaveLength(2);
  });

  it('原地拖（落点与当前坐标逐字相同）⇒ 不抛：骑手柱自己不算对手', () => {
    const { log, storeyId, sharedId, first } = lCorner();
    addColumn(log, storeyId, { pointId: sharedId });
    const depth = log.depth;
    const before = log.document.canonical();
    // exceptPointId 那一行 continue 只在这条路上有牙齿：不排自己，"点了把手又原样松开"
    // 会报"该坐标已有柱"。renderer 用 D4 的 noop 过滤挡掉这一发，但命令层不许靠上层守规矩 ——
    // 计划 4 的批量导入、计划 5 的图面复核都直接 dispatch 命令。
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 0 }));
    expect(log.depth).toBe(depth + 1); // 确实发出去了（不是被谁悄悄吞掉）
    expect(log.document.canonical()).toBe(before); // 而真源逐字节没变：这是一步空操作
  });
});

describe('wallMoveEndpoint 的 end:start 角色反转（计划 2 转下游 #1 收口）', () => {
  it('拖 start 端 ⇒ 动的只有 startId 那枚点，endId 一字未改，affected 恰好 {startId}', () => {
    const { log, first, sharedId } = lCorner();
    expect(first.startId).not.toBe(sharedId);
    const before = log.document.get(first.startId) as PointEntity;
    const cornerBefore = log.document.get(sharedId) as PointEntity;
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'start', x: 1200, y: 900 }));
    const after = log.document.get(first.startId) as PointEntity;
    expect([before.x, before.y]).toEqual([0, 0]);
    expect([after.x, after.y]).toEqual([1200, 900]);
    expect(log.affected).toEqual(new Set([first.startId]));
    // 拐角那枚点（= first.endId）压根没进补丁：applyPatch 用 `new Map(doc.entities)` 抄表，
    // 没被 upsert 的实体保持**对象同一性**。所以引用相等比"坐标没变"更强 ——
    // "把同一个坐标重述一遍"那种假改动（坐标断言看不出）会在这里红。
    expect(log.document.get(sharedId)).toBe(cornerBefore);
    expect([cornerBefore.x, cornerBefore.y]).toEqual([3600, 0]);
  });

  it('把 start 端拖到离 end 只剩 100mm ⇒ 拒的是本墙，守卫盯的是被拖的那一端', () => {
    const { log, second, sharedId } = lCorner();
    const depth = log.depth;
    const before = log.document.canonical();
    // second 是 (3600,0)-(3600,4800)、厚 240：start 拖到 (3600,4700) 之后轴长 100 < 240。
    // 角色写反了会拿"另一端点"当被拖端，那一发拒的是别的东西甚至放行。
    expect(() =>
      log.dispatch(wallMoveEndpoint({ wallId: second.id, end: 'start', x: 3600, y: 4700 })),
    ).toThrow(/移动端点会让墙 .* 的墙厚 240 不小于轴长 100/);
    expect(log.depth).toBe(depth);
    expect(log.document.canonical()).toBe(before);
    expect([pointAt(log, sharedId).x, pointAt(log, sharedId).y]).toEqual([3600, 0]);
  });
});
```

> **为什么 G1（跟走）与 G2（复核）是两条而不是合成一条**：G1 红了说明引用共享的副作用没了（有人改写柱实体），G2 红了说明新加的判据被摘掉。合成一条，"摘掉 `wall.ts` 那行复核"会把两条一起弄红，读不出坏在哪一边 —— 而这两边的修法是相反的。
>
> **Step 2 有意没钉的一件事，登记给计划 4**：把共享端点拖到与另一枚边界点重合，会让**已建楼板**的边界退化。`assertSimpleRing`（`geom/ring.ts`，按坐标判重复顶点与共线）只在 `slabCreate` 里跑一次（`commands/slab.ts:62`），而 `slab.boundaryPointIds` 存的是点**引用**，之后的 `wallMoveEndpoint` 不会替它复检；`wall.ts` 里唯一读板的地方是 `stillReferenced`（删墙时防误删孤儿点），跟几何合法性无关。本任务不修：一条拖动级的板复核要把板边界全展开，代价与判据都属"整层回读不变式"（挂账 #5/#12 同批），那才是它的落点。届时若它红，红的是这条已登记的缺口，不是没人想到。

- [ ] **Step 3: scene-2d —— 先写把手与探针的失败测试**

`packages/scene-2d/test/handles.test.ts`（12 条 `it`，全是 node 里跑的纯函数：`handles.ts` 只吃文档 + 视口 + 指令表，不碰 canvas，理由见 T4"命中为什么能在 node 里测完"那条注）。顶部先固定三份共用材料：

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  requirePoint,
  storeyCreate,
  uuidv7,
  vec,
  wallAxisById,
  wallCreate,
  wallMoveEndpoint,
  type WallEntity,
} from '@dajia/core';
import {
  buildDrawList,
  demoHouse,
  dragHandlesOf,
  dragProbe,
  EMPTY_SELECTION,
  fitStorey,
  HANDLE_COLOR,
  HANDLE_RADIUS_PX,
  legalDrop,
  mmToPx,
  moveTargetOf,
  pickHandle,
  pickOne,
  PIXEL_CHANNEL_TOL,
  pointSnapshot,
  PREVIEW_COLOR,
  pxToMm,
  PICK_TOL_PX,
  SELECTED,
  viewportOf,
  type DragHandle,
  type Selection,
} from '@dajia/scene-2d';

const house = demoHouse();
const view = fitStorey(house.doc, house.lowerStoreyId, 1200, 900, 60);
const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);

const sel = (...ids: string[]): Selection => ({ ids: new Set(ids) });

/**
 * 样例房一层拐角 (4000, 0) 上的两面墙：southEast 向东、stem 向北，两者的 startId
 * 是同一枚点（southWest 的 end）。共享点与非共享点在这里才分得开。
 *
 * 按坐标找墙，不按创建顺序：uuidv7 同毫秒不单调，`byKind` 又是 id 升序，
 * "第 n 面墙"这种说法在真源里没有意义（T2 的 demo.ts 为此把八面墙写成八个具名 const）。
 */
function wallsAtJunction(): { junction: WallEntity; other: WallEntity } {
  const byXY = (ax: number, ay: number, bx: number, by: number): WallEntity => {
    for (const w of house.doc.byKind('wall')) {
      if (w.storeyId !== house.lowerStoreyId) continue;
      const a = requirePoint(house.doc, w.startId, '墙端点');
      const b = requirePoint(house.doc, w.endId, '墙端点');
      if (a.x === ax && a.y === ay && b.x === bx && b.y === by) return w;
    }
    throw new Error(`样例房一层找不到 (${ax}, ${ay})→(${bx}, ${by}) 这面墙`);
  };
  return { junction: byXY(4000, 0, 8000, 0), other: byXY(4000, 0, 4000, 3000) };
}
```

> 读点坐标一律走 core 的 `requirePoint`，不写 `doc.get(id) as PointEntity`：前者在类型上是 `PointEntity`，后者把"这枚点存在且是 point"这件事从编译器手里抢过来自己扛 —— 而它恰好是 `wallCreate` 已经保证过的事，没必要用断言重写一遍，更没必要让读坐标的地方带上 `| undefined`（`noUncheckedIndexedAccess` 下 `!` 会像杂草一样长出来）。

```ts
describe('拖拽把手', () => {
  it('空选中集没有把手；选中一面墙给两个，端点与点 id 配对钉死', () => {
    const { junction } = wallsAtJunction();
    expect(dragHandlesOf(house.doc, house.lowerStoreyId, EMPTY_SELECTION, view)).toEqual([]);
    const handles = dragHandlesOf(house.doc, house.lowerStoreyId, sel(junction.id), view);
    expect(handles).toHaveLength(2);
    const start = handles.find((h) => h.end === 'start');
    const end = handles.find((h) => h.end === 'end');
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    // 角色配对：标着 'start' 的那把引用的必须是 startId。若实现把两端写反（计划 1 真反过一次），
    // 屏幕上两个把手会互换位置，而"两个把手"这条计数照过 —— 所以必须逐把对 id。
    expect(start!.pointId).toBe(junction.startId);
    expect(end!.pointId).toBe(junction.endId);
    const axis = wallAxisById(house.doc, junction.id);
    const startPx = mmToPx(view, axis.start);
    const endPx = mmToPx(view, axis.end);
    // 位置与墙多边形同一个产地（wallAxisById）：各算各的就会在斜切墙脚上错开半个把手
    expect([start!.atPx.x, start!.atPx.y]).toEqual([startPx.x, startPx.y]);
    expect([end!.atPx.x, end!.atPx.y]).toEqual([endPx.x, endPx.y]);
    // anchorPx 是"另一端"：压扁拖要的正是这个值，配错端就等于给了一条不存在的靶子
    expect([start!.anchorPx.x, start!.anchorPx.y]).toEqual([endPx.x, endPx.y]);
    expect([end!.anchorPx.x, end!.anchorPx.y]).toEqual([startPx.x, startPx.y]);
    // atMm 就是真源里那对整数毫米，没经过任何 px ↔ mm 往返（往返会漂）
    const corner = requirePoint(house.doc, junction.startId, '拐角');
    expect(start!.atMm).toEqual({ x: corner.x, y: corner.y });
    expect(Number.isInteger(start!.atMm.x) && Number.isInteger(start!.atMm.y)).toBe(true);
    // 半径要画得出来，且小于命中容差：否则"看得见却点不中"，用户只会说鼠标坏了
    expect(HANDLE_RADIUS_PX).toBeGreaterThan(0);
    expect(HANDLE_RADIUS_PX).toBeLessThan(PICK_TOL_PX);
  });

  it('别层的墙、洞口 id、楼层 id、根本不存在的 id 一律不给把手（且不抛）', () => {
    const upper = house.doc.byKind('wall').find((w) => w.storeyId === house.upperStoreyId);
    const opening = house.doc.byKind('opening')[0];
    expect(upper).toBeDefined(); // 先证明样例房真有二层墙与洞口，否则这条是空的
    expect(opening).toBeDefined();
    expect(
      dragHandlesOf(
        house.doc,
        house.lowerStoreyId,
        sel(upper!.id, opening!.id, house.lowerStoreyId, '00000000-0000-7000-8000-000000000009'),
        view,
      ),
    ).toEqual([]);
  });

  it('把手顺序与选中集的插入顺序无关（决定性与可重放）', () => {
    const { junction, other } = wallsAtJunction();
    const forward = dragHandlesOf(house.doc, house.lowerStoreyId, sel(junction.id, other.id), view);
    const backward = dragHandlesOf(house.doc, house.lowerStoreyId, sel(other.id, junction.id), view);
    expect(forward).toHaveLength(4);
    expect(backward).toEqual(forward);
    // 排序键 `${wallId}:${end}` 升序 —— 这一行就是约定的全部含义，不藏别的语义。
    // 同一面墙内 'end' 排在 'start' 前（字符串序），它只是"谁先"的凭据，不代表谁更重要。
    const keys = forward.map((h) => `${h.wallId}:${h.end}`);
    expect(keys).toEqual([...keys].sort());
  });
});
```

```ts
describe('落点与命中', () => {
  it('moveTargetOf 把浮点屏幕位置落成整数毫米，且对已是整数的输入幂等', () => {
    // 故意自造视口：0.13 px/mm 保证整数像素映射到分数毫米。
    // 不拿 `view` 做这件事 —— 它是 0.125 px/mm（T4 那条注算过），整数像素很可能本来就落在
    // 整数毫米上，那"确实有分数"这句会假红；而拿一个本来就整的输入测舍入，等于什么都没测。
    const v = viewportOf(1200, 900, { pxPerMm: 0.13, center: vec(4000, 3000) });
    const cursor = { x: 517, y: 289 };
    const raw = pxToMm(v, cursor);
    expect(raw.x % 1 !== 0 || raw.y % 1 !== 0).toBe(true); // 先证明这一发真的有分数
    const target = moveTargetOf(v, cursor);
    expect(Number.isInteger(target.x) && Number.isInteger(target.y)).toBe(true);
    // 钉住"四舍五入"这一个动作：换成 floor / ceil / trunc 都会在这里红（0.5 向正无穷侧走）
    expect(target).toEqual({ x: Math.round(raw.x), y: Math.round(raw.y) });
    // 幂等：已经是整数毫米的输入再过一遍不许漂（T6 的吸附叠在它之后，两者口径不能互相改）
    expect(moveTargetOf(v, mmToPx(v, vec(target.x, target.y)))).toEqual(target);
  });

  it('pickHandle：容差边界含等于，远处与 NaN 给 null（合成把手，不借 dragHandlesOf）', () => {
    // 合成把手的像素取整数：边界判据要精确落在 PICK_TOL_PX 上，
    // 从 mmToPx 里捞出来的浮点坐标做 `+ PICK_TOL_PX` 会因舍入误差在 `<=` 上抖。
    const handleAt = (px: number, py: number, id: string): DragHandle => ({
      wallId: id,
      end: 'start',
      pointId: `${id}-point`,
      atMm: { x: px, y: py },
      atPx: { x: px, y: py },
      anchorPx: { x: 0, y: 0 },
    });
    const handles = [handleAt(100, 40, 'a'), handleAt(300, 40, 'b')];
    expect(pickHandle(handles, { x: 100, y: 40 })?.wallId).toBe('a');
    // 与下一句是一对：答案只能由把手集合决定，不能由数组顺序决定。
    // （`dragHandlesOf` 出来的是排好序的，所以"排过序"这件事在真实路径上看不出来 ——
    // 并列的牙齿必须在这里用同一像素上的两把 synthetic 把手来试。）
    const tied = [handleAt(100, 40, 'zz'), handleAt(100, 40, 'aa')];
    expect(pickHandle(tied, { x: 100, y: 40 })?.wallId).toBe('aa');
    expect(pickHandle([...tied].reverse(), { x: 100, y: 40 })?.wallId).toBe('aa');
    // 与 T4 的 pickAt 同一口径：正好容差算命中，再多 0.01px 不算
    expect(pickHandle(handles, { x: 100 + PICK_TOL_PX, y: 40 })?.wallId).toBe('a');
    expect(pickHandle(handles, { x: 100 + PICK_TOL_PX + 0.01, y: 40 })).toBeNull();
    expect(pickHandle(handles, { x: 200, y: 40 })).toBeNull(); // 两把正中（各差 100px）都不中
    // NaN 钉的是**比较式的写法**：`!(dist <= tol)` 为真 ⇒ 跳过；若写成 `if (dist > tol) continue`，
    // NaN > tol 是 false ⇒ 不跳过，第一把把手会被当成命中（T4 第 8 条同款病，这里再守一次）。
    expect(pickHandle(handles, { x: Number.NaN, y: 40 })).toBeNull();
    expect(pickHandle(handles, { x: 100, y: Number.NaN })).toBeNull();
  });

  it('同一枚共享点上并列的两把把手：命中给唯一答案，且两把指的确实是同一个点', () => {
    const { junction, other } = wallsAtJunction();
    const corner = requirePoint(house.doc, junction.startId, '拐角');
    expect(junction.startId).toBe(other.startId); // 先证明"并列"真的是同一枚点，不是坐标恰好吧
    const both = dragHandlesOf(house.doc, house.lowerStoreyId, sel(junction.id, other.id), view);
    const at = mmToPx(view, vec(corner.x, corner.y));
    const tied = both.filter((h) => h.atPx.x === at.x && h.atPx.y === at.y);
    expect(tied).toHaveLength(2);
    expect(new Set(tied.map((h) => h.pointId)).size).toBe(1);
    const picked = pickHandle(both, at);
    expect(picked).not.toBeNull();
    expect(picked!.wallId).toBe([junction.id, other.id].sort()[0]!);
    // 换插入顺序再问一次，答案不许变："谁赢"只能取决于排序键，不能取决于 Set 的迭代序
    const shuffled = dragHandlesOf(house.doc, house.lowerStoreyId, sel(other.id, junction.id), view);
    expect(pickHandle(shuffled, at)).toEqual(picked);
  });
});
```

> 并列时"选哪一把"不影响结果，根据就是上面那两句：`tied` 的 `pointId` 只有一个值，而 `wallMoveEndpoint` 改的是**那枚点**（`{ ...moving, x, y }`），不是"点相对于某面墙的角色"。所以排序键只需要保证**唯一**，不需要保证**语义** —— 这是本任务不把 `end` 排进优先级的原因。


```ts
describe('合法落点与拖拽探针', () => {
  it('legalDrop 就是真源那道守卫的预言：合法 true、压扁给 false，而 false 那一发真的抛', () => {
    const { junction, other } = wallsAtJunction();
    const corner = requirePoint(house.doc, junction.startId, '拐角');
    const farEnd = requirePoint(house.doc, junction.endId, '另一端点');
    // (4000, 1200)：southEast 变 4326、southWest 变 4000、stem 变 1800，三面都远大于各自墙厚
    expect(legalDrop(house.doc, junction.id, 'start', { x: corner.x, y: corner.y + 1200 })).toBe(true);
    // 拖到自己另一端上：判据不许 scene-2d 自己重算一遍轴长，它试跑的就是 core 的那道守卫
    expect(legalDrop(house.doc, junction.id, 'start', { x: farEnd.x, y: farEnd.y })).toBe(false);
    expect(() =>
      wallMoveEndpoint({ wallId: junction.id, end: 'start', x: farEnd.x, y: farEnd.y }).build(
        house.doc,
      ),
    ).toThrow(/零长墙/);
    // 最要紧的第三条：坏的不是被拖那面墙，是**邻墙**。junction（southEast）拖到 (4000, 3000)
    // 自己变 4272、southWest 变 5000，两头都合格；只有 stem 的两端重合了。
    // 屏幕上若要自己算，算的必然是"我这一面够不够长" ⇒ 判成 true ⇒ 松手才报错。
    const stemFar = requirePoint(house.doc, other.endId, 'stem 另一端点');
    expect([corner.x, corner.y]).not.toEqual([stemFar.x, stemFar.y]); // 空话防线：两个落点别是同一个
    expect(legalDrop(house.doc, junction.id, 'start', { x: stemFar.x, y: stemFar.y })).toBe(false);
    expect(() =>
      wallMoveEndpoint({
        wallId: junction.id,
        end: 'start',
        x: stemFar.x,
        y: stemFar.y,
      }).build(house.doc),
    ).toThrow(/变成零长/); // 红在邻墙那条，不是红在别的守卫上
    // 试跑不许留下痕迹：house.doc 是下面每一条共用的那份文档，被写脏了后面全不可信
    expect(requirePoint(house.doc, junction.startId, '拐角')).toEqual(corner);
  });

  it('探针只认共享点：一面孤墙（两端都没有第二面墙指着）返回 null', () => {
    const projectId = uuidv7();
    const log = new TransactionLog(Document.create(projectId));
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    const storeyId = [...log.affected].find((id) => log.document.get(id)?.kind === 'storey')!;
    log.dispatch(
      wallCreate({
        storeyId,
        start: { x: 0, y: 0 },
        end: { x: 4000, y: 0 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    );
    const wallId = [...log.affected].find((id) => log.document.get(id)?.kind === 'wall')!;
    const v = fitStorey(log.document, storeyId, 1200, 900, 60);
    // 孤墙上"选中它给两个把手"照样成立 ⇒ 上一个用例没把把手和共享点混为一谈
    expect(dragHandlesOf(log.document, storeyId, sel(wallId), v)).toHaveLength(2);
    expect(
      dragProbe(log.document, storeyId, buildDrawList(log.document, storeyId, v, EMPTY_SELECTION), v),
    ).toBeNull();
  });

  it('探针给的落点必然合法、必然真的移动、锚点必然不合法、三枚像素全为整数，且 fromPx 先点必选中那面墙', () => {
    const probe = dragProbe(house.doc, house.lowerStoreyId, ops, view);
    expect(probe).not.toBeNull(); // 样例房一层有六枚共享端点 ⇒ 拿不到靶子是探针坏了，不是没素材
    const p = probe!;
    expect(p.sharedBy).toBeGreaterThanOrEqual(2);
    const point = requirePoint(house.doc, p.pointId, '探针点');
    expect([p.targetMm.x, p.targetMm.y]).not.toEqual([point.x, point.y]); // 真的移动，不是原地空放
    expect(legalDrop(house.doc, p.wallId, p.end, p.targetMm)).toBe(true);
    expect(legalDrop(house.doc, p.wallId, p.end, moveTargetOf(view, p.anchorPx))).toBe(false);
    // 探针报的毫米必须是**它那对像素的不动点**（`moveTargetOf(view, toPx) === targetMm`）。
    // 上面那句 `legalDrop` 判的就是这一对毫米，所以三句话连起来才成立：
    // 探针说合法 → renderer 松手算出同一对毫米 → 命令必然成功 → `--edit-shot` 才许拿"逐字相等"当判据。
    expect(moveTargetOf(view, p.toPx)).toEqual(p.targetMm);
    // 三枚像素必须全是整数：`sendInputEvent` 只收整数 DIP，主进程一发 `Math.round` 就把落点
    // 挪到另一对毫米上（fitStorey 的 0.13 px/mm 下差 1~4mm），上面那句"不动点"立刻变成随机红。
    // 摘掉 `snapPx` 这里必须红 —— 这条断言是 `--edit-shot` 第 0 步与第 3 步的地基。
    for (const spot of [p.fromPx, p.toPx, p.anchorPx]) {
      expect(Number.isInteger(spot.x) && Number.isInteger(spot.y)).toBe(true);
    }
    // D5 的"拖之前先选中"能在真窗口里成立，靠的就是这一句：起点那一发点选中的就是被拖那面墙
    expect(pickOne(ops, p.fromPx)?.ownerId).toBe(p.wallId);
    expect(p.fromPx.x).toBeGreaterThanOrEqual(0);
    expect(p.fromPx.x).toBeLessThanOrEqual(view.widthPx);
    expect(p.fromPx.y).toBeGreaterThanOrEqual(0);
    expect(p.fromPx.y).toBeLessThanOrEqual(view.heightPx);
  });

  it('探针幂等：同一份文档连问两次逐字节相同（回读判据不许每次跑给出不同靶子）', () => {
    expect(dragProbe(house.doc, house.lowerStoreyId, ops, view)).toEqual(
      dragProbe(house.doc, house.lowerStoreyId, ops, view),
    );
  });
});

describe('回读用的投影与配色', () => {
  it('pointSnapshot 的键集合恰是本层墙端点的去重集（多一个少一个都红）', () => {
    const snap = pointSnapshot(house.doc, house.lowerStoreyId);
    const lower = house.doc.byKind('wall').filter((w) => w.storeyId === house.lowerStoreyId);
    const upper = house.doc.byKind('wall').filter((w) => w.storeyId === house.upperStoreyId);
    const lowerIds = new Set(lower.flatMap((w) => [w.startId, w.endId]));
    expect(lowerIds.size).toBeGreaterThan(0); // 空样本会让下面全部断言变成恒真
    // 键集合**就是**本层全部墙端点：混进别层的点、或漏掉共享点（去重后少一枚）都红
    expect(Object.keys(snap).sort()).toEqual([...lowerIds].sort());
    for (const id of lowerIds) {
      const point = requirePoint(house.doc, id, '端点');
      expect(snap[id]).toEqual({ x: point.x, y: point.y });
      expect(Number.isInteger(snap[id]!.x) && Number.isInteger(snap[id]!.y)).toBe(true);
    }
    for (const w of upper) {
      // 同一件事的第二证法：别层的两枚端点都不该在表里
      expect(snap[w.startId]).toBeUndefined();
      expect(snap[w.endId]).toBeUndefined();
    }
  });

  it('三种颜色两两之间最大通道差 > 2×PIXEL_CHANNEL_TOL ⇒ 像素计数不会串道', () => {
    const rgb = (hex: string): [number, number, number] => [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
    ];
    const spread = (a: string, b: string): number => {
      const ca = rgb(a);
      const cb = rgb(b);
      return Math.max(...ca.map((c, k) => Math.abs(c - cb[k]!)));
    };
    // 每一侧的认色窗口宽 2×TOL（±TOL），两窗口不重叠 ⇔ 最大通道差 > 2×TOL。
    // 三对分开写而不是套循环：红了直接知道是哪一对颜色串道，不必再反推 i/j。
    const min = PIXEL_CHANNEL_TOL * 2;
    expect(spread(SELECTED, HANDLE_COLOR)).toBeGreaterThan(min);
    expect(spread(SELECTED, PREVIEW_COLOR)).toBeGreaterThan(min);
    expect(spread(HANDLE_COLOR, PREVIEW_COLOR)).toBeGreaterThan(min);
  });
});
```


**Step 3 的 `it` 合计 12 条**（把手 3 + 落点命中 3 + 探针 4 + 快照配色 2）。跑红时应当是 `dragHandlesOf is not a function` 一类的 import 解析失败（`handles.ts` 还不存在），不是断言失败 —— 这两件事分不开就说明 Step 3 的材料有问题，先回头核对再进 Step 4。


- [ ] **Step 4: scene-2d —— 实现 `handles.ts`，跑绿，再逐条改坏**

`packages/scene-2d/src/handles.ts` 整份新建：

```ts
import {
  endPointId,
  incidentWallEnds,
  quantizeMm,
  requirePoint,
  wallAxisById,
  wallMoveEndpoint,
  type Document,
  type WallEnd,
} from '@dajia/core';
import { mmToPx, pxToMm, type Px, type Viewport } from './viewport';
import type { DrawOp, Selection } from './drawlist';
import { PICK_TOL_PX, pickOne } from './pick';

/**
 * 编辑器画在屏幕上、却**不进指令表**的那一层（Task 5 D2）：把手、拖拽临时线、
 * 以及"这个落点拖不拖得动"的预言。
 *
 * 为什么不进 `buildDrawList`：那张表是**图纸内容的投影** —— 计划 4 的像素判据与计划 5 的
 * 可施工图都直接吃它，把蓝点掺进去等于往施工图上印编辑器家具，而"指令表还是 31 条"
 * 这类回归判据恰好看不见多印了什么。代价是这个文件外面要再多两个画家（PlanCanvas 的
 * `paintHandles` / `paintPreview`），"只有一条绘制通路"这条纪律改由像素计数来守（Step 5/6）。
 */

/**
 * 三种颜色给 `countPixels` 认道：选中（红）、把手（蓝）、临时线（绿）。
 * 两两最大通道差必须 > 2×`PIXEL_CHANNEL_TOL`（`handles.test.ts` 最后一条钉死）：
 * 认色是按通道 ±TOL 开窗的，两种颜色挨太近时同一片像素会同时进两个桶，
 * Step 6 的 `handlePx` / `previewPx` 就全是假绿。#1668dc 与 #12b886 的差只在 G/B 上
 * （104↔184、220↔134，最大 86 > 80），挨得不远 —— 所以改任何一个字面量都要回去跑那条。
 */
export const HANDLE_COLOR = '#1668dc';
export const PREVIEW_COLOR = '#12b886';
export const PIXEL_CHANNEL_TOL = 40;
export const HANDLE_RADIUS_PX = 4.5;

/** 落在真源上的整数毫米。与 core 的 `Vec2` 结构相同，但语义是"已过 quantizeMm"。 */
export interface MoveTarget {
  readonly x: number;
  readonly y: number;
}

/**
 * 屏幕像素 → 真源整数毫米的唯一出口（D4）。T6 的吸附（端点/中点/15°）插在它**之后**、
 * `dispatch` 之前，不许有第二条 px→mm 的路绕过这里。
 *
 * 非有限输入（NaN / ±Infinity）由 `quantizeMm` 直接抛 RangeError：指针事件的坐标恒为有限数，
 * 真出 NaN 说明上面有人算了个 0/0 —— 那种东西静默兜成 0 就是"一拖就飞到原点"，
 * 比当场崩掉难查得多。调用方（PlanCanvas 的落点分支）整段包在 try/catch 里报 `lastError`。
 */
export function moveTargetOf(v: Viewport, cursorPx: Px): MoveTarget {
  const mm = pxToMm(v, cursorPx);
  return { x: quantizeMm(mm.x), y: quantizeMm(mm.y) };
}

/** 一枚可拖把手：`end` 与 `pointId` 配对钉死（计划 1 的角色反转 bug 就是这个配对松开过）。 */
export interface DragHandle {
  readonly wallId: string;
  readonly end: WallEnd;
  readonly pointId: string;
  /** 真源里那对整数毫米，直读实体，不做任何 px ↔ mm 往返。 */
  readonly atMm: MoveTarget;
  /** 它在线上的哪一端：与 `wallAxisById` 同源，所以和墙多边形永远对齐。 */
  readonly atPx: Px;
  /** 另一端：拖到这里必然'零长墙'，压扁拖的回读判据要的就是这个值。 */
  readonly anchorPx: Px;
}

/** 排序键：代码单元序，和 `Array.prototype.sort()` 默认序一致（测试拿它当定义比）。
 *  绝不用 `localeCompare` —— 它对 `-` 与数字的排序规则跟代码单元序不同，两边会各排各的。 */
function handleKey(h: DragHandle): string {
  return `${h.wallId}:${h.end}`;
}

const WALL_ENDS: readonly WallEnd[] = ['start', 'end'];

/**
 * 把手只从**当前选中集**里生（D5）：入参 `sel` 就是 paint effect 刚拿去上色的那份 `ids`，
 * 于是"屏幕上红着的"与"屏幕上能拖的"不可能是两批构件。
 * 返回顺序只服务一件事：确定性（同文档同选中集 ⇒ 同数组），不给 `start` 排前面这种语义。
 */
export function dragHandlesOf(
  doc: Document,
  storeyId: string,
  sel: Selection,
  v: Viewport,
): DragHandle[] {
  const out: DragHandle[] = [];
  for (const id of sel.ids) {
    const wall = doc.get(id);
    // 三种"不是本层墙"的 id（洞口的、楼层的、已经不存在的）一律跳过，不抛：
    // 选中集来自点选，而那枚构件可能在两次渲染之间被撤销掉 —— 抛出去就是白屏。
    if (wall?.kind !== 'wall') continue;
    // 别层的墙不给把手：两层各自建面点，跨层拖一发就是拿一层的坐标去改另一层的点
    // （`wallCreate` 的 resolvePointRef 明确禁止跨层复用点，这里不能给 UI 开后门）。
    if (wall.storeyId !== storeyId) continue;
    const axis = wallAxisById(doc, wall.id);
    for (const end of WALL_ENDS) {
      const pointId = endPointId(wall, end);
      const point = requirePoint(doc, pointId, '墙端点');
      out.push({
        wallId: wall.id,
        end,
        pointId,
        // atMm 直读实体、atPx 走轴线：两个产地同一个数字，用例分别钉（H1）。
        // 只从轴取 atMm 的话，"轴算错了"和"点被人改了"会红在同一条断言上。
        atMm: { x: point.x, y: point.y },
        atPx: mmToPx(v, end === 'start' ? axis.start : axis.end),
        anchorPx: mmToPx(v, end === 'start' ? axis.end : axis.start),
      });
    }
  }
  return out.sort((a, b) => {
    const ka = handleKey(a);
    const kb = handleKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * 命中把手：排在 `pickOne` **之前**的独立一趟（D2 说的"比层序更强"就是这里）。
 * 容差沿用 `PICK_TOL_PX`：屏幕上"点得中一条线"与"点得中一个点"该是同一个手感。
 *
 * 不要求入参已排序：并列时按 `handleKey` 升序取第一个，所以结果只由把手集合决定，
 * 不由谁先塞进数组决定（H6 的"洗牌再问一次"靠这句成立）。
 * 循环里是 `!(dist <= tolPx)` 而不是 `if (dist > tolPx) continue` —— 后者会让 NaN 混进命中。
 */
export function pickHandle(
  handles: readonly DragHandle[],
  point: Px,
  tolPx: number = PICK_TOL_PX,
): DragHandle | null {
  let best: DragHandle | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  let bestKey = '';
  for (const h of handles) {
    const dist = Math.hypot(h.atPx.x - point.x, h.atPx.y - point.y);
    if (!(dist <= tolPx)) continue;
    const key = handleKey(h);
    if (best === null || dist < bestDist || (dist === bestDist && key < bestKey)) {
      best = h;
      bestDist = dist;
      bestKey = key;
    }
  }
  return best;
}

/**
 * "这一发拖得动吗" = 拿真命令试跑一次（D3）。绝不在屏幕上重写一遍轴长比较：
 * `wallMoveEndpoint` 的守卫有六道（本墙零长、本墙墙厚、每面邻墙零长、每面邻墙墙厚、
 * 墙缩短后洞口放不下、重影柱），少抄一道就是"看着能拖、松手才报错"。第三条用例专门
 * 挑"本墙合格、邻墙被拖成零长"那种落点 —— 自己算的写法唯一会漏的就是它。
 *
 * 试跑安全的前提（读过源码才敢这么写）：`build` 是纯函数 —— 不新建实体（这个命令里一个
 * `uuidv7` 都没有）、不改文档、同一入参两次调用结果逐字节相同。
 * `catch` 宽到一切异常是有意的：连墙 id 打错这种 TypeError 也只有一种回答 —— 不能拖。
 */
export function legalDrop(
  doc: Document,
  wallId: string,
  end: WallEnd,
  target: MoveTarget,
): boolean {
  try {
    wallMoveEndpoint({ wallId, end, x: target.x, y: target.y }).build(doc);
    return true;
  } catch {
    return false;
  }
}

/** 一次自动拖拽的全部坐标：`--edit-shot` 只读它，不猜靶子。 */
export interface DragProbe {
  readonly wallId: string;
  readonly end: WallEnd;
  readonly pointId: string;
  /** 几面墙指着这个点（>= 2）：孤墙拖了证不出"邻墙跟着动"，那才是回读要判的事。 */
  readonly sharedBy: number;
  /** 三枚像素全部取整（见 `snapPx`）：回读脚本发得出、renderer 反算得回同一个毫米。 */
  readonly fromPx: Px;
  readonly toPx: Px;
  readonly anchorPx: Px;
  readonly targetMm: MoveTarget;
}

/**
 * `sendInputEvent` 只收整数 DIP，而 renderer 松手时算的是 `moveTargetOf(视图, 那一发整数像素)`。
 * 所以探针**先取整像素、再由像素反算毫米**：这样"探针给的毫米"与"屏幕上真会落下的毫米"
 * 是同一个纯函数的同一个输出，不是近似。反过来（先定毫米再算像素）会在 0.125 px/mm 这种
 * 比例上差出最多 4mm —— 回读判据就会变成"有时候差一点"的随机红。
 */
function snapPx(p: Px): Px {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/**
 * 候选落点按顺序试，第一个"取整后真的动了且合法"的赢。偏移全写成整数毫米 ⇒ 同一份文档、
 * 同一个视图，每次问都给出同一个靶子（"撤销后回到原值"这条判据的前提就是靶子可复现）。
 */
const PROBE_OFFSETS: readonly MoveTarget[] = [
  { x: 0, y: 800 },
  { x: 800, y: 0 },
  { x: 0, y: -800 },
  { x: -800, y: 0 },
  { x: 600, y: 600 },
  { x: -600, y: 600 },
  { x: 600, y: -600 },
  { x: -600, y: -600 },
  { x: 0, y: 2400 },
  { x: 2400, y: 0 },
];

/**
 * 找一个"值得自动拖"的共享端点。返回 null 是合法结果（空层、孤墙层）。
 *
 * 注意它返回的是**哪面墙**取决于样例房每次现建的 uuidv7（接头处三面墙叠在同一片像素上，
 * 谁赢由 T4 的层序 + ownerId 排序决定），所以调用方与测试都只判性质，不判具体 id。
 */
export function dragProbe(
  doc: Document,
  storeyId: string,
  ops: readonly DrawOp[],
  v: Viewport,
): DragProbe | null {
  const wallIds = doc
    .byKind('wall')
    .filter((w) => w.storeyId === storeyId)
    .map((w) => w.id);
  // dragHandlesOf 已排序 ⇒ 这一趟的候选顺序与"谁在选中集里先插入"无关
  for (const h of dragHandlesOf(doc, storeyId, { ids: new Set(wallIds) }, v)) {
    const sharedBy = incidentWallEnds(doc, h.pointId).length;
    if (sharedBy < 2) continue;
    const fromPx = snapPx(h.atPx);
    // D5 的前提要在真窗口里成立，这一句是根：那一发点下去必须选中被拖那面墙。
    // 判的是**取整后**的像素 —— 回读脚本发的就是它，不是 h.atPx 那个浮点数。
    // 选不中就换一把 —— 而不是拖一面"屏幕上没红着的"墙。
    if (pickOne(ops, fromPx)?.ownerId !== h.wallId) continue;
    for (const off of PROBE_OFFSETS) {
      const toPx = snapPx(mmToPx(v, { x: h.atMm.x + off.x, y: h.atMm.y + off.y }));
      const targetMm = moveTargetOf(v, toPx);
      // 极小比例视图下取整会把这一发抹回原地：那不是"移动"，撤销/重做判据会全部空转，换下一个候选。
      if (targetMm.x === h.atMm.x && targetMm.y === h.atMm.y) continue;
      if (!legalDrop(doc, h.wallId, h.end, targetMm)) continue;
      return {
        wallId: h.wallId,
        end: h.end,
        pointId: h.pointId,
        sharedBy,
        fromPx,
        toPx,
        anchorPx: snapPx(h.anchorPx),
        targetMm,
      };
    }
  }
  return null;
}

/**
 * 本层全部墙端点的整数毫米，给 `--edit-shot` 当回读快照（"拖动前 vs 拖动后 vs 撤销后"）。
 * 只走墙端点，不遍历 `byKind('point')`：真源里的 point 只被墙/柱/板引用，而本任务的
 * 判据全部关于墙 —— 顺带把"别层的点漏进来"变成可红的断言（快照口径与 `dragHandlesOf` 的层过滤一致）。
 */
export function pointSnapshot(doc: Document, storeyId: string): Record<string, MoveTarget> {
  const out: Record<string, MoveTarget> = {};
  for (const wall of doc.byKind('wall')) {
    if (wall.storeyId !== storeyId) continue;
    for (const id of [wall.startId, wall.endId]) {
      if (out[id] !== undefined) continue; // 共享点只记一次
      const point = requirePoint(doc, id, '墙端点');
      out[id] = { x: point.x, y: point.y };
    }
  }
  return out;
}
```

`packages/scene-2d/src/index.ts` 末尾追加一行（与 T2/T4 同形）：

```ts
export * from './handles';
```

Run: `npx vitest run packages/core/test/commands-drag.test.ts packages/scene-2d/test/handles.test.ts > /tmp/t5-green.log 2>&1; echo exit=$?`
Expected: exit=0，`Test Files 2 passed`、`Tests 19 passed`（core 7 + scene-2d 12）。

逐条改坏，每条做完立刻改回来：

1. `dragHandlesOf` 删掉 `if (wall?.kind !== 'wall') continue;` → 「别层的墙、洞口 id…」必须红，且**红在 `TypeError`**（`requirePoint` 报"不是 point 实体"）而不是红在断言 —— 它守的是入口。
2. 删掉 `if (wall.storeyId !== storeyId) continue;` → 同一条用例必须红在"给了 2 个把手"（二层的墙在一层长出把手 ⇒ 一发拖动能改两层的坐标，这是两层房最贵的错）。
3. `atMm` 改成从 `atPx` 反算（`moveTargetOf(v, mmToPx(v, point))`）→ **不许红**：整数毫米过一轮 px↔mm 往返还是它自己，这条改动只多算不改变输出。它是反向哨兵，证明第 1、2 条不是连带崩。（真要钉"不许往返"，靠的是 `atMm` 与 `atPx` 分别比对不同产地那两句。）
4. `handleKey` 从 `${wallId}:${end}` 改成只按 `end` → 「把手顺序与插入顺序无关」必须红在 `keys` 排序那句（并列项退化成插入序），`pickHandle` 的并列用例必须红在 `pickHandle(shuffled)` 与 `picked` 不再相等。
5. `pickHandle` 的 `!(dist <= tolPx)` 改成 `if (dist > tolPx) continue` → 两条 NaN 用例必须红（NaN 比较恒 false ⇒ 不跳过 ⇒ 第一把把手被当成命中）。与 T4 第 8 条同源。
6. `dist === bestDist && key < bestKey` 里的 `key` 比较删掉（并列时先来后到）→ 合成把手那条必须红在 `pickHandle([...tied].reverse(), …)` 这一句（答案跟着数组顺序翻）。真实路径上的两句（`picked.wallId` 与 `shuffled`）都**不会**红 —— 因为 `dragHandlesOf` 已经排过序，并列项的先后恰好等于键的先后。所以这对 synthetic 并列把手不是装饰，它是这条判据唯一的牙齿。
7. `pickHandle` 入口补一条 `if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;` → **不许红**：NaN 的牙齿在循环里那个比较式上，入口这条是防御不是判据（写了不坏，但别以为它在守什么）。
8. `legalDrop` 换成"只判被拖这面墙自己"（自己算 `hypot(target, anchor) > thickness`）→ 第三条用例必须红（`stem` 被拖成零长那个落点被判成 true）。**这条是 D3 的全部理由**：屏幕上自己算判据，算的永远是"我这一面"。
9. `PROBE_OFFSETS` 最前面插一条 `{ x: 0, y: 0 }` → 探针那条必须红在 `[p.targetMm.x, p.targetMm.y]).not.toEqual([point.x, point.y])`（靶子原地不动，撤销/重做判据全成空转）。
10. 摘掉 `snapPx`（`fromPx`/`toPx`/`anchorPx` 直接返回 `mmToPx` 的浮点，`targetMm` 仍由它算）→ 「三枚像素全为整数」那三条必须红。它是 `--edit-shot` 第 3 步"落点逐字相等"的地基：主进程发事件前必定 `Math.round`，探针不给整数就是拿浮点跟主进程对赌。
11. 探针的像素↔毫米**反向**对调（`targetMm = moveTargetOf(v, h.atPx)`、`toPx = mmToPx(v, h.atMm)`）→ 两条必须同时红：「三枚像素全为整数」（`toPx` 是浮点）与「落点必然合法」（落点退回原地，`legalDrop` 那条判的是原地）。反向哨兵：它对"干脆把两个字段都返回原坐标"这类整段写反的改动有牙齿，而第 10 条只在 `snapPx` 内部。
12. `dragProbe` 删掉 `pickOne(ops, fromPx)?.ownerId !== h.wallId` 那一句 → **不保证红**：接头处哪面墙赢取决于每次现建的 uuidv7，样例房这局可能本来就选中它。它的凭据在 Step 6 —— `--edit-shot` 里"按在把手上即选中那面墙"那条判据（`selectedAfterPress === edit.wallId`）必须成立，那是真窗口里同一份文档上的确定断言。改了不红，也不许反过来删探针那句。
13. `pointSnapshot` 删掉 `storeyId` 过滤 → 快照那条必须红在键集合（别层的点漏进来）。
14. `pointSnapshot` 的循环只收 `wall.startId` → 同一条必须红在键集合（少一半）；`for (const id of [startId, endId])` 换成 `for (const id of [wall.startId, wall.startId])` 也一样红。
15. 摘掉 `wall.ts` 里 Step 1 加的那行 `assertNoGhostColumn` → core 侧 G2 必须红，G1/G3/G4/G5 必须还绿（复核只有"拖带着柱的端点"这一条路在用，别的产地各自有守卫）。
16. `assertNoGhostColumn` 的 `if (column.storeyId !== storeyId) continue;` 删掉（跨层也判）→ G4 正对照必须红。
17. `wall.ts` 调用处不传 `exceptPointId` → G5 必须红（原地拖报"该坐标已有柱"）。
18. 判据从坐标比较改成 `column.pointId === point.id` 比较 → G2 必须红（两根柱两个点、同一坐标 ⇒ 瞎了），既有 `commands-column-slab.test.ts` 的 `/已有柱/` 那条也会红。

1–2、4–11、13–18 里任何一条"改坏了还绿"，说明那条断言写空了，就地补到能红为止；第 3、7 两条反过来，**必须还绿**（它们测的是"改动没坏但也没变"这一类）。**一条不会红的测试比没有测试更糟**，而一条"以为在守、其实没守"的防御代码比没有更糟 —— 3、7 两条就是专门写来把这两件事分开的。第 12 条按"改坏不一定红、凭据在 Step 6"处理。把每条命令与关键红字写进提交信息。

- [ ] **Step 5: desktop —— `revision` 扳机、把手状态机、两个画家**

`apps/desktop/src/renderer/src/stores/editorStore.ts` 整份换成：

```ts
import { create } from 'zustand';
import type { Command, TransactionLog, WallEnd } from '@dajia/core';
import { demoHouse, type MoveTarget, type Px, type Viewport } from '@dajia/scene-2d';

// demoHouse() 只调一次（T3 的理由照旧：调两次就是"屏幕画 B、命中查 A"，且不报错）。
const demo = demoHouse();

/** 一次进行中的拖拽。中途只活在这里，不进真源（D4）。 */
export interface DragState {
  readonly wallId: string;
  readonly end: WallEnd;
  readonly pointId: string;
  /** 按下那一发从真源读到的坐标：松手回到它 ⇒ noop，一个字都不写。 */
  readonly atMm: MoveTarget;
  readonly fromPx: Px;
  readonly cursorPx: Px;
  readonly targetMm: MoveTarget;
}

export interface EditorState {
  readonly log: TransactionLog;
  readonly storeyId: string;
  /** null = 还没量过窗口尺寸，一帧都还没画 */
  readonly viewport: Viewport | null;
  /**
   * 唯一的"该重绘了"扳机（D6）。`log` 是可变类实例，引用永远不变 ⇒ zustand 的
   * `Object.is` 判定相等 ⇒ 只订阅 `{log}` 的组件**永不重渲**，所以这不是保险，是唯一的通路。
   * 它只在 `dispatch`/`undo`/`redo` **成功**之后 +1：失败不动它 ⇒ 既不重绘也无副作用，
   * 于是计划 2 转下游 #11（`log.lastAffected` 在抛错后留着上一批 id）在本任务里根本没有读者。
   */
  readonly revision: number;
  readonly lastError: string | null;
  readonly drag: DragState | null;
  setViewport: (viewport: Viewport | null) => void;
  setDrag: (drag: DragState | null) => void;
  dispatch: (cmd: Command) => void;
  undo: () => void;
  redo: () => void;
}

export const useEditor = create<EditorState>((set, get) => ({
  log: demo.log,
  storeyId: demo.lowerStoreyId,
  viewport: null,
  revision: 0,
  lastError: null,
  drag: null,
  setViewport: (viewport) => set({ viewport }),
  setDrag: (drag) => set({ drag }),
  // 失败路径**必须**只动 lastError：动 revision 就是"为一件没发生的事重绘整张图"。
  dispatch: (cmd) => {
    try {
      get().log.dispatch(cmd);
    } catch (err) {
      set({ lastError: `拖不动：${String(err)}` });
      return;
    }
    set((s) => ({ revision: s.revision + 1, lastError: null }));
  },
  undo: () => {
    if (!get().log.undo()) {
      set({ lastError: '没有可撤销的操作' }); // D7：栈空要给反馈，不许静默返回 false
      return;
    }
    set((s) => ({ revision: s.revision + 1, lastError: null }));
  },
  redo: () => {
    if (!get().log.redo()) {
      set({ lastError: '没有可重做的操作' });
      return;
    }
    set((s) => ({ revision: s.revision + 1, lastError: null }));
  },
}));
```

> **`dispatch` 里没有 `legalDrop` 预检，这是刻意的**（D3/D6 的接缝，执行时最容易"顺手补错"的一处）：renderer 直接发命令，让真源的守卫在 `build` 里抛，`catch` 写 `lastError`、`revision` 不动。若在发之前先 `legalDrop` 判一次，压扁拖就在屏幕上变成"没反应"，`--edit-shot` 第 8 条（失败不留痕迹）与整条 #11 的落地凭据就**永远测不到**了。`legalDrop` 现在的读者只有 `dragProbe`（Step 4）与 T6 的合法/非法预览线。它和 `dispatch` 判的是同一份算式，这一点由 `handles.test.ts` 第 7 条钉住，不需要在拖放路径上再套一层。
>
> **`set` 里没有 `drag: null`**：松手时谁清 `drag` 谁负责（PlanCanvas 的 `onUp`），store 不在命令路径上偷偷改视图态 —— 否则"拖完临时线还在屏幕上"这种残留只能靠约定来防。

`apps/desktop/src/renderer/src/PlanCanvas.tsx` 整体替换（T4 那份的骨架保留：`opsRef`、`countPixels`、`whenLoaded` 那套绘制顺序注释都不动，加把手画家、拖拽状态机、撤销快捷键，`DebugReport` 补 12 个字段）：

```tsx
import { useEffect, useRef } from 'react';
import { requirePoint, wallMoveEndpoint } from '@dajia/core';
import {
  buildDrawList,
  dragHandlesOf,
  dragProbe,
  fitStorey,
  HANDLE_COLOR,
  HANDLE_RADIUS_PX,
  moveTargetOf,
  pickHandle,
  pickOne,
  PIXEL_CHANNEL_TOL,
  pointSnapshot,
  PREVIEW_COLOR,
  probeTarget,
  SELECTED,
  type DragHandle,
  type DragProbe,
  type DrawOp,
  type Pen,
  type PickProbe,
  type Px,
} from '@dajia/scene-2d';
import { useEditor } from './stores/editorStore';
import { useSelection } from './stores/selectionStore';

export interface DropReport {
  outcome: 'ok' | 'noop' | 'failed';
  wallId: string;
  end: string;
  targetMm: { x: number; y: number };
  /** 松手那一刻从真源读到的坐标（不是命令参数）：ok 与 failed 的分界要靠它。 */
  pointMm: { x: number; y: number };
}

export interface KeyEventReport {
  /**
   * 每一发被 renderer 处理的 keydown 递增一次。**判据不能只靠 `combo`**：第 8 步的
   * "空栈再按 Ctrl+Shift+Z"与第 6 步的"重做 Ctrl+Shift+Z"是同一串字面量，而空栈那一发
   * 故意什么都不改（`depth`、`revision`、坐标全不动，只换一句中文）⇒ 真源侧没有任何字段
   * 能证明它到过。`waitKeyApplied` 等的就是这个数变大，`combo` 只用来证"回声的是那一发"。
   */
  seq: number;
  combo: string;
  depth: number;
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
  lastError: string | null;
}

export interface DebugReport {
  ops: number;
  layers: Record<string, number>;
  nonBlankPx: number;
  wPx: number;
  hPx: number;
  selectedIds: string[];
  selectedPx: number;
  pick: PickProbe | null;
  selectedAfterBlank: number;
  // ↓ T5 的 12 个
  revision: number;
  depth: number;
  canUndo: boolean;
  canRedo: boolean;
  lastError: string | null;
  handlePx: number;
  previewPx: number;
  /** 临时线中离**当前光标** 2px 内的那一撮：只有 `previewPx` 分不出"跟手的线"与"钉在按下点的线"。 */
  previewNearCursorPx: number;
  points: Record<string, { x: number; y: number }>;
  edit: DragProbe | null;
  lastDrop: DropReport | null;
  lastKeyEvent: KeyEventReport | null;
}

declare global {
  interface Window {
    __dajiaDebug?: () => DebugReport;
  }
}

const DASH: Record<Pen['lineType'], number[]> = {
  solid: [],
  dashed: [6, 4],
  'dash-dot': [12, 4, 2, 4],
};

const BG = '#ffffff';

/** 临时线的虚实：比轴线更疏一点，免得和 `DASH.dashed` 的轴线混成一类。 */
const PREVIEW_DASH = [4, 3];

function rgbOf(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

const SEL_RGB = rgbOf(SELECTED);
const HANDLE_RGB = rgbOf(HANDLE_COLOR);
const PREVIEW_RGB = rgbOf(PREVIEW_COLOR);

/**
 * 抗锯齿让线边缘是渐变而不是纯色，所以按通道 ±TOL 数，不比 RGB 全等（T4 的口径）。
 * 容差取自 `handles.ts` 的 `PIXEL_CHANNEL_TOL`：判据与画家不许各拿一个数 ——
 * `handles.test.ts` 最后那条"三种颜色互相分得开"用的也是它。
 */
function nearChannel(px: number, target: number): boolean {
  return Math.abs(px - target) <= PIXEL_CHANNEL_TOL;
}

/** 没有 ctx 时（理论分支）用的零值，与 `countPixels` 的返回同一形状。 */
const NO_PIXELS: Buckets = {
  nonBlankPx: 0,
  selectedPx: 0,
  handlePx: 0,
  previewPx: 0,
  previewNearCursorPx: 0,
};

function paint(ctx: CanvasRenderingContext2D, ops: readonly DrawOp[]): void {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.lineCap = 'round';
  for (const op of ops) {
    ctx.strokeStyle = op.pen.color;
    ctx.lineWidth = op.pen.widthPx;
    ctx.setLineDash(DASH[op.pen.lineType]);
    if (op.kind === 'polygon') {
      ctx.beginPath();
      op.pts.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      if (op.fill !== null) {
        ctx.fillStyle = op.fill;
        ctx.fill();
        ctx.fillStyle = BG;
      }
      ctx.stroke();
    } else if (op.kind === 'line') {
      ctx.beginPath();
      ctx.moveTo(op.from.x, op.from.y);
      ctx.lineTo(op.to.x, op.to.y);
      ctx.stroke();
    } else {
      ctx.setLineDash([]);
      ctx.fillStyle = op.pen.color;
      ctx.font = `${String(op.sizePx)}px system-ui, sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.fillText(op.text, op.at.x, op.at.y);
    }
  }
  ctx.setLineDash([]);
}

/** D2：把手不进指令表，所以它有专用画家。圆而不是方块 —— 端点上盖得住、旁边盖不住。 */
function paintHandles(ctx: CanvasRenderingContext2D, handles: readonly DragHandle[]): void {
  ctx.fillStyle = HANDLE_COLOR;
  for (const h of handles) {
    ctx.beginPath();
    ctx.arc(h.atPx.x, h.atPx.y, HANDLE_RADIUS_PX, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 拖拽中的临时线：起点是按下那一发的像素，终点是当前光标（不是 targetMm 的像素 ——
 *  中途要让光标指哪画哪，落点那对整数毫米是松手才生效的东西）。 */
function paintPreview(
  ctx: CanvasRenderingContext2D,
  fromPx: Px,
  cursorPx: Px,
): void {
  ctx.strokeStyle = PREVIEW_COLOR;
  ctx.fillStyle = PREVIEW_COLOR;
  ctx.lineWidth = 1.5;
  ctx.setLineDash(PREVIEW_DASH);
  ctx.beginPath();
  ctx.moveTo(fromPx.x, fromPx.y);
  ctx.lineTo(cursorPx.x, cursorPx.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(cursorPx.x, cursorPx.y, HANDLE_RADIUS_PX, 0, Math.PI * 2);
  ctx.fill();
}

interface Buckets {
  nonBlankPx: number;
  selectedPx: number;
  handlePx: number;
  previewPx: number;
  previewNearCursorPx: number;
}

/**
 * 五个桶一次扫完。分开扫要五次 `getImageData`（每次都是跨进程边界的拷贝），一次扫是同一件事的几倍便宜。
 * 桶与桶**可以重叠**（一根线正好压在把手上），所以这里数的是"有多少像素像这个颜色"，
 * 不是像素分配 —— 判据全是 `> 0` / `=== 0`，不拿它们做加减。
 *
 * `cursorPx` 只服务第五个桶：临时线的**颜色**证不了它跟手（`previewPx` 在一根钉死于
 * 按下点的线上一样的 >20），所以要数"离当前光标 2px 内的临时线像素"。窗口给 2px 而不是 0，
 * 是因为 `offsetX` 在缩放的 Windows 上可能带小数，而 `sendInputEvent` 发出去的是取整值。
 * 拖拽之外（`cursorPx === null`）这一桶恒 0 —— 没人拿它判"没在拖"的那种情形。
 */
function countPixels(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  cursorPx: Px | null,
): Buckets {
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const width = canvas.width;
  const out: Buckets = {
    nonBlankPx: 0,
    selectedPx: 0,
    handlePx: 0,
    previewPx: 0,
    previewNearCursorPx: 0,
  };
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    if (r < 250 || g < 250 || b < 250) out.nonBlankPx += 1;
    if (nearChannel(r, SEL_RGB[0]) && nearChannel(g, SEL_RGB[1]) && nearChannel(b, SEL_RGB[2])) {
      out.selectedPx += 1;
    }
    if (nearChannel(r, HANDLE_RGB[0]) && nearChannel(g, HANDLE_RGB[1]) && nearChannel(b, HANDLE_RGB[2])) {
      out.handlePx += 1;
    }
    if (nearChannel(r, PREVIEW_RGB[0]) && nearChannel(g, PREVIEW_RGB[1]) && nearChannel(b, PREVIEW_RGB[2])) {
      out.previewPx += 1;
      if (cursorPx !== null) {
        const col = (i / 4) % width;
        const row = Math.floor(i / 4 / width);
        if (Math.abs(col - cursorPx.x) <= 2 && Math.abs(row - cursorPx.y) <= 2) {
          out.previewNearCursorPx += 1;
        }
      }
    }
  }
  return out;
}

/**
 * 画布像素坐标。`offsetX/offsetY` 相对**事件目标**，而目标在窗口级监听下仍然是命中到的那块
 * canvas（它铺满内容区、1 canvas px = 1 CSS px，没有 CSS 缩放掺进来），所以它与 `DrawOp`
 * 的坐标同一单位、同一原点 —— 指针拖出画布外时目标会变成 `<html>`，那时 `offsetX` 就不是
 * 画布坐标了，但 `moveTargetOf` 拿到的仍是同一张屏幕上的数，最多是落点偏一点，不会算错单位。
 * 非有限值返回 null：`quantizeMm` 会抛 RangeError，而那一发既没什么可写、也没什么可撤销。
 */
function pointerPx(event: PointerEvent): Px | null {
  const x = Number.isFinite(event.offsetX) ? event.offsetX : event.clientX;
  const y = Number.isFinite(event.offsetY) ? event.offsetY : event.clientY;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

export function PlanCanvas(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 指针事件的靶子必须是**刷上屏的那一份**指令表与把手表（T4 的纪律延续到把手上）：
  // 副本与屏幕一旦漂开，"点得中的就是画出来的"就只剩注释在守。
  const opsRef = useRef<readonly DrawOp[]>([]);
  const handlesRef = useRef<readonly DragHandle[]>([]);
  // 诊断值住 ref 不进 paint 依赖（D6）：它们只给 __dajiaDebug 读，进了依赖就等于
  // "每一次抛错都自己制造一次重绘"，那 revision 的设计就白做了。
  const dropRef = useRef<DropReport | null>(null);
  const keyRef = useRef<KeyEventReport | null>(null);
  // 快捷键的"到过"计数器：与 keyRef 同生命周期，只给 __dajiaDebug 读（同样不进依赖）。
  const keySeqRef = useRef<number>(0);
  // "这次按下落在把手上"的同步副本：window 级监听器只注册一次、依赖里没有 drag，
  // 它判断"当前这串 move/up 属不属于一次拖"只能读 ref。屏幕上的那一半住 store（管重绘）。
  const activeRef = useRef<boolean>(false);

  const log = useEditor((s) => s.log);
  const storeyId = useEditor((s) => s.storeyId);
  const viewport = useEditor((s) => s.viewport);
  const revision = useEditor((s) => s.revision);
  const drag = useEditor((s) => s.drag);
  const setViewport = useEditor((s) => s.setViewport);
  const setDrag = useEditor((s) => s.setDrag);
  const dispatch = useEditor((s) => s.dispatch);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const ids = useSelection((s) => s.ids);
  const select = useSelection((s) => s.select);
  const toggle = useSelection((s) => s.toggle);
  const clear = useSelection((s) => s.clear);

  useEffect(() => {
    const fit = (): void => {
      const wPx = Math.max(1, Math.floor(window.innerWidth));
      const hPx = Math.max(1, Math.floor(window.innerHeight));
      const canvas = canvasRef.current;
      if (canvas !== null) {
        canvas.width = wPx;
        canvas.height = hPx;
        canvas.style.width = `${String(wPx)}px`;
        canvas.style.height = `${String(hPx)}px`;
      }
      setViewport(fitStorey(log.document, storeyId, wPx, hPx, 60));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [log, storeyId, setViewport]);

  // 一条绘制通路：指令表 → 把手 → 临时线，同一个 effect、同一次 ctx 获取。
  // `revision` 进了依赖却没被读：它是扳机不是数据（见 editorStore 的 D6 注释）。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || viewport === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const ops = buildDrawList(log.document, storeyId, viewport, { ids });
    opsRef.current = ops;
    paint(ctx, ops);
    const handles = dragHandlesOf(log.document, storeyId, { ids }, viewport);
    handlesRef.current = handles;
    paintHandles(ctx, handles);
    if (drag !== null) paintPreview(ctx, drag.fromPx, drag.cursorPx);
  }, [log, storeyId, viewport, revision, ids, drag]);

  // 按下：先问把手，再问指令表（D2 说的"把手命中排在 pickOne 之前"就是这一行的顺序）。
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    // 没有 viewport 就什么都没有：handlesRef 与 opsRef 由 paint effect 填，而它在
    // viewport === null 时直接 return（屏幕上是空的）。在这里返回假视口等于自欺。
    if (viewport === null) return;
    const px = pointerPx(event.nativeEvent);
    if (px === null) return;
    const hit = pickHandle(handlesRef.current, px);
    if (hit !== null) {
      // D5：拖之前先选中，同一趟里做完。于是"拖的那面墙"与"红着的那面墙"是同一个表达式给的。
      select(hit.wallId);
      const point = requirePoint(log.document, hit.pointId, '端点');
      const target = moveTargetOf(viewport, px);
      activeRef.current = true;
      setDrag({
        wallId: hit.wallId,
        end: hit.end,
        pointId: hit.pointId,
        atMm: { x: point.x, y: point.y },
        fromPx: hit.atPx,
        cursorPx: px,
        targetMm: target,
      });
      return;
    }
    const opHit = pickOne(opsRef.current, px);
    if (opHit === null) {
      clear();
      return;
    }
    if (event.shiftKey) toggle(opHit.ownerId);
    else select(opHit.ownerId);
  };

  // 中途与松手挂 window：拖出画布外也要继续画、也要能结束（元素级 handler 在指针离开后就收不到了，
  // 于是"临时线钉在屏幕上"是这类实现的标配 bug）。
  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      if (!activeRef.current || viewport === null) return;
      const px = pointerPx(event);
      if (px === null) return;
      const s = useEditor.getState();
      const current = s.drag;
      if (current === null) return;
      setDrag({ ...current, cursorPx: px, targetMm: moveTargetOf(viewport, px) });
    };
    const onUp = (): void => {
      if (!activeRef.current) return;
      activeRef.current = false;
      const s = useEditor.getState();
      const current = s.drag;
      setDrag(null);
      if (current === null || viewport === null) return;
      // D4：零移动不发命令。否则每点一次把手都往撤销栈塞一步空操作，
      // 真东西就被埋了 —— spec 验收 2 要的是"连按撤销能看到一串串改动退回去"。
      if (current.targetMm.x === current.atMm.x && current.targetMm.y === current.atMm.y) {
        dropRef.current = {
          outcome: 'noop',
          wallId: current.wallId,
          end: current.end,
          targetMm: current.targetMm,
          pointMm: current.atMm,
        };
        return;
      }
      // 不预检 legalDrop（见 editorStore 那条注）：让真源判，抛错由 dispatch 的 catch 记。
      dispatch(wallMoveEndpoint({ wallId: current.wallId, end: current.end, ...current.targetMm }));
      const after = useEditor.getState();
      const point = requirePoint(after.log.document, current.pointId, '端点');
      dropRef.current = {
        outcome: after.lastError === null ? 'ok' : 'failed',
        wallId: current.wallId,
        end: current.end,
        targetMm: current.targetMm,
        pointMm: { x: point.x, y: point.y },
      };
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [viewport, dispatch, setDrag]);

  // D7：Ctrl+Z / Ctrl+Shift+Z（mac 上 meta 同义）。挂在 window 而不是 canvas：
  // 快捷键不该要求"鼠标正好停在图上"。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'z' && event.key !== 'Z') return;
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const isRedo = event.shiftKey;
      if (isRedo) redo();
      else undo();
      const s = useEditor.getState();
      keySeqRef.current += 1;
      keyRef.current = {
        seq: keySeqRef.current,
        combo: isRedo ? 'Ctrl+Shift+Z' : 'Ctrl+Z',
        depth: s.log.depth,
        revision: s.revision,
        canUndo: s.log.canUndo,
        canRedo: s.log.canRedo,
        lastError: s.lastError,
      };
      // undo/redo 都不碰选中集（D7）：撤销的是文档，不是视图。
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || viewport === null) return;
    const previous = window.__dajiaDebug;
    window.__dajiaDebug = (): DebugReport => {
      const ops = opsRef.current;
      const layers: Record<string, number> = {};
      for (const o of ops) layers[o.pen.layer] = (layers[o.pen.layer] ?? 0) + 1;
      const ctx = canvas.getContext('2d');
      // `s` 先取：第五个桶要拿**当下 store 里的光标**去量像素。这一句是整个判据的要害 ——
      // 位置取自 store（活的那一份），颜色取自屏幕（刷上屏的那一份），两者对不上就是"没跟手"。
      const s = useEditor.getState();
      const counted =
        ctx === null ? NO_PIXELS : countPixels(ctx, canvas, s.drag?.cursorPx ?? null);
      return {
        ops: ops.length,
        layers,
        nonBlankPx: counted.nonBlankPx,
        wPx: canvas.width,
        hPx: canvas.height,
        selectedIds: [...ids],
        selectedPx: counted.selectedPx,
        pick: probeTarget(ops, viewport),
        selectedAfterBlank: ids.size,
        revision: s.revision,
        depth: s.log.depth,
        canUndo: s.log.canUndo,
        canRedo: s.log.canRedo,
        lastError: s.lastError,
        handlePx: counted.handlePx,
        previewPx: counted.previewPx,
        previewNearCursorPx: counted.previewNearCursorPx,
        points: pointSnapshot(s.log.document, s.storeyId),
        edit: dragProbe(s.log.document, s.storeyId, ops, viewport),
        lastDrop: dropRef.current,
        lastKeyEvent: keyRef.current,
      };
    };
    return () => {
      window.__dajiaDebug = previous;
    };
  }, [viewport, ids, revision]);

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={onPointerDown}
      style={{ display: 'block', touchAction: 'none', cursor: 'crosshair' }}
    />
  );
}
```

- [ ] **Step 6: desktop —— `--edit-shot`：发得出鼠标、发得出 Ctrl+Z，并把每一步的读数分开留档**

`apps/desktop/src/main/index.ts` 先改两处**已有**代码（不是新增，是订正）：

1. `shotPathFromArgv()` 换成通用版，`runShot` 与 `whenLoaded` / `waitForDebug` 的签名一个字都不动：

```ts
/** 取 `<flag> <path>` 的落盘路径。`--shot` 之外，T5 的 `--edit-shot` 也复用它写同一份报告。 */
function argPath(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  const p = process.argv[i + 1];
  if (p === undefined || p.startsWith('--')) {
    throw new RangeError(`${flag} 后面必须跟一个文件路径`);
  }
  return p;
}
```

2. 顶上的 `import { app, BrowserWindow, ipcMain } from 'electron';` 补一个 `Menu`（第 4 点解释为什么非摘菜单不可）：

```ts
import { app, BrowserWindow, ipcMain, Menu } from 'electron';
```

> **为什么 `argPath` 要现在改**：T4 的 `electronArgs` 是 `['.', '--pick-shot', '--shot', out]` —— `--pick-shot` 后面跟着的是**另一个开关**而不是路径，那时它不出问题，因为 `runPickShot(win, shotPath)` 用的就是 `--shot` 那一份路径，`--pick-shot` 只当开关读。T5 起 `runEditShot` 与 `runPickShot` 各自要读自己那个开关后面的路径（`argPath('--edit-shot') ?? shotPath`），"开关与路径成对"就从巧合变成规矩：`argPath(flag)` 拿到的下一个参数若是 `--…` 就抛，而不是把开关名当文件名写进 `writeFileSync`。**判据一条都没动**，动的只是参数怎么读，脚本那头的 `electronArgs` 因此必须同步改成成对写法。

新增下面这些。**不许**从 renderer 文件 `import type { DebugReport }`（会把 React 拖进 main 产物）；这里的形状与 `DebugReport` 逐字段对齐，JSON 是它们唯一的对账处。

```ts
interface MmShape {
  x: number;
  y: number;
}

interface ClickPoint {
  x: number;
  y: number;
}

interface DragProbeShape {
  wallId: string;
  end: string;
  pointId: string;
  sharedBy: number;
  fromPx: ClickPoint;
  toPx: ClickPoint;
  anchorPx: ClickPoint;
  targetMm: MmShape;
}

interface DropShape {
  outcome: 'ok' | 'noop' | 'failed';
  wallId: string;
  end: string;
  targetMm: MmShape;
  pointMm: MmShape;
}

interface KeyShape {
  /** 与 `KeyEventReport.seq` 同一字段：主进程靠它认"这一发确实到过 renderer"。 */
  seq: number;
  combo: string;
  depth: number;
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
  lastError: string | null;
}

/** T5 的 `__dajiaDebug()` 全形状：T4 那五个字段之外，又多了 12 + 探针与两份诊断。 */
interface EditReportShape {
  ops: number;
  layers: Record<string, number>;
  nonBlankPx: number;
  wPx: number;
  hPx: number;
  selectedIds: string[];
  selectedPx: number;
  pick: unknown;
  selectedAfterBlank: number;
  revision: number;
  depth: number;
  canUndo: boolean;
  canRedo: boolean;
  lastError: string | null;
  handlePx: number;
  previewPx: number;
  previewNearCursorPx: number;
  points: Record<string, MmShape>;
  edit: DragProbeShape | null;
  lastDrop: DropShape | null;
  lastKeyEvent: KeyShape | null;
}

function editShotRequested(): boolean {
  return process.argv.includes('--edit-shot');
}

/**
 * Electron 44 的 `electron.d.ts` 在 `webContents.sendInputEvent` 上写着原文注记：
 * "The `BrowserWindow` containing the contents needs to be focused for
 * `sendInputEvent()` to work." 所以**每一条**发合成输入的 shot 路径都得先聚焦，
 * 否则"点了没反应"和"窗口没焦点"长成同一个样子。
 */
function focusForInput(win: BrowserWindow): void {
  win.moveTop();
  win.focus();
  win.webContents.focus();
}

/** 把三枚像素读数写成一条 `waitUntil` 的判据，读不到就抛，绝不"等不到算通过"。 */
async function readEditReport(win: BrowserWindow, label: string): Promise<EditReportShape> {
  const value = (await win.webContents.executeJavaScript('window.__dajiaDebug()')) as
    | EditReportShape
    | undefined;
  if (value === undefined) {
    throw new Error(`__dajiaDebug() 没返回报告（${label}）—— renderer 死了，不是"还没刷完"`);
  }
  return value;
}

/** 快照里少一枚点 = 真源被写坏了。"读不到"绝不允许当成"没变"。 */
function mmOf(report: EditReportShape, pointId: string, label: string): MmShape {
  const mm = report.points[pointId];
  if (mm === undefined) throw new Error(`${label}：points 快照里没有端点 ${pointId}`);
  return mm;
}

async function pressPx(win: BrowserWindow, p: ClickPoint): Promise<void> {
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    x: Math.round(p.x),
    y: Math.round(p.y),
    button: 'left',
    clickCount: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 16));
}

async function movePx(win: BrowserWindow, p: ClickPoint): Promise<void> {
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x), y: Math.round(p.y) });
  await new Promise((resolve) => setTimeout(resolve, 16));
}

async function releasePx(win: BrowserWindow, p: ClickPoint): Promise<void> {
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: Math.round(p.x),
    y: Math.round(p.y),
    button: 'left',
    clickCount: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 16));
}

/**
 * 默认应用菜单里有 Edit → Undo (Ctrl+Z) / Redo (Ctrl+Shift+Z)，它们与本任务的快捷键**逐字同名**。
 * 合成按键是直接进 Blink 的，正常不该被 accelerator 截走；但一旦"按了没反应"，
 * 现象与被菜单吃掉一模一样。shot 模式下整张菜单摘掉，把这个变量从实验里去掉。
 */
/**
 * `sendInputEvent` 的修饰键只认这几个字面量（Electron 44 `electron.d.ts` 里 `InputEvent.modifiers`
 * 的联合类型）。这里写成字面量数组而不是 `string[]`：后者传进 `sendInputEvent` 会红在
 * `TS2322 Type 'string[]' is not assignable to ...`，而那是一条编译期就能抓住的错，
 * 不该留到真窗口里当"按了没反应"查。
 */
type InputModifier = 'ctrl' | 'shift' | 'alt' | 'meta' | 'command';

async function keyCombo(
  win: BrowserWindow,
  keyCode: string,
  modifiers: InputModifier[],
): Promise<void> {
  Menu.setApplicationMenu(null);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await new Promise((resolve) => setTimeout(resolve, 16));
}

/**
 * 发完快捷键再等 —— **等的是"这一发确实被处理了"**，不是固定 sleep：
 * 等的是 `seq` 变大。别退回去比 `combo`：第 8 步的空栈重做与第 6 步的重做同为
 * `'Ctrl+Shift+Z'`，而那一发故意什么都不改（真源没动 ⇒ `depth`、`revision`、坐标全不动，
 * 只换一句中文），拿它们当条件会等满 10 秒再抛 —— 判据没测到东西， yet 全线红在超时上。
 * `waitUntil` 的谓词替不了类型收窄，所以读回后仍要显式判 `null`。
 */
async function waitKeyApplied(win: BrowserWindow, before: EditReportShape, label: string): Promise<KeyShape> {
  const report = await waitUntil(
    `快捷键没生效（${label}）：renderer 的 keydown 没跑到`,
    () => readEditReport(win, label),
    (r) => r.lastKeyEvent !== null && r.lastKeyEvent.seq > (before.lastKeyEvent?.seq ?? 0),
  );
  const key = report.lastKeyEvent;
  if (key === null) throw new Error(`不可达：waitUntil 判定 key 非空后读回 null（${label}）`);
  return key;
}

/**
 * 八步序列：按下即选中 → 中途不写 → 松手落点 → 压扁被拒 → 撤销 → 重做 → 原地 noop → 空栈重做。
 * 每一步的读数都单独存一个 const，最后一起写盘：TS 的使用先于声明会替我们守住
 * "少跑一步就编译不过"，比事后补一堆缺键检查可靠。
 */
async function runEditShot(win: BrowserWindow, out: string): Promise<void> {
  await whenLoaded(win);
  await waitForDebug(win);
  focusForInput(win);

  const start = await readEditReport(win, '拖动前');
  const edit = start.edit;
  if (edit === null) {
    throw new Error('dragProbe 没给靶子：一层没有共享端点，或候选落点全不合法');
  }
  if (edit.sharedBy < 2) {
    throw new Error(`探针给出的是孤端点（sharedBy=${String(edit.sharedBy)}）：拖它证不出"邻墙跟着动"`);
  }
  const atStart = mmOf(start, edit.pointId, '拖动前');
  process.stdout.write(`探针：${edit.wallId}:${edit.end} 共享 ${String(edit.sharedBy)} 面\n`);

  // 1) 按在把手上：D5 说先选中，于是那一发之后墙必须是红的、把手必须画得出来。
  await pressPx(win, edit.fromPx);
  const pressed = await waitUntil(
    `按下把手后没选中 ${edit.wallId} 或把手没上屏`,
    () => readEditReport(win, '按下后'),
    (r) =>
      r.selectedIds.length === 1 &&
      r.selectedIds[0] === edit.wallId &&
      r.handlePx > 20 &&
      r.previewPx > 20,
  );

  // 2) 中途：临时线要**跟着光标**，真源一个字都不许写。
  //    取两枚整像素的中点并取整：偏移至少 600mm（≈ 75px），指针一定离开起点。
  const midPx = {
    x: Math.round((edit.fromPx.x + edit.toPx.x) / 2),
    y: Math.round((edit.fromPx.y + edit.toPx.y) / 2),
  };
  await movePx(win, midPx);
  // 这一发也必须 `waitUntil` 而不是直读：`pointermove` 进 renderer → React 重渲 → effect 重画，
  // 全在事件循环里排队，`executeJavaScript` 早到一步读到的就是**上一帧**。
  // 等的只有"光标那一撮有像素"：真源动没动是下面两道 throw 的活，别让等待替它们说话。
  const during = await waitUntil(
    `拖拽中临时线没跟到光标 (${String(midPx.x)}, ${String(midPx.y)})：` +
      '要么画家画的终点不是光标，要么 `drag` 没进 paint effect 的依赖',
    () => readEditReport(win, '拖动中'),
    (r) => r.previewNearCursorPx > 0,
  );
  const midMm = mmOf(during, edit.pointId, '拖动中');
  if (during.depth !== start.depth || during.revision !== start.revision) {
    throw new Error(
      `拖拽中途就写了真源：depth ${String(start.depth)}→${String(during.depth)}，` +
        `revision ${String(start.revision)}→${String(during.revision)}`,
    );
  }
  if (midMm.x !== atStart.x || midMm.y !== atStart.y) {
    throw new Error(
      `拖拽中途坐标就变了：(${String(atStart.x)}, ${String(atStart.y)}) → (${String(midMm.x)}, ${String(midMm.y)})`,
    );
  }
  process.stdout.write(
    `中途：previewPx=${String(during.previewPx)} nearMid=${String(during.previewNearCursorPx)} ` +
      `depth=${String(during.depth)}\n`,
  );

  // 3) 松手：落点必须逐字等于探针给的那对毫米。
  //    探针的 targetMm 是"取整像素反算回来的毫米"（`snapPx` → `moveTargetOf`），
  //    renderer 松手时算的是同一个纯函数的同一个入参 ⇒ 这里不许有 ±1mm 的"差不多"。
  await movePx(win, edit.toPx);
  await releasePx(win, edit.toPx);
  const dropped = await waitUntil(
    `松手后没落到 (${String(edit.targetMm.x)}, ${String(edit.targetMm.y)})，` +
      '或者屏幕上残留/该有的是错的（谓词含 previewPx === 0 与 handlePx > 20）',
    () => readEditReport(win, '松手后'),
    (r) => {
      const mm = r.points[edit.pointId];
      return (
        mm !== undefined &&
        mm.x === edit.targetMm.x &&
        mm.y === edit.targetMm.y &&
        r.depth === start.depth + 1 &&
        r.revision === start.revision + 1 &&
        r.previewPx === 0 &&
        r.handlePx > 20
      );
    },
  );
  const drop = dropped.lastDrop;
  if (drop === null || drop.outcome !== 'ok') {
    throw new Error(`松手后 lastDrop 不是 ok：${JSON.stringify(drop)}`);
  }

  // 4) 压扁：从落点拖回**这面墙自己的锚点**。锚点在上一发里没动过，所以 anchorPx 依然有效；
  //    此刻选中集只有这一面墙 ⇒ 两个把手分别在 toPx 与 anchorPx（相距 ≥ 墙厚 240mm ≈ 31px），
  //    按在 toPx 上不可能认错。取整反算的毫米离锚点不到 1 像素（≈ 8mm）⇒ 必然撞几何守卫。
  await pressPx(win, edit.toPx);
  await movePx(win, edit.anchorPx);
  await releasePx(win, edit.anchorPx);
  const crushed = await waitUntil(
    '压扁拖没被拒：lastError 一直是空的',
    () => readEditReport(win, '压扁后'),
    (r) => r.lastError !== null,
  );
  // `waitUntil` 的谓词替不了类型收窄：返回的报告里 `lastError` 仍是 `string | null`。
  // 这里显式读回并判空，与 `waitKeyApplied` 对 `lastKeyEvent` 做的事同形。
  const crushError = crushed.lastError;
  if (crushError === null) {
    throw new Error('不可达：waitUntil 判定 lastError 非空后读回 null（压扁后）');
  }
  if (!/轴长|零长/.test(crushError)) {
    throw new Error(`压扁拖报错但不像几何守卫：${crushError}`);
  }
  const crushMm = mmOf(crushed, edit.pointId, '压扁后');
  const dropMm = mmOf(dropped, edit.pointId, '松手后');
  if (
    crushed.depth !== dropped.depth ||
    crushed.revision !== dropped.revision ||
    crushMm.x !== dropMm.x ||
    crushMm.y !== dropMm.y
  ) {
    // 计划 2 转下游 #11 的落地凭据就在这一条：命令抛了 ⇒ 真源、revision、撤销栈三者都不许动。
    throw new Error(
      `失败的拖拽留了痕迹：depth ${String(dropped.depth)}→${String(crushed.depth)}，` +
        `revision ${String(dropped.revision)}→${String(crushed.revision)}`,
    );
  }
  const crushDrop = crushed.lastDrop;
  if (crushDrop === null || crushDrop.outcome !== 'failed') {
    throw new Error(`压扁拖的 lastDrop 不是 failed：${JSON.stringify(crushDrop)}`);
  }
  process.stdout.write(`被拒：${crushError.slice(0, 80)}\n`);

  // 5) Ctrl+Z 回到拖动前，且选中集不许跟着撤销走。
  const beforeUndo = await readEditReport(win, '撤销前');
  await keyCombo(win, 'Z', ['ctrl']);
  const undoKey = await waitKeyApplied(win, beforeUndo, 'Ctrl+Z');
  const undid = await waitUntil(
    `撤销后没回到 (${String(atStart.x)}, ${String(atStart.y)})，` +
      '或者选中集跟着撤销走了（谓词含 selectedIds 仍是那面墙）',
    () => readEditReport(win, '撤销后'),
    (r) => {
      const mm = r.points[edit.pointId];
      return (
        mm !== undefined &&
        mm.x === atStart.x &&
        mm.y === atStart.y &&
        r.depth === start.depth &&
        r.revision === beforeUndo.revision + 1 &&
        r.selectedIds.length === 1 &&
        r.selectedIds[0] === edit.wallId
      );
    },
  );
  if (undoKey.combo !== 'Ctrl+Z') throw new Error(`撤销读到的是另一发快捷键：${undoKey.combo}`);

  // 6) Ctrl+Shift+Z 回到落点，并把上一发失败留下的中文错误抹掉（redo 成功 ⇒ 清 lastError）。
  const beforeRedo = await readEditReport(win, '重做前');
  await keyCombo(win, 'Z', ['ctrl', 'shift']);
  const redoKey = await waitKeyApplied(win, beforeRedo, 'Ctrl+Shift+Z');
  const redid = await waitUntil(
    `重做后没回到 (${String(edit.targetMm.x)}, ${String(edit.targetMm.y)})`,
    () => readEditReport(win, '重做后'),
    (r) => {
      const mm = r.points[edit.pointId];
      return (
        mm !== undefined &&
        mm.x === edit.targetMm.x &&
        mm.y === edit.targetMm.y &&
        r.depth === start.depth + 1 &&
        r.lastError === null
      );
    },
  );
  if (redoKey.combo !== 'Ctrl+Shift+Z') {
    throw new Error(`重做读到的是另一发快捷键：${redoKey.combo}`);
  }

  // 7) 原地按下即松手：D4 的零移动不发命令 ⇒ 撤销栈一步都不许多。
  await pressPx(win, edit.toPx);
  await releasePx(win, edit.toPx);
  const nooped = await waitUntil(
    '原地松手没给出 noop 诊断，或撤销栈被空操作污染了',
    () => readEditReport(win, '原地松手后'),
    (r) => r.lastDrop !== null && r.lastDrop.outcome === 'noop' && r.depth === redid.depth,
  );

  // 8) 重做栈此时是空的（第 6 步已经把那一发取走，第 7 步没入栈）。
  //    再按一次 Ctrl+Shift+Z：不许静默，要有中文反馈，且真源一个字节都不动。
  const beforeEmpty = await readEditReport(win, '空栈重做前');
  await keyCombo(win, 'Z', ['ctrl', 'shift']);
  const emptyRedoKey = await waitKeyApplied(win, beforeEmpty, '空栈 Ctrl+Shift+Z');
  const emptyRedo = await waitUntil(
    '空重做栈没给出反馈',
    () => readEditReport(win, '空栈重做后'),
    (r) => r.lastError !== null && r.depth === beforeEmpty.depth && r.revision === beforeEmpty.revision,
  );
  if (emptyRedo.lastError !== '没有可重做的操作') {
    throw new Error(`空重做栈的反馈不是那句中文：${String(emptyRedo.lastError)}`);
  }
  if (emptyRedoKey.combo !== 'Ctrl+Shift+Z') {
    throw new Error(`空栈重做读到的是另一发快捷键：${emptyRedoKey.combo}`);
  }

  const finalReport = {
    ...emptyRedo,
    // 探针与第 0 步的读数必须留档：后面的判据拿它们跟真源对账。
    edit,
    xAtStart: atStart.x,
    yAtStart: atStart.y,
    depthAtStart: start.depth,
    revisionAtStart: start.revision,
    canUndoAtStart: start.canUndo,
    selectedAfterPress: pressed.selectedIds[0] ?? null,
    selectedPxAfterPress: pressed.selectedPx,
    handlePxAfterPress: pressed.handlePx,
    xDuringDrag: midMm.x,
    yDuringDrag: midMm.y,
    depthDuringDrag: during.depth,
    revisionDuringDrag: during.revision,
    canUndoDuringDrag: during.canUndo,
    previewPxDuringDrag: during.previewPx,
    previewNearMidPx: during.previewNearCursorPx,
    xAfterDrop: dropMm.x,
    yAfterDrop: dropMm.y,
    depthAfterDrop: dropped.depth,
    revisionAfterDrop: dropped.revision,
    previewPxAfterDrop: dropped.previewPx,
    handlePxAfterDrop: dropped.handlePx,
    dropOutcomeAfterDrop: drop.outcome,
    xAfterCrush: crushMm.x,
    yAfterCrush: crushMm.y,
    depthAfterCrush: crushed.depth,
    revisionAfterCrush: crushed.revision,
    lastErrorAfterCrush: crushed.lastError,
    dropOutcomeAfterCrush: crushDrop?.outcome ?? null,
    xAfterUndo: mmOf(undid, edit.pointId, '撤销后').x,
    yAfterUndo: mmOf(undid, edit.pointId, '撤销后').y,
    depthAfterUndo: undid.depth,
    revisionAfterUndo: undid.revision,
    selectedAfterUndo: undid.selectedIds[0] ?? null,
    comboAfterUndo: undoKey.combo,
    xAfterRedo: mmOf(redid, edit.pointId, '重做后').x,
    yAfterRedo: mmOf(redid, edit.pointId, '重做后').y,
    depthAfterRedo: redid.depth,
    comboAfterRedo: redoKey.combo,
    lastErrorAfterRedo: redid.lastError,
    dropOutcomeAfterNoop: nooped.lastDrop?.outcome ?? null,
    depthAfterNoop: nooped.depth,
    revisionAfterNoop: nooped.revision,
    comboAfterEmptyRedo: emptyRedoKey.combo,
    lastErrorAfterEmptyRedo: emptyRedo.lastError,
    depthAfterEmptyRedo: emptyRedo.depth,
    revisionAfterEmptyRedo: emptyRedo.revision,
  };
  writeFileSync(out, `${JSON.stringify(finalReport, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(finalReport)}\n`);
}
```

`app.whenReady()` 里那个分支（T4 改成 `if (pickShotRequested()) … else runShot …`）此刻换成三段：

```ts
void app.whenReady().then(async () => {
  const shotPath = argPath('--shot');
  const win = createWindow(shotPath === null);
  if (shotPath === null) {
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(true);
    });
    return;
  }
  let code = 0;
  try {
    if (editShotRequested()) await runEditShot(win, argPath('--edit-shot') ?? shotPath);
    else if (pickShotRequested()) await runPickShot(win, argPath('--pick-shot') ?? shotPath);
    else await runShot(win, shotPath);
  } catch (err) {
    process.stderr.write(`--shot 失败：${String(err)}\n`);
    code = 1;
  }
  app.exit(code);
});
```

> **`?? shotPath` 是兜底，不是常态**：脚本一定会成对给路径；手写命令少给一个时，宁可退到 `--shot` 那份路径，也不要让 `runEditShot` 拿 `null` 当文件名去 `writeFileSync`（那会红在一句对不上判据的 ENOENT 上）。

`scripts/desktop-shot.mjs`：`try` / `finally { rmSync(dir, ...) }` 的骨架照旧。把 T4 那段 `wantPick` + `electronArgs` 整段换成下面这段（`out` 的定义保持在它上面不动 —— 两个开关共用同一份落盘路径，因为一次运行只有一个 `run*Shot` 会写盘）：

```js
const wantPick = process.argv.includes('--pick');
const wantEdit = process.argv.includes('--edit');
// `--shot out` 不是"再写一份报告"：主进程用 `argPath('--shot') !== null` 判定进不进 shot 模式
// （隐藏窗口、跑完 exit）。少了它，`--edit-shot` 那份路径根本没人读。
// 一次运行只有 `runEditShot` 或 `runPickShot` 或 `runShot` 会写盘 ⇒ 三个开关共用 `out` 这一个路径。
const electronArgs = wantEdit
  ? ['.', '--edit-shot', out, '--shot', out]
  : ['.', ...(wantPick ? ['--pick-shot', out] : []), '--shot', out];
try {
  run('pnpm', ['--filter', '@dajia/desktop', 'build']);
  run('pnpm', ['--filter', '@dajia/desktop', 'exec', 'electron', ...electronArgs], 180_000);
```

然后在 `const layers = report.layers ?? {};` 之后补一行，并在 T4 那段 `if (wantPick) {…}` **之后**追加 `if (wantEdit) {…}`：

```js
  const edit = report.edit ?? {};
```

```js
  if (wantEdit) {
    // 前六条与 drawlist.test.ts 同源（拖动改的是坐标不是指令数，所以 `ops === 31` 在 edit 模式下
    // 仍是回归判据）；这十四条与 handles.test.ts + commands-drag.test.ts 同源，
    // 但只测它们管不到的那一层：真窗口里"发的像素 → 真源的毫米 → 撤销栈"。
    checks.push(
      ['探针给出可拖的共享端点（孤端点证不出邻墙）', typeof edit.wallId === 'string' && edit.sharedBy >= 2],
      ['按在把手上即选中那面墙（D5）', report.selectedAfterPress === edit.wallId && report.selectedPxAfterPress > 100],
      ['把手上屏（只有选中的墙才画把手）', report.handlePxAfterPress > 20],
      ['拖拽中不写真源：depth、revision、坐标三者都不动', report.depthDuringDrag === report.depthAtStart && report.revisionDuringDrag === report.revisionAtStart && report.xDuringDrag === report.xAtStart && report.yDuringDrag === report.yAtStart],
      ['拖拽中临时线上屏（白屏与"只画了图"都过不了）', report.previewPxDuringDrag > 20],
      // 上一行只证明"有那根线"，这一行证明"那根线在光标那儿"：把 paintPreview 的终点写死成
      // 按下点，上一行照样绿 —— 位置取自 store 的活光标，颜色取自屏幕的实像素，缺一半就是假绿。
      ['拖拽中临时线跟着光标（钉在按下点就红）', report.previewNearMidPx > 0],
      ['松手落点逐字等于探针给的毫米', report.xAfterDrop === edit.targetMm?.x && report.yAfterDrop === edit.targetMm?.y],
      ['一步拖 = depth +1 且 revision +1（撤销栈知道发生了什么）', report.depthAfterDrop === report.depthAtStart + 1 && report.revisionAfterDrop === report.revisionAtStart + 1],
      ['松手后临时线不残留、把手仍在', report.previewPxAfterDrop === 0 && report.handlePxAfterDrop > 20],
      ['压扁到锚点被真源拒绝（中文报错，不是没反应）', /轴长|零长/.test(report.lastErrorAfterCrush ?? '') && report.dropOutcomeAfterCrush === 'failed'],
      // 计划 2 转下游 #11 的落地凭据：抛错那发不留任何痕迹 —— 这一条只在真窗口里测得到，
      // 因为 renderer 的 dispatch 是唯一读者。
      ['失败的拖拽不改 depth、不改 revision、不改坐标', report.depthAfterCrush === report.depthAfterDrop && report.revisionAfterCrush === report.revisionAfterDrop && report.xAfterCrush === report.xAfterDrop && report.yAfterCrush === report.yAfterDrop],
      ['Ctrl+Z 回到拖动前且选中集不动', report.xAfterUndo === report.xAtStart && report.yAfterUndo === report.yAtStart && report.depthAfterUndo === report.depthAtStart && report.selectedAfterUndo === edit.wallId],
      ['Ctrl+Shift+Z 回到拖动后并把错误抹掉', report.xAfterRedo === edit.targetMm?.x && report.lastErrorAfterRedo === null && report.comboAfterRedo === 'Ctrl+Shift+Z'],
      // 后两条各管一头：noop 证"零移动不入栈"（D4），空栈反馈证"没发生的事要说出来"（D7）。
      ['原地松手 = noop，撤销栈一步都不许多', report.dropOutcomeAfterNoop === 'noop' && report.depthAfterNoop === report.depthAfterRedo],
      ['重做栈空时再按 Ctrl+Shift+Z 给中文反馈且不动真源', report.lastErrorAfterEmptyRedo === '没有可重做的操作' && report.comboAfterEmptyRedo === 'Ctrl+Shift+Z' && report.depthAfterEmptyRedo === report.depthAfterRedo],
    );
  }
```

数一下：`wantEdit` 那段是 **15** 条判据，基础六条照旧 ⇒ `pnpm edit-shot` 应当打印 **21 行 PASS**（`pick-shot` 仍是 10 行，`shot` 仍是 6 行）。改样例房或改判据时，这几处要一起改：`drawlist.test.ts`、`pick.test.ts`、`handles.test.ts`、`commands-drag.test.ts`、`desktop-shot.mjs`。

根 `package.json` 的 scripts 再加一条（`shot` 与 `pick-shot` 都保持原样）：

```json
"edit-shot": "node scripts/desktop-shot.mjs --edit"
```

- [ ] **Step 7: 真窗口拖一次 + 七条改坏 + 全量闸门 + 两个提交**

```bash
pnpm --filter @dajia/desktop typecheck > /tmp/t5-dts.log 2>&1; echo exit=$?
pnpm shot > /tmp/t5-shot-pixels.log 2>&1; echo exit=$?
pnpm pick-shot > /tmp/t5-shot-pick.log 2>&1; echo exit=$?
pnpm edit-shot > /tmp/t5-shot-edit.log 2>&1; echo exit=$?
```
Expected: 四个 exit=0。`shot` **六行**、`pick-shot` **十行**都照旧全绿（回归判据：T5 不该动它们的行为，`--pick-shot` 与 T4 唯一的差别是 `electronArgs` 换成成对写法）；`edit-shot` **二十一行**全 PASS。把 stdout 里那三行进度读数原样抄进提交信息：`探针：<wallId>:<end> 共享 N 面`（证靶子是**共享**端点，孤端点拖不出邻墙）、`中途：previewPx=… nearMid=… depth=…`（证"拖拽中有东西上屏、线跟着手、真源没动"）与 `被拒：…`（那一句中文报错的前 80 字）。

三条已知风险，按顺序试，**别改判据**：

1. **合成按键派发不下来**（`--edit-shot` 独有的新风险，`--pick-shot` 从来没证过 `keyDown`）。现象是 `waitKeyApplied` 抛"快捷键没生效（Ctrl+Z）：renderer 的 keydown 没跑到"。先确认 `runEditShot` 入口那句 `focusForInput(win)` 之后没有别的窗口把焦点抢走（Step 6 只在入口聚焦一次；鼠标那几步绿、只有按键红时就该往这里想），再看是不是 `keyCombo` 里那句 `Menu.setApplicationMenu(null)` 漏了 —— 默认的 Ctrl+Z 是**菜单 accelerator**，会被主进程截走，屏幕上"没反应"和"没焦点"长成同一个样子。两条都对还红，就按 T4 风险 1 走 `createWindow(true)`。都不许把判据改成"读到什么算什么"。
2. **`type: 'keyDown'` 收不到**：renderer 判的是 `event.key === 'z'`。同一份 `electron.d.ts` 里 `KeyboardInputEvent.type` 的联合还列着 `rawKeyDown`，先照原样跑，真收不到再换那一个字面量试 —— 一次只动一个变量，别同时改 `keyCode` 的大小写。
3. **180 秒上限**：`runEditShot` 最多有 11 处 `waitUntil`（8 处直写 + 3 处包在 `waitKeyApplied` 里），每处上限 10 秒 ⇒ 最坏 110 秒，加上起窗和加载会逼近 `run(..., 180_000)`。撞到就只把**这一条** electron 调用的超时提到 `300_000`；**不许**缩短那 10 秒 —— 它是给慢机器留的余量，缩短等于把偶发失败变成常发失败。

再验一次判据能区分"做了"和"没做"。**这一步不能省**：`vitest.config.ts` 的 include 只有 `packages/*/test/**` 与 `scripts/test/**`，`apps/**` 一行单测都没有，所以 Step 5 写的那套状态机在仓库里唯一的客观凭据就是 `--edit-shot` —— 十一处 `waitUntil` 加十三道硬 throw 保证"等不到就抛、绝不把没等到当成通过"，二十一行判据再把等到了的东西逐条钉成 PASS。下面七条改坏各钉一处，每条做完立刻改回来再跑下一条（每条只动一处，跑完 `git diff` 应当只剩那一处）：

| # | 改坏 | 必须红在哪一处 | 为什么是这一处 |
|---|------|----------------|----------------|
| R1 | 注释掉 paint effect 里的 `paintHandles(ctx, handles)`，`handlesRef.current = handles` 那行**保留** | 第 1 步 `waitUntil` 抛「按下把手后没选中 … 或把手没上屏」⇒ exit=1 | 证明确实是这个画家把把手刷上屏。`handlesRef` 还满着 ⇒ 命中、选中、拖拽全部照常，于是**只有像素那一桶抓得到它** |
| R2 | `paintPreview(ctx, drag.fromPx, drag.cursorPx)` 的终点改成 `drag.fromPx`（线钉在按下那一点） | 第 2 步 `waitUntil` 抛「拖拽中临时线没跟到光标 …」 | 这一条就是 `previewNearCursorPx` 存在的理由：只数 `previewPx` 时，钉死的线与跟手的线长成同一个数（`> 20` 照样成立） |
| R3 | 把 `drag` 从 paint effect 的依赖数组里摘掉（函数体一行不动） | 同样红在第 2 步那句 | 红因与 R2 不同：R2 是画家画错，R3 是**根本没重画**（按下那一帧靠 `ids` 变化侥幸刷了一次，此后的 move 无人重绘）。证 `drag` 进依赖是承重墙，不是"顺手加的" |
| R4 | 删掉 `onUp` 开头的 `setDrag(null)` | 第 3 步 `waitUntil` 抛「松手后没落到 …」（谓词含 `previewPx === 0`） | "拖出画布外临时线钉在屏幕上"那个标配 bug 的镜像判据。R2/R3 管"该在的时候在"，这一条管"该没的时候没" |
| R5 | 在 `onUp` 里 `dispatch` 之前补一句 `legalDrop` 预检（不合法就 `return`） | 第 4 步 `waitUntil` 抛「压扁拖没被拒：lastError 一直是空的」 | D3 的哨兵。它抓的是"**发没发**"，而「失败的拖拽不改 depth、不改 revision、不改坐标」那一对抓的是"**留没留痕迹**" —— 预检恰恰什么痕迹都不留，所以只有 `lastError` 这一路抓得住，两对缺一不可 |
| R6 | `editorStore.dispatch` 的 catch 里顺手 `revision + 1` | 第 4 步之后那道硬 throw：`失败的拖拽留了痕迹：… revision …` | 证 D6：扳机只在成功之后动。为"没发生的事"重绘整张图，肉眼看不出来，这一处看得出来 |
| R7 | 在 keydown 里 `undo()` 之后补一句 `clear()`（"撤销完顺手清个选中"） | 第 5 步 `waitUntil` 抛「撤销后没回到 (x, y)，或者选中集跟着撤销走了」 | 证 D7 那半句"撤销的是文档，不是视图"。这也是 T6 要接手的接缝（撤销掉正被选中的构件）现在唯一的护栏 |

七条里任何一条"改坏了还绿"，说明对应那一处写空了，就地补到能红为止；全部改回来后 `pnpm edit-shot` 必须又是二十一行全 PASS。**红在哪一处本身就是信息**：throw 在判据行上游，所以"某一行 FAIL"意味着它前面那道 throw 被削弱了 —— 那种红同样要查，不许顺手把判据改松。

**不做**的一条，写在这里防有人顺手补：把 `onPointerDown` 里的 `select(hit.wallId)` 删掉，看「按在把手上即选中那面墙」红不红 —— **不许当改坏**。把手落在共享端点上，那里两头都是墙，谁赢由每次现建的 uuidv7 定序，删掉之后随机命中同一面墙是有可能的，于是一条真坏了的东西可能偶然还绿（与 Step 4 第 12 条同一类）。D5 的凭据只有判据「按在把手上即选中那面墙（D5）」本身（它与 R1 红在第 1 步同一个谓词上，正好互为表里）。

```bash
pnpm verify > /tmp/t5-verify.log 2>&1; echo exit=$?
```
Expected: exit=0，`Test Files 28 passed`（28）、`Tests 337 passed`（**318 + 19**：T4 收尾时是 26 个文件 / 318 条，本任务加 `commands-drag.test.ts` 7 条与 `handles.test.ts` 12 条，各一个新文件）。同时**老用例一条都不许改**：Step 1 把重影柱的判据从 `columnCreate` 搬进 `assertNoGhostColumn`，`commands-column-slab.test.ts` 里那条 `/已有柱/` 是部分匹配，搬动之后它必须原样还绿 —— 真需要动那句断言，说明搬运改了文案，那是行为变更，停下来核对而不是顺手放宽。

```bash
git status --porcelain
git diff --stat
git add packages/core packages/scene-2d
git commit -m "feat: 重影柱判据进真源共享，scene-2d 出把手、落点换算与探针"
git add apps/desktop scripts package.json
git commit -m "feat: 拖端点改墙：屏幕像素落到真源，撤销栈全程有凭据"
```
第一条提交信息带上：core 的 7 条 + scene-2d 的 12 条、Step 4 逐条改坏的关键红字、`Tests 19 passed` 那一行。第二条带上：`--edit-shot` 的二十一行 PASS、上面那三行实测读数、R1–R7 各自红在哪一处。**`git status --porcelain` 在两次提交之后应当只剩计划文档一类**，出现别的文件就是漏 add 或多 add 了。


---

## 尚未展开的任务边界（补齐后才进执行）

- **Task 6 拉新墙 + 删除 + 吸附**：`snapping.ts`（端点/中点/垂足/15°/正交，按优先级）；`wallCreate` 复用既有端点时必须走 `{ pointId }` 引用，否则共享端点退化成一堆独立点、接头全断（计划 2 Task 3 的 `resolvePointRef` 就是这条的守卫）。**T5 留下的两个接缝归它**：① 吸附的插入点已选定 —— `moveTargetOf` 之后、`dispatch` 之前那一行（见 D4）；② 撤销掉"正被选中的构件"时屏幕上会留一个不存在的构件的把手（D7 的代价），随删除一起做。
- **Task 7 楼层切换 + 属性面板**：需要内核补口 —— 现在**没有** `wallSetMaterial` / `wallSetLoadBearing` / `storeyDelete` / `columnDelete` / `slabDelete`（M1.2 的"构件属性面板（厚度 / 承重 / 材料）"里只有厚度有命令）。补口放 Task 7 的第一步，且必须连带补 core 的测试与计划 2 的口径。

## 已核实的现状事实（2026-09-27 逐条读过源码，写给执行者省得再翻）

- `pnpm verify` = `typecheck && lint:deps && test`；根 `typecheck` = core + protocol + `pnpm --filter @dajia/desktop typecheck`，**不含 scene-2d**（T1 Step 1 修）。
- `vitest.config.ts` 的 alias 当前只有 `@dajia/core` 与 `@dajia/protocol`（T1 Step 1 补 `drawing` / `scene-2d` / `scene-3d`）。
- vitest `include` 是 `packages/*/test/**/*.test.ts` + `scripts/test/**/*.test.mjs`，**node 环境**，没装 jsdom。
- `scripts/check-package-deps.mjs` 的 `ALLOWED_DEPS` 已允许 `scene-2d → core, protocol`、`desktop → 全部`。
- `packages/scene-2d/` 现在只有 `package.json`（无 `dependencies` 字段、无 tsconfig）与 `src/index.ts` 一行 stub；`test/` 目录还不存在。
- `tsconfig.base.json` 的 `paths` 已含 `@dajia/scene-2d`，所以 typecheck 只缺"把包加进脚本"这一步。
- `apps/desktop/package.json` 的 `dependencies` 只有 `@dajia/core`、`@dajia/protocol`、`react`、`react-dom` —— **没有 zustand**（T3 Step 1 装，spec §技术栈 定的 `zustand@5.0.15`）。
- `apps/desktop/electron.vite.config.ts` 现在只给 `main` / `preload` 配了 alias + `externalizeDeps.exclude`，**renderer 一条都没有**；`src/renderer/index.html` 没有任何 CSS（所以 T3 用 `window.innerWidth/Height` 定画布尺寸，不引入布局变量）。
- `apps/desktop/src/renderer/src/App.tsx` 现在是"主进程应答：pong:1"的占屏页（T3 用平面图顶掉它，`IPC.ping` 通道保留）。
- core 现有命令出口：`wallCreate / wallDelete / wallMoveEndpoint / wallSetThickness / openingCreate / openingMove / openingDelete / columnCreate / slabCreate / storeyCreate / storeySetElevation`。
- `deriveStoreyGeometry(doc, storeyId)` → `{ storeyId, walls: WallQuad[], joints: Joint[], pieces: WallPiece[] }`；`WallQuad.corners` 是**环序四元组**（0 = start 侧 +normal，1 = end 侧 +normal，2 = end 侧 -normal，3 = start 侧 -normal），描边顺序即契约。
- `WallPiece` / `OpeningSpan` 都是**沿轴浮点毫米区间**（自 start 端起算），不是多边形；`wallAxisById(doc, id)` → `{ start, end, dir, normal, lengthMm, thicknessMm }`，`dir` 已归一化，所以 `advance(axis.start, axis.dir, mm)` 就是"沿轴距"。
- `aabbOfPoints([])` **抛** `RangeError` —— 这就是 `buildDrawList` / `fitStorey` 必须先对空层短路的直接原因。
- `EntityId = string`（无品牌类型），所以 scene-2d 的签名写 `string` 不构成第二套 id 系统。
- `TransactionLog`：`get document`、`get affected: ReadonlySet<EntityId>`、`undo(): boolean`、`redo(): boolean`。取"刚创建的实体"只认 `affected`（见全局约束）。
- （T4 加）`buildDrawList` 目前产的**每一条** polygon 都是 `fill: null` ⇒ `insidePolygon` 与 `distanceOfOp` 里那条 fill 分支在样例房里走不到，只有 `pick.test.ts` 的合成用例（「fill 非 null 时内部算命中」）走到它。**别把它当死代码删**：它是"点得中的就是看得见的"这条口径里唯一区分实心/空心的判据，且计划 4 的楼板填充（`slab` 的 `fill`）第一次用到它。
- （T4 加）`webContents.sendInputEvent({ type: 'mouseDown' | 'mouseUp', x, y })` 的坐标是相对页面的 DIP；T3 的画布是 1 canvas px = 1 CSS px（刻意没做 DPR 缩放），所以它与 `DrawOp` 的像素、与 `event.nativeEvent.offsetX/offsetY` 同一单位。这句话在 2026-09-27 只由文档确认，**运行时凭据是 `--pick-shot` 的十行 PASS**。
- （T5 加）`webContents.sendInputEvent` 在 Electron 44 自带的 `electron.d.ts` 里有一条原文注记：**"The `BrowserWindow` containing the contents needs to be focused for `sendInputEvent()` to work."** 所以每条发合成输入的路径都要先 `win.focus()` + `win.webContents.focus()`（Step 6 的 `focusForInput`）。同一份 `.d.ts` 里 `InputEvent.type` 的联合明列 `mouseMove` 与 `pointerDown`/`pointerUp`/`pointerMove`，`KeyboardInputEvent` 则是 `keyCode: string`（必填，取 Accelerator 键名）+ `type: 'rawKeyDown' | 'keyDown' | 'keyUp' | 'char'` + 继承来的 `modifiers: Array<'shift' | 'control' | 'ctrl' | ...>` —— **`modifiers` 里没有 `'meta'` 之外的 Windows 键，`ctrl` 与 `control` 同义**，Step 6 用 `'ctrl'`。
- （T5 加）`TransactionLog` 的 `get depth()` 就是 `undoStack.length`：`undo()` 会**减一**、`redo()` 加一、`dispatch()` 加一并**清空 redo 栈**。所以"撤销后回到 `depthAtStart`、重做后回到 `depthAtStart + 1`"是同一句事实的两种说法，`--edit-shot` 的两条 depth 判据不是重复劳动。
- （T5 加）`wallMoveEndpoint.build` 里"端点与另一端重合"那条是**逐字坐标相等**（`anchor.x === x && anchor.y === y`），紧跟其后的才是"墙厚不小于轴长"。取整像素反算回来的毫米几乎不可能与锚点逐字相同 ⇒ 压扁拖撞到的是**后一条**。所以 Step 6 的正则是 `/轴长|零长/`，写死"零长墙"会变成一条随取整方向随机红的判据。
- （T5 加）`quantizeMm` 对非有限值抛 `RangeError`、对 `-0` 归一成 `0` —— 这就是 `moveTargetOf` 不必自己防 NaN、而 `pointerPx` 必须在最上游拦掉非有限坐标的原因：拦在入口，命令层才有希望拿到一对正经毫米。
- （T5 加）`applyPatch` 只重建补丁里出现的实体，**未触及的实体保持对象同一性**（`doc.get(id) === 原对象`）。G1"柱跟走"那条的 `expect(log.document.get(column.id)).toBe(column)` 就是踩在这条契约上：跟走 = 柱实体一个字节都没动、动的只是它引用的那枚点。若哪天 `applyPatch` 改成"整份文档重建"，那句 `toBe` 会红，届时把 G1 换成 `toEqual` 并在这里补一句新的依据 —— 别让它静默退化成一条测不出东西的断言。
- （T5 加）`assertSimpleRing` 只在 `slabCreate` 的 `build` 里跑一次（`commands/slab.ts`），派生层不再复核 ⇒ 拖动挂板楼层的共享端点**可以**把已存在的楼板轮廓拖成自相交或 180° 折回，而且没有任何一条判据会红。`demoHouse()` 无柱无板，所以本任务的判据碰不到它；这条与计划 4 的读盘不变式（挂账 #5、#12）一起处理，不在 T5 里偷偷补。
- （T5 加）`demoHouse()` 一层有六枚共享端点（四个角 + 拐角 (4000,0) + 中段 (4000,3000)），且**无柱无板** ⇒ 重影柱那批用例必须自己 `columnCreate`，探针也绝不能指望样例里有柱。
- （T5 加）全仓此前**没有**一条用例钉过"同层同坐标已有柱"这条 `RangeError` 的完整文案（`commands-column-slab.test.ts` 只用了 `/已有柱/` 的部分匹配）⇒ Step 1 把判据搬进 `assertNoGhostColumn` 时，G2 是这条文案第一次被逐字钉住，搬完必须回去确认老用例仍过（它匹配的是子串，搬动不影响）。

## 执行日志

（执行时回填：每个 Task 的提交链、闸门数字、改坏验证的红字、以及 T3 的六个实测数。）
