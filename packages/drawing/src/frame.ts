import { line, text, type PaperOp, type PaperVec2, type Pen, type Sheet } from './ir';
import { THICKEST } from './linetypes';
import type { PaperMm } from './units';

/**
 * A3 横式图框 + 标题栏（plan5 §四 F1–F6）。
 *
 * ## 为什么幅面与边距都是常量而不是参数
 *
 * B2 定了 S1 只做 A3 横式（A1/A2/竖式是 S2「多图纸成册」的事）。把它们做成
 * 参数看起来更灵活，但那会让**每一个下游**（尺寸线的分道起点、剖切轮廓的
 * 裁剪、导出出口的页数）都多一个要传递的量，而 S1 只有一个取值。
 * **一个只有一种取值的参数不是参数，是第二份真源。**
 *
 * ## 坐标约定：只有两个出口
 *
 * 照 T5 立的规矩（"方向判断收成单一出口"），本文件里凡是算坐标的地方
 * 都走 `p(x, y)` / `box(...)` 这两个助手，不散写算式。
 */

/** A3 横式的纸面尺寸（毫米，F1 —— **硬门**，改成 400 就不是 A3 了）。 */
export const A3_LANDSCAPE_MM = { width: 420, height: 297 } as const;

/**
 * S1 支持的幅面表（B2）。**这张表是幅面的唯一产地** —— 键名逐字给判据用。
 * 加 A1/A2/竖式是 S2 的事，那时这张表自然长大。
 */
export const SHEETS = {
  'a3-landscape': A3_LANDSCAPE_MM,
} as const;

/** 装订边（纸面毫米，F2）。建筑制图惯例：图纸左边要装订，留宽一点。 */
export const BINDING_MARGIN_MM = 25;

/** 四边留白（纸面毫米，F2）。**有具体值，不是 0 也不是"自动"** ——
 *  "自动"意味着后端各自决定，而那样两张图的留白会不一样。 */
export const MARGINS_MM = {
  left: BINDING_MARGIN_MM,
  right: 10,
  top: 10,
  bottom: 10,
} as const;

/** 标题栏的尺寸（纸面毫米）。建筑制图惯例：180×56（横向）。 */
const TITLE_BLOCK_MM = { width: 180, height: 56 } as const;

/** 标题栏字段（五格，F3）。**闭集** —— 少一格读者查不到东西，多一格是自创格式。 */
export interface TitleBlock {
  readonly title: string;
  readonly scaleText: string;
  readonly date: string;
  readonly drafter: string;
  readonly sheetNo: string;
}

const FRAME_PEN: Pen = { layer: 'frame', widthMm: THICKEST, lineType: 'solid' };
const TITLE_LINE_PEN: Pen = { layer: 'frame', widthMm: 0.25, lineType: 'solid' };

/** 纸面上一个点。**本文件唯一的坐标出口**（理由见文件头）。 */
function p(x: PaperMm, y: PaperMm): PaperVec2 {
  return { x, y };
}

/** 一个矩形的四条边（顺序固定：左上 → 右上 → 右下 → 左下）。 */
function box(
  left: PaperMm,
  top: PaperMm,
  right: PaperMm,
  bottom: PaperMm,
  pen: Pen,
): PaperOp[] {
  return [
    line(p(left, top), p(right, top), pen),
    line(p(right, top), p(right, bottom), pen),
    line(p(right, bottom), p(left, bottom), pen),
    line(p(left, bottom), p(left, top), pen),
  ];
}

/** 图框的四条边（F1 / F2 / F5）。幅面 − 留白。 */
export function frameOps(): PaperOp[] {
  return box(
    MARGINS_MM.left,
    MARGINS_MM.top,
    A3_LANDSCAPE_MM.width - MARGINS_MM.right,
    A3_LANDSCAPE_MM.height - MARGINS_MM.bottom,
    FRAME_PEN,
  );
}

/** 标题栏的文字纸面高（毫米）。图面规范量。 */
const TITLE_TEXT_MM = 3.5;

/** 标题栏格子的内边距（纸面毫米）。 */
const TITLE_PAD_MM = 3;

/**
 * 标题栏（F3 / F4）：一个矩形 + 三条分隔线 + 五个字段的文字。
 *
 * **位置在图框的右下角**（F4，贴边）—— 建筑制图惯例：标题栏永远在右下，
 * 折图时它被折到最外侧。
 *
 * **五个字段都是入参**（F3c）：日期与设计人**不许**在这里取 `new Date()` /
 * `os.userInfo()` —— 那样同doc 连跑两次会产出不同字节，T8 的 E2（字节稳定）
 * 就会红。同一层入口处每个字段都有默认值的做法见 T8 的 IPCHandlers。
 */
export function titleBlockOps(fields: TitleBlock): PaperOp[] {
  const right = A3_LANDSCAPE_MM.width - MARGINS_MM.right;
  const bottom = A3_LANDSCAPE_MM.height - MARGINS_MM.bottom;
  const left = right - TITLE_BLOCK_MM.width;
  const top = bottom - TITLE_BLOCK_MM.height;

  const ops: PaperOp[] = [
    ...box(left, top, right, bottom, FRAME_PEN),
    // 三条横分隔线 ⇒ 五个格子
    line(p(left, top + TITLE_BLOCK_MM.height / 5), p(right, top + TITLE_BLOCK_MM.height / 5), TITLE_LINE_PEN),
    line(p(left, top + (TITLE_BLOCK_MM.height * 2) / 5), p(right, top + (TITLE_BLOCK_MM.height * 2) / 5), TITLE_LINE_PEN),
    line(p(left, top + (TITLE_BLOCK_MM.height * 3) / 5), p(right, top + (TITLE_BLOCK_MM.height * 3) / 5), TITLE_LINE_PEN),
  ];

  // 五个字段逐字进 IR（F3），每格一个
  const rowHeight = TITLE_BLOCK_MM.height / 5;
  const labels: readonly string[] = [
    fields.sheetNo,
    fields.title,
    fields.scaleText,
    fields.drafter,
    fields.date,
  ];
  for (let i = 0; i < labels.length; i++) {
    ops.push(
      text(
        p(left + TITLE_PAD_MM, top + rowHeight * (i + 0.7)),
        TITLE_TEXT_MM,
        labels[i]!,
        TITLE_LINE_PEN,
      ),
    );
  }
  return ops;
}

/** 一张完整的图：图框 + 标题栏（不含内容层）。 */
export function frameSheet(fields: TitleBlock): Sheet {
  return {
    widthMm: A3_LANDSCAPE_MM.width,
    heightMm: A3_LANDSCAPE_MM.height,
    ops: [...frameOps(), ...titleBlockOps(fields)],
  };
}
