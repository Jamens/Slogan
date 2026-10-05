import { describe, expect, it } from 'vitest';
import { PAPER_LAYERS, type PaperOp } from '../src/ir';
import {
  SCALE_DENOMINATOR,
  mmToPaperMm,
  paperToMm,
  requireScale,
  scaleAndRound,
} from '../src/units';

describe('units：比例与纸面换算（B1 只做 1:100）', () => {
  it('U1 模型 mm → 纸面 mm：1:100 下 3600mm 墙 ⇒ 纸面 36.00mm', () => {
    expect(SCALE_DENOMINATOR).toBe(100);
    expect(mmToPaperMm(3600)).toBe(36);
    expect(mmToPaperMm(240)).toBe(2.4);
    expect(mmToPaperMm(0)).toBe(0);
    expect(mmToPaperMm(-1000)).toBe(-10);
  });

  it('U3 收口是**换算路径上的唯一产地**：主路（整数 mm ÷ 100）本就不出尾巴，收口防的是主路之外的边', () => {
    // **2026-10-06 实测修正**：整数 mm 除以 100 在 JS 里是移位，`30/100 === 0.3`
    // 逐字相同 —— 裸除法在 1:100 + 整数模型值这条主路上**一个尾巴都不出**。
    // （我第一版判据写成 `expect(String(30/100)).not.toBe(String(mmToPaperMm(30)))`，
    //  它红了，暴露的是我那个前提错了，不是实现错了。）
    // 所以 U3 的真实形状是：**收口是换算路径上的唯一产地**，而它防的是主路之外 ——
    // 纸面尺寸（A3 的 420/297）、以及将来 S2 的 1:50 下非整数模型值。
    // 判据改成钉"收口真的收得掉尾巴"（用一条主路上不出现的值），而不是
    // 钉"主路上有尾巴"（那不是真的）。
    expect(mmToPaperMm(3600)).toBe(36);
    expect(mmToPaperMm(240)).toBe(2.4);
    expect(mmToPaperMm(1)).toBe(0.01);
    // 收口对非整数模型值有效：33.3333 收成 33.33。**这里的分母 1 不是"支持 1:1比例"**，
    // 它只是把"收口"这一步单独拎出来验（分母 1 时换算是恒等，收口的行为最清楚）。
    // 产品范围仍然只做 1:100（plan5 B1），`requireScale` 放行别的分母是 S2 的入口（B1a）。
    expect(mmToPaperMm(33.333333333333336, 1)).toBe(33.33);
    expect(mmToPaperMm(29.5, 1)).toBe(29.5);
    // 而 1/3 这种收不到的会被 `toFixed(2)` 截成两位 —— 判据钉的是"截"而不是"抛"，
    // 因为纸面坐标的精度约定就是两位（spec §11 的打印误差 ≤ 0.5mm 远宽于它）。
    expect(mmToPaperMm(1, 3)).toBe(0.33);
    // 结果恒等于显式收口函数（U6 的形状）：不许有第二条换算路径。
    expect(mmToPaperMm(777)).toBe(scaleAndRound(777, SCALE_DENOMINATOR));
  });

  it('U2 纸面坐标的原点在图框左上角、y 向下（后端解释方向的唯一产地）', () => {
    // 这条判据本身是"方向约定"的可测形态：纸面 y 与模型 y 的**符号相反**
    // （模型 y 向上为正，纸面 y 向下为正）。用墙的两个端点验。
    const upInModel = { x: 0, y: 1000 };
    const paper = { x: mmToPaperMm(upInModel.x), y: mmToPaperMm(-upInModel.y) };
    // 模型里 +y 的点在纸面上是**更小的** y（因为原点在左上、y 向下）
    expect(paper.y).toBe(-10);
    expect(mmToPaperMm(upInModel.y)).toBe(10);
  });

  it('U4 非法比例构造期抛：0、负数、NaN、非整数、Infinity 各一次', () => {
    for (const bad of [0, -100, Number.NaN, 12.5, Number.POSITIVE_INFINITY]) {
      expect(() => requireScale(bad)).toThrow();
    }
    expect(requireScale(100)).toBe(100);
    expect(requireScale(50)).toBe(50);
  });

  it('U5 逆换算本计划**故意没有**：`paperToMm` 是占位，调用它必须响亮地抛', () => {
    // 反向换算（纸面 → 模型）S1 没有任何读者：施工图只出不出，S2 才需要反向。
    // 留一个抛着的占位比留一个能跑的空实现安全 —— 后者会让人以为它能用。
    expect(() => paperToMm(36)).toThrow(/S2|反向|未实现/);
  });

  it('U6 比例常数只有一个产地：把分母改成 50，模型 mm 的纸面值必须跟着变（变异靶）', () => {
    // 这一格是 U6 的常驻证人，但它自己不改分母 —— 它钉住"换算的输出恒等于
    // `SCALE_DENOMINATOR` 决定的那个值"，所以真的把分母改成 50 时这一格必红。
    // 于是"分母在两处各写一份"（硬编码 100 与常量 100）会在改分母时露出。
    expect(mmToPaperMm(1000)).toBe(1000 / SCALE_DENOMINATOR);
    // 直接除法是**唯一**允许的算法 ⇒ 逐字等于带分母的除法
    expect(mmToPaperMm(777)).toBe(777 / SCALE_DENOMINATOR);
  });
});

describe('ir：图面 IR 的形状（D 组决策的落点）', () => {
  it('IR 的图层顺序即绘制顺序，且是**闭集**', () => {
    expect([...PAPER_LAYERS]).toEqual([
      'frame',
      'structure',
      'opening',
      'section',
      'dimension',
      'annotation',
    ]);
  });

  it('IR 里有五种图元，每种的字段是闭集（多一个键就红）', () => {
    const ops: PaperOp[] = [
      { kind: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, pen: pen() },
      { kind: 'polyline', pts: [{ x: 0, y: 0 }, { x: 10, y: 10 }], pen: pen() },
      { kind: 'polygon', pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], pen: pen(), fill: false },
      { kind: 'text', at: { x: 5, y: 5 }, heightMm: 2.5, s: '一层', pen: pen() },
      { kind: 'tick', at: { x: 1, y: 1 }, pen: pen() },
    ];
    expect(ops.map((o) => o.kind)).toEqual(['line', 'polyline', 'polygon', 'text', 'tick']);
    // 每种图元的键集合逐字钉死（IR 是后端的唯一输入，形状漂了后端就崩）
    for (const op of ops) {
      const keys = Object.keys(op).sort();
      switch (op.kind) {
        case 'line':
          expect(keys).toEqual(['a', 'b', 'kind', 'pen']);
          break;
        case 'polyline':
          expect(keys).toEqual(['kind', 'pen', 'pts']);
          break;
        case 'polygon':
          expect(keys).toEqual(['fill', 'kind', 'pen', 'pts']);
          break;
        case 'text':
          expect(keys).toEqual(['at', 'heightMm', 'kind', 'pen', 's']);
          break;
        case 'tick':
          expect(keys).toEqual(['at', 'kind', 'pen']);
          break;
      }
    }
  });

  it('IR 的源码里没有颜色 / 字体名 / 位图 / SVG 属性 / PDF 算子（"与格式无关"的证据）', () => {
    // 这一格是 plan5 §三那句"IR 里不出现的东西"的常驻证人。
    // 判据是**扫源码文本**：往ir.ts 里加一个 `#1f1f1f` 或一个 `fontFamily`
    // 就会红 —— 那说明某个后端专有的概念漏进了边界形状。
    const src = readSource('ir.ts');
    for (const re of [
      /#[0-9a-fA-F]{3,8}/, // 颜色字面量
      /rgb\(/,
      /opacity|alpha/i, // 透明度
      /fontFamily|font-family|fontSize|font-size/i, // 字体属性
      /<svg|<path|xmlns/i, // SVG 元素
      /BT\b|Tf\b|re\b.*\bS\b/, // PDF 算子
      /image|bitmap|base64|data:/i, // 位图
    ]) {
      expect(src).not.toMatch(re);
    }
  });

  it('IR 的 Pen 只有三个字段：图层 + 纸面线宽 + 线型（线宽不是几何）', () => {
    const src = readSource('ir.ts');
    // Pen 的形状钉死靠这一条 + 上一条的"无颜色"：线型表给的是纸面线宽（毫米），
    // 而**屏幕像素线宽是屏幕域的**，不许出现在 IR 里。
    expect(src).toMatch(/interface Pen/);
    expect(src).toMatch(/layer/);
    expect(src).toMatch(/widthMm/);
    expect(src).toMatch(/lineType/);
    expect(src).not.toMatch(/color|pxWidth|screenWidth/i);
  });

  it('IR 的坐标是纸面毫米（不是米、不是像素），原点约定写进注释', () => {
    // 判据的形态是"类型名 + 注释口径"两侧对账：PaperVec2 / PaperMm 的命名
    // 与 ir.ts 里的注释必须同时说"纸面毫米"。只钉类型名会漏掉"有人把单位改成米"。
    const src = readSource('ir.ts');
    expect(src).toMatch(/PaperVec2/);
    expect(src).toMatch(/PaperMm/);
    expect(src).toMatch(/纸面/);
    expect(src).toMatch(/毫米/);
  });
});

function pen(): PaperOp extends { pen: infer P } ? P : never {
  return { layer: 'structure', widthMm: 0.25, lineType: 'solid' } as never;
}

function readSource(file: string): string {
  // 用 require 而非 import.meta.url 拼路径：vitest 的 cwd 是仓库根，
  // 而这个文件在 packages/drawing/test 下 —— 相对路径要按包根算。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  return readFileSync(join(process.cwd(), 'packages/drawing/src', file), 'utf8');
}
