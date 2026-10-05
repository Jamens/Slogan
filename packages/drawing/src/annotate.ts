import { line, polygon, text, type PaperOp, type PaperVec2, type Pen } from './ir';
import type { PaperMm } from './units';

/**
 * 指北针与标高符号（plan5 §四 N1–N4）。
 *
 * ## 为什么这两个符号的尺寸与模型无关
 *
 * 它们是**图面规范量**，不是几何量（N4）。指北针画在图幅的哪个角、标高是
 * 0 还是 30000，都不改变它自己的纸面大小 —— 建筑制图里那根指北针永远
 * 那个粗细，标高三角永远是那个尺寸。
 *
 * 这一点值得说清为什么容易搞错：若把符号大小写成"随图幅缩放"，那么
 * A3 上的指北针和 A1 上的就不同样，而**同一种符号在不同幅面上长得不一样**
 * 是纸面上最刺眼的不一致之一。
 *
 * ## 为什么判据钉"形状特征"而不钉"长得像"
 *
 * N1 钉的是「有一个 45° 斜线段 + 一个闭合多边形」两件事 —— 那是**可算**的。
 * 钉"看起来像一个指北针"就得做像素比对，那是 S3 视觉回归的活（S1 明确
 * 不做预览层）。**判据要钉在能算的量上。**
 */

/** 指北针的纸面尺寸（毫米）。图面规范量，与图幅和模型都无关。 */
const ARROW_MM = { shaft: 24, head: 7, tail: 4 } as const;

/** 标高符号的纸面尺寸（毫米）。等腰直角三角，腰 = `leg`。 */
const ELEVATION_MM = { leg: 6, textHeight: 2.5 } as const;

const ANNOTATION_PEN: Pen = { layer: 'annotation', widthMm: 0.5, lineType: 'solid' };
const ANNOTATION_THIN: Pen = { layer: 'annotation', widthMm: 0.25, lineType: 'solid' };

/** 纸面上一个点。**本文件唯一的坐标出口**（照 T5 立的规矩）。 */
function p(x: PaperMm, y: PaperMm): PaperVec2 {
  return { x, y };
}

/**
 * 指北针（N1 / N3 / N4）。
 *
 * 形状：一条 45° 的针身 + 一个闭合的针头三角 + 一条短尾。
 * **判据钉的是"有一个 45° 斜线段"与"有一个闭合多边形"这两件事**，
 * 不是"看起来像"（理由见文件头）。
 */
export function northArrowOps(at: PaperVec2): PaperOp[] {
  const { shaft, head, tail } = ARROW_MM;
  // 针身：从左下到右上，45°（两个分量相等 ⇒ 判据里那条 |dx| == |dy| 成立）
  const a = p(at.x - shaft / 2, at.y + shaft / 2);
  const b = p(at.x + shaft / 2, at.y - shaft / 2);
  const needle = line(a, b, ANNOTATION_PEN);
  // 针头：b 处的一个闭合三角（面积 > 0，判据要验它不是退化多边形）
  const head3: PaperVec2[] = [
    b,
    p(b.x - head, b.y + head),
    p(b.x + head * 0.2, b.y + head),
  ];
  // 短尾：a 处往左下延伸一小段
  const tailLine = line(a, p(a.x - tail, a.y + tail), ANNOTATION_THIN);
  return [needle, polygon(head3, ANNOTATION_PEN, true), tailLine];
}

/**
 * 标高符号（N2 / N3 / N4b）。
 *
 * 形状：建筑制图惯例的**等腰直角三角**（腰垂直于基线，斜边朝上）。
 *
 * **符号大小与标高值无关**（N4b）—— 标高是**模型量**（它决定三角画在
 * 哪条线上），而三角本身是**图面规范量**。把两者混起来，"标高 30000"
 * 的那个三角会比"标高 0"的大一圈，而图面上看不出理由。
 */
export function elevationMarkOps(at: PaperVec2, _elevationMm: number): PaperOp[] {
  const { leg, textHeight } = ELEVATION_MM;
  // 等腰直角：底 = 腿，斜边 = 腿 × √2。判据据此验。
  const tri: PaperVec2[] = [p(at.x, at.y), p(at.x + leg, at.y), p(at.x, at.y - leg)];
  return [
    polygon(tri, ANNOTATION_THIN, false),
    // 标高值作为文字（数字本身是**图面信息**，但字号是图面规范量）
    text(p(at.x + leg + 1, at.y - leg / 2), textHeight, `±${(_elevationMm / 1000).toFixed(3)}`, ANNOTATION_THIN),
  ];
}
