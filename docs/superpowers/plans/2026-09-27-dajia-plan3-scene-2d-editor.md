# 搭家 S1 · 计划 3：2D 视图与编辑器（M1.2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **状态：Task 1–9 全部执行完毕（2026-09-30）。** **五个真窗口闸门（`--shot` / `--pick-shot` / `--edit-shot` / `--draw-shot` / `--prop-shot`）里所有写死的像素/毫米/条数字面量都已在真窗口跑过并回填实测**（编写期跑不了：`apps/desktop` 的 renderer 到 2026-09-28 仍是 pong 占屏页，`scripts/desktop-shot.mjs` 要 Task 3 之后才存在）；判据条数的盘上终账 = **6 / 11 / 21 / 28 / 29**，五个闸门在 Task 9 那份树上全部 PASS 且一字未改。node 侧的账以**盘上**为准，编写期那两段临时工程预预言（`.tscheck/t9` 449、`.tscheck/t10` 461，以及"真仓库预计 438 → 464 → 476"）**全部作废**：Task 8 落地 = **439 → 482**（34 文件），Task 9 落地 = **482 → 494**（`Test Files` 34 一字不动，净增 12 全在 `snapping.test.ts` 32 → 44；core 25 文件 / 316 条从头到尾没碰）；Task 9 的 **fix 轮**（评审 P1-1）再 **494 → 495**（`handles.test.ts` 33 → 34，给 `axisCross` 补上句柄/落点出口的确定性见证）。两张改坏表（Task 8 的 M1~M9、Task 9 的 N1~N9 + 自补 X1）逐条红名见各自 Step 6 的执行回填；Task 9 那一张里有两处当场把边界段的错误预言改掉了（交点档对样例房进表 **0** 枚 ⇒ 五个闸门判据一字不换；Task 8 的两枚确定性夹具不必重算那四个数），另有**一处计划漏列的改动**（`absorbedByPoint` 的档位过滤）与**一处落空的步骤**（Step 4 那条 `handles.test.ts` 改写在盘上无对象可改）—— 三处都记在 Task 9 的执行回填里。

**Goal:** 把 `@dajia/scene-2d` 从一行 stub 推进到「在真窗口里看得见一层平面、点得中构件」：视口仿射、绘制指令表、命中与选中，全部保持 DOM-free 可单测；像素是否真上屏由一次性截图回读证明，不靠人眼。

**Architecture:** 三层切分。① `scene-2d` 是**纯函数包**：吃 `Document` + 视口 + 选中集，吐绘制指令表（`DrawOp[]`）与命中结果，不 import DOM、不 import React、不持状态；② `apps/desktop` 的 renderer 持 `TransactionLog` 与视口状态（zustand），把指令表画到 canvas 上，把指针事件翻译成 scene-2d 的入参；③ 一切写操作一律经 core 的 command 层落盘（`log.dispatch`），scene-2d 与 renderer 都不许改 `Document`。于是"能看"和"能改"共用同一份派生几何，屏幕上的墙和导出的图纸不可能长得不一样。

**Tech Stack:** TypeScript 7.0.2 strict（`verbatimModuleSyntax` / `noUncheckedIndexedAccess` / `noUnusedLocals`）、React 19 + electron-vite 5、canvas 2D、vitest 5（**node 环境，无 jsdom**）、fast-check 4.10.2。

**Spec:** `docs/superpowers/specs/2026-09-25-dajia-s1-design.md` —— 本计划实现 §6「渲染与双向同步」与里程碑 **M1.2**；§4.2 的依赖方向由 `scripts/check-package-deps.mjs` 强制。

## Global Constraints

- **依赖方向不许破**：`scene-2d` 只许 import `core` 与 `protocol`；`desktop` 全可 import；`core` 谁都不许 import。改任何 import 后跑 `pnpm lint:deps`。
- **scene-2d 不许碰 DOM**：源码里不许出现**浏览器全局** —— `document` 或 `window` 这两个词本身不是禁令（执行回填 T2/T3：`log.document` 是 core 的真 API，`'window'` 是洞口类别的字面量，两处都合法且必需；绑定的东西是"不许访问浏览器环境"），真正的黑名单是 `HTMLCanvasElement` / `OffscreenCanvas` / `requestAnimationFrame` / `localStorage` / React / `apps/desktop` —— 这几样在 `packages/scene-2d/**` 里 T1–T3 实测**零命中**。理由不是洁癖：`pnpm test` 跑在 node 环境（`vitest.config.ts:19` 的 include 是 `packages/*/test/**/*.test.ts` **与** `scripts/test/**/*.test.mjs` 两条，执行回填：本节此处原先只写了前一条），任何 DOM 引用都会让该模块在闸门里根本跑不到 —— 一个跑不到的模块等于没有测试。canvas 绘制只发生在 `apps/desktop`。
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
| `package.json`（根） | `typecheck` 串上 scene-2d；**T6 加** `"draw-shot"`（`shot`/`pick-shot`/`edit-shot` 三条一字不动） | T1 |
| `packages/scene-2d/src/viewport.ts` | 整数毫米 ↔ 屏幕像素仿射：`Viewport` / `mmToPx` / `pxToMm` / `panBy` / `zoomAt` / `fitViewport` | T1 |
| `packages/scene-2d/test/viewport.test.ts` | 上面那个的可红测试（含 2 条属性） | T1 |
| `packages/scene-2d/src/demo.ts` | `demoHouse()`：无持久化时的样例两层房，命令现场建，desktop 与测试共用同一份几何 | T2 |
| `packages/scene-2d/src/drawlist.ts` | `buildDrawList(doc, storeyId, viewport, selection)` → `DrawOp[]`；`fitStorey(...)` → 该层的初始视口 | T2 |
| `packages/scene-2d/test/drawlist.test.ts` | 指令表的结构与不变式 | T2 |
| `packages/scene-2d/src/pick.ts` | 命中测试：`PICK_TOL_PX` / `distanceToSegmentPx` / `pickAt` / `pickOne` / `probeTarget`（靶子 = 指令表，容差 = 屏幕像素）。**T6 起**：候选点扫描抽成文件内私有 `uniqueHitOf`，新增出口 `pickPxOf`（给"点某构件的中点"这一发像素用） | T4 |
| `packages/scene-2d/test/pick.test.ts` | 命中的判据：容差两侧、回边、层序压倒距离、去重、NaN 守卫、2 条属性。**T6 +3 条 ⇒ 18 条** | T4 |
| `packages/scene-2d/src/index.ts` | 出口（现在是 `export const SCENE_2D_PACKAGE = 'scene-2d';` 一行 stub） | T1 起逐个补；T6 加 `snapping` / `editing` 两行 |
| `packages/scene-2d/src/snapping.ts` | 六档吸附（端点/中点/垂足/**轴网交点**/正交/15° —— 编写期写"五档"，`axisCross` 是 T9 补的第六档）：`SNAP_TOL_PX`/`ANGLE_TOL_DEG`/`SNAP_COLOR`/`SNAP_MARK_HALF_PX`、`snapFieldOf`、`snapFromCursor`、`dropTargetOf`、`pointRefOf`；T5 的 `MoveTarget` 三件套（`MoveTarget`/`quantizeTarget`/`moveTargetOf`）从 `handles.ts` 迁到这里 | T6 |
| `packages/scene-2d/test/snapping.test.ts` | 吸附的判据 **44 条**（编写期 28 条 ⇒ 盘上 = 28 + T8 的 4 + T9 的 12，含属性；见各自执行回填的计数账）：分组压倒距离、并列按 `ownerId`、档位互斥、`excludeMm`、NaN | T6 |
| `packages/scene-2d/src/editing.ts` | 工具态与画墙草稿：`Tool`、`draftAtPress`/`moveDraft`/`draftRefs`/`legalWallCreate`/`draftCommand`、`newWallDefaults`、`planDelete`/`pruneSelection`、`lastCreatedWall`、`wallProbe`（六道筛）。**T7 只改注释**：`derivesCleanly` 那条从"唯一防线"改成"第二道保险"（`wallCreate` 的 `build` 已复核，两侧同判），代码不动 | T6 |
| `packages/scene-2d/test/editing.test.ts` | 编辑判据 **35 条**（编写期 30 ⇒ 盘上 = 30 + T8 的 5，含 1 条属性）：草稿三态、删除四色出口、`unsupported`、探针六筛与自洽。**T7 改**其中「⑥ 的前提：命令层放行、派生层抛」那条 ⇒ 改名并断言**两层同判**，**30 条不变** | T6 |
| `packages/scene-2d/src/handles.ts` | 拖拽的屏幕侧全部纯函数：`HANDLE_COLOR`/`PREVIEW_COLOR`/`PIXEL_CHANNEL_TOL`/`HANDLE_RADIUS_PX`、`dragHandlesOf`、`pickHandle`、`legalDrop`（试跑 core 的 `build` 当合法性预言）、`dragProbe`、`pointSnapshot`。**T5 的 `moveTargetOf` 三件套 T6 迁往 `snapping.ts`**；`DragHandle` 补 `anchorMm`；`dragProbe` 的落点改吃 `dropTargetOf`，并新增出口 `handleDropTarget`。**T7 只改注释**：那句"`legalDrop` 试跑 `build`，不跑 `deriveStoreyGeometry`"在 T7 之后是错的 ⇒ 换成"core 的三条改几何命令已在 `build` 末尾复核派生，`legalDrop` 与真源同判" | T5 |
| `packages/scene-2d/test/handles.test.ts` | **13 条**（实测；正文原写 12 条，多出来的那条是执行中撞出来的：`探针的落点像素必须在画布内、且那一发派生得出` ⇒ 同时钉住 `insideCanvas` 与 `derivesAfterMove` 两道新筛）：把手只给选中的墙、顺序与插入序无关、并列按 key、NaN、`legalDrop` 三条（含"坏的是邻墙"）、探针四性质、快照键集合、三种颜色互相分得开。**T6 +7 条 ⇒ 20 条**（合成把手补 `anchorMm`；配色那条从三色列成四色；`moveTargetOf` 那句换成恒等式）。**执行回填：盘上终账 34 条** = 20 + T8 的 13（2 条是裁决 T8-5 / D4 修 bug 的用例，11 条是棒 E 的 `propProbe` 那一组，两组编写期都没有）+ T9 **fix 轮**的 1 条（`axisCross` 在句柄出口那一格的确定性见证） | T5 |
| `packages/core/test/commands-drag.test.ts` | 7 条：柱跟走（对象同一性）/ 重影柱抛错 / 同一句文案的第二个产地 / 跨层正对照 / 原地拖不抛 / `end:'start'` 角色反转两条 | T5 |
| `packages/core/src/geom/topology.ts` | 加 `assertNoGhostColumn(doc, storeyId, at, exceptPointId?)` —— 判据从 `columnCreate` 里搬出来，第二个产地是拖动落点复核。**T7 加** `pointStillReferenced(doc, pointId, exceptIds)`：孤儿点判定的唯一产地（墙两端 / 柱落点 / 板边界三类都查），`wallDelete` 那份文件私有 `stillReferenced` 删掉搬上来，`columnDelete` / `slabDelete` 共用 | T5 |
| `packages/core/src/model/command.ts` | **T7**：`CommandType` 11 → 16（`storey.delete` / `wall.setMaterial` / `wall.setLoadBearing` / `column.delete` / `slab.delete`）。`Command` 接口不动 | T7 |
| `packages/core/src/geom/outline.ts` | **T7 加** `assertDerivesAfterApply(doc, patch, storeyId)`：命令层的派生复核，`deriveStoreyGeometry` 那四道守卫在写入侧的唯一出口 | T7 |
| `packages/core/src/commands/wall.ts` | **T7**：`wallCreate` / `wallMoveEndpoint` / `wallSetThickness` 的 `build` 末尾挂复核；新增 `assertMaterial` / `wallSetMaterial` / `wallSetLoadBearing`；`wallDelete` 改问 `pointStillReferenced` | T1 |
| `packages/core/src/commands/{storey,column,slab}.ts` | **T7 加** `storeyDelete`（级联问 `dependentsOf` + 闭合性检查 + 最后一层不许删）、`columnDelete`、`slabDelete`，并各补一份文件私有读取断言 | T1 |
| `packages/core/test/{derive-guard,commands-attributes,commands-delete}.test.ts` | **T7 新增 9 / 12 / 12 条**：复核的正反两组、属性命令的补丁形状与撤销栈、三条删除命令的级联与孤儿点。core 计数 21 文件 / 276 条 ⇒ **24 / 309** | T7 |
| `packages/core/test/joint.test.ts` | 派生层四道守卫（同向重叠 / 翻面 / 直通异厚 / star）的哨兵。**T7 改**：五条用例的造图从"走命令"换成 `handBuild(...)` 手工贴实体（命令层 T7 起会先挡），**18 条不变** | T2 |
| `apps/desktop/electron.vite.config.ts` | renderer 侧补 `@dajia/core` + `@dajia/scene-2d` 的 alias（scene-2d 源码里 import 的是裸说明符） | T3 |
| `apps/desktop/src/renderer/src/PlanCanvas.tsx` | 一块 canvas：量尺寸 → `fitStorey` → `buildDrawList` → 刷；并挂 `window.__dajiaDebug`。**T4 起**：选中进绘制、`onPointerDown` 走 `pickOne`、`opsRef` 让钩子读刷上屏那份、`DebugReport` 补 `selectedIds`/`selectedPx`/`pick`/`selectedAfterBlank`。**T5 起**：`paintHandles` + `paintPreview` 两个专用画家、window 级 `pointermove/up/cancel` 状态机、`Ctrl+Z`/`Ctrl+Shift+Z`、`DebugReport` 再补 **14** 个字段（实测；正文原写 12 个，补竞态时加了 `dragTargetMm`/`dragCursorPx`：`revision`/`depth`/`canUndo`/`canRedo`/`lastError`/`handlePx`/`previewPx`/`previewNearCursorPx`/`points`/`edit`/`dragTargetMm`/`dragCursorPx`/`lastDrop`/`lastKeyEvent`；连同 T4 之前的 10 个 ⇒ 共 24 个读数）。**T6 起**：`paintSnapMarker` 第四色画家 + 第 6 个像素桶、模式分支（`W` 进拉墙 / `Escape` 两级退场 / `Delete`+`Backspace` 删除）、拖拽落点改走 `handleDropTarget`、`DebugReport` 再补 9 个字段（`tool`/`draft`/`snapMarkPx`/`lastCreate`/`deletedIds`/`unsupportedIds`/`selectionAfterDelete`/`lastHotkey`/`draw`） | T3 |
| `apps/desktop/src/renderer/src/stores/editorStore.ts` | zustand：`TransactionLog`、当前层、视口。**T5 起**：`revision` 扳机（只在成功后 +1）、`lastError`、`drag` 态、`dispatch` 的 `catch`。**T6 起**：`tool` / `draft` 两格 + `setTool` / `setDraft` / `dispatchBatch`。**选中集不在这儿** —— spec 明令 selection 不进真源/撤销栈 | T3 |
| `apps/desktop/src/renderer/src/stores/selectionStore.ts` | zustand：`ids: ReadonlySet<string>` + `select`/`toggle`/`clear`，每次给新 Set。**T6 加** `retain`（删除后给选中剪枝）。**没有 node 测试**（`apps/` 不在 vitest include 里，也没 jsdom），正确性由 `--pick-shot` 在真窗口钉 | T4 |
| `apps/desktop/src/main/index.ts` | 加 `--shot <path>`：`executeJavaScript('window.__dajiaDebug()')` → 写 JSON → `app.exit(code)`。**T4 加** `--pick-shot`：`sendInputEvent` 点探针给的两个点 + 条件轮询。**T5 加** `--edit-shot`：`pressPx`/`movePx`/`releasePx`/`keyCombo` 八步拖拽 + 撤销重做，每步读数分别留档；`argPath(flag)` 让开关与路径成对。**T6 加** `--draw-shot`：`runDrawShot` 十六步（进模式 → 按下吸端点 → 移动 → Escape → 原地松手被拒 → 真建一面墙 → 拉墙模式删除沉默 → Escape 退模式 → 点新墙 → Backspace 删 → 撤销 → 重做 → 终态探针回基线逐字相等），加 `DrawReportShape` | T3 |
| `scripts/desktop-shot.mjs` | 起 Electron 跑一次回读，按判据打 PASS/FAIL；**不进 `pnpm verify`**（CI 的 ubuntu 无 xvfb）。`--pick` 多四条（共 10 PASS）、`--edit` 多十五条（共 21 PASS）、**T6 `--draw` 多二十一条（共 27 PASS）** | T3 |

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
Expected: exit≠0，红在**函数不存在**上：`TypeError: ... buildDrawList is not a function` 一类。**订正（2026-09-28，Task 6 编写时实测机制后回填）**：原稿这里写的是"红在解析/导出缺失（`does not provide an export named 'buildDrawList'`）"，那个形状在 vitest 5 的 SSR 转译下**不会**出现 —— `export *` 里缺的名字不会在链接期抛 `SyntaxError`，它是 `undefined`，到调用那一行才炸（凭据见 Task 6 Step 4 的订正与实测）。判据不变：红必须落在"拿不到函数"上，**不许**红在断言值上。

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

#### 执行回填（Task 2，2026-09-28 实测；commit `2a6879d`）

- **计数**：`pnpm verify` exit=0，Test Files **24 → 25**、Tests **293 → 303**（本任务新增 10 条，全在 `packages/scene-2d/test/drawlist.test.ts`）。RED 落在 `TypeError: demoHouse is not a function` —— 函数拿不到，不落断言值。
- **改坏第 6 条按计划的位置挪会先撞 TDZ**：把楼层标签的 push 往后挪到 `penFor` 定义之前那一版，红成一串引用错误而不是预期的那条层序断言；挪到「① 之前」（紧跟 `pts`/`polys` 那段）才拿到干净单点红 `expected 0 to be greater than or equal to 2`（`layerRank` 单调性）。**这条判据仍然成立**，只是落点要挑在 `penFor` 之后。
- **改坏第 7 条红的不是预言的那一句**：`fitStorey` 的 `padPx` 传 0，先倒的是**边界圈里那条**（`expected -43.26923… to be greater than or equal to 0`，越界的正好是标签），计划预言的张幅断言在它的下游。根因写进挂账：`fitStorey` 的边界圈把 `annotation` 那条 op 也算进去了，今天能过只是因为 pad=60 恰好大于标签外偏（≈37.5 px）。谁改 `LABEL_OFFSET_MM` 或样例房几何，这条必红。
- 改坏第 9 条（去掉 `axisOf` 缓存）是**反向哨兵**，按要求必须还绿：实测全绿 exit=0、`Tests 10 passed (10)`。
- 评审挂来四条不在本格修：property 用例那半自反的 `toHaveLength(expectedOps)`、上面那条边界圈、`fitStorey`/`buildDrawList` 各算一次 `deriveStoreyGeometry`（三条都转交第一个真消费者 Task 3），以及 `drawlist.ts:130-131` 与 `:137-138` 两次同谓词扫 `opening`（无下游消费者，按计划既有裁决转终审）。

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

#### 执行回填（Task 3，2026-09-28 实测；commits `b7c0455` + `6ddb090`）

- **六个 PASS 全过，实测 JSON**（首轮，窗口可见那版）：`{"ops":31,"layers":{"structure":20,"opening":10,"annotation":1},"nonBlankPx":30633,"wPx":1427,"hPx":839}`；`20+10+1=31` 与判据表自洽。负测按要求跑过：把绘制表喂空 ⇒ `nonBlankPx=0` 且 exit=1（"绿着但什么都没画"这条路是关的），回改后重跑绿。`pnpm verify` 仍是 **25 / 303**，本任务零新增用例。
- **屏幕尺寸不是常数**：同一份代码两次实测 `hPx` = **839** 与 **865**。凡本任务及后续 `--pick-shot` / `--edit-shot` / `--draw-shot` 里"写死绝对像素"的判据都必须写成不变量（区间、单调、非零、"选中会改变输出"），只有纯函数那一侧的 31/20/10/1 可以写死。**T4–T6 的判据表照此办理。**
- **Step 4 那段 spawn 写法已被 `6ddb090` 换掉，别照抄本节正文**：正文那版 `spawnSync('pnpm', [...,'--shot', out], { shell: true })` 在 win32 上是坏的 —— `shell: true` 时 Node 把命令与参数拼成一条字符串、**不逐参数加引号**，于是临时目录一旦含空格（`C:\Users\Name With Space\…`）路径就在空格处断开，闸门在一点问题没有的机器上假失败；顺带每次跑都吐 `DeprecationWarning DEP0190`。现在的形态是：`createRequire(join(desktopDir,'package.json'))('electron')` 解析出 Electron 二进制，`runElectron` **不经 shell** 直起它，pnpm 构建那步走 `runPnpm`（单条预拼命令串、无参数数组）。**T4/T5/T6 复制这条闸门时复制新形态。**
  - 这条是**计划缺陷**，不是实施者失误：实施者是把正文逐字落地的。RED/GREEN 都有实测 —— RED：含空格的 TEMP 路径 exit=1；GREEN：同命令 exit=0 六行 PASS。
  - 失败点比本节预言晚一层：截断后的路径 `shotPathFromArgv` **是接受的**（它只拦 `undefined` 与 `--` 前缀），于是一发 shot "成功"、把 report 写到截断目录里，闸门死在下一行的 `readFileSync` ENOENT。预言里以为守卫会当场拒。
  - `os.tmpdir()` 在本机**只认 `TEMP`，单独设 `TMP` 无效** —— 想复现空格路径得设 `TEMP`。
- **`--shot` 现在不显示窗口**（`show: visible` + `ready-to-show` 只在可见分支里 `show()`），并且这条改完才第一次真正走到本节正文引用过的那句理由 ——「`show: false` 下 canvas 照样绘制」：隐藏窗口的回读实测 `nonBlankPx=31710`。在那之前代码一直显示着窗口，那句理由没人证明过。
- **坏参数改成秒退**：`--shot` 后面缺路径/跟着一个 flag，原先 throw 在 `app.whenReady().then(async …)` 里、 rejection 被丢弃，于是既不 `app.exit` 也没窗口，`window-all-closed` 永不触发，只能等 `spawnSync` 那 180 秒超时；现在 try/catch + `app.exit(2)`，实测 **exit=2 / 267ms**。
- 两条评审意见按既有裁决**不在本格修**：`desktop-shot.mjs` 里 31/20/10/1 重述了 `drawlist.test.ts` 从结构推出来的数（两个闸门刻意独立 —— node 侧与真窗口侧，合掉得等能分辨两半的测试，转终审）；那条名字写着「画布尺寸 = 窗口内容区」其实只断言了 `wPx>800 && hPx>500`（转 Task 4 —— 它本来要扩 `DebugReport`，改名或真去比 `innerWidth/innerHeight` 都由它定）。
- **CI 零暴露**：`.github/workflows/ci.yml` 只跑 `verify` 与 desktop build，`pnpm shot` 不在其中（本任务 Step 5 的刻意设计），所以上面那条 spawn 改动不影响 CI。

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
>
> **（终审裁决，2026-09-30：上面那句「不改」到此为止，`layerRank` 改。** 计划 3 整支终审 A 席 P1-1）当时不合并的理由是"改它要重跑 T2 那九条改坏、收益不在本格"，而 T4 之后**第一个能分辨两半的消费者真的长出来了**：`pick.ts:82` 的 `rankOf` 吃 `DRAW_LAYERS`，`drawlist.test.ts:130` 吃自己那份硬编码副本 —— 于是**没有任何一条用例把 `buildDrawList` 的真实出图序钉在 `DRAW_LAYERS` 上**，谁重排那张表（或加一层忘了同步 push 序），node 两侧各自判绿、屏幕上"看得见的叠序"与"点得中的优先级"各漂各的。这正是本计划那条挂账裁决的反面案例：**判据的形状要等到能分辨两半的消费者出现才合，出现了就得合**。修法 1 行（`:51` 改读 `DRAW_LAYERS.indexOf`，与 `pick.test.ts:371` 同法），`src` 零改动 ⇒ T2 的九条改坏不用重跑（第 6 条钉的是"标签排最后"，改的是它的**读数来源**不是它的判据），真窗口五闸门同样不动。代价与收益都在同一格：改完之后 `:130` 才是"出图序 == 层表"的凭据。

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
Expected: exit≠0，红在**函数不存在**上：`TypeError: ... pickAt is not a function` 一类。**订正（2026-09-28，Task 6 编写时实测机制后回填）**：原稿写的是"红在解析/导出缺失（`does not provide an export named 'pickAt'`）"，vitest 5 的 SSR 转译不会在链接期抛那个 `SyntaxError` —— `export *` 里缺的名字是 `undefined`，到调用那一行才炸（凭据见 Task 6 Step 4 的订正与实测）。**不许**出现"`probeTarget` 那条绿了"—— 导出不存在时任何断言都拿不到函数。

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
10. `probeTarget` 的 `hits.length !== 1` 改成 `hits.length < 1` → 「probeTarget 只接受唯一命中的候选点」必须红在 `expect(probe.clickPx).toEqual({ x: 200, y: 40 })`（放宽筛选后探针拿到的是被洞口线压住的 (200, 0)）。样例房那条 `probeTarget` 用例**不会**红 —— 它的第一个候选边本来就唯一，所以 R4 的牙齿全靠这条合成用例。别把它当装饰删。（**Task 6 Step 3 之后这段住在 `uniqueHitOf` 里** —— 那段候选点扫描被抽成文件内私有函数，`probeTarget` 与新的 `pickPxOf` 各吃它一次；改坏的位置跟着改名，红法与红在哪一条用例一字不变，凭据见 Task 6 Step 3 的 PK13。）

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

#### 执行回填（Task 4，2026-09-28 实测；commits `c025668` + `5756c12` + `fa05e41`）

- **账**：`pnpm verify` exit=0 **26 文件 / 318 条**（+`pick.test.ts` 15 条，含 2 条属性）。`pnpm pick-shot` **11 行 PASS**（正文那张十行表 + 新增的原点行），`ops=31` 与 T3 同值；连测 **7** 轮全绿（`5756c12` 正文写「6 轮」少算一轮，按 `fa05e41` 的日志核实为 7；口径 = P0 修复之后的绿测，故意打红的哨兵按名字与时间戳排除）。RED 形状：15 条全红在 `TypeError: pickAt is not a function`。
- **本节正文那套点击序列在这台机器上物理性坏**（T4 最大的实测收获，**T5/T6 抄闸门之前先读这条**）：`apps/desktop` 的 `index.html` **一行 CSS 都没有** ⇒ UA 的 `body { margin: 8px }` 把画布顶开，而 **8px 正好等于 `PICK_TOL_PX`**，实测 `rect=[8,8]`。探针点是**画布坐标**、`sendInputEvent` 吃**页面坐标**，正文把两者当同一套用了。`PICK_TOL_PX` 一分未改的前提下，判定会随 uuid 顺序漂、表现成"点了没反应"。
- **R4（本轮裁决）：前提必须由实测断言，不许由 CSS 或注释背书。** 落成的形态：`PlanCanvas.tsx` 挂载时清零 `document.body.style.margin`（**带 cleanup**，样式突变不许"改了没人还"）、`DebugReport` 新增 `canvasOriginPx`（`getBoundingClientRect()` 实测）、`main/index.ts` 里两套空间各有名字（`CanvasPx` / `ViewportPx`）并有 `clickCanvasPx(win, p, origin)` 加**实测**原点、闸门新增一行断言原点 `= (0,0)`。**RED 证过**：临时把 margin 设成 24px ⇒ exit=1 且**只有那一行红**，而换算后的点击仍然命中 —— 能在 24px 偏移下还命中的机制只有 `p + origin` 这一条路（渲染侧用 `offsetX/offsetY`，Chromium 已经是画布口径，所以它**不该**再加原点，也确实没加）。为什么值得做到这一步：**T8 要往 PlanCanvas 区域挂 `<StoreyTabs/>` 与 `<PropPanel/>`**，这套布局注定变；T5/T6 的 `--edit-shot` / `--draw-shot` 复用同一条探针通道。
- **R5：一个判据一个主人。** 正文那张表里**四行原本永远印不出 FAIL**（`pick===null`、`selectedPx>100`、`clickedOwner`、空白点后清零）—— main 侧 `waitUntil` 已经拿同一份快照判过，脚本只是回读。不是假绿（行为判得响、exit 归闸门），坏在「十行 PASS」把独立判据的条数吹大、且阈值两份会漂。`fa05e41` 之后 main 只轮询**需要 settle 的那一半**（`selectedIds.length` 到 1 / 到 0），恒等与像素阈值只活在 `scripts/desktop-shot.mjs`。反证：**反向哨兵现在真能红成 FAIL 行**（实测红在「点中墙后屏幕上真的有红色像素」、其余行绿、exit=1），修之前它红成 main 的一个 throw —— 那是这条缺陷的症状，不是时机问题。唯一刻意留在 main 侧的阈值是 `!before.pick`（探针没给靶子就没得点），已声明。
- **正文被实测推翻的另两条**：① 改坏第 9 条预言 shuffle 属性会红，实测**只有定值用例红** —— 当前 fixture 里不存在"同层同距离"的一对，属性碰不到 `ownerId` 平手那一档（对层序与距离仍有牙，不属 plan:22 禁的"任何输入都不会红"）→ 转终审。② `--pick-shot` 不带 `--shot` 会静默走交互启动 → 转 T5（它本来要把 `shotPathFromArgv()` 换成通用 `argPath(flag)`，配对校验顺带收掉）。
- **交接给 T5/T6 的三条硬事实**：`probeTarget` **只扫 `polygon`** ⇒ 真窗口那 11 行结构上只可能选中墙轮廓，洞口/轴线的命中只在 node 里证过，别把 11 行读成三层都覆盖；合成输入要求窗口有 **OS 前台焦点**，T4 实测到**一次瞬态红**（`focusForInput` 过了、那一发仍没派发，重跑绿）—— 这条**不许用静默重试糊过去**，效果观察不到时必须响亮地失败（现状：store 不变 ⇒ `waitUntil` 10 秒 throw ⇒ `app.exit(1)`，响亮但慢，是设计选择）；`shotPathFromArgv` 的守卫只拦 `undefined` 与 `--` 前缀（T3 那条截断路径就是"成功"到下一行才死的）。
- 评审结论：首轮 **Needs fixes**（I1 前提没被断言、I2 四行不可能红，加两行 Minor：`if (before.pick === null)` 漏 `undefined`；`pick.test.ts` 的层序 oracle 重抄数组而没用本任务刚导出的 `DRAW_LAYERS` —— **`drawlist.test.ts` 那个局部 `layerRank` 按正文继续不动**）。fix round 1（`fa05e41`，4 文件 +75/−25）后 scoped re-review：**四条全部 addressed、0 回归、Ready to close**；`--shot` 那六条基础判据逐字节未变，`ClickPoint`→`CanvasPx`/`ViewportPx` 改名无残留。
- **事故记录（控制位自己的账）**：本轮的 scoped re-review seat 违反了"只读"约定，19:51:09 在 reflog 里留下 `checkout: moving from plan3-scene-2d-editor to main`。没有提交落进 `main`（main 仍停在 `ab3115e`），代价是工作树被换到 `main`、控制位当时正编辑的计划文件落成了 main 那一份。此后所有 seat 的 dispatch 一律带一条硬禁：**不许 `git checkout` / `switch` / `restore` / `stash` / `reset`，你在哪条分支就在哪条分支干活。**

---

### Task 5: 拖端点改墙（屏幕上的像素落到真源，且撤销栈知道发生了什么）

**Files:**
- Modify: `packages/core/src/geom/topology.ts`（新增 `assertNoGhostColumn`，从 `columnCreate` 里搬判据）
- Modify: `packages/core/src/commands/column.ts`（那段循环换成调用共享判据；`requirePoint` 随之不再使用，必须从 import 删掉）
- Modify: `packages/core/src/commands/wall.ts`（`wallMoveEndpoint` 在算完新轴长与全部合法守卫之后补第二处复核）
- Create: `packages/core/test/commands-drag.test.ts`（7 条：重影柱与跟走 5 条 + `end:'start'` 角色反转 2 条）
- Create: `packages/scene-2d/src/handles.ts`（把手、落点换算、合法性预言、拖拽探针、端点快照、编辑器配色）
- Modify: `packages/scene-2d/src/index.ts`（`export * from './handles';`）
- Create: `packages/scene-2d/test/handles.test.ts`（**13 条**实测，正文原写 12；全是 node 里跑的纯函数）
- Modify: `apps/desktop/src/renderer/src/stores/editorStore.ts`（`revision` / `lastError` / `drag` + `dispatch`/`undo`/`redo` 三个动作）
- Modify: `apps/desktop/src/renderer/src/PlanCanvas.tsx`（整体替换：指针状态机、把手与临时线的绘制、`DebugReport` 补 **14** 个字段（实测，正文原写 12）、快捷键）
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
    **订正（2026-09-28 实测，Task 6 Step 5 跑同一处改坏时量出来的）**：在样例房那把尺子上这一条**一条都不红** —— `fitStorey(…, 1200, 900, 60)` 给的是 `0.125 px/mm`，百米毫米的坐标取整前后本来就是同一个数，那三句"整数"断言在 T5 的文件里是**空转的**（假绿）。真正咬 `snapPx` 的牙齿是 Task 6 Step 5 新加的那份 1200×901 尺子（`781/6240` px/mm，用例自己带一句"现场自证原生像素是浮点"），改坏编号 HC2，八个进程恒红。所以：**T5 执行到这一条时"改坏了还绿"是预期内的**，不许为此放宽别的判据、也不许在这里现造一份分数尺子（那是 Task 6 的活）；这一条在 T5 的清单里留作**已登记的无证改坏**，凭据由 HC2 补上。
11. 探针的像素↔毫米**反向**对调（`targetMm = moveTargetOf(v, h.atPx)`、`toPx = mmToPx(v, h.atMm)`）→ 两条必须同时红：「三枚像素全为整数」（`toPx` 是浮点）与「落点必然合法」（落点退回原地，`legalDrop` 那条判的是原地）。反向哨兵：它对"干脆把两个字段都返回原坐标"这类整段写反的改动有牙齿，而第 10 条只在 `snapPx` 内部。
    **同上一条的订正**：这两半里只有「落点必然合法」在样例房真有牙（落点退回原地 ⇒ `legalDrop` 给 false，与比例无关）；「三枚像素全为整数」在 0.125px/mm 下照样空转。Task 6 Step 5 的 HC3 跑的是同一处改坏、在 19 条的文件上实测 `14/5` 五处同时红，多出来的三处全是那一步新加的夹具与用例。
12. `dragProbe` 删掉 `pickOne(ops, fromPx)?.ownerId !== h.wallId` 那一句 → **不保证红**：接头处哪面墙赢取决于每次现建的 uuidv7，样例房这局可能本来就选中它。它的凭据在 Step 6 —— `--edit-shot` 里"按在把手上即选中那面墙"那条判据（`selectedAfterPress === edit.wallId`）必须成立，那是真窗口里同一份文档上的确定断言。改了不红，也不许反过来删探针那句。
13. `pointSnapshot` 删掉 `storeyId` 过滤 → 快照那条必须红在键集合（别层的点漏进来）。
14. `pointSnapshot` 的循环只收 `wall.startId` → 同一条必须红在键集合（少一半）；`for (const id of [startId, endId])` 换成 `for (const id of [wall.startId, wall.startId])` 也一样红。
15. 摘掉 `wall.ts` 里 Step 1 加的那行 `assertNoGhostColumn` → core 侧 G2 必须红，G1/G3/G4/G5 必须还绿（复核只有"拖带着柱的端点"这一条路在用，别的产地各自有守卫）。
16. `assertNoGhostColumn` 的 `if (column.storeyId !== storeyId) continue;` 删掉（跨层也判）→ G4 正对照必须红。
17. `wall.ts` 调用处不传 `exceptPointId` → G5 必须红（原地拖报"该坐标已有柱"）。
18. 判据从坐标比较改成 `column.pointId === point.id` 比较 → G2 必须红（两根柱两个点、同一坐标 ⇒ 瞎了），既有 `commands-column-slab.test.ts` 的 `/已有柱/` 那条也会红。

1–2、4–9、13–18 里任何一条"改坏了还绿"，说明那条断言写空了，就地补到能红为止；第 3、7 两条反过来，**必须还绿**（它们测的是"改动没坏但也没变"这一类）。**一条不会红的测试比没有测试更糟**，而一条"以为在守、其实没守"的防御代码比没有更糟 —— 3、7 两条就是专门写来把这两件事分开的。第 12 条按"改坏不一定红、凭据在 Step 6"处理。**第 10 条与第 11 条的"三枚像素全为整数"那半按"无证改坏"处理**：2026-09-28 实测在样例房那把 0.125px/mm 的尺子上取整前后本来就是同一个数，T5 跑到那儿"改坏了还绿"是预期内的（订正原文在那两条下面）—— 不许为了让它红而在 T5 里现造分数尺子或放宽别的断言，那颗牙齿由 Task 6 Step 5 的 HC2/HC3 补上；第 11 条的另一半（「落点必然合法」）仍然必须红。把每条命令与关键红字写进提交信息。

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

`apps/desktop/src/renderer/src/PlanCanvas.tsx` 整体替换（T4 那份的骨架保留：`opsRef`、`countPixels`、`whenLoaded` 那套绘制顺序注释都不动，加把手画家、拖拽状态机、撤销快捷键，`DebugReport` 补 **14** 个字段 —— 实测；下面那份代码正文写 12 个，竞态修复补 `dragTargetMm`/`dragCursorPx` 两个）：

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
  // ↓ T5 的 14 个
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

数一下：`wantEdit` 那段是 **15** 条判据，基础六条照旧 ⇒ `pnpm edit-shot` 应当打印 **21 行 PASS**（`pick-shot` 仍是 **11** 行，`shot` 仍是 6 行）。改样例房或改判据时，这几处要一起改：`drawlist.test.ts`、`pick.test.ts`、`handles.test.ts`、`commands-drag.test.ts`、`desktop-shot.mjs`。

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
Expected: 四个 exit=0。`shot` **六行**、`pick-shot` **十一行**都照旧全绿（Task 4 起实测 11 行）（回归判据：T5 不该动它们的行为，`--pick-shot` 与 T4 唯一的差别是 `electronArgs` 换成成对写法）；`edit-shot` **二十一行**全 PASS。把 stdout 里那三行进度读数原样抄进提交信息：`探针：<wallId>:<end> 共享 N 面`（证靶子是**共享**端点，孤端点拖不出邻墙）、`中途：previewPx=… nearMid=… depth=…`（证"拖拽中有东西上屏、线跟着手、真源没动"）与 `被拒：…`（那一句中文报错的前 80 字）。

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
Expected: exit=0，实测两行 `Test Files  28 passed (28)` / `Tests  338 passed (338)`（vitest 5 的排版是两个空格 + 括号计数，别按"Tests 338 passed"子串去 grep）。**338 是实测；正文原算式 `318 + 19 = 337` 差 1 条**，差源是 `handles.test.ts` 实际 13 条而非 12 条 ⇒ 正确算式 **318 + 20**：T4 收尾时是 26 个文件 / 318 条，本任务加 `commands-drag.test.ts` 7 条与 `handles.test.ts` 13 条，各一个新文件。同时**老用例一条都不许改**：Step 1 把重影柱的判据从 `columnCreate` 搬进 `assertNoGhostColumn`，`commands-column-slab.test.ts` 里那条 `/已有柱/` 是部分匹配，搬动之后它必须原样还绿 —— 真需要动那句断言，说明搬运改了文案，那是行为变更，停下来核对而不是顺手放宽。

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

#### 执行回填（Task 5，2026-09-28/29 实测；commits `39a7824` + `6dc9efe`）

- **账**：`pnpm typecheck` exit=0；`pnpm verify` exit=0 **`Test Files  28 passed (28)` / `Tests  338 passed (338)`**（正文算式 337 差 1，差源见上）。`pnpm shot` 6 行（画布 1427×865）、`pnpm pick-shot` **11 行**、`pnpm edit-shot` **21 行全 PASS**（正文那张十五判据 + 基础六条，数值与预言一致）。修复后**连续 13 次绿**。RED/GREEN 逐字留档：seat 那次 RED 是 `packages/scene-2d/test/handles.test.ts (12 tests | 12 failed)`，全红在 `TypeError: dragHandlesOf is not a function`（与 T1 同一条通路，不是链接期错误）；随后 GREEN `Tests 19 passed (19)` = 7 + 12 —— **与正文预言逐字相同**。第 13 条是控制器修危险 1 与 4 时补的（见下），于是全量 337 → 338。
- **两个提交并成一个**（评审 m5，裁决为记账不改史）：正文 Step 7 要 `git add packages/core packages/scene-2d` 与 `git add apps/desktop scripts package.json` 两发；实施时 core/scene-2d/desktop 三层在同一次改动里互相咬合（`assertNoGhostColumn` 的第二个读者、`DebugReport` 的两格新读数），拆开会让第一发单独不可编。 fix round 是独立第二发 `6dc9efe`。**下一任务的口径**：并发的判据是"这一发单独 checkout 能不能 typecheck"，不是"正文列了几条 `git add`"。
- **本节正文一条都没预言到的五个危险**（**T6 抄 `--edit-shot` 之前先读这五条**，它们全是复制即中的坑）：
  1. **`sendInputEvent` 静默夹坐标**。落点算出 `to=(253,-18)`（画布高 865、y 为负）时 Electron 不报错、不裁剪上报，只把事件夹进边界 ⇒ 那发"压扁拖"从未发生，而闸门把**没测到**报成**没被拒**（假阴，最坏那种）。修法：`dragProbe` 用 `insideCanvas(fromPx)` / `insideCanvas(toPx)` 筛掉越界候选。
  2. **应用菜单栏占约 26px 客户端高度**，`Menu.setApplicationMenu(null)` 摘晚了就当场触发一次 resize：正文原先摘在 `keyCombo` 里 ⇒ 同一串输入的前半与后半坐标系不同（实测同一点从 `(253,74)` 变 `(332,75)`）。修法：只在 shot 模式、且在 `createWindow` **之前**摘。
  3. **`fit()` 读的 `log.document` 是可变实例上的活 getter**：拖拽改过内容之后再触发一发 resize，`fitStorey` 按**当时**的文档边界重缩放，先前算定的像素前提全体作废。真正的治法是第 2 条 + `waitForLayoutSettled`（`{wPx,hPx}` 连读三次一致才算稳，否则抛）。**订正一处我自己的假因果**：评审 m3 建议"把 `log` 从 fit effect 的依赖里去掉"，`log` 引用永不变 ⇒ 那次改动**今天是零行为差**，它治的是"以后有人替换 `log` 实例"这一档 —— 该档**挂 Task 8**（换楼层/载入文档会真换实例）。同一句假因果还写进了 `39a7824` 的提交正文（"fitStorey 不再跟着文档 revision 重跑（每拖一下整张图自己重缩放）"）：**不 amend**，以本条为准 —— 核过改前依赖是 `[log, storeyId, setViewport]`，`revision` 从来不在其中，"每拖一下重缩放"那件事从来没有发生过。
  4. **star 接头让 renderer 白屏**。命令层两道守卫全放行，`deriveStoreyGeometry` 抛 `RangeError: 接头 … star，S1 不支持` ⇒ `__dajiaDebug` 没了，之后每一条判据都失败（症状是"超时"，根因在上一层）。修法：`derivesAfterMove`（`applyPatch` → `deriveStoreyGeometry` 试算，抛错即弃该候选）。**踩过的坑**：第一版把派生检查塞进 `legalDrop`，把 `wallsAtJunction()` 本来就是 star 的那条既有夹具打红了 ⇒ 拆成两个各自有主的谓词。**残留**：这一档只挡了**自动**通道，真人手拖到 star 落点仍会白屏 ⇒ **挂 Task 7**（`assertDerivesAfterApply` 落地后 `legalDrop` 与真源同判，自动收掉）。
  5. **输入队列竞态（约 1/6 概率）**。`sendInputEvent` 只把事件塞进浏览器输入队列，`await` **不等它被处理**；而 `onUp` 读的是最后一发**已处理** `pointermove` 决定的 `drag.targetMm` ⇒ `movePx(to)` 之后立刻 `releasePx(to)` 是在赌队列不压。赌输的那一发**确实落了盘**（`depth 30→31`、`outcome:'ok'`、`previewPx=0`），只是落成了**按下那一像素**反算的毫米（实测 `(1106,4478)`），症状却报在下游的落点断言上。修法**不是重试**，是把等待挪到上游并让它可证伪：`DebugReport` 加 `dragTargetMm`/`dragCursorPx` 把"松手前 store 里的目标"变成可读量，`waitDragAt()` 在第 3 步等到逐字等于、第 4 步压扁等到**离开**落点、第 7 步按下后先等 `dragTargetMm !== null`（证明真起拖了，否则红话会说成"没给出 noop 诊断"）。同时第 2 步的"跟手"判据从**自指**（量 store 自报的光标，光标落后一帧也照样绿）改成**发送方判**（对照实发的 `midPx`）。四条新断言各自证伪过。**边界**：这治的是症状通路，不是队列本身 —— 13 次绿不等于概率问题归零。
- **Step 4 的 12 条 ⇒ 实测 13 条**：多出来的那条是 `探针的落点像素必须在画布内、且那一发派生得出`，钉的正是上面第 1、4 两条危险的筛 —— 它不在 seat 那发 `19 passed` 里，是控制器补危险时后加的（⇒ 全量 337 → 338 的唯一差源）。
- **Step 5 的改坏凭据 R1–R7**：七条全红、无一条"改坏了还绿"（凭据 `t5-r1-r7.md`）。两处与预言不符，按实测记：
  - **R3 红得比正文早一处** —— 摘掉 `drag` 依赖后，第 1 步的 `waitUntil` 谓词（含 `previewPx > 20`）就先接住了，不必走到第 2 步。同一处像素缺失，两条预言合成一条 ⇒ 记录差异，**不改判据**。
  - **凭据抄写自身错过一次**：驱动挑红字用 `/没等到|…|Error:/` 取第一条命中，而 `RangeError:` 里含 `Error:` ⇒ R7 那一格抄成了第 4 步自己打的 stdout 诊断。单独重跑确认闸门确实红在第 5 步那句，**R7 判定不变**；R1–R6 逐条核过形态，无同类错位。**给 T6 的口径**：改坏清单的红字要取**最后一条** `--shot 失败：Error:` 那一行，或直接把全量输出留盘再对。
- **交接给 Task 6 的四条硬约束**：① 本节 Step 5 那份 `PlanCanvas` 代码 listing 的 `DebugReport` 字段块**比仓库少两格**（`dragTargetMm`/`dragCursorPx`，竞态修复补的），复制时以仓库为准 ⇒ T6 的 9 个新字段接在 **24** 之后。② `dispatch` 之前**不许**加 `legalDrop` 预检（Step 5 末那条纪律原样成立，R5 就是它的凭据），但松手侧现在读的是 store 里的 `drag` —— 吸附只能加在 `onMove`，第 3/4/7 步那三处 `waitDragAt` 一字不改地留着。③ 第 2 步的 `previewNearCursorPx > 0` 不许为"让吸附点上屏"而放宽（预览线恒画到裸光标，吸附点另用第四色）。④ `handles.test.ts` 第 13 条里 `not.toBeNull()` 的牙齿是**概率性**的（评审 m8），T6 复制该写法时不许放宽、也不许当成恒绿凭据。
- **探针可达形状比正文假设窄**：调试期做过一次"强制形状"实验（`dragProbe` 里加 `if (fromPx.y < 200) continue;`），结果不是拿到预期的内侧把手，而是红在第 0 步「dragProbe 没给靶子」⇒ 样例房里可被筛出的把手形状集合有限，那次偶发竞态的**具体形状此后未被复现**，上面的 1/6 是修前观测频率，不是修后回归频率。
- 真窗口三闸门在 `6dc9efe` 上的复跑由**控制位独占**执行（评审 seat 不跑闸门）⇒ scoped re-review 的"无回归"覆盖 verify / 静态 / 范围，**不**覆盖真窗口实测。

---

### Task 6: 拉新墙、删除构件、四类吸附

**Files:**
- Create: `packages/scene-2d/src/snapping.ts`（五档吸附 + `MoveTarget` 三件套从 `handles.ts` 迁进来）
- Create: `packages/scene-2d/src/editing.ts`（工具态、画墙草稿、删除计划、新建回来的墙）
- Create: `packages/scene-2d/test/snapping.test.ts`（**28 条 `it`**，含 2 条属性）
- Create: `packages/scene-2d/test/editing.test.ts`（**30 条 `it`**，含 1 条属性）
- Modify: `packages/scene-2d/src/pick.ts`（把 `probeTarget` 的候选点扫描抽成文件内私有 `uniqueHitOf`，新增出口 `pickPxOf`）
- Modify: `packages/scene-2d/test/pick.test.ts`（+3 条 ⇒ 18）
- Modify: `packages/scene-2d/src/handles.ts`（`MoveTarget`/`quantizeTarget`/`moveTargetOf` 迁出、`DragHandle` 补 `anchorMm`、`dragProbe` 改吃吸附后的毫米、**新增出口 `handleDropTarget`**）
- Modify: `packages/scene-2d/test/handles.test.ts`（+7 条 ⇒ **20**（正文原先的 19 是编写期账：13 条保留 + 7 条新增 = 20，棒 C 在 `d642466` 已按实测改口）；合成把手 `handleAt` 补一行 `anchorMm`；末条配色判据从三色列成四色；T5 那句 `moveTargetOf(view, p.toPx) === p.targetMm` **换成恒等式**，见"既有写法"第 3 条）
- Modify: `packages/scene-2d/src/index.ts`（两行出口）
- Modify: `apps/desktop/src/renderer/src/stores/editorStore.ts`（状态加 `tool`、`draft` 两格，出口加 `setTool`、`setDraft`、`dispatchBatch`）
- Modify: `apps/desktop/src/renderer/src/stores/selectionStore.ts`（新增 `retain`，给删除后的选中剪枝用）
- Modify: `apps/desktop/src/renderer/src/PlanCanvas.tsx`（吸附标记画家、第 6 个像素桶、模式分支、四条新快捷键、`DebugReport` 补 9 个字段）
- Modify: `apps/desktop/src/main/index.ts`（`--draw-shot`：`runDrawShot` 十六步 + `DrawReportShape`）
- Modify: `scripts/desktop-shot.mjs`（`modeOf()` + `wantDraw` + 判据段）
- Modify: `package.json`（根：`"draw-shot"`）
- **core 一行都不改**：`wallCreate` 的 `{ pointId }` 复用、`wallDelete` 的级联与孤儿点判定、`openingDelete` 全在计划 1/2 落好了。本任务只是把它们接到屏幕上，所以**没有任何 core 测试要加**（`338 → 406` 全部落在 scene-2d：28 + 30 + 3 + 7。基数原写 337，T5 实测 338 ⇒ 终点跟着挪一格）。

**先落八条裁决。** 末尾边界表给 Task 6 留的两个接缝（吸附插入点、撤销掉正被选中的构件）在这里判掉，判据写进代码与测试，不许留在纸面。

| # | 问题 | 裁决 | 理由与代价 |
|---|---|---|---|
| S1 | 吸附容差按毫米还是按屏幕像素？ | **按屏幕像素，且直接沿用 `PICK_TOL_PX`（= 8）**：`SNAP_TOL_PX = PICK_TOL_PX`。角度档（15°/正交）另外受这条像素上限约束 | `pick.ts` 顶部那句理由是现成的：毫米容差钉的是世界尺寸，放大 k 倍它在屏幕上就宽 k 倍 —— 吸附手感必须与命中手感同源，否则"点得中"与"吸得上"是两个数，用户没法形成预期。角度档若没有这条上限，`ANGLE_TOL_DEG` 的楔形会随离锚点的距离线性张开（8000mm 外 3° ≈ 420mm），落点会"跳"到光标之外几十像素 —— 那不是吸附，是抢方向盘。**代价**：极度缩小时（`pxPerMm` 逼近 `viewport.ts` 的 `MIN_PX_PER_MM`）8px 换算是很大的毫米数，吸附会把整张图吃光。这是 `pick` 本来就有的性质（缩小后什么都点得中），不是本任务新引入的；`--draw-shot` 的判据全是"取整像素反算毫米"的自洽对账，不依赖绝对手感。 |
| S2 | 五档靶子（端点 / 中点 / 垂足 / 15° / 正交）怎么排？轴网交点要不要做？ | **两级判据：先分组，组内看距离**。组 0 = 吸到**已有的东西**（端点/中点/垂足），组 1 = 吸到**方向**（正交/15°），组 0 永远压过组 1；组内先比 `distPx`，再比 `PRIORITY`（端点 0 < 中点 1 < 垂足 2 < 正交 3 < 15° 4），最后比 `ownerId`。**轴网交点整档不做**，写进 Task 9 边界 | 分组在前、距离在后的顺序不能反：**同组之间**舍近求远是最反直觉的吸附行为（光标压在垂足上却因为"端点优先级高"被吸回 4px 外的端点），而**跨组**时"吸到既有几何"必须赢过"吸到一个方向"—— 屏幕上 0.5px 外的正交落点抢走 0.7px 外的真源端点，等于把"对齐到那一枚点"让位给"大致水平"，用户看不见这 0.2px 的差别，却会在一松手之后发现墙没接到点上。优先级真正要管的只剩两类并列：① 一枚坐标既是 A 墙端点又是 B 墙中点；② 两面平行墙的同档位候选与光标**逐位等距**（`hypot(0,4)` 那种二进制精确值）。两类都必须由 `ownerId` 收尾，否则"谁赢"取决于数组序 —— `reversed(field)` 前后结果逐字相等是这条全序的凭据。**轴网交点不做**的理由不是"来不及"：交点要把同层墙按方向分族、两两求 `intersectLines`，`vec.ts` 那条"平行返回 null，绝不返回 Infinity/NaN"要在 UI 侧逐条兜住，而它给用户的收益是"能对着墙的中线拉齐" —— 那是**约束/对齐线**功能，属本任务之外的产品决定。代价：Task 9 补这一档时要回去给 `intersectLines` 的 null 分支写用例。 |
| S3 | 15° 与正交会不会同时命中同一个方向？谁给哪种语义？ | **档位互斥**：15° 档只考虑**非轴对齐**的 15° 倍数（15/30/45/60/105…），四条轴（0/90/180/270）整档让给正交。**正交用"保坐标"语义**（水平 ⇒ `y = anchor.y`，竖直 ⇒ `x = anchor.x`），15° 用"保距离旋转"语义 | 两档若都收轴方向，同一发光标会造出**两个不同的落点**：保坐标给 `(raw.x, anchor.y)`，旋转给 `(anchor.x + round(L), anchor.y)`（`L = hypot(dx, dy)`），第二根坐标相同、第一根恒差 `round(L) − |dx| ≥ 0` ⇒ **正交那一发永远不比旋转远**，胜负由 `distPx` 决定（正交赢），`snapKind` 的读数则由"量化把 `round(L)` 甩到 3px 还是 4px"决定。互斥把这条从"靠量化运气"变成"靠构造"：画一条 4000 的水平墙，落点必须是逐字的 `(4000, 0)`，`snapKind` 必须是 `'ortho'`。**代价**：这条互斥在单测里**抓不到红**（改坏清单第 7 条实测：摘掉 `n % 6 === 0` 那一句，28 条全绿）—— 它是语义判据不是胜负判据，所以给它写一条"看起来能红"的用例就是假绿。它在真窗口里的影子是 `--draw-shot` 的 `snapKind` 读数（Step 7 判据 D3）。 |
| S4 | 吸附插在拖拽路径的哪一处？会不会把 T5 的 `--edit-shot` 拖红？ | **插在 `moveTargetOf` 之后、`dispatch` 之前**（T5 D4 预留的那一行），实现成 `dropTargetOf(v, cursorPx, anchorMm, field, opts)` 这一个出口。三条纪律：① 只有 `pointermove` 走吸附，`pointerdown` 那一发仍是裸 `moveTargetOf`；② 探针与 renderer 吃**同一个** `dropTargetOf`（同一个锚点、同一个排除集）；③ 预览线恒画到裸光标，吸附点单独用第四色标出来 | 三条各堵一处 T5 判据的红：① 若按下就吸，`--edit-shot` 第 7 步（在把手上原地按下即松手 ⇒ `outcome === 'noop'`）里那个"落点等于真源现值"的等式会被吸附改写，"零移动不发命令"（D4）当场失效 —— 所以按下那一支**保持 T5 原样**，吸附只加在 `onMove` 里，那 21 行判据一字不改；② 若探针自己按 `atMm + offset` 算毫米，第 3 步那句"松手落点逐字等于探针给的毫米"就变成两个不同函数的比对，硬 throw 会随机红；③ 若预览线画到吸附点，第 2 步的 `previewNearCursorPx > 0` 在吸附发生时数是 0（线端离开光标 8px 就出 ±2px 窗口）。**代价**：屏幕上"临时线的终点"与"真会落下的点"可以差 8px —— 这是**看得见的取舍**，所以必须有第四个标记点把吸附位置显式画出来（S8），否则用户只知道"拖不动到我想去的地方"。 |
| S5 | 删除怎么发？级联与孤儿点归谁？ | **`planDelete` 只发两条规则**：选中的墙 → `wall.delete`；选中的洞口且**宿主墙不在本次删除集里** → `opening.delete`。派发顺序是**先洞口后墙**。剪枝不预测补丁内容，事后拿真源问一遍 | `wallDelete.build` 自己就会收掉 `hostWallId === wall.id` 的全部洞口，再自己判端点还有没有人引用（`stillReferenced` 查墙、柱、板）。所以"删墙时顺手把它的洞口 `openingDelete` 一遍"是**多余且有害**的：墙先删掉之后那些洞口已经不存在，第二条命令 `requireOpening` 直接抛，`dispatchBatch` 就在半途留下半套状态。反过来（先删全部选中洞口再删墙）也**不写**"先删宿主墙的洞口"这一支，因为对没被选中的洞口它毫无意义、对被选中的洞口它只是把真源已有的级联复述一遍 —— 复述的规则一定会漂，漂掉的永远是没人看的那一遍（`commands/opening.ts` 顶部那句"命令层绝不复述区间规则"同一条理由）。顺序排成"洞口在前"是为了**撤销的可读性**：撤销栈顶是 `wall.delete`，一次 Ctrl+Z 就把"墙 + 它自己级联掉的洞口"整组还原（`invertPatch` 按前像重插），而不是先还回一樘无主的洞口。代价：一次删除 = **多步撤销**（N 面墙 + M 樘独立洞口），不是"一个事务"；`TransactionLog` 没有批事务概念，这属计划 4 的真源决定（见转下游）。 |
| S6 | 谁读 `log.affected`？新建的墙怎么拿回来？ | **`lastCreatedWall(doc, affected, storeyId)` 是 renderer 侧第一个读者，三条纪律写进类型注释**：只在 `dispatch` 成功分支里同步读、读完立刻 `doc.get(id)` 复核、不许缓存 | 全局约束那句"取新建实体只认 `affected` + `kind` 判别式"到本任务才真的有 UI 读者。为什么必须复核：读过源码，`undo()` 里 `lastAffected = affectedIds(entry.patch)` 用的是**前向补丁**的 id —— 撤销掉一次 `wall.create` 之后，`affected` 里**仍然**列着那面墙的 id，而 `doc.get(id)` 已经是 `undefined`。少那一句复核，"新建即选中"会指着一面不存在的墙，屏幕上就是一个不存在的构件的把手与选中态（正是 D7 留的那个接缝）。代价：`affected` 的语义是"最近一次触及的 id"，不是"新出现的 id"，所以调用方永远要把文档当第二票 —— 这条要写在函数头上，否则 Task 8 属性面板的第二次读者会重犯。 |
| S7 | `wallProbe` 为什么必须让起点吸到既有端点上？ | **必须吸**（`start.snap?.kind === 'endpoint'` 且 `start.snap.pointId !== null`），终点必须**不引别人的点**（`end.snap === null \|\| end.snap.pointId === null`） | 起点复用让这一发真的走 `{ pointId }` 引用（边界表那条硬要求：不复用则接头全断），于是 `--draw-shot` 的判据能在真窗口里证"新建的墙与既有墙共享一枚点"；终点全新建，删掉这面墙时它带走**恰好一枚**孤儿点，`pointCount` 的账才是整数。注意这条筛**不是"终点什么都不许吸"** —— 探针的候选全是轴对齐的，正交档必然命中，那是保坐标、不引点，允许且无害。只有终点引了既有点，`wallDelete` 才会判定那枚点仍被引用而留下它，删除判据就从"数得清"变成"要看运气"。共享端点的删除在单元侧另有判据（`editing.test.ts` 里"墙与它的洞口一起选中"与"筛 ② 单独说话"两条）。代价：探针能挑的落点变少，样例房一层挑不出合法落点时返回 `null`，闸门在第 0 步就抛「探针给不出可画的空白落点」—— 抛错比放宽筛条件诚实。 |
| S8 | 第四色 `SNAP_COLOR` 的像素桶到底证明了什么？ | **只证明"那一刻确实吸附了"**，不证明"吸到了哪里" | 按构造，吸附点离光标不超过 `SNAP_TOL_PX`（S1），而 T5 的 5 号桶（`previewNearCursorPx`）用的 ±2px 窗口**比它小** —— 于是不存在任何一个像素窗口既能把标记点和别的像素分开、又不会在"标记点其实跑到 8px 外"时红。硬要写这种窗口就是假绿。所以 `snapMarkPx` 是**整幅画布上橙色像素的总数**，判据只有 `> 0` / 比较，位置的对账一律走毫米（`points` 快照与 `draft.endMm`）。代价：`--draw-shot` 的"吸上了"是存在性凭据；"吸对了"由 `snapping.test.ts` 的 28 条与 D4 那条毫米逐字判据负责。**这条桶的两个使用条件**（写 Step 7 的判据时必须照办）：样例房这份 `fitStorey` 实测 `pxPerMm = 0.125` ⇒ 8px 容差 = 64mm。**① `> 0` 那一侧不是"挑个近靶子停下"，是按构造成立**：`WALL_PROBE_OFFSETS` 那十发偏移（`editing.ts:321-332`）全是轴对齐或 45°，而 S3 的档位互斥把四条轴整档给正交、45° 整档留给 15°；候选毫米是"锚点毫米 + 整百米毫米"，`intPx` 的取整误差 ≤ 0.5px，远小于 8px 容差 ⇒ **方向档对每一发候选都会命中**。2026-09-28 实测（探针选中的起点 `(4000,3000)` × 那十发偏移，逐发问一遍 `dropTargetOf`）：**十发的 `snap` 全部非空、`distPx` 全部逐字为 `0`**，档位分布 `ortho` 1 / `angle15` 4 / `foot` 3 / `endpoint` 1 / `midpoint` 1（后四发分别被筛 ② 或筛 ④ 换掉，与这条无关）。所以第 2、3 步的 `snapMarkPx > 0` 判的是"标记画家真的在画"，不是"今天运气好吸上了"；**反过来，判据不许写成"吸到了哪个位置"**（那由毫米侧的 `end.mm === probe.endMm` 与 D4 的逐字对账负责）。**② `=== 0` 那一侧只在"既无草稿也无拖拽"的时刻成立**：起始读数、第 4 步 Escape 之后、第 15 步终态。它判的是画家**没有**在别处留下橙色 —— 只要 `draft === null && drag === null`，`paintSnapMarker` 就没有入参可画。别把它写成"离靶子够远所以没吸上"的证据：64mm 这个数在 0.125px/mm 下太容易越过，用它当凭据等于等一个不会来的红。两步读的是同一个 `snapMarkPx`，判据方向相反 —— 这正是 S8"只证存在、不证位置"的用法。 |

**本任务会改到 T4/T5 的六处既有写法**（逐条列出来，免得执行时以为是笔误）：

1. **`pick.ts` 的候选点扫描**：`probeTarget` 里那段"多边形取长边中点 / 线取中点 / `hits.length !== 1` 就换下一个"抽成文件内私有 `uniqueHitOf(ops, ownerId, minEdgePx)`，`probeTarget` 与新的出口 `pickPxOf` 各吃它一次。**T4 Step 5 第 10 条改坏的位置随之改名**：原文"`probeTarget` 的 `hits.length !== 1` 改成 `hits.length < 1`"读作"`uniqueHitOf` 的 `hits.length !== 1`"，红法与红在哪一条用例**一字不变**（T4 的两条靶子用例都还从 `probeTarget` 走进 `uniqueHitOf`）。
2. **`handles.ts` 的 `DragHandle` 加一个字段 `anchorMm`**（另一端那对整数毫米，与既有 `anchorPx` 同产地）：纯加字段。T5 的 12 条把手用例判的都不是"字段集合恰好如此"，所以不红；**`handles.test.ts` 里合成的 `handleAt` 必须补 `anchorMm: { x: px, y: py }` 一行** —— 那是构造期缺字段的编译错误，不是判据变化。`DragProbe` **不加字段**（S4 ①：按下不吸 ⇒ 探针的 `targetMm` 仍由 `dropTargetOf` 给，形状不变）。
3. **`handles.ts` 的 `dragProbe` 落点算法**：`moveTargetOf(v, toPx)` 换成 `handleDropTarget(v, toPx, h, field)`（= `dropTargetOf(v, toPx, h.anchorMm, field, { excludeMm: h.atMm })`，场在 `dragProbe` 入口取一次，**签名一字不改**，T5 那 12 条用例的调用点全都不受影响），排除的是**被拖那枚点的坐标**（不是 `pointId`，见 `SnapOptions` 那段注释），且 `legalDrop` 判的是**吸附之后**那对毫米。
   **原计划文本在这里写过一句错话，订正如下**：原文断言"`handles.test.ts` 里那句 `expect(moveTargetOf(view, p.toPx)).toEqual(p.targetMm)` **照样绿**，因为样例房在 0.125px/mm 下探针落点距任何靶子都 > 8px"。实测**不成立**：样例房那把被挑中的把手，其候选落点里有 14/160 发被 15° 档改写（最大 6.97px），那句话十个进程红 2 个 —— 它判的是"探针没吃吸附"，而本任务让探针吃了吸附，所以它**必须换掉**，不是"照样绿"。换成同一个纯函数的自比对（`handleDropTarget(view, p.toPx, 同一把把手, 同一个场).mm === p.targetMm`，恒成立），判据从"落点等于裸毫米"升级为"探针与 renderer 同一个调用"。新增用例里有专门判"落点内容"的两条（吸上了什么、合法性判在哪一侧），牙齿在它们身上。
4. **`handles.test.ts` 末条配色判据**：三色列成四色（多 `SNAP_COLOR`），判据本身一字不改。这是**加一格**，不是放宽 —— 它让新颜色也过同一把尺。
5. **`PlanCanvas.tsx` 的 `Buckets` / `NO_PIXELS` / `countPixels`**：多第 6 个桶 `snapMarkPx`。`countPixels` 的**签名不变**（S8 已定：橙色桶不带位置窗口），所以 T5 的两处调用点与 5 条像素判据一行不动。
6. **`apps/desktop/src/main/index.ts` 的 `whenReady` 分支** 与 **`scripts/desktop-shot.mjs` 的 `electronArgs` 三元式**：各加第四个开关 `--draw-shot`。`--edit-shot` 的 21 行 PASS 与 `--pick-shot` 的 11 行、`--shot` 的 6 行**判据一字不改**（新增的全是加字段与加读数）。

**Interfaces:**
- Consumes：
  - `@dajia/core`：`wallCreate(input: WallCreateInput)`（`start`/`end` 是 `PointRef = {x,y} | {pointId}`）、`wallDelete({wallId})`、`openingDelete({openingId})`、`wallMoveEndpoint({wallId,end,x,y})`、`incidentWallEnds(doc, pointId)`、`resolvePointRef(doc, ref, storeyId)`、`isExistingPoint`、`endPointId`、`wallAxisById`、`requirePoint`、`requireStorey`、`quantizeMm`、`vec/advance/length`、`type Document`、`type Command`、`type EntityId`、`type PointRef`、`type Vec2`、`type WallEnd`、`type WallEntity`
  - T1–T5：`Viewport`/`Px`/`mmToPx`/`pxToMm`/`viewportOf`/`fitStorey`、`DrawOp`/`Selection`/`buildDrawList`、`PICK_TOL_PX`/`pickOne`/`pickAt`/`probeTarget`、`DragHandle`/`dragHandlesOf`/`pickHandle`/`legalDrop`/`DragProbe`/`dragProbe`/`pointSnapshot`、`demoHouse`、`Document`/`TransactionLog`/`storeyCreate`/`wallCreate`/`openingCreate`/`uuidv7`
- Produces：
  ```ts
  // snapping.ts（Task 5 的 MoveTarget 三件套搬到这里，handles.ts 改为 import）
  export interface MoveTarget { readonly x: number; readonly y: number }
  export function quantizeTarget(v: Vec2): MoveTarget;
  export function moveTargetOf(v: Viewport, cursorPx: Px): MoveTarget;
  export const SNAP_TOL_PX: number;              // === PICK_TOL_PX，S1
  export const ANGLE_TOL_DEG: 3;                 // S3
  export const SNAP_COLOR = '#ff8a00';           // S8：第四色，吸附标记
  export const SNAP_MARK_HALF_PX: 2.5;           // 5×5 实心方块的半径，与把手同量级
  export type SnapKind = 'endpoint' | 'midpoint' | 'foot' | 'ortho' | 'angle15';
  export type SnapPointKind = 'endpoint' | 'midpoint';
  export interface SnapPoint { readonly kind: SnapPointKind; readonly mm: MoveTarget
    readonly pointId: string | null; readonly ownerId: string }
  export interface SnapAxis { readonly ownerId: string; readonly startMm: MoveTarget
    readonly dir: Vec2; readonly lengthMm: number }
  /** 一层的吸附场：静态点 + 轴线。垂足与角度档的候选**不在场里**，按光标现算。 */
  export interface SnapField { readonly points: readonly SnapPoint[]; readonly axes: readonly SnapAxis[] }
  export interface SnapResult { readonly kind: SnapKind; readonly pointId: string | null
    readonly mm: MoveTarget; readonly distPx: number }
  export interface DropTarget { readonly raw: MoveTarget; readonly mm: MoveTarget
    readonly snap: SnapResult | null }
  export interface SnapOptions { readonly excludeMm?: MoveTarget | null }
  export const EMPTY_SNAP_FIELD: SnapField;
  export function snapFieldOf(doc: Document, storeyId: string): SnapField;
  export function snapFromCursor(v: Viewport, cursorPx: Px, raw: MoveTarget,
    anchorMm: MoveTarget | null, field: SnapField, opts?: SnapOptions): SnapResult | null;
  export function dropTargetOf(v: Viewport, cursorPx: Px, anchorMm: MoveTarget | null,
    field: SnapField, opts?: SnapOptions): DropTarget;
  export function pointRefOf(mm: MoveTarget, snap: SnapResult | null): PointRef;

  // editing.ts
  export type Tool = 'select' | 'wall';
  export const NEW_WALL_THICKNESS_MM = 240;      // 本层没有墙可参照时的**厚度**兜底；高度直读楼层 `heightMm`，不设兜底
  export const MIN_WALL_LENGTH_MM = 500;         // 只筛 `wallProbe` 的候选；用户那一路的下限是 core 那两道（零长、墙厚不小于墙长），Task 8 的数值输入才把它搬进交互路径
  export interface NewWallDefaults { readonly thicknessMm: number; readonly heightMm: number }
  export function newWallDefaults(doc: Document, storeyId: string): NewWallDefaults;
  export interface DraftPoint { readonly mm: MoveTarget; readonly px: Px
    readonly snap: SnapResult | null }
  export interface DraftWall { readonly storeyId: string; readonly start: DraftPoint
    /** 裸光标：临时线**恒**画到这里（S4 第三条纪律），不是吸附点。 */
    readonly cursorPx: Px; readonly end: DropTarget; readonly legal: boolean }
  /** 按下那一发：锚点恒给 null（S3 —— 按下不许自动变正交）。 */
  export function draftAtPress(v: Viewport, px: Px, field: SnapField): DraftPoint;
  /** 草稿两端 → 命令入参：吸到既有点才复用（`pointRefOf` 是唯一的判据）。 */
  export function draftRefs(draft: DraftWall): { readonly start: PointRef; readonly end: PointRef };
  /** 终点以起点为锚求落点，并排掉起点坐标；返回**新对象**（renderer 比引用决定重绘）。 */
  export function moveDraft(doc: Document, draft: DraftWall, v: Viewport, cursorPx: Px,
    field: SnapField): DraftWall;
  /** 合法性 = 拿真命令试跑一次（`legalDrop` 同一条 D3 纪律：屏幕上不重写守卫）。 */
  export function legalWallCreate(doc: Document, draft: DraftWall): boolean;
  /** 只认 `legal` 一色：false ⇒ null；true 时不 catch（漂了就是程序错误，该红不该被咽）。 */
  export function draftCommand(draft: DraftWall, defaults: NewWallDefaults): Command | null;
  export type DeleteOutcome = 'ok' | 'empty' | 'ignored-in-wall-mode' | 'unsupported';
  export interface DeletePlan { readonly outcome: DeleteOutcome
    readonly commands: readonly Command[]; readonly commandTypes: readonly string[]
    readonly candidateIds: readonly EntityId[]; readonly unsupported: readonly EntityId[] }
  export function planDelete(doc: Document, storeyId: string, tool: Tool,
    ids: Iterable<EntityId>): DeletePlan;
  export function pruneSelection(doc: Document, storeyId: string, ids: Iterable<EntityId>): EntityId[];
  export interface LastCreatedWall { readonly wallId: EntityId; readonly storeyId: EntityId
    readonly startId: EntityId; readonly endId: EntityId }
  export function lastCreatedWall(doc: Document, affected: ReadonlySet<EntityId>,
    storeyId: string): LastCreatedWall | null;
  export interface WallProbe { readonly startPx: Px; readonly startMm: MoveTarget
    readonly startPointId: EntityId; readonly endPx: Px; readonly endMm: MoveTarget
    readonly midPx: Px; readonly lengthMm: number; readonly defaults: NewWallDefaults }
  /** 场与默认值都在函数内现问（签名里没有它们）：探针与 renderer 因此走同一条通路。 */
  export function wallProbe(doc: Document, storeyId: string, ops: readonly DrawOp[],
    v: Viewport): WallProbe | null;

  // pick.ts 追加
  export function pickPxOf(ops: readonly DrawOp[], ownerId: string): Px | null;

  // handles.ts 追加（S4 ② 的落地形状：锚点与排除只有这一处可写）
  export function handleDropTarget(v: Viewport, cursorPx: Px, h: DragHandle,
    field: SnapField): DropTarget;
  // DragHandle 多一个字段：另一端那对整数毫米，与 anchorPx 同产地（角度档吃毫米，命中吃像素）
  //   readonly anchorMm: MoveTarget;
  ```
  renderer 侧：`useEditor()` 变成 `{ log, storeyId, viewport, revision, lastError, drag, tool, draft, setViewport, setDrag, setTool, setDraft, dispatch, dispatchBatch, undo, redo }`；`useSelection()` 补 `retain`；`window.__dajiaDebug()` 的 `DebugReport` 补 `tool` / `draft` / `snapMarkPx` / `lastCreate` / `deletedIds` / `unsupportedIds` / `selectionAfterDelete` / `lastHotkey` / `draw` 九个字段；`pnpm draw-shot`。**T5 那条拖拽通路本任务只动一处落点**：`onMove` 里的 `targetMm: moveTargetOf(viewport, px)` 换成 `handleDropTarget(viewport, px, 那把把手, 场).mm` —— 代价是拖拽状态里得带上按下那把把手（或按下时取好的那一份场），因为锚点与排除都长在把手身上。按下分支（S4 ①：不许吸）、零移动那条 `noop` 判据、`--edit-shot` 那 21 行**一字不改** —— `--draw-shot` 若逼着回头改它们，就是 S4 ① 的代价没付掉（见转下游）。

  **Task 6 不往 `handles.ts` 里塞删除，也不往 `snapping.ts` 里塞草稿状态**：`snapping.ts` 只回答"这一发光标落在哪"，`editing.ts` 只回答"这一发要不要发命令"，`handles.ts` 只回答"哪一枚点可以拖"。三件事各自有测试文件，PlanCanvas 只做装配（T4/T5 的"一条绘制通路 + 屏幕侧零判据"纪律在这里继续生效）。

  Task 8 对它们的依赖：`newWallDefaults` 是"数值输入"要替换掉的唯一占位入口；`pointRefOf` 是"新建即共享端点"这条拓扑纪律在屏幕侧的唯一出口；`planDelete` 的 `unsupported` 是 Task 8 补 `columnDelete`/`slabDelete`/`storeyDelete` 时唯一要接的口子（补完之后 `DeletePlan.unsupported` 在样例房里恒空，那条用例要跟着改成"柱"—— 别删用例，改判据）。

  **本任务实测出来的两条差额，交给 T7 收口，别在 UI 侧私自补**：① `legalDrop` 只试跑命令的 `build`，**不跑 `deriveStoreyGeometry`** ⇒ "把一枚共享点拖成星形接头（≥3 个方向过同一点）"会被预言为合法、在松手重绘时由派生层抛 `RangeError`。**Task 6 证伪了"走不到"这半句**：S7 要求拉墙草稿的起点复用既有端点 ⇒ 新墙天生往共享点加臂。控制位在样例房上实测（一次性扫描，未提交）：按在任意二臂角点的 ±1px 内 ⇒ `start.snap.kind='endpoint'` 且复用既有 `pointId`，此后 45°/60°/30°/15°/135°/−45° 任一起手 ⇒ `legal=true`、`dispatch` 不抛、`buildDrawList` 抛 `RangeError`；扫到 8 枚角点 × 6 个角度 = **48 发，48 发全抛**。"复制墙 / 批量拖"接上只是扩大可达范围，不再是这条差额成立的前提。屏幕侧的保险已在 T6 落地（paint effect 的 `try/catch` → `editorStore.reportPaintError`，走 `lastError`「画不出来：…」，**只动 lastError、零 revision**）；真源侧的收口仍是 core 的派生复核（见 Task 7 的 `assertDerivesAfterApply`），**不许**在 UI 侧复述四道派生守卫（复述的规则一定漂）。② 极小比例下吸附会**改写位移本身**，但那一档 `dragProbe` 拿不到落点。本段原句写的是"探针的落点会吸到别面墙的中点"，实测不成立，订正如下。测量条件：样例房一层、16 把把手 × 5 发偏移 = 80 发、`viewportOf(1200, 900, { pxPerMm, center: 拟合中心 })`（2026-09-28 实测，逐档重复稳定）：

| `pxPerMm` | 8px 换成 | `dragProbe` | 80 发里落点 ≠ 名义落点 | 最大偏差 | 吸到别墙中点 | 单发容差内静态候选 |
|---|---|---|---|---|---|---|
| 0.05 | 160mm | `(8000, 6800)`（= 偏移） | 22 | 8mm | 1 | 1 |
| 1/64 | 512mm | `(8000, 6776)`（拖 800 得 776） | 67 | 434mm | 2 | 1 |
| 0.01 | 800mm | `(8000, 6800)` | 23 | 800mm | 2 | 2 |
| 0.001 | 8000mm | **null** | 79 | 3800mm | 15 | **16** |
| 1e-4 / 1e-6 | 80m / 8km | **null** | 0（80 发全塌回原地） | — | 0 | 0 |

三句话读这张表：① 偏差从 `1/64` 那一档就开始出现，且探针自己那一发也躲不掉（`ortho` 把 y 钉在**量化后的裸落点**上，512mm 容差下换算不再落在整数毫米上，"向上拖 800mm"于是给 776mm）；② `0.001` 那一档"谁离光标近"已经没有区分力 —— 一枚光标 8px 内躺着 16 枚静态候选，胜负落到 `PRIORITY` 再落到 `ownerId`，15 发吸的是**别面墙的中点**，最大偏差 3800mm；③ 但 `dragProbe` 在这两档都返回 `null`（恒等筛把塌回原地的那 80 发全筛掉，合法性筛把 3800mm 那种落点筛掉），闸门在第 0 步抛「探针给不出可画的空白落点」——**所以这条代价在一次性闸门里表现为抛错，不表现为拖出怪落点**；真会拖出怪落点的是用户在极小比例下的手动拖拽，那是屏幕侧没有任何一条判据会红的。S1 已把这条记成"容差按像素"的代价；Task 8 或 Task 9 若给缩放加下限（这条未单独排期，谁先动量程谁关）（`MIN_PX_PER_MM = 1e-6` 太宽，按这张表 ≥ 0.05 才算手感可用），就在这里把它关掉。

- [ ] **Step 1: scene-2d —— 先写吸附的失败测试**

`packages/scene-2d/test/snapping.test.ts`（**28 条 `it`，含 2 条属性**，全是 node 里跑的纯函数 —— `snapping.ts` 只吃文档 + 视口 + 像素，不碰 canvas）。整份文件如下，**逐字照抄**：里面的注释是判据的一部分，删掉注释的执行人就无法判断某一句断言为什么在那儿。

```ts
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  Document,
  TransactionLog,
  advance,
  isExistingPoint,
  length,
  quantizeMm,
  requirePoint,
  resolvePointRef,
  storeyCreate,
  uuidv7,
  vec,
  wallAxisById,
  wallCreate,
  type PointRef,
  type WallEntity,
} from '@dajia/core';
import {
  ANGLE_TOL_DEG,
  EMPTY_SNAP_FIELD,
  PICK_TOL_PX,
  SNAP_TOL_PX,
  demoHouse,
  dropTargetOf,
  fitStorey,
  mmToPx,
  moveTargetOf,
  pointRefOf,
  snapFieldOf,
  snapFromCursor,
  viewportOf,
  type MoveTarget,
  type Px,
  type SnapField,
  type SnapResult,
  type Viewport,
} from '@dajia/scene-2d';

const house = demoHouse();
const view = fitStorey(house.doc, house.lowerStoreyId, 1200, 900, 60);
const field = snapFieldOf(house.doc, house.lowerStoreyId);
const lowerWalls = house.doc.byKind('wall').filter((w) => w.storeyId === house.lowerStoreyId);
const lowerPointIds = new Set(lowerWalls.flatMap((w) => [w.startId, w.endId]));

/** 整数毫米生成器：真源只收这个形状，属性不许拿浮点当输入。 */
const mmInt = fc.integer({ min: -20000, max: 20000 });

/**
 * 角度档专用的小视口：`pxPerMm` 取 0.05 ⇒ 8px 容差 = 160mm。样例房那一份 `fitStorey` 给的是
 * 0.125px/mm（8px = 64mm），在它上面构造"偏 2.5° 但离锚点 8000mm"那一发要算的舍入太多，
 * 红的时候分不清是角度档坏了还是像素上限坏了。角度档的用例一律在 `av` 上跑，靶子档的用例在 `view` 上跑。
 */
const av = viewportOf(1000, 800, { pxPerMm: 0.05, center: vec(1500, 1500) });

/** 光标就停在这对整数毫米的像素上：`snapFromCursor` 拿到的 raw 与 cursorPx 因此逐字自洽。 */
const pxOf = (mm: MoveTarget, v: Viewport): Px => mmToPx(v, vec(mm.x, mm.y));

/** 静态表里落在这一对坐标上的档位（排序后比，数组序不是判据）。 */
const kindsAt = (fd: SnapField, x: number, y: number): string[] =>
  fd.points
    .filter((p) => p.mm.x === x && p.mm.y === y)
    .map((p) => `${p.kind}`)
    .sort();

/** 把两个池子的扫描序整个倒过来：并列判据是全序的话，答案不许变。 */
const reversed = (fd: SnapField): SnapField => ({
  points: [...fd.points].reverse(),
  axes: [...fd.axes].reverse(),
});

/** 独立的一层（无墙），给角度档当"没有别的靶子"的对照组。 */
function synthStorey(): { log: TransactionLog; storeyId: string } {
  const projectId = uuidv7();
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  let storeyId = '';
  for (const id of log.affected) {
    if (log.document.get(id)?.kind === 'storey') storeyId = id;
  }
  if (storeyId === '') throw new TypeError('affected 里没有新建的楼层');
  return { log, storeyId };
}

/**
 * 建一面墙并把实体取回来。**不许** `byKind('wall').at(-1)`（全局约束：uuidv7 同毫秒不单调），
 * 也不许拿入参里的坐标去 `doc.get` —— 字面坐标那一支的点 id 是命令内部新建的，外面根本拿不到。
 */
function wallAt(log: TransactionLog, storeyId: string, start: PointRef, end: PointRef): WallEntity {
  log.dispatch(wallCreate({ storeyId, start, end, thicknessMm: 240, heightMm: 3000 }));
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new TypeError('affected 里没有新建的墙');
}

/** 极坐标转整数毫米（度、y 朝上）。只用来**造测试输入**，判据一律不吃它。 */
function mmAtAngle(deg: number, radiusMm: number): MoveTarget {
  const rad = (deg * Math.PI) / 180;
  return { x: quantizeMm(Math.cos(rad) * radiusMm), y: quantizeMm(Math.sin(rad) * radiusMm) };
}

/** 一对毫米的绝对角度（度，[0,360)）。判"落在哪条射线上"用。 */
function degOf(mm: MoveTarget): number {
  const d = (Math.atan2(mm.y, mm.x) * 180) / Math.PI;
  return d < 0 ? d + 360 : d;
}

describe('吸附靶子表', () => {
  it('端点表 = 本层墙端点的去重集，坐标逐枚直读真源', () => {
    const eps = field.points.filter((t) => t.kind === 'endpoint');
    // 样例房一层八枚：四个角 + 拐角 (4000,0) + 中段 (4000,3000) + partWest 挪出来的 (800,3000) + partEast 外端 (7000,3000)
    expect(lowerPointIds.size).toBe(8);
    expect(eps).toHaveLength(8);
    // 去重：拐角 (4000,0) 被三面墙共享，只能有一条候选
    expect(new Set(eps.map((t) => t.pointId)).size).toBe(8);
    for (const t of eps) {
      expect(t.pointId).not.toBeNull();
      const point = requirePoint(house.doc, t.pointId as string, '端点');
      expect(t.mm).toEqual({ x: point.x, y: point.y }); // 整数毫米直读真源，不做任何 px ↔ mm 往返
      expect(Number.isInteger(t.mm.x) && Number.isInteger(t.mm.y)).toBe(true);
    }
  });

  it('中点每面墙一条，坐标是沿轴一半处的量化毫米，且 pointId 为 null', () => {
    const mids = field.points.filter((t) => t.kind === 'midpoint');
    expect(lowerWalls).toHaveLength(8);
    expect(mids).toHaveLength(8);
    for (const t of mids) {
      expect(t.pointId).toBeNull(); // 中点不是真源里的点：`{pointId}` 复用那一支对它无意义
      const axis = wallAxisById(house.doc, t.ownerId);
      const mid = advance(axis.start, axis.dir, axis.lengthMm / 2);
      expect(t.mm).toEqual({ x: quantizeMm(mid.x), y: quantizeMm(mid.y) });
    }
    // 样例房全是正交墙，中点必然正好是整数毫米 —— 这一句把"量化"与"直接抄浮点"在样例上区分开
    expect(mids.map((t) => t.mm)).toContainEqual({ x: 2000, y: 0 });
  });

  it('楼层过滤：二层的端点一枚都不许进一层的表', () => {
    const upper = snapFieldOf(house.doc, house.upperStoreyId);
    const upperIds = new Set(upper.points.filter((t) => t.kind === 'endpoint').map((t) => t.pointId));
    expect(upperIds.size).toBe(8); // 素材自证：二层自己有靶子，否则下面全部断言恒真
    expect(upper.axes).toHaveLength(8); // 轴线也按层筛：别层的轴当吸附轨道会让落点吸到另一层去
    for (const id of upperIds) {
      expect(lowerPointIds.has(id as string)).toBe(false);
    }
    for (const t of field.points) {
      // 反向对照（两个方向都判，摘掉层过滤才一定红）：一层的表里也不该有二层的点
      if (t.pointId === null) continue;
      expect(upperIds.has(t.pointId)).toBe(false);
    }
  });

  it('同一坐标既是端点又是中点：并列（各差 0px）时优先级赢，且洗牌不改变答案', () => {
    const { log, storeyId } = synthStorey();
    wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const b = wallAt(log, storeyId, { x: 2000, y: 0 }, { x: 6000, y: 0 });
    const f = snapFieldOf(log.document, storeyId);
    // 静态表只有两枚（端点 + 中点）；同坐标的两枚垂足是**按光标现算**的，所以表里不列
    // （『楼层过滤』那条的 axes 长度自证它们有来源）
    expect(kindsAt(f, 2000, 0)).toEqual(['endpoint', 'midpoint']);
    const cursor = mmToPx(view, vec(2000, 0));
    const first = snapFromCursor(view, cursor, { x: 2000, y: 0 }, null, f);
    expect(first?.kind).toBe('endpoint'); // 四发并列（各差 0px）⇒ 端点（0）赢中点（1）与两枚垂足（2）
    expect(first?.pointId).toBe(b.startId);
    expect(first?.distPx).toBeLessThan(1e-9);
    expect(snapFromCursor(view, cursor, { x: 2000, y: 0 }, null, reversed(f))).toEqual(first);
  });
});

describe('光标 → 吸附结果', () => {
  it('光标压在端点上：kind / pointId / mm 三样都对，落点就是真源那枚点', () => {
    const cursor = pxOf({ x: 8000, y: 6000 }, view); // 样例房东北角，一枚共享端点
    const snap = snapFromCursor(view, cursor, { x: 8000, y: 6000 }, null, field);
    expect(snap?.kind).toBe('endpoint');
    expect(snap?.pointId).not.toBeNull();
    expect(snap?.mm).toEqual({ x: 8000, y: 6000 });
    expect(snap?.distPx).toBeLessThanOrEqual(SNAP_TOL_PX);
  });

  it('容差边界含等于：差 8.000px 吸、差 8.5px 不吸（改成 < 时第一句红）', () => {
    const base = pxOf({ x: 0, y: 0 }, view); // 样例房西南角
    const toward = (dPx: number): Px => ({ x: base.x + dPx, y: base.y });
    // raw 恒写 {0,0}：容差判的是**光标到吸附点**的像素距离，与 raw 量化到哪儿无关
    expect(snapFromCursor(view, toward(SNAP_TOL_PX), { x: 0, y: 0 }, null, field)?.kind).toBe('endpoint');
    expect(snapFromCursor(view, toward(SNAP_TOL_PX + 0.5), { x: 0, y: 0 }, null, field)).toBeNull();
    // 8.000px 那一发本身就是 `<=` 与 `<` 的分界（hypot(8,0) 是二进制精确值，不靠浮点余量）
    expect(snapFromCursor(view, toward(SNAP_TOL_PX - 0.5), { x: 0, y: 0 }, null, field)?.kind).toBe('endpoint');
  });

  it('容差沿用 PICK_TOL_PX：屏幕上"点得中一条线"与"吸得上一个点"是同一个手感', () => {
    expect(SNAP_TOL_PX).toBe(PICK_TOL_PX);
  });

  it('垂足比端点近时距离赢，且同距的正交档把功劳让给对象档', () => {
    const { log, storeyId } = synthStorey();
    wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const v = viewportOf(1000, 800, { pxPerMm: 0.02, center: vec(2000, 0) }); // 8px = 400mm
    const list = snapFieldOf(log.document, storeyId);
    const raw = { x: 200, y: 8 };
    const snap = snapFromCursor(v, pxOf(raw, v), raw, null, list);
    // 端点 (0,0) 离光标 200.16mm = 4.0px（在容差内！），垂足 (200,0) 离 8mm = 0.16px
    // ⇒ 端点优先级更高（0 < 2），但垂足近 25 倍 —— 距离赢，落点必须回到轴上
    expect(snap?.kind).toBe('foot');
    expect(snap?.mm).toEqual({ x: 200, y: 0 });
    expect(snap?.pointId).toBeNull();
    // 素材自证：换成"只看优先级"的写法时它抓得到东西（端点确实在容差之内）
    const ep = list.points.find((t) => t.kind === 'endpoint' && t.mm.x === 0);
    expect(ep).toBeDefined();
    // 同一发再加锚点 (0,0)：偏 2.29° 在 ANGLE_TOL_DEG 之内 ⇒ 正交档给出**同一枚**落点，
    // 组判据必须把功劳记给对象档（否则 --draw-shot 的 snapKind 读数会随机在两种之间跳）
    const noAnchor = snapFromCursor(v, pxOf(raw, v), raw, null, list);
    const withAnchor = snapFromCursor(v, pxOf(raw, v), raw, { x: 0, y: 0 }, list);
    expect(noAnchor?.kind).toBe('foot');
    expect(withAnchor?.kind).toBe('foot');
    expect(withAnchor?.mm).toEqual({ x: 200, y: 0 });
    expect(withAnchor?.distPx).toBe(noAnchor?.distPx); // 同一发候选，锚点不许把距离改掉
  });

  it('超出容差 ⇒ null，且 dropTargetOf 原样给 raw', () => {
    const base = pxOf({ x: 0, y: 0 }, view);
    // 往西南**外**的对角方向走 9px：沿轴方向走会被垂足档接住（它离光标恒 ≤ 半像素），
    // 那不是容差判据能测的方向 —— 垂足候选又被 t 的上下界挡在墙外（见下一条）。
    const far: Px = { x: base.x - SNAP_TOL_PX - 1, y: base.y + SNAP_TOL_PX + 1 };
    const raw = moveTargetOf(view, far);
    expect(snapFromCursor(view, far, raw, null, field)).toBeNull();
    const drop = dropTargetOf(view, far, null, field);
    expect(drop.snap).toBeNull();
    expect(drop.mm).toEqual(raw);
    expect(drop.raw).toEqual(raw);
  });

  it('垂足：光标落在斜墙轴线外侧，吸到轴上且不越过墙端', () => {
    const { log, storeyId } = synthStorey();
    wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 4000 });
    const v = viewportOf(1000, 800, { pxPerMm: 0.1, center: vec(2000, 2000) });
    const list = snapFieldOf(log.document, storeyId);
    const raw = { x: 2000, y: 2050 };
    const snap = snapFromCursor(v, pxOf(raw, v), raw, null, list);
    // 4050/2 = 2025：垂足的精确解（斜率 1 的轴上它正好是坐标平均），量化后逐字钉得住
    expect(snap?.mm).toEqual({ x: 2025, y: 2025 });
    expect(snap?.kind).toBe('foot');
    expect(snap?.pointId).toBeNull();
    // 该墙的中点 (2000,2000) 离光标 50mm = 5px、垂足离 35.4mm = 3.5px ⇒ 这一发同时证了"距离赢"
    expect(snap?.distPx).toBeLessThan(5);
  });

  it('垂足不许越过墙端：光标落在轴延长线外侧 ⇒ 整档没有候选', () => {
    const { log, storeyId } = synthStorey();
    wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 4000 });
    const v = viewportOf(1000, 800, { pxPerMm: 0.1, center: vec(2000, 2000) });
    const list = snapFieldOf(log.document, storeyId);
    const raw = { x: 4100, y: 4100 };
    // 沿轴 t = 5798mm > 轴长 5656.9mm ⇒ 该墙的 foot 候选被 t 的上下界挡掉；
    // 最近的端点 (4000,4000) 离光标 14.1px > 8px ⇒ 什么都没有。摘掉 t 上界会吸出一枚"墙外垂足"。
    expect(snapFromCursor(v, pxOf(raw, v), raw, null, list)).toBeNull();
    // 素材自证：把 t 上界放开的实现会在这一发上给出 kind 'foot' 且落点在墙外 —— 轴长是 5656.9mm
    const axis = wallAxisById(log.document, list.points[0]!.ownerId);
    expect(axis.lengthMm).toBeLessThan(5700);
  });

  it('空层（本层没有墙）⇒ 表是空的，dropTargetOf 恒等', () => {
    const { log, storeyId } = synthStorey();
    const list = snapFieldOf(log.document, storeyId);
    expect(list.points).toEqual([]);
    expect(list.axes).toEqual([]);
    const cursor = { x: 400, y: 300 };
    const drop = dropTargetOf(view, cursor, null, list);
    expect(drop.mm).toEqual(moveTargetOf(view, cursor));
    expect(drop.snap).toBeNull();
  });

  it('NaN 光标抛 RangeError；NaN 像素一个候选都不许赢', () => {
    expect(() => dropTargetOf(view, { x: Number.NaN, y: 5 }, null, field)).toThrow(RangeError);
    // raw 有限、cursorPx 是 NaN ⇒ 所有 distPx 都是 NaN。写成 `if (dist > tol) continue` 时
    // NaN > tol 是 false ⇒ 第一条候选会被当成命中（T4 第 8 条、T5 pickHandle 那条同款病）。
    expect(snapFromCursor(view, { x: Number.NaN, y: Number.NaN }, { x: 0, y: 0 }, null, field)).toBeNull();
  });

  it('对象档永远压过方向档：端点在 0.7px、正交在 0.5px，赢的仍是端点', () => {
    const cursor = pxOf({ x: 0, y: 0 }, view);
    // 往屏幕左上各偏 0.5px ⇒ 裸落点 (-4, -4)：它在 southWest 与 west 两条轴的**墙外侧**
    // （t = -4 < 0），所以垂足档这一发给不出候选，场上只剩端点与正交两档。
    const off: Px = { x: cursor.x - 0.5, y: cursor.y + 0.5 };
    const raw = moveTargetOf(view, off);
    // 素材自证：裸落点确实不是 (0,0)，否则这条什么都没判
    expect(raw).not.toEqual({ x: 0, y: 0 });
    const drop = dropTargetOf(view, off, { x: 4000, y: 0 }, field);
    expect(drop.snap?.kind).toBe('endpoint');
    expect(drop.snap?.mm).toEqual({ x: 0, y: 0 }); // 端点（对象档）赢，不是正交的 (-4, 0)
    expect(drop.raw).toEqual(raw); // 但 raw 原样保留：预览线仍画到光标
  });

  it('并列判据到底只剩 ownerId：同档位、同距离、坐标不同的两枚候选，倒序扫描给同一个落点', () => {
    const { log, storeyId } = synthStorey();
    wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    wallAt(log, storeyId, { x: 0, y: 8 }, { x: 4000, y: 8 });
    // pxPerMm = 1 ⇒ 光标 (2000, 4) 到两条轴的中点各差 4px，且 `hypot(0, 4)` 是二进制精确值
    // —— 距离**逐位相等**，不是"近似相等"。这一格是 ownerId 那一级唯一的用武之地。
    const v = viewportOf(1000, 800, { pxPerMm: 1, center: vec(2000, 4) });
    const f = snapFieldOf(log.document, storeyId);
    const raw = { x: 2000, y: 4 };
    const cursor = mmToPx(v, vec(raw.x, raw.y));
    const first = snapFromCursor(v, cursor, raw, null, f);
    const flipped = snapFromCursor(v, cursor, raw, null, reversed(f));
    // 素材自证：赢的是并列两枚里的一枚，且真有一发命中（否则下面两句恒真）
    expect(first?.kind).toBe('midpoint'); // 中点（1）压过两枚垂足（2），同档位同距离 ⇒ 只剩 id
    expect(Math.abs((first?.distPx ?? 0) - 4)).toBeLessThan(0.01);
    expect([[2000, 0], [2000, 8]]).toContainEqual([first!.mm.x, first!.mm.y]);
    // 判据只许比"倒序前后相等"，**不许**钉死哪一枚赢：两面墙每次现建 uuidv7，谁小不一定。
    expect(flipped).toEqual(first);
  });
});

describe('角度档：15° 与正交', () => {
  it('正交走"保坐标"语义：横向吸 y、纵向吸 x，落点是逐字整数', () => {
    const anchor = { x: 0, y: 0 };
    const horiz = snapFromCursor(av, pxOf({ x: 3000, y: 60 }, av), { x: 3000, y: 60 }, anchor, EMPTY_SNAP_FIELD);
    // 旋转保距语义会给 (3001, 0)（半径 3000.6 转平后 x 变 3000.6）：差 1mm 就红，两种语义彻底分得开
    expect(horiz?.kind).toBe('ortho');
    expect(horiz?.pointId).toBeNull();
    expect(horiz?.mm).toEqual({ x: 3000, y: 0 });
    expect(Math.abs((horiz?.distPx ?? 0) - 3)).toBeLessThan(0.01);
    const vert = snapFromCursor(av, pxOf({ x: 60, y: 3000 }, av), { x: 60, y: 3000 }, anchor, EMPTY_SNAP_FIELD);
    expect(vert?.mm).toEqual({ x: 0, y: 3000 }); // 纵向保 y：x 归到锚点的 x
  });

  it('15° 走"保距旋转"语义：落在 45° 射线上、半径不变、位移在容差之内', () => {
    const anchor = { x: 0, y: 0 };
    const raw = { x: 1000, y: 1035 }; // 45.98°：离 45° 只 0.98°，离最近的轴还 44°
    const snap = snapFromCursor(av, pxOf(raw, av), raw, anchor, EMPTY_SNAP_FIELD);
    expect(snap?.kind).toBe('angle15');
    expect(snap?.pointId).toBeNull();
    // 旋转语义给的是浮点半径上的量化值 ⇒ 钉性质不钉字面量（正交那一发是整数，才许钉字面量）
    expect(Math.abs(degOf(snap!.mm) - 45)).toBeLessThan(0.05);
    const radiusMm = length(vec(snap!.mm.x, snap!.mm.y));
    expect(Math.abs(radiusMm - length(vec(raw.x, raw.y)))).toBeLessThan(1.5);
    expect(snap!.distPx).toBeLessThanOrEqual(SNAP_TOL_PX);
  });

  it('档位互斥：离 45° 2.9° 给 angle15，离轴 2.3° 给 ortho，90 的倍数不属于 15° 档', () => {
    const near45 = snapFromCursor(
      av,
      pxOf({ x: 904, y: 1000 }, av),
      { x: 904, y: 1000 },
      { x: 0, y: 0 },
      EMPTY_SNAP_FIELD,
    );
    expect(near45?.kind).toBe('angle15');
    const nearAxis = snapFromCursor(
      av,
      pxOf({ x: 3000, y: 124 }, av),
      { x: 3000, y: 124 },
      { x: 0, y: 0 },
      EMPTY_SNAP_FIELD,
    );
    // 素材自证：它同时落在两条 15° 线的 3° 楔形里 —— 45° 那一发差 2.63°，比正交的 2.38° 还近
    expect(degOf({ x: 3000, y: 124 }) - 0).toBeGreaterThan(2.3);
    expect(45 - degOf({ x: 3000, y: 124 })).toBeGreaterThan(2.6);
    // S3 的牙齿：若 15° 档也收 90 的倍数，这一发会被"旋转保距"抢先（它位移更小），落点就不是整数 0
    expect(nearAxis?.kind).toBe('ortho');
    expect(nearAxis?.mm).toEqual({ x: 3000, y: 0 });
  });

  it('角度容差是 ANGLE_TOL_DEG：偏 2.90° 吸、偏 3.18° 不吸（两侧各留 0.1° 余量，不赌浮点边界）', () => {
    const anchor = { x: 0, y: 0 };
    const inside = mmAtAngle(47.9, 1350);
    const outside = mmAtAngle(48.2, 1350);
    expect(degOf(inside) - 45).toBeGreaterThan(2.8); // 素材自证：真的在容差内侧
    expect(degOf(outside) - 45).toBeGreaterThan(3.1); // 素材自证：真的越过了容差
    expect(snapFromCursor(av, pxOf(inside, av), inside, anchor, EMPTY_SNAP_FIELD)?.kind).toBe('angle15');
    // 外侧那一发的半径只 1350mm ⇒ 45° 候选离光标约 75mm = 3.8px，**在像素容差之内**：
    // 所以它被拒只能是角度判据干的，这条用例因此测的是 ANGLE_TOL_DEG 而不是 S1 的上限。
    expect(snapFromCursor(av, pxOf(outside, av), outside, anchor, EMPTY_SNAP_FIELD)).toBeNull();
    expect(ANGLE_TOL_DEG).toBe(3);
  });

  it('角度档也受 SNAP_TOL_PX 上限：同是偏 2.5°，半径 8000mm 不吸、2000mm 吸', () => {
    const anchor = { x: 0, y: 0 };
    const far = mmAtAngle(32.5, 8000); // 离 30° 差 2.502°（在 3° 之内），但楔形张开 349mm = 17.5px
    expect(snapFromCursor(av, pxOf(far, av), far, anchor, EMPTY_SNAP_FIELD)).toBeNull();
    const near = mmAtAngle(32.5, 2000); // 同一个角度、同一个档位：位移只有 87mm = 4.4px
    expect(snapFromCursor(av, pxOf(near, av), near, anchor, EMPTY_SNAP_FIELD)?.kind).toBe('angle15');
    // 这一对把"上限"与"角度判据"分开了：只有半径变、角度不变 ⇒ 红的只能怪上限
    expect(degOf(far) - 30).toBeGreaterThan(2.4);
    expect(degOf(near) - 30).toBeGreaterThan(2.4);
  });

  it('落点与锚点重合 ⇒ 无方向，角度档不给候选也不抛', () => {
    const anchor = { x: 1000, y: 2000 };
    expect(snapFromCursor(av, pxOf(anchor, av), anchor, anchor, EMPTY_SNAP_FIELD)).toBeNull();
  });

  it('1mm 的极短位移：正交档照给，落点就是那 1mm，且不许漏出 -0', () => {
    const anchor = { x: 0, y: 0 };
    const snap = snapFromCursor(av, pxOf({ x: 1, y: 0 }, av), { x: 1, y: 0 }, anchor, EMPTY_SNAP_FIELD);
    expect(snap?.kind).toBe('ortho');
    expect(snap?.mm).toEqual({ x: 1, y: 0 });
    // `anchor.y - 0` 与 `-0` 在 Object.is 下不等，而 mmToPx 会把它带进屏幕（vec.ts 的 ±0 纪律）
    expect(Object.is(snap?.mm.y, -0)).toBe(false);
  });

  it('anchorMm 为 null ⇒ 只有靶子档，画墙以外的场合不许被角度档牵走', () => {
    const raw = { x: 3000, y: 60 };
    expect(snapFromCursor(av, pxOf(raw, av), raw, null, EMPTY_SNAP_FIELD)).toBeNull();
  });
});

describe('落点出口与复用引用', () => {
  it('dropTargetOf 是 moveTargetOf 之后的同一发：连问两次逐字节相同，落点是像素的不动点', () => {
    const cursor = pxOf({ x: 0, y: 0 }, view); // 样例房西南角：端点 + 两条轴的垂足同时在这里
    const first = dropTargetOf(view, cursor, { x: 8000, y: 6000 }, field);
    expect(first.raw).toEqual(moveTargetOf(view, cursor));
    expect(first.mm).toEqual({ x: 0, y: 0 });
    expect(first.snap?.kind).toBe('endpoint'); // 三发并列（各差 0px）⇒ 优先级只在这一刻说话
    expect(dropTargetOf(view, cursor, { x: 8000, y: 6000 }, field)).toEqual(first);
    // 不动点：吸附点再过一次 `moveTargetOf` 不许漂（S4 与 --edit-shot「落点逐字相等」的地基）
    expect(moveTargetOf(view, mmToPx(view, vec(first.mm.x, first.mm.y)))).toEqual(first.mm);
  });

  it('拖端点时排掉"原地那一枚"：不排除会吸回自己，排除后这一发什么都没有', () => {
    const { log, storeyId } = synthStorey();
    const w = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const list = snapFieldOf(log.document, storeyId);
    const raw = { x: 0, y: 0 };
    const cursor = pxOf(raw, view);
    // 不排除：端点与该墙起点处的垂足全部重合在原地 ⇒ 拖不动（屏幕上表现为一松手墙没动）
    expect(snapFromCursor(view, cursor, raw, { x: 4000, y: 0 }, list)?.kind).toBe('endpoint');
    // 排除的是**坐标**而不是 pointId：那一枚点是端点、又是它自己轴线的 t=0 垂足，还正好在
    // 锚点 (4000,0) 往回的水平射线上 —— 只按 id 排除会漏掉后两发。
    expect(snapFromCursor(view, cursor, raw, { x: 4000, y: 0 }, list, { excludeMm: raw })).toBeNull();
    expect(w.startId).not.toBe('');
  });

  it('属性：任意光标下落点恒为整数毫米、离光标不超过 SNAP_TOL_PX，非端点档不给 pointId', () => {
    fc.assert(
      fc.property(
        fc.record({
          x: mmInt,
          y: mmInt,
          dx: fc.double({ min: -20, max: 20, noNaN: true }),
          dy: fc.double({ min: -20, max: 20, noNaN: true }),
        }),
        ({ x, y, dx, dy }) => {
          const base = pxOf({ x, y }, view);
          const drop = dropTargetOf(view, { x: base.x + dx, y: base.y + dy }, { x: 0, y: 0 }, field);
          expect(Number.isInteger(drop.mm.x) && Number.isInteger(drop.mm.y)).toBe(true);
          if (drop.snap !== null) {
            expect(drop.snap.distPx).toBeLessThanOrEqual(SNAP_TOL_PX);
            if (drop.snap.kind !== 'endpoint') expect(drop.snap.pointId).toBeNull();
            expect(drop.mm).toEqual({ x: drop.snap.mm.x, y: drop.snap.mm.y });
          } else {
            expect(drop.mm).toEqual(drop.raw);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it('pointRefOf 只认 `pointId` 非 null 那一支：吸到中点也必须新建点', () => {
    const mid: SnapResult = { kind: 'midpoint', pointId: null, mm: { x: 2000, y: 0 }, distPx: 0 };
    const ref = pointRefOf(mid.mm, mid);
    expect(ref).toEqual({ x: 2000, y: 0 });
    expect(isExistingPoint(ref)).toBe(false);
    // 素材自证：`snap !== null` 不是复用判据，`snap.pointId !== null` 才是。放宽一个字面量，
    // 上面两句同时红 —— 而命令层拿到的是 `{ pointId: null }`，`resolvePointRef` 当场抛。
    expect(pointRefOf(mid.mm, { ...mid, pointId: lowerWalls[0]!.startId })).toEqual({
      pointId: lowerWalls[0]!.startId,
    });
  });

  it('属性：pointRefOf 与 resolvePointRef 同一口径 —— 吸到既有点就复用它，否则才新建', () => {
    const existingId = lowerWalls[0]!.startId;
    fc.assert(
      fc.property(fc.record({ x: mmInt, y: mmInt, reuse: fc.boolean() }), ({ x, y, reuse }) => {
        const snap: SnapResult | null = reuse
          ? { kind: 'endpoint', pointId: existingId, mm: { x, y }, distPx: 0 }
          : null;
        const ref = pointRefOf({ x, y }, snap);
        if (snap === null) {
          expect(isExistingPoint(ref)).toBe(false);
          expect(ref).toEqual({ x, y });
          // 字面量那一支：resolvePointRef 必返 null，命令层才会真的新建点
          expect(resolvePointRef(house.doc, ref, house.lowerStoreyId)).toBeNull();
          return;
        }
        expect(isExistingPoint(ref)).toBe(true);
        expect(ref).toEqual({ pointId: existingId });
        // 复用那一支必须真能被真源解析回来：解析不到就是"屏幕上以为复用了，真源里另建了一枚点"
        expect(resolvePointRef(house.doc, ref, house.lowerStoreyId)?.id).toBe(existingId);
      }),
      { numRuns: 200 },
    );
  });
});
```

**为什么是 `SnapField` 而不是一个扁平的靶子数组**（执行时最容易"顺手简化"回 `SnapTarget[]` 的一处）：端点与中点是**存在真源里的坐标**，可以预先列成表；垂足是"光标到轴线的正投影"，它随光标变，静态表里根本没有这一行；正交与 15° 连坐标都不属于文档，只属于"锚点 + 方向"。所以场分成两个池子 —— `points`（静态）与 `axes`（几何），五档里只有端点与中点从 `points` 取，垂足按 `axes` 现算（`footOf`），角度档吃 `anchorMm`。把 `axes` 也预先量化成一串静态点，斜墙的垂足就会吸出"离轴 1mm 以内、但不在轴上"的落点，『垂足：光标落在斜墙轴线外侧』与『垂足不许越过墙端』两条会一起红。

**两条写测试前先定死的规矩**，它们决定了上面每条断言的形状：

① **`distPx` 永不进 `toEqual`。** 它是两次 `mmToPx` 之差，而 `mmToPx` 里是 `(origin.y - y) * pxPerMm`，`pxPerMm` 又不是二进制有限小数 ⇒ 同一个"3px"会算成 `2.9999999999999574`。位置一律写成 `toBeLessThan` / `toBeLessThanOrEqual` / 夹一个 `Math.abs(...) < 0.01`；**毫米**才许逐字钉（`quantizeMm` 之后是整数）。

② **垂足档离一切同轴候选都近。** 中点、端点都在它所在墙的轴线上，而垂足就是"光标到轴线的正投影" ⇒ 只要光标靠得够近，垂足的 `distPx` 恒 ≤ 同一条轴上任何靶子的 `distPx`（等号只在光标恰好落在那点上时成立）。所以"靶子之间谁赢"的用例必须**自带一个垂足对照**，否则测的是投影不是排序 —— 『垂足比端点近时距离赢』与『对象档永远压过方向档』两条就是按这条各挑了一个方向。

**排序判据的形状**（S2 的落地，`takeBest` 里那四行 `if`）：先比**组**（端点/中点/垂足 = 吸到已有的东西，正交/15° = 吸到方向，组 0 永远压过组 1），组内先比 `distPx`，再比 `PRIORITY`（端点 0 < 中点 1 < 垂足 2 < 正交 3 < 15° 4），最后比 `ownerId`。四级判据必须构成**全序**，否则并列时"谁赢"取决于扫描序 —— 测试里 `reversed(field)`（两个池子各自整个倒过来扫）与原场的结果必须逐字节相等，那一句就是全序的凭据，也是 Step 2 第 6 条改坏的靶子。

> **属性为什么仍然要有**（它抓不到随机搜的东西，但抓得到实现退化）：`numRuns: 400` 落在 40001² 的整数网格上，撞上"跳变超过 8px"那一发的概率约千分之几，所以**这条属性的红不靠随机**。它靠的是三件事：① 落点必须是整数毫米（量化漏在任一档，浮点落点会以每秒一次的频率撞到）；② `drop.mm` 与 `drop.snap.mm` 必须同源（吸附点被二次改写就红）；③ 非端点档不许带 `pointId`（把靶子表的 `pointId` 抄进角度档的结果里，200 次里必撞）。Step 2 的第 12、13 条改坏就是①②两句的**实测见证**：那两条改坏之后 26 条手搭用例全绿（磁盘实测：`snapping.test.ts` 共 28 个 `it(`，减去下一段点名的 2 条属性），只有属性红 —— 手搭用例挑的是"吸附对不对"，属性挑的是"出口有没有把吸附带出去"。反过来第 16 条（垂足不量化）只红手搭用例、属性还绿，因为样例房全是正交墙 ⇒ 属性的覆盖面等于它那一份靶子场的覆盖面。

**Step 1 的 `it` 合计 28 条**（吸附靶子表 4 + 光标→吸附 11 + 角度档 8 + 落点出口与复用 5；其中 2 条属性在最后一段）。

Run: `npx vitest run packages/scene-2d/test/snapping.test.ts > /tmp/t6-red.log 2>&1; echo exit=$?`
Expected: exit≠0，红在**函数不存在**上，不在断言值上 —— 机制见 Task 6 Step 4 那条订正：vitest 走 SSR 转译，`export *` 里缺的名字不会在链接期抛 `SyntaxError: The requested module '@dajia/scene-2d' does not provide an export named '…'`，它变成 `undefined`，到**调用那一行**才炸成 `TypeError: … is not a function`（2026-09-28 在临时工程里对 `editing.ts` 的十个新出口实测过这个形状）。**不许**是断言失败：`demoHouse` / `fitStorey` / `viewportOf` / `mmToPx` / `moveTargetOf` / `PICK_TOL_PX` 到本任务都已经存在，只有 `snapping.ts` 的 11 个出口（`snapFieldOf`、`snapFromCursor`、`dropTargetOf`、`pointRefOf`、`EMPTY_SNAP_FIELD`、`SNAP_TOL_PX`、`ANGLE_TOL_DEG` 与四个类型）是新的；红的是既有函数、或红在断言值上，就说明 Step 1 的材料有问题（多半是把某个新名字写成了既有名字），先回头核对再进 Step 2。

> 这份测试与下面 Step 2 那份实现，在 2026-09-27 于一份临时工程里一起跑过：`Test Files 1 passed`、`Tests 28 passed`，`tsc --noEmit`（`strict` + `noUncheckedIndexedAccess` + `noUnusedLocals` + `verbatimModuleSyntax`）无错，Step 2 那份 16 条改坏的清单是**逐条跑出来的红字**（临时工程不是仓库）。仓库里 `packages/scene-2d/` 到本任务之前只有 T1–T5 落下的文件，所以 **Step 2 的 `Tests 28 passed` 仍以仓内日志为准** —— 这段记录只说明"这 28 条与那 16 条红不是纸面推演"。

- [ ] **Step 2: scene-2d —— 实现 `snapping.ts`，跑绿，再逐条改坏**

`packages/scene-2d/src/snapping.ts` 整份新建。它的依赖只有三行 —— `@dajia/core`、`./viewport`、`./pick`（容差沿用 `PICK_TOL_PX`），**不依赖 `./handles`**：方向是 `handles → snapping`（拖把手也要吸附），反过来就成环。文件里同时落地 Task 5 D4 预留的那一行：`MoveTarget` / `quantizeTarget` / `moveTargetOf` 从 `handles.ts` 搬到这里，"像素换算毫米"与"毫米落到哪一档"因此住在同一个文件，全模块只剩两个出口能把光标变成坐标 —— `moveTargetOf`（裸落点：临时线、探针的 `raw`）与 `dropTargetOf`（吸附后的落点：唯一进 `dispatch` 的那一支）。第二条 px→mm 的路一旦长出，D4 就作废了，所以这两行不是"顺手放的"，是**必须放在一起**的。

```ts
import {
  quantizeMm,
  requirePoint,
  wallAxisById,
  type Document,
  type PointRef,
  type Vec2,
} from '@dajia/core';
import { mmToPx, pxToMm, type Px, type Viewport } from './viewport';
import { PICK_TOL_PX } from './pick';

/**
 * 屏幕像素 → 真源整数毫米的**唯一**通路（Task 5 D4 预留的那一行在这里落地）。
 *
 * `MoveTarget` / `moveTargetOf` 原本住在 `handles.ts`，Task 6 把它们搬进来：吸附必须插在
 * "像素换算毫米"之后（D4），而换算与吸附分居两个文件就会长出第二条 px→mm 的路 ——
 * 那正是 D4 禁止的东西。搬完之后，全模块只有两个出口会把光标变成落点：
 * `moveTargetOf`（裸落点，只给临时线与探针的 raw 用）与 `dropTargetOf`（吸附后的落点，
 * 只给 dispatch 用）。
 */

/** 落在真源上的整数毫米。与 core 的 `Vec2` 结构相同，但语义是"已过 quantizeMm"。 */
export interface MoveTarget {
  readonly x: number;
  readonly y: number;
}

/**
 * 浮点毫米 → 整数毫米。`quantizeMm` 的 `Math.round(v) + 0` 顺手把 -0 归一成 +0，
 * 所以任何一对候选坐标比较之前都先过这里 —— 否则 `Object.is(-0, 0)` 为 false，
 * "正交档没动 y"会在锚点 y 恰为 0 时被判成动了。
 */
export function quantizeTarget(v: Vec2): MoveTarget {
  return { x: quantizeMm(v.x), y: quantizeMm(v.y) };
}

/**
 * 屏幕像素 → 真源整数毫米（D4）。非有限输入由 `quantizeMm` 直接抛 RangeError：
 * 指针事件的坐标恒为有限数，真出 NaN 说明上面有人算了个 0/0 —— 那种东西静默兜成 0
 * 就是"一拖就飞到原点"，比当场崩掉难查得多。调用方（PlanCanvas 的落点分支）整段包在
 * try/catch 里报 `lastError`。
 */
export function moveTargetOf(viewport: Viewport, cursorPx: Px): MoveTarget {
  return quantizeTarget(pxToMm(viewport, cursorPx));
}

/**
 * 吸附容差沿用命中容差：屏幕上"点得中一条线"与"吸得上一个点"必须是同一个手感，
 * 否则用户没法形成预期（`pick.ts` 顶部那段"毫米容差放大 k 倍就宽 k 倍"的理由在这里同样成立）。
 *
 * **代价**：极度缩小时 8px 换算是很大的毫米数，吸附会把整张图吃光 —— 那是 `pick` 本来就有的
 * 性质（缩小后什么都点得中），不是这里新引入的。
 */
export const SNAP_TOL_PX = PICK_TOL_PX;

/** 角度档（正交 / 15°）的角容差，单位是**度**。 */
export const ANGLE_TOL_DEG = 3;

/**
 * 吸附标记的第四色（S8）。它在闸门里只承担一句话："那一刻确实吸附了" —— `snapMarkPx` 数的是
 * 全画布上这个颜色的像素总数，判据 `> 0` / 两发比较，**位置一律走毫米对账**。
 * 为什么不给它一个位置窗口：按构造吸附点离光标不超过 `SNAP_TOL_PX`（8px），而 T5 那五个桶用的
 * 是 ±2px 窗口 —— 不存在任何一个窗口既能把标记点和别的像素分开、又不会在"标记真的跑到 8px 外"
 * 时红。硬写那种窗口就是假绿。
 */
export const SNAP_COLOR = '#ff8a00';

/** 标记是 5×5 实心方块（Step 7 的 `paintSnapMarker` 照这个画）：与把手（`HANDLE_RADIUS_PX = 4.5`）同量级、不同尺寸，屏幕上两枚标记分得开。 */
export const SNAP_MARK_HALF_PX = 2.5;

/** 五档吸附。前三种吸到**已有的东西**上，后两种吸到**方向**上。 */
export type SnapKind = 'endpoint' | 'midpoint' | 'foot' | 'ortho' | 'angle15';

/** 静态点表里出现的两种档：垂足与角度档的候选按光标现算，不可能预先列出（见 `SnapField`）。 */
export type SnapPointKind = 'endpoint' | 'midpoint';

/** 表里的一枚候选点。`ownerId` 只用于并列破序，不给语义。 */
export interface SnapPoint {
  readonly kind: SnapPointKind;
  readonly mm: MoveTarget;
  /** 端点才有：它是真源里那一枚点，`{ pointId }` 复用全靠这个值非 null。中点为 null。 */
  readonly pointId: string | null;
  readonly ownerId: string;
}

/** 一面墙的轴线：垂足档把它当"无限长直线里的一段"来投影。 */
export interface SnapAxis {
  readonly ownerId: string;
  /** 轴起点。整数毫米（`wallAxisById` 的 start 直接读自 `requirePoint`），这里只做形状转换。 */
  readonly startMm: MoveTarget;
  /** 单位向量 start→end（浮点，只用于投影，永不写回真源）。 */
  readonly dir: Vec2;
  readonly lengthMm: number;
}

/** 一层的吸附场。`fitStorey` 一次、拖动开始时取一次，`pointermove` 里只读不建。 */
export interface SnapField {
  readonly points: readonly SnapPoint[];
  readonly axes: readonly SnapAxis[];
}

/** 吸附结果。`distPx` 是**光标到吸附点**的像素距离，恒 ≤ `SNAP_TOL_PX`。 */
export interface SnapResult {
  readonly kind: SnapKind;
  readonly pointId: string | null;
  readonly mm: MoveTarget;
  readonly distPx: number;
}

/** 一发光标的完整答案：裸落点 + 吸附后的落点 + 命中的那一档（没吸到就是 null）。 */
export interface DropTarget {
  readonly raw: MoveTarget;
  readonly mm: MoveTarget;
  readonly snap: SnapResult | null;
}

export interface SnapOptions {
  /**
   * 排掉**这一对坐标**的所有候选（不是排掉 pointId）：拖一枚端点时，原地那枚点既是端点
   * 候选、又是它自己那条轴线上 t=0 的垂足候选，只按 id 排会漏掉垂足那一发 —— 表现是
   * "一松手墙没动"。
   */
  readonly excludeMm?: MoveTarget | null;
}

/** 只按角度档时用这一份：没有既有几何可吸，但仍然要正交 / 15°。 */
export const EMPTY_SNAP_FIELD: SnapField = { points: [], axes: [] };

/** 先分组（对象档永远压过方向档），组内先比距离，再比档位，最后比 ownerId。 */
const GROUP: Record<SnapKind, number> = { endpoint: 0, midpoint: 0, foot: 0, ortho: 1, angle15: 1 };
const PRIORITY: Record<SnapKind, number> = {
  endpoint: 0,
  midpoint: 1,
  foot: 2,
  ortho: 3,
  angle15: 4,
};

/**
 * 本层的端点（按 pointId 去重）+ 每面墙的中点 + 每面墙的轴线。
 *
 * 去重是必须的：样例房一层有六枚共享端点，不去重就是"同一个点六个候选、六个 ownerId"，
 * 并列破序会挑出任意一面墙，`pointId` 却全都一样 —— 结果对，过程没法测。
 * 柱/板的顶点、洞口中心不在表里：Task 9 的补档（柱端点、轴网交点）要加时改这里，不在 UI 侧另搭一份。
 */
export function snapFieldOf(doc: Document, storeyId: string): SnapField {
  const points: SnapPoint[] = [];
  const axes: SnapAxis[] = [];
  const seen = new Set<string>();
  for (const wall of doc.byKind('wall')) {
    // 别层的墙一枚靶子都不给：两层的坐标区间会重叠（上下层同位置），
    // 漏了这行就会把一层的落点吸到另一层的点上 —— `resolvePointRef` 那一句跨层抛错
    // 紧接着会把一发无害的吸附变成命令层异常。
    if (wall.storeyId !== storeyId) continue;
    // 零长墙在 `wallCreate` / `wallMoveEndpoint` 那两道正数定值闸外就已经进不来真源，
    // 所以 `wallAxisById` 的"两端点重合"抛错在这里不可达（真打进来就是真源坏了）。
    const axis = wallAxisById(doc, wall.id);
    axes.push({
      ownerId: wall.id,
      startMm: { x: axis.start.x, y: axis.start.y },
      dir: axis.dir,
      lengthMm: axis.lengthMm,
    });
    for (const pointId of [wall.startId, wall.endId]) {
      if (seen.has(pointId)) continue;
      seen.add(pointId);
      const point = requirePoint(doc, pointId, '吸附端点');
      points.push({
        kind: 'endpoint',
        // 直读真源，不做任何 px ↔ mm 往返：吸上去的坐标必须和点上存的逐字相同，
        // 否则"复用"会顺手把那枚点挪走零点几毫米。
        mm: { x: point.x, y: point.y },
        pointId,
        ownerId: wall.id,
      });
    }
    // 手写轴 start + dir·(L/2)：和 `SnapAxis` 用同一套浮点算法，中点与垂足不会漂出半个像素。
    const half = axis.lengthMm / 2;
    points.push({
      kind: 'midpoint',
      mm: quantizeTarget({ x: axis.start.x + axis.dir.x * half, y: axis.start.y + axis.dir.y * half }),
      pointId: null,
      ownerId: wall.id,
    });
  }
  return { points, axes };
}

/** 取最优的内部形状 = `SnapResult` + `ownerId`：并列破序要用，但它不属于对外的落点结论。 */
interface Scored {
  readonly kind: SnapKind;
  readonly pointId: string | null;
  readonly mm: MoveTarget;
  readonly ownerId: string;
  readonly distPx: number;
}

/** 候选生成器的返回：吸附点与档位，`distPx` 由 `consider` 现算。 */
interface Ranked {
  readonly kind: SnapKind;
  readonly pointId: string | null;
  readonly mm: MoveTarget;
  readonly ownerId: string;
}

/**
 * 取最优。三条不许商量的性质：
 * ① 非有限 `distPx` 一个都不许赢 —— NaN 比较恒 false，写成 `if (dist > tol) continue`
 *    会把第一条候选当成命中（T4 第 8 条、T5 `pickHandle` 那条同款病）；
 * ② 严格 `<` 才换，所以并列时留下的是**先扫到**的那一枚 —— 扫描序与输入数组的序无关性由
 *    "并列判据全序化（group → distPx → PRIORITY → ownerId）"保证，`ownerId` 是 uuidv7，
 *    `byKind` 又已按 id 升序，故同一次扫描里两枚并列候选的 ownerId 不可能相等；
 * ③ 越界（> SNAP_TOL_PX）在这里统一挡，五个候选生成器都不必各自判容差。
 */
function takeBest(best: Scored | null, cand: Scored | null): Scored | null {
  if (cand === null || !Number.isFinite(cand.distPx) || cand.distPx > SNAP_TOL_PX) return best;
  if (best === null) return cand;
  if (GROUP[cand.kind] !== GROUP[best.kind]) return GROUP[cand.kind] < GROUP[best.kind] ? cand : best;
  if (cand.distPx !== best.distPx) return cand.distPx < best.distPx ? cand : best;
  if (PRIORITY[cand.kind] !== PRIORITY[best.kind]) {
    return PRIORITY[cand.kind] < PRIORITY[best.kind] ? cand : best;
  }
  return cand.ownerId < best.ownerId ? cand : best;
}

/**
 * 光标 → 吸附结果。五档各造候选，`takeBest` 挑。
 *
 * `raw` 是**已经量化过**的裸落点（调用方给 `moveTargetOf` 的结果）：角度档要的是"光标在
 * 世界里的位置"，用它而不是再用一次 cursorPx，才能保证落点是像素的不动点 ——
 * 同一发光标问两次必须得同一个数，否则 `--edit-shot` 那句"松手落点逐字等于探针给的毫米"
 * 会随机红。
 *
 * `anchorMm` 为 null 时角度档整段不参与：拖洞口、拖把手以外的场合没有"从哪儿出发"这回事。
 */
export function snapFromCursor(
  viewport: Viewport,
  cursorPx: Px,
  raw: MoveTarget,
  anchorMm: MoveTarget | null,
  field: SnapField,
  opts: SnapOptions = {},
): SnapResult | null {
  const exclude = opts.excludeMm ?? null;
  // 五个档位先各造候选、合成一个池子，再统一排序：分开比五趟"谁更近"要把这条判据抄五遍，
  // 而漏抄的那一遍永远不会红（它只在两档同时命中的那一格才说话）。
  // 池子里留 null 是"这一档没命中"，不是"没有候选点" —— 过滤只发生在下面那一趟循环里。
  const pool: (Ranked | null)[] = [];
  for (const p of field.points) pool.push(p);
  for (const axis of field.axes) pool.push(footOf(axis, raw));
  if (anchorMm !== null) {
    // 一律走裸算术，不调 core 的 sub/scale/advance/add：那些助手每个返回值都把 -0 归一成
    // +0，但**输入参数**里的 -0 会原样参与乘法，`-0 * 0` 仍是 -0，最后 `anchor.x + (-0)`
    // 把 -0 带进落点。绕开它们，这条就不必存在第二份。
    const dx = raw.x - anchorMm.x;
    const dy = raw.y - anchorMm.y;
    // 落点与锚点重合 ⇒ 无方向。不调 normalize / atan2：前者抛"零向量无法归一化"，
    // 后者 atan2(0,0) = 0 ⇒ 会凭空造出一枚"水平正交"候选（『落点与锚点重合 ⇒ 无方向』那条钉的就是这条）。
    if (dx !== 0 || dy !== 0) {
      const theta = Math.atan2(dy, dx);
      pool.push(orthoOf(anchorMm, raw, theta));
      pool.push(angle15Of(anchorMm, theta, Math.hypot(dx, dy)));
    }
  }
  let best: Scored | null = null;
  for (const cand of pool) {
    if (cand === null) continue;
    if (exclude !== null && cand.mm.x === exclude.x && cand.mm.y === exclude.y) continue;
    const p = mmToPx(viewport, cand.mm);
    best = takeBest(best, {
      kind: cand.kind,
      pointId: cand.pointId,
      mm: cand.mm,
      ownerId: cand.ownerId,
      distPx: Math.hypot(cursorPx.x - p.x, cursorPx.y - p.y),
    });
  }
  if (best === null) return null;
  // 剥掉 ownerId：它只是并列判据，不是"吸到了谁"的结论（结论是 kind + mm + pointId）。
  return { kind: best.kind, pointId: best.pointId, mm: best.mm, distPx: best.distPx };
}

/**
 * 垂足：光标（量化后的 `raw`）到轴线那段**线段**的正投影。
 * `t` 的上下界不能省 —— 放开它就会吸到轴延长线上，画出一条"对着空气齐"的墙。
 * 投影长度不量化，所以端点判定比真正垂线的参数范围宽一整个 |Δraw|：光标离墙端 1mm 时
 * 仍可能给出一枚墙外垂足，而它比端点更近，于是赢。误差 < 1mm 且永远被端点吸收，不补。
 */
function footOf(axis: SnapAxis, raw: MoveTarget): Ranked | null {
  const dx = raw.x - axis.startMm.x;
  const dy = raw.y - axis.startMm.y;
  const t = dx * axis.dir.x + dy * axis.dir.y;
  if (t < 0 || t > axis.lengthMm) return null;
  return {
    kind: 'foot',
    pointId: null,
    mm: quantizeTarget({ x: axis.startMm.x + axis.dir.x * t, y: axis.startMm.y + axis.dir.y * t }),
    ownerId: axis.ownerId,
  };
}

const DEG = 180 / Math.PI;
const QUADRANTS = [0, 90, 180, 270];

/** 偏离最近一条轴 ≤ ANGLE_TOL_DEG ⇒ 把那根坐标钉到锚点上（**保坐标**语义，S3）。 */
function orthoOf(
  anchor: MoveTarget,
  raw: MoveTarget,
  theta: number,
): Ranked | null {
  let best: { readonly deg: number; readonly q: number } | null = null;
  for (const q of QUADRANTS) {
    const d = Math.abs(((theta * DEG - q + 540) % 360) - 180);
    if (d <= ANGLE_TOL_DEG && (best === null || d < best.deg)) best = { deg: d, q };
  }
  if (best === null) return null;
  return {
    kind: 'ortho',
    pointId: null,
    // 横向保 y、纵向保 x：另一根坐标取自裸落点（不是光标），所以"保坐标"与"保距离旋转"
    // 在判据上分得开（角度档那一段里 1mm 位移的用例就是钉这条的）。
    mm: best.q % 180 === 0 ? { x: raw.x, y: anchor.y } : { x: anchor.x, y: raw.y },
    ownerId: 'ortho',
  };
}

/**
 * 偏离最近的 15° 倍数 ≤ ANGLE_TOL_DEG ⇒ 绕锚点**保距旋转**到那条射线上。
 * 90 的倍数整档让给正交（S3）：两档同时收轴方向会给出两个不同的点，而按距离算旋转那一发
 * 永远更近 —— 于是"画一条 4000 的水平墙"会得到 3997.8，屏幕上看不出来、真源里是一枚
 * 永远对不齐的坐标。
 */
function angle15Of(
  anchor: MoveTarget,
  theta: number,
  radius: number,
): Ranked | null {
  const deg = ((theta * DEG + 360) % 360);
  const n = Math.round(deg / 15);
  if (n % 6 === 0) return null; // 0 / ±90 / 180 / 270 ⇒ 正交档的地盘
  const target = n * 15;
  if (Math.abs(deg - target) > ANGLE_TOL_DEG) return null;
  const rad = (target * Math.PI) / 180;
  return {
    kind: 'angle15',
    pointId: null,
    mm: quantizeTarget({
      x: anchor.x + radius * Math.cos(rad),
      y: anchor.y + radius * Math.sin(rad),
    }),
    ownerId: 'angle15',
  };
}

/**
 * 一发光标的落点：`moveTargetOf` 之后紧接的一步，也是 dispatch 前最后一站。
 * 没吸到时 `mm` 就是 `raw`（同一次 `moveTargetOf` 的结果，不是再算一遍）。
 */
export function dropTargetOf(
  viewport: Viewport,
  cursorPx: Px,
  anchorMm: MoveTarget | null,
  field: SnapField,
  opts: SnapOptions = {},
): DropTarget {
  const raw = moveTargetOf(viewport, cursorPx);
  const snap = snapFromCursor(viewport, cursorPx, raw, anchorMm, field, opts);
  return { raw, mm: snap === null ? raw : snap.mm, snap };
}

/**
 * 落点 → 命令入参的端点。**吸到既有点就复用它**，否则才新建 —— 真源里存"两个坐标相同的点"
 * 永远合不上接头（`topology.ts` 顶部那句），所以这一句是拓扑闭合在屏幕侧的唯一出口。
 */
export function pointRefOf(mm: MoveTarget, snap: SnapResult | null): PointRef {
  if (snap !== null && snap.pointId !== null) return { pointId: snap.pointId };
  // 显式抄两个字段，不 return mm：PointRef 的字面量那一支只认 x/y，多带字段会被
  // `isExistingPoint` 的 `'pointId' in ref` 判据以外的地方读到。
  return { x: mm.x, y: mm.y };
}
```

`packages/scene-2d/src/index.ts` 末尾追加一行（与 T2/T4/T5 同形）：

```ts
export * from './snapping';
```

> **`MoveTarget` 与 `moveTargetOf` 是从 `handles.ts` 整段搬进来的，不是"两边各留一份"**（本任务第 7 处既有改动）。若有人只加不改，`export * from './handles'` 与 `export * from './snapping'` 会导出两个同名成员，TS 报 `Module './snapping' has already exported a member named 'MoveTarget'` —— 这条红是好事，它比"重复导出被静默去重"诚实得多。搬完之后 `handles.ts` 顶部那条 `quantizeMm`（core）与 `pxToMm`（viewport）的 import 变成未用，`noUnusedLocals` 会当场拦住（Step 5 的 diff 里有这两行的删除）。

Run: `npx vitest run packages/scene-2d/test/snapping.test.ts > /tmp/t6-green.log 2>&1; echo exit=$?`
Expected: exit=0，**`Tests 28 passed`**（`Test Files 1 passed`；Step 1 的 `it` 共 28 条，2 条属性在其中）。数对不上就是有用例被跳过或被合并，别改期望值，先查日志。

逐条改坏，每条做完立刻改回来（下面 16 条的**红在哪一条是 2026-09-27 实测的**，不是推演）：

1. 删掉 `snapFieldOf` 里的 `if (wall.storeyId !== storeyId) continue;` → 三条同时红：『端点表 = 本层墙端点的去重集』（8 枚变 16 枚）、『中点每面墙一条』（同理）、『楼层过滤：二层的端点一枚都不许进一层的表』。**这条是全场最贵的一处**：漏了层过滤，一层的落点会吸到二层的点上，紧接着 `resolvePointRef` 的跨层 `TypeError` 把一发无害的吸附变成命令层异常。
2. 删掉 `takeBest` 第一句里的 `!Number.isFinite(cand.distPx)` → 『NaN 光标抛 RangeError；NaN 像素一个候选都不许赢』必须红。`NaN > tol` 是 `false` ⇒ 不跳过 ⇒ 第一条候选被当成命中。与 T4 改坏第 8 条、T5 改坏第 5 条同款病，三次都是同一个写法。
3. `cand.distPx > SNAP_TOL_PX` 改成 `>=` → 『容差边界含等于』必须红在第一句。这一发红得干净是因为 `hypot(8, 0)` 是二进制精确值 —— 容差边界不许靠浮点余量蒙。
4. 删掉 `takeBest` 里比较 `GROUP` 那一行（只按距离排） → 『对象档永远压过方向档』必须红（0.5px 的正交抢走 0.707px 的端点，落点变成 `(-4, 0)`）。
5. `distPx` 与 `PRIORITY` 两段互换（先看档位再看距离） → 两条红：『垂足比端点近时距离赢…』（落点退回 `(0,0)` 那枚端点）与『垂足：光标落在斜墙轴线外侧』（中点 `(2000,2000)` 压过 3.5px 外的垂足）。**4 与 5 是同一对方向**：4 撤掉组判据，5 撤掉组内距离，两个方向各红一次，合起来才是 S2 的形状。
6. `takeBest` 最后一行 `return cand.ownerId < best.ownerId ? cand : best;` 改成 `return best;`（并列时留先扫到的那枚） → 『并列判据到底只剩 ownerId』必须红在 `expect(flipped).toEqual(first)`。这条用例是**唯一**走到第四级判据的输入（两面平行墙、光标正落在两条轴线的等距线上、`hypot(0,4)` 逐位相等），摘掉它不会连带崩别的用例，也不会被别的用例抓到。
7. 删掉 `angle15Of` 的 `if (n % 6 === 0) return null;`（让 15° 档也收 0/90/180/270） → **一条都不红，且这是正确的**。理由要写进注释：同一档位里正交落点与旋转落点共用同一根坐标（`y` 都等于 `anchor.y`），另一根相差 `round(L) − |dx| ≥ 0` ⇒ **正交恒不比旋转远**，距离判据自己就会把旋转挡掉。所以 `n % 6 === 0` 那一句不是胜负判据，是 `snapKind` 的**语义**判据（画水平墙时读数恒为 `'ortho'`，不会随量化在 `'ortho'`/`'angle15'` 之间抖）。**别为它补一条抓不到的用例**，也别反过来删掉那句 —— 它的凭据是这句引理，`--draw-shot` 的 `snapKind` 读数（Step 7）是它在真窗口里唯一的影子。
8. `orthoOf` 的落点从"保坐标"改成"保距旋转"（与 `angle15Of` 同一套 cos/sin） → 两条红：『正交走"保坐标"语义』（`(3000, 0)` 变 `(3001, 0)`）与『档位互斥』。这两条用例当初就是为了把两种语义在**字面量**上分开来才那么写的。
9. `footOf` 的 `if (t < 0 || t > axis.lengthMm)` 只留下界 → 『垂足不许越过墙端』红（吸出轴延长线上的"墙外垂足"）。
10. 同一条只留上界（放开 `t < 0`） → 『对象档永远压过方向档』红：裸落点 `(-4,-4)` 会在西侧轴上吸出 `(0,-4)` 那枚 0.5px 的墙外垂足，把 0.707px 的端点压掉。**两个界各有各的牙齿，不许只补一个** —— 第 9 条抓不到这一发，第 10 条也抓不到第 9 条那一发。
11. `snapFromCursor` 的排除判据加上 `cand.kind === 'endpoint'`（只排端点、漏掉垂足） → 『拖端点时排掉"原地那一枚"』必须红在第二句（原地那枚 t=0 垂足还在 ⇒ 一松手墙没动）。这就是 `excludeMm` 按**坐标**而不是按 `pointId` 的全部理由。
12. `dropTargetOf` 的 `mm: snap === null ? raw : snap.mm` 改成恒 `raw` → 红的是**属性**那条（`drop.mm` 与 `drop.snap.mm` 必须同源，②句）。手搭的『dropTargetOf 是 `moveTargetOf` 之后的同一发』反而**还绿** —— 它那一发光标正好压在 `(0,0)` 的像素上，`raw` 与吸附点同值。**这就是属性存在的意义**：随机 400 发里有吸得上的，就必然抓到"吸了却没落地"。
13. `moveTargetOf` 去掉量化（`pxToMm` 的浮点原样返回） → 同样只有**属性**那条红（①句：落点恒为整数毫米）。这条与第 12 条一起就是 Step 1 末尾承诺的那对见证。
14. `pointRefOf` 的 `snap !== null && snap.pointId !== null` 放宽成 `snap !== null` → 『pointRefOf 只认 `pointId` 非 null 那一支』红。命令层拿到的会是 `{ pointId: null }`，`resolvePointRef` 当场抛 —— 但用例不等它抛，它直接判形状。
15. `takeBest` 的 `if (cand.distPx !== best.distPx) return cand.distPx < best.distPx ? cand : best;` 写成 `if (cand.distPx < best.distPx) return cand;` → **不许红**：本实现的 `pool` 恒把静态点排在垂足与角度档之前 ⇒ "更近才换"与"不等就比谁近"在当前装配序上等价。保留 `!==` 那版是为了**让装配序不再是判据的一部分**（Step 4 之后有人把 `axes` 提到 `points` 前面时，`<` 那一版会静默改变结果）。改了不红，也不许把"两版等价"当成结论去简化 `!==` 那一版。
16. `footOf` 的 `quantizeTarget(...)` 去掉 → 『垂足：光标落在斜墙轴线外侧』红（`(2025, 2025)` 变成 `2024.9999…`）。**属性那条还绿** —— 样例房全正交墙 ⇒ 垂足恒为整数，`Number.isInteger` 抓不到它。这一条是"属性的覆盖面 = 它那份靶子场的覆盖面"的现场教材：它不是万能网，斜墙得靠手搭用例。

1–6、8–14、16 里任何一条"改坏了还绿"，说明对应断言写空了，就地补到能红为止；第 7、15 两条反过来，**必须还绿**，它们测的是"改动没坏但也没变"这一类，与"这条判据其实不承重"是两件事 —— 第 7 条承重（语义），第 15 条不承重（装配序）。把每条命令与关键红字写进提交信息。

- [ ] **Step 3: scene-2d —— `pick.ts` 抽出 `uniqueHitOf`，新增出口 `pickPxOf`（先改测试）**

Task 4 的 `probeTarget` 只能回答"随便挑一面点得中的墙"，而 Step 7 的 `--draw-shot` 要删除的是**刚新建的那一面**：撤销栈顶上恰好只有那一发时，删错墙也能绿 —— 那是假绿，而且是最贵的一类假绿，因为它绿在"删除功能可用"这句话上。所以 `pick.ts` 需要一个**点名**的出口。

点名与随手挑吃的是同一把尺（边长下限、唯一命中两条判据）。判据抄成两遍的地方，漏抄的那一遍永远不红 —— 所以这一步的正解不是"再写一个函数"，是**把 `probeTarget` 里那段候选点扫描抽成文件内私有的 `uniqueHitOf`**，让两个出口各吃它一次。抽完之后 `pickPxOf` 与 `probeTarget` 的关系由一条用例钉住（同一个 owner 给同一个像素，逐字相等），而不是靠"看起来一样"。

**为什么 `MIN_PICK_EDGE_PX` 必须导出**：Step 4 的 `wallProbe` 要在**墙还不存在**的时候预言"这面墙建出来点得中吗"，它没有指令表可扫，只能拿算术比这条尺（`(lengthMm − thicknessMm) × pxPerMm < MIN_PICK_EDGE_PX` ⇒ 换下一个候选落点）。不在这里给出去，探针只能自己抄一份 64，抄的那一份最先漂。`pickPxOf` 本身的读者则有两个：Step 7 的闸门，和 Step 4 里"建完之后拿真指令表点名"那条用例。

**这一步动的是 Task 4 已经落地的判据所在文件**（Task 6 里只有这一处和 Step 5 的 `handles.ts` 是这种情况），所以顺序必须是"先改测试跑到红 → 再改实现 → 数一数原有用例有没有被碰坏"。`index.ts` 不用动：T4 已经有 `export * from './pick'`，两个新出口自动带出。

---

**A. 先改 `packages/scene-2d/test/pick.test.ts`（+3 条 ⇒ 18）**

文件里只动三处：第 3 行的 core import 多一个 `wallAxisById`，`pickOne,` 之后多一行 `pickPxOf,`，然后在「每条指令的每条边中点都点得中自己」那条的收尾 `  });` 之后、「放大时吸附在屏幕上不变松…」那条之前插入三条。**其余一行都不许改** —— T4 的 15 条判据在这次改动之后必须逐字保持原样，B 段跑绿时若有任何一条原用例变红，就是抄错了地方。

```ts
  it('pickPxOf 点名要墙：一层的每一面墙都拿得到只命中它自己那一发的像素', () => {
    const walls = house.doc.byKind('wall').filter((w) => w.storeyId === house.lowerStoreyId);
    expect(walls).toHaveLength(8); // 素材自证：空表会让下面的循环什么都不判
    let shortest: number | null = null;
    for (const wall of walls) {
      const px = pickPxOf(ops, wall.id);
      expect(px).not.toBeNull();
      if (px === null) continue;
      // 不是"命中里有它"，是"只命中它"：删除那一步的选中集必须恰好一面墙
      expect(owners(pickAt(ops, px))).toEqual([wall.id]);
      const axis = wallAxisById(house.doc, wall.id);
      shortest = shortest === null ? axis.lengthMm : Math.min(shortest, axis.lengthMm);
    }
    // 素材自证：最短的是 `stem`（(4000,0)→(4000,3000)），3000mm 整数
    expect(shortest).toBe(3000);
    // 边长下限 64px 在这一层的 0.125px/mm 下 = 512mm，最短的墙也远过这条线，
    // 所以"每一面都给得出"不是运气 —— 但它确实**依赖** pxPerMm：极小缩放时会给 null，
    // 那是调用方（探针）该处理的失败，不是这里放宽筛选的理由。
    expect(shortest).toBeGreaterThan(64 / view.pxPerMm);
  });

  it('pickPxOf 找不到就说找不到：不存在的 id、只有注记的楼层、太小的多边形都给 null', () => {
    expect(pickPxOf(ops, 'no-such-entity')).toBeNull();
    // 楼层只有一条 text 指令，而 text 永不命中（注记不是构件）⇒ 没有候选点可挑
    expect(pickPxOf(ops, house.lowerStoreyId)).toBeNull();
    // 洞口只有 line 指令：本出口只扫多边形长边，给它 null 而不是"差不多的那个点"。
    // 少了 `op.kind !== 'polygon'` 那道筛，这里会被 `op.pts` 取值炸掉或静默给出别的 owner。
    const opening = house.doc.byKind('opening').find((o) => o.storeyId === house.lowerStoreyId);
    expect(opening).toBeDefined();
    if (opening !== undefined) expect(pickPxOf(ops, opening.id)).toBeNull();
    // 唯一命中被别的指令压住 ⇒ 一路换边换不到：与 probeTarget 那两条合成用例同源，
    // 但这里钉的是**点名**的那一支（probe 会跳过这个 owner 继续找下一个）。
    const tight = [
      face('tiny', PEN_S, [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 40 },
        { x: 0, y: 40 },
      ]),
    ];
    expect(pickPxOf(tight, 'tiny')).toBeNull(); // 四条边都 < 64px：一条候选都没有
    const covered = [
      face('w', PEN_S, [
        { x: 0, y: 0 },
        { x: 400, y: 0 },
        { x: 400, y: 40 },
        { x: 0, y: 40 },
      ]),
      // 两条断口线把上下两条长边的中点全压住 ⇒ 唯一命中不成立
      seg('o1', PEN_O, { x: 200, y: -20 }, { x: 200, y: 20 }),
      seg('o2', PEN_O, { x: 200, y: 20 }, { x: 200, y: 60 }),
    ];
    expect(pickPxOf(covered, 'w')).toBeNull();
    expect(pickPxOf(covered, 'o1')).toBeNull(); // 线指令永远给 null（这一发同时证 o1 压住了边）
  });

  it('pickPxOf 与 probeTarget 同一把尺：同一个 owner 给同一个像素，且那把尺是 64px 下限', () => {
    const probe = probeTarget(ops, view);
    expect(probe).not.toBeNull();
    if (probe === null) return; // 上面那条已断言非空，这里只为类型收窄
    // 判据是"逐字相等"而不是"都非 null"：抽函数时把扫描整段抄成两套，这一发立刻红。
    expect(pickPxOf(ops, probe.ownerId)).toEqual(probe.clickPx);
    // 但上一句"两函数相等"抓不到**只漂 pickPxOf 的下限**那一发：两边吃同一个常量，下限翻倍时
    // 两个函数一起跳到别的边上，等式照样成立。所以下面另钉一个像素值而不是关系 —— 实测（PK9）
    // 红的是这一句，不是上一句。第一条够长（≥64px）的边就是上边，中点 (50, 0)；
    // 下限翻到 128px 会跳到右边 (100, 200)。
    const rect = [
      face('w', PEN_S, [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 400 },
        { x: 0, y: 400 },
      ]),
    ];
    expect(pickPxOf(rect, 'w')).toEqual({ x: 50, y: 0 });
  });
```

> **第三格为什么要另钉一个字面量像素**：这一格的前后两句是两种判据 —— 前一句钉"两个出口同源"（关系），后一句钉"那把尺是 64"（定值）。只留前一句的话，`MIN_PICK_EDGE_PX` 被改坏时两个函数会**一起**漂到别的边上，关系仍然成立、用例仍然绿。这是"关系断言"的通用盲区，实测（PK9：只把 `pickPxOf` 那一发下限翻倍）红的是后一句。
>
> **`tight` 与 `covered` 各管一侧**：`tight` 证边长下限（40px 正方形，四条边都够不到 64 ⇒ 一枚候选都没有），`covered` 证唯一命中筛（400px 长边够长，但中点被洞口线压住 ⇒ 换边换不到）。少任何一侧，`uniqueHitOf` 里对应的那道 `continue` 就没有红过。

Run: `npx vitest run packages/scene-2d/test/pick.test.ts > /tmp/t6s3-red.log 2>&1; echo exit=$?`
Expected: exit≠0，**`Tests 3 failed | 15 passed (18)`**，三条的红字都是 `TypeError: pickPxOf is not a function`（2026-09-28 实测）。**必须是这 3 条红、T4 原 15 条全绿** —— 多一条红说明 A 段抄进了实现细节之外的东西；少一条红说明 `pickPxOf` 不知从哪儿已经存在了。

---

**B. 再改 `packages/scene-2d/src/pick.ts`**

前 158 行（`PICK_TOL_PX` → `PickHit` / `PickProbe` 两型 → `dist` → `distanceToSegmentPx` → `insidePolygon` → `distanceOfOp` → `rankOf` / `better` → `pickAt` → `pickOne` → `minDistanceToOps` → `blankPoint`）**一个字都不改**。从第 159 行那句 `/** 一次性回读用的靶子…` 起到文件末尾（T4 版的 `probeTarget` 整段）替换为下面这份：

```ts
/**
 * 候选点边长下限（= `PICK_TOL_PX * 8` = 64px）：太短的边，其中点四周挤着一堆相邻指令，
 * 唯一命中几乎不可能成立。
 *
 * 出口是必需的而不是顺手：`editing.ts` 的 `wallProbe` 要在**建墙之前**预言"这面墙建出来点得中吗"，
 * 而那个"点得中"就是这一条尺 —— 不在这里给出去，探针只能抄一份 64，抄的那一份最先漂。
 */
export const MIN_PICK_EDGE_PX = PICK_TOL_PX * 8;

/**
 * `ownerId` 的唯一命中候选点：按绘制序扫该 owner 的多边形指令，取第一条够长的边的中点，
 * 且要求 `pickAt` 在这一点恰好返回 1 条。找不到 ⇒ null。
 *
 * 抽成文件内私有只有一条理由：`probeTarget`（随便挑一个能用的靶子）与 `pickPxOf`（点名要某一个
 * 实体的靶子）必须吃同一把尺 —— 边长下限、唯一命中两条判据抄成两遍，漏抄的那一遍永远不红。
 */
function uniqueHitOf(ops: readonly DrawOp[], ownerId: string, minEdgePx: number): Px | null {
  for (const op of ops) {
    if (op.kind !== 'polygon' || op.ownerId !== ownerId) continue;
    const n = op.pts.length;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const a = op.pts[i]!;
      const b = op.pts[(i + 1) % n]!;
      if (dist(a, b) < minEdgePx) continue;
      const mid: Px = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // 多命中 = 这个点上"谁在上面"说不清，换下一条边，不猜。
      // hits.length === 1 时那条必然是本条指令自己（中点在它上面，距离 0），
      // 所以这里不再重复断言 ownerId —— 写了也没人能走到另一支，测试里由 probe 那两条钉。
      if (pickAt(ops, mid).length !== 1) continue;
      return mid;
    }
  }
  return null;
}

/**
 * 点名要某一个实体的可点像素 —— `probeTarget` 只能给"随便一面墙"，而 `--draw-shot` 的删除
 * 那一步要的是**刚新建的那一面**（撤销栈顶上恰好只有它时，删错墙也能绿，那是假绿）。
 * 边太短 / 每条边都被别的指令压住 / 该实体只有线和字（洞口、楼层注记）⇒ null，调用方当失败处理。
 */
export function pickPxOf(ops: readonly DrawOp[], ownerId: string): Px | null {
  return uniqueHitOf(ops, ownerId, MIN_PICK_EDGE_PX);
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
  const minEdgePx = MIN_PICK_EDGE_PX;
  // owner 按**首次出现**的绘制序试，`tried` 让一面墙的轮廓与它的轴线只进一次。
  // 换抽之前这里是"逐条指令扫"；`buildDrawList` 按实体成组产出指令（一个 owner 的轮廓紧挨着
  // 它的轴线），所以两种写法给出的第一个靶子逐字相同。诚实说一句：`tried` 因此**不是判据**，
  // 只是省一遍重复扫描 —— 实测摘掉它（PK6）18 条全绿，别为它写用例，也别把它读成"排重规则"。
  const tried = new Set<string>();
  for (const op of ops) {
    const ownerId = op.ownerId;
    if (ownerId === null || op.kind !== 'polygon' || tried.has(ownerId)) continue;
    tried.add(ownerId);
    const clickPx = uniqueHitOf(ops, ownerId, minEdgePx);
    if (clickPx !== null) return { ownerId, clickPx, blankPx: blank };
  }
  return null;
}
```

> **`probeTarget` 的循环为什么换了形状**：抽函数之后必须有人决定"按什么顺序问哪些 owner"。原来的形状是"逐条指令扫，第一条符合条件的指令赢"，那是 `pickPxOf(ops, ownerId)` 的循环不能直接复用的部分（它按 owner 过滤）。新形状"按 owner 首次出现扫"与原形状在样例房给出**逐字相同**的第一个靶子 —— 这一点不靠推理，由第三格那条「同一个 owner 给同一个像素」钉住：`pickPxOf(ops, probe.ownerId)` 与 `probe.clickPx` 必须相等，`probe` 换了 owner 或换了边都会红。
>
> **`tried` 是性能，不是判据**（这句必须留在代码里，不能只留在计划里）：摘掉它 18 条全绿（PK6 实测）。它存在的意义是"轮廓 + 轴线同 owner 时不必把同一批边扫两遍"。写这一步的人如果把它读成"排重规则"，就会给排重写用例，那条用例永远抓不到东西。

Run: `npx vitest run packages/scene-2d/test/pick.test.ts > /tmp/t6s3-green.log 2>&1; echo exit=$?`
Expected: exit=0，**`Tests 18 passed`**（`Test Files 1 passed`；Step 1 的 15 条 + 本步 3 条）。数对不上就是有用例被跳过或被合并，别改期望值，先查日志。

**类型不在这里拦**：vitest 走 esbuild 转译，**不做类型检查** —— 上面那次"把 `rect` 少写一个逗号"式的错，vitest 会照样跑绿。类型由 Step 8 的 `pnpm verify`（根 `typecheck` 已含 scene-2d，Task 1 Step 1 接的线）统一过，本步不重复跑它；但改完 B 段之后**必须**眼过一遍两个代码块与 A 段的插入位置，因为"绿但类型错"的东西会一路走到 Step 8 才红，那时候红字已经指不到是哪一段抄错了。

---

**C. 改坏验证（13 条，红在哪一条、红成什么数都是 2026-09-28 实测的，不是推演）**

下面每条都在 `pick.ts` 上做一次、跑 `test/pick.test.ts`（18 条）、跑完立刻改回。括号里是实测的 `passed / failed`，引号里是实测的**断言红字**（vitest 原样）—— 红字比测试名值钱：它说明抓到的确实是那一判据，而不是碰巧邻居倒了。

1. **PK1** 摘掉 `uniqueHitOf` 里 `if (pickAt(ops, mid).length !== 1) continue;` 整句（16/2）→ 「probeTarget 只接受唯一命中的候选点」红在 `expected { x: 200, y: +0 } to deeply equal { x: 200, y: 40 }`（放宽筛之后探针拿到被洞口线压住的那条边），「pickPxOf 找不到就说找不到」红在 `expected { x: 200, y: +0 } to be null`（`covered` 那一方）。**这就是 R4 那条"唯一命中"筛在抽函数之后的落点。**
2. **PK2** `export const MIN_PICK_EDGE_PX = PICK_TOL_PX * 8;` 改成 `= 0`（16/2）→ 红的是**同名那两条，但红字不同**：`expected { x: 400, y: 20 } to deeply equal { x: 200, y: 40 }`（下限归零后第一条指令的第一条边就是顶点附近那条短边，候选点整个换了一座墙）与 `expected { x: 20, y: +0 } to be null`（`tight` 那 40px 正方形有了候选点）。**PK1 与 PK2 不许当成一条**：下限管的是"短边压根不许进候选"，唯一命中管的是"长边的中点被压住也要换边"，两条判据各有各的红字。
3. **PK3** `uniqueHitOf` 的 owner 筛摘掉（`op.ownerId !== ownerId` 那半句删了）（16/2）→ 「点名要墙」红在 `expected [ Array(1) ] to deeply equal [ Array(1) ]`（两个一元数组不同：拿的是别的墙的像素、要的是本墙的 id），「找不到就说找不到」红在 `expected { x: 357.5, y: 810 } to be null`。**点名这件事当场失效** —— 不筛 owner 时"点中一面墙"和"点中随便哪面墙"是同一个返回值。
4. **PK4** 多边形筛摘掉（`op.kind !== 'polygon'` 那半句删了）（17/1）→ 只红「找不到就说找不到」那一条，红在 `TypeError: Cannot read properties of undefined (reading 'length')` —— 线指令上没有 `pts`，扫到它就在 `op.pts.length` 炸掉。**是炸不是给 null**（测试里那句"会被 `op.pts` 取值炸掉或静默给出别的 owner"，实测落在前半支）。**只红一条是正确的**：别的出口本来就只点多边形，这一发不会给它们错答案。
5. **PK5** `pickPxOf` 写成 `return null;`（16/2）→ 「点名要墙」红在 `expected null not to be null`，「同一把尺」红在 `expected null to deeply equal { x: 787.5, y: 442.5 }` —— 也就是**前一句关系判据**就够抓它了。这条与 PK9 正好是一对照：**整支坏掉**（恒 null）关系判据抓得到，**只漂下限**（两边一起挪）关系判据抓不到，所以字面量那一句不是冗余。
6. **PK6** `probeTarget` 的 `tried.has(ownerId)` 那半句摘掉（**18/0，一条都不红，且这是正确的**）→ 见 B 段注释：`tried` 不承重，摘与不摘给出的第一个靶子逐字相同（`buildDrawList` 成组产出）。**别为它补用例**，也别反过来摘掉那句"因为它不红"。
7. **PK7** 候选点从边中点改成起点顶点（`mid = { x: a.x, y: a.y }`）（14/4）→ 四条全红：`expected { x: +0, y: +0 } to deeply equal { x: 200, y: 40 }`、`expected null not to be null`（样例房的墙顶点全被邻墙/轴线压住 ⇒ 一枚靶子都挑不出来）、`expected { x: +0, y: +0 } to be null`、`expected { x: +0, y: +0 } to deeply equal { x: 50, y: +0 }`。**这是全场最红的一条**，也是"取中点而不是取顶点"这句话唯一的凭据 —— 顶点是相邻指令聚集处，中点才是那条边自己的地盘。
8. **PK8** `probeTarget` 的 `blankPx: blank` 改成 `blankPx: clickPx`（16/2）→ 两条靶子用例红在 `expected [ { ownerId: 'wall', …(2) } ] to deeply equal []` 与 `expected [ { …(3) } ] to deeply equal []`（`pickAt(ops, probe.blankPx)` 非空）。空白点与可点点是两个东西，混淆它们等于把"点空白清空选中"那一步变成"再点一次构件"。
9. **PK9** `pickPxOf` 里的下限翻倍（`uniqueHitOf(ops, ownerId, MIN_PICK_EDGE_PX * 2)`，**只漂点名的那一支**）（17/1）→ 只红「同一把尺」，且红在**后一句**：`expected { x: 100, y: 200 } to deeply equal { x: 50, y: +0 }`。前一句 `pickPxOf(ops, probe.ownerId)` 与 `probe.clickPx` **照样相等**（两边一起跳到别的边）—— 这一发就是 A 段那句"必须另钉字面量"的凭据：只写关系判据，这条改坏永远绿。
10. **PK10** 同一处减半（`/ 2`，32px）（17/1）→ 只红「找不到就说找不到」，红在 `expected { x: 20, y: +0 } to be null`（`tight` 的 40px 边进了候选）。9 与 10 把这道下限夹在中间 —— 往任一方向漂都有对应的一侧红，且两侧红在**不同**的用例上。
11. **PK11** `uniqueHitOf` 的指令扫描序反过来（`for (const op of [...ops].reverse())`）（**18/0**）→ 诚实记录：抓不到。**原因是结构性的**：一个 owner 在本计划的指令表里只有一条多边形指令（墙轮廓），所以"按绘制序取第一条"与"按倒序取第一条"对同一个 owner 是同一批边。这条不承重，**别为它写用例**；若哪天一个 owner 有多条多边形指令（比如给墙加分段轮廓），"取哪一条先"会变成真判据，那时再补。
12. **PK12** `probeTarget` 的 owner 循环反过来（**18/0**）→ 同样抓不到，同样诚实：`probeTarget` 的语义是"给一个能用的靶子"，**哪个** owner 不是判据（它的三条用例判的都是"给了的那个是否唯一命中 + 空白点是否真空白"，全是相对判据）。别把它读成"必须挑最靠前的墙"。
13. **PK13** 唯一命中筛改成 `hits.length < 1`（即 **Task 4 Step 5 第 10 条改坏搬家之后的样子**）（16/2）→ 红字与 PK1 **逐字相同**：`expected { x: 200, y: +0 } to deeply equal { x: 200, y: 40 }` + `expected { x: 200, y: +0 } to be null`。**Task 4 那条断言一字不改仍然成立**（它仍然红在 `expect(probe.clickPx).toEqual({ x: 200, y: 40 })`），多出来的那一条红来自本次新增的用例，不是 T4 的判据变了。（**已回改**：Task 4 Step 5 第 10 条现在写作 `uniqueHitOf`，并带着"Task 6 Step 3 之后这段住在 `uniqueHitOf` 里，见 PK13"的括注 —— 两处读的是同一次改坏，别再改回去。）

1–5、7–10、13 里任何一条"改坏了还绿"，说明对应断言写空了，就地补到能红为止；第 6、11、12 三条反过来，**必须还绿** —— 它们测的是"这条写法其实不承重"，与"断言写空了"是两件事，所以必须像上面那样把不承重的**原因**写进代码注释或本节的文字里，否则下一个人会来给它们补用例。**注意这三条与 T4/T5 的同类幸存者是同一件事的两头**：不承重的写法要留在原地（它更直），但它不许被读成判据。

把每条命令与关键红字写进提交信息。

- [ ] **Step 4: scene-2d —— 先写 `editing.ts` 的失败测试（30 条 `it`，含 1 条属性）**

`editing.ts` 只回答一句话：**这一发要不要发命令**。三个文件三条问题在这里排齐 —— `snapping.ts` 答"这一发光标落在哪"，`editing.ts` 答"这一发要不要发命令"，`handles.ts`（Step 5）答"哪一枚点可以拖"。PlanCanvas 只做装配，屏幕上不许长出第四套判据。

这份测试的形状由三条纪律决定，它们决定了下面 30 条为什么长那样：

**① 合法性 = 拿真命令试跑，屏幕上不重写守卫。** `legalWallCreate` 不是"再判一遍零长/墙厚/跨层"，它构造那发 `wallCreate` 并 `build` 一次，抛就是 false。与 T5 的 `legalDrop` 同一条理由：`wallCreate` 从构造期到 build 一路有六道守卫 —— 墙厚为正、墙高为正、零长、墙厚不小于墙长、楼层必须存在、复用的端点必须属于本层（`packages/core/src/commands/wall.ts:59-81`），**抄一道漏五道**，而漏掉的那一道只在用户真的拉出一堵怪墙时才说话。这条纪律的代价是"合法性"每移动一次光标都要跑一遍真构造 —— 一次 `pointermove` 几微秒，换来的是**预言与真命令不可能漂**（最后那条属性钉的就是这句）。

**② 探针给的是建之前的预言，所以每一道筛都要能在建之后被打脸。** `wallProbe` 的六道筛（① 起点吸到既有端点并复用、② 终点不引别人的点、③ 毫米与像素两道长度下限、④ 落点与中点两发像素一个候选都不命中、⑤ 三发像素全在画布内、⑥ 建得出还要画得出）里，能在单元层说话的各有自己的用例，且**全部 8/8 恒红**（2026-09-28，每个改坏连开八个进程）：摘 ② → 「筛 ② 有牙齿」、摘 ④ → 「筛 ④ 有牙齿」、摘 ⑤ → 「筛 ⑤ 有牙齿」、摘像素下限 → 「极度缩小下探针给 null…」、摘"终点/中点取整像素" → 「探针只给整数像素…」各红一条。**只有 E17 一条都不红**（摘掉毫米下限，八个进程 `30/0` ×8）：那条筛在现有夹具里被像素下限**完全罩住** —— 样例房拟合视图 `pxPerMm = 0.125`，64px 换算回毫米是 512mm，加回墙厚 240 得 752mm，比 500mm 的毫米下限更严，于是任何过得了 ③ 之二的候选自动过得了 ③ 之一。**不许为它造假绿用例**：它的凭据在 Task 8 的"数值输入 + 最小墙长"（放大到 2px/mm 时两道筛才分家），现在写在 `MIN_WALL_LENGTH_MM` 的注释里（见 B 段第 ② 条）。**E14/E26 是这条纪律的两块试金石**：一个坏法（终点可以引别人的点）红一条，另一个坏法（终点什么都不许吸）红九条 —— 后者正是 S7 那句"这条筛不是'终点不许吸任何东西'"的凭据。

**③ uuidv7 会让"探针先看到哪个候选"跨进程随机。** `snapFieldOf` 的端点表按 `doc.byKind('wall')` 的顺序 push（先 start 后 end），而 `byKind` 按实体 id 升序 —— uuidv7 在同一毫秒内**不单调**。于是任何"探针该换下一个候选"的用例，只要它的红取决于**哪面墙排在前面**，就是 flaky 的。这不是一句修辞，改坏跑里直接看得见：E27（摘掉 ⑤）与 E28（摘掉 ⑥）唯一的见证人是样例房那条「六道筛逐条自证」，八个进程里它**只红七次**；而同两道筛在自带夹具的「筛 ⑤ 有牙齿」与「⑥ 的前提」上是 8/8 恒红。所以本步的每一道"必须换下一个候选"都有自己的小场：② 用两堵共起点墙、④ 用一堵 4000mm 横墙、⑤ 用 `viewportOf(…, { center })` 把整层挪出画布、⑥ 用"同一枚点已过两条线"的三方向场。**别再让下一个人重新发现一次**（Task 8 要接手的也是这条口径：凡"探针/命令挑哪个候选"进判据，必须自带同坐标的合成夹具）。

**30 条的分组**：新墙默认值 2 + 按下与移动 6 + 合法性预言与真命令 3 + 删除计划 7 + 新建回执与探针 12（含最后那条属性）。

**A. 写 `packages/scene-2d/test/editing.test.ts`（新建，30 条 `it`）**

整份如下，**逐字照抄**：里面的注释是判据的一部分，删掉注释的执行人就无法判断某一句断言为什么在那儿。

```ts
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  Document,
  TransactionLog,
  columnCreate,
  openingCreate,
  openingDelete,
  requirePoint,
  storeyCreate,
  uuidv7,
  vec,
  wallCreate,
  wallDelete,
  type PointRef,
  type WallEntity,
} from '@dajia/core';
import {
  EMPTY_SELECTION,
  EMPTY_SNAP_FIELD,
  MIN_PICK_EDGE_PX,
  MIN_WALL_LENGTH_MM,
  NEW_WALL_THICKNESS_MM,
  buildDrawList,
  demoHouse,
  draftAtPress,
  draftCommand,
  draftRefs,
  dropTargetOf,
  fitStorey,
  lastCreatedWall,
  legalWallCreate,
  mmToPx,
  moveDraft,
  moveTargetOf,
  newWallDefaults,
  pickAt,
  pickPxOf,
  planDelete,
  pointRefOf,
  pruneSelection,
  snapFieldOf,
  viewportOf,
  wallProbe,
  type DraftWall,
  type MoveTarget,
  type Px,
  type SnapField,
  type Viewport,
} from '@dajia/scene-2d';

const house = demoHouse();
const view = fitStorey(house.doc, house.lowerStoreyId, 1200, 900, 60);
const field = snapFieldOf(house.doc, house.lowerStoreyId);
const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);
const lowerWalls = house.doc.byKind('wall').filter((w) => w.storeyId === house.lowerStoreyId);
const upperWalls = house.doc.byKind('wall').filter((w) => w.storeyId === house.upperStoreyId);

/** 整数毫米生成器：真源只收这个形状，属性不许拿浮点当输入。 */
const mmInt = fc.integer({ min: -20000, max: 20000 });

/**
 * 合成用例专用视口：0.1px/mm ⇒ `MIN_PICK_EDGE_PX`(64px) = 640mm、`SNAP_TOL_PX`(8px) = 80mm，
 * 且 10mm 恰好是一像素 ⇒ `moveTargetOf` 在整数毫米上是不动点，红的时候不必先排除舍入。
 * 样例房那一份 `fitStorey` 是 0.125px/mm（1px = 8mm），算落点要处理的边角太多。
 */
const sv = viewportOf(1000, 800, { pxPerMm: 0.1, center: vec(2000, 1000) });

/** 独立的一层（可选层高），删除与新建的判据都在它上面跑，免得样例房的接头掺进来。 */
function synthStorey(heightMm = 3000): { log: TransactionLog; storeyId: string } {
  const projectId = uuidv7();
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm }));
  let storeyId = '';
  for (const id of log.affected) {
    if (log.document.get(id)?.kind === 'storey') storeyId = id;
  }
  if (storeyId === '') throw new TypeError('affected 里没有新建的楼层');
  return { log, storeyId };
}

/** 建一面墙并把实体取回来（**不许** `byKind('wall').at(-1)`：uuidv7 同毫秒不单调）。 */
function wallAt(log: TransactionLog, storeyId: string, start: PointRef, end: PointRef): WallEntity {
  log.dispatch(wallCreate({ storeyId, start, end, thicknessMm: 240, heightMm: 3000 }));
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new TypeError('affected 里没有新建的墙');
}

/** 建一樘洞口并取回 id。 */
function openingAt(log: TransactionLog, hostWallId: string, distanceMm: number): string {
  log.dispatch(openingCreate({ hostWallId, distanceMm, widthMm: 1000, heightMm: 2100, category: 'door' }));
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'opening') return id;
  }
  throw new TypeError('affected 里没有新建的洞口');
}

/** 本层唯一那面墙。 */
function onlyWall(log: TransactionLog): WallEntity {
  const walls = log.document.byKind('wall');
  if (walls.length !== 1) throw new TypeError('合成现场应当恰好只有一面墙');
  return walls[0]!;
}

/** 光标就停在这对整数毫米的像素上：草稿拿到的像素与毫米因此逐字自洽。 */
const pxOf = (mm: MoveTarget, v: Viewport): Px => mmToPx(v, vec(mm.x, mm.y));

/**
 * 一条**一面墙**的合成现场。所有移动 / 合法性用例都吃它，所以三个数字在整份文件里只解释一次：
 * 墙 (0,0)→(4000,0)、视口 0.1px/mm、容差 8px = 80mm。
 */
function oneWall(): { log: TransactionLog; storeyId: string; wall: WallEntity; field: SnapField } {
  const { log, storeyId } = synthStorey();
  const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
  return { log, storeyId, wall, field: snapFieldOf(log.document, storeyId) };
}

/** 按下的起点：压在 (0,0) 那枚既有端点上，`legal` 还没算过（false）。 */
function pressAtOrigin(fd: SnapField, storeyId: string): DraftWall {
  const start = draftAtPress(sv, pxOf({ x: 0, y: 0 }, sv), fd);
  return {
    storeyId,
    start,
    cursorPx: start.px,
    end: dropTargetOf(sv, start.px, null, fd),
    legal: false,
  };
}

/** 从当前草稿把光标拖到**这对毫米**对应的像素上：走的就是屏幕那条通路（不手搓 DropTarget）。 */
function dragToEnd(draft: DraftWall, end: MoveTarget, doc: Document, fd: SnapField, v: Viewport): DraftWall {
  return moveDraft(doc, draft, v, pxOf(end, v), fd);
}

describe('新墙默认值', () => {
  it('墙高读真源的层高，不是抄常量：3600 的层拿 3600', () => {
    const { log, storeyId } = synthStorey(3600);
    expect(newWallDefaults(log.document, storeyId)).toEqual({
      thicknessMm: NEW_WALL_THICKNESS_MM,
      heightMm: 3600,
    });
    // 对照：样例房两层都是 3000。少这一句，上面那发可以被"恒返回 3600"的写法混过去
    expect(newWallDefaults(house.doc, house.lowerStoreyId).heightMm).toBe(3000);
  });

  it('楼层不存在 ⇒ 抛，不兜成默认值', () => {
    expect(() => newWallDefaults(house.doc, 'no-such-storey')).toThrow(/不存在|楼层/);
  });
});

describe('按下与移动', () => {
  it('起点压在既有端点上：吸到端点档，pointId 与 mm 逐字取自真源', () => {
    const wall = lowerWalls[0]!;
    const point = requirePoint(house.doc, wall.startId, '起点');
    const pressPx = pxOf({ x: point.x, y: point.y }, view);
    const start = draftAtPress(view, pressPx, field);
    expect(start.snap?.kind).toBe('endpoint');
    expect(start.snap?.pointId).toBe(wall.startId);
    expect(start.mm).toEqual({ x: point.x, y: point.y });
    // `px` 存的是**按下那一发**的像素（起点标记画在哪儿读它），不是吸附点的像素
    expect(start.px).toEqual(pressPx);
  });

  it('按下处的像素与吸附点的像素是两个值：标记画在按下处，落点吸到点上', () => {
    const { storeyId, wall, field: fd } = oneWall();
    const pressPx = pxOf({ x: -50, y: -50 }, sv); // 离原点那枚端点 7.07px（容差 8px 之内），且在两条轴的延长线外
    const start = draftAtPress(sv, pressPx, fd);
    expect(start.snap?.pointId).toBe(wall.startId); // 素材自证：这一发确实吸上了那枚点
    expect(start.mm).toEqual({ x: 0, y: 0 });
    // 但 `px` 记下的是手指按下的地方。存成吸附点的像素，屏幕上就是"标记自己跳过去了"，
    // 而这一条在真源里查不出来 —— 只有这两个值不相等的那一发能分辨。
    expect(start.px).toEqual(pressPx);
    expect(start.px).not.toEqual(mmToPx(sv, vec(start.mm.x, start.mm.y)));
    expect(storeyId).not.toBe(''); // 素材自证：合成现场立起来了
  });

  it('起点在空白处按下：什么都不吸，也不吃角度档（锚点恒 null）', () => {
    const { log, storeyId, field: fd } = oneWall();
    // (4200, 60)：在墙的延长线方向上 —— 垂足越界（t > 4000）、最近的端点也在 100px 外，
    // 所以靶子档一枚都不命中；它离水平轴只有 0.82°，**带上锚点**就会被正交档钉平。
    const raw: MoveTarget = { x: 4200, y: 60 };
    const start = draftAtPress(sv, pxOf(raw, sv), fd);
    expect(start.snap).toBeNull();
    expect(start.mm).toEqual(moveTargetOf(sv, pxOf(raw, sv)));
    // 素材自证：同一发带上锚点就吸得上 ⇒ "按下不吸"确实是锚点造成的，不是坐标碰巧没人要
    const withAnchor = dropTargetOf(sv, pxOf(raw, sv), { x: 0, y: 0 }, EMPTY_SNAP_FIELD);
    expect(withAnchor.snap?.kind).toBe('ortho');
    expect(withAnchor.mm).toEqual({ x: 4200, y: 0 });
    expect(storeyId).not.toBe(''); // 素材自证：合成现场确实立起来了（楼层 + 一面墙）
    expect(log.depth).toBe(2);
  });

  it('拖到水平方向：终点吸成逐字整数、临时线仍画到裸光标、原草稿不动', () => {
    const { log, storeyId, field: fd } = oneWall();
    const base = pressAtOrigin(fd, storeyId);
    const cursor = pxOf({ x: 5000, y: 60 }, sv); // 离轴 0.69°，在 ANGLE_TOL_DEG 之内
    const moved = moveDraft(log.document, base, sv, cursor, fd);
    expect(moved.end.snap?.kind).toBe('ortho');
    expect(moved.end.mm).toEqual({ x: 5000, y: 0 }); // 正交档保坐标 ⇒ 逐字整数
    expect(moved.cursorPx).toEqual(cursor); // S4 第三条：预览线画到**裸光标**，不是吸附点
    expect(moved.legal).toBe(true);
    // 不可变：原草稿一格都没动（renderer 比引用决定要不要重绘，改原地等于让 React 看不见这一发）
    expect(base.cursorPx).not.toEqual(cursor);
    expect(base.legal).toBe(false);
  });

  it('光标压在起点上：终点排掉起点坐标、零长墙判不合法', () => {
    const { log, storeyId, field: fd } = oneWall();
    const base = pressAtOrigin(fd, storeyId);
    expect(base.start.snap?.pointId).not.toBeNull(); // 素材自证：起点确实吸上了那枚端点
    const moved = moveDraft(log.document, base, sv, base.start.px, fd);
    // 不排起点会吸回自己（端点档 + 该点处的垂足档），于是"一松手什么也没发生"
    expect(moved.end.snap).toBeNull();
    expect(moved.end.mm).toEqual(base.start.mm);
    expect(moved.legal).toBe(false);
    expect(draftCommand(moved, newWallDefaults(log.document, storeyId))).toBeNull();
  });

  it('draftRefs：起点复用 {pointId}、终点新建 {x,y}，真源里接头真接上了', () => {
    const { log, storeyId, field: fd } = oneWall();
    const base = pressAtOrigin(fd, storeyId);
    const moved = dragToEnd(base, { x: 0, y: 2500 }, log.document, fd, sv);
    expect(moved.legal).toBe(true);
    const refs = draftRefs(moved);
    expect(refs.start).toEqual({ pointId: base.start.snap?.pointId });
    expect(refs.end).not.toHaveProperty('pointId');
    const command = draftCommand(moved, newWallDefaults(log.document, storeyId));
    expect(command?.type).toBe('wall.create');
    if (command === null) throw new TypeError('legal 为真却拿不到命令');
    const before = log.document.byKind('point').length;
    log.dispatch(command);
    const created = lastCreatedWall(log.document, log.affected, storeyId);
    if (created === null) throw new TypeError('affected 里没有那面墙');
    // 接头成立 = 起点那一端**就是**既有那枚点；终点是新建的，所以点数恰好 +1（不是 +2）
    expect(created.startId).toBe(base.start.snap?.pointId);
    expect(created.endId).not.toBe(created.startId);
    expect(log.document.byKind('point').length).toBe(before + 1);
    expect(requirePoint(log.document, created.startId, '共享起点')).toEqual(
      expect.objectContaining({ x: 0, y: 0 }),
    );
    // 复用的判据只有一处：`pointRefOf` 看到 snap.pointId 非 null。换一种写法（自己摸 snap 拼 ref）
    // 就会在这里给出 {x,y} ⇒ +2 枚点，上面那句先红。
    expect(pointRefOf(moved.start.mm, moved.start.snap)).toEqual(refs.start);
  });
});

describe('合法性预言与真命令', () => {
  it('试跑不动真源：墙数、撤销栈深度、affected 三票全部原样', () => {
    const { log, storeyId, field: fd } = oneWall();
    const moved = dragToEnd(pressAtOrigin(fd, storeyId), { x: 1200, y: 0 }, log.document, fd, sv);
    const walls = log.document.byKind('wall').length;
    const affectedBefore = [...log.affected].sort();
    expect(legalWallCreate(log.document, moved)).toBe(true);
    expect(legalWallCreate(log.document, moved)).toBe(true); // 问两次同值（探针的可复现性靠这句）
    expect(log.document.byKind('wall').length).toBe(walls);
    expect(log.depth).toBe(2);
    // 少了这一条，"预览时每问一次就污染一次 affected"会让 `lastCreatedWall` 拿到试跑那一份
    expect([...log.affected].sort()).toEqual(affectedBefore);
  });

  it('三种拒绝各一色：零长、墙厚不小于墙长、跨层复用点', () => {
    const { log, storeyId, field: fd } = oneWall();
    const base = pressAtOrigin(fd, storeyId);
    const defaults = newWallDefaults(log.document, storeyId);
    // ① 零长：终点落回起点
    expect(moveDraft(log.document, base, sv, base.start.px, fd).legal).toBe(false);
    // ② 墙厚不小于墙长：240 厚的墙拖 200mm
    expect(dragToEnd(base, { x: 200, y: 0 }, log.document, fd, sv).legal).toBe(false);
    // 素材自证：同一方向多拖一点就合法（否则"恒 false"的写法也过这一发）
    expect(dragToEnd(base, { x: 400, y: 0 }, log.document, fd, sv).legal).toBe(true);
    // ③ 跨层复用点：把二层那枚起点当一层的起点，`resolvePointRef` 抛。
    // 终点保持"合法那一发"，所以这一发红只可能是起点造成的 —— 反过来（只换终点）证不到起点。
    const legalSoFar = dragToEnd(base, { x: 0, y: 1500 }, log.document, fd, sv);
    expect(legalSoFar.legal).toBe(true);
    const upper = upperWalls[0]!;
    const crossLayer: DraftWall = {
      ...legalSoFar,
      start: {
        mm: { x: 0, y: 0 },
        px: legalSoFar.start.px,
        snap: { kind: 'endpoint', pointId: upper.startId, mm: { x: 0, y: 0 }, distPx: 0 },
      },
    };
    expect(legalWallCreate(log.document, crossLayer)).toBe(false);
    // 素材自证：同一份草稿换回本层那枚点就合法 —— 上一发红在跨层，不是红在 `upper.startId` 写错了
    const sameLayer: DraftWall = {
      ...crossLayer,
      start: { mm: { x: 0, y: 0 }, px: legalSoFar.start.px, snap: base.start.snap },
    };
    expect(legalWallCreate(log.document, sameLayer)).toBe(true);
    expect(defaults.heightMm).toBe(3000);
  });

  it('draftCommand 只认 legal 一色：false 给 null，true 给可派发的命令', () => {
    const { log, storeyId, field: fd } = oneWall();
    const base = pressAtOrigin(fd, storeyId);
    const defaults = newWallDefaults(log.document, storeyId);
    expect(draftCommand(base, defaults)).toBeNull(); // 手工摆的草稿 legal 恒 false
    const ok = dragToEnd(base, { x: 0, y: -1500 }, log.document, fd, sv);
    expect(ok.legal).toBe(true);
    expect(draftCommand(ok, defaults)?.type).toBe('wall.create');
    // 对照：同一发把 legal 抹成 false，命令就发不出去（判据只有这一色，没有第二条路）
    expect(draftCommand({ ...ok, legal: false }, defaults)).toBeNull();
  });
});

describe('删除计划', () => {
  it('选一面墙：一条 wall.delete，candidateIds 记着它', () => {
    const { log, storeyId } = oneWall();
    const wall = onlyWall(log);
    const plan = planDelete(log.document, storeyId, 'select', [wall.id]);
    expect(plan.outcome).toBe('ok');
    expect(plan.commandTypes).toEqual(['wall.delete']);
    expect(plan.candidateIds).toEqual([wall.id]);
    expect(plan.unsupported).toEqual([]);
    // 命令真的删得掉（预言与真源的对照；`build` 的 remove 里带这面墙）
    expect(plan.commands[0]?.build(log.document).remove).toContain(wall.id);
  });

  it('墙与它的洞口一起选中：只发一条 wall.delete，不复述级联', () => {
    const { log, storeyId } = oneWall();
    const wall = onlyWall(log);
    const openingId = openingAt(log, wall.id, 1000);
    const plan = planDelete(log.document, storeyId, 'select', [wall.id, openingId]);
    // 第二条 `opening.delete` 不该出现：`wallDelete` 的级联已经收了它（复述必漂）
    expect(plan.outcome).toBe('ok');
    expect(plan.commandTypes).toEqual(['wall.delete']);
    expect(plan.candidateIds).toEqual([wall.id]);
    expect(plan.unsupported).toEqual([]);
    // 照计划真跑：墙与洞口一起消失
    const once = new TransactionLog(log.document);
    for (const command of plan.commands) once.dispatch(command);
    expect(once.document.get(wall.id)).toBeUndefined();
    expect(once.document.get(openingId)).toBeUndefined();
    // 反过来（给宿主墙同批删除的洞口也发一条）会炸在半路：墙先删掉 ⇒ 洞口已不存在 ⇒ requireOpening 抛。
    // 这一发是 `dispatchBatch` 的"半途留半套状态"的凭据，不是想象。
    const twice = new TransactionLog(log.document);
    twice.dispatch(wallDelete({ wallId: wall.id }));
    expect(twice.document.get(openingId)).toBeUndefined();
    expect(() => twice.dispatch(openingDelete({ openingId }))).toThrow();
  });

  it('独立洞口 + 另一面墙：两条命令，洞口在前、墙在后', () => {
    const { log, storeyId } = synthStorey();
    const a = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const b = wallAt(log, storeyId, { x: 0, y: 2000 }, { x: 4000, y: 2000 });
    const openingId = openingAt(log, a.id, 1200);
    const plan = planDelete(log.document, storeyId, 'select', [b.id, openingId]);
    expect(plan.outcome).toBe('ok');
    // 顺序不是随手排的：栈顶留 `wall.delete`，一次 Ctrl+Z 还原"墙 + 它级联掉的洞口"
    expect(plan.commandTypes).toEqual(['opening.delete', 'wall.delete']);
    expect(plan.candidateIds).toEqual([openingId, b.id]);
    for (const command of plan.commands) log.dispatch(command);
    expect(log.document.get(openingId)).toBeUndefined();
    expect(log.document.get(b.id)).toBeUndefined();
    expect(log.document.get(a.id)?.kind).toBe('wall'); // 宿主墙没被选中，它和它的洞口都该还在
    expect(log.document.byKind('opening').length).toBe(0);
  });

  it('三种沉默三种颜色：拉墙模式 / 只剩柱 / 空集', () => {
    const { log, storeyId } = oneWall();
    const wall = onlyWall(log);
    log.dispatch(columnCreate({ storeyId, at: { x: 500, y: 500 }, widthMm: 400, depthMm: 400 }));
    const columnId = [...log.affected].find((id) => log.document.get(id)?.kind === 'column');
    if (columnId === undefined) throw new TypeError('affected 里没有那根柱');
    // ① 拉墙时误触 Delete：什么都不发，但**不许**报"没选中东西"（选中集不该被清空）
    expect(planDelete(log.document, storeyId, 'wall', [wall.id, columnId])).toEqual({
      outcome: 'ignored-in-wall-mode',
      commands: [],
      commandTypes: [],
      candidateIds: [],
      unsupported: [],
    });
    // ② 只选了一根柱：本任务没有 columnDelete，如实报 unsupported（Task 8 接上之后这一格少一个取值）
    const only = planDelete(log.document, storeyId, 'select', [columnId]);
    expect(only.outcome).toBe('unsupported');
    expect(only.commands).toHaveLength(0);
    expect(only.unsupported).toEqual([columnId]);
    // ③ 什么都没选：'empty'，与 ② 不同色
    const none = planDelete(log.document, storeyId, 'select', []);
    expect(none.outcome).toBe('empty');
    expect(none.unsupported).toEqual([]);
    // 三色的存在性：写成布尔（"发没发命令"）就把 ①②③ 糊成一格
    expect(new Set(['ignored-in-wall-mode', only.outcome, none.outcome]).size).toBe(3);
    // 混选：柱 + 墙 ⇒ 墙照删，柱进 unsupported（不是"整批不做"）
    const mixed = planDelete(log.document, storeyId, 'select', [columnId, wall.id]);
    expect(mixed.outcome).toBe('ok');
    expect(mixed.commandTypes).toEqual(['wall.delete']);
    expect(mixed.unsupported).toEqual([columnId]);
  });

  it('别层构件进 unsupported，不是"没选中"：本层没这个权力', () => {
    const upper = upperWalls[0]!;
    const upperOpening = house.doc.byKind('opening').find((o) => o.storeyId === house.upperStoreyId);
    if (upperOpening === undefined) throw new TypeError('样例房二层应当有洞口');
    const plan = planDelete(house.doc, house.lowerStoreyId, 'select', [upper.id, upperOpening.id]);
    expect(plan.outcome).toBe('unsupported');
    expect(plan.commands).toHaveLength(0); // 一发都不许发：删二层的墙不在本层的权力里
    expect(plan.candidateIds).toEqual([]);
    expect([...plan.unsupported].sort()).toEqual([upper.id, upperOpening.id].sort());
    // 素材自证：同一枚洞口换到它自己的层就发得出命令 ⇒ 上一发红在认层，不红在"洞口删不掉"
    const same = planDelete(house.doc, house.upperStoreyId, 'select', [upperOpening.id]);
    expect(same.outcome).toBe('ok');
    expect(same.commandTypes).toEqual(['opening.delete']);
  });

  it('删掉一面带洞口的墙：洞口与它的孤儿点一起消失，pruneSelection 把两者都剔掉', () => {
    const { log, storeyId } = oneWall();
    const wall = onlyWall(log);
    const openingId = openingAt(log, wall.id, 1000);
    const pointsBefore = log.document.byKind('point').length;
    const selected = [wall.id, openingId, wall.startId];
    const plan = planDelete(log.document, storeyId, 'select', [wall.id]);
    for (const command of plan.commands) log.dispatch(command);
    expect(log.document.get(wall.id)).toBeUndefined();
    expect(log.document.get(openingId)).toBeUndefined(); // 级联收的，不是 UI 发的
    // 这面墙的两枚端点都不再被引用 ⇒ wallDelete 一并收掉，点数回到建墙之前
    expect(log.document.byKind('point').length).toBe(pointsBefore - 2);
    expect(pruneSelection(log.document, storeyId, selected)).toEqual([]);
  });

  it('pruneSelection：别层的、已不存在的、楼层本身都剔掉，留下的按 id 升序', () => {
    // 两层都取样例房：合成文档里只有一层，"别层的构件"根本不存在，摘掉层过滤也红不出来（实测过）。
    const lower = lowerWalls[0]!;
    const upper = upperWalls[0]!;
    expect(pruneSelection(house.doc, house.lowerStoreyId, [lower.id, upper.id, 'gone'])).toEqual([lower.id]);
    // 点按它自己的 storeyId 筛（不是"一律放行"）：别层的点留在本层选中集里，
    // 下一发拖动就会拿二层的坐标去改一层的点。
    expect(requirePoint(house.doc, upper.startId, '别层端点').storeyId).toBe(house.upperStoreyId);
    expect(
      pruneSelection(house.doc, house.lowerStoreyId, [lower.startId, upper.startId, house.upperStoreyId]),
    ).toEqual([lower.startId]);
    // 反方向的同一发：二层的选中集里不许留一层的点
    expect(pruneSelection(house.doc, house.upperStoreyId, [lower.startId, upper.startId])).toEqual([
      upper.startId,
    ]);
    // 升序是判据的一部分：撤销一次再比"选中集没变"，Set 的插入序会漂，只有排过序才可比
    const many = house.doc.byKind('wall').filter((w) => w.storeyId === house.lowerStoreyId).slice(0, 4);
    const kept = pruneSelection(house.doc, house.lowerStoreyId, [...many].reverse().map((w) => w.id));
    expect(kept).toEqual([...kept].sort());
    expect(kept).toHaveLength(many.length);
    expect(kept).toEqual(many.map((w) => w.id).sort());
  });
});

describe('新建回执与探针', () => {
  it('lastCreatedWall：派发后拿得到；撤销后 affected 仍列着那枚 id，但答案必须是 null', () => {
    const { log, storeyId } = oneWall();
    const created = wallAt(log, storeyId, { x: 0, y: 1000 }, { x: 4000, y: 1000 });
    const read = lastCreatedWall(log.document, log.affected, storeyId);
    expect(read).toEqual({ wallId: created.id, storeyId, startId: created.startId, endId: created.endId });
    // S6 的那一枪：`undo()` 把 lastAffected 设成**前向**补丁的 id，所以 id 还在集合里，
    // 而文档里已经没有那面墙。少了 `doc.get(id)` 复核，屏幕上就是一个不存在的构件的把手。
    expect(log.undo()).toBe(true);
    expect(log.affected.has(created.id)).toBe(true);
    expect(log.document.get(created.id)).toBeUndefined();
    expect(lastCreatedWall(log.document, log.affected, storeyId)).toBeNull();
  });

  it('lastCreatedWall 认层：别层的墙不给本层的答案', () => {
    const upper = upperWalls[0]!;
    const ids = new Set([upper.id, upper.startId, upper.endId]);
    expect(lastCreatedWall(house.doc, ids, house.lowerStoreyId)).toBeNull();
    expect(lastCreatedWall(house.doc, ids, house.upperStoreyId)?.wallId).toBe(upper.id);
  });

  it('wallProbe 在样例房里给得出靶子，六道筛逐条自证，且两次问逐字相同', () => {
    const probe = wallProbe(house.doc, house.lowerStoreyId, ops, view);
    expect(probe).not.toBeNull();
    if (probe === null) throw new TypeError('探针给不出可画的空白落点');
    // ① 起点吸到既有端点，且复用那一枚
    const startDrop = dropTargetOf(view, probe.startPx, null, field);
    expect(startDrop.snap?.kind).toBe('endpoint');
    expect(startDrop.snap?.pointId).toBe(probe.startPointId);
    const startPoint = requirePoint(house.doc, probe.startPointId, '探针起点');
    expect(probe.startMm).toEqual({ x: startPoint.x, y: startPoint.y });
    // ② 终点不引别人的点（正交档命中是允许的，它不带 pointId）
    const endDrop = dropTargetOf(view, probe.endPx, probe.startMm, field, { excludeMm: probe.startMm });
    expect(endDrop.mm).toEqual(probe.endMm);
    expect(endDrop.snap?.pointId ?? null).toBeNull();
    // ③ 两道长度下限
    expect(probe.lengthMm).toBeGreaterThanOrEqual(MIN_WALL_LENGTH_MM);
    expect((probe.lengthMm - probe.defaults.thicknessMm) * view.pxPerMm).toBeGreaterThanOrEqual(
      MIN_PICK_EDGE_PX,
    );
    // ④ 落点与中点两发像素一个候选都不命中
    expect(pickAt(ops, probe.endPx)).toEqual([]);
    expect(pickAt(ops, probe.midPx)).toEqual([]);
    // ⑤ 三发像素全在画布内（留 2px 边）：越界的那一发 `sendInputEvent` 发不出去
    for (const px of [probe.startPx, probe.endPx, probe.midPx]) {
      expect(px.x).toBeGreaterThanOrEqual(2);
      expect(px.y).toBeGreaterThanOrEqual(2);
      expect(px.x).toBeLessThan(view.widthPx - 2);
      expect(px.y).toBeLessThan(view.heightPx - 2);
    }
    // 像素是整数（`sendInputEvent` 只收整数 DIP），毫米由像素反算 ⇒ 不动点
    expect(Number.isInteger(probe.endPx.x) && Number.isInteger(probe.endPx.y)).toBe(true);
    expect(moveTargetOf(view, probe.endPx)).toEqual(probe.endMm);
    // 确定性：同一个靶子两次问必须一模一样（"撤销后回到原值"那类判据的前提）
    expect(wallProbe(house.doc, house.lowerStoreyId, ops, view)).toEqual(probe);
    // 建出来真的点得中：这一发证明筛 ③ 够用，删除那一步能在真窗口里点名
    const log = new TransactionLog(house.doc);
    const command = draftCommand(
      {
        storeyId: house.lowerStoreyId,
        start: { mm: probe.startMm, px: probe.startPx, snap: startDrop.snap },
        cursorPx: probe.endPx,
        end: endDrop,
        legal: true,
      },
      probe.defaults,
    );
    if (command === null) throw new TypeError('legal 为真却拿不到命令');
    log.dispatch(command);
    const created = lastCreatedWall(log.document, log.affected, house.lowerStoreyId);
    if (created === null) throw new TypeError('affected 里没有那面墙');
    const after = buildDrawList(log.document, house.lowerStoreyId, view, EMPTY_SELECTION);
    const named = pickPxOf(after, created.wallId);
    expect(named).not.toBeNull(); // 筛 ③/④ 的全部目的：删除那一步点得出这面墙
    if (named !== null) expect(pickAt(after, named).map((h) => h.ownerId)).toEqual([created.wallId]);
  });

  it('探针靶子的配平账：ops 空表（筛 ④ 失效）时建出来恰好多一枚点、删回去账回到原样', () => {
    // 空指令表 = "屏幕上什么都没有" ⇒ 筛 ④ 一枚都不拒，这一发只剩"起点复用、终点新建"这条账可判。
    // 终点若复用了既有点，删掉这面墙时那枚点仍被别人引用 ⇒ 留下 ⇒ 点数回不到原样。
    // 闸门那一步"删掉新建的墙"的配平判据就是这句话。
    //
    // **这一发在摘掉筛 ② 时不红**（E14 实测）：样例房的第一发候选终点本来就不是既有点，
    // 拦不拦都一样。② 自己的牙齿在下一条合成夹具那儿 —— 两条别合并，它们钉的是两件事。
    const probe = wallProbe(house.doc, house.lowerStoreyId, [], view);
    expect(probe).not.toBeNull();
    if (probe === null) throw new TypeError('空表下探针该给得出靶子');
    const startDrop = dropTargetOf(view, probe.startPx, null, field);
    const endDrop = dropTargetOf(view, probe.endPx, probe.startMm, field, { excludeMm: probe.startMm });
    expect(endDrop.snap?.pointId ?? null).toBeNull();
    const command = draftCommand(
      {
        storeyId: house.lowerStoreyId,
        start: { mm: probe.startMm, px: probe.startPx, snap: startDrop.snap },
        cursorPx: probe.endPx,
        end: endDrop,
        legal: true,
      },
      probe.defaults,
    );
    if (command === null) throw new TypeError('legal 为真却拿不到命令');
    const log = new TransactionLog(house.doc);
    const before = log.document.byKind('point').length;
    log.dispatch(command);
    const created = lastCreatedWall(log.document, log.affected, house.lowerStoreyId);
    if (created === null) throw new TypeError('affected 里没有那面墙');
    expect(log.document.byKind('point').length).toBe(before + 1); // 起点复用、终点新建
    log.dispatch(wallDelete({ wallId: created.wallId }));
    expect(log.document.byKind('point').length).toBe(before); // 孤儿点被收走，账配平
  });

  it('筛 ② 有牙齿：画布夹住的靶场里，唯一活着的候选引的是别人的点', () => {
    // **靶场视口**：300×300px @0.1px/mm ⇒ 画布只夹住 mm x ∈ (−1500, 1500)、y ∈ (−500, 2500)。
    // 两面墙各从画布内的一枚端点往 x=−6000 长出去 ⇒ 画布外那两枚端点当起点全被筛 ⑤ 拒掉，
    // 剩下 (0,0) 与 (0,2000) **互为对方唯一落在画布内的候选** —— 而那一枚终点是别人的点。
    // 摘掉筛 ②（E14）探针就把这一发交出来 ⇒ 本条恒红在最后那句"必须给 null"。
    //
    // 为什么这一格必须靠画布夹住、而不是"把样例房的那一发换个干净落点"：终点复用既有点 ⇒
    // 那一枚像素必然压在那面墙的轮廓上 ⇒ 筛 ④ 顺手就拒；就算 `ops` 给空表绕过 ④，共线重叠的
    // 墙又派生不出来 ⇒ 筛 ⑥ 也拒。也就是说 **④ 与 ⑥ 天生罩住 ②**（2026-09-28 实测：加了 ⑤⑥
    // 之后 E14 连跑八次 30/0，一条都不红）。这一格把 `ops` 给空表、再用画布把活着的候选逼到
    // 只剩一发，② 才重新有自己说话的地方 —— **判据不许因为"反正后面有人拦"就删掉前面的筛**：
    // ⑥ 每发要做一次整层派生，② 是一次比较，屏幕上拖一次光标要问十几发。
    const tv = viewportOf(300, 300, { pxPerMm: 0.1, center: vec(0, 1000) });
    const { log, storeyId } = synthStorey();
    wallAt(log, storeyId, { x: 0, y: 0 }, { x: -6000, y: 0 });
    wallAt(log, storeyId, { x: 0, y: 2000 }, { x: -6000, y: 2000 });
    const doc = log.document;
    const fd = snapFieldOf(doc, storeyId);
    // 素材自证 ①：那一发引的确实是既有点 —— 否则"给 null"是"场里什么都没有"造成的，与 ② 无关
    const candPx = pxOf({ x: 0, y: 2000 }, tv);
    const cand = dropTargetOf(tv, candPx, { x: 0, y: 0 }, fd, { excludeMm: { x: 0, y: 0 } });
    expect(cand.snap?.pointId ?? null).not.toBeNull();
    // 素材自证 ②：三发像素全在画布内（筛 ⑤ 放行）、两道长度下限都过（筛 ③ 放行）
    for (const p of [pxOf({ x: 0, y: 0 }, tv), candPx, pxOf({ x: 0, y: 1000 }, tv)]) {
      expect(p.x).toBeGreaterThanOrEqual(2);
      expect(p.y).toBeGreaterThanOrEqual(2);
      expect(p.x).toBeLessThan(tv.widthPx - 2);
      expect(p.y).toBeLessThan(tv.heightPx - 2);
    }
    expect(2000).toBeGreaterThanOrEqual(MIN_WALL_LENGTH_MM);
    // 素材自证 ③：命令层建得成、派生层也画得出 ⇒ 前五道筛加两个试跑都不拒它
    const startDrop = dropTargetOf(tv, pxOf({ x: 0, y: 0 }, tv), null, fd);
    const defaults = newWallDefaults(doc, storeyId);
    const trial = new TransactionLog(doc);
    trial.dispatch(
      wallCreate({
        storeyId,
        start: { pointId: startDrop.snap?.pointId ?? 'x' },
        end: { pointId: cand.snap?.pointId ?? 'x' },
        thicknessMm: defaults.thicknessMm,
        heightMm: defaults.heightMm,
      }),
    );
    expect(() => buildDrawList(trial.document, storeyId, tv)).not.toThrow();
    // 判据：六道筛齐全 ⇒ 这一格探针给 null
    expect(wallProbe(doc, storeyId, [], tv)).toBeNull();
    // 反面自证：同一份文档把画布松开（`sv` 夹住 x ∈ (−3000, 7000)）靶子就出现了
    // ⇒ 上面那发红在"越界把候选挤到只剩引点那一发"，不红在文档本身没有可画的落点
    expect(wallProbe(doc, storeyId, [], sv)).not.toBeNull();
  });

  it('筛 ④ 有牙齿：画布夹住的靶场里，唯一活着的候选中点压在横墙上', () => {
    // 同一块画布：竖着的候选 (0,0)→(0,2000) 落点**空**、中点 (0,1000) 正压在横墙 (−6000,1000)→(6000,1000)
    // 的轮廓里 ⇒ 只有筛 ④ 拒它（终点没引任何点 ⇒ ②放行；建得成也画得出 ⇒ 命令层与 ⑥ 放行；
    // 三发像素全在画布内 ⇒ ⑤ 放行）。摘掉筛 ④（E15）探针把这一发交出来 ⇒ 恒红在最后那句。
    // 起点只有 (0,0) 一枚在画布内（其余端点全在 x=±6000 之外）⇒ 与 uuidv7 的排位无关。
    const tv = viewportOf(300, 300, { pxPerMm: 0.1, center: vec(0, 1000) });
    const { log, storeyId } = synthStorey();
    wallAt(log, storeyId, { x: 0, y: 0 }, { x: -6000, y: 0 });
    wallAt(log, storeyId, { x: -6000, y: 1000 }, { x: 6000, y: 1000 });
    const doc = log.document;
    const tvOps = buildDrawList(doc, storeyId, tv, EMPTY_SELECTION);
    const fd = snapFieldOf(doc, storeyId);
    // 素材自证 ①：中点确实压在横墙上（这一句就是 ④ 要拒的东西）
    expect(pickAt(tvOps, pxOf({ x: 0, y: 1000 }, tv))).not.toEqual([]);
    // 素材自证 ②：落点自己是空白的，且不带别人的点 ⇒ ④ 之外没有第二道筛替它说话
    const candPx = pxOf({ x: 0, y: 2000 }, tv);
    expect(pickAt(tvOps, candPx)).toEqual([]);
    const cand = dropTargetOf(tv, candPx, { x: 0, y: 0 }, fd, { excludeMm: { x: 0, y: 0 } });
    expect(cand.snap?.pointId ?? null).toBeNull();
    // 素材自证 ③：命令层与派生层都放行（新点落在横墙内侧是 S1 允许的几何，闸门只要求点得中）
    const defaults = newWallDefaults(doc, storeyId);
    const trial = new TransactionLog(doc);
    trial.dispatch(
      wallCreate({
        storeyId,
        start: { pointId: fd.points.find((p) => p.mm.x === 0 && p.mm.y === 0)?.pointId ?? 'x' },
        end: { x: cand.mm.x, y: cand.mm.y },
        thicknessMm: defaults.thicknessMm,
        heightMm: defaults.heightMm,
      }),
    );
    expect(() => buildDrawList(trial.document, storeyId, tv)).not.toThrow();
    // 判据：六道筛齐全 ⇒ 探针给 null；松开画布（靶子换到别发候选）就有了 ⇒ 不红在空场
    expect(wallProbe(doc, storeyId, tvOps, tv)).toBeNull();
    const svOps = buildDrawList(doc, storeyId, sv, EMPTY_SELECTION);
    expect(wallProbe(doc, storeyId, svOps, sv)).not.toBeNull();
  });

  it('探针只给整数像素：换一把"整数毫米落在分数像素上"的尺子仍然成立', () => {
    // 样例房在 0.125px/mm 下所有靶子恰好落在整数像素上，那份视图证不了 `intPx` 这句话。
    // 高度改成 901 ⇒ pxPerMm 变成 781/6240，同样的毫米乘出来带小数，取整这一步才有对象。
    const v = fitStorey(house.doc, house.lowerStoreyId, 1200, 901, 60);
    expect(v.pxPerMm).not.toBe(0.125);
    // 素材自证：这把尺子下"毫米的原始像素"确实带小数 —— 不然这一发与上一发是同一件事，
    // `intPx` 依然没有对象（0.125px/mm + 全是 100 的倍数的坐标，取整恒等，红不出来）。
    const witness = mmToPx(v, vec(0, 0));
    expect(Number.isInteger(witness.x) && Number.isInteger(witness.y)).toBe(false);
    const oddOps = buildDrawList(house.doc, house.lowerStoreyId, v, EMPTY_SELECTION);
    const probe = wallProbe(house.doc, house.lowerStoreyId, oddOps, v);
    expect(probe).not.toBeNull();
    if (probe === null) throw new TypeError('换尺子后探针给不出靶子');
    for (const px of [probe.startPx, probe.endPx, probe.midPx]) {
      expect(Number.isInteger(px.x) && Number.isInteger(px.y)).toBe(true);
    }
    // 取整之后仍然自洽：落点是**那一发整数像素**过一遍屏幕通路的结果 ⇒ 闸门发得出、renderer 落得回
    const endDrop = dropTargetOf(v, probe.endPx, probe.startMm, field, { excludeMm: probe.startMm });
    expect(endDrop.mm).toEqual(probe.endMm);
    const startDrop = dropTargetOf(v, probe.startPx, null, field);
    expect(startDrop.mm).toEqual(probe.startMm);
    expect(startDrop.snap?.pointId).toBe(probe.startPointId);
  });

  it('极度缩小下探针给 null，稍大一档就给得出：说话的是那道像素下限', () => {
    // 两发的差别只有比例。0.02px/mm ⇒ 候选 2000mm = 40px：中点离既有墙角 20px（筛 ④ 放行），
    // 而 `(2000-240)*0.02 = 35.2 < 64` 被像素下限拒掉 ⇒ null。0.04px/mm 同一批候选 = 80px，
    // `(2000-240)*0.04 = 70.4 ≥ 64` 过筛 ⇒ 给得出。
    // 为什么比例要挑在中间：太小（0.005）时中点也挤进 8px 命中圈，改坏"摘掉像素下限"会被
    // 筛 ④ 顺手补上，这一发就退化成"④ 的第二个用例"；太大则两道筛都不说话。
    const tiny = viewportOf(1000, 800, { pxPerMm: 0.02, center: vec(4000, 3000) });
    const big = viewportOf(1000, 800, { pxPerMm: 0.04, center: vec(4000, 3000) });
    const tinyOps = buildDrawList(house.doc, house.lowerStoreyId, tiny, EMPTY_SELECTION);
    const bigOps = buildDrawList(house.doc, house.lowerStoreyId, big, EMPTY_SELECTION);
    expect(wallProbe(house.doc, house.lowerStoreyId, tinyOps, tiny)).toBeNull();
    const okProbe = wallProbe(house.doc, house.lowerStoreyId, bigOps, big);
    expect(okProbe).not.toBeNull();
    if (okProbe === null) throw new TypeError('0.04px/mm 下探针该给得出靶子');
    expect((okProbe.lengthMm - okProbe.defaults.thicknessMm) * big.pxPerMm).toBeGreaterThanOrEqual(
      MIN_PICK_EDGE_PX,
    );
    // 毫米下限在这一发里是**旁观者**：候选偏移恒 ≥2000mm，这条 500 对它永远不生效。
    // 所以 `MIN_WALL_LENGTH_MM` 只保护探针挑靶子，不保护用户那一发（那一发的下限是真源的墙厚）。
    expect(okProbe.lengthMm).toBeGreaterThan(MIN_WALL_LENGTH_MM);
  });

  it('筛 ⑤ 有牙齿：整层挪出画布后探针没靶子，回到拟合视图靶子就出现', () => {
    // 样例房在没有这条筛时挑中的是 (0,0)→(-2000,0)：毫米合法、`pickAt` 空、两道长度下限都过，
    // 但 `endPx = (-150, 825)`、`midPx = (-25, 825)` 在画布**左边界之外**（2026-09-28 实测）。
    // 这一发判的不是"样例房挑哪一发"（那随 uuidv7 变），而是"挑出来的三发必须发得出 DIP"。
    const off = viewportOf(1200, 900, { pxPerMm: view.pxPerMm, center: vec(30000, 30000) });
    // 素材自证：这一发的原点确实在画布外 —— 否则那句 null 是别的东西造成的（尺寸、比例、空场…）
    expect(mmToPx(off, vec(0, 0)).x).toBeLessThan(2);
    expect(snapFieldOf(house.doc, house.lowerStoreyId).points.length).toBeGreaterThan(0);
    const offOps = buildDrawList(house.doc, house.lowerStoreyId, off, EMPTY_SELECTION);
    expect(wallProbe(house.doc, house.lowerStoreyId, offOps, off)).toBeNull();
    // 同一份文档回到拟合视图 ⇒ 靶子出现：证上面那发红在"越界"，不红在文档或比例
    expect(wallProbe(house.doc, house.lowerStoreyId, ops, view)).not.toBeNull();
  });

  it('⑥ 的前提：同一发候选命令层放行、派生层抛（星形接头）', () => {
    // 角点 (0,0) 已经过着两条线（x 轴与 y 轴）。第三发 45° 斜线过同一点 ⇒ core 的 `deriveJoints`
    // 判它星形接头 ⇒ `buildDrawList` 抛「S1 不支持」。这一发**过了 ①~⑤ 也过了命令层**，
    // 所以本条判的是"⑥ 为什么必须存在"；⑥ 真正的牙齿在上一条样例房用例里
    // （摘掉 ⑥ 那次实测八个进程：「六道筛逐条自证」七次红、一次绿，红在建完再派生那一句 —— 本条不跟着红，
    // 因为它判的是候选本身，不判探针挑了谁）。
    const { log, storeyId } = synthStorey();
    const east = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    wallAt(log, storeyId, { pointId: east.startId }, { x: 0, y: 4000 });
    const fd = snapFieldOf(log.document, storeyId);
    const startMm: MoveTarget = { x: 0, y: 0 };
    const startOps = buildDrawList(log.document, storeyId, sv, EMPTY_SELECTION);
    const endPx = pxOf({ x: 2000, y: 2000 }, sv);
    const start = draftAtPress(sv, pxOf(startMm, sv), fd);
    const end = dropTargetOf(sv, endPx, startMm, fd, { excludeMm: startMm });
    const draft: DraftWall = { storeyId, start, cursorPx: endPx, end, legal: true };
    // ①③④⑤ 逐条自证：这一发确实"前五条全过"，于是它红的时候只可能是 ⑥ 干的
    expect(start.snap?.kind).toBe('endpoint');
    expect(end.snap?.pointId ?? null).toBeNull();
    expect(end.mm).toEqual({ x: 2000, y: 2000 });
    expect(pickAt(startOps, endPx)).toEqual([]);
    expect(endPx.x).toBeGreaterThanOrEqual(2);
    expect(endPx.y).toBeGreaterThanOrEqual(2);
    expect(endPx.x).toBeLessThan(sv.widthPx - 2);
    expect(endPx.y).toBeLessThan(sv.heightPx - 2);
    expect(Math.hypot(end.mm.x - startMm.x, end.mm.y - startMm.y)).toBeGreaterThan(MIN_WALL_LENGTH_MM);
    expect(legalWallCreate(log.document, draft)).toBe(true);
    // 派生层：同一发命令建进去，整层就画不出来了
    const command = draftCommand(draft, newWallDefaults(log.document, storeyId));
    if (command === null) throw new TypeError('legal 为真却拿不到命令');
    const trial = new TransactionLog(log.document);
    trial.dispatch(command);
    expect(() => buildDrawList(trial.document, storeyId, sv)).toThrow(/S1 不支持/);
    // ⑥ 在这一发夹具上**不承重**：摘掉它，探针换的还是别发轴向候选，本条不红（实测 E28 只红
    // 「六道筛逐条自证」那一条，且八进程里七次）。留着它是为了证"探针给的每一发都画得出"这句判据本身写得对。
    const probe = wallProbe(log.document, storeyId, startOps, sv);
    if (probe === null) throw new TypeError('这个夹具上探针该给得出别发候选（四条轴向外侧）');
    const t2 = new TransactionLog(log.document);
    t2.dispatch(
      wallCreate({
        storeyId,
        start: { pointId: probe.startPointId },
        end: { x: probe.endMm.x, y: probe.endMm.y },
        thicknessMm: probe.defaults.thicknessMm,
        heightMm: probe.defaults.heightMm,
      }),
    );
    expect(() => buildDrawList(t2.document, storeyId, sv)).not.toThrow();
  });

  it('wallProbe 在空层给 null（不抛），有了靶子才给得出', () => {
    const { log, storeyId } = synthStorey();
    const emptyField = snapFieldOf(log.document, storeyId);
    const emptyOps = buildDrawList(log.document, storeyId, sv, EMPTY_SELECTION);
    expect(wallProbe(log.document, storeyId, emptyOps, sv)).toBeNull();
    // 素材自证：空表确实空 —— 否则"给 null"可以是任何实现的功劳
    expect(emptyField.points).toEqual([]);
    expect(emptyField.axes).toEqual([]);
    // 建一面墙后靶子出现了：证上一发红在"没有端点可吸"，不是红在视口或筛写反
    wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const afterOps = buildDrawList(log.document, storeyId, sv, EMPTY_SELECTION);
    expect(wallProbe(log.document, storeyId, afterOps, sv)).not.toBeNull();
  });

  it('属性：legal 与"真 build 会不会抛"逐字同口径（试跑不是第二套判据）', () => {
    const { log, storeyId, field: fd } = oneWall();
    const base = pressAtOrigin(fd, storeyId);
    const defaults = newWallDefaults(log.document, storeyId);
    const wallsBefore = log.document.byKind('wall').length;
    fc.assert(
      fc.property(mmInt, mmInt, (x, y) => {
        const draft = moveDraft(log.document, base, sv, pxOf({ x, y }, sv), fd);
        // 预言与真命令吃同一对入参：这里的 `ok` 就是 `legalWallCreate` 该给的答案
        const refs = draftRefs(draft);
        let ok = true;
        try {
          wallCreate({
            storeyId,
            start: refs.start,
            end: refs.end,
            thicknessMm: defaults.thicknessMm,
            heightMm: defaults.heightMm,
          }).build(log.document);
        } catch {
          ok = false;
        }
        expect(draft.legal).toBe(ok);
        const command = draftCommand(draft, defaults);
        if (command === null) {
          expect(ok).toBe(false); // 只有 legal 为假才许给 null
          return;
        }
        expect(ok).toBe(true);
        const fresh = new TransactionLog(log.document);
        expect(() => fresh.dispatch(command)).not.toThrow();
        expect(fresh.document.byKind('wall').length).toBe(wallsBefore + 1);
      }),
      { numRuns: 250 },
    );
  });
});
```

> **四处"注释即判据"的地方，抄的时候别省**：
>
> ① 「试跑不动真源」那条钉的是**三票**（墙数、撤销栈深度、`log.affected`），不是一票。`legalWallCreate` 走的是真 `wallCreate(...).build(doc)`，它不动真源靠的是 `build` 的纯函数性质 —— 但只要有人在试跑里顺手 `log.dispatch(command)`、或者把 `doc` 换成 `log`，"墙数没变"这一票照样绿。三票同问才分得开"什么都没发生"与"发生了一次没人看见的派发"。
>
> ② `pruneSelection` 的两条用例（「删掉一面带洞口的墙：洞口与它的孤儿点一起消失」与「别层的、已不存在的、楼层本身都剔掉」）钉的是 S5 后半句：**剪枝不预测补丁内容**。屏幕上不去猜"级联会收走哪些 id"，删完之后拿真源问一遍 `doc.get(id)`。E7（不查存在性）红在这两条，E5/E6（摘掉层过滤 / 不排序）红在后一条 —— 层过滤和升序是"同一份答案给两次问要逐字相同"的最低要求，与存在性是三条独立判据，所以三条改坏各红各的。
>
> ③ 「探针靶子的配平账」与「筛 ② 有牙齿」是**两条**，不是一条的两半。前者用样例房 + 空指令表钉"建出来恰好多一枚点、删回去账回到原样"，后者用合成夹具钉"候选落点正是既有点时必须换下一个"。**前者在摘掉筛 ② 时不红**（样例房的第一发候选终点本来就不是既有点，E14 实测只红后一条），它的牙齿在 E25（`draftRefs` 不复用）那儿 —— 两条不许合并，合并之后两条判据都失去各自的见证。
>
> ④ 「筛 ⑤ 有牙齿」与「⑥ 的前提」各管一道**后来才长出来的**筛，而且两道的成因都写在注释里，不许读成"防御性代码"：⑤ 是因为样例房的探针在没有它时挑中 `(0,0) → (-2000,0)`，毫米合法、`pickAt` 空、两道长度下限全过，可 `endPx = (-150, 825)` 在画布左边界**之外**（实测），真窗口里那一发的现象是"按了没反应"、抛错却落在十几步之后；⑥ 是因为补上 ⑤ 之后探针改挑 `(0,0) → (2000,2000)` 那发 45°，而 `(0,0)` 已过着两条线 ⇒ 建完墙 `buildDrawList` 当场抛「S1 不支持」。**两条用例的形状因此不同**：⑤ 判"挑出来的三发必须发得出 DIP"（同一份文档在越界视图给 null、回拟合视图给得出，两问夹住原因）；⑥ 判"命令层放行、派生层抛"这个**前提**成立（同一发候选逐条自证过 ①③④⑤，只在派生层炸）。⑥ 真正的牙齿在样例房那条自证用例上，而它八进程只红七次 —— 这条不承重的事实登记在 C 段第 28 行，并转交 Task 8 配确定性夹具。

Run: `npx vitest run packages/scene-2d/test/editing.test.ts > /tmp/t6s4-red.log 2>&1; echo exit=$?`
Expected: exit≠0，**`Tests 30 failed (30)`**、`Test Files 1 failed (1)`。红在**函数不存在**上，不在断言上 —— 实测（2026-09-28：把 `src/index.ts` 的 `export * from './editing'` 摘掉、`editing.ts` 移走）给出的失败原因是 `TypeError`，按出口分摊：`draftAtPress is not a function` ×11、`wallProbe` ×6、`planDelete` ×6、`newWallDefaults` ×2、`lastCreatedWall` ×2、`pruneSelection` ×1，外加 1 次「expected value must be number or bigint, received "undefined"」（属性用例里那发算术）。

> **为什么不是"红在解析/导出缺失"**：vitest 走 SSR 转译，`export *` 里缺的名字不会在链接期抛 `SyntaxError: does not provide an export named …`，它会变成 `undefined`，到**调用那一行**才炸（上面那条实测的失败原因就是按出口分摊的 `TypeError`）。同样的订正已经就地落进 **Task 2 Step 3、Task 4 Step 2、Task 6 Step 1** 各自的 Expected —— 这段说明留在这里，是因为它本身就是判据：两种红分不开（红的是既有函数、或红在断言值上）才是真问题，多半是 import 列表把某个新名字写成了既有名字，先核对再进 B 段。

**B. 写 `packages/scene-2d/src/editing.ts`，并给 `index.ts` 加一行出口**

`index.ts` 末尾追加 `export * from './editing';`（放在 `'./snapping'` 之后 —— 依赖方向是 `editing → snapping → pick → viewport`，反过来会成环）。

`editing.ts` 整份新建，依赖只有四行：`@dajia/core`、`./viewport`、`./pick`（`MIN_PICK_EDGE_PX` 与 `pickAt`）、`./snapping`，加一条 `./drawlist` 的类型（筛 ⑥ 要 `buildDrawList` 真跑一遍派生）。**它不 import `./handles`**，方向是 `handles → snapping`（Step 5），拉墙这件事与拖把手互不知道。

```ts
import {
  length,
  openingDelete,
  quantizeMm,
  requireStorey,
  sub,
  TransactionLog,
  vec,
  wallCreate,
  wallDelete,
  type Command,
  type Document,
  type EntityId,
  type PointRef,
} from '@dajia/core';
import { mmToPx, type Px, type Viewport } from './viewport';
import { MIN_PICK_EDGE_PX, pickAt } from './pick';
import { buildDrawList, type DrawOp } from './drawlist';
import {
  dropTargetOf,
  pointRefOf,
  snapFieldOf,
  type DropTarget,
  type MoveTarget,
  type SnapField,
  type SnapResult,
} from './snapping';

/**
 * 屏幕上"这一发该不该发命令"的那一层（Task 6）。三个模块各管一问，互不越界：
 * `snapping.ts` = 这一发光标落在**哪儿**；`handles.ts` = 这一发**接得到**哪枚既有的点；
 * 本文件 = 接住了之后**要不要发**这条命令、发出去把谁拿回来、删的时候发几条。
 *
 * 为什么新建与删除放在同一个文件：两者共用同一套判据（真命令试跑、`affected` 的事后复核、
 * 选中的事后剪枝）。拆成两个文件就是各写一份 —— 漂掉的永远是没人看的那一份
 * （`commands/opening.ts` 顶部"命令层绝不复述区间规则"同一条理由）。
 */

/** 交互模式。`wall` = 正在拉新墙，此时删除键什么都不发（见 `planDelete`）。 */
export type Tool = 'select' | 'wall';

/** 新墙的默认墙厚。真源里没有"上一层用多厚"可读，这是产品给的起点；Task 8 的数值输入替换它。 */
export const NEW_WALL_THICKNESS_MM = 240;

/**
 * 新墙的最小长度（毫米）—— **只作用于 `wallProbe` 挑靶子**，别把它读成"用户那一发也有这道闸"：
 * 屏幕上真正拦得住长度的只有真源那两条（零长、墙厚不小于墙长，见 `wallCreate`），一面 300mm
 * 的短墙在真源里完全合法，本任务不假装屏幕上有第三道闸。
 *
 * 为什么探针还需要这条：像素那一道下限量的是**轮廓长边**（`lengthMm - thicknessMm` 对 64px），
 * 放大越多它换算回毫米越小 —— 2px/mm 时一面 272mm 长的墙（长边只剩 32mm）就够 64px 了，
 * 而真源只不许 `thicknessMm >= lengthMm`，所以 240mm 到 500mm 之间那段墙全都合法、又短得没法施工。
 * 这道毫米筛把靶子钉在 500mm 以上，与放大倍率无关。Task 8 的"数值输入 + 最小墙长"才把这条下限
 * 搬到交互路径上。
 */
export const MIN_WALL_LENGTH_MM = 500;

export interface NewWallDefaults {
  readonly thicknessMm: number;
  readonly heightMm: number;
}

/**
 * 新墙的墙厚 / 墙高。**Task 8 的"数值输入"要替换掉的唯一占位入口** —— 届时只改这一个函数，
 * `draftCommand` 与 `legalWallCreate` 的调用点一行不动（它们只吃 `NewWallDefaults`）。
 *
 * 层高读真源（`requireStorey`）而不是抄常量：把新墙画在 3600 的层上却给 3000 的墙高，
 * 2D 屏幕上看不出来，到了 3D 与施工图上是一面够不到顶的墙。墙厚没有真源可读，才留常量。
 */
export function newWallDefaults(doc: Document, storeyId: string): NewWallDefaults {
  return {
    thicknessMm: NEW_WALL_THICKNESS_MM,
    heightMm: requireStorey(doc, storeyId).heightMm,
  };
}

/**
 * 草稿的起点 = 按下那一发的答案。带着完整的 `SnapResult`（而不是拆成 `pointId` + `kind`）：
 * `pointRefOf` 吃的就是这一份，拆开再拼回去等于把"复用哪枚点"这条判据抄两遍。
 */
export interface DraftPoint {
  readonly mm: MoveTarget;
  /** 按下那一发的**光标像素**（不是吸附点：起点标记画在哪儿由它决定）。 */
  readonly px: Px;
  readonly snap: SnapResult | null;
}

/** 一次拉墙的完整现场。不可变：`moveDraft` 每次返回新对象，renderer 比引用就能决定重绘。 */
export interface DraftWall {
  readonly storeyId: string;
  readonly start: DraftPoint;
  /** 裸光标：临时线**恒**画到这里（S4 第三条纪律），不是吸附点。 */
  readonly cursorPx: Px;
  readonly end: DropTarget;
  /** 真命令试跑的结论。false ⇒ 松手不发命令。 */
  readonly legal: boolean;
}

/**
 * 按下那一发的起点。锚点给 **null** ⇒ 只有靶子档参与：按下时还没有"从哪儿出发"这回事，
 * 给它锚点等于"点下去就自动变正交"，那是抢方向盘（S3 的措辞）。
 */
export function draftAtPress(v: Viewport, px: Px, field: SnapField): DraftPoint {
  const drop = dropTargetOf(v, px, null, field);
  return { mm: drop.mm, px, snap: drop.snap };
}

/** 草稿的两个端点 → 命令入参。吸到既有点就复用，否则才新建（`pointRefOf` 是唯一的判据）。 */
export function draftRefs(draft: DraftWall): { readonly start: PointRef; readonly end: PointRef } {
  return { start: pointRefOf(draft.start.mm, draft.start.snap), end: pointRefOf(draft.end.mm, draft.end.snap) };
}

/**
 * 移动那一发：终点**以起点为锚**（"水平 / 竖直 / 15°"只有相对起点才成立），并且排掉起点的坐标
 * —— 不排的话光标压在起点上会吸回自己（端点档 + 该点轴线上的垂足档），屏幕上表现为"拖不开"，
 * 真源里是零长墙被 `wallCreate` 拒掉，用户以为松手键坏了。
 *
 * `doc` 每次现问，不缓存进草稿：草稿活着的那几十秒里可能来一发撤销，那一份 `legal` 就成了谎话。
 */
export function moveDraft(
  doc: Document,
  draft: DraftWall,
  v: Viewport,
  cursorPx: Px,
  field: SnapField,
): DraftWall {
  const end = dropTargetOf(v, cursorPx, draft.start.mm, field, { excludeMm: draft.start.mm });
  const next: DraftWall = { ...draft, cursorPx, end, legal: false };
  return { ...next, legal: legalWallCreate(doc, next) };
}

/**
 * 合法性 = 拿**真命令**试跑一次（`legalDrop` 的同一条理由：绝不在屏幕上重写一遍守卫）。
 * `wallCreate` 的守卫有零长、墙厚不小于墙长、墙高为正、楼层存在、跨层复用点等五道，
 * 抄一道漏四道。构造期与 `build` 两道都会抛，所以整段在 try 里。
 */
export function legalWallCreate(doc: Document, draft: DraftWall): boolean {
  try {
    buildCreate(doc, draft, newWallDefaults(doc, draft.storeyId));
    return true;
  } catch {
    return false;
  }
}

function buildCreate(doc: Document, draft: DraftWall, defaults: NewWallDefaults) {
  const refs = draftRefs(draft);
  return wallCreate({
    storeyId: draft.storeyId,
    start: refs.start,
    end: refs.end,
    thicknessMm: defaults.thicknessMm,
    heightMm: defaults.heightMm,
  }).build(doc);
}

/**
 * 草稿 → 命令。**只认 `legal` 一色**：false 就是不发（null），true 时 `wallCreate` 的构造期
 * 判据必然也过（同一对入参、同一套守卫，`legalWallCreate` 已经跑过一遍）。
 * 所以这里不 catch —— 真抛出来说明 `legal` 与入参之间漂了，那是程序错误，该红不该被咽下去。
 */
export function draftCommand(draft: DraftWall, defaults: NewWallDefaults): Command | null {
  if (!draft.legal) return null;
  const refs = draftRefs(draft);
  return wallCreate({
    storeyId: draft.storeyId,
    start: refs.start,
    end: refs.end,
    thicknessMm: defaults.thicknessMm,
    heightMm: defaults.heightMm,
  });
}

/**
 * 删除的计划。四条出口，各有各的判据，**不许合并成"成功 / 失败"两色**：
 * 'empty' 与 'ignored-in-wall-mode' 都发 0 条命令，但前者该提示"没选中东西"、
 * 后者该什么都不做（拉墙时误触 Delete 不该清空选中集）—— 合并了屏幕上就分不开。
 */
export type DeleteOutcome = 'ok' | 'empty' | 'ignored-in-wall-mode' | 'unsupported';

export interface DeletePlan {
  readonly outcome: DeleteOutcome;
  /** 派发顺序 = 数组顺序：先洞口后墙（S5）。 */
  readonly commands: readonly Command[];
  /** `commands` 的 `type` 抄一份：探针与日志判"发了哪几条"用它，不用反射。 */
  readonly commandTypes: readonly string[];
  /** 真的发出命令的那些 id，与 `commands` 同序（洞口在前、墙在后，各自按 id 升序）。 */
  readonly candidateIds: readonly EntityId[];
  /** 本次不删、留给后续任务的 id（柱 / 板 / 楼层，以及别层构件）。 */
  readonly unsupported: readonly EntityId[];
}

/**
 * 选中集 → 删除命令。**两条规则，一条都不复述真源已经做的事**：
 * ① 选中的墙 → `wall.delete`（它自己会级联收掉宿主是它的洞口、自己判端点还剩谁引用）；
 * ② 选中的洞口且**宿主墙不在本次删除集里** → `opening.delete`。
 *
 * 为什么反过来（先给每个选中洞口发 `opening.delete`、再删墙）也不行：那是对真源已有级联的
 * 复述，复述的规则一定会漂；而先删墙之后那些洞口已经不存在，第二条命令 `requireOpening`
 * 直接抛，`dispatchBatch` 就在半途留下半套状态。
 *
 * 顺序排成"洞口在前"是为了撤销的可读性：栈顶是 `wall.delete`，一次 Ctrl+Z 把"墙 + 它自己
 * 级联掉的洞口"整组还原，而不是先还回一樘无主的洞口。
 */
export function planDelete(
  doc: Document,
  storeyId: string,
  tool: Tool,
  ids: Iterable<EntityId>,
): DeletePlan {
  const all = [...ids];
  if (tool === 'wall') {
    return { outcome: 'ignored-in-wall-mode', commands: [], commandTypes: [], candidateIds: [], unsupported: [] };
  }
  // 先分两堆：要删的墙、要单独删的洞口。别的一律进 unsupported，不当"没选中"处理。
  const wallIds = new Set<EntityId>();
  const openingIds = new Set<EntityId>();
  const unsupported: EntityId[] = [];
  for (const id of all) {
    const entity = doc.get(id);
    // 已经不在了：两次渲染之间被撤销掉、或被同伴级联删掉。**一律不发命令也不进 unsupported** ——
    // 该管这件事的是 `pruneSelection`（屏幕上那一发本来就点不到它），在这里记账只会把
    // "选中集没剪干净"和"删除能力不够"混成同一条红。
    if (entity === undefined) continue;
    if (entity.kind === 'wall') {
      // 别层的墙不当"不支持"处理：它是"不该在这一层删的东西出现在了这一层的选中集"，
      // 那是选中集的问题（pruneSelection 的活），不是删除能力的问题。
      if (entity.storeyId !== storeyId) unsupported.push(id);
      else wallIds.add(id);
      continue;
    }
    if (entity.kind === 'opening') {
      if (entity.storeyId !== storeyId) unsupported.push(id);
      else openingIds.add(id);
      continue;
    }
    unsupported.push(id); // column / slab / storey / point ⇒ 本任务不发命令（Task 8 接 delete）
  }
  // 宿主墙要一起删的洞口不发第二条：wallDelete 的级联已经收了它。
  const solo = [...openingIds].filter((id) => {
    const opening = doc.get(id);
    if (opening?.kind !== 'opening') return false;
    return !wallIds.has(opening.hostWallId);
  });
  const sortedSolo = solo.sort();
  const sortedWalls = [...wallIds].sort();
  const commands: Command[] = [
    ...sortedSolo.map((openingId) => openingDelete({ openingId })),
    ...sortedWalls.map((wallId) => wallDelete({ wallId })),
  ];
  const candidateIds = [...sortedSolo, ...sortedWalls];
  const outcome: DeleteOutcome =
    commands.length > 0 ? 'ok' : unsupported.length > 0 ? 'unsupported' : 'empty';
  return { outcome, commands, commandTypes: commands.map((c) => c.type), candidateIds, unsupported };
}

/**
 * 删除 / 撤销之后重算一遍选中：还存在的、且还在本层的才留下。
 *
 * 为什么不预测补丁内容：`wallDelete` 会级联删掉洞口，还会收掉不再被引用的端点，
 * UI 侧照抄一遍等于把真源的孤儿判定抄第二份。事后拿真源问一遍，永远只有一个口径。
 * 排序是为了让"选中集没变"这种比较可判（`Set` 的迭代序跟着插入顺序，撤销一次就漂）。
 */
export function pruneSelection(doc: Document, storeyId: string, ids: Iterable<EntityId>): EntityId[] {
  const out: EntityId[] = [];
  for (const id of ids) {
    const entity = doc.get(id);
    if (entity === undefined) continue;
    // 楼层实体没有 `storeyId`（它就是层本身），本层的选中集里出现它就是错 ⇒ 一律剔掉。
    // 少这一支下面那句会编译不过，所以它不是"顺手写的"：`storeyDelete` 是 Task 8 的活，
    // 届时该由 `planDelete` 的 'unsupported' 记账，而不是让它滞留在选中集里。
    if (entity.kind === 'storey') continue;
    // 点按它自己的 `storeyId` 筛：`PointEntity.storeyId` 可为 null（地形 / 园林点不属于任何一层），
    // 那一支同样落不进本层的选中集。曾经这里写的是"point 一律放行"，理由是"点没有 storeyId" ——
    // 那个前提是假的（`resolvePointRef` 正靠这句判跨层），假前提写进判据就是漏。
    if (entity.storeyId !== storeyId) continue;
    out.push(id);
  }
  return out.sort();
}

/** `lastCreatedWall` 的答案。`startId` / `endId` 是给探针复核用的三样之一（另一个是 `wallId`）。 */
export interface LastCreatedWall {
  readonly wallId: EntityId;
  readonly storeyId: EntityId;
  readonly startId: EntityId;
  readonly endId: EntityId;
}

/**
 * 从最近一次派发的 `affected` 里取新建的那面墙 —— renderer 侧第一个读 `affected` 的人。
 *
 * 三条纪律，缺一条就会拿到一面不存在的墙：
 * ① 只在 `dispatch` 的成功分支里**同步**读（异步读会读到别人之后的 `affected`）；
 * ② 读完立刻拿 `doc.get(id)` 复核（`undo()` 把 `lastAffected` 设成**前向**补丁的 id，
 *    撤销掉一次 `wall.create` 之后 `affected` 里仍然列着那面墙，而文档里已经没有它了）；
 * ③ 不许缓存（下一次派发就换内容）。
 * `affected` 的语义是"最近一次触及的 id"，不是"新出现的 id" —— 所以调用方永远要把文档当第二票。
 */
export function lastCreatedWall(
  doc: Document,
  affected: ReadonlySet<EntityId>,
  storeyId: string,
): LastCreatedWall | null {
  for (const id of affected) {
    // 判别式只认 `doc.get(id)`：uuidv7 在同一毫秒内不单调，`byKind('wall').at(-1)` 会拿到
    // 别的实体（全局约束那条），而这里连"最后一条"都不必 —— affected 里 wall 只会有一面。
    const entity = doc.get(id);
    if (entity?.kind !== 'wall') continue;
    if (entity.storeyId !== storeyId) continue; // 别层的墙（撤销后重做、或探针挑错了靶子）不算
    return { wallId: entity.id, storeyId: entity.storeyId, startId: entity.startId, endId: entity.endId };
  }
  return null;
}

/**
 * `wallProbe` 的候选落点：整数毫米，全部 **axis 对齐**（正交档会把它钉在同一根坐标上，
 * 于是新墙与既有墙垂直相交，屏幕上看着像那么回事）。顺序写死在这里 ⇒ 同一份文档
 * 每次问都给同一个靶子，"撤销后回到原值"那类判据才有可比的对象。
 */
const WALL_PROBE_OFFSETS: readonly MoveTarget[] = [
  { x: 2000, y: 0 },
  { x: 0, y: 2000 },
  { x: -2000, y: 0 },
  { x: 0, y: -2000 },
  { x: 2000, y: 2000 },
  { x: -2000, y: 2000 },
  { x: 2000, y: -2000 },
  { x: -2000, y: -2000 },
  { x: 3000, y: 0 },
  { x: 0, y: 3000 },
];

/** `--draw-shot` 的一次拉墙现场：三枚**整数**像素 + 两对整数毫米 + 命令入参的默认值。 */
export interface WallProbe {
  /** 起点的像素：它**就是**既有端点那一发，按下即吸上。 */
  readonly startPx: Px;
  readonly startMm: MoveTarget;
  /** 起点复用的那枚点：判据 D4「新建的墙与既有墙共享一枚点」读它。 */
  readonly startPointId: EntityId;
  /** 终点像素（整数）：`sendInputEvent` 只收整数 DIP，毫米由它反算。 */
  readonly endPx: Px;
  readonly endMm: MoveTarget;
  /** 新墙中点的像素：删除那一步要在真窗口里点中它，`pickPxOf` 之外第二道对照。 */
  readonly midPx: Px;
  readonly lengthMm: number;
  readonly defaults: NewWallDefaults;
}

/**
 * 找一发"值得在真窗口里拉"的新墙。返回 null 是合法结果（空层、铺满的层），闸门在那一步就抛，
 * 不许放宽下面的筛来迁就样例房。
 *
 * 六道筛，每条各堵一处假绿：
 * ① **起点必须吸到既有端点**（`snapKind === 'endpoint'` 且 `pointId` 非 null）：不复用就接不上头，
 *    判据 D4 只能在真源里成立、在屏幕上证不出来。注意这一筛**不假设每个端点都吸得上**：
 *    像素原点带小数的视图下（`fitStorey` 在 1200×901 就是这样），把光标取整到端点像素后
 *    垂足档可能比端点更近半像素，于是那一枚端点被跳过、探针换下一个 —— 实测过，不是想象。
 *    谁吸得上是 `takeBest` 的判据，探针只负责服从它（把它改成"信自己按毫米拼出来的端点"，
 *    屏幕上就会出现探针说吸上了、真窗口里没吸上）。
 * ② **终点的 `pointId` 必须为 null**（S7 的准确口径）：它保证这面墙的终点那一头是**新建的点**。
 *    注意不是"终点不许吸附" —— 探针的候选全是轴对齐的，正交档必然命中，那是保坐标、不引点。
 *    只有引了别人的点，`wallDelete` 才会判定那枚点仍被引用而留下它，
 *    "删掉这面墙带走恰好一枚孤儿点"的账就变成看运气。
 * ③ 长度同时过毫米下限与像素下限：前者防墙屑，后者防"闸门建了一面点不中的墙"
 *    （轮廓长边 ≈ 轴长 − 墙厚，小于 `MIN_PICK_EDGE_PX` 时 `pickPxOf` 给 null，删除那一步没法点名）。
 * ④ 落点与中点那两发像素**一个候选都不许命中**：不判它，探针可能挑到穿过既有墙的位置，
 *    新墙的轮廓与老墙叠在一起，`pickPxOf` 的"唯一命中"筛会一路换边换到 null。
 * ⑤ **三发像素全在画布内**（`insideCanvas`）：越界的那一发 `sendInputEvent` 发不出去，
 *    闸门会在"按了没反应"和"毫米对不上"之间反复横跳。
 * ⑥ **建得出还要画得出**（`derivesCleanly`）：命令层的 `build` 不含接头分类，斜向候选会把共享点
 *    凑成星形接头（S1 不支持），那一发在松手之后的 `buildDrawList` 里抛。
 */
export function wallProbe(
  doc: Document,
  storeyId: string,
  ops: readonly DrawOp[],
  v: Viewport,
): WallProbe | null {
  const field = snapFieldOf(doc, storeyId);
  const defaults = newWallDefaults(doc, storeyId);
  const endpoints = field.points.filter((p) => p.kind === 'endpoint');
  for (const ep of endpoints) {
    if (ep.pointId === null) continue; // 端点档恒有 pointId；这一支只为让类型收窄成立
    // 起点走与屏幕完全同一条通路：先算像素、再 `dropTargetOf`。探针自己按毫米拼 `pointId`
    // 就等于绕开吸附 —— 屏幕上真会吸到别处时探针看不见。
    const startPx = intPx(mmToPx(v, vec(ep.mm.x, ep.mm.y)));
    const start = draftAtPress(v, startPx, field);
    if (start.snap?.kind !== 'endpoint' || start.snap.pointId !== ep.pointId) continue;
    for (const off of WALL_PROBE_OFFSETS) {
      const guess: MoveTarget = { x: ep.mm.x + off.x, y: ep.mm.y + off.y };
      const endPx = intPx(mmToPx(v, vec(guess.x, guess.y)));
      const end = dropTargetOf(v, endPx, ep.mm, field, { excludeMm: ep.mm });
      if (end.snap !== null && end.snap.pointId !== null) continue; // 筛 ②
      const lengthMm = length(sub(vec(end.mm.x, end.mm.y), vec(ep.mm.x, ep.mm.y)));
      if (lengthMm < MIN_WALL_LENGTH_MM) continue; // 筛 ③ 之一
      if ((lengthMm - defaults.thicknessMm) * v.pxPerMm < MIN_PICK_EDGE_PX) continue; // 筛 ③ 之二
      const midPx = intPx(mmToPx(v, vec(quantizeMm((ep.mm.x + end.mm.x) / 2), quantizeMm((ep.mm.y + end.mm.y) / 2))));
      if (pickAt(ops, endPx).length !== 0) continue; // 筛 ④
      if (pickAt(ops, midPx).length !== 0) continue; // 筛 ④
      // 筛 ⑤：三发像素全在画布内（见 `insideCanvas`）。放在 ④ 之后、`legalWallCreate` 之前：
      // 它比试跑命令便宜，且越界那一发根本发不出去，合法性与否都无从在真窗口里对账。
      if (!insideCanvas(v, startPx) || !insideCanvas(v, endPx) || !insideCanvas(v, midPx)) continue;
      const draft: DraftWall = {
        storeyId,
        start: { mm: ep.mm, px: startPx, snap: start.snap },
        cursorPx: endPx,
        end,
        legal: false,
      };
      if (!legalWallCreate(doc, draft)) continue;
      // 筛 ⑥：建得成还要画得出。`legalWallCreate` 只跑命令的 `build`，看不见接头分类。
      if (!derivesCleanly(doc, { ...draft, legal: true }, v, defaults)) continue;
      return {
        startPx,
        startMm: ep.mm,
        startPointId: ep.pointId,
        endPx,
        endMm: end.mm,
        midPx,
        lengthMm,
        defaults,
      };
    }
  }
  return null;
}

/**
 * 筛 ⑥：拿一份**副本真建一遍、再把整层派生一遍**。
 *
 * `legalWallCreate` 只跑命令的 `build`，那一道里没有接头分类；而 `buildDrawList` 会走
 * `deriveStoreyGeometry` → `deriveJoints`，对"三个方向过同一枚点"抛 `RangeError`（S1 不支持星形接头）。
 * 这条筛不是想象出来的：加进筛 ⑤ 之后样例房的探针改挑 `(0,0) → (2000,2000)` 那发 45°，
 * 而 `(0,0)` 本来已经过着两条线 —— 建完墙 `buildDrawList` 当场抛
 * 「接头 … 有 3 个墙端、3 组方向线，S1 不支持」（2026-09-28 实测，红在既有那条"建出来真的点得中"上）。
 * 在真窗口里那一发的现象是**松手之后整层画不出来**：抛错发生在 paint effect 里，
 * 判据会红在一句与画墙无关的对账上。所以挑靶子阶段就拒掉。
 *
 * **代价与边界**：每个候选多一次整层派生（样例房一层八面墙，`wallProbe` 全程仍在毫秒级）。
 * 它只护住探针 —— 用户手拉的那一发斜墙仍然只过 `legalWallCreate`，星形接头在屏幕上的缺口
 * 原样登记给 T7（`legalDrop` / `legalWallCreate` 都不跑派生，真要补的是 core 侧的派生复核，
 * 不是 UI 再算一遍接头分类）。
 */
function derivesCleanly(
  doc: Document,
  draft: DraftWall,
  v: Viewport,
  defaults: NewWallDefaults,
): boolean {
  try {
    const command = draftCommand(draft, defaults);
    if (command === null) return false;
    // 副本：`TransactionLog.dispatch` 换的是 log 自己那份 document 引用，传进来的那份不动
    const trial = new TransactionLog(doc);
    trial.dispatch(command);
    buildDrawList(trial.document, draft.storeyId, v);
    return true;
  } catch {
    return false;
  }
}

/**
 * 筛 ⑤ 的判据：这一发像素能不能真的**点**到。
 *
 * 为什么非要有这一条：样例房一层在 `fitStorey(…, 1200, 900, 60)`（2026-09-28 实测 pxPerMm=0.125、
 * origin `(-800, 6600)`）下，`wallProbe` 在没有这条筛时挑中的是 `(0,0) → (-2000,0)` 那一发 ——
 * 毫米完全合法，可 `endPx` 是 `(-150, 825)`、`midPx` 是 `(-25, 825)`，**两发都在画布外**。
 * `sendInputEvent` 的 x/y 是相对内容区的 DIP，负数与越界值不会报错、只会落到没有 canvas 的地方，
 * 于是 `--draw-shot` 表现为"按了没反应"，而抛错点却在十几步之后的一句毫米对账上。
 * 留 2px 边而不是 0：`Math.round` 出来的 0 与 `widthPx` 本身就压在边界像素上，而画布外侧没有像素。
 */
function insideCanvas(v: Viewport, p: Px): boolean {
  return p.x >= 2 && p.y >= 2 && p.x < v.widthPx - 2 && p.y < v.heightPx - 2;
}

/** `sendInputEvent` 只收整数 DIP：先把像素取整，再由像素反算毫米（`handles.ts` 的 `snapPx` 同一条理由）。 */
function intPx(p: Px): Px {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

```

> **七处形状，执行时最容易"顺手改平"的地方**（每条后面括号里的红法是 2026-09-28 的改坏实测，见 C 段）：
>
> ① `newWallDefaults` 的**墙高不兜底**：直读 `requireStorey(doc, storeyId).heightMm`，楼层不存在就让它抛。只有厚度有常量兜底（真源里没有"上一层用多厚"可读）。E13（墙高抄常量）红两条：「3600 的层拿 3600」与「楼层不存在 ⇒ 抛，不兜成默认值」—— 后一条是前一条的护栏：一处兜底同时吃掉"读不到"和"读到了别的层"两种故障。
>
> ② `MIN_WALL_LENGTH_MM` 的注释是这份文件里最容易被人"顺手放宽"的一句：**它只筛 `wallProbe`，别把它读成"用户那一发也有这道闸"**。屏幕上真正拦得住长度的只有真源那两条，一面 300mm 的短墙在真源里完全合法。为什么探针还要另加一道毫米筛：像素那一道量的是**轮廓长边**（`lengthMm - thicknessMm` 对 64px），放大越多它换算回毫米越小 —— 2px/mm 时一面 272mm 长的墙（长边只剩 32mm）就够 64px 了，而真源只不许 `thicknessMm >= lengthMm`，于是 240mm 到 500mm 之间那段墙全都合法、又短得没法施工：回读判据全绿，图纸上是一面画不出来的墙。**代价（诚实记账）**：在样例房这一档比例（`pxPerMm = 0.125`）下 64px = 512mm，加回墙厚 752mm > 500mm，毫米筛被像素筛完全罩住，所以 E17（摘掉毫米下限）八个进程一条都不红。这条筛现在是**给 Task 8 的数值输入用的**（那里比例由用户定，两道筛会分家），不许因为"测不出红"就删掉它，也不许为它造假绿用例。
>
> ③ `WALL_PROBE_OFFSETS` 的顺序**写死在源码里**，不排序、不随机。这是确定性的来源：`--draw-shot` 里"撤销后回到原值"那类判据要有一个可比的对象，而候选顺序一旦随 `byKind` 漂（见本步开头第 ③ 条），靶子就换面墙，对账变成看运气。
>
> ④ `lastCreatedWall` 只认 `doc.get(id)` 的判别式，**不许**写成 `doc.byKind('wall').at(-1)`：uuidv7 在同一毫秒内不单调，"末条"会拿到别的实体（全局约束那条）。E9 恒红它那两条（「派发后拿得到；撤销后 affected 仍列着那枚 id」与「认层」），三进程与单进程都是 `28/2`，**没有第三条顺带红** —— S6 那句"读完立刻 `doc.get` 复核"的凭据就在这两条里，不在别的用例里。
>
> ⑤ S7 的两个方向各红一次：E14（终点可以引别人的点）红**一条**（`29/1`，8/8 恒），E26（终点什么都不许吸）红**九条**（`21/9`，8/8 恒，九条全在「新建回执与探针」里）—— 探针在样例房、单墙场与合成场**全都给 null**。**这条筛的真意是"不许复用"，不是"不许吸附"**：探针的偏移全是轴对齐的，正交档必然命中，而那一发不带 `pointId`，是保坐标不是引点。写成 `end.snap !== null` 就等于要求"终点什么都不许吸"，一枚靶子都挑不出来。
>
> ⑥ 筛 ⑤ 排在 ④ 之后、`legalWallCreate` 之前，筛 ⑥ 排在 `legalWallCreate` 之后。这个顺序**是成本顺序不是逻辑顺序**：⑤ 只做三次比较，④ 只做两次 `pickAt`，而 ⑥ 要真建一份副本再派生整层 —— 把它俩换来换去判据不红，但每问一次探针就多跑一批注定被后面那道筛拒掉的派生。`derivesCleanly` 里的 `new TransactionLog(doc)` 必须是**新建的临时 log**：`dispatch` 换的是 log 自己那份 document 引用，传进来的那份一个字都不动（与「试跑不动真源」那条用例同一口径）。
>
> ⑦ 按下那一发**不吃角度档**：`draftAtPress` 调 `dropTargetOf` 时锚点恒给 `null`，于是 15°/正交两档在按下时物理上不存在。E22（误把终点锚传进去）红「起点在空白处按下：什么都不吸，也不吃角度档」；E23（把起点像素存成吸附点的像素）红「按下处的像素与吸附点的像素是两个值」—— 后者是第四色标记能画在"按下处"、而落点吸到"那枚点"的前提（S8 在屏幕侧的镜像）。

Run: `npx vitest run packages/scene-2d/test/editing.test.ts > /tmp/t6s4-green.log 2>&1; echo exit=$?`
Expected: exit=0，**`Tests 30 passed (30)`**。同一条命令再跑一次（两次 `30 passed` 逐字相同）—— 这一份测试里有探针与 uuidv7 的交叉，**跨进程确定性**在它身上不是修辞：本步开头第 ③ 条那些合成夹具就是为了这句才搭的。跑全量时 core 侧一条不动（本任务 core 零改动），scene-2d 侧**只加 68 条**：snapping 28（Step 1）+ editing 30（本步）+ pick 3（Step 3）+ handles 7（Step 5），计划总数 **338 → 406**（原写 `337 → 405`，基数按 T5 实测挪一格）。

---

**C. 改坏验证（28 条，红在哪一条、红成什么数都是 2026-09-28 实测的，不是推演）**

每条改 `src/editing.ts` 一次、跑 `test/editing.test.ts`（30 条）、跑完立刻改回。括号里是实测的 `passed / failed`；E1–E13 与 E21–E25 各连开三个进程、E14–E20 与 E26–E28 各连开八个进程，**只有下面标了"偶发"的两行会抖**。


1. **E1** 派发顺序反过来（墙在前、洞口在后）（29/1，三进程恒）→ 恒红「删除计划 独立洞口 + 另一面墙：两条命令，洞口在前、墙在后」。这一发红的是**顺序**，不是条数：两条命令都在，只是撤销栈顶换成了 `opening.delete`，S5 说的"一次 Ctrl+Z 把墙连同它级联掉的洞口整组还原"当场失效。
2. **E2** 复述级联：选中的墙之外，洞口一律补发第二条 `opening.delete`（29/1，三进程恒）→ 恒红「删除计划 墙与它的洞口一起选中：只发一条 wall.delete，不复述级联」。`wallDelete.build` 自己收宿主洞口，复述的那一条在真源里已经找不到对象 —— 这一条就是 S5"复述的规则一定漂"的凭据。
3. **E3** `unsupported` 与 `empty` 合并成一个布尔（28/2，三进程恒）→ 恒红「删除计划 三种沉默三种颜色：拉墙模式 / 只剩柱 / 空集」与「别层构件进 unsupported，不是"没选中"：本层没这个权力」（后一条里判的是 `outcome === 'unsupported'`）。四色判据塌成两色，Task 8 接 `columnDelete` 时就无处接。
4. **E4** 拉墙模式不特判（`tool === 'wall'` 也照删）（29/1，三进程恒）→ 恒红「三种沉默三种颜色」。代价写在 `DeleteOutcome` 的注释里：`'ignored-in-wall-mode'` 是**故意**的沉默，正在拉墙时删掉选中集等于把用户上一发的成果一起吃掉。
5. **E5** `pruneSelection` 摘掉层过滤（29/1，三进程恒）→ 恒红「pruneSelection：别层的、已不存在的、楼层本身都剔掉，留下的按 id 升序」。
6. **E6** `pruneSelection` 不排序（29/1，三进程恒）→ 同上一条。升序买到的是"同一份答案问两次逐字相同"，而 `--draw-shot` 的 `selectionAfterDelete` 判的就是逐字相同。
7. **E7** `pruneSelection` 不查存在性（只过滤层，不管实体还在不在）（28/2，三进程恒）→ 恒红两条：「删掉一面带洞口的墙：洞口与它的孤儿点一起消失，pruneSelection 把两者都剔掉」与上一条。S5 后半句"剪枝不预测补丁内容"的凭据在这里：不查存在性就是拿预测当答案。
8. **E8** `lastCreatedWall` 摘掉认层（29/1，三进程恒）→ 恒红「lastCreatedWall 认层：别层的墙不给本层的答案」。
9. **E9** `lastCreatedWall` 改成 `doc.byKind('wall').at(-1)`（28/2，三进程恒）→ 恒红「派发后拿得到；撤销后 affected 仍列着那枚 id，但答案必须是 null」与「认层」。没有第三条顺带红（见 B 段第 ④ 条）。
10. **E10** `draftCommand` 不认 `legal`（false 也照发命令）（27/3，三进程恒）→ 恒红「光标压在起点上：终点排掉起点坐标、零长墙判不合法」「draftCommand 只认 legal 一色：false 给 null，true 给可派发的命令」与**属性用例**「legal 与"真 build 会不会抛"逐字同口径」。属性那条是这一发的主要见证：把 `legal` 变成一个装饰字段，只有随机生成的候选才会持续撞它。
11. **E11** `moveDraft` 不排起点（终点吸附场里允许吸回起点自己）（29/1，三进程恒）→ 恒红「光标压在起点上：终点排掉起点坐标、零长墙判不合法」。
12. **E12** `moveDraft` 原地改草稿（返回同一个对象）（29/1，三进程恒）→ 恒红「拖到水平方向：终点吸成逐字整数、临时线仍画到裸光标、原草稿不动」。renderer 比引用决定重绘（S4 第三条纪律在对象层的落地），原地改等于每一帧都不重绘。
13. **E13** 墙高抄常量而不是读楼层 `heightMm`（28/2，三进程恒）→ 恒红「3600 的层拿 3600」与「楼层不存在 ⇒ 抛，不兜成默认值」。
14. **E14** 探针摘掉筛 ②（终点可以引别人的点）（29/1，**八进程 8/8 恒**）→ 恒红「筛 ② 有牙齿：画布夹住的靶场里，唯一活着的候选引的是别人的点」。**只有这一条**：样例房那条「配平账」不红（第一发候选的终点本来就不是既有点），这正是注释即判据第 ③ 条说的分工。
15. **E15** 探针摘掉筛 ④（不要求空白落点）（29/1，八进程 8/8 恒）→ 恒红「筛 ④ 有牙齿：画布夹住的靶场里，唯一活着的候选中点压在横墙上」。样例房那条自证用例**不跟着红** —— 旧版计划在这里写过"十次只红八次"，那是把判据写在样例房里的结果；配上合成夹具之后它恒红，而样例房那一发不再被任何改坏当作凭据（见本步开头第 ③ 条）。
16. **E16** 探针摘掉像素下限（只留毫米下限）（29/1，八进程 8/8 恒）→ 恒红「极度缩小下探针给 null，稍大一档就给得出：说话的是那道像素下限」。
17. **E17** 探针摘掉毫米下限（`MIN_WALL_LENGTH_MM` 那一道不生效）（**30/0，八进程一条都不红**）→ 无红，且这是**测不出来**而不是判据写错：样例房拟合视图 `pxPerMm = 0.125`，64px 换算回 512mm、加回墙厚 752mm，比 500mm 更严，凡是过得了像素下限的候选自动过得了毫米下限（推导与处置都写在 B 段第 ② 条）。**不许为它补一条假绿用例**；它的见证人是 Task 8 的"数值输入 + 最小墙长"（转下游清单里有名有姓）。
18. **E18** 探针终点不取整像素（拿毫米直接当像素用）（29/1，八进程 8/8 恒）→ 恒红「探针只给整数像素：换一把"整数毫米落在分数像素上"的尺子仍然成立」。
19. **E19** 探针中点不取整像素（29/1，八进程 8/8 恒）→ 同一条用例。中点那一发是删除时点名的靶子，`sendInputEvent` 只收整数 DIP，半像素的那一发发不出去。
20. **E20** 探针起点自拼 `pointId`（绕开吸附，直接信自己按毫米算出来的端点）（29/1，八进程 8/8 恒）→ 恒红「探针只给整数像素…」。**旧版计划在这里写过"一条都不红"，订正**：那条用例把探针报告的 `startPx` 与"端点毫米换算出的整数像素"作差，而自拼那一支绕开 `dropTargetOf` 之后落点不再保证与屏幕同源，红的是这一条而不是"起点必须吸上"的语义 —— 语义那一条的真正凭据在 Step 7 的真窗口判据 D4（`--draw-shot` 里"新建的墙与既有墙共享一枚点"）。
21. **E21** `draftRefs` 两端互换（起点新建、终点复用）（29/1，三进程恒）→ 恒红「draftRefs：起点复用 {pointId}、终点新建 {x,y}，真源里接头真接上了」。
22. **E22** 按下也吃角度档（`draftAtPress` 误把锚点传给 `dropTargetOf`）（29/1，三进程恒）→ 恒红「起点在空白处按下：什么都不吸，也不吃角度档（锚点恒 null）」。S3 的"按下不许自动变正交"在屏幕侧的落地。
23. **E23** 起点只存吸附点的像素（`DraftPoint.px` 写成 `mmToPx(snap.mm)`）（29/1，三进程恒）→ 恒红「按下处的像素与吸附点的像素是两个值：标记画在按下处，落点吸到点上」。
24. **E24** `planDelete` 把别层构件当"没选中"（返回 `empty` 而不是 `unsupported`）（29/1，三进程恒）→ 恒红「别层构件进 unsupported，不是"没选中"：本层没这个权力」。
25. **E25** `draftRefs` 不复用既有点（恒取 `{x,y}`）（26/4，三进程恒）→ 恒红四条：「draftRefs：起点复用…」「三种拒绝各一色：零长、墙厚不小于墙长、跨层复用点」「探针靶子的配平账：ops 空表（筛 ④ 失效）时建出来恰好多一枚点、删回去账回到原样」「⑥ 的前提：同一发候选命令层放行、派生层抛（星形接头）」。**这一发是"不复用则接头全断"的最贵坏法**：它同时打断拓扑（S7 的复用）、点数配平账（`--draw-shot` 的 `pointCount` 判据）与 ⑥ 的夹具前提。
26. **E26** 筛 ② 收紧成"终点什么都不许吸"（`end.snap !== null` 就换下一个）（21/9，八进程 8/8 恒）→ 九条红，全在「新建回执与探针」里：「wallProbe 在样例房里给得出靶子，六道筛逐条自证，且两次问逐字相同」「配平账」「筛 ② 有牙齿」「筛 ④ 有牙齿」「探针只给整数像素」「极度缩小下探针给 null…」「筛 ⑤ 有牙齿」「⑥ 的前提」「wallProbe 在空层给 null（不抛）」。探针在三种场上**全都给 null** —— 与 E14 是同一道筛的两个方向，各红一次才说明它判的是"不许复用"而不是"不许吸附"（B 段第 ⑤ 条）。
27. **E27** 探针摘掉筛 ⑤（画布外的落点也发出去）（六进程 26/4、两进程 27/3）→ 恒红三条：「筛 ② 有牙齿」「筛 ④ 有牙齿」「筛 ⑤ 有牙齿」（各 8/8）。**偶发红**：「六道筛逐条自证」八次红七次 —— 摘掉 ⑤ 之后样例房换不换那一发越界候选，取决于哪枚端点排在前面。**这一行就是"合成夹具为什么必须存在"的凭据**：判据写在样例房里会时红时绿，写在夹住的靶场里恒红。
28. **E28** 探针摘掉筛 ⑥（建得出但画不出来的候选留下）（**七进程 29/1、一进程 30/0**）→ 只有「六道筛逐条自证」红，且**八进程里七次**，红在建完再派生那一句。这是本清单唯一一条"承重靠偶发"的行：⑥ 的语义前提由「⑥ 的前提」那条用例钉死（同一发候选命令层放行、派生层抛，`/S1 不支持/`），但"探针真的会撞上它"目前只在样例房的自证用例上看得见，而那一发随 uuidv7 漂。**处置**：不造假绿、不删判据，把"确定性 ⑥ 夹具"（同一坐标、同一比例，让星形候选成为唯一活着的候选）连同 ⑤ 的夹具一起登记给 Task 8（见本步末尾的转下游清单）。

> **两处"红了但不是凭据"与一处"根本不红"**（第 17、20、27、28 行）：E17 是**比例造成的不可达**，E20 红错了对象（语义凭据在真窗口闸门），E27/E28 的那一发样例房自证用例是**八次七红**。三条的共同处置口径与 T5 一字不差：**判据不许靠"多半会红"**；恒红的那些就是凭据，偶发的那一发不算，不可达的那一条等它的第一个真读者。

> **交接给 Task 7 的四条**（本步实测出来的差额，不许在 UI 侧私自补）：① `MIN_WALL_LENGTH_MM` 目前被像素下限罩住（E17），数值输入进来之后它会第一次真的说话；② 筛 ⑥ 与筛 ⑤ 的确定性夹具（E27/E28 的偶发那一发）；③ `legalWallCreate` / `legalDrop` 都只试跑命令的 `build`、**不跑派生层** ⇒ 用户手拉一发斜墙凑出星形接头时，屏幕会先接受、再在 paint effect 里抛（Step 5 的 B 段第 ① 条同一条差额，那里记的是拖把手，这里记的是拉新墙；真要补的是 core 侧的派生复核，不是 UI 再算一遍接头分类）；④ `--draw-shot` 的靶子依赖 `WALL_PROBE_OFFSETS` 的写死顺序，T7 若给样例房加墙或改比例，**筛 ⑤/⑥ 会把靶子换到另一枚端点**，那时 `--draw-shot` 的毫米判据要跟着重测（不许把判据改成"任一发候选都行"来迁就）。

- [ ] **Step 5: scene-2d —— `handles.ts` 接上吸附，锚点与排除收进 `handleDropTarget` 出口；`handles.test.ts` 12 → 19 条**

Task 6 里第二处"动已经落地的判据文件"（第一处是 Step 3 的 `pick.ts`）。顺序照旧：**先整份换测试跑到红 → 再整份换实现 → 数一数 T5 那 12 条有没有被碰坏**。T5 的 12 条在这次替换里只有三处不同（本 Task 开头"本任务会改到 T4/T5 的六处既有写法"的第 2、3、4 条），逐条写在这里，免得执行时把它们当成抄错了：

1. 合成的 `handleAt`（`pickHandle` 那两条不借 `dragHandlesOf` 的用例在用）补一行 `anchorMm: { x: px, y: py }` —— 那是构造期缺字段的编译错误，不是判据变化。
2. 末条配色判据把三色列成四色（多 `SNAP_COLOR`），判据本身一字不改。
3. 「探针给的落点必然合法、必然真的移动…」里那句 `expect(moveTargetOf(view, p.toPx)).toEqual(p.targetMm)` 换成 `expect(handleDropTarget(view, p.toPx, probeHandle, probeField).mm).toEqual(p.targetMm)`。**这一处不是风格改动，是订正**：老写法的等式在"拖拽不吃吸附"时成立、吃吸附之后只在"探针恰好没吸到东西"时成立 —— 实测在样例房那把被挑中的把手上，它的落点正是被 15° 档改写过的（`{600,600} → {640,-578}` 那一类），于是老等式十个进程红 2 个。**一条会随机红的判据不能当 `--edit-shot`"落点逐字相等"的地基**，换成"两边同一个纯函数、同一对入参"之后它恒成立（恒等式，不是概率）。

**这一步只改四件事**（B 块逐条对得上）：

① `MoveTarget` / `quantizeTarget` / `moveTargetOf` 从 `handles.ts` 迁到 `snapping.ts`。迁移不是整理房间：D4 要求"屏幕 → 真源"只有一条通路，而吸附必须插在换算之后 —— 换算住在这个文件、吸附住在那个文件，就会长出第二条 px→mm 的路。迁完之后 `handles.ts` 只剩两个读者：`dragProbe` 吃 `dropTargetOf`，`legalDrop` 只吃已经定好的 `MoveTarget`。

② `DragHandle` 补 `anchorMm`（另一端那对**整数毫米**，与既有 `anchorPx` 同产地）。为什么不能拿 `anchorPx` 反算：角度档要的是世界坐标里的锚点，浮点像素反算回毫米会引入一次往返，而这一次往返正好落在"保坐标"语义上 —— 正交档给 `(raw.x, anchor.y)`，`anchor.y` 漂 1mm，落点就漂 1mm。

③ `dragProbe` 的落点从 `moveTargetOf(v, toPx)` 换成 `handleDropTarget(v, toPx, h, field)`；场在**入口取一次**（放在候选循环里就是 O(候选² × 墙)）；`legalDrop` 判的是**吸附之后**那对毫米。三条里最后这条最容易写反：判裸落点等于"预言一个松手必然被真源拒绝的落点"，屏幕上把手是绿的、松手报错。这条有专门的用例（下面第 19 条）与专门的改坏行（HB5）。

④ 新增出口 `handleDropTarget(v, cursorPx, h, field)`，把"锚点 = `h.anchorMm`、排除 = `h.atMm`"这一对参数**收在唯一一处**。

**④ 不是 convenience，是把判据从"多半会红"改成"必红"**。裁决 S4 ② 说探针与 renderer 必须吃同一个 `dropTargetOf`，但只要那两个调用点各写一遍参数，"探针传 `null` 锚点 / 忘了排除"就是可写的 —— 而实测这种改坏**时红时不红**：八个进程红 5 个（落点是否依赖锚点取决于探针挑到哪一面墙，挑哪面墙由 uuidv7 决定）。收进出口之后只剩"改出口"这一种写法，而它必然同时打到两个调用点：摘锚点（HB1）8/8 进程红「拖拽路径真的在吃吸附」，摘排除（HB2）8/8 红「把手按在原地那一发」，锚点写成原地（HE2）8/8 红前者。

同一份清单也说清了它**不**买到什么：有人绕开出口、在探针里另抄一遍 `dropTargetOf` 并漏掉排除（HE3），19 条**一条都不红**；连恒等筛一起摘掉（HE4）仍然一条都不红。出口买到的是"这两个参数在这条通路上只有一处可写"，不是"写错必然红" —— 后者靠的是那两条直接问出口的用例，它们判的是参数本身的效果，不是探针的返回值。这句要留在计划里，否则下一个执行的人会去给 HE3 补一条"看起来能红"的用例，补出来的是假绿。

**新加的七条（12 → 19）各咬谁**：anchorMm 的来源两条（字段语义 + 压扁拖那一发必然不合法）／拖拽路径真的在吃吸附一条（160 发候选的计数 + "改写只许来自 `angle15`"，咬 HB1、HE2）／把手按在原地一条（排除的牙齿，咬 HB2）／探针吃吸附后的毫米一条（场进探针，咬 HB3、HB4）／合法性判的是吸附后的毫米一条（咬 HB5）／三枚像素在分数尺子下的一条（咬 HC2，同时把 T5 第 10 条的凭据从假绿里救出来）。

**为什么"合法性判裸落点还是判吸附后"必须另搭一层夹具**：先把话说反 —— 现有两套夹具（样例房 160 问、原点四层加对角 100 问，共 260 问）**逐问比对 `legalDrop(drop.raw)` 与 `legalDrop(drop.mm)`，分歧 0 条**（2026-09-28 实测）。所以 HB5 原先一条都不红，不是用例弱，是**素材里没有两种答案**。要有两种答案，得让吸附把落点搬进一个非法坐标，而合法性只由**拖那一点时在场的邻墙**决定（读过 `wallMoveEndpoint`：六道守卫全在共享端点上，洞口是夹回来不是驳回）。于是可造窗口只有 `T − tol ≤ dist(吸点, 邻墙另一端) < T`：`T = 240`、`tol = 8px`，在 0.1px/mm 的尺子上就是 `[160, 240)`mm。第二层夹具照这个窗口搭：共享点 `P` 上只有**共线的两面墙**（`P→(0,530)` 与 `P→(0,-800)` —— 反向同线在 core 里算**一个**线组），外加一面不共享的墙，它的端点 `(40,760)` 离 `P→(0,530)` 的另一端 233mm（落进窗口 ⇒ 吸上去非法），离第一发的裸落点 `(0,800)` 56.6mm（0.1px/mm 下 5.66px ⇒ 一定吸得到）。**中途试过、被真源驳回的那条路要记下**：给共享点再加第三面方向的墙（`A→(400,540)`）能把窗口凑出来，但 core 在派生层就抛 `RangeError: 接头 … 有 5 个墙端、3 个方向在同一点相交（star），S1 不支持`（`trimsFor` ← `deriveJoints` ← `deriveStoreyGeometry` ← `buildDrawList`）—— S1 的真源里根本不存在那种点，所以夹具必须绕开星形接头，这正是"共线两面 + 一面游离墙"这个形状的由来。

---

**A. 整份替换 `packages/scene-2d/test/handles.test.ts`（19 条 `it`）**

整份如下，**逐字照抄**：里面的注释是判据的一部分 —— 这一份文件里"某个数为什么在那儿""某个夹具为什么长这个形状"的说明比断言本身多，删掉它们，下一个执行的人只能靠猜来改，而猜错的方向永远是放宽判据。

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
  dropTargetOf,
  EMPTY_SELECTION,
  fitStorey,
  HANDLE_COLOR,
  HANDLE_RADIUS_PX,
  handleDropTarget,
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
  snapFieldOf,
  SNAP_COLOR,
  SNAP_TOL_PX,
  viewportOf,
  type DragHandle,
  type MoveTarget,
  type Selection,
} from '@dajia/scene-2d';

const house = demoHouse();
const view = fitStorey(house.doc, house.lowerStoreyId, 1200, 900, 60);
const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);

const sel = (...ids: string[]): Selection => ({ ids: new Set(ids) });

/**
 * `handles.ts` 里 `PROBE_OFFSETS` 那十发的**副本**（那是文件私有常量，出口里没有它）。
 * 复制而不是导入是故意的：探针扫的就是这十个偏移，测试要拿同一套偏移去覆盖它，
 * 二者必须逐字相同 —— 而"改了那边忘了这边"的红法由最后一条覆盖判据负责（那一句会红）。
 */
const SWEEP_OFFSETS: readonly MoveTarget[] = [
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

/**
 * 合成一层：四面墙都从原点 A 出发（上 1040 / 右 1040 / 下 800 / 左 800），可选再在 (640,640)
 * 挂一面对角外的墙。三套探针夹具共用它 —— 四面墙把 `PROBE_OFFSETS` 前四发（上/右/下/左）全堵死
 * （(0,800)/(800,0) 撞墙厚，(0,-800)/(-800,0) 把另两面墙拖成零长），第五发对角才走得通。
 *
 * `foreign` 那一面给对角那发一个"吸得上的既有点"：带上它，探针报 (640,640)；不带，报裸 (600,600)。
 * A 的 id 只认第一次 `wallCreate` 的 affected（`createdWall`），**不许** `byKind('point')[0]`：
 * uuidv7 同毫秒不单调，那样写会把 A 拿成 (0,1040) 那枚点，四面墙两两同向重叠、core 当场抛。
 */
function wallsFromOrigin(foreign: boolean): { log: TransactionLog; storeyId: string } {
  const projectId = uuidv7();
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  let storeyId = '';
  for (const id of log.affected) {
    if (log.document.get(id)?.kind === 'storey') storeyId = id;
  }
  if (storeyId === '') throw new TypeError('affected 里没有新建的楼层');
  log.dispatch(wallCreate({ storeyId, start: { x: 0, y: 0 }, end: { x: 0, y: 1040 }, thicknessMm: 240, heightMm: 3000 }));
  const a = createdWallOf(log).startId;
  const ENDINGS: readonly [number, number][] = [
    [1040, 0],
    [0, -800],
    [-800, 0],
  ];
  for (const [bx, by] of ENDINGS) {
    log.dispatch(wallCreate({ storeyId, start: { pointId: a }, end: { x: bx, y: by }, thicknessMm: 240, heightMm: 3000 }));
  }
  // 既有点 (640,640)：离裸对角落点 (600,600) 56.6mm。0.1px/mm 下是 5.66px（容差 8px 之内），
  // 1px = 7mm 下是 8.08px（容差之外）—— 所以只有带 `foreign` 那发探针才吸得到它。
  if (foreign) {
    log.dispatch(wallCreate({ storeyId, start: { x: 640, y: 640 }, end: { x: 640, y: 1640 }, thicknessMm: 240, heightMm: 3000 }));
  }
  return { log, storeyId };
}

/**
 * 最近一次 dispatch 的 affected 里那面墙。**不许** `byKind('wall').at(-1)`：uuidv7 同毫秒
 * 不单调，`byKind` 又是 id 升序，"最后一面"跟"最后建的"不是一回事。
 */
function createdWallOf(log: TransactionLog): WallEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new TypeError('affected 里没有新建的墙');
}

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
      anchorMm: { x: 0, y: 0 },
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
    // 探针报的毫米必须是**renderer 松手那一发算出来的毫米**（T6 之前这里是
    // `expect(moveTargetOf(view, p.toPx)).toEqual(p.targetMm)`，本行是它换掉的写法）。
    // 为什么必须换：拖拽路径 T6 起吃吸附，样例房 16 把把手 × 10 发候选里有 14 发的落点
    // **不等于**裸落点（15° 档把它们改写了，见下面"拖拽真的在吃吸附"那条），而"哪面墙先被扫到"
    // 由 uuidv7 决定 ⇒ 老写法实测 10 个进程红 2 个。换掉之后这一句恒等：两边是同一个纯函数、
    // 同一对入参。上面那句 `legalDrop` 判的就是这一对毫米，三句话连起来才成立：
    // 探针说合法 → renderer 算出同一对毫米 → 命令必然成功 → `--edit-shot` 才许拿"逐字相等"当判据。
    const probeField = snapFieldOf(house.doc, house.lowerStoreyId);
    const probeHandle = dragHandlesOf(house.doc, house.lowerStoreyId, sel(p.wallId), view).find(
      (x) => x.end === p.end,
    )!;
    expect(
      handleDropTarget(view, p.toPx, probeHandle, probeField).mm,
    ).toEqual(p.targetMm);
    // 三枚像素必须全是整数：`sendInputEvent` 只收整数 DIP，主进程一发 `Math.round` 就把落点
    // 挪到另一对毫米上（fitStorey 的 0.13 px/mm 下差 1~4mm），上面那句"不动点"立刻变成随机红。
    // 但**这一条不是咬 snapPx 的那颗牙**：样例房 0.125px/mm 配百米毫米的坐标，取整前后本来就是
    // 同一个数，摘掉 `snapPx`（HC2）实测 8 个进程在这条上零红 —— 咬它的是下面那份 1200×901 的尺子。
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

describe('拖拽吃吸附（Task 6）', () => {
  it('anchorMm 是另一端那对整数毫米：与 atMm 分居两端、与 anchorPx 同产地', () => {
    const { junction } = wallsAtJunction();
    const handles = dragHandlesOf(house.doc, house.lowerStoreyId, sel(junction.id), view);
    const s = handles.find((h) => h.end === 'start')!;
    const e = handles.find((h) => h.end === 'end')!;
    const corner = requirePoint(house.doc, junction.startId, '拐角');
    const far = requirePoint(house.doc, junction.endId, '另一端');
    expect(s.atMm).toEqual({ x: corner.x, y: corner.y });
    expect(s.anchorMm).toEqual({ x: far.x, y: far.y });
    expect(e.anchorMm).toEqual({ x: corner.x, y: corner.y });
    // 两把把手的"另一端"恰是彼此的落点：配错端（把 anchorMm 写成 atMm、或两端写反）在这里红，
    // 而它在屏幕上的后果是角度档拿错锚 —— 拖出来的方向对着空气对齐，毫米账却全对。
    expect(s.anchorMm).toEqual(e.atMm);
    expect(e.anchorMm).toEqual(s.atMm);
    expect(s.anchorMm).not.toEqual(s.atMm);
    // 与 anchorPx 同产地：同一端换算两次必须逐字相同，不许一把取轴、一把取点
    expect(s.anchorPx).toEqual(mmToPx(view, vec(s.anchorMm.x, s.anchorMm.y)));
    expect(e.anchorPx).toEqual(mmToPx(view, vec(e.anchorMm.x, e.anchorMm.y)));
    expect(Number.isInteger(s.anchorMm.x) && Number.isInteger(s.anchorMm.y)).toBe(true);
  });

  it('anchorMm 就是压扁拖那一发：每把把手按它拖都必然不合法，按 atMm 原地不动必然合法', () => {
    const { junction, other } = wallsAtJunction();
    const handles = dragHandlesOf(house.doc, house.lowerStoreyId, sel(junction.id, other.id), view);
    expect(handles).toHaveLength(4); // 空样本防线：循环一次都不进的话，下面六句全是 vacuous truth
    for (const h of handles) {
      expect(legalDrop(house.doc, h.wallId, h.end, h.anchorMm)).toBe(false);
      expect(() =>
        wallMoveEndpoint({
          wallId: h.wallId,
          end: h.end,
          x: h.anchorMm.x,
          y: h.anchorMm.y,
        }).build(house.doc),
      ).toThrow(/零长/);
      // 对照组：这一句让上一条循环不能靠"怎么拖都不合法"蒙过去
      expect(legalDrop(house.doc, h.wallId, h.end, h.atMm)).toBe(true);
    }
  });

  it('拖拽路径真的在吃吸附：160 发候选里 72 发吸成恒等、14 发被 15° 档改写，改写全来自 angle15', () => {
    // 这条是上一批用例里那句 `moveTargetOf(view, toPx) === targetMm` 换掉的**理由**：
    // 拖拽落点从 T6 起走 `dropTargetOf`，而样例房里绝大多数候选确实吸上了东西 ——
    // 垂足（54 发）与正交（17 发）吸的是恒等（点本来就在自己那面墙的轴线上），中点 1 发；
    // 真正把落点挪走的是 15° 档那 14 发（最大位移 6.97px，仍在 `SNAP_TOL_PX` 之内）。
    // 计数跑在**全部把手 × 全部偏移**上，所以它与"uuidv7 决定探针挑哪面墙"无关：
    // 16 把把手、160 发、恒等 72、改写 14，这几个数在十个进程里逐字相同（2026-09-28 实测）。
    const fd = snapFieldOf(house.doc, house.lowerStoreyId);
    const walls = house.doc.byKind('wall').filter((w) => w.storeyId === house.lowerStoreyId);
    const handles = dragHandlesOf(house.doc, house.lowerStoreyId, sel(...walls.map((w) => w.id)), view);
    expect(handles).toHaveLength(16); // 空样本防线：一把把手都没有的话下面两个计数就是 vacuous truth
    let identity = 0;
    let rewritten = 0;
    for (const h of handles) {
      for (const off of SWEEP_OFFSETS) {
        const rawPx = mmToPx(view, vec(h.atMm.x + off.x, h.atMm.y + off.y));
        const toPx = { x: Math.round(rawPx.x), y: Math.round(rawPx.y) }; // 与探针同一发整数像素
        const ask = handleDropTarget(view, toPx, h, fd);
        expect(Number.isInteger(ask.mm.x) && Number.isInteger(ask.mm.y)).toBe(true);
        if (ask.snap === null) continue;
        expect(ask.snap.distPx).toBeLessThanOrEqual(SNAP_TOL_PX); // 吸附不许把落点甩到容差外
        if (ask.mm.x === ask.raw.x && ask.mm.y === ask.raw.y) identity++;
        else {
          rewritten++;
          // 被挪走的只可能是 15° 档：轴对齐的候选落在轴对齐墙的轴线上，垂足与正交只能给恒等。
          // 这一句是整条用例里唯一带"不许"的判据 —— 哪天垂足开始把对角候选拉回轴线，
          // 它先红在这里，而不是红在 `--edit-shot` 的逐字对账上。
          expect(ask.snap.kind).toBe('angle15');
        }
      }
    }
    expect(identity).toBeGreaterThanOrEqual(8); // 实测 72：判据只要求"吸了但没挪走"确实存在
    expect(rewritten).toBeGreaterThanOrEqual(1); // 实测 14：判据只要求"吸了且挪走了"确实存在
    // 扫的必须**盖住**探针真会走的那十发，否则上面两个数只是别人的账：
    // 从探针返回的像素反算偏移，必须能在 `SWEEP_OFFSETS` 里找到同一发（±8mm 容得下取整像素的 0.5px）。
    const p = dragProbe(house.doc, house.lowerStoreyId, ops, view)!;
    const h = dragHandlesOf(house.doc, house.lowerStoreyId, sel(p.wallId), view).find(
      (x) => x.end === p.end,
    )!;
    const atCursorMm = pxToMm(view, p.toPx);
    const delta = { x: Math.round(atCursorMm.x - h.atMm.x), y: Math.round(atCursorMm.y - h.atMm.y) };
    expect(
      SWEEP_OFFSETS.some((o) => Math.abs(o.x - delta.x) <= 8 && Math.abs(o.y - delta.y) <= 8),
    ).toBe(true);
  });

  it('把手按在原地那一发：排掉自己就谁也不吸，不排就吸回自己（dragProbe 传的就是前者）', () => {
    // 判的是 `dragProbe` 与 renderer 都传给 `dropTargetOf` 的那对参数：光标停在把手自己的像素上。
    // 这一发最容易写错成"按 pointId 排除"，而原地同时是①它自己那枚端点、②它所在轴线的 t=0 垂足、
    // ③与它同坐标的邻墙候选 —— 三个候选同一个坐标，只排 id 会漏掉后两个，表现就是"一松手墙没动"。
    // 实测样例房 16 把把手全部：传排除 ⇒ `snap === null` 且落点就是原地；不传 ⇒ 吸回自己那枚点。
    const fd = snapFieldOf(house.doc, house.lowerStoreyId);
    const walls = house.doc.byKind('wall').filter((w) => w.storeyId === house.lowerStoreyId);
    const handles = dragHandlesOf(house.doc, house.lowerStoreyId, sel(...walls.map((w) => w.id)), view);
    expect(handles.length).toBeGreaterThanOrEqual(4);
    for (const h of handles) {
      const at = { x: Math.round(h.atPx.x), y: Math.round(h.atPx.y) }; // 回读脚本发得出的那一发
      const excluded = handleDropTarget(view, at, h, fd);
      const kept = dropTargetOf(view, at, h.anchorMm, fd);
      expect(excluded.snap).toBeNull();
      expect(excluded.mm).toEqual(h.atMm); // 排掉自己之后原地那一发谁也不吸，落点就是它自己
      expect(kept.snap?.pointId).toBe(h.pointId); // 不排就吸回自己：这道筛确实有东西要挡
      expect(kept.mm).toEqual(h.atMm);
    }
  });

  it('探针吃的是吸附后的毫米：四发正向候选全被真源挡下，第五发被一枚既有点接住', () => {
    // 现场故意造到"前四发候选全非法、第五发对角候选的裸落点离一枚既有点 5.66px"，
    // 于是吃场的探针报**那枚点的毫米**，不吃场的探针报**对角那发的裸毫米** —— 两个答案不同。
    // 2026-09-28 实测这条咬住的改坏：探针传 `EMPTY_SNAP_FIELD`（HB3）与换回 `moveTargetOf`（HB4），
    // 两条各红这条 + 下面那条「合法性判的是吸附后的毫米」。锚点（HB1）与排除（HB2）不在这里判 ——
    // 它们收在 `handleDropTarget` 出口里，改出口会让"拖拽路径真的在吃吸附"与"把手按在原地那一发"
    // 逐进程红（实测 8/8），判在探针调用点上反而漏（那时探针与 renderer 一起改，行为没变）。
    // 判裸落点还是判吸附后（HB5）由下面那条专门咬，这条夹具里裸与吸两侧都合法，判不出。
    const { log, storeyId } = wallsFromOrigin(true);
    // 1px = 10mm ⇒ 整数像素与整数毫米逐字往返，红的时候不必先排除舍入
    const v = viewportOf(1000, 800, { pxPerMm: 0.1, center: vec(300, 300) });
    const doc = log.document;
    const p = dragProbe(doc, storeyId, buildDrawList(doc, storeyId, v, EMPTY_SELECTION), v);
    expect(p).not.toBeNull();
    expect(p!.sharedBy).toBeGreaterThanOrEqual(2);
    // 先自证现场：裸落点确实是对角那一发，而探针给的是**吸上去之后**那枚既有点
    expect(moveTargetOf(v, p!.toPx)).toEqual({ x: 600, y: 600 });
    expect(p!.targetMm).toEqual({ x: 640, y: 640 });
    expect(p!.targetMm).not.toEqual(moveTargetOf(v, p!.toPx));
    // 而合法性判的也是吸附后的毫米：原地那枚既有点把墙拖成的形状必须真的过得了真源那道守卫
    expect(legalDrop(doc, p!.wallId, p!.end, p!.targetMm)).toBe(true);
    expect(legalDrop(doc, p!.wallId, p!.end, { x: 600, y: 600 })).toBe(true); // 两个都合法 ⇒ 上面那句不是巧合
    // 前四发候选全非法是这套夹具的前提，不是假设：逐发当场验一遍（(0,800)/(800,0) 撞墙厚，
    // (0,-800)/(-800,0) 把另两面墙拖成零长），前提漂了这里先红，不会让上面那两句变成猜。
    for (const off of [
      { x: 0, y: 800 },
      { x: 800, y: 0 },
      { x: 0, y: -800 },
      { x: -800, y: 0 },
    ]) {
      expect(legalDrop(doc, p!.wallId, p!.end, { x: off.x, y: off.y })).toBe(false);
    }
  });

  it('合法性判的是吸附后的毫米：裸对角合法、吸上去那一发被 240 厚墙挡下', () => {
    // 上一条例用里裸落点与吸附落点**都**合法（那句 `legalDrop(... {600,600}) === true` 就是把它钉住），
    // 所以"合法性判在吸附之前还是之后"在那里只有一种答案 —— 实测把 `legalDrop` 改判 `drop.raw`
    // 在那套夹具上八个进程零红。这一条另造一层：`P→(0,530)` 那面 240 厚的墙把**吸上去**那一发
    // (40,760) 挡在"墙厚 ≥ 轴长"外（233 < 240），而裸的 (0,800) 离 (0,530) 有 270 ⇒ 合法。
    // 判裸落点的探针会把第一发就收下并报 (40,760) —— 一个松手必然被真源拒绝的落点；判吸附后的
    // 探针跳过第一发、报第二发的 (800,0)。于是这条同时钉住三件事：报出来的毫米合法、报出来的
    // 不是那个非法的吸点、报出来的像素不是第一发那一个。
    const projectId = uuidv7();
    const log = new TransactionLog(Document.create(projectId));
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    let storeyId = '';
    for (const id of log.affected) {
      if (log.document.get(id)?.kind === 'storey') storeyId = id;
    }
    if (storeyId === '') throw new TypeError('affected 里没有新建的楼层');
    // 共享 P 的两面墙（同一条竖线、方向相反 ⇒ 接头只有一个线组，S1 造得成）：`sharedBy >= 2` 成立。
    // 530 那面同时是陷阱口：`wallCreate` 的最小轴长 500 与墙厚 240 都过得去，建得成。
    log.dispatch(wallCreate({ storeyId, start: { x: 0, y: 0 }, end: { x: 0, y: 530 }, thicknessMm: 240, heightMm: 3000 }));
    const north = createdWallOf(log);
    log.dispatch(wallCreate({ storeyId, start: { pointId: north.startId }, end: { x: 0, y: -800 }, thicknessMm: 240, heightMm: 3000 }));
    // (40,760) 这一枚既有点离第一发的裸落点 (0,800) 56.6mm ⇒ 0.1px/mm 下 5.66px，容差 8px 之内
    // ⇒ 探针第一发必然吸到它（实测两把共享把手都是 `endpoint@5.66`）。
    log.dispatch(wallCreate({ storeyId, start: { x: 40, y: 760 }, end: { x: 1040, y: 760 }, thicknessMm: 240, heightMm: 3000 }));
    const v = viewportOf(1000, 800, { pxPerMm: 0.1, center: vec(200, 300) });
    const doc = log.document;
    const ops = buildDrawList(doc, storeyId, v, EMPTY_SELECTION);
    const p = dragProbe(doc, storeyId, ops, v);
    expect(p).not.toBeNull();
    expect(p!.sharedBy).toBeGreaterThanOrEqual(2);
    // 现场自证分歧真的存在，且就在**赢的那把把手**身上：同一发整数像素，裸落点过得了守卫、
    // 吸上去那一发过不了。这一句不判探针，只判"这条红不是靠运气挑到靶子"。
    const field = snapFieldOf(doc, storeyId);
    const handle = dragHandlesOf(
      doc,
      storeyId,
      { ids: new Set(doc.byKind('wall').filter((w) => w.storeyId === storeyId).map((w) => w.id)) },
      v,
    ).find((h) => h.wallId === p!.wallId && h.end === p!.end)!;
    const firstPx = {
      x: Math.round(mmToPx(v, { x: handle.atMm.x, y: handle.atMm.y + 800 }).x),
      y: Math.round(mmToPx(v, { x: handle.atMm.x, y: handle.atMm.y + 800 }).y),
    };
    const firstDrop = handleDropTarget(v, firstPx, handle, field);
    expect(firstDrop.raw).toEqual({ x: 0, y: 800 });
    expect(firstDrop.mm).toEqual({ x: 40, y: 760 }); // 吸上了那枚既有点
    expect(legalDrop(doc, handle.wallId, handle.end, firstDrop.raw)).toBe(true);
    expect(legalDrop(doc, handle.wallId, handle.end, firstDrop.mm)).toBe(false);
    // ⇒ 探针报出来的必须是**别的一发**：不是那个非法的吸点，且它真能落
    expect(p!.targetMm).not.toEqual({ x: 40, y: 760 });
    expect(p!.toPx).not.toEqual(firstPx);
    expect(legalDrop(doc, p!.wallId, p!.end, p!.targetMm)).toBe(true);
  });

  it('探针的三枚像素在分数尺子下才见取整的牙齿：取整前是浮点，报出来全为整数', () => {
    // T5 那条「三枚像素全为整数」在样例房那份 `fitStorey(…, 1200, 900, 60)` 上是**假绿**：
    // 0.125px/mm 配百米毫米的坐标，取整前后本来就是同一个数（2026-09-28 实测：摘掉 `snapPx`
    // 八个进程零红）。这一份 1200×901 把尺子换成 781/6240 px/mm，把手与候选的像素全是浮点，
    // 于是那三句"整数"判的才真是取整这一步 —— 而它是 `--edit-shot`「落点逐字相等」的地基：
    // 主进程 `sendInputEvent` 只收整数 DIP，探针给浮点就是拿浮点跟主进程对赌。
    const frac = fitStorey(house.doc, house.lowerStoreyId, 1200, 901, 60);
    const p = dragProbe(
      house.doc,
      house.lowerStoreyId,
      buildDrawList(house.doc, house.lowerStoreyId, frac, EMPTY_SELECTION),
      frac,
    )!;
    const h = dragHandlesOf(house.doc, house.lowerStoreyId, sel(p.wallId), frac).find(
      (x) => x.end === p.end,
    )!;
    // 现场自证：这把把手的原生像素就是浮点 ⇒ 下面三句不是"本来就整数"蒙过去的
    expect(Number.isInteger(h.atPx.x) && Number.isInteger(h.atPx.y)).toBe(false);
    expect(Number.isInteger(p.fromPx.x) && Number.isInteger(p.fromPx.y)).toBe(true);
    expect(Number.isInteger(p.toPx.x) && Number.isInteger(p.toPx.y)).toBe(true);
    expect(Number.isInteger(p.anchorPx.x) && Number.isInteger(p.anchorPx.y)).toBe(true);
    // 报出来的像素 = 原生像素四舍五入，不是"另算一遍"：`fromPx` 与把手必须同源
    expect(p.fromPx).toEqual({ x: Math.round(h.atPx.x), y: Math.round(h.atPx.y) });
    // 取整那一发反算的毫米与真源现值不同 ⇒ 这一发真的被搬到了整数像素上
    expect(p.targetMm).not.toEqual(h.atMm);
    // 与 renderer 同一个调用：同一发整数像素再问一次，答案逐字相同（浮点尺子下这条更要紧）
    expect(
      handleDropTarget(frac, p.toPx, h, snapFieldOf(house.doc, house.lowerStoreyId)).mm,
    ).toEqual(p.targetMm);
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

  it('四种颜色两两之间最大通道差 > 2×PIXEL_CHANNEL_TOL ⇒ 像素计数不会串道', () => {
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
    // 分开写而不是套循环：红了直接知道是哪一对颜色串道，不必再反推 i/j。
    // T6 加第四色（吸附标记）：判据一字不改，只是每对都多一列要过同一把尺。
    const min = PIXEL_CHANNEL_TOL * 2;
    expect(spread(SELECTED, HANDLE_COLOR)).toBeGreaterThan(min);
    expect(spread(SELECTED, PREVIEW_COLOR)).toBeGreaterThan(min);
    expect(spread(SELECTED, SNAP_COLOR)).toBeGreaterThan(min);
    expect(spread(HANDLE_COLOR, PREVIEW_COLOR)).toBeGreaterThan(min);
    expect(spread(HANDLE_COLOR, SNAP_COLOR)).toBeGreaterThan(min);
    expect(spread(PREVIEW_COLOR, SNAP_COLOR)).toBeGreaterThan(min);
  });
});
```



Run: `npx vitest run packages/scene-2d/test/handles.test.ts > /tmp/t6s5-red.log 2>&1; echo exit=$?`
Expected: exit≠0，**`Tests 8 failed | 11 passed (19)`**（2026-09-28 实测的红态就是这两个数）。红的是本步 7 条新用例，加上 T5 那条被订正的第 3 点（`handleDropTarget(view, p.toPx, …)` 那一句），红字一律是 `TypeError: handleDropTarget is not a function`。T5 其余 11 条**必须全绿** —— 多一条红说明 A 段抄进了本步之外的东西，少一条红说明 `handleDropTarget` 不知从哪儿已经存在了。

同一条命令之外，`pnpm typecheck` 在这个中间状态**必然**报三类错，它们全是"① 那条迁移还没做完"的样子，B 块换完就消失 —— 别回头改测试迁就它：

- `src/index.ts` **TS2308**：`Module './snapping' has already exported a member named 'MoveTarget'`（`moveTargetOf` 同一条第二行）。`export *` 撞名就是"同一个类型住在两个文件"的机械证据，正是 ① 要消掉的东西。
- `test/handles.test.ts` **TS2305**：`Module '"@dajia/scene-2d"' has no exported member 'handleDropTarget'`。
- `test/handles.test.ts` **TS2353 / TS2339**：`anchorMm` 不在 `DragHandle` 上，十余处（合成分支、`atMm` 分居两端、把手按在原地那三条用例都在读它）。

---

**B. 整份替换 `packages/scene-2d/src/handles.ts`**

整份如下，逐字照抄。`index.ts` 不动（T5 已有 `export * from './handles'`，新出口 `handleDropTarget` 自动带出）。

```ts
import {
  endPointId,
  incidentWallEnds,
  requirePoint,
  wallAxisById,
  wallMoveEndpoint,
  type Document,
  type WallEnd,
} from '@dajia/core';
import { mmToPx, type Px, type Viewport } from './viewport';
import type { DrawOp, Selection } from './drawlist';
import { PICK_TOL_PX, pickOne } from './pick';
import {
  dropTargetOf,
  snapFieldOf,
  type DropTarget,
  type MoveTarget,
  type SnapField,
} from './snapping';

/**
 * 编辑器画在屏幕上、却**不进指令表**的那一层（Task 5 D2）：把手、拖拽临时线、
 * 以及"这个落点拖不拖得动"的预言。
 *
 * 为什么不进 `buildDrawList`：那张表是**图纸内容的投影** —— 计划 4 的像素判据与计划 5 的
 * 可施工图都直接吃它，把蓝点掺进去等于往施工图上印编辑器家具，而"指令表还是 31 条"
 * 这类回归判据恰好看不见多印了什么。代价是这个文件外面要再多两个画家（PlanCanvas 的
 * `paintHandles` / `paintPreview`），"只有一条绘制通路"这条纪律改由像素计数来守（Step 5/6）。
 *
 * T6 之后本文件不再自带"像素 → 毫米"：`MoveTarget` / `moveTargetOf` 搬进了 `snapping.ts`
 * （吸附必须接在换算之后，两者分居两文件就会长出第二条 px→mm 的路，那正是 D4 禁止的）。
 * 本文件因此只剩两个**读者**：`dragProbe` 吃 `dropTargetOf`（吸附后的落点，与 renderer 松手
 * 那一发同一个函数、同一个场），`legalDrop` 只吃已经定好的 `MoveTarget`。
 */

/**
 * 四种颜色给 `countPixels` 认道：选中（红）、把手（蓝）、临时线（绿）、吸附标记（橙，
 * 常量在 `snapping.ts` 的 `SNAP_COLOR`）。
 * 两两最大通道差必须 > 2×`PIXEL_CHANNEL_TOL`（`handles.test.ts` 最后一条钉死）：
 * 认色是按通道 ±TOL 开窗的，两种颜色挨太近时同一片像素会同时进两个桶，
 * Step 6 的 `handlePx` / `previewPx` 就全是假绿。#1668dc 与 #12b886 的差只在 G/B 上
 * （104↔184、220↔134，最大 86 > 80），挨得不远 —— 所以改任何一个字面量都要回去跑那条。
 */
export const HANDLE_COLOR = '#1668dc';
export const PREVIEW_COLOR = '#12b886';
export const PIXEL_CHANNEL_TOL = 40;
export const HANDLE_RADIUS_PX = 4.5;

/** 一枚可拖把手：`end` 与 `pointId` 配对钉死（计划 1 的角色反转 bug 就是这个配对松开过）。 */
export interface DragHandle {
  readonly wallId: string;
  readonly end: WallEnd;
  readonly pointId: string;
  /** 真源里那对整数毫米，直读实体，不做任何 px ↔ mm 往返。 */
  readonly atMm: MoveTarget;
  /** 它在线上的哪一端：与 `wallAxisById` 同源，所以和墙多边形永远对齐。 */
  readonly atPx: Px;
  /**
   * 另一端那对整数毫米：T6 的角度档（正交 / 15°）要一个**毫米**锚点，而 `anchorPx` 是浮点像素，
   * 拿它反算毫米会引入一次往返。与 `anchorPx` 同产地（都取自 `wallAxisById` 的另一端），
   * 所以两枚永远指同一头 —— 它不进 `dispatch`，只当锚，不必像 `atMm` 那样另立"直读实体"这一票。
   */
  readonly anchorMm: MoveTarget;
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
      const anchor = end === 'start' ? axis.end : axis.start;
      out.push({
        wallId: wall.id,
        end,
        pointId,
        // atMm 直读实体、atPx 走轴线：两个产地同一个数字，用例分别钉（H1）。
        // 只从轴取 atMm 的话，"轴算错了"和"点被人改了"会红在同一条断言上。
        atMm: { x: point.x, y: point.y },
        atPx: mmToPx(v, end === 'start' ? axis.start : axis.end),
        // anchorMm 与 anchorPx 同产地、同一端：角度档吃毫米，命中与探针吃像素。
        anchorMm: { x: anchor.x, y: anchor.y },
        anchorPx: mmToPx(v, anchor),
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

/**
 * 拖拽与松手**共用**的那一发落点：锚点与被排除的坐标都从把手自己身上取，两个调用点
 * （`dragProbe` 与 PlanCanvas 的 `onMove`/松手）拿到的是同一个函数、同一对参数。
 *
 * 这一层薄壳不是 convenience，是**把 S4 第二条纪律变成可红的判据**。分开写两遍时，"探针传
 * `null` 锚点 / 忘了排除"是可写的，而实测那种改坏时红时不红（2026-09-28 八个进程里红 5 个：
 * 落点是否依赖锚点取决于探针挑到哪一面墙）—— 拿不稳的判据不算凭据。收进这一个出口之后，
 * 改锚点/改排除只有"改出口"这一种写法，而它必然同时打到两个调用点：实测摘锚点红
 * 「拖拽路径真的在吃吸附」、摘排除红「把手按在原地那一发」，两条都是 8/8 进程逐字红。
 *
 * 说清楚它**不**保证什么：有人绕过本出口、在探针里另抄一遍 `dropTargetOf(...)` 并漏掉排除
 * （改坏清单 HE3），本层拦不住 —— 实测那条零红，恒等筛也兜不住它（HE3 + 摘掉恒等筛的联合
 * 改坏 HE4 同样零红，样例房那十发候选里没有一发吸回原地）。出口买到的是"参数只有一处可写"，
 * 不是"参数写错必然红"；后者靠的是判探针与 renderer 同一个调用那两条。
 */
export function handleDropTarget(
  v: Viewport,
  cursorPx: Px,
  h: DragHandle,
  field: SnapField,
): DropTarget {
  return dropTargetOf(v, cursorPx, h.anchorMm, field, { excludeMm: h.atMm });
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
 * `sendInputEvent` 只收整数 DIP，而 renderer 松手时算的是
 * `dropTargetOf(视图, 那一发整数像素, 锚点, 场, 排除原地)`。
 * 所以探针**先取整像素、再由像素定落点**：这样"探针给的毫米"与"屏幕上真会落下的毫米"
 * 是同一个纯函数的同一个输出，不是近似。反过来（先定毫米再算像素）会在 0.125 px/mm 这种
 * 比例上差出最多 4mm —— 回读判据就会变成"有时候差一点"的随机红。
 */
function snapPx(p: Px): Px {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/**
 * 候选落点按顺序试，第一个"**吸附之后**真的动了且合法"的赢。偏移全写成整数毫米 ⇒ 同一份文档、
 * 同一个视图，每次问都给出同一个靶子（"撤销后回到原值"这条判据的前提就是靶子可复现）。
 *
 * 这一串候选**会**被吸走，别把"偏移取得远"当成"吸不上"。样例房一层 16 把把手 × 这十发 = 160 问
 * （2026-09-28 实测，十个进程逐字相同）：86 问吸上了东西，其中 72 问吸成**恒等** —— 垂足 54、
 * 正交 17、中点 1，那些落点本来就在自己那面墙的轴线上，吸附只是原样还回来；剩下 14 问被 15° 档
 * 挪走，最大位移 55.79mm = 6.97px（仍在 `SNAP_TOL_PX` 之内），且这 160 问的落点**在 Task 6 落地时**全部过得了 `legalDrop`。
 * （Task 7 把派生复核搬进 `wallMoveEndpoint.build` 之后这一句不再成立：160 发里 `build` 拒 84 发、全是 star，
 * 可拖 76 发，且"第一发可拖"从第 0 发挪到第 1 发的有 **16 把把手里的 12 把**（去重是 8 个位置，另外 4 把不动）—— 实测见 Task 7 的 T6 交接第 ④ 条。）
 * 所以"整数百米毫米"买到的是靶子可复现与恒等落点上的稳定，不是"探针不吃吸附"。
 *
 * `handles.test.ts` 的「拖拽路径真的在吃吸附」把这几个计数钉成判据（恒等 ≥ 8、改写 ≥ 1、
 * 改写只许来自 `angle15`）。它红的那天不是回归，是要回来重量的那天：`--edit-shot` 的
 * "松手落点逐字等于探针给的毫米"仍成立（两边同吃 `dropTargetOf`），但"拖了 800mm"这类
 * 位移预期从此不再等于偏移本身 —— 到那天要改的是判据，不是把吸附从拖拽路径上摘掉。
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
  // 场在入口取一次：`snapFieldOf` 要展开本层全部墙与点，放在候选循环里就是 O(候选² × 墙)。
  // 判据（`--edit-shot` 逐字相等）要的是"探针与 renderer 同一个函数、同一个场"，不是"更快一点"。
  const field = snapFieldOf(doc, storeyId);
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
      // 与 renderer 松手那一发**同一个调用**：`handleDropTarget(视图, 那一发整数像素, 这把把手, 场)`。
      // 锚点与排除集都在那个出口里从把手身上取（见它的注释）：原地要排掉的是**被拖那枚点的坐标**
      // 而不是 `pointId`（原地同时是端点候选又是它自己轴线上的垂足），锚点要给另一端，角度档才有方向可对齐。
      const { mm: targetMm } = handleDropTarget(v, toPx, h, field);
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


> **四处形状，执行时最容易"顺手改平"的地方**：
>
> ① `legalDrop` 的 `catch` 是**宽到一切异常**的，且它试跑的是真命令的 `build`。别收紧它、也别在屏幕上重写轴长比较（改坏 HD6 实测：换成"自己算 `hypot(target, anchor) > thickness`"红两条 —— 「legalDrop 就是真源那道守卫的预言」与「探针吃的是吸附后的毫米」。第二那条是 T6 新长的牙：自算那一版漏掉的是**邻墙**那两道，而吸上去那一发恰好撞在邻墙的墙厚上）。
> 还要记下它**没有**覆盖的东西：`build` 不跑 `deriveStoreyGeometry`，所以"这一发拖出一个星形接头（≥3 个方向过同一点）"在 `legalDrop` 这里预言为合法，松手后却在派生层抛。**Task 6 实测：真窗口里走得到**（草稿起点复用既有端点 ⇒ 往共享点加臂；样例房 8 枚角点 × 6 个角度 = 48/48 发在重绘时抛）。屏幕上现由 paint effect 那层 `try/catch` 兜住（`lastError`「画不出来：…」，白屏不再发生、`__dajiaDebug` 的引用留得住），但**兜住不等于挡住** —— 命令层仍会落盘（实测一次 `depth 30→31`），所以这条差额**记在 Task 7 的边界表里**，不许在 UI 侧另搭一套星形预判 —— 那是复述派生规则，复述的规则一定漂。
>
> ② `PROBE_OFFSETS` 那十发**会被吸走**，别把"偏移取得远"读成"探针不吃吸附"。样例房 16 把把手 × 10 发 = 160 问（2026-09-28 实测，十个进程逐字相同）：86 问吸上了东西，其中 72 问吸成**恒等**（垂足 54、正交 17、中点 1 —— 那些落点本来就在自己那面墙的轴线上，吸附只是原样还回来），剩下 14 问被 15° 档挪走，最大位移 55.79mm = 6.97px，仍在 `SNAP_TOL_PX` 之内；160 问的落点全部过得了 `legalDrop`（**这一句只对 Task 6 落地时成立** —— Task 7 的复核进了 `build` 之后是 76/160 过、84 发拒于 star，见 Task 7 的 T6 交接第 ④ 条）。所以"整数百米毫米"买到的是**靶子可复现**与恒等落点上的稳定，不是"探针免疫吸附"。这个计数同时是 A 块那条 sweep 用例的判据来源（它只要求 `identity ≥ 8`、`rewritten ≥ 1`、改写只许来自 `angle15`）。
>
> ③ `dragProbe` 里恒等筛那句（`targetMm === h.atMm` 就换下一个候选）在现有夹具下**单独摘掉不红**（HB6 实测 8/8 进程零红），它的凭据是联合改坏 HE1（插 `{0,0}` + 摘筛 ⇒ 红 3 条）。这不代表可以删掉它：`--edit-shot` 的"撤销后回到原值"判的前提是探针报出的**必然不是原地空放**，而那个前提靠的就是这一句。同理第 12 条筛（`pickOne` 必须选中被拖那面墙，HC4）在单测里零红，凭据在 Step 7 的真窗口闸门 —— 与 T5 的处置口径一字不差。
>
> ④ `handleDropTarget` 是本文件唯一允许出现 `anchorMm` / `atMm` 作为**吸附入参**的地方。`dragProbe` 与 renderer 的松手分支都调它；谁要是直接写 `dropTargetOf(v, toPx, h.anchorMm, …)`，S4 ② 那条纪律就从"没有写法"退回"多半会红"（HE3 实测：那样写并漏掉排除，19 条一条都不红）。

Run: `npx vitest run packages/scene-2d/test/handles.test.ts > /tmp/t6s5-green.log 2>&1; echo exit=$?`
Expected: exit=0，**`Tests 19 passed`**。同一条命令**连跑十个进程**，每次都得 `19 passed`（2026-09-28 实测十个进程逐字相同）—— 这一份里有 `dragProbe` 与吸附场，两者的靶子都吃 uuidv7 的建序，"偶尔红"在这一层不是可接受的绿：`--edit-shot` 的逐字对账要的是同一个靶子，靶子换面墙就是拿判据赌运气。真赌不起的那两处（HB4 / HB3 各自附带的那一句，见 C 段第 6、7 行）已经改写成"性质判据"而不是"具体靶子判据"。

---

**C. 改坏验证（24 条，红在哪一条、红成什么数都是 2026-09-28 实测的，不是推演）**

每条改 `packages/scene-2d/src/handles.ts` 一次、跑 `test/handles.test.ts`（19 条）、跑完立刻改回。标了"8/8"的是同一条改坏连跑八个进程逐字相同的；标了比例的（第 6、7 行）是那一条改坏在八个进程里红得**不全**，比例实测写在括号里。

1. **HA1** `anchorMm` 写成本端（`{ x: point.x, y: point.y }`）（16/3）→ 「anchorMm 是另一端…」「anchorMm 就是压扁拖那一发」「拖拽路径真的在吃吸附」。第一、二条判字段，第三条判它进了吸附。
2. **HA2** `anchorMm` 两端取反（`end === 'start' ? axis.start : axis.end`）（14/5）→ HA1 那三条 + 「空选中集没有把手…」（`anchorPx` 与 `atPx` 互换后配对判据红）+ 「探针给的落点必然合法…」（锚点那一发不再必然不合法）。**这一发与 T5 第 1 条是同一类角色反转，只是落在新字段上。**
3. **HA3** `anchorMm` 改走 px↔mm 往返（`pxToMm(v, mmToPx(v, anchor))` 再取整）（**19/0，八次全绿，不许红**）→ 反向哨兵：整数毫米一轮往返还是它自己，这条改动只多算不改变输出。它存在的意义是把"第 1、2 条的红"与"实现整体崩了"分开。真要钉"不许往返"，靠的是 `atMm` 与 `atPx` 分别比对不同产地那两句（T5 第 3 条同款，一字未改地沿用）。
4. **HB1** 出口不传锚点（`dropTargetOf(v, cursorPx, null, field, { excludeMm: h.atMm })`）（18/1，**8/8 恒**）→ 恒红「拖拽路径真的在吃吸附」。
5. **HB2** 出口不排原地（去掉 `{ excludeMm: h.atMm }`）（18/1，**8/8 恒**）→ 恒红「把手按在原地那一发：排掉自己就谁也不吸，不排就吸回自己」。这一发在屏幕上就是"一松手墙没动"。
6. **HB3** 探针传 `EMPTY_SNAP_FIELD`（仍走 `dropTargetOf`，等于把吸附整个摘掉）（17/2 七次、16/3 一次）→ 恒红两条（8/8）：「探针吃的是吸附后的毫米」与「合法性判的是吸附后的毫米」；**偶发红**「探针的三枚像素在分数尺子下…」八次一次 —— 那一发的靶子随 uuidv7 换把手。**这一行是"锚点/排除收进出口"最直接的对照**：摘掉场是探针与 renderer 一起摘，行为变了但等式还在，所以红来自判落点内容的两条用例，不是判恒等式的那条。
7. **HB4** 探针换回 `moveTargetOf`（T5 原样：吸附整个不接）（八个进程：15/4 两次、16/3 五次、17/2 两次）→ 恒红两条（8/8，同 HB3）；**偶发红**「三枚像素在分数尺子下」八次六、「探针给的落点必然合法…」八次二 —— 后一条红的正是第 3 点那句恒等式，**它现在只判"两边同一个调用"，不判"落点等于裸毫米"**，所以摘掉吸附时它反倒可能不红：这条用例的牙齿在第 8 行。
8. **HB5** `legalDrop` 判吸附**之前**（`legalDrop(doc, h.wallId, h.end, drop.raw)`，dispatch 仍发 `drop.mm`）（18/1，**8/8 恒**）→ 恒红「合法性判的是吸附后的毫米：裸对角合法、吸上去那一发被 240 厚墙挡下」。**这一行在 T5 的清单里没有对应物**，它是 T6 新长的牙；上一批夹具里裸与吸两侧都合法（260 问 0 分歧），所以它为真必须新搭一层 —— 别把那条用例读成"和第 7 条重复"。
   > **执行订正（2026-09-29，`d642466` 与 `48417e0` 上各 3–8 进程实测；这一行按写下的样子不成立）**：双锚精确变异（`const { mm: targetMm, raw: hb5raw } = handleDropTarget(...)` 后只把 `legalDrop` 那一侧换成 `hb5raw`，dispatch 仍发 `.mm`）实测 **8/8 与 3/3 全绿**（`Tests 20 passed (20)`）。根因不是用例弱，也不是"夹具里没有两种答案"（第 19 条用例证的正是裸合法 / 吸上去非法），而是**调用链上两道筛互相遮蔽**：`handles.ts` 的 `derivesAfterMove` 跑的是**同一个** `wallMoveEndpoint(...).build(doc)` 再加 `deriveStoreyGeometry` ⇒ 它是 `legalDrop` 的严格超集 ⇒ `legalDrop(mm) && derivesAfterMove(mm)` 与 `legalDrop(raw) && derivesAfterMove(mm)` 的差集只在 `derivesAfterMove(mm)=true 且 legalDrop(raw)=false` 时非空 —— 也就是需要一枚**裸落点建不出、吸上去反而建得出**的候选，而这条夹具给的是反方向（裸合法、吸上去被 240 厚墙挡下），那个方向恒被遮蔽。**结论**：本行的靶子方向与遮蔽方向重合 ⇒ 在**探针链上**按现状没有牙齿（第 19 条用例直接喂 `legalDrop` 两个入参比对，它证的是"夹具里真存在分歧"，不替探针的调用点背书）。**T7 的 6.7 已经把靶子换成有牙齿的那一侧**（裸落点拧成 star ⇒ `legalDrop(raw)=false`，吸回贯通线 ⇒ `derivesAfterMove(mm)=true`，差集非空、遮蔽解套）⇒ T7 执行日复测 HB5 的口径是「恰好红 6.6 与 6.7」，**不许**回到本条夹具复测。摘 `derivesAfterMove` 不是选项（它是 T5 star 白屏的治法）。已登记给 **T7**（见本文件末尾挂账总账那一行）。
9. **HB6** 摘掉恒等筛（**19/0，8/8 全绿**）→ 诚实记录：样例房那十发候选里，第一把通过其余筛的把手报出来的落点本来就不是原地，所以这一句单独摘掉没有可见后果。它防的是"候选表以后加进会吸回原地的偏移"，凭据在第 21 行的联合改坏。**不许为它单独造用例**（造出来的那条只会判"筛存在"，不判"筛有用"）。
10. **HC1** `PROBE_OFFSETS` 最前面插 `{ x: 0, y: 0 }`（**19/0，8/8 全绿**）→ **T5 改坏清单第 9 条说"探针那条必须红"，实测不红**：恒等筛把 `{0,0}` 那一发挡掉了。这不说明 T5 那条用例写空，只说明那一条判据的地基是"筛 + 候选表"这一对，拆开各都不承重 —— 见第 21 行。
11. **HC2** 摘掉 `snapPx`（返回原浮点）（18/1，**8/8 恒**）→ 恒红「探针的三枚像素在分数尺子下才见取整的牙齿」。**这是对 T5 第 10 条的订正**：原清单说"样例房那三句『整数』必须红"，实测在 `fitStorey(…, 1200, 900, 60)` 那把 0.125px/mm 的尺子上**一条都不红**（百米毫米的坐标取整前后本来就是同一个数 —— 假绿）。牙齿挪到了 1200×901 那份 `781/6240` px/mm 的尺子上，那条用例自己带"现场自证原生像素是浮点"的一句。
12. **HC3** 像素↔毫米反向对调（`toPx` 不取整、落点改由 `snapPx(h.atPx)` 算）（14/5）→ 五条同时红：「探针给的落点必然合法…」、sweep 那条、两条"吸附后的毫米"、分数尺子那条。整段写反有牙齿，与第 11 行是两种粒度。
13. **HC4** 摘掉"按在把手上必须先选中那面墙"（**19/0，8/8 全绿**）→ 与 T5 第 12 条同判：**不保证红**，接头处哪面墙赢吃 uuidv7。凭据在 Step 7 的 `--draw-shot`（`selectedAfterPress === 被拖那面墙`）。改了不红，也不许反过来删探针那一句。
14. **HD1** `dragHandlesOf` 摘掉墙种筛（18/1）→ 「别层的墙、洞口 id、楼层 id…」。红在 `requirePoint` 的 `TypeError`，不是断言 —— 它守的是入口（T5 第 1 条原样沿用）。
15. **HD2** `dragHandlesOf` 摘掉层筛（18/1）→ 同一条用例，红在"给了 2 个把手"。二层的墙在一层长出把手 ⇒ 一发拖动能改两层坐标。
16. **HD3** `handleKey` 从 `${wallId}:${end}` 改成只按 `end`（16/3）→ 「把手顺序与选中集的插入顺序无关」+ `pickHandle` 的 NaN 那条 + 「同一枚共享点上并列的两把把手」。
17. **HD4** `pickHandle` 的 `!(dist <= tolPx)` 改成 `if (dist > tolPx) continue`（18/1）→ NaN 那条（NaN 比较恒 false ⇒ 第一把被当成命中）。与 T4 第 8 条、T5 第 5 条同源。
18. **HD5** 并列时不比 key（18/1）→ `pickHandle([...tied].reverse(), …)` 那句（答案跟着数组顺序翻）。真实路径上两句都不红 —— 这对 synthetic 并列把手是这条判据唯一的牙齿（T5 第 6 条原样沿用）。
19. **HD6** `legalDrop` 换成只判被拖这面墙（17/2）→ 「legalDrop 就是真源那道守卫的预言」+「探针吃的是吸附后的毫米」。见上方 ①：屏幕上自算判据，算的永远是"我这一面"。
20. **HD7** `pointSnapshot` 摘掉层筛（18/1）→ 「键集合恰是本层墙端点的去重集」（别层的点漏进来）。T5 第 13 条原样沿用。
21. **HE1** 插 `{0,0}` **且**摘掉恒等筛（第 10 + 第 9 行联合）（16/3）→ 三条红：「探针给的落点必然合法…」（落点退回原地）、sweep 那条、「探针吃的是吸附后的毫米」。**这一行才是第 9、10 两行的凭据**：恒等筛与候选表是一对，只在两者同时被改时才说话 —— 而 `--edit-shot` 的"撤销后回到原值"判的就是这一对。
22. **HE2** 出口锚点写成 `h.atMm`（锚点 = 原地，角度档失去方向但不报错）（18/1，**8/8 恒**）→ 恒红「拖拽路径真的在吃吸附」。与第 4 行同一个红法：出口里那两个参数只有一处可写，写错就必然打到两条调用点。
23. **HE3** 探针**绕开**出口、自己另抄一遍 `dropTargetOf(v, toPx, h.anchorMm, field)`（漏掉排除）（**19/0，8/8 全绿**）→ 诚实记录：这一层拦不住"故意绕开出口"的人。它不是"可以绕"的许可证 —— 判据是第 5、22 两行：只要参数写在出口里，改它们就恒红。补一条用例去抓 HE3 就是假绿（它只能判"探针调了哪个函数"，而那已经由源码结构决定）。
24. **HE4** 绕开出口 + 摘掉恒等筛（**19/0，8/8 全绿**）→ 与第 23 行同组：恒等筛也兜不住它（样例房那十发里没有一发"绕开排除后吸回原地"的候选）。**第 9 行那句"恒等筛防的是候选表将来加偏移"在这里仍然成立，别把 HE4 读成"恒等筛没用"，也别读成"排除可以不传"。**

1–2、4–5、6–8、11–12、14–22 里任何一条"改坏了还绿"，说明对应断言写空了，就地补到能红为止。第 **3、9、10、13、23、24** 六条反过来，**必须基本还绿**，且各自不承重的原因不同：3 是**反向哨兵**（整数毫米往返是它自己）；9 与 10 是**一对**（恒等筛 × 候选表，拆开都不承重，联合红三条 = 第 21 行）；13 是**判据不在单元层**（凭据在 Step 7 闸门）；23 与 24 是**结构约束的边界**（出口拦不住绕开它的人，也不假装拦得住）。六条都不许删，也不许为它们补用例 —— 把上面这几段理由原样写进代码注释与本节，否则下一个执行的人会来"补测试"，补出来的必然假绿。

> **两处"红了但不是凭据"的偶发**（第 6、7 行各自附带的那一句），原因和 Step 4 开头第 ③ 条同一颗：探针挑哪面墙吃 `byKind` 的 uuidv7 序。处置口径也照抄：**判据不许靠"多半会红"** —— 恒红的那几条（HB1 / HB2 / HB5 / HE2 / HC2 / HA3）就是凭据，偶发的那两句（「三枚像素在分数尺子下…」与「探针给的落点必然合法…」的恒等式）在这两行上不算凭据，它们在别的行上是（第 11、12 行）。

> **交接给 Task 7 的两条**：① `legalDrop` 只试跑 `build`，**不跑派生层** ⇒ "拖出一颗星形接头"这一发会被预言为合法、在重绘时抛（① 里已写明）。**真窗口里 Task 6 已经走到了**（拉墙草稿按在既有角点上就能把三臂拧成 star，实测 48/48 发起），屏幕侧只有一层 `lastError` 保险、命令照旧落盘 ⇒ T7 的派生复核**不是"以后可达才要"，是现在就要**。要补的仍是**派生层复核**（core 侧），不是 UI 侧再算一遍接头分类。② 凡"探针/命令挑哪个候选"进判据，都必须自带同坐标的合成夹具（本步第 8 行那层"共线两面 + 一枚游离点"就是这么搭的）；样例房只能提供**性质**，不能提供**靶子**。

- [ ] **Step 6: desktop —— renderer 接线：工具态、草稿、删除派发、第四色标记**

这一层只做**装配**：`snapping.ts` 答"落在哪"、`editing.ts` 答"要不要发命令"、`handles.ts` 答"接得到哪枚点"，PlanCanvas 把三者按到指针事件与画布上，自己**不长出任何一条判据**（T4/T5 的"一条绘制通路 + 屏幕侧零判据"纪律在这里继续生效）。屏幕侧唯一的"判据"是那 9 个诊断字段 —— 它们不是断言，是给 Step 7 那道真窗口闸门读的读数。

三个文件都是**整份替换**（`apps/desktop/src/renderer/src/` 下）。先 `stores/`：

`stores/editorStore.ts` —— T5 那份的基础上加 `tool` / `draft` / `setTool` / `setDraft` / `dispatchBatch`，并给 `DragState` 补两个字段（`handle` 与 `drop`，S4 ② 要求锚点与排除集**只能从按下那一把把手上取**）：

```ts
import { create } from 'zustand';
import type { Command, TransactionLog, WallEnd } from '@dajia/core';
import {
  demoHouse,
  type DraftWall,
  type DragHandle,
  type DropTarget,
  type MoveTarget,
  type Px,
  type Tool,
  type Viewport,
} from '@dajia/scene-2d';

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
  /**
   * 按下命中的那把把手（S4 ②）：吸附的**锚点**（`handle.anchorMm`）与**排除集**
   * （`handle.atMm`）都长在它身上，所以拖拽态必须带上它 —— 不带就只能在 `onMove` 里
   * 重算 `pickHandle`，而重算出来的把手与按下那一把不是同一个对象，中途换墙就是改语义。
   */
  readonly handle: DragHandle;
  /**
   * 吸附后的完整落点（`raw` / `mm` / `snap`）。`targetMm` 恒等于 `drop.mm`，两个字段都留着
   * 是因为 T5 的三处判据（noop 比对、`wallMoveEndpoint` 入参、`DropReport.targetMm`）写的是
   * `targetMm`，而第四色标记要读的是 `drop.snap`。按下那一发 `drop === null`（S4 ①：不吸）。
   */
  readonly drop: DropTarget | null;
}

export interface EditorState {
  readonly log: TransactionLog;
  readonly storeyId: string;
  /** null = 还没量过窗口尺寸，一帧都还没画 */
  readonly viewport: Viewport | null;
  /**
   * 唯一的"该重绘了"扳机（D6）。`log` 是可变类实例，引用永远不变 ⇒ zustand 的
   * `Object.is` 判定相等 ⇒ 只订阅 `{log}` 的组件**永不重渲**，所以这不是保险，是唯一的通路。
   * 它只在 `dispatch`/`dispatchBatch`/`undo`/`redo` **成功**之后 +1：失败不动它 ⇒ 既不重绘也无副作用，
   * 于是计划 2 转下游 #11（`log.lastAffected` 在抛错后留着上一批 id）在本任务里根本没有读者。
   */
  readonly revision: number;
  readonly lastError: string | null;
  readonly drag: DragState | null;
  /** 工具态。`'wall'` 时不画把手、点选不生效，按下即起草稿（S2 的屏幕侧形状）。 */
  readonly tool: Tool;
  /** 进行中的墙草稿。中途只活在这里，不进真源（与 `drag` 同一条 D4 纪律）。 */
  readonly draft: DraftWall | null;
  setViewport: (viewport: Viewport | null) => void;
  setDrag: (drag: DragState | null) => void;
  setTool: (tool: Tool) => void;
  setDraft: (draft: DraftWall | null) => void;
  dispatch: (cmd: Command) => void;
  /** 一批命令 = 一个循环，**不是一个事务**（见下面那条注释）。 */
  dispatchBatch: (cmds: readonly Command[]) => void;
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
  tool: 'select',
  draft: null,
  setViewport: (viewport) => set({ viewport }),
  setDrag: (drag) => set({ drag }),
  setTool: (tool) => set({ tool }),
  setDraft: (draft) => set({ draft }),
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
  /**
   * 删除走这里，拉墙仍走 `dispatch`（一条命令一条路，别为了"统一"把单发也套进循环）。
   *
   * **它不是一个事务**：读过源码，`TransactionLog` 只有 `dispatch` / `undo` / `redo` 三个动作
   * 与 `affected` / `depth` / `canUndo` / `canRedo` 四个读数，没有 begin/commit/rollback。
   * 所以一次删除（N 面墙 + M 樘独立洞口）= 撤销栈上的 **N+M 步**，连按 Ctrl+Z 会一条条退回去；
   * 而 `S5` 排的"洞口在前、墙在后"保证了第 ② 条命令不会 `requireOpening` 抛在半途 ——
   * 顺序反了才真会留下半套状态（那条由 `editing.test.ts` 的 E1 钉住）。
   * 代价照付：批语义（一次撤销退一整组）是计划 4 真源侧的决定，UI 不许私自拿
   * "连发多条 + 出错回滚" 拼一个假事务：回滚要逆序重放补丁，那是第二套 `invertPatch`。
   */
  dispatchBatch: (cmds) => {
    const log = get().log;
    let applied = 0;
    let failed: string | null = null;
    for (const cmd of cmds) {
      try {
        log.dispatch(cmd);
        applied += 1;
      } catch (err) {
        failed = String(err);
        break;
      }
    }
    // 应用了几条就只 +1 一次 revision：扳机管的是"该重绘了"，不是"重绘几次"。
    // 半途失败时 `applied > 0` 也要 +1 —— 真源已经变了，不动它才是"屏幕画旧账"。
    set((s) => ({
      revision: applied > 0 ? s.revision + 1 : s.revision,
      lastError: failed === null ? null : `删不动：${failed}`,
    }));
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


`stores/selectionStore.ts` —— 只多一个出口 `retain`（删除后的剪枝走它，`undo` / `redo` 不走它）：

```ts
import { create } from 'zustand';

export interface SelectionState {
  readonly ids: ReadonlySet<string>;
  select: (id: string) => void;
  toggle: (id: string) => void;
  clear: () => void;
  retain: (keep: Iterable<string>) => void;
}

/**
 * 选中集独立于 editorStore：spec 明令它不进真源、不进撤销栈、不落库（关窗口就该忘掉，
 * 撤销一次拖拽不该顺手改回选中）。这里每次返回**新的 Set** —— 原地 add/delete 让
 * zustand 的 `Object.is` 判定相等、订阅者不重渲，屏幕就不跟着红，那是"点了没反应"里最难查的一种。
 * 重复点同一个构件、清空已经空的集，都原样返回 state：不为了"看着安全"多刷一帧。
 *
 * `retain` 是**删除之后**的剪枝：屏幕上不去猜"这条命令的补丁会收走哪些 id"，真源落完之后拿
 * `doc.get(id)` 问一遍（`pruneSelection` 就是那一问）。`undo` / `redo` **不走**它 —— D7 判过
 * "撤销的是文档，不是视图"，于是撤销掉一面正被选中的墙之后，选中集里会留一个不存在的 id。
 * 那无害（`buildDrawList` 与 `dragHandlesOf` 都按 `doc.get` 找不到就跳过），但它是 Task 8 的接缝。
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
  retain: (keep) =>
    set((s) => {
      const allowed = new Set(keep);
      const next = new Set([...s.ids].filter((id) => allowed.has(id)));
      // `next` 是 `s.ids` 的子集，所以"元素个数相等"就等价于"集合相等"⇒ 一个都没剪掉时
      // 原样返回 state：换了新 Set 的引用会让订阅者白重渲一帧，画的是同一张图。
      if (next.size === s.ids.size) return s;
      return { ids: next };
    }),
}));
```


`PlanCanvas.tsx` —— 整份替换。它是本任务最长的一块，但**没有一处判断是新的**：每一句都在调 scene-2d 的出口，或者在把读数搬到诊断字段上。

```ts
import { useEffect, useRef } from 'react';
import { requirePoint, wallMoveEndpoint } from '@dajia/core';
import {
  buildDrawList,
  draftAtPress,
  draftCommand,
  dragHandlesOf,
  dragProbe,
  dropTargetOf,
  EMPTY_SNAP_FIELD,
  fitStorey,
  HANDLE_COLOR,
  HANDLE_RADIUS_PX,
  handleDropTarget,
  lastCreatedWall,
  legalWallCreate,
  mmToPx,
  moveDraft,
  moveTargetOf,
  newWallDefaults,
  pickHandle,
  pickOne,
  PIXEL_CHANNEL_TOL,
  planDelete,
  pointSnapshot,
  PREVIEW_COLOR,
  probeTarget,
  pruneSelection,
  SNAP_COLOR,
  SNAP_MARK_HALF_PX,
  snapFieldOf,
  SELECTED,
  wallProbe,
  type DeleteOutcome,
  type DragHandle,
  type DragProbe,
  type DrawOp,
  type DraftWall,
  type Pen,
  type PickProbe,
  type Px,
  type SnapField,
  type Tool,
  type WallProbe,
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

/** 松手那一发拉出来的墙。`'rejected'` = 草稿 `legal === false`，**一条命令都没发**；`'failed'` = 发了但真源抛。 */
export interface CreateReport {
  outcome: 'ok' | 'rejected' | 'failed';
  wallId: string | null;
  /** 派发成功后从真源读的两端点 id（S6 的三票之一：`affected` 给 id，`doc.get` 复核存在）。 */
  startId: string | null;
  endId: string | null;
  /** 松手前草稿的终点毫米。命令入参可能是一支 `{ pointId }`（没有毫米），所以账要记在落点上。 */
  endMm: { x: number; y: number } | null;
  /** 本层点数的前后两次读数：新建一面全新终点的墙 ⇒ +1，删回去 ⇒ 回到原值。 */
  pointCountBefore: number;
  pointCountAfter: number;
}

/**
 * `w` / `Escape` / `Delete` / `Backspace` 的回声，与 `KeyEventReport` 同一套 `seq` 机理
 * （T5 D8 那条理由在这里原样成立：`combo` 只证"回声的是哪一发"，等它变大抓不到"到过 renderer"）。
 * 单独一份而不是塞进 `KeyEventReport`：撤销/重做那一发不碰工具态，这里每一发都碰。
 */
export interface HotkeyReport {
  seq: number;
  combo: string;
  /** 这一发处理完之后的工具态：`w` 与 `Escape` 的凭据就在它身上。 */
  tool: Tool;
  /** 这一发处理完还有没有草稿（Escape 取消、松手、被拒都该让它变 false）。 */
  draftActive: boolean;
  /** 只有 `Delete` / `Backspace` 那一发给值；其余快捷键给 null。四色判"沉默是哪一种沉默"（S5）。 */
  deleteOutcome: DeleteOutcome | null;
  depth: number;
  revision: number;
  lastError: string | null;
}

/** 本层的点数。`points` 快照的键集合就是它，所以这里不再数第二遍（两个真值来源必漂）。 */
function pointCountOf(points: Record<string, { x: number; y: number }>): number {
  return Object.keys(points).length;
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
  // ↓ T5 的 14 个
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
  // ↓ T6 的 9 个
  tool: Tool;
  /** 进行中的草稿（含两端落点、吸附结论、合法性）。null = 没在拉墙。 */
  draft: DraftWall | null;
  /** 第四色像素总数。**只证"那一刻吸附了"，不证吸到哪**（S8）：位置的对账走毫米。 */
  snapMarkPx: number;
  lastCreate: CreateReport | null;
  /** 最后一次删除计划真的发出命令的 id（与 `commands` 同序）。 */
  deletedIds: string[];
  /** 最后一次删除计划留给 Task 8 的 id。样例房里恒空 —— 那儿没有柱板可删，字段是接线凭据不是分支凭据。 */
  unsupportedIds: string[];
  /** 删除剪枝**之后**的选中集（`pruneSelection` 的答案直接落在这儿，不经过 store 二次推导）。 */
  selectionAfterDelete: string[];
  lastHotkey: HotkeyReport | null;
  /** 拉墙的靶子：与 `edit` 同一条纪律 —— 主进程只读它，不猜坐标（`pxPerMm` 住在 renderer）。 */
  draw: WallProbe | null;
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
const SNAP_RGB = rgbOf(SNAP_COLOR);

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
  snapMarkPx: 0,
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

/**
 * 吸附标记：一枚 5×5 的实心方块，画在**吸附后的落点**上（不是光标上 —— 光标那儿已经有
 * `paintPreview` 的绿点）。它是第四色，所以它唯一能证的事是"这一发光标确实被吸走了"；
 * 吸到哪一律走毫米（`draft.end.mm` / `lastCreate.endMm`），像素不参与对账。
 *
 * `left/top` 先取整再画：`mmToPx` 给浮点，浮点原点的 `fillRect` 会把 5×5 摊成 6×6 的
 * 半透明边，而 `nearChannel` 的 ±40 容差吃不下与白底混过色的高通道（`#ff8a00` 的 G=138，
 * 五成混白就是 196 > 178）—— 于是同一个标记在两种视图下数出来是 25 与 0。
 * 取整之后恒 25 个纯色像素（`SNAP_MARK_HALF_PX * 2` 见 `snapping.ts`）。
 */
function paintSnapMarker(ctx: CanvasRenderingContext2D, atPx: Px): void {
  ctx.fillStyle = SNAP_COLOR;
  ctx.fillRect(
    Math.round(atPx.x - SNAP_MARK_HALF_PX),
    Math.round(atPx.y - SNAP_MARK_HALF_PX),
    SNAP_MARK_HALF_PX * 2,
    SNAP_MARK_HALF_PX * 2,
  );
}

interface Buckets {
  nonBlankPx: number;
  selectedPx: number;
  handlePx: number;
  previewPx: number;
  previewNearCursorPx: number;
  snapMarkPx: number;
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
    snapMarkPx: 0,
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
    // 第六桶**不开位置窗口**：标记就画在吸附后的落点上，而落点在哪儿正是判据要问的东西 ——
    // 拿"落点像素"当窗口去数自己的像素，等于用结论证结论。所以这一桶只数颜色，位置对账一律走毫米。
    if (nearChannel(r, SNAP_RGB[0]) && nearChannel(g, SNAP_RGB[1]) && nearChannel(b, SNAP_RGB[2])) {
      out.snapMarkPx += 1;
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
  // T6 起它同时表示"这串手势归我管"：把手拖与拉墙的按下都置 true，`onMove`/`onUp` 再按
  // store 里是 `drag` 还是 `draft` 分岔 —— 两条路共用一个手势标志，因为一次按下只会走一条。
  const activeRef = useRef<boolean>(false);
  // 吸附的场：paint effect 每次上屏时刷新，指针事件只读不建（`snapFieldOf` 要展开本层全部墙，
  // 放在 `pointermove` 里就是每发一次整层遍历）。它必须是**刷上屏那一份**：场与屏幕不同步，
  // 判据就会说"吸上了一个屏幕上根本不存在的东西"。
  const fieldRef = useRef<SnapField>(EMPTY_SNAP_FIELD);
  /** 最后一次删除计划的三本账（发出的 / 留给 Task 8 的 / 剪完之后剩下的），给 `__dajiaDebug` 读。 */
  const deleteRef = useRef<{
    deletedIds: string[];
    unsupportedIds: string[];
    selectionAfterDelete: string[];
  }>({ deletedIds: [], unsupportedIds: [], selectionAfterDelete: [] });
  /** 最后一次拉墙的回执（`CreateReport`）。同 `dropRef`：诊断值，不进 paint 依赖。 */
  const createRef = useRef<CreateReport | null>(null);
  const hotRef = useRef<HotkeyReport | null>(null);
  /** 只数 `w`/`Escape`/`Delete`/`Backspace` 这一路，与 `keySeqRef` 各数各的（见 `HotkeyReport`）。 */
  const hotSeqRef = useRef<number>(0);

  const log = useEditor((s) => s.log);
  const storeyId = useEditor((s) => s.storeyId);
  const viewport = useEditor((s) => s.viewport);
  const revision = useEditor((s) => s.revision);
  const drag = useEditor((s) => s.drag);
  const tool = useEditor((s) => s.tool);
  const draft = useEditor((s) => s.draft);
  const setViewport = useEditor((s) => s.setViewport);
  const setDrag = useEditor((s) => s.setDrag);
  // `setTool` / `dispatchBatch` 不在这里取：只有快捷键那一路用它们，而那一路全部走
  // `useEditor.getState()`（闭包不捕获会变的东西 ⇒ 依赖表留空才是诚实的）。
  // `setDraft` 要取：按下/移动/松手三步都在指针路径里写草稿，它进那条 useEffect 的依赖表。
  const setDraft = useEditor((s) => s.setDraft);
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

  // 一条绘制通路：指令表 → 把手 → 临时线/标记，同一个 effect、同一次 ctx 获取。
  // `revision` 进了依赖却没被读：它是扳机不是数据（见 editorStore 的 D6 注释）。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || viewport === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const doc = log.document;
    const ops = buildDrawList(doc, storeyId, viewport, { ids });
    opsRef.current = ops;
    paint(ctx, ops);
    // 场与指令表在同一趟里取：指针事件的靶子、吸附的候选，全都来自刚刷上屏那一份几何。
    fieldRef.current = snapFieldOf(doc, storeyId);
    // S2：拉墙时屏幕上不许有把手。不画还不算完 —— `handlesRef` 也要清空，否则
    // `pickHandle` 会在墙模式下继续吃上一趟留下的把手（按下就该起草稿，不该拖老墙）。
    const handles = tool === 'wall' ? [] : dragHandlesOf(doc, storeyId, { ids }, viewport);
    handlesRef.current = handles;
    paintHandles(ctx, handles);
    if (drag !== null) {
      paintPreview(ctx, drag.fromPx, drag.cursorPx);
      const dragSnap = drag.drop?.snap ?? null;
      if (dragSnap !== null) paintSnapMarker(ctx, mmToPx(viewport, dragSnap.mm));
    }
    if (draft !== null) {
      // 临时线**恒**画到裸光标（`draft.cursorPx`），不画到吸附点：吸附点由橙色方块说。
      paintPreview(ctx, draft.start.px, draft.cursorPx);
      if (draft.start.snap !== null) paintSnapMarker(ctx, mmToPx(viewport, draft.start.snap.mm));
      if (draft.end.snap !== null) paintSnapMarker(ctx, mmToPx(viewport, draft.end.snap.mm));
    }
  }, [log, storeyId, viewport, revision, ids, drag, draft, tool]);

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
        // S4 ①：按下那一发**不吸**。把手已经在原地，吸一下只会把 `targetMm` 挪回 `atMm`
        // 之外的别处，于是"零移动 ⇒ noop"那条判据（D4）会在第一发上就判错。
        handle: hit,
        drop: null,
      });
      return;
    }
    if (tool === 'wall') {
      // S2：拉墙时点选完全不生效 —— 既不 `pickOne` 也不 `clear()`。不清选中集是因为退出墙模式后
      // 用户期望看见的仍是刚才红着的那批构件；在这里清掉等于让"按一次 w"有隐蔽副作用。
      const field = fieldRef.current;
      // 两次调用喂同一对入参 ⇒ `start.mm` 与 `end.mm` 必然相同（`draftAtPress` 的定义就是
      // `dropTargetOf(v, px, null, field)`）。宁可多跑一次吸附，也不在 renderer 里手拼
      // `DropTarget`：那是第二条 px→mm 通路，D4 禁的东西。
      const start = draftAtPress(viewport, px, field);
      const seed: DraftWall = {
        storeyId,
        start,
        cursorPx: px,
        end: dropTargetOf(viewport, px, null, field),
        legal: false,
      };
      activeRef.current = true;
      // 按下即试跑：零长草稿的 `legal` 恒 false，屏幕上的临时线从第一发起就是"不许松手"的颜色语义。
      setDraft({ ...seed, legal: legalWallCreate(log.document, seed) });
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
      if (current !== null) {
        // S4 ②：中途走 `handleDropTarget` —— 锚点与被排除的原地都从**按下那一把**把手身上取，
        // 与 `dragProbe` 里那一发是同一个函数、同一对入参，于是"探针给的毫米"与
        // "屏幕上真会落下的毫米"仍然是同一个纯函数的同一个输出。
        const drop = handleDropTarget(viewport, px, current.handle, fieldRef.current);
        setDrag({ ...current, cursorPx: px, targetMm: drop.mm, drop });
        return;
      }
      const currentDraft = s.draft;
      if (currentDraft !== null) {
        // 终点以起点为锚（正交/15° 只有相对起点才成立），并排掉起点坐标（否则吸自己、拖不开）。
        setDraft(moveDraft(s.log.document, currentDraft, viewport, px, fieldRef.current));
      }
    };
    const onUp = (): void => {
      if (!activeRef.current) return;
      activeRef.current = false;
      const s = useEditor.getState();
      const currentDraft = s.draft;
      if (currentDraft !== null) {
        setDraft(null);
        const before = pointCountOf(pointSnapshot(s.log.document, s.storeyId));
        const cmd = draftCommand(currentDraft, newWallDefaults(s.log.document, s.storeyId));
        if (cmd === null) {
          // 预言说不合法 ⇒ 一条命令都不发。这一支是 `--draw-shot` 里"拒绝就不留痕迹"那一步的凭据。
          createRef.current = {
            outcome: 'rejected',
            wallId: null,
            startId: null,
            endId: null,
            endMm: currentDraft.end.mm,
            pointCountBefore: before,
            pointCountAfter: before,
          };
          return;
        }
        dispatch(cmd);
        const after = useEditor.getState();
        const doc = after.log.document;
        // `lastCreatedWall` 的三条纪律之一：只在成功分支里**同步**读 `affected`，读完拿文档复核。
        const created =
          after.lastError === null ? lastCreatedWall(doc, after.log.affected, after.storeyId) : null;
        createRef.current = {
          // `failed` 而不是 `rejected`：命令已经发出去了，是真源抛的。`dispatch` 的 `legalDrop`
          // 缺位（D3/D6）在这里同样成立 —— 预言说行、真源说不行，那就是两边漂了，必须留一条能红的路。
          outcome: after.lastError === null && created !== null ? 'ok' : 'failed',
          wallId: created?.wallId ?? null,
          startId: created?.startId ?? null,
          endId: created?.endId ?? null,
          endMm: currentDraft.end.mm,
          pointCountBefore: before,
          pointCountAfter: pointCountOf(pointSnapshot(doc, after.storeyId)),
        };
        // 建完就选中它（D5 的入口唯一）：下一步"拖刚建的墙""删刚建的墙"都要它在选中集里，
        // 而把手只从选中集生成 —— 不选中的话屏幕上会出现一面没有把手的新墙。
        if (created !== null) select(created.wallId);
        return;
      }
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
  }, [viewport, dispatch, setDrag, setDraft, select]);

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

  // T6 的四发快捷键。与上面那发 `z` **分家成两个监听器**：那一路逐字不动（T5 的 R1–R7 与
  // `--edit-shot` 的 21 判据全压在它身上），而这一路每一发都碰工具态。两路各数各的 `seq`
  // （`keySeqRef` / `hotSeqRef`）：判据等的是"我这一路到过"，混在一个计数器上就分不清是哪一发。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const key = event.key;
      const isWall = key === 'w' || key === 'W';
      const isEscape = key === 'Escape';
      const isDelete = key === 'Delete' || key === 'Backspace';
      if (!isWall && !isEscape && !isDelete) return;
      event.preventDefault();
      // 全部状态从 `getState()` 现取，闭包不捕获任何会变的东西 ⇒ 依赖表留空是诚实的。
      const s = useEditor.getState();
      const sel = useSelection.getState();
      let combo: string;
      let outcome: DeleteOutcome | null = null;
      if (isWall) {
        combo = 'W';
        // 已经在墙模式就是空操作（`setTool` 给同一个值，zustand 照样换 state 对象，
        // 但 `tool` 引用不变 ⇒ 订阅者比的是 `s.tool` ⇒ 不重渲）。不清草稿：连按 w 不该吞手势。
        s.setTool('wall');
      } else if (isEscape) {
        combo = 'Escape';
        // `s` 是**这一发之前**的快照（`set()` 换的是 store 里的新对象），下面四个分支都读它：
        // 判的是"这一发该不该取消点什么"，不是"取消完了以后还剩什么"。
        if (s.draft !== null) s.setDraft(null);
        // 取消草稿后**留在**墙模式：Escape 的第一含义是"这一下不拉了"，不是"我要退出工具"。
        else if (s.tool === 'wall') s.setTool('select');
        // 不在墙模式也没有草稿：退回"什么都不选"，与点空白同一条语义。
        else sel.clear();
        // 按着指针时按 Escape ⇒ 手势当场作废：`activeRef` 不清的话，下一次 `onUp` 会拿
        // 一个已经作废的 `drag`/`draft` 再发一条命令（松手那一下本来不该有落点了）。
        if (s.drag !== null) s.setDrag(null);
        if (s.drag !== null || s.draft !== null) activeRef.current = false;
      } else {
        combo = key === 'Delete' ? 'Delete' : 'Backspace';
        const plan = planDelete(s.log.document, s.storeyId, s.tool, sel.ids);
        outcome = plan.outcome;
        if (plan.commands.length > 0) {
          s.dispatchBatch(plan.commands);
          deleteRef.current.deletedIds = [...plan.candidateIds];
        } else {
          // 四条出口里只有 'ok' 发命令。'empty' / 'ignored-in-wall-mode' / 'unsupported' 一律
          // 留一本空账 —— 判据据此分"上次删了东西"与"上次什么都没删"，而不是读一句中文。
          deleteRef.current.deletedIds = [];
        }
        deleteRef.current.unsupportedIds = [...plan.unsupported];
        const after = useEditor.getState();
        // 剪枝在**派发之后**、拿新文档问：`wallDelete` 级联掉的东西只有真源知道（口径见它注释）。
        const kept = pruneSelection(after.log.document, after.storeyId, useSelection.getState().ids);
        useSelection.getState().retain(kept);
        deleteRef.current.selectionAfterDelete = kept;
      }
      const after = useEditor.getState();
      hotSeqRef.current += 1;
      hotRef.current = {
        seq: hotSeqRef.current,
        combo,
        tool: after.tool,
        draftActive: after.draft !== null,
        deleteOutcome: outcome,
        depth: after.log.depth,
        revision: after.revision,
        lastError: after.lastError,
      };
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
      // 光标来源两支：拖把手时读 `drag.cursorPx`（T5 的第五桶判据一字不动），拉墙时读
      // `draft.cursorPx`。两支都非空的那一帧不存在 —— 一个手势只会走一条路。
      const counted =
        ctx === null
          ? NO_PIXELS
          : countPixels(ctx, canvas, s.drag?.cursorPx ?? s.draft?.cursorPx ?? null);
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
        // ↓ T6 的 9 个。全部读 `s`（活的那一份）与 `ops`（刷上屏的那一份），不读闭包里的
        // `tool`/`draft` —— 闭包可能是上一帧的，而判据要的是"按下这一发之后"。
        tool: s.tool,
        draft: s.draft,
        snapMarkPx: counted.snapMarkPx,
        lastCreate: createRef.current,
        deletedIds: deleteRef.current.deletedIds,
        unsupportedIds: deleteRef.current.unsupportedIds,
        selectionAfterDelete: deleteRef.current.selectionAfterDelete,
        lastHotkey: hotRef.current,
        draw: wallProbe(s.log.document, s.storeyId, ops, viewport),
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

**Step 6 的九处形状**（每一处都有"为什么长这样"，改之前先读它）：

① **`fieldRef` 在 paint effect 里刷新，指针事件只读不建**（`:453`）。`snapFieldOf` 要展开本层全部墙、每面墙取两端点 —— 放进 `pointermove` 就是每发一次整层遍历（一次拖拽轻松上千发）。它必须与 `opsRef`/`handlesRef` 同趟刷新：吸附的候选若非"刷上屏那一份几何"，判据就会说"吸上了一个屏幕上根本不存在的东西"。

② **墙模式把手不画，`handlesRef` 还要清空**（`:456-457`）。只跳过 `paintHandles` 是不够的：`pickHandle` 吃的是 ref，留着上一趟的把手，按下那一发就会去拖老墙而不是起草稿。这一句是 S2"拉墙时点选完全不生效"的落地形状。

③ **`activeRef` 是一个手势标志，不是两个**（`:385` 注释）。把手拖与拉墙共用它：`onMove`/`onUp` 进去之后再按 store 里是 `drag` 还是 `draft` 分岔。分两个 ref 会漏一种状态 —— 一次按下只会走一条路，但"这串手势归我管"这件事只有一份真相。

④ **两发 `keydown` 监听器分家**（`:636` 与 `:664`），各数各的 `seq`（`keySeqRef` / `hotSeqRef`）。T5 那一路一字不改（`--edit-shot` 的 21 条判据与 R1–R7 全压在它身上），这一路每一发都碰工具态。合在一个计数器上，`waitHot` 与 `waitKeyApplied` 就分不清"到过 renderer 的是哪一路"。

⑤ **`Escape` 分支读的是 `s` = 这一发之前的快照**（`:684`）。`set()` 换的是 store 里的新对象，`s.draft` 判的是"这一发该不该取消点什么"，不是"取消完了还剩什么"。四个分支的顺序就是判据的顺序：有草稿先取消草稿并**留在**墙模式；没草稿且在墙模式才退回 select；都不在才清选中集。

⑥ **删除的剪枝在派发之后、拿新文档问**（`:708-711`）。屏幕上不去猜补丁收了哪些 id（`pruneSelection` 就是那一问），而 `retain` 在"一个都没剪掉"时原样返回 state（`selectionStore` 里那句 `next.size === s.ids.size`）—— 换了新 Set 的引用会让订阅者白重渲一帧，画的还是同一张图。

⑦ **第五个桶的光标来源两支**（`:748`）：`s.drag?.cursorPx ?? s.draft?.cursorPx ?? null`。T5 那条 `previewNearCursorPx` 判据一字不动（它只会在拖把手时有值），拉墙时同一个桶读草稿的裸光标 —— 于是 S4 第三条纪律"临时线恒画到裸光标"在两条路上都有像素凭据。两支都非空的那一帧不存在（③）。

⑧ **`draw: wallProbe(...)` 每次调用现算**（`:781`）。它与 `edit: dragProbe(...)` 同一条纪律：主进程只读靶子，不猜坐标（`pxPerMm` 住在 renderer）。代价是**文档一变靶子就换** —— 所以 Step 7 的 `runDrawShot` 只在第 0 步读一次并把 JSON 留档，第 15 步拿"几何回到基线之后重新算出的那一发"与它逐字对账；中途任何一步再问一次，拿到的是"已经建了一面墙之后"的场里挑出的另一发。

⑨ **`pointCountOf` 在 renderer 与 main 各有一份，但都只数 `points` 快照的键**（`:108` / Step 7 的 `pointCountOf`）。两边数的都是**同一个真值来源的同一个派生**（`pointSnapshot` 的键集合），不是"各数一遍语义"。若哪天 main 侧改成读 `lastCreate.pointCountAfter`，那两处就会在撤销/重做那两步漂开 —— 那两个数只在松手那一发有值。

**harness 的凭据与边界**（这份代码在计划编写期是怎么验的，写在明处）：仓库里 `apps/desktop/.tscheck/` 不存在，本任务是**先落地再跑**；所以 Step 6 的验证命令就是仓库那条 `pnpm --filter @dajia/desktop typecheck`（Task 3 已把 `zustand` 装上，PlanCanvas 与两个 store 走的是真 react + 真 zustand 类型）。编写期能跑的只有离线 harness：把这三份文件放进一份临时目录，`tsconfig` 继承 `tsconfig.base.json`、`paths` 把 `@dajia/core` 指到 `packages/core/src/index.ts`、`@dajia/scene-2d` 指到本任务 Step 2/4 落地的 `src/index.ts`，react 与 react-dom 的类型沿 `apps/desktop/node_modules` 自然解析（**真类型，不是替身**），只有 `zustand` 用一份手写 `declare module` 替身（签名按 v5 的用法面写窄：`create<T>(initializer)` 直接给 hook、`getState`、`set` 的部分更新）。跑 `npx tsc --noEmit` ⇒ **exit=0**（2026-09-28 实测，无输出）。

它**不证**三件事，别把它们写进凭据：vite 打包能不能过（harness 没有 bundler）、真窗口的行为（那是 Step 7 那道 `--draw-shot` 的唯一凭据）、zustand 真实实现的订阅语义（`retain` 那句"返回同一个 state 就不重渲"吃的是 v5 的 `Object.is` 默认判定，harness 用的替身不实现订阅）。

- [ ] **Step 7: desktop —— 主进程的 `--draw-shot`：十六步拉墙现场，坐标全部来自探针**

`vitest.config.ts` 的 include 只有 `packages/*/test/**` 与 `scripts/test/**` —— `apps/**` 一行单测都没有。所以 Step 6 那套屏幕状态机（工具态、草稿、四色标记、删除派发）在仓库里**只有这一个客观凭据**：真起一个窗口，用 `sendInputEvent` 发指针与按键，再把 `__dajiaDebug()` 的读数逐条钉成 PASS。这与 T5 的 `--edit-shot` 是同一层东西，判据数量翻一倍（21 → 27），因为拉墙一条路上有**三种"什么都没发生"**要分开：`rejected`（预言不合法、一条命令都没发）、`ignored-in-wall-mode`（墙模式下的故意沉默）、`unsupported`（留给 Task 8 的构件）—— 全塞进一句中文报错就等于没有判据，所以 `DeleteOutcome` 的四色直接进报告。

写这一份代码时钉死四条纪律，它们决定了下面十六步为什么长那样：

**① 坐标一个都不硬编码。** 三发像素（`startPx` / `endPx` / `midPx`）、两对毫米、厚度与墙高，全部来自第 0 步读到的 `draw`（就是 renderer 里现算的 `wallProbe`）。写死一个数，等于让这道闸门替样例房背书：样例房一改，闸门就红在"坐标对不上"而不是"行为不对"上。

**② 探针只读一次，第 15 步拿它逐字对账。** `draw` 是每次调用 `__dajiaDebug()` 现算的（Step 6 第 ⑧ 条），文档一变靶子就换。所以第 0 步 `JSON.stringify(probe)` 留档，终态再算一次比"逐字相同"—— 这一句是整个序列"没留痕"的总账，比"点数回到基线"更严：点数回到基线但探针换了一发，说明几何看着一样、靶子已换。

**③ 序列必须把文档送回基线几何。** 第 8 步建的那面墙要在第 12 步删掉、第 13 步撤销回来、第 14 步重做再删掉，终态停在"已删除"上。原因很实在：`desktop-shot.mjs` 那六条基线判据（`ops === 31` 等）读的必须是"序列不留痕"之后那份账，序列留一面墙在文档里，那六条就红在"样例房指令数变了"上 —— 与①同一条理由，闸门不许红在错的地方。
**落地机制按实测说清（评审 I3）**：那六条读的不是"最后落盘的一份报告"，而是**第 15 步重做之后**落盘的快照 `fin`（`main/index.ts:1480` 的 `out1 = { ...fin, … }`）；第 16 步的三面星形墙落在它**之后**、故意留在文档里，它自己的判据（`starStart* / starEnd* / starCounts / starAppAlive / starLastError`）只吃那一发的前后差，不冒充基线。牙齿没丢 —— "回到基线"那几处硬 throw 全在第 9–15 步。评审给的另一个选项（末尾补一发 Ctrl+Z×3 再读一份快照）判定**不做**：那为了对上正文去补输入，属同一类"把闸门改成迁就说法的形状"。

**④ 等不到就抛，绝不把"没等到"当成通过。** 18 处等待（12 处 `waitUntil` + 4 处 `waitHot` + 2 处沿用 T5 的 `waitKeyApplied`），每处上限 10 秒，超时抛中文；每一处拿到报告之后还有一串硬 `throw`。最坏 180 秒加上起窗与加载，所以 Step 7 末把这一条 electron 调用的超时给到 `300_000`（**只给这一条**，`shot`/`pick-shot`/`edit-shot` 仍是 180 秒 —— 它们的等待数量没变）。

`waitHot` 与 `pointCountOf` 这两个新 helper 各堵一个具体的坑：

- **`waitHot` 要同时等 `seq` 变大与 `combo` 相等。** 只等 `seq`：第 9 步那发 `Delete` 若根本没进 renderer，会读到上一发（`W`）的回声然后判过 —— 于是"故意沉默"这一步测的是"上一发快捷键"。只比 `combo`：同一串字面量在序列里出现两次（两次 `Escape`，第 4 步与第 10 步），读到旧的那一发也长得对。与 T5 的 `waitKeyApplied` 同一条 D8 纪律，只是这里读的是 `lastHotkey`（撤销/重做那一发不碰工具态，所以两路各一份回声、各一个计数器）。
- **`pointCountOf` 只认 `points` 快照的键数**，不读 `lastCreate.pointCountBefore/After`。那两个数只在松手那一发有值，而撤销 / 重做 / 删除三步的账要靠**当前快照**问 —— 两处各数一遍必然漂（renderer 侧那份同名函数同一口径，见 Step 6 第 ⑨ 条）。它在快照为空时直接抛：样例房没了和 renderer 死了都不是"点数为 0"。

**A. `apps/desktop/src/main/index.ts` —— 追加一段（放在 `runEditShot` 之后、`whenReady` 之前）**

这一段**不新增任何 import**：`app` / `BrowserWindow` / `writeFileSync` 在文件开头已经进了；下面用到的既有出口 `argPath`、`createWindow`、`whenLoaded`、`waitForDebug`、`focusForInput`、`pressPx`、`movePx`、`releasePx`、`keyCombo`、`waitUntil`、`waitKeyApplied`、`pickShotRequested`、`editShotRequested`、`runShot`、`runPickShot`、`runEditShot`，以及类型 `ClickPoint` / `EditReportShape` / `MmShape`，**全部沿用 T3–T5 落下来的那一份，一字不改**（`DrawReportShape extends EditReportShape` 就是接在它后面读的）。会红的只有两种可能：某个 helper 的名字被 T5 之后的重构改过，或者 `EditReportShape` 少了一个字段 —— 前者按报错改调用点，后者说明 Step 6 的报告字段没落地，**不许**为了过编译把判据删掉。

```ts

type ToolShape = 'select' | 'wall';
type SnapKindShape = 'endpoint' | 'midpoint' | 'foot' | 'ortho' | 'angle15';
type DeleteOutcomeShape = 'ok' | 'empty' | 'ignored-in-wall-mode' | 'unsupported';

interface SnapShape {
  kind: SnapKindShape;
  pointId: string | null;
  mm: MmShape;
  distPx: number;
}

/** 与 renderer 的 `DraftPoint` 对齐：`px` 是**按下处**，`snap.mm` 是**落点**（E23 的那两个值）。 */
interface DraftPointShape {
  mm: MmShape;
  px: ClickPoint;
  snap: SnapShape | null;
}

interface DropTargetShape {
  raw: MmShape;
  mm: MmShape;
  snap: SnapShape | null;
}

interface DraftShape {
  storeyId: string;
  start: DraftPointShape;
  cursorPx: ClickPoint;
  end: DropTargetShape;
  legal: boolean;
}

interface CreateShape {
  outcome: 'ok' | 'rejected' | 'failed';
  wallId: string | null;
  startId: string | null;
  endId: string | null;
  endMm: MmShape | null;
  pointCountBefore: number;
  pointCountAfter: number;
}

interface HotkeyShape {
  seq: number;
  combo: string;
  tool: ToolShape;
  draftActive: boolean;
  deleteOutcome: DeleteOutcomeShape | null;
  depth: number;
  revision: number;
  lastError: string | null;
}

/** 与 `WallProbe` 逐字段对齐：主进程只读它，不猜坐标（`pxPerMm` 住在 renderer）。 */
interface WallProbeShape {
  startPx: ClickPoint;
  startMm: MmShape;
  startPointId: string;
  endPx: ClickPoint;
  endMm: MmShape;
  midPx: ClickPoint;
  lengthMm: number;
  defaults: { thicknessMm: number; heightMm: number };
}

interface DrawReportShape extends EditReportShape {
  tool: ToolShape;
  draft: DraftShape | null;
  snapMarkPx: number;
  lastCreate: CreateShape | null;
  deletedIds: string[];
  unsupportedIds: string[];
  selectionAfterDelete: string[];
  lastHotkey: HotkeyShape | null;
  draw: WallProbeShape | null;
}

function drawShotRequested(): boolean {
  return process.argv.includes('--draw-shot');
}

async function readDrawReport(win: BrowserWindow, label: string): Promise<DrawReportShape> {
  const value = (await win.webContents.executeJavaScript('window.__dajiaDebug()')) as
    | DrawReportShape
    | undefined;
  if (value === undefined) {
    throw new Error(`__dajiaDebug() 没返回报告（${label}）—— renderer 死了，不是"还没刷完"`);
  }
  return value;
}

/**
 * 点数的唯一真值来源是 `points` 快照的键集合（renderer 的 `pointCountOf` 同一口径，**不数第二遍语义**）。
 * 这里不读 `lastCreate.pointCountBefore/After`：那两个数只在松手那一发有值，而撤销 / 重做 / 删除
 * 三步的账要靠**当前快照**问 —— 两处各数一遍必然漂，所以判据只认这一个函数。
 */
function pointCountOf(report: DrawReportShape, label: string): number {
  const n = Object.keys(report.points).length;
  if (n === 0) throw new Error(`${label}：points 快照是空的，样例房没了还是 renderer 没起来`);
  return n;
}

async function clickPx(win: BrowserWindow, p: ClickPoint): Promise<void> {
  await pressPx(win, p);
  await releasePx(win, p);
}

/**
 * 快捷键回声的等待：`seq` 必须变大，**且** `combo` 必须是这一发。
 * 少了 `seq` 这一条，第 9 步的 `Delete` 若没进 renderer，会读到上一发（`W`）的回声然后判过；
 * 少了 `combo`，"回声的是哪一发"就无从判断 —— 与 T5 的 `waitKeyApplied` 同一条 D8 纪律，
 * 只是这里读的是 `lastHotkey`（撤销/重做那一发不碰工具态，两类快捷键各一份回声）。
 */
async function waitHot(
  win: BrowserWindow,
  before: DrawReportShape,
  combo: string,
  label: string,
): Promise<HotkeyShape> {
  const report = await waitUntil(
    `快捷键没生效（${label}）：renderer 的 keydown 没跑到`,
    () => readDrawReport(win, label),
    (r) => r.lastHotkey !== null && r.lastHotkey.seq > (before.lastHotkey?.seq ?? 0),
  );
  const hot = report.lastHotkey;
  if (hot === null) throw new Error(`不可达：waitUntil 判定非空后读回 null（${label}）`);
  if (hot.combo !== combo) {
    throw new Error(`${label}：读到的是另一发快捷键 ${hot.combo}，期望 ${combo}`);
  }
  return hot;
}

/**
 * 十六步（0…15）加一发 addendum A3 的星形接头（三发墙：横、竖两发预备 + 一发 45° 斜臂）。
 * **整条序列必须把文档送回基线几何**：`desktop-shot.mjs` 前六条判据读的是那份报告里
 * **spread 自第 15 步 `fin` 的基线读数**（`ops === 31` 等），所以第 8 步建的那面墙要在第 12 步删掉、
 * 第 13/14 步各撤销与重做一次，终态停在"已删除"的基线上。
 * （第 16 步那三发星形墙落在 `fin` **之后**、留在文档里不要紧：它自己的判据只吃那一发的前后差，
 * 不冒充基线 —— 评审 I3 要求把这件事说白，而不是补一发 Ctrl+Z 去对正文。）
 *
 * 坐标一个都不硬编码：三发像素、两对毫米、厚度与墙高全部来自第 0 步读到的探针。
 * 探针**只在第 0 步取一次**并留档 —— 它是每次调用现算的（文档一变就换靶子），
 * 后面再问一次会拿到"建了一面墙之后的场"里挑出的另一发。
 *
 * 每一步的读数存成独立 const，最后一起写盘：TS 的使用先于声明会替我们守住
 * "少跑一步就编译不过"（与 `runEditShot` 同一条纪律）。
 */
async function runDrawShot(win: BrowserWindow, out: string): Promise<void> {
  await whenLoaded(win);
  await waitForDebug(win);
  focusForInput(win);

  // 0) 起始读数 + 探针。
  const start = await readDrawReport(win, '起始');
  const probe = start.draw;
  if (probe === null) {
    throw new Error('探针给不出可画的空白落点 —— 样例房或视口改过了，先重跑 wallProbe 的六道筛');
  }
  const probeJson = JSON.stringify(probe);
  const basePoints = pointCountOf(start, '起始');
  if (start.snapMarkPx !== 0) {
    throw new Error(`起始没有草稿也没有拖拽，第四色应当恒 0，实测 ${String(start.snapMarkPx)}`);
  }
  if (start.tool !== 'select' || start.draft !== null) {
    throw new Error('起始状态不是"选择模式、无草稿"');
  }

  // 1) W 进拉墙。
  await keyCombo(win, 'W', []);
  const afterW = await waitHot(win, start, 'W', '按 W 之后');
  if (afterW.tool !== 'wall') throw new Error(`W 没把工具切到 wall：${afterW.tool}`);
  if (afterW.draftActive) throw new Error('按 W 不该顺手起草稿');
  if (afterW.depth !== start.depth) throw new Error('按 W 动了真源');

  // 2) 在既有端点上按下：草稿起来、起点吸上那枚点、零长 ⇒ 不合法。
  await pressPx(win, probe.startPx);
  const pressed = await waitUntil(
    '按下起点没起草稿',
    () => readDrawReport(win, '按下起点后'),
    (r) => r.draft !== null,
  );
  const draft0 = pressed.draft;
  if (draft0 === null) throw new Error('不可达：waitUntil 判定非空后读回 null（按下起点后）');
  const startSnap = draft0.start.snap;
  if (startSnap === null || startSnap.kind !== 'endpoint') {
    throw new Error(`起点必须吸到端点档，实测 ${String(startSnap?.kind)}`);
  }
  if (startSnap.pointId !== probe.startPointId) throw new Error('起点吸上的不是探针指的那枚点');
  if (JSON.stringify(draft0.start.px) !== JSON.stringify(probe.startPx)) {
    throw new Error('按下处的像素与探针给的像素不是同一发');
  }
  if (draft0.legal) throw new Error('零长草稿不该合法（S4 ①：按下不吸方向档，长度也没出来）');
  if (pressed.snapMarkPx === 0) {
    throw new Error('起点吸上了既有端点，第四色标记却没画出来');
  }

  // 3) 移到探针终点：落点毫米逐字等于探针给的那对，标记仍在，真源一个字没动。
  await movePx(win, probe.endPx);
  const moved = await waitUntil(
    '移到探针终点后落点没对上',
    () => readDrawReport(win, '移到终点后'),
    (r) => r.draft !== null && JSON.stringify(r.draft.end.mm) === JSON.stringify(probe.endMm),
  );
  const draft1 = moved.draft;
  if (draft1 === null) throw new Error('不可达：移到终点后草稿没了');
  if (!draft1.legal) throw new Error('探针说过合法的落点，屏幕上判不合法');
  const endSnap = draft1.end.snap;
  if (endSnap === null) {
    throw new Error('方向档必命中：探针偏移全是轴对齐或 45°（实测 distPx = 0）');
  }
  if (endSnap.pointId !== null) {
    throw new Error(`终点引了别人的点（${endSnap.pointId}），与筛 ② 矛盾`);
  }
  if (draft1.cursorPx.x !== probe.endPx.x || draft1.cursorPx.y !== probe.endPx.y) {
    throw new Error('草稿的裸光标不是探针那一发像素（临时线该画到这里）');
  }
  if (moved.previewNearCursorPx === 0) {
    throw new Error('临时线没跟到光标（S4 第三条纪律）');
  }
  if (moved.snapMarkPx === 0) {
    throw new Error('落点吸上了却没有第四色标记 —— 用户只会觉得"拖不到想去的地方"');
  }
  if (moved.depth !== start.depth || moved.revision !== start.revision) {
    throw new Error('中途把草稿写进真源了（D4）');
  }
  if (pointCountOf(moved, '移到终点后') !== basePoints) throw new Error('中途点数变了 —— 半途建墙');

  // 4) Escape 取消：草稿没了、标记也没了，账一步都不许多。
  const beforeEsc = await readDrawReport(win, '取消前');
  await keyCombo(win, 'Escape', []);
  const afterEsc = await waitHot(win, beforeEsc, 'Escape', '按 Escape 之后');
  if (afterEsc.draftActive) throw new Error('Escape 没取消草稿');
  if (afterEsc.tool !== 'wall') throw new Error('有草稿时 Escape 只该取消草稿，不该退出拉墙模式');
  const cancelled = await waitUntil(
    '取消后标记或账没回到原样',
    () => readDrawReport(win, '取消读数'),
    (r) => r.snapMarkPx === 0 && r.draft === null && r.depth === beforeEsc.depth,
  );
  if (pointCountOf(cancelled, '取消读数') !== basePoints) throw new Error('取消一次草稿留下了点');
  const depthAtCancel = cancelled.depth;

  // 5) 原地按下即松手：预言不合法 ⇒ 一条命令都不发（`rejected` 那一支）。
  await pressPx(win, probe.startPx);
  await releasePx(win, probe.startPx);
  const rejected = await waitUntil(
    '原地松手没给出 rejected 回执',
    () => readDrawReport(win, '原地松手后'),
    (r) => r.lastCreate !== null && r.lastCreate.outcome === 'rejected',
  );
  const rej = rejected.lastCreate;
  if (rej === null) throw new Error('不可达：rejected 分支读不到回执');
  if (rej.wallId !== null || rej.startId !== null || rej.endId !== null) {
    throw new Error('被拒的一发不该留下任何 id');
  }
  if (rej.pointCountBefore !== rej.pointCountAfter) throw new Error('被拒的一发多了点');
  if (rejected.depth !== depthAtCancel) throw new Error('被拒的一发入了栈');

  // 6) 第二次按下起点 —— 与第 2 步同一发像素，这次不松手。
  await pressPx(win, probe.startPx);
  const pressed2 = await waitUntil(
    '第二次按下没起草稿',
    () => readDrawReport(win, '第二次按下'),
    (r) => r.draft !== null,
  );

  // 7) 移到终点
  await movePx(win, probe.endPx);
  const moved2 = await waitUntil(
    '第二次移动落点没对上',
    () => readDrawReport(win, '第二次移到终点'),
    (r) => r.draft !== null && JSON.stringify(r.draft.end.mm) === JSON.stringify(probe.endMm),
  );

  // 8) 松手建墙：点数 +1、起点复用探针那枚点、新建即选中。
  await releasePx(win, probe.endPx);
  const built = await waitUntil(
    '松手没建出墙',
    () => readDrawReport(win, '松手建墙后'),
    (r) => r.lastCreate !== null && r.lastCreate.outcome === 'ok',
  );
  const builtCreate = built.lastCreate;
  if (builtCreate === null) throw new Error('不可达：建墙分支读不到回执');
  if (builtCreate.startId !== probe.startPointId) {
    throw new Error('新建的墙没有与既有墙共享起点 —— 接头全断（S7）');
  }
  if (JSON.stringify(builtCreate.endMm) !== JSON.stringify(probe.endMm)) {
    throw new Error('回执落点与探针预言不一致');
  }
  if (builtCreate.pointCountAfter !== basePoints + 1) {
    throw new Error(
      `一面全新终点的墙应恰好多一枚点：${String(basePoints)} → ${String(builtCreate.pointCountAfter)}`,
    );
  }
  const newWallId = builtCreate.wallId;
  if (newWallId === null || !built.selectedIds.includes(newWallId)) {
    throw new Error('新建即选中没生效（S6）');
  }
  if (built.selectedPx < 100) throw new Error(`选中红像素太少：${String(built.selectedPx)}`);
  if (built.tool !== 'wall') throw new Error('建完一面墙不该自动退出拉墙模式');
  const builtPoints = pointCountOf(built, '松手建墙后');

  // 9) 拉墙模式下按 Delete：四色之一的"故意沉默"。
  const beforeWallDel = await readDrawReport(win, '拉墙模式删除前');
  await keyCombo(win, 'Delete', []);
  const ignored = await waitHot(win, beforeWallDel, 'Delete', '拉墙模式下按 Delete');
  const ignoredReport = await readDrawReport(win, '拉墙删除后');
  if (ignored.deleteOutcome !== 'ignored-in-wall-mode') {
    throw new Error(`拉墙模式的删除沉默读成 ${String(ignored.deleteOutcome)}`);
  }
  if (ignoredReport.depth !== beforeWallDel.depth) throw new Error('拉墙模式下的删除发了命令');
  if (pointCountOf(ignoredReport, '拉墙删除后') !== builtPoints) throw new Error('拉墙模式下的删除动了点');

  // 10) Escape 退出拉墙（此时没有草稿 ⇒ 回到 select）。
  const beforeExit = await readDrawReport(win, '退出拉墙前');
  await keyCombo(win, 'Escape', []);
  const exited = await waitHot(win, beforeExit, 'Escape', '按 Escape 退出拉墙');
  if (exited.tool !== 'select') throw new Error(`Escape 没退回 select：${exited.tool}`);

  // 11) 点新墙中点：筛 ④ 保证那里建墙前一片空白，所以现在命中的只可能是新墙。
  await clickPx(win, probe.midPx);
  const clicked = await waitUntil(
    '点不中新墙（筛 ③ 的像素下限在真窗口里失效）',
    () => readDrawReport(win, '点新墙后'),
    (r) => r.selectedIds.length === 1 && r.selectedIds[0] === newWallId,
  );
  if (clicked.selectedPx < 100) throw new Error(`点中了但屏幕上没有红色像素：${String(clicked.selectedPx)}`);
  if (clicked.handlePx === 0) throw new Error('回到 select 了却没画把手');

  // 12) Backspace 删除：墙与它的孤儿点一起消失，选中集剪枝成空。
  const beforeDel = await readDrawReport(win, '删除前');
  await keyCombo(win, 'Backspace', []);
  const delHot = await waitHot(win, beforeDel, 'Backspace', '按 Backspace 删除');
  if (delHot.deleteOutcome !== 'ok') throw new Error(`删除读成 ${String(delHot.deleteOutcome)}`);
  const deleted = await waitUntil(
    '删除后账没回到基线',
    () => readDrawReport(win, '删除后'),
    (r) => pointCountOf(r, '删除后') === basePoints && r.selectionAfterDelete.length === 0,
  );
  if (deleted.deletedIds.length !== 1 || deleted.deletedIds[0] !== newWallId) {
    throw new Error(`deletedIds 不是那一面墙：${JSON.stringify(deleted.deletedIds)}`);
  }
  if (deleted.unsupportedIds.length !== 0) {
    throw new Error(`样例房里不该有 unsupported 构件：${JSON.stringify(deleted.unsupportedIds)}`);
  }

  // 13) Ctrl+Z：墙连同它那枚孤儿点一起回来（撤销不恢复选中 —— D7）。
  const beforeUndo = await readDrawReport(win, '撤销前');
  await keyCombo(win, 'Z', ['ctrl']);
  const undoKey = await waitKeyApplied(win, beforeUndo, '撤销');
  const undid = await waitUntil(
    '撤销没把墙和它的点带回来',
    () => readDrawReport(win, '撤销后'),
    (r) => pointCountOf(r, '撤销后') === basePoints + 1,
  );
  if (undid.selectedIds.includes(newWallId)) throw new Error('撤销把选中也恢复了（D7 说不许）');

  // 14) Ctrl+Shift+Z：再删回去，序列停在基线几何上。
  const beforeRedo = await readDrawReport(win, '重做前');
  await keyCombo(win, 'Z', ['ctrl', 'shift']);
  const redoKey = await waitKeyApplied(win, beforeRedo, '重做');
  const redid = await waitUntil(
    '重做没把墙再删掉',
    () => readDrawReport(win, '重做后'),
    (r) => pointCountOf(r, '重做后') === basePoints,
  );

  // 15) 终态：几何回到第 0 步，探针重新算出的靶子与第 0 步**逐字相同**。
  //     这一句是整个序列"没留痕"的总账，也是前六条基线判据能继续读最后一份报告的前提。
  const fin = await waitUntil(
    '终态探针没回到基线靶子',
    () => readDrawReport(win, '终态'),
    (r) => r.draw !== null && JSON.stringify(r.draw) === probeJson,
  );
  if (JSON.stringify(fin.points) !== JSON.stringify(start.points)) {
    throw new Error('终态的 points 快照与起始不同 —— 序列改写了基线几何');
  }
  if (fin.tool !== 'select' || fin.draft !== null) throw new Error('终态没回到"选择模式、无草稿"');
  if (fin.snapMarkPx !== 0) throw new Error('终态还留着吸附标记');

  const out1 = {
    ...fin,
    // ↓ 探针与逐步读数全部留档：脚本侧判据拿它们对账，改一步就少一个键。
    probeJsonAtStart: probeJson,
    basePoints,
    depthAtStart: start.depth,
    revisionAtStart: start.revision,
    toolAfterW: afterW.tool,
    depthAfterW: afterW.depth,
    startSnapKind: startSnap.kind,
    startSnapPointId: startSnap.pointId,
    pressPxMatches: JSON.stringify(draft0.start.px) === JSON.stringify(probe.startPx),
    legalAtPress: draft0.legal,
    snapMarkAtPress: pressed.snapMarkPx,
    endSnapKind: endSnap.kind,
    endSnapDistPx: endSnap.distPx,
    endSnapPointId: endSnap.pointId,
    legalAtMove: draft1.legal,
    cursorPxAtMove: draft1.cursorPx,
    previewNearCursorPx: moved.previewNearCursorPx,
    snapMarkAtMove: moved.snapMarkPx,
    depthAtMove: moved.depth,
    revisionAtMove: moved.revision,
    pointsAtMove: pointCountOf(moved, '移到终点后'),
    toolAfterEsc: afterEsc.tool,
    snapMarkAfterEsc: cancelled.snapMarkPx,
    rejectedOutcome: rej.outcome,
    rejectedWallId: rej.wallId,
    rejectedCounts: `${String(rej.pointCountBefore)}→${String(rej.pointCountAfter)}`,
    rejectedDepth: rejected.depth,
    depthAtCancel,
    pressed2Draft: pressed2.draft !== null,
    moved2Mm: moved2.draft?.end.mm ?? null,
    builtOutcome: builtCreate.outcome,
    builtWallId: newWallId,
    builtStartId: builtCreate.startId,
    builtEndId: builtCreate.endId,
    builtEndMm: builtCreate.endMm,
    builtCounts: `${String(builtCreate.pointCountBefore)}→${String(builtCreate.pointCountAfter)}`,
    builtSelectedPx: built.selectedPx,
    builtTool: built.tool,
    builtSelected: built.selectedIds.includes(newWallId),
    builtPointsBefore: builtCreate.pointCountBefore,
    builtPointsAfter: builtCreate.pointCountAfter,
    builtDepth: built.depth,
    deleteOutcomeInWallMode: ignored.deleteOutcome,
    depthInWallMode: ignored.depth,
    toolAfterEscape: exited.tool,
    clickedSelectedIds: clicked.selectedIds,
    clickedSelectedPx: clicked.selectedPx,
    clickedHandlePx: clicked.handlePx,
    deleteOutcomeAfterBackspace: delHot.deleteOutcome,
    deletedCount: deleted.deletedIds.length,
    unsupportedCount: deleted.unsupportedIds.length,
    comboAfterUndo: undoKey.combo,
    pointsAfterUndo: pointCountOf(undid, '撤销后'),
    selectedAfterUndo: undid.selectedIds.length,
    comboAfterRedo: redoKey.combo,
    pointsAfterRedo: pointCountOf(redid, '重做后'),
    probeMatchesStart: JSON.stringify(fin.draw) === probeJson,
    pointsMatchStart: JSON.stringify(fin.points) === JSON.stringify(start.points),
  };
  writeFileSync(out, `${JSON.stringify(out1, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(out1)}\n`);
}
```

**B. 同一个文件里的 `whenReady`：三段换四段**

T5 那段 `if (editShotRequested()) … else if (pickShotRequested()) … else runShot …` 整块换成：

```ts
/**
 * 四段分支（T5 的三段再加一段）。顺序是**从具体到通用**：`--draw-shot` 判在
 * `editShotRequested()` 之前 —— 四个 runner 共用 `--shot` 那份落盘路径，谁先命中谁写盘。
 * 脚本侧同样只允许一个具体 flag 生效（`mode` 只有一个值），两边配成一对。
 */
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
    if (drawShotRequested()) await runDrawShot(win, argPath('--draw-shot') ?? shotPath);
    else if (editShotRequested()) await runEditShot(win, argPath('--edit-shot') ?? shotPath);
    else if (pickShotRequested()) await runPickShot(win, argPath('--pick-shot') ?? shotPath);
    else await runShot(win, shotPath);
  } catch (err) {
    process.stderr.write(`--shot 失败：${String(err)}\n`);
    code = 1;
  }
  app.exit(code);
});
```

> **顺序是从具体到通用**：`--draw-shot` 必须在 `editShotRequested()` 之前判，`--edit-shot` 在 `--pick-shot` 之前，`runShot` 兜最后。理由是四个 runner **共用 `--shot` 那一份落盘路径**（`argPath('--shot') !== null` 才是"进 shot 模式、隐藏窗口、跑完 exit"的开关），谁先命中谁写盘 —— 反过来排不会编译错，只会让 `--draw-shot` 悄悄跑成 `--edit-shot` 那份报告，然后在 28 行判据里红成一地对不上的读数。
>
> `?? shotPath` 那三个兜底照 T5 的原样保留（脚本一定会成对给路径；手写命令少给一个时宁可退回 `--shot` 那份路径，也不要让 runner 拿 `null` 当文件名去 `writeFileSync`）。

`scripts/desktop-shot.mjs`：`try` / `finally { rmSync(dir, ...) }` 的骨架照旧，`out` 的定义保持在它上面不动。把 T5 那段 `wantPick` + `wantEdit` + `electronArgs` 整段换成下面这段 —— **三个 `includes` 换成一条 `mode` 判定链**：开关要是能同时生效，`--edit --draw` 就会给主进程两个具体 flag，而分支只认第一个，脚本侧却按 `wantDraw` 攒判据 ⇒ 红在"报告里没这个键"上。`mode` 只有一个值，这件事就不可能发生：

```js
const mode = process.argv.includes('--draw')
  ? 'draw'
  : process.argv.includes('--edit')
    ? 'edit'
    : process.argv.includes('--pick')
      ? 'pick'
      : 'shot';
const wantPick = mode === 'pick';
const wantEdit = mode === 'edit';
const wantDraw = mode === 'draw';
// 具体 flag 与 `--shot` 成对给：`--shot out` 不是"再写一份报告"，主进程用它判定进不进 shot 模式
// （隐藏窗口、跑完 exit）。少了它，`--draw-shot` 那份路径根本没人读。
const specificFlag = wantDraw
  ? '--draw-shot'
  : wantEdit
    ? '--edit-shot'
    : wantPick
      ? '--pick-shot'
      : null;
const electronArgs = [
  '.',
  ...(specificFlag === null ? [] : [specificFlag, out]),
  '--shot',
  out,
];
try {
  run('pnpm', ['--filter', '@dajia/desktop', 'build']);
  // 只有 draw 那一发放宽到 300 秒：它有序列里 18 处等待（每处上限 10 秒），最坏 180 秒。
  // 另三条**不跟着放宽** —— 它们的等待数量一字没动，跟着涨等于把"变慢了"这件事抹平。
  run(
    'pnpm',
    ['--filter', '@dajia/desktop', 'exec', 'electron', ...electronArgs],
    wantDraw ? 300_000 : 180_000,
  );
```

`const layers = report.layers ?? {};` 之后补一行读数对象（`draw` 是**探针**那一份，序列的逐步读数全部平铺在报告根上 —— 与 `edit` 那一份的形状不同，那些是 `runEditShot` 自己组的嵌套对象）：

```js
  const probe = report.draw ?? {};
```

然后**在 T5 那段 `if (wantEdit) {…}` 之后**追加 `if (wantDraw) {…}`。二十一条，一条对一步（或一步里的一件事），顺序就是 `runDrawShot` 的步序：

```js
  if (wantDraw) {
    // 前六条与 drawlist.test.ts 同源（序列把文档送回基线，所以 `ops === 31` 在这里仍是回归判据）；
    // 这二十一条与 editing.test.ts + snapping.test.ts 同源，但只测它们管不到的那一层：
    // 真窗口里"发的像素 → 吸附的落点 → 真源的账 → 撤销栈"。
    checks.push(
      ['D1 探针给得出靶子，起点吸在既有端点上（S7 的复用那一半）', typeof report.startSnapPointId === 'string' && report.startSnapPointId.length > 0 && report.startSnapKind === 'endpoint'],
      ['D2 按下处的像素就是探针给的那一发（屏幕不另算一套坐标）', report.pressPxMatches === true],
      ['D3 零长草稿判不合法，但吸附标记已经上屏', report.legalAtPress === false && report.snapMarkAtPress > 0],
      // 档位只钉到「是方向档、且零位移」：钉死 ortho 还是 angle15 等于拿判据赌 uuidv7 的端点顺序（探针挑中哪枚起点会漂，见 S8 ① 那段实测）。
      // S3 那句"画 4000 的水平墙必须是 ortho"由 snapping.test.ts 的档位互斥用例负责，那一份是确定性的。
      // distPx 的「逐字 0」按实测订正为 ≤1.5（D2a 落地即如此，评审 Q1 独立裁定保留）：真窗口 pxPerMm≈0.12417，
      // 整数像素取整的往返残差按构造 ≤0.5px/轴（对角 ≤0.71）；实测只取 0.3298 / 0.4508 两个离散值。
      // 「吸错别面墙」不靠这一行抓：第 3 步与第 8 步和 D12 的 `end.mm === probe.endMm` 三处逐字相等钉着。
      ['D4 终点吸的是方向档、没引别人的点、位移在量化往返残差内（S7 的另一半 + S8 ① 订正版）', report.endSnapPointId === null && (report.endSnapKind === 'ortho' || report.endSnapKind === 'angle15') && report.endSnapDistPx <= 1.5],
      ['D5 中途临时线跟到光标（S4 第三条纪律）', report.previewNearCursorPx > 0],
      ['D6 中途第四色标记在屏（S8 只证存在）', report.snapMarkAtMove > 0],
      ['D7 中途真源一个字没动：depth、revision、点数三者', report.depthAtMove === report.depthAtStart && report.revisionAtMove === report.revisionAtStart && report.pointsAtMove === report.basePoints],
      ['D8 Escape 只取消草稿、留在拉墙模式，标记跟着消失', report.toolAfterEsc === 'wall' && report.snapMarkAfterEsc === 0 && report.depthAtCancel === report.depthAtStart],
      ['D9 原地松手 = rejected，一条命令都不发（D4 的第三色）', report.rejectedOutcome === 'rejected' && report.rejectedWallId === null && report.rejectedCounts === `${String(report.basePoints)}→${String(report.basePoints)}`],
      ['D10 被拒那一发不入栈：depth 与取消后逐字相同', report.rejectedDepth === report.depthAtCancel],
      ['D11 松手建墙，起点复用探针指的那枚点（接头没断）', report.builtOutcome === 'ok' && report.builtStartId === report.startSnapPointId],
      ['D12 回执落点逐字等于探针预言（两边同一个纯函数）', JSON.stringify(report.builtEndMm) === JSON.stringify(probe.endMm)],
      ['D13 一面全新终点的墙恰好多一枚点（S7 的删除账靠它）', report.builtPointsBefore === report.basePoints && report.builtPointsAfter === report.basePoints + 1],
      ['D14 新建即选中，且屏幕上真有红色像素', report.builtSelected === true && report.builtSelectedPx > 100],
      ['D15 建完仍在拉墙模式（连画不该每面退出一次）', report.builtTool === 'wall'],
      ['D16 拉墙模式下按 Delete = 故意沉默，账一步不动', report.deleteOutcomeInWallMode === 'ignored-in-wall-mode' && report.depthInWallMode === report.builtDepth],
      ['D17 再按一次 Escape 才退出拉墙', report.toolAfterEscape === 'select'],
      ['D18 点新墙中点：唯一命中就是刚建那面，把手也画出来了（筛 ④ 的像素下限在真窗口里成立）', Array.isArray(report.clickedSelectedIds) && report.clickedSelectedIds.length === 1 && report.clickedSelectedIds[0] === report.builtWallId && report.clickedHandlePx > 20],
      ['D19 Backspace 只删那一面墙，unsupported 空，选中集剪空', report.deleteOutcomeAfterBackspace === 'ok' && report.deletedCount === 1 && report.unsupportedCount === 0 && Array.isArray(report.selectionAfterDelete) && report.selectionAfterDelete.length === 0],
      ['D20 撤销把墙连同它的孤儿点一起带回来，选中不跟着回来（D7 那半句）', report.pointsAfterUndo === report.basePoints + 1 && report.selectedAfterUndo === 0 && report.comboAfterUndo === 'Ctrl+Z'],
      // 倒数第二条是总账：②③ 两条纪律的凭据都在它身上 —— 第 15 步为止序列没留痕，前六条读的就是这份基线
      //   （第 16 步的三面星形墙落在它之后，只吃自己的前后差，不冒充基线）。
      ['D21 重做回到基线，终态探针与 points 快照逐字回到第 0 步', report.pointsAfterRedo === report.basePoints && report.probeMatchesStart === true && report.pointsMatchStart === true && report.comboAfterRedo === 'Ctrl+Shift+Z'],
    );
  }
```

根 `package.json` 的 scripts 再加一条（`shot` / `pick-shot` / `edit-shot` 三条保持原样）：

```json
"draw-shot": "node scripts/desktop-shot.mjs --draw"
```

数一下：`wantDraw` 那段是 **22** 条判据（`D1`–`D22`，第 22 条是 addendum A3 要求的星形接头那一发），基础六条照旧 ⇒ `pnpm draw-shot` 应当打印 **28 行 PASS**（实测 28）。另外三道闸门一行不动：`pnpm shot` 6 行、`pnpm pick-shot` **11** 行（正文原先写 10，Task 4 起实测就是 11）、`pnpm edit-shot` 21 行。改样例房或改判据时，这几处要一起改：`drawlist.test.ts`、`pick.test.ts`、`snapping.test.ts`、`editing.test.ts`、`handles.test.ts`、`commands-drag.test.ts`、`desktop-shot.mjs`。

> **D13 那一句为什么钉"恰好 +1"而不是"> 基线"**：S7 让终点全新建，所以一面新墙在真源里留下的点是**一枚**（`wallCreate` 建两端、起点走 `{ pointId }` 复用既有那一枚）。多出来的那一枚如果没被删干净，D19 的"点数回基线"会红；反过来，若起点没复用而走了 `{x,y}`，D11 先红 —— 两条一起才把"共享端点退化成一堆独立点"这条路堵死（计划 2 Task 3 的 `resolvePointRef` 守卫在屏幕侧的镜像）。
>
> **D18 是探针六道筛在真窗口里唯一露面的那一条**：它点的是 `probe.midPx`，而筛 ④ 保证那一发像素在**建墙之前**一个候选都不命中。所以建完之后那儿若还"唯一命中新墙"，证的就是这面墙真的画出来了、真的可点，而不是"点了个本来就红的地方"。它同时是筛 ③ 之二（`(长度 − 厚度) × pxPerMm ≥ MIN_PICK_EDGE_PX`）的运行时凭据 —— 那条下限在单元里由 E16 钉着，在真窗口里只有这一发够得着。

- [ ] **Step 8: 真窗口跑一次 + 八条改坏 + 全量闸门 + 两个提交**

```bash
pnpm --filter @dajia/desktop typecheck > /tmp/t6-dts.log 2>&1; echo exit=$?
pnpm shot > /tmp/t6-shot-base.log 2>&1; echo exit=$?
pnpm pick-shot > /tmp/t6-shot-pick.log 2>&1; echo exit=$?
pnpm edit-shot > /tmp/t6-shot-edit.log 2>&1; echo exit=$?
pnpm draw-shot > /tmp/t6-shot-draw.log 2>&1; echo exit=$?
```
Expected: 五个 exit=0。`shot` **六行**、`pick-shot` **十一行**、`edit-shot` **二十一行**照旧全绿（本任务不该动它们的判据 —— 见下面"红线"那条），`draw-shot` **二十八行**全 PASS（实测 28 = 基础六条 + `D1`–`D22`）。把 stdout 里那三行读数原样抄进提交信息：探针那一发的 `startMm → endMm` 与 `startPointId` 的前 8 字（证靶子从**既有端点**起画）、`snapMarkAtPress / snapMarkAtMove / previewNearCursorPx` 三个数（证"按下就有标记、中途标记与线都在、线跟着手"）、`builtCounts` 那一串 `N→N+1`（证"恰好一枚新点"）。

**四条已知风险**（前三条是 `--draw-shot` 独有的新风险，T5 没证过这些形状）。按顺序试，**一次只动一个变量**，都不许把判据改成"读到什么算什么"：

1. **`keyCode: string` 校验不了字面量。** `keyCombo(win, 'W', [])` 里那个 `'W'` 与 `'Escape'` / `'Delete'` / `'Backspace'` 都是裸字符串 —— `electron.d.ts` 只说它"取 Accelerator 键名"，TypeScript 帮不上忙，写错了要等到真窗口跑才知道。现象是某处 `waitHot` 抛「快捷键没生效（…）：renderer 的 keydown 没跑到」。分辨办法：同一份 `keyCombo` 在 `--edit-shot` 里跑过 `'Z'` 与 `'Shift'` 那一发 ⇒ 通道本身是通的，红的那一发单独查它的 `keyCode` 拼写（`'Escape'` 不是 `'esc'`，`'Backspace'` 不是 `'backspace'`）。**先确认 `focusForInput(win)` 之后没有别的窗口抢焦点**（T5 风险 1 同一条：`sendInputEvent` 要求窗口 focused）。
2. **`event.key` 与输入法。** renderer 判的是 `key === 'w' || key === 'W'`。合成事件走的是 Chromium 的 keydown 通路，与 T5 的 `'z'` 同一形状（那一路绿了 21 行），所以闸门里预期没问题；但**用户在中文输入法下按 W** 时 `event.key` 可能是 `'Process'` 而不是 `'w'` —— 那是键盘布局侧的事实，本任务的判据抓不到它（闸门只发合成事件）。这条**不在这里补**：写进转下游，Task 8 做属性面板与楼层切换入口（有按钮可点）与快捷键文案时才需要它，届时要么用 `event.code`，要么给模式一个可点的入口。**别为了让这条可测而在 renderer 里加一条"按不到就点按钮"的分支。**
3. **D2 那一句逐字相等吃的是整数像素。** `probe.startPx` 是 `intPx` 取整后的值，而 `draftAtPress` 存的 `px` 来自 `event.offsetX`。T5 已经记下"`offsetX` 在缩放的 Windows 上可能带小数"（所以 5 号桶给 ±2px 窗口）。若 `--draw-shot` 红在「按下处的像素与探针给的像素不是同一发」，处置是**在 `pointerPx` 里把按下像素取整**（与探针同一个 `intPx` 口径，两边同源），**不是**把 D2 放宽成"差 ≤ 1px" —— 那条判据的存在理由就是"屏幕不另算一套坐标"，一旦允许误差，探针与 renderer 就又是两个数了。
4. **300 秒上限**：`runDrawShot` 有序列里 18 处等待（最坏 180 秒）加起窗与加载。撞到就只把 `wantDraw` 那一支的超时给到 `300_000`（Step 7 已经这么写了），**不许**缩短那 10 秒的单次上限 —— 它是给慢机器留的余量。

**红线**：如果 `--draw-shot` 逼着回头改 `--edit-shot` 那 21 行里的任何一行、或者改 `onPointerDown` 的把手分支（S4 ① 说按下那一发**保持 T5 原样**），那就是 S4 的代价没付掉 —— 停在这里核对，别把 T5 的判据改松来迁新闸门。

再验一次判据能区分"做了"和"没做"。**`apps/**` 没有单测，这一步不能省**（`vitest.config.ts` 的 include 只有 `packages/*/test/**` 与 `scripts/test/**`）。下面八条各钉一处，每条做完立刻改回来再跑下一条（每条只动一处，跑完 `git diff` 应当只剩那一处）。**"必须红在哪一处"这一列是按 `runDrawShot` 的 throw 文案推出来的，执行时把实测的红字原样回填这一列** —— 与 T5 那张表不同，那张的每一行都在真窗口里跑过，这张还没有（编写期跑不了：`apps/desktop` 的 renderer 与 `scripts/desktop-shot.mjs` 要 Task 3 之后才存在）。红在哪一行本身就是信息：throw 在判据行上游，"某一行 FAIL"意味着它前面那道 throw 被削弱了，那种红同样要查。

| # | 改坏（各一处） | 必须红在哪一处 | 为什么是这一处 |
|---|---|---|---|
| DR1 | 注释掉 paint effect 里草稿那两支 `paintSnapMarker(...)`（起点与终点，`drag` 那一支保留） | 第 2 步的 `snapMarkPx === 0` 硬 throw：「起点吸上了既有端点，第四色标记却没画出来」 | 证明橙色像素是**这个画家**画的，不是别的东西混色。`countPixels` 一字没动，所以只有画家那一处能解释"颜色没了" |
| DR2 | `paintPreview(ctx, draft.start.px, draft.cursorPx)` 的终点改成吸附落点（`mmToPx(viewport, draft.end.mm)`） | **实测恒绿（2026-09-29，`dr2-run.log` = 28 行 PASS，无牙）**：预言那两处读的都是毫米侧数据（`draft.end.mm`）与光标 ±2px 窗口，而现手势的终点吸附位移实测只有 **0.33 / 0.45px 两个离散值**，落进 `previewNearCursorPx` 的 ±2px 第五桶 ⇒ 画到吸附点与画到裸光标像素不可分（`PlanCanvas.tsx:294` 那句注释早已自证标记正落在第五桶正中） | S4 ③ 那处"看得见的取舍"的哨兵：预览线恒画裸光标、吸附点交给第四色。**挂 Task 8，具名出口**（与 HB5 挂 T7 同一先例）：现手势补不出可见位移 —— 故意偏 5–6px 的那一发只在"没有 group-0 候选来抢"时保持 `end.mm === probe.endMm`，而 uuidv7 挑中的探针点某次开机旁边就有 8px 内的静态候选、另一次没有（`main/index.ts:1199-1217` 记过的相位抖动）。稳的形状是给 `wallProbe` 加一条**邻域无候选筛**（scene-2d 改动 + 自带单测，加在 `editing.ts:401-411` 筛②–⑥旁边）。**不许**用"橙像素必须是 56 的整数倍"这类计数等式凑牙（A1/S8 的禁令：那既脆又假） |
| DR3 | **按实测重写（2026-09-29）**：本行原先的写法抓不到东西，三处各自独立成立 —— ①`draftAtPress(viewport, px, field)` 根本没有"多传一个锚点"这个入参（`editing.ts:110-113` 内部硬写 `null`）；②即便写成"按下也吃方向档"（锚点 = 按下裸毫米）也是**等价变异**：`snapping.ts:272` 的零位移筛（`dx !== 0 \|\| dy !== 0` 才把方向档投进池子）⇒ 锚点 ≡ 裸落点时给不给锚点逐字相同，与按下位踩不踩端点无关（实测资源哈希 `index-DoffTLFe.js` ≠ 基线 `index-Blnm6r8A.js`，证明变异确实进了产物）；③预言的第 2 步「起点必须吸到端点档」根本走不到 —— 探针按在既有端点上，`GROUP` 让实体档恒赢方向档（`snapping.ts:143` + `takeBest` 228-237）。**能红的形状**：把 `draftAtPress` 里的 `null` 换成"按下裸毫米 **+1mm**"的锚点（= 真的让方向档参与） | 第 16 步 W1 硬 throw「空白角按下了吸附（`kind:'ortho' … distPx 0.054…`）」（`main/index.ts:1341`；实测 `dr3pp-run.log` = 0 行 PASS） | S3/S4 ① 的落地：按下那一发不许自动变正交。**判据一字未动** —— 牙齿本来就在第 16 步那条 `w1.startSnap === null` 与单测「起点在空白处按下：什么都不吸，也不吃角度档」（`editing.test.ts:181-192`）；本行只订正"怎么改坏才抓得到它" |
| DR4 | 在 `onUp` 的草稿分支开头加 `legalWallCreate` 预检、不合法直接 `return`（不写 `rejected` 回执） | 第 5 步 `waitUntil` 抛「原地松手没给出 rejected 回执（超时 10s）」 | 与 T5 的 R5 同一类：D3 的纪律是"屏幕上不重写守卫"，而**预检最像"什么都没发生"** —— 少一份回执，`--draw-shot` 就分不出"被预言挡下"与"那一发根本没到" |
| DR5 | `planDelete` 摘掉 `tool === 'wall'` 特判（拉墙模式下照删选中集） | 第 9 步硬 throw「拉墙模式的删除沉默读成 ok」，`depthInWallMode` 那一处跟着红 | S5 的四色判据里唯一一条"故意沉默"。摘掉之后正在拉墙时按 Delete 会把用户上一发的选中集一起吃掉，而屏幕上没有任何一条中文报错能证明它发生过 |
| DR6 | 摘掉删除之后那两句 `useSelection.getState().retain(kept)` | 第 12 步 `waitUntil` 抛「删除后账没回到基线（超时 10s）」（谓词含 `selectionAfterDelete.length === 0`） | 剪枝只在这条路上有读者：`buildDrawList` 与 `dragHandlesOf` 都按 `doc.get` 找不到就跳过，所以**不剪枝屏幕上看不出任何异常** —— 只有那份留档的 `selectionAfterDelete` 抓得到（D7 留给 Task 8 的那个接缝，本任务先在删除这条路上收掉） |
| DR7 | 摘掉 `hotSeqRef.current += 1`（`combo` 与其余读数照常写） | 第一处 `waitHot`（第 1 步按 W）抛「快捷键没生效（按 W 之后）：renderer 的 keydown 没跑到（超时 10s）」 | 证 `waitHot` 不是靠 `combo` 字面量蒙对的：`seq` 是"这一发到过 renderer"的唯一凭据，而 `'Escape'` 在序列里出现两次、`'Delete'` 与上一发的 `'W'` 长得不同但都会过期 |
| DR8 | 删掉 `if (created !== null) select(created.wallId)`（新建后不选中） | 第 8 步硬 throw「新建即选中没生效（S6）」 | D5"拖之前先选中"在拉墙路上的对应物。少这一句，新墙没有把手（把手只从选中集生成），下一步点它仍能选中 —— 所以**只有第 8 步那一发抓得到**，这正是它必须在建完立刻读的原因 |

**不做**的一条，写在这里防有人顺手补：把 `pointerup` 里"墙模式与 select 模式共用的 `activeRef` 复位"摘掉，看哪一条会红 —— **不许当改坏**。`Escape` 那一支已经把标志复位，后续按下又会置 `true`，红不红取决于事件到达顺序，于是一条真坏了的东西可能偶然还绿（与 T5 那条"删掉 `select(hit.wallId)`"同一类）。D8 与 D17 那两条判据加 `runDrawShot` 第 4 步之后紧跟的第 5 次按下，已经把"取消之后还能重新起一发"这件事测到了。

```bash
pnpm verify > /tmp/t6-verify.log 2>&1; echo exit=$?
```
Expected: exit=0，`Test Files 30 passed`（**28 + 2**：本任务新增 `snapping.test.ts` 与 `editing.test.ts` 两个文件）、`Tests 406 passed`（**338 + 68**；正文原先的 337 是 T5 编写期的账，T5 实测 338，差源见 Task 5 回填。68 = snapping 28 + editing 30 + pick 3 + handles 7，全部落在 scene-2d，core 零改动零新增：`git diff 14aa415..01d0226 -- packages/core` 为空）。同时**老用例一条都不许改**：Step 3 与 Step 5 动了 `pick.ts` / `handles.ts` 的既有写法，那六处订正逐条列在"本任务会改到 T4/T5 的六处既有写法"里 —— 在那六处之外的任何一条老用例变红，都是本任务把某处判据改松了，停下来核对。

```bash
git status --porcelain
git diff --stat
git add packages/scene-2d
git commit -m "feat: 五档吸附、拉墙草稿与删除计划进 scene-2d"
git add apps/desktop scripts package.json
git commit -m "feat: 拉墙与删除接上屏幕，--draw-shot 二十八行判据"
```
第一条提交信息带上：snapping 28 条 + editing 30 条 + pick 3 条 + handles 7 条、Step 4 与 Step 5 的改坏清单里那些**恒红**的行号与红字（E14 / E15 / E25 / E26 各一句）、`Tests 30 passed` 与 `Tests 19 passed` 那两行、以及标了"偶发"的 E17 / E27 / E28 三行**连同它们的处置**（这三条最容易被下一个人当成"判据写坏了"重新查一遍）。第二条带上：`--draw-shot` 的二十八行 PASS、上面那三行实测读数、DR1–DR8 + DR1b 各自红在哪一处（含两条实测无牙的如实登记）。`git status --porcelain` 在两次提交之后应当只剩计划文档一类，并且 **`apps/desktop/.tscheck/` 这类临时 harness 目录必须已经删掉**（它不属于任何一个提交）。


#### 执行回填（Task 6，2026-09-28/29 实测；commits `5f760f4` … `9dd6d85`）

- **账**：`pnpm --filter @dajia/desktop typecheck` exit=0；`pnpm verify` exit=0 **`Test Files 30 passed (30)` / `Tests 406 passed (406)`**（338 基线 + 68 新增 = snapping 28 / editing 30 / pick 18（+3）/ handles 20（+7），全部落在 scene-2d；`git diff 14aa415..01d0226 -- packages/core` **为空**，core 一行未改）。真窗口四闸门：`shot` **6 行**、`pick-shot` **11 行**、`edit-shot` **21 行**、`draw-shot` **28 行**全 PASS。
- **座位事故两次（同形状）**：本 range 里两发实现座位都在 **150 轮天花板**处断、**零提交**（D2a 临终那句是"现在写确定性的第 16 步替换"，代码其实已写完，只差报告与提交）。裁决沿用 T5 那条：**接管而非再派第三棒** —— 控制位实测五道闸门后自己提交 `01d0226`。教训入库：**别在一个座位里塞 Step 7 + Step 8**，把"实现"与"验证 + 收口"拆成两棒（D2b 就是这么拆的，它正常交收了九条）。
- **Step 7 的第 16 步（星形那一发）比控制位的 addendum 好，收下**：addendum 写的是"按在样例房某枚既有角点 ±1px"，实测两版都不稳定；实施改成了**不动点构造** —— 角点自己在闸门里现造（横竖两发预备墙 = 二臂直角，当场验 `lastError` 为空），第三发按在**同一发像素**上 ⇒ 端点候选与两枚垂足候选毫米逐字相同、并列由 `PRIORITY` 判给端点，与视口相位无关。**根因值得所有后续真窗口"按在既有角点上"的判据记住**：可当锚点的共享端点是按 **id 的代码单元序**挑的（`handles.ts` 的 `byKind('wall')` 同一条），id 是每次开机重造的 uuidv7 ⇒ 抽到哪枚角点本来就随机；而垂足是到轴线**线段**的正投影，按构造永不比端点远，只有逐字并列才轮到档位优先级。**跨运行检验过了**：同一份树连跑 5 次全 exit=0 / 28 行，`startPointId` 换过 3 枚、`previewNearCursorPx` 在 16/20 之间跳，而 `starStartDistPx` **五次逐字相同** = 0.054114724374674544、`snapMarkAtMove` 恒 112 ⇒ 第 16 步确实与"抽到哪枚角点 / 视口相位"无关。
- **`D4` 的 `distPx`：正文那个"逐字 0"是写错的预言，实测与判据都已改口（评审 Q1 独立裁定：不收回、不加重）**。真窗口 `pxPerMm ≈ 0.12417`（探针两发像素 ÷ `lengthMm` 现算，`main/index.ts:1310`），而 S8 ① 那个 0 量在合成夹具的 8mm=1px 二进制对齐格点（0.125）上。实测离散值只有 **0.3298 / 0.4508** 两个（跨 15 次干净运行）；构造上界：终点毫米与探针 guess 逐字相同时，残差只剩整数像素取整的 ≤0.5px/轴（对角 **≤0.71px**），正文注释原先写的"≤1px/轴（√2≈1.42）"把界说宽了一倍。**位置对账不在这一行**：第 3 步 `JSON.stringify(r.draft.end.mm) === JSON.stringify(probe.endMm)`（`main/index.ts:1013`）、第 8 步 `builtCreate.endMm === probe.endMm`（`:1097`）与 `D12` 三处**逐字相等**钉着 —— 吸错别面墙先红在那三处，`≤1.5` 只允许"吸对了"的方向档把落点拽离光标一个亚像素。代码旁白里那两处"distPx 恒 0"也一并改成实测口径（`2e1aa7c`）。
- **Step 8 的九条改坏（DR1–DR8 + DR1b）实测**：七条有牙（DR1、DR4、DR5、DR6、DR7、DR8、DR1b），两条无牙（DR2、DR3）。凭据 = `task-6D2b-report.md` 那张九行表 + `dr<N>-run.log` 九份落盘日志（控制位逐条重数过：七条 `PASS=0` + 一条 `--shot 失败：Error:`，DR2/DR3 `PASS=28`）。
  - **DR1b 推翻 addendum A1 的"恒绿"裁决**：只摘终点那一支 `paintSnapMarker` ⇒ `exit=1`，红在 `main/index.ts:1352`（W1「横拖吸上了却没画第四色标记」）—— 星形那发起点按构造**不吸任何人**（按在空白角），橙色像素唯一来源就是终点支。A1 的结构性论证只覆盖了第 2、3 步（那里起点恒吸端点、全局橙色计数恒 >0）。**"两支分家无牙"降级为"仅对第 2/3 步成立"**；判据一字未动，也没有为了满足它去加"橙像素必须是 56 的整数倍"那种计数等式（A1 的禁令照守）。
  - **DR3 是等价变异，不是"那一发没测到"**（改坏表那行已按实测重写）：`snapping.ts:272` 的零位移筛（`dx !== 0 || dy !== 0` 才把方向档投进池子）⇒ 只要锚点 ≡ 裸落点，给不给锚点结果逐字相同，与按下位踩不踩端点**无关**。三种形状各实测过：照正文字面 ⇒ 绿（且资源哈希 `index-DoffTLFe.js` ≠ 基线 `index-Blnm6r8A.js`，证明变异**确实进了产物**）；锚点 `{x:0,y:0}` ⇒ 绿（方向候选跑到 8px 容差外）；锚点"裸毫米 +1mm"（= 真的让按下吃方向档）⇒ **红在第 16 步 W1**「空白角按下了吸附」。单测侧的牙齿本来就在（`editing.test.ts` 的「起点在空白处按下：什么都不吸，也不吃角度档」）。
  - **DR2 是真无牙，按 HB5 的先例挂给 Task 8 并带具名出口**：现手势终点吸附位移只有 0.33/0.45px，落进 `previewNearCursorPx` 的 ±2px 第五桶 ⇒ "线画到吸附点"与"画到裸光标"像素不可分。**为什么不在这里补**：一发故意偏 5–6px 的光标只在"没有 group-0 候选来抢"时才保持 `end.mm === probe.endMm`，而 uuidv7 挑中的探针点某次开机旁边就有 8px 内的静态候选、另一次没有 —— 那正是 `main/index.ts:1199–1217` 记过的相位抖动。稳的形状是给 `wallProbe` 加一条**邻域无候选筛**（scene-2d 改动 + 自带单测，`editing.ts:401–411` 的筛②–⑥旁边加一条），Task 8 落地。
  - **DR6 红得比预言晚一步**：摘掉 `retain(kept)` 后第 12 步的谓词读的是**留档值** `kept`（`:801`/`:803` 照常跑）所以照过，未剪枝的**活体**选中集在第 13 步撤销时以 `undid.selectedIds` 现形才红。与 T5 的 R3 同一形状：红的位置不同、判定不变、判据不动。
- **本节正文一条都没预言到、由累计评审抓出的 Critical（已修）**：真人手势可达的 star **白屏**。修 = paint effect 函数体 `try/catch` → 新增 `editorStore.reportPaintError(err)`（**只动 lastError、零 revision**，沿用 `拖不动：`/`删不动：` 的中文形状，新增 `画不出来：`），没有在 UI 侧复述四道派生守卫、也没有在 catch 里再试跑派生。**反控做过**：把 catch 体改回 `throw err` ⇒ 同一份 CDP driver `alive=false`、`lastError=null`、`depth=null`、exit=1 ⇒ "白屏不再发生"这句有牙齿。可达性是控制位自己扫的（48/48 发，见上面正文订正）。
- **同一轮修掉的三条 Important**：`deletedIds` 改记真源账（派发后按 `log.document.get(id) === undefined` 筛，不动 `dispatchBatch` 的公共 API）；三条恒真断言换成与独立来源比对（`snapping.test.ts` 新增 `isCandidateForSnap`，只吃 `field` 表与锚点，不调 `snapFromCursor`/`dropTargetOf`；`editing.test.ts` 那两条改与命令层独立现算的形状比），**用例条数一字未动**；两处说明文字与代码对齐。
- **Step 7 纪律 ③ 的机制与正文不同（评审 I3，已按代码真话订正，牙齿没丢）**：正文说"前六条基线判据读的是**最后落盘的那一份报告**"，落地读的是第 15 步重做之后那份快照 `fin`（`main/index.ts:1480` 的 `out1 = { ...fin, … }`）；第 16 步的三面星形墙落在它**之后**、故意留在文档里，它自己的判据只吃那一发的前后差。"回到基线"那几处硬 throw 全在第 9–15 步，所以没有任何一条判据把星形之后的状态当基线读。评审给了两个选项（末尾补 Ctrl+Z×3 再读一份 / 改正文措辞），**选后者**：与 HB5 同一种处理 —— 说出代码的真话，不为了对上正文去补一发输入。
- **裁决教训（入库）**：给一条判据找理由时，机制要自己 grep 读到函数体。本轮三处栽在"把编写期预言当实测"——A1 的"恒绿"、"颜色逐字节相等"、"distPx 恒 0"，各被 DR1b / F4 / Q1 推翻一次。**新口径**：任何"每帧像素距离"进判据前先连跑几次看是不是**双峰**，别把一次读数当常数。
- **顺带扫出的同类残留（已一并改口，2026-09-29）**：正文里凡是把 `--draw-shot` 数成 27 行的十处
  （Task 6 的 Step 7 判据行与两条 commit message、Task 7 的 P9 那一格、Task 8/9 正文与代码 listing 里「那 27 行像素判据」之类）统一改成 **28**；
  `pick-shot` 写作「十行 / 10 行」的**六处**改成 **11 行**（Task 4 起实测就是 11；Task 4 正文那两处预言保留原样，
  由它自己的回填记成「正文那张十行表 + 新增的原点行 = 11 行」）；Task 6 Files 里 `handles.test.ts +7 ⇒ 19` 改成 **⇒ 20**；
  verify 账 `405（337+68）` 改成 **406（338+68）**。另订正 5375：那句「27 条手搭用例」按盘上事实改成 **26 条**
  （`snapping.test.ts` 实测 28 个 `it(`，其中 494 / 542 两条带 `fc.assert` 是属性用例 ⇒ 手搭 26；正文 5377 自己写的合计 28 条与此一致）。
- **Task 7 Step 8 那两行命令指的是不存在的文件**（`node scripts/desktop-draw.mjs --draw-shot` / `desktop-edit.mjs --edit-shot`）：
  四道闸门一直是同一个 runner `scripts/desktop-shot.mjs` 上的开关，由根 `package.json` 起（`shot` / `pick-shot` / `edit-shot` / `draw-shot`）。
  已按盘上事实改写，并写明 **T7 若要加 `--prop`，加的是同一个文件里的第四个 mode 与一条 script**，别凭空造第六个文件。
- **交接给 Task 7 的账**：① `assertDerivesAfterApply` 一落地，本节 ⑥ 那条"命令层放行、派生层抛"的单测判据要换成"两层同判"（Task 7 正文 Step 6 已写逐字改法），`legalDrop` 与真源同判后 `derivesAfterMove` 那层遮蔽（HB5 恒绿的根因）自动解套，复测口径 = 改坏 HB5 恰好红 6.6 与 6.7。② 真窗口侧的 star 保险（`lastError`「画不出来：…」）在复核挂上之后应当**两边都不许写进真源**，`D22` 的语义随之从"活着且有报错"改成"落盘被拒"。③ uuidv7 随机角点那条告警适用于 T7/T9 任何"按在既有角点上"的判据。
- **挂账**：`wallProbe` 邻域无候选筛（DR2 的牙）→ **T8**；快捷键不判 `event.target`（在输入框里敲 `w` 会切工具）→ **T8**；`fieldRef` 没省下它注释声称省下的东西（性能观察，样例房八面墙看不出来）；IME 下 `event.key` 可能是 `'Process'`（闸门只发合成事件，抓不到）→ **T8/T9**。
- **评审结论**：单座 `t6-reviewer`（`14aa415..01d0226`）判 **Ready to close**，**0 Critical / 3 Important**，三条都是"记录面"（正文与旁白与代码不符），无判据被放宽、无 `throw` 被换成 `console.warn`、无等待条件调松；三件单独裁的事各裁完（Q1 保留 `≤1.5` 并给出一条更紧的可行替代 `≤1.0` 但判定不必；Q2 判 DR3 = 改坏表写错行、DR2 = 挂 T8 并具名出口、DR1b = 如实登记；Q3 硬账逐条核过，含 `it.skip`/`it.only` 零命中、老用例只动授权那六处、导出全部有消费者（仅 `pickPxOf` 只被测试吃，属正文授权，Minor））。报告 `task-6-review.md`。


### Task 7: core 补口 —— 派生复核与属性/删除命令（"能改"落到真源）

计划 3 的前六个任务把屏幕搭完了：能看（T2/T3）、能点（T4）、能拖（T5）、能拉新墙（T6）。这七处里**唯一不动屏幕的一节**在 core：属性面板与删除键要的三条命令（`wall.setMaterial` / `wall.setLoadBearing` / `storey.delete`）与 T8 要的 `column.delete` / `slab.delete` 今天还不存在，而 T5/T6 一路记在边界表里的那条差额 ——「`legalDrop` / `legalWallCreate` 只试跑命令的 `build`，不跑派生层 ⇒ 拖出或拉出一颗星会被预言为合法、在重绘时抛」—— 也只在 core 收口才收得干净。本任务一次做两件事：**补口**（五条新命令 + `CommandType` 从 11 种到 16 种）与**复核**（改几何的三条命令在 `build` 末尾把整层派生跑一遍）。

Task 8 的属性面板、删除键与 `planDelete` 的 `unsupported` 分支全部压在这一步的出口上（Task 6 开头「Task 8 对它们的依赖」那段里那句"`planDelete` 的 `unsupported` 是 Task 8 补 `columnDelete`/`slabDelete`/`storeyDelete` 时唯一要接的口子"；同段还有一句"补完之后 `DeletePlan.unsupported` 在样例房里恒空，那条用例要跟着改成'柱'" —— 那句判据的改动归 **Task 8**，因为要接的是 `planDelete` 接屏时才会用到的柱/板夹具），所以这一步的产物是**命令与判据**，UI 侧只碰三处既有写法（见"本任务会改到的既有写法"第 4、6、7 条，全在 scene-2d 的两个文件里）。

**Files:**

- Create: `packages/core/test/derive-guard.test.ts`（**9 条**：三条改几何命令的复核各一组，加"复核只挂这三条"的反面一组）
- Create: `packages/core/test/commands-attributes.test.ts`（**12 条**：`assertMaterial` 的三种文案、`wallSetMaterial` / `wallSetLoadBearing` 的补丁形状与撤销栈）
- Create: `packages/core/test/commands-delete.test.ts`（**12 条**：`storeyDelete` 的级联与闭合性、`columnDelete` / `slabDelete` 的孤儿点、`pointStillReferenced` 本身）
- Modify: `packages/core/src/model/command.ts`（`CommandType` 11 → 16）
- Modify: `packages/core/src/geom/outline.ts`（+20 行：`assertDerivesAfterApply` 的唯一产地）
- Modify: `packages/core/src/geom/topology.ts`（+30 行：`pointStillReferenced`，从 `wall.ts` 的文件私有函数搬上来）
- Modify: `packages/core/src/commands/wall.ts`（+94/−25：三条命令挂复核、`assertMaterial`、`wallSetMaterial` / `wallSetLoadBearing`、`wallDelete` 改问拓扑那份）
- Modify: `packages/core/src/commands/storey.ts`（+60：`storeyDelete`）
- Modify: `packages/core/src/commands/column.ts`（+35：`requireColumn` + `columnDelete`）
- Modify: `packages/core/src/commands/slab.ts`（+41：`requireSlab` + `slabDelete`）
- Modify: `packages/core/test/joint.test.ts`（5 条既有守卫用例改 `handBuild`；条数 **18 不变**）
- Modify: `packages/scene-2d/test/editing.test.ts`（**4 条既有用例改写**，见 Step 6 的实测清单，条数 **30 不变**）
- Modify: `packages/scene-2d/test/handles.test.ts`（**3 条既有用例改写 + 删掉一个用不上的助手**，条数 **20 不变**；订正 2026-09-29：编写期那本账写的是棒 C/D 之前的 19，Task 6 落地后盘上实测 20 条）
- Modify: `packages/scene-2d/src/editing.ts`（**只动注释**三处，见 Step 6 的 ①②③；代码一字不动）

**`packages/core/src/index.ts` 一字不改**：那个文件对 `commands/storey` / `commands/wall` / `commands/column` / `commands/slab` / `geom/topology` / `geom/outline` 全是 `export *`（2026-09-28 核对），新出口自己就流出去了。代价是**红了不好看**：测试文件里 `import { storeyDelete } from '@dajia/core'` 在实现落地之前不会在链接期抛 `SyntaxError`，vitest 走 SSR 转译，那个名字是 `undefined`，要到**调用那一行**才炸成 `TypeError: storeyDelete is not a function`（Task 6 Step 4 已在临时工程里对十个新出口实测过这个形状）。Step 2 的"红在哪"按这个预期核对。

**计数账**（2026-09-28 的 `.tscheck/t8` 临时工程**实跑**出来的，不是加出来的）：core 从 **21 个文件 / 276 条** 到 **24 个文件 / 309 条**（+9 +12 +12，`joint.test.ts` 的 18 条一条不增不减）；scene-2d **6 个文件 / 114 条** —— viewport 9 + drawlist 10 + pick 18 + snapping 28 + editing 30 + handles 19，本任务那七条用例改写全落在 `editing.test.ts` 与 `handles.test.ts` 两个文件里，**条数一条不增不减**。那一跑的真账：`Test Files 30 passed (30) / Tests 423 passed (423)`，`npx tsc --noEmit`（core/src + scene-2d 的 src 与 test）exit=0。临时工程不装的两段：`packages/core/test/commands-drag.test.ts` 的 **7 条**（T5）与 core / scene-2d 之外的 **8 条**（`packages/protocol/test/ipc.test.ts` + `scripts/test/deps-check.test.mjs`；2026-09-28 对真仓库跑 `npx vitest run` 得 `Test Files 23 passed (23) / Tests 284 passed (284)`，正是 core 276 + 这 8）⇒ 全仓 **405 → 438**（284 + 114 + 7 + 33）。基线 276 是同一天在同一临时工程里对**真仓库**的 `packages/core` 重测过的（`Test Files 21 passed (21) / Tests 276 passed (276)`），不是抄计划 2 的旧数。

> **2026-09-29 盘上真账（Task 6 收尾后 `pnpm verify` 逐字）**：`Test Files 30 passed (30)` / `Tests 406 passed (406)`，分区 = core **22 文件 / 283 条**（含 `commands-drag.test.ts` 7 条）、scene-2d **6 文件 / 115 条**（handles 已是 20 条）、protocol 3、scripts 5。本任务只往 core 加 33 条 ⇒ 执行日的判据 = **33 文件 / 439 条**，core 段 = **25 文件 / 316 条**，scene-2d 段一条不增不减（115）。

---

**裁决（本任务定下的四条，加上 T6 交接过来的一张账）**

| # | 问题 | 裁决 | 理由与代价 |
| - | ---- | ---- | ---------- |
| A1 | 「建得出但画不出」的那一发在哪里挡？UI 再算一遍接头分类，还是 core 的 `build` 里复核一遍派生？ | **core**：`assertDerivesAfterApply(doc, patch, storeyId)` 放在 `wallCreate` / `wallMoveEndpoint` / `wallSetThickness` 三条命令 `build` 的**最后一行**，删除路径一条不挂 | 派生的四道守卫（star、同向重叠、近平行求不出接缝点、轮廓翻面）只有 `deriveStoreyGeometry` 一个产地；UI 侧预言"画不画得出来"必须复述这四道，而 `commands/opening.ts` 顶部那句"命令层绝不复述区间规则"早就给复述定过价。`applyPatch` 是纯函数、不动传进来的 doc ⇒ 草稿免费（`assertFitsAfterInsert` 同一条手法）。**代价实测**：一次带复核的 `build` 在 13 墙 0.055ms、31 墙 0.069ms、61 墙 0.161ms（2026-09-28，`bench/perf.test.ts`，整层派生本身 0.033 / 0.056 / 0.135ms）⇒ `pointermove` 每帧几次的量级仍然便宜，`legalWallCreate` / `legalDrop` 白捡一道。**副作用要写清**：复核吃的是**整份文档**（`deriveJoints` 是全局的），所以任何一层藏着坏数据，别层的每一条改几何命令都替它抛 —— 计划 4 的读盘读到坏层时本层是**冻结写入**的，`derive-guard.test.ts` 有一条专门钉这个形状。 |
| A2 | 孤儿点的判定谁说了算？ | **`geom/topology.ts` 的 `pointStillReferenced(doc, pointId, exceptIds)`**，`wallDelete` 原来那份文件私有 `stillReferenced` 删掉、搬上来，`columnDelete` / `slabDelete` 共用 | 三类引用者（墙两端 / 柱落点 / 板边界）少查一类就会删掉别人还在用的点，而真源不校验引用完整性（`Document.replaceEntities` 只查整数毫米与 id 形状）⇒ 悬空引用一旦写进去，屏幕与图纸两头各自解释。参数从"单个 exclude id"改成 `ReadonlySet` 是因为删一面挂着板的墙时，那枚点同时被这块板引用，而板也在同一批删除里 —— 它不该算数。**代价**：柱与板的删除从此必须记得传 `exceptIds`，`commands-delete.test.ts` 里那条"墙、柱、板三种引用都认"就是这条判据的哨兵。 |
| A3 | `storeyDelete` 怎么数下游？删到最后一层怎么办？ | 级联**不复述**：问 `dependentsOf`（楼层的墙/洞口/柱/板那份表），点按 `storeyId` 单独收；再叠一道**闭合性检查**（被删实体的下游必须也在删除集里，否则抛）；**最后一层不许删** | `dependentsOf` 已经存在且返回顺序写进了注释，这里再数一遍就是第二个产地，计划 4 加家具时漂掉的必然是本函数那一遍。点不在那张表里（`dependentsOf` 的 storey 分支只列构件），所以单独收 —— 那也不是复述引用规则，点是**属于**这层的而不是被这层引用的。闭合性检查兜的是"上面那张表写错/写漏"和读盘造出来的跨层悬空两种情况。最后一层的判据不是审美：`aabbOfPoints([])` 是**抛**的（计划 2 立的口径），删空之后屏幕每次重绘都炸，与其让 UI 兜不如真源不产这种状态。**代价**：删错了不能靠"删空再重建"回去，得先 `storeyCreate` 一层再删旧的。 |
| A4 | 属性命令要不要"值没变就不发补丁"？要不要跑复核？ | **都不**：`wallSetMaterial` / `wallSetLoadBearing` 各 upsert 一个字段，不查新旧、不跑 `assertDerivesAfterApply`；但材料名的写法纪律有**一个产地**（`assertMaterial`，`wallCreate` 的可选入参与 `wallSetMaterial` 共用） | 不查新旧买的是"面板反复点同一个选项各留一条撤销记录"——这是**可接受的代价**而不是遗漏，`commands-attributes.test.ts` 有一条用例专门把它钉成预期行为（判据是 `build().upsert` 逐字等于那面墙 + `depth` 每次 +2），否则下一个读到它的人会以为是 bug 顺手加短路。材料不进派生表（`deriveStoreyGeometry` 只读墙的几何与厚度），跑复核等于给每条属性命令加一次整层派生。写法纪律只挡"存进去就没法看"的三种（空、带首尾空白、超 32 字符），下拉框的候选集是产品选项不是数据约束，留在 UI 侧。**改坏实测 M7**：给 `wallSetLoadBearing` 加 noop 短路，第一次跑**居然是绿的** —— 原判据只问 `depth` 变没变，而短路之后 `build` 返回空 upsert、`applyPatch` 不产生变更、`dispatch` 也就不加深度，于是断言分不出"发了空补丁"与"根本没发"。把判据加固成"`build().upsert` 必须逐字是那面墙"之后 M7 才红（`AssertionError: expected [] to deeply equal [ { kind: 'wall', …(9) } ]`）。这条纪律与全局约束里那句"断言要分得开故障"是同一件事。 |

**T6 交接四条的处置**（Task 6 Step 4 末尾那条「交接给 Task 7 的四条」，本任务收两条、留两条给 T8/T9）：

- ③ **收口**：`legalWallCreate` / `legalDrop` 的差额在 core 侧补齐了 —— 屏幕上"预言合法、重绘才抛"那一发从此在 `build` 就抛，`dispatch` 的 `catch` 会把它记进 `lastError`（T5 D6 的口径不变：不预检、让真源判）。
- ④ **实测之后不迁就**：复核**没有**改变"画得出的那一发"，但**改变了每一枚端点的第一发过 `build` 的候选**。2026-09-28 在 `.tscheck/t8` 临时工程里重测过这一条（**core 与 scene-2d 都在**：吃的是真 `demoHouse()`、真 `snapFieldOf` / `handleDropTarget` 的吸附落点、`WALL_PROBE_OFFSETS` 与 `PROBE_OFFSETS` 两张原表；编写期那次是手工复刻，那一版的四个数下面逐条订正），8 枚端点 × 10 发 = **80 发**、16 把把手（去重后 **8 个**位置）× 10 发 = **160 发**，各问两遍（复核在 / 复核摘掉），实测结论：
  - 拉新墙：复核在 `build` 拒 **48** 发、可建 **32** 发；文案分两桶 —— 只提 star 的 **24** 发、star 与同向重叠写在同一句抛错里的 **24** 发，**"只提同向重叠"的文案这一批一发都没有**（编写期写的"star 24、同向重叠 24"是把两桶当成两件事，别再照它去找第三种文案）。摘掉复核 `build` 拒 **0**、`build` 过了但 `buildDrawList` 抛的正是**同一批 48 发**、可建仍是 **32** ⇒ **筛 ⑥ 从此不再单独挡任何一发**。`legalWallCreate` 与手搓 `wallCreate(...).build` 在这 80 发上**逐发同判**（`legalDiff = 0`，两侧都是 0）。
  - 拖把手：摘掉复核时 **160 发全部过 `legalDrop`**（Task 6 Step 5 里 `dragProbe` 那段注记与它下面那条"落点计数"引文块各说过一次；两处已就地标注"只对 Task 6 落地时成立"），复核在则 `build` 拒 **84** 发（桶只有一个：`{"star":84}`，文案全是接头那句）、可拖 **76** 发。`legalDrop` 与手搓 `wallMoveEndpoint(...).build` 同样逐发同判（`legalDropDiff = 0`）。恒等落点（拖回把手自己那枚坐标）在这把尺子上**一发都没有**（`skipped = 0`），160 发全进了判决；16 把把手**每一把都还剩 ≥3 发**（`minLegal = 3`），靶子仍然给得出。
  - **"第一发过 `build` 的候选"往后挪了，"第一发画得出的候选"一格没动**：前者在 8 枚端点里挪了 **5 枚**（`(0,0)`→第 2 发、`(4000,0)`→第 3 发、`(0,6000)` / `(800,3000)` / `(4000,3000)`→第 1 发；两个 `8000,*` 角与 `(7000,3000)` 仍在第 0 发），在 16 把把手里挪了 **12 把**（第 0 发→第 1 发，另外 4 把不动）；摘掉复核时这两张表**全是第 0 发**，所以位移是复核自己造成的，不是采样噪声。编写期那句"12 个把手位置里的 9 个"两个数都不对：把手是 **16** 把、去重位置是 **8** 个，挪动的是 16 把里的 12 把。而"第一发 `build` 与派生都过"的表在两侧**逐字相同**（8 枚端点分别还是 2/3/0/0/1/1/1/0）⇒ 样例房最终靶子不换的理由不是运气，是筛 ⑥ 早就把第 0 发挡在了外面：`(4000,3000)` 那一枚两侧都给第 1 发 `(0,2000)`，落点 `(4000,5000)`。
  - 两道探针的**答案**在进程之间本来就会漂，这一点必须写进执行日的判据：`wallProbe` 两侧都只在那两发里挑（`(4000,3000)→(4000,5000)` 与 `(800,3000)→(800,5000)`），同一份"复核在"的配置两次独立跑给出过 **5/3** 与 **7/1** 两种分布，"摘掉复核"那一次给 **7/1** ⇒ 编写期写的"`wallProbe` 的答案不变"这句**不成立**，只有"候选集合不变"成立。`dragProbe` 报出来的靶子在两侧分布确实不同（复核在：`→(700,450)` 六次、`→(1100,-25)` 两次；摘掉：六种靶子各 1～2 次，含 `→(600,350)/mm(3986,3854)` 那种把三臂拧成 star 的一发）—— 但这里**两件事叠在一起**：候选集合被复核砍掉一半，加上 uuidv7 的并列顺序，所以不能把这组差异单独归因为"复核改了靶子"。因此本任务 Step 8 要求：`--draw-shot` 与 `--edit-shot` 在 T7 之后**各跑一遍取新字面量**，判据形状一字不改（不许把"那一发"写成"任一发"）；**执行日对不上时先把同一版本再跑一遍**，看它自己漂不漂，再怀疑复核。
- ① **留给 T8**：`MIN_WALL_LENGTH_MM` 与数值输入第一次分家。
- ② **留给 T8**：筛 ⑤/⑥ 的确定性夹具（复核之后 ⑥ 已经没有单独可挡的东西，那条夹具要配的是"命令层与派生层判得一样"这个新命题，见第 6 条既有写法）。

---

**本任务会改到的既有写法**（一次列全，免得执行时把订正当成抄错）

1. `packages/core/test/joint.test.ts` 里**五条**"合法命令造得出画不出的文档"的哨兵用例（`sameRay` / `threeOnOneLine` / `insideTee` / 夹角小到翻面 / 直通两墙厚度不同 / Y 形三臂 star —— 前三条在同一条用例里，所以是**五条用例六处造图**）必须改成 `handBuild(...)` 手工造文档。改完 `deriveJoints(...)` 的入参从 `log.document` 变成 `doc`。**不是删用例**：那四道守卫是计划 4 的读盘与计划 6 的协作写入唯一的哨兵，命令层提前挡住不等于派生层可以不测。
2. `packages/core/src/commands/wall.ts` 文件末尾的私有函数 `stillReferenced` **整段删除**，`wallDelete` 改问 `topology.pointStillReferenced`（A2）。签名从 `(doc, pointId, excludeWallId)` 变成 `(doc, pointId, ReadonlySet)`。
3. `wallCreate` 的 `material` 从"什么都不查"变成构造期过一次 `assertMaterial(input.material, '墙材料')`。**只有传了才查**：`input.material === undefined` 仍然走 `'brick'` 兜底，所以既有 21 个测试文件里没传 `material` 的建墙调用一条都不必改（实测 276 条基线原样绿）。
4. `packages/scene-2d/src/editing.ts` 里**三处**"命令层不跑派生"的措辞（2026-09-28 逐字核对过，`handles.ts` 里**没有**同类注释 —— `legalDrop` 的 doc 注释只讲"试跑真命令、不抄轴长比较"，那一条 T7 不动，别去它里面找）：① `wallProbe` 头部那串六道筛的第 ⑥ 句「命令层的 `build` 不含接头分类」；② `wallProbe` 循环里那句行内注释「`legalWallCreate` 只跑命令的 `build`，看不见接头分类」；③ `derivesCleanly` 的 doc 注释首句「`legalWallCreate` 只跑命令的 `build`，那一道里没有接头分类」与末段「它只护住探针 —— 用户手拉的那一发斜墙仍然只过 `legalWallCreate`，星形接头在屏幕上的缺口原样登记给 T7」。三段**在 T7 之后是错的**（`wallCreate` 与 `wallMoveEndpoint` 的 `build` 末尾就复核派生），统一改成"core 的三条改几何命令已在 `build` 末尾复核（`assertDerivesAfterApply`），`legalWallCreate` / `legalDrop` 与真源同判"。T5/T6 边界表里那条差额在本任务收口，注释留着旧说法就是下一轮误判的源头。
5. 计划 2 的口径要跟着记一句：`deriveJoints` 全局 ⇒ 复核吃整份文档。这条不是新事实，是把第 4 段"删除路径永不复核"与它分开：坏数据**删得掉**（`wallDelete` / `openingDelete` / `columnDelete` / `slabDelete` / `storeyDelete` 全不挂复核），但**改不动**（三条改几何命令一律替别层的坏数据抛）。`commands-delete.test.ts` 里"坏数据必须还能删：逐面删掉星臂之后这一层重新派生得动"那条就是这条口径的凭据。
6. `packages/scene-2d/test/editing.test.ts` 的「⑥ 的前提：同一发候选命令层放行、派生层抛（星形接头）」**会红**，且红在两处：`expect(legalWallCreate(log.document, draft)).toBe(true)`（现在给 false）与它下面那句 `trial.dispatch(command)`（现在抛 `/star/`，用例直接炸）。改法见 Step 6 —— 判据从"命令层放行、派生层抛"换成**"两层同判"**，这正是 A1 想要的那个命题，用例不改名、条数不变。
7. `packages/scene-2d/src/editing.ts` 的 `derivesCleanly` 注释里"每个候选多一次整层派生 … 它只护住探针"要补一句：T7 之后它与 `legalWallCreate` **判得一样**（同一发命令、同一个 storey、同一份结果文档），它从此是第二道保险而不是唯一防线。**与第 4 条 ③ 是同一段注释，一次改完**，别分两次动那个文件。代码不动 —— 删掉它的唯一凭据是"真仓库里跑一遍 E28 那条改坏"，那属于执行日的事，写在 Step 6 的验证里。

---

**Interfaces:**

- Consumes：计划 2 落地的 `deriveStoreyGeometry` / `applyPatch` / `dependentsOf` / `requireStorey` / `mustExist`，计划 1 的 `Command` / `Patch` / `Document.byKind` / `uuidv7`，以及 `commands/opening.ts` 里 `requireOpening` 的读取断言口径（本任务的 `requireColumn` / `requireSlab` 照它的形状抄）。
- Produces（`@dajia/core` 的新出口，T8 的属性面板与 `planDelete` 逐条要接）：

```ts
// model/command.ts —— 11 → 16
export type CommandType =
  | 'storey.create'
  | 'storey.setElevation'
  | 'storey.delete'          // （T7 加）
  | 'wall.create'
  | 'wall.moveEndpoint'
  | 'wall.setThickness'
  | 'wall.setMaterial'       // （T7 加）
  | 'wall.setLoadBearing'    // （T7 加）
  | 'wall.delete'
  | 'opening.create'
  | 'opening.move'
  | 'opening.delete'
  | 'column.create'
  | 'column.delete'          // （T7 加）
  | 'slab.create'
  | 'slab.delete';           // （T7 加）

// geom/outline.ts
/** 命令层的派生复核：候选补丁贴到草稿上跑一次整层派生，派生抛则命令抛。 */
export function assertDerivesAfterApply(doc: Document, patch: Patch, storeyId: EntityId): void;

// geom/topology.ts
/** 除 exceptIds 之外还有谁引用这枚点：墙（两端）、柱（落点）、板（边界）。孤儿判定的唯一产地。 */
export function pointStillReferenced(
  doc: Document,
  pointId: EntityId,
  exceptIds: ReadonlySet<EntityId>,
): boolean;

// commands/wall.ts
/** 非空、不带首尾空白、不超 32 字符；label 只改文案，规则一处。 */
export function assertMaterial(material: string, label?: string): string;
export function wallSetMaterial(input: { wallId: EntityId; material: string }): Command;
export function wallSetLoadBearing(input: { wallId: EntityId; loadBearing: boolean }): Command;

// commands/storey.ts / column.ts / slab.ts
export function storeyDelete(input: { storeyId: EntityId }): Command;
export function columnDelete(input: { columnId: EntityId }): Command;
export function slabDelete(input: { slabId: EntityId }): Command;

// wallCreate 从此多一道构造期守卫：input.material 传了就过 assertMaterial(…, '墙材料')
// wallCreate / wallMoveEndpoint / wallSetThickness 的 build 会抛派生的四类 RangeError：
//   /star/、/同向重叠/、/厚度不同/、/翻面/
```

---

- [ ] **Step 1: 类型面 —— `CommandType` 11 → 16**

`packages/core/src/model/command.ts` 里那个判别式 union 是**唯一**需要动的类型文件（`Command` 接口本身不动，`type` 只是标签，`TransactionLog` 靠 `build`/`invert` 工作）。整段替换：

```ts
export type CommandType =
  | 'storey.create'
  | 'storey.setElevation'
  | 'storey.delete'
  | 'wall.create'
  | 'wall.moveEndpoint'
  | 'wall.setThickness'
  | 'wall.setMaterial'
  | 'wall.setLoadBearing'
  | 'wall.delete'
  | 'opening.create'
  | 'opening.move'
  | 'opening.delete'
  | 'column.create'
  | 'column.delete'
  | 'slab.create'
  | 'slab.delete';
```

Run: `npx tsc --noEmit -p packages/core/tsconfig.json`（或 `pnpm typecheck`）
Expected: exit=0。这一改**不可能红**：加 union 成员是放宽。它单独提交也不改变任何行为 —— 放在第一步是因为后面四步都要往命令对象上写 `type: 'storey.delete'` 这类字面量，晚改一步就编译不过一步。

---

- [ ] **Step 2: 写失败测试 —— 三个新文件全文 + `joint.test.ts` 的五处改写**

顺序纪律照 T5/T6：**先把测试整份落地跑到红，再写实现**。三个文件一次给全，逐字抄进去。

**2a. `packages/core/test/derive-guard.test.ts`（9 条）**

这一份钉的是 A1 的正面与反面：三条改几何的命令各有一组"改得出画不出的几何 ⇒ `build` 就抛、文档与撤销栈都不动"，外加"复核只挂这三条"那一组（坏数据删得掉、材料命令照过）。开头那段注释解释了它和 `joint.test.ts` 的分工，别删。

```ts
// 派生复核（`assertDerivesAfterApply`）：改得出"画不出来的几何"的那一发，命令层就抛，
// 且不留痕迹。计划 3 Task 7 的 A1。
//
// joint.test.ts 里那四条守卫用例（同向重叠 / 翻面 / 直通异厚 / star）从 Task 7 起改成
// **手工造文档**（`handBuild`），因为命令层已经不让它们走到派生层了。这个文件钉的是正面：
// 正常建房子的路走不到那四种文档，而坏数据仍然删得掉。
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  applyPatch,
  deriveStoreyGeometry,
  storeyCreate,
  uuidv7,
  wallCreate,
  wallDelete,
  wallMoveEndpoint,
  wallSetMaterial,
  wallSetThickness,
  type Entity,
  type EntityId,
  type PointRef,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();

/** 一层楼、空文档。每个用例自己往上盖墙，互不干扰。 */
function newLog(): TransactionLog {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  return log;
}

function storeyOf(log: TransactionLog, index = 0): EntityId {
  const storey = log.document.byKind('storey').find((s) => s.index === index);
  if (!storey) throw new Error(`没有序号为 ${index} 的楼层`);
  return storey.id;
}

/**
 * 走命令层盖一面墙，返回新墙。
 * 取返回值而不是 `byKind('wall')[n]`：uuidv7 同毫秒内不保证单调，byKind 按 id 升序，
 * **创建顺序在实体数组里根本没有位置可言** —— 下标选墙迟早漂。
 */
function addWall(
  log: TransactionLog,
  start: PointRef,
  end: PointRef,
  thicknessMm = 240,
): WallEntity {
  log.dispatch(
    wallCreate({ storeyId: storeyOf(log), start, end, thicknessMm, heightMm: 3000 }),
  );
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new Error('dispatch 之后没找到新墙');
}

/**
 * 手工贴墙与点（绕开命令层）：坐标相同的两端复用同一枚点 id，与命令层的共享端点语义一致。
 * Task 7 之后"合法命令造得出画不出的文档"这条路被复核堵死，要造坏文档只剩这一条路。
 */
function handEntities(storeyId: EntityId, specs: Array<[number, number, number, number]>) {
  const entities: Entity[] = [];
  const pointIds = new Map<string, EntityId>();
  const pointOf = (x: number, y: number): EntityId => {
    const key = `${x},${y}`;
    const hit = pointIds.get(key);
    if (hit) return hit;
    const id = uuidv7();
    pointIds.set(key, id);
    entities.push({ kind: 'point', id, storeyId, x, y });
    return id;
  };
  for (const [x0, y0, x1, y1] of specs) {
    entities.push({
      kind: 'wall',
      id: uuidv7(),
      storeyId,
      startId: pointOf(x0, y0),
      endId: pointOf(x1, y1),
      thicknessMm: 240,
      heightMm: 3000,
      elevationOffsetMm: 0,
      loadBearing: true,
      material: 'brick',
    });
  }
  return entities;
}

/** 把现有实体原样保留，再贴进 extras。 */
function withExtras(doc: Document, extras: readonly Entity[]): Document {
  const merged = new Map<EntityId, Entity>();
  for (const entity of doc.byKind('point')) merged.set(entity.id, entity);
  for (const entity of doc.byKind('wall')) merged.set(entity.id, entity);
  for (const entity of doc.byKind('storey')) merged.set(entity.id, entity);
  for (const entity of extras) merged.set(entity.id, entity);
  return Document.replaceEntities(doc, merged);
}

/** 三面墙、三个方向过 (5000, 5000)：S1 画不出来的那一颗。坐标离命令建的那面墙远远的。 */
const STAR_SPECS: Array<[number, number, number, number]> = [
  [5000, 5000, 6000, 5000],
  [5000, 5000, 5000, 6000],
  [5000, 5000, 5900, 6000],
];

describe('wallCreate 的派生复核', () => {
  it('三面墙过同一点、三个方向 → 命令层就抛 /star/，文档与撤销栈都不动', () => {
    const log = newLog();
    const hub = addWall(log, { x: 0, y: 0 }, { x: 1000, y: 0 }).endId;
    addWall(log, { pointId: hub }, { x: 1000, y: 900 });
    const before = log.document.canonical();
    const depth = log.depth;
    // 第三臂走斜方向 → 三条方向线过同一点 = star。加复核之前这一发**建得出来**，
    // 建完之后整层再也派生不了（屏幕侧就是重绘时抛 RangeError）。
    expect(() => addWall(log, { pointId: hub }, { x: 2000, y: 900 })).toThrow(/star/);
    expect(log.document.canonical()).toBe(before);
    expect(log.depth).toBe(depth);
  });

  it('同一点同向两笔 → 抛 /同向重叠/（重叠墙带进不了真源）', () => {
    const log = newLog();
    const spine = addWall(log, { x: 1000, y: 0 }, { x: 2000, y: 0 });
    expect(() => addWall(log, { pointId: spine.startId }, { x: 3000, y: 0 })).toThrow(
      /同向重叠/,
    );
    expect(log.document.byKind('wall')).toHaveLength(1);
  });

  it('合法的两臂直角照常建得出来；复核只读草稿，不动原档', () => {
    const log = newLog();
    const hub = addWall(log, { x: 0, y: 0 }, { x: 1000, y: 0 }).endId;
    const before = log.document.canonical();
    const cmd = wallCreate({
      storeyId: storeyOf(log),
      start: { pointId: hub },
      end: { x: 1000, y: 900 },
      thicknessMm: 240,
      heightMm: 3000,
    });
    const patch = cmd.build(log.document);
    // 复核是把补丁贴到草稿上再派生一遍，原文档一个字节都不动（applyPatch 本就不可变）
    expect(log.document.canonical()).toBe(before);
    // 起点复用 hub：复核看的就是"共享端点"这一语义，不是新建了一枚同坐标的点
    const wall = patch.upsert.find((e) => e.kind === 'wall');
    expect(wall?.kind === 'wall' && wall.startId === hub).toBe(true);
    expect(() => log.dispatch(cmd)).not.toThrow();
    expect(() => deriveStoreyGeometry(log.document, storeyOf(log))).not.toThrow();
  });

  it('复核吃的是**整份文档**：别层藏一颗星，本层也写不进墙', () => {
    const log = newLog();
    const storeyOne = storeyOf(log);
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    const storeyTwo = storeyOf(log, 1);
    const doc = withExtras(log.document, handEntities(storeyTwo, STAR_SPECS));
    // deriveJoints 是全局的（斜切量是全局性质），所以二层的坏文档会让一层的每发墙命令
    // 都替它抛错。这条行为要留档：计划 4 的读盘若读到坏层，本层是**冻结写入**的。
    expect(() =>
      wallCreate({
        storeyId: storeyOne,
        start: { x: 5000, y: 5000 },
        end: { x: 6000, y: 5000 },
        thicknessMm: 240,
        heightMm: 3000,
      }).build(doc),
    ).toThrow(/star/);
  });
});

describe('wallMoveEndpoint 的派生复核', () => {
  /** 一条直梁 + 一枚竖臂组成的合法 T 接：返回直通里"端点是 hub"的那面墙与 hub。 */
  function tee(): { log: TransactionLog; spine: WallEntity; hub: EntityId } {
    const log = newLog();
    const through = addWall(log, { x: 0, y: 0 }, { x: 1000, y: 0 });
    const hub = through.endId;
    addWall(log, { pointId: hub }, { x: 2000, y: 0 });
    addWall(log, { pointId: hub }, { x: 1000, y: 900 });
    // spine = 以 hub 为 end 的那面（拖它的 end 才是在搬 hub 本身）
    const spine = log.document.byKind('wall').find((w) => w.endId === hub)!;
    return { log, spine, hub };
  }

  it('把 T 接的公共点拖离直通线 → 三个方向过同一点，抛 /star/，文档不动', () => {
    const { log, spine } = tee();
    const storeyId = storeyOf(log);
    expect(() => deriveStoreyGeometry(log.document, storeyId)).not.toThrow();
    const before = log.document.canonical();
    const depth = log.depth;
    // hub 是三端共用的那枚点：拖 spine 的 end 就是把 hub 搬走，三臂方向同时变。
    // 命令层的轴长、零长、邻墙守卫一条都不会叫（三条边都还很长），
    // 接头分类只有派生层会算 —— 这正是 T5/T6 记的"legalDrop 只跑 build"的差额。
    expect(() =>
      wallMoveEndpoint({ wallId: spine.id, end: 'end', x: 1000, y: 300 }).build(log.document),
    ).toThrow(/star/);
    expect(log.document.canonical()).toBe(before);
    expect(log.depth).toBe(depth);
  });

  it('沿直通线拖同一个点 → 仍是 T 接，合法：红的是这一发的几何，不是"拖共点一律抛"', () => {
    const { log, spine, hub } = tee();
    log.dispatch(wallMoveEndpoint({ wallId: spine.id, end: 'end', x: 1200, y: 0 }));
    // 三端仍共 hub：拖点不拆连接，也不另造一枚同坐标的新点
    expect(
      log.document.byKind('wall').filter((w) => w.startId === hub || w.endId === hub),
    ).toHaveLength(3);
    expect(() => deriveStoreyGeometry(log.document, storeyOf(log))).not.toThrow();
  });
});

describe('wallSetThickness 的派生复核', () => {
  it('5° 斜角的两面墙：厚 120 合法，加厚到 240 会翻面 → 抛 /翻面/', () => {
    const log = newLog();
    const storeyId = storeyOf(log);
    const horizontal = addWall(log, { x: -2000, y: 0 }, { x: 0, y: 0 }, 120);
    const angled = addWall(log, { pointId: horizontal.endId }, { x: -2000, y: 175 }, 120);
    expect(() => deriveStoreyGeometry(log.document, storeyId)).not.toThrow();
    expect(() =>
      wallSetThickness({ wallId: angled.id, thicknessMm: 240 }).build(log.document),
    ).toThrow(/翻面/);
    // 加厚到 121 仍然合法：证明红的是这一发的几何，不是"这条命令一律抛"
    expect(() =>
      wallSetThickness({ wallId: angled.id, thicknessMm: 121 }).build(log.document),
    ).not.toThrow();
  });
});

describe('复核只挂在改几何的三条命令上', () => {
  /** 一份带星的文档：一面命令建的合法墙 + 三条手工星臂（三端共点、三个方向线）。 */
  function starDoc(): { doc: Document; storeyId: EntityId; legal: WallEntity; arms: EntityId[] } {
    const log = newLog();
    const storeyId = storeyOf(log);
    const legal = addWall(log, { x: 0, y: 0 }, { x: 1000, y: 0 });
    const doc = withExtras(log.document, handEntities(storeyId, STAR_SPECS));
    const arms = doc
      .byKind('wall')
      .filter((w) => w.id !== legal.id)
      .map((w) => w.id);
    return { doc, storeyId, legal, arms };
  }

  it('坏数据必须还能删：逐面删掉星臂之后，这一层重新派生得动', () => {
    const { doc, storeyId, arms } = starDoc();
    expect(() => deriveStoreyGeometry(doc, storeyId)).toThrow(/star/);
    expect(arms).toHaveLength(3);
    let cursor = doc;
    // 第一发的 build 打在**仍然带星**的文档上，后两发打在删了一半的坏文档上：
    // 删除路径不跑复核，否则守卫挡住删除等于把这份文档锁死，用户只能重开。
    for (const wallId of arms) {
      cursor = applyPatch(cursor, wallDelete({ wallId }).build(cursor)).doc;
    }
    expect(() => deriveStoreyGeometry(cursor, storeyId)).not.toThrow();
    expect(cursor.byKind('wall')).toHaveLength(1);
  });

  it('材料不进派生：同一份坏文档，wallSetMaterial 照常通过', () => {
    const { doc, storeyId, legal } = starDoc();
    expect(() => deriveStoreyGeometry(doc, storeyId)).toThrow(/star/);
    expect(() =>
      wallSetMaterial({ wallId: legal.id, material: 'concrete' }).build(doc),
    ).not.toThrow();
  });
});
```

三处形状要留意，它们是这一步最容易"顺手改平"的地方：

① `addWall` 从 `log.affected` 里挑新墙，**不写 `doc.byKind('wall')[i]`**：`byKind` 按 id 升序，而 `uuidv7` 在同一毫秒内不单调（全局约束那条），"第 n 面墙"迟早漂到别的墙上。`commands-attributes.test.ts` 与 `commands-delete.test.ts` 里的 `addWall` 同一形状。

② 「复核吃的是**整份文档**」那条用例故意把星藏在**另一层**，然后断言本层的 `wallCreate.build` 替它抛 `/star/`。这条不是设计缺陷的告解，是把 `deriveJoints` 的全局性质钉成预期行为 —— 计划 4 的读盘读到坏层时，本层冻结写入是**已知后果**，注释里写了。

③ 「三面墙过同一点、三个方向」那条用 `log.document.canonical()` 的引用相等 + `log.depth` 不变做"不留痕迹"的凭据。`canonical()` 返回的是缓存的字符串，`toBe(before)` 判的是"文档对象压根没换"，比逐字段对账强：`applyPatch` 一旦跑过，即便结果一模一样，引用也会变。

**2b. `packages/core/test/commands-attributes.test.ts`（12 条）**

```ts
// 属性命令（wall.setMaterial / wall.setLoadBearing）与那一条材料写法（assertMaterial）。
// 计划 3 Task 7 的 A4：不做 noop 检查、不进派生复核。两条都是**付了代价**的选择 ——
// 代价（反复点同一个选项会各留一条撤销记录）写在最后一条用例里，别让人以为是没想过。
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  assertMaterial,
  storeyCreate,
  uuidv7,
  wallCreate,
  wallSetLoadBearing,
  wallSetMaterial,
  type EntityId,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();

/** 一层楼 + 一面 4000×240 的墙。只有一面墙，所以 byKind 下标没有歧义。 */
function oneWall(): { log: TransactionLog; wall: WallEntity; storeyId: EntityId } {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  const storeyId = log.document.byKind('storey')[0]!.id;
  log.dispatch(
    wallCreate({
      storeyId,
      start: { x: 0, y: 0 },
      end: { x: 4000, y: 0 },
      thicknessMm: 240,
      heightMm: 3000,
    }),
  );
  return { log, wall: log.document.byKind('wall')[0]!, storeyId };
}

describe('assertMaterial：材料名的写法纪律', () => {
  it('非空、不带首尾空白、不超 32 字符，三种毛病各有自己的文案', () => {
    expect(() => assertMaterial('')).toThrow(/材料不能为空/);
    expect(() => assertMaterial(' 混凝土 ')).toThrow(/不能带首尾空白/);
    expect(() => assertMaterial('a'.repeat(33))).toThrow(/不能超过 32 字符，收到 33 个/);
  });

  it('合法的那一侧：32 字符正好、中文与句中空格都放行（图纸标注要写"240 砖砌"这种话）', () => {
    expect(assertMaterial('a'.repeat(32))).toHaveLength(32);
    expect(assertMaterial('240 砖砌', '墙材料')).toBe('240 砖砌');
  });

  it('label 只改文案不改规则：wallCreate 那份报错说的是"墙材料"', () => {
    expect(() => assertMaterial('', '墙材料')).toThrow(/墙材料不能为空/);
    expect(() =>
      wallCreate({
        storeyId: uuidv7(),
        start: { x: 0, y: 0 },
        end: { x: 1000, y: 0 },
        thicknessMm: 240,
        heightMm: 3000,
        material: '',
      }),
    ).toThrow(/墙材料不能为空/);
  });
});

describe('wallSetMaterial', () => {
  it('补丁只有一个 upsert、只有 material 变了，其余字段逐字不动', () => {
    const { log, wall } = oneWall();
    const patch = wallSetMaterial({ wallId: wall.id, material: 'concrete' }).build(log.document);
    expect(patch.remove).toEqual([]);
    expect(patch.upsert).toHaveLength(1);
    expect(patch.upsert[0]).toEqual({ ...wall, material: 'concrete' });
  });

  it('省略 material 时默认 brick；改完之后真源里就是新值', () => {
    const { log, wall } = oneWall();
    expect(wall.material).toBe('brick');
    log.dispatch(wallSetMaterial({ wallId: wall.id, material: '混凝土' }));
    expect(log.document.byKind('wall')[0]!.material).toBe('混凝土');
  });

  it('墙不存在 → TypeError，文案点名是"墙"（读取断言只有一个产地）', () => {
    const { log } = oneWall();
    const missing = uuidv7();
    let caught: unknown;
    try {
      wallSetMaterial({ wallId: missing, material: 'brick' }).build(log.document);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toBe(`墙 不存在：${missing}`);
  });

  it('拿楼层 id 当墙用 → 类型不符也抛（mustExist 之后还要过 kind 这一道）', () => {
    const { log, storeyId } = oneWall();
    expect(() =>
      wallSetMaterial({ wallId: storeyId, material: 'brick' }).build(log.document),
    ).toThrow(/不是墙，是 storey/);
  });

  it('材料不进派生：写法合法就只管写，值一样也照写不误（noop 不检查，见最后一条用例的代价）', () => {
    const { log, wall } = oneWall();
    expect(() => wallSetMaterial({ wallId: wall.id, material: 'brick' }).build(log.document)).not.toThrow();
  });
});

describe('wallSetLoadBearing', () => {
  it('默认承重为 true，改成 false 只动那一个字段', () => {
    const { log, wall } = oneWall();
    expect(wall.loadBearing).toBe(true);
    const patch = wallSetLoadBearing({ wallId: wall.id, loadBearing: false }).build(log.document);
    expect(patch.upsert).toEqual([{ ...wall, loadBearing: false }]);
  });

  it('撤销/重做把属性原样还回来，也原样再放回去', () => {
    const { log, wall } = oneWall();
    log.dispatch(wallSetMaterial({ wallId: wall.id, material: '混凝土' }));
    log.dispatch(wallSetLoadBearing({ wallId: wall.id, loadBearing: false }));
    expect(log.depth).toBe(4); // 楼层 + 墙 + 两条属性
    log.undo();
    log.undo();
    expect(log.document.get(wall.id)).toEqual(wall);
    // redo 逆着 undo 的顺序回来：先材料，后承重
    log.redo();
    expect(log.document.byKind('wall')[0]!.material).toBe('混凝土');
    log.redo();
    expect(log.document.byKind('wall')[0]!.loadBearing).toBe(false);
  });

  it('反复点同一个选项各留一条撤销记录：A4 选的代价，不是遗漏', () => {
    const { log, wall } = oneWall();
    const before = log.depth;
    // 值没变也照样出一发补丁 —— 哪天有人"顺手"加一句 noop 短路，这一发就断在补丁上，
    // 而不是断在撤销栈深度上（空补丁同样压栈，光看 depth 是看不出来的）。
    expect(wallSetMaterial({ wallId: wall.id, material: 'brick' }).build(log.document).upsert)
      .toEqual([wall]);
    log.dispatch(wallSetMaterial({ wallId: wall.id, material: 'brick' }));
    log.dispatch(wallSetMaterial({ wallId: wall.id, material: 'brick' }));
    expect(log.depth).toBe(before + 2);
    // 文档内容没变，所以这两发在 canonical() 上不可见 —— 撤销栈里却实实在在有两层
    expect(log.document.byKind('wall')[0]!.material).toBe('brick');
    log.undo();
    expect(log.document.byKind('wall')[0]!.material).toBe('brick');
  });

  it('属性命令不碰别的实体：applyPatch 之后未触及的墙保持同一个对象', () => {
    const { log, wall } = oneWall();
    log.dispatch(
      wallCreate({
        storeyId: log.document.byKind('storey')[0]!.id,
        start: { x: 0, y: 2000 },
        end: { x: 4000, y: 2000 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    );
    const untouched = log.document.byKind('wall').find((w) => w.id !== wall.id)!;
    const next = log.document;
    log.dispatch(wallSetMaterial({ wallId: wall.id, material: 'concrete' }));
    // 不可变文档的同一性保证：屏幕侧靠对象引用做增量重建，被误替换的实体会白白重算
    expect(log.document.byKind('wall').find((w) => w.id === untouched.id)).toBe(untouched);
    expect(next.byKind('wall').find((w) => w.id === wall.id)).toBe(wall);
  });
});
```

三处判据的形状：

① `assertMaterial` 的三种毛病**各有各的文案**（`不能为空` / `不能带首尾空白，收到 …` / `不能超过 32 字符，收到 N 个`），所以用例逐条点名正则，不写"抛个错就行"。32 个字符**正好**放行、中文放行 —— 计划 5 的图纸标注要写"240 砖砌"这种话。`label` 参数只改文案不改规则，所以断言里连"墙材料"和"材料"两种前缀都各问一遍。

② "反复点同一个选项各留一条撤销记录"那条是 A4 的代价清单，判据是**两段**：`build(doc).upsert` 逐字等于 `[wall]`（补丁不是空的），并且 `depth` 每次 +2。只写后一段会被 M7 那种"加个 noop 短路"的改坏骗过去 —— 实测第一次就是这么漏的（改坏表 M7 行有红文）。

③ `wallSetMaterial` 的 `TypeError` 那条要连**消息**一起对（`墙 不存在：${missing}` / `不是墙，是 storey`），因为 `mustExist` 与 kind 断言是两条不同的守卫，只断 `.toThrow(TypeError)` 分不出走的是哪一条。

**2c. `packages/core/test/commands-delete.test.ts`（12 条）**

```ts
// 删除侧的三条补口命令（storey.delete / column.delete / slab.delete）与那一份孤儿判据
// （pointStillReferenced）。计划 3 Task 7 的 A2 与 A3。
//
// 两条口径贯穿整个文件：① 级联与孤儿判定各只有一个产地（问 dependentsOf 与
// pointStillReferenced，不在命令里再数一遍）；② 删除路径一律不跑派生复核 ——
// 坏数据必须还能删，守卫挡住删除等于把文档锁死（正面用例在 derive-guard.test.ts）。
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  applyPatch,
  columnCreate,
  columnDelete,
  deriveStoreyGeometry,
  openingCreate,
  pointStillReferenced,
  slabCreate,
  slabDelete,
  storeyCreate,
  storeyDelete,
  uuidv7,
  wallCreate,
  wallDelete,
  type Entity,
  type EntityId,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();

/** 往文档里贴/换一条实体，其余原样。手搓坏文档只走这条路。 */
function withEntity(doc: Document, entity: Entity): Document {
  const merged = new Map<EntityId, Entity>();
  for (const kind of ['storey', 'point', 'wall', 'opening', 'column', 'slab'] as const) {
    for (const e of doc.byKind(kind)) merged.set(e.id, e);
  }
  merged.set(entity.id, entity);
  return Document.replaceEntities(doc, merged);
}

function newLog(): TransactionLog {
  return new TransactionLog(Document.create(projectId));
}

function addStorey(log: TransactionLog, index: number): EntityId {
  log.dispatch(storeyCreate({ projectId, index, elevationMm: index * 3000, heightMm: 3000 }));
  const storey = log.document.byKind('storey').find((s) => s.index === index);
  if (!storey) throw new Error(`建不出序号 ${index} 的楼层`);
  return storey.id;
}

function addWall(
  log: TransactionLog,
  storeyId: EntityId,
  start: { x: number; y: number } | { pointId: EntityId },
  end: { x: number; y: number } | { pointId: EntityId },
): WallEntity {
  log.dispatch(
    wallCreate({ storeyId, start, end, thicknessMm: 240, heightMm: 3000, material: 'brick' }),
  );
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new Error('dispatch 之后没找到新墙');
}

/**
 * 一层里塞满四类下游：墙（墙上挂樘门）、柱、板，加上各自的点。
 * 坐标彼此离远，除了墙自己，别给删除添接头上的麻烦。
 */
function fullStorey(log: TransactionLog, storeyId: EntityId) {
  const wall = addWall(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
  log.dispatch(
    openingCreate({
      hostWallId: wall.id,
      distanceMm: 1000,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    }),
  );
  const openingId = log.document.byKind('opening')[0]!.id;
  log.dispatch(columnCreate({ storeyId, at: { x: 9000, y: 9000 }, widthMm: 400, depthMm: 400 }));
  const columnId = log.document.byKind('column')[0]!.id;
  log.dispatch(
    slabCreate({
      storeyId,
      boundary: [
        { x: 20000, y: 20000 },
        { x: 26000, y: 20000 },
        { x: 26000, y: 24000 },
      ],
      thicknessMm: 120,
    }),
  );
  return { wallId: wall.id, openingId, columnId, slabId: log.document.byKind('slab')[0]!.id };
}

describe('storeyDelete 的级联', () => {
  it('楼层的下游全在删除集里：墙、洞口、柱、板、点一个不漏，upsert 恒空', () => {
    const log = newLog();
    const storeyId = addStorey(log, 0);
    // 空着的第二层只为满足"最后一层不许删"而存在（见下面那条用例），不参与删除集
    addStorey(log, 1);
    const { wallId, openingId, columnId, slabId } = fullStorey(log, storeyId);
    const patch = storeyDelete({ storeyId }).build(log.document);
    expect(patch.upsert).toEqual([]);
    const remove = new Set(patch.remove);
    expect(remove.has(storeyId)).toBe(true);
    for (const id of [wallId, openingId, columnId, slabId]) expect(remove.has(id)).toBe(true);
    // 点也一起走：这层的点数 = 墙 2 + 柱 1 + 板 3
    const points = log.document.byKind('point').filter((p) => p.storeyId === storeyId);
    expect(points).toHaveLength(6);
    for (const point of points) expect(remove.has(point.id)).toBe(true);
    expect(remove.size).toBe(11);
  });

  it('只动本层：另一层的墙与点不在删除集里', () => {
    const log = newLog();
    const one = addStorey(log, 0);
    const two = addStorey(log, 1);
    fullStorey(log, one);
    const other = addWall(log, two, { x: 0, y: 0 }, { x: 3000, y: 0 });
    const patch = storeyDelete({ storeyId: one }).build(log.document);
    const remove = new Set(patch.remove);
    expect(remove.has(other.id)).toBe(false);
    for (const point of log.document.byKind('point').filter((p) => p.storeyId === two)) {
      expect(remove.has(point.id)).toBe(false);
    }
    expect(remove.has(two)).toBe(false);
    // 反面对照：本层那面墙确实在删除集里，别是"什么都删不到"蒙对了第一条
    expect(remove.has(log.document.byKind('wall').find((w) => w.storeyId === one)!.id)).toBe(true);
  });

  it('删除补丁逐字可重放：同一文档 build 两次，remove 数组连顺序都相同', () => {
    const log = newLog();
    const storeyId = addStorey(log, 0);
    addStorey(log, 1);
    fullStorey(log, storeyId);
    const cmd = storeyDelete({ storeyId });
    // 顺序 = dependentsOf 的书写顺序（墙→洞口→柱→板）再接点（byKind 的 id 升序）。
    // 写死的不是这一串 id（它们是 uuid），写死的是"两次调用给出同一个数组"。
    expect(cmd.build(log.document).remove).toEqual(cmd.build(log.document).remove);
  });

  it('删完这一层，另一层照常派生得动；undo 把整层原样还回来，redo 再带走', () => {
    const log = newLog();
    const one = addStorey(log, 0);
    const two = addStorey(log, 1);
    fullStorey(log, one);
    addWall(log, two, { x: 0, y: 0 }, { x: 3000, y: 0 });
    const before = log.document.canonical();
    log.dispatch(storeyDelete({ storeyId: one }));
    expect(log.document.byKind('storey')).toHaveLength(1);
    expect(log.document.byKind('wall')).toHaveLength(1);
    expect(() => deriveStoreyGeometry(log.document, two)).not.toThrow();
    expect(log.undo()).toBe(true);
    expect(log.document.canonical()).toBe(before);
    expect(log.redo()).toBe(true);
    expect(log.document.byKind('wall')).toHaveLength(1);
  });

  it('空层也删得掉：删除集就只有楼层自己', () => {
    const log = newLog();
    addStorey(log, 0);
    const two = addStorey(log, 1);
    expect(storeyDelete({ storeyId: two }).build(log.document)).toEqual({
      upsert: [],
      remove: [two],
    });
  });

  it('最后一层不许删：S1 不产零层项目（fitStorey 对空点集是抛的）', () => {
    const log = newLog();
    const one = addStorey(log, 0);
    expect(() => storeyDelete({ storeyId: one }).build(log.document)).toThrow(/最后一层/);
    // 有了第二层就删得动：判据是"同项目还有别的楼层"，不是"文档里还有别的实体"
    const two = addStorey(log, 1);
    expect(() => storeyDelete({ storeyId: one }).build(log.document)).not.toThrow();
    expect(() => storeyDelete({ storeyId: two }).build(log.document)).not.toThrow();
  });

  it('闭合性检查兜住跨层悬空：别层的墙指着本层的点 → 抛，不留下断链', () => {
    const log = newLog();
    const one = addStorey(log, 0);
    const two = addStorey(log, 1);
    const victim = addWall(log, one, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const own = addWall(log, two, { x: 8000, y: 0 }, { x: 9000, y: 0 });
    // 手工把二层再加一面墙：一端指一层的点。命令层走不出这种文档
    // （resolvePointRef 限同层），但读盘与手搓能 —— 真源不校验引用完整性，
    // 所以删除侧必须自己数闭合。
    const doc = withEntity(log.document, {
      kind: 'wall',
      id: uuidv7(),
      storeyId: two,
      startId: victim.startId,
      endId: own.startId,
      thicknessMm: 240,
      heightMm: 3000,
      elevationOffsetMm: 0,
      loadBearing: true,
      material: 'brick',
    });
    expect(() => storeyDelete({ storeyId: one }).build(doc)).toThrow(/会留下悬空引用/);
    // 二层自己删得动：那面越界的墙在二层的删除集里，被它引用的点不属于二层、也不被删
    expect(() => storeyDelete({ storeyId: two }).build(doc)).not.toThrow();
  });
});

describe('columnDelete 与 slabDelete 的孤儿点', () => {
  it('柱的落点没人共用 → 点跟着删；落在墙端点上 → 只删柱，点留着', () => {
    const log = newLog();
    const storeyId = addStorey(log, 0);
    const wall = addWall(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    log.dispatch(columnCreate({ storeyId, at: { x: 9000, y: 9000 }, widthMm: 400, depthMm: 400 }));
    const own = log.document.byKind('column')[0]!;
    log.dispatch(
      columnCreate({ storeyId, at: { pointId: wall.startId }, widthMm: 400, depthMm: 400 }),
    );
    const shared = log.document.byKind('column').find((c) => c.pointId === wall.startId)!;

    expect(columnDelete({ columnId: own.id }).build(log.document).remove).toEqual([
      own.id,
      own.pointId,
    ]);
    expect(columnDelete({ columnId: shared.id }).build(log.document).remove).toEqual([shared.id]);
    // 那一发真的删不掉点：applyPatch 之后墙端点还在，墙于是还是那面墙
    const next = applyPatch(log.document, columnDelete({ columnId: own.id }).build(log.document))
      .doc;
    expect(next.get(wall.startId)).toBeDefined();
    expect(next.get(own.pointId)).toBeUndefined();
  });

  it('板的角点：独占的删、与墙共用的留', () => {
    const log = newLog();
    const storeyId = addStorey(log, 0);
    const a = addWall(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    addWall(log, storeyId, { pointId: a.endId }, { x: 4000, y: 3000 });
    // 板的第 1、2 个角复用两枚墙端点，第 3 个角是板自己新建的
    log.dispatch(
      slabCreate({
        storeyId,
        boundary: [{ pointId: a.startId }, { pointId: a.endId }, { x: 8000, y: 8000 }],
        thicknessMm: 120,
      }),
    );
    const slab = log.document.byKind('slab')[0]!;
    const ownCorner = slab.boundaryPointIds[2]!;
    expect(slab.boundaryPointIds.slice(0, 2)).toEqual([a.startId, a.endId]);
    expect(slabDelete({ slabId: slab.id }).build(log.document).remove).toEqual([
      slab.id,
      ownCorner,
    ]);
    const next = applyPatch(log.document, slabDelete({ slabId: slab.id }).build(log.document)).doc;
    expect(next.get(a.startId)).toBeDefined();
    expect(next.get(ownCorner)).toBeUndefined();
  });

  it('角点早就悬空的板仍删得掉：remove 里不许有文档里不存在的 id', () => {
    const log = newLog();
    const storeyId = addStorey(log, 0);
    log.dispatch(
      slabCreate({
        storeyId,
        boundary: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }],
        thicknessMm: 120,
      }),
    );
    const slab = log.document.byKind('slab')[0]!;
    const ghost = uuidv7();
    // 手工把一角换成不存在的 id：`applyPatch` 对不存在的 remove id 是**抛**的，
    // 少这一句跳过，一块缺角的板就把整份文档锁死。
    const doc = withEntity(log.document, {
      ...slab,
      boundaryPointIds: [ghost, ...slab.boundaryPointIds.slice(1)],
    });
    const patch = slabDelete({ slabId: slab.id }).build(doc);
    expect(patch.remove).not.toContain(ghost);
    expect(() => applyPatch(doc, patch)).not.toThrow();
    expect(applyPatch(doc, patch).doc.byKind('slab')).toHaveLength(0);
  });
});

describe('pointStillReferenced：孤儿判据只有一个产地', () => {
  /** 一枚点被墙引用、另一枚被柱引用、第三枚被板引用 —— 三种引用各验一次。 */
  function refs(log: TransactionLog, storeyId: EntityId) {
    const wall = addWall(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    log.dispatch(
      columnCreate({ storeyId, at: { pointId: wall.startId }, widthMm: 400, depthMm: 400 }),
    );
    const column = log.document.byKind('column')[0]!;
    log.dispatch(
      slabCreate({
        storeyId,
        boundary: [{ pointId: wall.endId }, { x: 1000, y: 5000 }, { x: 2000, y: 5000 }],
        thicknessMm: 120,
      }),
    );
    const slab = log.document.byKind('slab')[0]!;
    return { wall, column, slab };
  }

  it('墙、柱、板三种引用都认；exceptIds 排除掉引用者自己之后才算孤儿', () => {
    const log = newLog();
    const storeyId = addStorey(log, 0);
    const { wall, column, slab } = refs(log, storeyId);
    const ownCorner = slab.boundaryPointIds[1]!;
    const none = new Set<EntityId>();
    expect(pointStillReferenced(log.document, wall.startId, none)).toBe(true);
    expect(pointStillReferenced(log.document, wall.endId, none)).toBe(true);
    expect(pointStillReferenced(log.document, ownCorner, none)).toBe(true);
    // 排除柱自己：那点仍被墙端引用 → 不是孤儿
    expect(pointStillReferenced(log.document, column.pointId, new Set([column.id]))).toBe(true);
    // 排除墙自己：那点仍被柱引用 → 不是孤儿
    expect(pointStillReferenced(log.document, wall.startId, new Set([wall.id]))).toBe(true);
    // 排除板自己：它独占的那个角点于是成为孤儿
    expect(pointStillReferenced(log.document, ownCorner, new Set([slab.id]))).toBe(false);
  });

  it('wallDelete 用的就是这一份判据：删墙不动被柱、板共用的两枚端点', () => {
    const log = newLog();
    const storeyId = addStorey(log, 0);
    const { wall, column, slab } = refs(log, storeyId);
    expect(wallDelete({ wallId: wall.id }).build(log.document).remove).toEqual([wall.id]);
    log.dispatch(wallDelete({ wallId: wall.id }));
    expect(log.document.get(column.pointId)).toBeDefined();
    expect(log.document.get(slab.boundaryPointIds[0]!)).toBeDefined();
    // 对照：一根没人引用的墙（同层再建一面独立的）删下去会把两个端点一起带走
    const lone = addWall(log, storeyId, { x: 30000, y: 30000 }, { x: 34000, y: 30000 });
    expect(wallDelete({ wallId: lone.id }).build(log.document).remove).toEqual([
      lone.id,
      lone.startId,
      lone.endId,
    ]);
  });
});
```

四处判据的形状：

① 级联那条的凭据是**数出来的**：`fullStorey` 那间房（一面墙 + 一个洞口 + 一根柱 + 一块板）一层正好 **6 枚点**，删除集 **11 个 id**（层 1 + 墙 1 + 洞口 1 + 柱 1 + 板 1 + 点 6），`upsert` 恒空。数不上的话"全在删除集里"就是空话，所以先 `expect(remove).toHaveLength(11)` 再对内容。

② 前两条级联用例必须**另有一层空楼层**，否则会被"最后一层不许删"的守卫挡住。注释里写清了那层存在**只**为了喂这条规则，不是几何素材 —— 少了这句，下一个人会把它当冗余删掉，然后红在另一条上。

③ 「闭合性检查兜住跨层悬空」用 `withExtras` 手工贴一面**指着本层点、自己属于别层**的墙（`handEntities`），断言 `/会留下悬空引用/`。真源不校验引用完整性（`Document.replaceEntities` 只查整数毫米与 id 形状），所以这种文档读盘读得进来 —— 这条用例是那个入口的哨兵。

④ `slabDelete` 的"角点早就悬空的板仍删得掉"判的是 `remove` 里**不许有文档里不存在的 id**：`applyPatch` 对不存在的 remove id 是**抛**的，一块坏板删不掉就等于把整份文档锁死。那一发靠的是 `if (!doc.get(pointId)) continue;`（改坏 M13 摘掉它，红在这一条）。

**2d. `packages/core/test/joint.test.ts`：五处改 `handBuild`（条数 18 不变）**

这一步**先于实现落地也照样绿**（`handBuild` 造出来的文档，`deriveJoints` 在复核前后都抛同样的四类错），所以它跟 2a/2b/2c 一起提交，红只红在三个新文件上。

顶部 import 加一行 `type Entity`：

```ts
import {
  // …既有那些保持不动
  wallAxisById,
  wallCreate,
  vec,
  type Entity,          // （Task 7 加：handBuild 要贴 Entity[]）
  type Joint,
  type WallCreateInput,
  type WallEntity,
} from '@dajia/core';
```

`appendWall` 之后插入这个助手（`Document` 与 `uuidv7` 那个文件已经 import 过）：

```ts
/**
 * **不经命令层**，把手工实体直接贴进文档：坐标相同的两端复用同一枚点 id（与命令层的
 * 共享端点语义一致），差别只在于绕开 `wallCreate` 那道门。
 *
 * 为什么需要它：Task 7 给 `wallCreate` / `wallMoveEndpoint` / `wallSetThickness` 加了派生
 * 复核（`assertDerivesAfterApply`），"合法命令造得出画不出的文档"这条路于是被堵死。那正是
 * 复核要的效果，但派生层这四道守卫（同向重叠 / 轮廓翻面 / 直通异厚 / star）必须**仍然可测** ——
 * 它们是读盘与协作写入（计划 4、计划 6）唯一的哨兵，不能因为命令层提前挡就把哨兵本身
 * 失去凭据。所以这些用例改成手工造文档；"命令层也挡得住"另由 `derive-guard.test.ts` 从正面钉。
 */
function handBuild(
  specs: Array<{
    start: { x: number; y: number };
    end: { x: number; y: number };
    thicknessMm: number;
  }>,
): Document {
  const storeyId = uuidv7();
  const entities: Entity[] = [
    { kind: 'storey', id: storeyId, projectId, index: 0, elevationMm: 0, heightMm: 3000 },
  ];
  const pointIds = new Map<string, string>();
  const pointOf = (at: { x: number; y: number }): string => {
    const key = `${at.x},${at.y}`;
    const hit = pointIds.get(key);
    if (hit) return hit;
    const id = uuidv7();
    pointIds.set(key, id);
    entities.push({ kind: 'point', id, storeyId, x: at.x, y: at.y });
    return id;
  };
  for (const spec of specs) {
    entities.push({
      kind: 'wall',
      id: uuidv7(),
      storeyId,
      startId: pointOf(spec.start),
      endId: pointOf(spec.end),
      thicknessMm: spec.thicknessMm,
      heightMm: 3000,
      elevationOffsetMm: 0,
      loadBearing: true,
      material: 'brick',
    });
  }
  return Document.replaceEntities(
    Document.create(projectId),
    new Map(entities.map((entity) => [entity.id, entity])),
  );
}
```

五处替换（每处都是"删掉 `build(...)` + `appendWall`/`log.dispatch` 那几行，换成一次 `handBuild([...])`，并把 `deriveJoints(x.document)` 改成 `deriveJoints(doc)`"）：

1. `分组只认拓扑` 里的 `sameRay`：原来 `build` 一面 `1000→2000` 再 `appendWall(startId, {x:3000})`；换成
   ```ts
   const sameRay = handBuild([
     { start: { x: 1000, y: 0 }, end: { x: 2000, y: 0 }, thicknessMm: 240 },
     { start: { x: 1000, y: 0 }, end: { x: 3000, y: 0 }, thicknessMm: 240 },
   ]);
   expect(() => deriveJoints(sameRay)).toThrow(/同向重叠/);
   ```
   注释里那句"合法命令就造得出它：`wallCreate` 只查零长与墙厚不小于轴长…"换成"Task 7 起命令层就会先挡住这一发（`derive-guard.test.ts` 钉的是 `/同向重叠/` 从 `wallCreate.build` 抛出），所以这里手工造文档，只考派生层那道哨兵"。
2. 同一条用例里的 `threeOnOneLine`：三面墙（`0→1000`、`1000→2000`、`1000→3000`，全 240）一次 `handBuild`。
3. 同一条用例里的 `insideTee`：`1000,0→2000,0`（240）、`1000,0→3000,0`（240）、`1000,0→1000,800`（120）。
4. `corner：斜角与异厚` 里的「夹角小到轮廓翻面」：`{-2000,0→0,0}` 与 `{0,0→-2000,35}`，两面 500。
5. `tee` 里的「直通两墙厚度不同」：`0→1000`（240）、`1000→2000`（370）、`1000→(1000,800)`（120）；`cross 与 star` 里的「Y 形三臂」：`0→1000,0`、`1000→2000,900`、`1000→1000,900`（那条用例里"三条臂必须在三个方向上"的注释**保留**，它解释的正是为什么第二臂不是 `(2000,0)`）。

Run: `npx vitest run packages/core/test`
Expected: `joint.test.ts` 18 条**全绿**（它不依赖实现）；三个新文件红在**函数不存在**上，形状是 `TypeError: … is not a function`（`export *` 的链接期不抛，见本任务开头那段），`derive-guard.test.ts` 里"复核只挂这三条"那组的 `storeyDelete`/`wallDelete` 用例也一起红。**不许**红在断言值上：红在 `expected true to be false` 之类，说明测试自己造错了素材，先回头核对再进 Step 3。

---

- [ ] **Step 3: 两个产地 —— `assertDerivesAfterApply` 与 `pointStillReferenced`**

`packages/core/src/geom/outline.ts`：顶部加一行 import（`applyPatch` 与 `Patch` 是这个文件之前没引过的，`mustExist` 已在），文件末尾追加：

```ts
import { applyPatch, type Patch } from '../model/patch';
```

```ts
/**
 * 命令层的**派生复核**：把候选补丁贴到草稿文档上跑一次整层派生，派生抛则命令抛。
 *
 * 为什么在写入侧而不是 UI 侧：`deriveStoreyGeometry` 的四道守卫（star 接头、同向重叠、
 * 近平行求不出接缝点、轮廓翻面）只有这一个产地。屏幕若自己再算一遍接头分类去预言"这一发
 * 画不画得出来"，就是第二份规则 —— 复述的规则一定漂，而漂掉的那一遍永远没人看
 * （`commands/opening.ts` 顶部那句"命令层绝不复述区间规则"同一条理由）。
 * `applyPatch` 是纯函数、不动传进来的 doc，所以这张草稿是免费的（`assertFitsAfterInsert` 同一条手法）。
 *
 * 只给**改几何**的命令用（wall.create / wall.moveEndpoint / wall.setThickness）。删除路径
 * 一律不复核：坏数据必须还能删，守卫挡住删除就等于把文档锁死（`openingMove` 把正数那条
 * 守卫放在 move 而不是 requireOpening 里，是同一条纪律）。柱与板不在这张派生表里
 * （`deriveStoreyGeometry` 只读墙），所以 column/slab 命令也不必复核。
 */
export function assertDerivesAfterApply(doc: Document, patch: Patch, storeyId: EntityId): void {
  const next = applyPatch(doc, patch).doc;
  deriveStoreyGeometry(next, storeyId);
}
```

`packages/core/src/geom/topology.ts`：`incidentWallEnds` 之后追加（`Document` / `EntityId` / `requirePoint` 都已在，不新增依赖）：

```ts
/**
 * 除 `exceptIds` 里那些实体之外，还有谁引用这枚点：墙（两端）、柱（落点）、板（边界）。
 * 三类都查 —— 少查一类就会把别人还在用的点删掉，真源留下悬空引用。
 *
 * 这里是 `wallDelete` 原来那份文件私有 `stillReferenced` 的**唯一产地**（计划 1 Task 9 落地时
 * 只有墙要删点，所以它长在 wall.ts 里）。计划 3 Task 7 的 `columnDelete` / `slabDelete`
 * 是第二个和第三个调用者，同一条孤儿判定不许有三份。
 * `exceptIds` 取集合而不是单个 id：调用方给的是"本次补丁正要带走的那批实体"，
 * 而删一面挂板的墙时，那枚点可能同时被这块板引用（板也在本次删除集里时它不该算数）。
 */
export function pointStillReferenced(
  doc: Document,
  pointId: EntityId,
  exceptIds: ReadonlySet<EntityId>,
): boolean {
  for (const wall of doc.byKind('wall')) {
    if (exceptIds.has(wall.id)) continue;
    if (wall.startId === pointId || wall.endId === pointId) return true;
  }
  for (const column of doc.byKind('column')) {
    if (exceptIds.has(column.id)) continue;
    if (column.pointId === pointId) return true;
  }
  for (const slab of doc.byKind('slab')) {
    if (exceptIds.has(slab.id)) continue;
    if (slab.boundaryPointIds.includes(pointId)) return true;
  }
  return false;
}
```

> **为什么 `assertDerivesAfterApply` 落在 `outline.ts` 而不是新开一个 `geom/guard.ts`**：它唯一的读者是命令层，唯一的数据来源是 `deriveStoreyGeometry`，而 `outline.ts` 就是那个函数的家。新开文件会把"派生"拆成两个地方说话，而 A1 的全部理由就是它只能有一个产地。`lint:deps` 也不受影响：`outline.ts` 本来就只依赖 `model/`，现在多引的 `model/patch` 是同向的（core → 自己的 model），`scripts/check-deps.mjs` 管的是包与包之间。

---

- [ ] **Step 4: `commands/wall.ts` —— 三条命令挂复核，两条属性命令，`wallDelete` 换产地**

顶部 import 三处变化（`Patch` 与 `assertDerivesAfterApply` 是新依赖，方向仍合法：`commands → geom` 早就有）：

```ts
import {
  incidentWallEnds,
  isExistingPoint,
  pointStillReferenced,      // （T7 加）
  resolvePointRef,
  type PointRef,
} from '../geom/topology';
import { assertSpansFit, spansOfOpenings } from '../geom/opening';
import { assertDerivesAfterApply } from '../geom/outline';   // （T7 加）
import type { Command } from '../model/command';
import type { Document } from '../model/document';
import type { Patch } from '../model/patch';                // （T7 加）
```

**4a. 材料纪律**（放在 `WallCreateInput` 之前，导出是为了让 renderer 的属性面板能复用同一条规则）：

```ts
/**
 * 材料名的写法纪律：非空、不带首尾空白、不超 32 字符。
 * 真源里它是自由字符串（计划 5 的图纸标注要能写"240 砖砌"这种话），所以核心只挡"存进去就
 * 没法看"的那几种；下拉框的候选集在 UI 侧（scene-2d / renderer），那是产品选项不是数据约束。
 * 一个产地两处用：`wallCreate` 的可选入参与 `wallSetMaterial` —— 两份校验一定会漂。
 */
export function assertMaterial(material: string, label = '材料'): string {
  if (material.length === 0) throw new RangeError(`${label}不能为空`);
  if (material !== material.trim()) {
    throw new RangeError(`${label}不能带首尾空白，收到 ${JSON.stringify(material)}`);
  }
  if (material.length > 32) {
    throw new RangeError(`${label}不能超过 32 字符，收到 ${material.length} 个`);
  }
  return material;
}
```

`wallCreate` 的构造期（紧挨 `elevationOffsetMm` 那行之后）加**一行**，注意是"传了才查"：

```ts
  const material =
    input.material === undefined ? undefined : assertMaterial(input.material, '墙材料');
```

它的 `build` 末尾，`return { upsert, remove: [] }` 换成：

```ts
      const patch: Patch = { upsert, remove: [] };
      // 派生复核：新墙可能把一枚既有端点拖成星形接头（三个方向过同一点），
      // 那种文档建得出来、画不出来。守卫只有一个产地，就在这道门上（见 outline.ts 的注释）。
      assertDerivesAfterApply(doc, patch, input.storeyId);
      return patch;
```

同时 `material: input.material ?? 'brick'` 改成 `material: material ?? 'brick'`（复用构造期那份已校验的值，别在 build 里再读一次入参）。

**4b. `wallSetThickness`**：`return { upsert: [{ ...wall, thicknessMm }], remove: [] }` 换成

```ts
      const patch: Patch = { upsert: [{ ...wall, thicknessMm }], remove: [] };
      // 厚度改的是轮廓的宽，接头斜切量跟着变 —— 加厚能把一个合法 T 接画成翻面（自相交），
      // 所以这一发也要过派生复核。M1.2 的出口判据"把外墙厚改到 240"就压在这条上。
      assertDerivesAfterApply(doc, patch, wall.storeyId);
      return patch;
```

`wall.storeyId` 而不是入参：这发命令的入参里根本没有楼层，而**复核必须在写补丁之后**（`assertDerivesAfterApply` 吃的是补丁，`doc` 是原档，`wall` 是从原档读出来的）。

**4c. 两条属性命令**（紧跟 `wallSetThickness` 之后；`wallSetMaterial` 的 `assertMaterial` 在**构造期**，与 `wallCreate` 同一时机 —— 属性面板不该等到派发那一步才知道材料名写错了）：

```ts
/**
 * 改材料。与 `wallSetThickness` 同一形状：只 upsert 一个字段、不查"值有没有变"
 * （属性面板反复点同一个选项会各留一条撤销记录，这是可接受的代价 —— 见计划 3 Task 7 的 A4）。
 * 材料不进派生表，所以不跑 `assertDerivesAfterApply`。
 */
export function wallSetMaterial(input: { wallId: EntityId; material: string }): Command {
  const material = assertMaterial(input.material, '墙材料');
  return {
    type: 'wall.setMaterial',
    build(doc: Document) {
      const wall = requireWall(doc, input.wallId);
      return { upsert: [{ ...wall, material }], remove: [] };
    },
  };
}

/** 改承重。同上：一个布尔字段，不进派生。 */
export function wallSetLoadBearing(input: {
  wallId: EntityId;
  loadBearing: boolean;
}): Command {
  return {
    type: 'wall.setLoadBearing',
    build(doc: Document) {
      const wall = requireWall(doc, input.wallId);
      return { upsert: [{ ...wall, loadBearing: input.loadBearing }], remove: [] };
    },
  };
}
```

**4d. `wallMoveEndpoint`**：它那个 `build` 的最后（`clampOpeningsToWall` 那个 `for` 之后）换成

```ts
      const patch: Patch = { upsert, remove: [] };
      // 派生复核：这一发动的是**所有**共享这枚点的墙。上面逐面查过轴长与零长，
      // 但接头分类（star / 同向重叠 / 翻面）只有派生层会算 —— 把一枚 T 接拖成
      // 三方向过同一点，命令层那几条守卫一条都不会叫，而画不出来。
      // 计划 3 的 T5/T6 把这条记成"legalDrop 只跑 build 的差额"，在这里收口。
      assertDerivesAfterApply(doc, patch, wall.storeyId);
      return patch;
```

**4e. `wallDelete`**：孤儿点那一段换成问拓扑，**并且不加复核**：

```ts
      // 孤儿判定用 topology 的那一份产地（Task 7 起 columnDelete / slabDelete 共用）。
      // 删除路径**不跑**派生复核：坏数据必须还能删，守卫挡住删除等于把文档锁死。
      const except = new Set<EntityId>([wall.id]);
      for (const pointId of [wall.startId, wall.endId]) {
        if (!pointStillReferenced(doc, pointId, except)) remove.push(pointId);
      }
      return { upsert: [], remove };
```

文件末尾那份私有 `stillReferenced`（墙/柱/板三个 `for` 循环）**整段删除** —— 它是 `pointStillReferenced` 的旧产地，留着就是两份规则各漂各的。

Run: `npx vitest run packages/core/test/derive-guard.test.ts packages/core/test/joint.test.ts`
Expected: `joint.test.ts` **18 绿**、`derive-guard.test.ts` **9 绿**。这一步之后这两个文件不该有红：9 条读到的东西本一步就齐了 —— 三条改几何命令的复核、「材料不进派生」要 `wallSetMaterial`、「坏数据必须还能删」要 `wallDelete`（真源本来就有，本步只是把它的孤儿判定搬到 `topology`），而它**不需要** `storeyDelete` / `columnDelete` / `slabDelete`（那三条的用例全在 `commands-delete.test.ts`）。同一条命令再跑 `commands-attributes.test.ts` 与 `commands-delete.test.ts`：它们仍红，红在 `storeyDelete` / `columnDelete` / `slabDelete` 是 `undefined`（`TypeError: … is not a function`，见本任务开头的链接期说明）—— 那是 Step 5 的账。**中间态只核对到"红在哪个函数"，不核对数字**：临时工程里 Step 4 与 Step 5 是一次落地、一次全量跑的（24 files / 309 tests，重复三遍逐字相同），所以本步没有单独的实测绿数。

---

- [ ] **Step 5: `storeyDelete` / `columnDelete` / `slabDelete`**

**5a. `commands/storey.ts`** —— import 加 `dependentsOf`（`../geom/topology`），文件末尾追加：

```ts
/**
 * 删一层 = 连它的全部构件一起带走。三条口径：
 *
 * ① **级联不自己数，问 `dependentsOf`。** 楼层的下游（墙 / 洞口 / 柱 / 板）已经在
 *    `geom/topology.ts` 里有一份，且那份的返回顺序写进了注释。这里再数一遍就是第二个产地，
 *    将来多一类构件（计划 4 的家具？）漂掉的必然是本函数这一遍。点不在这张表里
 *    （`dependentsOf` 的 storey 分支只列构件），所以点按 `storeyId` 单独收 —— 那也不是
 *    复述引用规则，点是**属于**这层的，不是被这层引用的。
 * ② **删完不许留悬空引用，靠闭合性检查而不是靠"上面那条规则肯定全了"。**
 *    真源不校验引用完整性（`Document` 只管整数毫米与 id 形状），所以"别层的墙指着本层的点"
 *    这种文档是可能被读盘或手搓造出来的。逐条问 `dependentsOf`：被删的每个 id，它的下游
 *    必须也在删除集里，否则抛。这条检查顺带是 ① 那份表写错时的哨兵。
 * ③ **最后一层不许删。** 零层项目在数据上没有毛病，但 `fitStorey` / `buildDrawList` 走的
 *    `aabbOfPoints([])` 是**抛**的（计划 2 立的口径），于是"删掉最后一层"会让屏幕进入一个
 *    画不出任何东西、且每次重绘都抛的状态。与其让 UI 兜，不如让真源不产这种状态。
 *    代价：删错了不能靠"删空再重建"回到起点，得先 `storeyCreate` 一层再删旧的。
 *
 * 撤销：`invertPatch` 按前像逐条重插，所以一次 Ctrl+Z 把整层（含构件与点）原样还回来 ——
 * 不需要"批事务"，因为这一条命令的补丁本来就是一整块。
 */
export function storeyDelete(input: { storeyId: EntityId }): Command {
  return {
    type: 'storey.delete',
    build(doc: Document) {
      const storey = requireStorey(doc, input.storeyId);
      const hasSibling = doc
        .byKind('storey')
        .some((s) => s.projectId === storey.projectId && s.id !== storey.id);
      if (!hasSibling) {
        throw new RangeError(
          `楼层 ${storey.id} 是项目 ${storey.projectId} 的最后一层：S1 不许出现零层项目`,
        );
      }
      const remove: EntityId[] = [storey.id];
      const removal = new Set<EntityId>([storey.id]);
      for (const id of dependentsOf(doc, storey.id)) {
        removal.add(id);
        remove.push(id);
      }
      for (const point of doc.byKind('point')) {
        if (point.storeyId !== storey.id) continue;
        removal.add(point.id);
        remove.push(point.id);
      }
      for (const id of remove) {
        for (const dependentId of dependentsOf(doc, id)) {
          if (removal.has(dependentId)) continue;
          const dependent = doc.get(dependentId);
          throw new RangeError(
            `删除楼层 ${storey.id} 会留下悬空引用：${dependentId}` +
              `（${dependent?.kind ?? '未知'}）引用着本层的东西，但它不在本层，删不掉`,
          );
        }
      }
      return { upsert: [], remove };
    },
  };
}
```

三处不要"顺手改平"：`hasSibling` 判的是**同项目**（`s.projectId === storey.projectId`）而不是全文档 —— 一份文档理论上能装两个项目，全局"还剩一层就不许删"会替别人的项目管闲事。`remove` 用数组不用 `Set`（补丁的 `remove` 是有序列表，`affected` 的迭代序跟着它，测试里的 `toHaveLength(11)` 才对得上）。闭合性检查的循环跑在 `remove` 的**每个** id 上而不是楼层 id 上 —— 洞口/柱/板各也有自己的下游吗？今天没有，但这句话写在这里，`dependentsOf` 长出第二层的那天这条检查照样兜得住。

**5b. `commands/column.ts`** —— import 补 `mustExist`（`../model/read`）与 `pointStillReferenced`（`../geom/topology`），加文件私有的读取断言与新命令：

```ts
/** 与 `commands/opening.ts` 里那份 `requireOpening` 同一口径：读取断言长在用的那个文件里。 */
function requireColumn(doc: Document, id: EntityId): ColumnEntity {
  const entity = mustExist(doc, id, '柱');
  if (entity.kind !== 'column') throw new TypeError(`${id} 不是柱，是 ${entity.kind}`);
  return entity;
}
```

```ts
/**
 * 删一根柱，并把它**独占**的那枚落点一起带走（孤儿判定问 `pointStillReferenced`，
 * 与 `wallDelete` 同一份产地：柱落点常常就是墙端点，不查就是删柱拆墙）。
 * 不跑派生复核：柱不在 `deriveStoreyGeometry` 的表里（那张表只读墙），而且删除路径
 * 一律不许被守卫挡住（见 `storeyDelete` 的 ② 与 `commands/opening.ts` 顶部那句）。
 */
export function columnDelete(input: { columnId: EntityId }): Command {
  return {
    type: 'column.delete',
    build(doc: Document) {
      const column = requireColumn(doc, input.columnId);
      const remove: EntityId[] = [column.id];
      const except = new Set<EntityId>([column.id]);
      if (!pointStillReferenced(doc, column.pointId, except)) remove.push(column.pointId);
      return { upsert: [], remove };
    },
  };
}
```

**5c. `commands/slab.ts`** —— 同一形状，`requireSlab` 用 `mustExist(doc, id, '板')`；命令：

```ts
/**
 * 删一块板，并把它**独占**的边界点一起带走。孤儿判定问 `pointStillReferenced`
 * （与 `wallDelete` / `columnDelete` 同一份产地）：板的角点常常就是墙端点。
 * 被删点的顺序跟着 `boundaryPointIds` 的环序走 —— 那是真源里已有的顺序，
 * 不必再按 id 重排（重排是第二套口径，且 `remove` 的顺序只影响 `affected` 的迭代序）。
 */
export function slabDelete(input: { slabId: EntityId }): Command {
  return {
    type: 'slab.delete',
    build(doc: Document) {
      const slab = requireSlab(doc, input.slabId);
      const remove: EntityId[] = [slab.id];
      const except = new Set<EntityId>([slab.id]);
      for (const pointId of slab.boundaryPointIds) {
        if (pointStillReferenced(doc, pointId, except)) continue;
        // 引用早就悬空（点不在文档里）时跳过：`applyPatch` 对不存在的 remove id 是**抛**的，
        // 而"坏数据必须还能删"—— 一块角点已经丢了的板，绝不能因为删不掉而把文档锁死。
        if (!doc.get(pointId)) continue;
        remove.push(pointId);
      }
      return { upsert: [], remove };
    },
  };
}
```

Run: `npx vitest run packages/core/test && npx tsc --noEmit -p packages/core/tsconfig.json`
Expected: **`Test Files 24 passed (24) / Tests 309 passed (309)`**，tsc exit=0。2026-09-28 在临时工程里这条跑重复三遍，逐字相同（含 `properties.test.ts` 9 条与 `geometry-properties.test.ts` 14 条那两轮随机生成 —— 复核落地后它们仍然全绿，说明**属性测试那两套随机造图没有一发撞上新守卫**，因为它们的造图器本来就走合法命令）。

---

- [ ] **Step 6: scene-2d 侧的订正（7 条既有用例改写 + 1 个助手删除 + `editing.ts` 三段注释跟上真源；scene-2d 的逻辑代码一字不动）**

复核挂到 `build` 的最后一行之后，Task 6 那批用例里有**七条**的**夹具前提**漂了：它们靠"命令层放行、派生层抛"或者"从原点沿 `+x` 拖必然合法"活着，而这两句在 T7 都不再成立。2026-09-28 在 `.tscheck/t8` 临时工程（core 与 scene-2d 全量副本）里逐条改绿：`Test Files 30 passed (30) / Tests 423 passed (423)`，`npx tsc --noEmit`（core/src + scene-2d 的 src 与 test）exit=0。下面每段都是**逐字替换**文本，「红法」是执行日拿来核对的凭据。**条数一条不增不减**（`editing.test.ts` 30、`handles.test.ts` 19）—— 改的全是既有用例的落点方向与造图方式，没有新增用例，也没有删用例。

这七段代码块（`editing.test.ts` 4 段 + `handles.test.ts` 3 段）在写完之后**与那份临时工程的文件逐字反向比对过**：每一段都作为子串原样命中对应文件，不是转述。后面 `editing.ts` 的三处注释**不参与测试**，所以只能核对锚：那三段的"原行"引文摘自 Task 6 落地形态的源文件（`⑥ **建得出还要画得出**（\`derivesCleanly\`）：命令层的 \`build\` 不含接头分类…`），执行日若引文与实际源文件对不上，以源文件为锚做替换，别为了迁就引文改判据。

顺带一句执行顺序：这七条**必须与 Step 3–5 的 core 改动同批落地**。只在 core 侧挂复核、不动这几条，`packages/scene-2d/test` 会红（2026-09-28 实测：`Test Files 3 failed | 27 passed (30) / Tests 8 failed | 415 passed (423)`）；反过来先改测试、core 还没挂复核，那这七条**一条都不红**（旧夹具在旧真源下本来就是绿的）。所以"红在哪几条"本身就能证明你改的是哪一侧。

那 8 条红怎么分成七 + 一：**那三个红的文件是 `editing.test.ts`、`handles.test.ts`、`pick.test.ts`**（`Test Files 3 failed`），`snapping.test.ts` 一条没红 —— 复核不动吸附，正交/角度档的落点照旧。`editing.test.ts` 是 `30 tests | 4 failed`（正好 6.1、6.2、6.3、6.4 四条），`handles.test.ts` 于是是 3 条（8 − 4 − 1），留存日志片段里点得出名字的是其中两条：`handles.test.ts:482` 的 `expect(p).not.toBeNull()`（旧 6.6「四发正向候选全被真源挡下…」，探针被 star 筛光了）与 `handles.test.ts:549` 的 `expect(legalDrop(..., firstDrop.raw)).toBe(true)`（旧 6.7「裸对角合法、吸上去那一发被 240 厚墙挡下」，裸对角从此非法）。第三条的名字不在这两份片段里，只能由减法得到 —— 执行日如果只红 6 条或红 9 条，先按 6.1–6.7 的清单逐条点名，别拿这个减法当判据。

**那第 8 条红是临时工程自己的装配事故，执行日不该复现它**：红的是 `pick.test.ts > pickPxOf 点名要墙：一层的每一面墙都拿得到只命中它自己那一发的像素`，红法是 `ReferenceError: wallAxisById is not defined`（`pick.test.ts:244`）—— 与派生复核毫无关系，是那一轮临时工程里那份 `pick.test.ts` 副本少了 `import { vec, wallAxisById } from '@dajia/core'` 里的第二个名字。核对过：现在这份 harness 文件与计划 Task 4 Step 1 的文本**逐字相同**，带上那行 import 之后 `pick.test.ts` 18 条全绿（`final_green` 那一跑就是 30 文件 / 423 条）。执行日若真在 `pick.test.ts` 上看到红，先查是不是夹具的墙变了，别把它记成本任务的凭据。

**6.1 `editing.test.ts`「按下与移动 > 拖到水平方向：终点吸成逐字整数、临时线仍画到裸光标、原草稿不动」**

漂在哪：锚点是原点，素材那面墙是 `(0,0)→(4000,0)`，沿 `+x` 拖出来的草稿与它**同向重叠** —— T7 之前重叠只在派生层抛、`legalWallCreate` 看不见，所以这一发的 `legal` 只由正交档说话；复核挂上之后它变成 false，而这条要求 true。改往**反向延长线**拖：`-x` 那侧只在锚点处接出一个两臂贯通点，合法。`(-2000, 60)` 离轴 1.72°，仍在 `ANGLE_TOL_DEG`（实测 = 3）之内，正交档照样把终点吸成逐字整数。把开头这四行与注释换成：

```ts
    const { log, storeyId, field: fd } = oneWall();
    const base = pressAtOrigin(fd, storeyId);
    // 往 **-x** 拖（穿过锚点那枚端点的反向延长线）：Task 7 把派生复核挂上 `wallCreate.build`
    // 之后，从原点沿 +x 画会与素材那面 (0,0)→(4000,0) **同向重叠** ⇒ 同一发有了两个拒绝理由，
    // `legal` 就不再只由正交档说话。反向延长线只在锚点处接出一个两臂贯通点，合法。
    const cursor = pxOf({ x: -2000, y: 60 }, sv); // 离轴 1.72°，在 ANGLE_TOL_DEG(=3) 之内
    const moved = moveDraft(log.document, base, sv, cursor, fd);
    expect(moved.end.snap?.kind).toBe('ortho');
    expect(moved.end.mm).toEqual({ x: -2000, y: 0 }); // 正交档保坐标 ⇒ 逐字整数
    expect(moved.cursorPx).toEqual(cursor); // S4 第三条：预览线画到**裸光标**，不是吸附点
    expect(moved.legal).toBe(true);
```

只换 `cursor` 那一发与它的注释，外加 `moved.end.mm` 的字面量；`moved.legal` 与 `cursorPx` 两句一字不动。**Task 6 登记在这条上的改坏凭据 E12 不受影响**：E12 判的是"`moveDraft` 不许原地改草稿"，靠的是这条后半段那两句引用比较（`expect(base.cursorPx).not.toEqual(cursor)` / `expect(base.legal).toBe(false)`），本步没碰。方向换了之后它**照样吃得住吸附判据**，2026-09-28 实测过一次改坏：把 `orthoOf` 的"保锚点坐标"退化成"整发取裸落点"（`mm: { x: raw.x, y: raw.y }`），红 4 条 —— 本条、`editing.test.ts`「起点在空白处按下：什么都不吸，也不吃角度档（锚点恒 null）」、`snapping.test.ts`「正交走"保坐标"语义：横向吸 y、纵向吸 x，落点是逐字整数」、「档位互斥：离 45° 2.9° 给 angle15，离轴 2.3° 给 ortho，90 的倍数不属于 15° 档」。改坏跑完即改回。

**6.2 `editing.test.ts`「合法性预言与真命令 > 试跑不动真源：墙数、撤销栈深度、affected 三票全部原样」**

只换一行，`dragToEnd(pressAtOrigin(fd, storeyId), { x: 1200, y: 0 }, log.document, fd, sv)` → `{ x: 0, y: 1200 }`。理由与 6.1 同一条雷（沿 `+x` 那一发在 T7 之后被 `build` 拒 ⇒ `legalWallCreate` 给 false，这条要求 true）。它判的是"试跑不许碰真源"，方向换成垂直完全不影响判据。

**6.3 `editing.test.ts`「合法性预言与真命令 > 三种拒绝各一色：零长、墙厚不小于墙长、跨层复用点」**

漂在哪：第 ② 发原本沿 `+x` 拖 200mm 与 400mm，T7 之后那两发**同时**撞"墙厚 ≥ 轴长"和"同向重叠"两个拒绝理由，用例名字里的"各一色"就不成立了（②与素材自证那发各有两个拒因，第一条用例分不出是谁在说话）。换成 `+y`（与素材那面墙垂直），只有墙厚那一条会说话。替换段（含注释，`// 素材自证` 那行也要跟着换）：

```ts
    // ② 墙厚不小于墙长：240 厚的墙拖 200mm。方向取 **+y**（与素材那面 (0,0)→(4000,0) 垂直）：
    // Task 7 把派生复核挂上 `wallCreate.build` 之后，沿 +x 拖会先撞上「同向重叠」，
    // 那一发就同时有两个拒绝理由，②不再"各一色"。垂直方向只有墙厚这一条会说话。
    expect(dragToEnd(base, { x: 0, y: 200 }, log.document, fd, sv).legal).toBe(false);
    // 素材自证：同一方向多拖一点就合法（否则"恒 false"的写法也过这一发）
    expect(dragToEnd(base, { x: 0, y: 400 }, log.document, fd, sv).legal).toBe(true);
```

①（零长）与 ③（跨层复用点）两发一字不动。

**6.4 `editing.test.ts`「新建回执与探针 > ⑥ 的前提：同一发候选命令层放行、派生层抛（星形接头）」→ 改名「⑥ 的前提：同一发候选在命令层与派生层一起拒（星形接头）」**

命题换边：`legalWallCreate` 现在自己就 false，而它原来下面那句 `trial.dispatch(command)` 会在 dispatch 里抛。夹具（`synthStorey` + 两面 4000 的墙 + `(2000,2000)` 那一发）、`①③④⑤ 逐条自证`那六句、`legal: true` 那个草稿字面量、末尾"探针仍给得出别发候选 + `buildDrawList(t2…)` 不抛"那一段**全不动**。改的是标题、开头那段注释，和中间这四句：

```ts
    // 角点 (0,0) 已经过着两条线（x 轴与 y 轴）。第三发 45° 斜线过同一点 ⇒ core 的 `deriveJoints`
    // 判它星形接头。Task 6 写这一条时它**过了 ①~⑤ 也过了命令层**，只在派生层炸；Task 7 把派生复核
    // 挂上 `wallCreate.build` 之后，同一发在**两层一起拒** ⇒ 本条改判"两层同判、预言不漂"。
    // ⑥ 真正的牙齿在上一条样例房用例里
    // （摘掉 ⑥ 那次实测八个进程：「六道筛逐条自证」七次红、一次绿，红在建完再派生那一句 —— 本条不跟着红，
    // 因为它判的是候选本身，不判探针挑了谁）。
```

```ts
    expect(legalWallCreate(log.document, draft)).toBe(false);
    // Task 7 把派生复核挂上 `wallCreate.build` 之后，这一发不再是"命令层放行、派生层抛"，
    // 而是**两层一起拒**：`legalWallCreate` 试跑的就是 `build`，所以它拿到的抛错就是 ⑥ 那句。
    // 这一发从此不判"⑥ 为什么必须存在"，判的是"⑥ 从画图时炸提前到松手前拒"这条搬迁落地了。
    const command = draftCommand(draft, newWallDefaults(log.document, storeyId));
    if (command === null) throw new TypeError('legal 为假却拿不到命令（`draftCommand` 看了 legal？）');
    expect(() => command.build(log.document)).toThrow(/S1 不支持/);
```

删掉的是原来那三行（`const trial = new TransactionLog(log.document);` / `trial.dispatch(command);` / `expect(() => buildDrawList(trial.document, storeyId, sv)).toThrow(/S1 不支持/);`）。**`legal: true` 那行不许跟着改成 false**：`draftCommand` 只认 `legal` 一色，这条要的就是"手工把 `legal` 写成 true 也照样在 `build` 抛" —— 改成 false 会让 `draftCommand` 返回 null，抛点从 `build` 挪到那句 `TypeError`，判据就空了。

**6.5 `handles.test.ts`「合法落点与拖拽探针 > legalDrop 就是真源那道守卫的预言：合法 true、压扁给 false，而 false 那一发真的抛」**

漂在哪：原本"合法那一发"是 `(4000, 1200)`（southEast 变 4326、southWest 变 4000、stem 变 1800，命令层六道守卫全过 ⇒ 当时为 true）；复核挂上 `wallMoveEndpoint.build` 之后那一发把三臂拧成 star ⇒ **改判 false**。合法的那一发从此只剩"仍然留在贯通线上"这一类，改成 `(corner.x + 1200, corner.y)`（southEast 变 2800、southWest 变 5200、stem 变 3671）。替换那一行注释 + 那一行断言，换成下面这一段（顺手把"false 那一发"钉成红字，别让 A1 悄悄改掉这条的靶子）：

```ts
    // 沿贯通线拖 (5200, 0)：southEast 变 2800、southWest 变 5200、stem 变 3671，三面都远大于各自墙厚。
    // Task 7 之前这里用的是 (4000, 1200)（southEast 4326 / southWest 4000 / stem 1800，命令层六道守卫全过
    // ⇒ 当时为 true）；派生复核挂上 `wallMoveEndpoint.build` 之后那一发把三臂拧成 star ⇒ 改判 false，
    // 合法的那一发只剩"仍然留在贯通线上"这一类。下面第三句把它钉成红字，别让 A1 悄悄改掉这条的靶子。
    expect(legalDrop(house.doc, junction.id, 'start', { x: corner.x + 1200, y: corner.y })).toBe(true);
    expect(legalDrop(house.doc, junction.id, 'start', { x: corner.x, y: corner.y + 1200 })).toBe(false);
    expect(() =>
      wallMoveEndpoint({
        wallId: junction.id,
        end: 'start',
        x: corner.x,
        y: corner.y + 1200,
      }).build(house.doc),
    ).toThrow(/S1 不支持/);
```

后面 `farEnd`（`/零长墙/`）与 `stemFar`（`/变成零长/`）那两组一字不动 —— 它们本来就是"false 那一发真的抛"的凭据，只是理由各不相同。`wallMoveEndpoint` 在这条用例里 Task 6 就已经 import 了，不必动导入表。

**6.6 `handles.test.ts`「拖拽吃吸附（Task 6） > 探针吃的是吸附后的毫米：四发正向候选全被真源挡下，第五发被一枚既有点接住」→ 改名「…前两发被真源挡下，第三发被一枚既有点接住」**

漂在哪：原夹具的"四发正向候选全非法"里有两发（`(0,-800)` / `(-800,0)`）是靠**把另两面墙拖成零长**才非法的，复核把"拧成 star"也变成拒绝理由之后，`sharedBy` 与探针挑中的靶子都会换。新夹具只用共享 A 的两面 1040 墙（`+y` / `+x` 那两发各把其中一面拖成轴长 240 ⇒ 撞墙厚守卫）+ 一面**与 A 无关**的墙做陷阱口。整条替换（从 `it(` 到 `});`）：

```ts
  it('探针吃的是吸附后的毫米：前两发被真源挡下，第三发被一枚既有点接住', () => {
    // 现场故意造到"前两发（+y / +x）候选全非法、第三发 (0,-800) 的裸落点离一面既成墙的起点 5.66px"，
    // 于是吃场的探针报**那枚既有点的毫米 (40,-760)**，不吃场的探针报**裸的 (0,-800)** —— 两个答案不同。
    // 2026-09-28 实测这条咬住的改坏：探针传 `EMPTY_SNAP_FIELD`（HB3）与换回 `moveTargetOf`（HB4），
    // 两条各红这条 + 下面那条「合法性判的是吸附后的毫米」。锚点（HB1）与排除（HB2）不在这里判 ——
    // 它们收在 `handleDropTarget` 出口里，改出口会让"拖拽路径真的在吃吸附"与"把手按在原地那一发"
    // 逐进程红（实测 8/8），判在探针调用点上反而漏（那时探针与 renderer 一起改，行为没变）。
    // 判裸落点还是判吸附后（HB5）由下面那条专门咬：这条夹具里裸 (0,-800) 与吸 (40,-760) **两侧都合法**，判不出。
    const projectId = uuidv7();
    const log = new TransactionLog(Document.create(projectId));
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    let storeyId = '';
    for (const id of log.affected) {
      if (log.document.get(id)?.kind === 'storey') storeyId = id;
    }
    if (storeyId === '') throw new TypeError('affected 里没有新建的楼层');
    // 共享 A=(0,0) 的两面墙（+x 与 +y，直角共点 ⇒ 两臂接头，S1 造得成，`sharedBy` 恰为 2）。
    // 两面都取 1040：+y / +x 那两发把其中一面拖成轴长 240，正好撞"墙厚 240 不小于轴长 240"那条守卫。
    log.dispatch(wallCreate({ storeyId, start: { x: 0, y: 0 }, end: { x: 1040, y: 0 }, thicknessMm: 240, heightMm: 3000 }));
    const east = createdWallOf(log);
    log.dispatch(wallCreate({ storeyId, start: { pointId: east.startId }, end: { x: 0, y: 1040 }, thicknessMm: 240, heightMm: 3000 }));
    // 第三发 (0,-800) 的陷阱：一面**与 A 无关**的墙，起点 (40,-760) 离裸落点 56.6mm ⇒
    // 0.1px/mm 下 5.66px，容差 8px 之内，且它是端点档 ⇒ 比"没有候选"更优先，探针第一发就吸得上。
    log.dispatch(wallCreate({ storeyId, start: { x: 40, y: -760 }, end: { x: 1040, y: -760 }, thicknessMm: 240, heightMm: 3000 }));
    // 1px = 10mm ⇒ 整数像素与整数毫米逐字往返，红的时候不必先排除舍入
    const v = viewportOf(1000, 800, { pxPerMm: 0.1, center: vec(400, 100) });
    const doc = log.document;
    const p = dragProbe(doc, storeyId, buildDrawList(doc, storeyId, v, EMPTY_SELECTION), v);
    expect(p).not.toBeNull();
    expect(p!.sharedBy).toBe(2);
    // 先自证现场：裸落点确实是第三发那一发，而探针给的是**吸上去之后**那枚既有点
    expect(moveTargetOf(v, p!.toPx)).toEqual({ x: 0, y: -800 });
    expect(p!.targetMm).toEqual({ x: 40, y: -760 });
    expect(p!.targetMm).not.toEqual(moveTargetOf(v, p!.toPx));
    // 而合法性判的也是吸附后的毫米：原地那枚既有点把墙拖成的形状必须真的过得了真源那道守卫
    expect(legalDrop(doc, p!.wallId, p!.end, p!.targetMm)).toBe(true);
    expect(legalDrop(doc, p!.wallId, p!.end, { x: 0, y: -800 })).toBe(true); // 两个都合法 ⇒ 上面那句不是巧合
    // 前两发候选全非法是这套夹具的前提，不是假设：逐发当场验一遍（各把一面 1040 的墙拖成轴长 240），
    // 前提漂了这里先红，不会让上面那两句变成猜。
    for (const off of [
      { x: 0, y: 800 },
      { x: 800, y: 0 },
    ]) {
      expect(legalDrop(doc, p!.wallId, p!.end, off)).toBe(false);
    }
  });
```

两个执行日要核对的点：`sharedBy` 从原来的 `>= 2` 收成**恰为 2**（这条夹具造的是直角两臂点，写 `>= 2` 等于允许第四面墙悄悄混进夹具）；这条**只证"探针在吃吸附"**，裸与吸两侧都合法，判不出"合法性判在吸附之后"（那是 6.7 的活，注释最后一行写的就是这件事）。

视野中心从 Task 6 的 `vec(300, 300)` 挪到 `vec(400, 100)`，**这只是把 (-760,-760) 那条陷阱墙挪到画面里更靠中的地方，不是判据**：`pxPerMm: 0.1` 下 1000×800px 的视野跨 10000×8000mm，两个中心都把夹具里那三面墙完整框住，所以换不换中心都轮不到裁剪来改候选集。2026-09-28 在临时工程里各跑三遍实测：`vec(300, 300)` 与 `vec(400, 100)` 都是 handles **19/19 绿**。执行日**不要**把它当成"必须挪中心才绿"的条件 —— 对不上时先查夹具的墙，别查视野。

**6.7 `handles.test.ts`「拖拽吃吸附（Task 6） > 合法性判的是吸附后的毫米：裸对角合法、吸上去那一发被 240 厚墙挡下」→ 改名「合法性判的是吸附后的毫米：裸对角被 star 挡下、吸回贯通线那一发过得了守卫」**

为什么整条重写：T7 之前这条靠"240 厚墙把**吸上去**那一发挡在轴长守卫外、裸对角反而合法"造分歧；复核挂上之后多了一条干净得多的分裂 —— **同一发整数像素，裸落点拧成 star（非法）、吸回贯通线（合法）**。而 6.6 的新夹具里裸与吸两侧都合法，两条夹具的判据不能再互相借。尺子换成 `pxPerMm: 0.01`（1px = 100mm）：容差 8px 在这把尺子上是 800mm，所以第五发对角 `(600,600)` 虽然离贯通线还有 600mm，仍吸得回来（垂足档，6.00px）。整条替换：

```ts
  it('合法性判的是吸附后的毫米：裸对角被 star 挡下、吸回贯通线那一发过得了守卫', () => {
    // Task 7 把派生复核挂上 `wallMoveEndpoint.build`（裁决 A1）之后，star 在松手前就拒，
    // 于是这里能造出"同一发整数像素，裸落点非法、吸上去那一发合法"的分歧 —— 上一条例用里裸与吸
    // 两侧都合法，判不出这件事，所以它只能证"探针在吃吸附"，证不了"合法性判在吸附之后"。
    // 夹具：一个 T 接 —— 贯通线 x=0（A→(0,1000) 与 A→(0,-1000) 共点 A）+ 一根 45° 斜撑 A→(700,-700)，
    // A 是三臂点。尺子取 1px = 100mm（`pxPerMm: 0.01`）：容差 8px 在这把尺子上就是 800mm，
    // 所以第五发对角 (600,600) 的裸落点虽然离贯通线还有 600mm，仍然吸得回来（垂足档，6.00px）。
    // 裸的那一发把三臂拧成 star ⇒ S1 不支持；吸回线上 (0,600) 的那一发仍是"一条线 + 一根撑" ⇒ 过守卫。
    // 于是判 `drop.raw` 的实现（改坏 HB5）会把十发全筛光 ⇒ 报 null（2026-09-28 实测：本夹具上
    // 判 raw 的探针给 null，判 mm 的给 to=(506,394)、mm=(0,600)），两条探针用例一起红。
    const projectId = uuidv7();
    const log = new TransactionLog(Document.create(projectId));
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    let storeyId = '';
    for (const id of log.affected) {
      if (log.document.get(id)?.kind === 'storey') storeyId = id;
    }
    if (storeyId === '') throw new TypeError('affected 里没有新建的楼层');
    log.dispatch(wallCreate({ storeyId, start: { x: 0, y: 0 }, end: { x: 0, y: 1000 }, thicknessMm: 240, heightMm: 3000 }));
    const up = createdWallOf(log);
    log.dispatch(wallCreate({ storeyId, start: { pointId: up.startId }, end: { x: 0, y: -1000 }, thicknessMm: 240, heightMm: 3000 }));
    log.dispatch(wallCreate({ storeyId, start: { pointId: up.startId }, end: { x: 700, y: -700 }, thicknessMm: 240, heightMm: 3000 }));
    const v = viewportOf(1000, 800, { pxPerMm: 0.01, center: vec(0, 0) });
    const doc = log.document;
    const ops = buildDrawList(doc, storeyId, v, EMPTY_SELECTION);
    const p = dragProbe(doc, storeyId, ops, v);
    expect(p).not.toBeNull();
    expect(p!.sharedBy).toBe(3); // 三臂点：star 这条判据要的就是"搬起来会拧成三方向"
    // 现场自证分歧真的存在：同一发整数像素，裸落点过不了守卫，吸上去那一发过得了。
    expect(moveTargetOf(v, p!.toPx)).toEqual({ x: 600, y: 600 });
    expect(p!.targetMm).toEqual({ x: 0, y: 600 });
    expect(legalDrop(doc, p!.wallId, p!.end, { x: 600, y: 600 })).toBe(false);
    expect(() =>
      wallMoveEndpoint({ wallId: p!.wallId, end: p!.end, x: 600, y: 600 }).build(doc),
    ).toThrow(/S1 不支持/);
    expect(legalDrop(doc, p!.wallId, p!.end, p!.targetMm)).toBe(true);
    // 前提不许是假设：探针**赢的那把把手**上，前四发（+y / +x / -y / -x）吸附后的落点逐发非法，
    // 第五发才第一次合法 —— 前提漂了这里先红，上面那五句不会变成猜。
    const field = snapFieldOf(doc, storeyId);
    const handle = dragHandlesOf(
      doc,
      storeyId,
      { ids: new Set(doc.byKind('wall').filter((w) => w.storeyId === storeyId).map((w) => w.id)) },
      v,
    ).find((h) => h.wallId === p!.wallId && h.end === p!.end)!;
    const firstFour = [
      { x: 0, y: 800 },
      { x: 800, y: 0 },
      { x: 0, y: -800 },
      { x: -800, y: 0 },
    ];
    const pxOf = (mm: MoveTarget): { x: number; y: number } => {
      const at = mmToPx(v, mm);
      return { x: Math.round(at.x), y: Math.round(at.y) };
    };
    for (const off of firstFour) {
      const px = pxOf(off);
      expect(legalDrop(doc, handle.wallId, handle.end, handleDropTarget(v, px, handle, field).mm)).toBe(false);
    }
    const fifth = handleDropTarget(v, pxOf({ x: 600, y: 600 }), handle, field);
    expect(fifth.raw).toEqual({ x: 600, y: 600 });
    expect(fifth.mm).toEqual({ x: 0, y: 600 });
    expect(fifth.snap?.kind).toBe('foot'); // 吸的是贯通线上那枚垂足，不是既有点
  });
```

两处口径要盯住，别在执行时"顺手放宽"：`sharedBy` 从 `>= 2` 收成 **恰为 3**（star 这条判据要的就是三臂），以及"前四发逐发非法"那个循环判的是**吸附后的 `.mm`**、不是裸落点 —— 它正是 HB5 的靶子。改坏 HB5（`dragProbe` 里把 `legalDrop(..., targetMm)` 换成判 `drop.raw`）实测红**恰好这两条**（`Tests 2 failed | 47 passed (49)`，红的就是 6.6 与 6.7，其余 47 条一条不动），跑完立刻改回。

**6.8 `handles.test.ts`：删掉助手 `wallsFromOrigin(foreign: boolean)`**

Task 6 文本里那段（自带 `projectId` / 楼层 / 两面共点墙 / 可选第四面外来墙，连同它上面的 doc 注释，约第 89–123 行）**整段删除** —— 6.6 与 6.7 各自内联造图之后它没有读者了。**这不是可选的清理**：`noUnusedLocals` 会先红，`tsc` 报 `TS6133: 'wallsFromOrigin' is declared but its value is never read`，`pnpm verify` 的 typecheck 段直接 exit≠0。同文件里的 `createdWallOf` **留着**（6.6 与 6.7 都在用它取新建那面墙）。

**牙口复测记录**（2026-09-28，每条改完立刻跑、跑完立刻改回；这两条是七条改写的"分得开故障"凭据，不是新事实）：

| 改坏 | 动的那一处 | 红在哪几条 |
| ---- | ---------- | ---------- |
| **HB5** | `handles.ts` 的 `dragProbe`：`const { mm: targetMm } = handleDropTarget(...)` → 取 `drop.raw` 判合法性 | 恰好 2 条：6.6「探针吃的是吸附后的毫米…」+ 6.7「合法性判的是吸附后的毫米…」（`Tests 2 failed \| 47 passed (49)`，只跑 editing 与 handles 两个文件） |
| **正交档退化** | `snapping.ts` 的 `orthoOf`：`mm: best.q % 180 === 0 ? { x: raw.x, y: anchor.y } : { x: anchor.x, y: raw.y }` → `{ x: raw.x, y: raw.y }` | 恰好 4 条：6.1「拖到水平方向…」、`editing.test.ts`「起点在空白处按下…」、`snapping.test.ts`「正交走"保坐标"语义…」「档位互斥…」 |

这两行也回答"换了落点方向之后 6.1 还是不是吸附判据"：是 —— 正交档退化它先红。而 Task 6 登在这条上的 **E12**（`moveDraft` 原地改草稿）不受本步影响，判据在它的后半段，一字未动。

`packages/scene-2d/src/editing.ts` 的注释：第 4 条列的三处 + 第 7 条那一句，**一个文件里一次改完**（第 4 条 ③ 与第 7 条是同一段）。三处的落地文本：

**① `wallProbe` 头部六道筛清单里的第 ⑥ 句** —— 原两行「⑥ **建得出还要画得出**（`derivesCleanly`）：命令层的 `build` 不含接头分类，斜向候选会把共享点 / 凑成星形接头（S1 不支持星形接头），而那一发会…**」整行换成：

```ts
 * ⑥ **建得出还要画得出**（`derivesCleanly`）：T7 起 `wallCreate` 的 `build` 末尾就复核了派生，
 *    所以这一筛在样例房上与 `legalWallCreate` **判得一样**（实测同一批候选）。留着它是因为
 *    "画得出"这句话在屏幕上只有这一个读者 —— 见 `derivesCleanly` 的注释，别顺手删。
```

**② `wallProbe` 循环里那走行内注释** —— 整行替换：

```ts
      // 筛 ⑥：建得成还要画得出。T7 之后 `legalWallCreate` 里的 `build` 已经复核过派生，
      // 这一筛与它判得一样（实测同一批候选）；留着它是"画得出"这句话的唯一读者。
```

**③ + 第 7 条：`derivesCleanly` 的 doc 注释** —— 首段那句「`legalWallCreate` 只跑命令的 `build`，那一道里没有接头分类」改成「`legalWallCreate` 跑命令的 `build`，而 T7 起 `build` 的最后一行就是派生复核」；末段「它只护住探针 —— 用户手拉的那一发斜墙仍然只过 `legalWallCreate`，星形接头在屏幕上的缺口原样登记给 T7（…）」整段替换为：

```ts
 * **T7 之后它不再是唯一防线**：`wallCreate` 的 `build` 已经复核过派生（`assertDerivesAfterApply`），
 * 2026-09-28 实测 80 发候选里被挡的那 48 发在两侧是同一批。留着它是因为它是**画得出**而不是
 * **建得出**的唯一读者：`buildDrawList` 将来长出派生之外的失败（渲染期的算术、新的抛点）时，
 * 探针依然只给得出真窗口里点得中、画得出的一发。摘掉它的改坏行是 E28，登记在执行日的重测里。
```

`handles.ts` 的 `legalDrop` 注释**不动**（核对过：它只讲"试跑真命令、不抄轴长比较"，没有"不跑派生层"这类措辞 —— 那句差额记在计划文本的注记里，不在源码里）。

Run: `npx vitest run packages/scene-2d/test packages/core/test`
Expected: scene-2d **115 条**（六个文件：viewport 9 + drawlist 10 + pick 18 + snapping 28 + editing 30 + handles **20**，七条改写全在 `editing.test.ts` 与 `handles.test.ts` 里，**条数一条不增不减**）、core **309 条**，合起来 **`Test Files 30 passed (30) / Tests 423 passed (423)`**。这组数不是加出来的：2026-09-28 在 `.tscheck/t8` 临时工程（core 与 scene-2d 的全量副本）逐字跑过，重复三遍逐字相同，`npx tsc --noEmit`（core/src + scene-2d 的 src 与 test）exit=0。口径要看清：**这个 423 只覆盖 core 与 scene-2d 两个包**，不等于下面 Step 7 的全仓数 —— 临时工程不装 `packages/protocol/test/ipc.test.ts` 与 `scripts/test/deps-check.test.mjs` 那 8 条，也不装 Task 5 的 `commands-drag.test.ts` 那 7 条。

---

- [ ] **Step 7: 全量验证 + 改坏表**

Run: `pnpm verify`（= `typecheck && lint:deps && test`）
Expected: **`Test Files 33 passed (33)` / `Tests 439 passed (439)`**（订正 2026-09-29：编写期那三段账拼出的是 405→438，而 Task 6 的 D 棒落地后盘上基线是 **406**（`handles.test.ts` 实测 20 条、当时那份临时工程数的是 19）⇒ 本任务只加 core 的 33 条，执行日判 **439**。下面"这个 438…"那三段照旧当作 2026-09-28 的实测来源读，别再拿它的合计去对今天的盘），typecheck exit=0，lint:deps 不报新边（`commands → geom` 与 `geom → model` 都是既有方向）。

**这个 438 是"两段实测 + 一段既有回填"拼出来的，三段来源不同，别混着当实测引用**：
- **实测段 A**：`.tscheck/t8` 临时工程 `Test Files 30 passed (30) / Tests 423 passed (423)` = core **24 文件 / 309 条** + scene-2d **6 文件 / 114 条**（2026-09-28 重复三遍逐字相同；本任务的 33 条净增 9 + 12 + 12 就在这里，所以它是**量出来的**，不是推算的）。
- **实测段 B**：同日对**真仓库**跑 `npx vitest run` 得 `Test Files 23 passed (23) / Tests 284 passed (284)` = core 21 文件 / 276 条 + 临时工程不装的那 **8** 条（`packages/protocol/test/ipc.test.ts` 与 `scripts/test/deps-check.test.mjs`）。A 与 B 相减正好差那 8 条 + Task 5 的 `commands-drag.test.ts` **7** 条 —— 这两段就是 438 与 423 之间那道口子，执行日对不上账时先从这里找。
- **既有回填段**：405 是计划 3 的 Task 6 执行回填里记的全仓数（= 284 + 114 + 7），本任务没重跑全量。

⇒ 全仓 **405 → 438** = 405 + 33，加的那 33 是实测段 A 里 core 的净增。**（2026-09-29 订正：盘上基线已是 406 ⇒ 执行日判 439，差的那 1 条是 `handles.test.ts` 的第 20 条，Task 6 棒 C/D 落地时补的。）**执行日 `pnpm verify` 的真账要对三样：全仓 `Tests`（判 438）、全仓 `Test Files`（**A、B 两段都没给过这个数** —— A 是 30 但只含两个包，B 是 23 但还没有 scene-2d；按 A+B 的分解推算是 **33** = A 的 30 + `commands-drag.test.ts` + `ipc.test.ts` + `deps-check.test.mjs`，跑出来写进这里的「执行回填」，对不上就是有一个文件没被 `include` 收到）、以及 core 是否仍是 **24 / 309**。对不上时先怀疑 T5/T6 那两段有没有漂（其它包的既有绿数不该被本任务改动），再怀疑本任务。

**改坏表**（15 条，每条改一次、跑 `npx vitest run packages/core/test`、跑完立刻改回。2026-09-28 在临时工程里逐条实测，括号里是当时的 `Test Files / Tests / tsc`）：

1. **M1** `wallCreate` 不复核（`assertDerivesAfterApply(doc, patch, input.storeyId)` → `/*M*/;`）→ `1 failed | 23 passed`，**3 条红**，全在 `derive-guard.test.ts` 的 `wallCreate 的派生复核` 组（星形那条、同向重叠那条、"复核吃的是整份文档"那条），`first-error: AssertionError: expected [Function] to throw an error`。
2. **M2** `wallSetThickness` 不复核 → 1 条红：「5° 斜角的两面墙：厚 120 合法，加厚到 240 会翻面 → 抛 /翻面/」。
3. **M3** `wallMoveEndpoint` 不复核（同一行文本的第二处出现） → 1 条红：「把 T 接的公共点拖离直通线 → 三个方向过同一点，抛 /star/，文档不动」。**这一条就是 T5/T6 记的那条差额**，它从此有了 core 侧的凭据。
4. **M4** 给 `wallDelete` 也挂复核 → 1 条红：「坏数据必须还能删：逐面删掉星臂之后，这一层重新派生得动」，红法是 `RangeError: 接头 … 有 3 个墙端、3 个方向在同一点相交（star）…` —— **删除被守卫锁死的样子**，A1 那条"删除路径永不复核"的唯一反面教材。
5. **M5** `assertMaterial` 的长度上限改成 64 → 1 条红（`commands-attributes.test.ts` 的三种文案那条）。
6. **M6** trim 检查写成 `false` → 同一条红。
7. **M7** 给 `wallSetLoadBearing` 加"值没变就返回空补丁"的 noop 短路 → **第一次跑是绿的**（原判据只问 `depth`，短路之后 `dispatch` 同样不加深度，断言分不出"发了空补丁"与"根本没发"）；把那条用例加固成"`build(doc).upsert` 逐字等于 `[wall]`"之后重跑：1 条红，`AssertionError: expected [] to deeply equal [ { kind: 'wall', …(9) } ]`。**这一行是本任务最贵的一条**：它记下的是"断言必须分得开故障"这条纪律在 T7 自己身上的失守与补法。
8. **M8** 去掉"最后一层不许删"的 `hasSibling` 检查 → 1 条红（「最后一层不许删：S1 不产零层项目…」），且 `tsc errors=1`（`hasSibling` 变成未使用变量，`noUnusedLocals` 抓到）。
9. **M9** 闭合性检查整段失效（内层 `throw` 换成 `continue`）→ 1 条红（「闭合性检查兜住跨层悬空…」）。
10. **M10** 收点的条件写反（`if (point.storeyId === storey.id) continue;`）→ **4 条红**（级联数数、只动本层、undo/redo 还原、闭合性），`first-error: AssertionError: expected false to be true`。
11. **M11** `columnDelete` 总带走落点（`if (!pointStillReferenced(…))` 改成无条件 `push`）→ 1 条红（「柱的落点没人共用 → 点跟着删；落在墙端点上 → 只删柱，点留着」），`tsc errors=2`（`pointStillReferenced` 与 `except` 在 column.ts 里变成未使用）。
12. **M12** `columnDelete` 从不带走落点 → 同一条红，`first-error` 方向相反（`expected [ Array(1) ] to deeply equal [ …(2) ]`）。**两条各红一次**才证明那条用例判的是"两个方向"，不是"数对上一个数"。
13. **M13** `slabDelete` 去掉 `if (!doc.get(pointId)) continue;` → 1 条红（「角点早就悬空的板仍删得掉：remove 里不许有文档里不存在的 id」，`expected [ …(4) ] to not include '<id>'`）。
14. **M14** 孤儿判据不看板（`slab` 那个循环删掉）→ **2 个文件 3 条红**：`commands-delete.test.ts` 的「墙、柱、板三种引用都认…」，**外加既有 `commands.test.ts` 里那条"端点仍被柱或板引用时不回收"** —— 这条计划 1 就有的用例从此有了对 `slab` 的牙（A2 把判据搬上来的收益：它不再只服务 `wallDelete`）。
15. **M15** 孤儿判据不看柱 → 同样 3 条红（同一批见证）。

> 三条同时红在 `tsc`（M8/M11/M12）不是巧合，是 `noUnusedLocals` 在替这条纪律背书：**摘掉一处判据会留下没人读的变量**，所以类型检查先红。剩下十二条只红在测试上，`tsc errors=0`。15 条全红的基线是 `24 files / 309 tests` 原样绿（重复三遍逐字相同）。

---

- [ ] **Step 8: 真窗口重测与提交**

复核改的是**每一条改几何命令的返回值**，所以两个真窗口闸门在 T7 之后各跑一遍。**判据形状一字不改**，只允许更新其中写死的毫米/像素字面量：

```bash
pnpm draw-shot    # 28 行 PASS（基础六条 + D1–D22；实测 28）
pnpm edit-shot    # 21 行 PASS
# 订正（2026-09-29）：四道闸门都是同一个 runner `scripts/desktop-shot.mjs` 上的开关，
# 由根 package.json 的 scripts 起（shot / pick-shot / edit-shot / draw-shot）。
# 正文原先写的 `desktop-draw.mjs` / `desktop-edit.mjs` **从来没有存在过**，照抄会凭空造一个文件。
# 执行日 T7 若要加 `--prop`，加的是同一个文件里的第四个 mode 与 `"prop-shot"` 那条 script。
```

Expected: 两个闸门**都绿**。若 `--draw-shot` 红在"新建的墙与既有墙共享一枚点"或毫米逐字对账那两句上，按本任务「T6 交接四条的处置」第 ④ 条处理：先在 Node 侧跑一遍 `wallProbe`，读它这一轮给的 `startMm / endMm / midPx`，把闸门里写死的那几个数换成新值，**并重跑三遍确认稳定**；不许把"那一发"改成"任一发候选都行"来迁就 —— 那是把 D4 的凭据换成 vacuous truth。

若 `--edit-shot` 红在落点对账：`dragProbe` 的候选集合在 T7 之后少了 84/160 发（全是会拖出星形的那几发，实测见第 ④ 条），每一把把手仍剩 ≥3 发 ⇒ 靶子可能换。同样只改字面量，不改判据。

```bash
git status --porcelain    # 只应有 packages/core/{src,test} 与 packages/scene-2d/{src,test} 下的文件
git add packages/core/src packages/core/test packages/scene-2d/src packages/scene-2d/test
git commit -m "feat(core): 派生复核进改几何的三条命令，补属性与删除命令"
```

提交信息按仓库口径再补一段正文：五条新命令（`storey.delete` / `wall.setMaterial` / `wall.setLoadBearing` / `column.delete` / `slab.delete`）、`assertDerivesAfterApply` 与 `pointStillReferenced` 两个产地、core 测试 276 → 309、以及 `joint.test.ts` 那五条哨兵改手工造文档的理由。

#### 执行回填（Task 7，2026-09-29 实测；commits `b2b59f0` + `b6a1d69` + `9ca3d43` + `8a8d2ee` + `bc35ecf` + `e22d700` + `684a4fb`）

**落地形状**：本任务按「单棒 ≤150 轮」拆成 **A/B/C/D/E** 五棒，执行中又**补排两棒**（F 量闸门、G 换判据），评审一席。BASE = `0b12ca2`。

- **A**（`b6a1d69`）`derive-guard.test.ts` 9 条 RED + `joint.test.ts` 五处改 `handBuild`（18 条不变）。**B**（`9ca3d43`）`commands-attributes.test.ts` 12 条 + `commands-delete.test.ts` 12 条 RED。**C**（`8a8d2ee`）Step 3+4+5 实现（`assertDerivesAfterApply` / `pointStillReferenced` / 三条改几何命令挂复核 + 两条属性命令 + 三条删除命令）。**D**（`bc35ecf`）Step 6（scene-2d 七条夹具前提改写 + `editing.ts` 三段注释，代码行零改动）。**E** Step 7 的 15 条改坏表，**零提交**（树逐条 `cp` 还原）。
- **计数账（盘上真话，覆盖编写期那三段拼账）**：`pnpm verify` = **`Test Files 33 passed (33)` / `Tests 439 passed (439)`**、typecheck exit=0、`lint:deps` 无新边；core **25 文件 / 316 条**（编写期的 24/309 是临时工程 `.tscheck/t8` 的数，盘上多 `commands-drag.test.ts` 7 条、少 3 条的差额已被 T5/T6 的落地填平）；scene-2d **6 文件 / 115 条**（`handles.test.ts` 是 **20** 条，不是 19）。⇒ 本节上面那句「core 测试 276 → 309」按盘上口径是 **283 → 316**。
- **Step 7 的 15 条改坏：13 条有牙、2 条无牙**（M4、M7，两条控制位**亲自重跑**：`npx vitest run packages/core/test` = exit=0 / 316 全绿）：
  - **M4**（给 `wallDelete` 挂复核没被抓到）根因：复核派生的是**补丁应用之后**的文档，删掉一根星臂后 3 端 3 方向自动解除 ⇒「坏数据必须还能删」那条哨兵**结构上抓不到**；能抓的形状（坏数据藏在另一处接头/另一层、删的是一把无关的墙）无覆盖 ⇒ **裁决 A1「删除路径永不复核」至今没有正面凭据**。补法（归 Task 8）：`derive-guard.test.ts` 加一条"别层/别处藏着坏数据时本层一条无关删除命令仍要跑得动"。
  - **M7**（给 `wallSetLoadBearing` 加 noop 短路没被抓到）根因：`commands-attributes.test.ts` 只有一条承重用例（`:107`，从不同值发同值）⇒ 短路分支不可达 ⇒ **A4「属性命令不许 noop 短路」只在材料半边有牙**。补法（归 Task 8 的属性面板）：加一条"同值再发一次，`build().upsert` 逐字是那面墙且 `depth` 每次 +2"。
  - 与预言相符的部分：M1 红 3 条、M10 红 4 条、M14/M15 各红 3 条（比 brief 点名多红一条同组见证「wallDelete 用的就是这一份判据」）；M8 `tsc errors=1`、M11/M12 `errors=2` 且首错互为镜像；**没有任何 M 额外红在 `commands-drag.test.ts`**。
- **Step 8 的判据冲突（本任务最贵的一条计划缺陷）**：正文写「判据形状一字不改，只允许更新写死的毫米/像素字面量」，而 `apps/desktop/src/main/index.ts:1198-1199` 与 `scripts/desktop-shot.mjs:181` **两处都登记着**「Task 7 落地 `assertDerivesAfterApply` 后这条判据的语义要改成'两边都不许写进真源'」。二者互斥，且 Step 1–8 没有任何一棒授权动 `apps/desktop` 与 `scripts` 的判据 ⇒ **计划漏排**。
  - 实测：`shot` 6 PASS、`pick-shot` 11、`edit-shot` 21（两遍落点读数逐字相同 ⇒ 担心的 `dragProbe` 靶子换**没发生**），**`draw-shot` exit=1、三遍红字逐字相同**（`斜墙草稿在屏幕上判不合法（落点 -1188,5835）`，抛点 `index.ts:1446`）。**这不是漂移**：`legalWallCreate` 试跑的就是带复核的真 `wallCreate().build(doc)` ⇒ 星形草稿 `legal` 由 true 转 false ⇒ 命令不发 ⇒ 渲染端等不到坏数据 ⇒ D22 的旧语义结构性不可达。
  - **裁决 G-1**：Task 7 不许带红闸门收棒，也不许放宽判据绕过去 ⇒ 补棒 G（`e22d700`）兑现那句已登记的语义替换。D22 那**一行**由 5 条与判换成 **11 条与判**（屏幕判不合法 + `rejected` 且 `wallId` 为 null + 点数 `N→N` + 真源 depth/revision/点数三者不动 + `lastError` 恒空 + 报告读得回来 + 起点逐字复用现造那枚角点），28 行总数不增不减、前 27 行一字未动。命令层那一半由 `derive-guard.test.ts` 的星形用例钉，真窗口不复述。
  - **牙测（控制位亲手，不采信报告）**：注释掉 `wall.ts:142` 的 `assertDerivesAfterApply` → `pnpm --filter @dajia/desktop build` → `--draw` ⇒ **exit=1，红在新那条判据**（`45° 第三臂在屏幕上仍判合法…assertDerivesAfterApply 掉了一处`）⇒ 新判据不是空转；`cp` 还原验 md5、重 build、再跑 ⇒ 28 PASS。
  - **代价（如实入账）**：F1 兜网（`PlanCanvas` 的 catch ⇒ `lastError`）在**绘制通路**上失去唯一真窗口凭据 —— A1 之后三条改几何命令都造不出坏几何，而删除路径按裁决永不复核且删除在派生上单调向好（删臂解星），现在硬造只能靠假通路。**Task 8 待办**：等出现"不经命令层的坏几何来源"（计划 4 读盘 / 计划 6 协作写入）时重造该凭据。另：`drawStarWall` 的"等 `lastCreate` 换新"依赖"被拒也写回执"这条隐式契约，它的正面凭据是 **D9**（`index.ts:1058-1062` + `desktop-shot.mjs:154-155`），不是 D22。
- **裁决 D-1 的落地与评审裁定**（`editing.test.ts:805-830`）：表判 false ⇒ 单向钉 `legal===false` 且 `draftCommand` 给 `null`（不读 `build`）；表判 true ⇒ 手工置真取命令、`try { probe.build(doc) }` 现问真源。评审席裁定：① **反向支今天恒真**（`buildCreate` 与 `draftCommand` 是**同一产地的两个消费者**，`throws === !legal` 是实现恒等式），它钉的是两处入参/字段映射漂开，**注释原称"两个产地对账，不是自己抄自己"属冒领** ⇒ 已按如实说法改掉（`684a4fb`），并明写"摘掉复核不会红在这里"；② 正向钉子**实测有牙**（评审席的只读推理"被派生层掩蔽所以不红"**是错的**：把 `assertWallShape` 改成进门 `return` ⇒ 红在 `expect(draft.legal).toBe(false)`，fast-check 反例 `(-1, 0)` —— 轴长 1mm 的墙过得了复核，只有这道构造期守卫挡它；「三种拒绝各一色」同时红）⇒ 凭据抄进注释；③ 第三种形状（既不抄派生规则又对今天代码非恒真）**不存在** ⇒ 维持现状 + 台账记两条已知弱点（反向支恒真、给表加「同向重叠」这条路已实测堵死：6 遍 5 红 1 绿，反例是轴长 ≈241～250 的短斜墙被判翻面）。
- **listing 与盘上不符（逐条，含一条假阳性）**：
  - **假阳性要纠**：6.1 的坐标「brief 写 `(-2000,60)` 而盘上是 `pxOf({x:5000,y:60})`」是**控制位记错的**（评审席逐字比对：listing 与盘上**一致**）。要纠的是 `task-7D-report.md:65` 的表述，不是 brief 正文。
  - 6.6 整段（把那条夹具重写成"既有点 (40,-760) 陷阱 + `sharedBy` 恰为 2 + 中心 `vec(400,100)`）**未落地也不该落地**：盘上那条是**垂足**版夹具、T7 之后本来就绿 ⇒ 只兑现其中一句真正缺的牙：`sharedBy` 从 `>= 2` 收成 **`toBe(2)`**（`684a4fb`，改后 handles 20/20）。行号锚 `:482`/`:549` 对不上盘上（实为 `:521`/`:558`）。
  - 6.8 的助手 `wallsFromOrigin` **盘上不存在**（`grep -rn` 零命中）⇒ 无段可删；6.5 注释里的 `stem 3671` 实算 **3231**。
  - Files 列表与 Step 8 的 `git add` 白名单**漏掉** `apps/desktop/src/main/index.ts` 与 `scripts/desktop-shot.mjs` ⇒ 照抄会把棒 G 落在提交外。
  - RED 条数：本任务开工时的盘上 RED 是 **29 条**（不是 33），另有 7 个 `TS2305` 名字充当"名字都补齐了"的清单；`pnpm verify` 在 typecheck 阶段就停，看不到测试段。
  - 正文原先那两行指向 `desktop-draw.mjs` / `desktop-edit.mjs` 的**从未存在过**（四道闸门一直是同一个 runner 的开关）—— 已在 `ab3115e` 订正。
- **过程教训（进台账）**：本任务出现**两条凭空捏造的完成通知**（对我从未派出的座位报"已提交"，哈希全是无效对象）⇒ 收棒判据升级为 `git cat-file` + `ls` 报告文件 + **控制位复跑同一命令**，且**后续棒次一律前台派发**（返回值是工具结果本身，不是通知）。

---
### Task 8: 楼层切换 + 属性面板 + 删除接屏（把 T7 补的那五道口用到屏幕上）

> **本任务的 node 侧全部实测**（临时工程 `.tscheck/t9`，2026-09-28：31 文件 / 449 条、九条变异逐条红在哪、`npx tsc --noEmit` 一处真错）。**renderer 与 `--prop-shot` 是编写期-authored、执行日回填**：`apps/desktop` 的 renderer 此刻还是 pong 占屏页，真窗口跑不了 —— 与 Task 3~6 的 renderer 步骤同一口径，判据形状写死、字面量留空。

**Files:**

| 文件 | 动什么 | 实测 |
| --- | --- | --- |
| `packages/scene-2d/src/panel.ts` | **新建**：材料候选集、`selectedWallForPanel`、`wallPropsOf`、`trialCommand`、`storeyTabsOf` | 163 行 |
| `packages/scene-2d/test/panel.test.ts` | **新建**：五组 21 条 | 21 条全绿 |
| `packages/scene-2d/src/index.ts` | 追加 `export * from './panel';` 一行 | — |
| `packages/scene-2d/src/editing.ts` | `planDelete` 从两条规则扩到四条（补柱 / 板）、`DeletePlan` 的 `unsupported` 语义改写、四处注释的 `T7` → `Task 8` 订正 | 逻辑改动集中在 219–288 行 |
| `packages/scene-2d/test/editing.test.ts` | 30 → 35 条：改写「三种沉默」「别层构件」，新增「③④ 接上屏幕」「柱落在墙端点上」「删一根带独占落点的柱」，再加两枚确定性夹具（筛 ⑤、⑥） | +5 条 |
| `apps/desktop/src/renderer/src/stores/editorStore.ts` | 加 `setStorey`：**换层与视口复位是同一次 `set`**（拆开发送给中间帧的机会） | 执行日 |
| `apps/desktop/src/renderer/src/PlanCanvas.tsx` | 挂 `<StoreyTabs/>` 与 `<PropPanel/>`；`DebugReport` 补 `storeyTabs` / `panel` / `lastTrial` / `propsAfterEdit` / `deletePlan` | 执行日 |
| `apps/desktop/src/main/index.ts` | 加 `--prop-shot` 的十六步合成输入 | 执行日 |
| `scripts/desktop-shot.mjs` | 加 `--prop` 开关与判据数组 | 执行日 |
| `package.json`（根） | `"prop-shot": "node scripts/desktop-shot.mjs --prop"` | 执行日 |

**Interfaces:**

- Consumes：T7 产的五条新命令（`wall.setLoadBearing` / `wall.setMaterial` / `storey.delete` / `column.delete` / `slab.delete`）与三条挂了复核的旧命令；`wallAxisById(doc, id).lengthMm`；`Document.byKind('storey')` 与 `StoreyEntity.projectId`；T6 产的 `planDelete` / `pruneSelection` / `wallProbe` / `fitStorey`。
- Produces：`PANEL_MATERIAL_OPTIONS`、`selectedWallForPanel(doc, storeyId, ids): WallEntity | null`、`wallPropsOf(doc, wallId): WallProps | null`、`trialCommand(doc, makeCommand: () => Command): TrialResult`、`storeyTabsOf(doc, projectId): StoreyTab[]`；`planDelete` 的 `candidateIds` 从"洞口在前、墙在后"变成"洞口 → 柱 → 板 → 墙"；`useEditor().setStorey`；`--prop-shot`。

#### 本任务的九条裁决

| # | 问题 | 裁决 | 为什么，以及代价 |
| --- | --- | --- | --- |
| P1 | 输入框里那一发"能不能提交"谁说了算？ | **只问真命令的试跑**（`trialCommand` 把"造命令 + 跑 `build`"整段放进 `try`），屏幕侧一道守卫都不写。 | `wall.setThickness` 现在有六道门（整数、正、墙厚 < 轴长、墙存在、接头直通两墙同厚、整层派生复核）。抄其中前两道写进输入框的版本，在 T7 那天已经被实测漂过一次（七条用例改写）；抄第三遍等于把"漂移"变成默认行为。代价：`reason` 是真源那句长文案（带数字与下一步），面板得能容下一行半的字，不许截断。 |
| P2 | `trialCommand` 吃 `Command` 对象还是吃工厂？ | **吃 `() => Command` 工厂**。 | 真源的守卫有两半：一半长在命令工厂的构造期（`assertMm` / `positiveMm` / `assertMaterial`），一半长在 `build` 里。传进来的是已造好的 Command，前者就在 `try` 外面 —— 用户在输入框打 `240.5` 是一条**未捕获异常**，屏幕上表现为整个面板崩掉。实测凭据：`panel.test.ts`「命令工厂里那半道门也在 try 内」（摘掉工厂那一半，M3 那一发翻成红）。代价：调用方每次问都要重新造一个命令对象；命令对象是纯数据，不心疼。 |
| P3 | 多选时面板展示谁？ | **恰好一面本层墙才给答案，其余一律 null**（空集、两面墙、柱、洞口、楼层、已消失的 id、别层的墙）。 | 下拉框一改就发命令，"取第一面"取决于 `Set` 的插入序（撤销一次就漂），于是屏幕上会出现"改的是我没选的那面墙"。实测凭据：M2 把 `picked.length === 1` 摘成 `picked[0]` 之后，只有那一条红 —— 它红得正好。代价：多选时面板整块消失，用户想知道"这五面墙各多厚"办不到；S1 不假装能。 |
| P4 | 材料下拉框的候选集放 core 还是放 UI？ | **值与中文标签放 UI（`PANEL_MATERIAL_OPTIONS`），写法纪律问 core 的 `assertMaterial`，测试逐条问一遍。** | 材料是**图纸上的标注文字**：S1 的真源只把它当字符串存，不进派生、不参与几何（T7 裁决 A4：`wall.setMaterial` 不跑 `assertDerivesAfterApply`）。放进 core 等于假装 core 认识"砖墙 / 加气混凝土"，而它不认识。代价：柱 / 板 / 门窗将来要各自再列一张表，不许互相借 —— 借来的是不相干的候选。 |
| P5 | `MIN_WALL_LENGTH_MM = 500` 要不要搬到输入框？ | **不搬。** 面板的长度格只读 `axisLengthMm`（真源派生），厚度格不设 `min`／`max`。 | 它是 T6 为了"探针挑得出能施工的靶子"定的**屏幕常量**，不是真源规则：300×300 的墙在 core 里唯一撞的是「墙厚不小于墙长」那道几何下限（实测 `panel.test.ts`「屏幕常量不是输入框的上限」：300mm 的墙 `wallCreate` 收、`MIN_WALL_LENGTH_MM` 拒了它，而 240×240 真源自己就抛）。搬上去等于屏幕自己立一道真源没有的闸，还会把"墙厚合法但墙太短"这种真实施工问题伪装成输入框的 bug。代价：用户能画出一面 300mm 长的墙，而它进不了施工图 —— 那属计划 5 的图纸校核，不属这一屏。 |
| P6 | 楼层 tab 的顺序与标高从哪儿来？ | **按真源 `index` 升序**（不是照抄 `byKind`）、标高读 `StoreyEntity.elevationMm`（不算 `index × heightMm`）、标签 `第 ${index + 1} 层`。 | `byKind` 按 id 升序返回，而 uuidv7 在同一毫秒内不单调 ⇒ 照抄它，两层项目的 tab 顺序会跨进程漂（实测：十轮打乱里"id 序 ≠ index 序"的轮数跑出 9、8、9、8、7、9）。样例房二层被 `storeySetElevation` 从 6000 改成 3000 ⇒ 算出来的 tab 上是假数字。代价：`index` 必须唯一（`storeyCreate` 已守卫），这个排序因此是全序，不必再排第二次。 |
| P7 | Delete 键到底接几类构件？ | **接四类**：墙、独立洞口、柱、板。派发顺序定死成 **洞口 → 柱 → 板 → 墙**（各自按 id 升序）。`storeyDelete` **不接** Delete 键。 | 柱与板的删除命令 T7 已经补好（`column.delete` / `slab.delete`，各自收掉自己独占的落点），屏幕上只差把它接到 `planDelete` 的 `unsupported` 那一格里。顺序定死是为了撤销栈可读：栈顶恒是 `wall.delete`，一次 Ctrl+Z 把"墙 + 它自己级联掉的洞口"整组还回来。`storeyDelete` 的入口是楼层 tab 上那条显式动作而不是删除键 —— 删整层要连带删光该层所有构件，需要确认框，S1 没有确认框。代价：`unsupported` 从此只装两样屏幕上根本取不到的东西（裸点与楼层本身）+ 别层构件。 |
| P8 | T 接两侧改不成同厚怎么办？ | **只显示真源文案，不试图绕过。** 不加"同时改两面墙"的隐藏命令，也不让面板偷偷多派一条。 | 复核是逐发问"这一发之后的世界"，两侧各发一条 ⇒ 每条都看见对面还是原厚 ⇒ 两条都拒（实测：`.tscheck/tmp/scratch2.txt` 的 A 组 —— 连发 (800,800) 两条全 `REJ-同厚`，摘掉中间那根 stem 再连发才成 800/800）。真给用户第二条路只有"改画成 L 角"，那是几何编辑，不属面板。代价：样例房一层八面墙里有四面被这道守卫锁死（B 组：`southWest` 与 `southEast` 四档全 `REJ-同厚`，`partEast` / `partWest` 只有同值那一档 OK），`--prop-shot` 必须挑**改得动**那四面之一当靶子。 |
| P9 | 柱与板屏幕上点不到，怎么证明"删得掉"？ | **由合成夹具证明，不把柱画进指令表。** | `buildDrawList` 与 `pickAt` 都只认墙与洞口，所以 ③④ 两支的凭据只能是手工把柱 / 板的 id 塞进选中集（`editing.test.ts` 里的 `kindId` 助手就是这件事的形状）。为了"在屏幕上证明它"把柱掺进指令表 = 混进 Task 9 / 计划 4 的边界，且 `--draw-shot` 那 28 行像素判据要全数重测。代价：`--prop-shot` 里删柱那一步**不能**当验收凭据；这一支只有 node 侧红绿可看。 |

- [ ] **Step 1: 建临时工程并取基线**

沿用 Task 7 的做法：`cp -a .tscheck/t8 .tscheck/t9`（t8 是 T7 落地的逐字副本），`vitest.config.ts` 的 alias 把 `@dajia/core` 指向 `./core/src/index.ts`、`@dajia/scene-2d` 指向 `./packages/scene-2d/src/index.ts`，`tsconfig.scene2d.json` extends 根 `tsconfig.base.json`、include `core/src` + `packages/scene-2d/{src,test}`。

Run: `npx vitest run --config .tscheck/t9/vitest.config.ts`
Expected: **30 文件 / 423 条全绿**（core 24/309 + scene-2d 6/114），与 Task 7 Step 7 回填的那笔账逐字相同。这一步的红绿都不许带进 Step 2。

- [ ] **Step 2: 写失败测试 —— `panel.test.ts` 全文，再落 `panel.ts`**

先不写 `panel.ts`，只把测试全文写完、`index.ts` 也先不动，跑一遍取红。**预期的红形**（编写期只推得出形状，与 T7 Step 2 那句"别等 `SyntaxError`"同一理由：`export *` 的入口缺东西时拿到的是 `undefined`）：21 条一起红在 `selectedWallForPanel is not a function` 这类调用点上，而不是红在断言里。红完再落实现 —— 这一步不许反过来（先写实现再补测试，21 条里有 14 条会退化成"测实现写了什么"）。

`packages/scene-2d/test/panel.test.ts`（21 条，逐字实测绿）：

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  assertMaterial,
  columnCreate,
  openingCreate,
  storeyCreate,
  uuidv7,
  wallCreate,
  wallDelete,
  wallSetLoadBearing,
  wallSetMaterial,
  wallSetThickness,
  type PointRef,
  type WallEntity,
} from '@dajia/core';
import {
  MIN_WALL_LENGTH_MM,
  PANEL_MATERIAL_OPTIONS,
  demoHouse,
  selectedWallForPanel,
  storeyTabsOf,
  trialCommand,
  wallPropsOf,
} from '@dajia/scene-2d';

const house = demoHouse();

function synthStorey(heightMm = 3000): { log: TransactionLog; storeyId: string; projectId: string } {
  const projectId = uuidv7();
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm }));
  let storeyId = '';
  for (const id of log.affected) {
    if (log.document.get(id)?.kind === 'storey') storeyId = id;
  }
  if (storeyId === '') throw new TypeError('affected 里没有新建的楼层');
  return { log, storeyId, projectId };
}

function wallAt(log: TransactionLog, storeyId: string, start: PointRef, end: PointRef): WallEntity {
  log.dispatch(wallCreate({ storeyId, start, end, thicknessMm: 240, heightMm: 3000 }));
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new TypeError('affected 里没有新建的墙');
}

/** 一面墙 + 一根柱 + 一樘洞口：面板取墙那几条要区分"点得到的"与"点不到的"。 */
function wallWithNeighbours(): {
  log: TransactionLog;
  storeyId: string;
  wall: WallEntity;
  columnId: string;
  openingId: string;
} {
  const { log, storeyId } = synthStorey();
  const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
  log.dispatch(columnCreate({ storeyId, at: { x: 500, y: 500 }, widthMm: 400, depthMm: 400 }));
  const columnId = [...log.affected].find((id) => log.document.get(id)?.kind === 'column');
  if (columnId === undefined) throw new TypeError('affected 里没有那根柱');
  log.dispatch(
    openingCreate({ hostWallId: wall.id, distanceMm: 1200, widthMm: 1000, heightMm: 2100, category: 'door' }),
  );
  const openingId = [...log.affected].find((id) => log.document.get(id)?.kind === 'opening');
  if (openingId === undefined) throw new TypeError('affected 里没有那樘洞口');
  return { log, storeyId, wall, columnId, openingId };
}

/**
 * 一面墙的 T 接现场：贯通线 (0,0)→(4000,0)→(8000,0) 在 (4000,0) 上立一根 stem。
 * `wall.setThickness` 的派生复核只在这一发上说话（命令层前三道门全过），所以整条
 * 「输入预言」用例都建在它上面。2026-09-28 实测：stem 在时改贯通任一侧 ⇒
 * 「接头 … 的直通两墙厚度不同（370 / 240）…」；摘掉 stem（T 变纯贯通两臂点）⇒ 同值改得动。
 */
function teeJoint(): {
  log: TransactionLog;
  storeyId: string;
  west: WallEntity;
  east: WallEntity;
  stem: WallEntity;
} {
  const { log, storeyId } = synthStorey();
  const west = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
  const east = wallAt(log, storeyId, { pointId: west.endId }, { x: 8000, y: 0 });
  log.dispatch(
    wallCreate({
      storeyId,
      start: { pointId: east.startId },
      end: { x: 4000, y: 3000 },
      thicknessMm: 120,
      heightMm: 3000,
    }),
  );
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall' && entity.thicknessMm === 120) return { log, storeyId, west, east, stem: entity };
  }
  throw new TypeError('affected 里没有那根 stem');
}

describe('材料候选集', () => {
  it('每一项都真发得出去：五项逐个试跑 `wall.setMaterial`，reason 逐字为 null', () => {
    const { log, storeyId } = synthStorey();
    const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    for (const option of PANEL_MATERIAL_OPTIONS) {
      const trial = trialCommand(log.document, () =>
        wallSetMaterial({ wallId: wall.id, material: option.value }),
      );
      // 判 reason 逐字为 null 而不是"没抛"：候选集里漂进一个带空格的写法时，
      // 真源的文案会进来，而 `ok` 那一路已经先红 —— 两句一起看才知道是谁在说话。
      expect({ value: option.value, ok: trial.ok, reason: trial.reason }).toEqual({
        value: option.value,
        ok: true,
        reason: null,
      });
    }
  });

  it('写法纪律问 core 的 `assertMaterial`：候选集全过，自造的三种写法全拒', () => {
    const materialLegal = (material: string): boolean => {
      try {
        assertMaterial(material);
        return true;
      } catch {
        return false;
      }
    };
    for (const option of PANEL_MATERIAL_OPTIONS) {
      expect(materialLegal(option.value)).toBe(true);
    }
    // 素材自证：这一条真的在问写法，不是恒真 —— 空串、首尾空白、超长各一。
    expect(materialLegal('')).toBe(false);
    expect(materialLegal(' brick')).toBe(false);
    expect(materialLegal('砖'.repeat(33))).toBe(false);
  });

  it('标签非空、值不带空白，且首屏那面墙的当前材料在候选里找得到', () => {
    for (const option of PANEL_MATERIAL_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.value).toBe(option.value.trim());
    }
    const { log, storeyId } = synthStorey();
    const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const props = wallPropsOf(log.document, wall.id);
    if (props === null) throw new TypeError('刚建好的墙读不出属性');
    // 下拉框打开时当前值必须在候选里，否则面板显示空白而真源里那面墙有材料（两套口径）
    expect(PANEL_MATERIAL_OPTIONS.some((o) => o.value === props.material)).toBe(true);
    expect(props.material).toBe('brick'); // 真源默认（`wallCreate` 里那句 `?? 'brick'`）
  });
});

describe('面板取哪一面墙', () => {
  it('恰好一面本层墙 ⇒ 就是它（逐字同一引用，面板不复制实体）', () => {
    const { log, storeyId, wall } = wallWithNeighbours();
    expect(selectedWallForPanel(log.document, storeyId, [wall.id])).toBe(wall);
  });

  it('两面墙一起选中 ⇒ null：面板不许"取第一面"，那等于偷偷改用户的选中集', () => {
    const { log, storeyId } = synthStorey();
    const a = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const b = wallAt(log, storeyId, { x: 0, y: 2000 }, { x: 4000, y: 2000 });
    expect(selectedWallForPanel(log.document, storeyId, [a.id, b.id])).toBeNull();
    // 素材自证：单发同一面墙仍是答案 ⇒ 上一发红在"两面"，不红在"这面墙读不出"
    expect(selectedWallForPanel(log.document, storeyId, [b.id])).toBe(b);
  });

  it('柱、洞口、已消失的 id、别层的墙四种都拿 null', () => {
    const { log, storeyId, columnId, openingId } = wallWithNeighbours();
    expect(selectedWallForPanel(log.document, storeyId, [columnId])).toBeNull();
    expect(selectedWallForPanel(log.document, storeyId, [openingId])).toBeNull();
    expect(selectedWallForPanel(log.document, storeyId, ['gone'])).toBeNull();
    const upper = house.doc.byKind('wall').find((w) => w.storeyId === house.upperStoreyId);
    if (upper === undefined) throw new TypeError('样例房二层应当有墙');
    expect(selectedWallForPanel(house.doc, house.lowerStoreyId, [upper.id])).toBeNull();
    // 素材自证：同一枚别层墙问到它自己的层就给答案 ⇒ 上一发红在认层
    expect(selectedWallForPanel(house.doc, house.upperStoreyId, [upper.id])).toBe(upper);
  });

  it('空集给 null 不抛；混选（墙 + 柱）仍是那面墙', () => {
    const { log, storeyId, wall, columnId } = wallWithNeighbours();
    expect(selectedWallForPanel(log.document, storeyId, [])).toBeNull();
    // 混选给墙：面板照开。柱只是**改不了属性**（S1 没有柱面板），不是删不掉（Task 8 接了 columnDelete）
    expect(selectedWallForPanel(log.document, storeyId, [columnId, wall.id])).toBe(wall);
  });
});

describe('面板读值', () => {
  it('三格逐字取自真源，第四格是这面墙的轴长', () => {
    const { log, storeyId } = synthStorey(3600);
    const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    expect(wallPropsOf(log.document, wall.id)).toEqual({
      wallId: wall.id,
      thicknessMm: 240,
      // 墙高读墙自己的字段，不读层高：3600 的层上画 3000 的墙是本夹具故意留的差别。
      // 面板显示层高的话，用户在屏幕上看不见"这面墙够不到顶"。
      heightMm: 3000,
      material: 'brick',
      loadBearing: true,
      axisLengthMm: 4000,
    });
  });

  it('撤销掉正被选中的那面墙：读值与取墙双双回到 null，面板清空而不抛', () => {
    const { log, storeyId } = synthStorey();
    const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    expect(wallPropsOf(log.document, wall.id)).not.toBeNull();
    expect(log.undo()).toBe(true);
    expect(wallPropsOf(log.document, wall.id)).toBeNull();
    expect(selectedWallForPanel(log.document, storeyId, [wall.id])).toBeNull();
  });

  it('楼层与柱的 id 不是墙：读值 null，不抛（挡住把 `wallAxisById` 接进面板）', () => {
    const { log, storeyId } = wallWithNeighbours();
    expect(wallPropsOf(log.document, storeyId)).toBeNull();
    const column = log.document.byKind('column')[0];
    if (column === undefined) throw new TypeError('夹具里没有柱');
    expect(wallPropsOf(log.document, column.id)).toBeNull();
  });
});

describe('输入框那一发的预言', () => {
  it('命令工厂里那半道门也在 try 内：非整数毫米给文案，不给未捕获异常', () => {
    const { log, storeyId } = synthStorey();
    const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    // `wallSetThickness(240.5)` 在**构造期**就抛（`assertMm`），所以 `trialCommand` 吃的是工厂函数。
    // 改成吃 Command 对象的话这一行是"测试自己抛"，红在测试而不是红在预言 —— 那条红同样有效，
    // 但它不告诉下一个人为什么签名是 `() => Command`。
    const rough = trialCommand(log.document, () =>
      wallSetThickness({ wallId: wall.id, thicknessMm: 240.5 }),
    );
    expect(rough.ok).toBe(false);
    expect(rough.reason).toMatch(/必须是整数毫米/);
  });

  it('真源三道门各一句文案：非正、墙厚不小于轴长、墙不存在', () => {
    const { log, storeyId } = synthStorey();
    const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    expect(trialCommand(log.document, () => wallSetThickness({ wallId: wall.id, thicknessMm: 370 }))).toEqual({
      ok: true,
      reason: null,
    });
    for (const mm of [0, -240]) {
      const bad = trialCommand(log.document, () => wallSetThickness({ wallId: wall.id, thicknessMm: mm }));
      expect(bad.ok).toBe(false);
      expect(bad.reason).toMatch(/必须为正/);
    }
    const tooThick = trialCommand(log.document, () =>
      wallSetThickness({ wallId: wall.id, thicknessMm: 4000 }),
    );
    expect(tooThick.reason).toMatch(/不小于墙长/); // 真源那句带数字，比屏幕自编的"太大"有用
    const gone = trialCommand(log.document, () => wallSetThickness({ wallId: 'gone', thicknessMm: 240 }));
    expect(gone.ok).toBe(false);
    expect(gone.reason).toMatch(/不存在|不是墙/); // `mustExist` / `requireWall` 的文案，屏幕不复述
  });

  it('T 接改厚被派生复核挡下：命令层三道门全过，拒它的是「直通两墙厚度不同」', () => {
    const tee = teeJoint();
    const doc = tee.log.document;
    // 先自证命令层看不见这件事：370 < 轴长 4000、是正整数、墙存在 ⇒ 前三道门全过
    expect(tee.west.thicknessMm).toBe(240);
    const trial = trialCommand(doc, () => wallSetThickness({ wallId: tee.west.id, thicknessMm: 370 }));
    expect(trial.ok).toBe(false);
    expect(trial.reason).toMatch(/直通两墙厚度不同/);
    // 素材自证 ①：stem（垂直那臂）加厚不受这条纪律约束 ⇒ 上一发红在"贯通两墙"，不红在"加厚"
    expect(trialCommand(doc, () => wallSetThickness({ wallId: tee.stem.id, thicknessMm: 370 })).ok).toBe(true);
    // 素材自证 ②：同值重设合法 ⇒ 红在"两侧不同厚"，不红在"这面墙谁都改不动"
    expect(trialCommand(doc, () => wallSetThickness({ wallId: tee.west.id, thicknessMm: 240 })).ok).toBe(true);
  });

  it('两侧逐条连发改不动 T 接：每条各自复核自己那一发之后的世界', () => {
    // 这是属性面板的**能力边界**，写成判据而不是注释：屏幕上"把两侧都改成 800"只能是两次派发，
    // 第一次派发时另一侧还是 240 ⇒ 被拒；第二次时两侧仍不同（第一次没落地）⇒ 再被拒。
    // 拆掉 stem（T 变纯贯通两臂点）之后同两发改得动 —— 2026-09-28 实测：厚度 800/800、深度 7。
    const tee = teeJoint();
    const log = tee.log;
    const first = trialCommand(log.document, () =>
      wallSetThickness({ wallId: tee.west.id, thicknessMm: 800 }),
    );
    expect(first.ok).toBe(false);
    const second = trialCommand(log.document, () =>
      wallSetThickness({ wallId: tee.east.id, thicknessMm: 800 }),
    );
    expect(second.ok).toBe(false);
    expect(log.depth).toBe(4); // 三层 + 一根 stem，一次派发都没发生
    // 拆掉 stem ⇒ T 接不在这里了，两发连发就过（面板给出的下一步"改画成 L 角"真的走得通）
    log.dispatch(wallDelete({ wallId: tee.stem.id }));
    expect(trialCommand(log.document, () => wallSetThickness({ wallId: tee.west.id, thicknessMm: 800 })).ok).toBe(true);
    log.dispatch(wallSetThickness({ wallId: tee.west.id, thicknessMm: 800 }));
    expect(trialCommand(log.document, () => wallSetThickness({ wallId: tee.east.id, thicknessMm: 800 })).ok).toBe(true);
  });

  it('试跑不动真源：墙数、那面墙的厚度、撤销栈深度三票原样', () => {
    const { log, storeyId } = synthStorey();
    const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const depthBefore = log.depth;
    expect(trialCommand(log.document, () => wallSetThickness({ wallId: wall.id, thicknessMm: 370 })).ok).toBe(true);
    expect(log.depth).toBe(depthBefore);
    expect(log.document.get(wall.id)).toEqual(wall); // 引用逐字相同：不可变文档没被试跑动过
    const rejected = trialCommand(log.document, () =>
      wallSetThickness({ wallId: wall.id, thicknessMm: 9999 }),
    );
    expect(rejected.ok).toBe(false); // 9999 > 轴长 4000：预言给 false，而真源一个字没动
    expect(log.document.get(wall.id)).toEqual(wall);
    expect(log.depth).toBe(depthBefore);
    // 反证：真的派发一次，三票全变 ⇒ 上面那两句不是"恒不变"
    log.dispatch(wallSetThickness({ wallId: wall.id, thicknessMm: 370 }));
    expect(log.depth).toBe(depthBefore + 1);
  });

  it('承重与材料不进派生：同值反复点各留一条撤销记录（T7 裁决 A4 的代价在屏幕侧有读者）', () => {
    const { log, storeyId } = synthStorey();
    const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    for (const material of ['brick', 'brick', 'brick']) {
      expect(trialCommand(log.document, () => wallSetMaterial({ wallId: wall.id, material })).ok).toBe(true);
    }
    const depthBefore = log.depth;
    log.dispatch(wallSetLoadBearing({ wallId: wall.id, loadBearing: true })); // 与现值相同的一发
    expect(log.depth).toBe(depthBefore + 1);
    expect(log.undo()).toBe(true);
    expect(log.document.get(wall.id)).toEqual(wall); // 撤销回到原样 ⇒ 代价只是栈里多一条空改动
  });

  it('屏幕常量不是输入框的上限：300mm 的墙真源收，而 `MIN_WALL_LENGTH_MM` 是 500', () => {
    // Task 6 交过来的那一条（E17 的凭据登记在这里）。三个事实摞在一起才叫"分家"：
    // ① 真源对长度只有两道（零长、墙厚 < 轴长），一面 300mm 的墙建得出来 —— 短得没法施工，但合法；
    // ② `MIN_WALL_LENGTH_MM` = 500 比真源严，而它只活在 `wallProbe` 挑靶子里；
    // ③ 于是面板若拿 ② 当输入上限，就会拒掉真源已经收下的一发 ⇒ 屏幕上"这面墙存在"与"改不动它"同时发生。
    const { log, storeyId } = synthStorey();
    const short = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 300, y: 0 });
    const props = wallPropsOf(log.document, short.id);
    if (props === null) throw new TypeError('300mm 的墙读不出属性');
    expect(props.axisLengthMm).toBe(300);
    expect(300).toBeLessThan(MIN_WALL_LENGTH_MM);
    expect(trialCommand(log.document, () => wallSetThickness({ wallId: short.id, thicknessMm: 299 })).ok).toBe(true);
    // 真源那两道门仍然在说话：240 厚 240 长的墙连建都建不出来（屏幕常量换成真源口径也不放宽）
    expect(() =>
      wallCreate({
        storeyId,
        start: { x: 500, y: 500 },
        end: { x: 740, y: 500 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    ).toThrow(/不小于墙长/);
  });
});

describe('楼层 tab', () => {
  it('样例房两层：按 index 升序、标签逐字、标高读真源（二层是被编辑过的那一份）', () => {
    const lower = house.doc.get(house.lowerStoreyId);
    if (lower?.kind !== 'storey') throw new TypeError('一层读出来不是楼层实体');
    const projectId = lower.projectId;
    expect(storeyTabsOf(house.doc, projectId)).toEqual([
      // 二层被 `storeySetElevation` 从 6000 改成 3000（demo.ts 的第 4 次编辑）。
      // tab 读真源而不是算 `index * heightMm`：改过标高之后两者不等，屏幕上写的是假数字。
      { storeyId: house.lowerStoreyId, index: 0, elevationMm: 0, heightMm: 3000, label: '第 1 层' },
      { storeyId: house.upperStoreyId, index: 1, elevationMm: 3000, heightMm: 3000, label: '第 2 层' },
    ]);
  });

  it('外来项目的楼层不进本项目的 tab', () => {
    const { log, storeyId, projectId } = synthStorey();
    const foreign = uuidv7();
    log.dispatch(storeyCreate({ projectId: foreign, index: 0, elevationMm: 0, heightMm: 3000 }));
    const foreignStoreyId = [...log.affected].find(
      (id) => log.document.get(id)?.kind === 'storey' && id !== storeyId,
    );
    if (foreignStoreyId === undefined) throw new TypeError('affected 里没有外来项目那层');
    expect(storeyTabsOf(log.document, projectId).map((t) => t.storeyId)).toEqual([storeyId]);
    expect(storeyTabsOf(log.document, foreign).map((t) => t.storeyId)).toEqual([foreignStoreyId]);
    expect(log.document.byKind('storey').length).toBe(2); // 素材自证：过滤真的在筛，文档里确实两层
  });

  it('顺序按 index 而不是按 id：十轮打乱里至少五轮 id 序与 index 序不同（摘掉 sort 的凭据）', () => {
    // `Document.byKind` 按 id 升序返回，而 uuidv7 在同一毫秒内不单调 ⇒ "照抄 byKind 的顺序"
    // 是一个跨进程漂的写法。这一条把 sort 的凭据钉成**可数的量**：同一套夹具跑十轮，
    // 数出"byKind 的 index 序列 ≠ tab 的 index 序列"的轮数。
    // 2026-09-28 跑六次，十轮里的轮数依次为 9、8、9、8、7、9 ⇒ 下限取 5（每轮独立，
    // 10 轮全序的概率约 (1/6)^10；写成 5 而不是实测最小值，是为了不把这条变成"今天 uuid 恰好这么排"）。
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
      [2, 1, 0],
      [1, 2, 0],
      [2, 0, 1],
      [0, 2, 1],
    ];
    let disagrees = 0;
    for (const permutation of permutations) {
      const projectId = uuidv7();
      const log = new TransactionLog(Document.create(projectId));
      // 三层各 3000 高、贴邻不重叠（`storeyCreate` 判重叠，贴邻合法）；index 由这一轮给
      for (const [level, index] of permutation.entries()) {
        log.dispatch(storeyCreate({ projectId, index, elevationMm: level * 3000, heightMm: 3000 }));
      }
      const tabs = storeyTabsOf(log.document, projectId);
      expect(tabs.map((t) => t.index)).toEqual([0, 1, 2]);
      // tab 的 storeyId 必须与那一层真源的 index / 标高配套：只按 index 排序、
      // 但字段抄自另一层（排序排错了对象）时这两句红，上面那句只看 index 不够。
      for (const tab of tabs) {
        const storey = log.document.get(tab.storeyId);
        if (storey?.kind !== 'storey') throw new TypeError('tab 指着的实体不是楼层');
        expect(storey.index).toBe(tab.index);
        expect(storey.elevationMm).toBe(tab.elevationMm);
        expect(storey.heightMm).toBe(tab.heightMm);
      }
      const byId = log.document
        .byKind('storey')
        .filter((s) => s.projectId === projectId)
        .map((s) => s.index);
      if (byId.join(',') !== tabs.map((t) => t.index).join(',')) disagrees += 1;
    }
    // 写成下限而不是等号：等号会让这条变成"今天 uuid 恰好这么排"的第二个跨进程判据。
    console.log("DISAGREES=" + disagrees); expect(disagrees).toBeGreaterThanOrEqual(5);
  });

  it('只有一层时 tab 也有一条：不许"单层就不显示列表"把切换入口一起砍掉', () => {
    const { log, storeyId, projectId } = synthStorey();
    expect(storeyTabsOf(log.document, projectId)).toEqual([
      { storeyId, index: 0, elevationMm: 0, heightMm: 3000, label: '第 1 层' },
    ]);
  });
});

```

`packages/scene-2d/src/panel.ts`（163 行，逐字实测绿）：

```ts
import {
  wallAxisById,
  type Command,
  type Document,
  type EntityId,
  type StoreyEntity,
  type WallEntity,
} from '@dajia/core';

/**
 * 屏幕右侧那一栏的**只读派生**（Task 8）：属性面板的三格读值、材料下拉框的候选集、
 * 楼层 tab 的列表，以及"输入框里那一发真源收不收"的唯一预言。
 *
 * 为什么不塞进 `editing.ts`：`editing.ts` 管的是**改之前**的判断（要不要发、发给谁、删的时候发几条），
 * 本文件管的是**读出来给人看**与**输入框里的数能不能进**。两者共用的那条纪律
 * （合法性只问真命令试跑）在这里以 `trialCommand` 一个函数收掉，与 `legalWallCreate` / `legalDrop`
 * 是同一形状的第三次出现 —— 出现三次而不抽公共层：三者的入参形状（草稿 / 把手落点 / 属性补丁）
 * 本来就不一样，抽出来只剩一个 `try`。
 */

/** 材料下拉框的一格。`value` 写进真源，`label` 只给屏幕看。 */
export interface MaterialOption {
  readonly value: string;
  readonly label: string;
}

/**
 * 材料候选集。**值在 UI 侧，写法纪律在真源**（core 的 `assertMaterial` 判非空、无首尾空白、≤32 字符；
 * 面板测试逐条问一遍，见 `panel.test.ts`「候选集里每一项都过真源那道写法纪律」）。
 *
 * 为什么候选集不放 core：材料是**图纸上的标注文字**，S1 的真源只把它当字符串存 ——
 * 不进派生、不参与几何（`wall.setMaterial` 不跑 `assertDerivesAfterApply`）。
 * 放进 core 等于假装 core 认识这些材料，而它不认识。
 * 代价：柱 / 板 / 门窗将来要各自再列一张表，不许互相借 —— 借来的是不相干的候选。
 */
export const PANEL_MATERIAL_OPTIONS: readonly MaterialOption[] = [
  { value: 'brick', label: '砖墙' },
  { value: 'concrete', label: '混凝土' },
  { value: 'aerated-concrete', label: '加气混凝土' },
  { value: 'wood', label: '木' },
  { value: 'steel', label: '钢' },
];

/**
 * 面板三格的读值。字段名与真源逐字一致，面板不许自己攒一份状态：
 * 攒了就是第二套口径，改了不写回时屏幕上是对的真源是错的。
 */
export interface WallProps {
  readonly wallId: EntityId;
  readonly thicknessMm: number;
  readonly heightMm: number;
  readonly material: string;
  readonly loadBearing: boolean;
  /**
   * 轴长（毫米，浮点，来自 core 的 `wallAxisById`）。面板显示它只有一个理由：
   * 真源那道守卫判的是 `thicknessMm >= 轴长`，输入框里的 240 合不合法**取决于这面墙有多长**。
   */
  readonly axisLengthMm: number;
}

/**
 * 选中集 → 面板要展示的那面墙。**恰好一面**才给答案，两面以上给 null。
 *
 * 为什么"取第一面"不行：下拉框一改就发命令，"第一面"取决于 `Set` 的插入序（撤销一次就漂），
 * 于是屏幕上会出现"改的是我没选的那面墙"。
 * 别层的、已不存在的、柱 / 板 / 洞口 / 楼层同样给 null —— S1 的面板只认墙（屏幕上点得到的只有墙与洞口，
 * 而洞口的位置由 `openingMove` 那条通路管，柱与板还没有属性面板）。
 */
export function selectedWallForPanel(
  doc: Document,
  storeyId: string,
  ids: Iterable<EntityId>,
): WallEntity | null {
  const picked: WallEntity[] = [];
  for (const id of ids) {
    const entity = doc.get(id);
    if (entity?.kind !== 'wall') continue;
    if (entity.storeyId !== storeyId) continue;
    picked.push(entity);
  }
  return picked.length === 1 ? picked[0]! : null;
}

/** 一面墙 → 面板读值。墙不在文档里给 null（撤销掉正被选中的那一发：面板跟着清空，不抛）。 */
export function wallPropsOf(doc: Document, wallId: EntityId): WallProps | null {
  const wall = doc.get(wallId);
  if (wall?.kind !== 'wall') return null;
  return {
    wallId: wall.id,
    thicknessMm: wall.thicknessMm,
    heightMm: wall.heightMm,
    material: wall.material,
    loadBearing: wall.loadBearing,
    axisLengthMm: wallAxisById(doc, wall.id).lengthMm,
  };
}

/** `trialCommand` 的答案。`reason` 是**真源那句抛错文案**，不是屏幕编的。 */
export interface TrialResult {
  readonly ok: boolean;
  readonly reason: string | null;
}

/**
 * 输入框那一发的预言：把"造命令 + 跑 `build`"整段放进 try，拿真源的文案当答案。
 *
 * ① **吃的是工厂函数，不是 Command 对象**。真源的守卫有两半：一半在命令工厂里
 *   （`assertMm` / `positiveMm` / `assertMaterial`，构造期就抛），一半在 `build` 里
 *   （查实体、查墙厚不小于轴长、跑 T7 的派生复核）。传进来的是已造好的 Command，
 *   前者就在 try 外面 —— 输入框打 `240.5` 是一条未捕获异常，屏幕上表现为整个面板崩掉。
 * ② **不重写守卫**。`wall.setThickness` 现在有六道门（整数、正、墙厚 < 轴长、墙存在、
 *   接头直通两墙同厚、整层派生复核）。屏幕侧照抄前两道的版本在 T7 那天已经漂过一次
 *   （七条用例改写），不许再抄第三遍。
 * ③ **试跑不碰真源**：`build(doc)` 只算补丁，`Document` 不可变，落地要经 `TransactionLog.dispatch`。
 *   所以没有副本、没有深拷贝，也没有"试跑之后要撤销"的账。
 *
 * 为什么返回文案而不是布尔：面板要把"为什么进不去"给用户看。真源那句
 * 「接头 … 的直通两墙厚度不同（370 / 240），S1 的 T 接与十字要求直通两墙同厚：请统一墙厚，或把它改画成 L 角」
 * 带着数字与下一步，屏幕自编的「墙厚太大」两句都给不了。
 *
 * 面板每次 `revision` 变化重问一遍，不缓存：预言吃的是**当前文档**，用户在输入框改数期间
 * 按了撤销，缓存的那一份就是谎话（`moveDraft` 每次重问 `legalWallCreate` 同一条理由）。
 */
export function trialCommand(doc: Document, makeCommand: () => Command): TrialResult {
  try {
    makeCommand().build(doc);
    return { ok: true, reason: null };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 楼层 tab 的一格。`label` 给按钮，`index` 是真源那个序号（顺序由它决定）。 */
export interface StoreyTab {
  readonly storeyId: EntityId;
  readonly index: number;
  readonly elevationMm: number;
  readonly heightMm: number;
  readonly label: string;
}

/**
 * 楼层 tab 列表。**按真源的 `index` 升序，不是照抄 `byKind` 的顺序**：
 * `Document.byKind` 按 id 升序返回，而 uuidv7 在同一毫秒内不单调 ⇒ 照抄它，两层项目的 tab
 * 顺序会跨进程漂（`panel.test.ts` 把这件事钉成一个可数的量：十轮打乱、断言"至少五轮 id 序与 index
 * 序不同"；实测六次独立进程跑出的轮数是 9、8、9、8、7、9，下限留 5 是留出实测的抖动余量）。
 * `index` 在同项目内唯一（`storeyCreate` 的构造期守卫），所以这个排序是全序，不必再排第二次。
 *
 * 标高读真源而不是算 `index * heightMm`：样例房二层被 `storeySetElevation` 从 6000 改成 3000，
 * 算出来的 tab 上写的是假数字。
 */
export function storeyTabsOf(doc: Document, projectId: EntityId): StoreyTab[] {
  const storeys: StoreyEntity[] = doc
    .byKind('storey')
    .filter((s) => s.projectId === projectId)
    .sort((a, b) => a.index - b.index);
  return storeys.map((s) => ({
    storeyId: s.id,
    index: s.index,
    elevationMm: s.elevationMm,
    heightMm: s.heightMm,
    label: `第 ${s.index + 1} 层`,
  }));
}

```

Run: `npx vitest run --config .tscheck/t9/vitest.config.ts packages/scene-2d/test/panel.test.ts`
Expected: **21 passed**。这一步里唯一一次真错是 TS 报在测试身上（`Entity` 联合上 `projectId` 不是共有字段 ⇒ `TS2339`，必须先把实体收窄成 `kind === 'storey'` 才读得出 `projectId`；见上面 Step 2 代码第 352–354 行的形状）。**这句话对 renderer 有直接后果**：`storeyTabsOf` 要 `projectId`，而屏幕上唯一拿得到它的通路就是"当前层实体自己"，别指望从 `Document` 上问出"这个项目有哪几层"。

`packages/scene-2d/src/index.ts` 末尾追加一行：

```ts
export * from './panel';
```

- [ ] **Step 3: `planDelete` 从两条规则扩到四条**

`packages/scene-2d/src/editing.ts` 里改三处（`DeleteOutcome` 一字不动，四色还是那四色）：

1. `DeletePlan.unsupported` 的注释换成新语义：**别层构件 + 屏幕上取不到的 `storey` / `point`**，并写清"样例房里恒空"这句为什么仍然成立（那儿没有别层的东西被选中）。
2. 分派循环补 `column` / `slab` 两支，各自认层；文件顶部 import 补 `columnDelete`、`slabDelete`（`packages/core/src/index.ts` 对 `commands/*` 全是 `export *`，不需要改 core 的索引 —— T7 已核实）。
3. 命令数组与 `candidateIds` 的构造换成 P7 定死的四段顺序。

`packages/scene-2d/src/editing.ts`（改后的 `planDelete` 全文，逐字实测绿）：

```ts
/**
 * 删除的计划。四条出口，各有各的判据，**不许合并成"成功 / 失败"两色**：
 * 'empty' 与 'ignored-in-wall-mode' 都发 0 条命令，但前者该提示"没选中东西"、
 * 后者该什么都不做（拉墙时误触 Delete 不该清空选中集）—— 合并了屏幕上就分不开。
 */
export type DeleteOutcome = 'ok' | 'empty' | 'ignored-in-wall-mode' | 'unsupported';

export interface DeletePlan {
  readonly outcome: DeleteOutcome;
  /** 派发顺序 = 数组顺序：先洞口后墙（S5）。 */
  readonly commands: readonly Command[];
  /** `commands` 的 `type` 抄一份：探针与日志判"发了哪几条"用它，不用反射。 */
  readonly commandTypes: readonly string[];
  /** 真的发出命令的那些 id，与 `commands` 同序（洞口在前、墙在后，各自按 id 升序）。 */
  readonly candidateIds: readonly EntityId[];
  /**
   * 本次不删的 id：**别层构件**，加上屏幕上取不到的 `storey` / `point`（后两者的删除入口不是
   * Delete 键，理由写在 `planDelete` 最后那段注释里）。样例房里恒空 —— 那儿没有别层的东西被选中。
   */
  readonly unsupported: readonly EntityId[];
}

/**
 * 选中集 → 删除命令。**四条规则，一条都不复述真源已经做的事**：
 * ① 选中的墙 → `wall.delete`（它自己会级联收掉宿主是它的洞口、自己判端点还剩谁引用）；
 * ② 选中的洞口且**宿主墙不在本次删除集里** → `opening.delete`；
 * ③ 选中的柱 → `column.delete`（它自己收掉独占的落点，孤儿判定问 `pointStillReferenced`）；
 * ④ 选中的板 → `slab.delete`（同上，逐枚边界点各问一次）。
 *
 * 为什么反过来（先给每个选中洞口发 `opening.delete`、再删墙）也不行：那是对真源已有级联的
 * 复述，复述的规则一定会漂；而先删墙之后那些洞口已经不存在，第二条命令 `requireOpening`
 * 直接抛，`dispatchBatch` 就在半途留下半套状态。
 *
 * 顺序排成"洞口 → 柱 → 板 → 墙"是为了撤销的可读性：栈顶是 `wall.delete`，一次 Ctrl+Z 把
 * "墙 + 它自己级联掉的洞口"整组还原，而不是先还回一樘无主的洞口。柱与板排在墙**之前**：
 * 它们与墙共享端点时，先删板/柱会让那些点变成孤儿候选，而 `wallDelete` 的孤儿判定是事后问的，
 * 两个顺序都合法 —— 定死一个，撤销栈的形状才可预测（`--prop-shot` 里"删一根柱再撤销"那条判据读它）。
 *
 * **屏幕上今天还点不到柱与板**：`buildDrawList` 的指令表与 `pickAt` 的命中集都只认墙与洞口，
 * 所以 ③④ 两支的凭据只能是合成夹具（手工把柱/板的 id 放进选中集）。不许为了在屏幕上"证明它"
 * 就把柱画进指令表 —— 那是 Task 9 / 计划 4 的边界，混进来会让 `--draw-shot` 那 28 行像素判据全数重测。
 */
export function planDelete(
  doc: Document,
  storeyId: string,
  tool: Tool,
  ids: Iterable<EntityId>,
): DeletePlan {
  const all = [...ids];
  if (tool === 'wall') {
    return { outcome: 'ignored-in-wall-mode', commands: [], commandTypes: [], candidateIds: [], unsupported: [] };
  }
  const wallIds = new Set<EntityId>();
  const openingIds = new Set<EntityId>();
  const columnIds = new Set<EntityId>();
  const slabIds = new Set<EntityId>();
  const unsupported: EntityId[] = [];
  for (const id of all) {
    const entity = doc.get(id);
    // 已经不在了：两次渲染之间被撤销掉、或被同伴级联删掉。**一律不发命令也不进 unsupported** ——
    // 该管这件事的是 `pruneSelection`（屏幕上那一发本来就点不到它），在这里记账只会把
    // "选中集没剪干净"和"删除能力不够"混成同一条红。
    if (entity === undefined) continue;
    if (entity.kind === 'wall') {
      // 别层的墙不当"不支持"处理：它是"不该在这一层删的东西出现在了这一层的选中集"，
      // 那是选中集的问题（pruneSelection 的活），不是删除能力的问题。
      if (entity.storeyId !== storeyId) unsupported.push(id);
      else wallIds.add(id);
      continue;
    }
    if (entity.kind === 'opening') {
      if (entity.storeyId !== storeyId) unsupported.push(id);
      else openingIds.add(id);
      continue;
    }
    if (entity.kind === 'column') {
      if (entity.storeyId !== storeyId) unsupported.push(id);
      else columnIds.add(id);
      continue;
    }
    if (entity.kind === 'slab') {
      if (entity.storeyId !== storeyId) unsupported.push(id);
      else slabIds.add(id);
      continue;
    }
    // 剩下只有 `storey` 与 `point` 两种，而它们**不进删除集**：
    // 楼层实体没有 `storeyId`（它就是层本身），`pruneSelection` 一律剔掉，所以它进不到这里；
    // `storeyDelete` 的入口因此不是 Delete 键，而是楼层 tab 上那条显式动作（删整层 = 连带删光该层
    // 所有构件，需要确认框，S1 没有确认框）。点在屏幕上也不会命中楼层或裸点 —— 命中集只有墙与洞口。
    unsupported.push(id);
  }
  // 宿主墙要一起删的洞口不发第二条：wallDelete 的级联已经收了它。
  const solo = [...openingIds].filter((id) => {
    const opening = doc.get(id);
    if (opening?.kind !== 'opening') return false;
    return !wallIds.has(opening.hostWallId);
  });
  const sortedSolo = solo.sort();
  const sortedColumns = [...columnIds].sort();
  const sortedSlabs = [...slabIds].sort();
  const sortedWalls = [...wallIds].sort();
  const commands: Command[] = [
    ...sortedSolo.map((openingId) => openingDelete({ openingId })),
    ...sortedColumns.map((columnId) => columnDelete({ columnId })),
    ...sortedSlabs.map((slabId) => slabDelete({ slabId })),
    ...sortedWalls.map((wallId) => wallDelete({ wallId })),
  ];
  const candidateIds = [...sortedSolo, ...sortedColumns, ...sortedSlabs, ...sortedWalls];
  const outcome: DeleteOutcome =
    commands.length > 0 ? 'ok' : unsupported.length > 0 ? 'unsupported' : 'empty';
  return { outcome, commands, commandTypes: commands.map((c) => c.type), candidateIds, unsupported };
}
```

跟着改的测试（`editing.test.ts`，30 → 35 条）。两条既有的**改写**（不是删除）：

- 「三种沉默三种颜色」：原来 ② 那一格用"只剩一根柱"当 `unsupported` 的样例，现在柱删得掉了 ⇒ 样例换成**一枚裸点**（`wall.startId`，屏幕上根本不是一个命中目标），末尾加一发素材自证：同一根柱换到本层就发得出 `column.delete`，证上一发红在"它是点"，不红在"这层没东西可删"。
- 「别层构件进 unsupported」：原来只带墙与洞口两样，现在带三样（墙、洞口、**二层的一根柱**），并加反向自证 —— 同一枚柱换到它自己的层就发得出命令。这一发的夹具必须用 `new TransactionLog(house.doc)` 派生出的那份 `doc`（`dispatch` 换的是 log 自己那份引用，`house.doc` 不动），否则 `planDelete(house.doc, …)` 读不到那根柱，它会走 `entity === undefined` 那一支被**静默跳过**而不是进 `unsupported`。

三条**新增**：

```ts
  it('三种沉默三种颜色：拉墙模式 / 只剩裸点 / 空集', () => {
    const { log, storeyId } = oneWall();
    const wall = onlyWall(log);
    // Task 8 把柱与板接进 `planDelete` 之后，"只剩一根柱"不再是 unsupported 的样例 —— 它发得出
    // `column.delete`。这一格从此只装屏幕上根本取不到的两样东西：裸点与楼层本身。这里用裸点当靶子
    // （`wall.startId` 在屏幕上不是一个命中目标：`pickAt` 的命中集只有墙与洞口）。
    const bare = wall.startId;
    expect(log.document.get(bare)?.kind).toBe('point');
    // ① 拉墙时误触 Delete：什么都不发，但**不许**报"没选中东西"（选中集不该被清空）
    expect(planDelete(log.document, storeyId, 'wall', [wall.id, bare])).toEqual({
      outcome: 'ignored-in-wall-mode',
      commands: [],
      commandTypes: [],
      candidateIds: [],
      unsupported: [],
    });
    // ② 只选了一枚裸点：发不出命令，如实报 unsupported（Delete 键不是删点的入口）
    const only = planDelete(log.document, storeyId, 'select', [bare]);
    expect(only.outcome).toBe('unsupported');
    expect(only.commands).toHaveLength(0);
    expect(only.unsupported).toEqual([bare]);
    // ③ 什么都没选：'empty'，与 ② 不同色
    const none = planDelete(log.document, storeyId, 'select', []);
    expect(none.outcome).toBe('empty');
    expect(none.unsupported).toEqual([]);
    // 三色的存在性：写成布尔（"发没发命令"）就把 ①②③ 糊成一格
    expect(new Set(['ignored-in-wall-mode', only.outcome, none.outcome]).size).toBe(3);
    // 混选：裸点 + 墙 ⇒ 墙照删，点进 unsupported（不是"整批不做"）
    const mixed = planDelete(log.document, storeyId, 'select', [bare, wall.id]);
    expect(mixed.outcome).toBe('ok');
    expect(mixed.commandTypes).toEqual(['wall.delete']);
    expect(mixed.unsupported).toEqual([bare]);
    // 素材自证：同一根柱换到本层就发得出命令 ⇒ 上面那发红在"它是点"，不红在"这层没东西可删"
    log.dispatch(columnCreate({ storeyId, at: { x: 500, y: 500 }, widthMm: 400, depthMm: 400 }));
    const columnId = kindId(log, 'column');
    expect(planDelete(log.document, storeyId, 'select', [columnId]).outcome).toBe('ok');
  });

  it('别层构件进 unsupported，不是"没选中"：本层没这个权力（墙、洞口、柱三样一起判）', () => {
    const log = new TransactionLog(house.doc);
    log.dispatch(
      columnCreate({ storeyId: house.upperStoreyId, at: { x: 100, y: 100 }, widthMm: 400, depthMm: 400 }),
    );
    const doc = log.document;
    const upper = upperWalls[0]!;
    const upperOpening = doc.byKind('opening').find((o) => o.storeyId === house.upperStoreyId);
    if (upperOpening === undefined) throw new TypeError('样例房二层应当有洞口');
    const upperColumn = kindId(log, 'column');
    const plan = planDelete(doc, house.lowerStoreyId, 'select', [upper.id, upperOpening.id, upperColumn]);
    expect(plan.outcome).toBe('unsupported');
    expect(plan.commands).toHaveLength(0); // 一发都不许发：删二层的构件不在本层的权力里
    expect(plan.candidateIds).toEqual([]);
    expect([...plan.unsupported].sort()).toEqual([upper.id, upperOpening.id, upperColumn].sort());
    // 素材自证：同一枚柱换到它自己的层就发得出命令 ⇒ 上一发红在认层，不红在"柱删不掉"
    const same = planDelete(doc, house.upperStoreyId, 'select', [upperColumn]);
    expect(same.outcome).toBe('ok');
    expect(same.commandTypes).toEqual(['column.delete']);
  });

  it('③④ 接上屏幕：四类混选发四条，顺序定死成 洞口 → 柱 → 板 → 墙', () => {
    const { log, storeyId } = synthStorey();
    const host = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const other = wallAt(log, storeyId, { x: 0, y: 2000 }, { x: 4000, y: 2000 });
    const openingId = openingAt(log, host.id, 1200); // 宿主是 host，而 host **不**进本次删除集 ⇒ 它得自己发一条
    log.dispatch(columnCreate({ storeyId, at: { x: 500, y: 500 }, widthMm: 400, depthMm: 400 }));
    const columnId = kindId(log, 'column');
    log.dispatch(
      slabCreate({
        storeyId,
        boundary: [
          { x: 0, y: 4000 },
          { x: 4000, y: 4000 },
          { x: 4000, y: 6000 },
          { x: 0, y: 6000 },
        ],
        thicknessMm: 120,
      }),
    );
    const slabId = kindId(log, 'slab');
    const other2 = wallAt(log, storeyId, { x: 0, y: 8000 }, { x: 4000, y: 8000 });
    // 同类多枚时**输入故意降序**：只有一枚墙的夹具测不出 sort（实测摘掉四处 sort 全绿，
    // 因为单元素数组排不排都一样）。降序进、升序出才是这道 sort 的牙齿。
    const wallsDesc = [other.id, other2.id].sort().reverse();
    // 传入顺序故意打乱：判的是"输出顺序由规则定死"，不是"跟着选中集走"
    const plan = planDelete(log.document, storeyId, 'select', [slabId, ...wallsDesc, openingId, columnId]);
    expect(plan.outcome).toBe('ok');
    expect(plan.commandTypes).toEqual([
      'opening.delete',
      'column.delete',
      'slab.delete',
      'wall.delete',
      'wall.delete',
    ]);
    expect(plan.candidateIds).toEqual([openingId, columnId, slabId, ...[other.id, other2.id].sort()]);
    // 判据的牙齿：栈顶必须是 wall.delete。摘掉四处 sort（按集合插入序发）这一发就红，
    // 于是撤销一次还回来的不是"墙 + 它级联掉的洞口"整组，而是一樘无主的洞口。
    const tx = new TransactionLog(log.document);
    for (const command of plan.commands) tx.dispatch(command);
    expect(tx.depth).toBe(5);
    expect(tx.document.get(host.id)?.kind).toBe('wall'); // host 没被选中，它和它的洞口都该还在
    expect(tx.document.get(openingId)).toBeUndefined();
    expect(tx.document.get(columnId)).toBeUndefined();
    expect(tx.document.get(slabId)).toBeUndefined();
    expect(tx.document.get(other.id)).toBeUndefined();
    expect(tx.document.get(other2.id)).toBeUndefined();
    // 撤销栈顶那一条：最后删的那面墙回来了，其余四条各占一格 ⇒ 一次 Ctrl+Z 只回来一面墙
    const undone = wallsDesc[0]!;
    tx.undo();
    expect(tx.document.get(undone)?.kind).toBe('wall');
    expect(tx.document.get(slabId)).toBeUndefined();
  });

  it('柱落在墙端点上：删柱只删柱，那枚点还被墙引用 ⇒ 不许跟着走（删柱拆墙）', () => {
    const { log, storeyId } = oneWall();
    const wall = onlyWall(log);
    // 复用墙起点当柱心：这是 S1 里柱最常见的形态（柱在墙角）
    log.dispatch(columnCreate({ storeyId, at: { pointId: wall.startId }, widthMm: 400, depthMm: 400 }));
    const columnId = kindId(log, 'column');
    const pointsBefore = log.document.byKind('point').length;
    const plan = planDelete(log.document, storeyId, 'select', [columnId]);
    for (const command of plan.commands) log.dispatch(command);
    expect(log.document.get(columnId)).toBeUndefined();
    expect(log.document.byKind('point').length).toBe(pointsBefore); // 一根点都不许少
    expect(requirePoint(log.document, wall.startId, '墙起点').storeyId).toBe(storeyId);
    // 反向自证：同一根柱换成独占落点，那枚点就跟着走 —— 区别只在"还有谁引用它"
    const solo = new TransactionLog(log.document);
    solo.dispatch(columnCreate({ storeyId, at: { x: 900, y: 900 }, widthMm: 400, depthMm: 400 }));
    const soloId = kindId(solo, 'column');
    const soloPoint = (solo.document.get(soloId) as { pointId: string }).pointId;
    const before = solo.document.byKind('point').length;
    for (const command of planDelete(solo.document, storeyId, 'select', [soloId]).commands) {
      solo.dispatch(command);
    }
    expect(solo.document.byKind('point').length).toBe(before - 1);
    expect(solo.document.get(soloPoint)).toBeUndefined();
  });

  it('删一根带独占落点的柱：pruneSelection 把柱与孤儿点一起剔掉', () => {
    const { log, storeyId } = oneWall();
    const wall = onlyWall(log);
    log.dispatch(columnCreate({ storeyId, at: { x: 500, y: 500 }, widthMm: 400, depthMm: 400 }));
    const columnId = kindId(log, 'column');
    const columnPoint = (log.document.get(columnId) as { pointId: string }).pointId;
    const selected = [columnId, columnPoint, wall.id];
    const plan = planDelete(log.document, storeyId, 'select', [columnId]);
    for (const command of plan.commands) log.dispatch(command);
    expect(log.document.get(columnId)).toBeUndefined();
    expect(log.document.get(columnPoint)).toBeUndefined(); // 级联收的，不是 UI 发的
    // 柱与它的点都不在选中集里了，而墙还在 —— 这一发的凭据是"问真源"，不是 UI 自己抄一份孤儿判定
    expect(pruneSelection(log.document, storeyId, selected)).toEqual([wall.id]);
  });

```

Run: `npx vitest run --config .tscheck/t9/vitest.config.ts packages/scene-2d/test/editing.test.ts`
Expected: **33 passed**（30 + 3）。这一步的测试夹具之外还要在文件里落一个助手 `kindId(log, 'column' | 'slab')`（从上一次派发的 `affected` 里挑该 kind 的 id）—— P9 那句"合成夹具"的具体形状就是它。

- [ ] **Step 4: 两枚确定性夹具（T6 交接 ② 的落地）**

T6 留下的问题是：`--draw-shot` 与「六道筛逐条自证」读的靶子会**跨进程漂**（`snapFieldOf` 的端点表来自 `doc.byKind('wall')` 的 id 升序，uuidv7 同毫秒不单调），所以既有的筛 ⑤ / ⑥ 用例只能说"给不给得出"，不能说"给的是哪一发"。这一步补两枚**不吃枚举顺序**的夹具。

筛 ⑤ 那枚的构造是**算出来的**，不是试出来的：`pxPerMm = 0.2`、`640×800`、`center = (3500, 1000)` ⇒ 可见区 x `∈ [1900, 5100]`、y `∈ [-1000, 3000]`。墙 `(0,0)→(4000,0)` 的两个端点因此一内一外：外那个（A）的 `startPx` 越界，它十发候选**全部**被 ⑤ 拒（`insideCanvas` 连 `startPx` 一起判）；内那个（B）的十发里 `E=(6000,0)` 越右界、`S=(4000,-2000)` 越下界、`W=(2000,0)` 压在既有墙上（筛 ④），只剩 `N=(4000,2000)`。于是无论哪一端先被枚举，能交靶子的只有 B，答案恒为 `(4000,0)→(4000,2000)`。

```ts
  it('筛 ⑤ 的确定性夹具：两个端点绕不开同一发 —— 画布外那一发只由 ⑤ 拒', () => {
    // 上一发判的是"越界会让探针没靶子"，但它读的是样例房，而样例房里**哪个端点先被枚举**随
    // uuidv7 变，所以它只能说"给不给得出"，不能说"给的是哪一发"。Task 8 要把 ⑤ 钉成可复算的账，
    // 于是这里换一份一面墙的合成现场：把画布摆到只有 (4000,0) 那端在界内（另一端 (0,0) 的
    // startPx 就越界 ⇒ 它的十个候选全被 ⑤ 拒），于是无论枚举顺序如何，答案只能是同一发。
    // 视口尺寸 / 中心是算出来的不是试出来的：pxPerMm=0.2、640×800 ⇒ x 可见 [1900, 5100]、
    // y 可见 [-1000, 3000]。于是 (4000,0) 的候选里 E=(6000,0) 越右界、S=(4000,-2000) 越下界、
    // W=(2000,0) 压在既有墙上（筛 ④），只剩 N=(4000,2000)。
    const { log, storeyId } = synthStorey();
    const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const v = viewportOf(640, 800, { pxPerMm: 0.2, center: vec(3500, 1000) });
    const doc = log.document;
    const vOps = buildDrawList(doc, storeyId, v, EMPTY_SELECTION);
    // 素材自证（三发都在界外/界内的哪一侧，先钉死，才许说"答案唯一"）
    expect(mmToPx(v, vec(0, 0)).x).toBeLessThan(2); // A 端整个在画布左外 ⇒ 它的候选全交不出靶子
    expect(insidePx(v, intPxOf(mmToPx(v, vec(4000, 0))))).toBe(true); // B 端在界内
    const eastOff = intPxOf(mmToPx(v, vec(6000, 0)));
    expect(eastOff.x).toBeGreaterThanOrEqual(v.widthPx - 2); // E 候选越右界
    expect(pickAt(vOps, eastOff)).toEqual([]); // ……而筛 ④ 放行它 ⇒ 拒它的只有 ⑤
    expect(snapFieldOf(doc, storeyId).points.length).toBeGreaterThan(0);
    const probe = wallProbe(doc, storeyId, vOps, v);
    if (probe === null) throw new TypeError('这个夹具上探针该给得出靶子');
    // 判据的牙齿（2026-09-28 实测）：摘掉 ⑤ 那一发不是"探针没靶子"，而是**换了一发挑不中 DIP 的**
    // —— 答案改挑 (0,0) 那端（它的 startPx 在画布左外），四个独立进程都红在这里。
    // 而"答案只能是 B 端那一发"这件事本身是确定性的：A 端十个候选全被 ⑤ 拒（startPx 越界与候选无关），
    // 所以无论 uuidv7 让哪一端先被枚举，能交靶子的只有 B。
    expect(probe.startMm).toEqual({ x: 4000, y: 0 });
    expect(probe.startPointId).toBe(wall.endId);
    expect(probe.endMm).toEqual({ x: 4000, y: 2000 });
    expect(insidePx(v, probe.endPx)).toBe(true);
    expect(insidePx(v, probe.midPx)).toBe(true);
  });

```

⑥ 那枚不读探针，读**两层同判**：过 `(0,0)` 先架两条线（x 轴与 y 轴），再把周围八发候选逐发问一遍 `legalWallCreate` 与"真建一遍 + 整层派生"，要求八对逐字相同、四发斜线两层一起拒、且八发里确有放行的（否则"同判"可以靠"全拒"糊过去）。

```ts
  it('⑥ 的确定性夹具：八发候选在命令层与派生层判得一字一样', () => {
    // 上一发只钉了 45° 那一发。Task 8 把属性面板接上屏之后，"屏幕上拒过一次"就不再是孤例，
    // 于是这里把 (0,0) 这个三臂点周围的**八发**候选全问一遍，判的是两层**逐发同判**：
    // 摘掉 core 的 `assertDerivesAfterApply` ⇒ 四发斜线在命令层翻成放行、派生层仍然抛 ⇒ 本条红。
    // 这一条不读探针挑了谁，所以它不受 uuidv7 影响 —— 这就是"确定性夹具"四个字的含义。
    const { log, storeyId } = synthStorey();
    const east = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    wallAt(log, storeyId, { pointId: east.startId }, { x: 0, y: 4000 });
    const doc = log.document;
    const fd = snapFieldOf(doc, storeyId);
    const defaults = newWallDefaults(doc, storeyId);
    const startMm: MoveTarget = { x: 0, y: 0 };
    const start = draftAtPress(sv, pxOf(startMm, sv), fd);
    expect(start.snap?.kind).toBe('endpoint'); // 素材自证：起点真的压在三臂点上，否则八发都在别处
    const rows = [
      { x: 2000, y: 0 },
      { x: 0, y: 2000 },
      { x: -2000, y: 0 },
      { x: 0, y: -2000 },
      { x: 2000, y: 2000 },
      { x: -2000, y: 2000 },
      { x: 2000, y: -2000 },
      { x: -2000, y: -2000 },
    ].map((off) => {
      const endPx = pxOf(off, sv);
      const end = dropTargetOf(sv, endPx, startMm, fd, { excludeMm: startMm });
      const draft: DraftWall = { storeyId, start, cursorPx: endPx, end, legal: true };
      const command = legalWallCreate(doc, draft);
      let derived: boolean;
      try {
        const commandBuilt = draftCommand(draft, defaults);
        if (commandBuilt === null) throw new TypeError('legal 为真却拿不到命令');
        const trial = new TransactionLog(doc);
        trial.dispatch(commandBuilt);
        buildDrawList(trial.document, storeyId, sv);
        derived = true;
      } catch {
        derived = false;
      }
      return { mm: end.mm, command, derived };
    });
    for (const row of rows) expect(row.derived).toBe(row.command);
    // 四发斜线（过同一枚点的第三个方向）两层一起拒：这就是星形接头搬迁后的形状
    for (const row of rows.filter((r) => Math.abs(r.mm.x) === Math.abs(r.mm.y))) {
      expect(row.command).toBe(false);
    }
    // 判据不空转：八发里确实有放行的（四条轴向外侧），否则"同判"可以靠"全拒"糊过去
    expect(rows.filter((r) => r.command).length).toBeGreaterThan(0);
  });

```

Run: 同上
Expected: **35 passed**。

- [ ] **Step 5: 四处注释订正 + 全量验证**

`T7` 在 Task 6/7 编写期是"下一个任务"的代称，T7 落地之后它成了谎话，逐条改名（只动注释，不动逻辑）：

| 位置 | 原文说 | 改成 |
| --- | --- | --- |
| `editing.ts` 的 `NEW_WALL_THICKNESS_MM` | "T7 的数值输入替换它" | "Task 8 的数值输入替换它"（**本任务没替换它**：面板改的是既有墙的厚度，新建墙那一路仍然吃常量，理由见 Step 7 的边界段） |
| `editing.ts` 的 `MIN_WALL_LENGTH_MM` | "T7 的『数值输入 + 最小墙长』才把这条下限搬到交互路径上" | "Task 8 落地时也没有搬到输入框上 —— 它到今天仍只作用于探针"（P5 实测背书） |
| `editing.ts` 的 `derivesCleanly` 那段"星形接头在屏幕上的缺口原样登记给 T7" | "登记给下一个任务" | 已兑现：`assertDerivesAfterApply` 在 `wallCreate.build` 末尾，`legalWallCreate` 试跑的就是 `build` ⇒ 用户手拉那一发现在也在**松手前**被拒 |
| `editing.ts` / `panel.ts` 里剩下的 `T7` 与 `Task 7` | 混写 | 一律 `Task 7`，且只用于**已经发生**的事（"Task 7 把派生复核挂上 build 之后"），不再当"将来"用 |

`panel.ts` 里"十轮打乱里有六轮 id 序与 index 序不同"那句注释按实测改成**至少五轮 + 实测分布 9、8、9、8、7、9**（编写期先写的"六轮"是猜的，实测六次独立进程没有一次正好是 6；下限留 5 是给抖动留余量）。

Run: `npx vitest run --config .tscheck/t9/vitest.config.ts`，然后 `npx tsc --noEmit -p .tscheck/t9/tsconfig.scene2d.json`
Expected: **31 文件 / 449 条全绿**（core 24/309 一字未动 + scene-2d 7/140：viewport 9、drawlist 10、pick 18、snapping 28、editing 35、handles 19、panel 21）；`tsc` 无输出。**这两个数是本任务 node 侧的终点账**，Step 6 的九条变异与 Step 8 的回填都从它出发。

- [ ] **Step 6: 改坏验证（九条变异，逐条记下红的是哪几条）**

每条 = 摘掉一处实现 → 跑全量 → 记红名 → 还原。命令形状（在临时工程根上跑，`<file>` 与模式见每条）：

```bash
cp packages/scene-2d/src/panel.ts /tmp/panel.bak
perl -0pi -e 's/\.sort\(\(a, b\) => a\.index - b\.index\)/.slice()/' packages/scene-2d/src/panel.ts
npx vitest run --config vitest.config.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "^ +Tests |× "
cp /tmp/panel.bak packages/scene-2d/src/panel.ts
```

（那句 `sed 's/\x1b\[[0-9;]*m//g'` **不是装饰**：命令替换里 vitest 仍吐 ANSI 序列，第一次跑这张表时有八行被读成"无统计行"，差点记成"摘掉实现全绿"。剥色之后九条全部有红。）

| # | 摘掉什么 | 实测红 | 红的是哪几条（逐字用例名） |
| --- | --- | --- | --- |
| M1 | `storeyTabsOf` 的 `.sort` 换成 `.slice()`（照抄 `byKind`） | 1 / 448 | 「顺序按 index 而不是按 id：十轮打乱里至少五轮 id 序与 index 序不同（摘掉 sort 的凭据）」 |
| M2 | `selectedWallForPanel` 改"取第一面"（`picked.length === 1 ? … : null` → `picked[0] ?? null`） | 1 / 448 | 「两面墙一起选中 ⇒ null：面板不许"取第一面"，那等于偷偷改用户的选中集」 |
| M3 | `trialCommand` 摘掉整段试跑（恒返回 `ok: true`） | 5 / 444 | 「命令工厂里那半道门也在 try 内：非整数毫米给文案，不给未捕获异常」「真源三道门各一句文案：非正、墙厚不小于轴长、墙不存在」「T 接改厚被派生复核挡下：命令层三道门全过，拒它的是『直通两墙厚度不同』」「两侧逐条连发改不动 T 接：每条各自复核自己那一发之后的世界」「试跑不动真源：墙数、那面墙的厚度、撤销栈深度三票原样」 |
| M4 | `planDelete` 摘柱那一支（柱重新落进 `unsupported`） | 5 / 444 | 「③④ 接上屏幕：四类混选发四条，顺序定死成 洞口 → 柱 → 板 → 墙」「三种沉默三种颜色：拉墙模式 / 只剩裸点 / 空集」「删一根带独占落点的柱：pruneSelection 把柱与孤儿点一起剔掉」「别层构件进 unsupported，不是"没选中"：本层没这个权力（墙、洞口、柱三样一起判）」「柱落在墙端点上：删柱只删柱，那枚点还被墙引用 ⇒ 不许跟着走（删柱拆墙）」 |
| M5 | `planDelete` 摘板那一支 | 1 / 448 | 「③④ 接上屏幕：四类混选发四条，顺序定死成 洞口 → 柱 → 板 → 墙」 |
| M6 | `planDelete` 摘掉四处 `.sort()`（改回集合插入序） | 1 / 448 | 「③④ 接上屏幕：四类混选发四条，顺序定死成 洞口 → 柱 → 板 → 墙」 |
| M7 | `wallProbe` 摘掉筛 ⑤（`insideCanvas` 那一行） | 5 / 444 | 「wallProbe 在样例房里给得出靶子，六道筛逐条自证，且两次问逐字相同」「筛 ② 有牙齿：画布夹住的靶场里，唯一活着的候选引的是别人的点」「筛 ④ 有牙齿：画布夹住的靶场里，唯一活着的候选中点压在横墙上」「筛 ⑤ 有牙齿：整层挪出画布后探针没靶子，回到拟合视图靶子就出现」「筛 ⑤ 的确定性夹具：两个端点绕不开同一发 —— 画布外那一发只由 ⑤ 拒」 |
| M8 | core 的 `wallCreate.build` 末尾摘掉 `assertDerivesAfterApply`（只摘 `wallCreate` 那一处） | 5 / 444 | 「⑥ 的前提：同一发候选在命令层与派生层一起拒（星形接头）」「⑥ 的确定性夹具：八发候选在命令层与派生层判得一字一样」「三面墙过同一点、三个方向 → 命令层就抛 /star/，文档与撤销栈都不动」「同一点同向两笔 → 抛 /同向重叠/（重叠墙带进不了真源）」「复核吃的是**整份文档**：别层藏一颗星，本层也写不进墙」 |
| M9 | `planDelete` 摘掉墙那一支的认层（`storeyId !== storeyId` 不再进 `unsupported`） | 1 / 448 | 「别层构件进 unsupported，不是"没选中"：本层没这个权力（墙、洞口、柱三样一起判）」 |

**这张表本来差点写错两次**（都是当场实测揪出来的，记在这里防执行日再犯）：

1. **M6 第一次跑是全绿**。四类混选那枚夹具每种 kind 只放了一枚构件，而 `sort` 只决定**同 kind 之内**的顺序 ⇒ 单元素数组排不排都一样，那句"摘掉排序这一发就红"是我凭空写的。修法不是放宽判据，而是给夹具补第二面墙、并把输入按 id **降序**喂进去（"降序进、升序出"才是这道 sort 的牙齿）—— 改完 M6 红 1 条。
2. **M7 的红形与我预言的不同**。我写的是"摘掉 ⑤ ⇒ 答案换成 `(4000,0)→(6000,0)`"，实测四个独立进程给的都是 `(0,0)→(0,2000)` —— 摘掉 ⑤ 之后**外端 A 也能交靶子了**，而它排在前面。结论照实测写（见 Step 4 那段注释），别照预言写。

- [ ] **Step 7: renderer 接线 —— 楼层 tab、属性面板、以及"屏幕只问真源"这条纪律落到 DOM 上**

> **这一步以下全部是编写期-authored 的代码，编写期跑不了**：此刻 `apps/desktop/src/renderer/src/App.tsx` 还是"pong:1"占屏页，`apps/desktop/src/main/index.ts` 40 行里一句 shot 都没有（2026-09-28 核对）。所以本步与 Task 3~6 的 renderer 步骤同一口径：**判据形状写死，字面量执行日回填**。落地时若与本步给的形状冲突，以测到的为准，并把冲突记进"已核实的现状事实"，别把判据放宽。

先补三条只有接上屏才会浮出来的裁决：

| # | 问题 | 裁决 | 为什么 |
| --- | --- | --- | --- |
| P10 | 切层要不要顺手复位视口？分几次 `set`？ | **一次 `set` 同时换 `storeyId` 与 `viewport`**：`setStorey(storeyId: string, viewport: Viewport)`，视口由调用方（`PlanCanvas`，它才量得到画布尺寸）用 `fitStorey(doc, 新层, widthPx, heightPx, PAD)` 算好递进来。同一次调用里顺手 `setDraft(null)`、`setTool('select')`，并由调用方清选中集。 | 分两次 `set`（先换层、下一帧再复位视口）会留一个**中间帧**：新一层的图配旧一层的 `origin`，画在画布外，`--prop-shot` 的采样如果落在那一帧上，红形是"pxPerMm 对不上"这种谁也看不懂的话。代价：`storeyId` 的变更入口从"随便谁 `set`"收成一个函数，以后 Task 9 想加"滚轮切层"必须走同一个出口 —— 这正是想要的约束。 |
| P11 | 厚度输入框是逐字符提交吗？ | **不是**。`onChange` 只更新本地态并现问一次 `trialCommand`（给红字），**提交只发生在 Enter 与 blur**。 | 打 `370` 这三个字符要经过 `3` 和 `37` —— 两个都是合法厚度，逐字符 dispatch 会往撤销栈上留三条记录，Ctrl+Z 要按三下才回得来，而且每一下都会跑整层派生复核。代价：粘贴完不回车直接点画布，靠 blur 兜住；若两条都没兜住（用户按 Esc 关掉面板），本地态丢掉、真源不动，这是**对的方向**（屏幕没说谎）。 |
| P12 | 值没变要不要发命令？ | **不发**。面板比较"要写的值"与 `wallPropsOf` 刚读出来的值，相同就一行都不发。 | 真源**允许**同值重设并各留一条撤销记录（实测：`panel.test.ts`「承重与材料不进派生：同值反复点各留一条撤销记录」—— 承重连点两次拿到两条记录）。屏幕上不挡就等于把"改了什么"的账交给撤销栈去背，而 `--prop-shot` 的 depth 判据立刻分不清"改过"与"摸过"。代价：这与真源口径**故意不同**（屏幕比真源严），注释必须写清这条不是 bug —— 未来若 core 自己挡同值，这一支要跟着删，别留成第二道守卫。 |

**`stores/editorStore.ts`**（在 T6 那份之上加一格一出口，其余一字不动）：

```ts
export interface EditorState {
  // ……T3~T6 的字段原样：log / storeyId / viewport / revision / lastError / drag / tool / draft
  /** P10：换层与视口复位必须是同一次 `set`。调用方负责清选中集（store 不碰 selectionStore）。 */
  setStorey: (storeyId: string, viewport: Viewport) => void;
}

// create：
  setStorey: (storeyId, viewport) =>
    set({ storeyId, viewport, draft: null, tool: 'select', revision: get().revision + 1 }),
```

`revision` 在这里 +1 是**故意**的：面板与 tab 都读 `revision` 决定重算（`storeyTabsOf` 与 `wallPropsOf` 都吃文档，切层后文档没变但"当前层"变了，不扳一次就会留着上一层的三格读数）。这条与 T5 那句"`revision` 只在成功之后 +1"不冲突 —— 切层不是真源编辑，它是视图状态，而这一格扳的是"派生读数该重算了"。

**`apps/desktop/src/renderer/src/panels.tsx`（新建，tab 条 + 属性面板都在这儿）**：

```tsx
import {
  PANEL_MATERIAL_OPTIONS,
  fitStorey,
  selectedWallForPanel,
  storeyTabsOf,
  trialCommand,
  wallPropsOf,
  type StoreyTab,
  type WallProps,
} from '@dajia/scene-2d';
import {
  wallSetLoadBearing,
  wallSetMaterial,
  wallSetThickness,
  type Document,
  type EntityId,
} from '@dajia/core';
```

（`fitStorey` 从 `@dajia/scene-2d` 拿而不是在这儿现算：全局约束那句"renderer 一行几何都不许算"。`panels.tsx` 是 T3 之后第一个新增的 renderer 组件文件，`check-package-deps.mjs` 的 `ALLOWED_DEPS` 早就放行了 `desktop → core, protocol, scene-2d`，不必再改守卫脚本。）

面板组件的三条纪律：

```tsx
/**
 * 当前层实体是唯一能读出 `projectId` 的把手（`Entity` 联合上它不是共有字段，
 * 必须先收窄成 `kind === 'storey'` —— 2026-09-28 写 `panel.test.ts` 时踩过这条 TS2339）。
 * 收窄不到就返回空 tab 列表：屏幕上"一层都没有"是文档坏了，不是面板该抛错的地方。
 */
function tabsFor(doc: Document, storeyId: string): StoreyTab[] {
  const current = doc.get(storeyId);
  if (current?.kind !== 'storey') return [];
  return storeyTabsOf(doc, current.projectId);
}
```

- **属性面板整体只读 `wallPropsOf`**，本地不留三份状态。唯一允许存在的本地态是"输入框里正在打的那串字"与它的 `TrialResult`（P11），而且它**必须**在提交成功、`revision` 变化、或选中集变化时被丢掉 —— 否则屏幕上是对的、真源是错的。
- **`reason` 直接显示真源那句**，不翻译、不截断、不换成"输入无效"。T 接那一发的完整文案是「接头 … 的直通两墙厚度不同（370 / 240），S1 的 T 接与十字要求直通两墙同厚：请统一墙厚，或把它改画成 L 角」—— 后半句"改画成 L 角"是用户唯一能自己走通的路，翻译一次就丢了。
- **提交走 `dispatch`（单条）不走 `dispatchBatch`**：面板一次只改一格的值。`dispatchBatch` 留给 Delete 那条多命令通路（T6）。

**`PlanCanvas.tsx`** 补四件事：

1. tab 条的点击出口：`const fitted = fitStorey(log.document, tab.storeyId, widthPx, heightPx, VIEW_PAD_PX); setStorey(tab.storeyId, fitted); useSelection.getState().clear();`
2. 快捷键 `Delete` / `Backspace` 那一路**一行不改**（T6 已经接的是 `planDelete`，本任务改的是它内部）。要改的只有注释里那句"柱与板留给 Task 8"。
3. `DebugReport` 补五个字段（与 T4/T5/T6 那三批同一形状，诊断值住 ref 不进 `paint` 依赖）：

```ts
interface DebugReport {
  // ……T3~T6 的字段原样
  /** 当前层的 tab 列表（顺序、标签、标高全部来自 `storeyTabsOf`，renderer 不自己排）。 */
  storeyTabs: StoreyTab[];
  /** `selectedWallForPanel` 的答案；null = 面板不渲染。 */
  panelWallId: EntityId | null;
  /** 面板三格读数 + 轴长；null 同上。 */
  panelProps: WallProps | null;
  /** 最近一次输入框预言：`{ kind, input, ok, reason }`。`--prop-shot` 的红字判据读它。 */
  lastTrial: PanelTrialReport | null;
  /** 最近一次成功提交后的**真源**读数（不是输入框的值）：证"面板读真源"。 */
  propsAfterEdit: WallProps | null;
}
```

4. **像素计数**：材料那一发提交前后各读一次 `ops` 与各层颜色桶计数，必须逐字相同 —— 这是 P4「材料不进派生」在屏幕上的唯一凭据（node 侧 `panel.test.ts` 只能证到 `wall.setMaterial` 不跑复核，证不到"画面上一个字都没变"）。

**`main/index.ts` 的 `runPropShot`**：`argPath('--prop-shot')`、`whenLoaded` / `waitForDebug` / `focusForInput` / `pressPx` / `movePx` / `keyCombo` / `readReport` 六个助手沿用 T3~T6 那一份，一步都不许新写。十六步（坐标一个都不硬编码：tab 的中心由 `executeJavaScript` 问 DOM 的 `getBoundingClientRect()` 拿，墙与洞口的像素来自 `pickPxOf` 同一条探针通路）：

| 步 | 动作 | 判据（红形必须指向的那件事） |
| --- | --- | --- |
| 0 | 起始读数 | `storeyTabs.length === 2`、当前层是 `index 0` 那格、`panelWallId === null`、`tool === 'select'`、`depth` / 点数留档当基线 |
| 1 | 鼠标点二层 tab | `storeyId` 换、`pxPerMm` 与 `origin` **逐字等于**同一次调用里算出的 `fitStorey(二层)`、`selectedIds` 空、`panelWallId` null、`depth` 与基线相同（P10：切层不许动真源） |
| 2 | 点回一层 | 视口两份值逐字回到第 0 步那一份（证 P6 的 tab 与 P10 的复位都可逆） |
| 3 | 点一面**改得动**的墙 | `panelWallId` = 它、三格读数 = 真源、`axisLengthMm` = `wallAxisById` 的轴长（靶子从 P8 的 B 组表里选：`west` / `north` / `east` / `stem` 四面之一，**不许**选 `southWest` / `southEast` / `partWest` / `partEast`） |
| 4 | 厚度框打 `240.5`，不回车 | `lastTrial.ok === false`、`reason` 含「必须是整数毫米」（P2 工厂那一半）、`depth` = 基线、真源厚度未变 |
| 5 | 改成合法值（如 `300`）后 Enter | `lastTrial.ok === true`、`depth` = 基线 + 1、`propsAfterEdit.thicknessMm === 300`、`panelProps` 与真源逐字相同 |
| 6 | 同值再 blur 一次（框里还是 `300`） | `depth` **不变**（P12） |
| 7 | Ctrl+Z | `depth` 回基线、`panelProps.thicknessMm` 回原值（证面板读的是真源而不是本地态） |
| 8 | 材料下拉选 `concrete` | `depth` +1、真源 `material === 'concrete'`、**像素计数与 ops 条数逐字等于第 3 步**（P4） |
| 9 | 承重开关点一下 | `depth` +1、真源 `loadBearing` 翻转、`panelProps.loadBearing` 跟着翻 |
| 10 | Ctrl+Z 三次 | 三格读数逐字回到第 3 步那一份（P11 的"一次编辑一条记录"在这里被数出来：恰好三下，不是四下也不是两下） |
| 11 | 点墙 + Shift 点它身上的洞口（多选） | `panelWallId === null`（P3 在屏幕上的形状：面板整块消失，而不是显示"第一面"） |
| 12 | Delete | `depth` +1（**只加一**：级联由真源做，复述就变成 +2）、`deletedIds` 只有那面墙、`selectionAfterDelete` 空、`unsupportedIds` 空 |
| 13 | Ctrl+Z | 墙与洞口都回来；`selectedIds` **仍为空** —— 这是 T6 交接里那句"撤销的是文档，不是视图"（D7）第一次被真窗口钉成预期行为，判据照实写死"不回"，不许改成"应当回" |
| 14 | 连点两次 tab 切换 | 两次的 `storeyTabs` 读数逐字相同（P6：顺序不随进程漂） |
| 15 | 终态 | `depth` = 基线、点数 = 基线、`panelWallId === null`、`tool === 'select'`、`storeyId` = 一层 |

第 12 步那句 `unsupportedIds` 为空**必须**同时读 `storeyTabs.length === 2` 当素材自证：样例房无柱无板（T5 已核实），所以这一发证明的是"屏幕上取不到柱板时 `unsupported` 就该空"，它**不能**被当成 P7 那两支的验收 —— 那两支只有 M4 / M5 的红绿可看（P9）。

- [ ] **Step 8: 落回真仓库、四个闸门重跑、提交**

```bash
# 1) 把临时工程里实测过的 scene-2d 三个文件与两份测试逐字搬回真仓库
#    （panel.ts / panel.test.ts 新建；editing.ts / editing.test.ts / index.ts 覆盖）
npx tsc --noEmit -p packages/scene-2d/tsconfig.json   # 真仓库的 typecheck 脚本按 Task 1 改后的口径走
pnpm verify
```

Expected: `pnpm verify` exit=0；`Tests` 从 Task 7 落地的 **438** 涨到 **464**（净增 26 = panel 21 + editing 5），`Test Files` 由执行日回填（本任务只新增一个测试文件 `panel.test.ts`）。core 的 `24 文件 / 309 条` **一字不动** —— 若这一步发现还要改 core，按边界段那条纪律：回 Task 7，不在这里补。

```bash
# 2) 临时工程那九条变异，在真仓库原样复跑一遍（同九条命令、同一份剥色管道）
# 3) 四个闸门各跑一遍
pnpm shot        # 6 条（实测）
pnpm pick-shot   # 11 条（实测；编写期写 10）
pnpm edit-shot   # 21 条（实测）
pnpm draw-shot   # 28 条（实测）
pnpm prop-shot   # 29 条（实测 = 共用那 6 条 + 本任务新增 23 条；编写期留空）
```

Expected: 前三个闸门**逐字不变**（本任务没碰它们的通路：`planDelete` 的两条既有规则一字未动，`wallProbe` 的六道筛只被 Step 4 加了夹具、没加筛）。`--draw-shot` 若红，先按 Task 7 Step 8 那句处理（读新靶子、换字面量、重跑三遍确认稳定），再怀疑本任务 —— 本任务唯一可能影响它的地方是 `--draw-shot` 第 12/13 步那两条删除判据读的是 `planDelete` 的输出，而 `candidateIds` 的顺序定义从"洞口在前、墙在后"扩成四段；样例房无柱无板 ⇒ 两者对同一发给出逐字相同的数组，红了就是改错了。

```bash
git status --porcelain   # 只应看到 packages/scene-2d/{src,test} 与 apps/desktop 下的文件 + 根 package.json
git add packages/scene-2d/src packages/scene-2d/test
git commit -m "feat(scene-2d): 属性面板派生与四类删除，planDelete 接上柱与板"
git add apps/desktop package.json
git commit -m "feat(desktop): 楼层 tab 与属性面板上屏，--prop-shot 十六步合成输入"
```

第一条提交信息正文带上：`panel.ts` 五个出口、`planDelete` 的两条新规则与四段顺序、35 + 21 那两份用例数、九条变异的红名表。第二条带上 `--prop-shot` 的实测条数与前三个闸门的重跑结果（编写期这两笔都还没有）。

#### 执行回填（Task 8，2026-09-29/30 实测；commits `c820327` + `59b918b` + `90b837a` + `eb0f28a` + `d7d8e7a` + `7c8ea24` + `0f67e4d` + `cbd6a75` + `ef5db0d` + `cb27c50`）

**落地形状**：A/B（node 侧 TDD 直接在真仓库，裁决 T8-1 放弃临时工程搬运）→ C（`panel.ts` 五出口的 GREEN）→ D1/D2（renderer 真布局接屏 + 三道旧闸门重测）→ D3/D4（跑 `--draw-shot`/`--edit-shot` 时揪出的**两个既有 bug**：`snapFromCursor` 的无名垂足抢端点、`dragProbe` 漏筛锚点）→ E-1…E-4（`propProbe` 探针 + `runPropShot` 十六步 + `--prop` 判据 23 行）。D3 起座位派发撞平台日额度上限 ⇒ **控制位 inline 接管**。BASE = `3c11183`。

- **计数账（盘上真话，覆盖编写期那三段拼账）**：`pnpm verify` = **`Test Files 34 passed (34)` / `Tests 482 passed (482)`**；core **25 文件 / 316 条一字未动**（⇒ 边界段那句"要改 core 就回 Task 7"没被触发）；scene-2d **6→7 文件 / 115→158 条**（新文件只有 `panel.test.ts`）。起点是 T7 回填的 **439**，净增 **43** = panel 21 + `editing.test.ts` 5（计划预见的 26）+ snapping 4 + handles 2（**裁决 T8-5 与 D4 两处修 bug 的用例，计划没有**）+ handles 11（棒 E 的 `propProbe` 那一组，**编写期没有**）。⇒ 本节上面那句「438 → 464」按盘上是 **439 → 482**，差的 18 里有 1 条是 T7 已登记的 `sharedBy` 收紧、17 条是上面那两组。
- **五个真窗口闸门在最终这份树上跑到稳定**：`shot 6/6` ×2、`pick-shot 11/11` ×2、`edit-shot 21/21` ×2、`draw-shot 28/28` ×2、**`prop-shot 29/29` ×4**（第四遍在改掉一段误引计划原文的注释之后重跑）。⇒ 编写期预言的「前三个闸门逐字不变」**成立**：6/11/21/28 那 66 条判据一行没动、一行没红，动的只有 `--pick` 那行的原点字面量（(0,0) → **(0,32)**，裁决 T8-3 授权的**唯一**一次字面量回填，判据仍是硬等式）。
- **`--prop-shot` 的形状**：共用那 6 条 + 本任务新增 **23 条**（P1…P23）。Step 7 那张十五行表落下来是三处展开、两处换证人：
  1. **第 11 行与实现互斥 ⇒ 拆成 11a/11b/11c**（本任务最贵的一处计划缺陷）。正文写「点墙 + Shift 点它身上的洞口 ⇒ `panelWallId === null`」，而 `selectedWallForPanel` 与 `panel.test.ts` 的口径是**混选里只要有一面墙就开面板**（P3 关掉的是"面板偷偷取第一面"那条路）。两种读法只能活一个：**裁决 = 实现与 node 测赢**，判据**不放宽**而是加发 —— 11a 墙 + 自己的洞口（面板照开、三格逐字不变）、11b **再 Shift 点第二面墙**（三枚选中、面板整块消失）、11c 点空白清空再重选（把选中集交回第 12 步）。**代价**：`propProbe` 多两个 nullable 字段 `secondWallId` / `secondWallPx`（探针的"尽力"那一发，**不是第七道筛** —— 单墙夹具照样交得出靶子，`handles.test.ts` 新增那条钉的就是这个形状），而主进程"不许自己猜坐标"这条纪律靠它才没被破。
  2. **第 12 行那句 `deletedIds` 只有那面墙与实现一致，但它证不了级联**。`deletedIds` 记的是**计划账**（`candidateIds` 里真源不再含有的那些），而 `planDelete` 的 `solo` 过滤本来就不给"宿主墙同批要删的洞口"发第二条 ⇒ 实测 `deletedIds.length === 1`。**换证人**：`layers.opening` **10 → 8**（删）→ **10**（撤销），同时 `depth` 只 +1 —— 没发第二条命令、构件却从画面上一起消失，这才是级联在屏幕上的形状；撤销那一半的凭据（"级联走的要跟着回来"）与删除用同一把尺。
  3. **第 10 行「Ctrl+Z 三次」实测 2 发**：第 5 步那发厚度已在第 7 步单独撤过 ⇒ 撤销数 = 材料发数 + 1。判据钉 `undoCount === 2` 与 `undoCombos` 逐字两条，**没写成"若干发"**。
- **两条只在真窗口才现形的实测纪律**（node 侧永远证不到）：
  - **`<select>` 的方向键要先有焦点**（Electron 44.4.5）：焦点在 `body` 时发 `Down` 谁都不动 —— 静默停在 0，既不报错也不改值。⇒ 第 8 步前 `moveFocus(MATERIAL_SELECT)`，第 10 步发快捷键前把焦点从刚点过的复选框交出去。材料那一发的 depth 预言基线是**撤销之后**那份（`undid1.depth`）；首跑拿撤销前去加，红成"永远差一发"。
  - **写盘报告的键名会静默覆盖终态**：`outReport = {...fin, ...逐步读数}`，同名键后者胜。首跑第 3 步的读数取了裸名 `panelWallId`，把 `fin.panelWallId`（null）盖掉 ⇒ 落盘的账与跑判据的账成了两份，而 29 行照绿。修法 = 逐步读数一律带"第几步"后缀（`panelWallIdAtSelect` / `planDeletedIds`），外加一枚**撞车就在写盘前抛**的守卫。
- **牙测（控制位亲手，两条都改完就 `cp` + `md5sum` 还原，不碰 git）**：
  - `STOREY_TAB_HEIGHT_PX` 32 → 40 ⇒ **P3、P7 FAIL / 27 PASS / exit=1**。P3 是布局前提、P7 是墨迹字面量（30744），其余 27 行不受影响 ⇒ 十六步自己走完了，这两行不是空转。
  - `storeyTabsOf` 的 label 改字 ⇒ **P1 FAIL / 28 PASS / exit=1**（基线那行吃的是 tab 内容字面量）。
  - **没做的一条要如实登记**：M2 类变异（`selectedWallForPanel` 摘掉 `kind === 'wall'` 过滤、改成取第一面）在真窗口红在 main 第 11b 步的 `waitUntil` **抛**，不落脚本判据行 —— 它的脚本侧凭据要等 `runPropShot` 不再自己抛才有意义。node 侧两条（`handles.test.ts` 第二面墙 + `panel.test.ts` 混选墙 + 洞口）是有牙的，故不为它单开一次跑。
- **listing 与盘上不符（逐条）**：
  - Step 8 的 `git add` 白名单（`packages/scene-2d/{src,test}` + `apps/desktop` + 根 `package.json`）**漏 `scripts/desktop-shot.mjs`** ⇒ 照抄会把 23 行判据落在提交外（Task 7 同款漏排，第二次犯）。
  - Step 7 那句「`whenLoaded` / `waitForDebug` / `focusForInput` / `pressPx` / `movePx` / `keyCombo` / `readReport` 六个助手沿用 T3~T6 那一份，**一步都不许新写**」在屏幕上不成立：棒 E 新写八个 —— `propShotRequested` / `readPropReport` / `domCenterPx` / `clickDomPx` / `shiftClickCanvasPx` / `typeText` / `moveFocus` / `readSelectState`。原因是面板那一发点的是 **DOM**（页面空间，**不**加 `canvasOriginPx`），而 T3~T6 那批只会点画布与发快捷键；沿用那六个一字未动。**代价**：主进程多八个助手，全是读 DOM 或转发 `sendInputEvent`，没有新语义。
  - Files 表里 `main/index.ts` 那行只写「加 `--prop-shot` 的十六步合成输入」，实际还加了四个形状（`WallPropsShape` / `StoreyTabShape` / `PanelTrialShape` / `PropProbeShape`）、`whenReady` 的四段→五段分支，以及 `--prop` 进 `wantInput`（派发合成输入必须拿 OS 前台焦点）。
  - 本节引言那句「`.tscheck/t9` = 31 文件 / 449 条」是临时工程的账；盘上从 34/439 起算 ⇒ 裁决 T8-1 换轨真仓库，Step 8 的"逐字搬回三个文件"那一步**没有发生**（也不该发生）。
  - `panelReadout()` 这条约束（面板上屏的值必须由**面板自己在 commit 后的 `useEffect`** 公布，不许 `PlanCanvas` 拿同一批纯函数重算，也不许渲染期赋值 —— `StrictMode` 双跑会公布没上屏的值）只存在于台账（裁决 T8-4 的 R2），正文 Step 7 没写。**这是"面板画空也绿"那类假绿的结构性修法，后续任务加诊断字段照此办理。**
- **转下游 / 仍未收掉的**：`storeyDelete` 的入口不是 Delete 键（删整层要确认框，S1 没有）；柱与板屏幕上点不到 ⇒ 删柱 / 删板只有 node 侧红绿（P9 的代价原样成立，`--prop-shot` 第 12 行那句"素材自证"只证了"取不到柱板时 `unsupported` 就该空"）；面板的多选批量改厚（P3 现形 = 两面墙就整块不显示）；材料候选按构件分表（P4 的代价）；`--prop-shot` P4/P5 两行吃的 `revision` 是 **store 的重绘计数**（`useEditor((s) => s.revision)`），**不是**文档 revision —— 它钉的是"切层重绘了但没写文档"，别读成后者。
- **过程教训（进台账）**：`git add` 两次被权限分类器拒（棒 B、D1）⇒ 提交一律由控制位执行；`main/index.ts` 那段注释曾把一条**我自己的执行笔记**的话引成"计划原文"（`deletedIds` 两枚），E-4 按盘上口径订正 —— 引语要对着计划正文再念一遍才许写进注释。

---


### Task 9: 吸附补档 —— 轴网交点 + 柱心/板角进表（把 T6 注释里那句"Task 9 补"兑现成代码）

> **本任务的 node 侧全部实测**（临时工程 `.tscheck/t10`，2026-09-28：31 文件 / 461 条、九条变异逐条红在哪、`npx tsc --noEmit -p tsconfig.scene2d.json` 干净）。屏幕侧只有一条结论是实测的：**五个闸门的判据一个字都不必改**（含 Task 8 才落地的 `--prop-shot`，它的重跑同属执行日），凭据是"样例房一层在补档前后的表内容、sweep 计数、探针答案集合逐字相同"（Step 5 那六进程）。

**Files:**

| 文件 | 动什么 | 实测 |
| --- | --- | --- |
| `packages/scene-2d/src/snapping.ts` | 五处：① 三行 import（`intersectLines` / `vec` / 既有那些不动）② `SnapKind` 补 `'axisCross'`、`SnapPointKind` 补 `'axisCross'` ③ `GROUP` 补一格、`PRIORITY` 插一档并把 `ortho`/`angle15` 顺次后移 ④ `snapFieldOf` 的注释重写 + 端点去重键换成坐标 + 柱心/板角两段循环 + 最后一行把交点并进表 ⑤ 新增**文件内私有**函数 `axisCrossPoints` | 380 行 → 501 行；snapping 28 → 40 条 |
| `packages/scene-2d/test/snapping.test.ts` | 追加两个 describe（交点档 6 条 + 柱心板角 6 条）+ 一个 `crossKeys` 助手；core import 补 `columnCreate` / `intersectLines` / `slabCreate` 三行 | 40 条全绿 |
| `packages/scene-2d/test/handles.test.ts` | **只改写一条**既有用例（「探针吃的是吸附后的毫米：前两发被真源挡下，第三发被一枚既有点接住」→ 结尾换成「被**轴网交点档**接住」），判据强度一行不放宽 | 19 条不变，全绿 |
| `packages/scene-2d/src/editing.ts` | **只改注释一处**（`planDelete` 的 doc 注释里那句「那是 Task 9 / 计划 4 的边界」把 Task 9 的边界说错了 —— 本任务只把柱心/板角喂进吸附场，指令表与命中集一行未动）；函数体一行未动 | 516 行 → 517 行；editing 35 条不变，全绿 |
| `packages/scene-2d/src/index.ts` | **一字不动** —— 本任务没有新出口 | — |
| `apps/desktop/**` | **一字不动** —— renderer 只把 `snapFieldOf` 的返回值往 `handleDropTarget` / `dropTargetOf` 里传，档位对它不透明 | 执行日只重跑闸门 |

**Interfaces:**

- Consumes（全是 core 既有的，本任务不给 core 加东西）：`intersectLines(p, dir, q, other)` → `Vec2 | null`（**无限直线**求交；平行与共线给 `null`，靠 `PARALLEL_EPS = 1e-9` 的相对容差，永不返回 `NaN`/`Infinity`）、`vec(x, y)`、`quantizeMm(n)`、`requirePoint(doc, id, 语境)`、`wallAxisById(doc, id)`；实体侧 `ColumnEntity.pointId`（一柱一枚，计划 2 T8 就这么定的）与 `SlabEntity.boundaryPointIds`（环序，长度 ≥ 3）；本文件内的 `quantizeTarget(px)`、`SnapAxis`、`SnapPoint`。
- Produces：`SnapKind` 从五档变六档（`'endpoint' | 'midpoint' | 'foot' | 'axisCross' | 'ortho' | 'angle15'`）、`SnapPointKind` 从两种变三种（多出 `'axisCross'`）、`PRIORITY = { endpoint: 0, midpoint: 1, foot: 2, axisCross: 3, ortho: 4, angle15: 5 }`（`ortho`/`angle15` 从 3/4 后移一位）、`GROUP.axisCross = 0`。**`snapFieldOf` 的签名与返回类型不变**，变的是表的形状：入表顺序定死成 **每面墙的〔起点，终点，中点〕顺次 → 柱心 → 板角 → 轴网交点**，端点档从此吃三类真源点（墙端点、柱心、板角）。调用方（`wallProbe` / `dragProbe` / `handleDropTarget` / renderer）不需要知道这些 —— 它们只把 `field` 整个递给 `snapFromCursor`。

#### 本任务的九条裁决

| # | 问题 | 裁决 | 为什么，以及代价 |
| --- | --- | --- | --- |
| R1 | "轴网交点"在 S1 里读作什么？ | **本层墙轴线的两两求交，且按无限直线算**（含轴延长线上的交点）。 | spec §6 那六档写的是"轴网交点"，S1 没有轴网实体；能称"轴"的只有 `wallAxisById` 派出来的墙轴线。按**线段**求交等于只做了一半：两线段相交的地方本来就垂足覆盖得到（那一处根本就有靶子），这一档**独有的东西**恰恰是延长线上的交点 —— 用户拿它把新墙同时对齐两面还没碰上的老墙。凭据：`snapping.test.ts`「两墙不相接、轴延长线上相交」（那一枚 (6000,0) 离两面墙的线段都远，只有直线给得出）。代价：近平行的两轴会给出极远的交点，它进表；`SNAP_TOL_PX = 8` 天然把它挡在大多数光标位置之外，除非用户真把光标停进那一格。 |
| R2 | 柱心与板角要不要各立一档？ | **不立。归进既有的 `endpoint` 档**，`SnapPointKind` 只多出 `'axisCross'`。 | 这一档真正的语义是"一枚**真源点**"（`pointId` 非空 ⇒ `pointRefOf` 复用它 ⇒ 接头闭合），墙端点、柱心、板角在这件事上完全同构。新开两档等于让 `PRIORITY` 回答"吸成柱还是吸成墙"这种没有答案的问题，而 `wallProbe` 的筛 ①（起点必须是 `kind === 'endpoint'`）会当场看不见柱心 —— 探针挑不上的档，屏幕上也不会吸。**改名成 `'point'` 更贵**：要动 `wallProbe` 的起点枚举、`--draw-shot`/`--edit-shot` 的字面量，换来的只有名字好看。代价：读表的人看到"endpoint"得记着它含柱心板角（注释里写死了）。 |
| R3 | 端点档的去重键用什么？ | **坐标** `` `${x},${y}` ``，不是 `pointId`。 | `resolvePointRef` 对**坐标字面量恒返回 null** ⇒ `columnCreate({ at: { x, y } })` 拿到的是一枚**自己的**点，坐标与旁边那面墙的端点逐字相同却是两枚 id。按 id 去重就留下两枚同坐标的端点候选，`takeBest` 的并列判据（GROUP 0 → distPx 相等 → PRIORITY 相等 → **ownerId**）只能拿 uuidv7 比大小 ⇒ 赢家跨进程漂，而吸到"柱那枚孤儿点"那一发**接不上头**（墙不认识那枚点，`wallCreate` 会新建第三枚同坐标的点）。凭据：「柱用坐标字面量落在墙端点上 ⇒ 墙的那枚点赢，孤儿点抢不走」是 N8（把键换回 pointId）**唯一**咬住的一条；另一枚见证是 61 墙栅格层的端点数 **122 → 120**（同一坐标合并掉两枚）。代价：同坐标的**两层**的点本来就被 `storeyId` 过滤隔开了，这条键不背跨层的锅。 |
| R4 | `axisCross` 排在优先级哪一格？ | **GROUP = 0（对象档）、PRIORITY = 3**：输给端点/中点/垂足，赢过正交/15°。`ortho` 与 `angle15` 顺次挪到 4/5。 | 交点是"两条轴决定的确定位置"，它比端点少了"背后有一枚真源点"这层意义 ⇒ 该输；比方向档多了"一个具体坐标" ⇒ 该赢。垂足 2 压交点 3 不是修辞：三轴共点、其中一轴的墙段真的穿过那一处时，屏幕上同时摆着两枚候选，而用户看到的"贴到墙上"才是垂足档的意思。凭据：N2（把 `axisCross` 的 PRIORITY 改成 0）**整场只红一条** ——「垂足档压过交点档」。代价：这一格挪动使 `ortho` 从 3 变 4、`angle15` 从 4 变 5，**相对次序一字未改**，所以 T6 那条"改写只许来自 `angle15`"的 sweep 判据照样成立（Step 5 实测 `rewriteKinds` 逐字相同）。 |
| R5 | 交点与既有靶子撞在同一坐标怎么办？ | **不入表**（规则 ③），并且交点之间也按量化坐标去重（规则 ②）。 | 撞上了那一处已经有更高档的候选（端点 0 / 中点 1 都压过 3），留着的交点永远输给对面 —— 它不是候选，是**噪声**：表长度变成实现细节的读数，而 `--draw-shot` 那句"吸上了哪一档"的判据会取决于枚举顺序而不是几何。共线更要挡：三条共线横轴 × 一条竖轴 = 三枚同一坐标。凭据：N3（不与既有表去重）红三条，含「样例房一枚交点档独有的靶子都没有」；N4（交点之间不去重）红四条，含「平行与共线都不求交」。代价：表**不再**是"这一档所有几何交点"的清单，而是"这一档独有靶子"的清单 —— 读代码的人若想知道撞掉了几枚，得自己算（61 墙层：930 对 ⇒ 784 枚进表、146 枚被挡）。 |
| R6 | T6 注释里承诺的"洞口中心"要不要一起补？ | **不补，判掉**，并把承诺那句话从注释里换成三条理由。 | ① 它不是 spec §6 那六档之一；② 它背后没有真源点，吸上去只是新建一枚坐标，而那个坐标**恰好已被垂足档覆盖**（洞口中心恒在宿主墙的轴线上）；③ 它许诺的语义是坏的 —— 把新墙的头吸到门洞中心 = 往门中间立一堵墙。想"对齐门洞边"要的是洞口的两个端点，属计划 4 的洞口编辑。代价：这句承诺从 T6 挂到今天，读者会以为漏做；所以注释必须逐字写明"到此判掉"，不能只删了事。 |
| R7 | O(墙²) 的建场成本落在谁头上？ | **落在 paint effect 那一发**（每帧一次），不落在 `pointermove`。 | `fieldRef` 的既有纪律（T6 裁决 ①：指针事件只读不建）本来就为这个准备着。实测（`.tscheck/t10` 的 F perf，2026-09-28）：样例房建场 0.0029~0.0032ms → **0.0081ms**，一次 `dropTargetOf` **0.0010ms**；61 面墙的栅格层（31 横 × 30 竖，965 枚候选）建场 0.021ms → **0.233~0.254ms**、一次取最优 0.009 → **0.030ms**。就算写错成"每发 pointermove 重建场"也是 0.264~0.273ms ⇒ 16.7ms 帧预算的 **1.6%**。代价：S1 认这个量级；真到千面墙要的是空间索引（`spatial/` 在计划 2 T9 已经有了），不是把这一档砍掉。 |
| R8 | 要不要重测 `--draw-shot` / `--edit-shot` 的字面量？ | **不必改判据，但执行日要重跑一遍取 PASS**。 | 本节此处原先预言了两个副作用（"探针计数与闸门字面量会再变一轮"、"Task 8 夹具的端点枚举表会跟着变"）。**实测都不成立**，理由是结构性的：样例房**无柱无板**（T5 已核实那条 ⇒ 柱心/板角两段循环对它空转），而它的 8 根轴两两求交得到的 9 枚格点**逐枚**已经落在端点或中点上（`pairTotal 28 → pairs 15 → unique 9 → dropped 9 → 进表 0 枚`）⇒ 交点档对样例房贡献 **0 枚新靶子**。六进程实测：表内容 `{endpoint:8, midpoint:8, axes:8}`、sweep `{handles:16, identity:72, rewritten:14, rewriteKinds:{angle15:14}, hitKinds:{foot:54, ortho:17, angle15:14, midpoint:1}, maxShiftPx:6.97}`、`dragProbe {toPx:{700,825}, targetMm:{4800,0}, sharedBy:3}` 三份**逐字相同**。代价：新档在屏幕上**没有见证**（它的凭据全在 node 侧的合成夹具里），所以那条"样例房 0 枚独有靶子"的用例本身就是护栏 —— 谁将来往 `demoHouse()` 里加柱加板或改成非格网布局，它会红，逼着那个人回来重测这五个闸门。 |
| R9 | 交点候选的 `pointId` 给什么？ | **恒 `null`**，`ownerId` 取该轴对里 id 较小那面墙的 id（`axes` 已按 id 升序 ⇒ 先扫到的那面，不必再比）。 | 那一处背后没有点；给了 id 等于宣称"复用它"，而 `resolvePointRef` 只认**文档里存在**的点 id。把墙的 id 当点 id 填进去，`wallCreate` 会在 `requirePoint` 那一格抛「点 … 不存在」—— 一发无害的吸附变成命令层异常。凭据：N9（让交点带上一枚真源 id）红两条，正是「交点档给得出唯一靶子，且它是新建点不是复用」与那条属性用例（恒不给 `pointId`）。代价：`ownerId` 只用于并列破序，屏幕上没人看得见它。 |

- [ ] **Step 1: 建临时工程 `.tscheck/t10` 并取基线**

沿用 Task 8 的做法：`cp -a .tscheck/t9 .tscheck/t10`（t9 是 Task 8 落地的逐字副本），本任务只往里改 `packages/scene-2d` 下**四个**文件（`src/snapping.ts`、`src/editing.ts` 的那一处注释、`test/snapping.test.ts`、`test/handles.test.ts`），`core/` 一字不动。

Run: `npx vitest run --config .tscheck/t10/vitest.config.ts`
Expected: **32 文件 / 451 条全绿**（其中 449 条是本计划登记的账 + `zz-measure.test.ts` 那 2 条只打印不断言的测量用例 —— 它是 Step 5 的探针，Step 8 落回真仓库时**不带它**）。红绿都不许带进 Step 2。

- [ ] **Step 2: 写失败测试 —— `snapping.test.ts` 追加两个 describe（12 条），先取红**

只写测试，`snapping.ts` 一字不动。跑 `npx vitest run --config vitest.config.ts packages/scene-2d/test/snapping.test.ts packages/scene-2d/test/handles.test.ts`。

**实测红形**（2026-09-28 在 `.tscheck/t9` 上把这份新测试逐字压给旧实现跑出来的）：**8 红 / 51 绿**（两个文件合计 59 条）。这与 T6/T7/T8 那种"红在 `… is not a function`"不同 —— 本任务**没有新出口**，`snapFieldOf` 早就在，所以红的全部落在断言值上：

```text
× 两墙不相接、轴延长线上相交 ⇒ 交点档给得出唯一靶子，且它是新建点不是复用
× 平行与共线都不求交；共线的三段横轴对同一根竖轴只留一枚交点
× 垂足档压过交点档：三轴共点且其中一轴的墙段真的穿过该点 ⇒ 赢的是 foot
× 属性：交点档命中时恒整数毫米、恒不给 pointId、恒在容差内，且答案恒来自表里那一枚
× 柱心在表里：吸上去复用柱引用的那枚点
× 板角四枚全在表里，逐枚 pointId 指向真源那个顶点
× 别层的柱与板一枚都不进本层表（上下层同位置是建筑常态，不是边角）
× 端点集 = 本层墙端点 ∪ 柱心 ∪ 板角 的坐标去重集（全量对账，多一枚少一枚都红）
```

**剩下四条在旧实现上是绿的，这不是漏写**：「样例房一枚交点档独有的靶子都没有」「交点与既有端点同坐标 ⇒ 不重复入表」「柱引既有墙端点 ⇒ 那一枚仍只有一份候选」「柱用坐标字面量落在墙端点上 ⇒ 墙的那枚点赢」在"档根本不存在"时当然成立 —— 它们是**防回归**的形状，各自的牙齿记在 Step 6 的 N3 / N5 / N8 上（摘掉实现才红）。执行时不许因为这四条绿就把上面八条的断言放宽。

下面两段就是**实测绿**的正文，逐字搬进 `snapping.test.ts` 末尾（`describe('光标 → 吸附结果' …)` 之后）。先在 core 的 import 列表里补三行（`columnCreate` / `intersectLines` / `slabCreate`，按现有字母序插进 `advance` 之后、`storeyCreate` 之前）：

```ts
import {
  Document,
  TransactionLog,
  advance,
  columnCreate,
  intersectLines,
  isExistingPoint,
  length,
  quantizeMm,
  requirePoint,
  resolvePointRef,
  slabCreate,
  storeyCreate,
  uuidv7,
  vec,
  wallAxisById,
  wallCreate,
  type PointRef,
  type WallEntity,
} from '@dajia/core';
```

`@dajia/scene-2d` 那一串**一字不改**（`snapFieldOf` / `snapFromCursor` / `dropTargetOf` / `pointRefOf` / `demoHouse` / `fitStorey` / `mmToPx` / `quantizeMm` / `viewportOf` 与 `SnapField` 类型都已经在了）。追加的正文：

```ts
/** 交点档的表内容按坐标列出来（排序后比：`byKind` 的 id 序随 uuidv7 漂，数组序不是判据）。 */
function crossKeys(fd: SnapField): string[] {
  return fd.points.filter((p) => p.kind === 'axisCross').map((p) => `${p.mm.x},${p.mm.y}`).sort();
}

describe('Task 9 轴网交点档', () => {
  /**
   * 两面对不上头的墙：A 沿 y=0 走到 x=4000 就完了，B 沿 x=6000 从 y=2000 才开始。
   * 它们的**轴延长线**交于 (6000, 0) —— 那一处既不是任何墙的端点也不是中点，
   * 所以表里若有它，只能是求交档给的。
   */
  function twoDetached(): { log: TransactionLog; storeyId: string; fd: SnapField } {
    const { log, storeyId } = synthStorey();
    wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    wallAt(log, storeyId, { x: 6000, y: 2000 }, { x: 6000, y: 5000 });
    return { log, storeyId, fd: snapFieldOf(log.document, storeyId) };
  }

  it('两墙不相接、轴延长线上相交 ⇒ 交点档给得出唯一靶子，且它是新建点不是复用', () => {
    const { log, fd } = twoDetached();
    expect(crossKeys(fd)).toEqual(['6000,0']);
    // 素材自证：这一处确实"不是既有靶子" —— 两墙各自的端点与中点四条坐标全不在此
    expect(kindsAt(fd, 6000, 0)).toEqual(['axisCross']);
    const cross = fd.points.find((p) => p.kind === 'axisCross')!;
    expect(cross.pointId).toBeNull(); // 交点背后没有真源点：谈不到复用
    const wallIds = new Set(log.document.byKind('wall').map((w) => w.id));
    expect(wallIds.has(cross.ownerId)).toBe(true); // ownerId 只是并列破序的把手，但必须是本层的墙
    // 光标停在交点上方 60mm（0.125px/mm ⇒ 7.5px，容差之内）：两墙的垂足都被墙端夹掉，只剩这一档
    const snap = snapFromCursor(view, mmToPx(view, vec(6000, 60)), { x: 6000, y: 60 }, null, fd);
    expect(snap?.kind).toBe('axisCross');
    expect(snap?.mm).toEqual({ x: 6000, y: 0 });
    expect(snap?.distPx).toBeCloseTo(7.5, 6);
    // 再退 30mm 就出容差（11.25px）⇒ 整档没有候选，落点退回裸毫米
    expect(
      snapFromCursor(view, mmToPx(view, vec(6000, 90)), { x: 6000, y: 90 }, null, fd),
    ).toBeNull();
  });

  it('样例房一枚交点档独有的靶子都没有：15 对轴求出的 9 枚格点逐枚落在既有端点或中点上', () => {
    // 这一条是"`--draw-shot` / `--edit-shot` 的字面量不必重测"的**凭据**，不是顺手写的安慰剂：
    // 样例房是 3 横（y=0/3000/6000）× 3 竖（x=0/4000/8000）的完整格网，9 个格点全部已经被
    // 端点（8 枚）或中点（西/北/东三墙的中点正好是 (0,3000)/(4000,6000)/(8000,3000)）占住。
    expect(crossKeys(field)).toEqual([]);
    expect(field.axes).toHaveLength(8);
    // 素材自证：不是"求交没跑"。拿 core 的原始助手独立算一遍九枚，逐枚问静态表里有没有更高档。
    let pairs = 0;
    for (let i = 0; i < field.axes.length; i += 1) {
      for (let j = i + 1; j < field.axes.length; j += 1) {
        const a = field.axes[i]!;
        const b = field.axes[j]!;
        const hit = intersectLines(vec(a.startMm.x, a.startMm.y), a.dir, vec(b.startMm.x, b.startMm.y), b.dir);
        if (hit === null) continue;
        pairs += 1;
        const mm = { x: quantizeMm(hit.x), y: quantizeMm(hit.y) };
        const kinds = kindsAt(field, mm.x, mm.y);
        expect(
          kinds.includes('endpoint') || kinds.includes('midpoint'),
          `交点 ${mm.x},${mm.y} 既不是端点也不是中点，却不在交点档表里`,
        ).toBe(true);
      }
    }
    expect(pairs).toBe(15); // 3 竖 × 5 横（y=0 与 y=3000 上各有两面共线墙）= 15 对垂直，去重后 9 个格点
  });

  it('平行与共线都不求交；共线的三段横轴对同一根竖轴只留一枚交点', () => {
    const { log, storeyId } = synthStorey();
    // 三段**共线但不相接**的横墙（同一条几何线 y=0）+ 一面平行横墙
    wallAt(log, storeyId, { x: 0, y: 0 }, { x: 2000, y: 0 });
    wallAt(log, storeyId, { x: 3000, y: 0 }, { x: 4000, y: 0 });
    wallAt(log, storeyId, { x: 6000, y: 0 }, { x: 8000, y: 0 });
    expect(crossKeys(snapFieldOf(log.document, storeyId))).toEqual([]); // 共线 = 平行：三对全不求交
    wallAt(log, storeyId, { x: 0, y: 2000 }, { x: 8000, y: 2000 });
    expect(crossKeys(snapFieldOf(log.document, storeyId))).toEqual([]); // 不同线的平行也一样
    // 竖轴来了：与 y=0 那三条共线轴各交一次，**同一个坐标** ⇒ 表里只许有一枚
    wallAt(log, storeyId, { x: 5000, y: -2000 }, { x: 5000, y: 4000 });
    const fd = snapFieldOf(log.document, storeyId);
    expect(crossKeys(fd)).toEqual(['5000,0', '5000,2000']);
    // 素材自证：这两处都不在端点/中点上（六段墙的端点与中点逐枚不在此），所以不是被去重挡掉的
    expect(kindsAt(fd, 5000, 0)).toEqual(['axisCross']);
    expect(kindsAt(fd, 5000, 2000)).toEqual(['axisCross']);
  });

  it('交点与既有端点同坐标 ⇒ 不重复入表：那一处该以真源点身份被吸到，好让接头闭合', () => {
    const { log, storeyId } = synthStorey();
    const a = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    // L 角：第二面墙**引**第一面的 endId ⇒ 两轴的交点恰好就是那枚共享点
    wallAt(log, storeyId, { pointId: a.endId }, { x: 4000, y: 3000 });
    const fd = snapFieldOf(log.document, storeyId);
    expect(fd.axes).toHaveLength(2);
    // 独立算一遍：两轴确实交于 (4000,0)，而那一处表里已经有端点了
    const hit = intersectLines(vec(0, 0), vec(1, 0), vec(4000, 0), vec(0, 1));
    expect(hit).not.toBeNull();
    expect(kindsAt(fd, 4000, 0)).toEqual(['endpoint']);
    expect(crossKeys(fd)).toEqual([]);
    // 判据的另一半：吸上去复用的是**墙的那枚点**，不是"另建一枚同坐标的点"
    const snap = snapFromCursor(view, pxOf({ x: 4000, y: 0 }, view), { x: 4000, y: 0 }, null, fd);
    expect(snap?.kind).toBe('endpoint');
    expect(snap?.pointId).toBe(a.endId);
  });

  it('垂足档压过交点档：三轴共点且其中一轴的墙段真的穿过该点 ⇒ 赢的是 foot', () => {
    const { log, storeyId } = synthStorey();
    wallAt(log, storeyId, { x: 0, y: 0 }, { x: 8000, y: 0 });
    wallAt(log, storeyId, { x: 3000, y: -1000 }, { x: 3000, y: 3000 });
    const fd = snapFieldOf(log.document, storeyId);
    // (3000,0) 在两墙的**线段内部** ⇒ 那一处同时是两枚垂足候选与一枚交点候选
    expect(crossKeys(fd)).toEqual(['3000,0']);
    const cursor = pxOf({ x: 3000, y: 0 }, view);
    const first = snapFromCursor(view, cursor, { x: 3000, y: 0 }, null, fd);
    expect(first?.kind).toBe('foot'); // PRIORITY：foot 2 < axisCross 3，距离并列时档位说话
    expect(first?.mm).toEqual({ x: 3000, y: 0 });
    expect(first?.pointId).toBeNull();
    // 倒过来扫一遍还是同一个答案：并列判据（档位 → ownerId）是全序，不靠扫描顺序
    expect(snapFromCursor(view, cursor, { x: 3000, y: 0 }, null, reversed(fd))).toEqual(first);
  });

  it('属性：交点档命中时恒整数毫米、恒不给 pointId、恒在容差内，且答案恒来自表里那一枚', () => {
    // 跑在**有交点**的场上：上面那条全场属性跑的是样例房，而样例房一枚交点都没有 ⇒ 对它 vacuous。
    const fd = twoDetached().fd;
    expect(crossKeys(fd)).toEqual(['6000,0']);
    fc.assert(
      fc.property(
        fc.record({
          x: fc.integer({ min: 4000, max: 8000 }),
          y: fc.integer({ min: -2000, max: 4000 }),
          dx: fc.double({ min: -20, max: 20, noNaN: true }),
          dy: fc.double({ min: -20, max: 20, noNaN: true }),
        }),
        ({ x, y, dx, dy }) => {
          const base = pxOf({ x, y }, view);
          const drop = dropTargetOf(view, { x: base.x + dx, y: base.y + dy }, null, fd);
          expect(Number.isInteger(drop.mm.x) && Number.isInteger(drop.mm.y)).toBe(true);
          if (drop.snap?.kind !== 'axisCross') return;
          expect(drop.snap.pointId).toBeNull();
          expect(drop.snap.distPx).toBeLessThanOrEqual(SNAP_TOL_PX);
          // 落点恒等于表里那一枚：现算出来的交点档 candidate 不许在 `snapFromCursor` 里被重算一遍
          expect(crossKeys(fd)).toContain(`${drop.mm.x},${drop.mm.y}`);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('Task 9 柱心与板角进表', () => {
  function synth(): { log: TransactionLog; storeyId: string; projectId: string } {
    const projectId = uuidv7();
    const log = new TransactionLog(Document.create(projectId));
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    let storeyId = '';
    for (const id of log.affected) {
      if (log.document.get(id)?.kind === 'storey') storeyId = id;
    }
    if (storeyId === '') throw new TypeError('affected 里没有新建的楼层');
    return { log, storeyId, projectId };
  }

  function columnAt(log: TransactionLog, storeyId: string, at: PointRef): string {
    log.dispatch(columnCreate({ storeyId, at, widthMm: 400, depthMm: 400, heightMm: 3000 }));
    for (const id of log.affected) {
      const entity = log.document.get(id);
      if (entity?.kind === 'column') return entity.pointId;
    }
    throw new TypeError('affected 里没有新建的柱');
  }

  function slabAt(log: TransactionLog, storeyId: string, boundary: PointRef[]): string[] {
    log.dispatch(slabCreate({ storeyId, boundary, thicknessMm: 120 }));
    for (const id of log.affected) {
      const entity = log.document.get(id);
      if (entity?.kind === 'slab') return entity.boundaryPointIds;
    }
    throw new TypeError('affected 里没有新建的板');
  }

  it('柱心在表里：吸上去复用柱引用的那枚点', () => {
    const { log, storeyId } = synth();
    const pointId = columnAt(log, storeyId, { x: 1000, y: 1000 });
    const fd = snapFieldOf(log.document, storeyId);
    expect(kindsAt(fd, 1000, 1000)).toEqual(['endpoint']); // 柱心走的是端点档，不是新立一档
    const hit = fd.points.find((p) => p.mm.x === 1000 && p.mm.y === 1000)!;
    expect(hit.pointId).toBe(pointId);
    const snap = snapFromCursor(view, pxOf({ x: 1000, y: 1000 }, view), { x: 1000, y: 1000 }, null, fd);
    expect(snap?.kind).toBe('endpoint');
    expect(snap?.pointId).toBe(pointId);
    expect(pointRefOf(snap!.mm, snap)).toEqual({ pointId }); // 复用真源点，接头才闭合
  });

  it('板角四枚全在表里，逐枚 pointId 指向真源那个顶点', () => {
    const { log, storeyId } = synth();
    const ids = slabAt(log, storeyId, [
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
      { x: 4000, y: 3000 },
      { x: 0, y: 3000 },
    ]);
    const fd = snapFieldOf(log.document, storeyId);
    const eps = fd.points.filter((p) => p.kind === 'endpoint');
    expect(eps).toHaveLength(4); // 板的四个顶点，一枚不多一枚不少
    expect(new Set(eps.map((p) => p.pointId))).toEqual(new Set(ids));
    for (const p of eps) {
      const point = requirePoint(log.document, p.pointId as string, '板角');
      expect(p.mm).toEqual({ x: point.x, y: point.y });
      expect(p.ownerId).toBe(eps[0]!.ownerId); // ownerId 是**板**，不是某面墙（这里根本没有墙）
    }
    expect(log.document.byKind('wall')).toHaveLength(0); // 素材自证：四枚候选全是板的功劳
  });

  it('柱引既有墙端点 ⇒ 那一枚仍只有一份候选（去重跨三类共用）', () => {
    const { log, storeyId } = synth();
    const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const pointId = columnAt(log, storeyId, { pointId: wall.endId });
    const fd = snapFieldOf(log.document, storeyId);
    expect(kindsAt(fd, 4000, 0)).toEqual(['endpoint']);
    const at = fd.points.filter((p) => p.mm.x === 4000 && p.mm.y === 0);
    expect(at).toHaveLength(1);
    expect(at[0]!.pointId).toBe(pointId); // 与墙共用同一枚点 ⇒ 去重前后是同一枚
    expect(at[0]!.ownerId).toBe(wall.id); // 先扫到的墙赢：ownerId 只用于并列破序，不给语义
  });

  it('柱用坐标字面量落在墙端点上 ⇒ 墙的那枚点赢，孤儿点抢不走（去重键是坐标而不是 id）', () => {
    const { log, storeyId } = synth();
    const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    // `resolvePointRef` 对字面量恒返回 null ⇒ 柱拿到一枚**自己的**点，坐标与墙的 endId 逐字相同
    const orphanId = columnAt(log, storeyId, { x: 4000, y: 0 });
    expect(orphanId).not.toBe(wall.endId);
    const fd = snapFieldOf(log.document, storeyId);
    const at = fd.points.filter((p) => p.mm.x === 4000 && p.mm.y === 0);
    expect(at).toHaveLength(1); // 按 pointId 去重的写法会在这里留下两枚，赢家随 uuidv7 漂
    expect(at[0]!.pointId).toBe(wall.endId); // 恒取墙的点：复用它才接得上头
    const snap = snapFromCursor(view, pxOf({ x: 4000, y: 0 }, view), { x: 4000, y: 0 }, null, fd);
    expect(snap?.pointId).toBe(wall.endId);
  });

  it('别层的柱与板一枚都不进本层表（上下层同位置是建筑常态，不是边角）', () => {
    const { log, storeyId, projectId } = synth();
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    let upperId = '';
    for (const id of log.affected) {
      if (log.document.get(id)?.kind === 'storey' && id !== storeyId) upperId = id;
    }
    if (upperId === '') throw new TypeError('第二层没建出来');
    columnAt(log, upperId, { x: 1000, y: 1000 }); // 与下面那枚同坐标，只差一层
    slabAt(log, upperId, [
      { x: 0, y: 0 },
      { x: 2000, y: 0 },
      { x: 2000, y: 2000 },
    ]);
    columnAt(log, storeyId, { x: 1000, y: 1000 });
    const fd = snapFieldOf(log.document, storeyId);
    const upper = snapFieldOf(log.document, upperId);
    const lowerIds = new Set(fd.points.map((p) => p.pointId).filter((id): id is string => id !== null));
    const upperIds = new Set(upper.points.map((p) => p.pointId).filter((id): id is string => id !== null));
    expect(upperIds.size).toBeGreaterThan(lowerIds.size); // 素材自证：别层自己有东西可漏
    for (const id of lowerIds) expect(upperIds.has(id)).toBe(false);
    const upperOwners = new Set<string>([
      ...log.document.byKind('column').filter((c) => c.storeyId === upperId).map((c) => c.id),
      ...log.document.byKind('slab').filter((s) => s.storeyId === upperId).map((s) => s.id),
    ]);
    expect(upperOwners).toHaveLength(2); // 素材自证：别层确实进来了一柱一板
    for (const p of fd.points) expect(upperOwners.has(p.ownerId)).toBe(false);
    // 同坐标不等于同一点：本层那一枚必须还在，且它是本层柱的点
    const at = fd.points.filter((p) => p.mm.x === 1000 && p.mm.y === 1000);
    expect(at).toHaveLength(1);
    expect(requirePoint(log.document, at[0]!.pointId as string, '本层柱心').storeyId).toBe(storeyId);
  });

  it('端点集 = 本层墙端点 ∪ 柱心 ∪ 板角 的坐标去重集（全量对账，多一枚少一枚都红）', () => {
    const { log, storeyId } = synth();
    const w1 = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    wallAt(log, storeyId, { pointId: w1.endId }, { x: 4000, y: 3000 });
    const columnPointId = columnAt(log, storeyId, { x: 800, y: 800 });
    // 矩形往左上方去，只与 w1 共用 (0,0) 那一枚点：四个顶点里没有三个共线，`assertSimpleRing` 收得下
    const slabIds = slabAt(log, storeyId, [
      { pointId: w1.startId },
      { x: -2000, y: 0 },
      { x: -2000, y: 2000 },
      { x: 0, y: 2000 },
    ]);
    const fd = snapFieldOf(log.document, storeyId);
    const eps = fd.points.filter((p) => p.kind === 'endpoint');
    // 期望的坐标集：墙 (0,0)(4000,0)(4000,3000) + 柱 (800,800) + 板角 (0,0)(-2000,0)(-2000,2000)(0,2000)
    // 去重后 7 枚 —— 板与墙共用的那枚 (0,0) 只算一次（键是坐标）。
    const expected = new Set([
      '0,0',
      '4000,0',
      '4000,3000',
      '800,800',
      '-2000,0',
      '-2000,2000',
      '0,2000',
    ]);
    expect(new Set(eps.map((p) => `${p.mm.x},${p.mm.y}`))).toEqual(expected);
    expect(eps).toHaveLength(expected.size);
    expect(eps.map((p) => p.pointId)).toContain(columnPointId); // 柱心那一枚的 id 真的进了表
    // 每一枚的 pointId 都必须是真的、属于本层的点
    for (const p of eps) {
      const point = requirePoint(log.document, p.pointId as string, '端点集对账');
      expect(point.storeyId).toBe(storeyId);
    }
    // 中点每面墙一枚；交点档在这一格里也没有新增靶子：唯一的轴对 (w1,w2) 交于 (4000,0)，
    // 那里已经有墙端点 ⇒ 被规则 ③ 挡掉（板角不是轴，不参与求交）。
    expect(fd.points.filter((p) => p.kind === 'midpoint')).toHaveLength(2);
    expect(crossKeys(fd)).toEqual([]);
    expect(slabIds).toHaveLength(4);
  });
});
```

（起点行号：`crossKeys` 那三行的注释是"排序后比：`byKind` 的 id 序随 uuidv7 漂，数组序不是判据" —— 这句是本任务全部新断言的写法纪律，凡表内容都比**集合/排序后的坐标串**，不比数组下标。老库里唯一一处按下标取候选的是 `snapping.test.ts:263` 的 `list.points[0]!.ownerId`，它跑在**单面墙**的合成层上，Task 9 之后那一枚仍是那面墙的起点，所以不必动 —— 但**别学它**。）

- [ ] **Step 3: 落实现 —— `snapping.ts` 的五处改动，外加 `editing.ts` 的一处注释订正**

改完之后 `snapFieldOf` 的签名、返回类型、`index.ts` 的导出面都不变；变的是档位、去重键、以及表里多出那三段。六处逐字如下（①–⑤ 的行号按**改后**的 `snapping.ts` 501 行版本给，⑥ 按改后的 `editing.ts` 517 行版本给，便于对账）。

**① 文件头 import（第 1–10 行）**：补 `intersectLines` 与 `vec` 两个名字，别的一律不动。

```ts
import {
  intersectLines,
  quantizeMm,
  requirePoint,
  vec,
  wallAxisById,
  type Document,
  type PointRef,
  type Vec2,
} from '@dajia/core';
```

**② 档位（第 73–85 行）**：`SnapKind` 五档变六档；`SnapPointKind` 多出 `'axisCross'`，并把 `'endpoint'` 读作"一枚真源点"这件事写进注释（R2）。

```ts
/** 六档吸附。前四种吸到**已有的东西**上，后两种吸到**方向**上（spec §6 那张表）。 */
export type SnapKind = 'endpoint' | 'midpoint' | 'foot' | 'axisCross' | 'ortho' | 'angle15';

/**
 * 静态点表里出现的三种档：垂足与两个角度档的候选按光标现算，不可能预先列出（见 `SnapField`）。
 *
 * `'endpoint'` 读作"**一枚真源点**"而不是"一面墙的头"：Task 9 把柱心与板角也归进这一档，
 * 因为它们共享同一条语义 —— `pointId` 非空、`pointRefOf` 会复用它。改名成 `'point'` 要动
 * `wallProbe` 的起点枚举、`--draw-shot` 与 `--edit-shot` 的字面量，换来的只有名字好看。
 */
export type SnapPointKind = 'endpoint' | 'midpoint' | 'axisCross';

/** 表里的一枚候选点。`ownerId` 只用于并列破序，不给语义。 */
```

**③ 并列判据与场的契约（第 137–180 行）**：`GROUP` 补 `axisCross: 0`；`PRIORITY` 把 `axisCross: 3` 插进 `foot` 之后、`ortho` 之前，于是 `ortho` 4 / `angle15` 5（R4 —— 相对次序一字未动）；`snapFieldOf` 的注释从"三行 + 一句留给 Task 9 的承诺"换成五段来源的定死顺序、跨层三道防线、以及**洞口中心判掉**那三条理由（R6）。

```ts
/** 先分组（对象档永远压过方向档），组内先比距离，再比档位，最后比 ownerId。 */
const GROUP: Record<SnapKind, number> = {
  endpoint: 0,
  midpoint: 0,
  foot: 0,
  axisCross: 0,
  ortho: 1,
  angle15: 1,
};
/**
 * 档位优先序 = spec §6 那张表的顺序，**只有一处故意不同**：正交排在 15° 前面。
 * 理由是 `angle15Of` 把 90 的倍数整档让给了正交（S3），于是两档同时命中的场合只剩下
 * "方向恰好落在轴上"那一种 —— 那里该赢的是保坐标的正交。这条在 T6 就是这样，Task 9 没改它。
 */
const PRIORITY: Record<SnapKind, number> = {
  endpoint: 0,
  midpoint: 1,
  foot: 2,
  axisCross: 3,
  ortho: 4,
  angle15: 5,
};

/**
 * 本层的吸附场：一面层的**全部既有靶子**在这里列齐，`snapFromCursor` 只读它。
 *
 * 五段来源，入表顺序定死成 **每面墙的〔两个端点，中点〕顺次 → 柱心 → 板角 → 轴网交点**：
 * - **端点档**收三样真源点（墙端点、柱心、板角），它们共用同一条语义 —— `pointId` 非空，
 *   吸上即复用。按**坐标**去重（键是 `${x},${y}`，不是 pointId）：样例房一层有六枚共享端点，
 *   不去重就是"同一个点六个候选、六个 ownerId"，并列破序会挑出任意一面墙，`pointId` 却全都一样 ——
 *   结果对，过程没法测；而柱/板带进来的**同坐标孤儿点**更要靠这一条挡住（见下面柱那一段）。
 * - **轴网交点档**是本任务补的那一档：S1 没有轴网实体，所以它就是**本层墙轴线的两两求交**
 *   （`axisCrossPoints`，含轴延长线上的交点）。
 *
 * 三道跨层的防线都在同一个循环里（`if (x.storeyId !== storeyId) continue`）：漏任何一道，
 * 两层的同位置坐标就会互相吸 —— 上下层对齐是建筑的常态，所以这不是边角，是必然踩的那一发。
 * `resolvePointRef` 紧接着拿跨层抛错，会把一发无害的吸附变成命令层异常。
 *
 * **洞口中心不在表里**（`snapping.ts` 在 T6 承诺"Task 9 补"的那半句，到此判掉而不是兑现）：
 * ① 它不是 spec §6 那六档之一；② 它背后没有真源点，吸上去只会新建一枚坐标，与"随便吸到轴上
 * 某处"没有区别 —— 而那个"某处"**恰好**已经被垂足档覆盖（洞口中心就在宿主墙的轴线上）；
 * ③ 它许诺的语义是坏的：把新墙的头吸到门洞中心 = 往门中间立一堵墙。
 * 想要"对齐门洞边"，那是洞口的两个端点，属计划 4 的洞口编辑，不属这一档。
 */
```

**④ 墙那一段的去重键（第 199–203 行）**：`seen` 的键从 `pointId` 换成 `` `${point.x},${point.y}` ``，并且把 `requirePoint` 提到键计算之前（R3）。

```ts
    for (const pointId of [wall.startId, wall.endId]) {
      const point = requirePoint(doc, pointId, '吸附端点');
      const key = `${point.x},${point.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
```

**⑤ 柱心、板角、交点三段（第 222–308 行）**：接在墙那个 `for` 的右花括号之后、`return { points, axes }` 之前；`axisCrossPoints` 是**文件内私有**函数，紧跟在 `snapFieldOf` 后面，不进 `index.ts`。交点档排在最后算，因为它要拿前面三段的结果去重（R5、R9）。

```ts
  // 柱心与板角走的是与墙端点完全相同的一条通路：读真源那枚点、按坐标去重、复用。
  // 去重键是**坐标**而不是 pointId（墙那一段同理），理由是 `columnCreate` 拿坐标字面量时
  // 会新建一枚**自己的**点（`resolvePointRef` 对字面量恒返回 null）—— 按 id 去重就会留下
  // 两枚同坐标的端点候选，并列破序按 ownerId 挑，而 ownerId 是 uuidv7：吸到"墙的点"还是
  // "柱那枚孤儿点"跨进程漂。孤儿点复用了也接不上头（墙不认识它），所以赢家恒取先扫到的墙端点。
  // `seen` 跨三类共用是故意的 —— 柱落在墙端点上是常态（`columnCreate` 的 `at` 就写着可以
  // 引既有墙端点），共用同一枚点时表里只该留一枚候选，留两枚等于让并列破序去挑"吸成墙还是吸成柱"。
  for (const column of doc.byKind('column')) {
    if (column.storeyId !== storeyId) continue;
    const point = requirePoint(doc, column.pointId, '吸附柱心');
    const key = `${point.x},${point.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push({
      kind: 'endpoint',
      mm: { x: point.x, y: point.y },
      pointId: column.pointId,
      ownerId: column.id,
    });
  }
  for (const slab of doc.byKind('slab')) {
    if (slab.storeyId !== storeyId) continue;
    for (const pointId of slab.boundaryPointIds) {
      const point = requirePoint(doc, pointId, '吸附板角');
      const key = `${point.x},${point.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      points.push({
        kind: 'endpoint',
        mm: { x: point.x, y: point.y },
        pointId,
        ownerId: slab.id,
      });
    }
  }
  // 交点排在最后算：它要拿上面三段的结果去重（一枚既是墙端点又是两轴交点的坐标，
  // 该以"真源点"的身份被吸到，好让 `pointRefOf` 复用而不是新建）。
  for (const cross of axisCrossPoints(axes, points)) points.push(cross);
  return { points, axes };
}

/**
 * 轴网交点档：本层墙轴线**两两求交**（spec §6 的第四档，S1 里没有轴网实体时的唯一读法）。
 *
 * 四条规则，每条各挡一处：
 * ① **无限直线**求交而不是线段：线段交点 = "墙已经十字相交"，那里本来就有靶子（垂足档覆盖它）；
 *   这一档给的新东西恰恰是**轴延长线上**的交点 —— 让新墙与两面还没碰上的老墙同时对齐。
 *   共线与近平行由 core 的 `intersectLines` 返回 null 挡掉（`PARALLEL_EPS = 1e-9` 相对容差）。
 * ② **量化后去重**：三条共线横墙 × 一条竖墙 = 三枚同一坐标的候选。不去重，`--draw-shot` 里
 *   "吸上了哪一档"的判据就取决于枚举顺序而不是几何，而表长度也变成实现细节的读数。
 * ③ **与已有真源点/中点同坐标的交点不入表**：那一处已经有更高优先档的候选（端点 0 / 中点 1
 *   都压过本档的 3），留两枚只会被 `takeBest` 立刻丢掉 —— 清掉它，表才是"这一档独有的靶子"。
 * ④ `ownerId` 取该对中**id 较小**的那面墙：`axes` 来自 `byKind('wall')`（已按 id 升序），
 *   所以先扫到的那面恒为较小者，不需要再比一次。它只用于并列破序，不给语义。
 *
 * **代价**：表长度是 O(墙数²)。样例房一层 8 面墙 → 28 对，但交点档进表 **0** 枚（9 枚格点全被端点/中点占了）；
 *   一张 61 面墙的栅格层 → 1830 对、进表 784 枚，建一次场实测 0.233~0.254ms。场只在按下时建一次、`pointermove` 只读，
 *   所以这笔落在"按下那一发"上，不落在每帧上。近于平行的两轴会给出极远的交点：它进表，
 *   但 `takeBest` 的 `SNAP_TOL_PX` 天然把它挡在候选之外 —— 除非用户真的把光标停在那一小格里，
 *   而那一格的几何是**确定**的（同一个文档算同一个数），不是噪声。
 */
function axisCrossPoints(
  axes: readonly SnapAxis[],
  existing: readonly SnapPoint[],
): SnapPoint[] {
  const taken = new Set(existing.map((p) => `${p.mm.x},${p.mm.y}`));
  const out: SnapPoint[] = [];
  for (let i = 0; i < axes.length; i += 1) {
    const a = axes[i]!;
    for (let j = i + 1; j < axes.length; j += 1) {
      const b = axes[j]!;
      const hit = intersectLines(
        vec(a.startMm.x, a.startMm.y),
        a.dir,
        vec(b.startMm.x, b.startMm.y),
        b.dir,
      );
      if (hit === null) continue;
      const mm = quantizeTarget(hit);
      const key = `${mm.x},${mm.y}`;
      if (taken.has(key)) continue;
      taken.add(key);
      out.push({ kind: 'axisCross', mm, pointId: null, ownerId: a.ownerId });
    }
  }
  return out;
}
```

**⑥ `editing.ts` 的一处注释订正（第 215–218 行，`planDelete` 的 doc 注释尾巴）**：Task 8 落地时那句「就把柱画进指令表 —— 那是 **Task 9** / 计划 4 的边界」把边界说错了：Task 9 交付的是**吸附场**吃下柱心与板角，`buildDrawList` 与 `pickAt` 一行没动（Step 5 那六进程的 sweep 逐字相同就是它的见证）。留着这句，执行完 Task 9 的人回头读 `editing.ts` 会以为指令表里该有柱了。只改注释，函数体一行未动。

```ts
 * **屏幕上今天还点不到柱与板**：`buildDrawList` 的指令表与 `pickAt` 的命中集都只认墙与洞口，
 * 所以 ③④ 两支的凭据只能是合成夹具（手工把柱/板的 id 放进选中集）。不许为了在屏幕上"证明它"
 * 就把柱画进指令表 —— 那是**计划 4** 的边界（Task 9 只把柱心/板角喂进**吸附场**，指令表与命中集一行未动），
 * 混进来会让 `--draw-shot` 那 28 行像素判据全数重测。
```

Run: `npx vitest run --config vitest.config.ts packages/scene-2d/test/snapping.test.ts`
Expected: **40 条全绿**（Step 2 那 8 条从红转绿；4 条本来绿的仍然绿 —— 它们的凭据在 Step 6）。这时 `handles.test.ts` 会**恰好红一条**（「探针吃的是吸附后的毫米」，实测 `expected { x: +0, y: -760 } to deeply equal { x: 40, y: -760 }`），那是 Step 4 的活，不许在这里就地放宽。

- [ ] **Step 4: `handles.test.ts` 里那一条被新档合法改写的既有用例**

Step 3 之后 `handles.test.ts` 红的**只有那一条**（实测 19 条里 1 条红）。先说清"为什么改它不算放宽判据"：

- 这条用例的判据是**三件事**：① 探针吃的不是裸落点（`expect(p!.targetMm).not.toEqual(moveTargetOf(v, p!.toPx))`）、② 吸附之后那一发真过得了真源守卫（`legalDrop(..., p!.targetMm)` 为 `true`）、③ 裸的对角偏移那两发非法（末尾那个 `for` 里 `legalDrop(..., off)` 恒 `false`）。**三件事一条都没动、一条都没少。**
- 动的只有"① 的答案具体是哪一枚毫米"：`(40,-760)` → `(0,-760)`。旧实现吸到第三面墙的**起点**（端点档，5.66px）；新实现先撞上 `(0,-760)` —— `+y` 那面墙的轴**延长线** `x=0` 与第三面墙的轴 `y=-760` 的交点，离裸落点 4px ⇒ 同一对象组内先比距离，交点赢。
- **不许改成"挪夹具"**：交点是端点在光标那条线上的**投影**（端点 `(40,-760)` 投到 `x=0` 上就是 `(0,-760)`），所以只要场里同时有那枚端点与那两条轴，交点档的距离**恒 ≤** 端点档的距离，相等只在那枚端点已经落在光标线上的时候。把夹具挪开等于把这条用例变成"没有交点的场"，测不到东西。
- 所以正确做法是**改答案 + 加两句素材自证**：端点那一枚仍在表里（它输的是距离不是存在），而 `(0,-760)` 不是任何一面墙的端点（证明改的那对数字判的确实是交点档）。

整条用例（`handles.test.ts` 第 445–502 行，逐字实测绿）替换成：

```ts
  it('探针吃的是吸附后的毫米：前两发被真源挡下，第三发被**轴网交点档**接住', () => {
    // 现场故意造到"前两发（+y / +x）候选全非法、第三发 (0,-800) 的裸落点离一面既成墙 5.66px"，
    // 于是吃场的探针报**吸附之后**那枚毫米，不吃场的探针报裸的 (0,-800) —— 两个答案不同。
    // 2026-09-28 实测这条咬住的改坏：探针传 `EMPTY_SNAP_FIELD`（HB3）与换回 `moveTargetOf`（HB4），
    // 两条各红这条 + 下面那条「合法性判的是吸附后的毫米」。锚点（HB1）与排除（HB2）不在这里判 ——
    // 它们收在 `handleDropTarget` 出口里，改出口会让"拖拽路径真的在吃吸附"与"把手按在原地那一发"
    // 逐进程红（实测 8/8），判在探针调用点上反而漏（那时探针与 renderer 一起改，行为没变）。
    // 判裸落点还是判吸附后（HB5）由下面那条专门咬：这条夹具里裸 (0,-800) 与吸 (0,-760) **两侧都合法**，判不出。
    //
    // **Task 9 改的是"谁接住它"，不是判据。** 这条用例原来吸的是第三面墙的起点 (40,-760)（端点档，
    // 5.66px）；补上轴网交点档之后，同一发光标先撞上 (0,-760) —— 它是"+y 那面墙的轴**延长线** x=0"
    // 与"第三面墙的轴 y=-760"的交点，离裸落点 4px ⇒ 按距离赢下端点档（同一对象组内先比距离）。
    // 端点那一枚并没有消失（下面第一句自证），它只是输了距离。
    // "复用一枚真源点"那半句的凭据不在这条：它住在「把手按在原地那一发」与 `wallProbe` 的筛 ①。
    const projectId = uuidv7();
    const log = new TransactionLog(Document.create(projectId));
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    let storeyId = '';
    for (const id of log.affected) {
      if (log.document.get(id)?.kind === 'storey') storeyId = id;
    }
    if (storeyId === '') throw new TypeError('affected 里没有新建的楼层');
    // 共享 A=(0,0) 的两面墙（+x 与 +y，直角共点 ⇒ 两臂接头，S1 造得成，`sharedBy` 恰为 2）。
    // 两面都取 1040：+y / +x 那两发把其中一面拖成轴长 240，正好撞"墙厚 240 不小于轴长 240"那条守卫。
    log.dispatch(wallCreate({ storeyId, start: { x: 0, y: 0 }, end: { x: 1040, y: 0 }, thicknessMm: 240, heightMm: 3000 }));
    const east = createdWallOf(log);
    log.dispatch(wallCreate({ storeyId, start: { pointId: east.startId }, end: { x: 0, y: 1040 }, thicknessMm: 240, heightMm: 3000 }));
    // 第三发 (0,-800) 的陷阱：一面**与 A 无关**的墙。Task 9 之前起作用的是它的起点 (40,-760)
    // （离裸落点 56.6mm ⇒ 0.1px/mm 下 5.66px，容差 8px 之内的端点档）；Task 9 之后起作用的是
    // 它那条**轴** y=-760 —— 与 x=0 那条延长线交于 (0,-760)，4px。两面都在，谁近谁赢。
    log.dispatch(wallCreate({ storeyId, start: { x: 40, y: -760 }, end: { x: 1040, y: -760 }, thicknessMm: 240, heightMm: 3000 }));
    // 1px = 10mm ⇒ 整数像素与整数毫米逐字往返，红的时候不必先排除舍入
    const v = viewportOf(1000, 800, { pxPerMm: 0.1, center: vec(400, 100) });
    const doc = log.document;
    const fd = snapFieldOf(doc, storeyId);
    // 素材自证一：端点档那一枚仍在表里（它输的是距离，不是存在）—— 摘掉交点档时这一发会退回它
    expect(fd.points.some((q) => q.kind === 'endpoint' && q.mm.x === 40 && q.mm.y === -760)).toBe(true);
    // 素材自证二：(0,-760) 不是任何一面墙的端点 ⇒ 上一句改的那对数字判的确实是交点档
    expect(fd.points.some((q) => q.kind === 'endpoint' && q.mm.x === 0 && q.mm.y === -760)).toBe(false);
    const p = dragProbe(doc, storeyId, buildDrawList(doc, storeyId, v, EMPTY_SELECTION), v);
    expect(p).not.toBeNull();
    expect(p!.sharedBy).toBe(2);
    // 先自证现场：裸落点确实是第三发那一发，而探针给的是**吸上去之后**那枚毫米
    expect(moveTargetOf(v, p!.toPx)).toEqual({ x: 0, y: -800 });
    expect(p!.targetMm).toEqual({ x: 0, y: -760 });
    expect(p!.targetMm).not.toEqual(moveTargetOf(v, p!.toPx));
    // 而合法性判的也是吸附后的毫米：原地那枚既有点把墙拖成的形状必须真的过得了真源那道守卫
    expect(legalDrop(doc, p!.wallId, p!.end, p!.targetMm)).toBe(true);
    expect(legalDrop(doc, p!.wallId, p!.end, { x: 0, y: -800 })).toBe(true); // 两个都合法 ⇒ 上面那句不是巧合
    // 前两发候选全非法是这套夹具的前提，不是假设：逐发当场验一遍（各把一面 1040 的墙拖成轴长 240），
    // 前提漂了这里先红，不会让上面那两句变成猜。
    for (const off of [
      { x: 0, y: 800 },
      { x: 800, y: 0 },
    ]) {
      expect(legalDrop(doc, p!.wallId, p!.end, off)).toBe(false);
    }
  });
```

Run: `npx vitest run --config vitest.config.ts packages/scene-2d`
Expected: **7 文件 / 152 条全绿**（`zz-measure.test.ts` 那条只打印，别把它算进账）。

- [ ] **Step 5: 全量验证 + 实测账**

```bash
npx vitest run --config vitest.config.ts        # 临时工程全量
npx tsc --noEmit -p tsconfig.scene2d.json       # 本任务唯一的形式验证
```

Expected（2026-09-28 实测）：**31 文件 / 461 条全绿** —— core **24 / 309**（一字未动），scene-2d **7 / 152**（viewport 9、drawlist 10、pick 18、**snapping 40**、editing 35、handles 19、panel 21）；`tsc` **exit=0**。相对 Task 8 的 449 净增 **12**（全在 `snapping.test.ts`），⇒ 真仓库预计 **464 → 476**。

**① 表内容账**（`demoHouse()` 一层 vs 一张 61 面墙的栅格层：31 横 `y = i·1000` + 30 竖 `x = i·1000`，全部用坐标字面量建端点 ⇒ 没有接头，那张层只为量规模，不过几何守卫）：

| 读数 | Task 9 前（`.tscheck/t9`） | Task 9 后（`.tscheck/t10`） |
| --- | --- | --- |
| 样例房表 | `16 点 = endpoint 8 + midpoint 8`，`axes 8` | **逐字相同**，`axisCross 0` |
| 样例房求交规模 | —— | `pairTotal 28 → pairs 15 → uniqueRaw 9 → dropped 9 → 进表 0` |
| 61 墙层表 | `183 点 = endpoint 122 + midpoint 61` | `965 点 = endpoint 120 + midpoint 61 + axisCross 784` |
| 61 墙层求交规模 | —— | `pairTotal 1830 → pairs 930 → uniqueRaw 930 → dropped 146 → 进表 784` |

两个数不是巧合，逐字对得上账：样例房那 9 枚格点**全部**已经被端点或中点占住（`dropped = uniqueRaw`）⇒ 交点档对样例房**新增 0 枚靶子**，这就是 R8 那句"闸门不必重测"的算术来源；61 墙层那 `endpoint 122 → 120` 是 R3 换去重键的直接读数（两枚同坐标的孤儿点在坐标键下合并）。

**② 规模与成本**（同一次 `npx vitest run` 里 `while (performance.now() - t0 < 250)` 的循环读数，取三次独立进程的区间）：

| 读数 | Task 9 前 | Task 9 后 |
| --- | --- | --- |
| 样例房建一次场 | 0.0029 ~ 0.0032 ms | **0.0081 ms** |
| 样例房一次 `dropTargetOf`（16 枚候选的场） | —— | **0.0010 ms** |
| 61 墙层建一次场 | 0.0208 ~ 0.0219 ms | **0.233 ~ 0.254 ms** |
| 61 墙层一次取最优（965 枚候选） | 0.0087 ~ 0.0092 ms | **0.029 ~ 0.032 ms** |
| 61 墙层"每发 pointermove 重建场"（错误用法的形状） | 0.030 ~ 0.032 ms | **0.264 ~ 0.273 ms** |

⇒ 帧预算 16.7ms 下最坏那一格占 **1.6%**，而 renderer 走的是"每帧一次（paint effect）"而不是"每发一次"（`fieldRef` 那条既有纪律，T6 裁决 ①）。R7 的账就是这么来的。

**③ 探针与 sweep 的集合比对**（把同一份 `zz-measure.test.ts` 分别压进 t9 与 t10，各跑独立进程，比**打印出来的值**）：

| 读数 | 结果 |
| --- | --- |
| 样例房场表 / `crosses` | 6 个进程（t9×3 + t10×3）**逐字相同**：`{endpoint:8, midpoint:8, axes:8}` + `[]` |
| `handles` sweep 160 发 | 6 进程逐字相同：`{handles:16, identity:72, rewritten:14, rewriteKinds:{angle15:14}, hitKinds:{foot:54, ortho:17, angle15:14, midpoint:1}, maxShiftPx:6.97}` |
| `dragProbe` | 6 进程逐字相同：`{toPx:{700,825}, targetMm:{4800,0}, sharedBy:3}` ⇒ `--edit-shot` 的字面量不必动 |
| `wallProbe` | **两边都不是单值**：t9 九个独立进程 `(800,3000)` 4 次 / `(4000,3000)` 5 次，t10 十一个进程 5 次 / 6 次 ⇒ 候选**集合** `{(800,3000)→(800,5000), (4000,3000)→(4000,5000)}` 两边相同，二十个进程里没有第三枚 |

`wallProbe` 那一行**不是本任务引入的**：它就是 T6 记在"已核实的现状事实"里那条「探针选中的**起点会跨进程漂**」（`snapFieldOf` 的端点表顺序来自 `doc.byKind('wall')`，按 uuidv7 id 升序，而同毫秒不单调）。所以"探针答案没移动"这条判据**只能按集合写、不能按单值写** —— 编写期本节此处原先那句"探针的恒等/改写计数与闸门字面量会再变一轮"就是拿单值当判据的结果，实测推翻（计数与字面量都没变，理由见 R8）。

- [ ] **Step 6: 改坏验证（九条变异，逐条记下红的是哪几条）**

每条 = 摘掉一处实现 → 跑全量 → 记红名 → 还原。命令形状（在 `.tscheck/t10` 根上跑）：

```bash
cp packages/scene-2d/src/snapping.ts /tmp/snap.bak
perl -0pi -e 's/  axisCross: 3,/  axisCross: 0,/' packages/scene-2d/src/snapping.ts
npx vitest run --config vitest.config.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "^ +Tests |× "
cp /tmp/snap.bak packages/scene-2d/src/snapping.ts
```

（Task 8 那条"命令替换里必须剥 ANSI"的教训这里照用，一句 `sed` 不能省。九条用同一个模式串，逐条列出在下面的表里。）

| # | 摘掉什么 | 实测红 | 红的是哪几条（逐字用例名） |
| --- | --- | --- | --- |
| N1 | 整段交点档（把 `snapFieldOf` 末尾那行 `for (const cross of axisCrossPoints(axes, points)) points.push(cross);` 摘掉） | 5 / 149 | 「两墙不相接、轴延长线上相交 ⇒ 交点档给得出唯一靶子，且它是新建点不是复用」「垂足档压过交点档：三轴共点且其中一轴的墙段真的穿过该点 ⇒ 赢的是 foot」「属性：交点档命中时恒整数毫米、恒不给 pointId、恒在容差内，且答案恒来自表里那一枚」「平行与共线都不求交；共线的三段横轴对同一根竖轴只留一枚交点」**+ `handles.test.ts` 的**「探针吃的是吸附后的毫米：前两发被真源挡下，第三发被**轴网交点档**接住」 |
| N2 | `PRIORITY.axisCross` 从 3 改 0（交点与端点同优先级） | 1 / 153 | 「垂足档压过交点档」（**只**这一条 ⇒ R4 那一格的全部牙齿就住在这里） |
| N3 | 规则 ③：交点不再与既有表去重（`const taken = new Set(existing.map(...))` 换成 `new Set<string>()`） | 3 / 151 | 「交点与既有端点同坐标 ⇒ 不重复入表」「样例房一枚交点档独有的靶子都没有」「端点集 = 本层墙端点 ∪ 柱心 ∪ 板角 的坐标去重集（全量对账，多一枚少一枚都红）」 |
| N4 | 规则 ②：交点之间不按坐标去重（摘掉 `axisCrossPoints` 里的 `if (taken.has(key)) continue;`） | 4 / 150 | 「交点与既有端点同坐标 ⇒ 不重复入表」「平行与共线都不求交；共线的三段横轴对同一根竖轴只留一枚交点」「样例房一枚交点档独有的靶子都没有」「端点集 … （全量对账）」 |
| N5 | 柱心那一段循环摘掉（`for (const column of doc.byKind('column'))` → `for (const column of [])`） | 3 / 151 | 「柱心在表里：吸上去复用柱引用的那枚点」「别层的柱与板一枚都不进本层表」「端点集 … （全量对账）」 |
| N6 | 板角那一段循环摘掉（同上，换成 `of []`） | 3 / 151 | 「板角四枚全在表里，逐枚 pointId 指向真源那个顶点」「别层的柱与板一枚都不进本层表」「端点集 … （全量对账）」 |
| N7 | 柱与板的 `storeyId` 过滤摘掉（两处 `if (x.storeyId !== storeyId) continue;`） | 1 / 153 | 「别层的柱与板一枚都不进本层表（上下层同位置是建筑常态，不是边角）」 |
| N8 | 去重键换回 `pointId`（Step 3 ④ 那一处与柱/板两段的模板串键全改成 `pointId` / `column.pointId`） | 1 / 153 | 「柱用坐标字面量落在墙端点上 ⇒ 墙的那枚点赢，孤儿点抢不走（去重键是坐标而不是 id）」—— **R3 的唯一见证** |
| N9 | 交点带上一枚真源点 id（`pointId: null` → `pointId: a.ownerId`） | 2 / 152 | 「两墙不相接、轴延长线上相交 … 且它是新建点不是复用」「属性：交点档命中时恒整数毫米、恒不给 pointId …」 |

**这张表差点记错两次**（都是当场踩到的，写在这里防执行日照抄）：

1. **N1 的"摘掉调用行"不能顺手连函数一起删**。只摘调用行时 `npx tsc --noEmit -p tsconfig.scene2d.json` 给 `snapping.ts(283,10): error TS6133: 'axisCrossPoints' is declared but its value is never read.`（2026-09-28 实测，exit=1）—— 那是 `noUnusedLocals` 的编译期红，与"实现被摘掉"是两件事。变异只摘调用，函数留在原地，红才落在断言上。
2. **变异脚本崩在打印那一行，会把实现留在改坏状态**。这一轮真踩了：第一版驱动在 Windows 的 GBK 控制台上 `print` 用例名直接抛 `UnicodeEncodeError`，`finally` 没写，于是 N1 的 `// removed` 与 N2 的 `axisCross: 0` 留在盘上；第二次跑时 N1 那行锚点已经找不到（报 `ANCHOR-FAIL`），而 N2 那行测的其实是 **N1+N2 叠加** —— 数字看着像，红的名字少了两条。所以：驱动必须 `try/finally` 还原 + `ORIG` 只在开头读一次 + **跑完再验一遍全绿**（本轮最后那条"还原后 8 文件 / 154 条"就是这么出来的）。控制台上打印中文要 `sys.stdout.reconfigure(encoding='utf-8', errors='replace')`，或者只往 utf-8 文件里写。

- [ ] **Step 7: 落回真仓库 —— 四个文件、九条变异复跑、五个闸门**

```bash
# 1) 把临时工程里实测过的文件逐字搬回真仓库。本任务动的是四个文件，全在 packages/scene-2d 下：
#    src/snapping.ts（380 → 501 行）、src/editing.ts（516 → 517 行，只有 Step 3 ⑥ 那一处注释）、
#    test/snapping.test.ts（追加 12 条）、test/handles.test.ts（改写 1 条）。
#    ⚠ 临时工程里的 zz-measure.test.ts 与那张 61 面墙的栅格夹具**不带回真仓库**（它没有断言，
#      带回去等于给真仓库塞一条"永远绿"的用例 —— 边界段那条纪律在这儿照样生效）。
#    ⚠ index.ts 与 apps/desktop/** 一字不动 ⇒ 本任务只有一个提交，没有第二个。
npx tsc --noEmit -p packages/scene-2d/tsconfig.json
pnpm verify
```

Expected: `pnpm verify` exit=0；`Tests` 从 Task 8 落地的 **464** 涨到 **476**（净增 **12**，全部落在 `snapping.test.ts` 28 → 40；`handles.test.ts` 改写一条不涨数）；`Test Files` **一字不动**（本任务不新建任何测试文件）。core 的 `24 文件 / 309 条` 一字不动 —— 若这一步发现还得改 core（比如想给 `SnapKind` 加一个 core 侧的轴网实体），按边界段那条纪律：那是计划 4 的活，回计划 2/4，不在这里补。

```bash
# 2) Step 6 那九条变异在真仓库原样复跑（同九条模式串、同一条剥色管道、同一个 try/finally 还原）
# 3) 五个闸门各跑一遍，判据一个字都不改
pnpm shot        # 6 条
pnpm pick-shot   # 11 条（Task 8 实测订正：编写期写 10）
pnpm edit-shot   # 21 条
pnpm draw-shot   # 28 条
pnpm prop-shot   # 29 条（Task 8 实测回填：6 条共用 + 23 条面板行）
```

Expected: **五个闸门的判据逐字不变、且全都 PASS** —— 这不是"大概不受影响"，是 Step 5 那六进程实测出来的：样例房一层的场表 `{endpoint:8, midpoint:8, axes:8}`、sweep 计数、`dragProbe` 的落点在补档前后**逐字相同**，交点档对样例房进表 **0** 枚（28 对 → 15 不平行 → 9 枚去重坐标 → 9 枚全被端点/中点占住），而样例房无柱无板 ⇒ 柱心/板角两段循环对它空转（T5 已核实那条）。

**如果某个闸门在这里红了**，按这个顺序查，别先改判据：

1. 先查 `demoHouse()` 是不是被谁加了柱或板、或者把格网布局改成了非格网（那 9 枚格点一旦有漏网的，交点档就在屏幕上有了靶子，`--draw-shot` 的落点字面量会跟着动）。这一发的护栏就是「样例房一枚交点档独有的靶子都没有」那条用例 —— 它在 node 侧先红，屏幕侧的红只是回声。
2. 再查 `wallProbe` 的起点枚举是不是被顺手改成了 `!== 'midpoint'` 之类（R2 那条"探针挑不上的档屏幕上也不吸"）。
3. 最后才怀疑字面量。真到要换的那一步，按 Task 7 Step 8 那句处理：读新靶子、换字面量、**重跑三遍确认稳定** —— 本任务把"跨进程漂"的形状写进了 Step 5 ③，`wallProbe` 那一发有 `(800,3000)` 与 `(4000,3000)` 两枚候选，二十个进程里没有第三枚；如果第四遍跳出第三枚，那才是真回归。

- [ ] **Step 8: 提交与交接**

```bash
git status --porcelain   # 只应看到 packages/scene-2d/src/{snapping,editing}.ts 与 packages/scene-2d/test/{snapping,handles}.test.ts 四条
git add packages/scene-2d/src packages/scene-2d/test
git commit -m "feat(scene-2d): 吸附补上轴网交点档，柱心与板角进吸附场"
```

提交信息正文带上三件事：① 交点档按**无限直线**求交（线段交点本来就有靶子，这一档独有的东西在延长线上）；② 端点档的去重键从 `pointId` 换成坐标（`resolvePointRef` 对坐标字面量恒返回 null ⇒ 柱/板带进来同坐标孤儿点，按 id 去重会让赢家跨进程漂）；③ T6 注释里那句"洞口中心 Task 9 补"**判掉**而不是兑现，理由三条写在 `snapFieldOf` 的注释里。

**交接账**（这个任务做完，计划 3 的账本长这样）：

- Task 1–9 **全部展开、全部实测**；计划 3 至此没有"边界未展开"的格子，末尾那一节已是交接说明（`## 任务边界与交接`）。
- node 侧：临时工程 `.tscheck/t10` = **31 文件 / 461 条**（core 24/309 + scene-2d 7/152），`tsc` exit=0；相对 Task 8 的 449 净增 12 ⇒ 真仓库预计 **464 → 476**。
- 屏幕侧：**零改动**。`apps/desktop` 一行没碰、五个闸门一条判据没改。本任务的屏幕证据是"闸门重跑仍 PASS"，不是"新画了什么"。
- 下一步是**执行**：从 Task 1 起（真仓库的 `packages/scene-2d/src/index.ts` 到这里仍是一行 stub），四个真窗口闸门与 `--prop-shot` 里所有写死的像素/毫米数字面量在真窗口跑过之后回填实测红字。
- 计划 4（洞口/柱/板编辑上屏 + 读盘）继承本任务两条欠账：① `SnapPointKind` 里那个名字叫 `'endpoint'` 却含柱心与板角（R2 的代价）；② 洞口边界的两个端点进吸附场 —— R6 判掉的是"洞口**中心**"，不是"对齐门洞边"这个需求本身。

#### 执行回填（Task 9，2026-09-30 实测；实现 `e6682a2` + fix 轮 `79b84d3` / `24982a4` / `2a9f9a9`）

**落地形状**：**一笔提交**，三个文件 +470/−18（`snapping.ts` +164、`snapping.test.ts` +320、`editing.ts` 一行注释）。实现棒在**第 150 轮天花板中止、零提交**（报告与全部日志已落盘），控制位接手做三件事才敢提交：① `md5sum` 对账 —— 树上 `snapping.ts` = `192d305df7615197449feb6a219c8988`（报告声明的"订正注释之后终态"），变异期备份 `tmp/snapping.final.bak` = `2a90defcf96a72114bca3c2c57441d86` ⇒ **没有未还原的变异残留在树上**；② **自己复跑一条变异**（N2：`PRIORITY.axisCross` 3 → 0）⇒ 恰好 1 条红，红名逐字「垂足档压过交点档：三轴共点且其中一轴的墙段真的穿过该点 ⇒ 赢的是 foot」，与报告一致；③ 自己跑 `pnpm verify` = exit=0 / 34 文件 / **494** 条。BASE = `3c6ce05`；**工作树已在 `main`**（用户本人把单检出切到 `main` 并推了上去），所以本节 Step 8 那句"合到主分支"在本任务**不发生** —— 只剩用户自己的 push。

- **计数账（盘上真话，覆盖上面那条「464 → 476」）**：全量 **482 → 494**，`Test Files` 34 **一字不动**（本任务不新建测试文件）。文件级：`snapping.test.ts` **32 → 44**（净增 12 这件事与正文一致，起点不是 28）、`handles.test.ts` **33 条不变**（正文写 19）、`editing.test.ts` 35 条不变（只改注释）、core **25 文件 / 316 条**一字未动（正文那两处 `24 / 309` 是计划 2 的旧账）。⇒ 正文 Files 表与「交接账」里凡是引用 `.tscheck/t10`（31 文件 / 461 条）的那几段全是**临时工程的账**：本任务按 Task 8 的裁决 T8-1 **放弃那一轨**，Step 1（`cp -a .tscheck/t9 .tscheck/t10`）与 Step 8（"逐字搬回三个文件"）都没执行。
- **五个真窗口闸门：判据 6/11/21/28/29 一字未改、写死的字面量一个未换、全部 PASS** ⇒ R8 那句"不必改判据"**成立**，且是结构性的（样例房无柱无板 ⇒ 柱心/板角两段循环空转；8 根轴两两求交那 9 枚格点逐枚已被端点/中点占住 ⇒ 交点档进表 **0** 枚）。两处首跑红要按本计划的老规矩分开记：
  1. `--draw-shot` run1 **崩在第 3 步的 `waitUntil`**（10 秒天花板，`exit 1`，无判据打印），不是判据红；复跑 4/4 全绿。同族超时在 Task 5~8 已有记录（`grep -l "10 秒内没等到"` 命中 `dr4/dr7/r7/gate-draw-shot-run6-fallbackprobe/t8D4-edit-shot-run1/t8E-prop-run2~3`）。
  2. `--prop-shot` run1 **P7 / P20 两条真红**（实测 30747 / `opening` 层 10→7，判据 30744 / 10→8）。按 Step 7 那三步查：`git diff` 里 core 与样例房零改动 ⇒ 排除第 1 步；根因是**探针起点枚举**（第 2 步）—— `propProbe` 挑"第一档改得动且身上有洞口"的墙，谁被挑中由 uuidv7 现建 id 定，run1 挑到 8000 长那面横墙（身上三樘洞口 ⇒ 级联删 3），run2~5 全回到 Task 8 写死判据时那面 6000 长墙。**判据与字面量都没动**（第 3 步没走到）。
- **三处「计划 vs 盘上」，逐条**：
  1. **`absorbedByPoint` 的档位过滤 = 计划漏列的第五处改动**（`snapping.ts:202-206`，只吸收 `endpoint` / `midpoint`）。不改它，交点档会因 `takeBest` **组内先比距离**（`snapping.ts:387-396`：`GROUP` → `distPx` → `PRIORITY` → `ownerId`）吃掉落在墙段内部的**垂足** —— 垂足优先级 2 输给交点 3 反而没意义，spec §6 那张表里"贴到墙上"那一档永远输给一个坐标，R4 当场作废。代价：R4 那句"垂足在具名点旁被吸收"的既有语义从此**只作用在真源点与中点上**，这条新边界由一句注释 + 用例「垂足档压过交点档」+ 变异 **X1**（放开过滤 ⇒ 恰好 1 条红）看着。
  2. **Step 4 落空**：盘上 `handles.test.ts:537` 那条在 Task 8 就已经换过靶子（现题「…第三发被一枚**垂足**接住」），正文引用的那份夹具（`start {x:40,y:-760}`、答案 `(40,-760)` → `(0,-760)`）**在盘上不存在**；几何上也改不动：那套轴只造得出**一枚**交点候选 `(40,0)`，离第三发的裸落点 (0,-800) 约 801mm ⇒ 在 0.1px/mm 那把尺子上是 **80px** ≫ `SNAP_TOL_PX = 8`。**实测**：改动前后 `handles` 都是 33 条全绿 ⇒ 落点没变，无改写对象。⇒ 连带代价：N1 的红名从正文预言的 **5 条变 4 条**，「摘掉交点档 ⇒ 句柄侧也红」这条连带关系**不存在了**（新档的凭据全在本文件内）。判据强度一行未放宽。
  3. **R9 后半句（交点候选的 `ownerId` 取该对里 id 较小那面墙）没有机械凭据**：交点档按坐标去重 ⇒ 表里不可能出现两枚同坐标候选，而 `ownerId` 不进任何屏幕读数。用例只判到"它是本层某面墙的 id"。认下来挂在遗留，不补夹具。
- **变异表（N1~N9 逐字照正文 + 自补 X1；驱动纪律：`ORIG` 只在开头读一次 md5，每条 `try/finally` 还原并复验，锚点命中 0 次当场 `ANCHOR-FAIL` 且不动盘）**：N1 **4 条**（正文 5 条 ⇒ 见上面第 2 条）、N2 **1**、N3 **3**、N4 **4**、N5 **3**、N6 **3**、N7 **1**、N8 **1**、N9 **2**、X1 **1**；跑完全量复验 exit=0 / 494 / 34。**N8 首轮 `ANCHOR-FAIL`**：驱动里那条锚点串多写两个空格（盘上第 281 行是四空格缩进的 `const point = requirePoint(doc, column.pointId, '吸附柱心');`）⇒ 命中 0 次当场抛、盘未动（还原 md5 对账 OK），按锚点订正后单跑，红名与预言逐字一致。
- **转下游 / 仍未收掉的**：① `--prop-shot` 的 **P7 / P20 是"跟着探针挑中哪面墙走"的字面量**（Task 8 落地后 13 次读数 1 次漂）⇒ 要么把这两格改成**与靶子同源自洽**（`nonBlankAtSelect` / `openingOpsAfterDelete` 跟 `prop.wallId` 一起判），要么在 `propProbe` 里钉死起点枚举；本任务两条都没动，判据一字未改。② `axisCrossPoints` 是"读墙轴线"这一档的**唯一入口**，真上轴网实体（计划 4）时只改它。③ 表长度 O(墙²)：复测过的数（61 面墙的完整格网 1830 对 ⇒ 进表 784 枚、`snapFieldOf` 200 次 p50 **0.231ms**）记在注释里；场只在按下那一发建（`fieldRef` 的 T6 纪律），不落在每帧。④ 正文原有的两条（`'endpoint'` 的名字含柱心板角、"对齐门洞边"要洞口两个端点）原样交计划 4。
- **listing 与盘上不符（本任务新犯的一条要记账）**：Step 8 那句「`git status --porcelain` 只应看到**四条**」把 `handles.test.ts` 算在内 ⇒ 盘上只有**三条**（Step 4 落空）。另：`.gitignore` 里只有 `*.log` 与 `.tscheck/`，**`tmp/` 没被忽略** ⇒ 棒把非 `.log` 的 scratch（`brief-block.txt` / `file-block.txt` / `snapping.final.bak`）写进 `tmp/` 会脏 `git status`，控制位已把整目录搬进本计划的 SDD 工作区（`t9-tmp/`）；**以后派发词要点名日志与 scratch 一律写 SDD 目录**，别再写 `tmp/`。
- **评审与 fix 轮（2026-09-30，同一任务的第二笔代码提交）**：评审席（`task-9-review.md`）判 **PASS WITH FINDINGS ⇒ 0 P0 / 2 P1 / 4 P2**。
  1. **P1-1（句柄/落点出口零确定性见证）已由修复棒补上**：`79b84d3 test(scene-2d): 给 axisCross 补句柄/落点出口的确定性见证 + 清过期注释`（4 文件 +103/−7：`handles.test.ts` +87 = 新夹具 `wallsForCrossSnap()` + 一条用例；`snapping.ts` 四处**纯注释**；`snapping.test.ts` 去重键与牙齿归因的注释 + 一句 `kindsAt(fd, 3000, 0)` 断言；`handles.ts` 把写死的"31 条"换成关系式措辞）。控制位再补两笔注释收尾：`24982a4`（同一行里剩下的"五趟/抄五遍"）、`2a9f9a9`（复审 P2：那句"否则被吸收的是端点/中点"主宾写反，吸收者恒为端点/中点、被吸的是现造垂足；并列候选从"两枚"订正为"两垂足 + 一交点"）。
  2. **上面第 2 条（Step 4 落空 ⇒ N1 红名 5 → 4）已被这一轮翻回来**：摘掉 `snapping.ts:309` 那行调用 ⇒ `handles.test.ts` **恰好 1 红、红的就是新用例**（修复棒与复审席**各亲手跑一遍**，红名逐字「句柄出口那一格被轴网交点档接住：第三发裸落点 (0,-800) 吸到唯一一枚交点 (0,-760)」），scene-2d 全量红名 **5** 条 = N1 那 4 条 snapping + 这条 ⇒ "摘掉交点档 ⇒ 句柄侧也红"这条连带关系重新在盘上存在。**补的是新用例**：`wallsForProbeSnap` 那份 Task 8 的垂足靶子一字未改。复审席另跑 5 次重发：`handles.test.ts` 次次 34 绿，且被断言的四个量（`raw=(0,-800)`、`drop.mm=(0,-760)`、`snap.kind='axisCross'`、`targetMm=(0,-760)`）**跨进程恒等** —— 漂移只在没断言的 `p.wallId`/`p.end` 上（两臂同 A、等价），判据未放宽成"任一发"。
  3. **计数账（覆盖上面的 494）**：`handles.test.ts` **33 → 34**、`snapping.test.ts` **44 不变**、全量 **494 → 495**、`Test Files` **34 不动**、core **25 / 316 未动**。修复棒与复审席各自复跑 `pnpm verify` = exit=0 / 34 / 495。
  4. **真窗口五个闸门在 fix 轮未跑**（node 侧测试 + 注释 ⇒ 屏幕零改动），`--*-shot` 判据与字面量一字未动。评审席的 **P1-2（`--prop-shot` 的 P7 / P20 跟着探针挑中哪面墙走，且 FAIL 文案把判据值印成"实测"）判给 prop-shot 判据属主**（Task 8 那笔账），**不在本计划修** ⇒ 与上面"转下游"第 ① 条是同一格，位置在 `scripts/desktop-shot.mjs:231-232`、`:280-281`，转计划 4。
  5. 评审席对上一轮三处偏差的裁定：**`absorbedByPoint` 那处计划外改动判"必须做、因果成立、没顺手改掉既有语义"**（R4 在真源点与中点附近逐字不变）；**Step 4 落空判"真落空、不是回避"**，但把"补不上"改判为"**补得上、该补而没补**"⇒ 这才是 P1-1 的根据；`snapping.ts:399` 那簇"五档"注释与 `handles.ts:417` 的"31 条"读数都判 P2（后者实质判断仍成立：那里的"五档"指属性面板素材候选，与吸附第六档无关）。

---

## 任务边界与交接（Task 1–9 已全部展开；下一格是执行）

Task 6 已展开（正文见上文 Task 6：八条裁决 + 八步 + 二十八行真窗口判据）。它把 T5 留下的两个接缝就地判掉了：① 吸附的插入点 = `moveTargetOf` 之后、`dispatch` 之前那一行（S4 的三条纪律：按下不吸、探针与 renderer 同一个出口、预览线恒画裸光标）；② "撤销掉正被选中的构件"拆成两半收掉 —— 删除之后用 `pruneSelection` + `selectionStore.retain` 剪掉已不存在的 id（S5），新建那一路用 `lastCreatedWall` 里的 `doc.get(id)` 复核挡住"选中指向不存在的构件"（S6：`log.affected` 在撤销后**仍然**列着那枚 id）。**没收掉的那一半**写在这里防丢：`Ctrl+Z` 撤销一次删除之后选中集不回（D7 的口径是"撤销的是文档，不是视图"）；Task 7 与 Task 8 都没接这一条，谁要做"撤销后恢复选中"，得回来改这条裁决。

Task 7 已展开（正文见上文 Task 7：四条裁决 + 八步 + 十五条改坏）。它收掉了 T6 交接四条里的 ③（`legalDrop` / `legalWallCreate` 与真源同判，差额在 core 侧补齐）与 ④（探针候选集合的实测差额：拉墙 80 发拒 48、拖把手 160 发拒 84，"第一发过 `build`"在 8 枚端点里挪了 **5** 枚、16 把把手里挪了 **12** 把，而"第一发 `build` 与派生都过"那张表两侧逐字相同）；**① 与 ② 原样交接给 Task 8**。T7 没动屏幕上的任何一行逻辑代码 —— scene-2d 侧只改 `editing.ts` 的三处注释、改写七条既有用例、删掉一个没人读的助手（见 T7 的"本任务会改到的既有写法"第 4、6、7 条与 Step 6）。

**为什么原来那一节"Task 7"拆成了 T7 + T8**：本节此处原先写的是"Task 7 楼层切换 + 属性面板：需要内核补口……补口放 Task 7 的第一步"。展开时把补口独立成一个任务，因为它改的是**每一条改几何命令的返回值**，`--draw-shot` 与 `--edit-shot` 两个闸门里写死的毫米/像素字面量必须跟着重测；和属性面板混在一节里重测，红了分不清是命令层还是面板。代价是本计划的既有编号整体后移一位 —— 已按新口径订正的地方：本节上一段、`snapping.ts` 里"柱/板的顶点不在表里"那句注释（原写 Task 8，现写 Task 9）、以及"本计划展开了 Task 1–7"那句状态行。

Task 8 已展开（正文见上文 Task 8：九条裁决 + 八步 + 九条变异逐条红名）。它接住了 T6 交接四条里的 **②**（筛 ⑤/⑥ 的两枚确定性夹具，Step 4）与 **①**（`MIN_WALL_LENGTH_MM` 与输入框第一次分家，裁决 P5 用 `panel.test.ts` 那条实测钉死）；T7 交接的 ①② 那两条（`planDelete` 的 `unsupported` 分支、面板的合法性预言）也一并收掉。**没收掉的仍然写在这里防丢**：`Ctrl+Z` 撤销一次删除之后**选中集不回**（D7 的口径"撤销的是文档，不是视图"，Task 8 的 `--prop-shot` 第 13 步第一次把它钉成预期行为而不是缺陷，但"撤销后恢复选中"仍没人做 —— 谁要做，得回来改 Task 6 那句裁决）；面板的**多选批量改厚**（P3 现在的形状是"多选就整块不显示"）；材料候选集的**按构件分表**（P4 的代价那条：柱 / 板 / 门窗将来各列一张，不许互借）。
- **Task 9 吸附补档：已展开**（正文见上文 Task 9：九条裁决 R1~R9 + 八步 + 九条变异逐条红名）。它兑现了 T6 注释里那句「柱/板的顶点……不在表里：Task 9 的补档要加时改这里」，并把同一句里承诺的「洞口中心」**判掉而不是兑现**（三条理由在 `snapFieldOf` 的注释里，裁决 R6）。
  **本节此处原先预言的两个副作用，实测都不成立**（2026-09-28，`.tscheck/t10` 六进程）：① 交点档对样例房进表 **0** 枚 —— 28 对轴 → 15 对不平行 → 去重得 9 枚坐标 → 9 枚逐枚已落在端点或中点上；而样例房无柱无板 ⇒ 柱心/板角两段循环对它空转。于是场表 `{endpoint:8, midpoint:8, axes:8}`、sweep 那 160 发的计数、`dragProbe` 的落点**逐字相同**，`--draw-shot` / `--edit-shot` 的字面量一条都不必换（凭据见 Step 5 ③）。② Task 8 那两枚确定性夹具的端点枚举表**没变**，那四个数（`pxPerMm` / 尺寸 / 中心 / 期望答案）不必重算 —— 夹具是合成层、样例房无柱无板，交点档在两者里都造不出独有靶子。真被改写的既有用例只有**一条**：`handles.test.ts` 的「探针吃的是吸附后的毫米」，答案 `(40,-760)` → `(0,-760)`，判据那三件事一件没少、还加了两句素材自证（Step 4）。
  **没收掉的写在这里防丢**：① 新档在**真窗口**上仍然零见证（fix1 之后 node 侧有两层：吸附层 `snapFromCursor` + 句柄/落点出口 `handleDropTarget`，凭据全在合成夹具里），护栏是「样例房一枚交点档独有的靶子都没有」那条用例 —— 谁往 `demoHouse()` 加柱加板或改成非格网布局，它会红，红了就要回来重测这五个闸门；② `SnapPointKind` 里那个名字叫 `'endpoint'`、实际含柱心与板角（R2 的代价：改名要动 `wallProbe` 的起点枚举与三个闸门的字面量）；③「对齐门洞边」要的是洞口的两个端点进吸附场，属计划 4 —— R6 判掉的只是洞口**中心**，不是这个需求本身。

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
- （T4 加）`webContents.sendInputEvent({ type: 'mouseDown' | 'mouseUp', x, y })` 的坐标是相对页面的 DIP；T3 的画布是 1 canvas px = 1 CSS px（刻意没做 DPR 缩放），所以它与 `DrawOp` 的像素、与 `event.nativeEvent.offsetX/offsetY` 同一单位。这句话在 2026-09-27 只由文档确认，**运行时凭据是 `--pick-shot` 的十一行 PASS**（Task 4 的回填记作 11 行：正文那张十行表 + 新增的原点行）。
- （T5 加）`webContents.sendInputEvent` 在 Electron 44 自带的 `electron.d.ts` 里有一条原文注记：**"The `BrowserWindow` containing the contents needs to be focused for `sendInputEvent()` to work."** 所以每条发合成输入的路径都要先 `win.focus()` + `win.webContents.focus()`（Step 6 的 `focusForInput`）。同一份 `.d.ts` 里 `InputEvent.type` 的联合明列 `mouseMove` 与 `pointerDown`/`pointerUp`/`pointerMove`，`KeyboardInputEvent` 则是 `keyCode: string`（必填，取 Accelerator 键名）+ `type: 'rawKeyDown' | 'keyDown' | 'keyUp' | 'char'` + 继承来的 `modifiers: Array<'shift' | 'control' | 'ctrl' | ...>` —— **`modifiers` 里没有 `'meta'` 之外的 Windows 键，`ctrl` 与 `control` 同义**，Step 6 用 `'ctrl'`。
- （T5 加）`TransactionLog` 的 `get depth()` 就是 `undoStack.length`：`undo()` 会**减一**、`redo()` 加一、`dispatch()` 加一并**清空 redo 栈**。所以"撤销后回到 `depthAtStart`、重做后回到 `depthAtStart + 1`"是同一句事实的两种说法，`--edit-shot` 的两条 depth 判据不是重复劳动。
- （T5 加）`wallMoveEndpoint.build` 里"端点与另一端重合"那条是**逐字坐标相等**（`anchor.x === x && anchor.y === y`），紧跟其后的才是"墙厚不小于轴长"。取整像素反算回来的毫米几乎不可能与锚点逐字相同 ⇒ 压扁拖撞到的是**后一条**。所以 Step 6 的正则是 `/轴长|零长/`，写死"零长墙"会变成一条随取整方向随机红的判据。
- （T5 加）`quantizeMm` 对非有限值抛 `RangeError`、对 `-0` 归一成 `0` —— 这就是 `moveTargetOf` 不必自己防 NaN、而 `pointerPx` 必须在最上游拦掉非有限坐标的原因：拦在入口，命令层才有希望拿到一对正经毫米。
- （T5 加）`applyPatch` 只重建补丁里出现的实体，**未触及的实体保持对象同一性**（`doc.get(id) === 原对象`）。G1"柱跟走"那条的 `expect(log.document.get(column.id)).toBe(column)` 就是踩在这条契约上：跟走 = 柱实体一个字节都没动、动的只是它引用的那枚点。若哪天 `applyPatch` 改成"整份文档重建"，那句 `toBe` 会红，届时把 G1 换成 `toEqual` 并在这里补一句新的依据 —— 别让它静默退化成一条测不出东西的断言。
- （T5 加）`assertSimpleRing` 只在 `slabCreate` 的 `build` 里跑一次（`commands/slab.ts`），派生层不再复核 ⇒ 拖动挂板楼层的共享端点**可以**把已存在的楼板轮廓拖成自相交或 180° 折回，而且没有任何一条判据会红。`demoHouse()` 无柱无板，所以本任务的判据碰不到它；这条与计划 4 的读盘不变式（挂账 #5、#12）一起处理，不在 T5 里偷偷补。
- （T5 加）`demoHouse()` 一层有六枚共享端点（四个角 + 拐角 (4000,0) + 中段 (4000,3000)），且**无柱无板** ⇒ 重影柱那批用例必须自己 `columnCreate`，探针也绝不能指望样例里有柱。
- （T5 加）全仓此前**没有**一条用例钉过"同层同坐标已有柱"这条 `RangeError` 的完整文案（`commands-column-slab.test.ts` 只用了 `/已有柱/` 的部分匹配）⇒ Step 1 把判据搬进 `assertNoGhostColumn` 时，G2 是这条文案第一次被逐字钉住，搬完必须回去确认老用例仍过（它匹配的是子串，搬动不影响）。
- （T6 加）样例房一层拟合视图实测 **`pxPerMm = 0.125`** ⇒ `SNAP_TOL_PX = 8` 在这一档等于 **64mm**，而 `MIN_PICK_EDGE_PX = 64` 换算回毫米是 512mm、加回墙厚 752mm —— 这就是 `MIN_WALL_LENGTH_MM = 500` 在现有夹具里被像素下限**完全罩住**（改坏 E17 八进程一条都不红）的算术来源。同一档比例下 `--draw-shot` 的第四色判据只能判"吸上了没有"，不能判"吸到了哪里"（S8）。
- （T6 加）`WALL_PROBE_OFFSETS` 那十发偏移 × 探针选中的起点，逐发问一遍 `dropTargetOf`（2026-09-28 实测）：**十发全部命中方向档、`distPx` 逐字为 `0`**，档位分布 `ortho` 1 / `angle15` 4 / `foot` 3 / `endpoint` 1 / `midpoint` 1。理由是构造性的：偏移全是轴对齐或 45°，而 S3 的档位互斥把四条轴整档给正交、45° 整档留给 15°。所以 `snapMarkPx > 0` 不靠运气。
- （T6 加）探针选中的**起点会跨进程漂**：同一份 `demoHouse()` 连开十个进程，9 次挑中 `(4000,3000)`、1 次挑中 `(800,3000)`（`snapFieldOf` 的端点表顺序来自 `doc.byKind('wall')`，按 uuidv7 的 id 升序，而同毫秒不单调）。⇒ `--draw-shot` 只许把第 0 步算出的那份 `probeJson` 存下来、在第 15 步与**它自己**对账，**不许**把档位名、起点毫米或任何一次实测值写死进判据；单元侧凡是"必须换下一个候选"的判据都自带合成夹具（Task 6 Step 4 开头第 ③ 条）。
- （T6 加）`log.affected` 在 `undo()` 之后**仍然列着**被撤销实体的 id（`undo()` 把 `lastAffected` 设成**前向补丁**的 id 集），而那时 `doc.get(id)` 已经是 `undefined` ⇒ "新建即选中"若不复核文档就会指向一个不存在的构件。这条既是 S6 那句"读完立刻 `doc.get` 复核"的来源，也是 `editing.test.ts` 里「派发后拿得到；撤销后 affected 仍列着那枚 id，但答案必须是 null」那条用例的判据（2026-09-28 在临时工程跑过）。
- （T6 加）T5 那句 `expect(moveTargetOf(view, p.toPx)).toEqual(p.targetMm)` 在吸附接上之后**会红**，不是"照样绿"：样例房 16 把把手 × 10 发候选 = 160 发里有 **14 发**被 15° 档改写（最大偏差 6.97px），十个进程红 2 个。所以 Task 6 Step 5 把它换成同一函数的自比对（恒等式），落点内容的凭据交给新增的两条"吸上了什么/合法性判在哪一侧"用例（改坏 HD6 实测：`legalDrop` 换成自算 `hypot` 红两条）。
- （T7 加）`deriveJoints` 是**全局**的：`deriveStoreyGeometry(doc, storeyId)` 虽然按层返回，接头分类却扫全文档的墙。⇒ 复核（`assertDerivesAfterApply`）吃的是**整份文档**，任何一层藏着一颗坏接头，**别层**的每一条改几何命令都替它抛。`derive-guard.test.ts` 有一条用例专门把这个形状钉成预期行为（「复核吃的是整份文档：别层藏一颗星，本层也写不进墙」），计划 4 的读盘读到坏层时"本层冻结写入"是**已知后果**而不是 bug。
- （T7 加）派生复核**不改变**探针挑出的候选集合，只改变**拒绝发生在哪一层**。2026-09-28 在临时工程里逐字复刻 `demoHouse()` 一层（8 墙 + 4 洞口 + 那两次改几何编辑），各问两遍（复核在 / 复核摘掉）：拉新墙 80 发 ⇒ 复核在 `build` 拒 48（star 24、同向重叠 24）、可建 32；摘掉复核 `build` 全放行、派生层拒的**同一批** 48（新增拒绝 0、少拒绝 0）。拖把手 160 发 ⇒ 摘掉复核全过 `legalDrop`，复核在则拒 84（全 star）、可拖 76，同样是同一批；16 把把手**每一把仍剩 ≥3 发**。⇒ 筛 ⑥ 从此不再单独挡任何一发（`editing.ts` 里那句"命令层的 `build` 不含接头分类"要在 T7 Step 6 改写，见"本任务会改到的既有写法"第 4 条）；而"落点吸成恒等"那 160 问的计数（恒等 72 / 改写 14）**不受影响**，`handles.test.ts` 里那条 sweep 用例（只要求恒等 ≥ 8、改写 ≥ 1、改写只许来自 `angle15`）在 T7 之后照样绿。
- （T7 加）但**第一发过 `build` 的那一发偏移会变**：复核把"第 0 发就合法"往后挪 —— 拉新墙在 8 枚端点里挪了 **5 枚**（`(0,0)`→第 2 发、`(4000,0)`→第 3 发、`(0,6000)` / `(800,3000)` / `(4000,3000)`→第 1 发），拖把手在 16 把里挪了 **12 把**（都是第 0 发→第 1 发，去重后是 8 个位置里的 6 个；另外 4 把/4 个位置两侧都不动）。摘掉复核时这两张表**全是第 0 发** ⇒ 位移是复核造成的，不是采样噪声。而**"第一发 `build` 与派生都过"那张表在两侧逐字相同**（8 枚端点还是 2/3/0/0/1/1/1/0）⇒ 样例房的最终靶子不换，理由不是运气，是筛 ⑥ 早就把第 0 发挡在外面。编写期写的"12 个把手位置里的 9 个"两个数都不对（把手 16 把、去重位置 8 个、挪动 12 把），已在 T7 的 T6 交接第 ④ 条与 Task 6 那句 `handles.ts` 注释里改过来。`--draw-shot` / `--edit-shot` 的字面量仍要在 T7 落地后各重跑一遍取值（Step 8），判据形状一字不改 —— 因为**探针最终挑哪一枚端点仍跨进程漂**（2026-09-28 实测：带复核两次独立跑出 `5/3` 与 `7/1`，摘掉复核跑出 `7/1`，编写期"`wallProbe` 的答案不变"那句已被推翻）。
- （T7 加）一次带复核的 `build` 实测成本（2026-09-28，`bench/perf.test.ts`，整层派生本身在括号里）：13 墙 0.055ms（0.033）、31 墙 0.069ms（0.056）、61 墙 0.161ms（0.135）。⇒ `pointermove` 每帧问几次 `legalDrop` 仍然便宜，"复核太贵所以只留 UI 侧预判"这条反对意见在 S1 的规模上买不到东西。
- （T7 加）`packages/core/src/index.ts` 对 `commands/*` 与 `geom/*` 全是 `export *`（2026-09-28 核对）⇒ 新命令**不需要**改索引文件，也没有链接期错误可看：测试里 `import { storeyDelete } from '@dajia/core'` 在实现落地前拿到的是 `undefined`，要到调用那一行才 `TypeError: … is not a function`。写"红在哪"的核对清单时按这个形状预期，别等 `SyntaxError`。
- （T7 加）`applyPatch` 对**不在文档里的 remove id 是抛的**（计划 1 立的口径）⇒ `slabDelete` 必须先 `doc.get(pointId)` 再决定是否收进 `remove`：一块角点早就悬空的板，若把那个不存在的 id 写进补丁，命令在 `dispatch` 里抛，文档就**锁死**了（删不掉、改不动）。`commands-delete.test.ts` 的「角点早就悬空的板仍删得掉」钉的就是这个（改坏 M13 摘掉守卫即红）。
- （T7 加）core 基线 2026-09-28 重测：**21 文件 / 276 条**（不是抄计划 2 的旧数）；T7 之后 **24 / 309**（+9 +12 +12，`joint.test.ts` 的 18 条一条不增不减，且那 18 条改用 `handBuild` 之后**不依赖实现** —— 先落地也照样绿）。同日两个真账都跑过：临时工程（core + scene-2d）**30 文件 / 423 条**，真仓库（还没有 scene-2d 测试）**23 文件 / 284 条**。全仓 405 → 438 = T6 回填的 405 加本任务实测的 core 净增 33；**全仓 `Test Files` 数两段都没给过**（30 只含两个包、23 还没有 scene-2d 的 6 个文件），执行日 `pnpm verify` 跑出来再回填。⇒ **盘上真账（T7 执行回填，见本节末）**：core **25 文件 / 316 条**（那个 `24 / 309` 是临时工程 `.tscheck/t8` 的数：盘上多 `commands-drag.test.ts` 那 7 条），全仓 **33 文件 / 439 条**。

- （T8 加）`Entity` 联合上 **`projectId` 不是共有字段**：`doc.get(storeyId)?.projectId` 直接 `TS2339`（`ColumnEntity` 没有它，2026-09-28 写 `panel.test.ts` 时真撞上去的）。⇒ renderer 想知道"这个项目有哪几层"，唯一通路是**先把当前层实体收窄成 `kind === 'storey'`** 再读它的 `projectId`；`Document` 上没有"按项目列层"的出口，别为这一格去 core 开。
- （T8 加）**T 接同厚是能力边界，不是缺 bug**：`.tscheck/tmp/scratch2.txt` 的两组实测（2026-09-28）—— A 组：`stem` 在位时 `a→370` 单发被「直通两墙厚度不同」拒、`stem→370` 与 `a→240`（同值重设）放行、两侧**逐条连发** (800,800) 两条**全拒**（复核逐发只看"这一发之后的世界"，每条都看见对面还是原厚）、摘掉中间那根 `stem` 再连发才成 800/800（深度 7）。B 组：样例房一层八面墙各试 `120 / 370 / 500 / 3900` 四档 ⇒ **四面全档可改**（`west (0,0)→(0,6000)`、`north (8000,6000)→(0,6000)`、`east (8000,0)→(8000,6000)`、`stem (4000,0)→(4000,3000)`，stem 只在 3900 撞「墙厚不小于墙长」）、**四面全档锁死**（`southWest`、`southEast` 四档一律 `REJ-同厚`；`partEast` / `partWest` 只有同值那一档 OK，370 / 500 是 `REJ-同厚`、3900 是 `REJ-墙长`）。⇒ `--prop-shot` 第 3~10 步的靶子**必须**从前四面里挑；挑到后四面上，那六步会红成"面板拒了合法输入"的假象。屏幕上没有任何一条通路能把后四面改成同厚（真给用户的那条路是"改画成 L 角"，属几何编辑）。
- （T8 加）**真源允许同值重设**：`wall.setThickness` / `wall.setLoadBearing` / `wall.setMaterial` 各把同一值连发两次 ⇒ 撤销栈上留**两条**记录（实测：`panel.test.ts`「承重与材料不进派生：同值反复点各留一条撤销记录」）。⇒ P12 那条"值没变就不发"是**屏幕侧故意比真源严**，不是复述真源；写进注释，将来 core 自己挡同值时这一支要跟着删。
- （T8 加）**输入框逐字符提交会把撤销栈灌满**：打 `370` 三个字符要经过 `3` 和 `37`，两个都是合法厚度（真源只判整数、正、小于轴长）。⇒ P11 的 commit-on-blur/Enter 不是体验偏好，是 depth 判据能写成"恰好 +1"的前提；`--prop-shot` 第 10 步那句"Ctrl+Z 三次回基线"踩的就是这条。
- （T8 加）**摘掉筛 ⑤ 的红形不是"探针没靶子"**：Step 4 那枚确定性夹具上，四个独立进程实测给的都是 `(0,0)→(0,2000)` —— 画布外那一端也交得出靶子了，而它排在枚举表前面。编写期我先写成"答案换成 `(4000,0)→(6000,0)`"（照枚举顺序推的），实测推翻。⇒ 记红形一律照测到的写。
- （T8 加）**`planDelete` 里那四处 `.sort()` 只决定同一 kind 之内的顺序**：四类混选各放一枚构件时，摘掉 sort **全绿**（实测 M6 第一次跑）。牙齿是"同一 kind 多枚 + 输入降序" ⇒ Step 3 的夹具补第二面墙、按 id 降序喂进去。这张教训推广开：任何"排好序再输出"的判据，夹具里每种只放一枚就等于没测。
- （T8 加）**命令替换里读 vitest 输出必须剥 ANSI**：`out=$(npx vitest run … 2>&1)` 之后 `grep -E "^ +Tests "` 一条都匹配不上（八行变异全被记成"无统计行"，差点写成"摘掉实现全绿"），而 `npx vitest … | grep` 直接管道又是好的。⇒ 变异表一律带 `sed 's/\x1b\[[0-9;]*m//g'`（Step 6 那条命令里已带上）。
- （T8 加）账（2026-09-28，临时工程 `.tscheck/t9`）：**31 文件 / 449 条** = core 24/309（一字未动）+ scene-2d 7/140（viewport 9、drawlist 10、pick 18、snapping 28、editing **35**、handles 19、panel **21**）。相对 Task 7 的 423 净增 26 ⇒ 真仓库落地预计 **438 → 464**，`Test Files` 只多 `panel.test.ts` 一个文件（执行日回填）。`npx tsc --noEmit -p tsconfig.scene2d.json` 干净（那一条 `TS2339` 修完之后）。⇒ **盘上真账（T8 执行回填 + T9 收口，2026-09-30）**：core **25 / 316**（不是 24/309），scene-2d **7 / 171** = viewport 9、drawlist 10、pick 18、**snapping 44**、editing **35**、**handles 34**、panel 21，全仓 **34 文件 / 495 条**（那一串 140 / 449 / 464 全是临时工程的账）。

- （T9 加）交点档的**表内容账**（2026-09-28 实测，读 `snapFieldOf` 的中间量）：样例房一层 `pairTotal 28 → 不平行 15 → 去重坐标 9 → 撞上既有靶子 9 → 进表 0`；一张 61 面墙的栅格层（31 横 × 30 竖，全部用坐标字面量建端点，只为量规模、不过几何守卫）`1830 → 930 → 930 → 撞掉 146 → 进表 784`，而同一张层的端点数 **122 → 120** —— 那两枚就是去重键从 `pointId` 换成坐标直接合并掉的孤儿点。⇒ 交点档在**格网布局**上天然没有独有靶子（每枚格点早被端点或中点占了），它独有的东西在非格网层与**轴延长线**上；这条算术同时是「五个闸门判据一字不改」的凭据来源，不是巧合。
- （T9 加）吸附场的**规模成本**（同一次 `npx vitest run` 里 `while (performance.now() - t0 < 250)` 的读数，取三次独立进程的区间）：样例房建一次场 0.0029~0.0032ms → **0.0081ms**，一次 `dropTargetOf`（16 枚候选）**0.0010ms**；61 墙层建场 0.0208~0.0219ms → **0.233~0.254ms**，一次取最优（965 枚候选）0.0087~0.0092ms → **0.029~0.032ms**，而错误用法「每发 `pointermove` 重建场」是 0.264~0.273ms = 16.7ms 帧预算的 **1.6%**。⇒ R7 那个"落在 paint effect 那一发"的裁决在 S1 的规模上买得到；就算写错成每发一次也红不了谁 —— 挡住它的不是数字，是 `fieldRef` 那条既有纪律（T6 裁决 ①）。
- （T9 加）**「探针答案没移动」这类判据只能按集合写，不能按单值写**：`Document.byKind` 返回的是 `out.sort(byId)`（`core/src/model/document.ts`），uuidv7 同毫秒不单调 ⇒ `snapFieldOf` 的端点枚举顺序跨进程随机（T6 已记过一次，T9 又量了一遍）。`wallProbe` 补档前跑九个独立进程（`(800,3000)` 4 次 / `(4000,3000)` 5 次）、补档后跑十一个（5 次 / 6 次）⇒ **候选集合两侧相同，二十个进程里没有第三枚**。本任务 12 条新用例一律比"排序后的坐标串/集合"（`crossKeys` 那个助手就是这个用途）；老库里唯一按下标取候选的 `snapping.test.ts:263` 跑在单面墙的合成层上，Task 9 之后那一枚仍是那面墙的起点，不必动 —— 但别学它。
- （T9 加）**改坏验证的两条操作纪律**（这一轮真踩了才写下来的）：① 摘掉新档时**只摘调用行**、函数留在原地 —— 连函数一起删会让 `npx tsc --noEmit` 红在 `TS6133: 'axisCrossPoints' is declared but its value is never read.`（`noUnusedLocals`），那是编译期的红，与"实现被摘掉"是两件事，一条断言也读不到。② 变异驱动必须 `try/finally` 还原 + 锚点先验 + 跑完再验一遍全绿：第一版驱动在 Windows 的 GBK 控制台上 `print` 中文用例名直接抛 `UnicodeEncodeError`、`finally` 没写，于是 N1 的改动留在盘上，第二次跑 N1 报 `ANCHOR-FAIL`、N2 那行测的其实是 **N1+N2 叠加**（数字看着像，红名少两条）。控制台打中文要 `sys.stdout.reconfigure(encoding='utf-8', errors='replace')`，或者只往 utf-8 文件里写。
- （T9 加）`resolvePointRef` 对**坐标字面量恒返回 `null`**（计划 2 立的口径）⇒ `columnCreate({ at: { x, y } })` 拿到的是柱**自己的**一枚点，坐标与旁边那面墙的端点逐字相同、id 是两枚。吸附端点档若按 `pointId` 去重，表里就留两枚同坐标候选，`takeBest` 的并列判据只能拿 ownerId（uuidv7）比大小 ⇒ 赢家跨进程漂，而吸上"柱那枚孤儿点"的那一发**接不上头**（墙不认识那枚点，`wallCreate` 会新建第三枚同坐标的点）。R3 换去重键就是为这一格，唯一见证是 N8。
- （T9 加）计划正文里引用的 `bench/perf.test.ts`（T7 的复核成本账与本任务的规模账都挂在这个名字下）**只存在于编写期的临时工程**：真仓库没有这个文件、本计划也不打算造 —— 它是「数字产地」的名字，不是执行日要去找的测试。真要在 CI 里盯住这条性能，那是计划 4 之后的事，届时要连夹具一起落地，别只落一条 `expect(ms < X)`。

## 执行日志

执行时逐格回填（2026-09-28 起，branch `plan3-scene-2d-editor`，代码 seat 提交、计划正文由控制位另提 `docs:`）。

| Task | 提交 | `pnpm verify` 实测 | 关键实测红字 / 数字 | 评审结论 |
|---|---|---|---|---|
| T1 视口仿射与包接线 | `86f2a3c` | exit=0，**24 文件 / 293 条**（基线 23/284 ⇒ +1 文件 / +9 条，全在 `viewport.test.ts`） | RED = `TypeError: viewportOf is not a function`；评审员自跑 `tsc --listFilesOnly` 证明根 `typecheck` 真的把 scene-2d 的 src+test 收进去了 | Spec ✅ / Approved；0 Critical、0 Important；Minors m1–m6 全挂账（m3→T4、m4→T3/T5、m2 改判不并入 T2） |
| T2 绘制指令表与样例两层房 | `2a6879d` | exit=0，**25 / 303**（+10 条） | 改坏 1–8 逐条红、9 必须绿（实测全绿）；第 6 条按正文位置挪会先撞 `penFor` TDZ，挪到 ① 之前才是单点红；第 7 条红在标签越界的边界断言（`expected -43.26923… >= 0`）而不是预言的张幅断言 | Spec ✅ / Approved；0 Critical、0 Important、5 Minor（三条转 T3 真消费者、两条转终审） |
| T3 真窗口出像素（`--shot`） | `b7c0455` + `6ddb090` | exit=0，**25 / 303 不变**（本格零新增用例，刻意） | `pnpm shot` 六行 PASS + `{"ops":31,"layers":{"structure":20,"opening":10,"annotation":1},"nonBlankPx":30633,"wPx":1427,"hPx":839}`；`hPx` 两次实测 839 / **865** ⇒ 绝对像素不是常数；负测喂空 ⇒ `nonBlankPx=0` / exit=1；隐藏窗口回读 `nonBlankPx=31710`；坏参数 fail-fast exit=2 / 267ms | 首轮 Spec ✅ / **Needs fixes**（1 Important = 计划正文自带的 `shell:true` 拆路径缺陷）；fix round 1 修 I1+m2+m3+m4，**scoped re-review：四条全 addressed、0 回归、Ready to close** |
| T4 命中与点选（`--pick-shot`） | `c025668` + `5756c12` + `fa05e41` | exit=0，**26 / 318**（+15 条，含 2 条属性） | RED 15 条全红在 `TypeError: pickAt is not a function`；`pnpm pick-shot` **11 行 PASS**、连测 **7** 轮（提交正文的「6 轮」少算一轮）；**`index.html` 无 CSS ⇒ UA `body{margin:8px}` 正好等于 `PICK_TOL_PX`（实测 `rect=[8,8]`）** —— 从此 `CanvasPx` / `ViewportPx` 两套空间分开命名、`canvasOriginPx` 实测、`clickCanvasPx` 加实测原点、闸门有一行断言原点 `(0,0)`（24px margin 的 RED 只让那一行红）；反向哨兵从"红成 main 的 throw"改成"红成脚本的 FAIL 行" | 首轮 Spec ✅ / **Needs fixes**（I1 前提由 CSS 造成而非断言、I2 十行里四行不可能红）；fix round 1（4 文件 +75/−25）修 I1+I2+两行 Minor，**scoped re-review：四条全 addressed、0 回归、Ready to close**（`--shot` 那六条逐字节未变）。**事故：该 review seat 违反只读约定，reflog 19:51:09 `checkout: moving from plan3-scene-2d-editor to main`；无提交落进 main，代价是控制位当时未提交的计划编辑落到了 main 那一份上** |
| T5 拖端点改墙（`--edit-shot`） | `39a7824` + `6dc9efe` | exit=0，**28 / 338**（正文预言 337；差源 = `handles.test.ts` 实测 13 条而非 12，第 13 条是控制器补危险时后加的。seat 那发 GREEN 逐字 `Tests 19 passed (19)` = 7+12，与预言相同） | RED 12 条全红在 `TypeError: dragHandlesOf is not a function`；`shot` 6 行 / `pick-shot` 11 行 / **`edit-shot` 21 行全 PASS**，修复后**连续 13 次绿**；R1–R7 闸门级改坏**七条全红**（R3 比预言早一处红）；**五个正文未预言的危险**：① `sendInputEvent` 静默夹画布外坐标（假阴，`insideCanvas` 筛）② 菜单栏占约 26px、摘晚了当场触发 resize ③ `fit()` 读的 `log.document` 是活 getter × resize ⇒ 像素前提全体作废 ④ star 接头令 `deriveStoreyGeometry` 抛 ⇒ **renderer 白屏**（`derivesAfterMove` 筛；真人手动那一档挂 T7）⑤ **输入队列竞态**（约 1/6）：`await sendInputEvent` 不等事件被处理，`onUp` 读的是最后一发**已处理**的 `move` ⇒ 用 `dragTargetMm`/`dragCursorPx` + `waitDragAt()` 做**条件等待**（不是重试），并把第 2 步"跟手"从自指改成发送方判 | 首轮 Spec ✅ / **Needs fixes**（I1 压扁那发缺 `movePx`、I2 R1–R7 从未跑；m3 是我写进注释的假因果、m6 是报告里两个不存在的符号名）；fix round 1（2 文件 +98/−13）修 I1+I2+m3+m4，**scoped re-review：Ready to close，无需第 2 轮代码返工**。**事故：implementer seat 在第 150 轮天花板中止、零提交 ⇒ 控制位接管落地（独立性只剩评审 seat）**；**凭据抄写缺陷：驱动取第一条 `Error:` 命中，而 `RangeError:` 含 `Error:` ⇒ R7 那格抄成 stdout 诊断，已单独重跑订正** |
| T6 拉新墙/删除/五档吸附（`--draw-shot`） | `5f760f4` … `9dd6d85`（代码棒 + 两发控制位接管 + 三发评审修） | exit=0，**30 / 406**（+2 文件 / +68 条，全在 scene-2d；`packages/core` 零改动） | `pnpm draw-shot` **28 行 PASS**；改坏 DR1–DR8 + DR1b = 七牙两无牙（DR2 位移 0.33/0.45px 落进 ±2px 桶、DR3 是等价变异）；Critical = 真人手势可达的 star 白屏（48/48 发实测）已收进 `lastError` 并做过反控 | 单座 `t6-reviewer`：**Ready to close**，0 Critical / 3 Important（全是记录面），Q1 保留 `≤1.5`、Q2 判 DR3 改坏表写错行 + DR2 挂 T8、Q3 硬账全过 |

- T3 的六个实测数（本节原先要的就是这个）：`ops=31`、`structure=20`、`opening=10`、`annotation=1`、`nonBlankPx=30633`（可见那版）/ `31710`（隐藏那版）、`wPx=1427`、`hPx=839`（另一次 865）。
- 挂账中、当前没人踩的：**T4 收口时一条都没踩到**，所以照旧挂着 —— T2 的三条（property 半自反、`fitStorey` 边界圈含 annotation、`fitStorey`+`buildDrawList` 双算派生）与 T1 的 m3/m4（`mmToPx`/`pxToMm` 不拦非有限、`Viewport` 是裸结构接口），现在全部指向 **T5**（拖拽第一次把屏幕浮点喂回命令入口，非有限与手搓视口在这才可达）与 **T6**；T4 自己新挂的四条写在上面 T4 那节末尾（shuffle 属性的 `ownerId` 平手档 → 终审；`selectedAfterBlank` 与名字 → 下次真动 `DebugReport` 那一格；`probeTarget` 只扫 `polygon` → T5/T6 的闸门作者；`willReadFrequently` → 有实测数字再动）。
- **闸门不在 `verify` 里**（`pnpm shot` / `pick-shot` / `edit-shot` / `draw-shot` 全是本地手动），CI 只跑 `verify` + desktop build。不许为了让 CI 绿把断言写成"跑不起来就跳过"。
- **T5 收口后的挂账总账**（谁踩谁知道，别提前"顺手补"）：T1 的 m3/m4 与 T2 的三条**在 T5 一次都没被踩到**（拖拽把"屏幕浮点喂回命令入口"这条通路走通了，没有一条判据因非有限入参或手搓 `Viewport` 变红；**注意这不等于它们被挡住了** —— 量化只是 `Math.round`，NaN 进去还是 NaN，只是这条路上没人喂 NaN 进去），继续指向 **T6**；T4 的四条照旧（`probeTarget` 只扫 `polygon` ⇒ 三闸门那 6/11/21 行**结构上只覆盖墙轮廓**，读 PASS 时别读成三层都覆盖）。**T5 新增三条定向交接**：真人手拖到 star 落点仍白屏 → **T7**（`assertDerivesAfterApply` 之后 `legalDrop` 与真源同判）；"以后替换 `log` 实例要不要重算视口" → **T8**；`handles.test.ts` 第 13 条里 `not.toBeNull()` 的牙齿是概率性的 → **T6 复制该写法时不许放宽、也不许当恒绿凭据**。两提交并一（m5）与"改坏红字要取最后一条 `Error:`"这两条已经写在上面，属规则不属挂账。
- **T6 棒 C 收口后新增一条定向交接（HB5）**：改坏"`legalDrop` 判吸附前的裸毫米而不是吸附后的"在 `d642466` 下 **8/8 全绿**（`48417e0` 上复跑 3/3 同样全绿）。根因不是漏测，是**探针链上两道筛互相遮蔽** —— `derivesAfterMove` 跑同一个 `wallMoveEndpoint(...).build(doc)` 再加 `deriveStoreyGeometry`，是 `legalDrop` 的严格超集，而这条夹具给的分歧是"裸合法 / 吸附非法"那一侧 ⇒ 非法的吸附后落点先被 `derivesAfterMove` 筛掉，调用点改坏结果集不变（Task 6 正文 C 段第 8 行那句「18/1，8/8 恒」是**计划文本过期**，已就地订正）。同一批代码的别的行为是有牙齿的（HB3 传 `EMPTY_SNAP_FIELD`、HB4 换回裸 `moveTargetOf` 均 8/8 只红那条用例）。**交接给 T7，且 T7 已经自带解法**：6.7 那条重写把分歧挪到**有牙齿的那一侧**（裸落点拧成 star ⇒ `legalDrop(raw)=false`，吸回贯通线 ⇒ `derivesAfterMove(mm)=true`）⇒ 差集非空、遮蔽解套。执行日的复测口径因此是「改坏 HB5 **恰好**红 6.6 与 6.7」（`Tests 2 failed | 47 passed (49)`），跑绿就说明那枚分歧没造出来，**别回到 T6 这条夹具复测、更别把靶子方向再搭反**。`assertDerivesAfterApply` 挂上之后 `legalDrop` 与 `derivesAfterMove` 对同一入参同判，所以这条纪律从此只能靠"分歧方向"来证，不能靠"再加一道筛"。**不许**为了给这条改坏留牙齿去摘 `derivesAfterMove`（它是 T5 star 白屏的治法，且摘了探针就重新允许"建得出、画不出"落盘）。
