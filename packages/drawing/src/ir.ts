import type { PaperMm } from './units';

/**
 * 图面 IR —— 与格式无关的图面形状（plan5 §三）。
 *
 * **它为什么必须与格式无关**：S1 交付 PDF，S2 还要出 SVG，而后端之间
 * 绝不能互相转换（PDF 后端塞进 SVG 里就废了，SVG 后端塞进 PDF 里也一样）。
 * 所以上游只产出一份 IR，每个后端各自把它落到自己的世界去。
 * plan5 的「IR 里不出现的东西」那条判据就是这一节的守门人。
 *
 * **单位是纸面毫米**：见 `units.ts`。IR 里的坐标**已经乘过比例**了 ——
 * 上游（`plan.ts` / `dimensioning/`）负责那一步，下游后端只负责画。
 */

/** 纸面坐标（毫米）。原点是**图框左上角**，y 向下—— PDF 与 SVG 都是这个方向。 */
export interface PaperVec2 {
  readonly x: PaperMm;
  readonly y: PaperMm;
}

/**
 * 图层。**顺序即绘制顺序**（后画的压在上面）—— 这一列的值同时是
 * `plan.ts` / `frame.ts` / `annotate.ts` 三处产出图元时的分层依据，
 * 而它们的层单调不减由 plan5 的 P7 那格对账。
 *
 * 与 `scene-2d` 的 `DRAW_LAYERS`（`'structure' | 'opening' | 'annotation'`）
 * **语义平行但不共用枚举**（plan5 决策 A1/A2）：那一族是屏幕语义（配像素线宽
 * 与颜色），这一族是纸面语义（配毫米线宽）。两边各留一格做映射对账，
 * 不许"看着重复就顺手统一"—— 统一会把"线宽"这个词污染成两个意思。
 */
export const PAPER_LAYERS = [
  'frame',
  'structure',
  'opening',
  'section',
  'dimension',
  'annotation',
] as const;
export type PaperLayer = (typeof PAPER_LAYERS)[number];

/**
 * 纸面线型。四种，与 spec §7 的线型表对应。
 * `center`（中心线/轴线）在屏幕上与轴线同一族，映射见 `linetypes.ts`。
 */
export type PaperLineType = 'solid' | 'dashed' | 'dash-dot' | 'center';

/**
 * 画笔：**线宽是纸面毫米，不是屏幕像素**（plan5 决策 A3）。
 *
 * 为什么线宽是"图面规范量"而不是"几何量"：spec §7 说屏幕与交付物共用同一份
 * **几何**，线宽不在其中—— 同一堵墙在屏幕上要 1px、在 A3 上要 0.35mm 纸面，
 * 它随图幅走而不是随模型走。所以线宽挂在 `Pen` 上，而屏幕侧忽略它
 * （`scene-2d` 那边读的是自己的 `Pen.widthPx`）。
 */
export interface Pen {
  readonly layer: PaperLayer;
  /** 纸面线宽（毫米）。合法值只有五个：0.18 / 0.25 / 0.35 / 0.5 / 0.7（见 `linetypes.ts`）。 */
  readonly widthMm: PaperMm;
  readonly lineType: PaperLineType;
}

export type PaperOp =
  | { readonly kind: 'line'; readonly a: PaperVec2; readonly b: PaperVec2; readonly pen: Pen }
  | { readonly kind: 'polyline'; readonly pts: readonly PaperVec2[]; readonly pen: Pen }
  | {
      readonly kind: 'polygon';
      readonly pts: readonly PaperVec2[];
      readonly pen: Pen;
      /** 平面图里墙体不填充（建筑制图惯例），但剖到的构件若将来要填充就在这里开。 */
      readonly fill: boolean;
    }
  /**
   * 文字。**只给基点与纸面字高**，不给字体名、不给对齐方式—— 后端按各自的
   * 约定解释基点（PDF 的 `Td` 与 SVG 的 `text-anchor` 语义不同）。
   * 字高固定 2.5 / 3.5 纸面毫米（spec §7），它是图面规范量。
   */
  | {
      readonly kind: 'text';
      readonly at: PaperVec2;
      readonly heightMm: PaperMm;
      readonly s: string;
      readonly pen: Pen;
    }
  /**
   * 尺寸端点的 45° 短斜线（plan5 决策 C3，固定纸面 2mm）。
   *
   * 为什么它是**独立图元**而不是"用 `line` 也画得出来"：端点符号是建筑制图的
   * 规范量（固定纸面长度、恒45°），让后端自己画就等于把规范量散到每个后端里
   * 各画一次。IR 给成一个图元，后端只负责落它。
   */
  | { readonly kind: 'tick'; readonly at: PaperVec2; readonly pen: Pen };

/** 构造助手：把"图面里的一笔"包成 `PaperOp` 的那些小函数。 */

export function line(a: PaperVec2, b: PaperVec2, pen: Pen): PaperOp {
  return { kind: 'line', a, b, pen };
}

export function polyline(pts: readonly PaperVec2[], pen: Pen): PaperOp {
  return { kind: 'polyline', pts, pen };
}

export function polygon(pts: readonly PaperVec2[], pen: Pen, fill: boolean): PaperOp {
  return { kind: 'polygon', pts, pen, fill };
}

export function text(at: PaperVec2, heightMm: PaperMm, s: string, pen: Pen): PaperOp {
  return { kind: 'text', at, heightMm, s, pen };
}

export function tick(at: PaperVec2, pen: Pen): PaperOp {
  return { kind: 'tick', at, pen };
}

/** 一张图：图元列表 + 纸面尺寸（mm）。后端从这里知道画布多大、原点在哪。 */
export interface Sheet {
  readonly widthMm: PaperMm;
  readonly heightMm: PaperMm;
  readonly ops: readonly PaperOp[];
}
