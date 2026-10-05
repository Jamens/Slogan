# 搭家 S1 · 计划 5：图纸引擎（M1.4 + 剖切轮廓）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **状态：设计决策已逐条确认（2026-10-06），Step 正文待执行。** 用户选定范围 = **平面图 + 剖切轮廓**，粒度 = **只写设计决策与判据清单**（不照抄 plan4 那种 16653 行的逐字密度）。执行时若某条判据与盘上不符，**改实现与注释，不改判据形状**（T4/T6/T7 沿用的纪律）。每 Task 结束跑 `pnpm verify` + `pnpm test:db` 全量。

**Goal:** 从「已在 2D 视口里画出的两层房子」到「导出一份 A3 1:100 可施工平面图 + 剖切轮廓」。

**Spec:** `docs/superpowers/specs/2026-09-25-dajia-s1-design.md` —— 本计划实现 §7「图纸引擎」的平面图部分（`linetypes` / `dimensioning/` / `frame.ts` / 图面 IR）、spec §6 的屏幕-交付物共用几何那条，以及 §3.1 里"S1 不做立面剖面"的**收窄解释**：S1 只做**剖切轮廓**（不是完整立面/剖面图），S2 才做立面剖面图与门窗表。

---

## 一、12 条设计决策（本计划的地基，2026-10-06 逐条确认）

这 12 条是执行本计划的**前提**。每条后面写"为什么这么定"与"改它要付什么"，执行时若发现某条与盘上冲突，**先回来改这一节并说明理由**，不要在 Step 里偷偷绕过。

| # | 决定 | 理由 | 改它的代价 |
|---|---|---|---|
| **A1** | 线型表分**两个域**，不强行统一 | `scene-2d/drawlist.ts` 已有 `LineType = 'solid' \| 'dashed' \| 'dash-dot'`（屏幕语义，配 `INK = '#1f1f1f'` 与像素线宽）；施工图要"线型 × 纸面线宽（0.18/0.25/0.35/0.5/0.7mm）"。**两者语义不同**（px vs 纸面 mm），强行统一会把"线宽"污染成两套尺 | 改 A1 就要扩 `drawlist.test.ts` 的既有判据（T3 验过：`drawlist` 的层序判据读 `DRAW_LAYERS` 真源） |
| **A2** | `drawing` 自己一套 `PaperLineType` + 一处**显式映射** `toScreenLineType()`，两族各留一格钉住映射 | 见 A1。映射是显式的、可测的；隐式共用会在将来某次"顺手统一"里悄悄改变屏幕观感 | — |
| **A3** | `drawlist` 的 `Pen` 增一个**可选** `paperWidthMm`，屏幕侧忽略它 | 不碰现有判据；导出侧读它。这是"屏幕与交付物共用同一份几何，但线宽不是几何"这条 spec 判断的落地形状 | 改这里要重跑 T3 的五道真窗口闸门（`--shot` 等，判据字面量一字不动） |
| **B1** | 只做 **1:100** | spec §11 验收标准写的是 1:100。1:50 留 S2 | — |
| **B1a** | **B1 是产品范围约束，不是 API 约束**：`requireScale(50)` 与 `mmToPaperMm(x, 50)` **合法**（`units.ts` 收窄只挡 `0` / 负数 / NaN / 非整数 / Infinity），S2 要做 1:50 时不必改签名 | 2026-10-06 执行 T2 时发现：§一 B1 说"只做 1:100"，而 §四 U4 那格我写了 `expect(requireScale(50)).toBe(50)` —— 两者字面矛盾。查清后认定**不冲突**：B1 管的是"S1 不做 1:50 那一档图幅排版"，`requireScale` 管的是"这个分母能不能算"。锁死分母会让 S2 来改签名，而那时改签名的成本远大于现在多放行一个合法值。**执行者若发现别处也有这层张力，按这条口径判。** | 若将来有人读B1 当成"分母只许 100"，会去改 `requireScale` 把它锁死 ⇒ S2 开工时必须先解冻 || **B2** | 只做 **A3 横式**；A1/A2/竖式留 S2 | spec §7 写"A1/A2/A3 横竖"是 S2「多图纸成册」的承诺，S1 兑现它属于过度承诺 | — |
| **C1** | 三道尺寸线**从轴网点收集** | 建筑制图惯例是轴线。链是通的：`PointEntity { storeyId, x, y }` → `StoreyEntity { projectId }`；core 已有 `incidentWallEnds(doc, pointId)` 可数一根点的墙端。**注意 `PointEntity` 没有 `projectId`**（spec §5.1 说它经 `storeyId` 关联），所以取 projectId 必须走 `storeyId → StoreyEntity → projectId`，不许直接读 | — |
| **C2** | 三道道间距**固定纸面毫米**（7 / 5 / 5），spec 的"按图面留白自动分道"降级为"**溢出时加一道**" | 固定值可测；"自动分道"是未定义算法，且它是 spec §7 里少数没有给出判据的句子。**这是本计划对 spec 的一处收窄，执行时需在报告里显式记一笔** | 保留自动分道 ⇒ 判据不可写 |
| **C3** | 尺寸端点符号长度**固定纸面 2mm** | 建筑制图惯例，且可测（进打印实测误差 ≤ 0.5mm 那条验收） | — |
| **D1** | 剖切线是**显式输入**（用户画一条），但**不进真源**，落在视图状态 | spec §5.5 已定"selection 与视图状态不进真源、不进撤销栈、不落库"。剖切线同理：它是"看这张图时的视角"，不是文档内容。**注意这与 T8 的 `projectStore` 一样落在 renderer 侧**——`Document` 不许因此加第七类实体 | 若改成文档内容 ⇒ core 数据模型加一类实体 + 迁移 + zod schema + 命令，属 S2 量级 |
| **D2** | 剖切轮廓**独立图幅**：一次导出出两页 PDF（平面图 + 剖切轮廓） | 一图两幅会污染 `frame.ts` 的坐标模型（每幅各有自己的图框与纸面原点） | — |
| **D3** | 剖到的构件只画**轮廓线**，不做 45° 剖面填充 | spec §3.1 明确 S1 不做材质/渲染；45° 填充是渲染语义 | — |
| **E1** | 屏幕侧**不做**施工线型预览，2D 视口继续用 `drawlist` 现物 | 屏幕上的施工线型是 S3 的一部分（它依赖线型表的第三族） | — |

### 被有意排除的（与 spec 的差距，逐条登记）

| 不做 | 依据 | 何时做 |
|---|---|---|
| 1:50 比例 | B1 | S2 |
| A1/A2/竖式图框 | B2 | S2 |
| 门窗表 | spec §3.1 | S2 |
| 完整立面/剖面图 | spec §3.1 | S2 |
| 45° 剖面填充 | D3 | S3 |
| SVG 预览后端 | spec §3.1（S1 明确不做预览层） | — |
| 屏幕侧施工线型 | E1 | S3 |
| 线型表第三族（屏幕预览） | A1 | S3 |

---

## 二、包结构与依赖方向

```
core  ←  drawing  ←  { desktop（导出入口）, scene-3d（M1.6 之后）}
         ↑
      scene-2d 不 import drawing（A1/A2：两族并存，映射在 drawing 内部）
```

`ALLOWED_DEPS` 现状（`scripts/check-package-deps.mjs`）：`drawing: ['core']` —— **本计划不需要改这个表**。`drawing` 只依赖 core，screen 侧的映射函数在 drawing 内部实现（输入是 drawing 自己的 `PaperLineType`，输出是 scene-2d 的 `LineType` 字面量集合，**不 import scene-2d**，只在那一个文件里写字面量并用一格测试钉住）。

**为什么 `drawing` 不 import `scene-2d`**：`ALLOWED_DEPS` 允许，但它会把"导出包"绑到"屏幕包"上，而 spec §4.1 写的是「`drawing` 图纸引擎：图面 IR → SVG / PDF。**只依赖 core**」。映射表用字面量 + 一格对账，是达成"共用一份规则"又不违反依赖方向的最便宜形状。

### 文件清单（本计划落地后新增）

| 文件 | 职责 | 格数 |
|---|---|---|
| `packages/drawing/package.json` | 已有骨架，需确认 `zod` **不要**引入（drawing 不做 schema） | — |
| `packages/drawing/tsconfig.json` | **新建**（现在没有，`pnpm typecheck` 串里也没有这个包 —— 见 §五的顺带修） | — |
| `packages/drawing/src/index.ts` | 现有 1 行占位，扩成逐名出口 | — |
| `packages/drawing/src/units.ts` | **比例与纸面换算的唯一产地**（模型 mm → 纸面 mm） | 6 |
| `packages/drawing/src/linetypes.ts` | 线型表（纸面语义）+ `toScreenLineType()` 映射 | 7 |
| `packages/drawing/src/ir.ts` | 图面 IR 的类型与构造助手 | 5 |
| `packages/drawing/src/plan.ts` | 平面图内容：墙/洞口/柱/板 → IR 图元 | 10 |
| `packages/drawing/src/dimensioning/chains.ts` | 从轴网点收集尺寸链 | 7 |
| `packages/drawing/src/dimensioning/render.ts` | 三道尺寸线分道 + 45° 端点符号 | 9 |
| `packages/drawing/src/frame.ts` | A3 横式图框 + 标题栏 | 6 |
| `packages/drawing/src/section/clip.ts` | 剖切线对 core 几何求交（D3：只轮廓） | 7 |
| `packages/drawing/src/annotate.ts` | 指北针 + 标高符号 | 4 |
| `packages/drawing/test/*.test.ts` | 上述各模块的 vitest（纯 node，不连库） | — |
| `apps/desktop/src/main/draw/export-plan.ts` | **唯一** Electron 出口：拼图面 IR → 存盘 | 4（unit） |

合计 **78 格**（unit 档，不连库；2026-10-06 由 79 订正为 78 —— `linetypes` 那栏原写 8 格，实测 7 格，因为 L5 是变异靶而非独立判据）。

---

## 三、图面 IR 的形状（D 组决策的落点，先钉死）

IR 必须**与格式无关**（spec §7），这样 S1 只写 IR + 一个存盘后端，S2 加 SVG 时不动上游。

```ts
/** 纸面坐标单位：**毫米**（不是像素、不是米）。1:100 时模型 3600mm ⇒ 纸面 36.0mm。 */
export type PaperMm = number;

/** 图面里的图层。顺序即绘制顺序（后画的压在上面），与 scene-2d 的 DRAW_LAYERS 语义平行但不共用枚举。 */
export const PAPER_LAYERS = ['frame', 'structure', 'opening', 'section', 'dimension', 'annotation'] as const;
export type PaperLayer = (typeof PAPER_LAYERS)[number];

export type PaperLineType = 'solid' | 'dashed' | 'dash-dot' | 'center';

export interface Pen {
  readonly layer: PaperLayer;
  /** 纸面线宽（mm）。线型表的五档：0.18 / 0.25 / 0.35 / 0.5 / 0.7 */
  readonly widthMm: PaperMm;
  readonly lineType: PaperLineType;
}

export type PaperOp =
  | { readonly kind: 'line'; readonly a: PaperVec2; readonly b: PaperVec2; readonly pen: Pen }
  | { readonly kind: 'polyline'; readonly pts: readonly PaperVec2[]; readonly pen: Pen }
  | { readonly kind: 'polygon'; readonly pts: readonly PaperVec2[]; readonly pen: Pen; readonly fill: boolean }
  /** 文字的纸面高固定 2.5 / 3.5mm（spec §7），对齐方式由后端解释，IR 只给基点 */
  | { readonly kind: 'text'; readonly at: PaperVec2; readonly heightMm: PaperMm; readonly s: string; readonly pen: Pen }
  /** 尺寸端点的 45° 短斜线（C3：固定纸面 2mm），用 `line` 也表达得出来，这一类是给后端的提示 */
  | { readonly kind: 'tick'; readonly at: PaperVec2; readonly pen: Pen };
```

**IR 里不出现的东西**（每一条都是"IR 无关格式"的证据，写进 `ir.test.ts`）：颜色、透明度、字体名、位图、SVG 属性、PDF 算子。

---

## 四、五个模块的判据清单

**这一节是本计划的执行面。** 每条判据写成"能红"的形态——即"删掉实现里的一处，这一条会红"。执行时逐条落地并**先证红**。

### `units.ts`（6 格，比例与纸面换算）

- `U1` 模型 mm → 纸面 mm：`mm / 100`（1:100），且**结果保留到 0.01mm**（1:100 下 10mm 的构件是 0.1mm 纸面，四舍五入到 0.01 足够）
- `U2` 纸面坐标的原点在**图框左上角**，y 向下（PDF 与 SVG 都是这个方向）
- `U3` 整数毫米纪律：`mm / 100` 产生浮点，**IR 允许浮点**（它不是真源），但**判据要钉住**「模型整数 mm → 纸面值恰是 `n/100`，不许出现 0.30000000000000004 这类尾巴」—— 用 `toFixed(2)` 收
- `U4` 比例非法值（0、负、NaN）**构造期抛**
- `U5` 纸面 → 模型（逆换算）**本计划不实现**（S2 才需要反向），但要有一格说明"故意没有"的注释与占位
- `U6` 比例常数**唯一产地**是 `units.ts`；`plan.ts` / `dimensioning/` 里不许出现字面量 `100`（变异样本：把 `units.ts` 的 `SCALE_DENOMINATOR` 改成 50，`plan.test.ts` 必须红）

### `linetypes.ts`（**7 格**，2026-10-06 实测订正：L5 是变异靶不是独立一格）

- `L1` 五档纸面线宽逐字：`[0.18, 0.25, 0.35, 0.5, 0.7]`，各线型的**默认档**有唯一映射
- `L2` 四种线型的**虚线节奏**（dash / gap，单位纸面 mm）是纸面量，**不随比例变**（建筑制图的虚线长度是图面规范，不是模型量）—— 判据：同一线型在 1:100 下的 dash/gap 与表里逐字相同
- `L3` `toScreenLineType()` 映射：`solid→solid`、`dashed→dashed`、`dash-dot→dash-dot`、**`center→dash-dot`**（中心线在屏幕上与轴线同一族；映射表只有一份且两族各留一格对账）
- `L4` 映射表是**闭集**：多一个线型名或映射到未列出的线型，判据红
- `L5` **变异靶（不是独立一格）**：`toScreenLineType` 里把 `center` 映成 `solid` ⇒ **`L3` 那格**红。实测读数见 §九（2026-10-06：1 格红，打中的正是 L3）
- `L6` 线型表**不许含颜色**（`grep` 源码：没有 `#` / `rgb` 字样）—— 颜色是屏幕域的
- `L7` 变异样本：给 `Pen` 的 `widthMm` 传 `0.3`（不在五档里）⇒ 抛（线宽只有五个合法值，不是任意正数）
- `L8` 判据钉住"`Pen` 的三个字段一起决定渲染"：同 `layer` 不同 `widthMm` 必须产出两条不同的 `PaperOp`

### `plan.ts`（10 格，平面图内容）

**依赖的 core 现物（已核准，2026-10-06 逐字读盘）：**

```ts
// packages/core/src/geom/outline.ts
export interface WallQuad { readonly wallId: EntityId; readonly corners: readonly [Vec2, Vec2, Vec2, Vec2]; readonly areaMm2: number; }
export interface StoreyGeometry { readonly storeyId: EntityId; readonly walls: readonly WallQuad[]; readonly joints: readonly Joint[]; readonly pieces: readonly WallPiece[]; }
export function deriveWallQuads(doc: Document, joints?: readonly Joint[]): WallQuad[];
export function deriveStoreyGeometry(doc: Document, storeyId: EntityId): StoreyGeometry;
```

**注意 `deriveWallQuads` 的 `corners` 是 4 个角，而 T2 证明了墙的轮廓**可能**被接头切成非矩形**（`JointMember.trimLeftMm/trimRightMm`）—— 四角仍是四角（斜切只动两个端点），但**洞口是在这四边之上切的**，所以墙身的画法是"四边轮廓 + 洞口挖空"，不是"多边形"。

- `P1` 一层一层的墙投影：**以 `deriveStoreyGeometry(doc, storeyId).walls[].corners`** 逐字投影为纸面多边形（不自己算轮廓）—— 这一条是"不写第二份几何派生"的证据
- `P2` 洞口：按 `OpeningEntity { hostWallId, distanceMm, widthMm, heightMm, sillMm }` 在**宿主墙的纸面投影上**挖空；挖空的方式是把墙的多边形**拆成"墙头-洞-墙尾"若干块**（平面图里洞口是留白的，不是画一个洞的轮廓线）
- `P3` 判据：**一堵墙上一个门 + 一个窗 ⇒ 墙身拆成 3 块**（这是 spec §5.4「洞口自动跟随」在图纸侧的可见证据）
- `P4` 变异的靶：把 `P3` 的洞宽从 `widthMm` 改成 `widthMm + 40` ⇒ `plan.test.ts` 红（洞在墙里但位置偏了 40mm）
- `P5` 洞口越界（洞口伸到墙外）**当场抛**，文案带宿主墙 id 与洞口 id —— core 的 `assertTruthSourceInvariants` 在读盘侧兜，drawing 侧要有一道独立的（spec §10 说"洞口永不超出宿主墙长"是 core 的不变式，drawing 不许重算一遍）
- `P6` 柱与板：`ColumnEntity` / `SlabEntity` 按 `deriveStoreyGeometry` 的 `pieces` 走（S1 有柱/板实体但无 UI，图上要画出来）
- `P7` 图层顺序：墙在 `structure`、洞口挖空产生的边界线在 `opening`、指北针与标高在 `annotation` —— 判据钉住 `PAPER_LAYERS` 的**索引顺序**与实际产出的层单调不减
- `P8` 楼层标题（每层标高文字）属 `annotation`，且**取 `StoreyEntity.elevationMm` 不取真源的派生**
- `P9` 变异样本：把层顺序写成 `['structure','opening',...]` 但产出时按 `annotation` 先画 ⇒ `plan.test.ts` 红（P7 的对账型）
- `P10` 空层（`deriveStoreyGeometry` 返回 0 面墙）⇒ 产出**空**图元数组，不抛（导出单层的工程是合法的）

### `dimensioning/chains.ts` + `render.ts`（16 格，本计划最费时的一族）

**C1 的链（照核准的字段写）：** 轴网点 = 该层的全部 `PointEntity`；每个点的坐标 `(x, y)`。**取 projectId 必须 `point.storeyId → doc.get(storeyId).projectId`**，不许直接读（`PointEntity` 没有 `projectId`）。

- `C1a` 一层两片正交墙 ⇒ **恰好 1 条总尺寸**（x 向）与 1 条（y 向）
- `C1b` 三点共线（x 相同的三片墙）⇒ x 向**恰好 1 条**，**不是 3 条**（去重是这一族的核心）
- `C1c` 尺寸链的**有序性**：从最小到最大，不按 `PointEntity` 的插入序
- `C1d` 变异样本：把去重的那一刀删掉 ⇒ `chains.test.ts` 红（C1b 变3 条）
- `C2a` 三道的道间距**固定纸面 7 / 5 / 5mm**（C2）；判据钉住"两道之间的**绝对纸面距离**"，不钉比例
- `C2b` **溢出时加一道**：轴网点超出 A3 可用图幅 ⇒ 道数 +1，且新道的间距仍是 5mm（不是重新分配）
- `C2c` 判据：同一份图在**不同轴网点数量**下，道数只随"是否溢出"变，不随点数线性变
- `C2d` 相交处**断线**：总尺寸的标注线穿过轴线尺寸的标注线时，断开 2mm 的缺口
- `C3a` 端点符号是 **45° 斜线**，长度**固定纸面 2mm**（C3）
- `C3b` 判据：符号线段的**两端点距离** == 2.000（用 `toBeCloseTo(…, 3)`，不用 `toBe` —— 浮点）
- `C3c` 变异样本：把 2mm 改成 2.5mm ⇒ 红
- `D3a` 尺寸线**不用箭头**（建筑制图的 45° 短斜线，C3a 已定）
- `D3b` 判据：`render.ts` 产出的图元里**没有**箭头类 op（IR 的五种 op 里就没有箭头 ⇒ 这一格是"IR 表达力够用"的证据）
- `M1` 变异的靶（**唯一允许改形状的一族**）：任一条尺寸的**数值文字**必须等于该两轴网点距离 × 比例，判据用 `scaleAndRound(distanceMm, 100)` 那个函数算出来逐字比
- `M2` 文字纸面高固定 **2.5mm**（spec §7）

### `frame.ts`（6 格）

- `F1` A3 横式尺寸 **420 × 297mm**（逐字，这是硬门）
- `F2` 装订边 25mm、其余边距**有值且可测**（图面留白 = 纸面减去图框，不是 `0` 也不是"自动"）
- `F3` 标题栏字段：图名、比例、日期、设计人、图号 —— 五格逐字进 IR 的 `text` op
- `F4` 标题栏的**位置**在图框**右下角**（建筑制图惯例）
- `F5` 图框线宽用**最粗那档 0.7mm**，与 `L1` 逐字一致
- `F6` 变异样本：把 A3 的 420 写成 400 ⇒ `frame.test.ts` 红

### `section/clip.ts`（7 格，D1/D2/D3）

- `X1` 剖切线是**视图状态**（D1）：`clipLine: { a: PaperVec2; b: PaperVec2 }` 只出现在本模块的**入参**里，**不出现在 `PaperOp` 里**，也不进 `Document`
- `X2` 判据钉死这条：`clipLine` 与 `Document` 的**序列化结果逐字相同**（即剖切线不改变文档一个字节）—— 这是 D1 最直接的证据
- `X3` 求交：对 `plan` 产出的墙/柱/板纸面多边形求与剖切线的**交段**
- `X4` **只看剖切线一侧**：约定剖切线的**法向右侧**为保留侧（判据钉死这个约定，不许"哪边都行"）
- `X5` 剖到的构件输出**轮廓线**（`polyline`），**不输出填充**（D3）：判据钉住产出里没有 `fill: true` 的 op
- `X6` **不剖楼板轮廓线以外的东西**：楼板在平面图里是轮廓线（不是填充），剖到它时仍只画线
- `X7` 变异样本：把 `X4` 的保留侧判反（`<` 改成 `>`）⇒ `clip.test.ts` 红
- `X8`（D2）剖切轮廓**独立图幅**：本模块产出一个**新的** IR（有自己的图框），不是往平面图那个 IR 里加层

### `annotate.ts`（4 格）

- `N1` 指北针是一个**可辨识的图元序列**（针尖三角 + 圆环或十字），判据钉住"包含一个 45° 斜线段 + 一个闭合多边形"两件事，而不是钉住"长得像"（那是像素测试，本计划不做）
- `N2` 标高符号同理（建筑制图的等腰直角三角）
- `N3` 两者的图层是 `annotation`，且**在 `dimension` 之后**（`PAPER_LAYERS` 的索引顺序钉住这一点）
- `N4` 判据：缩放（A3 → 别的尺寸）时这两个符号的**纸面尺寸不变**（它们是图面规范量，不随图幅缩放）

### `apps/desktop/src/main/draw/export-plan.ts`（4 格，unit 不连库）

- `E1` 出口是**纯函数 + fs 参数**：`(doc, opts, outPath) => void`，不 import electron（与 T7 的 P-2 同一条纪律，`persist-boundary.test.ts` 那一族的常驻证人扩到它）
- `E2` 判据：同 `doc` + 同 `opts` 连跑两次 ⇒ 产出的**字节逐字相同**（IR 里的实体排序稳定）
- `E3` 判据：`opts` 里的日期/设计人是**入参**，不是 `new Date()` / `os.userInfo()`（否则同 doc 两次跑出不同字节，E2 就红）
- `E4` 变异样本：把实体排序改成按插入序 ⇒ E2 红（房建顺序与 id 序不同就会漂）

---

## 五、顺带修的一个真缺口

`packages/drawing` 现在**没有 `tsconfig.json`**，且**不在根 `pnpm typecheck` 串里**（`scripts` 里串的是 core / protocol / scene-2d + desktop 三个）。**M1.4 落码时必须同时改两处**，否则这个包的类型错误要等 `pnpm build` 才暴露：

1. 新建 `packages/drawing/tsconfig.json`（照 `packages/scene-2d/tsconfig.json` 的形状）
2. 根 `package.json` 的 `typecheck` 串加 `tsc --noEmit -p packages/drawing/tsconfig.json`

**先证红**：改完之前往 `drawing/src/index.ts` 写一个类型错，`pnpm typecheck` **必须不红**（证明它当时真的不在串里）；改完之后必须红。判据记在 Task 1。

---

## 六、Step 划分（8 个 Task）

| Task | 内容 | 退出条件 |
|---|---|---|
| **T1** | 包地基：`tsconfig.json` + 根 `typecheck` 串 + `lint:deps` 确认（§五的先证红） | 一个类型错能红 |
| **T2** | `units.ts`（6 格）+ `ir.ts`（5 格） | 换算逐字、IR 里无格式概念 |
| **T3** | `linetypes.ts`（8 格） | 五档线宽、四线型、映射闭集 |
| **T4** | `plan.ts`（10 格） | 一层房 → IR，洞口拆块 |
| **T5** | `dimensioning/`（16 格） | 三道尺寸线、去重、断线、45° 符号 |
| **T6** | `frame.ts`（6 格）+ `annotate.ts`（4 格） | A3 420×297 逐字、标题栏五格 |
| **T7** | `section/clip.ts`（7 格，D1/D2/D3） | 剖切轮廓独立图幅、只轮廓不填充 |
| **T8** | `export-plan.ts`（4 格）+ 全量复跑 + 回填本计划 | verify / test:db 全绿，格数对账 |

**依赖**：T2 → T3 →（T4 与 T5 可并行）→（T6 与 T7 可并行）→ T8。

---

## 七、测试策略与退出条件

| 层 | 手段 | 断言对象 |
|---|---|---|
| `drawing`（纯 node） | vitest | 每个模块的判据清单；**IR 快照**（plan 的输出逐个图元钉死） |
| `export-plan` | vitest（unit，不连库） | 字节稳定性（E2）；import 边界（E1） |
| 回归 | `pnpm verify` + `pnpm test:db` 全量 | 不许碰坏 T1–T7 的 644 / 110 |

**T8 的退出条件**（一条一句）：

1. 一个两层、外墙 240mm、含 4 门 4 窗的工程，产出 A3 1:100 平面图 IR，其图元逐个符合本计划第四节的判据
2. 同一份 doc 连跑两次，产出的**字节逐字相同**
3. `pnpm typecheck`（含新的 drawing 串）/ `pnpm verify` / `pnpm test:db` 全绿
4. `drawing` 包的 import 边界由一格常驻证人钉住（不 import electron / 不 import scene-2d）

---

## 九、执行回填

### T1（包地基，2026-10-06）

**先证红的两半**（本棒的全部凭据）：改**之前**往 `drawing/src/index.ts` 写两个类型错（`const PROBE: number = 'x'` / `const ALSO_PROBE: string = 42`），`pnpm typecheck` **exit=0**、日志零个 drawing 报错 ⇒ 证明 §五 那个缺口是真的；改**之后**同样两个错 ⇒ **exit=1**，报 `(4,14) TS2322` 与 `(5,14) TS2322`，行号精确。

新建 `packages/drawing/tsconfig.json`（照 scene-2d 形状）；根 `typecheck` 串加一发。**格数一格未动**（49 / 644、6 / 110）—— T1 只改配置不加格，这正是 §六 给 T1 的退出条件。

**两件确认过没改的事**：① `ALLOWED_DEPS` 里 `drawing: ['core']` 已是 §二 要的形状，不必动（`lint:deps` exit=0）；② `vitest.config.ts` 的 `packages/*/test/**/*.test.ts` 收得到 drawing 的测试（落了个占位格跑通后删掉）。

### T2（units + ir，2026-10-06）

**落码**：`units.ts`（换算唯一产地）+ `ir.ts`（图面 IR）+ `units-ir.test.ts` **11 格**。

**① U3 判据的前提是错的，已实测订正。** 原文写的是 `expect(String(30 / 100)).not.toBe(String(mmToPaperMm(30)))` —— 它红了，而**红的原因是判据错不是实现错**。实测：**整数 mm 除以 100 在 JS 里是移位，`30/100 === 0.3` 逐字相同**，裸除法在「1:100 + 整数模型值」这条主路上**一个尾巴都不出**。`toFixed(2)` 真正防的是主路之外的边：纸面尺寸（A3 的 420/297）、S2 的 1:50 下非整数模型值。已把判据改成钉「收口是换算路径上的唯一产地」这个真实形状（用分母 1 把收口单独拎出来验：`33.333333333333336 → 33.33`、`1 分母下 1/3 → 0.33`）。
> **给 T3 起的教训**：判据要钉真实的形状，不是钉一个听起来合理的担忧。本仓已栽过两次同型的（T7 的 `toEqual(undefined)` 恒绿、T7 的"空栈那格拿逆补丁比原件"）。**写完一格先问：它红的时候，实现坏在哪一行？答不上来就是判据自己错。**

**② §一 B1 与 §四 U4 字面矛盾，已立决策 B1a 消解。** B1「只做 1:100」是**产品范围**约束（不做 1:50 那一档图幅排版）；`requireScale` 只管「这个分母能不能算」，`requireScale(50)` / `mmToPaperMm(x, 50)` **合法**。锁死分母会让 S2 开工时来改签名，而那时改签名比现在多放行一个合法值贵得多。**若将来有人把 B1 读成「分母只许 100」去改 `requireScale`，那是本条要拦的事。**

**③ 「IR 与格式无关」是判出来的**：一格扫 `ir.ts` 源码文本，命中颜色字面量 / `rgb(` / `opacity` / `fontFamily` / `<svg` / `BT`+`Tf` 等 PDF 算子 / 位图 / base64 任一即红。`Pen` 严格三字段（layer / widthMm / lineType）。

**T2 变异实测**：

| 变异 | 红格 | 打中的格 |
|---|---|---|
| `SCALE_DENOMINATOR` 100 → 50 | **3** | U1 / U2 / U3 |
| 给 `Pen` 加一个 `color` 字段 | **1** | `IR 的 Pen 只有三个字段` |

**T2 盘上**：`pnpm verify` exit=0，**`Test Files 50` / `Tests 655`**（T1 时 49 / 644 ⇒ +1 / +11）；`pnpm typecheck` exit=0（**含 T1 新接的 drawing 串**）；`tsc -p packages/drawing/tsconfig.json` exit=0。`test:db` 本棒未跑（T2 不碰连库档），仍为 6 / 110。

### T3（线型表，2026-10-06）

**落码**：`linetypes.ts` + `linetypes.test.ts` **7 格**（§二 原写 8，见下）。这是决策 A1/A2 第一次落到代码上。

**① 格数按实测订正：8 → 7。** §二 与 §四 把 `linetypes.ts` 写成 8 格，实测 **7 格** —— **L5 是变异靶不是独立一格**（它的形态是"改 `center` 映射看 L3 红"，本身不产格子）。合计 79 → **78 格**。按 §六 的规矩「执行时每棒按盘上实测重数并把真数写进回填，**不许追幻影差异**」处理。
> **给 T4 起的同类提醒**：§四 里凡是写着"变异样本 / 变异靶"的条目，都**不计入格数**。数格数时先分清哪些条目产出 `it()`、哪些只是"改这里看那里红"。

**② 注释里也不能出现"颜色"这个词。** L6 那格扫的是 `linetypes.ts` **自己的源码**，正则含 `\bcolor\b` / `\bink\b` —— 所以实现里讨论"为什么不用颜色"时**不能把那个词写进注释**，否则本格误红。第一版注释里写了"颜色"，已改成描述性的说法。

**③ `noUnusedLocals` 抓到测试里一个未用 import**（`TS6133: 'PaperOp'`）—— 已清。**这是 T1 那个缺口补上之后的第一个实际收益**：drawing 包现在也享受 `noUnusedLocals`，而 T1 之前它连 typecheck 都不进。

**变异实测**：

| 变异 | 红格 | 打中的格 |
|---|---|---|
| `center` 映成 `solid`（L5 的靶） | **1** | L3 正是那格 |
| 放行任意线宽（`includes` 检查换成 `false`） | **1** | L7 正是那格 |

**盘上**：`pnpm verify` exit=0，**`Test Files 51` / `Tests 662`**（T2 时 50 / 655 ⇒ +1 / +7）；`pnpm typecheck` exit=0；`tsc -p packages/drawing` exit=0。`test:db` 未跑（T3 不碰连库档），仍 6 / 110。

**待办**：T4 `plan.ts` 10 格 → T5 `dimensioning/` 16 格 → T6 `frame.ts` + `annotate.ts` 10 格 → T7 `section/clip.ts` 7 格 → T8 `export-plan.ts` 4 格 + 全量。**§二 写的 78 格是编写期预估**（含已落的 11 + 7 = 18 格），每棒结束按盘上实测重数并回填。

**需人工验证、本计划不打勾的项**（沿用 spec §10 的口径）：

- A3 实体打印后拿尺量图框与标注（这是 spec §11 验收 1 的一部分，**本计划只能产出 IR，打印实测归 M1.5**）
- 剖切轮廓在真实图纸上的建筑制图惯例是否可接受（D3 选了"只轮廓"，那是**没验证过的选择**，人工看一眼再决定要不要升级成填充）

---

## 八、给执行者的须知（这个项目栽过的坑，逐条）

1. **判据先证红。** 每条新判据提交前先改坏一个界看它叫。本计划第四节的每一条判据都标了靶点。
2. **一条判据在"功能缺失"时也成立 = 假绿。** T7 踩过：`expect(x).toEqual(undefined)` 两端都 undefined 时恒绿。写完一格先问"没有这个功能时它会红吗"。
3. **规格与盘上不符 ⇒ 改规格或改实现，不改判据形状。** T7 Step 6 踩过：规格把 `migrate` 压在业务池上，而 `locks.test.ts` 的注释里已写着正确形状。
4. **按行号插入代码前先 `grep -n` 复核。** T7 踩过：编辑使行号漂移，按旧行号插入插错了地方。
5. **闸门一律重定向取 exit**：`pnpm verify > tmp/x.log 2>&1; echo exit=$?`，**绝不 `| tail`**（管道吃 CJK 行）。
6. **本计划的格数是编写期预估。** 执行时每棒必须按盘上实测重数并把真数写进回填——**不许追幻影差异**（T7 计划 3 的教训：席位被告知计划数会去改判据凑数）。
7. **A1/A2 那族映射不许"顺手统一"。** 屏幕 px 与纸面 mm 是两套尺；发现看着重复时先读 §一的理由。
