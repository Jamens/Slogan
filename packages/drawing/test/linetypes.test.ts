import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { line, type PaperLineType } from '../src/ir';
import {
  DASH_PATTERN_MM,
  LINE_WIDTHS_MM,
  PEN_BY_LINE_TYPE,
  THINNEST,
  THICKEST,
  defaultWidthOf,
  toScreenLineType,
} from '../src/linetypes';

describe('线型表：五档线宽与四线型（A1/A2 的纸面侧）', () => {
  it('L1 五档线宽逐字，且每种线型的默认档唯一', () => {
    expect([...LINE_WIDTHS_MM]).toEqual([0.18, 0.25, 0.35, 0.5, 0.7]);
    expect(THINNEST).toBe(0.18);
    expect(THICKEST).toBe(0.7);
    // 建筑制图的语义档位（spec §7 的线型表）：细部最细、轴线居中、剖断线最粗。
    expect(defaultWidthOf('solid')).toBe(0.5); // 可见轮廓：图上最常见的墙线
    expect(defaultWidthOf('dashed')).toBe(0.25); // 不可见轮廓
    expect(defaultWidthOf('dash-dot')).toBe(0.25); // 门窗开启线一类
    expect(defaultWidthOf('center')).toBe(0.18); // 轴线：最细的一档
    // 默认档必须**都在五档之内**（不在的话`PEN_BY_LINE_TYPE` 就是一张自己都不合法的表）
    for (const t of ['solid', 'dashed', 'dash-dot', 'center'] as const) {
      expect(LINE_WIDTHS_MM).toContain(defaultWidthOf(t));
    }
  });

  it('L2 虚线节奏是纸面量：不随比例变（它是图面规范量，不是模型量）', () => {
    // 建筑制图的虚线长度是**图面规范**：A3 上那条虚线永远是那么长，不因为
    // 画的房子大就变长。所以节奏是纸面毫米，不带比例。
    expect(DASH_PATTERN_MM.dashed).toEqual({ dash: 3, gap: 1.5 });
    expect(DASH_PATTERN_MM['dash-dot']).toEqual({ dash: 4, gap: 1, dot: 0.5, dotGap: 1 });
    expect(DASH_PATTERN_MM.center).toEqual({ dash: 6, gap: 1, dot: 0.5, dotGap: 1 });
    // solid 没有节奏 —— 它的"节奏"就是不间断，字段是 undefined 而不是 { dash: 1e9 }
    expect(DASH_PATTERN_MM.solid).toBeUndefined();
    // 判据的形状是"节奏表里没有任何比例参数"：给节奏表加一个 scale 键即红
    for (const key of Object.keys(DASH_PATTERN_MM)) {
      expect(Object.keys(DASH_PATTERN_MM[key as PaperLineType] ?? {})).not.toContain('scale');
    }
  });

  it('L3 四条映射逐字：center 映到 dash-dot（屏幕侧与轴线同一族）', () => {
    expect(toScreenLineType('solid')).toBe('solid');
    expect(toScreenLineType('dashed')).toBe('dashed');
    expect(toScreenLineType('dash-dot')).toBe('dash-dot');
    // **这一格是 L5 的靶**：把 center 映成 solid（看着"更清楚"）时本格必红。
    // 为什么是 dash-dot 而不是 solid：屏幕上的中心线与轴线同族（都是长划+短划），
    // 屏幕没有"点划"的独立表现力，solid 会让轴线看起来与墙线同族。
    expect(toScreenLineType('center')).toBe('dash-dot');
  });

  it('L4 映射表是闭集：纸面四型全部有落点，且落点都在屏幕三型之内', () => {
    const paper: readonly PaperLineType[] = ['solid', 'dashed', 'dash-dot', 'center'];
    for (const t of paper) {
      const screen = toScreenLineType(t);
      expect(['solid', 'dashed', 'dash-dot']).toContain(screen);
    }
    // 屏幕三型逐字（`scene-2d` 的 LineType 现在的三个字面量）——
    // 映射表的**值域**若多一个第四个，屏幕侧就认不出来了。
    expect([...new Set(paper.map(toScreenLineType))].sort()).toEqual(['dash-dot', 'dashed', 'solid']);
  });

  it('L6 线型表里没有颜色：源码扫不到任何颜色字面量 / rgba / 颜色相关的键', () => {
    // A1/A2 的边界在代码侧的落点：纸面域不认颜色。颜色是屏幕域的。
    // 往 `linetypes.ts` 里加一个 `color: '#1f1f1f'` 时本格必红。
    const src = readFileSync(join(process.cwd(), 'packages/drawing/src/linetypes.ts'), 'utf8');
    for (const re of [/#[0-9a-fA-F]{3,8}/, /rgb\(/, /rgba\(/, /\bcolor\b/, /\bink\b/i, /\brgba?\b/]) {
      expect(src).not.toMatch(re);
    }
  });

  it('L7 非法线宽抛：0.3 不在五档里（线宽只有五个合法值，不是任意正数）', () => {
    // 这一条是 A3 的"线宽是图面规范量"的兑现：线宽**不是**自由正数。
    // 放行 0.3 会让同一个工程出两种观感相近的墙线，而没人能查出是哪一种。
    for (const bad of [0.3, 1, 0, -0.5, Number.NaN, 0.700001]) {
      expect(() => defaultWidthOf('solid', bad)).toThrow();
    }
    // 五档逐个放行
    for (const good of [0.18, 0.25, 0.35, 0.5, 0.7]) {
      expect(() => defaultWidthOf('solid', good)).not.toThrow();
    }
  });

  it('L8 同 layer 不同 widthMm 产出两条不同的 op（Pen 的三个字段一起决定渲染）', () => {
    const a = line({ x: 0, y: 0 }, { x: 10, y: 0 }, {
      layer: 'structure',
      widthMm: 0.25,
      lineType: 'solid',
    });
    const b = line({ x: 0, y: 0 }, { x: 10, y: 0 }, {
      layer: 'structure',
      widthMm: 0.7,
      lineType: 'solid',
    });
    // 坐标与图层逐字相同，只有线宽不同
    expect(a).not.toEqual(b);
    expect((a as { pen: { widthMm: number } }).pen.widthMm).toBe(0.25);
    expect((b as { pen: { widthMm: number } }).pen.widthMm).toBe(0.7);
    // 且 PEN_BY_LINE_TYPE 里的四张Pen 各有合法的层与线宽
    for (const t of ['solid', 'dashed', 'dash-dot', 'center'] as const) {
      const pen = PEN_BY_LINE_TYPE[t];
      expect(pen.lineType).toBe(t);
      expect(LINE_WIDTHS_MM).toContain(pen.widthMm);
    }
  });
});
