# 搭家 S1 · 计划 3：2D 视图与编辑器（M1.2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **状态：本计划展开了 Task 1–3。** Task 4–7 的边界与验收口径列在末尾，正文尚未展开成可执行步骤 —— **补齐前不得进入执行**（Task 1 起就要改根 `typecheck` 与 `vitest.config.ts`，跑到 Task 4 才发现缺口的代价是把前三步的闸门重跑一遍）。

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
| `packages/scene-2d/src/index.ts` | 出口（现在是 `export const SCENE_2D_PACKAGE = 'scene-2d';` 一行 stub） | T1 起逐个补 |
| `apps/desktop/electron.vite.config.ts` | renderer 侧补 `@dajia/core` + `@dajia/scene-2d` 的 alias（scene-2d 源码里 import 的是裸说明符） | T3 |
| `apps/desktop/src/renderer/src/PlanCanvas.tsx` | 一块 canvas：量尺寸 → `fitStorey` → `buildDrawList` → 刷；并挂 `window.__dajiaDebug` | T3 |
| `apps/desktop/src/renderer/src/stores/editorStore.ts` | zustand：`TransactionLog`、当前层、视口。**选中集不在这儿** —— spec 明令 selection 不进真源/撤销栈，T4 另建 `selectionStore.ts` | T3 |
| `apps/desktop/src/main/index.ts` | 加 `--shot <path>`：`executeJavaScript('window.__dajiaDebug()')` → 写 JSON → `app.exit(code)` | T3 |
| `scripts/desktop-shot.mjs` | 起 Electron 跑一次回读，按判据打 PASS/FAIL；**不进 `pnpm verify`**（CI 的 ubuntu 无 xvfb） | T3 |

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
    // 本样例是"高"这一边吃满（6340mm / 780px < 8240mm / 1080px）：
    // 纵向张幅必须正好等于可用高，否则 fitStorey 把 padPx 丢了或选错了缩放边。
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
  vec,
  wallAxisById,
  type Document,
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

  // ③ opening：每樘洞口两条断口线（横穿墙厚），窗再补一条沿轴中线。
  for (const opening of doc.byKind('opening')) {
    if (opening.storeyId !== storeyId) continue;
    const axis = axisOf(axes, doc, opening.hostWallId);
    const half = axis.thicknessMm / 2;
    const near = alongAxis(axis, opening.distanceMm);
    const far = alongAxis(axis, opening.distanceMm + opening.widthMm);
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

## 尚未展开的任务边界（补齐后才进执行）

- **Task 4 命中与点选**：`pick.ts` —— `SpatialIndex.query(rect: Aabb)` 取候选（索引只有墙与洞口两种 `IndexedKind`，端点不在里头），再精判（点在轮廓内 / 到轴线距离 ≤ 阈值）；阈值按**屏幕像素**给、换算成毫米比较（`pxToMm`），保证放大时吸附不变松（spec §6）。多命中的取舍必须确定性（距离最小 → id 升序），否则同一次点击在不同机器上选中不同构件。选中集另建 `stores/selectionStore.ts`（spec 明令选中不进真源、不进撤销栈）。
- **Task 4 必须回答的一个问题**：`pick` 吃 `DrawOp[]` 的 `ownerId` 还是吃 `SpatialIndex`？前者保证"点得中的就是画出来的"（屏幕与真源同源），后者快但可能选中被遮住或没画的东西。**倾向：以指令表为准，索引只做候选加速**，但这条要在展开 Task 4 时连同遮挡取舍一起定。
- **Task 5 拖点改墙**：pointer down 命中端点 → 拖拽期只重绘临时线（要不要给 `DrawLayer` 真加一个 `interaction` 层，在这里定）→ up 时 `quantizeMm` 后 `log.dispatch(wallMoveEndpoint)`；撤销/重做快捷键接 `log.undo()` / `log.redo()`（两者都返回 `boolean`，栈空时要反馈到 UI 而不是静默）。
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

## 执行日志

（执行时回填：每个 Task 的提交链、闸门数字、改坏验证的红字、以及 T3 的六个实测数。）
