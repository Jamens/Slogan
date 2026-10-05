import type { PaperLineType, Pen } from './ir';

/**
 * 纸面线型表（plan5 决策 A1/A2 的纸面侧）。
 *
 * ## 为什么它与 `scene-2d` 的那一族并存而不是统一
 *
 * `packages/scene-2d/src/drawlist.ts` 里已经有一份线型（三个字面量，配
 * 像素线宽与一个屏幕专用的墨色）。这一份是纸面语义（毫米线宽 + 虚线节奏）。
 * **两者不是同一族东西**：屏幕那一族回答"在 1:1 缩放的画布上画多粗"，
 * 这一族回答"打印到 A3 上画多粗、虚线多长"。硬统一的话，"线宽"这个词会
 * 同时指两个意思，于是每次改图幅都要去查哪一处在管这件事。
 *
 * 两族之间**只有一处**联系：`toScreenLineType()`（见下）。它把纸面线型
 * 映到屏幕线型，仅此而已。**不要在没有读这段注释的情况下"顺手统一"两族** ——
 * 那会把A3 的纸面规范量污染成屏幕的实现细节。
 */

/**
 * 五档纸面线宽（毫米，L1）。这是**图面规范量**：建筑制图规范里的那几档，
 * 不是"随便一个正数都行"。
 *
 * 为什么只有五档：施工图靠线宽表达语义（细部 / 轮廓 / 剖断 / 轴线），
 * 线宽的档位数量就是语义的数量。放行任意正数等于允许同一份图出现两种
 * 观感相近的墙线，而没有人能查出是哪一种 —— 所以 `defaultWidthOf` 拒绝
 * 不在表内的值（L7）。
 */
export const LINE_WIDTHS_MM = [0.18, 0.25, 0.35, 0.5, 0.7] as const;
export type PaperLineWidth = (typeof LINE_WIDTHS_MM)[number];

export const THINNEST: PaperLineWidth = 0.18;
export const THICKEST: PaperLineWidth = 0.7;

/**
 * 虚线节奏（纸面毫米，L2）。
 *
 * **它不随比例变** —— 这是本文件最容易被人改错的一处。建筑制图里虚线
 * 长度是**图面规范**：A3 上那条虚线永远是那么长，不因为画的房子大就变长。
 * 若把它写成"模型毫米再乘比例"，同一张 A3 上不同大小的构件会画出不同长度的
 * 虚线，看起来像两种线型。
 *
 * 字段命名对齐 PDF 后端的算子习惯（`dash` / `gap` / `dot` / `dotGap`），
 * SVG 后端直接照抄即可。`solid` 没有节奏 —— 它的"节奏"是不间断，所以
 * 值是 `undefined` 而不是 `{ dash: 1e9 }`：后者会让后端多走一条分支。
 */
export const DASH_PATTERN_MM: {
  readonly [T in PaperLineType]?: { readonly dash: number; readonly gap: number; readonly dot?: number; readonly dotGap?: number };
} = {
  solid: undefined,
  dashed: { dash: 3, gap: 1.5 },
  'dash-dot': { dash: 4, gap: 1, dot: 0.5, dotGap: 1 },
  center: { dash: 6, gap: 1, dot: 0.5, dotGap: 1 },
};

/**
 * 各线型的默认线宽（L1）。**唯一产地** —— 别的文件不许写"轴线用 0.18"这种字面量。
 *
 * 档位的语义（spec §7 线型表）：
 * - `solid` 0.5：可见轮廓。墙线在图上是最常见的粗实线。
 * - `dashed` 0.25：不可见轮廓（在平面图里是"被遮挡但存在的构件"）。
 * - `dash-dot` 0.25：门窗开启线一类。
 * - `center` 0.18：轴线，最细的一档 —— 建筑制图惯例，轴线要能穿过墙线被认出来。
 */
const DEFAULT_WIDTH: { readonly [T in PaperLineType]: PaperLineWidth } = {
  solid: 0.5,
  dashed: 0.25,
  'dash-dot': 0.25,
  center: 0.18,
};

/**
 * 取线型的默认线宽，或校验一个**显式给定**的线宽是否在五档之内。
 *
 * 两参形态是 T4 之后那些"线宽要按图面规范算出来而不是随手写"的调用点的入口
 * （比如 `frame.ts` 的图框用 `THICKEST`）。第二个参给了就**必须合法**，
 * 不在表内即抛 —— 这条是 L7 的常驻证人。
 */
export function defaultWidthOf(lineType: PaperLineType, explicit?: number): PaperLineWidth {
  if (explicit !== undefined) {
    if (!(LINE_WIDTHS_MM as readonly number[]).includes(explicit)) {
      throw new RangeError(
        `纸面线宽必须是 ${LINE_WIDTHS_MM.join(' / ')} 之一（毫米），收到 ${String(explicit)}：` +
          `线宽是图面规范量而不是自由正数 —— 放行表外的值等于让同一份图出现两种观感相近的线`,
      );
    }
    return explicit as PaperLineWidth;
  }
  return DEFAULT_WIDTH[lineType];
}

/**
 * 四张默认 `Pen`（L8 的对账物）。给 `lineType` 一个默认值省掉每个调用点的
 * 三个字段重复，但**不许反过来**用它给已存在的笔改宽度。
 */
export const PEN_BY_LINE_TYPE: { readonly [T in PaperLineType]: Pen } = {
  solid: { layer: 'structure', widthMm: DEFAULT_WIDTH.solid, lineType: 'solid' },
  dashed: { layer: 'structure', widthMm: DEFAULT_WIDTH.dashed, lineType: 'dashed' },
  'dash-dot': { layer: 'opening', widthMm: DEFAULT_WIDTH['dash-dot'], lineType: 'dash-dot' },
  center: { layer: 'structure', widthMm: DEFAULT_WIDTH.center, lineType: 'center' },
};

/**
 * 纸面线型 → 屏幕线型（L3/L4）。**这是两族之间唯一的联系。**
 *
 * 值域是 `scene-2d` 现在的三个字面量，逐字写成字符串而**不 import 它**
 * —— 依赖方向上 `drawing` 只许依赖 `core`（`ALLOWED_DEPS`），而
 * `verbatimModuleSyntax` 会把一个纯类型 import 擦干净，所以就算 import
 * 它的类型也过不了 lint:deps 的运行时检查。写字面量 + 这一格对账是
 * 达成"共用一份规则"又不违反依赖方向的最便宜形状。
 *
 * `center → dash-dot` 而不是 `center → solid`：屏幕上的中心线与轴线同族
 * （长划 + 短划），而 `solid` 会让轴线看起来与墙线同族，读者就分不出
 * "这是轴"还是"这是墙"。**这一条是 L5 的靶** —— 有人觉得 solid 更清楚
 * 而改它时，本函数下方那格必红。
 */
export function toScreenLineType(lineType: PaperLineType): 'solid' | 'dashed' | 'dash-dot' {
  switch (lineType) {
    case 'solid':
      return 'solid';
    case 'dashed':
      return 'dashed';
    case 'dash-dot':
    case 'center':
      return 'dash-dot';
  }
}
