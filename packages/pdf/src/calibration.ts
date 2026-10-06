import type { PaperOp, Pen, Sheet } from '@dajia/drawing';
import { line, text } from '@dajia/drawing';

/**
 * 校准页（M1.5c）：一张「打印实测」用的刻度对照图。
 *
 * spec §11 验收之一是「A3 实体打印后拿尺量图框与标注」—— 这张页就是给那步用的：
 * 一根 100mm 横线 + 一根 100mm 竖线，每 5mm 一短刻度、每 10mm 一长刻度并标数，
 * 标题与说明。导出后打出来，用尺量两端，看实测与标称 100mm 差多少。
 *
 * 它只产出 `Sheet` IR（和平面图同一条流水线），字体在 `writeSheet(sheet, { font })` 时给。
 * 几何（两根 100mm 主线 + 刻度）可被独立 reader 读回逐字对账，所以「写对了吗」
 * 不靠肉眼，靠往返测试（见 `pdf.test.ts` 的 M1.5c 格）。
 */
const pen = (w: number, layer: Pen['layer'] = 'annotation'): Pen => ({
  layer,
  widthMm: w,
  lineType: 'solid',
});

export interface CalibrationOptions {
  /** 校准段长（mm）。默认 100。 */
  readonly scaleMm?: number;
  /** 页宽（mm）。默认 210（A4 竖）。 */
  readonly widthMm?: number;
  /** 页高（mm）。默认 297（A4 竖）。 */
  readonly heightMm?: number;
  /** 标尺原点 x（mm）。默认 40。 */
  readonly originX?: number;
  /** 标尺原点 y（mm）。默认 140。 */
  readonly originY?: number;
}

export function calibrationSheet(opts: CalibrationOptions = {}): Sheet {
  const scale = opts.scaleMm ?? 100;
  const w = opts.widthMm ?? 210;
  const h = opts.heightMm ?? 297;
  const ox = opts.originX ?? 40;
  const oy = opts.originY ?? 140;

  const ops: PaperOp[] = [];
  // 两根 100mm 主线（横 + 竖）
  ops.push(line({ x: ox, y: oy }, { x: ox + scale, y: oy }, pen(0.5)));
  ops.push(line({ x: ox, y: oy }, { x: ox, y: oy + scale }, pen(0.5)));

  // 横向刻度：每 5mm 一短刻、每 10mm 一长刻并标数
  for (let i = 0; i <= scale; i += 5) {
    const x = ox + i;
    const major = i % 10 === 0;
    ops.push(line({ x, y: oy }, { x, y: oy - (major ? 7 : 3.5) }, pen(0.25)));
    if (major) ops.push(text({ x, y: oy - 12 }, 2.5, String(i), pen(0.18)));
  }
  // 纵向刻度：同理，向左侧标数
  for (let i = 0; i <= scale; i += 5) {
    const y = oy + i;
    const major = i % 10 === 0;
    ops.push(line({ x: ox, y }, { x: ox - (major ? 7 : 3.5), y }, pen(0.25)));
    if (major) ops.push(text({ x: ox - 20, y }, 2.5, String(i), pen(0.18)));
  }

  // 标题 + 说明
  ops.push(text({ x: ox, y: 40 }, 4, `${scale}mm 校准刻度（打印实测）`, pen(0.25)));
  ops.push(text({ x: ox, y: 60 }, 3, '用尺量两端，实测与标称误差', pen(0.18)));

  return { widthMm: w, heightMm: h, ops };
}
