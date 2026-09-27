# 搭家 S1 · 计划 2：几何与不变式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `@dajia/core` 从"有实体、有撤销"推进到"有几何"：墙轴线派生矩形轮廓与 L/T/十字接头、洞口沿宿主墙定位并在墙拉伸时跟随夹取、补齐 `opening.*`/`column.create`/`slab.create`/`storey.setElevation` 命令，再用 AABB 网格索引支撑拾取，并用属性测试证明"接头闭合、洞口永不超出宿主墙长、派生与撤销逐字节可重放"。

**Architecture:** 真源仍是不可变 `Document` + `Patch` + `TransactionLog`（计划 1 已建，本计划不推翻）。新增两条边界：(1) **派生层**（`src/geom/`）是纯函数，输入 `Document` 输出浮点几何，绝不写回真源，浮点因此被物理隔离在 `geom/` 目录内；(2) **接头不进真源**，真源只为拓扑闭合新增一件事 —— 多面墙可共享同一 `pointId`。拖动一个拐角两面墙同时跟随，靠的是它们指向同一个点实体，不靠任何缓存或联动写回（D2b）。空间索引（`src/spatial/`）是派生层的下游，按 `TransactionLog.affected` 做局部重建。

**Tech Stack:** Node 24.14、pnpm 11.18、TypeScript 7.0.2、Vitest 5、fast-check 4.10.2。无新增运行时依赖 —— 几何与索引全自研（`spec` 第 4.1 节：`@dajia/core` 零运行时依赖）。

**Spec:** `docs/superpowers/specs/2026-09-25-dajia-s1-design.md` —— 本计划实现 **M1.1 的后半**（轴线→轮廓与接头派生、AABB 索引、几何不变式属性测试），并补完 spec 5.5 命令表里计划 1 留下的空位。M1.0 与 M1.1 前半见 `docs/superpowers/plans/2026-09-25-dajia-plan1-core-foundation.md`。

## 本计划的用户已确认口径（2026-09-25）

三条都是会实质改变工期与结果的取舍，已问过，不再自行改变：

1. **接头算法 = 中线斜切**：从两墙轴线算夹角，共享端点处沿角平分线切；异厚则平接。**不做**轮廓多边形布尔。
2. **洞口 = 派生时把墙轮廓沿洞口打断成段**，真源仍是"墙 + 洞口实体"两份，不复制几何。
3. **`column.create` / `slab.create` 并入本计划**（计划 1 自审已把它们的实体归到计划 2）。

口径 1 里"异厚则平接"的落地细节见 Task 4，先在这里说明以免读起来像改主意：**平接（方头切）在 T 接与直通处几何精确，本计划就这么做**；而两面墙各以端点相遇的异厚 L 角，方头切必然留缝或重叠（Task 4 有一段推导），所以那里改用**偏置斜切** —— 接缝仍是直线，只是不过中线，两墙轮廓共用同一条边，验收要的"无缝闭合"才成立。等厚 L 角退化为标准 45° 斜切，与口径一致。

## 计划系列（S1 共 6 份）

| # | 名称 | 覆盖 | 独立可交付 |
|---|---|---|---|
| 1 | 内核地基 | M1.0 + M1.1 前半 | ✅ 已交付（`main` = `d1bdd78`）|
| **2（本文档）** | 几何与不变式 | M1.1 后半 | `pnpm verify` 全绿；给定墙网可派生无缝轮廓、洞口跟随拉伸、索引与暴力扫描一致、几何不变式属性测试通过 |
| 3 | 画得出 | M1.2 + M1.6 | 交互画出一栋两层房 + 3D 只读拉伸 + 选中双向同步 |
| 4 | 存得下 | M1.3 | MySQL 迁移/repository/连接向导/工程锁/崩溃恢复，真库集成测试 |
| 5 | 出得了图 | M1.4 + M1.5 | 一页 A3 1:100 平面图矢量 PDF，含三道尺寸线与图框 |
| 6 | 补完 | M1.7 + M1.8 | 3D 拖整层、描图底图两点定标、端到端金路径与 S1 验收 |

**为什么不在现在把 3–6 写全**：计划 3 的吸附候选点、计划 5 的尺寸链都直接吃本计划产出的派生形状（`WallQuad` / `WallPiece` / `Joint` 的字段）。现在写只会得到看着整齐、落地必改的假代码。

## Global Constraints

每条对全部任务生效，值逐字取自 spec 与计划 1。

- 真源坐标与长度一律**整数毫米**（D8）。浮点只允许出现在视口投影与**临时构造计算**中，写回真源必过 `quantizeMm`。本计划里"临时构造计算"的具体落点就是 `packages/core/src/geom/**` 与 `packages/core/src/spatial/**`。
- 包依赖方向：`core` ← `{ scene-2d, scene-3d, drawing }`，三者互相禁止 import；`drawing` 只许依赖 `core`。由 `pnpm lint:deps` 强制（D2b、4.2）。**本计划全部代码在 `packages/core` 内**，不新增包。
- renderer 永不接触数据库（4.3）。本计划不碰 `apps/desktop`。
- 每条 command 必须可逆；`dispatch → undo` 必须把文档还原到**逐字节相同**（5.5）。
- ID 一律 UUIDv7 字符串（5.1）。
- core 内部不变式被违反时**直接抛错，不做兜底**（第 9 节）。派生层同样适用：轴线端点缺失就抛，不返回空几何。
- **不引入 ORM**；不引入几何库（polybooljs / turf / jsts 一律不许）。
- UI 文案仅中文；不使用 emoji。错误消息与 `toThrow` 正则同样用中文。
- `Node >= 24`，包管理器锁定 pnpm。
- 仓库行尾 `.gitattributes` 必须是 `* text=auto eol=lf`（已存在，勿改）。
- 每个任务结束时 `pnpm verify` 必须全绿才允许提交。
- **派生层与它的测试里，算出来的 `Vec2` 一律走 `vec()` 拼装**（`geom/vec.ts` 导出的那枚构造器），不写 `{ x: …, y: … }`。理由不是观感：`geom/vec.ts` 把 `-0` 归一成 `+0`，而 `Object.is(-0, 0)` 为 `false`、vitest 的 `toEqual`/`toBe` 就用它 —— 裸字面量算出的 `-0` 会让 Task 4/5/8/10 红在符号上而不是几何上，`{ x: -a.x, y: -a.y }` 这种取负写法在水平/垂直墙上必踩。**范围只到"分量是算出来的"那一类**（取负、相减、缩放之后拼装），两类不算违例：① 纯整数常量夹具（`vec(0, 0)` 与 `{ x: 0, y: 0 }` 谁都造不出 `-0`，按可读性选）；② 测试里**故意**喂 `-0` 的用例 —— Task 1 那几条 ±0 用例正是靠裸 `{ x: -0, … }` 才能把一个 `-0` 送进构造器，写成 `vec(-0, …)` 等于把要验的东西先归一掉，那条测试就空跑了。计划文本里留着的两处（Task 1 的 `perp`、Task 2 的 `awayDir`）已在代码里改掉，见 Task 1 执行回填。
- 测试里禁止"空跑恒真"：属性测试必须 `expect(executed).toBe(numRuns)` 钉住样本量；生成器优先靠上下界构造排除非法值，不用 `filter`（计划 1 Task 9 已确立此规）。
- **`uuidv7` 在同一毫秒内不保证单调**（`ids.ts` 的注释写明了，计划 1 的 `ids.test.ts` 还专门有一条「同毫秒不保证有序（已知边界，排序靠命令序列）」钉住它）。因此本计划的测试**禁止**用 `byKind(...).at(-1)` 或 `[1]` 取"刚建的那个实体" —— 那等于掷硬币，同一毫秒建两面墙时有约一半概率取错。取新建实体一律用 `log.affected`（`dispatch` 之后它正好是这次补丁写入的 id 集合）；要按楼层取实体就按 `storeyId` / `index` 过滤。派生层的顺序契约一律写成"**id 升序**"（也就是 `byKind` 给的顺序），不写"创建顺序"。计划 1 落地的 `properties.test.ts:227` 有此写法残留（那里不会误红，但取到的不是它以为的那面墙），Task 10 顺手改掉。**用例名同理**： Task 5 原本给那条顺序用例起的名字写的是「id 升序 = 创建顺序」，这正是本条禁例的措辞，已就地改成「契约是 id 升序，不是创建顺序」—— 断言本身（拿派生序比 `byKind` 序）没问题，错的是括号里的解释。
- **变异检查的仪式**：跑一条变异，若**全绿**，先别记"这条测不出东西"，而是先证明它到底有没有改变行为 —— 计划 2 Task 4 的 M4 是现场教材：把 `faceSide` 的结果抽到外层只改一处，另一处的块级 `const face` 把外层值**遮蔽**掉了，于是"变异"其实没改任何行为，全绿是正确结果，而它被记成了"测试有漏洞"。**一个不红的变异，必须先证明它确实改变了行为**（`git diff` 看一眼改的到底是哪个绑定、或临时加一行 `console.log` 看被改的分支有没有走到），否则日志里写的是一条不存在的证据。反过来也成立：写变异要挑"改了就会错"的那一处，不要挑"改了只是不一样"的那一处（Task 9 的 `Math.floor` → `Math.round` 那条已经立过这个规）。

---

## 文件结构

计划 1 已建立的（本计划只改 `commands/wall.ts`、`commands/storey.ts`、`model/command.ts` 与 `index.ts`，其余不动）：

```
packages/core/src/units/mm.ts        Mm / quantizeMm / assertMm / mmToMeters          （已存在；本计划只为 ±0 归一动它两个返回值，理由见 Task 1 执行回填）
packages/core/src/ids.ts             EntityId / uuidv7 / isEntityId / timeFromUuid     （已存在）
packages/core/src/model/entity.ts    Point/Wall/Opening/Storey/Column/Slab 实体        （已存在，不改）
packages/core/src/model/document.ts  Document / SCHEMA_VERSION / canonical()           （已存在，不改）
packages/core/src/model/patch.ts     Patch / applyPatch / invertPatch                  （已存在，不改）
packages/core/src/model/command.ts   CommandType / Command                             （本计划扩 type 联合）
packages/core/src/model/transaction.ts TransactionLog / affectedIds                    （已存在，不改）
packages/core/src/commands/storey.ts storeyCreate                                       （本计划加 storeySetElevation）
packages/core/src/commands/wall.ts   wallCreate / wallSetThickness / wallMoveEndpoint / wallDelete
                                                                                       （本计划改：共享端点 + 洞口夹取）
```

本计划新建，按"浮点在左、索引在右"分两个目录：

```
packages/core/src/model/read.ts      跨命令共用的 doc 读取断言：mustExist/requireWall/requirePoint/requireStorey
packages/core/src/geom/vec.ts        Vec2（浮点）与直线求交、角度、投影、闭段相交判定
packages/core/src/geom/axis.ts       墙轴线 WallAxis：真源整数 → 单位向量/法向/浮点长度
packages/core/src/geom/ring.ts       assertSimpleRing：多边形环能不能当构件轮廓用（整数判据，无 EPS）
packages/core/src/geom/topology.ts   PointRef 解析 + 共享端点查询：incidentWallEnds / sharedPointIds / dependentsOf
packages/core/src/geom/joint.ts      接头：按共享 pointId 分组、分类、算每端每侧斜切量
packages/core/src/geom/outline.ts    WallQuad 派生（Task 5）+ 整层派生入口 deriveStoreyGeometry（Task 6 补进本文件）
packages/core/src/geom/opening.ts    洞口沿墙定位、互不重叠校验、墙身分段 WallPiece
packages/core/src/spatial/index.ts   Aabb + SpatialIndex（均匀网格），按 affected 局部重建
packages/core/src/commands/opening.ts openingCreate / openingMove / openingDelete
packages/core/src/commands/column.ts columnCreate
packages/core/src/commands/slab.ts   slabCreate
```

测试新建（`packages/core/test/`，已被 vitest 的 `packages/*/test/**/*.test.ts` 覆盖）：

```
read.test.ts     vec.test.ts      axis.test.ts     topology.test.ts
joint.test.ts    outline.test.ts  ring.test.ts     opening-geom.test.ts
spatial.test.ts  geometry-properties.test.ts
commands-opening.test.ts   commands-column-slab.test.ts
integration-two-storeys.test.ts
```

`topology.test.ts` 同时考纯查询（`incidentWallEnds` / `dependentsOf`）与"共享端点进了真源以后命令怎么变"，
因为它们是同一件事的两面 —— 分两个文件会让命令侧的守卫没有查询侧的语义可对照。

`geometry-properties.test.ts` 与 `integration-two-storeys.test.ts` 都归 Task 10：前者是随机的（随机墙链 +
随机操作序列，跑不出那栋房子），后者是定值的（spec 11.1 那两层住宅，每个数字都手算过）。
两种测试的失效方式完全不同 —— 随机测试会悄悄退化成空跑，定值测试会跟着实现一起改口径 —— 所以不合并成一个文件。

`packages/core/test/arbitraries.ts` 本计划扩两个生成器（墙链 + 洞口尺寸）与一条操作序列生成器，
计划 1 已有的 `arbWallShape` 等一律不改签名 —— `properties.test.ts` 在吃它。
Task 10 另外清理 `properties.test.ts` 里 `byKind().at(-1)` 与 `as PointEntity` 的残留写法（见 Global Constraints 末条）。

---

## 任务间的类型契约（先读这张表，再写代码）

跨任务引用的每个签名都在这里定死，任何任务内部改写都算计划缺陷：

| 符号 | 定义于 | 签名 |
|---|---|---|
| `EntityId` | 计划 1 `ids.ts` | `type EntityId = string` |
| `Mm` | 计划 1 `mm.ts` | `type Mm = number`（整数毫米） |
| `Vec2` | Task 1 | `interface Vec2 { readonly x: number; readonly y: number }` |
| `WallAxis` | Task 2 | `interface WallAxis { wallId: EntityId; storeyId: EntityId; start: Vec2; end: Vec2; dir: Vec2; normal: Vec2; lengthMm: number; thicknessMm: Mm }` |
| `WallEnd` | Task 2（`geom/axis.ts` 导出） | `type WallEnd = 'start' \| 'end'` |
| `endPointId` | Task 2（`geom/axis.ts` 导出） | `(wall: WallEntity, end: WallEnd) => EntityId` |
| `PointRef` | Task 3 | `type PointRef = { readonly x: number; readonly y: number } \| { readonly pointId: EntityId }` |
| `WallEndRef` | Task 3 | `interface WallEndRef { wallId: EntityId; end: WallEnd }` |
| `JointKind` | Task 4 | `'free' \| 'corner' \| 'tee' \| 'cross' \| 'collinear' \| 'star'` |
| `Joint` | Task 4 | `interface Joint { pointId: EntityId; kind: JointKind; members: readonly JointMember[] }` |
| `JointMember` | Task 4 | `interface JointMember { wallId: EntityId; end: WallEnd; trimLeftMm: number; trimRightMm: number }`（left = +normal 侧，right = -normal 侧；**可正可负**，正=沿轴内退，负=越过端点外伸） |
| `deriveJoints` | Task 4 | `(doc: Document) => Joint[]`（每个被墙端引用的点一个 Joint，按 pointId 升序；自由端也给 `kind:'free'`） |
| `memberTrim` | Task 4 | `(joints: readonly Joint[], wallId: EntityId, end: WallEnd) => JointMember`（找不到就抛，不返默认值） |
| `WallQuad` | Task 5 | `interface WallQuad { wallId: EntityId; corners: readonly [Vec2, Vec2, Vec2, Vec2]; areaMm2: number }` |
| `wallQuad` | Task 5 | `(axis: WallAxis, startTrim: JointMember, endTrim: JointMember) => WallQuad` |
| `deriveWallQuads` | Task 5 | `(doc: Document, joints?: readonly Joint[]) => WallQuad[]`（按墙 id 升序） |
| `polygonArea` | Task 5 | `(points: readonly Vec2[]) => number`（鞋带公式，恒非负） |
| `OpeningSpan` | Task 6 | `interface OpeningSpan { openingId: EntityId; fromMm: number; toMm: number }` |
| `WallPiece` | Task 6 | `interface WallPiece { wallId: EntityId; fromMm: number; toMm: number }` |
| `openingSpans` | Task 6 | `(doc: Document, wall: WallEntity) => OpeningSpan[]`（按 `fromMm` 升序） |
| `assertSpansFit` | Task 6 | `(wallId: EntityId, lengthMm: number, spans: readonly OpeningSpan[]) => void`（越界 / 重叠即抛） |
| `piecesFromSpans` | Task 6 | `(wallId: EntityId, lengthMm: number, spans: readonly OpeningSpan[]) => WallPiece[]` |
| `StoreyGeometry` | Task 6 | `interface StoreyGeometry { storeyId: EntityId; walls: readonly WallQuad[]; joints: readonly Joint[]; pieces: readonly WallPiece[] }` |
| `deriveStoreyGeometry` | Task 6 | `(doc: Document, storeyId: EntityId) => StoreyGeometry`（定义在 `geom/outline.ts`） |
| `OpeningCreateInput` | Task 7 | `interface OpeningCreateInput { hostWallId: EntityId; distanceMm: number; widthMm: number; heightMm: number; sillMm?: number; category: 'door' \| 'window' }` |
| `openingCreate` / `openingMove` / `openingDelete` | Task 7 | `openingCreate(input: OpeningCreateInput): Command`；`openingMove({ openingId, distanceMm }): Command`；`openingDelete({ openingId }): Command`。Task 7 另把 `wallMoveEndpoint` 的 `affected` 从"只有那个点"扩成"那个点 + 被夹动的洞口"，签名不变 |
| `columnCreate` / `slabCreate` / `storeySetElevation` | Task 8 | `columnCreate(input: ColumnCreateInput): Command`，`ColumnCreateInput = { storeyId: EntityId; at: PointRef; widthMm: number; depthMm: number; heightMm?: number; loadBearing?: boolean; material?: string }`；`slabCreate(input: SlabCreateInput): Command`，`SlabCreateInput = { storeyId: EntityId; boundary: PointRef[]; thicknessMm: number; elevationOffsetMm?: number }`（`boundary` 是**开环**，顺序即真源走向，不许排序）；`storeySetElevation({ storeyId, elevationMm }): Command`。后两条要扩 `CommandType` 联合 |
| `requireStorey` | Task 8（`model/read.ts`） | `(doc: Document, storeyId: EntityId) => StoreyEntity`（与 `requireWall` 同形；柱高默认值与板的楼层检查都走它，命令里不留 cast） |
| `segmentsIntersect` | Task 8（`geom/vec.ts`） | `(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2) => boolean`（闭段语义：端点相接与共线重叠都算真相交；无 EPS，输入恒为整数毫米） |
| `assertSimpleRing` | Task 8（`geom/ring.ts`） | `(label: string, points: readonly Vec2[]) => void`（四条精确判据：≥3 顶点、顶点互异、相邻三点不共线、非相邻边不相交；**故意不看面积**，理由见 Task 8 Step 2） |
| `Aabb` | Task 9 | `interface Aabb { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }`（浮点：由派生轮廓取极值） |
| `aabbOfPoints` | Task 9 | `(points: readonly Vec2[]) => Aabb`（空数组抛 `/至少一个点/`） |
| `aabbIntersects` | Task 9 | `(a: Aabb, b: Aabb) => boolean`（**闭区间**：贴边与包含都算相交） |
| `openingAabb` | Task 9 | `(axis: WallAxis, span: OpeningSpan) => Aabb`（沿轴区间 × 墙厚，不含斜切） |
| `expandAffected` | Task 9 | `(doc: Document, seed: ReadonlySet<EntityId>) => Set<EntityId>`（`dependentsOf` 的不动点闭包，含 seed；**不含**共角邻墙 —— 那条边不在真源里） |
| `IndexedKind` / `IndexEntry` | Task 9 | `type IndexedKind = 'wall' \| 'opening'`；`interface IndexEntry { id; kind: IndexedKind; aabb: Aabb; dependsOn: readonly EntityId[] }`（墙 = 两端点；洞口 = 宿主墙 + 两端点） |
| `SpatialIndexOptions` | Task 9 | `interface SpatialIndexOptions { readonly cellSizeMm?: number }`（默认 `4000`，走 `assertMm`） |
| `SpatialIndex` | Task 9 | `class SpatialIndex`（构造器 private）：`static fromDoc(doc, storeyId, options?)`、`rebuild(doc)`、`applyAffected(doc, affected)`、`query(rect): EntityId[]`、`queryPoint(x, y): EntityId[]`、`cellVisits(rect): number`、`entryOf(id): IndexEntry \| undefined`、`snapshot(): readonly IndexEntry[]`（id 升序）、`get size: number`。一层一个实例，只管墙与洞口 |

任务顺序（每个任务末尾独立可提交）：1 vec → 2 read+axis → 3 共享端点进真源 → 4 joint → 5 outline →
6 opening 派生 → 7 `opening.*` 命令 + 洞口跟随 → 8 `column.create` / `slab.create` / `storey.setElevation`
→ 9 spatial → 10 几何属性测试与两层整合。

---

### Task 1: 浮点向量与直线求交

派生层唯一的浮点落点。本任务不碰真源、不碰实体，只建 `geom/vec.ts`。后面 Task 2–10 的所有浮点运算都从这里出发，所以它必须先把"零向量、平行线、退化角"三种崩溃面处理干净 —— 否则 Task 4 的接头会拿 `NaN` 去算斜切。

**Files:**
- Create: `packages/core/src/geom/vec.ts`
- Create: `packages/core/test/vec.test.ts`
- Modify: `packages/core/src/index.ts`（加一行 `export * from './geom/vec';`）

**Interfaces:**
- Consumes: 无（`geom/` 的第一块砖，零依赖）
- Produces: `Vec2{x,y}`（浮点毫米，readonly）、`vec`、`add`、`sub`、`scale`、`dot`、`cross`、`length`、`normalize`、`perp`、`angleOf`、`angleBetween`、`advance`、`sinOfAngle`、`isParallel`、`intersectLines`、常量 `PARALLEL_EPS = 1e-9`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/vec.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  PARALLEL_EPS,
  add,
  advance,
  angleBetween,
  angleOf,
  cross,
  dot,
  intersectLines,
  isParallel,
  length,
  normalize,
  perp,
  scale,
  sinOfAngle,
  sub,
  vec,
} from '@dajia/core';

describe('vec 基本运算', () => {
  it('加减与数乘逐分量', () => {
    expect(add(vec(1, 2), vec(3, 4))).toEqual({ x: 4, y: 6 });
    expect(sub(vec(1, 2), vec(3, 4))).toEqual({ x: -2, y: -2 });
    expect(scale(vec(2, -3), 2.5)).toEqual({ x: 5, y: -7.5 });
  });

  it('点积与叉积：叉积符号区分左右侧', () => {
    expect(dot(vec(2, 3), vec(4, -1))).toBe(8 - 3);
    expect(cross(vec(1, 0), vec(0, 1))).toBe(1);
    expect(cross(vec(0, 1), vec(1, 0))).toBe(-1);
  });

  it('perp 是逆时针 90°', () => {
    expect(perp(vec(1, 0))).toEqual({ x: 0, y: 1 });
    expect(perp(vec(0, 1))).toEqual({ x: -1, y: 0 });
  });
});

describe('长度与方向', () => {
  it('length 走 hypot，斜边取整不丢', () => {
    expect(length(vec(3, 4))).toBe(5);
    expect(length(vec(-3, -4))).toBe(5);
  });

  it('normalize 保长度 1', () => {
    const u = normalize(vec(3, 4));
    expect(u.x).toBeCloseTo(0.6, 12);
    expect(u.y).toBeCloseTo(0.8, 12);
    expect(length(u)).toBeCloseTo(1, 12);
  });

  it('零向量归一化直接抛，不返回 NaN', () => {
    expect(() => normalize(vec(0, 0))).toThrow(RangeError);
    expect(() => normalize(vec(0, 0))).toThrow(/零向量/);
  });

  it('angleOf 与 angleBetween 取主值与无向角', () => {
    expect(angleOf(vec(1, 0))).toBe(0);
    expect(angleOf(vec(0, 1))).toBeCloseTo(Math.PI / 2, 12);
    expect(angleBetween(vec(1, 0), vec(0, 1))).toBeCloseTo(Math.PI / 2, 12);
    expect(angleBetween(vec(1, 0), vec(-1, 0))).toBeCloseTo(Math.PI, 12);
    // 无向：反向取钝角的一侧，结果落在 [0, π]
    expect(angleBetween(vec(1, 0), vec(0, -1))).toBeCloseTo(Math.PI / 2, 12);
    expect(angleBetween(vec(2, 4), vec(1, 2))).toBe(0);
  });

  it('advance 沿单位向量前移，负值后退', () => {
    expect(advance(vec(10, 10), vec(1, 0), 5)).toEqual({ x: 15, y: 10 });
    expect(advance(vec(10, 10), vec(1, 0), -2.5)).toEqual({ x: 7.5, y: 10 });
  });
});

describe('平行判定与直线求交', () => {
  it('sinOfAngle 对零向量给 0，不给 NaN', () => {
    expect(sinOfAngle(vec(0, 0), vec(1, 0))).toBe(0);
    expect(sinOfAngle(vec(1, 0), vec(0, 2))).toBeCloseTo(1, 12);
    expect(sinOfAngle(vec(1, 0), vec(-1, 0))).toBe(0);
  });

  it('isParallel 同向与反向都算平行', () => {
    expect(isParallel(vec(1, 0), vec(5, 0))).toBe(true);
    expect(isParallel(vec(1, 0), vec(-5, 0))).toBe(true);
    expect(isParallel(vec(1, 0), vec(0, 5))).toBe(false);
  });

  it('isParallel 是相对判据：大坐标下不误判', () => {
    // 叉积绝对值很大（3e5），但 sin 只有 1e-6 > PARALLEL_EPS → 不平行
    expect(isParallel(vec(3e5, 0), vec(3e5, 0.3))).toBe(false);
    // sin ≈ 1e-12 < PARALLEL_EPS → 平行
    expect(isParallel(vec(3e5, 0), vec(3e5, 3e-7))).toBe(true);
  });

  it('intersectLines 求交点', () => {
    const hit = intersectLines(vec(0, 0), vec(1, 0), vec(2, 3), vec(0, -1));
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(2, 12);
    expect(hit!.y).toBeCloseTo(0, 12);
  });

  it('intersectLines 平行返回 null 而不是 Infinity', () => {
    expect(intersectLines(vec(0, 0), vec(1, 0), vec(0, 5), vec(1, 0))).toBeNull();
  });

  it('PARALLEL_EPS 是 1e-9 量级：接头斜切对角度不敏感到有误差的程度', () => {
    expect(PARALLEL_EPS).toBe(1e-9);
  });
});
```

- [ ] **Step 2: 跑测试确认它红在"导出不存在"**

```bash
cd /d/ReactElectron && pnpm vitest run packages/core/test/vec.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -20
```

Expected: FAIL，报 `does not provide an export named 'intersectLines'`（或首个导入名）。同时 `pnpm typecheck` 报 `TS2305` —— 这两条一起证明测试真在考新代码，而不是碰巧全绿。

- [ ] **Step 3: 实现 `geom/vec.ts`**

```ts
/**
 * 派生层唯一的二维向量类型：浮点毫米（spec D8 的"临时构造计算"侧）。
 * 它的值**永不写回真源** —— 真源只收整数毫米，见 units/mm.ts。
 */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/**
 * 近平行判据的相对容差。用 |sinθ| 而不是叉积绝对值：坐标量级到 2e5 mm 时
 * 叉积绝对值本身没有可比性（Task 1 有一条测试专门钉这点）。
 */
export const PARALLEL_EPS = 1e-9;

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** 标量叉积。> 0 表示 b 在 a 的逆时针侧（即墙的 +normal 侧）。 */
export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

export function length(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function normalize(a: Vec2): Vec2 {
  const l = length(a);
  if (l === 0) throw new RangeError('零向量无法归一化');
  return { x: a.x / l, y: a.y / l };
}

/** 逆时针 90°。墙的"左"侧一律取 +normal，即 perp(dir)。 */
export function perp(a: Vec2): Vec2 {
  return { x: -a.y, y: a.x };
}

export function angleOf(a: Vec2): number {
  return Math.atan2(a.y, a.x);
}

/** 无向夹角，结果落在 [0, π]。共线反向给 π。 */
export function angleBetween(a: Vec2, b: Vec2): number {
  return Math.abs(Math.atan2(cross(a, b), dot(a, b)));
}

/** dir 必须是单位向量（来自 normalize），调用方保证。 */
export function advance(origin: Vec2, dir: Vec2, dist: number): Vec2 {
  return { x: origin.x + dir.x * dist, y: origin.y + dir.y * dist };
}

/** 带符号夹角的正弦。任一向量为零时给 0（退化方向按"平行"处理，交由上层抛错或平接）。 */
export function sinOfAngle(a: Vec2, b: Vec2): number {
  const l = length(a) * length(b);
  return l === 0 ? 0 : cross(a, b) / l;
}

export function isParallel(a: Vec2, b: Vec2): boolean {
  return Math.abs(sinOfAngle(a, b)) <= PARALLEL_EPS;
}

/**
 * 两条无限直线求交：p 沿 dir、q 沿 other。
 * 平行（含近平行）返回 null —— 绝不返回 Infinity 或 NaN，
 * 因为 Task 4 的接头会把这些点直接写进派生多边形。
 */
export function intersectLines(p: Vec2, dir: Vec2, q: Vec2, other: Vec2): Vec2 | null {
  const den = cross(dir, other);
  if (Math.abs(den) <= PARALLEL_EPS * length(dir) * length(other)) return null;
  const t = cross(sub(q, p), other) / den;
  return advance(p, dir, t);
}
```

`packages/core/src/index.ts` 末尾加：

```ts
export * from './geom/vec';
```

- [ ] **Step 4: 跑测试确认全绿**

```bash
pnpm vitest run packages/core/test/vec.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -6
pnpm verify 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -5
```

Expected: 新增 14 passed；`pnpm verify` 全绿（计划 1 的 77 passed 不变，`lint:deps` 通过 —— 新文件在 `core` 内且零 `@dajia/*` 导入）。

- [ ] **Step 5: 变异检查（防"测试考的是空气"）**

临时把 `normalize` 的零向量抛错改成 `return { x: 0, y: 0 }`，跑：

```bash
pnpm vitest run packages/core/test/vec.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "Tests|failed"
```

Expected: `零向量归一化直接抛，不返回 NaN` 这条必须红。再临时把 `isParallel` 改成用叉积绝对值 `Math.abs(cross(a,b)) <= PARALLEL_EPS`，Expected: `isParallel 是相对判据` 必须红。两次改完各自还原，`git diff` 必须为空。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/geom/vec.ts packages/core/test/vec.test.ts packages/core/src/index.ts
git commit -m "feat: 派生层浮点向量与直线求交"
```

---

#### Task 1 执行回填（2026-09-26，评审后裁决；本任务的权威文本是代码，不是上面那三段）

评审在本任务落地的代码里查出两处会往下游漏的东西，已改并提交为 `6d8ff33`。
**本节列出的三处计划文本已被代码取代，后面九个任务按代码办，不按本文抄：**
（同一处约定在 Task 2 也改过一次：`awayDir` 的 `{ x: -dir.x, y: -dir.y }` 字面量已换成过 `vec()`，
所以**派生层里任何手写 `Vec2` 字面量都得走 `vec()`** —— 这条规矩归 Global Constraints，不看本节也该守。）

1. **±0 归一从一处扩到全部**（裁决⑤）。本节 `perp` 那份 `{ x: -a.y, y: a.x }`（第 355 行）
   与它下面那条"用 `Object.is` 才会红"的说法都只是局部。现在 `vec.ts` 里有一个不导出的
   `noNegZero` + `point()`，`vec / add / sub / scale / normalize / perp / advance` 返回的每个
   分量都过它，`intersectLines` 经 `advance` 顺带覆盖。理由是行为不是观感：
   `scale(vec(0,5),-1)` 的 x 实测是 `-0`，而 `Math.atan2(-0,-1) = -π` 与 `Math.atan2(0,-1) = +π`
   分属两支 —— Task 4 的 cross 分支按"方向角更小的那族当直通"选直通墙，一枚 `-0` 能把分类翻过来。
   **真源边界一并封了**（这一条动了计划 1 的 `units/mm.ts`，与"文件结构"一节的"已存在，不改"相左，
   以本节为准）：`quantizeMm` 返回 `Math.round(value) + 0`，`assertMm` 对 `±0` 归一为 `+0`，
   `mm.ts:8` 那句"`-0.5 → -0`（与 0 全等）"的注释同步改写。因为 `JSON.stringify(-0) === "0"`，
   一枚进了 `PointEntity` 的 `-0` 能躲过 `canonical()` 与全部逐字节撤销比对，只在内存里的
   `Object.is` / vitest `toEqual` 下现形 —— 那正是 Task 5 / 8 / 10 的断言方式。
2. **退化方向轴改为抛**（裁决⑥）。本节第 257 行"`sinOfAngle` 零向量给 0"与第 388 行
   `intersectLines` 自己重推的平行判据都作废：`sinOfAngle` 现在抛
   `RangeError('零向量无方向，无法求夹角正弦')`，`isParallel` / `intersectLines` 继承，
   `intersectLines` 内部改调 `isParallel`（同一判据不留两份）。这是"不做兜底"那条约束赢过计划文本：
   零长轴是缺陷，不是"恰好平行"。**给 Task 4 的口径变化**：`isParallel` / `intersectLines` 的
   入参必须是 `normalize` 过的非零向量 —— 而 `wallAxis` 给的就是，命令层也早把零长墙挡在外面，
   所以 Task 4 的定值与派生都不必为退化情形留分支。
3. **`angleBetween` 仍把退化折成答案**（`atan2(0,0) → 0`），与第 2 条同源但不在本任务的判据里，
   留给终审定夺；`dot` / `cross` / `sinOfAngle` 的**标量**返回值也不归一（裁决⑤明确划在范围外，
   Task 4 只以 `Math.abs` 与阈值比较用它们）。
   **【终审 M-9 已裁决：跟着第 2 条走，抛。】** 计划 2 收口时 `angleBetween` 加上零长度守卫
   （`if (length(a) === 0 || length(b) === 0) throw new RangeError('零向量无方向，无法求夹角')`），
   与同文件 `sinOfAngle`（紧挨在它下面那个）的"不把退化输入折叠成平行"同一口径 —— 两条相邻函数一个抛一个折，
   下一个人无从判断哪条是规矩。src 消费者为 0（当时已核），所以这条不改任何派生行为，只改
   `vec.test.ts` 的退化用例（`toBe(0)` → `toThrow`）。

执行日志写在这里：`vec.test.ts` 14→21 条、`units.test.ts` 7→9 条，`pnpm verify` 91→**100 passed**；
三处变异（回退 `scale` 的归一 / 把 `sinOfAngle` 折回 0 / 回退 `quantizeMm` 的 `+ 0`）分别红
2 / 3 / 2 条，均已还原；`{x: -0}` 字面量经 esbuild 的 TS loader 后仍是 `-0`（实测），
所以那些靠字面量喂 `-0` 的用例不是空气断言。

---

### Task 2: 实体读取断言与墙轴线派生

把计划 1 藏在 `commands/wall.ts` 里的 `mustExist` / `requireWall` / `requirePoint` 提成共用（派生层要用同样的话报错，不能各写一份中文文案），再建 `WallAxis`：真源整数端点 → 单位方向、法向、**浮点**轴长。斜墙轴长天生不是整数（3-4-5 除外），这正是 D8 把浮点限定在临时构造里的原因。

**Files:**
- Create: `packages/core/src/model/read.ts`
- Create: `packages/core/src/geom/axis.ts`
- Modify: `packages/core/src/commands/wall.ts`（删本地三函数 + `axisLengthMm`，改 import）
- Create: `packages/core/test/read.test.ts`
- Create: `packages/core/test/axis.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: Task 1 的 `Vec2` / `vec` / `sub` / `normalize` / `perp` / `length` / `advance`；计划 1 的 `Document` / `WallEntity` / `PointEntity` / `Mm`
- Produces: `mustExist(doc, id, label): Entity`、`requireWall(doc, wallId): WallEntity`、`requirePoint(doc, id, label): PointEntity`、`WallEnd = 'start' | 'end'`、`WallAxis`（见契约表）、`wallAxis(doc, wall): WallAxis`、`wallAxisById(doc, wallId): WallAxis`、`otherEnd(end): WallEnd`、`endPointId(wall, end): EntityId`、`endPoint(axis, end): Vec2`、`awayDir(axis, end): Vec2`、`cornerPoint(axis, end, side: -1 | 1, trimMm): Vec2`

- [ ] **Step 1: 写两个失败的测试**

`packages/core/test/read.test.ts`（错误文案必须与计划 1 `commands/wall.ts` 里的私有版本逐字相同 —— `commands.test.ts` 的 `toThrow(/不存在/)` 等正则靠它，改了就会红一条老测试）：

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  mustExist,
  requirePoint,
  requireWall,
  storeyCreate,
  uuidv7,
  wallCreate,
} from '@dajia/core';

const projectId = uuidv7();
const MISSING = '00000000-0000-7000-8000-000000000009';

function logWithOneWall(): TransactionLog {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  const storeyId = log.document.byKind('storey')[0]!.id;
  log.dispatch(
    wallCreate({
      storeyId,
      start: { x: 0, y: 0 },
      end: { x: 3600, y: 0 },
      thicknessMm: 240,
      heightMm: 3000,
    }),
  );
  return log;
}

describe('model/read 的三个断言', () => {
  it('mustExist 缺失时抛中文 label + id', () => {
    const log = logWithOneWall();
    expect(() => mustExist(log.document, MISSING, '楼层')).toThrow(/楼层 不存在/);
    expect(() => mustExist(log.document, MISSING, '楼层')).toThrow(MISSING);
  });

  it('requireWall 对非墙实体抛「不是墙，是 <kind>」', () => {
    const log = logWithOneWall();
    const storeyId = log.document.byKind('storey')[0]!.id;
    expect(() => requireWall(log.document, storeyId)).toThrow(/不是墙，是 storey/);
  });

  it('requirePoint 对非点实体抛中文文案', () => {
    const log = logWithOneWall();
    const wall = log.document.byKind('wall')[0]!;
    expect(() => requirePoint(log.document, wall.id, '墙起点')).toThrow(/墙起点 不是 point 实体/);
  });

  it('requirePoint 正常路径返回点本体', () => {
    const log = logWithOneWall();
    const wall = log.document.byKind('wall')[0]!;
    expect(requirePoint(log.document, wall.startId, '墙起点').x).toBe(0);
  });
});
```

`packages/core/test/axis.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  awayDir,
  cornerPoint,
  endPoint,
  endPointId,
  otherEnd,
  wallAxisById,
  storeyCreate,
  uuidv7,
  wallCreate,
  type PointEntity,
} from '@dajia/core';

const projectId = uuidv7();

function buildWalls(
  specs: Array<{ start: { x: number; y: number }; end: { x: number; y: number }; thicknessMm: number }>,
) {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  const storeyId = log.document.byKind('storey')[0]!.id;
  for (const s of specs) {
    log.dispatch(wallCreate({ storeyId, heightMm: 3000, ...s }));
  }
  return { log, storeyId };
}

function axisOf(log: TransactionLog, i: number) {
  const wall = log.document.byKind('wall')[i]!;
  return wallAxisById(log.document, wall.id);
}

describe('WallAxis', () => {
  it('正交墙：dir 与 normal 单位正交，lengthMm 精确', () => {
    const { log } = buildWalls([{ start: { x: 0, y: 0 }, end: { x: 3600, y: 0 }, thicknessMm: 240 }]);
    const axis = axisOf(log, 0);
    expect(axis.start).toEqual({ x: 0, y: 0 });
    expect(axis.end).toEqual({ x: 3600, y: 0 });
    expect(axis.dir).toEqual({ x: 1, y: 0 });
    expect(axis.normal).toEqual({ x: 0, y: 1 });
    expect(axis.lengthMm).toBe(3600);
    expect(axis.thicknessMm).toBe(240);
    expect(axis.storeyId).toBe(log.document.byKind('storey')[0]!.id);
  });

  it('斜墙：lengthMm 是浮点，不谎报整数', () => {
    const { log } = buildWalls([{ start: { x: 0, y: 0 }, end: { x: 1000, y: 1000 }, thicknessMm: 200 }]);
    const axis = axisOf(log, 0);
    expect(axis.lengthMm).toBeCloseTo(Math.SQRT2 * 1000, 9);
    expect(Number.isInteger(axis.lengthMm)).toBe(false);
    // 单位向量：长度 1，分量各 0.707…
    expect(Math.hypot(axis.dir.x, axis.dir.y)).toBeCloseTo(1, 12);
  });

  it('反向墙：dir 跟着起终点走，normal 始终逆时针 90°', () => {
    const { log } = buildWalls([{ start: { x: 3600, y: 0 }, end: { x: 0, y: 0 }, thicknessMm: 240 }]);
    const axis = axisOf(log, 0);
    expect(axis.dir).toEqual({ x: -1, y: 0 });
    expect(axis.normal).toEqual({ x: 0, y: -1 });
  });

  it('otherEnd / endPoint / awayDir 三件套自洽', () => {
    const { log } = buildWalls([{ start: { x: 0, y: 0 }, end: { x: 4000, y: 0 }, thicknessMm: 240 }]);
    const axis = axisOf(log, 0);
    const wall = log.document.byKind('wall')[0]!;
    expect(otherEnd('start')).toBe('end');
    expect(otherEnd('end')).toBe('start');
    expect(endPointId(wall, 'start')).toBe(wall.startId);
    expect(endPointId(wall, 'end')).toBe(wall.endId);
    expect(endPointId(wall, otherEnd('start'))).toBe(wall.endId);
    expect(endPoint(axis, 'start')).toEqual({ x: 0, y: 0 });
    expect(endPoint(axis, 'end')).toEqual({ x: 4000, y: 0 });
    // awayDir 从该端点指向墙内部：start 端朝 +x，end 端朝 -x
    expect(awayDir(axis, 'start')).toEqual({ x: 1, y: 0 });
    expect(awayDir(axis, 'end')).toEqual({ x: -1, y: 0 });
    expect(awayDir(axis, 'start')).not.toBe(awayDir(axis, 'end'));
    expect(wall.startId).not.toBe(wall.endId);
  });

  it('cornerPoint：trim=0 时是平接四角，trim>0 时沿轴内退', () => {
    const { log } = buildWalls([{ start: { x: 0, y: 0 }, end: { x: 4000, y: 0 }, thicknessMm: 240 }]);
    const axis = axisOf(log, 0);
    expect(cornerPoint(axis, 'start', 1, 0)).toEqual({ x: 0, y: 120 });
    expect(cornerPoint(axis, 'start', -1, 0)).toEqual({ x: 0, y: -120 });
    expect(cornerPoint(axis, 'end', 1, 0)).toEqual({ x: 4000, y: 120 });
    // start 端内退 120：x 增大；end 端内退 120：x 减小。两侧同号才不串。
    expect(cornerPoint(axis, 'start', 1, 120)).toEqual({ x: 120, y: 120 });
    expect(cornerPoint(axis, 'end', 1, 120)).toEqual({ x: 3880, y: 120 });
  });

  it('cornerPoint 在斜墙上仍落在两侧边线上（用 normal 分量核验）', () => {
    const { log } = buildWalls([{ start: { x: 0, y: 0 }, end: { x: 3000, y: 4000 }, thicknessMm: 200 }]);
    const axis = axisOf(log, 0);
    const c = cornerPoint(axis, 'end', 1, 100);
    // 该点到轴线的垂直距离必须等于半厚 100
    const along = ((c.x - axis.start.x) * axis.dir.x + (c.y - axis.start.y) * axis.dir.y);
    const perpDist = Math.abs(
      (c.x - axis.start.x) * axis.normal.x + (c.y - axis.start.y) * axis.normal.y,
    );
    expect(perpDist).toBeCloseTo(100, 9);
    expect(along).toBeCloseTo(Math.hypot(3000, 4000) - 100, 9);
  });

  it('端点实体缺失时抛，而不是返回 NaN 几何', () => {
    const { log, storeyId } = buildWalls([{ start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, thicknessMm: 50 }]);
    const wall = log.document.byKind('wall')[0]!;
    // 手工构造一个"墙指着不存在的点"的文档：Document.replaceEntities 不校验引用完整性
    const broken = Document.replaceEntities(
      log.document,
      new Map([...log.document.entities].filter(([id]) => id !== wall.startId)),
    );
    expect(() => wallAxisById(broken, wall.id)).toThrow(/墙起点 不存在/);
    expect(storeyId).toBeTruthy();
  });

  it('两端点重合的墙抛零方向（防 normalize 崩在别处）', () => {
    const log = new TransactionLog(Document.create(projectId));
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    const storeyId = log.document.byKind('storey')[0]!.id;
    const shared = '00000000-0000-7000-8000-000000000077';
    const p: PointEntity = { kind: 'point', id: shared, storeyId, x: 5, y: 5 };
    const doc = Document.replaceEntities(log.document, new Map([...log.document.entities, [shared, p]]));
    const degenerate = {
      kind: 'wall' as const,
      id: '00000000-0000-7000-8000-000000000078',
      storeyId,
      startId: shared,
      endId: shared,
      thicknessMm: 100,
      heightMm: 3000,
      elevationOffsetMm: 0,
      loadBearing: true,
      material: 'brick',
    };
    const bad = Document.replaceEntities(doc, new Map([...doc.entities, [degenerate.id, degenerate]]));
    expect(() => wallAxisById(bad, degenerate.id)).toThrow(/两端点重合|零长/);
  });
});
```

- [ ] **Step 2: 跑测试确认它们红**

```bash
pnpm vitest run packages/core/test/read.test.ts packages/core/test/axis.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -15
```

Expected: FAIL，`does not provide an export named 'mustExist'` / `'wallAxisById'`。

- [ ] **Step 3: 实现 `model/read.ts`**

文案与计划 1 `commands/wall.ts` 里的私有版本逐字相同 —— `commands.test.ts` 的 `toThrow(/不存在/)` 等正则靠它，改了就会红一条老测试：

```ts
import type { EntityId } from '../ids';
import type { Document } from './document';
import type { Entity, PointEntity, WallEntity } from './entity';

export function mustExist(doc: Document, id: EntityId, label: string): Entity {
  const entity = doc.get(id);
  if (!entity) throw new TypeError(`${label} 不存在：${id}`);
  return entity;
}

export function requireWall(doc: Document, wallId: EntityId): WallEntity {
  const entity = mustExist(doc, wallId, '墙');
  if (entity.kind !== 'wall') throw new TypeError(`${wallId} 不是墙，是 ${entity.kind}`);
  return entity;
}

export function requirePoint(doc: Document, id: EntityId, label: string): PointEntity {
  const entity = mustExist(doc, id, label);
  if (entity.kind !== 'point') throw new TypeError(`${label} 不是 point 实体：${id}`);
  return entity;
}
```

`packages/core/src/geom/axis.ts`：

```ts
import type { EntityId } from '../ids';
import type { Mm } from '../units/mm';
import type { Document } from '../model/document';
import { mustExist, requirePoint, requireWall } from '../model/read';
import type { WallEntity } from '../model/entity';
import { advance, length, normalize, perp, sub, vec, type Vec2 } from './vec';

export type WallEnd = 'start' | 'end';

/**
 * 墙轴线的派生视图。lengthMm / dir / normal 都是浮点：斜墙轴长不是整数
 * （spec D8 允许浮点只存在于临时构造计算，本目录就是那个"临时构造"）。
 */
export interface WallAxis {
  readonly wallId: EntityId;
  readonly storeyId: EntityId;
  readonly start: Vec2;
  readonly end: Vec2;
  /** 单位向量 start→end */
  readonly dir: Vec2;
  /** perp(dir)：逆时针 90°，墙的左侧 */
  readonly normal: Vec2;
  readonly lengthMm: number;
  readonly thicknessMm: Mm;
}

export function wallAxis(doc: Document, wall: WallEntity): WallAxis {
  const s = requirePoint(doc, wall.startId, '墙起点');
  const e = requirePoint(doc, wall.endId, '墙终点');
  const start = vec(s.x, s.y);
  const end = vec(e.x, e.y);
  const delta = sub(end, start);
  const lengthMm = length(delta);
  if (lengthMm === 0) {
    throw new RangeError(`墙 ${wall.id} 两端点重合，轴线无方向（零长墙应在命令层就被拒绝）`);
  }
  const dir = normalize(delta);
  return {
    wallId: wall.id,
    storeyId: wall.storeyId,
    start,
    end,
    dir,
    normal: perp(dir),
    lengthMm,
    thicknessMm: wall.thicknessMm,
  };
}

export function wallAxisById(doc: Document, wallId: EntityId): WallAxis {
  const wall = requireWall(doc, wallId);
  mustExist(doc, wall.storeyId, '楼层');
  return wallAxis(doc, wall);
}

export function otherEnd(end: WallEnd): WallEnd {
  return end === 'start' ? 'end' : 'start';
}

/** 真源里该端的点 id。Task 3 的共享端点与 Task 4 的接头分组都从它出发。 */
export function endPointId(wall: WallEntity, end: WallEnd): EntityId {
  return end === 'start' ? wall.startId : wall.endId;
}

export function endPoint(axis: WallAxis, end: WallEnd): Vec2 {
  return end === 'start' ? axis.start : axis.end;
}

/** 从该端点指向墙内部的单位方向。接头算的就是"这个端点上，墙往哪走"。 */
export function awayDir(axis: WallAxis, end: WallEnd): Vec2 {
  // 走 vec() 而不是裸字面量：水平墙的 `-axis.dir.y` 给出 -0，而派生层约定不出现 -0
  // （Task 1 执行回填第 1 条）。取负本身照旧，不做兜底。
  return end === 'start' ? axis.dir : vec(-axis.dir.x, -axis.dir.y);
}

/**
 * 该端点某一侧的轮廓角点。side: +1 = normal 侧（左），-1 = -normal 侧（右）。
 * trimMm 是沿 awayDir 的内退距离（0 = 平接到端点，>0 = 斜切掉一段）。
 */
export function cornerPoint(axis: WallAxis, end: WallEnd, side: 1 | -1, trimMm: number): Vec2 {
  const half = axis.thicknessMm / 2;
  const base = advance(endPoint(axis, end), awayDir(axis, end), trimMm);
  return advance(base, axis.normal, side * half);
}
```

`packages/core/src/index.ts` 加两行（位置：`export * from './geom/vec';` 之后）：

```ts
export * from './model/read';
export * from './geom/axis';
```

- [ ] **Step 4: 命令层改吃共用断言与 `wallAxis`**

`packages/core/src/commands/wall.ts`：删掉文件里这四个私有函数（`mustExist` / `requireWall` / `requirePoint` / `axisLengthMm`），改成从 core 内部导入。`axisLengthMm` 的替代必须**保持同样的整数比较语义**，否则 `wallCreate` 那条"墙厚不小于墙长"的老测试会变味：

```ts
import { uuidv7, type EntityId } from '../ids';
import { assertMm, quantizeMm, type Mm } from '../units/mm';
import { mustExist, requirePoint, requireWall } from '../model/read';
import { wallAxis } from '../geom/axis';
import type { Command } from '../model/command';
import type { Document } from '../model/document';
import type { Entity, OpeningEntity, PointEntity, WallEntity } from '../model/entity';
```

调用点逐个替换，只此两处用到长度：

```ts
// wallCreate：量化后的坐标已知，直接算，不查 doc（保持"构造时就拒"的时序）
const lengthMm = Math.hypot(x1 - x0, y1 - y0);
if (thicknessMm >= lengthMm) { /* 原文案不动 */ }

// wallSetThickness.build：改吃 wallAxis
if (thicknessMm >= wallAxis(doc, wall).lengthMm) {
  throw new RangeError(`墙厚 ${thicknessMm} 不小于墙长，轮廓会自相交`);
}
```

`requirePoint` 在 `wallMoveEndpoint` 里还在用（移动点与锚点），改 import 后不动调用。删干净后跑：

```bash
pnpm typecheck 2>&1 | tail -5
```

Expected: 退出码 0。若报 `TS6133 'axisLengthMm' is declared but its value is never read` 说明函数没删净；报 `noUnusedLocals` 类错误一律是删多了，照错误行补回。

- [ ] **Step 5: 全绿 + 变异检查**

```bash
pnpm verify 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -5
```

Expected: 计划 1 的 77 passed 全在（`commands.test.ts` 没被文案改动打破）+ Task 1 落地后的 100 条（含其修复轮新增的 9 条：vec 14→21、units 7→9）+ 本任务 12（read 4 条、axis 8 条），总计 112 passed，0 失败。

变异：把 `cornerPoint` 里 `side * half` 改成 `half`（丢掉一侧符号），Expected: `cornerPoint：trim=0 时是平接四角` 必须红。再把 `awayDir(axis,'end')` 写成 `axis.dir`（反向搞错），Expected: `otherEnd / endPoint / awayDir 三件套自洽` 与至少一条 `cornerPoint` 用例红。两次都还原后 `git diff` 为空。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/model/read.ts packages/core/src/geom/axis.ts packages/core/src/commands/wall.ts packages/core/test/read.test.ts packages/core/test/axis.test.ts packages/core/src/index.ts
git commit -m "feat: 墙轴线派生与共用实体断言"
```

执行日志写在这里：把实际 passed 数、变异检查的每条红项、以及 `wallAxis` 与旧 `axisLengthMm` 的语义差异（浮点 vs 同为浮点 hypot）记清楚。

---

### Task 3: 共享端点进真源 + 移动端点的邻墙守卫

本任务是计划 2 唯一改动**真源语义**的一步：`wallCreate` 从此接受 `{ pointId }`，两面墙可以指向同一个点实体。计划 1 的 `wallCreate` 注释写着"共享端点与接头吸附属计划 2，这里总是新建两个端点"，这句注释在本任务作废。

为什么它必须先于接头（Task 4）：接头靠"共享 `pointId` 分组"识别，没有共享点就没有接头可言 —— 而 L/T/十字接头的**无缝闭合**（spec 5.2 与第 10 节的验收）本质是拓扑问题，不是浮点问题。同时这里收掉计划 1 自审记下的一条洞：`wallMoveEndpoint` 只查被拖的那面墙，将来墙网一旦共享端点，把拐角拖过头就会把**邻墙**拖成零长或墙厚 ≥ 轴长的非法轮廓，而命令层毫无反应。本任务补上这道守卫。

**Files:**
- Create: `packages/core/src/geom/topology.ts`
- Create: `packages/core/test/topology.test.ts`
- Modify: `packages/core/src/commands/wall.ts`（`WallCreateInput.start/end` 改 `PointRef`；抽 `assertWallShape`；`wallMoveEndpoint` 加邻墙守卫）
- Modify: `packages/core/src/index.ts`（`export * from './geom/topology';`）

**Interfaces:**
- Consumes: Task 2 的 `mustExist` / `requirePoint` / `requireWall` / `WallEnd` / `otherEnd` / `endPointId`；计划 1 的 `quantizeMm` / `assertMm` / `uuidv7`
- Produces: `PointRef`、`isExistingPoint`、`WallEndRef`、`resolvePointRef(doc, ref, storeyId): PointEntity | null`、`incidentWallEnds(doc, pointId, excludeWallId?): WallEndRef[]`、`sharedPointIds(doc): EntityId[]`、`dependentsOf(doc, id): EntityId[]`；改签名的 `WallCreateInput`（`start: PointRef; end: PointRef`）与 `wallMoveEndpoint`（`end: WallEnd`）

**本任务新增的错误文案（后续任务与计划 3 的 UI 要靠这些正则定位失败原因）：**

| 抛出点 | 文案 |
|---|---|
| `resolvePointRef` 跨楼层复用 | `端点 <id> 属于楼层 <sid>，不能给楼层 <sid2> 复用` |
| `wallMoveEndpoint` 邻墙零长 | `移动端点会让墙 <id> 变成零长：它与本墙共享端点 <pid>` |
| `wallMoveEndpoint` 邻墙非法轮廓 | `移动端点会让墙 <id> 的墙厚 <t> 不小于轴长 <L>，轮廓会自相交` |
| `wallMoveEndpoint` 本墙非法轮廓 | 同上文案，`<id>` 是被拖的这面墙（UI 不必分两条正则，两种情况都命中 `/不小于轴长/`） |
| `resolveEnd` 端点解析失败 | `端点 <id> 无法解析`（`commands/wall.ts` 的 `resolveEnd`。**当前不可达**：`resolvePointRef` 对 `{pointId}` 形态要么返点要么抛，留着这句只为让类型收窄成立。终审挂账 #3 把它补进表，是因为它在文本里——UI 若将来对全部抛错做正则映射，这条要么显式标"不可达"，要么别指望它兜底） |

- [ ] **Step 1: 写失败的测试**

`packages/core/test/topology.test.ts`。`commands.test.ts` 里那三条老测试（`/整数毫米/`、`/零长/`、`/不小于墙长/`）走的是**字面坐标**路径，本任务必须一条不破 —— 它们就是 `assertWallShape` 提取正不正确的哨兵。

```ts
// 第 1 段：imports、fixture、PointRef 解析与共享端点查询
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  dependentsOf,
  incidentWallEnds,
  isExistingPoint,
  resolvePointRef,
  sharedPointIds,
  storeyCreate,
  uuidv7,
  wallCreate,
  wallDelete,
  wallMoveEndpoint,
  type ColumnEntity,
  type OpeningEntity,
  type PointEntity,
  type SlabEntity,
  type WallCreateInput,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();

/**
 * 取这次 dispatch 新建的墙。**不能**写 `byKind('wall').at(-1)`：
 * 计划 1 的 ids.test.ts 专门钉了"同毫秒不保证有序"，同一毫秒建两面墙时那样取是掷硬币。
 * `affected` 恰好是本次补丁写入的 id 集合（patch.upsert 顺序：起点、终点、墙），
 * 里面只有一面墙，取它确定无疑。
 */
function lastWall(log: TransactionLog): WallEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建墙');
}

function buildLog(): TransactionLog {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  return log;
}

function storey0(log: TransactionLog): string {
  return storeyByIndex(log, 0);
}

/**
 * 按 index 取楼层 id。**不要**写 `byKind('storey')[1]`：byKind 是 id 升序，
 * 而同一毫秒内的 uuidv7 不保证单调（Global Constraints），两个楼层的下标是掷硬币。
 */
function storeyByIndex(log: TransactionLog, index: number): string {
  const hit = log.document.byKind('storey').find((s) => s.index === index);
  if (!hit) throw new Error(`测试找不到楼层 index=${index}`);
  return hit.id;
}

function addWall(log: TransactionLog, spec: Omit<WallCreateInput, 'storeyId'>): WallEntity {
  log.dispatch(wallCreate({ storeyId: storey0(log), heightMm: 3000, ...spec }));
  return lastWall(log);
}

/** 拐角在 (3600, 0)：第一面墙 A(0,0)→B，第二面墙 B→C(3600,2400)，B 是共享点。 */
function lCorner(): {
  log: TransactionLog;
  sharedId: string;
  first: WallEntity;
  second: WallEntity;
} {
  const log = buildLog();
  const first = addWall(log, {
    start: { x: 0, y: 0 },
    end: { x: 3600, y: 0 },
    thicknessMm: 240,
  });
  const sharedId = first.endId;
  const second = addWall(log, {
    start: { pointId: sharedId },
    end: { x: 3600, y: 2400 },
    thicknessMm: 240,
  });
  return { log, sharedId, first, second };
}

describe('PointRef 与 resolvePointRef', () => {
  it('isExistingPoint 认得两种形态', () => {
    expect(isExistingPoint({ x: 0, y: 0 })).toBe(false);
    expect(isExistingPoint({ pointId: uuidv7() })).toBe(true);
    // 三个字段都给时以 pointId 为准：判据不能写成 "没有 x 就是复用"
    expect(isExistingPoint({ x: 1, y: 2, pointId: uuidv7() })).toBe(true);
  });

  it('坐标字面量给 null：点还不存在，由命令层新建', () => {
    const log = buildLog();
    expect(resolvePointRef(log.document, { x: 100, y: 200 }, storey0(log))).toBeNull();
  });

  it('既有 pointId 给点本体', () => {
    const { log, sharedId } = lCorner();
    const p = resolvePointRef(log.document, { pointId: sharedId }, storey0(log));
    expect(p).not.toBeNull();
    expect(p!.x).toBe(3600);
    expect(p!.y).toBe(0);
    expect(p!.storeyId).toBe(storey0(log));
  });

  it('跨楼层复用直接抛：点属于别的楼层', () => {
    const log = buildLog();
    const s0 = storey0(log);
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    const s1 = storeyByIndex(log, 1);
    expect(s1).not.toBe(s0);
    // 手工造一个属于楼层 1 的点：opening/column 的命令还没实现，点也不能凭空长出来
    const p: PointEntity = { kind: 'point', id: uuidv7(), storeyId: s1, x: 800, y: 800 };
    const doc = Document.replaceEntities(
      log.document,
      new Map([...log.document.entities, [p.id, p]]),
    );
    expect(() => resolvePointRef(doc, { pointId: p.id }, s0)).toThrow(/属于楼层/);
    expect(() => resolvePointRef(doc, { pointId: p.id }, s0)).toThrow(/不能给楼层/);
    // 正对照：同一点交给它自己的楼层就不抛，说明抛错的原因是跨层而不是点本身非法
    expect(resolvePointRef(doc, { pointId: p.id }, s1)).toBe(p);
  });

  it('pointId 指向非点实体时抛「端点 不是 point 实体」', () => {
    const { log, first } = lCorner();
    expect(() => resolvePointRef(log.document, { pointId: first.id }, storey0(log))).toThrow(
      /端点 不是 point 实体/,
    );
  });
});

describe('共享端点查询', () => {
  it('incidentWallEnds：拐角两面墙，排除自己只剩邻墙，且端点角色正确', () => {
    const { log, sharedId, first, second } = lCorner();
    const all = incidentWallEnds(log.document, sharedId);
    expect(all).toEqual([
      { wallId: first.id, end: 'end' },
      { wallId: second.id, end: 'start' },
    ]);
    expect(incidentWallEnds(log.document, sharedId, first.id)).toEqual([
      { wallId: second.id, end: 'start' },
    ]);
  });

  it('incidentWallEnds：独占的点只有自己', () => {
    const { log, sharedId, first } = lCorner();
    expect(incidentWallEnds(log.document, first.startId)).toEqual([
      { wallId: first.id, end: 'start' },
    ]);
    expect(incidentWallEnds(log.document, first.startId, first.id)).toEqual([]);
    expect(sharedId).toBeTruthy();
  });

  it('sharedPointIds：孤墙给空，L 形给那一个', () => {
    const lonely = buildLog();
    addWall(lonely, { start: { x: 0, y: 0 }, end: { x: 3600, y: 0 }, thicknessMm: 240 });
    expect(sharedPointIds(lonely.document)).toEqual([]);
    const { log, sharedId } = lCorner();
    expect(sharedPointIds(log.document)).toEqual([sharedId]);
    expect(log.document.byKind('point')).toHaveLength(3);
  });
});
```

`incidentWallEnds` 那条用 `toEqual` 比数组：`byKind('wall')` 按 id 升序，所以顺序就是创建顺序，断言写得动静态都对。

```ts
// 第 2 段：接在同一个文件末尾
describe('dependentsOf', () => {
  /** 一个 L 角 + 挂在第一面墙上的门 + 落在共享点的柱与板 */
  function docWithEverything(): {
    log: TransactionLog;
    doc: Document;
    first: WallEntity;
    second: WallEntity;
    sharedId: string;
    openingId: string;
    columnId: string;
    slabId: string;
  } {
    const { log, sharedId, first, second } = lCorner();
    const storeyId = storey0(log);
    const opening: OpeningEntity = {
      kind: 'opening',
      id: uuidv7(),
      storeyId,
      hostWallId: first.id,
      distanceMm: 500,
      widthMm: 900,
      heightMm: 2100,
      sillMm: 0,
      category: 'door',
    };
    const column: ColumnEntity = {
      kind: 'column',
      id: uuidv7(),
      storeyId,
      pointId: sharedId,
      widthMm: 400,
      depthMm: 400,
      heightMm: 3000,
      loadBearing: true,
      material: 'concrete',
    };
    const slab: SlabEntity = {
      kind: 'slab',
      id: uuidv7(),
      storeyId,
      boundaryPointIds: [sharedId],
      thicknessMm: 120,
      elevationOffsetMm: 0,
    };
    const doc = Document.replaceEntities(
      log.document,
      new Map([
        ...log.document.entities,
        [opening.id, opening],
        [column.id, column],
        [slab.id, slab],
      ]),
    );
    return {
      log,
      doc,
      first,
      second,
      sharedId,
      openingId: opening.id,
      columnId: column.id,
      slabId: slab.id,
    };
  }

  it('点 → 引用它的墙柱板；只给一层，洞口的下游要调用方自己迭代', () => {
    const x = docWithEverything();
    expect(new Set(dependentsOf(x.doc, x.sharedId))).toEqual(
      new Set([x.first.id, x.second.id, x.columnId, x.slabId]),
    );
    // 洞口挂在墙下：本函数不递归，Task 9 负责迭代到不动点
    expect(dependentsOf(x.doc, x.sharedId)).not.toContain(x.openingId);
  });

  it('墙 → 它的洞口', () => {
    const x = docWithEverything();
    expect(dependentsOf(x.doc, x.first.id)).toEqual([x.openingId]);
  });

  it('楼层 → 该层墙与洞口（Task 8 的 storey.setElevation 靠它找下游）', () => {
    const x = docWithEverything();
    expect(new Set(dependentsOf(x.doc, storey0(x.log)))).toEqual(
      new Set([...x.doc.byKind('wall').map((w) => w.id), x.openingId]),
    );
  });

  it('叶子（洞口/柱/板）给空；实体不存在直接抛', () => {
    const x = docWithEverything();
    expect(dependentsOf(x.doc, x.openingId)).toEqual([]);
    expect(dependentsOf(x.doc, x.columnId)).toEqual([]);
    expect(dependentsOf(x.doc, x.slabId)).toEqual([]);
    expect(() => dependentsOf(x.doc, uuidv7())).toThrow(/实体 不存在/);
  });
});
```

`storey0(x.log)` 读的是 `x.log`（拖动/加实体前的那份文档），而断言打在 `x.doc` 上 —— 两者 `byKind('storey')` 相同，因为 `Document.replaceEntities` 不动没被 patch 的实体。这样写是为了不让测试为了取一个楼层 id 再复制一遍 fixture。

```ts
// 第 3 段：命令级用例，接在同一个文件末尾
describe('wallCreate 复用端点进真源', () => {
  it('L 形只新建 3 个点；同坐标各建各的仍是 4 个点', () => {
    const { log, sharedId, second } = lCorner();
    expect(log.document.byKind('point')).toHaveLength(3);
    expect(sharedPointIds(log.document)).toEqual([sharedId]);
    expect(second.startId).toBe(sharedId);
    // 正对照：同样几何、不复用 → 4 个点、无共享。少了这条，上面的 3 可能是恒真。
    const dup = buildLog();
    addWall(dup, { start: { x: 0, y: 0 }, end: { x: 3600, y: 0 }, thicknessMm: 240 });
    addWall(dup, { start: { x: 3600, y: 0 }, end: { x: 3600, y: 2400 }, thicknessMm: 240 });
    expect(dup.document.byKind('point')).toHaveLength(4);
    expect(sharedPointIds(dup.document)).toEqual([]);
  });

  it('复用的点不进补丁：affected 只有新墙与新点', () => {
    const { log, sharedId, second } = lCorner();
    expect(log.affected).toEqual(new Set([second.id, second.endId]));
    expect(log.affected.has(sharedId)).toBe(false);
    expect(second.startId).toBe(sharedId);
  });

  it('撤销回到单墙，重做不产生新点', () => {
    const { log, sharedId } = lCorner();
    const afterFirst = log.document.canonical();
    const pointsBefore = log.document.byKind('point').length;
    expect(log.undo()).toBe(true);
    expect(log.document.canonical()).toBe(afterFirst);
    expect(log.redo()).toBe(true);
    expect(log.document.byKind('point')).toHaveLength(pointsBefore);
    expect(sharedPointIds(log.document)).toEqual([sharedId]);
  });

  it('两端复用同一个 pointId = 零长墙，拒在 build', () => {
    const { log, sharedId } = lCorner();
    const before = log.document.canonical();
    expect(() =>
      log.dispatch(
        wallCreate({
          storeyId: storey0(log),
          start: { pointId: sharedId },
          end: { pointId: sharedId },
          thicknessMm: 240,
          heightMm: 3000,
        }),
      ),
    ).toThrow(/零长/);
    expect(log.document.canonical()).toBe(before);
  });

  it('复用端点导致墙厚 ≥ 轴长：构造期算不出来，必须拒在 build', () => {
    const { log, sharedId } = lCorner();
    const before = log.document.canonical();
    // (3600,0) → (3600,200) 轴长 200 < 墙厚 240；起点是复用的，构造期无从得知它的坐标
    expect(() =>
      log.dispatch(
        wallCreate({
          storeyId: storey0(log),
          start: { pointId: sharedId },
          end: { x: 3600, y: 200 },
          thicknessMm: 240,
          heightMm: 3000,
        }),
      ),
    ).toThrow(/不小于墙长/);
    expect(log.document.canonical()).toBe(before);
    expect(log.depth).toBe(2);
  });

  it('正对照：两端都是坐标字面量时，构造期就抛，连文档都不需要', () => {
    // 计划 1 的时序承诺：这类非法输入在 wallCreate(...) 这一步就拒，不进入 dispatch
    expect(() =>
      wallCreate({
        storeyId: '不存在的楼层',
        start: { x: 100, y: 100 },
        end: { x: 100.2, y: 100.1 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    ).toThrow(/零长/);
    expect(() =>
      wallCreate({
        storeyId: '不存在的楼层',
        start: { x: 0, y: 0 },
        end: { x: 100, y: 0 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    ).toThrow(/不小于墙长/);
  });
});

describe('wallMoveEndpoint 带走邻墙', () => {
  it('拖拐角：两面墙同步跟随，共享关系不变', () => {
    const { log, sharedId, first, second } = lCorner();
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 1200 }));
    const p = log.document.get(sharedId) as PointEntity;
    expect([p.x, p.y]).toEqual([3600, 1200]);
    expect((log.document.get(first.id) as WallEntity).endId).toBe(sharedId);
    expect((log.document.get(second.id) as WallEntity).startId).toBe(sharedId);
    expect(sharedPointIds(log.document)).toEqual([sharedId]);
  });

  it('affected 仍只有那一个点 —— 记档：Task 9 必须用 dependentsOf 扩脏', () => {
    const { log, sharedId, first } = lCorner();
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 1200 }));
    expect(log.affected).toEqual(new Set([sharedId]));
    // 派生层与索引要重算的却是两墙 + 它们的洞口：这就是反向依赖闭包存在的理由
    expect(new Set(dependentsOf(log.document, sharedId))).toEqual(
      new Set(log.document.byKind('wall').map((w) => w.id)),
    );
  });

  it('邻墙被拖成零长 → 抛，且文档一点没动', () => {
    const { log, first, second } = lCorner();
    const before = log.document.canonical();
    expect(() =>
      log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 2400 })),
    ).toThrow(/移动端点会让墙/);
    expect(() =>
      log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 2400 })),
    ).toThrow(second.id);
    expect(log.document.canonical()).toBe(before);
    expect(log.depth).toBe(2);
  });

  it('邻墙被拖成墙厚 ≥ 轴长 → 抛（守卫的是非法轮廓，不只是零长）', () => {
    const { log, first } = lCorner();
    const before = log.document.canonical();
    // 新位置 (3600,2200)：邻墙 B→C 轴长 200 < 墙厚 240
    expect(() =>
      log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 2200 })),
    ).toThrow(/墙厚 240 不小于轴长 200/);
    expect(log.document.canonical()).toBe(before);
  });

  it('把自己这面墙拖成墙厚 ≥ 轴长 → 抛（邻墙循环一轮不进，也要有守卫）', () => {
    const log = buildLog();
    const wall = addWall(log, {
      start: { x: 0, y: 0 },
      end: { x: 3600, y: 0 },
      thicknessMm: 240,
    });
    // 没有任何共享端点：这道守卫盯的是本墙自己，与邻墙循环无关
    expect(sharedPointIds(log.document)).toEqual([]);
    const before = log.document.canonical();
    expect(() =>
      log.dispatch(wallMoveEndpoint({ wallId: wall.id, end: 'end', x: 200, y: 0 })),
    ).toThrow(/墙厚 240 不小于轴长 200/);
    expect(log.document.canonical()).toBe(before);
    expect(log.depth).toBe(2);
    // 正对照：300 ≥ 240 合法。少了它，"改成恒抛"这一变异能蒙过上一条断言。
    log.dispatch(wallMoveEndpoint({ wallId: wall.id, end: 'end', x: 300, y: 0 }));
    expect((log.document.get(wall.endId) as PointEntity).x).toBe(300);
  });

  it('正对照：同一坐标在不共享的文档上合法 —— 证明上面两条红是因为共享，不是坐标本身非法', () => {
    const log = buildLog();
    const first = addWall(log, {
      start: { x: 0, y: 0 },
      end: { x: 3600, y: 0 },
      thicknessMm: 240,
    });
    const neighbour = addWall(log, {
      start: { x: 3600, y: 0 },
      end: { x: 3600, y: 2400 },
      thicknessMm: 240,
    });
    expect(sharedPointIds(log.document)).toEqual([]);
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 2200 }));
    expect((log.document.get(first.endId) as PointEntity).y).toBe(2200);
    // 邻墙纹丝不动：坐标一样但不共享点，于是没有联动。
    // 断言打在 neighbour.startId 这个点上 —— 若实现改成"按坐标吸附"，这里会跟着动，测试就红。
    expect(neighbour.startId).not.toBe(first.endId);
    expect((log.document.get(neighbour.startId) as PointEntity).y).toBe(0);
  });

  it('撤销拖动的拐角：两墙一起回位', () => {
    const { log, sharedId, first } = lCorner();
    const before = log.document.canonical();
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 1200 }));
    expect(log.document.canonical()).not.toBe(before);
    expect(log.undo()).toBe(true);
    expect((log.document.get(sharedId) as PointEntity).y).toBe(0);
    expect(log.document.canonical()).toBe(before);
  });
});

describe('wallDelete 与共享端点', () => {
  it('删 L 形的一面墙，共享点必须留下，撤销后重新共享', () => {
    const { log, sharedId, first, second } = lCorner();
    const before = log.document.canonical();
    log.dispatch(wallDelete({ wallId: first.id }));
    expect(log.document.get(sharedId)).toBeDefined();
    expect(log.document.byKind('point')).toHaveLength(2);
    expect(sharedPointIds(log.document)).toEqual([]);
    expect(second.startId).toBe(sharedId);
    log.undo();
    expect(log.document.canonical()).toBe(before);
    expect(sharedPointIds(log.document)).toEqual([sharedId]);
  });
});
```

`lCorner` 里 `addWall` 用 `lastWall(log)`（读 `log.affected`）取新墙，**不是** `byKind('wall').at(-1)` —— 见 Global Constraints 里"同毫秒 uuidv7 不保证单调"那条。

- [ ] **Step 2: 跑测试确认它们红**

```bash
pnpm vitest run packages/core/test/topology.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -20
```

Expected: FAIL。两类红：`does not provide an export named 'incidentWallEnds'`；`pnpm typecheck` 另报 `TS2353`/`TS2322`，因为 `{ pointId }` 还不在 `WallCreateInput.start` 的类型里。这两条一起证明测试在考新代码。

- [ ] **Step 3: 实现 `geom/topology.ts`**

```ts
import type { EntityId } from '../ids';
import type { Document } from '../model/document';
import type { PointEntity } from '../model/entity';
import { mustExist, requirePoint } from '../model/read';
import { endPointId, otherEnd, type WallEnd } from './axis';

/**
 * 命令入参的端点：给坐标就新建点，给 pointId 就复用既有点。
 * 拓扑闭合（接头、整层连通性）全靠后者 —— 真源里存"两个坐标相同的点"永远合不上。
 */
export type PointRef =
  | { readonly x: number; readonly y: number }
  | { readonly pointId: EntityId };

/**
 * 判据是 pointId 而非 'x' in ref：TS 的 `in` 收窄要求两者互斥，
 * 而调用方传多余字段（{x, y, pointId}）时"以 pointId 为准"是本函数定的规矩。
 */
export function isExistingPoint(ref: PointRef): ref is { readonly pointId: EntityId } {
  return 'pointId' in ref;
}

export interface WallEndRef {
  readonly wallId: EntityId;
  readonly end: WallEnd;
}

/**
 * ref 落到文档里的点。字面坐标返回 null（点还不存在，由命令层新建）。
 * 复用即跨层检查：点必须存在、必须是 point、必须属于这个构件的楼层。
 * 少这一条，拖楼层 1 的拐角会改掉楼层 2 的墙 —— 两层的墙网凭空焊死。
 * 第三个参数一律取"新构件所在层"：Task 8 的柱与板传自己的 storeyId，共用这一份判据。
 */
export function resolvePointRef(
  doc: Document,
  ref: PointRef,
  storeyId: EntityId,
): PointEntity | null {
  if (!isExistingPoint(ref)) return null;
  const point = requirePoint(doc, ref.pointId, '端点');
  if (point.storeyId !== storeyId) {
    throw new TypeError(
      `端点 ${point.id} 属于楼层 ${point.storeyId}，不能给楼层 ${storeyId} 复用`,
    );
  }
  return point;
}

/** 指着这个点的墙端（byKind 已按 id 升序，故结果确定）。excludeWallId 用于"除我之外还有谁"。 */
export function incidentWallEnds(
  doc: Document,
  pointId: EntityId,
  excludeWallId?: EntityId,
): WallEndRef[] {
  const out: WallEndRef[] = [];
  for (const wall of doc.byKind('wall')) {
    if (wall.id === excludeWallId) continue;
    // 两个 if 不写 else：一堵墙理论上不可能两端同点（零长墙在命令层就被拒），
    // 但真源不校验引用完整性，写出这种墙时这里必须两条都报，而不是静默漏一条。
    if (wall.startId === pointId) out.push({ wallId: wall.id, end: 'start' });
    if (wall.endId === pointId) out.push({ wallId: wall.id, end: 'end' });
  }
  return out;
}

/** 被两面以上墙共享的点。Task 4 的接头分组从它出发。 */
export function sharedPointIds(doc: Document): EntityId[] {
  const count = new Map<EntityId, number>();
  for (const wall of doc.byKind('wall')) {
    for (const id of [wall.startId, wall.endId]) {
      count.set(id, (count.get(id) ?? 0) + 1);
    }
  }
  return [...count]
    .filter(([, n]) => n >= 2)
    .map(([id]) => id)
    .sort();
}

/**
 * 反向依赖**一层**：这个实体被谁直接引用。
 * 闭包（迭代到不动点）是调用方的事 —— Task 9 的局部重建要的是"点脏 → 墙脏 → 墙上洞口也脏"，
 * 在这一层里塞递归会让本函数没法单测。
 * 计划 1 的 `wallDelete.stillReferenced` 是它的特例（"还有没有人引用，有则不许删点"）。
 */
export function dependentsOf(doc: Document, id: EntityId): EntityId[] {
  const entity = mustExist(doc, id, '实体');
  const out = new Set<EntityId>();
  switch (entity.kind) {
    case 'point':
      for (const wall of doc.byKind('wall')) {
        if (wall.startId === id || wall.endId === id) out.add(wall.id);
      }
      for (const column of doc.byKind('column')) {
        if (column.pointId === id) out.add(column.id);
      }
      for (const slab of doc.byKind('slab')) {
        if (slab.boundaryPointIds.includes(id)) out.add(slab.id);
      }
      break;
    case 'wall':
      for (const opening of doc.byKind('opening')) {
        if (opening.hostWallId === id) out.add(opening.id);
      }
      break;
    case 'storey':
      for (const wall of doc.byKind('wall')) if (wall.storeyId === id) out.add(wall.id);
      for (const opening of doc.byKind('opening')) if (opening.storeyId === id) out.add(opening.id);
      for (const column of doc.byKind('column')) if (column.storeyId === id) out.add(column.id);
      for (const slab of doc.byKind('slab')) if (slab.storeyId === id) out.add(slab.id);
      break;
    default:
      // opening / column / slab 没有下游依赖者
      break;
  }
  return [...out];
}
```

`endPointId` / `otherEnd` 在本文件里用不上（`incidentWallEnds` 直接给 `end`），所以**不要**留未使用的 import —— `noUnusedLocals` 会红。它们出现在这里是为了说明 Task 4 怎么接：`incidentWallEnds` 给 `{wallId, end}`，Task 4 用 `endPointId(requireWall(doc, wallId), end)` 找回共享点。

`packages/core/src/index.ts` 在 `export * from './geom/axis';` 之后加：

```ts
export * from './geom/topology';
```

- [ ] **Step 4: `commands/wall.ts` 收下 `PointRef`，并给 `wallMoveEndpoint` 加邻墙守卫**

`WallCreateInput` 的两个端点字段换类型（`{x,y}` 字面量仍合法，计划 1 的测试与 `arbWallShape` 一行都不用改）：

```ts
export interface WallCreateInput {
  storeyId: EntityId;
  /** 共享端点：`{ pointId }` 复用既有点，两面墙于是拓扑闭合（Task 3） */
  start: PointRef;
  end: PointRef;
  thicknessMm: Mm;
  heightMm: Mm;
  elevationOffsetMm?: Mm;
  loadBearing?: boolean;
  material?: string;
}
```

新增两个模块内私有助手（不导出：它们只服务于 `wallCreate` 的"构造期能查就查、查不了就 build 里查"这条时序）：

```ts
/** 端点解析结果：id 为 null 表示这个点还要新建。 */
interface ResolvedEnd {
  readonly id: EntityId | null;
  readonly x: Mm;
  readonly y: Mm;
}

function resolveEnd(doc: Document, ref: PointRef, storeyId: EntityId): ResolvedEnd {
  const existing = resolvePointRef(doc, ref, storeyId);
  if (existing !== null) return { id: existing.id, x: existing.x, y: existing.y };
  if (isExistingPoint(ref)) {
    // resolvePointRef 对 pointId 形态要么返点要么抛，走不到这里；留着是让类型收窄成立
    throw new TypeError(`端点 ${ref.pointId} 无法解析`);
  }
  return { id: null, x: quantizeMm(ref.x), y: quantizeMm(ref.y) };
}

/** 轮廓能不能成立。文案与计划 1 逐字相同 —— commands.test.ts 的 /零长/、/不小于墙长/ 靠它。 */
function assertWallShape(thicknessMm: Mm, x0: Mm, y0: Mm, x1: Mm, y1: Mm): void {
  if (x0 === x1 && y0 === y1) {
    throw new RangeError(`零长墙：两端点量化后同为 (${x0}, ${y0})`);
  }
  const lengthMm = Math.hypot(x1 - x0, y1 - y0);
  if (thicknessMm >= lengthMm) {
    throw new RangeError(
      `墙厚 ${thicknessMm} 不小于墙长 ${Math.round(lengthMm)}，轮廓会自相交`,
    );
  }
}
```

`wallCreate`：删掉那句作废的注释"共享端点与接头吸附属计划 2，这里总是新建两个端点"，构造期检查改成只在**两端都是坐标字面量**时做（保住计划 1 的时序承诺），其余逻辑搬进 `build`：

```ts
export function wallCreate(input: WallCreateInput): Command {
  const thicknessMm = assertMm(input.thicknessMm, '墙厚');
  const heightMm = assertMm(input.heightMm, '墙高');
  const elevationOffsetMm = assertMm(input.elevationOffsetMm ?? 0, '标高偏移');
  const startRef = input.start;
  const endRef = input.end;
  // 两端都是字面量时构造期就能判；只要有一端复用，坐标在文档里，只能等 build 再判。
  if (!isExistingPoint(startRef) && !isExistingPoint(endRef)) {
    assertWallShape(
      thicknessMm,
      quantizeMm(startRef.x),
      quantizeMm(startRef.y),
      quantizeMm(endRef.x),
      quantizeMm(endRef.y),
    );
  }
  return {
    type: 'wall.create',
    build(doc: Document) {
      mustExist(doc, input.storeyId, '楼层');
      const a = resolveEnd(doc, input.start, input.storeyId);
      const b = resolveEnd(doc, input.end, input.storeyId);
      assertWallShape(thicknessMm, a.x, a.y, b.x, b.y);
      const upsert: Entity[] = [];
      const startId = a.id ?? uuidv7();
      if (a.id === null) {
        upsert.push({
          kind: 'point',
          id: startId,
          storeyId: input.storeyId,
          x: a.x,
          y: a.y,
        });
      }
      const endId = b.id ?? uuidv7();
      if (b.id === null) {
        upsert.push({
          kind: 'point',
          id: endId,
          storeyId: input.storeyId,
          x: b.x,
          y: b.y,
        });
      }
      const wall: WallEntity = {
        kind: 'wall',
        id: uuidv7(),
        storeyId: input.storeyId,
        startId,
        endId,
        thicknessMm,
        heightMm,
        elevationOffsetMm,
        loadBearing: input.loadBearing ?? true,
        material: input.material ?? 'brick',
      };
      upsert.push(wall);
      return { upsert, remove: [] };
    },
  };
}
```

复用两端为同一点时 `a.id === b.id` 且坐标相同，`assertWallShape` 先抛零长，永远走不到 `applyPatch` 的"`Patch.upsert` 内 id 重复"。`wallSetThickness` 本任务不动（它没有坐标入参）。

`wallMoveEndpoint` 加邻墙守卫 —— 这是计划 1 那条洞的收口处：

```ts
export function wallMoveEndpoint(input: {
  wallId: EntityId;
  end: WallEnd;
  x: number;
  y: number;
}): Command {
  const x = quantizeMm(input.x);
  const y = quantizeMm(input.y);
  return {
    type: 'wall.moveEndpoint',
    build(doc: Document) {
      const wall = requireWall(doc, input.wallId);
      const moving = requirePoint(doc, endPointId(wall, input.end), '端点');
      const anchor = requirePoint(doc, endPointId(wall, otherEnd(input.end)), '另一端点');
      if (anchor.x === x && anchor.y === y) {
        throw new RangeError(`零长墙：端点移到与另一端 (${x}, ${y}) 重合`);
      }
      // 被拖的这面墙自己也要查：计划 1 只让 wallCreate / wallSetThickness 管墙厚与轴长的关系，
      // 拖端点是第三条能改轴长的路。少了这一条，把 3600 长的 240 墙拖到 200 就成功了，
      // 而 Task 5 的轮廓会自相交 —— 真源里绝不能留这种东西。
      const selfLengthMm = Math.hypot(x - anchor.x, y - anchor.y);
      if (wall.thicknessMm >= selfLengthMm) {
        throw new RangeError(
          `移动端点会让墙 ${wall.id} 的墙厚 ${wall.thicknessMm} 不小于轴长 ${Math.round(selfLengthMm)}，轮廓会自相交`,
        );
      }
      // 共享端点：这一动会带走所有指着同一个点的墙。逐面按同样的规矩检查，
      // 绝不允许把邻墙拖成零长或非法轮廓 —— 真源里不留坏几何，抛错比画歪便宜得多。
      for (const inc of incidentWallEnds(doc, moving.id, wall.id)) {
        const neighbour = requireWall(doc, inc.wallId);
        const other = requirePoint(
          doc,
          endPointId(neighbour, otherEnd(inc.end)),
          '邻墙另一端点',
        );
        if (other.x === x && other.y === y) {
          throw new RangeError(
            `移动端点会让墙 ${neighbour.id} 变成零长：它与本墙共享端点 ${moving.id}`,
          );
        }
        const lengthMm = Math.hypot(x - other.x, y - other.y);
        if (neighbour.thicknessMm >= lengthMm) {
          throw new RangeError(
            `移动端点会让墙 ${neighbour.id} 的墙厚 ${neighbour.thicknessMm} 不小于轴长 ${Math.round(lengthMm)}，轮廓会自相交`,
          );
        }
      }
      return { upsert: [{ ...moving, x, y }], remove: [] };
    },
  };
}
```

文件头的 import 补上（Task 2 已引入 `mustExist/requirePoint/requireWall` 与 `wallAxis`）：

```ts
import { wallAxis, endPointId, otherEnd, type WallEnd } from '../geom/axis';
import { incidentWallEnds, isExistingPoint, resolvePointRef, type PointRef } from '../geom/topology';
```

`wallDelete` 一行都不用改：它的 `stillReferenced` 早就把"别的墙还指着这个点"算进去了，本任务只是第一次让它真的有机会生效。

- [ ] **Step 5: 全绿 + 老测试不破**

```bash
pnpm typecheck 2>&1 | tail -5
pnpm vitest run packages/core/test/topology.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -6
pnpm verify 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -5
```

Expected: `topology.test.ts` 26 passed（PointRef 5 + 共享端点查询 3 + dependentsOf 4 + wallCreate 复用 6 + wallMoveEndpoint 7 + wallDelete 1）；`commands.test.ts` 与 `properties.test.ts` 的老条目一条不少，总数 = Task 2 的 112 + 26 = 138 passed，0 失败。`properties.test.ts` 不变式 2 会随机生成"建墙 → 改端点 → 撤销"序列，本任务给它新增的守卫只是多抛错的口子，而它用的全是字面量坐标，因此不应触发 —— 若它变红，先看是不是 `resolveEnd` 把字面量误判成了复用。

- [ ] **Step 6: 变异检查（防"测试考的是空气"）**

五处逐个改、逐个还原，每次 `git diff` 必须回到空：

1. 把 `wallMoveEndpoint.build` 里的邻墙 `for` 循环整段注释掉 → Expected: 「邻墙被拖成零长」「邻墙被拖成墙厚 ≥ 轴长」两条红，其余全绿（这正是"守卫确实起了作用"的证据）。
2. 注释掉本墙的 `if (wall.thicknessMm >= selfLengthMm)` → Expected: 只有「把自己这面墙拖成墙厚 ≥ 轴长」红，且该用例里 300mm 的正对照仍绿。少了这条正对照，"把守卫改成恒抛"这种变异能蒙过第 1 处之外的检查。
3. 把 `wallCreate.build` 里 `const startId = a.id ?? uuidv7()` 改成无条件 `uuidv7()`（即忽略复用）→ Expected: 「L 形只新建 3 个点」「复用的点不进补丁」「affected 仍只有那一个点」全红。
4. 只保留构造期检查、把 `build` 里的 `assertWallShape(...)` 调用删掉 → Expected: 「复用端点导致墙厚 ≥ 轴长」红，而「正对照：构造期就抛」仍绿（说明两条检查各有各的活）。
5. `incidentWallEnds` 里删掉 `if (wall.startId === pointId)` 那一支 → Expected: 「incidentWallEnds：拐角两面墙」红。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/geom/topology.ts packages/core/src/commands/wall.ts packages/core/test/topology.test.ts packages/core/src/index.ts
git commit -m "feat: 共享端点进真源与移动端点的邻墙守卫"
```

执行日志写在这里：实际新增条数、五处变异各自红了哪些、以及 `resolvePointRef` 的跨楼层检查有没有在真实两层文档上验过（本任务只验单层 + 手工造的异层点，两层墙网留到 Task 10 的整合测试）。

**留给后续任务的钩子（本任务不做，但别改主意）：**
- `wallMoveEndpoint` 的 `affected` 只有那个点。Task 9 的索引局部重建必须把 affected 沿 `dependentsOf` 迭代到不动点，否则拖完拐角，旧墙几何还留在网格里。
- 洞口跟随拉伸属 Task 7：现在拖墙不会检查宿主洞口是否被挤出墙外，因为还没有命令能建洞口（`opening.create` 未实现），手搓的洞口 + 拉伸这条路径在测试里到不了。Task 7 实现 `openingCreate` 时必须同时补上这条守卫和它的测试。

#### Task 3 执行回填（2026-09-26，评审后裁决；本任务的权威文本是代码 `7f7e143`，不是上面那几段 fence）

上面 Task 3 的文本里有五处自相矛盾，实现者在没有提示的情况下全部发现，并一律往"更严"的方向改对（没有一条放松断言）。逐条记在这里，免得下一个人照 fence 抄回去：

1. **第 968 行 `Omit<WallCreateInput, 'storeyId'>` 编译不过** —— `heightMm` 是必填（`commands/wall.ts:21`），而所有 `addWall` 调用点只给 `{ start, end, thicknessMm }`；把 `heightMm` 补进调用点又撞 `TS2783`（它排在 `...spec` 之前）。落地是 `Omit<WallCreateInput, 'storeyId' | 'heightMm'>`（`topology.test.ts:66`），层高由 fixture 补齐，语义不变。
2. **第 1047 行那条 `toEqual([...])` 是掷硬币**，第 1077 行给的理由（"`byKind('wall')` 按 id 升序，所以顺序就是创建顺序"）**与 Global Constraints 里 uuidv7 那条直接矛盾**。实测 300 次 `lCorner`：两面墙 300/300 落在同一毫秒，`byKind` 把后建的排前面 **155/300** 次。落地写法（`topology.test.ts:145-151`）= `toHaveLength(2)` + wallId 集合 + 逐个 `find(...).end` 钉端点角色：顺序无关，而变异 5（删掉 `startId` 那一支）照样红。
3. **第 1203 行那句撤销断言永远不可能成立**：`afterFirst` 取在 undo **之前**（那时 L 形还在），却在 undo 之后断 `canonical()).toBe(afterFirst)` —— 按原文只有在"undo 什么都没做却返回 true"时才绿，它断的是自己名字的反面。落地（`topology.test.ts:301-313`）：先存 L 形快照，undo 后断"回到单墙"（1 墙 / 2 点 / `sharedPointIds` 空），redo 后断 `canonical()` 逐字节等于那份快照 —— 重做若新建点必带新 id，快照就变，所以钉得更死。
4. **第 1245 / 1302 / 1329 行的 `log.depth` 应为 3**：`lCorner()` 自己就压了三笔（建层 + 两面墙）。意图（抛掉的 dispatch 不入栈）没变，绝对数字按 fixture 纠正；另有走 `buildLog + addWall` 的那条仍是 2，本来就对。
5. **第 1501 行 `case 'storey'` 扫 wall/opening/column/slab 四类，而它自己的测试期望只列两类** —— 该断言必红。实现照文本（Task 8 改标高要的是该层全部下游，漏一类就是漏算），测试期望补上柱与板；用例名"该层墙与洞口"因此低估了断言范围，改名并入 Task 4 的实现轮。
6. 第 1062 行 `expect(sharedId).toBeTruthy()` 是全局约束明令禁止的空跑断言，换成 `expect(first.startId).not.toBe(sharedId)`（`topology.test.ts:165`）—— 它才真正排除"两端同点的退化墙也能过前两条"。**同一个坑在第 2226 行（Task 4 的确定性用例）又出现一次，Task 4 一并处理。**
7. 两条顺序契约钉死（评审与实现者各自独立提出）：**`incidentWallEnds` 返的是 id 升序，不是创建顺序**，Task 4 判"谁当直通"不能靠下标；`wallMoveEndpoint.affected` 只有那一个点，Task 9 的局部重建要自己沿 `dependentsOf` 迭代到不动点。

**执行日志**：新增 **26** 条（与 Step 5 的 5+3+4+6+7+1 逐段对上），`pnpm verify` = 112 + 26 = **138 passed**（14 files，0 失败）；`topology.test.ts` 单文件 **17ms**，vitest 全量 **473ms**。五处变异逐个红、逐个还原（`git diff` 归零），另加一条"把本墙守卫改成恒抛"的变体，用它证明 300mm 正对照确有牙齿。计划 1 的 `commands.test.ts` 14 条与 `properties.test.ts` 9 条一条不少。评审 Approved（0 Critical / 0 Important / 10 Minor，其中 7 条进终审清单）。

---

### Task 4: 接头分类与斜切量（geom/joint.ts）

计划 2 的算法核心。三条不变式，本任务的测试就是照着它们写的：

1. **只认拓扑**：接头的身份是"同一个 `pointId`"，不是"坐标很接近"。所以两面墙画得完全重叠但不共享点，派生结果仍是两个自由端，绝不给 `corner`。这条由第 2 个用例做正对照钉住。
2. **无缝闭合**：同一接头的两个成员，在同一侧（同为 +normal 或同为 -normal）算出的角点必须**是同一个点**。两墙轮廓因此共用一条边，既不留缝也不重叠 —— 这就是 spec 第 10 节"接头闭合"的几何定义。
3. **非法即抛**：夹角小到会让轮廓翻面、T 接的直通两墙厚度不同、超过十字的星形交点，一律抛错。派生层不兜底（spec 第 9 节），画歪的图纸比报错危险。

**斜切量为什么要带符号**（读代码前先看这段，否则 `trimLeftMm: -120` 像是 bug）：

直角 L 角，共享点 P = (1000, 0)，两墙都 240 厚。墙 A 沿 +x 到 P 结束（`dir=(1,0)`，`normal=(0,1)`，`away=(-1,0)`）；墙 B 从 P 沿 +y 出发（`dir=(0,1)`，`normal=(-1,0)`，`away=(0,1)`）。接缝是内角点 (880, 120) 到外角点 (1120, -120) 那条 45° 直线，它正好过 P。于是

- 墙 A 的 +normal 侧角点 = (880, 120) → 沿 `away` 内退 120 → `trimLeft = +120`
- 墙 A 的 -normal 侧角点 = (1120, -120) → 沿 `away` **后退** 120 → `trimRight = -120`

墙 B 同样得到 `(+120, -120)`。两墙的 +1 角点都是 (880,120)，-1 角点都是 (1120,-120) —— 共用同一条边，闭合且零重叠。**"斜切"必然是一侧内退、一侧外伸**，只给一个正的 trim 画不出 L 角，这也解释了 `JointMember` 为什么是 `trimLeftMm` / `trimRightMm` 两个值而不是一个。

一般地，corner 的两侧边线都关于 P 中心对称，所以 **`trimLeft = -trimRight` 恒成立**（用例 5 把它当不变式断言）；tee 的支墙两条边线交在同一条面线上，所以**两侧同号**（用例 8 断言 120/120）。这两条一正一反，恰好互相验证。

异厚 corner 用同一个"内侧面互交、外侧面互交"公式，得到的是**偏置斜切**：接缝仍是一条直线、两墙仍共用它，只是不过 P 的中线。这是用户口径里"平接"在两面端点相遇时唯一能闭合的形式，见开头那段说明。

> **为什么不是"同侧边线求交"**（写代码前先看这条，否则会照着直觉写出一个静默错的版本）。两墙各自把第 `s` 条边线配对的写法，只在"一墙的 `start` 遇另一墙的 `end`"时恰好正确。两条墙都从共享点起画（用户在同一个点上连画两笔，`start`/`start`）时，各自的 `+normal` 一内一外，同侧配对称出的交点落在两堵墙**之外**，两墙轮廓随之重叠 —— 而接缝闭合、`trimLeft = -trimRight`、Σ 面积恒等这三条**全都照样成立**（两侧用的是同一个交点，误差被构造抹平了），所以属性测试抓不到它。能抓到的只有本任务那两条「同向起画」的定值用例，和 Task 10 那条**按侧**比对闭式解的属性测试（"整条链反着画"抓不到：两墙同时换成各自的另一端，内/外指派跟着一起翻，配对结构原样保留）。规则本身：`innerSide(m, other) = sign(dot(other.away, m.normal))`，即"对面那堵墙的实体在我这一侧"，两墙的 `innerSide` 边线交于凹角点、各自反向边线交于凸角点。

**Files:**
- Create: `packages/core/src/geom/joint.ts`
- Create: `packages/core/test/joint.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: Task 1 的 `intersectLines` / `dot` / `sub` / `advance` / `isParallel` / `angleOf` / `Vec2`；Task 2 的 `wallAxis` / `wallAxisById` / `endPointId` / `endPoint` / `awayDir` / `WallAxis`；Task 3 的分组前提（共享 `pointId`）
- Produces: `JointKind`、`JointMember`、`Joint`（见契约表）、`deriveJoints(doc): Joint[]`、`memberTrim(joints, wallId, end): JointMember`

- [ ] **Step 1: 写失败的测试**

`packages/core/test/joint.test.ts`。fixture 全部用**共享点**建墙（Task 3 的能力），因此本任务的测试天然要写 `wallCreate({ start: { pointId } })`。

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  cornerPoint,
  cross,
  deriveJoints,
  dot,
  memberTrim,
  storeyCreate,
  uuidv7,
  wallAxisById,
  wallCreate,
  type Joint,
  type WallCreateInput,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();

/** 一层多墙，specs 里的 storeyId 与 heightMm 由本函数填。 */
function build(specs: Array<Omit<WallCreateInput, 'storeyId' | 'heightMm'>>) {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  const storeyId = log.document.byKind('storey')[0]!.id;
  for (const spec of specs) log.dispatch(wallCreate({ storeyId, heightMm: 3000, ...spec }));
  return log;
}

function jointsAt(log: TransactionLog, pointId: string): Joint {
  const hit = deriveJoints(log.document).find((j) => j.pointId === pointId);
  if (!hit) throw new Error(`测试找不到接头 ${pointId}`);
  return hit;
}

/**
 * 取最近一次 dispatch 新建的墙。禁止 `byKind('wall').at(-1)`：同毫秒的 uuidv7
 * 不保证单调（Global Constraints 与计划 1 的 ids.test.ts），那样取新墙是掷硬币。
 */
function lastWall(log: TransactionLog): WallEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建墙');
}

/** 建一面复用 startId 的新墙，返回墙本体。 */
function appendWall(
  log: TransactionLog,
  startId: string,
  end: { x: number; y: number },
  thicknessMm: number,
): WallEntity {
  const storeyId = log.document.byKind('storey')[0]!.id;
  log.dispatch(
    wallCreate({ storeyId, start: { pointId: startId }, end, thicknessMm, heightMm: 3000 }),
  );
  return lastWall(log);
}

/** 直角 L：A (0,0)→P(1000,0)，B P→(1000,800)，同厚 240。 */
function rightL(thicknessA = 240, thicknessB = 240) {
  const log = build([
    { start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: thicknessA },
  ]);
  const a = log.document.byKind('wall')[0]!;
  const b = appendWall(log, a.endId, { x: 1000, y: 800 }, thicknessB);
  return { log, sharedId: a.endId, a, b };
}

describe('分组只认拓扑', () => {
  it('一面孤墙给两个 free 接头，trim 全 0', () => {
    const log = build([{ start: { x: 0, y: 0 }, end: { x: 3600, y: 0 }, thicknessMm: 240 }]);
    const wall = log.document.byKind('wall')[0]!;
    const joints = deriveJoints(log.document);
    expect(joints).toHaveLength(2);
    expect(joints.map((j) => j.kind)).toEqual(['free', 'free']);
    for (const j of joints) {
      expect(j.members).toHaveLength(1);
      expect(j.members[0]!.trimLeftMm).toBe(0);
      expect(j.members[0]!.trimRightMm).toBe(0);
    }
    expect(joints.map((j) => j.pointId).sort()).toEqual([wall.startId, wall.endId].sort());
  });

  it('正对照：坐标撞在一起但不共享点，仍是两个 free，不是 corner', () => {
    // 少了这条，用例 3 之后的所有断言都可能只是"坐标吸附"在起作用
    const log = build([
      { start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: 240 },
      { start: { x: 1000, y: 0 }, end: { x: 1000, y: 800 }, thicknessMm: 240 },
    ]);
    const kinds = deriveJoints(log.document).map((j) => j.kind);
    expect(kinds).toEqual(['free', 'free', 'free', 'free']);
    expect(log.document.byKind('point')).toHaveLength(4);
  });

  it('共线直通给 collinear，四侧 trim 全 0（两墙拼成一条连续带）', () => {
    const log = build([{ start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: 240 }]);
    const storeyId = log.document.byKind('storey')[0]!.id;
    const w1 = log.document.byKind('wall')[0]!;
    log.dispatch(
      wallCreate({
        storeyId,
        start: { pointId: w1.endId },
        end: { x: 2000, y: 0 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    );
    const joint = jointsAt(log, w1.endId);
    expect(joint.kind).toBe('collinear');
    expect(joint.members).toHaveLength(2);
    for (const m of joint.members) {
      expect(m.trimLeftMm).toBe(0);
      expect(m.trimRightMm).toBe(0);
    }
  });
});

describe('corner：等厚直角', () => {
  it('分类 corner，两成员各得 (+120, -120)', () => {
    const { log, sharedId, a, b } = rightL();
    const joint = jointsAt(log, sharedId);
    expect(joint.kind).toBe('corner');
    // 契约是"墙 id 升序 + 同墙 start 先于 end"，不是"建墙顺序"（同毫秒 uuidv7 不保证单调）。
    // 用排序比较，让这条断言只考成员集合，不受 id 运气影响。
    expect(joint.members.map((m) => `${m.wallId}:${m.end}`).sort()).toEqual(
      [`${a.id}:end`, `${b.id}:start`].sort(),
    );
    for (const m of joint.members) {
      expect(m.trimLeftMm).toBe(120);
      expect(m.trimRightMm).toBe(-120);
    }
  });

  it('两端角点精确重合：两墙轮廓共用同一条接缝（不变式 2）', () => {
    const { log, sharedId, a, b } = rightL();
    const axisA = wallAxisById(log.document, a.id);
    const axisB = wallAxisById(log.document, b.id);
    const trimA = memberTrim(deriveJoints(log.document), a.id, 'end');
    const trimB = memberTrim(deriveJoints(log.document), b.id, 'start');
    expect(cornerPoint(axisA, 'end', 1, trimA.trimLeftMm)).toEqual({ x: 880, y: 120 });
    expect(cornerPoint(axisB, 'start', 1, trimB.trimLeftMm)).toEqual({ x: 880, y: 120 });
    expect(cornerPoint(axisA, 'end', -1, trimA.trimRightMm)).toEqual({ x: 1120, y: -120 });
    expect(cornerPoint(axisB, 'start', -1, trimB.trimRightMm)).toEqual({ x: 1120, y: -120 });
  });

  it('不变式：corner 的 trimLeft 恒为 -trimRight（边线关于共享点中心对称）', () => {
    const { log, sharedId } = rightL(370, 200);
    const joint = jointsAt(log, sharedId);
    expect(joint.kind).toBe('corner');
    for (const m of joint.members) expect(m.trimLeftMm).toBeCloseTo(-m.trimRightMm, 9);
  });
});

describe('corner：同向起画（start-start 与 end-end）', () => {
  /**
   * 同一个物理直角，两种画法。P=(0,0)，两墙实体都在第一象限，同厚 240：
   * - `startStart`：两墙都**从** P 起画（用户在共享点上连画两笔），成员是 start/start；
   * - `endEnd`：两墙都**收在** P（先把两笔反向画出来），成员是 end/end。
   * 并集轮廓必须一模一样（凹角 (120,120)、凸角 (-120,-120)），只有 side 编号跟着画法翻。
   */
  function startStart() {
    const log = build([
      { start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: 240 },
    ]);
    const a = log.document.byKind('wall')[0]!;
    const b = appendWall(log, a.startId, { x: 0, y: 800 }, 240);
    return { log, sharedId: a.startId, a, b };
  }

  function endEnd() {
    const log = build([
      { start: { x: 1000, y: 0 }, end: { x: 0, y: 0 }, thicknessMm: 240 },
    ]);
    const a = log.document.byKind('wall')[0]!;
    const storeyId = log.document.byKind('storey')[0]!.id;
    log.dispatch(
      wallCreate({
        storeyId,
        start: { x: 0, y: 800 },
        end: { pointId: a.endId },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    );
    return { log, sharedId: a.endId, a, b: lastWall(log) };
  }

  it('start-start：接缝是另一条对角 —— 凹角 (120,120)、凸角 (-120,-120)', () => {
    const { log, sharedId, a, b } = startStart();
    expect(jointsAt(log, sharedId).kind).toBe('corner');
    const joints = deriveJoints(log.document);
    const axisA = wallAxisById(log.document, a.id);
    const axisB = wallAxisById(log.document, b.id);
    const trimA = memberTrim(joints, a.id, 'start');
    const trimB = memberTrim(joints, b.id, 'start');
    // A 的内侧面是 +normal（y=+120），B 的内侧面是 -normal（x=+120）：异侧配对。
    // 若照"各自的第 s 条边线相交"去算，会得到 (-120,120) —— 那个点在两堵墙之外，
    // 两墙轮廓随即重叠，而 trimLeft=-trimRight、接缝闭合、Σ 面积恒等全都照样成立，
    // 所以这条用例是本任务唯一盯着这个坑的东西。
    expect(trimA.trimLeftMm).toBe(120);
    expect(trimA.trimRightMm).toBe(-120);
    expect(trimB.trimLeftMm).toBe(-120);
    expect(trimB.trimRightMm).toBe(120);
    expect(cornerPoint(axisA, 'start', 1, trimA.trimLeftMm)).toEqual({ x: 120, y: 120 });
    expect(cornerPoint(axisB, 'start', -1, trimB.trimRightMm)).toEqual({ x: 120, y: 120 });
    expect(cornerPoint(axisA, 'start', -1, trimA.trimRightMm)).toEqual({ x: -120, y: -120 });
    expect(cornerPoint(axisB, 'start', 1, trimB.trimLeftMm)).toEqual({ x: -120, y: -120 });
  });

  it('end-end：同一个物理直角反过来画，轮廓一模一样，只有 side 编号翻转', () => {
    const { log, sharedId, a, b } = endEnd();
    expect(jointsAt(log, sharedId).kind).toBe('corner');
    const joints = deriveJoints(log.document);
    const axisA = wallAxisById(log.document, a.id);
    const axisB = wallAxisById(log.document, b.id);
    const trimA = memberTrim(joints, a.id, 'end');
    const trimB = memberTrim(joints, b.id, 'end');
    expect(trimA.trimLeftMm).toBe(-120);
    expect(trimA.trimRightMm).toBe(120);
    expect(trimB.trimLeftMm).toBe(120);
    expect(trimB.trimRightMm).toBe(-120);
    // 四角点集合与 start-start 那条完全相同：画法不改变图纸
    const vs = [
      cornerPoint(axisA, 'end', 1, trimA.trimLeftMm),
      cornerPoint(axisA, 'end', -1, trimA.trimRightMm),
      cornerPoint(axisB, 'end', 1, trimB.trimLeftMm),
      cornerPoint(axisB, 'end', -1, trimB.trimRightMm),
    ];
    expect(vs.filter((v) => v.x === 120 && v.y === 120)).toHaveLength(2);
    expect(vs.filter((v) => v.x === -120 && v.y === -120)).toHaveLength(2);
  });
});

describe('corner：斜角与异厚', () => {
  it('60° 异厚：顶点仍重合，且薄墙切得比厚墙多', () => {
    // A 沿 -x 到 P(0,0)，厚 370；B 从 P 走 60° 的整数端点
    const log = build([{ start: { x: -2000, y: 0 }, end: { x: 0, y: 0 }, thicknessMm: 370 }]);
    const a = log.document.byKind('wall')[0]!;
    // away 方向 (-1000, 1732)：与 (-1,0) 夹 60°
    const b = appendWall(log, a.endId, { x: -1000, y: 1732 }, 200);
    const joints = deriveJoints(log.document);
    const joint = jointsAt(log, a.endId);
    expect(joint.kind).toBe('corner');
    const axisA = wallAxisById(log.document, a.id);
    const axisB = wallAxisById(log.document, b.id);
    const trimA = memberTrim(joints, a.id, 'end');
    const trimB = memberTrim(joints, b.id, 'start');
    for (const side of [1, -1] as const) {
      const left = side === 1 ? 'trimLeftMm' : 'trimRightMm';
      const va = cornerPoint(axisA, 'end', side, trimA[left]);
      const vb = cornerPoint(axisB, 'start', side, trimB[left]);
      expect(va.x).toBeCloseTo(vb.x, 9);
      expect(va.y).toBeCloseTo(vb.y, 9);
    }
    // 独立验算（不是把实现抄一遍）：θ = 两墙实体的内夹角，h = 半厚，
    // 内侧面那一侧的 trim = (h_对 + h_己·cosθ) / sinθ。
    // 本 fixture 里两墙的内侧面恰好都是 +normal（θ<90° 且 B 在 A 的逆时针侧），
    // 所以直接比 trimLeftMm：A(厚 370) ≈ 222.28、B(薄 200) ≈ 271.36 —— **薄墙切得多**。
    // 反直觉之处：厚墙的侧面离自己的轴线远，薄墙的轴线得外伸更多才够得着它。
    // "厚墙占地方多所以切得多"是错的直觉，所以这条既钉数值也钉大小关系。
    const iA = { x: -axisA.dir.x, y: -axisA.dir.y }; // A 的实体离开 P 的方向
    const iB = axisB.dir; // B 从 P 起画，实体就在自己的 dir 上
    const cosT = dot(iA, iB);
    const sinT = Math.abs(cross(iA, iB));
    const hA = axisA.thicknessMm / 2;
    const hB = axisB.thicknessMm / 2;
    expect(trimA.trimLeftMm).toBeCloseTo((hB + hA * cosT) / sinT, 6);
    expect(trimB.trimLeftMm).toBeCloseTo((hA + hB * cosT) / sinT, 6);
    expect(trimB.trimLeftMm).toBeGreaterThan(trimA.trimLeftMm);
    expect(trimA.trimLeftMm).toBeCloseTo(-trimA.trimRightMm, 9);
    expect(trimB.trimLeftMm).toBeCloseTo(-trimB.trimRightMm, 9);
  });

  it('夹角小到轮廓翻面 → 抛，不画出自相交四边形', () => {
    const log = build([{ start: { x: -2000, y: 0 }, end: { x: 0, y: 0 }, thicknessMm: 500 }]);
    const storeyId = log.document.byKind('storey')[0]!.id;
    const a = log.document.byKind('wall')[0]!;
    log.dispatch(
      wallCreate({
        storeyId,
        start: { pointId: a.endId },
        // 与 -x 只夹约 1°：cot(0.5°) ≈ 114，斜切量远超 2000 的轴长
        end: { x: -2000, y: 35 },
        thicknessMm: 500,
        heightMm: 3000,
      }),
    );
    expect(() => deriveJoints(log.document)).toThrow(/翻面/);
  });
});

describe('tee', () => {
  /** 直通：W1 (0,0)→P(1000,0)、W2 P→(2000,0)，同厚 240；支墙 W3 P→(1000,800)，厚 120 */
  function teeFixture(stemThickness = 120) {
    const log = build([{ start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: 240 }]);
    const w1 = log.document.byKind('wall')[0]!;
    appendWall(log, w1.endId, { x: 2000, y: 0 }, 240);
    const w3 = appendWall(log, w1.endId, { x: 1000, y: 800 }, stemThickness);
    return { log, sharedId: w1.endId, w1, w3 };
  }

  it('分类 tee：支墙两侧 trim = 直通墙半厚 120，直通两墙 0', () => {
    const { log, sharedId, w3 } = teeFixture();
    const joint = jointsAt(log, sharedId);
    expect(joint.kind).toBe('tee');
    expect(joint.members).toHaveLength(3);
    const stem = joint.members.find((m) => m.wallId === w3.id)!;
    expect(stem.end).toBe('start');
    expect(stem.trimLeftMm).toBe(120);
    expect(stem.trimRightMm).toBe(120);
    for (const m of joint.members.filter((x) => x.wallId !== w3.id)) {
      expect(m.trimLeftMm).toBe(0);
      expect(m.trimRightMm).toBe(0);
    }
  });

  it('支墙两个角点都落在直通墙的北面上（y 都等于 120，与支墙厚度无关）', () => {
    const { log, sharedId, w1, w3 } = teeFixture(400);
    const joints = deriveJoints(log.document);
    const axis = wallAxisById(log.document, w3.id);
    const trim = memberTrim(joints, w3.id, 'start');
    const left = cornerPoint(axis, 'start', 1, trim.trimLeftMm);
    const right = cornerPoint(axis, 'start', -1, trim.trimRightMm);
    expect(left.y).toBeCloseTo(120, 9);
    expect(right.y).toBeCloseTo(120, 9);
    expect(left.x).toBeCloseTo(1000 - 200, 9);
    expect(right.x).toBeCloseTo(1000 + 200, 9);
    // 直通墙自己的角点仍在轴线上，与支墙的角点共同构成一条直线接缝
    const axis1 = wallAxisById(log.document, w1.id);
    expect(cornerPoint(axis1, 'end', 1, 0).y).toBeCloseTo(120, 9);
  });

  it('支墙朝南时切到南面：faceSide 的判据真的在起作用，不是恒取 +1', () => {
    const log = build([{ start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: 240 }]);
    const hub = log.document.byKind('wall')[0]!.endId;
    appendWall(log, hub, { x: 2000, y: 0 }, 240);
    const stem = appendWall(log, hub, { x: 1000, y: -800 }, 120);
    expect(jointsAt(log, hub).kind).toBe('tee');
    const joints = deriveJoints(log.document);
    const trim = memberTrim(joints, stem.id, 'start');
    expect(trim.trimLeftMm).toBe(120);
    expect(trim.trimRightMm).toBe(120);
    const axis = wallAxisById(log.document, stem.id);
    // 支墙朝南，两个角点的 y 都等于直通墙的南面 -120
    expect(cornerPoint(axis, 'start', 1, trim.trimLeftMm).y).toBeCloseTo(-120, 9);
    expect(cornerPoint(axis, 'start', -1, trim.trimRightMm).y).toBeCloseTo(-120, 9);
  });

  it('直通两墙厚度不同 → 抛（S1 的 T 接不允许带台阶的直通）', () => {
    const log = build([{ start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: 240 }]);
    const storeyId = log.document.byKind('storey')[0]!.id;
    const w1 = log.document.byKind('wall')[0]!;
    log.dispatch(
      wallCreate({
        storeyId,
        start: { pointId: w1.endId },
        end: { x: 2000, y: 0 },
        thicknessMm: 370,
        heightMm: 3000,
      }),
    );
    log.dispatch(
      wallCreate({
        storeyId,
        start: { pointId: w1.endId },
        end: { x: 1000, y: 800 },
        thicknessMm: 120,
        heightMm: 3000,
      }),
    );
    expect(() => deriveJoints(log.document)).toThrow(/厚度不同/);
  });
});

describe('cross 与 star', () => {
  /** 十字：四条臂都结束于 P(1000,1000)，全厚 240 */
  function plus() {
    const log = build([
      { start: { x: 0, y: 1000 }, end: { x: 1000, y: 1000 }, thicknessMm: 240 },
    ]);
    const storeyId = log.document.byKind('storey')[0]!.id;
    const eastIn = log.document.byKind('wall')[0]!;
    const specs: Array<{ start: { pointId: string }; end: { x: number; y: number } }> = [
      { start: { pointId: eastIn.endId }, end: { x: 2000, y: 1000 } },
      { start: { pointId: eastIn.endId }, end: { x: 1000, y: 0 } },
      { start: { pointId: eastIn.endId }, end: { x: 1000, y: 2000 } },
    ];
    for (const s of specs) {
      log.dispatch(wallCreate({ storeyId, thicknessMm: 240, heightMm: 3000, ...s }));
    }
    return { log, sharedId: eastIn.endId };
  }

  it('十字：方向角更小的那族当直通（trim 0），另一族各自切到自己那一面', () => {
    const { log, sharedId } = plus();
    const joint = jointsAt(log, sharedId);
    expect(joint.kind).toBe('cross');
    expect(joint.members).toHaveLength(4);
    const horizontal = joint.members.filter(
      (m) => wallAxisById(log.document, m.wallId).dir.y === 0,
    );
    const vertical = joint.members.filter((m) => wallAxisById(log.document, m.wallId).dir.x === 0);
    // 两条过滤必须覆盖全部成员：冒出斜墙说明 fixture 或分组坏了
    expect(horizontal.length + vertical.length).toBe(4);
    expect(horizontal).toHaveLength(2);
    for (const m of horizontal) expect([m.trimLeftMm, m.trimRightMm]).toEqual([0, 0]);
    for (const m of vertical) expect([m.trimLeftMm, m.trimRightMm]).toEqual([120, 120]);
    // 两支墙在直通墙的两侧，必须各自顶到**自己那一面**：北臂落在 y=1120，南臂落在 y=880。
    // 只按 stemLine[0] 算一次 face 的实现会让另一臂被切到对面去（trim 变 -120），
    // 而"红哪一臂"取决于 uuidv7 的运气 —— 那种运气依赖就是"实现读了成员顺序"的警报。
    for (const m of vertical) {
      const axis = wallAxisById(log.document, m.wallId);
      const yLeft = cornerPoint(axis, m.end, 1, m.trimLeftMm).y;
      const yRight = cornerPoint(axis, m.end, -1, m.trimRightMm).y;
      expect(yLeft).toBe(yRight); // 平接：两角点同在直通墙的一个面上
      expect(Math.abs(yLeft - 1000)).toBe(120); // 北面 1120 或南面 880，二选一
    }
  });

  it('Y 形三臂（三个方向）→ 抛 star，并提示打断成 T 接', () => {
    const log = build([{ start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: 240 }]);
    const storeyId = log.document.byKind('storey')[0]!.id;
    const hub = log.document.byKind('wall')[0]!.endId;
    for (const end of [
      { x: 2000, y: 0 },
      { x: 1000, y: 900 },
    ] satisfies Array<{ x: number; y: number }>) {
      log.dispatch(
        wallCreate({ storeyId, start: { pointId: hub }, end, thicknessMm: 240, heightMm: 3000 }),
      );
    }
    expect(() => deriveJoints(log.document)).toThrow(/star/);
    expect(() => deriveJoints(log.document)).toThrow(/打断/);
  });
});

describe('deriveJoints 的确定性', () => {
  it('同一文档派生两次逐字节相同，且 joints 按 pointId 升序', () => {
    const { log, sharedId } = rightL();
    const first = deriveJoints(log.document);
    expect(deriveJoints(log.document)).toEqual(first);
    expect(JSON.stringify(first)).toBe(JSON.stringify(deriveJoints(log.document)));
    expect(first.map((j) => j.pointId)).toEqual([...first.map((j) => j.pointId)].sort());
    expect(sharedId).toBeTruthy();
  });

  it('memberTrim 找不到该墙的端点时抛，不给默认 0', () => {
    const { log } = rightL();
    const joints = deriveJoints(log.document);
    expect(() => memberTrim(joints, uuidv7(), 'start')).toThrow(/找不到/);
  });
});
```

- [ ] **Step 2: 跑测试确认它们红**

```bash
pnpm vitest run packages/core/test/joint.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -15
```

Expected: FAIL，`does not provide an export named 'deriveJoints'`（`memberTrim` 同样）。

- [ ] **Step 3: 实现 `geom/joint.ts`**

```ts
import type { EntityId } from '../ids';
import type { Document } from '../model/document';
import type { WallEntity } from '../model/entity';
import { awayDir, endPoint, endPointId, wallAxis, wallAxisById, type WallAxis, type WallEnd } from './axis';
import { advance, dot, intersectLines, isParallel, sub, type Vec2 } from './vec';

export type JointKind = 'free' | 'corner' | 'tee' | 'cross' | 'collinear' | 'star';

/**
 * 某个墙端在该接头处的斜切量，两侧各一个，**可正可负**：
 * 正 = 沿 awayDir 内退，负 = 越过共享点外伸。L 角必然一侧正一侧负（见计划说明），
 * 所以不能只给一个标量。left = +normal 侧，right = -normal 侧。
 */
export interface JointMember {
  readonly wallId: EntityId;
  readonly end: WallEnd;
  readonly trimLeftMm: number;
  readonly trimRightMm: number;
}

export interface Joint {
  readonly pointId: EntityId;
  readonly kind: JointKind;
  readonly members: readonly JointMember[];
}

interface Member {
  readonly wallId: EntityId;
  readonly end: WallEnd;
  readonly axis: WallAxis;
  /** 指向墙内部的单位向量 */
  readonly away: Vec2;
  readonly normal: Vec2;
  readonly dir: Vec2;
  readonly half: number;
  /** 共享点在浮点侧的位置 */
  readonly vertex: Vec2;
}

function toMember(wall: WallEntity, end: WallEnd, axis: WallAxis): Member {
  return {
    wallId: wall.id,
    end,
    axis,
    away: awayDir(axis, end),
    normal: axis.normal,
    dir: axis.dir,
    half: axis.thicknessMm / 2,
    vertex: endPoint(axis, end),
  };
}

/** 按无向轴线分组：所有成员的轴线都过共享点，故方向平行即同一条直线。 */
function lineGroups(members: readonly Member[]): Member[][] {
  const lines: Array<{ dir: Vec2; items: Member[] }> = [];
  for (const m of members) {
    const hit = lines.find((l) => isParallel(l.dir, m.dir));
    if (hit) hit.items.push(m);
    else lines.push({ dir: m.dir, items: [m] });
  }
  return lines.map((l) => l.items);
}

/**
 * 同一线族里出现**同向**的两个墙端 = 两条完全重叠的墙带（用户在同一个点上朝同一方向画了两笔）。
 * `lineGroups` 按无向方向折桶，所以这种输入会落到 `collinear`（members.length === 2 时 trim 全 0），
 * 甚至藏进 tee/cross 的"直通两墙"里 —— 分类照样给出合法的缝，图纸上却是双份材料，
 * 而 Task 10 的 Σ 面积恒等是**逐墙**的，双份材料两边同时成立、抓不到它（执行回填第 1 条）。
 * 所以这一层拦：非法即抛，且在分类**之前**抛，collinear / tee / cross / star 一律覆盖。
 * 三个以上成员同线不必特判：两条射线放三个端点，鸽笼原理保证必有一对同向，逐对检查自然命中。
 */
function assertNoSameRay(pointId: EntityId, members: readonly Member[]): void {
  for (const line of lineGroups(members)) {
    for (let i = 0; i < line.length; i += 1) {
      for (let j = i + 1; j < line.length; j += 1) {
        const a = line[i]!;
        const b = line[j]!;
        if (dot(a.away, b.away) > 0) {
          const coSame = line.filter((m) => dot(m.away, a.away) > 0).length;
          throw new RangeError(
            `接头 ${pointId} 有 ${coSame} 个墙端在同一点同向重叠（墙 ${a.wallId} 的 ${a.end} 端与墙 ${b.wallId} 的 ${b.end} 端朝同一方向离开该点），` +
              `S1 不支持：请把其中一面墙挪开或删掉`,
          );
        }
      }
    }
  }
}

function kindOf(members: readonly Member[]): JointKind {
  if (members.length === 1) return 'free';
  const lines = lineGroups(members);
  if (lines.length === 1) return 'collinear';
  if (members.length === 2) return 'corner';
  if (members.length === 3 && lines.length === 2) return 'tee';
  if (members.length === 4 && lines.length === 2 && lines.every((l) => l.length === 2)) {
    return 'cross';
  }
  return 'star';
}

/** 某成员某一侧的边线（无限直线）与该边线上一点。 */
function sideVertex(a: Member, sideA: 1 | -1, b: Member, sideB: 1 | -1): Vec2 {
  const hit = intersectLines(
    advance(a.vertex, a.normal, sideA * a.half),
    a.dir,
    advance(b.vertex, b.normal, sideB * b.half),
    b.dir,
  );
  if (hit === null) {
    throw new RangeError(`接头处两侧边线近平行，求不出接缝点：墙 ${a.wallId} 与墙 ${b.wallId}`);
  }
  return hit;
}

/** 把接缝点换算成该成员该侧的斜切量（沿 awayDir 的有符号距离）。 */
function trimOf(m: Member, hit: Vec2): number {
  return dot(sub(hit, m.vertex), m.away);
}

/** 直通墙的哪一侧面朝支墙。 */
function faceSide(through: Member, stem: Member): 1 | -1 {
  const facing = dot(through.normal, stem.away);
  if (facing === 0) {
    throw new RangeError(`支墙 ${stem.wallId} 与直通墙 ${through.wallId} 的几何无面线可辨`);
  }
  return facing > 0 ? 1 : -1;
}

/**
 * corner：该成员的哪一侧是**内侧面**（朝对面那堵墙实体的一面）。
 * 两墙的内侧面交于轮廓的凹角点，两条外侧面交于凸角点 —— 这两个点才是共用的接缝端点。
 *
 * 不能按"各自的第 s 条边线相交"配对：那只在一墙 start、一墙 end 时恰好成立。
 * 用户在同一个点上连画两笔（start/start）时，两墙的 +normal 一内一外，
 * 同侧配对称出的交点落在两堵墙之外，两墙轮廓随即重叠 —— 而接缝闭合、
 * trimLeft = -trimRight、Σ 面积恒等三条**全都照样成立**（两侧取的是同一个交点，
 * 误差被构造本身抹平），所以这三条属性抓不到它。能抓到的只有两处：这里那两条
 * 「同向起画」的定值用例，和 Task 10 那条**按侧**比对闭式解的属性测试 ——
 * 它的预言里没有任何"第几条边线"的约定，只有两墙的内向向量与半厚。
 */
function innerSide(m: Member, other: Member): 1 | -1 {
  const facing = dot(other.away, m.normal);
  if (facing === 0) {
    throw new RangeError(`接头处墙 ${m.wallId} 与墙 ${other.wallId} 的边线无内外侧面可辨`);
  }
  return facing > 0 ? 1 : -1;
}

function requireEqualThrough(pointId: EntityId, through: readonly Member[]): void {
  const [a, b] = [through[0]!, through[1]!];
  if (a.axis.thicknessMm !== b.axis.thicknessMm) {
    throw new RangeError(
      `接头 ${pointId} 的直通两墙厚度不同（${a.axis.thicknessMm} / ${b.axis.thicknessMm}），` +
        `S1 的 T 接与十字要求直通两墙同厚：请统一墙厚，或把它改画成 L 角`,
    );
  }
}

/** 无向方向角落在 [0, π)：用于十字的确定性 tie-break。 */
function lineAngle(dir: Vec2): number {
  const a = Math.atan2(dir.y, dir.x);
  return ((a % Math.PI) + Math.PI) % Math.PI;
}

interface Trim {
  left: number;
  right: number;
}

function trimsFor(pointId: EntityId, kind: JointKind, members: readonly Member[]): Trim[] {
  // 一格一成员：put 直接查表，不每次写回都 members.indexOf(m) 线性找下标
  const slots = new Map<Member, Trim>();
  const base: Trim[] = members.map((m) => {
    const t: Trim = { left: 0, right: 0 };
    slots.set(m, t);
    return t;
  });
  const put = (m: Member, side: 1 | -1, hit: Vec2): void => {
    const t = slots.get(m)!;
    const v = trimOf(m, hit);
    if (side === 1) t.left = v;
    else t.right = v;
  };
  /**
   * 平接斜切：把支墙两侧都切到直通墙朝它的那一面上，故两侧**同号**（不是 corner 的一正一负）。
   * tee 与 cross 共用这一块。**本任务早期的文本把这两处逐字写了两遍**，而重复正是
   * 那次假变异的产地：把 `const face` 提到 cross 的循环外、被循环内的块级声明遮蔽，
   * 实现等价、18 条全绿（见 Step 5 变异 4 与执行回填第 2 条）。抽成单一实现后
   * face 只有一个产地，"提到循环外"这种遮蔽写法在结构上不再存在。
   * face 逐支墙算：两支墙分居直通墙两侧时共用一个 face 会把其中一支切到**背面**去
   * （trim 变负，轮廓穿过横带、与直通墙重叠）。
   */
  const putFlatJoin = (stem: Member, through: Member): void => {
    const face = faceSide(through, stem);
    for (const side of [1, -1] as const) {
      put(stem, side, sideVertex(stem, side, through, face));
    }
  };

  switch (kind) {
    case 'free':
    case 'collinear':
      return base;
    case 'corner': {
      const [a, b] = [members[0]!, members[1]!];
      // 内侧配内侧（凹角点）、外侧配外侧（凸角点）：见 innerSide 的注释
      const sa = innerSide(a, b);
      const sb = innerSide(b, a);
      const inner = sideVertex(a, sa, b, sb);
      const outer = sideVertex(a, -sa, b, -sb);
      put(a, sa, inner);
      put(b, sb, inner);
      put(a, -sa, outer);
      put(b, -sb, outer);
      return base;
    }
    case 'tee': {
      const lines = lineGroups(members);
      const through = lines.find((l) => l.length === 2)!;
      const stem = lines.find((l) => l.length === 1)![0]!;
      requireEqualThrough(pointId, through);
      // 直通两墙同轴同厚，它们的 face 侧面是同一条物理直线，故取 through[0] 与顺序无关
      putFlatJoin(stem, through[0]!);
      return base;
    }
    case 'cross': {
      const lines = lineGroups(members);
      const [l1, l2] = [lines[0]!, lines[1]!];
      const through = lineAngle(l1[0]!.dir) <= lineAngle(l2[0]!.dir) ? l1 : l2;
      const stemLine = through === l1 ? l2 : l1;
      // 只要求**真直通那一族**同厚。两支臂被直通带隔开、彼此从不同时接触，
      // 支族异厚画出的是"带台阶的平接"（北臂切到 y=1120、南臂切到 y=880，无缝无重叠），
      // 是合法图纸 —— 本行原来还有一句 requireEqualThrough(pointId, stemLine)，
      // 那是过拒，评审后删掉，见 Task 4 执行回填第 3 条。
      requireEqualThrough(pointId, through);
      for (const stem of stemLine) putFlatJoin(stem, through[0]!);
      return base;
    }
    case 'star':
      throw new RangeError(
        `接头 ${pointId} 有 ${members.length} 个墙端、${lineGroups(members).length} 个方向在同一点相交（star），` +
          `S1 不支持：请把其中一面墙打断成两段，让交点变成 T 接`,
      );
  }
}

/**
 * 轮廓翻面守卫：同一侧的两端角点不能越过彼此，否则四边形自相交，
 * 图纸上就是一个蝴蝶结。夹角极小时斜切量会爆（cot(θ/2) → ∞），这里兜住。
 *
 * 轴长吃 `deriveJoints` 已经算好的那张 axis 表，不回查文档（原文是 `wallAxisById`，
 * 见执行回填第 6 条：那顺手做的楼层存在性检查本来就归 `model/read` 与命令层管）。
 */
function assertNoFlip(axes: ReadonlyMap<EntityId, WallAxis>, joints: readonly Joint[]): void {
  const ends = new Map<EntityId, Partial<Record<WallEnd, JointMember>>>();
  for (const joint of joints) {
    for (const m of joint.members) {
      const slot = ends.get(m.wallId) ?? {};
      slot[m.end] = m;
      ends.set(m.wallId, slot);
    }
  }
  for (const [wallId, slot] of ends) {
    const start = slot.start;
    const end = slot.end;
    if (!start || !end) throw new RangeError(`墙 ${wallId} 的接头成员不齐（内部错误）`);
    // 不可达：axes 与 ends 的键都来自同一个 doc.byKind('wall') 循环，按构造必然命中
    const axis = axes.get(wallId)!;
    for (const side of ['trimLeftMm', 'trimRightMm'] as const) {
      const sum = start[side] + end[side];
      // 用 >= 而不是 >：合计恰好等于轴长时该侧两端角点重合在同一点，四边形退化成一条线 ——
      // 与越过彼此同样画不出轮廓，所以"等于"这一合法边界是**故意**非法的，别改成 >
      if (sum >= axis.lengthMm) {
        throw new RangeError(
          `墙 ${wallId} 在 ${side === 'trimLeftMm' ? '+normal' : '-normal'} 侧的两端斜切量合计 ${Math.round(sum)} ` +
            `不小于轴长 ${Math.round(axis.lengthMm)}，轮廓会翻面`,
        );
      }
    }
  }
}

/**
 * 每个被墙端引用的点一个接头，自由端也算（kind 'free'），这样 Task 5 只需一次查表
 * 就能拿到一面墙四角的斜切量，不必区分"有没有接头"。顺序：pointId 升序，组内按墙 id 升序
 * （来自 doc.byKind('wall')，不是"建墙顺序" —— 同毫秒的 uuidv7 不保证单调）。
 */
export function deriveJoints(doc: Document): Joint[] {
  const groups = new Map<EntityId, Member[]>();
  // 顺手攒一张 axis 表给 assertNoFlip：它原来用 wallAxisById 回查文档，那是把同一面墙
  // 再派生一遍，还要顺带做楼层存在性检查 —— 一个几何守卫没资格判"这份文档的引用完不完整"
  const axes = new Map<EntityId, WallAxis>();
  for (const wall of doc.byKind('wall')) {
    const axis = wallAxis(doc, wall);
    axes.set(wall.id, axis);
    for (const end of ['start', 'end'] as const) {
      const pointId = endPointId(wall, end);
      const list = groups.get(pointId);
      const member = toMember(wall, end, axis);
      if (list) list.push(member);
      else groups.set(pointId, [member]);
    }
  }
  const joints: Joint[] = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([pointId, members]) => {
      // 先拦同向重叠，再分类：见 assertNoSameRay 的注释（collinear / tee / cross 一律覆盖）
      assertNoSameRay(pointId, members);
      const kind = kindOf(members);
      const trims = trimsFor(pointId, kind, members);
      return {
        pointId,
        kind,
        members: members.map((m, i) => ({
          wallId: m.wallId,
          end: m.end,
          trimLeftMm: trims[i]!.left,
          trimRightMm: trims[i]!.right,
        })),
      };
    });
  assertNoFlip(doc, joints);
  return joints;
}

/** Task 5 的入口：一面墙某一端的斜切量。找不到就抛，绝不返回 0 蒙过去。 */
export function memberTrim(
  joints: readonly Joint[],
  wallId: EntityId,
  end: WallEnd,
): JointMember {
  for (const joint of joints) {
    for (const m of joint.members) {
      if (m.wallId === wallId && m.end === end) return m;
    }
  }
  throw new RangeError(`接头表里找不到墙 ${wallId} 的 ${end} 端（内部错误）`);
}
```

`packages/core/src/index.ts` 在 `export * from './geom/topology';` 之后加：

```ts
export * from './geom/joint';
```

- [ ] **Step 4: 跑测试确认全绿**

```bash
pnpm typecheck 2>&1 | tail -5
pnpm vitest run packages/core/test/joint.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
pnpm verify 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -5
```

Expected: `joint.test.ts` 18 passed（分组 3 + 等厚直角 3 + 同向起画 2 + 斜角异厚 2 + tee 4 + cross/star 2 + 确定性 2）。`pnpm verify` 总数 = Task 3 的 138 + 18 = 156 passed，0 失败。

- [ ] **Step 5: 变异检查（防"测试考的是空气"）**

1. `kindOf` 里把 `lineGroups(members).length === 1` 判据删掉（即 collinear 也当 corner 处理）→ Expected: 「共线直通给 collinear」红。
2. corner 分支退回"同侧配对"：把 `const sb = innerSide(b, a)` 改成 `const sb = sa`（两墙都取自己的第 `sa` 条边线）→ Expected: 「start-start：接缝是另一条对角」与「end-end：同一个物理直角反过来画」两条红，而等厚直角的三条与「60° 异厚」**全绿**。那四条都是 start/end 混合角，同侧配对在那里恰好也对 —— 这个对照就是要写进执行日志的结论：**只测混合角，等于没测这条规则**。
3. tee 分支里 `faceSide` 恒定返回 `1` → Expected: 「支墙朝南时切到南面」红，而「支墙两个角点都落在直通墙的北面上」仍绿。正因为有朝南那一条，"面朝支墙"这个判据才不是恒真。
4. cross 分支把 face 改成"整族共用一个"（落地后的形状里就是 `putFlatJoin(stem, through[0]!)` 之外再传一个预先算好的 face）→ Expected: 「十字」红（必有一支臂被切到直通墙的背面，trim 变 -120）。**这条变异原本不是这样写的**：原文是"把 `const face = faceSide(through[0]!, stem)` 提到 `for (const stem …)` 外面"，而 tee 与 cross 当时是两块逐字重复的代码，`for` 块内还留着一个块级 `const face` 把提上去的值**遮蔽**掉 ⇒ 实现一字未变、18 条全绿。那是一个假变异被误记成测试有漏洞，详见执行回填第 2 条与 Global Constraints 的「变异检查的仪式」。红哪条臂仍取决于 uuidv7 排序，**这种"红哪条看运气"就是实现读了成员顺序的警报**，执行日志里要写清楚。
5. 删掉 `assertNoFlip` 调用 → Expected: 「夹角小到轮廓翻面」红。
6. `requireEqualThrough` 直接 return → Expected: 「直通两墙厚度不同」红。注意它现在只管**直通那一族**：cross 的两支臂异厚是合法图纸（带台阶的平接），那条过拒的支族检查已删，反证是「十字」用例里北臂 400 / 南臂 120 那一组数值。
7. `innerSide` 恒定返回 `1` → Expected: 与 2 同一组红（start-start、end-end 两条），其余 corner 用例全绿 —— 因为其余 fixture 的两墙内侧本来就都是 `+normal` 侧。这跟 2 红得一样不是巧合：`sa = sb = 1` 就是"同侧配对"本身。两处变异一起写进日志，用来说明**旧有四条 corner 用例对"配对规则"的覆盖是零**。
8. `assertNoSameRay` 的调用注释掉 → Expected: 只有钉同向重叠那一例红（落地是「共线直通给 collinear」里折进去的三组夹具）。**别把比较号 `> 0` 改成 `> 0.5` 当变异**：桶内两成员是同向或反向的单位向量，dot 恒为 ±1，那是个**等价变异**，按构造必绿（执行回填第 4 条）。要动就翻极性成 `< 0`：那是"拒绝合法的反向直通"，Expected: collinear + tee 三条 + 厚度不同 + 十字 共六条红。

每处改完还原，`git diff` 必须为空。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/geom/joint.ts packages/core/test/joint.test.ts packages/core/src/index.ts
git commit -m "feat: 墙接头分类与斜切量派生"
```

执行日志写在这里：18 条的实际结果、七处变异各自红了哪些、十字接头的中心块（直通族方头、支族各切到自己那一面，无重叠）与预期是否一致，以及两件事必须各写一段：
① 异厚 corner 的偏置接缝有没有真的验证过"两墙共用同一条边"，且 `trimB > trimA`（薄墙切得多）与闭式解 `(h_对 + h_己·cosθ)/sinθ` 的数值都对上；
② start-start / end-end 两条同向起画的用例，是不是本任务里唯一能区分"内侧配对"与"同侧配对"的东西 —— 是的话把这条结论留在日志里，后面谁想把 `innerSide` 换回 `side` 都会撞上它。

**留给后续任务的钩子**：Task 5 的 `deriveStoreyGeometry` 每个墙端调一次 `memberTrim`；十字接头按本任务的规则是"一族方头、一族切到面线"，图纸上不会出现重叠块 —— 计划 3 的 2D 视图无需为此特判。

#### Task 4 执行回填（2026-09-26，评审 + 修复轮 1 后裁决；本任务的权威文本是代码 `0e83570`，不是上面那几段 fence）

落地的东西与上面的文本有九处不同。前六处是计划文本自己的错，后三处是执行时才看清的性质。每一条都在代码里验过，照抄 fence 会把它们抹掉：

1. **同向共线的重叠墙，分类表会静默放过**（Critical，评审 F1）。文本的 `kindOf` 把 `lines.length === 1` 一律判 `collinear`、trim 全 0，而 `lineGroups` 按**无向**方向折桶 —— 同一个点上两堵墙朝**同一射线**出去，落进同一个桶，于是"合法直通"，图纸上是两条完全压在一起的墙带。契约里的 `collinear` 说的是**反向**共线拼成一条连续带，同向是另一回事。落地新增 `assertNoSameRay`：**组内逐对** `dot(a.away, b.away) > 0` 即抛，且跑在 `kindOf` **之前**，所以 collinear / tee / cross / star 一律覆盖（同向那一对还能藏进 tee 的"直通两墙"里，落地测试专门造了这一例）。
   三处不可达的判据顺手补了注释，但**别把 `sideVertex` 那条当死代码删**，理由见第 7 条。
2. **tee 与 cross 两块"平接斜切"在文本里逐字重复**，而重复是一起执行事故的产地：变异 4 第一次跑是**假绿** —— 把 `const face` 提到 `for` 外，块内那个块级 `const face` 把它遮蔽掉了，实现一字未变。落地抽成 `putFlatJoin(stem, through)`，face 只有一个产地，"提到循环外"这种遮蔽写法在结构上不再存在；重做的变异（把 face 当参数传进去、cross 只按 `stemLine[0]` 算一次）确实红了「十字」。规约升进 Global Constraints 的「变异检查的仪式」。
3. **`cross` 要求支族两臂同厚是过拒**（评审 F3）。两支臂被直通带隔开、从不同时接触，各自平接到自己那一面，异厚画出的是"带台阶的平接"（北臂切到 y=1120、南臂切到 y=880，无缝无重叠），是合法图纸。落地删掉 `requireEqualThrough(pointId, stemLine)`，直通族那条保留。反证折进「十字」用例：北臂 400 / 南臂 120，断言两支各自 `trim = [120, 120]`（平接量只由直通墙半厚决定，与支臂自己的厚度无关）、两角点同在一条面线上、`|x − 1000|` 等于**自己**的半厚。把那条删掉的检查加回去，恰好红这一例，报错文案是「直通两墙厚度不同（120 / 400）」—— 说的并不是这一对墙。
4. **等价变异要认出来**：把 `> 0` 改成 `> 0.5` 不是变异。桶内两成员要么同向要么反向，`dot` 恒为 ±1，改阈值什么都改不了，按构造必绿。这类"改了只是不一样"的靶子在本任务出现了一次，规约在 Global Constraints 与 Task 9 变异表处各立过一回。要动这条判据就翻极性成 `< 0`（拒绝合法的反向直通）：落地实测红六条（collinear + tee 三条 + 厚度不同 + 十字）。
5. **star 那条用例的夹具在文本里不成立**（同 Task 3 第 6 条那个"看起来对"的坐标）。第一臂 `{x: 2000, y: 0}` 与 A 的轴线**共线**，那个点只有两条方向线、三个墙端 ⇒ 分类是合法 `tee`，`toThrow(/star/)` 永远打不到 star 分支。落地把两臂改成 `(2000, 900)` 与 `(1000, 900)`，三条真方向线，`kindOf` 才落到 star。**Task 10 若复用那段"三臂"坐标，一并核**。
6. **`assertNoFlip` 不再回查文档**（评审 F7）。文本用 `wallAxisById(doc, wallId)` 取轴长，那是把同一面墙再派生一遍，还要顺带做楼层存在性检查 —— 一个几何守卫没资格判"这份文档的引用完不完整"。落地改吃 `deriveJoints` 顺手攒的 axis 表。**附带的行为差异要说清**：`deriveJoints` 从此不再对"墙指向已删楼层"抛「楼层 不存在」。评审核过不可达：`commands/storey.ts` 只导出 `storeyCreate`（没有删楼层的命令），而 `wallCreate.build` 第一行就查楼层，任何命令序列（含撤销/重做）都造不出那种文档，只有手搓 `Patch.remove` 能；且那项检查原本就跑在所有几何之后。
7. **贪心分桶让"近平行"与"精确平行"分家**。`lineGroups` 只与桶代表元比 `isParallel`，"平行"在桶里不传递 ⇒ 一对夹角小于 `PARALLEL_EPS` 的近重合方向可能被拆进**两个**桶。后果有两条：① 第 1 条那个同向判据只在桶内逐对比，看不见被拆开的近同向对 —— 但那种输入会被当成一个极小的 corner 交给 `sideVertex`，在那里抛「近平行」，或把 trim 爆到 1e8 量级由 `assertNoFlip` 拦下，**不存在静默窗口**（翻面判据的作用域约 (h_a+h_b)/L ≈ 8.6e-4 rad，比 1e-9 那个带宽六个数量级）；② 所以 `sideVertex` 那条抛错**不是死代码**，`faceSide` / `innerSide` 那两条要的是 `facing === 0` 即**精确**平行，而精确平行必同桶，那两条才真的不可达。三条注释的措辞按这个区分写。
8. **一元负号在 TS7 下过不了类型**：文本的 `put(a, -sa, b, -sb)` 把 `1 | -1` 展宽成 `number` ⇒ 三处 `TS2345`。落地用私有的 `otherSide(side: 1 | -1): 1 | -1`（与 `axis.ts` 的 `otherEnd` 同款），语义与变异 2 / 7 的语义都不受影响。
9. **两处 `noUnusedLocals` 与一处空跑断言**：文本的两个解构里 `sharedId` 取了不读（`TS6133` 是编译错误）；`expect(sharedId).toBeTruthy()` 是 Global Constraints 明令禁止的空跑断言，换成三条有鉴别力的（该点在接头表里的 kind 确为 `corner`、全图唯一的非 free、接头总数 3），并把"组内成员按墙 id 升序、同墙 start 先于 end"这条**顺序契约**并进同一条用例钉住（Task 5 要按它铺轮廓顶点）。

**执行日志**：`joint.test.ts` **18** 条（分组 3 + 等厚直角 3 + 同向起画 2 + 斜角异厚 2 + tee 4 + cross/star 2 + 确定性 2），`pnpm verify` = 138 + 18 = **156 passed**（15 files，0 失败，441ms）。实现 `6f06ea7` + `9b31c39`；评审判定 Spec ✅ / 质量不过（1 Critical + 2 Important + 3 Minor）；修复轮 1 = `0e83570`，逐条复审 **六项全部 ADDRESSED、无新增 Critical/Important**；复审揪出的两处注释级错误（第 1、7 条里的量级论证写反了分子分母）由控制方就地改在 `8fda192`（不动行为、不动条数）。变异八处逐个红、逐个还原（`git diff` 归零），其中第 4 条的原始写法是一次假变异 —— 它留在文本里作为反面教材，别再照抄。

---

### Task 5: 墙轮廓派生（geom/outline.ts）

把 Task 2 的轴线与 Task 4 的斜切量合成**画得出、量得准的四角多边形**。本层只做一件事，且它的成败用面积说话：

- **斜切保面积**：两面墙以端点相遇（corner，含异厚偏置斜切）时，`trimLeft = -trimRight`，于是每面墙的四角面积恰好等于 `轴长 × 墙厚`。这是"中线斜切"口径的几何定义 —— 材料不多不少，接缝两侧不重叠也不留缝。用例 6 与 9 钉它。
- **T 接与十字缩进**：支墙的 trim 两侧同号（Task 4），轮廓止于直通墙的面线，面积恰好少掉那一段。用例 7 与 8 钉它，并把总数与**手工算出的并集面积**对齐 —— 那是独立算法，不是拿实现验实现。
- **不自交**：四角必须构成凸四边形。Task 4 的 `assertNoFlip` 抛之前，这里什么都画不出来。

面积用鞋带公式（`polygonArea`）。它有个必须写进测试的脾气：**蝴蝶结给 0**。两面墙若自相交，两个叶片的带符号面积正好相消，看起来"面积正常"而图形是错的，所以凸性（用例 12）与面积（用例 6–9）必须同时断言，缺一条就是空跑。

**Files:**
- Create: `packages/core/src/geom/outline.ts`
- Create: `packages/core/test/outline.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes：Task 2 的 `WallAxis` / `cornerPoint` / `wallAxis` / `wallAxisById`；Task 4 的 `deriveJoints` / `memberTrim` / `Joint` / `JointMember`；Task 1 的 `Vec2`
- Produces：`WallQuad`、`wallQuad(axis, startTrim, endTrim)`、`deriveWallQuads(doc, joints?)`、`polygonArea(points)`（见契约表）

- [ ] **Step 1: 写失败的测试**

`packages/core/test/outline.test.ts`。四个 fixture 与 Task 4 同源（同样靠 `wallCreate({ start: { pointId } })` 建共享端点）；测试文件之间不共用 fixture 是有意的 —— fixture 改坏时只该红一个文件。

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  deriveJoints,
  deriveWallQuads,
  polygonArea,
  storeyCreate,
  uuidv7,
  wallAxisById,
  wallCreate,
  type Vec2,
  type WallQuad,
} from '@dajia/core';

const projectId = uuidv7();

function build(
  specs: Array<{ start: { x: number; y: number }; end: { x: number; y: number }; thicknessMm: number }>,
) {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  const storeyId = log.document.byKind('storey')[0]!.id;
  for (const s of specs) log.dispatch(wallCreate({ storeyId, heightMm: 3000, ...s }));
  return log;
}

/**
 * 以 {pointId} 复用端点追加一面墙，返回新墙 id。
 * 取新墙靠 affected，不靠 byKind 下标（同毫秒 uuidv7 不保证单调，见 Global Constraints）。
 * Task 5 回填：本 helper 原缺 `: string`，而 tee/obliqueL 两处按 `stem.wallId` / `b.wallId`
 * 读它 —— 与 lCorner 当 id 用自相矛盾，照抄会撞 TS2339。三处已统一成"返回 id"。
 */
function append(log: TransactionLog, startId: string, end: { x: number; y: number }, thicknessMm: number): string {
  const storeyId = log.document.byKind('storey')[0]!.id;
  log.dispatch(
    wallCreate({ storeyId, start: { pointId: startId }, end, thicknessMm, heightMm: 3000 }),
  );
  // 取新墙靠 affected，不靠 byKind 下标（同毫秒 uuidv7 不保证单调，见 Global Constraints）
  for (const id of log.affected) if (log.document.get(id)?.kind === 'wall') return id;
  throw new Error('追加墙失败：affected 里没有墙');
}

function quadOf(log: TransactionLog, wallId: string): WallQuad {
  const hit = deriveWallQuads(log.document).find((q) => q.wallId === wallId);
  if (!hit) throw new Error(`测试找不到墙 ${wallId} 的轮廓`);
  return hit;
}

/** 直角 L：A (0,0)→P(1000,0)，B P→(1000,800)，同厚 240。 */
function lCorner() {
  const log = build([{ start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: 240 }]);
  const a = log.document.byKind('wall')[0]!;
  const b = append(log, a.endId, { x: 1000, y: 800 }, 240);
  return { log, a: a.id, b };
}

/** T 接：直通 (0,0)→P(1000,0)→(2000,0) 厚 240，支墙 P→(1000,800) 厚 120。 */
function tee() {
  const log = build([{ start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: 240 }]);
  const hub = log.document.byKind('wall')[0]!.endId;
  append(log, hub, { x: 2000, y: 0 }, 240);
  const stem = append(log, hub, { x: 1000, y: 800 }, 120);
  return { log, hub, stem };
}

/** 十字：四臂皆终于 P(1000,1000)，全厚 240。 */
function plus() {
  const log = build([
    { start: { x: 0, y: 1000 }, end: { x: 1000, y: 1000 }, thicknessMm: 240 },
  ]);
  const hub = log.document.byKind('wall')[0]!.endId;
  for (const end of [
    { x: 2000, y: 1000 },
    { x: 1000, y: 0 },
    { x: 1000, y: 2000 },
  ]) {
    append(log, hub, end, 240);
  }
  return { log, hub };
}

/** 60° 异厚 L：A (-2000,0)→P(0,0) 厚 370，B P→(-1000,1732) 厚 200。 */
function obliqueL() {
  const log = build([{ start: { x: -2000, y: 0 }, end: { x: 0, y: 0 }, thicknessMm: 370 }]);
  const a = log.document.byKind('wall')[0]!;
  const b = append(log, a.endId, { x: -1000, y: 1732 }, 200);
  return { log, a: a.id, b };
}

/** 严格凸：四个叉积同号，共线角（叉积为 0）也算不合格。 */
function strictlyConvex(corners: readonly Vec2[]): boolean {
  let sign = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    const c = corners[(i + 2) % corners.length]!;
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (z === 0) return false;
    const s = z > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function sumArea(log: TransactionLog): number {
  return deriveWallQuads(log.document).reduce((s, q) => s + q.areaMm2, 0);
}

describe('polygonArea', () => {
  it('凸多边形恒正，且与顶点起点无关', () => {
    const square: Vec2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(polygonArea(square)).toBe(100);
    expect(polygonArea([...square.slice(2), ...square.slice(0, 2)])).toBe(100);
    expect(polygonArea([...square].reverse())).toBe(100);
  });

  it('蝴蝶结给 0：这就是 assertNoFlip 必须存在、凸性必须单独断言的原因', () => {
    expect(
      polygonArea([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ]),
    ).toBe(0);
  });
});

describe('孤墙与斜墙', () => {
  it('孤墙：四角是精确矩形，面积 = 轴长 × 墙厚', () => {
    const log = build([{ start: { x: 0, y: 0 }, end: { x: 4000, y: 0 }, thicknessMm: 240 }]);
    const [quad] = deriveWallQuads(log.document);
    expect(quad!.corners).toEqual([
      { x: 0, y: 120 },
      { x: 4000, y: 120 },
      { x: 4000, y: -120 },
      { x: 0, y: -120 },
    ]);
    expect(quad!.areaMm2).toBe(960000);
  });

  it('斜墙：面积仍等于轴长 × 墙厚，四角到轴线的垂直距离都等于半厚', () => {
    const log = build([{ start: { x: 0, y: 0 }, end: { x: 3000, y: 4000 }, thicknessMm: 200 }]);
    const wall = log.document.byKind('wall')[0]!;
    const axis = wallAxisById(log.document, wall.id);
    const quad = quadOf(log, wall.id);
    expect(quad.areaMm2).toBeCloseTo(5000 * 200, 6);
    for (const c of quad.corners) {
      const perpDist = Math.abs(
        (c.x - axis.start.x) * axis.normal.x + (c.y - axis.start.y) * axis.normal.y,
      );
      expect(perpDist).toBeCloseTo(100, 9);
    }
  });

  it('deriveWallQuads 的顺序与 byKind("wall") 一致（契约是 id 升序，不是创建顺序）', () => {
    const log = build([
      { start: { x: 0, y: 0 }, end: { x: 3000, y: 0 }, thicknessMm: 240 },
      { start: { x: 0, y: 0 }, end: { x: 0, y: 3000 }, thicknessMm: 240 },
      { start: { x: 3000, y: 0 }, end: { x: 3000, y: 3000 }, thicknessMm: 120 },
    ]);
    expect(deriveWallQuads(log.document).map((q) => q.wallId)).toEqual(
      log.document.byKind('wall').map((w) => w.id),
    );
  });
});

describe('接头处的轮廓', () => {
  it('直角 L：两墙共用同一条接缝边（四个角点逐个精确相等）', () => {
    const { log, a, b } = lCorner();
    const qa = quadOf(log, a);
    const qb = quadOf(log, b);
    expect(qa.corners).toEqual([
      { x: 0, y: 120 },
      { x: 880, y: 120 },
      { x: 1120, y: -120 },
      { x: 0, y: -120 },
    ]);
    expect(qb.corners).toEqual([
      { x: 880, y: 120 },
      { x: 880, y: 800 },
      { x: 1120, y: 800 },
      { x: 1120, y: -120 },
    ]);
    // A 的 1、2 号 === B 的 0、3 号：共边即共边界，既无缝也无双层
    expect(qa.corners[1]).toEqual(qb.corners[0]);
    expect(qa.corners[2]).toEqual(qb.corners[3]);
  });

  it('直角 L：每面墙面积恰为 轴长 × 墙厚（斜切保面积）', () => {
    const { log, a, b } = lCorner();
    expect(quadOf(log, a).areaMm2).toBeCloseTo(1000 * 240, 6);
    expect(quadOf(log, b).areaMm2).toBeCloseTo(800 * 240, 6);
    expect(sumArea(log)).toBeCloseTo(432000, 6);
  });

  it('60° 异厚 L：偏置斜切仍保面积', () => {
    const { log, a, b } = obliqueL();
    expect(quadOf(log, a).areaMm2).toBeCloseTo(2000 * 370, 6);
    expect(quadOf(log, b).areaMm2).toBeCloseTo(Math.hypot(1000, 1732) * 200, 6);
  });

  it('T 接：支墙轮廓止于直通墙面线，面积 = 120 × (800 − 120)', () => {
    const { log, stem } = tee();
    const quad = quadOf(log, stem);
    expect(quad.corners).toEqual([
      { x: 940, y: 120 },
      { x: 940, y: 800 },
      { x: 1060, y: 800 },
      { x: 1060, y: 120 },
    ]);
    expect(quad.areaMm2).toBe(81600);
    // 直通两墙各自方头到 P，正好拼满横带：240000 + 240000 = 2000 × 240
    expect(sumArea(log)).toBeCloseTo(480000 + 81600, 6);
  });

  it('十字：Σ 面积 = 手工并集 902400，中心没有重叠块', () => {
    const { log } = plus();
    expect(deriveWallQuads(log.document)).toHaveLength(4);
    // 独立算：横带 2000×240 + 竖带 240×2000 − 中心 240×240
    expect(sumArea(log)).toBeCloseTo(2000 * 240 + 240 * 2000 - 240 * 240, 6);
    expect(sumArea(log)).toBeCloseTo(902400, 6);
  });
});

describe('派生入口的契约', () => {
  it('显式传 joints 与让函数内部派生结果完全相同', () => {
    const { log } = lCorner();
    const doc = log.document;
    expect(deriveWallQuads(doc, deriveJoints(doc))).toEqual(deriveWallQuads(doc));
  });

  it('墙指向不存在的点：抛，不给 NaN 轮廓', () => {
    const log = build([{ start: { x: 0, y: 0 }, end: { x: 3600, y: 0 }, thicknessMm: 240 }]);
    const wall = log.document.byKind('wall')[0]!;
    const broken = Document.replaceEntities(
      log.document,
      new Map([...log.document.entities].filter(([id]) => id !== wall.endId)),
    );
    expect(() => deriveWallQuads(broken)).toThrow(/墙终点 不存在/);
  });

  it('四个 fixture 的 11 面墙轮廓全部严格凸（自相交与共线退化都会红）', () => {
    const fixtures = [lCorner(), tee(), plus(), obliqueL()];
    let checked = 0;
    for (const { log } of fixtures) {
      for (const quad of deriveWallQuads(log.document)) {
        checked++;
        expect(strictlyConvex(quad.corners)).toBe(true);
      }
    }
    // L 2 + tee 3 + cross 4 + 斜 L 2：数量写死，防止 fixture 悄悄少建墙变成空跑
    expect(checked).toBe(11);
  });
});
```

- [ ] **Step 2: 跑测试确认它们红**

```bash
pnpm vitest run packages/core/test/outline.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -15
```

Expected: FAIL，**13 条全红**（Task 5 回填：原写"`does not provide an export named 'deriveWallQuads'`"是错的期望）。实测报的是运行期 `TypeError: polygonArea is not a function` 与 `deriveWallQuads is not a function or its return value is not iterable` —— 测试经 `@dajia/core` 这个 barrel 拿到的是值为 `undefined` 的具名导出，esbuild 转译后不在链接期抛 `SyntaxError`。**RED 的实质成立**（新 API 一个都不存在、13/13 红），只是失败的消息形态与这里写的不一样；以后写"红在导出不存在"这类期望时按这条的实际形态记。

- [ ] **Step 3: 实现 `geom/outline.ts`**

```ts
import type { EntityId } from '../ids';
import type { Document } from '../model/document';
import { cornerPoint, wallAxis, type WallAxis } from './axis';
import { deriveJoints, memberTrim, type Joint, type JointMember } from './joint';
import type { Vec2 } from './vec';

/**
 * 一面墙的矩形（斜切后是梯形）轮廓。corners 是**环序**：
 * 0 = start 侧 +normal，1 = end 侧 +normal，2 = end 侧 -normal，3 = start 侧 -normal。
 * 顺序即契约 —— 计划 3 描边、计划 5 标注都以它为前提。
 */
export interface WallQuad {
  readonly wallId: EntityId;
  readonly corners: readonly [Vec2, Vec2, Vec2, Vec2];
  readonly areaMm2: number;
}

/**
 * 鞋带公式，返回绝对值。注意：自相交的蝴蝶形两叶带符号相消 → 给 0，
 * 所以"面积对"不等于"形状对"，调用方要单独保证不自交（joint.ts 的 assertNoFlip）。
 */
export function polygonArea(points: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function wallQuad(
  axis: WallAxis,
  startTrim: JointMember,
  endTrim: JointMember,
): WallQuad {
  const corners: [Vec2, Vec2, Vec2, Vec2] = [
    cornerPoint(axis, 'start', 1, startTrim.trimLeftMm),
    cornerPoint(axis, 'end', 1, endTrim.trimLeftMm),
    cornerPoint(axis, 'end', -1, endTrim.trimRightMm),
    cornerPoint(axis, 'start', -1, startTrim.trimRightMm),
  ];
  return { wallId: axis.wallId, corners, areaMm2: polygonArea(corners) };
}

/**
 * joints 可传入以避免重复派生（Task 6 的整层入口一次派生两处用）。
 * 不传就内部派生：绝不因为"没接头表"就退化成平接 —— 那样接头会静默开裂。
 */
export function deriveWallQuads(doc: Document, joints?: readonly Joint[]): WallQuad[] {
  const table = joints ?? deriveJoints(doc);
  return doc.byKind('wall').map((wall) => {
    const axis = wallAxis(doc, wall);
    return wallQuad(axis, memberTrim(table, wall.id, 'start'), memberTrim(table, wall.id, 'end'));
  });
}
```

`packages/core/src/index.ts` 在 `export * from './geom/joint';` 之后加：

```ts
export * from './geom/outline';
```

- [ ] **Step 4: 跑测试确认全绿**

```bash
pnpm typecheck 2>&1 | tail -5
pnpm vitest run packages/core/test/outline.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
pnpm verify 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -5
```

Expected: `outline.test.ts` 13 passed（polygonArea 2 + 孤墙与斜墙 3 + 接头处的轮廓 5 + 派生入口的契约 3）。`pnpm verify` = 156 + 13 = 169 passed，0 失败。

**若 `deriveWallQuads(doc, deriveJoints(doc))` 那条比对失败**：先查 `toEqual` 两侧是否对象引用不同但值相同（`toEqual` 只看值，不该失败），再看 `wallQuad` 是否在某条路径上返回了新 `corners` 数组之外的字段差异。

- [ ] **Step 5: 变异检查（防"测试考的是空气"）**

1. `wallQuad` 里第 4 个角点把 `startTrim.trimRightMm` 写成 `startTrim.trimLeftMm`（左右两侧串味）→ **实测红 3**：「直角 L 共边」「直角 L 面积」「60° 异厚 L」；「T 接」绿（支墙 `trimLeft === trimRight`，对它是数学 no-op）。原预言把「T 接」写成红、又在同一句括号里说不红 —— 括号对，主句错。
2. 把环序改成 `[c0, c2, c1, c3]`（角点错序）→ **实测红 8**（凸性 + 面积类 + 共边一起红），覆盖面比原预言（只点名凸性与"面积类跟着红"）大得多。
3. `polygonArea` 去掉 `Math.abs` → **实测红 7**（原预言只点名 2 条：「凸多边形恒正」「孤墙」）。同样失明于覆盖面。
4. `deriveWallQuads` 的 `joints ?? deriveJoints(doc)` 改成 `joints ?? []` → **实测红 10，绿 3**。绿的 3 条 = `polygonArea` 两条 + 「墙指向不存在的点」。原预言"所有走默认路径的用例红"过头了一条，因为**那条用例断的错根本不出自轮廓派生**：见下面 M4 的机制说明。
5. 把 `memberTrim(table, wall.id, 'start')` 与 `'end'` 互换 → **实测红 2**：「直角 L 共边」「T 接」；「直角 L 面积」绿。原预言"直角 L 两条红"错。
6. （Task 5 回填补的两条对照，简报没有）**M6** 四角 `trimLeftMm`/`trimRightMm` 整体对调 → 只红 1 条（「直角 L 共边」）；**M7** 环序轮转 `[c1,c2,c3,c0]`（面积、凸性全不变）→ 红 3 条（孤墙、直角 L、T 接）。M7 是"环序契约不止是注释"的证据，M6 是下面 Σ 面积盲区的证据。

**M4 为什么有一条仍绿（别再归因成"outline.ts 的 wallAxis 先抛"）**：未变异时 `outline.ts` 的 `deriveWallQuads` 在 `.map()` **之前**就跑了 `deriveJoints(doc)`，而 `joint.ts` 的派生循环里也调 `wallAxis` —— 所以「墙指向不存在的点」那条断到的 `墙终点 不存在` 出自 `joint.ts`；施加 M4 后 `deriveJoints` 不再跑，抛点才落到 `outline.ts` 自己的 `wallAxis`。**同一条中文消息，两个产地**，所以"仍绿"的判定对，机制描述要写对。

**Σ 面积盲区（Task 5 最重要的测试学结论，Task 10 必读）**：`wallQuad` 四角展开后鞋带给出 `Area = 墙厚 × (轴长 − Σt/2)`，`Σt = tL_start + tL_end + tR_start + tR_end` —— 任何**保和的重排**（start↔end、left↔right）面积逐字不变，凸性也看不见（梯形仍凸）。M5/M6 实测印证：只有**位置化的角点 `toEqual`** 能看见侧别/端别错配，而今天全仓库这样的钉子只有三条（`outline.test.ts` 的孤墙、直角 L、T 接），且全部建立在轴对齐整数坐标上。结论：Task 10 的 Σ 面积属性**永远**抓不到侧别错配，那条按侧比对闭式解的预言不可删、不可"简化成比面积"（另见 Task 4 执行回填里 `innerSide` 的同一段论证）。

每处改完还原，`git diff` 必须为空。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/geom/outline.ts packages/core/test/outline.test.ts packages/core/src/index.ts
git commit -m "feat: 墙轮廓四角与面积派生"
```

#### Task 5 执行回填（2026-09-26，评审后）

交付：`packages/core/src/geom/outline.ts`（新建 57 行）、`packages/core/test/outline.test.ts`（新建 271 行 / 13 条）、`src/index.ts` +1 行导出。提交 `2050fc5`，只含这三个文件；`pnpm verify` = **169 passed / 16 files**（156 + 13），控制器与评审各自复跑确认。

**13 条的实际结果**：RED 阶段 13/13 红（新 API 一个都不存在），GREEN 阶段 13/13 绿。用例分布与简报预期逐条一致：`polygonArea` 2 + 孤墙与斜墙 3 + 接头处的轮廓 5 + 派生入口的契约 3。四个 fixture 全在本文件内、未从 `joint.test.ts` import 任何东西（改坏只红一个文件）；11 面墙严格凸那条写死 `checked === 11`，无空跑。

**"斜切保面积"在 60° 异厚角上到底成不成立**（这条必须写实数，不能只记"绿了"）：临时 `console.log` 取到的实测是 —— 厚墙 A（轴长恰 2000、厚 370）`areaMm2 = 740000` 与 `轴长 × 墙厚` **逐位相同**（差 0）；薄墙 B（轴长 `hypot(1000,1732)` = 1999.9559…、厚 200）`399991.1999031978` 对闭式 `399991.19990319794`，差 `-1.16e-10` mm²、相对误差 ≈3e-16，落在双精度舍入里，**不是靠 `toBeCloseTo` 的容差蒙绿**。同时两墙接缝角点 `A[1].y = 185` 与 `B[0].y = 185.00000000000003` 差 ≈3e-14 ⇒ **斜角下的"共点"是浮点意义而非逐位**，所以本文件的逐位 `toEqual` 只用在直角 L / T 接这类轴对齐整数 fixture 上（这条已升格成 Task 10 的义务 O2）。探针跑完即还原，校验和回到基线 `7e1e6630…`。

**变异的实际红集合与简报预言的差**（简报 Step 5 五条预言里三条错，全部是**简报层**缺陷，代码未改；详见上面 Step 5 的改文）：M1 红 3（简报把「T 接」写成红，而同一句括号又说不红 —— 括号对）；M2 红 8（简报只点名凸性 + 面积，覆盖面低估）；M3 红 7（简报只点名 2 条）；M4 红 10 绿 3（简报"所有默认路径都红"过头一条）；M5 红 2（简报"直角 L 两条红"错，只有共边那条）。评审独立重跑五处 + 补两条探针（M6 左右整体对调 → 只红 1；M7 环序轮转 → 红 3），红集合与报告逐条一致。

**M4 那条为什么绿 —— 别把抛点归因错**：报告原文写"`deriveWallQuads` 先 `wallAxis` 后 `memberTrim`，所以 `墙终点 不存在` 仍先抛"，这个机制是**错的**：未变异时 `outline.ts:52` 的 `deriveJoints(doc)` 在 `.map()` **之前**执行，所以「墙指向不存在的点」断到的消息产自 `joint.ts:341-342` 的派生循环；只有施加 M4 之后抛点才落到 `outline.ts:54` 自己的 `wallAxis`。同一条中文消息、两个产地 —— 判定（仍绿）不受影响，但机制写错会让下一个人以为轮廓层是那条错误的守门人。

**评审裁定（0 Critical / 1 Important / 4 Minor，SPEC COMPLIANT + QUALITY APPROVED）**

- **裁定 1（`append` 编译失败）**：简报的 `append()` 同时做两件事 —— ① 靠 `wallCreate({ start: { pointId } })` 复用共享端点，② 从 `log.affected` 取新墙。落地态两件都原样保留，**变的只有返回形状**（`string` 而非 `{ wallId }`），而返回形状不参与任何断言（`quadOf(log, wallId)` 收 id，`lCorner` 本来也当 id 用）→ 用例没有被悄悄削弱，五处变异全部仍可触发。附带查清一件值得记的事：`wall.ts:80-114` 的 `wallCreate.build` 复用 `pointId` 时连点都不 upsert，所以一次 `wallCreate` 的 `affected` 里**恰好一面墙**，那个"取第一个墙"的循环是确定性的，不存在"悄悄拿到旧墙、用例其实考的是空气"。
- **裁定 2（落地测试是否仍在分辨）**：是。简报声称要钉的每一件事都至少被一条红测试钉住。**唯一没有红测试支撑的行为是"显式传入的 `joints` 被用上"** —— 见下面 F1。
- **裁定 3（Σ 面积盲区）**：盲区是真的，但只吞掉面积/凸性类断言；per-end（M5 红 2）与 per-side（M6 红 1）由**位置化角点** `toEqual` 钉住了，故 Task 5 不需补断言（简报钉死 13 条 + 计数链 169，私自加 `it` 才是违例）。风险是这条防线**只有一个点**且完全依赖整数坐标 → 义务 O2 交给 Task 10。
- **裁定 4（`joints?` 可选参数）**：显式表路径**没有**被任何测试行为化地验证（把 `joints ?? deriveJoints(doc)` 改成彻底忽略参数 → 13/13 仍绿，因为 `outline.test.ts:246` 那条两侧同源）。可接受答案是"Task 6 owns it"（`joints` 的唯一设计目的就是 Task 6 的整层入口），但必须落进 ledger 并写进 Task 6 的简报 → 义务 O1。
- **附加两项**：① Task 5 的 fixture 没有一个违反 Task 4 的 `assertNoSameRay`（它是**桶内**检查；`obliqueL` 的两墙 `dot = +0.5 > 0` 但不平行故不同桶 —— 这条要记：若哪天有人把 `assertNoSameRay` 改成跨桶比 dot，这个合法 60° L 会红，而红是错的）；② **环序契约不是只有注释**：三条按下标的四元组 `toEqual` 把它钉住了，轮转 `[c1,c2,c3,c0]`（面积、凸性全不变）实测红 3 条。

**下游义务（Task 6 / 8 / 10 的简报必须带上这几条）**

- **O1（Task 6）**：`deriveStoreyGeometry` 只准把**未经过滤的** `allJoints = deriveJoints(doc)` 喂给 `deriveWallQuads`，按层裁剪必须发生在**返回值**上。误传 layer-filtered 表分两种后果：① 传 `deriveStoreyGeometry` 里那张 `const joints = allJoints.filter(...)`（它只服务于 `StoreyGeometry.joints` 字段）—— `deriveWallQuads` 遍历的是 `doc.byKind('wall')` 全部墙，被丢掉的别层墙端查不到成员 ⇒ 抛 `/接头表里找不到墙 …（内部错误）/`，而**单楼层 fixture 上这种错传完全隐形**（filter 是 no-op），只有两层 fixture 能暴露；② 若传的是"按成员删过但 Joint 骨架还在"的表，成员数一变 `kindOf` 就把 cross 降级成 tee、tee 降级成 corner ⇒ 斜切量**静默算错**，轮廓开裂或重叠，一条异常都不抛。另：`joints` 非空时 `deriveJoints` 根本不跑，`assertNoSameRay` / `requireEqualThrough` / star 抛错 / `assertNoFlip` 四道守卫全部缺席 ⇒ 这张表必须来自同一个 `doc` 的同一次 `deriveJoints`，不许修补、不许跨文档缓存复用。Task 6 还须补一条证明"参数真被消费"的用例，最小形式：`expect(() => deriveWallQuads(doc, [])).toThrow(/接头表里找不到墙/)`。
- **O2（Task 10）**：Σ 面积属性（8,140,800 那条）对 start/end 与 left/right 错配**结构性失明**（`Area = 墙厚 × (轴长 − Σt/2)`）⇒ 按侧比对闭式解的那条预言不可删、不可"简化成比面积"；跨墙角点的逐位 `toEqual` 只允许出现在轴对齐整数 fixture 上（60° 实测共点差 ≈3e-14）。
- **O3（Task 10）**：环序 `[0=start+, 1=end+, 2=end−, 3=start−]`（`[0,3]` 同端、`[1,2]` 同端）目前只被三条整数 fixture 顺带钉住，而计划 3 的描边按下标走一圈 ⇒ `quadEndCorners` 必须显式按 `(end, side) → 下标` 比对，把注释契约升格为断言契约。
- **O4（Task 8）**：`polygonArea` 对 <3 点返回 0 而不抛（简报明文，且 Task 5 路径上不可达）⇒ 判板环合法性必须先过 `assertSimpleRing`，否则退化环"面积正常"。
- **O5（顺序契约，Task 6 / 9 可直接受益）**：`deriveWallQuads` 的输出序列 == `doc.byKind('wall')` == 墙 id 升序；Task 6 的 `.filter((q) => ids.has(q.wallId))` 保序，Task 9 可以直接 `new Map(quads.map(q => [q.wallId, q]))` 而不必再排。`WallQuad` **没有** `storeyId` 字段（`WallAxis` 有），按层取轮廓只能自己按 `wall.storeyId` 过滤 —— 与 `deriveJoints` 同一条限制。
- **O6（性能）**：`wallQuad` 是公开原语，Task 9/10 可直接拿 `axis + 两端 JointMember` 调；`memberTrim` 是 O(成员总数) 的线性查表，谁要在循环里逐墙调它，请像 `deriveWallQuads` 一样一次建表一次查。

**留给后续任务的钩子**：`deriveStoreyGeometry` 在 Task 6 补进本文件 —— 它要同时消费轮廓、接头与洞口分段，早一步写就得留空字段。**它传 `deriveWallQuads` 的那张表必须是未过滤的 `allJoints`**（按层裁剪发生在返回值上），理由与误传的两种静默后果见上面 O1；Task 6 的简报必须原样带上这条。

---

### Task 6: 洞口沿墙定位、墙身分段与整层派生入口

洞口口径（用户已确认第 2 条）：**派生时把墙沿洞口打断成段**，真源仍是"墙 + 洞口"两份数据，不复制几何。本任务落地三件事：

1. **区间换算**：`distanceMm + widthMm` → 沿轴 `OpeningSpan`。注意轴长是**浮点**（Task 2），所以"放不放得下"是浮点比较：1000×1000 的斜墙轴长 1414.21mm，1414 宽的洞口放得下，1415 放不下。整数墙长在真源里根本不存在，别拿它当判据。
2. **校验只有一份**：`assertSpansFit` 被 `piecesFromSpans` 内建调用，Task 7 的 `openingCreate` / `openingMove` 也调它。派生层能画出来的东西与命令层能写进去的东西由同一段代码把关，不会两边规则漂移。
3. **零长段不产，贴边洞口拒绝**：洞口正好压在墙端（`distanceMm = 0`）是真实的门洞，尾段照常产出、不产出 `[0,0]` 空壳；而两个洞口中间 0 墙垛则直接抛 —— 施工上那是一樘而不是两樘，且会退化出零长的"段"。两条规则方向相反，所以各有一条正对照盯着（用例 3 与用例 4）。

`deriveStoreyGeometry` 放在 `outline.ts`（Task 5 的空位），因为它是轮廓 + 接头 + 分段的合成出口，计划 3 的 2D 视图与计划 9 的索引都只认它。

**Files:**
- Create: `packages/core/src/geom/opening.ts`
- Modify: `packages/core/src/geom/outline.ts`（补 `StoreyGeometry` / `deriveStoreyGeometry`）
- Create: `packages/core/test/opening-geom.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes：Task 2 的 `wallAxis`；Task 5 的 `WallQuad` / `deriveWallQuads`；计划 1 的 `OpeningEntity` / `WallEntity` / `Document`
- Produces：`OpeningSpan`、`WallPiece`、`openingSpans(doc, wall)`、`assertSpansFit(wallId, lengthMm, spans)`、`piecesFromSpans(wallId, lengthMm, spans)`、`StoreyGeometry`、`deriveStoreyGeometry(doc, storeyId)`（见契约表）。Task 7 用 `assertSpansFit` 做写入前校验；Task 9 用 `deriveStoreyGeometry` 建索引。

- [ ] **Step 1: 写失败的测试**

`packages/core/test/opening-geom.test.ts`。此时还没有 `openingCreate`（Task 7），洞口一律用手写实体 + 一条只 upsert 它的命令塞进真源 —— 与计划 1 `commands.test.ts` 的 `wallWithOpening` 同一手法。

> **Task 6 回填：下面 Step 1 的夹具文本有四处与落地态不同，照抄前先读本文末尾的「Task 6 执行回填」。**
> **D2** = 跨层用例里 `fake` 必须是 `w1` 的**替身**（`entities.delete(w1.id)` + `set(fake.id, fake)`），两墙并存会先撞 `assertNoSameRay` 的「同向重叠」，本层守卫根本走不到；
> **D3** = 排序用例的 id 要用 `uuidv7(1)/(2)/(3)` 钉死，`expect(far.id < near.id)` 原文是抛硬币（同毫秒 rand_a 随机）；
> **F2** = 排序用例还要第三个**同距**洞才走得到 tie-break（没有平距样本时，把比较号整个反转也不会红）；
> **F3** = 两处 `expect(storeyId).toBeTruthy()` 是恒真空跑，换成含楼层 id 的 `toThrow(new RegExp(...))`（uuid 只含 hex 与 `-`，全角括号不是元字符）。
> `it` 数仍是 12，`pnpm verify` 仍是 181。helper `addOpening` 因此多了一个**只活在测试里**的可选 `id`。

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  assertSpansFit,
  deriveJoints,
  deriveStoreyGeometry,
  deriveWallQuads,
  openingSpans,
  piecesFromSpans,
  storeyCreate,
  uuidv7,
  wallAxisById,
  wallCreate,
  type Joint,
  type OpeningEntity,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();

function oneWall(
  start: { x: number; y: number },
  end: { x: number; y: number },
  thicknessMm = 240,
) {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  const storeyId = log.document.byKind('storey')[0]!.id;
  log.dispatch(wallCreate({ storeyId, start, end, thicknessMm, heightMm: 3000 }));
  return { log, storeyId, wall: log.document.byKind('wall')[0]! };
}

/** 长度字段一律给合法的整数毫米，只让被测的 distance/width 变化。 */
function addOpening(
  log: TransactionLog,
  wall: WallEntity,
  spec: { distanceMm: number; widthMm: number; category?: 'door' | 'window'; storeyId?: string },
): OpeningEntity {
  const opening: OpeningEntity = {
    kind: 'opening',
    id: uuidv7(),
    storeyId: spec.storeyId ?? wall.storeyId,
    hostWallId: wall.id,
    distanceMm: spec.distanceMm,
    widthMm: spec.widthMm,
    heightMm: 1500,
    sillMm: spec.category === 'door' ? 0 : 900,
    category: spec.category ?? 'window',
  };
  log.dispatch({ type: 'opening.create', build: () => ({ upsert: [opening], remove: [] }) });
  return opening;
}

function axisLen(log: TransactionLog, wallId: string): number {
  return wallAxisById(log.document, wallId).lengthMm;
}

describe('洞口区间与墙身分段', () => {
  it('无洞口：一整段 [0, 轴长]', () => {
    const { log, wall } = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    expect(openingSpans(log.document, wall)).toEqual([]);
    expect(piecesFromSpans(wall.id, axisLen(log, wall.id), [])).toEqual([
      { wallId: wall.id, fromMm: 0, toMm: 3600 },
    ]);
  });

  it('一个居中窗：两段，边界精确，Σ段长 + Σ洞口宽 = 轴长', () => {
    const { log, wall } = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    const opening = addOpening(log, wall, { distanceMm: 900, widthMm: 1200 });
    const spans = openingSpans(log.document, wall);
    expect(spans).toEqual([{ openingId: opening.id, fromMm: 900, toMm: 2100 }]);
    const pieces = piecesFromSpans(wall.id, axisLen(log, wall.id), spans);
    expect(pieces).toEqual([
      { wallId: wall.id, fromMm: 0, toMm: 900 },
      { wallId: wall.id, fromMm: 2100, toMm: 3600 },
    ]);
    const pieceSum = pieces.reduce((s, p) => s + (p.toMm - p.fromMm), 0);
    const openingSum = spans.reduce((s, x) => s + (x.toMm - x.fromMm), 0);
    expect(pieceSum + openingSum).toBeCloseTo(3600, 9);
  });

  it('门洞贴墙起点：跳过零长段，只剩尾段', () => {
    const { log, wall } = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    addOpening(log, wall, { distanceMm: 0, widthMm: 900, category: 'door' });
    expect(piecesFromSpans(wall.id, axisLen(log, wall.id), openingSpans(log.document, wall))).toEqual(
      [{ wallId: wall.id, fromMm: 900, toMm: 3600 }],
    );
  });

  it('两洞之间必须留墙垛：贴边抛；留 1mm 恰好三段（正对照）', () => {
    const { log, wall } = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    addOpening(log, wall, { distanceMm: 900, widthMm: 1200 });
    addOpening(log, wall, { distanceMm: 2100, widthMm: 500 });
    expect(() =>
      piecesFromSpans(wall.id, axisLen(log, wall.id), openingSpans(log.document, wall)),
    ).toThrow(/重叠或贴边/);

    const ok = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    addOpening(ok.log, ok.wall, { distanceMm: 900, widthMm: 1200 });
    addOpening(ok.log, ok.wall, { distanceMm: 2101, widthMm: 500 });
    expect(piecesFromSpans(ok.wall.id, 3600, openingSpans(ok.log.document, ok.wall))).toEqual([
      { wallId: ok.wall.id, fromMm: 0, toMm: 900 },
      { wallId: ok.wall.id, fromMm: 2100, toMm: 2101 },
      { wallId: ok.wall.id, fromMm: 2601, toMm: 3600 },
    ]);
  });

  it('超出宿主墙抛；正好收在墙尾合法（正对照）', () => {
    const over = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    addOpening(over.log, over.wall, { distanceMm: 3000, widthMm: 900 });
    expect(() =>
      piecesFromSpans(over.wall.id, 3600, openingSpans(over.log.document, over.wall)),
    ).toThrow(/超出宿主墙/);

    const flush = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    addOpening(flush.log, flush.wall, { distanceMm: 2700, widthMm: 900 });
    expect(piecesFromSpans(flush.wall.id, 3600, openingSpans(flush.log.document, flush.wall))).toEqual(
      [{ wallId: flush.wall.id, fromMm: 0, toMm: 2700 }],
    );
  });

  it('斜墙按浮点轴长判定：1414 宽放行，1415 宽抛', () => {
    const fits = oneWall({ x: 0, y: 0 }, { x: 1000, y: 1000 });
    addOpening(fits.log, fits.wall, { distanceMm: 0, widthMm: 1414 });
    const lengthMm = axisLen(fits.log, fits.wall.id);
    expect(lengthMm).toBeCloseTo(Math.SQRT2 * 1000, 9);
    expect(Number.isInteger(lengthMm)).toBe(false);
    expect(piecesFromSpans(fits.wall.id, lengthMm, openingSpans(fits.log.document, fits.wall))).toHaveLength(
      1,
    );

    const over = oneWall({ x: 0, y: 0 }, { x: 1000, y: 1000 });
    addOpening(over.log, over.wall, { distanceMm: 0, widthMm: 1415 });
    expect(() =>
      piecesFromSpans(over.wall.id, axisLen(over.log, over.wall.id), openingSpans(over.log.document, over.wall)),
    ).toThrow(/超出宿主墙/);
  });

  it('openingSpans 按 fromMm 升序，而非实体创建顺序', () => {
    const { log, wall } = oneWall({ x: 0, y: 0 }, { x: 6000, y: 0 });
    const far = addOpening(log, wall, { distanceMm: 4000, widthMm: 600 });
    const near = addOpening(log, wall, { distanceMm: 500, widthMm: 600 });
    // 先建的洞在远端：结果顺序必须与创建顺序相反，否则这条排序是空跑
    expect(far.id < near.id).toBe(true);
    expect(openingSpans(log.document, wall).map((s) => s.openingId)).toEqual([near.id, far.id]);
  });

  it('洞口与宿主墙不同层：抛（真源不校验引用，派生层必须查）', () => {
    const { log, wall, storeyId } = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    addOpening(log, wall, { distanceMm: 100, widthMm: 600, storeyId: uuidv7() });
    expect(() => openingSpans(log.document, wall)).toThrow(/两者必须同层/);
    expect(storeyId).toBeTruthy();
  });

  it('assertSpansFit 要求入参升序：乱序直接抛，不静默漏检重叠', () => {
    expect(() =>
      assertSpansFit(uuidv7(), 3600, [
        { openingId: uuidv7(), fromMm: 2000, toMm: 2600 },
        { openingId: uuidv7(), fromMm: 500, toMm: 1100 },
      ]),
    ).toThrow(/升序/);
  });
});

describe('deriveStoreyGeometry', () => {
  it('整层派生：墙、接头、段三类结果都只含本层', () => {
    const { log, storeyId } = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    const w0 = log.document.byKind('wall')[0]!;
    addOpening(log, w0, { distanceMm: 900, widthMm: 1200 });
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    const storey1 = log.document.byKind('storey').find((s) => s.index === 1)!.id;
    log.dispatch(
      wallCreate({
        storeyId: storey1,
        start: { x: 0, y: 0 },
        end: { x: 0, y: 3000 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    );
    const w1 = log.document.byKind('wall').find((w) => w.storeyId === storey1)!;
    const g0 = deriveStoreyGeometry(log.document, storeyId);
    const g1 = deriveStoreyGeometry(log.document, storey1);
    expect(g0.walls.map((q) => q.wallId)).toEqual([w0.id]);
    expect(g0.pieces).toEqual([
      { wallId: w0.id, fromMm: 0, toMm: 900 },
      { wallId: w0.id, fromMm: 2100, toMm: 3600 },
    ]);
    expect(g1.walls.map((q) => q.wallId)).toEqual([w1.id]);
    expect(g1.pieces).toEqual([{ wallId: w1.id, fromMm: 0, toMm: 3000 }]);
    // 两层各 2 个自由端：接头不许串层（两层墙起点同为 (0,0) 也不许合并）
    expect(g0.joints).toHaveLength(2);
    expect(g1.joints).toHaveLength(2);
    expect(g0.joints.every((j) => j.members.every((m) => m.wallId === w0.id))).toBe(true);

    // ---- Task 5 回填 O1：钉住"传进来的接头表真被消费" ----
    // 评审实测：把 outline.ts 的 `joints ?? deriveJoints(doc)` 改成彻底忽略入参，Task 5 的 13 条全绿
    //（那条显式传参的用例两侧同源，对"参数是否被读"这个维度结构性失明）。补在这里而不是新开一条
    // `it` —— Task 6 的 it 数（12）与计数链 181 是计划级契约。
    expect(() => deriveWallQuads(log.document, [])).toThrow(/接头表里找不到墙/);
    // 更强的预言：喂一张改过 trim 的表，角点必须跟着动（用的是这张表，不是重新派生出来的那份）
    const patched: Joint[] = deriveJoints(log.document).map((joint) => ({
      ...joint,
      members: joint.members.map((m) =>
        m.wallId === w0.id
          ? { ...m, trimLeftMm: m.trimLeftMm + 500, trimRightMm: m.trimRightMm + 500 }
          : m,
      ),
    }));
    const moved = deriveWallQuads(log.document, patched).find((q) => q.wallId === w0.id)!;
    // w0 是 (0,0)→(3600,0) 厚 240 的自由端墙：+500 内退发生在 start 端的 +normal 侧 ⇒ (500, 120)
    expect(moved.corners[0]).toEqual({ x: 500, y: 120 });
    expect(moved.corners[1]).toEqual({ x: 3100, y: 120 });
  });

  it('楼层不存在抛；空楼层给三个空集合而不是抛', () => {
    const { log } = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    expect(() => deriveStoreyGeometry(log.document, uuidv7())).toThrow(/楼层 不存在/);
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    const empty = log.document.byKind('storey').find((s) => s.index === 1)!.id;
    expect(deriveStoreyGeometry(log.document, empty)).toEqual({
      storeyId: empty,
      walls: [],
      joints: [],
      pieces: [],
    });
  });

  it('跨楼层共享端点：命令层造不出来，手工构造时抛，不静默按本层派生', () => {
    const { log, storeyId } = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    const w0 = log.document.byKind('wall')[0]!;
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    const storey1 = log.document.byKind('storey').find((s) => s.index === 1)!.id;
    log.dispatch(
      wallCreate({
        storeyId: storey1,
        start: { x: 0, y: 0 },
        end: { x: 0, y: 3000 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    );
    const w1 = log.document.byKind('wall').find((w) => w.storeyId === storey1)!;
    // 伪造一面"属于楼层 1、起点却是楼层 0 的点"的墙：resolvePointRef 挡住了命令，
    // 但 Document 不校验引用完整性，派生层必须自己发现。
    const fake: WallEntity = { ...w1, id: uuidv7(), startId: w0.startId };
    const bad = Document.replaceEntities(
      log.document,
      new Map([...log.document.entities, [fake.id, fake]]),
    );
    expect(() => deriveStoreyGeometry(bad, storey1)).toThrow(/接头不在本层/);
    expect(storeyId).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认它们红**

```bash
pnpm vitest run packages/core/test/opening-geom.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -15
```

Expected: FAIL，**12 条全红**，报的是运行期 `TypeError: openingSpans is not a function`（`deriveStoreyGeometry` 同理）。Task 6 回填：原写的 `does not provide an export named …` 是错的期望，理由与 Task 5 那条完全相同（入口是 TS 源、vitest 走 esbuild，缺失的具名导出取到 `undefined`，不在链接期抛 `SyntaxError`）—— 见上面 Task 5 执行日志的 D2 段。

- [ ] **Step 3: 实现 `geom/opening.ts`**

```ts
import type { EntityId } from '../ids';
import type { Document } from '../model/document';
import type { WallEntity } from '../model/entity';

/** 洞口在宿主墙轴线上占的区间：沿轴浮点毫米，自 start 端起算。 */
export interface OpeningSpan {
  readonly openingId: EntityId;
  readonly fromMm: number;
  readonly toMm: number;
}

/** 被打断后剩下的一段实体墙（墙垛、窗下墙…），同样是沿轴区间。 */
export interface WallPiece {
  readonly wallId: EntityId;
  readonly fromMm: number;
  readonly toMm: number;
}

/**
 * 洞口 → 沿轴区间，按 fromMm 升序（同距离按 id 升序，保证确定性）。
 * 楼层一致性在这里查：真源只管 id 与整数毫米，不管引用完整性，
 * 而"洞口挂在别层的墙上"会让几何凭空出现在错误的标高上。
 */
export function openingSpans(doc: Document, wall: WallEntity): OpeningSpan[] {
  const out: OpeningSpan[] = [];
  for (const opening of doc.byKind('opening')) {
    if (opening.hostWallId !== wall.id) continue;
    if (opening.storeyId !== wall.storeyId) {
      throw new TypeError(
        `洞口 ${opening.id} 属于楼层 ${opening.storeyId}，宿主墙 ${wall.id} 属于楼层 ` +
          `${wall.storeyId}：两者必须同层`,
      );
    }
    out.push({
      openingId: opening.id,
      fromMm: opening.distanceMm,
      toMm: opening.distanceMm + opening.widthMm,
    });
  }
  return out.sort(
    (a, b) =>
      a.fromMm - b.fromMm ||
      (a.openingId < b.openingId ? -1 : a.openingId > b.openingId ? 1 : 0),
  );
}

/**
 * 越界与重叠的**唯一**判据：本文件的 piecesFromSpans 内建调用它，Task 7 的
 * openingCreate / openingMove 写盘前也调用它。派生与写入共用一份规则，不会漂。
 * 入参必须已按 fromMm 升序（openingSpans 保证；调用方自己拼表时要先排）。
 */
export function assertSpansFit(
  wallId: EntityId,
  lengthMm: number,
  spans: readonly OpeningSpan[],
): void {
  for (const span of spans) {
    if (span.fromMm < 0 || span.toMm > lengthMm) {
      throw new RangeError(
        `洞口 ${span.openingId} 超出宿主墙 ${wallId}：墙沿轴长 ${lengthMm.toFixed(1)}，` +
          `洞口占 ${span.fromMm}–${span.toMm}`,
      );
    }
  }
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1]!;
    const cur = spans[i]!;
    if (prev.fromMm > cur.fromMm) {
      throw new RangeError(`assertSpansFit 需要按 fromMm 升序的洞口表（内部错误）`);
    }
    // <= 而不是 <：贴边（0 墙垛）在施工上就是一樘，且会退化出零长的"段"。
    if (cur.fromMm <= prev.toMm) {
      throw new RangeError(
        `洞口 ${prev.openingId} 与 ${cur.openingId} 在墙 ${wallId} 上重叠或贴边：` +
          `${prev.toMm} ≥ ${cur.fromMm}，中间必须留出墙垛`,
      );
    }
  }
}

/** 沿轴切成一段段实体材料。零长段（洞口压在墙端）跳过，不产空壳。 */
export function piecesFromSpans(
  wallId: EntityId,
  lengthMm: number,
  spans: readonly OpeningSpan[],
): WallPiece[] {
  assertSpansFit(wallId, lengthMm, spans);
  const pieces: WallPiece[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.fromMm > cursor) pieces.push({ wallId, fromMm: cursor, toMm: span.fromMm });
    cursor = span.toMm;
  }
  if (cursor < lengthMm) pieces.push({ wallId, fromMm: cursor, toMm: lengthMm });
  return pieces;
}
```

- [ ] **Step 4: 给 `geom/outline.ts` 补整层入口**

在 `outline.ts` 顶部补三条 import（`mustExist` 走 `model/read`，别在 geom 里再写一份中文文案）：

```ts
import { mustExist } from '../model/read';
import { openingSpans, piecesFromSpans, type WallPiece } from './opening';
```

文件末尾追加：

```ts
/**
 * 一层的完整派生几何 —— 计划 3 的 2D 视图、计划 9 的空间索引都只吃这一个出口。
 * pieces 是"沿轴区间"，不是多边形：把墙垛再切成梯形属计划 5（图纸要画断开的材料），
 * 这里保持与真源同构，避免第二份几何。
 */
export interface StoreyGeometry {
  readonly storeyId: EntityId;
  readonly walls: readonly WallQuad[];
  readonly joints: readonly Joint[];
  readonly pieces: readonly WallPiece[];
}

export function deriveStoreyGeometry(doc: Document, storeyId: EntityId): StoreyGeometry {
  mustExist(doc, storeyId, '楼层');
  const walls = doc.byKind('wall').filter((wall) => wall.storeyId === storeyId);
  const ids = new Set(walls.map((wall) => wall.id));
  // 接头表整体派生一次：斜切量是全局性质（同一点上所有墙端一起算），不能按层各算各的
  const allJoints = deriveJoints(doc);
  const joints = allJoints.filter((j) => j.members.every((m) => ids.has(m.wallId)));
  const endsSeen = new Map<EntityId, number>();
  for (const joint of joints) {
    for (const m of joint.members) endsSeen.set(m.wallId, (endsSeen.get(m.wallId) ?? 0) + 1);
  }
  // 每面本层墙必须在接头表里出现两次（两端各一次）。少一次 = 某端的接头被别层墙共享，
  // 于是被上面的 filter 丢掉 —— 斜切量会静默消失，墙画出缝来。Task 3 的 resolvePointRef
  // 挡着命令层，但 Document 不校验引用完整性，这里必须自己发现。
  for (const wall of walls) {
    if ((endsSeen.get(wall.id) ?? 0) !== 2) {
      throw new RangeError(
        `墙 ${wall.id} 的某个端点接头不在本层（楼层 ${storeyId}）：` +
          `存在跨楼层共享端点，派生会静默丢掉斜切量`,
      );
    }
  }
  // Task 5 回填 O1：这里必须喂**未过滤的** allJoints，按层裁剪发生在返回值上。
  // 误传上面那张 joints（filter 过的）在单楼层 fixture 上完全隐形（filter 是 no-op），
  // 多楼层才抛 /接头表里找不到墙/；若传"按成员删过但骨架还在"的表，更坏：成员数一变
  // kindOf 就把 cross 降级成 tee、tee 降级成 corner，斜切量静默算错而一条异常都不抛。
  // 另：joints 非空时 deriveJoints 不跑，assertNoSameRay / requireEqualThrough / star 抛错 /
  // assertNoFlip 四道守卫随之缺席 —— 所以这张表只能来自同一个 doc 的同一次 deriveJoints。
  const quads = deriveWallQuads(doc, allJoints).filter((q) => ids.has(q.wallId));
  const pieces = walls.flatMap((wall) =>
    piecesFromSpans(wall.id, wallAxis(doc, wall).lengthMm, openingSpans(doc, wall)),
  );
  return { storeyId, walls: quads, joints, pieces };
}
```

`packages/core/src/index.ts` 在 `export * from './geom/outline';` 之后加：

```ts
export * from './geom/opening';
```

- [ ] **Step 5: 跑测试确认全绿**

```bash
pnpm typecheck 2>&1 | tail -5
pnpm vitest run packages/core/test/opening-geom.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
pnpm verify 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -5
```

Expected: `opening-geom.test.ts` 12 passed（分段 9 + 整层 3）。`pnpm verify` = 169 + 12 = 181 passed，0 失败。

- [ ] **Step 6: 变异检查（防"测试考的是空气"）**

1. 删掉 `piecesFromSpans` 首行的 `assertSpansFit(...)` → **实测红 3**（Task 6 回填：原只预言 2 条 —— 漏了「斜墙按浮点轴长判定」，它同样经 `piecesFromSpans` 走校验）。这证明校验真的在建段之前跑，不是靠调用方自觉。
2. 零长段判据 `span.fromMm > cursor` 改成 `>=` → **实测红 2**：「门洞贴墙起点」＋「斜墙按浮点轴长判定」（原预言只写了第一条；斜墙那条在断言行 `:137` 红，机制同属"该不该产零长段"的判据被动过）。
3. `assertSpansFit` 的 `cur.fromMm <= prev.toMm` 改成 `<` → Expected: 「两洞之间必须留墙垛」红，而该用例里的 1mm 正对照仍绿。少了正对照，这条变异可以被"改成恒抛"蒙混过去。
4. `s.toMm > lengthMm` 改成 `>=` → Expected: 「正好收在墙尾合法」红。这盯的是浮点轴长上的开闭区间，不是随手写的比较。
5. 删掉 `deriveStoreyGeometry` 里 `endsSeen !== 2` 的循环 → **实测红 1**：「跨楼层共享端点」（评审 R1 用 `!== 2` → `> 2` 等价地复现，其余 11 绿）。这条守卫只在病态文档下起作用，所以必须有一条专门造病的用例 —— 病怎么造见上面 D2：`fake` 必须是 `w1` 的**替身**而不是第三面墙，否则 `assertNoSameRay` 先抛，本层的守卫根本走不到。
6. 删掉 `openingSpans` 末尾的 `.sort(...)` → **实测红 2**：「按 fromMm 升序」**恒红**（设计性覆盖全在这里），另有「两洞之间必须留墙垛」在随机 id 下约 75% 连带红 —— 那是表乱序先撞 `/升序/` 内部错误的机制副红，**不是设计出来的钉子**，别把它当覆盖写进日志。
7. （Task 6 回填补）**反转排序的 tie 分支**（`a.openingId < b.openingId` 改成 `>`）→ 原夹具下 **0 红、12 全绿**（评审 R10）：没有任何两条洞口共享 `distanceMm`，那个分支一次都走不到。已在排序用例里补第三个同距洞（`uuidv7(3)`），现在反转即红（控制器实测 `1 failed | 11 passed`）。**这条是"平距样本"的通用地雷**：凡断言"按 A 排、A 相等时按 B 排"的排序契约，夹具里就必须真的存在 A 相等的两条 —— 否则第二个键是死代码。

每处改完还原，`git diff` 必须为空。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/geom/opening.ts packages/core/src/geom/outline.ts packages/core/test/opening-geom.test.ts packages/core/src/index.ts
git commit -m "feat: 洞口沿墙定位、墙身分段与整层派生入口"
```

执行日志写在这里：12 条的实际结果、六处变异各红了哪些用例、斜墙 1414/1415 那条的浮点轴长实测值，以及"1mm 墙垛"正对照是否真的产出了宽度为 1 的中间段。

#### Task 6 执行回填（2026-09-26，评审后）

交付：`geom/opening.ts`（新建 100 行：`openingSpans` / `assertSpansFit` / `piecesFromSpans`）、`geom/outline.ts` +49（`deriveStoreyGeometry`）、`index.ts` +1、`test/opening-geom.test.ts`（新建 269 行 / 12 条 = 分段 9 + 整层 3）。提交 `ea055bc`，控制器核对 numstat 只有这四个文件；`pnpm verify` = **181 passed / 17 files**（169 + 12），控制器与评审各自复跑。评审 `task-6-review.md`：**SPEC COMPLIANT / QUALITY APPROVED**，0 Critical / 1 Important / 4 Minor；评审施加 R1–R10 十处变异，逐条 `git checkout --` 还原，结尾 `git status --porcelain` 空。

**简报的三处缺陷（落地已按最小改法处理，计划正文同步改掉）**：

- **D1**：Step 2 的 `Expected: does not provide an export named` 与实测 `TypeError: openingSpans is not a function` 不符 —— 与 Task 5 的 D2 同一个原因，已就地改文（不再要求后人去期待一个不会出现的消息形态）。
- **D2（跨层夹具会先撞上游的守卫）**：简报原文在同一文档里同时留下 `fake` 与 `w1`，而两者只换起点、`endId` 是同一个点 ⇒ 它们的 end 端**从同一点朝同一方向离开** ⇒ `joint.ts` 的 `assertNoSameRay` 在 `deriveJoints` 阶段就先抛「同向重叠」，本层那条 `endsSeen !== 2` 守卫根本走不到。落地改法是让 `fake` 成为 `w1` 的**替身**（`entities.delete(w1.id); entities.set(fake.id, fake)`），断言与实现一行未动。评审独立验三件事：① 替身后该点只剩 w0.start 与 fake.start 两个成员，方向 `(1,0)` 与 `(0,1)` 不平行、分属两桶，`assertNoSameRay` 桶内比较无从命中，于是流程真走到层守卫；② `grep 接头不在本层` 全仓唯一产地就是 `outline.ts:90`，所以红不可能来自别处；③ 变异 R1（`!== 2` → `> 2`，对该夹具等价于删掉循环）**恰好红这一条**，其余 11 绿 ⇒ 守卫有牙。**这条要记住**：写"派生层自己发现病态文档"的用例时，得先确认它不会先被上游派生的守卫拦下 —— 否则用例红在别的病上，测的其实是空气。
- **D3（排序用例的预言靠运气）**：简报写 `expect(far.id < near.id)`，而 `uuidv7` 的 rand_a 是同毫秒内的随机位 ⇒ 实现者三次连跑红过一次（并且 M6 到底生不生效全看这一掷）。落地改法是给测试 helper `addOpening` 加一个**只存在于测试里**的可选 `id`，排序用例改用 `uuidv7(1)/(2)`：前 48 位是毫秒时间戳、写在 bytes[0..5] 的最前面，字典序在前 12 个 hex 位就见分晓，**早于一切随机位** ⇒ 有序性由构造成立。评审补了两点：这条测的仍然是 `openingSpans` 的排序契约（文档 id 升序 = [far, near]，期望 [near, far] 恰与 id 序反向，只有按 `fromMm` 排才能得到），且删 `.sort` 的变异 R2 让该用例**恒红**；其余 11 条不传 `id` ⇒ 行为与原状逐字相同。

**变异的实际红集合与简报预言的差（都是简报级"预期写漏"，测试与实现都没错）**：M1（删 `piecesFromSpans` 首行的 `assertSpansFit`）实测红 **3** 条（简报只预言 2 —— 漏了「斜墙按浮点轴长判定」，它也经 `piecesFromSpans` 走校验）；M2（`fromMm > cursor` → `>=`）实测红 **2** 条（同样漏了斜墙那条）。其余 M3/M4/M5 与简报一致，评审复现全表。另有一条简报没列的**运气红**要记：M6（删排序）会让「两洞之间必须留墙垛」那条也红，但那是随机 id 下表乱序先撞 `/升序/` 内部错误的机制副红（约 75% 命中），设计性覆盖全在排序那条 —— 报告自己把它标成"运气、不是设计出来的钉"，评审认可。

**O1 销账（Task 5 留下的义务，本任务清偿）**：评审复现 R4（`deriveWallQuads` 忽略入参 ⇒ `opening-geom` 的「整层派生」`:212` 红，而 `outline.test.ts` 13 条仍全绿，Task 5 的失明被这两条新断言补上）；又自有 R5（把 `allJoints` 误传成过滤过的 `joints` ⇒ **两条红**：整层派生在 `memberTrim` 抛 `/接头表里找不到墙/`、空楼层因过滤表为 `[]` 而 `[] ?? deriveJoints` 不兜底）⇒ **"必须喂未过滤 allJoints"这半也有红点背书**。

**F1（Important，本任务不修，交 Task 7 + Task 10）**：`assertSpansFit` 的界内判据是 `span.fromMm < 0 || span.toMm > lengthMm`，**不检查区间朝向**；而真源的 `Document.validate` 只查 `distanceMm/widthMm` 是整数、不查正负 ⇒ `widthMm ≤ 0` 是"真源合法"的反序 span。单 span 时两道循环全过，`piecesFromSpans` 产出 `[0, from]` 与 `[to, length]` 两段**物理重叠**的墙，而 `Σ段长 + Σ洞口宽 = 轴长` 照样精确成立（wall 3600、span `[500,100]` ⇒ 段 500+3500、span −400、和恰 3600）。**后果：只断言 Σ 恒等式的属性测试可以在真源带着重叠材料时全绿。** 这条与本计划反复出现的"Σ 类恒等式失明"是同一个家族（Task 4 的接缝闭合、Task 5 的 Σ 面积、这里的 Σ 段长），所以修在写入层而不是靠属性兜。

**评审验真、值得留下的两条口径**：① `deriveStoreyGeometry` 零回写 —— 只读 `mustExist/byKind/deriveJoints/deriveWallQuads/piecesFromSpans`，全部返回新数组，`Document` 唯一的改法 `replaceEntities` 在本文件从未被调用；② 浮点不外泄 —— `opening.ts` 根本不产 `Vec2`（纯沿轴标量），浮点轴长只活在 `OpeningSpan`/`WallPiece` 这两个 geom 层接口里，从不流入 `Mm` 类型的实体字段，因此无需 `quantizeMm`；`NaN` 经 `wallAxis.lengthMm` 不可达（整数点 + `hypot` 有限 + 零长墙先抛），只有调用方自己把 NaN 塞进 `lengthMm` 才会让界内与尾段判据双双失明。

**下游义务（Task 7 / 8 / 9 / 10 的简报必须带上）**

- **T7（必须做，含 F1 的修法）**：`openingCreate` / `openingMove` 要 ① 拒绝 `widthMm < 1`（把 F1 的静默通道堵在写入层）；② 自跑跨层检查（`assertSpansFit` **不看楼层**，跨层只存在于 `openingSpans` 的 `TypeError` 里）；③ 界内比较用**浮点轴长** `wallAxis(doc, wall).lengthMm`，`lengthMm` 参数只准来自 `wallAxis`，禁止外部拼 NaN；④ 候选表必须**按 `fromMm` 重排后**再喂 `assertSpansFit`，不许把候选追加在表尾 —— 那会撞上"入参必须升序（内部错误）"那条文案，把内部错误当用户错误抛出去。边界是**刻意的**：贴边 `<=` 判非法、墙尾 `>` 齐平判合法（R6/R7 各钉一头），不许"顺手"统一成 `<`/`>=`。
- **T8**：接头过滤口径是"成员全在本层"。若将来引入合法跨层共享点，`endsSeen !== 2` 会在**两层都**抛（Task 6 的替身夹具正是这样）——届时改口径本身，不得放宽断言。
- **T9**：`deriveStoreyGeometry` 每次调用都全档 `deriveJoints` + 全档 `deriveWallQuads` 且每墙两次 `wallAxis`，它是**视图入口**；建索引请按条目用 `openingSpans` / `wallQuad` / `memberTrim`，并先把洞口按 `hostWallId` 建索引（`openingSpans` 是 O(openings)/墙）。若缓存接头表，必须补回四道缺席守卫（`assertNoSameRay` / `requireEqualThrough` / star 抛错 / `assertNoFlip`）。
- **T10**：生成器用**上下界**排除病态输入而不用 `filter`：`widthMm ≥ 1`、`distanceMm ≥ 0`、`distanceMm + widthMm ≤ 浮点轴长`、`opening.storeyId ≡ 宿主墙.storeyId` 进构造期、同一 point id 不得被两层墙引用。属性预言：Σ 恒等式**之外必须另断**逐段两两不重叠且段在 `[0, 轴长]` 内（F1 的静默通道）；浮点比较一律 `toBeCloseTo`（实例：`Math.hypot(1000,1000)` 与 `Math.SQRT2*1000` 差 1 ULP）；样本数写死。
- **T10｜tie-break 的确定性**：同距离双洞 ⇒ 结果按 id 升序且两次调用全等。Task 6 已在排序用例里补了平距第三洞（评审 R10 原本把比较号整个反转都测不出，补完后反转比较号即红，控制器实测 `1 failed | 11 passed`）。
- **计划文本另两处同步修正**：`assertSpansFit` 的"入参升序"内部错误分支可达性 = `piecesFromSpans`/`assertSpansFit` 是公开出口、Task 7 手拼表即撞；派生链自产表永不触发（触发即调用方 bug，文案与行为相配）。

**留给后续任务的钩子**：`assertSpansFit` 是 Task 7 三条洞口命令的写入前校验；`openingSpans` / `wallQuad` / `memberTrim` 这一批原语是 Task 9 索引的取料口（索引按条目取，不整层调 `deriveStoreyGeometry`，理由写在 Task 9 开头）。谁都不许绕开这批原语另写一套。**Task 7 开工前先读上面 T7 那条**：`assertSpansFit` 既不查楼层（跨层只在 `openingSpans` 的 `TypeError` 里）、也不查区间朝向（`widthMm ≤ 0` 在真源合法，会让 Σ 段长恒等式带着重叠材料全绿），这两样都得由命令层补，且候选表要重排后再喂它。

---

### Task 7: `opening.*` 命令与"拉伸墙时洞口跟随"

计划 1 到今天为止，洞口只能靠测试里手搓实体进真源。本任务给它一条正经的写入路径，并收掉 Task 3 留在末尾的那条钩子：拖墙时宿主洞口被挤出墙外，命令层现在必须有反应。

三条口径，本任务的测试照着它们写：

1. **写入校验 = 派生校验，同一份代码**。命令层不复述区间规则。做法是"把候选实体贴到一张草稿文档上，跑 Task 6 的分段派生"：派生算得出来的东西才允许进真源。`applyPatch` 是纯函数、不改传入的 doc，所以这张草稿是免费的。规则一旦写两遍，两遍一定会漂，而漂掉的永远是没人看的那一遍。
2. **派生抓不到的三条规则在命令层补**：宽度与高度必须为正（零宽洞口的区间 `[1000, 1000]` 能干净地骗过 `assertSpansFit`，用例 11 把这条反证写进了测试）、门洞窗台必须为 0、洞口顶标高不得超过宿主墙高（竖向约束在真源里第一次出现）。
3. **洞口跟随拉伸只减 `distanceMm`，绝不动 `widthMm`**。一樘 900 宽的门就是 900，静默改窄比报错危险。能夹回来就夹；新墙比洞口还短、夹不下，就抛错让用户先动洞口。

**为什么 `affected` 必须带上被夹的洞口**：Task 9 的索引按 `affected` 局部重建。拖一次拐角，补丁里如果只有那个点，被改了距离的洞口在网格里仍是旧位置，命中测试会指到空气。反过来，"每次都把所有洞口塞进补丁"也不行 —— 那样 `affected` 再也不能说明"这次真的改了什么"，所以用例 18 专门断言拉长墙时 `affected` 只有那个点。

**Files:**
- Create: `packages/core/src/commands/opening.ts`
- Modify: `packages/core/src/commands/wall.ts`（整段替换 Task 3 的 `wallMoveEndpoint`，新增私有 `clampOpeningsToWall`）
- Create: `packages/core/test/commands-opening.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes：Task 6 的 `assertSpansFit` / `openingSpans` / `openingCreate` 要用的 `OpeningSpan`；Task 2 的 `wallAxis` / `requireWall` / `mustExist`；Task 3 的 `incidentWallEnds` / `endPointId` / `otherEnd`；计划 1 的 `applyPatch` / `assertMm` / `quantizeMm` / `OpeningEntity`
- Produces：`OpeningCreateInput`、`openingCreate(input): Command`、`openingMove({ openingId, distanceMm }): Command`、`openingDelete({ openingId }): Command`；改写的 `wallMoveEndpoint`（签名不变，`affected` 语义扩展为"点 + 被夹的洞口"）

**校验分工**（谁把关、什么文案，后续任务与计划 3 的 UI 照这张表接）：

| 规则 | 把关处 | 文案正则 |
|---|---|---|
| 四个长度字段是整数毫米 | `openingCreate` / `openingMove` 构造期（工厂函数自己抛）。**用例必须断工厂、不能只断 dispatch**：只断 dispatch 的话 `Document.validate` 的整数检查会替 `assertMm` 挡下来，两条消息又都含"整数毫米"，摘掉 `assertMm` 照样全绿（Task 7 修复轮 F4，实测） | `/整数毫米/` |
| 宽度、高度为正 | `openingCreate` 构造期 `positiveMm`；`openingMove` 在 `build` 里复核真源里已有的宽高（T7①：读盘/手搓进来的零宽洞口不能由命令层盖章搬走）。守卫**不放**在 `requireOpening` 里 —— 那里同时服务 `openingDelete`，放上去坏数据就永远删不掉了（Task 7 修复轮 F1） | `/洞口宽度必须为正/`、`/洞口高度必须为正/` |
| 窗台非负、门洞窗台为 0 | 构造期 | `/窗台高不能为负/`、`/门洞窗台高必须为 0/` |
| 沿轴不越界（含负距离） | `assertSpansFit`（经草稿文档跑派生） | `/超出宿主墙/` |
| 洞口互不重叠、不贴边 | 同上 | `/重叠或贴边/` |
| 洞口与宿主墙同层 | `openingSpans`（同上） | `/两者必须同层/` |
| `sillMm + heightMm ≤` 宿主墙高 | `assertFitsAfterInsert` | `/超过宿主墙高/` |
| 拉伸后端点引用与轴长合法 | Task 3 的 `wallMoveEndpoint` 守卫 | `/变成零长/`、`/不小于轴长/` |
| 拉伸后洞口仍住在宿主墙里 | `clampOpeningsToWall` | `/放不下洞口/`、`/重叠或贴边/` |

"同层"那条从写入侧其实造不出来（`openingCreate` 的 `storeyId` 抄宿主墙，不是入参），留着是给手搓文档和计划 4 之后从磁盘读回来的旧数据兜底。

> **Task 7 回填：下面 Step 1/2 的测试代码块与落地态有 7 处不同，Step 7 的变异预言有 3 处错、还漏了 5 个靶子。照抄前先读本文末尾的「Task 7 执行回填」。**

- [ ] **Step 1: 写失败的测试（第 1 段：fixtures 与 `openingCreate`）**

`packages/core/test/commands-opening.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  applyPatch,
  deriveStoreyGeometry,
  openingCreate,
  openingDelete,
  openingMove,
  openingSpans,
  piecesFromSpans,
  storeyCreate,
  uuidv7,
  wallAxisById,
  wallCreate,
  wallDelete,
  wallMoveEndpoint,
  type OpeningEntity,
  type WallCreateInput,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();

function buildLog(): TransactionLog {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  return log;
}

function storey0(log: TransactionLog): string {
  const hit = log.document.byKind('storey').find((s) => s.index === 0);
  if (!hit) throw new Error('测试找不到楼层');
  return hit.id;
}

/** 新建的墙/洞口一律从 affected 里取：同毫秒的 uuidv7 不保证有序，byKind 下标是掷硬币。 */
function lastWall(log: TransactionLog): WallEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建墙');
}

function lastOpening(log: TransactionLog): OpeningEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'opening') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建洞口');
}

function addWall(log: TransactionLog, spec: Omit<WallCreateInput, 'storeyId' | 'heightMm'>): WallEntity {
  log.dispatch(wallCreate({ storeyId: storey0(log), heightMm: 3000, ...spec }));
  return lastWall(log);
}

type OpeningSpec = {
  distanceMm: number;
  widthMm: number;
  heightMm: number;
  sillMm?: number;
  category?: 'door' | 'window';
};

/** category 给默认值 'window'：spec 里省略它时，OpeningCreateInput 的必填字段才不会缺。 */
function addOpening(log: TransactionLog, wall: WallEntity, spec: OpeningSpec): OpeningEntity {
  log.dispatch(openingCreate({ hostWallId: wall.id, category: 'window', ...spec }));
  return lastOpening(log);
}

/** 一面 3600×240 的墙，墙高 3000，独占一个文档（depth 建完是 2）。 */
function oneWall(): { log: TransactionLog; wall: WallEntity } {
  const log = buildLog();
  const wall = addWall(log, {
    start: { x: 0, y: 0 },
    end: { x: 3600, y: 0 },
    thicknessMm: 240,
  });
  return { log, wall };
}

/** 拐角在 (3600, 0)：A 水平 3600 长，B 竖直 2400 长，共享那个点。 */
function lCorner(): { log: TransactionLog; sharedId: string; first: WallEntity; second: WallEntity } {
  const log = buildLog();
  const first = addWall(log, {
    start: { x: 0, y: 0 },
    end: { x: 3600, y: 0 },
    thicknessMm: 240,
  });
  const sharedId = first.endId;
  const second = addWall(log, {
    start: { pointId: sharedId },
    end: { x: 3600, y: 2400 },
    thicknessMm: 240,
  });
  return { log, sharedId, first, second };
}

describe('openingCreate', () => {
  it('建门洞：窗台默认 0，楼层抄宿主墙，affected 只有新洞口', () => {
    const { log, wall } = oneWall();
    const depth = log.depth;
    log.dispatch(
      openingCreate({
        hostWallId: wall.id,
        distanceMm: 0,
        widthMm: 900,
        heightMm: 2100,
        category: 'door',
      }),
    );
    const made = lastOpening(log);
    expect(made.sillMm).toBe(0);
    expect(made.storeyId).toBe(wall.storeyId);
    expect(made.hostWallId).toBe(wall.id);
    expect(log.affected).toEqual(new Set([made.id]));
    expect(log.depth).toBe(depth + 1);
  });

  it('建窗洞：窗台默认 900，且默认值自己过得了竖向守卫', () => {
    const { log, wall } = oneWall();
    log.dispatch(
      openingCreate({
        hostWallId: wall.id,
        distanceMm: 600,
        widthMm: 1500,
        heightMm: 1500,
        category: 'window',
      }),
    );
    expect(lastOpening(log).sillMm).toBe(900);
    // 900 + 1500 = 2400 ≤ 3000。默认值要是越了界，等于每次建窗都得先撞一次错。
    expect(() => deriveStoreyGeometry(log.document, wall.storeyId)).not.toThrow();
  });

  it('显式 sillMm 覆盖默认值', () => {
    const { log, wall } = oneWall();
    log.dispatch(
      openingCreate({
        hostWallId: wall.id,
        distanceMm: 600,
        widthMm: 1500,
        heightMm: 1500,
        sillMm: 400,
        category: 'window',
      }),
    );
    expect(lastOpening(log).sillMm).toBe(400);
  });

  it('门洞窗台非 0 → 构造期就抛，日志一步没走', () => {
    const { log, wall } = oneWall();
    const before = log.document.canonical();
    expect(() =>
      log.dispatch(
        openingCreate({
          hostWallId: wall.id,
          distanceMm: 0,
          widthMm: 900,
          heightMm: 2100,
          sillMm: 100,
          category: 'door',
        }),
      ),
    ).toThrow(/门洞窗台高必须为 0/);
    expect(log.document.canonical()).toBe(before);
    expect(log.depth).toBe(2);
    // 正对照：同一批参数把 sillMm 拿掉就建得成 —— 抛错是因为窗台，不是因为别的
    log.dispatch(
      openingCreate({
        hostWallId: wall.id,
        distanceMm: 0,
        widthMm: 900,
        heightMm: 2100,
        category: 'door',
      }),
    );
    expect(log.depth).toBe(3);
  });

  it('窗台为负 / 洞口顶超过宿主墙高 → 抛；正好等于墙高合法（正对照）', () => {
    const { log, wall } = oneWall();
    expect(() =>
      log.dispatch(
        openingCreate({
          hostWallId: wall.id,
          distanceMm: 0,
          widthMm: 900,
          heightMm: 1500,
          sillMm: -100,
          category: 'window',
        }),
      ),
    ).toThrow(/窗台高不能为负/);
    expect(() =>
      log.dispatch(
        openingCreate({
          hostWallId: wall.id,
          distanceMm: 0,
          widthMm: 900,
          heightMm: 2200,
          sillMm: 900,
          category: 'window',
        }),
      ),
    ).toThrow(/超过宿主墙高/);
    // 900 + 2100 = 3000 = 墙高：判据是 > 不是 >=，这条放行才说明顶部齐平可画
    log.dispatch(
      openingCreate({
        hostWallId: wall.id,
        distanceMm: 0,
        widthMm: 900,
        heightMm: 2100,
        sillMm: 900,
        category: 'window',
      }),
    );
    expect(lastOpening(log).heightMm).toBe(2100);
  });

  it('越出墙尾 → /超出宿主墙/；正好收在墙尾合法（正对照）', () => {
    const { log, wall } = oneWall();
    expect(() =>
      log.dispatch(
        openingCreate({
          hostWallId: wall.id,
          distanceMm: 2800,
          widthMm: 900,
          heightMm: 2100,
          category: 'door',
        }),
      ),
    ).toThrow(/超出宿主墙/);
    log.dispatch(
      openingCreate({
        hostWallId: wall.id,
        distanceMm: 2700,
        widthMm: 900,
        heightMm: 2100,
        category: 'door',
      }),
    );
    expect(lastOpening(log).distanceMm).toBe(2700);
  });

  it('与已有洞口重叠或贴边 → 抛；中间留 1mm 合法（正对照）', () => {
    const { log, wall } = oneWall();
    addOpening(log, wall, { distanceMm: 900, widthMm: 900, heightMm: 2100, category: 'door' });
    expect(() =>
      log.dispatch(
        openingCreate({
          hostWallId: wall.id,
          distanceMm: 1800,
          widthMm: 900,
          heightMm: 2100,
          category: 'door',
        }),
      ),
    ).toThrow(/重叠或贴边/);
    log.dispatch(
      openingCreate({
        hostWallId: wall.id,
        distanceMm: 1801,
        widthMm: 900,
        heightMm: 2100,
        category: 'door',
      }),
    );
    expect(openingSpans(log.document, wall)).toHaveLength(2);
  });

  it('负距离由派生那条判据兜住：命令层不另写一份区间规则', () => {
    const { log, wall } = oneWall();
    expect(() =>
      log.dispatch(
        openingCreate({
          hostWallId: wall.id,
          distanceMm: -100,
          widthMm: 900,
          heightMm: 2100,
          category: 'door',
        }),
      ),
    ).toThrow(/超出宿主墙/);
  });

  it('宿主墙不存在 → /不存在/；宿主指向点或墙自己 → /不是墙/', () => {
    const { log, wall } = oneWall();
    const spec = { distanceMm: 0, widthMm: 900, heightMm: 2100, category: 'door' as const };
    expect(() => log.dispatch(openingCreate({ hostWallId: uuidv7(), ...spec }))).toThrow(/不存在/);
    expect(() => log.dispatch(openingCreate({ hostWallId: wall.startId, ...spec }))).toThrow(/不是墙/);
  });

  it('宽度或高度为 0 → 抛；反证：零宽洞口确实骗得过派生层', () => {
    const { log, wall } = oneWall();
    expect(() =>
      log.dispatch(
        openingCreate({
          hostWallId: wall.id,
          distanceMm: 1000,
          widthMm: 0,
          heightMm: 2100,
          category: 'door',
        }),
      ),
    ).toThrow(/洞口宽度必须为正/);
    expect(() =>
      log.dispatch(
        openingCreate({
          hostWallId: wall.id,
          distanceMm: 1000,
          widthMm: 900,
          heightMm: 0,
          category: 'door',
        }),
      ),
    ).toThrow(/洞口高度必须为正/);
    // 反证（不是多余检查）：绕过命令直接贴一条零宽进文档，派生层一声不吭。
    // 删掉 positiveMm 的话上面两条红，这条仍绿 —— 三条一起看才知道构造期那道守卫非有不可。
    const hacked = applyPatch(log.document, {
      upsert: [
        {
          kind: 'opening',
          id: uuidv7(),
          storeyId: wall.storeyId,
          hostWallId: wall.id,
          distanceMm: 1000,
          widthMm: 0,
          heightMm: 2100,
          sillMm: 0,
          category: 'door',
        },
      ],
      remove: [],
    }).doc;
    expect(() => piecesFromSpans(wall.id, 3600, openingSpans(hacked, wall))).not.toThrow();
    expect(log.document.byKind('opening')).toEqual([]);
  });

  it('浮点入参在构造期就抛，日志一步没走', () => {
    const { log, wall } = oneWall();
    expect(() =>
      log.dispatch(
        openingCreate({
          hostWallId: wall.id,
          distanceMm: 100.5,
          widthMm: 900,
          heightMm: 2100,
          category: 'door',
        }),
      ),
    ).toThrow(/整数毫米/);
    expect(log.depth).toBe(2);
    expect(log.document.byKind('opening')).toEqual([]);
  });
});
```

- [ ] **Step 2: 写失败的测试（第 2 段：`openingMove` / `openingDelete` / 洞口跟随）**

接在同一个文件里（`describe` 平铺，不嵌套）：

```ts
describe('openingMove', () => {
  it('改距离：只有 distanceMm 变，其余字段逐字不变', () => {
    const { log, wall } = oneWall();
    const opening = addOpening(log, wall, {
      distanceMm: 600,
      widthMm: 1500,
      heightMm: 1500,
    });
    log.dispatch(openingMove({ openingId: opening.id, distanceMm: 1200 }));
    expect(log.document.get(opening.id)).toEqual({ ...opening, distanceMm: 1200 });
    expect(log.affected).toEqual(new Set([opening.id]));
  });

  it('移到与另一樘重叠 → 抛，文档一字未改', () => {
    const { log, wall } = oneWall();
    addOpening(log, wall, { distanceMm: 0, widthMm: 900, heightMm: 2100, category: 'door' });
    const b = addOpening(log, wall, {
      distanceMm: 2000,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    const before = log.document.canonical();
    // b 挪到 450：区间 [450,1350] 与 a 的 [0,900] 交叠
    expect(() => log.dispatch(openingMove({ openingId: b.id, distanceMm: 450 }))).toThrow(
      /重叠或贴边/,
    );
    expect(log.document.canonical()).toBe(before);
    expect((log.document.get(b.id) as OpeningEntity).distanceMm).toBe(2000);
  });

  it('目标不是洞口 → 抛；同一条命令换回真洞口就成功（正对照）', () => {
    const { log, wall } = oneWall();
    const opening = addOpening(log, wall, {
      distanceMm: 600,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    expect(() => log.dispatch(openingMove({ openingId: wall.startId, distanceMm: 800 }))).toThrow(
      /不是洞口/,
    );
    expect(() => log.dispatch(openingMove({ openingId: wall.id, distanceMm: 800 }))).toThrow(
      /不是洞口/,
    );
    expect(() => log.dispatch(openingMove({ openingId: uuidv7(), distanceMm: 800 }))).toThrow(
      /洞口 不存在/,
    );
    log.dispatch(openingMove({ openingId: opening.id, distanceMm: 800 }));
    expect((log.document.get(opening.id) as OpeningEntity).distanceMm).toBe(800);
  });

  it('撤销/重做移动：距离回到原值，canonical 与初始逐字节相同', () => {
    const { log, wall } = oneWall();
    const opening = addOpening(log, wall, {
      distanceMm: 600,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    const before = log.document.canonical();
    log.dispatch(openingMove({ openingId: opening.id, distanceMm: 2000 }));
    expect(log.document.canonical()).not.toBe(before);
    expect(log.undo()).toBe(true);
    expect(log.document.canonical()).toBe(before);
    expect(log.redo()).toBe(true);
    expect((log.document.get(opening.id) as OpeningEntity).distanceMm).toBe(2000);
  });
});

describe('openingDelete', () => {
  it('删除后只剩一整段；撤销后逐字节复原', () => {
    const { log, wall } = oneWall();
    const opening = addOpening(log, wall, {
      distanceMm: 1200,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    // [1200,2100] 把 3600 的墙切成 [0,1200] 与 [2100,3600]
    expect(deriveStoreyGeometry(log.document, wall.storeyId).pieces).toHaveLength(2);
    const before = log.document.canonical();
    log.dispatch(openingDelete({ openingId: opening.id }));
    expect(log.document.get(opening.id)).toBeUndefined();
    expect(deriveStoreyGeometry(log.document, wall.storeyId).pieces).toHaveLength(1);
    log.undo();
    expect(log.document.canonical()).toBe(before);
    expect(deriveStoreyGeometry(log.document, wall.storeyId).pieces).toHaveLength(2);
  });

  it('删墙连带删洞口，撤销把墙与洞口一起带回来', () => {
    const { log, wall } = oneWall();
    const opening = addOpening(log, wall, {
      distanceMm: 1200,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    const before = log.document.canonical();
    log.dispatch(wallDelete({ wallId: wall.id }));
    expect(log.document.get(opening.id)).toBeUndefined();
    expect(log.affected).toEqual(new Set([wall.id, opening.id, wall.startId, wall.endId]));
    log.undo();
    expect(log.document.canonical()).toBe(before);
  });
});

describe('洞口跟随拉伸', () => {
  it('拉长墙：洞口距离一字不改，affected 里也只有那个点（正对照）', () => {
    const { log, wall } = oneWall();
    const opening = addOpening(log, wall, {
      distanceMm: 2700,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    log.dispatch(wallMoveEndpoint({ wallId: wall.id, end: 'end', x: 4800, y: 0 }));
    expect((log.document.get(opening.id) as OpeningEntity).distanceMm).toBe(2700);
    // 没夹就不进补丁。实现若改成"每次拖动都重述全部洞口"，这条 affected 断言会红 ——
    // 那时 affected 再也不能说明"这次真的改了什么"，Task 9 的增量重建就退化成全量。
    expect(log.affected).toEqual(new Set([wall.endId]));
  });

  it('缩墙：洞口夹到 floor(新轴长 − 宽)，affected 含洞口 id', () => {
    const { log, wall } = oneWall();
    const opening = addOpening(log, wall, {
      distanceMm: 2700,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    log.dispatch(wallMoveEndpoint({ wallId: wall.id, end: 'end', x: 3000, y: 0 }));
    expect((log.document.get(opening.id) as OpeningEntity).distanceMm).toBe(2100);
    expect(log.affected).toEqual(new Set([wall.endId, opening.id]));
    expect(() => deriveStoreyGeometry(log.document, wall.storeyId)).not.toThrow();
  });

  it('斜墙按 Math.floor 而不是 round：轴长 1999.7 → 1099，不是 1100', () => {
    const log = buildLog();
    const wall = addWall(log, {
      start: { x: 0, y: 0 },
      end: { x: 2000, y: 2000 },
      thicknessMm: 240,
    });
    const opening = addOpening(log, wall, {
      distanceMm: 1900,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    // 拖动前 [1900,2800] 在 2828.4 的墙里；拖到 (1414,1414) 后轴长只剩 1999.7
    log.dispatch(wallMoveEndpoint({ wallId: wall.id, end: 'end', x: 1414, y: 1414 }));
    expect(wallAxisById(log.document, wall.id).lengthMm).toBeCloseTo(1999.698, 2);
    expect((log.document.get(opening.id) as OpeningEntity).distanceMm).toBe(1099);
    // 1100 + 900 = 2000 > 1999.698：写成 Math.round 会留下越界洞口，下面这条派生断言就红
    expect(() => deriveStoreyGeometry(log.document, wall.storeyId)).not.toThrow();
  });

  it('新墙比洞口还短 → /放不下洞口/，文档一步没走', () => {
    const { log, wall } = oneWall();
    const opening = addOpening(log, wall, {
      distanceMm: 2700,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    const before = log.document.canonical();
    // 轴长 800 > 墙厚 240，Task 3 的守卫放行；到洞口这一关才被挡下
    expect(() =>
      log.dispatch(wallMoveEndpoint({ wallId: wall.id, end: 'end', x: 800, y: 0 })),
    ).toThrow(/放不下洞口/);
    expect(() =>
      log.dispatch(wallMoveEndpoint({ wallId: wall.id, end: 'end', x: 800, y: 0 })),
    ).toThrow(opening.id);
    expect(log.document.canonical()).toBe(before);
    expect(log.depth).toBe(3);
  });

  it('往回夹会让两樘撞上 → /重叠或贴边/，绝不留下一对重叠的洞口', () => {
    const { log, wall } = oneWall();
    addOpening(log, wall, { distanceMm: 1000, widthMm: 900, heightMm: 2100, category: 'door' });
    const b = addOpening(log, wall, {
      distanceMm: 2000,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    expect(openingSpans(log.document, wall).map((s) => [s.fromMm, s.toMm])).toEqual([
      [1000, 1900],
      [2000, 2900],
    ]);
    const before = log.document.canonical();
    // 缩到 2500：a 不用动（1900 ≤ 2500），b 夹到 floor(2500−900)=1600 → [1600,2500] 撞进 a
    expect(() =>
      log.dispatch(wallMoveEndpoint({ wallId: wall.id, end: 'end', x: 2500, y: 0 })),
    ).toThrow(/重叠或贴边/);
    expect(log.document.canonical()).toBe(before);
    expect((log.document.get(b.id) as OpeningEntity).distanceMm).toBe(2000);
  });

  it('拖拐角：邻墙的洞口一起被夹到 300，本墙的洞口仍是 2000', () => {
    const { log, sharedId, first, second } = lCorner();
    const onFirst = addOpening(log, first, { distanceMm: 2000, widthMm: 900, heightMm: 1500 });
    const onSecond = addOpening(log, second, {
      distanceMm: 1400,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    // A 变长到 3794.7：窗 [2000,2900] 仍在墙内 → 一个字节都不该改
    // B 缩到 1200：门 1400 → floor(1200−900) = 300，正好收在新墙尾
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 1200 }));
    expect((log.document.get(onFirst.id) as OpeningEntity).distanceMm).toBe(2000);
    expect((log.document.get(onSecond.id) as OpeningEntity).distanceMm).toBe(300);
    expect(log.affected).toEqual(new Set([sharedId, onSecond.id]));
    expect(() => deriveStoreyGeometry(log.document, first.storeyId)).not.toThrow();
  });

  it('撤销拉伸：墙长与洞口距离一起回退，重放逐字节相同', () => {
    const { log, first, second } = lCorner();
    addOpening(log, first, { distanceMm: 2000, widthMm: 900, heightMm: 1500 });
    const door = addOpening(log, second, {
      distanceMm: 1400,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    });
    const before = log.document.canonical();
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 1200 }));
    const dragged = log.document.canonical();
    expect(dragged).not.toBe(before);
    expect((log.document.get(door.id) as OpeningEntity).distanceMm).toBe(300);
    expect(log.undo()).toBe(true);
    expect(log.document.canonical()).toBe(before);
    expect((log.document.get(door.id) as OpeningEntity).distanceMm).toBe(1400);
    expect(log.redo()).toBe(true);
    expect(log.document.canonical()).toBe(dragged);
  });
});
```

第 2 段 15 条 + 第 1 段 11 条 = 本文件 24 条，全计划总数 181 + 24 = 205。

- [ ] **Step 3: 跑测试确认失败**

```bash
pnpm vitest run packages/core/test/commands-opening.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
```

Expected: FAIL，运行期 `TypeError: openingCreate is not a function`（`openingMove` / `openingDelete` 同）。Task 7 回填：原写的 `does not provide an export named 'openingCreate'` 是错的期望，与 Task 5 的 D2、Task 6 的 D1 同因（入口是 TS 源、vitest 走 esbuild，缺失的具名导出取到 `undefined`，不在链接期抛 `SyntaxError`）。此时 `commands/opening.ts` 还不存在。

- [ ] **Step 4: 实现 `commands/opening.ts`**

```ts
import { uuidv7, type EntityId } from '../ids';
import { assertMm, type Mm } from '../units/mm';
import type { Command } from '../model/command';
import type { Document } from '../model/document';
import { applyPatch } from '../model/patch';
import type { OpeningEntity } from '../model/entity';
import { mustExist, requireWall } from '../model/read';
import { wallAxis } from '../geom/axis';
import { openingSpans, piecesFromSpans } from '../geom/opening';

export interface OpeningCreateInput {
  hostWallId: EntityId;
  /** 宿主墙起点到洞口近端的沿轴距离 */
  distanceMm: number;
  widthMm: number;
  heightMm: number;
  /** 洞底距本层楼面。省略时门取 0、窗取 900 */
  sillMm?: number;
  category: OpeningEntity['category'];
}

function positiveMm(value: Mm, label: string): Mm {
  if (value <= 0) throw new RangeError(`${label}必须为正，收到 ${value}`);
  return value;
}

function requireOpening(doc: Document, id: EntityId): OpeningEntity {
  const entity = mustExist(doc, id, '洞口');
  if (entity.kind !== 'opening') throw new TypeError(`${id} 不是洞口，是 ${entity.kind}`);
  return entity;
}

/**
 * 写入前校验 = 派生校验。把候选实体贴到一张草稿文档上跑 Task 6 的分段派生：
 * 派生算得出来的（不越界、不重叠、不贴边、同层）才允许进真源。
 * 命令层绝不复述区间规则 —— 写两遍的规则一定会漂，而漂掉的永远是没人看的那一遍。
 * applyPatch 是纯函数，不改传进来的 doc，所以这张草稿是免费的。
 */
function assertFitsAfterInsert(doc: Document, candidate: OpeningEntity): void {
  const next = applyPatch(doc, { upsert: [candidate], remove: [] }).doc;
  const wall = requireWall(next, candidate.hostWallId);
  piecesFromSpans(wall.id, wallAxis(next, wall).lengthMm, openingSpans(next, wall));
  const topMm = candidate.sillMm + candidate.heightMm;
  if (topMm > wall.heightMm) {
    throw new RangeError(
      `洞口 ${candidate.id} 顶标高 ${topMm} 超过宿主墙高 ${wall.heightMm}` +
        `（窗台 ${candidate.sillMm} + 洞口高 ${candidate.heightMm}）`,
    );
  }
}

export function openingCreate(input: OpeningCreateInput): Command {
  const distanceMm = assertMm(input.distanceMm, '洞口距离');
  // 正数这两条只能卡在构造期：零宽洞口的区间 [1000,1000] 干干净净过得了 assertSpansFit
  const widthMm = positiveMm(assertMm(input.widthMm, '洞口宽度'), '洞口宽度');
  const heightMm = positiveMm(assertMm(input.heightMm, '洞口高度'), '洞口高度');
  const sillMm =
    input.sillMm === undefined
      ? input.category === 'door'
        ? 0
        : 900
      : assertMm(input.sillMm, '窗台高');
  if (sillMm < 0) throw new RangeError(`窗台高不能为负，收到 ${sillMm}`);
  // 门的 sill 是构造期定的（门要贴地做坡度与门套），派生层只看沿轴区间，管不到竖向
  if (input.category === 'door' && sillMm !== 0) {
    throw new RangeError(`门洞窗台高必须为 0，收到 ${sillMm}`);
  }
  return {
    type: 'opening.create',
    build(doc: Document) {
      const wall = requireWall(doc, input.hostWallId);
      mustExist(doc, wall.storeyId, '楼层');
      const opening: OpeningEntity = {
        kind: 'opening',
        id: uuidv7(),
        // 楼层不是入参，抄宿主墙：洞口天生跟着墙走，
        // "洞口与宿主墙不同层"从写入侧根本造不出来。
        storeyId: wall.storeyId,
        hostWallId: wall.id,
        distanceMm,
        widthMm,
        heightMm,
        sillMm,
        category: input.category,
      };
      assertFitsAfterInsert(doc, opening);
      return { upsert: [opening], remove: [] };
    },
  };
}

export function openingMove(input: { openingId: EntityId; distanceMm: number }): Command {
  const distanceMm = assertMm(input.distanceMm, '洞口距离');
  return {
    type: 'opening.move',
    build(doc: Document) {
      const opening = requireOpening(doc, input.openingId);
      // T7① 的另一半：搬动不产生新宽度，但读盘/手搓进来的零宽洞口不能由命令层盖章搬走。
      // assertFitsAfterInsert 用的派生判据不看区间朝向（Task 6 评审 F1），这一关只能在这里补。
      // 守卫放在 move 而不是 requireOpening 里 —— 坏数据必须还能删，删除路径不许被它挡住。
      positiveMm(opening.widthMm, '洞口宽度');
      positiveMm(opening.heightMm, '洞口高度');
      const moved: OpeningEntity = { ...opening, distanceMm };
      // 同一条校验：改一樘的位置与新建一樘，允许的落点集合必须一模一样
      assertFitsAfterInsert(doc, moved);
      return { upsert: [moved], remove: [] };
    },
  };
}

export function openingDelete(input: { openingId: EntityId }): Command {
  return {
    type: 'opening.delete',
    build(doc: Document) {
      requireOpening(doc, input.openingId);
      return { upsert: [], remove: [input.openingId] };
    },
  };
}
```

`openingDelete` 不校验"删了以后派生还剩什么"：删洞口只会让墙少一个洞，永远合法。`requireOpening` 那一步是为了"删不存在的东西要抛错"，不然撤销时会出现一个凭空多出来的补丁。

- [ ] **Step 5: 改写 `commands/wall.ts` 的 `wallMoveEndpoint`**

先补 import（Task 3 已引入 `incidentWallEnds` / `endPointId` / `otherEnd`）：

```ts
import { assertSpansFit, type OpeningSpan } from '../geom/opening';
```

新增私有函数，放在 `wallMoveEndpoint` 之前：

```ts
/**
 * 该墙缩到 newLengthMm 以后，把挂在它上面的洞口沿轴往起点方向夹回来。
 * 只减 distanceMm，绝不动 widthMm —— 洞口宽度是产品尺寸，静默改窄比报错危险。
 * 夹完必须复核整表：往回夹会让两樘撞上（新墙长排不开它们），那种拖动施工上不成立。
 * 复核用 Task 6 的 assertSpansFit，不在这里重写区间规则。
 * 只有真被夹动的才进 upsert：affected 是"这次到底改了什么"的记录，
 * 每次拖动都重述全部洞口会把它稀释成噪音（用例「拉长墙」盯着这条）。
 */
function clampOpeningsToWall(
  doc: Document,
  wall: WallEntity,
  newLengthMm: number,
  upsert: Entity[],
): void {
  const final: OpeningEntity[] = [];
  const dirty: OpeningEntity[] = [];
  for (const opening of doc.byKind('opening')) {
    if (opening.hostWallId !== wall.id) continue;
    if (opening.distanceMm + opening.widthMm <= newLengthMm) {
      final.push(opening);
      continue;
    }
    // floor 不是随手写的：轴长是浮点（斜墙 1999.698），round 会舍到墙外去
    const maxDistanceMm = Math.floor(newLengthMm - opening.widthMm);
    if (maxDistanceMm < 0) {
      throw new RangeError(
        `墙 ${wall.id} 缩到 ${Math.round(newLengthMm)}mm，放不下洞口 ${opening.id}` +
          `（宽 ${opening.widthMm}）：请先改小或删掉这个洞口`,
      );
    }
    const clamped: OpeningEntity = { ...opening, distanceMm: maxDistanceMm };
    final.push(clamped);
    dirty.push(clamped);
  }
  if (dirty.length === 0) return;
  const spans: OpeningSpan[] = final
    .map((o) => ({ openingId: o.id, fromMm: o.distanceMm, toMm: o.distanceMm + o.widthMm }))
    .sort(
      (a, b) =>
        a.fromMm - b.fromMm || (a.openingId < b.openingId ? -1 : a.openingId > b.openingId ? 1 : 0),
    );
  // 这里不查楼层：洞口不是新数据，只是把真源里已有的东西重述一遍。
  // 跨层洞口的判定仍归 openingSpans，在 deriveStoreyGeometry 里守。
  assertSpansFit(wall.id, newLengthMm, spans);
  upsert.push(...dirty);
}
```

`wallMoveEndpoint` **整段替换**（签名与 Task 3 一致，只是 `build` 里多攒了一张新轴长表）：

```ts
export function wallMoveEndpoint(input: {
  wallId: EntityId;
  end: WallEnd;
  x: number;
  y: number;
}): Command {
  const x = quantizeMm(input.x);
  const y = quantizeMm(input.y);
  return {
    type: 'wall.moveEndpoint',
    build(doc: Document) {
      const wall = requireWall(doc, input.wallId);
      const moving = requirePoint(doc, endPointId(wall, input.end), '端点');
      const anchor = requirePoint(doc, endPointId(wall, otherEnd(input.end)), '另一端点');
      if (anchor.x === x && anchor.y === y) {
        throw new RangeError(`零长墙：端点移到与另一端 (${x}, ${y}) 重合`);
      }
      const selfLengthMm = Math.hypot(x - anchor.x, y - anchor.y);
      if (wall.thicknessMm >= selfLengthMm) {
        throw new RangeError(
          `移动端点会让墙 ${wall.id} 的墙厚 ${wall.thicknessMm} 不小于轴长 ${Math.round(selfLengthMm)}，轮廓会自相交`,
        );
      }
      // 端点一动，所有共享它的墙轴长都变了。逐面守卫，同时把新轴长记下来给洞口跟随用：
      // affected 只有那一个点，靠它找不到这些墙（Task 9 的扩脏闭包就是为这个存在的）。
      const resized: Array<{ wall: WallEntity; lengthMm: number }> = [
        { wall, lengthMm: selfLengthMm },
      ];
      for (const inc of incidentWallEnds(doc, moving.id, wall.id)) {
        const neighbour = requireWall(doc, inc.wallId);
        const other = requirePoint(
          doc,
          endPointId(neighbour, otherEnd(inc.end)),
          '邻墙另一端点',
        );
        if (other.x === x && other.y === y) {
          throw new RangeError(
            `移动端点会让墙 ${neighbour.id} 变成零长：它与本墙共享端点 ${moving.id}`,
          );
        }
        const lengthMm = Math.hypot(x - other.x, y - other.y);
        if (neighbour.thicknessMm >= lengthMm) {
          throw new RangeError(
            `移动端点会让墙 ${neighbour.id} 的墙厚 ${neighbour.thicknessMm} 不小于轴长 ${Math.round(lengthMm)}，轮廓会自相交`,
          );
        }
        resized.push({ wall: neighbour, lengthMm });
      }
      const upsert: Entity[] = [{ ...moving, x, y }];
      // resized 的顺序确定（本墙在前，邻墙按 byKind 的 id 升序），所以补丁逐字节可重放。
      // 各墙的洞口互不相干，顺序不影响结果，只影响 canonical() 里的字段次序。
      for (const entry of resized) {
        clampOpeningsToWall(doc, entry.wall, entry.lengthMm, upsert);
      }
      return { upsert, remove: [] };
    },
  };
}
```

`wallCreate` 与 `wallDelete` 本任务一行都不改：前者不需要知道洞口（新建的墙必然没有洞口），后者的 `stillReferenced` 早就把宿主洞口一起摘了。

- [ ] **Step 6: 导出 + 全绿**

`packages/core/src/index.ts` 在 `export * from './commands/wall';` 之后加：

```ts
export * from './commands/opening';
```

```bash
pnpm typecheck 2>&1 | tail -5
pnpm vitest run packages/core/test/commands-opening.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
pnpm verify 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -5
```

Expected: `commands-opening.test.ts` 24 passed（openingCreate 11 + move 4 + delete 2 + 跟随 7）。`pnpm verify` = 181 + 24 = 205 passed，0 失败。`lint:deps` 会检查 `commands/opening.ts → geom/opening.ts` 这条新边：包内方向，允许（守卫只管包与包）。

- [ ] **Step 7: 变异检查（防"测试考的是空气"）**

七处逐个改、逐个还原，每次 `git diff` 必须回到空：

1. 删掉 `assertFitsAfterInsert` 里 `piecesFromSpans(...)` 那一行 → Expected: 「越出墙尾」「与已有洞口重叠或贴边」「负距离」「移到与另一樘重叠」四条红，而「超过宿主墙高」仍绿。竖向那条不走派生，正因为如此它才需要单独的实现 —— 两条路各自红一半，说明校验确实分了两处、缺一不可。
2. `positiveMm` 的 `value <= 0` 改成 `value < 0` → Expected: 「宽度或高度为 0 → 抛；反证…」这一条红（`Tests 1 failed / 204 passed`，红形如 `expected [Function] to throw an error`）。Task 7 回填：原写的"前两条红、同一用例里的反证仍绿"在同一条 `it` 里**不可观测** —— 第一条断言就中止，反证那几行根本没跑；"反证常绿"这个设计意图要在两条不同的 `it` 里才看得出来。
3. `if (input.category === 'door' && sillMm !== 0)` 改成 `sillMm < 0` → Expected: 「门洞窗台非 0」红，其正对照仍绿。
4. `clampOpeningsToWall` 的 `Math.floor` 改成 `Math.round` → Expected: 「斜墙 1099」这一条红（`Tests 1 failed / 204 passed`）。这条变异只有斜墙用例抓得到，水平墙全是整数轴长。Task 7 回填：原写的"值断言与派生断言各红一次"不可能成立 —— 命令在 `dispatch` 里就抛了（栈：`assertSpansFit (geom/opening.ts:61) ← clampOpeningsToWall (commands/wall.ts:182) ← build ← dispatch ← test`），那条用例后面两行一次都没跑，所以只有**一次**红。取整这件事真正的红集合见下面第 12 条。
5. `clampOpeningsToWall` 里把"合法不动"那支也 `dirty.push(opening)` → Expected: 「拉长墙」与「拖拐角」**两条**的 `affected` 断言红（`Tests 2 failed / 203 passed`）。Task 7 回填：原写"只有「拉长墙」红"少算了一条 —— 「拖拐角」里本墙那樘窗没被夹动，它的 `affected` 断言同样盯的是"守卫会不会多动手"。
6. 注释掉 `wallMoveEndpoint` 末尾那个 `for (const entry of resized)` 循环 → Expected: 「缩墙」「斜墙」「放不下洞口」「夹完撞上」「拖拐角」「撤销拉伸」六条红，「拉长墙」仍绿（它验的就是没改动的情况）。六比一，说明跟随逻辑真的在承重。
7. 删掉 `clampOpeningsToWall` 末尾的 `assertSpansFit(...)` → Expected: 只有「夹完撞上」红。这条守卫只在"缩墙后排不开两樘"时起作用，不专门造病就永远不红。

Task 7 修复轮补的五个靶子（评审 5 条 Important 里 F1–F4/F6 各对应一个"修复前 205 全绿"的盲区；`ca21447`）。**这五条是本轮真正的产出**：前七条盯的是"守卫会不会不动手"，这几条盯的是"新守卫的边界有没有人看着"。

8. `openingMove` 的 `build` 里摘掉两条 `positiveMm` → Expected: 「宽度或高度为 0 → 抛；反证…」红（`expected [Function] to throw an error`）。修复前 205 全绿：一条零宽洞口能被搬动并盖章，`deriveStoreyGeometry` 交出 `[[+0,300],[-700,3600]]` —— 3600 的墙上长出 4300 的料并与另一段物理重叠，而 `Σ段长 + Σ洞宽 = 轴长` 照样精确成立（本计划第三个"Σ 类恒等式失明"）。
9. `wall.ts` 的 `if (opening.distanceMm + opening.widthMm <= newLengthMm)` 改成 `<` → Expected: 「缩墙」红（`affected` 凭空多一个洞口 id，而它的 `distanceMm` 一个字节没变）。修复前 205 全绿，且这**不是等价变异**。
10. `openingMove` 的 `assertMm(input.distanceMm, …)` 换成裸赋值 → Expected: 「浮点入参在构造期就抛」红。**坑在这里**：如果那条断言写成 `expect(() => log.dispatch(openingMove({…100.5}))).toThrow(/整数毫米/)`，摘掉 `assertMm` 之后仍然 24 全绿 —— `Document.validate` 的整数检查会替它挡下来，两条消息又都含"整数毫米"。必须断**工厂函数自己**抛（`expect(() => openingMove({…})).toThrow(/整数毫米/)`），四个字段一样各来一次（第 11 条）。
11. `openingCreate` 的 `assertMm` 同样换成裸赋值 → Expected: 同一条用例红（`Tests 1 failed / 23 passed`）。修复前简报从未预言，实测 205 全绿。
12. 夹洞写回的 `Math.floor(newLengthMm - opening.widthMm)` 去掉取整 → Expected: 「斜墙」「新墙比洞口还短…夹到 0 的边界两支」「撤销拉伸：一次拖拽夹两樘」**三条**红（`Tests 3 failed / 21 passed`）。这条是"绕过 `quantizeMm` 写回真源"的唯一落点，浮点一旦漏进去，`Document.validate` 在 `dispatch` 里就抛。
13. 夹洞表摘掉 `.sort` → Expected: 「往回夹会让两樘撞上」**恒红**（连跑 5 次 5 次红，形如 `expected [Function] to throw error matching /重叠或贴边/ but got 'assertSpansFit 需要按 fromMm 升序的洞口表（内部错误）'`）。修复前是 8 次跑红 5 次 —— 那条用例的两樘洞口用随机 id，"id 序恰与几何序反向"全凭运气。修法是把夹具换成钉死的时间戳（`uuidv7(2)@1000` + `uuidv7(1)@2000`）并加一条 `expect(far.id < near.id).toBe(true)` 守卫夹具本身；**别把这条推给 Task 10 的属性测试**，属性测试只能提高命中率，不能让它不可能漏（失效模式是把合法拖法判成内部错误，Task 9 的索引正建在这条之上）。

- [ ] **Step 8: 提交**

```bash
git add packages/core/src/commands/opening.ts packages/core/src/commands/wall.ts packages/core/test/commands-opening.test.ts packages/core/src/index.ts
git commit -m "feat: 洞口命令与拉伸墙时洞口跟随"
```

执行日志写在这里：24 条的实际结果、七处变异各红了哪些用例、斜墙那条实测的 `lengthMm` 与 `distanceMm`，以及「拖拐角」里 `affected` 到底是不是恰好两个 id。

**留给后续任务的钩子**：`resized` 这张表就是 Task 9 的 `expandAffected` 要自己算出来的东西 —— 命令层知道哪些墙变了，索引层不知道，所以 Task 9 必须沿 `dependentsOf` 迭代到不动点。两边口径在这里对一次：`resized` 里的墙 ∪ 被夹的洞口 ⊆ `expandAffected(doc, { pointId })`（后者更大，还包含没被夹动的那樘窗：多重建不会错，少重建会）。Task 9 要把这句话写成断言，用本任务「拖拐角」那个文档当输入。闭包出不出本层由 Task 3 的 `resolvePointRef` 决定（端点不能跨层复用），Task 9 把它写成一条用例而不是当作前提。

#### Task 7 执行回填（2026-09-26，评审后）

交付 `745d29e`（`commands/opening.ts` +122 / `commands/wall.ts` +68−1 / `index.ts` +1 /
`commands-opening.test.ts` +609）+ 修复轮 `ca21447`（`opening.ts` +5 / 测试 +127−35）。
`pnpm verify` = **205 passed / 18 files**，`commands-opening.test.ts` 24 条（openingCreate 11 /
move 4 / delete 2 / 跟随 7），修复轮**没有新增 `it`**。

评审 Verdict：`NOT SPEC COMPLIANT`（唯一不合规点 = T7① 的 `openingMove` 半边）+
`0 Critical / 5 Important / 5 Minor`。修复轮把 SPEC 那一半补上，并把 F2–F6 五条"边界一次没红过"
全变成确定性红（靶子与实测红集合见上面 Step 7 的第 8–13 条）。

**Step 1 / Step 2 的测试代码块有 7 处与落地态不同（照抄前先读，别改回去）**：

1. 「建门洞」尾部多 5 行：`before = canonical()` → `undo()` → `canonical() === before` →
   `get(made.id)` 为 `undefined` → `redo()` 后距离回来。spec 5.5 的可逆性对"新建"这一支
   此前只被一个跑完即删的临时文件证明过（F5）。
2. 「宽度或高度为 0 → 抛；反证」：手搓的零宽洞口从内联字面量提成 `negative` 常量，
   尾部多 4 件事 —— `new TransactionLog(hacked)` 装回可写日志、`openingMove` 抛
   `/洞口宽度必须为正/`、`distanceMm` 仍是 1000（没被盖章搬走）、`openingDelete` 同一樘**成功**。
   最后那件是 F1 修法的一部分：守卫放 `openingMove` 而不是 `requireOpening`，否则坏数据删不掉。
3. 「浮点入参在构造期就抛」：先建一樘真洞口（`depth` 因此从 2 变 3），
   断言改成**工厂函数自己抛**，并覆盖 `distanceMm`/`widthMm`/`heightMm`/`sillMm` 四个字段
   加 `openingMove` 一次；`byKind('opening')).toEqual([])` 换成 `canonical()` 逐字节比对（F4）。
4. 「缩墙」尾部同距离（x=3000）再拖一次，断 `distanceMm` 仍 2100 且 `affected` 只剩 `wall.endId`（F3）。
5. 「新墙比洞口还短」标题加"夹到 0 的边界两支各自钉住"，尾部补 (899, 41) 抛 `/放不下洞口/`
   与 (899, 59) 夹到 `+0`（`Object.is(d, 0)` 真、`Object.is(d, -0)` 假）两支（F6）。
   **顺带订正报告 §8 的一处措辞**：`Math.floor` 对 `(-1, 0)` 给的是 **−1** 不是 −0
   （`-0` 出自 `Math.trunc`/`Math.ceil`），而 `x - x` 恒为 `+0` ⇒ −0 根本进不到这条路径。
6. 「往回夹会让两樘撞上」：新增测试 helper `putOpening(log, wall, { id, distanceMm, widthMm })`
   （照 Task 6 D3 的手法，用裸 `log.dispatch({ type, build })` 贴指定 id 的洞口），
   两条洞口换成 `uuidv7(2)@1000` + `uuidv7(1)@2000`，并加 `expect(far.id < near.id).toBe(true)`
   钉住"本用例确实在反向序上"（F2）。
7. 「撤销拉伸」整个换成"一次拖拽夹两樘"的形状（共享点拖到 (2400, 800)：A 3600→2529.82、
   B 2400→2000，窗 2000→1629、门 1400→1100，`affected` 恰三个 id），
   断逆补丁把**每一条**旧距离都带回来；原形状（一次夹一樘）的覆盖在「拖拐角」里没丢（F5）。

**记账（本轮不修，别再考后人）**：

- **F8**：`openingCreate` 里 `mustExist(doc, wall.storeyId, '楼层')`（`commands/opening.ts:80`）
  注释掉 → 205 全绿，而且今天**不可能**有红：仓里没有 `storeyDelete`，`wallCreate` 又要求楼层存在
  ⇒ "墙的楼层不存在"从写入侧造不出来。这是**结构不可达支**（等价变异），与 Task 6 的
  「不同层」那一格同一类：都挂给计划 4 的读盘用例，不是漏洞。
- **F9**：`Document.validate` 不禁止带符号零（`Number.isInteger(-0)` 为真），而 `units/mm.ts`
  明文说真源不接受带符号的零；`JSON.stringify(-0) === "0"` ⇒ `canonical()` 看不见它。
  Task 7 新代码产不出 −0（见上面第 5 条），这是**上游账**：
  最小修法是在 `document.ts` 的整数检查上加 `|| Object.is(value, -0)` → 抛中文错误，
  归计划 4 读盘入口或 Task 10 的 `assertTruthSourceInvariants`。
- 评审给的更彻底修法"把 `distance + width <= newLengthMm` 从 `geom/opening.ts` 导出成
  `spanOverflows(span, lengthMm)`，命令层只调不复述" **没做**：它动的是 Task 6 的公开出口，
  而第 9 条变异现在已有确定性红。留给 Task 8/9 顺路（规则复述两遍，漂的永远是没人看的那一遍）。

**下游义务（覆盖 Task 6 回填里同名的那几条，以这里为准）**：

- **T8**：任何改 `wall.heightMm` 或 `storey.heightMm` 的命令，写前必须**整表复核**该层全部洞口的
  `sillMm + heightMm ≤ 宿主墙高`，并复用 `assertFitsAfterInsert` 的草稿文档套路，别写第二份竖向规则。
  今天"搬/缩墙造不出洞口高出宿主墙"只因为全仓没有任何命令改墙高（`grep heightMm commands/*` 只有
  `wallCreate` 与 `storeyCreate` 写它）—— 这条随时会被 T8 打破。
- **T9**：`wallMoveEndpoint.affected` = 被拖的点 ∪ **真被夹动**的洞口；轴长变了但洞口没被夹动的那面墙，
  其 id 不在 `affected` 里（「拉长墙」与「缩墙」第二轮那一次拖钉的就是这个），
  所以 `expandAffected` 必须自己走 `dependentsOf(point) → walls → openings` 到不动点。
  要收的两种形态：一次拖拽夹**两樘**（「撤销拉伸」现在是这一形状的现成夹具）与
  "洞口远端齐平墙尾 ⇒ 不该进 `affected`"（「缩墙」尾部）。简报那句集合口径用「拖拐角」文档写成断言；
  闭包不出本层由 `resolvePointRef` 决定，写成用例。
- **T10**：① 随机文档 + 随机拖端点后断言**永不出现** `/内部错误/`（排序前提的通用网，
  **不代替**第 13 条那个确定性夹具）；② 断 `Σ段长 + Σ洞宽 = 轴长` **且段两两不物理重叠、段在 `[0, 轴长]` 内**
  （F1 朝向洞的属性层补法 —— 本计划第三个 Σ 失明）；③ 生成"非整数轴长 + 洞口越界"的拖法，
  把 `distanceMm = floor(新轴长 − 宽)` 写成预言；④ 断 `Object.is(预测轴长, wallAxis(afterDoc, wall).lengthMm)`
  （夹洞路径的预测/派生同式性今天只靠注释维系）；⑤ 出一份 `assertTruthSourceInvariants(doc)`
  （引用完整性 + `widthMm ≥ 1` + `heightMm ≥ 1` + `sillMm ≥ 0` + 门 ⇒ `sillMm = 0` +
  `storeyId === hostWall.storeyId` + 不接受 `-0`），计划 4 读盘时调用一次。
  **理由**：`Document` 不查引用完整性，而 `openingSpans` 按 `hostWallId !== wall.id` 过滤
  ⇒ 一樘宿主指向非墙的洞在整层派生里**根本不存在**（不报错、不进段表），比零宽更安静；
  属性测试只能覆盖"命令能造的形状"，覆盖不到读盘数据。

---

### Task 8: 柱、楼板与楼层标高（`column.create` / `slab.create` / `storey.setElevation`）

> **照抄前先读**：本任务正文已在 2026-09-26 的执行 + 评审 + 修复轮之后**按落地态订正**过五处 ——
> ① `columnCreate` 的同点判据从"按 `pointId` 相等"改成"按坐标 + 同层"（连带守卫结构、`requirePoint` 与那条注释）；
> ② 两条「整数毫米」断言从 `log.dispatch(...)` 改问工厂本身；③ 柱的「楼层不存在」用例补 `heightMm: 4000`；
> ④ `storeyCreate` 那发的标高 `9000 → 1500`；⑤ ring 与柱的两条用例名。
> 测试辅助函数 `addWall` 的 `Omit<WallCreateInput, 'storeyId' | 'heightMm'>` 是编译必需的订正（原文 TS2783 + TS2741）。
> Step 7 的九条预言全部带上了实测红集合与四条修复轮新靶子。若你的分支上已经有 `a8fd5a4`/`2da49e3`/`1d32c73`，
> **不要再照抄一遍** —— 先 `git log --oneline -3`。执行结果与裁决见本节末尾「Task 8 执行回填」。


spec 第 5.5 节把这三条命令划进"数据模型与命令已实现、S1 不提供 UI"那一档：柱 UI 随 S3，楼板随 S2，而 3D 视口在 M1.7 唯一的写路径就是 `storey.setElevation`（spec 第 7 节）。D1 要求结构语义一开始就在真源里，所以本任务不能推给后续计划。

**关键判断：柱与板没有任何派生层，命令层就是唯一的门。** 墙有 Task 3–6 那一串守卫，`deriveStoreyGeometry` 兜在后面；柱与板在计划 2 里不进任何派生出口（Task 9 的索引只管墙，柱网与楼板命中留给计划 3），所以命令构造期与 `build` 期不拦下来的坏数据，会一路躺到计划 5 的图纸上。这就是本任务唯一那条"重"的地方 —— 板的边界环要自己判合法性：

1. **顶点数 ≥ 3、顶点互异**（含"不给首点重复当终点"：`boundaryPointIds` 是**开环**，闭合由派生方隐含）。
2. **相邻三点不共线**。这一条同时挡住两种病：180° 折回（`(0,0)-(10000,0)-(5000,0)-(0,10000)`，面积 25000000 照样算得出来，只有共线判据抓得到）和图纸上的冗余顶点（共线中间点会被当成真实转角标出来）。
3. **非相邻边不相交**（自交环的轮廓在 3D 里是破的）。
4. **不用面积判据**。Task 5 已经钉死"蝴蝶结的鞋带面积恒为 0"：面积能挡的病，共线 + 自交这两条精确判据全能挡；而面积挡不住的（折回、面积非 0 的交叉四边形）前两条能挡。所以留面积判据是留一份冗余，删。

三条判据都用精确零判定，**不引入 EPS**：输入恒为真源里的整数毫米（`PointEntity.x/y`），最大叉积量级 2×10⁴ × 2×10⁴ = 4×10⁸，离 2⁵³ 还差七个数量级，共线就是 `cross === 0`。浮点输入才需要容差判据，那属于计划 5 的环规范化。

**楼层重叠**：`storeyCreate` 到今天只查 `index` 重复，两层楼标高填重了照样进真源。本任务把它和 `storeySetElevation` 的竖向检查合成一个 `assertNoVerticalOverlap`，两边共用 —— 与 Task 6 的 `assertSpansFit` 同一个道理。判据是半开区间 `[elevationMm, elevationMm + heightMm)` 互不相交：正好贴邻合法（一层的顶就是二层的地），**留出空隙也合法**（错层、夹层、吊顶都是真实工况），只有重叠是物理上不可能。**负标高合法**（地下室），所以符号一律不查。

**非目标**（本任务明确不做，别顺手加）：柱与墙的关系（柱该落在墙角、截面是否吃进墙厚）属 S3 柱网；板与墙的支承关系属 S2；`storey.delete` 不在 spec 第 5.5 节的 S1 命令全集里，删楼层要连带删层内全部构件，那是计划 4 落库时按真源引用完整性一起设计的事，不在这里挤进去。

**Files:**
- Create: `packages/core/src/geom/ring.ts`
- Create: `packages/core/src/commands/column.ts`
- Create: `packages/core/src/commands/slab.ts`
- Modify: `packages/core/src/geom/vec.ts`（加 `segmentsIntersect`）
- Modify: `packages/core/src/commands/storey.ts`（加 `storeySetElevation` 与共用重叠守卫）
- Modify: `packages/core/src/model/read.ts`（加 `requireStorey`，柱/板/楼层命令共用它，消掉 cast）
- Modify: `packages/core/src/model/command.ts`（`CommandType` 加 `'storey.setElevation'`）
- Create: `packages/core/test/ring.test.ts`
- Create: `packages/core/test/commands-column-slab.test.ts`
- Modify: `packages/core/test/read.test.ts`（`requireStorey` 一条）
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes：Task 3 的 `PointRef` / `isExistingPoint` / `resolvePointRef`（柱与板的顶点复用同一套"坐标或已有 id"，跨层检查也是同一份）；Task 2 的 `mustExist` / `requirePoint` 同族断言（本任务补 `requireStorey`）；Task 5 的 `polygonArea`（只用于 `ring.test.ts` 里造反例时核对，实现不依赖它）；计划 1 的 `ColumnEntity` / `SlabEntity` / `assertMm`
- Produces：`segmentsIntersect(a1, a2, b1, b2): boolean`（`geom/vec.ts`）、`assertSimpleRing(label: string, points: readonly Vec2[]): void`（`geom/ring.ts`）、`requireStorey(doc, storeyId): StoreyEntity`（`model/read.ts`）、`ColumnCreateInput` / `columnCreate`、`SlabCreateInput` / `slabCreate`、`storeySetElevation({ storeyId, elevationMm })`

- [ ] **Step 1: 写失败的测试（环判据）**

`packages/core/test/ring.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { assertSimpleRing, polygonArea, segmentsIntersect, vec } from '@dajia/core';

const RECT = [vec(0, 0), vec(10000, 0), vec(10000, 6000), vec(0, 6000)];
/** 凹角 L 形板：合法，且专门用来盯"共线判据会不会误伤真转角"。 */
const CONCAVE_L = [
  vec(0, 0),
  vec(6000, 0),
  vec(6000, 3000),
  vec(3000, 3000),
  vec(3000, 6000),
  vec(0, 6000),
];

describe('assertSimpleRing', () => {
  it('矩形与它的反向绕序都通过（判据与顶点顺序方向无关）', () => {
    expect(() => assertSimpleRing('板', RECT)).not.toThrow();
    expect(() => assertSimpleRing('板', [...RECT].reverse())).not.toThrow();
    expect(() => assertSimpleRing('板', [vec(0, 0), vec(3000, 0), vec(0, 3000)])).not.toThrow();
  });

  it('凹 L 形板通过：凹角不是自交，共线判据不许把 90° 转角当冗余', () => {
    expect(() => assertSimpleRing('板', CONCAVE_L)).not.toThrow();
    // 反证：这个环的鞋带面积确实是 27000000，说明它没退化（退化环才是我们要挡的）
    expect(polygonArea(CONCAVE_L)).toBe(27000000);
  });

  it('少于 3 个顶点 → 抛（两点的"环"是一条线）', () => {
    expect(() => assertSimpleRing('板', [vec(0, 0), vec(1000, 0)])).toThrow(/至少 3 个顶点/);
    expect(() => assertSimpleRing('板', [])).toThrow(/至少 3 个顶点/);
  });

  it('重复顶点 → 抛；把首点重复写成终点也算重复', () => {
    expect(() =>
      assertSimpleRing('板', [vec(0, 0), vec(1000, 0), vec(1000, 0), vec(0, 1000)]),
    ).toThrow(/重复顶点/);
    // 开环约定：闭合由调用方隐含，写了首点就是重复
    expect(() =>
      assertSimpleRing('板', [vec(0, 0), vec(1000, 0), vec(0, 1000), vec(0, 0)]),
    ).toThrow(/重复顶点/);
  });

  it('相邻三点共线 → 抛：180° 折回与冗余共线点一起挡', () => {
    // 折回：面积 25000000 算得出来，只有共线判据抓得到 —— 面积判据在这里是瞎的
    expect(() =>
      assertSimpleRing('板', [vec(0, 0), vec(10000, 0), vec(5000, 0), vec(0, 10000)]),
    ).toThrow(/共线/);
    // 冗余顶点：同一条边上多一个点，出图会被标成真实转角
    expect(() =>
      assertSimpleRing('板', [vec(0, 0), vec(5000, 0), vec(10000, 0), vec(0, 10000)]),
    ).toThrow(/共线/);
  });

  it('自交 → 抛：用面积非 0 的交叉四边形，不用蝴蝶结', () => {
    // 蝴蝶结的鞋带恒为 0（Task 5 已钉），拿它当反例会让人以为"面积也能管自交"。
    // 这个四边形面积 9000000，只有边相交判据抓得到。
    const crossed = [vec(0, 0), vec(10000, 8000), vec(9000, 0), vec(0, 10000)];
    expect(polygonArea(crossed)).toBe(9000000);
    expect(() => assertSimpleRing('板', crossed)).toThrow(/自交/);
  });

  it('segmentsIntersect 是闭段语义：共顶点算相交；环判据靠跳过相邻对挡在门外', () => {
    // RECT 的四条边两两在顶点相接，上面第一条已经证明整环通过；
    // 这里直接盯 segmentsIntersect 本身，防止它"返回恒真"混过环判据。
    expect(segmentsIntersect(vec(0, 0), vec(10, 0), vec(5, -5), vec(5, 5))).toBe(true);
    expect(segmentsIntersect(vec(0, 0), vec(10, 0), vec(10, 0), vec(10, 10))).toBe(true);
    expect(segmentsIntersect(vec(0, 0), vec(10, 0), vec(0, 5), vec(10, 5))).toBe(false);
    expect(segmentsIntersect(vec(0, 0), vec(10, 0), vec(20, -5), vec(20, 5))).toBe(false);
    // 共线但错开：不重叠就不算相交
    expect(segmentsIntersect(vec(0, 0), vec(10, 0), vec(11, 0), vec(20, 0))).toBe(false);
    // 共线且重叠：算相交
    expect(segmentsIntersect(vec(0, 0), vec(10, 0), vec(5, 0), vec(20, 0))).toBe(true);
  });
});
```

7 条。注意最后一条把 `segmentsIntersect` 单独拉出来测：它是环判据的地基，而"相邻边跳过"的写法会让它的恒真/恒假 bug 在环测试里只红一条，指认不出根因。

- [ ] **Step 2: 实现 `segmentsIntersect` 与 `assertSimpleRing`**

`packages/core/src/geom/vec.ts` 末尾追加（`cross` / `sub` 本任务已有）：

```ts
/**
 * 闭线段是否相交（端点相接与共线重叠都算）。环的自交判据要的就是"闭"这一档语义：
 * 差一点点就算漏，画出来的轮廓是破的。
 *
 * 这里**不引入 EPS**：调用方给的恒是真源里的整数毫米，叉积量级 4e8 远在 double 精确区内，
 * 共线就是 cross === 0。浮点输入才需要容差判据，那属于计划 5 的环规范化。
 */
export function segmentsIntersect(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): boolean {
  const o1 = cross(sub(a2, a1), sub(b1, a1));
  const o2 = cross(sub(a2, a1), sub(b2, a1));
  const o3 = cross(sub(b2, b1), sub(a1, b1));
  const o4 = cross(sub(b2, b1), sub(a2, b1));
  // 严格相交：两条线段的两个端点各在对方两侧（0 与任何非零都"不同号"，端点落在线上会被下面兜住）
  if (Math.sign(o1) !== Math.sign(o2) && Math.sign(o3) !== Math.sign(o4)) return true;
  const within = (a: Vec2, b: Vec2, p: Vec2): boolean =>
    Math.min(a.x, b.x) <= p.x &&
    p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y &&
    p.y <= Math.max(a.y, b.y);
  // 共线：只有落进另一条线段的包围盒里才算碰上了
  return (
    (o1 === 0 && within(a1, a2, b1)) ||
    (o2 === 0 && within(a1, a2, b2)) ||
    (o3 === 0 && within(b1, b2, a1)) ||
    (o4 === 0 && within(b1, b2, a2))
  );
}
```

`packages/core/src/geom/ring.ts`：

```ts
import type { Vec2 } from './vec';
import { cross, segmentsIntersect, sub } from './vec';

/**
 * 一个开环（首尾不重复，闭合由调用方隐含）能不能当构件轮廓用。
 * 三条精确判据：顶点数、顶点互异、相邻三点不共线、非相邻边不相交。
 *
 * 故意不看面积：Task 5 已钉"蝴蝶结的鞋带面积恒为 0"，面积能挡的病这三条全能挡，
 * 而 180° 折回（面积照样为正）和面积非 0 的交叉四边形，面积判据一个都挡不住。
 * 多留一份判据就多一份"到底哪条在起作用"的疑问。
 */
export function assertSimpleRing(label: string, points: readonly Vec2[]): void {
  const n = points.length;
  if (n < 3) throw new RangeError(`${label}至少 3 个顶点，收到 ${n}`);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (points[i]!.x === points[j]!.x && points[i]!.y === points[j]!.y) {
        throw new RangeError(
          `${label}有重复顶点（第 ${i} 与 ${j} 个同为 (${points[i]!.x}, ${points[i]!.y})）：` +
            `开环不重复首点，两点也不许重合`,
        );
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const c = points[(i + 2) % n]!;
    // 输入恒为整数毫米 → 零判定精确，不需要 EPS
    if (cross(sub(b, a), sub(c, b)) === 0) {
      throw new RangeError(
        `${label}第 ${i}、${(i + 1) % n}、${(i + 2) % n} 个顶点共线：` +
          `要么 180° 折回，要么是图纸上的冗余转角`,
      );
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // 相邻边天生共享一个端点，(0, n-1) 也因为环闭合而相邻 —— 这些对一律不查
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (
        segmentsIntersect(points[i]!, points[(i + 1) % n]!, points[j]!, points[(j + 1) % n]!)
      ) {
        throw new RangeError(
          `${label}自交：第 ${i}-${(i + 1) % n} 条边与第 ${j}-${(j + 1) % n} 条边相交`,
        );
      }
    }
  }
}
```

- [ ] **Step 3: 写失败的测试（三条命令）**

`packages/core/test/commands-column-slab.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  columnCreate,
  slabCreate,
  storeyCreate,
  storeySetElevation,
  uuidv7,
  wallCreate,
  type ColumnEntity,
  type PointEntity,
  type SlabEntity,
  type StoreyEntity,
  type WallCreateInput,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();

function buildLog(): TransactionLog {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  return log;
}

/** 与 read.test.ts 同一个假 id：uuidv7 造不出它，也不会同一撞上真实体。 */
const MISSING = '00000000-0000-7000-8000-000000000009';

/** 按 index 取楼层：同毫秒的 uuidv7 不保证有序，byKind 下标是掷硬币。 */
function storeyByIndex(log: TransactionLog, index: number): string {
  const hit = log.document.byKind('storey').find((s) => s.index === index);
  if (!hit) throw new Error(`测试找不到楼层 index=${index}`);
  return hit.id;
}

// 取刚建成的实体一律靠 affected + 字面量判别（kind 写字面量才能收窄类型，不必修道断言）
function lastWall(log: TransactionLog): WallEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建墙');
}

function lastColumn(log: TransactionLog): ColumnEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'column') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建柱');
}

function lastSlab(log: TransactionLog): SlabEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'slab') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建板');
}

function addWall(log: TransactionLog, spec: Omit<WallCreateInput, 'storeyId'>): WallEntity {
  log.dispatch(wallCreate({ storeyId: storeyByIndex(log, 0), heightMm: 3000, ...spec }));
  return lastWall(log);
}

/** 拐角在 (3600, 0)：柱与板都要复用这个点。 */
function lCorner(): {
  log: TransactionLog;
  storeyId: string;
  sharedId: string;
  first: WallEntity;
  second: WallEntity;
} {
  const log = buildLog();
  const storeyId = storeyByIndex(log, 0);
  const first = addWall(log, {
    start: { x: 0, y: 0 },
    end: { x: 3600, y: 0 },
    thicknessMm: 240,
  });
  const sharedId = first.endId;
  const second = addWall(log, {
    start: { pointId: sharedId },
    end: { x: 3600, y: 2400 },
    thicknessMm: 240,
  });
  return { log, storeyId, sharedId, first, second };
}

/** 只要一个楼层、不要墙的场合（板的环用裸坐标就够）。 */
function oneStorey(): { log: TransactionLog; storeyId: string } {
  const log = buildLog();
  return { log, storeyId: storeyByIndex(log, 0) };
}

/** 6000×6000 矩形板四角，板的三条用例共用。 */
const RECT_CORNERS = [
  { x: 0, y: 0 },
  { x: 6000, y: 0 },
  { x: 6000, y: 6000 },
  { x: 0, y: 6000 },
];

describe('columnCreate', () => {
  it('给坐标建柱：点与柱一起进真源，坐标过 quantizeMm，默认承重且材料是混凝土', () => {
    const { log, storeyId } = lCorner();
    log.dispatch(
      columnCreate({ storeyId, at: { x: 1200.4, y: 600.2 }, widthMm: 400, depthMm: 400 }),
    );
    const column = lastColumn(log);
    const point = log.document.get(column.pointId) as PointEntity;
    expect([point.x, point.y]).toEqual([1200, 600]);
    expect(point.storeyId).toBe(storeyId);
    expect(column.loadBearing).toBe(true);
    expect(column.material).toBe('concrete');
    expect(log.affected).toEqual(new Set([column.pointId, column.id]));
  });

  it('复用拐角点：只 upsert 柱，affected 一个 id', () => {
    const { log, storeyId, sharedId } = lCorner();
    log.dispatch(
      columnCreate({ storeyId, at: { pointId: sharedId }, widthMm: 400, depthMm: 400 }),
    );
    const column = lastColumn(log);
    expect(column.pointId).toBe(sharedId);
    expect(log.affected).toEqual(new Set([column.id]));
    expect(log.document.byKind('point')).toHaveLength(3);
  });

  it('heightMm 省略时取所在楼层层高；给了就用给的', () => {
    const { log, storeyId } = lCorner();
    log.dispatch(columnCreate({ storeyId, at: { x: 0, y: 0 }, widthMm: 400, depthMm: 400 }));
    expect(lastColumn(log).heightMm).toBe(3000);
    log.dispatch(
      columnCreate({
        storeyId,
        at: { x: 900, y: 900 },
        widthMm: 400,
        depthMm: 400,
        heightMm: 2600,
      }),
    );
    expect(lastColumn(log).heightMm).toBe(2600);
  });

  it('截面或柱高非正 → /必须为正/；浮点截面 → 构造期 /整数毫米/，日志一步没走', () => {
    const { log, storeyId } = lCorner();
    const depth = log.depth;
    expect(() =>
      log.dispatch(columnCreate({ storeyId, at: { x: 0, y: 0 }, widthMm: 0, depthMm: 400 })),
    ).toThrow(/柱截面宽必须为正/);
    expect(() =>
      log.dispatch(columnCreate({ storeyId, at: { x: 0, y: 0 }, widthMm: 400, depthMm: -1 })),
    ).toThrow(/柱截面深必须为正/);
    expect(() =>
      log.dispatch(
        columnCreate({
          storeyId,
          at: { x: 0, y: 0 },
          widthMm: 400,
          depthMm: 400,
          heightMm: 0,
        }),
      ),
    ).toThrow(/柱高必须为正/);
    // 浮点这条直接断言**工厂**抛，不套 log.dispatch：Document.validate 的整数检查也含
    // 「整数毫米」，套上 dispatch 就分不清是命令层拦的还是落库层拦的（Task 7 栽过一次）
    expect(() =>
      columnCreate({ storeyId, at: { x: 0, y: 0 }, widthMm: 400.5, depthMm: 400 }),
    ).toThrow(/整数毫米/);
    expect(log.depth).toBe(depth);
    expect(log.document.byKind('column')).toHaveLength(0);
  });

  it('同坐标两柱 → /已有柱/（判据是坐标 + 同层，不看点 id）；换坐标、换层都放行（正对照）', () => {
    const { log, storeyId, sharedId } = lCorner();
    log.dispatch(
      columnCreate({ storeyId, at: { pointId: sharedId }, widthMm: 400, depthMm: 400 }),
    );
    const before = log.document.canonical();
    expect(() =>
      log.dispatch(
        columnCreate({ storeyId, at: { pointId: sharedId }, widthMm: 500, depthMm: 500 }),
      ),
    ).toThrow(/已有柱/);
    expect(log.document.canonical()).toBe(before);
    // 正对照一：换个坐标就行
    log.dispatch(
      columnCreate({ storeyId, at: { x: 100, y: 100 }, widthMm: 400, depthMm: 400 }),
    );
    expect(log.document.byKind('column')).toHaveLength(2);
    // 红：同一对**坐标**再来一次 —— 入参给的是字面量，所以这是个全新 pointId，
    // 但真源里它和上一根柱落在同一个 (100, 100) 上，图纸上就是重影。
    // 旧判据比 pointId 相等时这一发全然是瞎的（上一条只复用同一个 id，盯不住）。
    const beforeSameXY = log.document.canonical();
    expect(() =>
      log.dispatch(
        columnCreate({ storeyId, at: { x: 100, y: 100 }, widthMm: 500, depthMm: 500 }),
      ),
    ).toThrow(/已有柱/);
    expect(log.document.canonical()).toBe(beforeSameXY);
    // 正对照二（钉住"同层"这半边）：计划 3 的柱网逐层复用同一平面坐标，
    // 二层同一根轴线上的柱不是重影 —— 删掉 storeyId 过滤就会在这一发误红
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    log.dispatch(
      columnCreate({
        storeyId: storeyByIndex(log, 1),
        at: { x: 100, y: 100 },
        widthMm: 400,
        depthMm: 400,
      }),
    );
    expect(log.document.byKind('column')).toHaveLength(3);
    expect(log.document.byKind('point')).toHaveLength(5);
  });

  it('复用别层的点 → 抛（与墙共用 resolvePointRef 那条判据）', () => {
    const { log, sharedId } = lCorner();
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    expect(() =>
      log.dispatch(
        columnCreate({
          storeyId: storeyByIndex(log, 1),
          at: { pointId: sharedId },
          widthMm: 400,
          depthMm: 400,
        }),
      ),
    ).toThrow(/不能给楼层/);
  });

  it('楼层不存在 / 拿墙当楼层 → 两道中文各抛一次，柱一根都不许留下', () => {
    const { log, first } = lCorner();
    const depth = log.depth;
    // heightMm 必须显式给：省略时 column.ts 要拿 storey.heightMm 兜底，
    // 删掉 requireStorey 后这一发会崩在 `undefined.heightMm` 上 —— 红是 JS 的 TypeError，
    // 证不到"这道中文契约在起作用"（Task 8 评审 F4）
    expect(() =>
      log.dispatch(
        columnCreate({
          storeyId: MISSING,
          at: { x: 0, y: 0 },
          widthMm: 400,
          depthMm: 400,
          heightMm: 4000,
        }),
      ),
    ).toThrow(/楼层 不存在/);
    expect(() =>
      log.dispatch(
        columnCreate({
          storeyId: first.id,
          at: { x: 0, y: 0 },
          widthMm: 400,
          depthMm: 400,
          heightMm: 4000,
        }),
      ),
    ).toThrow(/不是楼层，是 wall/);
    // requireStorey 是 build 的第一行：抛在建点之前，所以点数与日志深度都该原地不动
    expect(log.depth).toBe(depth);
    expect(log.document.byKind('column')).toHaveLength(0);
    expect(log.document.byKind('point')).toHaveLength(3);
  });

  it('撤销新建柱：连它自己建的点一起消失', () => {
    const { log, storeyId } = lCorner();
    const points = log.document.byKind('point').length;
    log.dispatch(
      columnCreate({ storeyId, at: { x: 100, y: 100 }, widthMm: 400, depthMm: 400 }),
    );
    expect(log.document.byKind('point')).toHaveLength(points + 1);
    log.undo();
    expect(log.document.byKind('column')).toHaveLength(0);
    expect(log.document.byKind('point')).toHaveLength(points);
  });

  it('撤销复用拐角的柱：那个点必须留下（墙还指着它）', () => {
    const { log, storeyId, sharedId } = lCorner();
    log.dispatch(
      columnCreate({ storeyId, at: { pointId: sharedId }, widthMm: 400, depthMm: 400 }),
    );
    log.undo();
    expect(log.document.byKind('column')).toHaveLength(0);
    expect(log.document.get(sharedId)).toBeDefined();
  });
});

describe('slabCreate', () => {
  it('矩形板：4 个新点 + 1 块板进补丁，boundaryPointIds 保持传入顺序', () => {
    const { log, storeyId } = oneStorey();
    log.dispatch(slabCreate({ storeyId, boundary: RECT_CORNERS, thicknessMm: 120 }));
    const slab = lastSlab(log);
    expect(slab.boundaryPointIds).toHaveLength(4);
    expect(log.affected.size).toBe(5);
    expect(slab.elevationOffsetMm).toBe(0);
    // 顺序是真源的一部分：派生侧靠它复原环，不许偷偷排序
    const ring = slab.boundaryPointIds.map((id) => log.document.get(id) as PointEntity);
    expect(ring.map((p) => [p.x, p.y])).toEqual(RECT_CORNERS.map((c) => [c.x, c.y]));
  });

  it('混排复用与新建：拐角点直接进环，补丁里只有板与两个新点', () => {
    const { log, storeyId, sharedId } = lCorner();
    log.dispatch(
      slabCreate({
        storeyId,
        boundary: [{ pointId: sharedId }, { x: 3600, y: 2400 }, { x: 0, y: 0 }],
        thicknessMm: 120,
      }),
    );
    const slab = lastSlab(log);
    expect(slab.boundaryPointIds).toHaveLength(3);
    expect(slab.boundaryPointIds[0]).toBe(sharedId);
    expect(log.affected.size).toBe(3);
    // 复用的点没被改动 → 不进补丁。affected 只说"这次真的改了什么"（与 Task 7 同一口径）
    expect(log.affected.has(sharedId)).toBe(false);
    expect(log.affected.has(slab.id)).toBe(true);
  });

  it('环非法即抛：少于 3 点、自交，点与板都不许留下', () => {
    const { log, storeyId } = oneStorey();
    const before = log.document.canonical();
    expect(() =>
      log.dispatch(
        slabCreate({ storeyId, boundary: [{ x: 0, y: 0 }, { x: 6000, y: 0 }], thicknessMm: 120 }),
      ),
    ).toThrow(/至少 3 个顶点/);
    expect(() =>
      log.dispatch(
        slabCreate({
          storeyId,
          boundary: [
            { x: 0, y: 0 },
            { x: 10000, y: 8000 },
            { x: 9000, y: 0 },
            { x: 0, y: 10000 },
          ],
          thicknessMm: 120,
        }),
      ),
    ).toThrow(/自交/);
    expect(log.document.canonical()).toBe(before);
    expect(log.document.byKind('slab')).toHaveLength(0);
    // 补丁是原子的：build 抛错 → dispatch 什么都不做，环上的点也不许先落盘
    expect(log.document.byKind('point')).toHaveLength(0);
  });

  it('顶点 id 重复 → 抛；板厚非正与浮点 → 抛', () => {
    const { log, storeyId, sharedId } = lCorner();
    expect(() =>
      log.dispatch(
        slabCreate({
          storeyId,
          boundary: [
            { pointId: sharedId },
            { pointId: sharedId },
            { x: 0, y: 0 },
            { x: 0, y: 2400 },
          ],
          thicknessMm: 120,
        }),
      ),
    ).toThrow(/重复的顶点/);
    expect(() =>
      log.dispatch(slabCreate({ storeyId, boundary: RECT_CORNERS, thicknessMm: 0 })),
    ).toThrow(/板厚必须为正/);
    // 同柱那条：浮点板厚直接问工厂，dispatch 版会被 Document.validate 的同款文案顶掉
    expect(() => slabCreate({ storeyId, boundary: RECT_CORNERS, thicknessMm: 120.5 })).toThrow(
      /整数毫米/,
    );
  });

  it('撤销整块板：自建的点消失，复用的点保留', () => {
    const { log, storeyId, sharedId } = lCorner();
    const points = log.document.byKind('point').length;
    log.dispatch(
      slabCreate({
        storeyId,
        boundary: [{ pointId: sharedId }, { x: 3600, y: 2400 }, { x: 0, y: 0 }],
        thicknessMm: 120,
      }),
    );
    expect(log.document.byKind('slab')).toHaveLength(1);
    log.undo();
    expect(log.document.byKind('slab')).toHaveLength(0);
    expect(log.document.byKind('point')).toHaveLength(points);
    expect(log.document.get(sharedId)).toBeDefined();
  });

  it('楼层不存在 / 拿墙当楼层 → 抛，环上的四个点一个都不许留下', () => {
    const { log, first } = lCorner();
    const before = log.document.canonical();
    expect(() =>
      log.dispatch(slabCreate({ storeyId: MISSING, boundary: RECT_CORNERS, thicknessMm: 120 })),
    ).toThrow(/楼层 不存在/);
    expect(() =>
      log.dispatch(slabCreate({ storeyId: first.id, boundary: RECT_CORNERS, thicknessMm: 120 })),
    ).toThrow(/不是楼层，是 wall/);
    // requireStorey 在取环上各点之前：四次新建点连 build 都没进到
    expect(log.document.canonical()).toBe(before);
    expect(log.document.byKind('point')).toHaveLength(3);
    expect(log.document.byKind('slab')).toHaveLength(0);
  });
});

describe('storeySetElevation', () => {
  it('只改标高：层内的墙与点坐标一字未动，affected 只有楼层', () => {
    const { log, storeyId, sharedId } = lCorner();
    const point = log.document.get(sharedId) as PointEntity;
    log.dispatch(storeySetElevation({ storeyId, elevationMm: 450 }));
    const storey = log.document.get(storeyId) as StoreyEntity;
    expect(storey.elevationMm).toBe(450);
    expect(storey.heightMm).toBe(3000);
    expect(storey.index).toBe(0);
    expect(log.affected).toEqual(new Set([storeyId]));
    // 标高挂在楼层上，点的 (x, y) 与本层楼面无关 → 一个字都不该改
    expect(log.document.get(sharedId)).toEqual(point);
  });

  it('与上层重叠 → 抛；正好贴邻与留出空隙都合法（两条正对照）', () => {
    const { log, storeyId } = lCorner();
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 4500, heightMm: 3000 }));
    const before = log.document.canonical();
    // 本层抬到 1501：[1501, 4501) 与上层 [4500, 7500) 重叠 1mm
    expect(() =>
      log.dispatch(storeySetElevation({ storeyId, elevationMm: 1501 })),
    ).toThrow(/标高重叠/);
    expect(log.document.canonical()).toBe(before);
    // 正好贴邻：[1500, 4500) 与 [4500, 7500) 在半开区间下不相交
    log.dispatch(storeySetElevation({ storeyId, elevationMm: 1500 }));
    expect((log.document.get(storeyId) as StoreyEntity).elevationMm).toBe(1500);
    // 留出空隙：错层、夹层、吊顶都是真实工况 —— 只禁重叠，不禁缝
    log.dispatch(storeySetElevation({ storeyId, elevationMm: 0 }));
    expect((log.document.get(storeyId) as StoreyEntity).elevationMm).toBe(0);
  });

  it('负标高合法（地下室）：符号一律不查', () => {
    const { log, storeyId } = lCorner();
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    log.dispatch(storeySetElevation({ storeyId, elevationMm: -3000 }));
    expect((log.document.get(storeyId) as StoreyEntity).elevationMm).toBe(-3000);
    expect(log.document.byKind('storey')).toHaveLength(2);
  });

  it('storeyCreate 也拒绝重叠楼层（共用一份判据）；index 查重仍然先生效', () => {
    const { log } = lCorner();
    const before = log.document.canonical();
    // 二层建在 [2999, 5999)：与一层 [0, 3000) 重叠 1mm
    expect(() =>
      log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 2999, heightMm: 3000 })),
    ).toThrow(/标高重叠/);
    // index 重复走不到标高判据：两条判据各管一件事，顺序也不能反。
    // 标高故意给 1500（[1500, 4500) 与一层 [0, 3000) 重叠 1500mm），让这一发**同时**违反两条
    // 判据 —— 给 9000 时它只违反 index 查重，把两段检查上下调换也什么都红不出来。
    expect(() =>
      log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 1500, heightMm: 3000 })),
    ).toThrow(/index 重复/);
    expect(log.document.canonical()).toBe(before);
    expect(log.document.byKind('storey')).toHaveLength(1);
    expect(log.depth).toBe(3);
  });

  it('不同项目的楼层互不相干：标高重叠也各自成立', () => {
    const { log, storeyId } = lCorner();
    log.dispatch(
      storeyCreate({ projectId: uuidv7(), index: 0, elevationMm: 0, heightMm: 3000 }),
    );
    // 另一个项目已经占住 [0, 3000)，本项目的这层照旧抬到 100
    log.dispatch(storeySetElevation({ storeyId, elevationMm: 100 }));
    expect((log.document.get(storeyId) as StoreyEntity).elevationMm).toBe(100);
    expect(log.document.byKind('storey')).toHaveLength(2);
  });

  it('撤销标高改动逐字节复原，重做结果相同', () => {
    const { log, storeyId } = lCorner();
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    const before = log.document.canonical();
    log.dispatch(storeySetElevation({ storeyId, elevationMm: -500 }));
    expect(log.document.canonical()).not.toBe(before);
    expect(log.undo()).toBe(true);
    expect(log.document.canonical()).toBe(before);
    expect(log.redo()).toBe(true);
    expect((log.document.get(storeyId) as StoreyEntity).elevationMm).toBe(-500);
  });
});
```

9 + 6 + 6 = 21 条。柱与板各带一条「楼层不存在 / 拿墙当楼层」不是凑数：`requireStorey` 是这两个文件里唯一一道楼层检查，删掉它测试必须变红（Step 7 第 9 条就盯这个）。

- [ ] **Step 4: 实现 `requireStorey`、`commands/column.ts` 与 `commands/slab.ts`**

先扩 `packages/core/src/model/command.ts` 的联合（`storey.setElevation` 是给 Step 5 用的，一起加，省一次改文件）：

```ts
/** spec 5.5 的 S1 命令全集 + storey.setElevation（spec 第 7 节 M1.7 的 3D 唯一写路径）。 */
export type CommandType =
  | 'storey.create'
  | 'storey.setElevation'
  | 'wall.create'
  | 'wall.moveEndpoint'
  | 'wall.setThickness'
  | 'wall.delete'
  | 'opening.create'
  | 'opening.move'
  | 'opening.delete'
  | 'column.create'
  | 'slab.create';
```

柱与板都要读楼层（柱高默认取层高、板要确认楼层真实存在），所以先给 Task 2 的 `model/read.ts` 补上同族第四个断言。**必须在 Step 4 就落地**：柱与板的实现都靠它收窄类型，拖到 Step 5 会让这两个文件的中间态编不过。

```ts
// 文件头的 type import 加 StoreyEntity：
// import type { Entity, PointEntity, StoreyEntity, WallEntity } from './entity';

export function requireStorey(doc: Document, storeyId: EntityId): StoreyEntity {
  const entity = mustExist(doc, storeyId, '楼层');
  if (entity.kind !== 'storey') throw new TypeError(`${storeyId} 不是楼层，是 ${entity.kind}`);
  return entity;
}
```

`packages/core/test/read.test.ts` 的 `describe` 里追加一条（`requireStorey` 加进文件头的 import，`describe` 标题顺手改成「model/read 的四个断言」）：

```ts
  it('requireStorey 对非楼层实体抛「不是楼层，是 <kind>」，缺失抛中文 label', () => {
    const log = logWithOneWall();
    const wall = log.document.byKind('wall')[0]!;
    expect(() => requireStorey(log.document, wall.id)).toThrow(/不是楼层，是 wall/);
    expect(() => requireStorey(log.document, MISSING)).toThrow(/楼层 不存在/);
    // 正常路径：楼层实体原样返回 —— 柱高默认值就靠这一步拿到 heightMm
    expect(requireStorey(log.document, log.document.byKind('storey')[0]!.id).heightMm).toBe(3000);
  });
```

`packages/core/src/commands/column.ts`：

```ts
import { uuidv7, type EntityId } from '../ids';
import { assertMm, quantizeMm, type Mm } from '../units/mm';
import type { Command } from '../model/command';
import type { Document } from '../model/document';
import type { ColumnEntity, Entity, PointEntity } from '../model/entity';
import { requirePoint, requireStorey } from '../model/read';
import { isExistingPoint, resolvePointRef, type PointRef } from '../geom/topology';

export interface ColumnCreateInput {
  storeyId: EntityId;
  /** 柱心/柱角点：坐标字面量新建点，或复用墙端点（柱落在墙角是常态） */
  at: PointRef;
  widthMm: number;
  depthMm: number;
  /** 省略时取所在楼层层高：S1 的柱一律到顶，短柱属 S3 */
  heightMm?: number;
  loadBearing?: boolean;
  material?: string;
}

function positiveMm(value: Mm, label: string): Mm {
  if (value <= 0) throw new RangeError(`${label}必须为正，收到 ${value}`);
  return value;
}

export function columnCreate(input: ColumnCreateInput): Command {
  const widthMm = positiveMm(assertMm(input.widthMm, '柱截面宽'), '柱截面宽');
  const depthMm = positiveMm(assertMm(input.depthMm, '柱截面深'), '柱截面深');
  const heightMm =
    input.heightMm === undefined ? null : positiveMm(assertMm(input.heightMm, '柱高'), '柱高');
  // 坐标走 quantizeMm（与 wallCreate 同一口径），构造期就能判的都在这里判完
  const at = input.at;
  if (!isExistingPoint(at)) {
    quantizeMm(at.x);
    quantizeMm(at.y);
  }
  return {
    type: 'column.create',
    build(doc: Document) {
      const storey = requireStorey(doc, input.storeyId);
      const existing = resolvePointRef(doc, at, input.storeyId);
      const pointId = existing?.id ?? uuidv7();
      const upsert: Entity[] = [];
      let landing: PointEntity;
      // 建不建新点看**入参形态**而不是 existing === null：两者等价（resolvePointRef 只对坐标
      // 字面量返回 null），但这个写法让 TS 把 at 收窄成 {x, y}，免掉一条修道路断言。
      // 复用那一支的 `!` 是同一条推理的另一半（这里 existing 必然非空），与 slab.ts 里
      // resolvePointRef(...)! 是同一个例外，不是兜底。
      if (isExistingPoint(at)) {
        landing = existing!;
      } else {
        landing = {
          kind: 'point',
          id: pointId,
          storeyId: input.storeyId,
          x: quantizeMm(at.x),
          y: quantizeMm(at.y),
        };
        upsert.push(landing);
      }
      // 一根柱占一个坐标：同坐标两柱在图纸上是重影，在 3D 里是 z-fighting，在算量里是双份混凝土。
      // 判据取**坐标 + 同层**，不取 pointId —— 同一个 (x, y) 给两次字面坐标就会新建出第二个点
      // 实体，id 相等那条对这种重影全然是瞎的（板侧 geom/ring.ts 按坐标查重，柱侧按 id 查，
      // 一起提交的两个文件自相矛盾）。候选坐标直接取 landing.x/y，也就是真源里那对整数毫米，
      // 判据与真源不许有两套口径。
      // 限定同层是给计划 3 的柱网留的：柱网逐层复用同一平面坐标，不限定就会把
      // "二层同一根轴线上的柱"判成重影。层内柱指着的东西必须是真实存在的点，
      // 所以拿 requirePoint 断言（悬空引用是内部不变式被破坏，抛，不 continue）。
      for (const column of doc.byKind('column')) {
        if (column.storeyId !== input.storeyId) continue;
        const owner = requirePoint(doc, column.pointId, '柱落点');
        if (owner.x === landing.x && owner.y === landing.y) {
          // 两边都是整数毫米 → 精确相等比较，不引入 epsilon
          throw new RangeError(
            `该坐标已有柱 ${column.id}（点 ${column.pointId}，落在 (${owner.x}, ${owner.y})）：` +
              `同一层的同一个坐标上不能立两根柱`,
          );
        }
      }
      const column: ColumnEntity = {
        kind: 'column',
        id: uuidv7(),
        storeyId: input.storeyId,
        pointId,
        widthMm,
        depthMm,
        // 默认到层高：柱是竖向承重构件，"柱高 = 这一层多高"是唯一不用问用户的默认
        heightMm: heightMm ?? storey.heightMm,
        loadBearing: input.loadBearing ?? true,
        material: input.material ?? 'concrete',
      };
      upsert.push(column);
      return { upsert, remove: [] };
    },
  };
}
```

楼层那道检查只用 `requireStorey` 一次：它内部就含 `mustExist`，再单独调一次 `mustExist(doc, input.storeyId, '楼层')` 是重复劳动，还会让人以为这两处检查有可能给出不同的错误文案。`storey.heightMm` 现在直接可读 —— 早先这里写的是 `(storey as { heightMm: Mm }).heightMm`，那是把"这实体到底是不是楼层"从断言层推给运行时，正是计划 1 第 9 节禁的那类兜底，落地时不许留这种 cast。

`packages/core/src/commands/slab.ts`：

```ts
import { uuidv7, type EntityId } from '../ids';
import { assertMm, quantizeMm } from '../units/mm';
import type { Command } from '../model/command';
import type { Document } from '../model/document';
import type { Entity, PointEntity, SlabEntity } from '../model/entity';
import { requireStorey } from '../model/read';
import { isExistingPoint, resolvePointRef, type PointRef } from '../geom/topology';
import { assertSimpleRing } from '../geom/ring';
import { vec } from '../geom/vec';

export interface SlabCreateInput {
  storeyId: EntityId;
  /** 开环：首尾不重复，闭合由派生方隐含。至少 3 个，顺序就是真源里的边界走向。 */
  boundary: PointRef[];
  thicknessMm: number;
  elevationOffsetMm?: number;
}

export function slabCreate(input: SlabCreateInput): Command {
  const thicknessMm = assertMm(input.thicknessMm, '板厚');
  if (thicknessMm <= 0) throw new RangeError(`板厚必须为正，收到 ${thicknessMm}`);
  const elevationOffsetMm = assertMm(input.elevationOffsetMm ?? 0, '板标高偏移');
  // 入参在构造期只判"形状"（数量与重复），坐标本身要等 build 才读得到（可能是复用的点）
  if (input.boundary.length < 3) {
    throw new RangeError(`板边界至少 3 个顶点，收到 ${input.boundary.length}`);
  }
  const seen = new Set<EntityId>();
  for (const ref of input.boundary) {
    if (isExistingPoint(ref)) {
      if (seen.has(ref.pointId)) throw new RangeError(`板边界有重复的顶点 id：${ref.pointId}`);
      seen.add(ref.pointId);
    }
  }
  return {
    type: 'slab.create',
    build(doc: Document) {
      // 楼层检查一次就够：requireStorey 内部已含 mustExist（返回值本任务用不上，
      // 但板的标高偏移迟早要和楼层标高相加，先走同一道门）
      requireStorey(doc, input.storeyId);
      const ids: EntityId[] = [];
      const points: PointEntity[] = [];
      for (const ref of input.boundary) {
        if (isExistingPoint(ref)) {
          // 这个分支里 resolvePointRef 必然返回点（点若不存在它当场就抛了；null 只给坐标字面量），
          // 所以 `!` 只是把这条已成立的推理告诉 TS，不是兜底
          const existing = resolvePointRef(doc, ref, input.storeyId)!;
          ids.push(existing.id);
          points.push(existing);
          continue;
        }
        const created: PointEntity = {
          kind: 'point',
          id: uuidv7(),
          storeyId: input.storeyId,
          x: quantizeMm(ref.x),
          y: quantizeMm(ref.y),
        };
        ids.push(created.id);
        points.push(created);
      }
      // 环的合法性在这里判完就够：计划 2 没有任何派生出口会再读板的边界，
      // 命令层是唯一一道门，漏过去就一路躺到计划 5 的图纸上。
      assertSimpleRing('板边界', points.map((p) => vec(p.x, p.y)));
      const slab: SlabEntity = {
        kind: 'slab',
        id: uuidv7(),
        storeyId: input.storeyId,
        boundaryPointIds: ids,
        thicknessMm,
        elevationOffsetMm,
      };
      const upsert: Entity[] = [...points.filter((p) => !doc.get(p.id)), slab];
      return { upsert, remove: [] };
    },
  };
}
```

`upsert` 那行用 `!doc.get(p.id)` 滤掉复用的点 —— 复用的点没被改动，进补丁就是"重述"，会让 `affected` 说不清这次改了什么（与 Task 7 的 `dirty` 同一口径）。判据用"文档里有没有"而不是"分支来源"，是为了让这个不变式不靠调用点自觉：将来谁加了第三种 `PointRef` 形态，已存在的点照样进不了补丁。

- [ ] **Step 5: `commands/storey.ts` 加 `storeySetElevation` 与共用重叠守卫**

`storeyCreate` 的 `build` 里，index 查重之后、返回补丁之前插一行；新建与改标高共用同一份判据：

```ts
/**
 * 竖向不重叠：楼层占用 [elevationMm, elevationMm + heightMm)。
 * 正好贴邻合法（一层的顶就是二层的地），留出空隙也合法（错层、夹层、吊顶），
 * 只有重叠是物理上不可能。负标高合法（地下室），所以符号一律不查。
 * storeyCreate 与 storeySetElevation 共用这一份：两份规则一定会漂。
 */
function assertNoVerticalOverlap(doc: Document, candidate: StoreyEntity): void {
  const top = candidate.elevationMm + candidate.heightMm;
  for (const other of doc.byKind('storey')) {
    if (other.id === candidate.id || other.projectId !== candidate.projectId) continue;
    const otherTop = other.elevationMm + other.heightMm;
    const from = Math.max(candidate.elevationMm, other.elevationMm);
    const to = Math.min(top, otherTop);
    if (from < to) {
      throw new RangeError(
        `楼层标高重叠：${candidate.id} 占 ${candidate.elevationMm}–${top}，` +
          `与楼层 ${other.id} 的 ${other.elevationMm}–${otherTop} 相交（区间按半开算，贴邻合法）`,
      );
    }
  }
}
```

在 `storeyCreate.build` 里把结尾改成：

```ts
      const storey: StoreyEntity = {
        kind: 'storey',
        id: uuidv7(),
        projectId: input.projectId,
        index: input.index,
        elevationMm,
        heightMm,
      };
      assertNoVerticalOverlap(doc, storey);
      return { upsert: [storey], remove: [] };
```

新增命令：

```ts
export function storeySetElevation(input: { storeyId: EntityId; elevationMm: number }): Command {
  const elevationMm = assertMm(input.elevationMm, '楼层标高');
  return {
    type: 'storey.setElevation',
    build(doc: Document) {
      const storey = requireStorey(doc, input.storeyId);
      // 标高只在楼层上，层内墙与点的 (x, y) 一个字都不动 —— 这也是为什么这条命令
      // 能当 M1.7 的 3D 唯一写路径：拖动整层 = 改一个整数，不碰任何构件几何。
      assertNoVerticalOverlap(doc, { ...storey, elevationMm });
      return { upsert: [{ ...storey, elevationMm }], remove: [] };
    },
  };
}
```

`requireStorey` 是 Step 4 已经落地的那个断言，本文件只需在 `commands/storey.ts` 文件头补一行 `import { requireStorey } from '../model/read';` —— 别在 `storey.ts` 里再写一份同款检查，跨命令共用的读断言只有一份是 Task 2 立的规矩。

- [ ] **Step 6: 导出 + 全绿**

`packages/core/src/index.ts` 追加：

```ts
export * from './geom/ring';
export * from './commands/column';
export * from './commands/slab';
```

（`storeySetElevation` 走已有的 `export * from './commands/storey'`；`segmentsIntersect` 走 `./geom/vec`。）

```bash
pnpm typecheck 2>&1 | tail -5
pnpm vitest run packages/core/test/ring.test.ts packages/core/test/commands-column-slab.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -10
pnpm verify 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -5
```

Expected: `ring.test.ts` 7 passed；`commands-column-slab.test.ts` 21 passed（柱 9 + 板 6 + 楼层 6）。`pnpm verify` = 205 + 7 + 21 + 1（`read.test.ts` 的 `requireStorey`）= 234 passed，0 失败。`commands.test.ts` 的 `/index 重复/` 与 `properties.test.ts` 都不该被新的重叠判据打破：它们的 fixture 全是 `[0,3000)` 单层或 `[0,3000)/[3000,6000)` 贴邻。

- [ ] **Step 7: 变异检查（防"测试考的是空气"）**

九处逐个改、逐个还原，每次 `git diff` 必须回到空：

1. 删掉 `assertSimpleRing` 的共线循环 → Expected: 「180° 折回与冗余共线点」红，其余全绿（那个折回环面积 25000000，其它三条判据全是瞎的）。
2. 删掉非相邻边循环 → Expected: 只有「自交」红，且它内部的 `polygonArea === 9000000` 仍绿 —— 少了那行面积反证，这条变异能被"改用面积判据"蒙混。
3. 把 `if (j === i + 1 || (i === 0 && j === n - 1)) continue;` 整行删掉 → Expected: 「矩形通过」与「凹 L 形通过」全红（相邻边共享端点，`segmentsIntersect` 按闭段语义如实报真相交）。这条盯的是"跳过相邻对"这个设计本身，不是判据够不够严。
4. `storeySetElevation` 里删掉 `assertNoVerticalOverlap` → Expected: 只有「与上层重叠」红。
5. 把 `assertNoVerticalOverlap` 的 `from < to` 改成 `from <= to` → Expected（原写法）: 「正好贴邻合法」那条红。**实测红得多**：3 个文件 8 条红（本任务 4 条 + `opening-geom.test.ts` 3 条 + `topology.test.ts` 1 条）。这不是判据错了，而是**判据共用之后本来就该这样** —— 全仓每一个"第二层"夹具都是正好贴邻（`[3000,6000)` 对 `[0,3000)`），把贴邻判成重叠必然全线误拒。评审据此确认：现在由 4 个文件的夹具钉着半开区间语义，远强于原本预测的单条。这就是"半开区间必须有正对照盯着"的代价与收益。
6. `columnCreate` 的同点查重循环改成 `continue`（即永不命中）→ Expected（原写法）: 「同一个点上不能有两根柱」红，其正对照仍绿。**两处订正**：① 用例名已改成「同坐标两柱 …（判据是坐标 + 同层，不看点 id）」，因为旧名"同一个点"与新增的坐标形态子用例矛盾（那两个落点是**不同的点实体**）；② "正对照仍绿"在同一个 `it` 里**不可观测** —— vitest 首个断言失败即中止，红之后的行一次都不跑。它由另一条独立用例作证：「同坐标两柱」里的**正对照一**（换坐标放行）与**正对照二**（换层放行，红在 `toHaveLength(3)` 与 `toHaveLength(5)`）。
7. `slabCreate` 的 `upsert` 去掉 `!doc.get(p.id)` 过滤（复用的点也重述）→ Expected: 「混排复用与新建」的 `affected.size === 3` 与 `has(sharedId) === false` 红。**订正**：两条预测里只有第一条被观测到 —— `expected 4 to be 3`，随后同一条 `it` 中止，`has(sharedId)`（下一行）对本变异是**冗余断言**；`撤销整块板…` 仍绿（重述未改动的点，撤销后照样逐字节相同）。这条变异红的是"补丁里多了一条没改动的实体"，红不在撤销语义上。
8. `storeyCreate` 里删掉 `assertNoVerticalOverlap` → Expected: 「storeyCreate 也拒绝重叠楼层」的前半红，`/index 重复/` 那条仍绿（两条判据各管一件事，顺序也不能反：index 查重先，标高查重叠后）。**坑在原用例写法**：第二条子调用原本给 `elevationMm: 9000`，那一发**只**违反 index 查重，于是把两段检查上下调换也什么都红不出来 —— "`/index 重复/` 仍绿"是平凡地绿，不是证据。已改成 `1500`（同时违反两条，只有排在前面的 index 能答），变异「两段对调」实测红在 `:481`，报 `楼层标高重叠：… 占 1500–4500 …`。全仓**只有这一条**用例能区分先后（`commands.test.ts:52-58` 用的是贴邻 3000，对调后仍绿）。
9. 分别删掉 `columnCreate` 与 `slabCreate` 的 `requireStorey` 那行 → Expected: 各自新加的那条「楼层不存在 / 拿墙当楼层」红。**柱那一发原本是"崩红"不是"契约红"**：夹具省略 `heightMm` 时，摘掉 `requireStorey` 后代码会崩在 `undefined.heightMm` 上，红来自 JS TypeError，中文正则 `/楼层 不存在/` 撞不上它 —— 会红，但证不到"这道中文契约在起作用"。已给两条调用都补 `heightMm: 4000`：判据在时照样从 `requireStorey` 第一行抛，判据摘掉时 `heightMm ?? storey.heightMm` 短路、**根本不抛**，于是红在「expected [Function] to throw an error」。板那一发原本就是强形（悬空 `storeyId` 直接落库，L3 浮出）。
10. （修复轮新增）摘掉 `columnCreate` / `slabCreate` 的 `assertMm`，而浮点断言仍套在 `log.dispatch` 上 → Expected: **21 全绿**（实测），因为 `Document.validate` 的整数检查会替它答，两条文案都含「整数毫米」。改问工厂之后 → `Tests 2 failed | 19 passed (21)`。**通用规矩**：断"某道校验在"时，先问有没有下游会替它红（Task 7 修复轮第 10 条的同一条）。
11. （修复轮新增）`column.ts` 的守卫退回按 `column.pointId === landing.id` 判（保留 `storeyId` 过滤）→ Expected: **只有**坐标形态那条子用例红（`commands-column-slab.test.ts:206`，`expected [Function] to throw an error`），`:191` 那条复用同一 id 的仍绿。这一条就是评审 Important #1 描述的"瞎"，也是改名之后用例里两个正对照存在的理由。
12. （修复轮新增）摘掉 `column.ts:70` 的 `if (column.storeyId !== input.storeyId) continue;` → Expected: 只有**跨层正对照**那条红（`:211`），形态是未捕获 `RangeError: 该坐标已有柱 …（落在 (100, 100)）`。若没有这一发正对照，"同层限定"这半边任何人都能悄悄删掉。
13. （修复轮新增，实测**无红**，记账）把 `column.ts:71` 的 `requirePoint(doc, column.pointId, '柱落点')` 换成 `doc.get(column.pointId)` + `if (!owner) continue` → **234 全绿**。`requirePoint` 函数本身由 `read.test.ts` 5 条钉着，但**这个调用点的"抛 vs 跳过"策略没有任何用例盯着**。留给 Task 10 的引用完整性属性层（与 Task 7 的 F8/L3、F9 同一批读盘账）。

- [ ] **Step 8: 提交**

```bash
git add packages/core/src/geom/ring.ts packages/core/src/geom/vec.ts packages/core/src/commands/column.ts packages/core/src/commands/slab.ts packages/core/src/commands/storey.ts packages/core/src/model/read.ts packages/core/src/model/command.ts packages/core/test/ring.test.ts packages/core/test/commands-column-slab.test.ts packages/core/test/read.test.ts packages/core/src/index.ts
git commit -m "feat: 柱与楼板命令、环判据与楼层标高重叠守卫"
```

执行日志写在这里：29 条（7 + 21 + 1）的实际结果、九处变异各红了哪些用例，以及 `column.ts` 与 `slab.ts` 落地后有没有残留 `as { ... }` 这类修道路断言（Step 4 的要求是加 `requireStorey` + 用 `isExistingPoint` 收窄，一处都不许留；`slab.ts` 里 `resolvePointRef(...)!` 那个 `!` 是例外，Step 4 里写明了它为什么成立）。

**留给后续任务的钩子**：Task 9 的索引只吃墙与洞口（按条目取 `wallQuad` / `memberTrim` / `openingSpans` 那批原语），柱与板不进网格 —— 但 `queryPoint` 到了计划 3 必须能命中柱（点式构件），那时再扩 `SpatialIndex` 的入仓类型，本计划不预留空接口。`expandAffected` 对柱与板的行为要单独验：柱只依赖一个点，板依赖一圈点，两者的反向依赖边计划 1 的 `dependentsOf` 已经覆盖（Task 3 的 `dependentsOf` 用例里就有柱/板引用点的情形），Task 9 直接复用。

#### Task 8 执行回填（2026-09-26，评审 + 修复轮之后）

提交：`a8fd5a4`（实现，11 个文件）→ `2da49e3`（test-only：浮点断言改问工厂）→ `1d32c73`（修复轮 1：柱判据 + 三条判据的测试补强）。
门禁落地态：`pnpm verify` = **234 passed / 20 files**（控制器自己复跑，并在同一 HEAD 上连跑 6 次全绿；
`it` 数与简报一致：ring 7 / `columnCreate` 9 / `slabCreate` 6 / `storeySetElevation` 6 / `read.test.ts` +1，修复轮净增 0 条 `it`）。
`column.ts` 与 `slab.ts` 落地后**没有任何 `as { ... }` 修道路断言**；留下的两处 `!` 是
`slab.ts:46` 与 `column.ts:50` 的 `existing!`，同一条推理（`resolvePointRef` 只对坐标字面量返回 `null`），
Step 4 已写明为什么成立。

**与简报正文的偏离（全部已在上面正文就地订正，照抄本文件会得到落地态）**：

1. `columnCreate` 的"同点两柱"判据从**按 `pointId` 相等**改为**按坐标 + 同层**，守卫扫描用 `requirePoint` 断言既存在柱的落点。
   原因见 Step 7 第 11 条的变异：按 id 判时，同一对字面坐标给两次就长出两根柱（新点实体、不同 id），判据全然看不见，
   而**同一次提交里板侧 `geom/ring.ts` 是按坐标查重的** —— 两个文件自相矛盾。柱与板没有任何派生层，命令层就是唯一的门。
   随带的结构调整：`upsert` 与 `landing` 建点提前到守卫之前（候选坐标与真源共用同一份 `quantizeMm` 结果，不留第二套口径），
   时序仍安全，因为 `dispatch` 在 `build` 返回前不落任何补丁，且用例里有 `canonical()` 逐字节断言钉住"被拒的那发什么都没写"。
   **`requirePoint` 而不是 `doc.get(...) + continue`**：计划 1 第 9 节禁兜底；误拒风险由顺序挡掉 —— `storeyId` 过滤先于解析，
   别层的悬空引用走不到这一行，而同层内命令层造不出悬空（`wallDelete` 不回收仍被柱引用的点，`commands.test.ts:246-282`）。
2. 三条中文断言的**夹具与用例名**改动：`heightMm: 4000` 补齐（否则柱的 `requireStorey` 红是 JS 崩红）、
   `storeyCreate` 那发的标高 `9000 → 1500`（否则"index 查重先生效"是平凡地绿）、
   ring 用例改名（旧名把断言说反）、柱用例改名（旧名"同一个点"与新增的坐标形态子用例矛盾）。
3. 两处**编不过/跑不动**的简报正文：`addWall` 的 `Omit<WallCreateInput, 'storeyId'>` + 硬写 `heightMm: 3000`
   是 TS2783 + 两个调用点 TS2741（`WallCreateInput.heightMm` 必填），改为 `Omit<…, 'storeyId' | 'heightMm'>`；
   Step 7 第 5/6/7/8/9 条的红集合与"单 `it` 内可观测性"按实测订正（见上）。
4. 浮点「整数毫米」两条从 `log.dispatch(...)` 改问**工厂本身**（Step 7 第 10 条给了两边的实测计数）。

**已知未闭合（不是"留给下一个人当空气"，是显式裁决）**：柱的坐标不变式目前**只在创建期成立**。
`wallMoveEndpoint` 会改写共享点的 `(x, y)` 且只咨询墙，因此一次合法拖拽可以把 B 柱的落点搬到同层 A 柱的坐标上，
真源里长出守卫正要禁的那个重影。本轮不修，因为它需要的不是补丁而是一条语义裁决 ——
"拖动一个挂着柱的点"算不算移动那根柱？在拖里加"同坐标已有柱"会把"墙端落进柱位"这个真实工况一起拒掉。
**归 Task 9**：它是 `wallMoveEndpoint.affected` 与索引的下游消费者，必须明确自己建的索引里允许存在重影柱，
或者由它把拖侧守卫补上（那时 `dependentsOf` 已经给出柱的反向依赖边）。

**下游义务（可直接粘进 ledger）**：

- **T9**：① 上面那条重影语义要一次裁决；② `column.ts:69` 每次建柱 `byKind('column')` 排序 + 全扫 ⇒ 整层柱网 O(n²)，
  要不要按点建桶由索引层决定，别在索引里重新推导柱几何；③ 柱/板不入网格（简报非目标），`expandAffected` 直接复用
  `dependentsOf` 的现成分支。
- **T10**：① 整数毫米扫描从"只 dispatch 墙"扩到 `column.create` / `slab.create` / `storey.setElevation`；
  ② 随机命令序列全撤销后逐字节还原要覆盖这三条命令（今天只有逐条 `canonical()` 断言，属性层无证）；
  ③ `assertTruthSourceInvariants(doc)` 里加"同层同坐标不得有两根柱"与"两个不同 `pointId` 落在同一坐标 ⇒ 板环非法"
  （Step 3 的 M11 账：板构造期只按 `pointId` 去重，环判据的重复顶点支在 `slabCreate` 路径上不可达）；
  ④ 上面 Step 7 第 13 条：`column.ts:71` 的抛/跳策略无用例；
  ⑤ `properties.test.ts` 六处 `fc.assert` **没有钉 seed、失败也不打印 seed** —— 那是本仓唯一真正不可复现的掷硬币面，
  顺手把 seed 打印出来。
- **终审（本轮有意不修的 3 条 Minor + 4 条 out-of-scope）**：`positiveMm` 现在散在 4 处
  （`column.ts:21-24` 有名函数、`slab.ts:21`、`wall.ts:126`、`storey.ts:40` 内联），三处就是阈值，提到 `units/mm.ts` 共用；
  `wall.ts:77` 仍是 `mustExist(…, '楼层')`，"拿墙当楼层"对柱/板拒、对墙静默接受（收窄既有命令需要自己的用例）；
  `SlabCreateInput.boundary` 可变且按引用捕获（与 `wall.ts` 的 `input.start/end` 同一既有模式，单点改会不一致）；
  `TransactionLog.dispatch` 在 `build` 抛错时留下上一次的 `lastAffected`（计划 3 增量重建的坑）；
  `storey.ts:21` 的 `assertNoVerticalOverlap` 是模块私有（计划 4 需要共享版，别复制第二份规则）；
  `slab.ts:25` 与 `ring.ts:14` 在 `label='板边界'`、`length=2` 时文案逐字符相同（`test:326` 说不出哪一层答的，
  现靠 `ring.test.ts:68-69` 直接盯判据自身那份）。

---

---

### Task 9: AABB 空间索引与受影响子集重建（`spatial/index.ts`）

> **照抄前先读**：本任务正文已在 2026-09-26/27 的执行 + 评审 + 修复轮 1 之后**按落地态订正**过七处 ——
> ① Step 2 与 Step 4 的 import 表：`advance` 不在 `geom/axis.ts`，它在 `geom/vec.ts`（原文照抄会在 ESM 链接期就死，
> Step 2"前 10 条转绿"这句根本没法验）；② Step 3 里三条测试期望（门与宿主墙一起被 `queryPoint` 报出、
> 共角邻墙的盒子把外伸方块整个盖住、拖完之后 `maxX` 仍是 3720）；③ Step 4 的 `dirtyIds` 从"只读条目"改成
> **条目优先 + 实体回落**的 `dependsOnOf`（修复轮 1 的 C1，见下面解释第 3 点），连带 `wallDeps` / `openingDeps` /
> `entityDeps` 三个新函数与两处注释；④ Step 3 追加两条 C1 回归用例（`applyAffected` 那一组 5 → 7 条）；
> ⑤ Step 5 的期望数 22 → **24**、256 → **258**；⑥ Step 6 第 1 条的红名单两条 → **四条**、第 2 条 → 三条、
> 第 6 条的预言撤回（等价变异，实测 0 红）；⑦ Step 4 的解释从三处变四处。
> 提交链：`035878e`（实现）→ `c2f9d29`（修复轮 1）→ `3219a4e`（注释订正）。若你的分支上已经有这三个，
> **不要再照抄一遍** —— 先 `git log --oneline -3`。执行结果与裁决见本节末尾「Task 9 执行回填」。

spec 第 9 节那句话是本任务的全部验收标准：**「派生 AABB 索引，command 后只重建受影响节点局部，支撑命中与拾取」**。计划 3 的 2D 命中、吸附候选点、橡皮筋预览都只问这个索引要候选，不再自己遍历真源；所以本任务的核心不是"快"，而是**局部重建之后的索引必须与整层重建逐条相等** —— 一旦这里悄悄留下旧盒子，计划 3 症状是"点了没反应"，根因却在几万行之外。

**关键判断 1：`dependentsOf` 的闭包不够用，索引必须双向走。** 四条真实的漏网边：

1. **删一面墙，邻墙的框会变。** `wallDelete` 的补丁里没有邻墙，邻墙的实体也没变，但它在那个共享端点上的接头从 `corner` 变成了 `free`，斜切量归零 → 梯形变矩形 → 盒子变小。
2. **改一面墙的墙厚，共角的另一面墙框也会变**（Task 4 的异厚 corner 是偏置斜切，邻墙的 `trim` 取的是对面的半厚）。
3. `affected` 里根本没有那些"几何变了但实体没变"的墙 —— Task 3 就钉过这条（`affected` 只有那个点）。
4. **刚建成的构件自己还没有条目**，可它两端挂着的既有邻墙从这一刻起接头从 `free` 变 `corner`，框要重算。这条是落地后评审抓出来的（C1，见本节末尾回填第 3 条）：`wallCreate` 复用 `{pointId}` 时连那个点都不 upsert，所以共享点不在 `affected` 里；而新墙此刻没有 `IndexEntry`，`dependsOn` 也无从读起 —— 上面 1/2/3 三条都是"旧条目的盒子发霉"，只有这一条是"新实体的边根本没人认领"，**从条目里读边的设计看不见它**。

`dependentsOf` 只走真源的**引用关系**（点 → 墙 → 洞口），"两墙共享端点"这条边不在里面。所以本任务把 `expandAffected(doc, seed)` 保持为**纯真源闭包**（Task 7 的口径断言靠它），而 `SpatialIndex` 内部另走一步：把依赖边（墙的两个端点、洞口的宿主墙与那两个端点）也当作边，双向迭代到不动点。取边是**一条回落链**：条目还在就用条目的 `dependsOn`（被删实体唯一的边来源），条目没有而实体活着就从实体现取（新建实体的那条边只有这里给得出）—— 两步缺任何一步，上面四条里就有对应的几条留下发霉的盒子。

**关键判断 2：一个索引只管一层。** 三层楼的墙在 (x, y) 上完全重叠，2D 视口与 3D 楼层切换的作用域本来就是"当前层"。按层建索引让 `query` 不必带过滤参数，也让上面的漏网边 1 与 2 天然只在本层内闭环 —— 前提正是测试 7 要钉住的那条：**点 seed 的闭包不会跑到别层去**（Task 3 的 `resolvePointRef` 挡住了跨层复用端点）。

**关键判断 3：`query` 返回的是候选，不是证明。** AABB 相交不等于几何相交：洞口的框是"沿轴区间 × 墙厚"，**不带斜切**，所以端头被斜掉的那块三角里仍会报出这个洞口。保守方向是"宁多不漏"（洞口框恒真包含洞口本身，墙框就是梯形盒），精确命中由 `scene-2d` 做。这句话必须写在 `query` 的文档注释里，且有一条测试盯着它的两个来源。

**非目标**：柱与板不入索引（Task 8 已声明，计划 3 再扩）；不做旋转/倾斜盒的精确相交；不管竖向（标高）—— `storeySetElevation` 之后本层索引照旧重建一次（闭包会把全层构件收进来，见测试 3），这正是 M1.7 拖动整层时 3D 侧要的那份脏集合。

还有一条要说白：**索引不调 `deriveStoreyGeometry`**，它按条目用同一批派生原语（`wallAxis` + `memberTrim` + `wallQuad`，洞口走 `openingSpans` + `openingAabb`）。Task 6 那句"索引的唯一数据来源是 `deriveStoreyGeometry`"当时写得比实际乐观 —— 整层派生每次都把全层的墙重算一遍，"只重建受影响局部"这句话就落不了地。两边不漂的保证是**原语只有一份**，不是出口只有一个；代价是 Task 6 那道「墙端接头不在本层」守卫（`endsSeen !== 2`）在索引路径上不生效 —— 它挡的是跨楼层共享端点，而那种文档在 Task 3 的命令层就建不出来，`deriveStoreyGeometry` 那道守卫是给手工 `applyPatch` 的病态文档准备的（Task 6 已专门造过一次病并验了守卫）。索引遇到同一种病态文档，给出的盒子与 `deriveWallQuads` 完全一致，只是不报错。

**Files:**
- Create: `packages/core/src/spatial/index.ts`
- Create: `packages/core/test/spatial.test.ts`
- Modify: `packages/core/src/index.ts`（加 `export * from './spatial/index';`）

**Interfaces:**
- Consumes：Task 5 的 `deriveWallQuads` / `wallQuad` / `polygonArea`；Task 4 的 `deriveJoints` / `memberTrim`；Task 2 的 `wallAxis` / `wallAxisById` / `advance`；Task 6 的 `openingSpans` / `OpeningSpan`；Task 3 的 `dependentsOf`；计划 1 的 `Document` / `TransactionLog.affected` / `assertMm`
- Produces：`Aabb`、`aabbOfPoints(points): Aabb`、`aabbIntersects(a, b): boolean`、`openingAabb(axis, span): Aabb`、`expandAffected(doc, seed): Set<EntityId>`、`IndexEntry` / `IndexedKind` / `SpatialIndex`（`fromDoc(doc, storeyId, options?)` / `rebuild(doc)` / `applyAffected(doc, affected)` / `query(rect)` / `queryPoint(x, y)` / `cellVisits(rect)` / `entryOf(id)` / `snapshot()` / `size`）

- [ ] **Step 1: 写失败的测试（`expandAffected` 与 AABB 助手）**

`packages/core/test/spatial.test.ts`，先落夹具与前两个 `describe`（Step 3 在同一个文件里追加索引的两个 `describe`，并把 `SpatialIndex`、`deriveWallQuads` 补进 import）。

**import 表里此刻不能出现 `SpatialIndex`**：Step 2 只落纯函数，那时 `@dajia/core` 里没有这个名字，ESM 会在解析阶段就让整个文件报错，Step 2 那句"前 10 条转绿"就无从验起。同理 `deriveWallQuads` 只被 Step 3 的 `bruteForce` 用到，也留到 Step 3 再加。

```ts
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  aabbIntersects,
  aabbOfPoints,
  applyPatch,
  columnCreate,
  expandAffected,
  openingAabb,
  openingCreate,
  openingSpans,
  slabCreate,
  storeyCreate,
  uuidv7,
  wallAxisById,
  wallCreate,
  wallDelete,
  wallMoveEndpoint,
  wallSetThickness,
  type Aabb,
  type OpeningEntity,
  type PointRef,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();
const MISSING = '00000000-0000-7000-8000-000000000009';

function buildLog(): TransactionLog {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  return log;
}

function storeyByIndex(log: TransactionLog, index: number): string {
  const hit = log.document.byKind('storey').find((s) => s.index === index);
  if (!hit) throw new Error(`测试找不到楼层 index=${index}`);
  return hit.id;
}

/** 取刚建成的实体一律走 affected + 字面量判别（同毫秒的 uuidv7 不保证有序）。 */
function lastWall(log: TransactionLog): WallEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建墙');
}

function idOfKind(log: TransactionLog, kind: 'column' | 'slab'): string {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === kind) return id;
  }
  throw new Error(`最近一次 dispatch 没有新建 ${kind}`);
}

/**
 * 夹具只写坐标，墙高统一 3000。
 * 这里不用 `Omit<WallCreateInput, 'storeyId'>`：那个类型里 `heightMm` 是必填，
 * Omit 掉 storeyId 之后每条 addWall 都得自己再写一遍墙高。本地 `WallSpec` 让它可选，
 * 默认值只在这一处。
 */
interface WallSpec {
  start: PointRef;
  end: PointRef;
  thicknessMm: number;
  heightMm?: number;
}

function addWall(log: TransactionLog, spec: WallSpec): WallEntity {
  log.dispatch(
    wallCreate({
      storeyId: storeyByIndex(log, 0),
      start: spec.start,
      end: spec.end,
      thicknessMm: spec.thicknessMm,
      heightMm: spec.heightMm ?? 3000,
    }),
  );
  return lastWall(log);
}

/** 只有一面 3600×240 的横墙：洞口盒与 queryPoint 用它，没有接头干扰。 */
function straightWall(): { log: TransactionLog; storeyId: string; wall: WallEntity } {
  const log = buildLog();
  const wall = addWall(log, { start: { x: 0, y: 0 }, end: { x: 3600, y: 0 }, thicknessMm: 240 });
  return { log, storeyId: storeyByIndex(log, 0), wall };
}

/** 拐角在 (3600, 0) 的 L 形：A 横 B 竖，两墙同厚 240。 */
function lCorner(): {
  log: TransactionLog;
  storeyId: string;
  sharedId: string;
  first: WallEntity;
  second: WallEntity;
} {
  const log = buildLog();
  const first = addWall(log, {
    start: { x: 0, y: 0 },
    end: { x: 3600, y: 0 },
    thicknessMm: 240,
  });
  const sharedId = first.endId;
  const second = addWall(log, {
    start: { pointId: sharedId },
    end: { x: 3600, y: 2400 },
    thicknessMm: 240,
  });
  return { log, storeyId: storeyByIndex(log, 0), sharedId, first, second };
}

function addOpening(
  log: TransactionLog,
  spec: Omit<Parameters<typeof openingCreate>[0], 'hostWallId'> & { hostWallId: string },
): OpeningEntity {
  log.dispatch(openingCreate(spec));
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'opening') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建洞口');
}

/** L 形 + A 上一樘窗（2000–2900）、B 上一樘门（1400–2300）。 */
function lCornerWithOpenings(): {
  log: TransactionLog;
  storeyId: string;
  sharedId: string;
  first: WallEntity;
  second: WallEntity;
  win: OpeningEntity;
  door: OpeningEntity;
} {
  const base = lCorner();
  const win = addOpening(base.log, {
    hostWallId: base.first.id,
    distanceMm: 2000,
    widthMm: 900,
    heightMm: 1500,
    category: 'window',
  });
  const door = addOpening(base.log, {
    hostWallId: base.second.id,
    distanceMm: 1400,
    widthMm: 900,
    heightMm: 2100,
    category: 'door',
  });
  return { ...base, win, door };
}

/** count 面互不相连的横墙排成一列，i 号占 x ∈ [i*4000, i*4000+3000]。 */
function wallRow(count: number): { log: TransactionLog; storeyId: string; walls: WallEntity[] } {
  const log = buildLog();
  const walls: WallEntity[] = [];
  for (let i = 0; i < count; i++) {
    walls.push(
      addWall(log, {
        start: { x: i * 4000, y: 0 },
        end: { x: i * 4000 + 3000, y: 0 },
        thicknessMm: 200,
      }),
    );
  }
  return { log, storeyId: storeyByIndex(log, 0), walls };
}

describe('expandAffected', () => {
  it('三种 seed 都含自身，并沿引用关系往下走', () => {
    const { log, first, win } = lCornerWithOpenings();
    // 洞口没有下游：闭包就是它自己
    expect([...expandAffected(log.document, new Set([win.id]))]).toEqual([win.id]);
    // 墙 → 它身上的洞口
    expect([...expandAffected(log.document, new Set([first.id]))].sort()).toEqual(
      [first.id, win.id].sort(),
    );
    // 独占的端点 → 墙 → 洞口（一次走到底，不是只走一层）
    expect([...expandAffected(log.document, new Set([first.startId]))].sort()).toEqual(
      [first.startId, first.id, win.id].sort(),
    );
  });

  it('共享端点一脏，两墙与两墙上的洞口一次收全', () => {
    const { log, sharedId, first, second, win, door } = lCornerWithOpenings();
    const closure = expandAffected(log.document, new Set([sharedId]));
    expect([...closure].sort()).toEqual(
      [sharedId, first.id, second.id, win.id, door.id].sort(),
    );
  });

  it('楼层 id 一脏，整层构件全脏；点不在闭包里（点没有要重算的几何）', () => {
    const { log, storeyId, first, second, win, door } = lCornerWithOpenings();
    log.dispatch(
      columnCreate({ storeyId, at: { pointId: first.startId }, widthMm: 400, depthMm: 400 }),
    );
    const column = idOfKind(log, 'column');
    log.dispatch(
      slabCreate({
        storeyId,
        boundary: [
          { pointId: first.startId },
          { x: 3600, y: 0 },
          { x: 0, y: 2400 },
        ],
        thicknessMm: 120,
      }),
    );
    const slab = idOfKind(log, 'slab');
    const closure = expandAffected(log.document, new Set([storeyId]));
    expect([...closure].sort()).toEqual(
      [storeyId, first.id, second.id, win.id, door.id, column, slab].sort(),
    );
    // 点是楼层的**上游**：楼层脏不需要重算点
    expect(closure.has(first.startId)).toBe(false);
  });

  it('已经不在文档里的 id 当 seed：不抛，闭包只剩它自己', () => {
    const { log, first, second } = lCorner();
    log.dispatch(wallDelete({ wallId: second.id }));
    const closure = expandAffected(log.document, new Set([second.id]));
    expect([...closure]).toEqual([second.id]);
    // 活着的共享端点仍能把邻墙带进来 —— 删除不切断闭包的其他入口
    expect(expandAffected(log.document, new Set([first.endId])).has(first.id)).toBe(true);
  });

  it('终止性：startId === endId 的病态墙也不会让闭包转圈', () => {
    const { log, wall } = straightWall();
    // 真源不校验引用完整性，这种墙只能靠 applyPatch 手工造出来（命令层建不出：零长墙被拒）
    const bad: WallEntity = { ...wall, startId: wall.endId };
    const doc = applyPatch(log.document, { upsert: [bad], remove: [] }).doc;
    const closure = expandAffected(doc, new Set([bad.endId]));
    expect([...closure].sort()).toEqual([bad.endId, bad.id].sort());
  });

  it('Task 7 的口径：被拉伸的两面墙 ∪ 被夹的洞口 ⊆ expandAffected(doc, {pointId})', () => {
    const { log, sharedId, first, second, win, door } = lCornerWithOpenings();
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 1200 }));
    // 命令层的补丁只写了那个点与被夹动的门
    expect([...log.affected].sort()).toEqual([sharedId, door.id].sort());
    const closure = expandAffected(log.document, new Set([sharedId]));
    for (const id of [first.id, second.id, door.id]) expect(closure.has(id)).toBe(true);
    // 没被夹动的窗也在闭包里：多重建不会错，少重建会
    expect(closure.has(win.id)).toBe(true);
  });

  it('点 seed 的闭包不出本层：这就是索引按楼层建的作用域前提', () => {
    const { log, storeyId, sharedId } = lCorner();
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    const upper = storeyByIndex(log, 1);
    log.dispatch(
      wallCreate({
        storeyId: upper,
        start: { x: 3600, y: 0 },
        end: { x: 3600, y: 2400 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    );
    const closure = expandAffected(log.document, new Set([sharedId]));
    // 二层那面墙与本层的 B 平面坐标完全重合，但它引用的是别层的点 → 不在闭包里
    for (const id of closure) {
      const entity = log.document.get(id);
      if (!entity || entity.kind === 'storey') continue;
      expect(entity.storeyId).toBe(storeyId);
    }
    expect(closure.size).toBe(3);
  });
});

describe('Aabb 助手', () => {
  it('aabbOfPoints 取四极值；单点退化成零面积矩形；空数组抛', () => {
    const box = aabbOfPoints([
      { x: 10, y: -30 },
      { x: 40, y: 20 },
      { x: -5, y: 7 },
    ]);
    expect(box).toEqual({ minX: -5, minY: -30, maxX: 40, maxY: 20 });
    expect(aabbOfPoints([{ x: 3, y: 4 }])).toEqual({ minX: 3, minY: 4, maxX: 3, maxY: 4 });
    expect(() => aabbOfPoints([])).toThrow(/至少一个点/);
  });

  it('aabbIntersects 用闭区间：贴边与包含都算相交，错开一格才算不相交', () => {
    const a: Aabb = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(aabbIntersects(a, { minX: 10, minY: 0, maxX: 20, maxY: 10 })).toBe(true);
    expect(aabbIntersects(a, { minX: 2, minY: 2, maxX: 3, maxY: 3 })).toBe(true);
    expect(aabbIntersects(a, a)).toBe(true);
    expect(aabbIntersects(a, { minX: 11, minY: 0, maxX: 20, maxY: 10 })).toBe(false);
    expect(aabbIntersects(a, { minX: -10, minY: -10, maxX: -1, maxY: 5 })).toBe(false);
  });

  it('openingAabb 是沿轴区间 × 墙厚，不带斜切：2600+900 的窗落在 x[2600,3500] y[-120,120]', () => {
    const { log, wall } = straightWall();
    const axis = wallAxisById(log.document, wall.id);
    expect(openingAabb(axis, { openingId: uuidv7(), fromMm: 2600, toMm: 3500 })).toEqual({
      minX: 2600,
      minY: -120,
      maxX: 3500,
      maxY: 120,
    });
    // 区间口径不自己拼：吃 openingSpans 的输出，和派生轮廓用的是同一张表。
    // 「索引里的洞口条目」（kind / dependsOn）由 Step 3 那条用例接着验。
    const win = addOpening(log, {
      hostWallId: wall.id,
      distanceMm: 2600,
      widthMm: 900,
      heightMm: 1500,
      category: 'window',
    });
    const spans = openingSpans(log.document, wall);
    expect(spans).toEqual([{ openingId: win.id, fromMm: 2600, toMm: 3500 }]);
    expect(openingAabb(axis, spans[0]!)).toEqual({ minX: 2600, minY: -120, maxX: 3500, maxY: 120 });
    // 洞口盒恒真包含洞口本身：墙厚方向不外伸（±half），沿轴不外伸（to - from == widthMm）。
    // 斜切只削墙的角，不会把洞口削到盒子外面 —— 这条是 query 敢把 AABB 当候选的依据。
    expect(spans[0]!.toMm - spans[0]!.fromMm).toBe(900);
    expect(axis.thicknessMm / 2).toBe(120);
  });
});
```

7 + 3 = 10 条。第 6 条就是 Task 7 留的那句话，输入文档也是它那个文档；第 7 条是本任务"按层建索引"这个决定的唯一凭据，删了它，`fromDoc(doc, storeyId)` 的作用域就是没有依据的想当然。Aabb 那三条全是纯函数，所以 Step 2 之后这个文件就能绿 —— 索引条目的 `kind` / `dependsOn` 留到 Step 3，那时 `SpatialIndex` 才存在。

- [ ] **Step 2: 实现 `expandAffected` 与 AABB 助手**

`packages/core/src/spatial/index.ts`（本任务先落纯函数部分，`SpatialIndex` 在 Step 4 补进同一个文件）。文件头只 import 本步用得上的东西，Step 4 再补它自己那几行 —— 一份写着十来个名字、有一半没人用的 import 表，会让 Step 2 的 `pnpm typecheck` 红得莫名其妙：

```ts
import type { EntityId } from '../ids';
import type { Document } from '../model/document';
import { dependentsOf } from '../geom/topology';
import type { WallAxis } from '../geom/axis';
import { advance, type Vec2 } from '../geom/vec';
import type { OpeningSpan } from '../geom/opening';
```

```ts
/** 轴对齐包围盒。分量是浮点：它由派生轮廓（本身是浮点）取极值而来。 */
export interface Aabb {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export function aabbOfPoints(points: readonly Vec2[]): Aabb {
  if (points.length === 0) throw new RangeError('aabbOfPoints 需要至少一个点');
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * 闭区间相交：贴边与包含都算"碰上"。索引宁可多报候选也不能漏，
 * 开区间会在两个盒子恰好共边时漏掉真实可拾取的构件。
 */
export function aabbIntersects(a: Aabb, b: Aabb): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/**
 * 洞口沿墙方向的盒子：轴线区间 × 墙厚，**不含接头斜切**。
 * 洞口本身恒真包含在这个盒子里（斜切只会削墙的角，不会削洞口），所以它是合法的保守候选盒。
 */
export function openingAabb(axis: WallAxis, span: OpeningSpan): Aabb {
  const half = axis.thicknessMm / 2;
  const from = advance(axis.start, axis.dir, span.fromMm);
  const to = advance(axis.start, axis.dir, span.toMm);
  return aabbOfPoints([
    advance(from, axis.normal, half),
    advance(to, axis.normal, half),
    advance(to, axis.normal, -half),
    advance(from, axis.normal, -half),
  ]);
}

/**
 * 真源引用关系的反向闭包（dependentsOf 迭代到不动点），含 seed 自身。
 * 注意它**只是**真源闭包：删一面墙时邻墙的接头会变，改一面墙的墙厚时共角邻墙的斜切会变，
 * 而这两种"邻居"都不在引用关系里。SpatialIndex 自己再走一层（见 dirtyIds 的双向闭包）。
 * 终止性由 kind 顺序保证：point → wall / column / slab，wall → opening，storey → 层内构件，
 * opening / column / slab 无下游。真源再怎么悬空引用也构不成环，所以这里不需要访问上限。
 */
export function expandAffected(doc: Document, seed: ReadonlySet<EntityId>): Set<EntityId> {
  const out = new Set<EntityId>(seed);
  const queue: EntityId[] = [...seed];
  while (queue.length > 0) {
    const id = queue.shift()!;
    // 被删的实体没有下游：它的下游要么同批被删（本来就在 seed 里），要么根本不引用它
    if (doc.get(id) === undefined) continue;
    for (const dependent of dependentsOf(doc, id)) {
      if (!out.has(dependent)) {
        out.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return out;
}
```

`dependentsOf` 里那句 `mustExist` 会抛，所以上面那个 `continue` 必须先于它 —— 这正是 Step 6 第 2 条变异要盯的一行。

`packages/core/src/index.ts` 在 `export * from './geom/opening';` 之后加一行（现在加，别等 Step 5：Step 3 的测试文件要能 import 到这个模块）：

```ts
export * from './spatial/index';
```

```bash
pnpm vitest run packages/core/test/spatial.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -8
```

Expected: 10 passed。这一步必须绿，Step 3 才有红可看；如果这里就是红的（`does not provide an export named ...`），说明 Step 1 的 import 表里混进了索引符号。

- [ ] **Step 3: 写失败的测试（`SpatialIndex`）**

同一个文件追加。先把名字补进 import：`@dajia/core` 那一大格里按字母序加 `SpatialIndex`（放在 `Document` 之后）与 `deriveWallQuads`（放在 `columnCreate` 之后）；`MISSING` 这条常量在 Step 1 就声明了，本步第一条用例是它第一个用户。

```ts
/**
 * 暴力遍历：直接吃 Task 5 的轮廓与 Task 6 的洞口表算盒子，不看网格。
 * 它验的是**分桶**有没有漏、有没有多，不是盒子本身（盒子由 Task 5 / 本任务前面几条验）。
 */
function bruteForce(doc: Document, storeyId: string, rect: Aabb): string[] {
  const hits = new Set<string>();
  for (const quad of deriveWallQuads(doc)) {
    const entity = doc.get(quad.wallId);
    // 用 kind 收窄，不用 as WallEntity：本计划里读实体一律走判别式（Task 8 Step 7 查的就是这个）
    if (!entity || entity.kind !== 'wall' || entity.storeyId !== storeyId) continue;
    if (aabbIntersects(aabbOfPoints(quad.corners), rect)) hits.add(quad.wallId);
  }
  for (const wall of doc.byKind('wall')) {
    if (wall.storeyId !== storeyId) continue;
    const axis = wallAxisById(doc, wall.id);
    for (const span of openingSpans(doc, wall)) {
      if (aabbIntersects(openingAabb(axis, span), rect)) hits.add(span.openingId);
    }
  }
  return [...hits].sort();
}

const PROBES: Aabb[] = [
  { minX: -9000, minY: -9000, maxX: 9000, maxY: 9000 },
  { minX: 3601, minY: -119, maxX: 3719, maxY: -1 },
  { minX: 3540, minY: -60, maxX: 3660, maxY: 60 },
  { minX: 100, minY: 1000, maxX: 200, maxY: 1100 },
  { minX: 0, minY: -130, maxX: 100, maxY: -121 },
  { minX: 2000, minY: -1, maxX: 2900, maxY: 1 },
  { minX: 3481, minY: 2380, maxX: 3599, maxY: 2401 },
  { minX: -3600, minY: -120, maxX: -3599, maxY: 120 },
  // 第 9 条是**恰好共边**：minX 3720 就是 A 与 B 盒子的右边界。
  // 没有它，把 aabbIntersects 的 <= 改成 < 也能全绿 —— 闭区间这件事就成了空测试。
  { minX: 3720, minY: -119, maxX: 3800, maxY: 119 },
];

describe('SpatialIndex.fromDoc 与 query', () => {
  it('只收本层的墙与洞口；楼层 id 不存在当场抛', () => {
    const { log, storeyId, first, second, win, door } = lCornerWithOpenings();
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    const upper = storeyByIndex(log, 1);
    log.dispatch(
      wallCreate({
        storeyId: upper,
        start: { x: 0, y: 0 },
        end: { x: 3600, y: 0 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    );
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    expect([...index.snapshot().map((e) => e.id)].sort()).toEqual(
      [first.id, second.id, win.id, door.id].sort(),
    );
    expect(index.size).toBe(4);
    expect(() => SpatialIndex.fromDoc(log.document, MISSING)).toThrow(/楼层 不存在/);
  });

  it('query 与暴力遍历在 9 个探针矩形上逐条一致', () => {
    const { log, storeyId } = lCornerWithOpenings();
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    for (const rect of PROBES) {
      expect(index.query(rect)).toEqual(bruteForce(log.document, storeyId, rect));
    }
    // 反证：探针不是恒空的。6 条非空（第 1/2/3/6/7/9 条），3 条真空 ——
    // 全空的话上面那九次比对可以绿着什么都不验
    expect(index.query(PROBES[8]!).length).toBeGreaterThan(0);
    expect(PROBES.filter((rect) => index.query(rect).length > 0).length).toBe(6);
  });

  it('queryPoint：墙身内、洞口内、墙外空档各得其所', () => {
    const { log, storeyId, first, second, win, door } = lCornerWithOpenings();
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    // (1000, 0) 在 A 的墙身里，窗在 2000–2900，所以只有 A
    expect(index.queryPoint(1000, 0)).toEqual([first.id]);
    // (2500, 0) 同时在 A 与窗的盒子里：洞口先于宿主墙被点是常识，但两者都该在
    expect(index.queryPoint(2500, 0).sort()).toEqual([first.id, win.id].sort());
    // (3600, 2000) 在 B 的盒子里（A 的 y 到 ±120 为止），同时也在 B 上那樘门的盒子里
    // （门沿轴 1400–2300、横向 ±120）：宿主墙与门一起报，正是拾取要的那一对候选
    expect(index.queryPoint(3600, 2000).sort()).toEqual([second.id, door.id].sort());
    // 只要 B 一家的话取 y 500：门从 1400 才起，A 与窗都到不了这里
    expect(index.queryPoint(3600, 500)).toEqual([second.id]);
    // **多报**方向的现场（query 文档注释里第 2 条来源）：(3700, 100) 在 A 的盒子里
    // （A 的框 x[0,3720] × y[-120,120]），却不在 A 的梯形材料里 —— A 那端的斜切边过
    // (3480, 120) 与 (3720, -120)，即 x = 3600 - y，所以 y=100 那一行 A 只到 x=3500。
    // 那一格实际是 B 的材料（B 的框 x[3480,3720]，同一条斜切边，它覆盖 y ≥ 3600 - x）。
    // AABB 层分不开共角的这两面墙，故 A 在这里是合法的保守候选：宁多不漏，
    // 精确命中（点在不在这个梯形里）归 scene-2d（计划 3，本计划还没有那一层）。
    expect(index.queryPoint(3700, 100).sort()).toEqual([first.id, second.id].sort());
    expect(index.queryPoint(500000, 500000)).toEqual([]);
  });

  it('墙框来自斜切后的梯形：共角那端超出轴线端点，超出那段仍命中', () => {
    const { log, storeyId, first, second } = lCorner();
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    const box = index.entryOf(first.id)?.aabb;
    if (!box) throw new Error('索引里找不到 A');
    // corner 的 trim 是 (+120, -120)：一侧内退 120，另一侧外伸 120 → 框宽 3720。
    // 这里把 3720 钉死（不只看"大于 3600"）：下面那个 query 的右边界是从 box.maxX 反推的，
    // 一个"错得自洽"的梯形（Task 5 才抓得住的病）在本文件里不能两条都绿。
    expect(box.maxX).toBe(3720);
    expect(box.minX).toBe(0);
    // 外伸那段（x > 3600）落在 A 的盒子里，网格在那里也必须报出 A：A 的轴线端点在 3600，
    // 盒子却到 3720，这一问盯的就是"漏报"（Step 6 第 4 条变异红在这里）。
    // B 自己的盒子是 x[3480,3720] × y[-120,2400]，把整个外伸方块盖住了，
    // 所以这一问在这副夹具里必然两家一起中 —— 单独只要 A 的矩形问不出来。
    expect(index.query({ minX: 3601, minY: -120, maxX: box.maxX - 1, maxY: 120 }).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    // 孤墙没有这个外伸：同一条墙拆掉邻墙之后，框回到 3600（「删一面墙」那条靠这个差别）
  });

  it('条目形状：墙 dependsOn 两个端点，洞口 dependsOn 宿主墙 + 那两个端点', () => {
    const { log, storeyId, first, win } = lCornerWithOpenings();
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    const wallEntry = index.entryOf(first.id);
    if (!wallEntry) throw new Error('索引里找不到 A');
    expect(wallEntry.kind).toBe('wall');
    expect(wallEntry.dependsOn).toEqual([first.startId, first.endId]);
    const openingEntry = index.entryOf(win.id);
    if (!openingEntry) throw new Error('索引里找不到那樘窗');
    expect(openingEntry.kind).toBe('opening');
    expect(openingEntry.dependsOn).toEqual([first.id, first.startId, first.endId]);
    // 宿主墙 id 必须在 dependsOn 里：拖端点带动洞口重算，靠的就是这条反向边
    expect(openingEntry.dependsOn).toContain(first.id);
    // 洞口盒子不随接头变化：A 的共角端被斜掉 120，窗盒仍从 2000 起到 2900
    expect(openingEntry.aabb).toEqual({ minX: 2000, minY: -120, maxX: 2900, maxY: 120 });
  });

  it('cellVisits 只数局部：12 面墙排一列，小窗口落在 2 个格子里', () => {
    const { log, storeyId, walls } = wallRow(12);
    const index = SpatialIndex.fromDoc(log.document, storeyId, { cellSizeMm: 4000 });
    const rect: Aabb = { minX: 8100, minY: -50, maxX: 8200, maxY: 50 };
    expect(index.size).toBe(12);
    expect(index.cellVisits(rect)).toBe(2);
    expect(index.query(rect)).toEqual([walls[2]!.id]);
  });

  it('非有限或上下界颠倒的矩形 → 抛（不许把 Infinity 当"无限大的窗口"）', () => {
    const { log, storeyId } = lCorner();
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    expect(() => index.query({ minX: -Infinity, minY: 0, maxX: 0, maxY: 0 })).toThrow(/有限数/);
    expect(() => index.query({ minX: 100, minY: 0, maxX: 50, maxY: 0 })).toThrow(/上下界颠倒/);
    expect(() => SpatialIndex.fromDoc(log.document, storeyId, { cellSizeMm: 0 })).toThrow(
      /网格边长/,
    );
  });
});

describe('SpatialIndex.applyAffected', () => {
  /** 局部重建之后必须与整层重建逐条相等 —— 本任务唯一的硬指标。 */
  function expectSame(index: SpatialIndex, doc: Document, storeyId: string): void {
    expect(index.snapshot()).toEqual(SpatialIndex.fromDoc(doc, storeyId, {}).snapshot());
  }

  it('拖拐角：affected 只有那个点与被夹的门，索引里两墙两洞口都换过', () => {
    const { log, storeyId, sharedId, first, second, win, door } = lCornerWithOpenings();
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    const before = index.entryOf(first.id)!.aabb;
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 1200 }));
    expect([...log.affected].sort()).toEqual([sharedId, door.id].sort());
    index.applyAffected(log.document, log.affected);
    expectSame(index, log.document, storeyId);
    // 两面墙都动了：A 变斜、B 变短，盒子不可能原地不动。
    // 比整盒而不比单个分量：A 的外伸角是斜切后的外侧面与 B 的外侧面 x=3720 的交点，
    // 拖之前拖之后都仍贴在那条竖直线上（实测 maxX 两回都是 3720），
    // 真正变了的是 minX（0 → -37.947…）、minY（-120 → -113.842…）、maxY（120 → 1286.491…）。
    expect(index.entryOf(first.id)!.aabb).not.toEqual(before);
    // 拖完之后 (2300, 750) 同时落在 A 的新盒子与那樘窗的盒子里；拖之前那是墙外的空档
    expect(index.queryPoint(2300, 750).sort()).toEqual([first.id, win.id].sort());
    // 而 (1000, 0) 只剩 A 一家：窗沿轴 2000–2900 才起，B 与门都在 x 3480 之外
    expect(index.queryPoint(1000, 0)).toEqual([first.id]);
    // B 的下边界从 -120 抬到 1000 以上（共享端点被拖走，旧盒子留不住这个数）。
    // 阈值取 500 不取 1033：这个数由 Task 4 的任意角斜切公式算出来，测试不该把它的
    // 小数位钉死 —— 钉"抬起来了"这个方向就够，钉"抬到哪一毫米"是 Task 4 的事。
    expect(index.entryOf(second.id)?.aabb.minY).toBeGreaterThan(500);
  });

  it('删一面墙：邻墙的接头从 corner 变 free，它的框必须跟着换', () => {
    const { log, storeyId, first, second } = lCorner();
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    const wideBefore = index.entryOf(first.id)!.aabb;
    expect(wideBefore.maxX - wideBefore.minX).toBeGreaterThan(3600);
    log.dispatch(wallDelete({ wallId: second.id }));
    index.applyAffected(log.document, log.affected);
    const after = index.entryOf(first.id)!.aabb;
    // free 端 trim 为 0 → 梯形变矩形，宽恰好等于轴长。这条断言与上一条配对，
    // 才能证明"局部重建真的动了 A"，而不是索引一直没碰它
    expect(after.maxX - after.minX).toBe(3600);
    expect(index.entryOf(second.id)).toBeUndefined();
    expectSame(index, log.document, storeyId);
  });

  it('改一面墙的墙厚：共角的另一面墙也在脏集合里（doc 的反向依赖给不出这条边）', () => {
    const { log, storeyId, first, second } = lCorner();
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    const neighbourBefore = index.entryOf(second.id)!.aabb;
    // 真源闭包只到"这面墙 + 它身上的洞口"：邻墙不在里面
    expect(expandAffected(log.document, new Set([first.id])).has(second.id)).toBe(false);
    log.dispatch(wallSetThickness({ wallId: first.id, thicknessMm: 300 }));
    index.applyAffected(log.document, log.affected);
    expect(index.entryOf(second.id)!.aabb).not.toEqual(neighbourBefore);
    expectSame(index, log.document, storeyId);
  });

  it('新建的墙复用既有端点：邻墙那端从 free 变 corner，它的框必须跟着换', () => {
    // C1 的回归。先只有一面孤立横墙（两端 free）并据此建好索引，然后**在它那个端点上接着画**
    // 一面竖墙 —— 画房间最普通的动作，计划 3 每一条画墙命令都会走到这里。
    const { log, storeyId, wall: first } = straightWall();
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    const sharedId = first.endId;
    expect(index.entryOf(first.id)!.aabb).toEqual({ minX: 0, minY: -120, maxX: 3600, maxY: 120 });
    const second = addWall(log, {
      start: { pointId: sharedId },
      end: { x: 3600, y: 2400 },
      thicknessMm: 240,
    });
    // 根因两条，写成断言钉住：复用 {pointId} 时 wallCreate 连那个点都不 upsert，
    // 共享点因此不在 affected 里；而新墙此刻还没有 IndexEntry，它两端那两条边谁都不认识。
    expect(log.affected.has(second.id)).toBe(true);
    expect(log.affected.has(sharedId)).toBe(false);
    index.applyAffected(log.document, log.affected);
    expectSame(index, log.document, storeyId);
    // 邻墙 A 的框从矩形变梯形（maxX 3600 → 3720），与 lCorner 夹具的实测值同一个数
    expect(index.entryOf(first.id)!.aabb).toEqual({ minX: 0, minY: -120, maxX: 3720, maxY: 120 });
    expect(index.entryOf(second.id)!.aabb).toEqual({
      minX: 3480,
      minY: -120,
      maxX: 3720,
      maxY: 2400,
    });
  });

  it('在两个既有端点之间合上一间房：affected 只有新墙，两侧邻墙都得重算', () => {
    // C1 最坏的变体：三边已画好的房间，最后那一面墙两端**都**复用既有点，
    // 补丁里连一个新点都没有 → affected 就只有一个新墙 id。
    const { log, storeyId, wall: first } = straightWall();
    const second = addWall(log, {
      start: { pointId: first.endId },
      end: { x: 3600, y: 2400 },
      thicknessMm: 240,
    });
    const third = addWall(log, {
      start: { pointId: second.endId },
      end: { x: 0, y: 2400 },
      thicknessMm: 240,
    });
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    // 合房之前：A 与 C 各有一个 free 端（x=0 那一头），框到 0 为止
    expect(index.entryOf(first.id)!.aabb).toEqual({ minX: 0, minY: -120, maxX: 3720, maxY: 120 });
    expect(index.entryOf(third.id)!.aabb).toEqual({ minX: 0, minY: 2280, maxX: 3720, maxY: 2520 });
    const closing = addWall(log, {
      start: { pointId: third.endId },
      end: { pointId: first.startId },
      thicknessMm: 240,
    });
    expect([...log.affected]).toEqual([closing.id]);
    index.applyAffected(log.document, log.affected);
    expectSame(index, log.document, storeyId);
    // 两侧邻墙的两个 free 端同时变成 corner：0 那一头越过共享点外伸 120（-120 = 半厚），
    // 3720 那一头本来就在角上，不动。这两个数是这次重建的凭据，不是 expectSame 的副产品
    expect(index.entryOf(first.id)!.aabb).toEqual({
      minX: -120,
      minY: -120,
      maxX: 3720,
      maxY: 120,
    });
    expect(index.entryOf(third.id)!.aabb).toEqual({
      minX: -120,
      minY: 2280,
      maxX: 3720,
      maxY: 2520,
    });
  });

  it('与本层无关的 id 是空操作：柱、别层的墙与点都不动索引', () => {
    const { log, storeyId, first } = lCorner();
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    const upper = storeyByIndex(log, 1);
    log.dispatch(
      wallCreate({
        storeyId: upper,
        start: { x: 0, y: 0 },
        end: { x: 3600, y: 0 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    );
    const upperWall = lastWall(log);
    log.dispatch(
      columnCreate({ storeyId, at: { pointId: first.startId }, widthMm: 400, depthMm: 400 }),
    );
    const column = idOfKind(log, 'column');
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    const snapshot = index.snapshot();
    // 本层的柱：进了脏闭包，但它不入索引 → remove 是空操作
    index.applyAffected(log.document, new Set([column]));
    // 别层的楼层 id：闭包把它那面墙带进来，墙不属于本层 → 同样空操作
    index.applyAffected(log.document, new Set([upper]));
    // 别层墙的一个端点：连"本层"这道门都进不来
    index.applyAffected(log.document, new Set([upperWall.startId]));
    // 文档里根本没有的 id：不抛，也不动
    index.applyAffected(log.document, new Set([MISSING]));
    expect(index.snapshot()).toEqual(snapshot);
    expect(index.size).toBe(2);
  });

  it('undo / redo 回放：每一步之后的局部重建都与整层重建相等', () => {
    const { log, storeyId, first } = lCornerWithOpenings();
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    expectSame(index, log.document, storeyId);
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 1200 }));
    index.applyAffected(log.document, log.affected);
    expectSame(index, log.document, storeyId);
    expect(log.undo()).toBe(true);
    index.applyAffected(log.document, log.affected);
    expectSame(index, log.document, storeyId);
    expect(log.redo()).toBe(true);
    index.applyAffected(log.document, log.affected);
    expectSame(index, log.document, storeyId);
  });
});
```

7 + 7 = 14 条，连 Step 1 的 10 条共 24 条。四处要点：

- `expectSame` 是本任务的脊柱，`snapshot()` 必须可比（条目按 id 升序、字段全是值语义）。八处调用它，覆盖拖拽 / 删除 / 改厚 / 新建复用端点 / 合房 / 回放六条路径（回放那条一次调四处：undo、redo、再 undo、redo）。
- 「删一面墙」的两条断言是**配对**的：`toBeGreaterThan(3600)` 与 `toBe(3600)`。只写 `expectSame` 的话，一个"什么都不重建"的实现也能过（因为测试里从没要求旧盒子是错的）。
- 「改墙厚」那条先 `expect(expandAffected(...).has(second.id)).toBe(false)`，把"真源闭包不够"这件事写成断言。将来谁把 `dependentsOf` 扩成"墙 → 共角墙"，这条会红并提醒他重新读一遍这里的取舍。
- 最后两条（「新建的墙复用既有端点」「合上一间房」）是**修复轮 1 补的回归**，盯的是同一类缺陷的两个变体：`wallCreate` 复用 `{pointId}` 时既不 upsert 那个点、新墙自己又没有条目，于是"邻墙那端从 free 变 corner"这件事在 `affected` 里和旧条目里**都查不到**。两条各钉一个 `affected` 口径（`has(sharedId) === false` / `[...affected] === [closing.id]`）和一组邻墙盒子的具体数字（3600 → 3720、0 → −120），因为 `expectSame` 单独担不起：整层重建与局部重建可以一起错。裁决见本节末尾「Task 9 执行回填」第 3 条。

- [ ] **Step 4: 实现 `SpatialIndex`**

同一个文件追加。先把 Step 2 那份文件头补全（下面是**完整**的 import 表，不是增量，替换掉原来那五行即可）：

```ts
import type { EntityId } from '../ids';
import { assertMm } from '../units/mm';
import type { Document } from '../model/document';
import type { Entity, OpeningEntity, WallEntity } from '../model/entity';
import { mustExist, requireWall } from '../model/read';
import { dependentsOf } from '../geom/topology';
import { deriveJoints, memberTrim, type Joint } from '../geom/joint';
import { wallAxis, wallAxisById, type WallAxis } from '../geom/axis';
import { advance, type Vec2 } from '../geom/vec';
import { wallQuad } from '../geom/outline';
import { openingSpans, type OpeningSpan } from '../geom/opening';
```

（`assertMm` 被 `assertCellSize` 用掉，`mustExist` 被 `rebuild` 用掉 —— 少一个 `noUnusedLocals` 就红一条，别提前也别漏。）

```ts
export type IndexedKind = 'wall' | 'opening';

/**
 * 一条索引记录。dependsOn 是"这个盒子由哪些 id 决定"：
 * 墙 = 两个端点；洞口 = 宿主墙 + 那两个端点。局部重建的反向闭包靠它，
 * 因为"两墙共享端点"这条边不在真源的引用关系里（见 expandAffected 的注释）。
 */
export interface IndexEntry {
  readonly id: EntityId;
  readonly kind: IndexedKind;
  readonly aabb: Aabb;
  readonly dependsOn: readonly EntityId[];
}

/**
 * 一面墙的盒子由哪些 id 决定。条目的 dependsOn 与局部重建的脏闭包**共用这一份定义**：
 * 各写一遍迟早漂，而漂的方向是"少给一条边"→ 少重建 → 计划 3 点不动。
 */
function wallDeps(wall: WallEntity): readonly EntityId[] {
  return [wall.startId, wall.endId];
}

/** 一樘洞口的盒子由哪些 id 决定：宿主墙 + 宿主墙那两个端点（端点口径上面那份，不重抄）。 */
function openingDeps(host: WallEntity): readonly EntityId[] {
  return [host.id, ...wallDeps(host)];
}

/**
 * 从**实体**现取依赖边。唯一的用户是 dirtyIds 的第 2 步回落：刚建成的构件此刻还没有条目，
 * 它两端挂着的既有邻墙于是没人认领（这就是邻墙盒子发霉的那条路）。
 * point / column / slab 没有盒子，返空 —— 它们的下游本来就走 expandAffected。
 * 洞口的宿主墙查不到、或查到了却不是墙时只回 [hostWallId]：这不是兜底，边照走，
 * 病态文档随后在 openingEntry 里由 requireWall / openingSpans 抛，
 * 抛错的那一步仍然只有一处（脏闭包不该比盒子派生更严格）。
 */
function entityDeps(doc: Document, entity: Entity): readonly EntityId[] {
  if (entity.kind === 'wall') return wallDeps(entity);
  if (entity.kind === 'opening') {
    const host = doc.get(entity.hostWallId);
    return host?.kind === 'wall' ? openingDeps(host) : [entity.hostWallId];
  }
  return [];
}

export interface SpatialIndexOptions {
  readonly cellSizeMm?: number;
}

const DEFAULT_CELL_SIZE_MM = 4000;

function assertCellSize(value: number): number {
  // 网格边长也走 assertMm：整数毫米，免得浮点渗进 cell key（key 一变，插进去的盒子就找不回来了）
  const mm = assertMm(value, '网格边长');
  if (mm <= 0) throw new RangeError(`网格边长必须为正，收到 ${mm}`);
  return mm;
}

function assertQueryable(rect: Aabb): void {
  if (
    !Number.isFinite(rect.minX) ||
    !Number.isFinite(rect.minY) ||
    !Number.isFinite(rect.maxX) ||
    !Number.isFinite(rect.maxY)
  ) {
    throw new RangeError(`查询矩形必须是有限数，收到 ${JSON.stringify(rect)}`);
  }
  if (rect.minX > rect.maxX || rect.minY > rect.maxY) {
    throw new RangeError(
      `查询矩形上下界颠倒：(${rect.minX}, ${rect.minY})–(${rect.maxX}, ${rect.maxY})`,
    );
  }
}

/**
 * 一层的 AABB 均匀网格。spec 第 9 节：command 后只重建受影响节点局部。
 *
 * "局部"的确切口径（别对外吹）：**盒子只为脏条目重算，网格只为脏条目重挂**。
 * 接头表一次派生**整个文档** —— `deriveJoints(doc)` 吃的是 doc，不看 storeyId：
 * 斜切量是全局性质（Task 4），一面墙的两端各被别的墙牵着，没有"只重算这一段"的合法做法。
 * 两条后果都是明账：① 一层的重建是 O(全档墙数)而不是 O(本层墙数)；
 * ② 别层一个非法接头（同点同向重叠、带台阶的直通、极小夹角翻面、星形交点）会让本层
 * 这次重建直接抛 —— 与"内部不变式破了就抛、绝不兜底"的口径一致，整层重建同样抛，
 * 所以这是作用域的账，不是正确性缺口。
 */
export class SpatialIndex {
  private readonly storeyId: EntityId;
  private readonly cellSizeMm: number;
  private readonly entries = new Map<EntityId, IndexEntry>();
  private readonly cells = new Map<string, Set<EntityId>>();

  private constructor(storeyId: EntityId, cellSizeMm: number) {
    this.storeyId = storeyId;
    this.cellSizeMm = cellSizeMm;
  }

  static fromDoc(
    doc: Document,
    storeyId: EntityId,
    options: SpatialIndexOptions = {},
  ): SpatialIndex {
    const index = new SpatialIndex(
      storeyId,
      assertCellSize(options.cellSizeMm ?? DEFAULT_CELL_SIZE_MM),
    );
    index.rebuild(doc);
    return index;
  }

  get size(): number {
    return this.entries.size;
  }

  /** 按 id 升序的条目快照：测试用它比对局部重建与整层重建，计划 3 用它做调试面板。 */
  snapshot(): readonly IndexEntry[] {
    return [...this.entries.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  entryOf(id: EntityId): IndexEntry | undefined {
    return this.entries.get(id);
  }

  rebuild(doc: Document): void {
    // 楼层不存在就别往下建：不查这一句，fromDoc(doc, 乱写的 id) 会静默建成一个空索引，
    // 而空索引在 query 里和"这层真的没有墙"长得一模一样 —— 计划 3 的症状是点不动，查不到根因
    mustExist(doc, this.storeyId, '楼层');
    this.clear();
    const joints = deriveJoints(doc);
    for (const wall of doc.byKind('wall')) {
      if (wall.storeyId === this.storeyId) this.insert(this.wallEntry(doc, wall, joints));
    }
    for (const opening of doc.byKind('opening')) {
      if (opening.storeyId !== this.storeyId) continue;
      this.insert(this.openingEntry(doc, opening));
    }
  }

  applyAffected(doc: Document, affected: ReadonlySet<EntityId>): void {
    const dirty = this.dirtyIds(doc, affected);
    if (dirty.size === 0) return;
    let joints: readonly Joint[] | null = null;
    // id 升序遍历：同一批脏条目里先墙后洞口的顺序会影响 Map 的插入序，
    // 排序之后 snapshot() 的比对不受 dispatch 顺序影响（契约：派生层按 id 升序）
    for (const id of [...dirty].sort()) {
      const entity = doc.get(id);
      if (!entity || entity.kind === 'storey' || entity.storeyId !== this.storeyId) {
        this.remove(id);
        continue;
      }
      if (entity.kind === 'wall') {
        joints ??= deriveJoints(doc);
        this.insert(this.wallEntry(doc, entity, joints));
      } else if (entity.kind === 'opening') {
        this.insert(this.openingEntry(doc, entity));
      } else {
        // point / column / slab：本计划不入索引（Task 8 的非目标）， remove 是空操作
        this.remove(id);
      }
    }
  }

  /**
   * 矩形命中：返回的是**候选**，不是几何证明 —— AABB 相交 ≠ 几何相交。多报来自两处：
   *
   * 1. **洞口盒不带斜切**。它是「沿轴区间 × 墙厚」（见 `openingAabb`），而墙的两端被接头
   *    削成梯形，所以端头被斜掉的那块三角里仍会报出这樘洞口。方向仍安全：斜切只削墙的角、
   *    不削洞口，洞口盒恒真包含洞口本身（`openingAabb` 那条用例把 ±half 与 to-from=width
   *    两个边界都钉死了）。
   * 2. **墙盒是斜切后梯形的包围盒**，共角那一端的外伸方块会整块落进邻墙的盒子里：
   *    L 角上 A 的框是 x[0,3720]、B 的框是 x[3480,3720]×y[-120,2400]，A 越过轴线端点
   *    3600 的那一竖条其实全是 B 的材料 —— 这一问在 AABB 层面根本分不开共角的两面墙。
   *
   * 保守方向是**宁多不漏**：漏一个候选，计划 3 的症状就是"点了没反应"，根因却在几万行之外；
   * 多一个候选只是让上层白测一次。精确命中（点在不在这个梯形里、在不在这个洞口矩形里）
   * 归 `scene-2d`，本计划还没有那一层。
   */
  query(rect: Aabb): EntityId[] {
    assertQueryable(rect);
    const hits = new Set<EntityId>();
    for (const key of this.cellKeys(rect)) {
      for (const id of this.cells.get(key) ?? []) {
        const entry = this.entries.get(id);
        // 精筛：格子是粗的，落在同一格不等于盒子相交
        if (entry && aabbIntersects(entry.aabb, rect)) hits.add(id);
      }
    }
    return [...hits].sort();
  }

  queryPoint(x: number, y: number): EntityId[] {
    return this.query({ minX: x, minY: y, maxX: x, maxY: y });
  }

  /** 这个矩形会扫多少个格子。局部性的度量，也是 Step 6 第 4、5 条变异的靶子。 */
  cellVisits(rect: Aabb): number {
    assertQueryable(rect);
    return this.cellKeys(rect).length;
  }

  /**
   * 这个 id 的盒子由哪些 id 决定 —— **一条回落链，两个来源，顺序不能反**：
   * 1. 索引里还留着条目就用它。这既是**已删除**实体唯一的边来源（`doc.get(id)` 对它已是
   *    undefined，「删一面墙」那条全靠旧条目把共享端点带出来），也是本次重建那一刻之前
   *    那张真实生效的依赖图。
   * 2. 条目不存在而实体还活着，就从实体现取（`entityDeps`）。刚 `wallCreate` /
   *    `openingCreate` 出来的构件正是这一类：它自己还没有条目，两端却可能挂着既有邻墙。
   * 只走第 1 步会漏新建实体（邻墙盒子发霉），只走第 2 步会漏被删实体 —— 两步必须留在同一条
   * 回落链上、由 dirtyIds 里唯一的消费点取边；写成两次独立遍历的话，后者会悄悄替前者干活，
   * 变异检查（删掉那一行 for）也就再也红不起来了。
   */
  private dependsOnOf(doc: Document, id: EntityId): readonly EntityId[] {
    const entry = this.entries.get(id);
    if (entry) return entry.dependsOn;
    const entity = doc.get(id);
    return entity ? entityDeps(doc, entity) : [];
  }

  /**
   * 双向闭包：真源反向依赖（expandAffected）∪ 盒子的共享端点（dependsOnOf：条目优先、实体回落）。
   * 少了后半段，"删一面墙""改一面墙的墙厚""新建的墙复用既有端点""在既有端点之间合上一间房"
   * 四条都会留下发霉的邻墙盒子（实测：摘掉下面那行 for，红的正是这四条 + 拖拐角仍绿）。
   */
  private dirtyIds(doc: Document, affected: ReadonlySet<EntityId>): Set<EntityId> {
    const dirty = new Set<EntityId>();
    const queue: EntityId[] = [...affected];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (dirty.has(id)) continue;
      dirty.add(id);
      // 盒子的依赖边只有这一个产地（连"本次补丁里的新实体"一起走，见 dependsOnOf）。
      // "两墙共享端点"这条边不在真源的引用关系里，删掉这一行，四条邻墙发霉的用例同时红。
      for (const dep of this.dependsOnOf(doc, id)) queue.push(dep);
      for (const dependent of expandAffected(doc, new Set([id]))) {
        if (!dirty.has(dependent)) queue.push(dependent);
      }
    }
    return dirty;
  }

  private wallEntry(doc: Document, wall: WallEntity, joints: readonly Joint[]): IndexEntry {
    const axis = wallAxis(doc, wall);
    const quad = wallQuad(
      axis,
      memberTrim(joints, wall.id, 'start'),
      memberTrim(joints, wall.id, 'end'),
    );
    return {
      id: wall.id,
      kind: 'wall',
      aabb: aabbOfPoints(quad.corners),
      dependsOn: wallDeps(wall),
    };
  }

  private openingEntry(doc: Document, opening: OpeningEntity): IndexEntry {
    const wall = requireWall(doc, opening.hostWallId);
    // 区间只有一份口径：走 openingSpans，顺带把它内建的「洞口与宿主墙同层」检查也用了。
    // 自己拼 distanceMm + widthMm 更短，但那条楼层检查就会成为索引独缺的一道守卫。
    const span = openingSpans(doc, wall).find((s) => s.openingId === opening.id);
    if (!span) throw new TypeError(`洞口 ${opening.id} 在宿主墙 ${wall.id} 上派生不出区间`);
    return {
      id: opening.id,
      kind: 'opening',
      aabb: openingAabb(wallAxisById(doc, wall.id), span),
      dependsOn: openingDeps(wall),
    };
  }

  private cellKeys(rect: Aabb): string[] {
    const x0 = Math.floor(rect.minX / this.cellSizeMm);
    const x1 = Math.floor(rect.maxX / this.cellSizeMm);
    const y0 = Math.floor(rect.minY / this.cellSizeMm);
    const y1 = Math.floor(rect.maxY / this.cellSizeMm);
    const keys: string[] = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) keys.push(`${cx},${cy}`);
    }
    return keys;
  }

  private insert(entry: IndexEntry): void {
    // 这一句是承重的，别当"顺手简化掉"的候选：盒子挪过之后旧格子里那个 id 不会自己消失，
    // 不先 remove 就永远留着 —— `cells` 只增不减，扫得越来越宽（内存与扫描成本，不是错答案）。
    // 之所以**没有测试钉得住它**：这件事公开 API 看不见。幽灵成员既不会多报（下面 `query`
    // 那条精筛用的是**当前** entries 里的盒子，共格条件恰好保证真相交的条目必在矩形所扫的
    // 某一格里）也不会漏报（insert 与 query 同一个 cellKeys），而 snapshot/size/entryOf/
    // cellVisits 都不读桶内容。变异检查实测 0 红 ⇒ 等价变异（brief Step 6 第 6 条预测
    // "expectSame 红"是错的）；将来若给同格子加"按插入序"的优化，它就变成可观察量，届时
    // 只能加一个只读格子访问器来钉 —— 那得等到真需要它的任务，别为了这条注释先造旁路表。
    this.remove(entry.id);
    this.entries.set(entry.id, entry);
    for (const key of this.cellKeys(entry.aabb)) {
      const bucket = this.cells.get(key);
      if (bucket) bucket.add(entry.id);
      else this.cells.set(key, new Set([entry.id]));
    }
  }

  private remove(id: EntityId): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    for (const key of this.cellKeys(entry.aabb)) {
      const bucket = this.cells.get(key);
      if (!bucket) continue;
      bucket.delete(id);
      if (bucket.size === 0) this.cells.delete(key);
    }
  }

  private clear(): void {
    this.entries.clear();
    this.cells.clear();
  }
}
```

四处解释，都是会被 review 追问的：

- `dirtyIds` 里对每个 id 现调 `expandAffected(doc, new Set([id]))`，看着浪费，其实要的是"从这个 id 出发的真源闭包"，而外层队列已经做了跨 id 的去重。要省这一步就把 `dependentsOf` 摊开自己写一遍 —— 那才是真的重复（"校验只有一份"，Task 6 立的规矩）。
- `entity.storeyId` 之前必须先排除 `kind === 'storey'`：`StoreyEntity` 没有 `storeyId` 字段，联合类型上直接读会编不过。这一行不是风格问题。
- **依赖边只有一条回落链**（`dependsOnOf`：先查条目、查不到再从实体现取），且 `dirtyIds` 里只有它一个消费点。两步缺任何一步都会漏：只走条目 ⇒ 刚建成的构件自己没条目，它两端的既有邻墙没人认领（「新建的墙复用既有端点」「合上一间房」两条红）；只走实体 ⇒ 被删的实体在 `doc` 里已经是 `undefined`，它的旧边再也拿不到（「删一面墙」红）。写成两次独立遍历更糟：后者会悄悄替前者干活，Step 6 第 1 条变异也就再也红不起来了。
- `applyAffected` 里 `[...dirty].sort()`：**今天它不影响任何可观察结果** —— `insert` 先 `remove`，`snapshot()` 自己按 id 排序，`query` 也排序，所以先重建谁后重建谁结果一样。仍然排序，是要把"重建顺序跟着 `affected` 这个 Set 的插入序漂移"这件事关在门外：`affected` 的顺序来自命令实现（Task 3 就改过一次），哪天有人拿它打日志、做增量统计，或给 `insert` 加一条"同格子内按插入序排"的优化，这里不会突然变成隐式契约。别把它读成正确性所需 —— Step 6 第 10 条把 `.sort()` 删掉，实测**一条都不红**，这就是上面那句话的凭据。第 6 条（`insert` 去掉开头的 `remove`）实测同样 0 红，但它与第 10 条不是一回事：那条变异确实改了东西（旧格子里留下幽灵 id，`cells` 只增不减），只是**公开 API 看不见**，所以它是**性能纪律**而不是正确性纪律 —— 两处代码注释里各写了这笔账。原 brief 预言第 6 条会让 `expectSame` 红，那是错的，见 Step 6 与「Task 9 执行回填」第 5 条。

- [ ] **Step 5: 全绿**

导出行在 Step 2 就加过了（`export * from './spatial/index';`，位置在 `export * from './geom/opening';` 之后）。本步只跑闸门：

```bash
pnpm typecheck 2>&1 | tail -5
pnpm vitest run packages/core/test/spatial.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -12
pnpm verify 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -5
```

Expected: `spatial.test.ts` 24 passed（expandAffected 7 + Aabb 3 + fromDoc/query 7 + applyAffected 7）。`pnpm verify` = Task 8 的 234 + 24 = 258 passed，0 失败。`lint:deps` 不该有新的话要讲：`spatial/index.ts` 只 import `core` 内部模块，包依赖方向没动。

- [ ] **Step 6: 变异检查（防"测试考的是空气"）**

十处逐个改、逐个还原，每次 `git diff` 必须回到空：

1. `dirtyIds` 里删掉整条边遍历 `for (const dep of this.dependsOnOf(doc, id)) queue.push(dep);` → Expected: **「删一面墙」「改一面墙的墙厚」「新建的墙复用既有端点」「在两个既有端点之间合上一间房」四条同时红**，「拖拐角」仍绿（那个补丁的入口是点，真源闭包已经够）。这就是双向闭包不是多余设计的证据。
   （**原文这条指的是 `if (entry) for (const dep of entry.dependsOn) …`、红名单只有两条** —— 修复轮 1 把那行换成了回落链（见上一条解释的第 3 点），红名单随代码形状一起长。实测红点：`删一面墙` 红在 `expected 3720 to be 3600`，`改墙厚` 红在邻墙盒原地不动，两条 C1 回归各红在自己的 `expectSame`。）
2. `expandAffected` 里删掉 `if (doc.get(id) === undefined) continue;` → Expected: 「已经不在文档里的 id 当 seed」红（`dependentsOf` 的 `mustExist` 抛「实体 不存在」）。**实测还多红两条**：「删一面墙」（`applyAffected → dirtyIds` 对每个 affected id 也调 `expandAffected`，那个已删除的墙 id 当场抛）与「与本层无关的 id 是空操作」（红在 `MISSING`）。同一道守卫在两层各有一个入口，一条 `continue` 守两处。
3. `aabbIntersects` 的两处 `<=` 改成 `<` → Expected: 「aabbIntersects 用闭区间」红 **且**「query 与暴力遍历在 9 个探针矩形上逐条一致」红，但红的**不是**那九次 `toEqual`：`bruteForce` 与 `query` 吃的是同一个被改坏的函数，两边一起错、比对照样绿。红的是那两条反证（第 9 条探针必须非空 + 非空探针恰好 6 条）。这条变异就是"oracle 与实现同源 ⇒ 测不出东西"的现场教材，也正是那两条反证存在的全部理由。
4. `cellKeys` 里 x 下界那一行 `Math.floor(rect.minX / ...)` 改成 `Math.ceil(...)`（只改这一处）→ Expected: 「query 与暴力遍历」红（`bruteForce` 不看格子，漏报当场露出来：第 2/3/9 条探针那类贴着格边的盒子查不到），「墙框来自斜切后的梯形」的 `query({minX: 3601, ...})` 跟着红。
   **别把这条换成"`Math.floor` 改 `Math.round`"** —— 那不是一个 bug：`round` 只是把格线从 4000 的整数倍挪到奇数倍，仍然是一个单调的平面划分，insert 与 query 用同一个 key 函数就仍然不漏，唯一变的是 `cellVisits` 的数。写变异要挑"改了就会错"的那一处，不要挑"改了只是不一样"的那一处，否则测试红了也不知道该改代码还是改测试。
5. `query` 去掉 `aabbIntersects` 精筛（整个格子直接报候选）→ Expected: 「query 与暴力遍历」红（同格不同盒，多报）。这条变异说明精筛不是装饰。
6. `insert` 去掉开头的 `this.remove(entry.id)` → **实测 0 红（24 passed），是个等价变异**，原预言「`expectSame` 红（旧格子留下幽灵条目，query 多报）」不成立。两边都取证过（修复轮 1 在新代码形状上重跑，仍 0 红）：幽灵成员只可能让"格子成员集合"变大，而 `query` 报之前用**当前** `entry.aabb` 精筛 —— 真相交的条目必然已经挂在矩形所扫的某一格里（`cellKeys` 对 insert 与 query 同一个函数、闭区间一致），所以既不多报也不漏报；`snapshot()` / `size` / `entryOf` / `cellVisits` 都不读桶内容。它改的是内存与扫描成本（`cells` 里越拖越多的死 id），不是任何可观察结果。**这条变异保留在清单上**，因为它教的是"绿不等于测试有漏洞，先证明行为有没有变"（Global Constraints 的变异仪式第 2 条），而 `insert` 里那八行注释就是它的落地凭据；要把它变成可观察量，得先加一个只读的格子占用访问器 —— 那是为测试造旁路表，本任务不做。
7. `rebuild` 里删掉 `wall.storeyId === this.storeyId` 判断 → Expected: 「只收本层」红（`size` 与 `snapshot` 都对不上）。
8. `applyAffected` 里把 `entity.kind === 'opening'` 分支改成 `this.remove(id)`（洞口不重建，只删）→ Expected: 「拖拐角」与「undo/redo 回放」的 `expectSame` 红，「删一面墙」仍绿（那场所删的洞口本来就该消失）。
9. `rebuild` 里删掉首行的 `mustExist(doc, this.storeyId, '楼层')` → Expected: 「只收本层」的 `toThrow(/楼层 不存在/)` 红（空索引建出来了，一句都不抛）。这条盯的是"静默空索引"，与第 7 条盯的"收错层"是两种病。
10. `applyAffected` 里把 `[...dirty].sort()` 改成 `[...dirty]` → Expected: **一条都不红**（实测确认：0 红）。这不是漏写用例，是 Step 4 第四句解释的凭据：排序不是正确性所需，别让它长成一隐式契约。红了几条就说明上面那段话是编的，回去重写。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/spatial/index.ts packages/core/test/spatial.test.ts packages/core/src/index.ts
git commit -m "feat: AABB 均匀网格索引与受影响子集重建"
```

执行日志写在这里：24 条的实际结果、十处变异各红了哪些用例（第 10 条要写明"确实一条都没红"，它是那段解释的唯一凭据）、`PROBES` 里非空探针到底有几条、以及「改墙厚」那条实测的第二面墙 `aabb` 从什么变成什么（这个数只有跑出来才知道，写下来是给 Task 10 的"两层整合"当参照）。

**留给后续任务的钩子**：`IndexEntry.dependsOn` 是计划 3 做"高亮这面墙涉及哪些点"的现成材料，别另建一张表。`cellSizeMm` 是构造参数，计划 3 若按缩放级别换网格，接口不动。`storeySetElevation` 的脏集合 = 整层（测试 3 已钉），3D 侧 M1.7 拖动整层直接吃它。

#### Task 9 执行回填（2026-09-27，评审 + 修复轮 1 之后）

提交：`035878e`（实现，3 files / +888）→ `c2f9d29`（修复轮 1：C1 的依赖边回落链 + 两条回归用例 + 两处注释）→ `3219a4e`（注释订正）。
门禁落地态：`pnpm verify` = **258 passed / 21 files**（= Task 8 的 234 + 24；控制器在 `c2f9d29` 与 `3219a4e` 上各复跑一次，两次 exit=0）。
`spatial.test.ts` 落地 24 条 = expandAffected 7 + Aabb 助手 3 + `fromDoc`/query 7 + `applyAffected` **7**（简报写的 5）。
分支是 `plan2-geometry-invariants` 而不是 dispatch 里写的 `main`（起点 HEAD `34b1d0a` 与正文一致，所以按"不建分支、就地在当前检出上工作"执行）；`main` 至今仍是 `470109a`，**push 由用户本人执行**。

**与简报正文的偏离（全部已在上面正文就地订正，照抄本文件会得到落地态）**：

1. **`advance` 的导出方写错了**（Step 2 与 Step 4 两份 import 表，原 `:6136`、`:6486`）。`geom/axis.ts` 只是 `import { advance } from './vec'` 并在内部用，全文件没有 `export … advance`；导出方是 `geom/vec.ts:86`。照抄会在 Step 2 的 vitest 里 **ESM 链接期**就 `does not provide an export named 'advance'`，"前 10 条转绿"这句门槛话无从验起。裁决 Ruling ㊢：派发时带订正，评审后回填。
2. **三条测试期望与实测几何不符**，改成最小正确形式（用例名与条数一条没动，评审者独立闭式复算后认可）：
   ① `queryPoint(3600, 2000)` 简报写只回 B，实测**同时回 B 与那樘门**（门盒 x[3480,3720] × y[1400,2300]）—— 这一改反而把"宿主墙与门上洞口一起被报出"写成了断言，正是计划 3 拾取要的那一对候选；另加 `queryPoint(3600, 500)` 保住原本想问的"只在 B 一家"。
   ② 「墙框来自斜切后的梯形」那问的 `query({minX: 3601, …})` 简报写只回 A，实测**必然两家**：B 的盒子 x[3480,3720] × y[−120,2400] 把 A 的外伸方块整个盖住，这副夹具里问不出"只有 A"的矩形。同条用例把 `box.maxX` 从 `toBeGreaterThan(3600)` 钉成 `toBe(3720)`（否则"错得自洽"的梯形可以让两条都绿）。
   ③ 「拖拐角」简报比 `aabb.maxX`，实测**拖前拖后都是 3720**（那个外伸角是 A 的斜切外侧面与 B 的外侧面直线 x=3720 的交点，只要 B 还竖直、半厚还是 120，这个 x 就恒定）。改成比整盒 `not.toEqual(before)`，语义更强。实测变的是 minX `0 → -37.94733192202055`、minY `-120 → -113.84199576606166`、maxY `120 → 1286.4911064067353`。
3. **C1（真缺陷，正文的设计缺口）**：简报的关键判断 1 原本只列了三条漏网边，**三条全是"已存在条目的盒子会发霉"**，没有一条是"新建实体还没有条目"（正文现已补上第 4 条，见上面）。落地后这条路是断的：`wallCreate` 复用 `{pointId}` 时连那个点都不 upsert，共享点因此不在 `affected` 里；而新墙此刻没有 `IndexEntry`，它两端挂着的既有邻墙在 `dirtyIds` 里**没人认领** ⇒ 邻墙那端从 `free` 变 `corner`，盒子却还是矩形。控制器在 `035878e` 上用临时用例实测到 `maxX 3720 → 3600`（局部重建比整层重建少 120），删掉 scratch、`git status` 复原后写进评审记录。修法（Ruling ㊥：只有索引看得见这条边，所以必须在 Task 9 修，不推给 Task 10）：依赖边收成**一条回落链、一个消费点** —— `dependsOnOf`（条目优先，因为被删实体的边只有旧条目记得；查不到再从实体现取，`entityDeps`），边定义本身抽成 `wallDeps` / `openingDeps` 供两处共用（Ruling ㊧：不把评审者给的具体重构形状当命令下达，本轮它自己给的写法也编不过）。Ruling ㊦：本轮允许新增 `it`（Task 8 立的"修复轮不加 `it`"惯例在此让位，因为 C1 必须有"改前红、改后绿"的回归才叫修完），故 22 → 24。
4. **两条新回归用例**（`新建的墙复用既有端点` / `在两个既有端点之间合上一间房`）各钉一个 `affected` 口径 + 一组邻墙盒子的具体数字：前者 `affected.has(sharedId) === false`、A 的 `maxX 3600 → 3720`；后者 `[...affected] === [新墙 id]`（两端都复用既有点 ⇒ 补丁里连一个新点都没有）、两侧 `minX 0 → -120`。定值断言独立红过一遍，不是躲在 `expectSame` 后面。
5. **Step 6 的预言错两处**（见下面表格与正文订正）：第 1 条的行引用随 C1 换形状，红名单 2 → 4；第 6 条（`insert` 去掉先 `remove`）原预言"`expectSame` 红"，**实测 0 红，两轮都是** ⇒ 等价变异，实现者与评审者各自给出不多报/不漏报的证明（`cellKeys` 同函数、闭区间一致 ⇒ 真相交必共格；精筛读**当前**盒子；`snapshot`/`size`/`entryOf`/`cellVisits` 都不读桶内容）。它在 `insert` 里换来了八行注释，把这条纪律的性质写清楚：**性能纪律，不是正确性纪律**。
6. 一处排版：`fromDoc` 里那 103 列的 `new SpatialIndex(…)` 折成三行（仓库源码普遍 ≤100 列；CI 里没有 prettier，纯观感）。
7. **闸门读法**：正文那些 `| tail -N` 只给观感，**不给退出码**（Task 8 就是这样丢过一次证据）。本任务的复跑一律 `pnpm verify > 文件 2>&1; echo exit=$?`，再 `sed` 去色读尾部。Ruling ㊣ 另记一条：Step 2 之后**不要**拿 `pnpm typecheck` 当门槛（`MISSING` 还没有用户，TS6133 必红），它该绿的地方是 Step 5。

**十处变异的实测红集合**（每处改完跑 `pnpm vitest run packages/core/test/spatial.test.ts`，`cp` 还原后 `cmp` 与 pristine 快照逐字节比对；新文件未入库时 `git diff` 看不见它们，所以 `cmp` 比 `git diff` 强）：

| # | 变异 | 实测 | 与预言 |
| --- | --- | --- | --- |
| 1 | 摘掉 `dirtyIds` 里那条边遍历 | 修复前 2 红（删墙 / 改厚），修复后 **4 红**（+ 两条 C1），`拖拐角` 两轮都绿 | 吻合（红名单随形状长） |
| 2 | `expandAffected` 去掉 `doc.get(id) === undefined` 的 `continue` | **3 红**：「不在文档里的 id 当 seed」（`TypeError: 实体 不存在`）、「删一面墙」、「与本层无关的 id 是空操作」（红在 `MISSING`） | 多红 2 条：同一道守卫在闭包与索引两处各有入口 |
| 3 | `aabbIntersects` 的 `<=` 改 `<`（四个比较全改） | **2 红**，且**九次 `query === bruteForce` 的 `toEqual` 一次都没红**（两边同源、一起错），红的是两条反证（贴边那条 + "非空探针恰好 6 条"） | 完全吻合，教科书那条成立 |
| 4 | `cellKeys` 的 x 下界 `floor` 改 `ceil` | **5 红**：探针比对、`queryPoint`、梯形外伸、`cellVisits`、拖拐角 | 预言的两条都红，另多 3 条 |
| 5 | `query` 去掉精筛 | **3 红**：探针比对、`queryPoint`、拖拐角（`expectSame`） | 精筛不是装饰 ✓ |
| 6 | `insert` 去掉先 `remove` | **0 红（24 passed）** | **预言错**：等价变异，见上面第 5 条 |
| 7 | `rebuild` 去掉 `wall.storeyId === this.storeyId` | **2 红**：「只收本层」、「与本层无关的 id 是空操作」（`size` 2 → 4） | 吻合 |
| 8 | `applyAffected` 的 opening 分支改成只 `remove` | **2 红**：拖拐角、undo/redo 回放；`删一面墙` 与两条 C1 回归绿（那两副夹具没有洞口） | 完全吻合（含"该绿的仍绿"） |
| 9 | `rebuild` 去掉首行 `mustExist` | **1 红**：「只收本层」的 `toThrow(/楼层 不存在/)`；附带 typecheck 也红（`mustExist` 变没人用的 import → TS6133），所以它不能只靠 vitest 判读 | 吻合 |
| 10 | `[...dirty].sort()` 去掉 `.sort()` | **0 红** | 吻合，Step 4 第四句解释拿到凭据 |

`PROBES` 九条里**非空 6 条**（1/2/3/6/7/9），与简报注释里写的数字逐字吻合；第 9 条"恰好共边"那条非空，正是变异 3 的靶子。
「改墙厚」实测的第二面墙：A 横墙厚 240→300 之后，**B 只有 `minY` 从 `-120` 变 `-150`**（异厚 corner 里邻墙沿自身轴的外伸取的是**对面墙的半厚**），`minX/maxX/maxY` 一动不动；A 自己 `{0,-120,3720,120} → {0,-150,3720,150}`。这两个"盒子级"事实给 Task 10 的两层整合当参照，也是计划 3 精确命中层的依据：**AABB 层分不开共角的两面墙，精确命中必须回梯形轮廓**。

**下游义务（可直接粘进 ledger）**：

- **T10**：① `arbitraries.ts` 的 `ChainOp.kind` **必须含 `addWall` 且含"两端都复用既有端点"那一变体**，否则属性测试的随机序列走不到 C1 那条路，本轮加的回归就只是两条定值用例而已；② Ruling ㊤：重影柱（`wallMoveEndpoint` 把挂着柱的点拖到同层另一根柱的坐标上）归本任务的 `assertTruthSourceInvariants(doc)` —— 索引里没有柱条目，既不能容忍也修不了它，而 `expandAffected` 已经给出 `point → column` 这条边；③ Ruling ㊡：`properties.test.ts` 六处 `fc.assert` 没钉 seed、失败也不打印 seed，这是本仓唯一真正不可复现的掷硬币面，顺手补上；④ `properties.test.ts:227` 还在用 `.at(-1)` 取"刚建成的实体"（uuidv7 同毫秒不保证有序），清掉；⑤ 空层（`fromDoc` 在一层还没有墙时）与 `requirePoint` 的抛/跳策略目前无用例；⑥ 两层整合要吃到 `storeySetElevation` 的"脏集合 = 整层"这条（测试 3 已钉）。 **（本块 ①②③ 与 ⑤ 的"空层"那半已由 Task 10 下达前的预检改判处置：① 换成测试 14、②③ 判给计划 4 与计划 3、⑤ 的空层那半并进测试 14。以 `:7048` 那块为准。）**
- **终审（本轮有意不修）**：`cellKeys` 没有 key 数量上限（`cellSizeMm: 1` 会让一次 `query` 造出天文数字的 key）；`dirtyIds` 对每个 id 现调 `expandAffected` 保留了 `dependentsOf` 的 `byKind` 全扫形状，楼层 seed 时接近 O(n²)；`assertQueryable` 用 `JSON.stringify` 打印矩形，`NaN` 会显示成 `null`；`applyAffected` 是"边派生边提交"，中途抛错会留下半新半旧的索引（今天没有任何一条路径会在循环里抛：能抛的都在 `deriveJoints`/`openingEntry`，而病态文档在命令层就建不出来）。
- **计划 3**：`IndexEntry.dependsOn`（墙 = 两端点；洞口 = 宿主墙 + 那两个端点）就是"高亮这面墙涉及哪些点"的现成材料，别另建一张表；`cellSizeMm` 是构造参数，按缩放级别换网格不用动接口；精确命中层要自己解决共角那对面墙（见上面那条盒子级实测）。

---

### Task 10: 几何属性测试与两层整合（`geometry-properties.test.ts` + `integration-two-storeys.test.ts`）

计划 2 的验收任务：**不新增一行 `src/`**。前面九个任务各自守自己的那一小块，本任务要回答的是把它们拼在一起之后还剩什么没被证明 —— 特别是那三条写在计划开头、还没有一条测试同时考过的话：接头闭合、洞口永不超出宿主墙、派生与撤销逐字节可重放。再加 spec 11.1 那栋两层住宅的定值整合（它的出图在计划 5，这里只验"这栋房子在几何与索引层面画得出来、合法、撤销得回去"）。

**关键判断 1：预言必须写成"不含约定"的形式。** 这条是本任务全部设计的起点，也是 Task 4 踩过的坑：接头那套几何有三条看起来很像 oracle 的性质 —— 接缝两端点重合、`trimLeft = -trimRight`、Σ 四边形面积 = Σ 轴长 × 墙厚 —— 它们在**错误的边线配对**下全都照样成立（`innerSide` 那条注释写着为什么）。原因是这三条都只用到"两侧取同一个交点"这个构造，而配对错了也是一个交点，只是错的那个。所以属性测试的预言不能停在这三条上，必须把每个墙端**每一侧**的斜切量算出来比：

```
θ   = 两墙内向量的夹角           cosθ = dot(i_A, i_B)，sinθ = |cross(i_A, i_B)|
内侧 = 对面墙的内向量在本墙法向上的符号（sign(dot(i_other, n_self))），不是"第几条边线"
trim_内侧(self) = (h_other + h_self · cosθ) / sinθ        trim_外侧(self) = −trim_内侧(self)
凹角点 = P + trim_内侧(A)·i_A + s_A·h_A·n_A               凸角点 = 2P − 凹角点
```

这里没有任何一处依赖成员在 `Joint.members` 里的先后、也没有"start 配 start"这种画法约定 —— 而 Task 4 那个 bug 恰好只破坏这类约定。所以它抓得住。代价是预言得自己算一遍向量：它**不调用** `geom/joint.ts` 与 `geom/axis.ts` 的任何导出，连 `dot`/`cross`/`perp` 都在测试文件里另写一份（`outline.test.ts` 里的 `strictlyConvex` 同样故意复制一份而不是共享 —— 共享了就不再是第二份证据）。

**关键判断 1 的补（Task 4 执行回填，别把它读成"Task 10 兜底"）**：上面那三条"照样成立"说的是**错误的边线配对**。还有第四条本任务**结构上看不到**的缺陷：**同一个点上两堵墙朝同一条射线画**。Task 4 评审时我曾对用户说"Task 10 的 Σ 面积恒等会把它抓出来（重叠被算两次）"，那句话是**错的**，两处凭据：

- Σ 那条是**逐墙恒等式**，不是并集面积（本文件 Task 10 属性表里"Σ 轮廓面积"那行与 `8,140,800` 那条用例的注释都写死了这一点）。同向重叠的两堵墙各自仍是 `轴长 × 墙厚`，逐墙求和不会因为它们在纸上压在一起而变化 ⇒ 没有任何 Σ 断言能看见它。
- 更硬的一条：本任务的生成器**根本产不出那个形状**。关键判断 2 把转角限死在 |turn| ∈ [30°, 150°]（见上一条规原文），相邻两段永远不平行 ⇒ 链上同一个点的两成员永远判成 `corner`，`collinear` 分支一次都走不到。
- **Task 5 回填的第二块盲区（O2，与本节同一条 Σ 断言有关，别混成一件）**：`wallQuad` 四角展开后鞋带给出 `Area = 墙厚 × (轴长 − Σt/2)`，只依赖四个 trim 的**和** ⇒ 任何"保和的重排"（start↔end 互换、左右整体对调）面积逐字不变，凸性也看不见（梯形仍凸）。这是 Task 5 用 M5（红 2）/M6（红 1）实测出来的：**能看见侧别与端别的只有位置化的角点比对**，而 Task 5 那种整数 fixture 上的逐位 `toEqual` 只有三条钉子。所以本任务那条**按侧**比对闭式解的预言（上面 6506 那两行 `trim_内侧/trim_外侧` 与凹/凸角点公式）是本计划里唯一能覆盖侧别错配的东西 —— **不可删、不可"简化成比面积"、不许改成只比 Σ**。配套 O3：环序 `[0=start+, 1=end+, 2=end−, 3=start−]` 必须在 `quadEndCorners` 里显式按 `(end, side) → 下标` 比对（`[0,3]` 同端、`[1,2]` 同端），因为计划 3 的描边按下标走一圈，而 Task 5 的环序今天只被整数 fixture 顺带钉住。另：跨墙共点在斜角下只能容差比（60° 实测 y 差 ≈3e-14），别把逐位 `toEqual` 推广到非轴对齐 fixture。

所以"同向重叠必须在派生层就抛"这条守卫的证据只能来自 **Task 4 自己**（`joint.ts` 的组内判据 + 定值用例 + 它的变异检查），Task 10 既不是它的兜底、也不许在日志里写成"已由属性测试覆盖"。它同时是本计划"oracle 与被测实现同源 ⇒ 测不出东西"这个主题的第二块教材（第一块是 Task 9 变异 3，`bruteForce` 与 `query` 共用 `aabbIntersects`）：一条性质听起来像证据，跟它真能区分对错是两件事，要拿"改了会不会红"去问。


**关键判断 2：墙链生成器靠上下界产合法值，不靠 `filter`**（Global Constraints 那条规）。三条界互相咬合，把"命令层会抛"的形状从源头掐掉：

- 段长 ≥ 4000（取整前的名义值）> 墙厚上界 400 ⇒「墙厚不小于轴长」造不出来；
- 转角 |turn| ∈ [30°, 150°] ⇒ 内角 θ = 180° − |turn| ∈ [30°, 150°]，sinθ ≥ 0.5（取整扰动 < 0.02°，见测试里的界取 0.49 的理由）⇒ 接头永远是 `corner`，既不会退化出 `collinear`，也不会撞到 `sideVertex` 的近平行抛错；
- 由 sinθ ≥ 0.49 与半厚 ≤ 200 ⇒ 单侧斜切 ≤ (200 + 200)/0.49 ≈ 817，两端同侧合计 ≤ 1634 ≪ 轴长下界 3900（`MIN_AXIS_MM`，即名义 4000 减取整余量）⇒ `assertNoFlip` 永远不必抛。

**关键判断 3：随机 `movePoint` 先在真源上"试法"，不合法就不 dispatch。** 拖动一个共享点会同时改掉两段的长度与方向，而方向一改，**相邻三个接头**的内角都变了 —— 想靠上下界一次性保证"任意拖动都合法"是不可能的（拖动本身就是无界的角变化）。所以测试算子先把候选坐标代进真源坐标做一遍完整合法性预检（轴长下界、sinθ 下界、每接头至多两成员），过得了才 `dispatch`。这跟被禁止的 `fc.filter` 不是一回事：`filter` 是生成器丢样本重试、会拖慢收缩、还会骗人"非法值测过了"；这里是**从操作流里挑出此刻合法的那一步**，非法形状由关键判断 4 单独、定向地造。并且跳过量与施加量都计数，末尾各钉一条下界，防止"整条属性其实只在撤销里打转"。

**关键判断 4：把"非法写"当一类被测操作。** `model/transaction.ts` 的 `dispatch` 第一行就是 `cmd.build(this.doc)`，补丁求不出来就碰不到任何状态 —— 这条时序是"抛错的命令必然整条不生效"的凭据，但没有一条测试钉过它。本任务每步跑四种定向非法探针，每种都同时断言：抛对中文错、`canonical()` 逐字节不动、`depth` 不动、`affected` 不动。只断言抛错是不够的：那等于允许命令"抛之前先把文档改了"。

四种探针按**抛在哪一层**分两组，这个区分是这条判断的全部要害：前三条抛在 `build`（零长墙 = 两端复用同一个 `pointId`，要解析引用才知道重合；`openingMove` 把洞口挪出宿主墙末端；`wallSetThickness` 把墙厚调到不小于轴长），它们才真正考 `dispatch` 的时序；第四条（门洞带窗台）抛在**构造期**，`dispatch` 根本没被调用，"文档没动"是白送的 —— 它考的是命令工厂，留在这里是为了让两组并排放着有人看得见差别。**探针不能换成"随便造一个非法值"**：构造期就抛的非法值再多，也钉不住"抛之前不许改文档"这一条。

**非目标**（三条，各有一句理由）：

1. **随机生成 T 接 / 十字 / 星形。** 随机拓扑要处理"直通两墙必须同厚"（`requireEqualThrough`）、星形必须被拒、同一交点上支墙方向数不可控 —— 生成器的复杂度会超过它能证明的东西。这三类接头的定值证明在 Task 4（分类与斜切量）、Task 5（轮廓面积）、本任务 Step 5（两层房里的两个 T 接）。属性测试里 `checkKinds` 反过来钉"链上永远不该出现 tee/cross/star"，一旦有人把生成器改成产 tee，这条会红着提醒他先读这段。
2. **一面墙上两樘洞 + 缩墙夹取。** 两樘洞挤不进同一面缩短的墙：`clampOpeningsToWall` 会各自 `Math.floor(L − w)` 贴到末端，于是必然重叠或贴边，`assertSpansFit` 抛 —— 那是**正确行为**，不是可以随机化试探的空间。两樘洞的夹取冲突由 Task 7 的定值用例「夹完撞上」负责；本任务的随机夹取保持"一墙至多一樘"。
3. **柱、板、标高的几何。** `src/spatial` 不索引它们：索引条目只有 `wall` 与 `opening` 两类（Task 9）。**别把这句读成"柱与板已经有人守"**（归属改判第 2、3 条）：本计划只在**创建期**守柱与板（Task 8 的 `columnCreate` / `slabCreate` 守卫），派生层与拖侧后果没人管；三条里只有标高是真被两处守住的（Task 8 的 `assertNoVerticalOverlap` + Task 9 的"改标高 ⇒ 整层脏集合"）。

#### Task 10 下达前的归属改判（覆盖 4626 / 4647 / 5750 / 7000 四处同名指认）

那四处都写在别的任务的执行回填里，写的时候都默认 Task 10 会有一个 `assertTruthSourceInvariants(doc)`、或一个 `addWall` 算子。Task 10 正文里两样都没有 —— 所以先把这四条判掉，别让执行人去猜（计划自己的"以这里为准"惯例）。

1. **`addWall` 不进 `ChainOp`；"新墙挂到既有点"改由测试 14 覆盖。** 7000 那条 T10 ① 与 Step 6 变异 8 那句"前提是 `ChainOp.kind` 里有 `addWall`"三处都不成立：
   - (a) 那句后面说的"四条里只有两条会红"指的是 Task 9 的**定值**用例，它们跟 `ChainOp` 没有任何关系 —— 摘掉半条闭包它们照红，Task 9 执行回填写的就是实测红四条。
   - (b) 真缺的不是算子，是**时机**。`runOpsWithIndex` 的索引建在 `drawChain` **之后**，所以即便 `ChainOp` 多一种 `addWall`，索引看到的也只是"一张已经装全墙的表再加一面墙"；而链上第 i 段复用第 i−1 段端点那一幕 —— 索引此生第一次遇到"新构件挂到既有点"的地方 —— 发生在索引还不存在的窗口里。
   - (c) 给 `arbChainShape` 加闭合段、或给 `ChainOp` 加任意连线，都会破掉关键判断 2 的三条界：闭合段与任意连线的长度、夹角是**派生**量，不在生成器的下界里，而 `MIN_AXIS_MM` 与 `sinθ ≥ 0.49` 是全文件所有"抛/跳"判定的前提。破它的代价远大于收益。
   **落地的东西**：`drawChain` 多一个可选的每步回调（默认不传 ⇒ 其余 13 条行为逐字不变），索引的出生点挪到空层，画一段建一次 ⇒ 测试 14。它覆盖"新墙挂到既有端点"（每轮 1–4 次 × 40 轮），**不**覆盖"在两个既有端点之间合上一间房"（链不闭合是生成器的既定边界，那条留在 Task 9 的定值用例）。
2. **`assertTruthSourceInvariants(doc)` 不在本任务，判给计划 4 的读盘校验。** 理由是鉴别力，不是工作量：Task 10 的文档全部由 `dispatch` 命令工厂产出，那份清单里的每一条（引用完整性、`widthMm ≥ 1`、`heightMm ≥ 1`、`sillMm ≥ 0`、门 ⇒ `sillMm = 0`、洞口与宿主同层、不接受 `-0`）在这类文档上要么已被命令层守卫挡死、要么按 4618 那条 F8 的实测**结构不可达** —— 4626 与 4647 自己给的理由就是"只有读盘/手搓能进来"。一条在这台测试能喂给它的任何输入上都不会红的检查器，正是本计划反复罚的那件事（Task 9 变异 3 的 `bruteForce` 与 `query` 同源、Task 4 那三条"错误配对下照样成立"）。清单本身别丢：**4647 的 T10 ⑤ + 5750 的 T10 ③ 合起来就是计划 4 读盘入口的验收清单**，抄过去即可。
3. **重影柱（ledger 里的 Ruling ㊤）不在本任务，判给计划 3 的拖拽入口。** 它要先回答"拖动一个挂着柱的共享点，柱跟不跟走"（5741–5744 原话：需要的不是补丁而是一条语义裁决）。那是交互语义而不是几何派生问题，而 Task 10 只有一种拖法（`wallMoveEndpoint`）、索引里没有任何柱条目 —— 在这里写断言，等于拿一条测试当场把"柱不跟走"这个**未定**语义钉成期望值，而计划 3 真做拖拽时改的就是它。裁决人从"Task 9"改成"计划 3 的拖拽入口"，理由不变。
   **【终审 M-12 ③ 补落点】** 这条判出去时计划 3 的"尚未展开的任务边界"里没有它的格子，等于判给了空气。现已写在计划 3 的 Task 5 边界条目里（与"`DrawLayer` 加不加 `interaction` 层"同等必答），并把三条现状事实一并抄了过去：柱 `pointId` 与墙端点是**同一枚实体**、`column.ts:56-73` 的重影判据只在创建期跑一次、柱既不进 `deriveStoreyGeometry` 也不进 `SpatialIndex` ⇒ 判据被拖坏之后没有任何一层会红。
4. **seed 不钉，但必须复现一次（7000 那条 T10 ③ 的实测订正）。** fast-check 4.10.2 的 `fc.assert` **失败时本来就把 seed 与 path 打进错误消息**：本仓实测 `{ seed: -354603730, path: "0:2:0:0:0:1:1", endOnFailure: true }` + `Counterexample: [500]` + `Shrunk 6 time(s)`。所以"失败也不打印 seed"这句是错的，别为它加代码。真缺的只有"每轮跑流不同"这一半，而钉死 seed 等于把 CI 的随机覆盖冻在一条流上 —— 拿覆盖换一个本来就有的东西。**本任务只做一件事**：把一次真实失败（没有就临时改坏一个界造一次）输出里的 `seed` 与 `path` 原样填进 `fc.assert(prop, { seed, path })` 复跑，确认复现同一个反例，然后把这条实测写进执行日志。它是"不钉 seed"这个决定的凭据，不是任何一条断言。

**Files:**
- Create: `packages/core/test/geometry-properties.test.ts`
- Create: `packages/core/test/integration-two-storeys.test.ts`
- Modify: `packages/core/test/arbitraries.ts`（追加墙链、洞口尺寸、操作序列三个生成器；已有导出一个都不改）
- Modify: `packages/core/test/properties.test.ts`（清理计划 1 残留的 `byKind().at(-1)` 与 `as PointEntity`，见 Global Constraints 末条）
- 不改：`packages/core/src/**`（本任务若逼出实现缺陷，按缺陷处理：改实现、记进执行日志，不改预言）

**Interfaces:**
- Consumes：Task 4 的 `deriveJoints`；Task 5 的 `WallQuad`（`polygonArea` 不 import，理由写在 Step 3 的 import 规矩里）；Task 6 的 `deriveStoreyGeometry`/`openingSpans`/`WallPiece`；Task 7 的 `openingCreate`/`openingMove`/`openingDelete`；Task 8 的 `storeySetElevation`；Task 9 的 `SpatialIndex`/`aabbOfPoints`/`openingAabb`（`aabbIntersects` **故意不 import**：属性测试自己写一份闭区间相交判据，见 Step 3）；计划 1 的 `Document.canonical`/`TransactionLog.{document,affected,depth,undo,redo}`
- Produces：无（纯测试任务）。只有一件跨计划的东西值得记：`geometry-properties.test.ts` 里那份**闭式解预言**是计划 5 标注尺寸线时唯一的浮点第二证据，别让它烂在这里没人复用。

- [ ] **Step 1: 扩 `test/arbitraries.ts`**

在文件末尾追加。**不要**改 `arbWallShape` 及其他已有导出（`properties.test.ts` 在吃它们，改签名等于改计划 1 的交付）。

```ts
// ---------- 计划 2 · Task 10：墙链、洞口尺寸、操作序列 ----------

/** 折线顶点。整数毫米，但本文件不调 `quantizeMm`：这里的数天生就是整数。 */
export interface ChainPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * 一条开放墙链：points.length = walls.length + 1。
 * `forward` 是这份生成器存在的理由：true 表示这一段按折线正方向画（start = 前一个点），
 * false 表示反着画。相邻两段的 forward 相同 ⇒ 共享点是 (end, start) 混合角；
 * 不同 ⇒ 是 (start, start) 或 (end, end) 同向角 —— 只有同向角才会露出边线配对的破绽
 * （Task 4 的 `innerSide` 就是为它加的）。随机布尔保证两种角都会大量出现。
 */
export interface ChainShape {
  readonly points: readonly ChainPoint[];
  readonly walls: ReadonlyArray<{ readonly thicknessMm: number; readonly forward: boolean }>;
}

const arbChainSegment = fc
  .record({
    turn: fc.integer({ min: 30, max: 150 }),
    side: fc.constantFrom(1, -1),
    lengthMm: fc.integer({ min: 4000, max: 12000 }),
    thicknessMm: fc.integer({ min: 100, max: 400 }),
    forward: fc.boolean(),
  })
  .map(({ turn, side, lengthMm, thicknessMm, forward }) => ({
    turnDeg: side * turn,
    lengthMm,
    thicknessMm,
    forward,
  }));

/**
 * 折线靠"每段相对上一段转 ±[30°,150°]"来保证合法，不用 filter（关键判断 2）。
 * 顶点坐标是取整后的整数：真实轴长与转角跟名义值差不到 0.71mm / 0.02°，
 * 所以测试侧的界一律留了余量（轴长 3900、sinθ 0.49），见 geometry-properties.test.ts 顶部。
 * 链**允许**自交（不相邻的两段在平面上压过去）：接头只由共享 pointId 决定，自交不产生
 * 新接头，也不影响"Σ 面积 = Σ 轴长 × 墙厚"—— 那条是逐墙恒等式，不是并集面积。
 */
export const arbChainShape: fc.Arbitrary<ChainShape> = fc
  .record({
    x: fc.integer({ min: -20_000, max: 20_000 }),
    y: fc.integer({ min: -20_000, max: 20_000 }),
    headingDeg: fc.integer({ min: 0, max: 359 }),
    segments: fc.array(arbChainSegment, { minLength: 2, maxLength: 5 }),
  })
  .map(({ x, y, headingDeg, segments }) => {
    const points: ChainPoint[] = [{ x, y }];
    let heading = (headingDeg * Math.PI) / 180;
    for (const segment of segments) {
      const prev = points[points.length - 1]!;
      heading += (segment.turnDeg * Math.PI) / 180;
      points.push({
        x: Math.round(prev.x + segment.lengthMm * Math.cos(heading)),
        y: Math.round(prev.y + segment.lengthMm * Math.sin(heading)),
      });
    }
    return {
      points,
      walls: segments.map((s) => ({ thicknessMm: s.thicknessMm, forward: s.forward })),
    };
  });

/**
 * 洞口尺寸。`distancePercent` 不是"距起点百分之几"，而是 `legalDistanceMm` 的分子：
 * `d = floor((轴长 − 宽) × pct / 100)`，所以 `to = d + w ≤ 0.95 × 轴长 + 0.05 × 宽 < 轴长`
 * （最后一步要 `w < L`，由轴长下界 3900 > 宽上界 1200 白送）。
 * 上界取 95 而不是 40 的理由在 Step 3 的测试 9：夹取那条要有红得起来的可能。
 */
export interface OpeningShape {
  readonly widthMm: number;
  readonly heightMm: number;
  readonly distancePercent: number;
  readonly category: 'door' | 'window';
}

export const arbOpeningShape: fc.Arbitrary<OpeningShape> = fc.record({
  widthMm: fc.integer({ min: 700, max: 1200 }),
  // 窗台默认 900（openingCreate 给），所以 900 + 2100 = 3000 正好顶到墙高上界
  heightMm: fc.constantFrom(1000, 1200, 1500, 1800, 2100),
  distancePercent: fc.integer({ min: 0, max: 95 }),
  category: fc.constantFrom('door' as const, 'window' as const),
});

/**
 * 一步随机操作。`index` 是一个共享的"挑哪一个"槽位（运行时对当前存活集合取模）：
 * 取模会让操作分布不均匀，但它是**选择**不是**被测值**，被测值（坐标、尺寸）都来自主档。
 * 六种操作各管一段责任：
 * - opening / moveOpening / deleteOpening：洞口三式，配合"一墙至多一樘"（非目标 2）
 * - movePoint：拖共享端点，两墙跟随，会触发 Task 7 的洞口夹取
 * - thickness：改墙厚。异厚角是 `innerSide` 与闭式解最吃紧的地方
 * - deleteWall：删一面墙，接头降级 —— Task 9 双向闭包的那条漏网边
 */
export type ChainOp = OpeningShape & {
  readonly kind: 'opening' | 'moveOpening' | 'deleteOpening' | 'movePoint' | 'thickness' | 'deleteWall';
  readonly index: number;
  readonly dx: number;
  readonly dy: number;
};

export const arbChainOp: fc.Arbitrary<ChainOp> = fc
  .tuple(
    arbOpeningShape,
    fc.record({
      kind: fc.constantFrom(
        'opening' as const,
        'moveOpening' as const,
        'deleteOpening' as const,
        'movePoint' as const,
        'thickness' as const,
        'deleteWall' as const,
      ),
      index: fc.integer({ min: 0, max: 9 }),
      // 600mm 的拖动量对 4000mm 以上的段最多改 8.5° 方向角：单步很少越界，
      // 但连续多步会累积，所以 movePoint 仍要过关键判断 3 的试法。
      dx: fc.integer({ min: -600, max: 600 }),
      dy: fc.integer({ min: -600, max: 600 }),
    }),
  )
  .map(([opening, op]) => ({ ...opening, ...op }));

/**
 * 6..18 步。为什么不是 30 步：spec 11.2 那"连续撤销 30 步"是**定值**要求，
 * 由 Step 5 的两层房逐条数出来（2 楼层 + 16 墙 + 8 洞口 + 4 编辑 = 30）。
 * 这里的序列只管长度覆盖：随机撤销重放一步的成本是整层派生 + 索引三件套，
 * 18 步 × 80 次运行已经把每个中间态都翻了两遍，再长只是让 CI 变慢。
 */
export const arbChainOps = fc.array(arbChainOp, { minLength: 6, maxLength: 18 });
```

`opening` 与 `moveOpening` 都用 `distancePercent`，`deleteOpening` / `movePoint` 等用不上洞口字段的就带着无用数据 —— 这是**故意**的：一份字段表比六个变体 union 少一半样板，而 `ChainOp` 只在测试内部流动，不进任何断言。`arbOpeningShape` 之所以单独成一个导出：`arbChainOp` 用 `fc.tuple` 复用它，尺寸档只写一遍（Step 3 的 `clamp` 判定与探针 4 都要拿同一批数字算 `to`，两处各抄一遍就会漂）。

- [ ] **Step 2: 清掉计划 1 留在 `properties.test.ts` 的取值残留**

计划开头那条约定（「取新建实体一律走 `log.affected` + 字面量判别，禁止 `byKind().at(-1)`」）承诺顺手改掉 `properties.test.ts:227`。那里有两处 `log.document.byKind('wall').at(-1)!` 被当成"刚建 / 刚改的那面墙"用（第 227、235 行）。`byKind` 返回的是**按 id 升序**（`model/document.ts:70` 的 `out.sort(byId)`），而 uuidv7 在同一毫秒内不保证单调 —— 同批建的墙谁排最后取决于时钟低位的运气。今天它不会误红（拿到哪面墙都还合法，相对锚点偏移保证撞不出零长墙），但第 235 行的 `grown` 想验的是"刚被 `wallMoveEndpoint` 拉伸的那面墙"，实际可能拿回上一轮那面，于是那句"整数毫米字段仍要扫刚被改动的实体"落了一半空。同文件第 95、228 行的 `as PointEntity` 是同一类问题：cast 掉了判别式，点读不回来时炸成 `undefined.x`。

**本步骤没有变异检查，也不该有**：改完之后把 `wallJustCreated` 换回 `at(-1)`，一条测试都不会红 —— 那正是它今天不误红的原因。这条改动的凭据是"取到的确实是它以为的那个实体"，钉住它的是本条约定 + Step 3 里那些新写的用例，不是这里。别为了"让它变红"去加断言：那要造一个"同毫秒建两面墙且 id 逆序"的场景，是把生成器支起来给一个注释看。

**改动 1 —— import 表**（第 3–15 行）：删 `type PointEntity`（改动 4 之后它没有别的用处），加 `type WallEntity`。`verbatimModuleSyntax` + `noUnusedLocals` 会替你盯着：多一个少一个都过不了 `pnpm typecheck`。

```ts
import {
  Document,
  TransactionLog,
  quantizeMm,
  storeyCreate,
  uuidv7,
  wallCreate,
  wallDelete,
  wallMoveEndpoint,
  wallSetThickness,
  type WallCreateInput,
  type WallEntity,
} from '@dajia/core';
```

**改动 2 —— 在 `withStorey` 之后插入两个助手**：

```ts
/**
 * 取刚 dispatch 出来的那面墙。不许用 `byKind('wall').at(-1)`：byKind 按 id 升序，
 * 同毫秒的 uuidv7 不保证有序，at(-1) 拿到的是"id 最大的墙"而不是"刚建的墙"。
 */
function wallJustCreated(log: TransactionLog): WallEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new TypeError('最近一次 dispatch 没有新建墙');
}

/** 点的坐标：靠判别式而不是 cast。点不在真源里就抛，别让下一行炸成 undefined.x。 */
function pointXY(log: TransactionLog, id: string): { x: number; y: number } {
  const entity = log.document.get(id);
  if (entity?.kind !== 'point') throw new TypeError(`真源里点 ${id} 不存在或不是 point`);
  return { x: entity.x, y: entity.y };
}
```

**改动 3 —— 第 95 行**（`pick === 0` 分支里那一行，其余不动）：

```ts
              const anchor = pointXY(log, target.startId);
```

**改动 4 —— 第 226–236 行**整段替换（`for (const [i, shape] of shapes.entries())` 的循环体前半）：

```ts
          log.dispatch(wallCreate(withStorey(storeyId, shape)));
          const wall = wallJustCreated(log);
          const anchor = pointXY(log, wall.startId);
          // 同样用相对锚点偏移：绝对坐标有极小概率正好落在 start 上，命令层会抛零长墙，
          // 那是生成器的运气问题不是被测代码的缺陷，不该让它变成红测试。
          const { dx, dy } = FRACTIONAL_OFFSETS[i % FRACTIONAL_OFFSETS.length]!;
          log.dispatch(
            wallMoveEndpoint({ wallId: wall.id, end: 'end', x: anchor.x + dx, y: anchor.y + dy }),
          );
          // 移动端点不新建墙：读回来必须还是同一面。这里若换成 wallJustCreated 会抛，
          // 那本身就是"wallMoveEndpoint 只改点不改墙"的断言。
          const grown = log.document.get(wall.id);
          if (grown?.kind !== 'wall') throw new TypeError(`墙 ${wall.id} 拉伸后读不回来`);
          log.dispatch(wallSetThickness({ wallId: grown.id, thicknessMm: 50 }));
```

**跑一遍，只验本文件**：

```bash
pnpm typecheck 2>&1 | tail -3
pnpm vitest run packages/core/test/properties.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -6
```

Expected: **9 passed**（`properties.test.ts` 里 7 条 `it`，其中「反例哨兵」那条是 `it.each(REGRESSIONS)`，两条夹具展成 2 条测试，所以 vitest 报 9；计划 2 起跑前实跑确认过。条数不变：本步骤只换取值写法，不加用例）。`canonical()` 那几条比对若因 `grown` 取到不同实体而红，说明残留**确实在改变被测对象** —— 那不是回归，是那处测试本来就是错的，把红的那条 Counterexample 抄下来写进执行日志。

- [ ] **Step 3: 写 `geometry-properties.test.ts`**

文件长，分三段依次追加（① 预言 → ② Harness 与操作 → ③ 四个 `describe`），中间不提交、不运行 —— 第 ①② 段单独留着会因"导入未使用"过不了 `pnpm typecheck`。

**这个文件的 import 表里不许出现 `wallAxis` / `wallAxisById` / `awayDir` / `cornerPoint` / `endPoint` / `deriveJoints` 之外的任何 `geom/axis` 与 `geom/joint` 导出**（`dot` / `cross` / `perp` / `advance` / `Vec2` 也不许：它们是 `geom/vec`，但预言用它们就等于把"法向怎么取"这个约定借过来用）。理由见关键判断 1。被 import 的实现侧符号只有：`deriveJoints`、`deriveWallQuads`、`deriveStoreyGeometry`、`openingSpans`、`SpatialIndex` 与八个命令（`wallCreate` / `wallDelete` / `wallMoveEndpoint` / `wallSetThickness` / `openingCreate` / `openingMove` / `openingDelete` / `storeyCreate`）—— 全是**被测对象**。`polygonArea` 不在其中：它就是 `WallQuad.areaMm2` 的算法本身（Task 5 里 `areaMm2: polygonArea(corners)` 一行），在这里拿它比 `areaMm2` 是自己比自己；它该被考的地方是 Task 5 的定值用例，已经考过。

**第 ① 段：预言**

```ts
/**
 * 计划 2 的验收属性测试。三件事：
 * 1. 闭式解预言 —— 按侧比对每个墙端的斜切量（关键判断 1，Task 4 那个 bug 的唯一随机探测器）；
 * 2. 随机操作序列下，接头分类 / 生成器边界 / 洞口分段互补 / 轮廓接缝 / 非法写 no-op / 夹取 /
 *    索引三方一致 / 撤销重放 每步逐一成立；
 * 3. 非法写按"抛在 build 还是抛在构造期"分两组定向钉（关键判断 4）。
 *
 * 本文件不 import `geom/axis` 与 `geom/joint` 的任何导出，连 dot/cross/perp 都另写一份：
 * 预言一旦与实现共享约定，就不再是第二份证据。轮廓面积同理不 import `polygonArea`，
 * 原因写在 Step 3 开头的 import 规矩里。
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  Document,
  SpatialIndex,
  TransactionLog,
  deriveJoints,
  deriveStoreyGeometry,
  deriveWallQuads,
  openingCreate,
  openingDelete,
  openingMove,
  openingSpans,
  storeyCreate,
  uuidv7,
  wallCreate,
  wallDelete,
  wallMoveEndpoint,
  wallSetThickness,
  type Aabb,
  type Command,
  type IndexEntry,
  type PointRef,
  type WallEntity,
  type WallPiece,
  type WallQuad,
} from '@dajia/core';
import { arbChainOps, arbChainShape, type ChainOp, type ChainShape } from './arbitraries';

const projectId = uuidv7();

/** 整条链 + 每步六个检查器（外加夹取记账）的成本不低：操作序列 80 次，只画链的轻档 200 次。 */
const NUM_RUNS_OPS = 80;
const NUM_RUNS_LIGHT = 200;
/** 测试 10 每一步都多建一次全量索引，所以它自己降档：40 × 12 步已经把五种计数灌满了。 */
const NUM_RUNS_INDEX = 40;

/** 生成器的界。名义界是轴长 4000 / sinθ ≥ 0.5（关键判断 2），这里留取整余量。 */
const MIN_AXIS_MM = 3900;
const MIN_SIN = 0.49;
const MIN_THICKNESS_MM = 100;
const MAX_THICKNESS_MM = 400;
const WALL_HEIGHT_MM = 3000;
const WINDOW_SILL_MM = 900;
/** 预言自检的地板：低于它闭式解数值发散，宁可抛，不要比一个不准的数。 */
const ORACLE_MIN_SIN = 0.4;
/** 实现走两直线求交，预言走闭式解：两条算式必须在 1e-6 mm 内一致。 */
const TRIM_DIGITS = 6;

// ---------- ① 预言：只读真源字段，不碰任何几何实现 ----------

interface Vec {
  readonly x: number;
  readonly y: number;
}

const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
const perp = (a: Vec): Vec => ({ x: -a.y, y: a.x });
const flip = (a: Vec): Vec => ({ x: -a.x, y: -a.y });

/** 真源里的一个墙端。inward = awayDir（'start' 端是 dir，'end' 端是 −dir）；normal 恒取 perp(dir)。 */
interface EndVec {
  readonly wallId: string;
  readonly end: 'start' | 'end';
  readonly p: Vec;
  readonly inward: Vec;
  readonly normal: Vec;
  readonly half: number;
  readonly thicknessMm: number;
  readonly axisLengthMm: number;
}

function pointAt(doc: Document, id: string): Vec {
  const entity = doc.get(id);
  if (entity?.kind !== 'point') throw new TypeError(`真源里没有点 ${id}`);
  return { x: entity.x, y: entity.y };
}

/** 轴长。本文件唯一的算法：Math.hypot，与 geom/vec 的 length 同式，所以逐位相同（Step 3 的 toBe 靠它）。 */
function axisLengthOf(doc: Document, wall: WallEntity): number {
  const a = pointAt(doc, wall.startId);
  const b = pointAt(doc, wall.endId);
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function coordsOf(doc: Document): Map<string, Vec> {
  const out = new Map<string, Vec>();
  for (const entity of doc.entities.values()) {
    if (entity.kind === 'point') out.set(entity.id, { x: entity.x, y: entity.y });
  }
  return out;
}

function endVecFrom(coords: Map<string, Vec>, wall: WallEntity, end: 'start' | 'end'): EndVec {
  const at = (id: string): Vec => {
    const hit = coords.get(id);
    if (!hit) throw new TypeError(`预言：真源里没有点 ${id}`);
    return hit;
  };
  const start = at(wall.startId);
  const finish = at(wall.endId);
  const delta = sub(finish, start);
  const axisLengthMm = Math.hypot(delta.x, delta.y);
  if (axisLengthMm === 0) throw new RangeError(`预言：墙 ${wall.id} 两端重合，轴线无方向`);
  const dir = { x: delta.x / axisLengthMm, y: delta.y / axisLengthMm };
  return {
    wallId: wall.id,
    end,
    p: end === 'start' ? start : finish,
    inward: end === 'start' ? dir : flip(dir),
    // 法向永远从 start→end 取：JointMember 的 left/right 认的是它，不是 inward 的 perp。
    // 写成 perp(inward) 会让 'end' 端的左右整体反号 —— 而那正是配对 bug 的对称面。
    normal: perp(dir),
    half: wall.thicknessMm / 2,
    thicknessMm: wall.thicknessMm,
    axisLengthMm,
  };
}

/** 按共享 pointId 给本层所有墙端分组。接头从真源来，不从 deriveJoints 来。 */
function endsByPoint(
  coords: Map<string, Vec>,
  doc: Document,
  storeyId: string,
): Map<string, EndVec[]> {
  const groups = new Map<string, EndVec[]>();
  for (const wall of doc.byKind('wall')) {
    if (wall.storeyId !== storeyId) continue;
    for (const end of ['start', 'end'] as const) {
      const pointId = end === 'start' ? wall.startId : wall.endId;
      const member = endVecFrom(coords, wall, end);
      const bucket = groups.get(pointId);
      if (bucket) bucket.push(member);
      else groups.set(pointId, [member]);
    }
  }
  return groups;
}

/** 该端某一侧的轮廓角点：与 cornerPoint 同一构造，但斜切量来自预言。 */
const vertexOf = (e: EndVec, side: 1 | -1, trim: number): Vec =>
  add(add(e.p, scale(e.inward, trim)), scale(e.normal, side * e.half));

/** 一套"前提"：哪些界属于被测前提，哪些只是随机生成器的自留地。 */
interface Premises {
  /** 轴长下界 + 墙厚区间。生成器的事：手算夹具是几百毫米的小样，不该被它挡在门外。 */
  readonly generatorBounds: boolean;
  /** 低于此值闭式解发散：生成器用 0.49（名义 30°/150° 的余量），预言自检用 0.4。 */
  readonly minSin: number;
}

/**
 * 接头的可用前提：一个点最多挂两个墙端，且二成员接头的 sinθ 过线。
 * 越界即抛，消息带实测数字。
 * 为什么抛而不是返 false：这条判据在属性体里跑，抛了就是"前提破了"，fast-check 会带着
 * 收缩后的 Counterexample 红给用户看；返 false 会让人以为被测代码错了。
 * 唯一"要返 false"的调用方是 withinChainBounds（试法），它把这同一个判据包起来用。
 */
function assertPremises(groups: Iterable<EndVec[]>, premises: Premises): number {
  let cornerCount = 0;
  for (const bucket of groups) {
    if (premises.generatorBounds) {
      for (const e of bucket) {
        if (e.axisLengthMm < MIN_AXIS_MM) {
          throw new RangeError(
            `墙 ${e.wallId} 轴长 ${e.axisLengthMm.toFixed(1)} 掉到下界 ${MIN_AXIS_MM} 以下`,
          );
        }
        if (e.thicknessMm < MIN_THICKNESS_MM || e.thicknessMm > MAX_THICKNESS_MM) {
          throw new RangeError(
            `墙 ${e.wallId} 墙厚 ${e.thicknessMm} 出了 [${MIN_THICKNESS_MM}, ${MAX_THICKNESS_MM}]`,
          );
        }
      }
    }
    if (bucket.length > 2) {
      throw new RangeError(
        `墙端 ${bucket[0]!.wallId} 所在的点挂了 ${bucket.length} 个墙端：` +
          `随机链只该有自由端与角，tee/cross/star 是 Step 5 的定值活（非目标 1）`,
      );
    }
    if (bucket.length === 2) {
      const [a, b] = [bucket[0]!, bucket[1]!];
      const sin = Math.abs(cross(a.inward, b.inward));
      if (sin < premises.minSin) {
        throw new RangeError(
          `墙 ${a.wallId} 与墙 ${b.wallId} 的接头 sinθ=${sin.toFixed(4)} 低于 ${premises.minSin}`,
        );
      }
      cornerCount++;
    }
  }
  return cornerCount;
}

/** 生成器边界的看门狗（关键判断 2 + 3）：轴长/墙厚 + 接头前提，全开。 */
const assertChainBounds = (groups: Iterable<EndVec[]>): number =>
  assertPremises(groups, { generatorBounds: true, minSin: MIN_SIN });

/** 试法用的非抛版本（关键判断 3）。try 里只有本文件自己的界判据，没有任何 src 调用被吞。 */
function withinChainBounds(groups: Iterable<EndVec[]>): boolean {
  try {
    assertChainBounds(groups);
    return true;
  } catch {
    return false;
  }
}

interface ExpectedTrim {
  readonly left: number;
  readonly right: number;
  /** +1 = 内侧在 +normal 侧。由对面墙的内向量在本墙法向上的符号决定，不看成员顺序。 */
  readonly innerSide: 1 | -1;
}

/**
 * 闭式解（关键判断 1 那个框）：
 *   trim_内侧 = (h_other + h_self·cosθ) / sinθ，trim_外侧 = −trim_内侧
 * 没有任何一处依赖"第几条边线"或成员先后：配对错了在这里必然算出另一个数。
 */
function expectedTrims(self: EndVec, other: EndVec): ExpectedTrim {
  const cos = dot(self.inward, other.inward);
  const sin = Math.abs(cross(self.inward, other.inward));
  if (sin < ORACLE_MIN_SIN) {
    throw new RangeError(`预言自检：sinθ=${sin.toFixed(4)} 低于 ${ORACLE_MIN_SIN}，闭式解在此发散`);
  }
  const inner = (other.half + self.half * cos) / sin;
  const facing = dot(other.inward, self.normal);
  if (facing === 0) throw new RangeError('预言自检：对面墙与本墙共线，内侧面无定义');
  const innerSide: 1 | -1 = facing > 0 ? 1 : -1;
  const left = innerSide === 1 ? inner : -inner;
  return { left, right: -left, innerSide };
}

/** 一个接头的凹角点与凸角点：凹 = P + trim_内侧·i + s·h·n，凸 = 2P − 凹。 */
function oracleCornerPoints(self: EndVec, other: EndVec): { inner: Vec; outer: Vec } {
  const t = expectedTrims(self, other);
  const inner = vertexOf(self, t.innerSide, t.innerSide === 1 ? t.left : t.right);
  return { inner, outer: { x: 2 * self.p.x - inner.x, y: 2 * self.p.y - inner.y } };
}

/**
 * 整张图的期望斜切表，key = `${wallId}:${end}`。
 * 前提检查走 `{ generatorBounds: false, minSin: ORACLE_MIN_SIN }`（不带轴长/墙厚那两档）：
 * 本函数的消费者既有 4000mm 的随机链，也有 1000mm 的手算夹具 —— 生成器的自留地管不到它们。
 */
function oracleTrims(doc: Document, storeyId: string): Map<string, ExpectedTrim> {
  const groups = endsByPoint(coordsOf(doc), doc, storeyId);
  assertPremises(groups.values(), { generatorBounds: false, minSin: ORACLE_MIN_SIN });
  const out = new Map<string, ExpectedTrim>();
  for (const bucket of groups.values()) {
    if (bucket.length !== 2) continue;
    const [a, b] = [bucket[0]!, bucket[1]!];
    out.set(`${a.wallId}:${a.end}`, expectedTrims(a, b));
    out.set(`${b.wallId}:${b.end}`, expectedTrims(b, a));
  }
  return out;
}

/** 实现给的斜切表，同一套 key。 */
function implementationTrims(doc: Document): Map<string, { left: number; right: number }> {
  const out = new Map<string, { left: number; right: number }>();
  for (const joint of deriveJoints(doc)) {
    for (const m of joint.members) {
      out.set(`${m.wallId}:${m.end}`, { left: m.trimLeftMm, right: m.trimRightMm });
    }
  }
  return out;
}

/**
 * 逐侧比对，left 对 left、right 对 right。
 * 顺带把实现自己的 `trimRight = −trimLeft` 也钉上（那条不区分配对对错，但它是 Task 5
 * "面积 = 轴长 × 墙厚"的前提，值得在随机样本里每步重验）。
 * 返回比对条数，调用方拿它做防空跑的下界。
 */
function expectTrimsMatchOracle(doc: Document, storeyId: string): number {
  const oracle = oracleTrims(doc, storeyId);
  const impl = implementationTrims(doc);
  for (const [key, want] of oracle) {
    const got = impl.get(key);
    if (!got) throw new TypeError(`实现没给 ${key} 的斜切量`);
    expect(got.left).toBeCloseTo(want.left, TRIM_DIGITS);
    expect(got.right).toBeCloseTo(want.right, TRIM_DIGITS);
    expect(got.right).toBeCloseTo(-got.left, TRIM_DIGITS);
  }
  return oracle.size;
}

const fmt = (p: Vec): string => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
const sortPts = (pts: readonly Vec[]): Vec[] =>
  [...pts].sort((p, q) => p.x - q.x || p.y - q.y);

/**
 * 两点集合的容差匹配：每个 got 点认领一枚距离 ≤ 1e-6 mm 的 want 点，认领不到就抛。
 *
 * 为什么不用"排序后逐位比"（第一版是这么写的，它是个坑）：接头处 A 墙与 B 墙各自算出的
 * 同名角点只在 1e-13 量级上一致，而**轴线水平的那面墙，该端两枚角点的 x 逐位相同**
 * （dir = (±1,0)、normal = (0,±1)，法向那一项的 x 分量精确为 0），于是排序第二键 y 生效；
 * 斜着的那面墙两枚角点 x 相差 1e-13，谁前谁后纯看浮点噪声。两串的键不一样，
 * 逐位比对就会拿左下角去比右上角 —— 红在一个完全合法的状态上。
 *
 * 贪心即最优的前提在这里成立：同端两角相距一个墙厚（≥ 100mm），比 1e-6 的容差大八个数量级，
 * 不存在"两枚都想认领同一枚"的歧义。随机链允许自交，但两座独立接头恰好重合到 1e-6
 * 以内的概率是 0（顶点是整数，交角是无理数倍）。
 */
function expectSamePointSet(got: readonly Vec[], want: readonly Vec[]): void {
  expect(got.length).toBe(want.length);
  const taken = want.map(() => false);
  for (const p of got) {
    const hit = taken.findIndex(
      (used, i) => !used && Math.abs(want[i]!.x - p.x) <= 1e-6 && Math.abs(want[i]!.y - p.y) <= 1e-6,
    );
    if (hit < 0) throw new Error(`点集里没有 ${fmt(p)} 的容身之处：${want.map(fmt).join(' | ')}`);
    taken[hit] = true;
  }
}
```

`fmt` 有两处消费者：上面那句抛错消息（把比过的点集原样打出来，红的时候不用回头加日志）与第 ③ 段测试 2 的"两组角点确实不同"。`sortPts` 只剩测试 2 用 —— 那里比的是**不相等**，顺序稳定与否不影响结论。

**第 ② 段：Harness、操作与检查器**

```ts
// ---------- ② Harness：一切从真源现读 ----------

/**
 * 为什么不维护"折线镜像"：wallDelete 会连带删掉不再被引用的点，undo 又把实体按原 id 放回来。
 * 测试侧的镜像在这两处必然与真源走偏，而走偏的镜像比没有镜像更坏 —— 断言会去比镜像。
 * 所以墙、洞口、坐标一律从 doc 现读；只有 drawChain 在画的那一小段里需要知道
 * "第 i 个顶点是哪个 pointId"（决定写 {pointId} 还是字面量），那是本地临时变量。
 */
interface Harness {
  readonly log: TransactionLog;
  readonly storeyId: string;
  /** 画完链、动手之前的栈深：快照 0 之下那些笔是准备动作，不参与逐张比对 */
  readonly baseDepth: number;
  readonly snapshots: string[];
  readonly stats: OpStats;
}

interface ClampRecord {
  readonly openingId: string;
  readonly beforeMm: number;
  readonly afterMm: number;
  readonly axisLengthMm: number;
  readonly widthMm: number;
}

interface OpStats {
  applied: number;
  skipped: number;
  /** 真正发生过夹取的次数（不是"检查过夹取"的次数）：测试 9 的防空跑下界 */
  clamps: number;
  /** 每种操作各成功派发过多少次：测试 5/7 靠它证明"分类检查真的见过删墙与改厚" */
  byKind: Record<ChainOp['kind'], number>;
  probes: {
    zeroLength: number;
    outOfHost: number;
    thickness: number;
    doorSill: number;
  };
  index: { compared: number; hits: number; empty: number; partial: number; pruned: number };
  corners: { same: number; mixed: number };
  oracleEntries: number;
}

const newStats = (): OpStats => ({
  applied: 0,
  skipped: 0,
  clamps: 0,
  byKind: { opening: 0, moveOpening: 0, deleteOpening: 0, movePoint: 0, thickness: 0, deleteWall: 0 },
  probes: { zeroLength: 0, outOfHost: 0, thickness: 0, doorSill: 0 },
  index: { compared: 0, hits: 0, empty: 0, partial: 0, pruned: 0 },
  corners: { same: 0, mixed: 0 },
  oracleEntries: 0,
});

/** 把一次运行的计数并进总账：跨 Counterexample 累计，末尾钉下界（关键判断 3 的"两边都数"）。 */
function absorbStats(into: OpStats, from: OpStats): void {
  into.applied += from.applied;
  into.skipped += from.skipped;
  into.clamps += from.clamps;
  for (const key of ['opening', 'moveOpening', 'deleteOpening', 'movePoint', 'thickness', 'deleteWall'] as const) {
    into.byKind[key] += from.byKind[key];
  }
  for (const key of ['zeroLength', 'outOfHost', 'thickness', 'doorSill'] as const) {
    into.probes[key] += from.probes[key];
  }
  for (const key of ['compared', 'hits', 'empty', 'partial', 'pruned'] as const) {
    into.index[key] += from.index[key];
  }
  into.corners.same += from.corners.same;
  into.corners.mixed += from.corners.mixed;
  into.oracleEntries += from.oracleEntries;
}

function wallJustCreated(log: TransactionLog): WallEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new TypeError('最近一次 dispatch 没有新建墙');
}

const liveWalls = (h: Harness): WallEntity[] =>
  h.log.document.byKind('wall').filter((w) => w.storeyId === h.storeyId);

const liveOpenings = (h: Harness) =>
  h.log.document.byKind('opening').filter((o) => o.storeyId === h.storeyId);

/**
 * 折线 → 真源。顶点 i 的点实体在画第 i 段时已经存在（除 i = 0），所以第 i 段
 * 有一端写 {pointId}、另一端写字面量 —— 共享端点就是这么进真源的（Task 3）。
 * `forward` 决定共享点落在 start 还是 end：相邻两段 forward 相同 ⇒ 混合角 (end,start)，
 * 不同 ⇒ 同向角 (start,start) / (end,end)。同向角才是 Task 4 那个 bug 的现场。
 */
function drawChain(
  shape: ChainShape,
  stats: OpStats = newStats(),
  onStep?: (log: TransactionLog, storeyId: string) => void,
): Harness {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: WALL_HEIGHT_MM }));
  const storeyId = log.document.byKind('storey')[0]!.id;
  // 测试 14 要的是"索引从一张空层开始长大"，所以回调在**一段墙都还没有**时先叫一次。
  // 其余 13 条都不传 onStep：可选参数保证它们的执行序列逐字不变。
  if (onStep) onStep(log, storeyId);
  const vertexIds: Array<string | undefined> = [];
  shape.walls.forEach((segment, i) => {
    const near = shape.points[i]!;
    const far = shape.points[i + 1]!;
    const shared = vertexIds[i];
    const sharedRef: PointRef = shared ? { pointId: shared } : near;
    const startRef: PointRef = segment.forward ? sharedRef : far;
    const endRef: PointRef = segment.forward ? far : sharedRef;
    log.dispatch(
      wallCreate({
        storeyId,
        start: startRef,
        end: endRef,
        thicknessMm: segment.thicknessMm,
        heightMm: WALL_HEIGHT_MM,
      }),
    );
    const wall = wallJustCreated(log);
    vertexIds[i] = segment.forward ? wall.startId : wall.endId;
    vertexIds[i + 1] = segment.forward ? wall.endId : wall.startId;
    if (onStep) onStep(log, storeyId);
  });
  return {
    log,
    storeyId,
    baseDepth: log.depth,
    snapshots: [log.document.canonical()],
    stats,
  };
}

/**
 * 洞口沿轴位置。写成"轴长减宽"的百分比而不是轴长的百分比，是为了让 `pct` 的上界与
 * 轴的长短无关：`to = d + w ≤ pct% × (L − w) + w < L` 对任意 `L > w` 恒成立，
 * 于是一句代数就挡住了 `openingCreate` 的"超出宿主墙"，生成器不需要 filter（关键判断 2）。
 * 传进来的 `percent` 最大 95，`w` 最大 1200，`L` 最小 3900 ⇒ `to ≤ 0.95L + 60 < L`。
 */
function legalDistanceMm(axisLengthMm: number, widthMm: number, percent: number): number {
  return Math.floor(((axisLengthMm - widthMm) * percent) / 100);
}

/**
 * 一步随机操作 → 命令，或 null（跳过并计数，关键判断 3）。
 * 这里不加 try/catch：planOp 里算过的界保证命令建得出补丁，真抛了就是缺陷，该红。
 * 三种"跳过"各有各的理由，都体现在返回值上而不是吞掉：
 *   - 没有可操作的实体（活墙/活洞口为空，或删到只剩一面）：继续跑测不出东西；
 *   - 目标墙上已经有洞口：非目标 2 的"一墙至多一樘"；
 *   - movePoint 没过试法：见 planOp 的 movePoint 分支。
 */
function planOp(h: Harness, op: ChainOp): Command | null {
  const doc = h.log.document;
  const walls = liveWalls(h);
  if (walls.length === 0) return null;
  const target = walls[op.index % walls.length]!;
  switch (op.kind) {
    case 'opening': {
      if (openingSpans(doc, target).length > 0) return null;
      const sillMm = op.category === 'door' ? 0 : WINDOW_SILL_MM;
      const lengthMm = axisLengthOf(doc, target);
      const distanceMm = legalDistanceMm(lengthMm, op.widthMm, op.distancePercent);
      // 横向由 legalDistanceMm 兜住（to < 轴长）。竖向：窗 900 + 2100 = 3000 正好压顶
      // （assertFitsAfterInsert 用 > 号，合法），再高就被这个 min 夹回来 ——
      // 界写在这里而不是生成器里，因为它是墙高的函数。
      const heightMm = Math.min(op.heightMm, WALL_HEIGHT_MM - sillMm);
      return openingCreate({
        hostWallId: target.id,
        distanceMm,
        widthMm: op.widthMm,
        heightMm,
        sillMm,
        category: op.category,
      });
    }
    case 'moveOpening': {
      const openings = liveOpenings(h);
      if (openings.length === 0) return null;
      const opening = openings[op.index % openings.length]!;
      const host = doc.get(opening.hostWallId);
      if (host?.kind !== 'wall') return null;
      const lengthMm = axisLengthOf(doc, host);
      // 同样走 legalDistanceMm：pct 最大 95 时 to 仍严格小于新轴长，
      // 于是 moveOpening 自己从不越界 —— 越界只由"墙先变短"造成，那正是测试 9 要数的夹取。
      const distanceMm = legalDistanceMm(lengthMm, opening.widthMm, op.distancePercent);
      return openingMove({ openingId: opening.id, distanceMm });
    }
    case 'deleteOpening': {
      const openings = liveOpenings(h);
      if (openings.length === 0) return null;
      return openingDelete({ openingId: openings[op.index % openings.length]!.id });
    }
    case 'movePoint': {
      // 用 dx/dy 的符号决定拖哪一端：不加新槽位，也不引入"每步只能拖 start"的偏差
      const end: 'start' | 'end' = op.dy >= 0 ? 'start' : 'end';
      const pointId = end === 'start' ? target.startId : target.endId;
      const here = pointAt(doc, pointId);
      const coords = coordsOf(doc);
      coords.set(pointId, { x: here.x + op.dx, y: here.y + op.dy });
      if (!withinChainBounds(endsByPoint(coords, doc, h.storeyId).values())) return null;
      return wallMoveEndpoint({ wallId: target.id, end, x: here.x + op.dx, y: here.y + op.dy });
    }
    case 'thickness': {
      // 从已有的随机槽位派生 100..400 的整数百：不新增生成器字段，也不出关键判断 2 的界。
      // 异厚角是闭式解最吃紧的地方（h_self 与 h_other 不等，两条边的斜切量差很多）。
      const thicknessMm = 100 + ((op.index + Math.abs(op.dx)) % 4) * 100;
      if (thicknessMm === target.thicknessMm) return null;
      return wallSetThickness({ wallId: target.id, thicknessMm });
    }
    case 'deleteWall': {
      if (walls.length < 2) return null;
      return wallDelete({ wallId: target.id });
    }
  }
}

/** 派发前记下每个洞口的 distanceMm，派发后比对 —— 洞口实体一律现读，不留镜像。 */
function openingDistances(doc: Document): Map<string, number> {
  const out = new Map<string, number>();
  for (const opening of doc.byKind('opening')) out.set(opening.id, opening.distanceMm);
  return out;
}

/**
 * 夹取的判据不是"距离变了"，而是"距离变成了 floor(轴长 − 宽)"。
 * 后者是 clampOpeningsToWall 的算法本身，跑在它外面才算第二份证据；
 * 顺带钉"动过的必然曾经越界"（before + w > 新轴长）与"落地后仍在宿主墙里"。
 *
 * `causedByWallEdit` 是这条记录能成立的前提，不是修饰：`openingMove` 也会改 distanceMm，
 * 而它是合法位移。把两种改混成一谈，第一簇随机 moveOpening 就会撞上
 * `before + w > 轴长` 而红在无关的操作上 —— 只有 wallMoveEndpoint 会缩短轴长
 * （wallSetThickness 与 wallDelete 都不动别的墙的轴长，见 Task 3 的自厚守卫），
 * 所以只有它引发的位移才配叫夹取。
 */
function recordClamps(h: Harness, before: Map<string, number>, causedByWallEdit: boolean): void {
  const doc = h.log.document;
  for (const [id, distanceMm] of before) {
    const opening = doc.get(id);
    if (opening?.kind !== 'opening') continue;
    if (opening.distanceMm === distanceMm) continue;
    const host = doc.get(opening.hostWallId);
    if (host?.kind !== 'wall') continue;
    const axisLengthMm = axisLengthOf(doc, host);
    if (!causedByWallEdit) {
      // 洞口是自己被挪的：只钉"仍然整个待在宿主墙里"，不记进夹取账
      expect(opening.distanceMm + opening.widthMm).toBeLessThanOrEqual(axisLengthMm);
      continue;
    }
    const record: ClampRecord = {
      openingId: id,
      beforeMm: distanceMm,
      afterMm: opening.distanceMm,
      axisLengthMm,
      widthMm: opening.widthMm,
    };
    h.stats.clamps++;
    expect(record.beforeMm + record.widthMm).toBeGreaterThan(record.axisLengthMm);
    expect(record.afterMm).toBe(Math.floor(record.axisLengthMm - record.widthMm));
    expect(record.afterMm + record.widthMm).toBeLessThanOrEqual(record.axisLengthMm);
  }
}

function checkBounds(h: Harness): void {
  assertChainBounds(endsByPoint(coordsOf(h.log.document), h.log.document, h.storeyId).values());
}

/** 接头分类与真源端点计数一致；链上不该出现 tee/cross/star（非目标 1 的反面）。 */
function checkKinds(h: Harness): void {
  const doc = h.log.document;
  const groups = endsByPoint(coordsOf(doc), doc, h.storeyId);
  const joints = deriveJoints(doc);
  expect(joints.map((j) => j.pointId)).toEqual([...groups.keys()].sort());
  for (const joint of joints) {
    const bucket = groups.get(joint.pointId);
    if (!bucket) throw new TypeError(`接头 ${joint.pointId} 在真源里没被任何墙端引用`);
    expect(joint.members.length).toBe(bucket.length);
    expect(joint.kind).toBe(bucket.length === 1 ? 'free' : 'corner');
    expect(['tee', 'cross', 'star']).not.toContain(joint.kind);
    if (bucket.length === 2) {
      // 同向角 vs 混合角：Task 4 的配对 bug 只在同向角上露头，这里数着它（测试 13 吃这个数）
      if (bucket[0]!.end === bucket[1]!.end) h.stats.corners.same++;
      else h.stats.corners.mixed++;
    }
  }
  expect(implementationTrims(doc).size).toBe(2 * liveWalls(h).length);
}

/**
 * 接缝闭合：角上两墙在该端的两枚角点两两重合；自由端的两枚角点关于共享点对称。
 * 这条**抓不到**边线配对错（错配对也是同一个交点，两墙共用 —— 关键判断 1），
 * 它抓的是环序改动与"角点没按斜切量摆"。
 * 下标 [0,3] = start 侧、[1,2] = end 侧用的是 WallQuad 契约表里那条环序：
 * 那是接口约定，不是几何约定（Step 6 第 5 处变异专门冲它红）。
 */
function checkContours(h: Harness): void {
  const doc = h.log.document;
  const groups = endsByPoint(coordsOf(doc), doc, h.storeyId);
  const quads = new Map(deriveWallQuads(doc).map((q) => [q.wallId, q] as const));
  const atEnd = (e: EndVec): Vec[] => {
    const quad = quads.get(e.wallId);
    if (!quad) throw new TypeError(`墙 ${e.wallId} 没有轮廓`);
    return e.end === 'start' ? [quad.corners[0], quad.corners[3]] : [quad.corners[1], quad.corners[2]];
  };
  for (const bucket of groups.values()) {
    if (bucket.length === 1) {
      const [only] = bucket as [EndVec];
      const pts = atEnd(only);
      expectSamePointSet(
        pts,
        pts.map((p) => ({ x: 2 * only.p.x - p.x, y: 2 * only.p.y - p.y })),
      );
      continue;
    }
    const [a, b] = bucket as [EndVec, EndVec];
    expectSamePointSet(atEnd(a), atEnd(b));
  }
}

/**
 * 洞口分段与洞口区间严格互补 —— 结构比对，端点精确相等。
 * 为什么不用"Σ 段长 = 轴长 − Σ 洞宽"：浮点求和会把 ±1mm 的错位摊进余量。
 * 这里的内端点全是整数（distance/width 是整数毫米），只有最后一段的 toMm 是浮点轴长，
 * 而它与 axisLengthOf 同为 Math.hypot 的结果，逐位相同，所以 toEqual 敢用 === 比浮点。
 */
function checkSpans(h: Harness): void {
  const doc = h.log.document;
  const geometry = deriveStoreyGeometry(doc, h.storeyId);
  const piecesOf = new Map<string, WallPiece[]>();
  for (const piece of geometry.pieces) {
    const list = piecesOf.get(piece.wallId);
    if (list) list.push(piece);
    else piecesOf.set(piece.wallId, [piece]);
  }
  for (const wall of liveWalls(h)) {
    const lengthMm = axisLengthOf(doc, wall);
    const expected: WallPiece[] = [];
    let cursor = 0;
    for (const span of openingSpans(doc, wall)) {
      if (span.fromMm > cursor) expected.push({ wallId: wall.id, fromMm: cursor, toMm: span.fromMm });
      cursor = span.toMm;
    }
    if (cursor < lengthMm) expected.push({ wallId: wall.id, fromMm: cursor, toMm: lengthMm });
    expect(piecesOf.get(wall.id) ?? []).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  }
}

function checkOracle(h: Harness): void {
  h.stats.oracleEntries += expectTrimsMatchOracle(h.log.document, h.storeyId);
}

/**
 * 非法写：抛对中文错 + 文档/栈深/affected 三样都不动。
 * 深比对 canonical 而不是比对象身份：抛之前偷改一处，对象还是那个对象，身份比不出来。
 */
function expectRejected(h: Harness, make: () => Command, pattern: RegExp): void {
  const log = h.log;
  const before = log.document.canonical();
  const depth = log.depth;
  const affected = [...log.affected].sort();
  expect(() => log.dispatch(make())).toThrow(pattern);
  expect(log.document.canonical()).toBe(before);
  expect(log.depth).toBe(depth);
  expect([...log.affected].sort()).toEqual(affected);
}

/**
 * 四种探针按抛在哪一层分两组（关键判断 4）：前三条抛在 build，才真正考 dispatch 的时序；
 * 第四条抛在构造期，dispatch 根本没被调用，"文档没动"是白送的。
 * 正则全部抄自 Task 3 / Task 7 已写下的断言。
 */
function checkIllegalWrites(h: Harness): void {
  const doc = h.log.document;
  const walls = liveWalls(h);
  if (walls.length === 0) return;
  const host = walls[0]!;
  // 1（build）：两端复用同一个 pointId —— 只有解析引用之后才知道是同一个点
  expectRejected(
    h,
    () =>
      wallCreate({
        storeyId: h.storeyId,
        start: { pointId: host.startId },
        end: { pointId: host.startId },
        thicknessMm: 240,
        heightMm: WALL_HEIGHT_MM,
      }),
    /零长/,
  );
  h.stats.probes.zeroLength++;
  // 2（build）：把洞口挪出宿主墙末端。Math.round 不能省 —— 轴长是浮点，
  // 直接 +1000 会让 openingMove 在构造期就抛"整数毫米"，那就白测了 build 的时序。
  const opening = liveOpenings(h)[0];
  const openingHost = opening ? doc.get(opening.hostWallId) : undefined;
  if (opening && openingHost?.kind === 'wall') {
    const overshoot = Math.round(axisLengthOf(doc, openingHost)) + 1000;
    expectRejected(h, () => openingMove({ openingId: opening.id, distanceMm: overshoot }), /超出宿主墙/);
    h.stats.probes.outOfHost++;
  }
  // 3（build）：墙厚调到不小于轴长
  const tooThick = Math.round(axisLengthOf(doc, host)) + 10;
  expectRejected(h, () => wallSetThickness({ wallId: host.id, thicknessMm: tooThick }), /不小于墙长/);
  h.stats.probes.thickness++;
  // 4（构造期）：门洞带窗台。考不到 dispatch 时序，留着是让两组并排看得见差别。
  expectRejected(
    h,
    () =>
      openingCreate({
        hostWallId: host.id,
        distanceMm: 0,
        widthMm: 700,
        heightMm: 1000,
        sillMm: 300,
        category: 'door',
      }),
    /门洞窗台高必须为 0/,
  );
  h.stats.probes.doorSill++;
}

type Checker = (h: Harness) => void;

/**
 * 每步跑的检查。顺序有讲究：bounds 在最前 —— 它一破，后面的预言与轮廓比对都是在比
 * 一个前提已经不成立的状态，红出来会把人引去改实现。索引那条不进这个数组：
 * 它每步多建一次整层索引，只有测试 10 付这个钱。
 */
const CHECK_ALL: Checker[] = [
  checkBounds,
  checkKinds,
  checkContours,
  checkSpans,
  checkOracle,
  checkIllegalWrites,
];

function runOps(shape: ChainShape, ops: ChainOp[], checkers: Checker[], stats?: OpStats): Harness {
  const h = drawChain(shape, stats);
  for (const op of ops) {
    const cmd = planOp(h, op);
    if (!cmd) {
      h.stats.skipped++;
      continue;
    }
    const distances = openingDistances(h.log.document);
    h.log.dispatch(cmd);
    h.stats.applied++;
    h.stats.byKind[op.kind]++;
    // 紧跟 dispatch：before 只有在这一刻还在
    recordClamps(h, distances, op.kind === 'movePoint');
    h.snapshots.push(h.log.document.canonical());
    for (const check of checkers) check(h);
  }
  // 每步必须有交代：既不许偷偷 skip 掉一半，也不许有操作类型一次都没跑过就被"验证"了
  expect(h.stats.applied + h.stats.skipped).toBe(ops.length);
  return h;
}
```

三条约定值得单独说一句，因为它们各挡一种"绿着骗人"：

1. **`recordClamps` 里的断言写在记录的同时**，不交给某个 `checkClamps`。夹取只存在于"派发前后洞口实体的差"里，错过那一刻就再也取不到 `before` —— 检查器拿到的是已经落地的事实，比不了"曾经越界"。
2. **`byKind` 按操作类型分开数**。`applied > 0` 只证明跑过 *某种* 操作：`deleteWall` 是 Task 9 双向闭包那条漏网边（删墙 → 邻墙盒子发霉），它一次没跑过而整条属性仍绿，是最容易骗人的空跑。所以测试 5 直接钉 `byKind.deleteWall > 0` 与 `byKind.thickness > 0`，而不是笼统钉 applied。
3. **`Harness` 里没有索引字段**，`SpatialIndex` 只活在测试 10 的 `runOpsWithIndex` 局部。索引每步要额外建一次整层全量索引才能比对"增量 == 全量"，把它塞进 `CHECK_ALL` 会让真正走全表的测试 5 与测试 11 慢一截却什么都不多证 —— 便宜的检查每步跑，贵的那条单独开一测。曾经往 `Harness` 上挂过一个 `index` 字段，赋值一次、没人读，删了（理由记在下面第 4 条）。

**第 ③ 段：四个 `describe`（14 条）**

```ts
// ---------- ③ 用例 ----------

/**
 * 严格凸：相邻三点的叉积同号且非零。本文件自己写一份，不从 outline.test.ts 借 ——
 * 借来的那份与借出方同源，就不再是第二份证据（Task 5 里同样是复制的）。
 * 判据用精确 0：随机链的 sinθ ≥ 0.49 由 checkBounds 先钉住，这里不会有擦边零。
 */
function strictlyConvex(pts: readonly Vec[]): boolean {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const c = pts[(i + 2) % pts.length]!;
    const turn = cross(sub(b, a), sub(c, b));
    if (turn === 0) return false;
    if (sign === 0) sign = Math.sign(turn);
    else if (Math.sign(turn) !== sign) return false;
  }
  return true;
}

/** 反向画：顶点数组反序，`forward` 一律不动 —— 反序本身已把每面墙的 start/end 对调了。 */
function reverseChain(shape: ChainShape): ChainShape {
  return { points: [...shape.points].reverse(), walls: [...shape.walls] };
}

// ---------- 三条跑序列的工具：放在两个 describe 之前，读的人不用往后翻 ----------

/**
 * 一轮"随机链 + 随机操作序列"。放在 module 级是因为测试 13 也要跑同样一轮：
 * 定义在 describe B 里面的话，describe C 只能把 runOps 再抄一遍。
 */
function runAll(
  assert: (shape: ChainShape, ops: ChainOp[], h: Harness) => void,
  total: OpStats,
  checkers: Checker[] = CHECK_ALL,
): void {
  fc.assert(
    fc.property(arbChainShape, arbChainOps, (shape, ops) => {
      const stats = newStats();
      const h = runOps(shape, ops, checkers, stats);
      assert(shape, ops, h);
      absorbStats(total, stats);
    }),
    { numRuns: NUM_RUNS_OPS },
  );
}

/**
 * 手写的闭区间相交判据 —— 故意不调 `aabbIntersects`。
 * Task 9 的变异 3 就是这件事的教材：它的 bruteForce 与 query 共用 aabbIntersects，
 * 把 `<=` 改成 `<` 两边一起错、比对照样绿，红的是另两条反证。
 * 这里另写一份，谁把闭区间改成开区间，这条立刻红。
 */
function overlaps(a: Aabb, b: Aabb): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

function bruteOverlaps(entries: readonly IndexEntry[], rect: Aabb): string[] {
  return entries
    .filter((entry) => overlaps(entry.aabb, rect))
    .map((entry) => entry.id)
    .sort();
}

interface ProbeRects {
  readonly tight: Aabb;
  readonly full: Aabb;
  readonly empty: Aabb;
  readonly point: Vec;
  readonly jointWalls: string[];
}

/**
 * 三个探针矩形各司其职，缺一个就有空跑的余地：
 * tight（贴着一个接头的小盒）证明能命中且不报全表，full（整层外框）证明不漏，
 * empty（外框平移一百万）证明能说"没有"。point 是拾取：P 是那枚共享端点，
 * 它必须落在**每一个成员墙**的盒子里 —— 这条不是白送的，界要算：
 * 沿轴方向，P 那一端的角点最多外伸 `trim ≤ (400 + 400) / 0.49 ≈ 1633mm`（闭式解里
 * `sinθ ≥ MIN_SIN`、半厚 ≤ 200），而远端的角点最少也在 `3900 − 1633 > 0` 处，
 * 所以墙盒在轴向上跨过 P；法向一侧两枚角点恒为 ±h，P 正落在中间。
 * 两个界都靠 `checkBounds` 先钉住轴长 ≥ 3900 与 sinθ ≥ 0.49，破了就是前提红而不是这里红。
 *
 * full 的 ±1 余量为什么够：索引里只有两类盒子 —— 墙盒就是它自己四枚角点的 AABB，
 * 洞口盒是宿主墙带内的一块（`openingAabb` 取 span 两端 ± 自身 half，横向往内收、
 * 竖向正好等于 half thickness）—— 两者都落在全体角点取极值再外扩 1mm 的框里。
 */
function probeRects(h: Harness, n: number): ProbeRects {
  const doc = h.log.document;
  const groups = [...endsByPoint(coordsOf(doc), doc, h.storeyId).values()];
  const bucket = groups[n % groups.length]!;
  const p = bucket[0]!.p;
  const corners = deriveWallQuads(doc).flatMap((q) => [...q.corners]);
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const full: Aabb = {
    minX: Math.min(...xs) - 1,
    minY: Math.min(...ys) - 1,
    maxX: Math.max(...xs) + 1,
    maxY: Math.max(...ys) + 1,
  };
  return {
    tight: { minX: p.x - 1, minY: p.y - 1, maxX: p.x + 1, maxY: p.y + 1 },
    full,
    empty: { minX: full.minX + 1_000_000, minY: full.minY, maxX: full.minX + 1_000_001, maxY: full.minY },
    point: p,
    jointWalls: bucket.map((e) => e.wallId),
  };
}

/**
 * 索引不进 `runOps`，而是把同一条序列**再跑一遍**、这一遍带着索引。
 * 为什么不塞进 runOps 的某个位置：`applyAffected` 要拿"这一笔的 `log.affected`"，
 * 而 `checkIllegalWrites` 自己 dispatch 过一次就把 affected 换掉了 —— 除非给 runOps
 * 钉一条"索引必须排在探针前面"的隐式顺序。隐式顺序迟早被下一次插入的检查打破，
 * 不如把这一遍自己写出来：它的成本只多付一次 dispatch 与一次全量重建，不多证任何东西，
 * 但也不需要跟别的检查抢时机。
 *
 * "同一条序列再跑一遍"而不是"把 Command 对象重放进新日志"，是因为后者根本走不通：
 * 新日志里的 pointId / wallId 全是新造的 uuid，老命令里的 `{ pointId }` 引用与 wallId
 * 全都指不到东西。而 planOp 只看几何与 `op.index % 存活数`，uuid 谁大都影响不到选谁，
 * 所以两轮的墙数、洞口数、每步走哪个分支逐笔相同 —— 这才是可重放的口径。
 */
function runOpsWithIndex(shape: ChainShape, ops: ChainOp[], stats: OpStats): void {
  const h = drawChain(shape, stats);
  const index = SpatialIndex.fromDoc(h.log.document, h.storeyId);
  let probeCount = 0;
  const probe = (): void => {
    const doc = h.log.document;
    const live = index.snapshot();
    expect(live).toEqual(SpatialIndex.fromDoc(doc, h.storeyId).snapshot());
    const rects = probeRects(h, probeCount++);
    for (const rect of [rects.tight, rects.full, rects.empty]) {
      expect(index.query(rect)).toEqual(bruteOverlaps(live, rect));
      stats.index.compared++;
    }
    expect(index.query(rects.full)).toEqual(live.map((e) => e.id));
    expect(index.query(rects.empty)).toEqual([]);
    const tight = index.query(rects.tight);
    if (tight.length > 0) stats.index.hits++;
    if (tight.length < live.length) stats.index.partial++;
    if (live.length > 0 && index.cellVisits(rects.tight) < index.cellVisits(rects.full)) {
      stats.index.pruned++;
    }
    if (index.query(rects.empty).length === 0) stats.index.empty++;
    const picked = index.queryPoint(rects.point.x, rects.point.y);
    for (const wallId of rects.jointWalls) expect(picked).toContain(wallId);
  };
  probe();
  for (const op of ops) {
    const cmd = planOp(h, op);
    if (!cmd) {
      stats.skipped++;
      continue;
    }
    const distances = openingDistances(h.log.document);
    h.log.dispatch(cmd);
    stats.applied++;
    stats.byKind[op.kind]++;
    recordClamps(h, distances, op.kind === 'movePoint');
    // 唯一的、真正的差别：affected 还热着
    index.applyAffected(h.log.document, h.log.affected);
    probe();
    checkBounds(h);
  }
  expect(stats.applied + stats.skipped).toBe(ops.length);
}

/**
 * 撤销到底再重做：每个中间态必须逐字节复现。
 * 从快照 0（画完链、动手之前）起算，栈深 == 快照数 − 1 先钉住，
 * 否则"少撤一笔"与"多撤一笔"都可能被后面的 canonical 比对放过。
 */
function expectReplay(h: Harness): void {
  const snaps = h.snapshots;
  expect(h.log.depth).toBe(h.baseDepth + snaps.length - 1);
  expect(snaps.length).toBe(h.stats.applied + 1);
  for (let i = snaps.length - 1; i >= 1; i--) {
    expect(h.log.undo()).toBe(true);
    expect(h.log.document.canonical()).toBe(snaps[i]);
  }
  expect(h.log.document.canonical()).toBe(snaps[0]);
  for (let i = 1; i < snaps.length; i++) {
    expect(h.log.redo()).toBe(true);
    expect(h.log.document.canonical()).toBe(snaps[i]);
  }
  expect(h.log.canRedo).toBe(false);
  // 重放完之后，几何还得是活的状态：撤销重做的不是字符串，是那张图。
  // 探针那条不在这里跑：它每回要 dispatch 四次注定失败的命令，跟"重放完图还活着"无关。
  for (const check of CHECK_ALL.filter((c) => c !== checkIllegalWrites)) check(h);
}

describe('闭式解预言：按侧比对，不按多重集', () => {
  const drawn = (
    points: readonly [Vec, Vec, Vec],
    walls: readonly [
      { thicknessMm: number; forward: boolean },
      { thicknessMm: number; forward: boolean },
    ],
  ): Harness => drawChain({ points, walls });

  /** 混合角 (end, start)：A (0,0)→(1000,0)，B 从 (1000,0) 北上。 */
  const mixedCorner = (ta: number, tb: number) =>
    drawn([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 800 }], [
      { thicknessMm: ta, forward: true },
      { thicknessMm: tb, forward: true },
    ]);

  /**
   * 同向角 (start, start)：两面墙都从 (0,0) 起画。
   * 这是 Task 4 那个配对 bug 唯一露头的形状（两条墙都从共享点出发时，
   * 各自的 +normal 一内一外，"同侧配对"会取到外面那个交点）。
   */
  const startStartCorner = (ta: number, tb: number) =>
    drawn([{ x: 1000, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1000 }], [
      { thicknessMm: ta, forward: false },
      { thicknessMm: tb, forward: true },
    ]);

  /** 按几何认成员（水平轴的那面墙在前），不靠分组顺序 —— 预言与成员先后无关，测试也不该依赖它。 */
  function jointMembers(h: Harness): [EndVec, EndVec] {
    const doc = h.log.document;
    const buckets = [...endsByPoint(coordsOf(doc), doc, h.storeyId).values()];
    const joint = buckets.find((b) => b.length === 2);
    if (!joint) throw new TypeError('夹具里没有二成员接头');
    const [a, b] = [joint[0]!, joint[1]!];
    return a.inward.y === 0 ? [a, b] : [b, a];
  }

  it('手算三个接头：等厚直角、异厚直角、3-4-5 钝角；遇三成员必须抛', () => {
    // (a) 等厚直角。i_A = (−1,0)、i_B = (0,1) ⇒ cosθ = 0、sinθ = 1，两侧都恰为半厚 120。
    const h1 = mixedCorner(240, 240);
    const [a1, b1] = jointMembers(h1);
    const t1a = expectedTrims(a1, b1);
    const t1b = expectedTrims(b1, a1);
    expect([t1a.innerSide, t1b.innerSide]).toEqual([1, 1]);
    expect(t1a.left).toBeCloseTo(120, 9);
    expect(t1b.left).toBeCloseTo(120, 9);
    expect(expectTrimsMatchOracle(h1.log.document, h1.storeyId)).toBe(2);

    // (b) 异厚直角 200 / 370：薄墙切得比厚墙多（185 vs 100），凹角点在 (815, 100)。
    const h2 = mixedCorner(200, 370);
    const [a2, b2] = jointMembers(h2);
    const t2a = expectedTrims(a2, b2);
    const t2b = expectedTrims(b2, a2);
    expect(t2a.left).toBeCloseTo(185, 9);
    expect(t2b.left).toBeCloseTo(100, 9);
    expect(t2a.left).toBeGreaterThan(t2b.left);
    const p2 = oracleCornerPoints(a2, b2);
    expect(p2.inner.x).toBeCloseTo(815, 9);
    expect(p2.inner.y).toBeCloseTo(100, 9);
    expect(expectTrimsMatchOracle(h2.log.document, h2.storeyId)).toBe(2);

    // (c) 3-4-5 钝角（θ ≈ 126.87°，cosθ = −0.6、sinθ = 0.8），异厚 200 / 370。
    //     斜切量异号：B 的 trimLeft 是 −13.75 —— 负数意味着 B 的轮廓**越过**共享点往外伸，
    //     这是 JointMember 契约里"可正可负"那条唯一的定值凭据之一（另一条在 Task 4）。
    const h3 = drawn([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 4000, y: 4000 }], [
      { thicknessMm: 200, forward: true },
      { thicknessMm: 370, forward: true },
    ]);
    const [a3, b3] = jointMembers(h3);
    const t3a = expectedTrims(a3, b3);
    const t3b = expectedTrims(b3, a3);
    expect(t3a.left).toBeCloseTo(156.25, 9);
    expect(t3a.right).toBeCloseTo(-156.25, 9);
    expect(t3b.left).toBeCloseTo(-13.75, 9);
    expect(t3b.right).toBeCloseTo(13.75, 9);
    const p3 = oracleCornerPoints(a3, b3);
    expect(p3.inner.x).toBeCloseTo(843.75, 9);
    expect(p3.inner.y).toBeCloseTo(100, 9);
    expect(p3.outer.x).toBeCloseTo(1156.25, 9);
    expect(p3.outer.y).toBeCloseTo(-100, 9);
    expect(expectTrimsMatchOracle(h3.log.document, h3.storeyId)).toBe(2);

    // 预言只证过二成员：喂它一个 tee 必须抛，不许悄悄拿前两个成员算完给个绿。
    const tee = new TransactionLog(Document.create(projectId));
    tee.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: WALL_HEIGHT_MM }));
    const teeStorey = tee.document.byKind('storey')[0]!.id;
    tee.dispatch(
      wallCreate({
        storeyId: teeStorey,
        start: { x: 0, y: 0 },
        end: { x: 4000, y: 0 },
        thicknessMm: 240,
        heightMm: WALL_HEIGHT_MM,
      }),
    );
    const junction = wallJustCreated(tee).endId;
    for (const end of [{ x: 8000, y: 0 }, { x: 4000, y: 3000 }]) {
      tee.dispatch(
        wallCreate({
          storeyId: teeStorey,
          start: { pointId: junction },
          end,
          thicknessMm: 240,
          heightMm: WALL_HEIGHT_MM,
        }),
      );
    }
    const teeBuckets = [
      ...endsByPoint(coordsOf(tee.document), tee.document, teeStorey).values(),
    ];
    expect(teeBuckets.some((b) => b.length === 3)).toBe(true);
    expect(() => assertChainBounds(teeBuckets)).toThrow(/挂了 3 个墙端/);
    expect(() => oracleTrims(tee.document, teeStorey)).toThrow(/挂了 3 个墙端/);
  });
```

`toBe(2)` 是防空气的关键：三个 fixture 各有 1 个角、2 个 keyed 端点，返回 0 意味着预言一条都没比（比如 `jointMembers` 挑错了 bucket，或 `oracleTrims` 的 key 拼错）。**每个 fixture 都要单独拿一个 `toBe(2)`**，不能三个 fixture 合起来比一次：合起来时 (a) 没比、(c) 比了两遍也是 2。

```ts
  it('按侧比对才有区分力：交换两侧后多重集不变、按侧全错', () => {
    const h = startStartCorner(240, 240);
    const [a, b] = jointMembers(h);
    const want = expectedTrims(a, b);
    const wantB = expectedTrims(b, a);
    const got = implementationTrims(h.log.document).get(`${a.wallId}:${a.end}`);
    if (!got) throw new TypeError('实现没给 A 的斜切量');
    // 两侧符号必须相反且非零，否则"交换"没有区分力，整条测试会白绿
    expect(want.left).not.toBe(want.right);
    expect(Math.abs(want.left)).toBeCloseTo(120, 9);
    expect(got).toEqual({ left: want.left, right: want.right });
    // 多重集口径放行配对 bug：交换后的两侧与原来同样"对"
    expect([want.left, want.right].sort()).toEqual([want.right, want.left].sort());
    expect(want.left).not.toBe(want.right);
    // 现场演示"接缝闭合为什么放行它"：等厚直角下，同侧配对等于把两墙的斜切量各自取反。
    // 那样 A 与 B 在该端的两枚角点**仍然是同样两个点**（下面第一行绿），
    // 但 A 的轮廓已经跨过共享点压到 B 的带里去了（第二行：错误的角点跑到 x < 0）。
    const buggyA = [vertexOf(a, 1, -want.left), vertexOf(a, -1, -want.right)];
    const buggyB = [vertexOf(b, 1, -wantB.left), vertexOf(b, -1, -wantB.right)];
    expectSamePointSet(buggyA, buggyB);
    const good = [vertexOf(a, 1, want.left), vertexOf(a, -1, want.right)];
    expect(sortPts(good).map(fmt)).not.toEqual(sortPts(buggyA).map(fmt));
    expect(Math.min(buggyA[0]!.x, buggyA[1]!.x)).toBeLessThan(0);
    expect(Math.min(good[0]!.x, good[1]!.x)).toBeGreaterThanOrEqual(0);
  });

  it('随机墙链：每个接头每一侧的斜切量都吻合闭式解', () => {
    let entries = 0;
    let runs = 0;
    fc.assert(
      fc.property(arbChainShape, (shape) => {
        runs++;
        const h = drawChain(shape);
        entries += expectTrimsMatchOracle(h.log.document, h.storeyId);
      }),
      { numRuns: NUM_RUNS_LIGHT },
    );
    expect(runs).toBe(NUM_RUNS_LIGHT);
    // 链至少 2 段 ⇒ 至少 1 个二成员接头 ⇒ 每次运行至少 2 条 keyed 比对。
    // 达不到这个量就是空跑：要么 key 拼错了，要么 oracleTrims 的分组没吃到角。
    expect(entries).toBeGreaterThanOrEqual(2 * NUM_RUNS_LIGHT);
  });

  it('随机墙链：接缝闭合、自由端对称、严格凸、面积 = 轴长 × 墙厚', () => {
    let quads = 0;
    fc.assert(
      fc.property(arbChainShape, (shape) => {
        const h = drawChain(shape);
        const doc = h.log.document;
        checkBounds(h);
        checkContours(h);
        const derived = deriveWallQuads(doc);
        expect(derived.length).toBe(liveWalls(h).length);
        for (const quad of derived) {
          expect(strictlyConvex(quad.corners)).toBe(true);
          const wall = doc.get(quad.wallId);
          if (wall?.kind !== 'wall') throw new TypeError(`轮廓 ${quad.wallId} 引用了不存在的墙`);
          // 这四条（闭合 / 对称 / 凸 / 面积）在错误配对下**全都照样成立** —— 测试 2 刚演过。
          // 它们是"轮廓有没有摆歪"的证据，不是"边线配对对不对"的证据，别拿它们代替测试 3。
          expect(quad.areaMm2).toBeCloseTo(axisLengthOf(doc, wall) * wall.thicknessMm, 6);
          quads++;
        }
      }),
      { numRuns: NUM_RUNS_LIGHT },
    );
    expect(quads).toBeGreaterThanOrEqual(2 * NUM_RUNS_LIGHT);
  });
});

describe('随机操作序列：每步之后逐条核对', () => {
  it('接头分类与真源端点计数一致，链上不出现 tee/cross/star', () => {
    const total = newStats();
    runAll(() => {}, total);
    // 分类检查真的见过"墙没了"与"墙变厚"：一次都没跑过的话，这一整轮只测了新建路径。
    // 概率：80 次 × 平均 12 步 = 960 步里一次都不落到某个 kind，约 (5/6)^960 ≈ 1e-78。
    expect(total.byKind.deleteWall).toBeGreaterThan(0);
    expect(total.byKind.thickness).toBeGreaterThan(0);
    expect(total.applied).toBeGreaterThan(0);
  });

  it('整条链始终守住关键判断 2 的三条界，且试法真的拦下过东西', () => {
    const total = newStats();
    runAll(() => {}, total, [checkBounds]);
    expect(total.applied).toBeGreaterThan(0);
    // 跳过量下界：拦不住任何东西的"试法"等于没写（关键判断 3 的最后一句）
    expect(total.skipped).toBeGreaterThan(0);
    expect(total.byKind.movePoint).toBeGreaterThan(0);
  });

  it('洞口分段与洞口区间严格互补，端点精确相等', () => {
    const total = newStats();
    runAll(() => {}, total, [checkBounds, checkSpans]);
    expect(total.byKind.opening).toBeGreaterThan(0);
    expect(total.byKind.moveOpening).toBeGreaterThan(0);
    expect(total.byKind.deleteOpening).toBeGreaterThan(0);
  });

  it('四种非法探针：抛对中文错，且文档 / 栈深 / affected 三样都不动', () => {
    const total = newStats();
    runAll(() => {}, total, [checkIllegalWrites]);
    // 四条各自下界：只钉"探针总数 > 0"的话，三条没跑过、一条跑了 99 次也是绿的
    expect(total.probes.zeroLength).toBeGreaterThan(0);
    expect(total.probes.thickness).toBeGreaterThan(0);
    expect(total.probes.doorSill).toBeGreaterThan(0);
    expect(total.probes.outOfHost).toBeGreaterThan(0);
  });

  it('缩墙夹取确实发生过，且每次夹到 floor(轴长 − 宽)', () => {
    const total = newStats();
    fc.assert(
      fc.property(arbChainShape, arbChainOps, (shape, ops) => {
        const stats = newStats();
        const h = drawChain(shape, stats);
        for (const op of ops) {
          const cmd = planOp(h, op);
          if (!cmd) {
            stats.skipped++;
            continue;
          }
          const distances = openingDistances(h.log.document);
          h.log.dispatch(cmd);
          stats.applied++;
          stats.byKind[op.kind]++;
          // 与 runOps 唯一的差别：recordClamps 必须紧跟 dispatch，晚一步 before 就没了。
          // 夹取公式在 recordClamps 里就地断言，这里只数"发生过没有"。
          recordClamps(h, distances, op.kind === 'movePoint');
          h.snapshots.push(h.log.document.canonical());
          checkBounds(h);
          checkSpans(h);
        }
        expect(stats.applied + stats.skipped).toBe(ops.length);
        absorbStats(total, stats);
      }),
      { numRuns: NUM_RUNS_OPS },
    );
    expect(total.clamps).toBeGreaterThan(0);
    expect(total.byKind.movePoint).toBeGreaterThan(0);
  });

  it('索引：增量 == 全量 == 手算暴力扫，五类计数都非零', () => {
    const total = newStats();
    fc.assert(
      fc.property(arbChainShape, arbChainOps, (shape, ops) => {
        const stats = newStats();
        runOpsWithIndex(shape, ops, stats);
        absorbStats(total, stats);
      }),
      { numRuns: NUM_RUNS_INDEX },
    );
    expect(total.index.compared).toBeGreaterThan(0);
    expect(total.index.empty).toBeGreaterThan(0);
    expect(total.index.partial).toBeGreaterThan(0);
    expect(total.index.pruned).toBeGreaterThan(0);
    expect(total.index.hits).toBeGreaterThan(0);
  });

  it('撤销到底再重做，每个中间态逐字节复现', () => {
    let replays = 0;
    fc.assert(
      fc.property(arbChainShape, arbChainOps, (shape, ops) => {
        const h = runOps(shape, ops, []);
        expectReplay(h);
        replays += h.snapshots.length;
      }),
      { numRuns: NUM_RUNS_OPS },
    );
    // 比对的快照张数：每步一张，80 次运行至少 80 × (1 + 6) 张（序列最短 6 步）
    expect(replays).toBeGreaterThanOrEqual(NUM_RUNS_OPS * 7);
  });
});
```

`expect(stats.applied + stats.skipped).toBe(ops.length)` 写在 `runOps` 与 `runOpsWithIndex` 的末尾，不写进各测试：凡走序列的属性都必须"每步有交代"，漏一条就红。这条与计划 1 的 `expect(executed).toBe(numRuns)` 是同一族哨兵。

**这一步删掉了四样东西**，各自代表一种会复发的错法，留在这里当本任务的执行日志前四条：

1. **把 Command 对象重放进第二份日志**（原叫 `checkIndexFromScratch`）。走不通：新日志里的 `pointId` / `wallId` 是新造的 uuid，老命令里的 `{ pointId }` 引用与 `wallId` 一个都指不到东西。改成"同一条序列再跑一遍、这一遍带索引"（`runOpsWithIndex`），凭据是 `planOp` 只看几何与 `op.index % 存活数` —— 两轮的墙数、洞口数、每步走哪个分支逐笔相同，只有 uuid 不同，而 uuid 不参与任何选择。
2. **把"洞口距离变了"当成"被夹了"**。`openingMove` 也改 `distanceMm`，而且是合法位移：照原写法每一条随机 moveOpening 都会撞上 `before + w > 轴长` 那条断言，红在无关的操作上。`recordClamps` 现在收 `causedByWallEdit`，只有 `wallMoveEndpoint` 会缩轴长（`wallSetThickness` 连自己那面墙的轴长都不动 —— Task 3 的自厚守卫；`wallDelete` 只拆不建）。
3. **为了让某个检查进 `CHECK_ALL` 而写一个空壳 Checker**（原叫 `recordClampsAsChecker`）。夹取记录依赖"派发前后各读一次实体"这个时机，天生不是 Checker；测试 9 于是自己跑循环，而 `runOps` 里那行 `recordClamps` 保留 —— 别的测试顺带也记账，只是不看。
4. **`Harness` 上两个只写不读的字段**（`clamps: ClampRecord[]` 与 `index: SpatialIndex | null`）。前者每次夹取 push 一条，而承重的三行 `expect` 用的是当场构造的 `record`，那个数组没有任何一条断言读它；后者赋值一次给闭包外的谁都不看。它们不是"以防要查"的账本，是**看着像状态、其实是空气**的字段：加进去之后 `Harness` 的读者会以为"索引与夹取史是每轮都攒着的公共事实"，于是下一条测试会去读一个从没被正确维护的东西。判据很简单 —— 一个字段如果只有一处写、零处读，它要么变成断言，要么消失。`ClampRecord` 这个类型留下（它给 `record` 那三行断言定形状），数组不留。

**第 ③ 段（续）：第三个 `describe`（测试 12、13）**

```ts
// ---------- ③ 段（续）：生成器自觉 ----------

/** Σ 轮廓面积。反向画前后必须同一个数（逐墙恒等式求和，不是并集面积）。 */
const areaSum = (quads: readonly WallQuad[]): number =>
  quads.reduce((total, quad) => total + quad.areaMm2, 0);

/**
 * 相对容差比对。不用 toBeCloseTo(x, 6)：那要求绝对差 < 5e-7，而这里的数在 1e7 量级，
 * 双精度在这个量级的固有噪声本身就有 1e-9 级，求和顺序又跟着 uuid 排序变。
 * 1e-9 的相对容差 = 1e-2 mm² 的绝对容差：比噪声大七个数量级，比任何真实几何改动小三个数量级
 * （改动最小的形态是挪掉一个 100×100 的角 = 10000 mm²）。
 */
function expectNearRel(got: number, want: number, label: string): void {
  const tol = 1e-9 * Math.max(1, Math.abs(want));
  if (Math.abs(got - want) > tol) {
    throw new Error(`${label} 反向画前后不等：${got} vs ${want}（容差 ${tol}）`);
  }
}

describe('生成器自觉：这个随机空间真长出过我们要的东西吗', () => {
  it('反向画同一条链：接头规模、墙数、Σ 面积、全体角点集合四项不变', () => {
    let quads = 0;
    fc.assert(
      fc.property(arbChainShape, (shape) => {
        const a = drawChain(shape);
        const b = drawChain(reverseChain(shape));
        checkBounds(a);
        checkBounds(b);
        // 只比"每个接头挂几个墙端"的多重集：pointId 是 uuid，两份日志之间没法按 id 对上
        const sizes = (h: Harness): number[] =>
          deriveJoints(h.log.document)
            .map((j) => j.members.length)
            .sort();
        expect(sizes(a)).toEqual(sizes(b));
        const qa = deriveWallQuads(a.log.document);
        const qb = deriveWallQuads(b.log.document);
        expect(qa.length).toBe(qb.length);
        expectNearRel(areaSum(qa), areaSum(qb), 'Σ 轮廓面积');
        expectSamePointSet(
          qa.flatMap((q) => [...q.corners]),
          qb.flatMap((q) => [...q.corners]),
        );
        quads += qa.length;
      }),
      { numRuns: NUM_RUNS_LIGHT },
    );
    expect(quads).toBeGreaterThanOrEqual(2 * NUM_RUNS_LIGHT);
  });

  it('同向角与混合角都出现过，而且出现过的那些都被闭式解比过', () => {
    const total = newStats();
    runAll(() => {}, total, [checkBounds, checkKinds, checkOracle]);
    expect(total.corners.same).toBeGreaterThan(0);
    expect(total.corners.mixed).toBeGreaterThan(0);
    expect(total.oracleEntries).toBeGreaterThan(0);
  });
});

// ---------- ③ 段（续三）：索引跟着画墙（测试 14）----------

/**
 * 全体条目盒的外框，±1mm 余量（口径与 `probeRects.full` 相同，理由写在那儿）。
 * 不用一个写死的"世界大框"：4000mm 的格子下，±1e6 的框一次要扫 25 万格，
 * 而本条每步要查 2 + N 个矩形 × 40 轮 —— 外框从条目现取，代价随链长走，不随坐标范围走。
 */
function unionBox(entries: readonly IndexEntry[]): Aabb {
  if (entries.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return {
    minX: Math.min(...entries.map((e) => e.aabb.minX)) - 1,
    minY: Math.min(...entries.map((e) => e.aabb.minY)) - 1,
    maxX: Math.max(...entries.map((e) => e.aabb.maxX)) + 1,
    maxY: Math.max(...entries.map((e) => e.aabb.maxY)) + 1,
  };
}

/**
 * 测试 14 与测试 10 的分工，一句话：**测试 10 的索引建在链画完之后，所以它只见"改"不见"增"。**
 * 而"新构件挂到既有端点"正是 Task 9 双向闭包四条漏网边里唯一没被随机覆盖的那条
 * （`wallCreate` 复用了第 i−1 段的端点 ⇒ 那根老墙在同一点的接头从 `free` 变 `corner`、
 * 斜切量从零变非零，而老墙**不在** `wallCreate` 的 `affected` 里 —— 它只能从
 * `dependsOnOf` 的实体回落那一跳被捞回来）。这里把它接到随机链上：每轮 1–4 次复用 × 40 轮。
 *
 * 它**不**覆盖"在两个既有端点之间合上一间房"：链不闭合是 `arbChainShape` 的既定边界
 * （闭合段的长度与夹角是派生量，关键判断 2 的三条界管不到它，见归属改判第 1 条 (c)），
 * 那一条留在 Task 9 的定值用例里。
 *
 * 本条不走 `absorbStats`：它不跑操作序列，`byKind` / `probes` / `clamps` 恒为 0，
 * 为一个全是零的账本去动 `OpStats` 与 `absorbStats` 两处签名，是 Task 9 评审那条
 * "挂一个赋值一次、没人读的字段"的同一件事。防它空跑的三个下界用局部计数器。
 */
describe('索引跟着画墙：从一张空层开始', () => {
  it('每画一段 applyAffected 一次：增量 == 全量，且每条目的自查盒 == 暴力扫', () => {
    let steps = 0;
    let emptyStarts = 0;
    let reuseSteps = 0;
    let partials = 0;
    fc.assert(
      fc.property(arbChainShape, (shape) => {
        let index: SpatialIndex | undefined;
        let reusedBefore = 0;
        const step = (log: TransactionLog, storeyId: string): void => {
          const doc = log.document;
          const walls = doc.byKind('wall').filter((w) => w.storeyId === storeyId);
          if (index === undefined) {
            // 第一次回调 = storeyCreate 之后、一段墙都还没有。Task 9 的 T10 义务 ⑤：
            // 空层既不能抛，也不能把"这层没墙"和"楼层 id 写错"混成同一个空索引。
            expect(walls.length).toBe(0);
            index = SpatialIndex.fromDoc(doc, storeyId);
            expect(index.size).toBe(0);
            expect(index.query({ minX: 0, minY: 0, maxX: 0, maxY: 0 })).toEqual([]);
            emptyStarts++;
            return;
          }
          index.applyAffected(doc, log.affected);
          const live = index.snapshot();
          expect(live).toEqual(SpatialIndex.fromDoc(doc, storeyId).snapshot());
          expect(live.length).toBe(walls.length);
          for (const entry of live) {
            // 拿条目自己的盒子当查询矩形：接头两侧的墙盒在共角端互相盖住，
            // 所以这既是"命中非空"又是"不全表"，一个矩形干两件事，还都是紧的。
            const hit = index.query(entry.aabb);
            expect(hit).toEqual(bruteOverlaps(live, entry.aabb));
            if (hit.length < live.length) partials++;
          }
          const full = unionBox(live);
          expect(index.query(full)).toEqual(live.map((e) => e.id));
          expect(
            index.query({
              minX: full.maxX + 1_000_000,
              minY: full.minY,
              maxX: full.maxX + 1_000_001,
              maxY: full.minY,
            }),
          ).toEqual([]);
          steps++;
          // 复用数 = 2×墙数 − 不同端点数。链上每加一段必然复用 1 个 ⇒ 严格递增一步。
          const ends = new Set(walls.flatMap((w) => [w.startId, w.endId]));
          const reused = walls.length * 2 - ends.size;
          if (reused > reusedBefore) reuseSteps++;
          reusedBefore = reused;
        };
        drawChain(shape, newStats(), step);
      }),
      { numRuns: NUM_RUNS_INDEX },
    );
    expect(emptyStarts).toBe(NUM_RUNS_INDEX);
    expect(steps).toBeGreaterThanOrEqual(2 * NUM_RUNS_INDEX);
    expect(reuseSteps).toBeGreaterThan(0);
    expect(partials).toBeGreaterThan(0);
  });
});
```

**测试 12 抓不到边线配对错，这句话必须写在它旁边。** 把整条链反着画，每个接头的两墙同时换成各自的另一端，`innerSide` 跟着一起翻 —— 配对结构原样保留，所以 Task 4 那个 bug 在这条属性下**全绿**（与 Task 4 的 intro 同一句结论，那里已经写过一次，这里是它的落点）。它真正的位置是另一类病：实现偷偷读了 `forward`、读了 `Joint.members` 的先后、或读了 uuid 序 —— 这三样在反向画里全变了，而输出必须不变。配对错的随机探测器只有一个，就是测试 3 那条按侧比闭式解；定值探测器是 Task 4 的两条「同向起画」、本文件测试 2，与 Step 5 的「同向角定值」。

**测试 13 的三个数不需要再按角型拆开。** `checkKinds` 数的每一枚二成员接头，`checkOracle` 都在**同一帧**里比过两侧（`oracleTrims` 的 key 集就是这些 bucket 的两端，比 `corners` 用的同一批 bucket），所以"两种角都出现过"+"预言比过 N 条"两件事合起来就是"两种角都被预言比过"。再加一遍按角型分账是重复记账。

概率那笔账：一轮最少 2 段 ⇒ 至少 1 枚内部接头；一枚接头是同向角还是混合角，只由相邻两段 `forward` 是否相同决定 ⇒ 单轮只出一种角的概率 ≤ 1/2 ⇒ 80 轮全走同一边的概率 ≤ 2⁻⁸⁰ ≈ 8e-25。这个下界在 Step 4 降档时要跟着改（降到 50 就是 2⁻⁵⁰）。

- [ ] **Step 4: 跑门禁**

```bash
pnpm typecheck
pnpm vitest run packages/core/test/geometry-properties.test.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -6
pnpm verify
```

Expected：本文件 14 passed；`pnpm verify` = Task 9 的 258 + 14 = **272 passed**，0 失败。（Step 5 那 8 条落地后，收尾门禁才是 **280 passed / 23 files** —— 别在 Step 4 就去找那个数。）

**把两个墙钟时间抄进执行日志。** 这个文件是计划 2 里最贵的一处：80 次运行 × 最多 18 步，每步跑六个检查器（其中 `checkContours` / `checkOracle` / `checkSpans` 各要派生一次整层）。如果 `geometry-properties.test.ts` 单文件超过 **20 秒**，按这个顺序降档，别乱降：

1. `NUM_RUNS_OPS` 80 → 50（连带把测试 13 那句概率下界改成 2⁻⁵⁰）；
2. `NUM_RUNS_INDEX` 40 → 25；
3. **不动 `NUM_RUNS_LIGHT`** —— 那 200 次是测试 3/4/12 的样本量，砍它等于砍覆盖，而它们恰恰是最便宜的（只画链、不跑序列）。

**降一档要连带动哪些下界**（先对这张表再改常数；只改常数就以为完事了，留下的是一笔过期的账）：

| 常数 | 写成符号的下界（改常数自动跟着走，别手改） | 写成字面量的（必须同批改，否则绿的是过期数字） |
| --- | --- | --- |
| `NUM_RUNS_OPS` = 80 | 序列类那五条 `byKind.* > 0` 与四条 `probes.* > 0`（只要求"跑到过"，≥1 轮就成立）；`total.clamps > 0`；`expect(replays).toBeGreaterThanOrEqual(NUM_RUNS_OPS * 7)` | ①「80 次 × 平均 12 步 = 960 步里一次都不落到某个 kind，约 (5/6)^960 ≈ 1e-78」那句注释 —— 12 是 `arbChainOps` 的 `minLength: 6, maxLength: 18` 的均值，6 种 kind 由 `fc.constantFrom` 等概率取 ⇒ 降 50 就把 960 改成 600、把 1e-78 重算一遍；②测试 13 的 2⁻⁸⁰（同一段散文里那句"80 轮全走同一边"），降到 50 就是 2⁻⁵⁰ |
| `NUM_RUNS_INDEX` = 40 | `index.compared / empty / partial / pruned / hits` 五条 `> 0` | 无 —— 所以这一档最便宜，改完不用回头看 |
| `NUM_RUNS_LIGHT` = 200 | `expect(runs).toBe(NUM_RUNS_LIGHT)`（等号哨兵，证明这轮真跑满了）；`entries >= 2 * NUM_RUNS_LIGHT`；两处 `quads >= 2 * NUM_RUNS_LIGHT` | 无 —— 真降它时红只会来自"200 轮里每链至少 2 段"这个前提不够密，不来自过期字面量，这正是第 3 条不许动它的代价对照 |

顺带把 `960` 这笔账钉死在这里，免得下一个人以为它是实测步数：它是 **期望值**（80 × 12），实际总步数落在 80 × 6 = 480 与 80 × 18 = 1440 之间。注释用期望值算概率下界是保守方向 —— 步数越少、"(5/6)^步数"越大、"一次都没落到某个 kind"的概率上界越高，所以 480 步时仍有 (5/6)^480 ≈ 1e-39，结论不变。

如果红在某个 Counterexample 上，先读收缩后的最小反例再判断归属：消息是 `assertPremises` / `assertChainBounds` 那几条中文（带实测数字）的，是**前提破了**，改生成器或改界，不许改断言；消息是 `expect` 的期望值不符的，是 `src/` 缺陷，按 Global Constraints 那条走"改实现、记执行日志"。

- [ ] **Step 5: 写 `integration-two-storeys.test.ts`（spec 11.1 的两层住宅）**

八条定值。为什么定值不属性：非目标 1 说得很清楚，tee 与"直通两墙同厚"这种形状随机生成器产不出来，而 spec 11.1 要的恰好是**这一栋**房子在几何、分段、索引、撤销四个层面都成立。

**先把登记表算出来再写测试**（下面每个数都标了来源；跑出来与表不符就是缺陷或算错，两种都要写进执行日志）：

| 项 | 每层的值 | 怎么来的 |
| --- | --- | --- |
| 墙 | 8 面：`southWest` (0,0)→(4000,0) t240、`southEast` (4000,0)→(8000,0) t240、`east` (8000,0)→(8000,6000) t240、`north` (8000,6000)→(0,6000) t240、`west` (0,0)→(0,6000) t240、`stem` (4000,0)→(4000,3000) **t240（建成 120，第 2 笔编辑改的）**、`partWest` **(800,3000)**→(4000,3000) t120、`partEast` (4000,3000)→(7000,3000) t120 | 五面墙闭合成外框（`west` 的两端都写 `{pointId}`，共享端点走 Task 3 的路径），`stem` 从南墙中点顶到横隔墙，横隔墙被 `stem` 打断成两段 ⇒ 三个共线成员在 (4000,3000) 成 tee |
| 接头 | 8 个 = **4 corner + 2 tee + 2 free** | 角：(0,0) `start/start`、(8000,0)、(8000,6000)、(0,6000) `end/end`；tee：(4000,0) = {southWest.end, southEast.start, stem.start}、(4000,3000) = {stem.end, partWest.end, partEast.start}；free：(800,3000)、(7000,3000) |
| 墙身段 | 12 片 | 4 面宿主墙各被一樘洞切成 2 片 = 8，另 4 面无洞各 1 片 |
| 洞口 | 4 樘 = 2 门 + 2 窗（两层共 8 樘 = 4 门 4 窗，spec 11.1） | `doorSouth` d1500 w1000 h2100；`doorEast` d1000 w1000 h2100；`winNorth` d2000→**2200**（第 3 笔编辑）w1500 h1500 sill 900；`winWest` d3500 w1200 h1500 sill 900 |
| Σ 轴长 × 墙厚 | 8,184,000 | 240 × (4000+4000+6000+8000+6000+3000) + 120 × (3200+3000) = 7,440,000 + 744,000 |
| Σ 轮廓面积 | **8,140,800** | 上一行减两处 tee 重叠：`stem` ∩ 南墙带 = 240 × 120 = 28,800；`stem` ∩ 横隔墙带 = 240 × 60 = 14,400。合计 43,200。角上四枚 90° 等厚角**不**产生差额（Task 5 的斜切保面积），自由端 trim = 0 也不产生 |
| `stem` 的两端斜切 | start 端两侧都 120、end 端两侧都 60 | tee 只切支墙：`face` = 直通墙朝支墙那一侧的面线 ⇒ 南墙（t240）面线在 y=+120、横隔墙（t120）面线在 y=3000−60=2940 |
| `stem` 的四枚端角点 | start (3880,120)/(4120,120)；end (3880,2940)/(4120,2940) | x = 4000 ± h_stem = ±120（**改厚之后**），y 见上一行 |
| 直通墙在两个 tee 的斜切 | 全 0（方头） | `trimsFor` 的 tee 分支只 `put(stem, …)` |
| 全体角点 AABB | {minX:−120, minY:−120, maxX:8120, maxY:6120} | 外框 [0,8000]×[0,6000] 各向外扩半厚 120；横隔墙与 `stem` 都在框内 |
| `queryPoint(2000, 0)` | 每层恰好 2 个 id = `southWest` + `doorSouth` | 墙盒 x∈[−120,4000] y∈[−120,120]；门盒 x∈[1500,2500] y∈[−120,120]。两层的 id 不相交（不同实体） |
| 索引条目 | 每层 `size` = 12 | 8 墙 + 4 洞；Task 9 不索引柱/板/楼层 |
| 命令数 | 30 = 2 `storeyCreate` + 16 `wallCreate` + 8 `openingCreate` + 4 笔编辑 | 编辑依次是：`wallMoveEndpoint(partWest, 'start', 800, 3000)`、`wallSetThickness(stem, 240)`、`openingMove(winNorth, 2200)`、`storeySetElevation(upper, 3000)` |

**为什么第 1 笔编辑拖的是自由端而不是共享端**：`stem` 的两端都挂在 tee 上（三个共点成员分属两个方向），把 (4000,3000) 往任何方向挪都会让 `partWest` 与 `partEast` 不再共线，`kindOf` 立刻判成 3 方向 3 成员的 **star** 并抛错（Task 4 的 star 分支）—— 那是正确行为，但会把整张登记表变成无理数。外框的四个角是 90° 角，挪动任何一枚都会打掉一面墙的轴对齐。所以本文件的随机链负责共享端点（关键判断 3 的试法专门为此存在），这里只拖自由端：`partWest` 从 3000 变 3200，长度、面积、AABB 全能手算。共享端点跨两层的表现在 Task 3 的「拖拐角」与 Task 7 的洞口跟随里已经钉过。

**为什么 `storeySetElevation` 从 6000 改到 3000 而不是新建时就写 3000**：`assertNoVerticalOverlap` 在 `storeyCreate` 里也跑，二层若与一层同在 0 直接抛；本任务要把这条命令本身算一笔编辑（30 步里的第 4 笔），所以先以 6000 建、再落到贴邻的 3000（半开区间贴邻合法，见 Task 8 Step 5）。

```ts
/**
 * spec 11.1 那栋两层住宅的定值整合：几何、分段、索引、撤销四个层面各钉一票。
 * 本文件不新增任何被测代码，只把 Task 4–9 的派生口径在一张真实图纸上对一遍。
 */
import { describe, expect, it } from 'vitest';
import {
  Document,
  SpatialIndex,
  TransactionLog,
  aabbOfPoints,
  deriveJoints,
  deriveStoreyGeometry,
  deriveWallQuads,
  memberTrim,
  openingCreate,
  openingMove,
  storeyCreate,
  storeySetElevation,
  uuidv7,
  wallAxisById,
  wallCreate,
  wallMoveEndpoint,
  wallSetThickness,
  type Command,
  type Joint,
  type PointRef,
  type Vec2,
  type WallEnd,
  type WallEntity,
  type WallPiece,
} from '@dajia/core';

const STOREY_HEIGHT_MM = 3000;
const projectId = uuidv7();

type WallName =
  | 'southWest'
  | 'southEast'
  | 'east'
  | 'north'
  | 'west'
  | 'stem'
  | 'partWest'
  | 'partEast';

type OpeningName = 'doorSouth' | 'doorEast' | 'winNorth' | 'winWest';

interface StoreyParts {
  readonly storeyId: string;
  readonly walls: Record<WallName, WallEntity>;
  readonly openings: Record<OpeningName, string>;
}

interface House {
  readonly log: TransactionLog;
  readonly lower: StoreyParts;
  readonly upper: StoreyParts;
  /** 每一笔之后的 canonical，长度 == 命令数 + 1（含起点） */
  readonly snaps: string[];
}

/**
 * 与 geometry-properties.test.ts 同款的六行：取新建实体只认 affected + 字面量判别。
 * 墙与洞口各一个助手，不做泛型 —— 见下一段。
 */
function lastCreatedWall(log: TransactionLog): WallEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new TypeError('affected 里没有新建的墙');
}

function lastCreatedOpening(log: TransactionLog): string {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'opening') return entity.id;
  }
  throw new TypeError('affected 里没有新建的洞口');
}

/** 取刚 dispatch 出来的那个楼层 id。同样不 `byKind('storey').at(-1)`，理由见 buildHouse 之后。 */
function lastCreatedStorey(log: TransactionLog): string {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'storey') return entity.id;
  }
  throw new TypeError('affected 里没有新建的楼层');
}
```

**为什么是三个助手而不是一个带 `kind` 参数的泛型**：`entity.kind === kind` 收窄的是 `entity`，TS 不会因此把 `T` 推出来，泛型判别式在这里就是写不进去 —— 想合成一个助手，末尾必须留一个 `as T`，而本文件唯一的 cast 名额要留给 `memberStorey` 那种"联合读不回具体型"的真需要处（下面第 2 条断言那里）。三个六行助手，`noUnusedParameters` 还会替我盯着哪天某个不再被用。**为什么墙那个助手不能顺手服务洞口**：`openingCreate` 的 `affected` 里只有新建的**洞口**，拿 `lastCreatedWall` 取会抛 `affected 里没有新建的墙` —— 抛是对的行为（拿回一面墙当洞口 id 用会一路红到无关的断言上），但那一抛不是本文件想要的失败形态，所以 `cut` 必须调洞口那个。

```ts
function buildStorey(log: TransactionLog, storeyId: string): StoreyParts {
  const walls = {} as Record<WallName, WallEntity>;
  const put = (name: WallName, start: PointRef, end: PointRef, thicknessMm: number): void => {
    log.dispatch(wallCreate({ storeyId, start, end, thicknessMm, heightMm: STOREY_HEIGHT_MM }));
    walls[name] = lastCreatedWall(log);
  };
  put('southWest', { x: 0, y: 0 }, { x: 4000, y: 0 }, 240);
  put('southEast', { pointId: walls.southWest.endId }, { x: 8000, y: 0 }, 240);
  put('east', { pointId: walls.southEast.endId }, { x: 8000, y: 6000 }, 240);
  put('north', { pointId: walls.east.endId }, { x: 0, y: 6000 }, 240);
  put('west', { pointId: walls.southWest.startId }, { pointId: walls.north.endId }, 240);
  put('stem', { pointId: walls.southWest.endId }, { x: 4000, y: 3000 }, 120);
  put('partWest', { x: 1000, y: 3000 }, { pointId: walls.stem.endId }, 120);
  put('partEast', { pointId: walls.stem.endId }, { x: 7000, y: 3000 }, 120);

  const openings = {} as Record<OpeningName, string>;
  const cut = (
    name: OpeningName,
    host: WallEntity,
    input: { distanceMm: number; widthMm: number; heightMm: number; category: 'door' | 'window' },
  ): void => {
    log.dispatch(openingCreate({ hostWallId: host.id, ...input }));
    openings[name] = lastCreatedOpening(log);
  };
  cut('doorSouth', walls.southWest, { distanceMm: 1500, widthMm: 1000, heightMm: 2100, category: 'door' });
  cut('doorEast', walls.east, { distanceMm: 1000, widthMm: 1000, heightMm: 2100, category: 'door' });
  cut('winNorth', walls.north, { distanceMm: 2000, widthMm: 1500, heightMm: 1500, category: 'window' });
  cut('winWest', walls.west, { distanceMm: 3500, widthMm: 1200, heightMm: 1500, category: 'window' });
  return { storeyId, walls, openings };
}
```

`put` 与 `cut` 是全文件仅有的两处"dispatch 之后立刻取实体"，所以 `buildStorey` 内部不许出现任何一次 `log.document.byKind(...)`：那会把"这一步建的东西"换成"id 最大的那类东西"，而这类替换正是 Global Constraints 里那条禁例的形状。它也不进 Step 6 的变异表 —— 变异表改的是 `src/`，测试侧的取值写法由这段约定与下面 `buildHouse` 之后那段负责。

```ts
function buildHouse(): House {
  const log = new TransactionLog(Document.create(projectId));
  const snaps: string[] = [];
  const step = (cmd: Command): void => {
    log.dispatch(cmd);
    snaps.push(log.document.canonical());
  };
  step(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: STOREY_HEIGHT_MM }));
  const lowerId = lastCreatedStorey(log);
  const lower = buildStorey(log, lowerId);
  step(storeyCreate({ projectId, index: 1, elevationMm: 6000, heightMm: STOREY_HEIGHT_MM }));
  const upperId = lastCreatedStorey(log);
  const upper = buildStorey(log, upperId);

  const edit = (cmd: Command): void => step(cmd);
  edit(wallMoveEndpoint({ wallId: lower.walls.partWest.id, end: 'start', x: 800, y: 3000 }));
  edit(wallSetThickness({ wallId: lower.walls.stem.id, thicknessMm: 240 }));
  edit(openingMove({ openingId: lower.openings.winNorth, distanceMm: 2200 }));
  edit(storeySetElevation({ storeyId: upperId, elevationMm: 3000 }));
  return { log, lower, upper, snaps };
}
```

**两处 `lastCreatedStorey`，一处都不写 `byKind('storey')`** —— 那是计划 1 那条禁例（Global Constraints「同毫秒 uuidv7 不保证单调」）的重演。这里比一般情形更隐蔽：楼层只有两条，`index` 0 在前、1 在后看着像有顺序，但 `byKind` 给的是 **id 升序**，同一毫秒建的两条 storey 谁排后面取决于时钟低位的运气。取错的话 `upper` 会拿到一层的 id，`storeySetElevation(upperId, 3000)` 改到一层头上，而 `assertNoVerticalOverlap` 会让它当场抛 —— 抛在离病根三行远的地方。`lowerId` 用 `byKind('storey')[0]` 也不会误红（只有两条时它总能取到某一条），所以更要用同一个助手，别给"看起来安全"的那一处开特例。

**先把六个助手写全，再写断言。** 它们全在 module 级、`describe` 之前：`buildStorey` 那三个取实体的助手用 `log.affected`，这六个用 `doc`，两组职责不重叠。`memberStorey` 与 `storeyOfWall` 是一对（一个认接头、一个认墙），写成两个函数而不是让 `kinds` 里再抄一遍 cast。

```ts
/** 墙 id → 楼层 id。`doc.get` 返回实体联合，判别式走完，cast 一处都不留。 */
function storeyOfWall(doc: Document, wallId: string): string {
  const wall = doc.get(wallId);
  if (wall?.kind !== 'wall') throw new TypeError(`${wallId} 不是墙`);
  return wall.storeyId;
}

/** 接头属于哪一层：只看第一个成员。"成员不跨层"这件事由第 1 条断言负责，这里不重复检查。 */
const memberStorey = (doc: Document, joint: Joint): string =>
  storeyOfWall(doc, joint.members[0]!.wallId);

/** 本层存活的墙。`byKind` 给 id 升序，与本文件的期望值无关，只是别拿它当"创建顺序"。 */
const liveWallsOf = (doc: Document, storeyId: string): WallEntity[] =>
  doc.byKind('wall').filter((wall) => wall.storeyId === storeyId);

/** 轴长走 Task 2 的实现：整合测试测的是接线，不是把几何再推导一遍（那份在属性测试里）。 */
const axisLength = (doc: Document, wall: WallEntity): number => wallAxisById(doc, wall.id).lengthMm;

/** 按坐标找接头：登记表里的点全是整数，直接 == 比。 */
function jointAt(doc: Document, parts: StoreyParts, x: number, y: number): Joint {
  for (const joint of deriveJoints(doc)) {
    if (memberStorey(doc, joint) !== parts.storeyId) continue;
    const point = doc.get(joint.pointId);
    if (point?.kind === 'point' && point.x === x && point.y === y) return joint;
  }
  throw new Error(`(${x}, ${y}) 处没有属于本层的接头`);
}

/**
 * 该接头处这面墙的两侧斜切，折成 { left, right } 方便断言。
 * 查找仍然交给 Task 4 的 `memberTrim`（传一枚接头组成的数组），本文件不写第二份查找；
 * 找不到时它抛 `/找不到/`，比这里自己抛更准，因为那条消息是 Task 4 契约的一部分。
 */
const trimAt = (joint: Joint, wallId: string, end: WallEnd): { left: number; right: number } => {
  const member = memberTrim([joint], wallId, end);
  return { left: member.trimLeftMm, right: member.trimRightMm };
};

/** 该端两枚角点，按 (x, y) 排序后返回：比的是点集，不是环序。 */
function quadEndCorners(doc: Document, wallId: string, end: WallEnd): Vec2[] {
  const quad = deriveWallQuads(doc).find((q) => q.wallId === wallId);
  if (!quad) throw new Error(`墙 ${wallId} 没有轮廓`);
  const corners = quad.corners;
  const pair = end === 'start' ? [corners[0], corners[3]] : [corners[1], corners[2]];
  return pair.sort((p, q) => p.x - q.x || p.y - q.y);
}
```

`quadEndCorners` 里先落到 `const corners = quad.corners` 再索引，是因为 `corners` 是**只读四元组**：直接写 `quad.corners[0]` 组出来的数组字面量会被推成 `readonly` 上下文里的东西而丢掉 `.sort`。拆成两行后 `pair` 是普通 `Vec2[]`，`sort` 与返回值都顺手。`[0]/[3]` 与 `[1]/[2]` 这两对下标就是 Task 5 的环序契约（`[c0, c2, c1, c3]` 里同一端的两枚角点）—— 本文件按它取，Step 6 的变异 2 换掉环序时这里必红。

八条断言：

```ts
describe('两层住宅：接头与轮廓', () => {
  const kinds = (parts: StoreyParts, doc: Document): string[] =>
    deriveJoints(doc)
      .filter((joint) => memberStorey(doc, joint) === parts.storeyId)
      .map((j) => j.kind)
      .sort();

  it('每层 8 个接头：4 corner + 2 tee + 2 free，且不跨层', () => {
    const h = buildHouse();
    const doc = h.log.document;
    const want = ['corner', 'corner', 'corner', 'corner', 'free', 'free', 'tee', 'tee'];
    expect(kinds(h.lower, doc)).toEqual(want);
    expect(kinds(h.upper, doc)).toEqual(want);
    // 上面两条只证明"每层各自有 8 枚"；这一条证明没有第三层的、或者谁都不 belonging 的接头漏网
    expect(deriveJoints(doc).length).toBe(16);
    // 楼层不串：每一枚接头的成员都在同一层
    for (const joint of deriveJoints(doc)) {
      const storeys = new Set(joint.members.map((m) => storeyOfWall(doc, m.wallId)));
      expect(storeys.size).toBe(1);
    }
  });
```

`storeyOfWall` 那句解释放在这里：成员只有 `wallId`，取楼层必须读一次真源，而 `doc.get` 返回实体联合 —— 判别式走完，cast 一处都不留。

其余七条接着往同一个 `describe` 里写（下面几个 fence 都不重复 `describe` 的头，最后一条末尾那个 `});` 才是它的收尾）：

```ts
  it('同向角定值：A 是 start/start、D 是 end/end，凹凸角点与两侧斜切逐条吻合', () => {
    const h = buildHouse();
    const doc = h.log.document;
    const a = jointAt(doc, h.lower, 0, 0);
    expect(a.kind).toBe('corner');
    expect(a.members.map((m) => m.end)).toEqual(['start', 'start']);
    // 凹 = 两内侧面之交点 = (120,120)；凸 = 2P − 凹 = (−120,−120)
    expect(trimAt(a, h.lower.walls.southWest.id, 'start')).toEqual({ left: 120, right: -120 });
    expect(trimAt(a, h.lower.walls.west.id, 'start')).toEqual({ left: -120, right: 120 });
    expect(quadEndCorners(doc, h.lower.walls.southWest.id, 'start')).toEqual([
      { x: -120, y: -120 },
      { x: 120, y: 120 },
    ]);
    const d = jointAt(doc, h.lower, 0, 6000);
    expect(d.members.map((m) => m.end)).toEqual(['end', 'end']);
    expect(trimAt(d, h.lower.walls.north.id, 'end')).toEqual({ left: 120, right: -120 });
    expect(trimAt(d, h.lower.walls.west.id, 'end')).toEqual({ left: -120, right: 120 });
  });
```

`quadEndCorners(doc, wallId, end)` 取该端两枚角点并**按 (x, y) 排序**：这里比的是"两个点的集合"，环序由 Task 5 自己的定值用例守（本文件拿排序去环序噪声，不拿它去比大小关系）。`west` 两端给出的 `{left:−120, right:120}` 完全相同不是巧合 —— 两枚都是同向角，而外框是凸矩形：`west` 从 (0,0) 画到 (0,6000)，`dir = (0,1)`、`normal = perp(dir) = (−1,0)` 指向**室外**，房屋内侧恒在它的 −normal 那侧，所以两端的 `innerSide` 都取 −1。这条正是 Step 6 变异 3（`innerSide` 写死成 `1`）的第二块靶子：写死后 (0,0) 与 (0,6000) 两处 `{left, right}` 会同时翻成 `{120, −120}`。

```ts
  it('两个 tee：支墙切到直通墙面线，直通墙方头', () => {
    const h = buildHouse();
    const doc = h.log.document;
    const s1 = jointAt(doc, h.lower, 4000, 0);
    const q = jointAt(doc, h.lower, 4000, 3000);
    expect([s1.kind, q.kind]).toEqual(['tee', 'tee']);
    expect(s1.members.length).toBe(3);
    // 只有支墙被切：直通两墙 trim 全 0（方头），stem 两侧同值
    expect(trimAt(s1, h.lower.walls.southWest.id, 'end')).toEqual({ left: 0, right: 0 });
    expect(trimAt(s1, h.lower.walls.southEast.id, 'start')).toEqual({ left: 0, right: 0 });
    expect(trimAt(q, h.lower.walls.partWest.id, 'end')).toEqual({ left: 0, right: 0 });
    expect(trimAt(q, h.lower.walls.partEast.id, 'start')).toEqual({ left: 0, right: 0 });
    expect(trimAt(s1, h.lower.walls.stem.id, 'start')).toEqual({ left: 120, right: 120 });
    expect(trimAt(q, h.lower.walls.stem.id, 'end')).toEqual({ left: 60, right: 60 });
    expect(quadEndCorners(doc, h.lower.walls.stem.id, 'start')).toEqual([
      { x: 3880, y: 120 },
      { x: 4120, y: 120 },
    ]);
    expect(quadEndCorners(doc, h.lower.walls.stem.id, 'end')).toEqual([
      { x: 3880, y: 2940 },
      { x: 4120, y: 2940 },
    ]);
  });
```

**这两组数同时钉住了 `wallSetThickness` 与 `wallMoveEndpoint` 的联动**：`x = 4000 ± 120` 成立的前提是改厚已生效（h_stem = 240/2），`y = 2940` 成立的前提是 `face` 取的是**横隔墙**（t120）那一侧的面线而不是南墙（t240）的。把 `stem` 的厚度改在 tee 之外任何一面墙上、或把 `faceSide` 写死成 `1`，这两组里必有一组红。

```ts
  it('每层 12 片墙身，洞口分段与登记表逐端点相同', () => {
    const h = buildHouse();
    const geometry = deriveStoreyGeometry(h.log.document, h.lower.storeyId);
    expect(geometry.pieces.length).toBe(12);
    const pieceOf = (wallId: string): WallPiece[] => geometry.pieces.filter((p) => p.wallId === wallId);
    expect(pieceOf(h.lower.walls.southWest.id)).toEqual([
      { wallId: h.lower.walls.southWest.id, fromMm: 0, toMm: 1500 },
      { wallId: h.lower.walls.southWest.id, fromMm: 2500, toMm: 4000 },
    ]);
    // 第 3 笔编辑（openingMove 2000 → 2200）真的落到了分段上
    expect(pieceOf(h.lower.walls.north.id)).toEqual([
      { wallId: h.lower.walls.north.id, fromMm: 0, toMm: 2200 },
      { wallId: h.lower.walls.north.id, fromMm: 3700, toMm: 8000 },
    ]);
    // 无洞的墙整段一片，且第 1 笔编辑把 partWest 从 3000 拉到 3200
    expect(pieceOf(h.lower.walls.partWest.id)).toEqual([
      { wallId: h.lower.walls.partWest.id, fromMm: 0, toMm: 3200 },
    ]);
  });
```

`toMm: 8000` 与 `3200` 都是浮点，但它们与实现算的是同一个 `Math.hypot(0, 8000)` / `Math.hypot(3200, 0)`，逐位相同 ⇒ `toEqual` 敢用 `===` 比（这条与 Task 6 里"浮点轴长用 0.5mm 下界"那处不矛盾：那里量的是斜墙的 `hypot(1000,1732)`，测试侧另算一遍才是第二份证据）。

```ts
  it('面积恒等式在一张真图纸上成立：Σ 轮廓 = 8,140,800 = Σ 轴长×墙厚 − 43,200', () => {
    const h = buildHouse();
    const doc = h.log.document;
    const area = deriveWallQuads(doc)
      .filter((q) => storeyOfWall(doc, q.wallId) === h.lower.storeyId)
      .reduce((total, q) => total + q.areaMm2, 0);
    expect(area).toBeCloseTo(8_140_800, 6);
    // Σ 轴长 × 墙厚：全是整数轴长（本图纸没有斜墙），hypot 逐位精确
    const nominal = liveWallsOf(doc, h.lower.storeyId).reduce(
      (total, wall) => total + axisLength(doc, wall) * wall.thicknessMm,
      0,
    );
    expect(nominal).toBe(8_184_000);
    // 差额只来自两处 tee 重叠，逐项列出来，别写成"减一个大约的数"
    expect(nominal - area).toBeCloseTo(28_800 + 14_400, 6);
  });
```

`28,800 = 240（stem 厚）× 120（南墙半厚）`、`14,400 = 240 × 60（横隔墙半厚）`。**四枚 90° 角不贡献差额**，这正是 Task 5 那条"斜切保面积"在真实图纸上的复验：如果哪天有人把角的配对改错（Task 4 变异 2 那种），四枚角每枚都会漏出一块，这一条立刻红 —— 而本文件的测试 12（反向画）不会。

```ts
  it('全体角点 AABB = {−120,−120,8120,6120}', () => {
    const h = buildHouse();
    const doc = h.log.document;
    const corners = deriveWallQuads(doc)
      .filter((q) => storeyOfWall(doc, q.wallId) === h.lower.storeyId)
      .flatMap((q) => [...q.corners]);
    expect(corners.length).toBe(32);
    expect(aabbOfPoints(corners)).toEqual({ minX: -120, minY: -120, maxX: 8120, maxY: 6120 });
  });
```

`corners.length` 先钉 32（8 面墙 × 4）是防空跑：过滤条件写错成"整个文档"会拿到 64，写成"恒假"会拿到 0，两种都会让下面那行 `toEqual` 变成一个孤立数字的比对。

```ts
  it('索引：每层 12 条，queryPoint(2000,0) 恰好命中南墙与它的门，两层不相交', () => {
    const h = buildHouse();
    const doc = h.log.document;
    const lower = SpatialIndex.fromDoc(doc, h.lower.storeyId);
    const upper = SpatialIndex.fromDoc(doc, h.upper.storeyId);
    expect(lower.size).toBe(12);
    expect(upper.size).toBe(12);
    expect(lower.queryPoint(2000, 0).sort()).toEqual(
      [h.lower.walls.southWest.id, h.lower.openings.doorSouth].sort(),
    );
    expect(upper.queryPoint(2000, 0).sort()).toEqual(
      [h.upper.walls.southWest.id, h.upper.openings.doorSouth].sort(),
    );
    // 楼层隔离：二层的任何一个 id 都不该出现在本层的命中里
    for (const id of lower.queryPoint(2000, 0)) expect(upper.queryPoint(2000, 0)).not.toContain(id);
  });
```

**这个 fence 里曾经还有第三行 `expect(lower.queryPoint(2000, 0)).toEqual(expect.arrayContaining([]))`，删了。** 空数组谁都包含，它永远不会红 —— 一句恒真的断言不是"多一道保险"，是把读者的注意力从一个会红的地方引走。"两层不相交"这件事光靠上面两组 `toEqual` 的期望值（本就分属两层）已经成立，`not.toContain` 那个循环把它推广到"本层命中的任何一个 id 都不在二层"，这才是承重的那一句。写下来是因为它是本计划第二次差点交出空气断言（第一次见 Task 10 Step 2 的 `at(-1)`），同一类错误值得同一个记号。

```ts
  it('30 笔命令：撤到底、逐字节回到空文档、重做逐张复现，图还活着', () => {
    const h = buildHouse();
    const empty = h.snaps[0];
    expect(h.snaps.length).toBe(31);      // 起点 1 张 + 30 笔各 1 张
    expect(h.log.depth).toBe(30);
    for (let i = 0; i < 30; i++) expect(h.log.undo()).toBe(true);
    expect(h.log.undo()).toBe(false);
    expect(h.log.document.canonical()).toBe(empty);
    for (let i = 1; i < h.snaps.length; i++) {
      expect(h.log.redo()).toBe(true);
      expect(h.log.document.canonical()).toBe(h.snaps[i]);
    }
    expect(h.log.canRedo).toBe(false);
    // 撤销重做的不是字符串，是那张图：重放完再算一遍面积与索引
    const area = deriveWallQuads(h.log.document)
      .filter((q) => storeyOfWall(h.log.document, q.wallId) === h.lower.storeyId)
      .reduce((total, q) => total + q.areaMm2, 0);
    expect(area).toBeCloseTo(8_140_800, 6);
    expect(SpatialIndex.fromDoc(h.log.document, h.upper.storeyId).size).toBe(12);
  });
});
```

`expect(h.snaps.length).toBe(31)` 与 `expect(h.log.depth).toBe(30)` 一起写，是因为 spec 11.2 那句"连续撤销 30 步"要的就是**这个数**：它既不是"撤销了很多次"也不是"撤到不能撤"，是一条定值。少一笔 `dispatch`（比如哪天有人把 `storeySetElevation` 并进 `storeyCreate`）会让两条同时红，而只写 `undo()` 返回 false 那一条会放过它。

**这里的"按 (x, y) 排序"与 `geometry-properties.test.ts` 里那条"不能靠排序逐位比"看着自相矛盾，其实不矛盾**：那边比的是两份**独立浮点路径**算出的同一批点（A 墙的角点与 B 墙的角点，彼此差 1e-13，谁前谁后由噪声决定），那边必须用容差匹配；这里的两组点**都来自同一枚 `deriveWallQuads` 输出**（同端的两枚角点相距一个墙厚 ≥ 100），排序键不会翻。而且比的是 `toEqual` 的精确值 —— 本图纸全是轴对齐的整数坐标，`(3880, 120)` 就是 `(3880, 120)`，没有 1e-13 可漂。

- [ ] **Step 6: 变异检查（防"测试考的是空气"）**

每处改完跑 `pnpm verify`，**跑完立刻 `git checkout --` 撤掉**，不许把变异留在工作区里比对下一条。

1. `geom/joint.ts` 的 corner 分支：`const sb = innerSide(b, a)` 改成 `const sb = sa` → Expected: 测试 3 红（收缩后的最小反例是一枚同向角），走 `CHECK_ALL` 的测试 5 与测试 13 红（`checkOracle` 在同一批随机链上抛），Step 5 的「同向角定值」红，**且 Task 4 的两条「同向起画」定值一起红**。**测试 1 的三组 fixture 全绿**（它们全是左转折的混合角，`innerSide(a,b)` 与 `innerSide(b,a)` 同号，同侧配对恰好也对），测试 2 也绿（它比的是预言自己，不碰实现）。这两处"故意留绿"是关键判断 1 的量化凭据：**同侧配对这个 bug 只有随机链上的按侧比对能抓**，定值用例必须自己造同向角才看得见。**【执行订正】"测试 2 也绿（它比的是预言自己，不碰实现）"这句与本条 Step 3 的代码 fence 自相矛盾**：fence 里第 1173/1178 行就是 `implementationTrims(...)` + `expect(got).toEqual({ left: want.left, right: want.right })`，它一直读实现 ⇒ 实测红。两棒一度把它归因给"代码棒重写了测试 2"，评审核对 fence 后判定归因错、且这条**不是污染**（多一处按侧比对的证据没有坏处），保留现状。红名单实测 8 条，与变异 3 逐字相同（见下条订正）。
2. `geom/outline.ts` 的 `wallQuad`：把 `corners` 的四个下标整体循环错开两位（`[start+, end+, end−, start−]` → `[end−, start−, start+, end+]`，也就是"端点对"整组挪到另一头）→ Expected: `checkContours`（按 `[0,3]`/`[1,2]` 取同一端的两枚）每步红 ⇒ 测试 4（直接调它）、走 `CHECK_ALL` 的测试 5 与 11 红；Step 5 的 `quadEndCorners` 两处红（`stem` 的四枚端角点会整组挪到另一端）；Task 5 的环序契约测试红。**测试 12 仍绿**（它把每面墙的四枚角点整个摊平比集合，重新编号看不见它）与**面积那句断言本身不变**（循环移位不改鞋带公式的绝对值）—— 这两处绿正是"面积 = 轴长 × 墙厚"凭什么不能单独承重、以及点集比对凭什么要看 `checkContours` 而不是看它。
3. `geom/joint.ts` 的 `innerSide`：直接 `return 1` → Expected: 变异 1 的那一批全红，**另外多红一批变异 1 打不到的**：`innerSide` 写死会把**右转**的混合角也配到 +normal 侧，而本文件测试 1 与 Step 5 的直角夹具全是左折，随机链里左右折各占一半 ⇒ 多出来的是测试 3/5/13 里那些右转的反例。Step 5 的 tee 那条仍不红（tee 分支不调 `innerSide`）。两条变异的红项一多一少，要照抄进执行日志：变异 1 打的是"配对"，变异 3 打的是"配对 + 侧向"，能区分它们的只有随机链。**【执行订正】"多红一批"在测试名粒度不成立**：变异 3 实测同样红 8 条，**红测试名集合与变异 1 逐字相同**。差别只在反例层（变异 1 红在 after 1 / 3 / 8，变异 3 在 after 1 / 1 / 13，收缩后的最小反例也不同）。照抄本句会让人以为两条变异的红名单长得不一样 —— 想区分它们只能读 Counterexample，这本身值得记进日志，但措辞要改口径为"区别在反例层，不在红名单层"。
4. `geom/joint.ts` 的 cross 分支：把 `const face = faceSide(through[0]!, stem)` 提到 `for (const stem …)` 外面 → Expected: **本文件一条都不红**（随机链不产 cross，见非目标 1；Step 5 的图纸只有 tee），红的是 Task 4 的「十字：方向角更小的那族当直通」。把它记在执行日志里当非目标 1 的凭据：属性测试覆盖不到的形状，定值用例是唯一防线。**【执行实测】红 2 条：Task 4「十字：方向角更小的那族当直通」+ Task 5「十字：Σ 面积 = 手工并集 902400，中心没有重叠块」（后者本条未点名，同属 cross 定值防线）。本任务两个新文件 14 + 8 条一条都不红 ⇒ 非目标 1 的凭据兑现，且"新文件零红"这条凭据属于本条变异。**
5. `geom/joint.ts` 的 `deriveJoints` 出口排序：删掉 `byPointId` 那一步 → Expected: `checkKinds`（`joints.map(pointId)` 与 `[...groups.keys()].sort()` 比）红 ⇒ 走 `CHECK_ALL` 的测试 5 与 11 红，Task 4 与 Task 9 的"顺序契约"定值红。**测到排序的不是那一条专门的用例，是每一天的检查** —— 这条是计划开头"派生层按 id 升序"规约的兑现凭据。**【执行订正】Task 9 那半没兑现**：实测红 4 条 = 属性测试 5 / 11 / 13（`checkKinds`）+ Task 4「同一文档派生两次逐字节相同」，`spatial.test.ts` 24 条全绿。评审裁定这是**合理免疫**而非"排序契约没人守"：`applyAffected` 那条路上索引自己会重排（控制器 grep 复核：`spatial/index.ts:226` 的 `[...dirty].sort()` 与 `:269` 的 `[...hits].sort()` 两处，评审原报"三处"以此为准），不经 `deriveJoints` 的出口序 ⇒ 对本变异天然免疫。"每天检查"那句成立（红的主力仍是 `checkKinds`），但它守的是派生出口，不是索引。
6. `commands/opening.ts` 的 `assertFitsAfterInsert`：整段注释掉 → Expected: ~~**本文件一条都不红**~~ **【执行订正：这句是错的，实测红测试 5 与测试 8，共 7 红】**`checkSpans` 比的是"分段与洞口区间互补"，那是派生自洽，写入守卫拿掉之后派生仍然自洽地把非法区间摊成一片越界的墙身段；红的是 Task 7 的「放不下洞口」「夹完撞上」。与变异 4 同记为非目标防线：写入校验由命令层的定值守，属性测试守的是派生。
   **实测与上面这段叙述冲突，以实测为准**：非法写探针 2 断言的就是"`openingMove` 越界必须抛 `/超出宿主墙/`"，而那条抛的产地正在 `assertFitsAfterInsert` 内部（它调 `piecesFromSpans` → `assertSpansFit`，抛点在 `geom/opening.ts:61`）⇒ 守卫一摘，探针不再抛，测试 5 与测试 8 一起红。也就是说**本任务的属性侧确实给这条写入守卫上了一把锁**，超出"命令层定值守写入、属性测试守派生"的分工叙述。"新文件零红"那条凭据属于**变异 4**，不属于本条。（另外 brief 点名的「放不下洞口」「夹完撞上」两条实测**不红**：它们的抛点在 `wallMoveEndpoint` 的 `assertSpansFit`，本变异不碰。）
7. `commands/wall.ts` 的 `clampOpeningsToWall`：`Math.floor` → `Math.round` → Expected: 测试 9 红（`recordClamps` 钉的是 `after === floor(轴长 − 宽)`，斜墙轴长带小数时两者差 1），Task 7 的「缩墙」与 Task 6 的斜墙值断言红。960 步里一次都没碰上 `.5` 的概率可以忽略；真碰不到就照 Step 4 的规矩把收缩后的反例抄进日志，别改断言。**这条同时证明测试 9 不是空跑**：`total.clamps > 0` 那行绿而这条变异不红，就说明夹取从来没真的发生过。
   **【执行订正】三点，都照实测改**：① brief 点名的 Task 7「缩墙：洞口夹到 floor(新轴长 − 宽)」实测**绿** —— 它那副夹具的轴长是整数，floor 与 round 同值；红的是同文件另外三条（「斜墙按 Math.floor 而不是 round：轴长 1999.7 → 1099，不是 1100」、「新墙比洞口还短 → /放不下洞口/…夹到 0 的边界两支」、「撤销拉伸：一次拖拽夹两樘…重放逐字节相同」）。**名字里写着 floor 的那条不是靶心，带小数的轴长才是** —— 这句话得留在日志里，否则下一个读 brief 的人会以为前者在守。② 本文件测试 9 第一次跑（`0f3837b`）红在随机轮的下游派生抛（`墙沿轴长 8366.8，洞口占 7452–8367`），`clampDirected` 里的 floor 断言没执行到就红了 ⇒ 评审 Minor 1 把定向那笔**前置**（`b88d2ba`），现在红字是 `clampOpeningsToWall`（`commands/wall.ts:182`）自己那条越界（`轴长 7017.8，洞口占 6018–7018`），一眼指着夹取公式。③ 前置后全量红集合从 5 条缩到 **4 条**：测试 8「四种非法探针」这次**绿** —— 它上一轮的红是随 seed 流撞出来的（本文件不钉 seed，`seed:` 出现 0 次），不是结构性必红。⇒ 这条变异能依赖的必红只有定向那一笔与 commands-opening 的三条定值。
8. `spatial/index.ts` 的 `applyAffected`：删掉 `dirtyIds` 里"共享端点"那一半闭包（即 `for (const dep of this.dependsOnOf(doc, id)) queue.push(dep);`，只留 `expandAffected`）→ Expected: 测试 10 红（增量 != 全量，邻墙盒子发霉），**测试 14 同时红**（画第 i 段时那根老墙留在"自由端"的那个盒子和 `fromDoc` 全量对不上），**Task 9 的四条同时红**（「删一面墙」「改一面墙的墙厚」「新建的墙复用既有端点」「在两个既有端点之间合上一间房」；它们是定值用例，摘掉半条闭包必红，实测见 Task 9 执行回填的变异表第 1 行），而「拖拐角」仍绿。这一条把 Task 9 留的那句"双向闭包缺半条就漏邻墙"接到随机链上：随机链每个接头都是共享端点，删半条闭包在 80 × 12 步里必撞。**（原稿这里写的是"前提是 `ChainOp.kind` 里有 `addWall`，否则随机链造不出新建实体挂到既有点上那一类，四条里只有两条会红"—— 三处都不成立：那四条是定值用例、与 `ChainOp` 无关；而 `ChainOp` 加一种 `addWall` 也到不了那一步，因为测试 10 的索引建在链画完**之后**。判由与替代方案（测试 14）见 Step 3 前面的『Task 10 下达前的归属改判』第 1 条。）**

跑完八条**必须回到全绿**再进 Step 7（`git status --porcelain` 只该有本任务那几个测试文件）。

- [ ] **Step 7: 提交**

```bash
git add packages/core/test/geometry-properties.test.ts packages/core/test/integration-two-storeys.test.ts packages/core/test/arbitraries.ts packages/core/test/properties.test.ts
git commit -m "$(cat <<'EOF'
test: 几何属性测试与两层整合

闭式解预言按侧比对每个墙端的斜切量，随机链与操作序列每步逐一核对六个检查器，
spec 11.1 的两层住宅以定值钉住 tee、面积恒等式与 30 步撤销重放。
EOF
)"
```

执行日志写在这里：14 + 8 条的实际结果与两个墙钟时间（降档了就写降到哪一档、为什么）、八处变异各红了哪些用例（**第 4 条要写明"本文件一条都不红"，它是非目标 1 的凭据；第 6 条原样写错了，实测红两条，见那一条下面的执行订正**；**第 1、2、3 条要写明各自那批"故意留绿"**：变异 1 不打左折的混合角、变异 2 不动点集与面积、变异 3 才打得到混合角里的右转 —— 三处绿是关键判断 1 与非目标 2 的量化凭据，漏记就等于下次没人知道哪条断言不该单独承重）、Step 5 登记表里有没有与实际跑出来不一致的数（有的话把两个数都抄下来：算错的要改登记表，实现错的是缺陷，走"改实现"那条），以及测试 2 现场演示的那组"错误配对的角点仍然两两重合"的坐标 —— 它是关键判断 1 唯一的可视化证据，别只留一句结论。

**留给后续计划的钩子**：① 本文件的闭式解预言（`expectedTrims` / `oracleTrims` / `endsByPoint` 三件套，约 90 行）是计划 5 标注尺寸线时唯一的浮点第二证据，计划 5 要把它抽成 `test/oracle-joint.ts` 共享而不是复制 —— 复制的代价在 Step 3 的 `overlaps` 那里演示过（一份判据两处用，变异就打不中）。② `recordClamps` 那套"派发前后各读一次实体、在中间那一刻断言"的写法，是计划 4（MySQL 落库）验"写库前后真源一致"的现成模板。③ `arbChainShape` 只产开放链，闭合环（外框一圈、共享首尾点）由 Step 5 定值覆盖；计划 3 的 2D 视图要做"绕一圈闭合"的交互，就得回来给生成器加 `closed: boolean` 并让 `assertChainBounds` 允许末点复用首点 —— 现在不留这个字段，因为属性测试不需要它就够了。

#### Task 10 执行回填（2026-09-27，两棒 + 评审 + Minor 1 就地修之后）

提交链：`0f3837b` `test: 几何属性测试与两层整合`（4 files / **+1962 −5**：`arbitraries.ts` +132、
`geometry-properties.test.ts` 1482 新、`integration-two-storeys.test.ts` 351 新、`properties.test.ts` +27 −5）
→ `b88d2ba`（评审 Minor 1：夹取靶心前置）。`packages/core/src` 在两个提交里**零改动**
（`git show --name-only` 复核）。评审席一份：**APPROVED_WITH_MINOR，0 Blocker / 0 Major / 4 Minor**，
三裁见下面第 3 段。

门禁落地态：`pnpm verify` = **280 passed / 23 files**（= Task 9 的 258 + 22）。控制器在 `0f3837b` 与
`b88d2ba` 上各重跑一次，两次 exit=0。两个墙钟时间：`geometry-properties.test.ts` **744ms**（全量跑里；
单文件 659–728ms）、`integration-two-storeys.test.ts` **33ms**，全量 `Duration 1.22s` ⇒ 距 20s 阈值很远，
**未降档**，`NUM_RUNS_OPS=80 / INDEX=40 / LIGHT=200` 原样。降档那三条与"降一档连带动哪些下界"那张表
这次一条都没用上 —— **别把它们当成已验证的路径**。条数对上正文：属性 14 条（A 1–4 预言自证 /
B 5–11 每步核对 / C 12–13 生成器自觉 / D 14 索引跟着画墙）+ 整合 8 条定值 = 22 条新增；
`properties.test.ts` 仍是 **9** 条（只换取值写法，没加用例）。

**Step 5 登记表与实际跑：没有不符的数**（八条定值在基线与八次变异后的全绿跑里都通过，
变异 2 / 4 / 8 恰好把依赖位置与索引的那几条打红）：接头 **8/层**、`deriveJoints` 全层 **16**、
墙身片 **12/层**、Σ轮廓 **8,140,800 mm²**、Σ轴长×厚 **8,184,000 mm²**、差额 **28,800 + 14,400**、
整层 AABB **{−120, −120, 8120, 6120}**、索引 `size` **12/层**。

**八处变异的实测红集合**（每条 `pnpm verify > /tmp/t10-mN.log 2>&1; echo exit=$?`，跑完立刻按精确路径
`git checkout -- <该一个 src 文件>` 撤；八条全部 exit=1，收尾 `/tmp/t10-final.log` 回 280/23）：

| # | 变异 | 实测 | 与正文 |
| --- | --- | --- | --- |
| 1 | corner 分支 `sb = sa` | 8 红（joint 2 + 整合「同向角定值」+ 属性 2/3/5/11/13）。**故意留绿**：测试 1（全左折）、测试 4（不读 trim） | 两处订正：测试 2 红、测试 11 漏列 |
| 2 | `wallQuad` 下标整体错开两位 | 9 红 / 4 文件（属性 4/5/11、Task 5 三条角点位置、`opening-geom`「只含本层」、整合两处 `quadEndCorners`）。**故意留绿**：测试 12 + 全部面积断言 | 吻合，"面积不能单独承重"拿到凭据 |
| 3 | `innerSide` 写死 `return 1` | 8 红，**红名单与变异 1 逐字相同**；tee 定值仍绿 | 措辞订正：区别只在反例层 |
| 4 | cross 的 `faceSide` 提到循环外 | 2 红（Task 4 十字 + Task 5 十字面积并集）；**本任务 22 条一条都不红** | 吻合 ⇒ 非目标 1 的凭据在这条身上 |
| 5 | 删 `deriveJoints` 出口排序 | 4 红（属性 5/11/13 + Task 4 逐字节相同）；`spatial.test.ts` 24 条全绿 | Task 9 那半没兑现，评审裁为合理免疫 |
| 6 | 摘 `assertFitsAfterInsert` | 7 红（Task 7 五条越界判据 + **本文件测试 5、8**） | **正文预言错**，见上面第 6 条订正 |
| 7 | 夹取 `floor` → `round` | `0f3837b` 上 5 红（Task 7 三条 + 属性 9、8）；`b88d2ba` 前置后 **4 红**（属性只剩 9，且红在 `wall.ts:182` 自己那条越界） | 见上面第 7 条订正 |
| 8 | `dirtyIds` 摘"共享端点"半条闭包 | 6 红（属性 10、**14** + Task 9 定值四条）；「拖拐角」仍绿 | 吻合，测试 14 兑现了设计目的 |

**三处"故意留绿"是关键判断 1 / 非目标 2 的量化凭据**：变异 1 不打左折的混合角、变异 2 不动点集与面积
（循环移位不改鞋带绝对值）、变异 4 打不到本任务两个新文件（随机链不产 cross、图纸只有 tee）。
**变异 8 的写法记一笔**：按正文"删掉整行 `dependsOnOf` 调用"会让 `noUnusedLocals` 先炸 typecheck，
实跑得改成"取边保留、只删 `queue.push(dep)`"的等价写法才测得到那一刀。

**Ruling ㊫ 的 seed 复现实测（"不钉 seed"这个决定的凭据）**：fast-check 4.10.2 失败时本来就打印 seed 与
path —— 变异 1 的日志里测试 3 带 `{ seed: -524815775, path: "0:0:0:0:0:0:0:0:0:0:0:0:1", endOnFailure: true }`，
收缩 12 次后的反例是 `{points: [(0,0), (3464,2000), (5464,5464)], walls: [{100,false}, {100,true}]}`。
原样填回 `fc.assert(prop, { seed, path })` 复跑（`/tmp/t10-seedreplay.log`）得到**逐字节相同的 Counterexample**、
`Shrunk 0 time(s)`、`Property failed after 1 tests`。临时 harness 已删、未回插任何测试文件，
本文件里 `seed:` 出现 **0** 次（不钉 seed 的规约没被破坏）。

**测试 2 现场演示的那组坐标（关键判断 1 唯一的可视化证据）**：落地在 `geometry-properties.test.ts:1168-1195`，
夹具是 start/start 等厚直角（`startStartCorner(240, 240)`，共享点在原点）：
`expectSamePointSet(buggyA, buggyB)` —— 两侧 trim 各自取反后，A 与 B 在该端**仍是同样两个点**；
`expect(buggyA[0]!.x).toBeLessThan(0)` 对 `expect(good[0]!.x).toBeGreaterThanOrEqual(0)` —— +normal 侧那枚内角，
正确的是 **x = +120（房屋内侧）**，错误的是 **x = −120（跑到墙外）**；再用 `sortPts` 两句证明"按侧比对口径
看得见、多重集口径看不见"。**为什么不是正文那种写法**：`Math.min(good[0]!.x, good[1]!.x) >= 0` 在
start/start 直角上不可满足（正确的凸角本来就是 (−120,−120)），照抄会红在
`expected -120 to be greater than or equal to 0`；改成只钉 +normal 那一枚，"多重集不变、按侧全错"
这句话依然成立。

**评审三裁（Minor）**：① 测试 2 在变异 1 下红**不是污染**，是 brief 的散文与它自己的 fence 自相矛盾
（fence 一直读实现），保留现状；② 变异 5 对 `spatial.test.ts` 的免疫**合理**（索引自己重排两处，见上面
第 5 条订正），排序契约由 Task 4 定值 + `checkKinds` 每日守；③ 变异 7 的 floor 靶心逻辑上锁死
（`recordClamps` 内两句 + `clampDirected` 末三句 + `floor ≠ round` 哨兵），只是执行顺序会把消息遮蔽 ⇒
已就地前置（`b88d2ba`）。另两条 Minor 登记不修：`checkKinds` 里的 `not.toContain` 与 `index.empty++`
是恒真语句（brief 原样，留着当"这一类没出现"的记录，不承重）。
---

## 全分支终审与修复批（2026-09-27，计划 2 收口）

终审席（覆盖 `470109a..76bd526` 的 39 个提交）判 **CHANGES_REQUESTED**：0 Blocker / 3 Important / 11 Minor，
并把散在各任务回填里的 22 条挂账一次性处置完（修 5 / 继续挂 6 / 转下游 7 / 前序提交已修 4）。
全文存档在 `.superpowers/sdd/2026-09-25-dajia-plan2-geometry-invariants/final-review-plan2.md`（gitignored）。
三条 Important 在派发修复前逐条 grep 复验为真，**报告措辞不作为开工依据**。

**修复批**：`0ef01a2` → `c8da525` → `4f2aaac` → `efbc5ea` → `185c980` → `3912b26`（代码），
`9ab0e60`（控制者的正文账），`d65dff9`（重评 M-1 就地修）。门禁 **280 → 284**（`Test Files 23`），+4 全来自新守卫用例。

| 终审条目 | 落地 | 实测凭据 |
| --- | --- | --- |
| I-1 `wall.create` 缺正数与楼层类型守卫 | `0ef01a2`：`positiveMm` 提到 `units/mm.ts`，六处手写点合并（文案逐字节不变），`wall.ts` 两处入参过它，`build` 首行换 `requireStorey` | 新增 4 条定值（零厚 / 负厚 / 零高 / 拿墙当楼层）；反向哨兵：`thicknessMm: 240` 的正常建墙用例仍走同一工厂且绿 ⇒ 工厂不是无差别抛 |
| I-2 命令层手写轴长 + `floor` 绕过写回守卫 | `c8da525`：三处 `Math.hypot` 换 `length(sub(vec,vec))`；`:159` 的 `Math.floor` 包 `assertMm(…, '夹取后的洞口距离')` | 逐位相同（`vec()` 归一 `-0`、`length()` 就是 `Math.hypot`），全量断言值一字未改 |
| I-3 洞口→沿轴区间投影写了三遍 | `4f2aaac`：新产地 `spansOfOpenings(openings): OpeningSpan[]`，`openingSpans` 只剩跨层判定 + 委托，`clampOpeningsToWall` 改吃它；计划 3 的 `drawlist` 正文同步改吃（`9ab0e60`） | 摘掉新产地的 `.sort()` **红 3 条**（`opening-geom.test.ts:161`、`commands-opening.test.ts:302` 与 `:638`）⇒ 升序契约有人守，不只靠 `assertSpansFit` 的内部错误抛 |
| 挂账 #4 `dependentsOf` 的 `default: break` 静默吞新 kind | `efbc5ea`：显式列全 `opening/column/slab` + `const exhaustive: never = entity` 汇合点 | 重评席实测：临时加第 7 个 kind → `tsc` 在 `topology.ts:126` 报 TS2322（真能编译不过，不是口头承诺） |
| 挂账 #18 / M-9 `angleBetween` 把退化折成 0 | `185c980`：零长度抛，与同文件 `sinOfAngle` 同口径；src 消费者 0，只有 `vec.test.ts` 引用 | 两条退化用例（`vec(1,0)×vec(0,0)` 与反向）；共线非零那条 `toBe(0)` 原样不动 |

**重评席（`final-fix-rereview.md`）判 APPROVED_WITH_MINOR，三条 Minor 的处置**：
- **M-1 已修（`d65dff9`）**：三条正数定值原来写成 `expect(() => log.dispatch(wallCreate(…))).toThrow(…)`，
  工厂与 dispatch 混在一个 thunk 里 ⇒ 守卫挪到哪一层都绿，只钉住"这个输入进不了真源"、没钉"谁拦的"。
  改成只调工厂（`build` 根本不执行），能过 `toThrow` 就只能来自 `wallCreate` 返回之前。
  **未做的检查要写清**：原打算把守卫真的挪进 `build` 看它红，被权限闸门拦下 ⇒ 这里给的是静态推理加"合法入参不抛"的反向哨兵，不是一次变异实测。
- **M-2 判不改**：新文案 `夹取后的洞口距离` 在测试目录 0 命中。这条 `assertMm` 今天**没有任何可达路径**能触发它的抛错
  （`Math.floor` 恒整数，超安全整数要轴长 > 2⁵³），唯一可观察的作用是 `-0` 归一，而那发生在补丁被丢弃的路径上（`assertSpansFit` 先把越界抛掉了）。
  给它补用例等于造一个不可能的入参，写出来是一条只会永远绿的装饰断言 —— 登记为"防御性守卫，无靶心"。
- **M-3 报告措辞**：`final-fix-report.md` 三处把用例名引成"零墙高被拒：与墙高同口径"，磁盘上是"与墙厚同口径"。
  报告是历史存档，不改写；权威正文（本节）按磁盘写。

**转下游的 7 条，别丢**：计划 3 —— #1（`wallMoveEndpoint` 的 `end:'start'` 角色反转用例，拖拽入口天然两端都拖时补）、
#11（`transaction.ts` 失败事务留下上一次 `lastAffected` ⇒ 计划 3 的增量重建要写死"dispatch 抛错 = 不重建"）、
#14（`cellKeys` 无 key 上限，随缩放级别一起在 T4 定）、#15（`dirtyIds` 对每 id 现调 `expandAffected` 的 O(n²) 性能账）；
计划 4 —— #5（`isExistingPoint` 的 `{x,y,pointId:undefined}` 只在反序列化进得来，修在 zod 边界加 `.strict()`）、
#10（命令入参一律冻结，含 `SlabCreateInput.boundary` 按引用捕获）、#12（跨层批量校验要的是共享版 `assertNoVerticalOverlap`）。
另有 6 条"继续挂"（`wall.ts` 两枚 point 字面量、存档报告少写一条、`板边界`/`ring` 同文案、`NaN` 打印成 `null`、
`applyAffected` 边派生边提交、两条恒真计数语句）—— 判留理由逐条在 `final-review-plan2.md` 的处置表里。
