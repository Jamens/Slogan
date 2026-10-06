import { type Document } from '@dajia/core';
import { planSheet, type PlanOptions } from '../plan';
import { frameSheet, type TitleBlock } from '../frame';
import { polyline, type PaperOp, type PaperVec2, type Sheet } from '../ir';

/**
 * 剖切轮廓（plan5 T7，D1/D2/D3）。
 *
 * 入参 `clipLine` 是**视图状态**（D1）：它只出现在本模块的入参里，
 * **不进 `Document`**（X1/X2 的证据：调用前后 `doc.canonical()` 逐字相同），
 * 也**不进 `PaperOp`**（我们从不把它画成一条线，只把它当裁剪刀）。
 *
 * 产出是一张**独立图幅**（D2）：自带图框，不是往平面图那个 IR 里加层；
 * 图里只画被剖到的构件的**轮廓线**（D3，X5：不填充）。
 */

/** 剖切线：纸面 mm 的两个端点。视图状态，不入真源。 */
export interface ClipLine {
  readonly a: PaperVec2;
  readonly b: PaperVec2;
}

/** 剖切轮廓的画笔：section 层、实线、0.5mm（图面规范量，见 linetypes 五档）。 */
const SECTION_PEN = { layer: 'section', widthMm: 0.5, lineType: 'solid' } as const;

/**
 * 剖切线的一侧判定（X4）。
 *
 * 方向 a→b，点 p 的叉积 `cross = (b.x-a.x)*(p.y-a.y) - (b.y-a.y)*(p.x-a.x)`：
 * - `cross > 0` ⇒ 左侧
 * - `cross < 0` ⇒ 右侧（法向右侧，约定保留侧）
 * - `≈ 0` ⇒ 在线上
 *
 * 约定保留**右侧**（含线上，EPS 容差）—— 剖切线穿过构件中心时构件落在
 * 线上，应作为剖切断保留（D3 的"只轮廓"需要它画出来）。EPS 同时兜住浮点：
 * 薄墙被剖切线穿过时重心可能落到线另一侧一个极小浮点上，不能因此丢段。
 */
const SIDE_EPS = 1e-6;
function sideOf(p: PaperVec2, a: PaperVec2, b: PaperVec2): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}
function retainRight(centroid: PaperVec2, a: PaperVec2, b: PaperVec2): boolean {
  return sideOf(centroid, a, b) <= SIDE_EPS;
}

/**
 * 线段 a-b 与一个闭合多边形求交，返回剖切断的两个端点（纸面 mm）。
 *
 * 对多边形每条边求与 a-b 的交点（参数 t∈[0,1] 落在段内、u∈[0,1] 落在边上）。
 * 凸多边形被一条线段穿过恰得两个交点 ⇒ 取 t 最小/最大者为剖切断两端；
 * 非凸（如 L 形板）取首尾是近似（S1 只出矩形板，够用，见 plan5 §十 D3）。
 * 交点不足两个（不相交 / 仅相切）⇒ 不产段。
 */
function cutSegment(
  a: PaperVec2,
  b: PaperVec2,
  poly: readonly PaperVec2[],
): [PaperVec2, PaperVec2] | null {
  if (poly.length < 2) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const hits: { t: number; p: PaperVec2 }[] = [];
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i]!;
    const d = poly[(i + 1) % poly.length]!;
    const ex = d.x - c.x;
    const ey = d.y - c.y;
    const denom = dx * ey - dy * ex;
    if (denom === 0) continue; // 平行，无单一交点
    const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / denom;
    const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / denom;
    if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) {
      const tt = t < 0 ? 0 : t > 1 ? 1 : t;
      hits.push({ t: tt, p: { x: a.x + dx * tt, y: a.y + dy * tt } });
    }
  }
  if (hits.length < 2) return null;
  hits.sort((h1, h2) => h1.t - h2.t);
  const first = hits[0]!;
  const last = hits[hits.length - 1]!;
  if (Math.abs(first.t - last.t) < 1e-9) return null; // 退化（切线，无长度）
  return [first.p, last.p];
}

function centroidOf(poly: readonly PaperVec2[]): PaperVec2 {
  let sx = 0;
  let sy = 0;
  for (const p of poly) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / poly.length, y: sy / poly.length };
}

function isSolid(op: PaperOp): op is Extract<PaperOp, { kind: 'polygon' }> {
  return op.kind === 'polygon';
}

/**
 * 一层 → 剖切轮廓（独立图幅，D2）。
 *
 * 取 `planSheet` 产出的墙/柱/板纸面多边形（X3），对每个求与剖切线的交段；
 * 仅保留剖切线**法向右侧**（X4）构件的剖切断，作为 `polyline` 轮廓线输出，
 * **不填充**（D3 / X5）。楼板在平面图里是轮廓线（X6），剖到时同样只画线。
 *
 * **不重算几何**：交段完全来自 plan 的纸面多边形与剖切线，本模块一个模型坐标都不碰
 * （与 plan.ts 的 P1/P3 同一纪律：几何的唯一产地在 core，drawing 只读结果）。
 */
export function clipSheet(doc: Document, opts: PlanOptions, clipLine: ClipLine, date?: string): Sheet {
  const plan = planSheet(doc, opts);
  const solids = plan.ops.filter(isSolid);
  const cutOps: PaperOp[] = [];
  for (const solid of solids) {
    const seg = cutSegment(clipLine.a, clipLine.b, solid.pts);
    if (!seg) continue;
    // X4：只保留剖切线右侧的构件（线上视为保留，见 `sideOf` 注释）。
    if (retainRight(centroidOf(solid.pts), clipLine.a, clipLine.b)) {
      cutOps.push(polyline(seg, SECTION_PEN));
    }
  }
  // X8：独立图幅（自带图框），不是往平面图 IR 里加层。
  const frame = frameSheet(sectionTitle(opts, date));
  return { ...frame, ops: [...frame.ops, ...cutOps] };
}

/** 剖切轮廓图幅的标题栏：五格都是入参（F3c），不许在这里取 `new Date()`。 */
function sectionTitle(opts: PlanOptions, date: string | undefined): TitleBlock {
  return {
    title: `${opts.title} 剖切轮廓`,
    scaleText: '1:100',
    date: date ?? '', // 入参，不是 new Date()
    drafter: opts.drafter,
    sheetNo: opts.sheetNo,
  };
}
