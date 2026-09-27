# 搭家 S1 · 计划 3：2D 视图与编辑器（M1.2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **状态：本计划展开了 Task 1–4。** Task 5–7 的边界与验收口径列在末尾，正文尚未展开成可执行步骤 —— **补齐前不得进入执行**（Task 1 起就要改根 `typecheck` 与 `vitest.config.ts`，跑到 Task 5 才发现缺口的代价是把前四步的闸门重跑一遍）。

**Goal:** 把 `@dajia/scene-2d` 从一行 stub 推进到「在真窗口里看得见一层平面、点得中构件」：视口仿射、绘制指令表、命中与选中，全部保持 DOM-free 可单测；像素是否真上屏由一次性截图回读证明，不靠人眼。

**Architecture:** 三层切分。① `scene-2d` 是**纯函数包**：吃 `Document` + 视口 + 选中集，吐绘制指令表（`DrawOp[]`）与命中结果，不 import DOM、不 import React、不持状态；② `apps/desktop` 的 renderer 持 `TransactionLog` 与视口状态（zustand），把指令表画到 canvas 上，把指针事件翻译成 scene-2d 的入参；③ 一切写操作一律经 core 的 command 层落盘（`log.dispatch`），scene-2d 与 renderer 都不许改 `Document`。于是"能看"和"能改"共用同一份派生几何，屏幕上的墙和导出的图纸不可能长得不一样。

**Tech Stack:** TypeScript 7.0.2 strict（`verbatimModuleSyntax` / `noUncheckedIndexedAccess` / `noUnusedLocals`）、React 19 + electron-vite 5、canvas 2D、vitest 5（**node 环境，无 jsdom**）、fast-check 4.10.2。

**Spec:** `docs/superpowers/specs/2026-09-25-dajia-s1-design.md` —— 本计划实现 §6「渲染与双向同步」与里程碑 **M1.2**；§4.2 的依赖方向由 `scripts/check-package-deps.mjs` 强制。

## Global Constraints

- **依赖方向不许破**：`scene-2d` 只许 import `core` 与 `protocol`；`desktop` 全可 import；`core` 谁都不许 import。改任何 import 后跑 `pnpm lint:deps`。
- **scene-2d 不许碰 DOM**：源码里不许出现 `document` / `window` / `HTMLCanvasElement` / `OffscreenCanvas` / `requestAnimationFrame`。理由不是洁癖：`pnpm test` 跑在 node 环境（`vitest.config.ts` 的 include 只有 `packages/*/test/**/*.test.ts`），任何 DOM 引用都会让该模块在闸门里根本跑不到 —— 一个跑不到的模块等于没有测试。canvas 绘制只发生在 `apps/desktop`。
- **浮点只许活在屏幕侧**：`Viewport`、`Px`、绘制指令里的坐标都是浮点像素或浮点毫米；**任何要写回命令的东西必须先过 `quantizeMm`**（`@dajia/core`）。拖拽中途的浮点坐标只进 renderer 的临时绘制，不进 `Document`（临时绘制走哪条路是 Task 5 的事，届时才谈要不要给 `DrawLayer` 加 `interaction`）。
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
| `apps/desktop/electron.vite.config.ts` | renderer 侧补 `@dajia/core` + `@dajia/scene-2d` 的 alias（scene-2d 源码里 import 的是裸说明符） | T3 |
| `apps/desktop/src/renderer/src/PlanCanvas.tsx` | 一块 canvas：量尺寸 → `fitStorey` → `buildDrawList` → 刷；并挂 `window.__dajiaDebug`。**T4 起**：选中进绘制、`onPointerDown` 走 `pickOne`、`opsRef` 让钩子读刷上屏那份、`DebugReport` 补 `selectedIds`/`selectedPx`/`pick`/`selectedAfterBlank` | T3 |
| `apps/desktop/src/renderer/src/stores/editorStore.ts` | zustand：`TransactionLog`、当前层、视口。**选中集不在这儿** —— spec 明令 selection 不进真源/撤销栈 | T3 |
| `apps/desktop/src/renderer/src/stores/selectionStore.ts` | zustand：`ids: ReadonlySet<string>` + `select`/`toggle`/`clear`，每次给新 Set。**没有 node 测试**（`apps/` 不在 vitest include 里，也没 jsdom），正确性由 `--pick-shot` 在真窗口钉 | T4 |
| `apps/desktop/src/main/index.ts` | 加 `--shot <path>`：`executeJavaScript('window.__dajiaDebug()')` → 写 JSON → `app.exit(code)`。**T4 加** `--pick-shot`：`sendInputEvent` 点探针给的两个点 + 条件轮询 | T3 |
| `scripts/desktop-shot.mjs` | 起 Electron 跑一次回读，按判据打 PASS/FAIL；**不进 `pnpm verify`**（CI 的 ubuntu 无 xvfb）。`--pick` 开关多四条判据（`pnpm pick-shot`） | T3 |

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

  it('panBy 是纯平移：屏幕坐标整体减掉位移，不碰缩放', () => {
    const v = viewportOf(1000, 800, { pxPerMm: 0.25, center: vec(0, 0) });
    const moved = panBy(v, { x: 40, y: -25 });
    const p = vec(800, 300);
    expect(mmToPx(moved, p).x).toBeCloseTo(mmToPx(v, p).x - 40, 9);
    expect(mmToPx(moved, p).y).toBeCloseTo(mmToPx(v, p).y + 25, 9);
    expect(moved.pxPerMm).toBe(v.pxPerMm);
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
    expect(deriveStoreyGeometry(fresh.doc, thirdId).walls).toEqual([]);
    expect(buildDrawList(fresh.doc, thirdId, view)).toEqual([]);
    // 空层也要能打开：视口退化到默认缩放，而不是把 RangeError 抛给 UI
    expect(fitStorey(fresh.doc, thirdId, 1200, 900, 60).widthPx).toBe(1200);
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
| R1 | `pick` 吃 `DrawOp[]` 的 `ownerId` 还是吃 `SpatialIndex`？ | **吃指令表，本轮根本不碰 `SpatialIndex`** | T2 把 `ownerId` 钉在每一条指令上，为的就是这一座"像素 ↔ 实体"的桥；指令表就是屏幕上那张图，索引只装墙与洞口两类 `IndexedKind`，且它的 AABB 是世界毫米 —— 拿它当靶子就把"看得见的"换成了"落在包围盒里的"，会点中已经被更高层盖住的构件。代价：全扫 O(指令数)，本样例 31 条，一次点击几微秒。**索引什么时候回来**：等出现"点一下要卡"的真证据；届时 `pickAt` 签名不动，只在 `hitDistanceOf` 之前加一趟 AABB 预筛。计划 2 转下游的 #14（`cellSizeMm` 护栏）与 #15（脏集 O(n²)）说的都是索引与重建，与本任务无关，留在 T5/T6。 |
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
      const pts = op.kind === 'polygon' ? op.pts : [op.from, op.to];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % pts.length]!;
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

1. **隐藏窗收不到合成输入**：`show: false` 下 `sendInputEvent` 理应照常派发到 Blink（T3 已证明后备缓冲能读）。若 `--pick-shot` 卡在第一处 `waitUntil` 并报"10 秒内没等到：选中 …"，先把 `createWindow(shotPath === null)` 改成 `createWindow(true)` 再跑一次；两条路径都跑不通就停下来报告 —— 那时"屏幕红了"就没有客观凭据了，不许退回去用 `executeJavaScript('el.click()')` 蒙过去（它绕开了 pointerdown 与真实坐标，正是我们要证的那一层）。
2. **`mouseDown` 不产生 `pointerdown`**：现代 Chromium 会生成。若确实是事件类型对不上，把 `onPointerDown` 换成 `onMouseDown`（React 侧一行），判据不变 —— 先跑再改，不许猜。

再验一次判据能区分"画了"和"没画"：把 `buildDrawList(log.document, storeyId, viewport, { ids })` 的第四参临时改成 `EMPTY_SELECTION`（或删掉），跑 `pnpm pick-shot` —— **必须**在"点中墙后屏幕上真的有红色像素"那行 FAIL 并抛错退出（`selectedPx` 恒 0）。改回来再跑，十行全 PASS。这条是"选中真的上屏"的唯一证明，`pick.test.ts` 管不到屏幕那一侧。

```bash
pnpm verify > /tmp/t4-verify.log 2>&1; echo exit=$?
```
Expected: exit=0，`Test Files 24 passed`（24）、`Tests 299 passed`（**284 + 15**）。数字对不上就是有用例被 skip 或没被 include 收到，先查日志别改期望值。

```bash
git add packages/scene-2d
git commit -m "feat: scene-2d 命中测试，屏幕像素容差 + 层序压倒距离"
git add apps/desktop scripts package.json
git commit -m "feat: 平面图点选与选中 store，--pick-shot 用合成指针回读证明"
```
第一条提交信息里带上 Step 5 的十条改坏命令与关键红字；第二条带上 `--pick-shot` 的十个实测数。

---

## 尚未展开的任务边界（补齐后才进执行）

- **Task 5 拖点改墙**：pointer down 命中端点 → 拖拽期只重绘临时线（要不要给 `DrawLayer` 真加一个 `interaction` 层，在这里定）→ up 时 `quantizeMm` 后 `log.dispatch(wallMoveEndpoint)`；撤销/重做快捷键接 `log.undo()` / `log.redo()`（两者都返回 `boolean`，栈空时要反馈到 UI 而不是静默）。
- **Task 5 必须先回答的语义裁决 —— 重影柱（计划 2 ledger Ruling ㊤，判给"计划 3 的拖拽入口"，本行是它的落点）**：拖一个挂着柱的共享端点，柱跟不跟走？现状事实三条，逐条读过源码：
  ① 柱以 `column.pointId` 引用那枚 point 实体，而 `wallMoveEndpoint` upsert 的正是那个点（`commands/wall.ts`：`const upsert: Entity[] = [{ ...moving, x, y }]`）⇒ 柱**一定**跟走。但这是引用共享的副作用，不是任何一条判据承诺的语义。
  ② `column.ts:56-73` 的"同层同坐标不能立两根柱"只在**建柱那一刻**判一次（判据取坐标 + 同层，不取 `pointId`）。拖动共享端点完全可以把一根柱搬到另一根柱的坐标上 ⇒ 那条判据在建完之后被破坏，而全仓没有第二处复核。
  ③ 破坏之后没人红：`deriveStoreyGeometry` 不派生柱，`SpatialIndex` 的 `IndexedKind` 只有墙与洞口 ⇒ 视图与索引都看不见悬空/重影的柱。
  **展开 T5 时要写下来的东西**：一句裁决（跟走 / 拒拖 / 拖后复核，三选一）、一条钉住它的定值用例（拖共享端点 ⇒ 柱坐标变了 / 命令抛 / 命中阶段就不给把手），以及若裁决是"跟走"，那第二处复核放在哪一层（命令层加守卫，或计划 4 的读盘不变式）。这条与"`DrawLayer` 加不加 `interaction` 层"同等必答，不许默认现状。
- **Task 6 拉新墙 + 删除 + 吸附**：`snapping.ts`（端点/中点/垂足/15°/正交，按优先级）；`wallCreate` 复用既有端点时必须走 `{ pointId }` 引用，否则共享端点退化成一堆独立点、接头全断（计划 2 Task 3 的 `resolvePointRef` 就是这条的守卫）。
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

## 执行日志

（执行时回填：每个 Task 的提交链、闸门数字、改坏验证的红字、以及 T3 的六个实测数。）
