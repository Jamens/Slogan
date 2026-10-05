import { Document, type EntityId } from '@dajia/core';
import { line, text, tick, type PaperOp, type PaperVec2, type Pen, type Sheet } from './ir';
import { PEN_BY_LINE_TYPE } from './linetypes';
import { mmToPaperMm, requireScale, type PaperMm } from './units';

/**
 * 三道尺寸线（plan5 §四 C1–C3 / D3 / M）。
 *
 * ## 尺寸链的来源：轴线端点，不是"轴网对象"
 *
 * core 里**没有"轴网"这个概念** —— `grep axisGrid` 在 `packages/core/src` 里零命中。
 * 这不是缺口：`PointEntity` 的字段注释（`entity.ts` 第 13 行）写着
 * 「真源是轴线两端点 + 厚度；轮廓与接头一律派生（spec 5.2）」，
 * 而 `WallEntity.startId` / `endId` 指向的正是那两个 point。
 * **所以"轴线端点"就是那层的全部 `PointEntity`**，而 `point` 没有 `projectId`
 * —— 取工程号要经 `storeyId → StoreyEntity → projectId`。
 *
 * ## 坐标约定：一条标注线 = 固定一轴 + 变化另一轴
 *
 * x 向的尺寸线，其标注线是**横**的（y 恒为该道的 cross 值）；
 * y 向的尺寸线，其标注线是**竖**的（x 恒为该道的 cross 值）。
 * 下面所有几何都走 `pt(direction, along, cross)` 这**一个**出口，
 * **不各处散写 `dir === 'x' ? … : …`** —— 第一版那样写时 y 向那一支的
 * 两端点被写成 0，竖线段长度成了 0，于是断线 / 符号 / 层 / 文字**四条判据
 * 全在 y 向上，一次就红四条**。**一个方向判断散在四处 = 四个错点。**
 */

/**
 * 道间距（**纸面**毫米，C2）。图面规范量，不随比例变。
 *
 * **三个数、三道、两个间隔** —— 这不是笔误，是规格里"7 / 5 / 5"三个数对应
 * 「细部↔轴线 7、轴线↔总尺寸 5、总尺寸↔图框 5」：第三个 5 是**总尺寸与图框
 * 之间的留白**，不是第四道。**2026-10-06 实测纠正**：第一版把它当"三个间隔"
 * 循环，于是三道变成了四道（读数 `[10,17,22,27]`），C2a 那格立刻红。
 */
const LANE_GAPS_MM = [7, 5] as const;

/** 溢出时加的那一道与第三道的间距（仍是 5，不重新分配—— C2b）。 */
const OVERFLOW_GAP_MM = 5;

/** 端点符号（45° 短斜线）的**总长**（纸面毫米，C3）。建筑制图惯例。 */
export const TICK_LENGTH_MM = 2;

/** 相交处断线的缺口长度（纸面毫米，C2d）。 */
const BREAK_MM = 2;

/** 文字纸面高（毫米，M2）。图面规范量。 */
const TEXT_HEIGHT_MM = 2.5;

/** 一张图的幅面（纸面 mm）。T6 的 `frame.ts` 会接上真图框。 */
const SHEET_MM = { width: 420, height: 297 } as const;

/** 图面留白（纸面 mm）。装订边 25 + 其余 10。 */
const MARGIN_MM = { left: 25, right: 10, top: 10, bottom: 10 } as const;

export interface DimensionOptions {
  readonly storeyId: EntityId;
  readonly title: string;
  readonly drafter: string;
  readonly sheetNo: string;
  /** 比例分母，默认 `SCALE_DENOMINATOR`。B1a：这是 S2 的入口，合法值不止 100。 */
  readonly scaleDenominator?: number;
}

/** 尺寸链：x 与 y 方向各若干条 `[fromMm, toMm]`（模型毫米，升序）。 */
export interface DimensionKeys {
  readonly x: readonly (readonly [number, number])[];
  readonly y: readonly (readonly [number, number])[];
}

/** 方向。`along` 是尺寸线自己延伸的方向，`cross` 是标注线摆在哪一侧。 */
type Direction = 'x' | 'y';

/** 标注线上的一个点。**全模块唯一的坐标出口**（理由见文件头那段）。 */
function pt(dir: Direction, along: PaperMm, cross: PaperMm): PaperVec2 {
  return dir === 'x' ? { x: along, y: cross } : { x: cross, y: along };
}

function storeyOf(doc: Document, storeyId: EntityId): EntityId {
  const s = doc.get(storeyId);
  if (!s || s.kind !== 'storey') {
    throw new RangeError(`楼层 ${storeyId} 不存在：尺寸线要按层收集轴线端点`);
  }
  return s.projectId;
}

/**
 * 收集尺寸链（C1 / C1b / C1c）。
 *
 * 三步，顺序不能换：
 * 1. 取该层全部 `PointEntity` 的 x / y **取值集合**（按取值去重，不是按点数）
 * 2. 只有一个取值的那个方向**不产链**（退化成点，标注不了）
 * 3. 相邻取值成链，升序
 *
 * 链数 = 取值数 − 1。**C1b「共用一条竖线的三片墙 ⇒ x 向零条」靠的是第 1 步
 * 那个去重** —— 按墙的条数算会得三条 x 尺寸。
 */
export function dimensionKeys(doc: Document, opts: DimensionOptions): DimensionKeys {
  // 取 projectId 必须走 storeyId → StoreyEntity；`PointEntity` 没有该字段。
  storeyOf(doc, opts.storeyId);
  const points = doc.byKind('point').filter((p) => p.storeyId === opts.storeyId);
  return {
    x: chainsOf(uniqueSorted(points.map((p) => p.x))),
    y: chainsOf(uniqueSorted(points.map((p) => p.y))),
  };
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * 一组**已去重且升序**的取值 → 相邻成链。链数 = 取值数 − 1。
 *
 * **这里刻意没有 `if (a === b) continue`**（2026-10-06 变异实测的结论）：
 * 那个 continue 看起来是 defensive，实际上它**掩盖了"忘了去重"这个缺陷**
 * —— 不去重时输入里的重复值相邻，continue 恰好把由此产生的**零长链
 * `[0,0]`** 滤掉，于是"去重"与"不去重"给出同一个结果，`C1d` 那格**打不死
 * 那个变异**（实测确认：删掉去重那刀，17 格仍全绿）。
 *
 * 所以本函数的契约收紧成"**输入必须已去重**"，去重那一步只有
 * `uniqueSorted` 一个产地（`dimensionKeys` 里）。真的传进未去重的输入时，
 * 它会产出零长链 —— 那是**看得见的错误**，比静默滤掉好。
 */
function chainsOf(sorted: readonly number[]): (readonly [number, number])[] {
  const out: (readonly [number, number])[] = [];
  for (let i = 1; i < sorted.length; i++) {
    out.push([sorted[i - 1]!, sorted[i]!]);
  }
  return out;
}

const DIMENSION_PEN: Pen = { ...PEN_BY_LINE_TYPE.dashed, layer: 'dimension' };

/**
 * 三道（或溢出时四道）的纸面 `cross` 坐标（C2a / C2b）。
 *
 * 间距固定 7 / 5（纸面 mm，**不随比例变**）。
 *
 * **溢出判定用的是尺寸线的长度方向，不是 cross 方向**（2026-10-06 实测纠正）：
 * 一条尺寸线画不下，是因为它**太长**（40000mm 的房子在 1:100 下是 400 纸面 mm，
 * 而 A3 可用宽只有 385），不是因为它的标注线摆得高。`cross` 坐标从留白边缘
 * 起排三道，永远不会"溢出图幅"。第一版拿 `cross > from + usable` 判溢出，
 * 于是 `C2b` 那格恒红而实现根本走不到加道那一支。
 *
 * 所以判据是：`addOverflowLane` 由**调用方**按尺寸线长度决定要不要传 true。
 */
function lanesFor(from: number, usable: number, addOverflowLane: boolean): PaperMm[] {
  const lanes: PaperMm[] = [from];
  for (const gap of LANE_GAPS_MM) {
    lanes.push(lanes[lanes.length - 1]! + gap);
  }
  // 第四道只在**确实画不下**时出现，且与第三道的间距是 5（不是重新分配）。
  if (addOverflowLane) lanes.push(lanes[lanes.length - 1]! + OVERFLOW_GAP_MM);
  // 兜底：连第四道都越过图幅就不排了（画到图幅外去不算数）。
  return lanes.filter((l) => l <= from + usable);
}

/**
 * 相交处断线（C2d）：`along` 方向上被另一方向的标注线穿过的位置各留一个
 * `BREAK_MM` 的缺口。返回要画的区间对（`lo→hi`）。
 */
function breakSegments(
  lo: number,
  hi: number,
  crossings: readonly number[],
): (readonly [number, number])[] {
  const cuts = crossings.filter((c) => c > lo + BREAK_MM && c < hi - BREAK_MM).sort((a, b) => a - b);
  if (cuts.length === 0) return [[lo, hi]];
  const out: (readonly [number, number])[] = [];
  let cursor = lo;
  for (const c of cuts) {
    out.push([cursor, c - BREAK_MM / 2]);
    cursor = c + BREAK_MM / 2;
  }
  out.push([cursor, hi]);
  return out;
}

/**
 * 端点斜线的线段本体：45°，**总长 `TICK_LENGTH_MM`**。
 *
 * 每分量的半量是 `L / (2·√2)`，不是 `L / 2` —— 45° 的两端点差在 x 与 y 上
 * 各是 `L / √2`，而这里取的是中点两侧的半量，所以还要再除 2。
 * （2026-10-06 实测纠正：写成 `L / 2` 时产出的线段长 `L·√2 ≈ 2.83`。）
 */
function tickLeg(at: PaperVec2, pen: Pen): PaperOp {
  const half = TICK_LENGTH_MM / (2 * Math.SQRT2);
  return line({ x: at.x - half, y: at.y - half }, { x: at.x + half, y: at.y + half }, pen);
}

/** 一条尺寸链 → 每一道的全部图元。 */
function renderChain(
  fromMm: number,
  toMm: number,
  dir: Direction,
  lanes: readonly PaperMm[],
  denominator: number,
  crossings: readonly number[],
): PaperOp[] {
  const ops: PaperOp[] = [];
  const lo = mmToPaperMm(Math.min(fromMm, toMm));
  const hi = mmToPaperMm(Math.max(fromMm, toMm));
  for (let lane = 0; lane < lanes.length; lane++) {
    const cross = lanes[lane]!;
    for (const [s, e] of breakSegments(lo, hi, crossings)) {
      ops.push(line(pt(dir, s, cross), pt(dir, e, cross), DIMENSION_PEN));
    }
    // 两端各一个 45° 短斜线（`tick` 给基点，线段本体也落成 `line`）
    for (const along of [lo, hi]) {
      const at = pt(dir, along, cross);
      ops.push(tick(at, DIMENSION_PEN));
      ops.push(tickLeg(at, DIMENSION_PEN));
    }
    // 数值文字**只在最外那道**标一次（三道各标同一个数是噪声）
    if (lane === 0) {
      const mid = (lo + hi) / 2;
      const value = (toMm - fromMm) / denominator;
      ops.push(text(pt(dir, mid, cross), TEXT_HEIGHT_MM, value.toFixed(2), DIMENSION_PEN));
    }
  }
  return ops;
}

/** 一组链在纸面上占的 along 长度（首尾端点之差）。 */
function paperSpan(chains: readonly (readonly [number, number])[]): PaperMm {
  const values = chains.flatMap(([p, q]) => [mmToPaperMm(p), mmToPaperMm(q)]);
  return Math.max(...values) - Math.min(...values);
}

/**
 * 一层的三道尺寸线 → 图元。
 *
 * 相交断线用**另一方向的链端点**当交点（C2d）：x 向的横标注线会在 y 向那些
 * 竖标注线的 x 位置被穿过，反之亦然。
 */
export function dimensionSheet(doc: Document, opts: DimensionOptions): Sheet {
  const denominator = requireScale(opts.scaleDenominator ?? 100);
  const keys = dimensionKeys(doc, opts);
  const ops: PaperOp[] = [];

  // 可用图幅（纸面 mm）。**溢出判定看的是尺寸线的 along 长度**（见 `lanesFor`）。
  const usableH = SHEET_MM.height - MARGIN_MM.top - MARGIN_MM.bottom;
  const usableW = SHEET_MM.width - MARGIN_MM.left - MARGIN_MM.right;
  const spanX = keys.x.length > 0 ? paperSpan(keys.x) : 0;
  const spanY = keys.y.length > 0 ? paperSpan(keys.y) : 0;

  const xLanes = lanesFor(MARGIN_MM.top, usableH, spanX > usableW);
  const yLanes = lanesFor(MARGIN_MM.left, usableW, spanY > usableH);

  const yEndpoints = keys.y.flatMap(([p, q]) => [mmToPaperMm(p), mmToPaperMm(q)]);
  const xEndpoints = keys.x.flatMap(([p, q]) => [mmToPaperMm(p), mmToPaperMm(q)]);

  for (const [fromMm, toMm] of keys.x) {
    ops.push(...renderChain(fromMm, toMm, 'x', xLanes, denominator, yEndpoints));
  }
  for (const [fromMm, toMm] of keys.y) {
    ops.push(...renderChain(fromMm, toMm, 'y', yLanes, denominator, xEndpoints));
  }

  return { widthMm: SHEET_MM.width, heightMm: SHEET_MM.height, ops };
}
