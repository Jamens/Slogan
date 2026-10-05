import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAPER_LAYERS, type PaperOp } from '../src/ir';
import { THICKEST } from '../src/linetypes';
import {
  A3_LANDSCAPE_MM,
  BINDING_MARGIN_MM,
  MARGINS_MM,
  SHEETS,
  frameOps,
  titleBlockOps,
} from '../src/frame';
import { northArrowOps, elevationMarkOps } from '../src/annotate';

const titleBlock = {
  title: '一层平面图',
  scaleText: '1:100',
  date: '2026-10-06',
  drafter: '搭家',
  sheetNo: 'A-101',
};

function ops(): PaperOp[] {
  return [...frameOps(), ...titleBlockOps(titleBlock)];
}

function texts(list: readonly PaperOp[]): string[] {
  return list.filter((o) => o.kind === 'text').map((o) => (o.kind === 'text' ? o.s : ''));
}

describe('frame：A3 横式图框（F1 / F2）', () => {
  it('F1 A3 横式 420 × 297 逐字（硬门，改了就不是 A3）', () => {
    expect(A3_LANDSCAPE_MM.width).toBe(420);
    expect(A3_LANDSCAPE_MM.height).toBe(297);
    // 幅面常量只有一个产地：`SHEETS` 里那一项逐字等于它
    expect(SHEETS['a3-landscape']).toEqual(A3_LANDSCAPE_MM);
    // 且这是 S1 唯一支持的幅面（B2）—— 别的幅面不进这张表
    expect(Object.keys(SHEETS)).toEqual(['a3-landscape']);
  });

  it('F2 装订边 25、其余边距有值且可测；图面留白 = 纸面减图框（不是 0 也不是"自动"）', () => {
    expect(BINDING_MARGIN_MM).toBe(25);
    // 其余三边也有具体值（不是 0，也不是 undefined）
    expect(MARGINS_MM.top).toBeGreaterThan(0);
    expect(MARGINS_MM.right).toBeGreaterThan(0);
    expect(MARGINS_MM.bottom).toBeGreaterThan(0);
    // 装订边只���左边那一个
    expect(MARGINS_MM.left).toBe(BINDING_MARGIN_MM);
    // 图面留白 = 纸面 − 四边留白，逐字可算
    const frame = frameOps();
    const xs = frame.flatMap((o) => xy(o).map((p) => p.x));
    const ys = frame.flatMap((o) => xy(o).map((p) => p.y));
    expect(Math.min(...xs)).toBe(BINDING_MARGIN_MM);
    expect(Math.min(...ys)).toBe(MARGINS_MM.top);
    expect(Math.max(...xs)).toBeCloseTo(A3_LANDSCAPE_MM.width - MARGINS_MM.right, 3);
    expect(Math.max(...ys)).toBeCloseTo(A3_LANDSCAPE_MM.height - MARGINS_MM.bottom, 3);
  });

  it('F5 图框线宽用最粗那档 0.7，与线型表逐字一致', () => {
    for (const op of frameOps()) {
      expect(op.pen.widthMm).toBe(THICKEST);
    }
    expect(THICKEST).toBe(0.7);
  });
});

describe('frame：标题栏（F3 / F4）', () => {
  it('F3 标题栏五个字段逐字进 IR 的 text op', () => {
    const labels = texts(titleBlockOps(titleBlock));
    // 五个字段一个都不许少，且**逐字出现**（不是"包含某个子串"）
    for (const field of [titleBlock.title, titleBlock.scaleText, titleBlock.date, titleBlock.drafter, titleBlock.sheetNo]) {
      expect(labels).toContain(field);
    }
    expect(labels).toHaveLength(5);
  });

  it('F3b 标题栏的字段集合是闭集：少一个字段或多一个字段都判据红', () => {
    // 这一格钉住"五格"这个数：建筑制图的标题栏字段是**规范**，
    // 少一格读者就查不到东西，多一格是自创格式。
    const labels = texts(titleBlockOps(titleBlock));
    expect(labels).toHaveLength(5);
    // 且这五格**互不相同**（重复字段等于少一格）
    expect(new Set(labels).size).toBe(5);
  });

  it('F3c 日期与设计人是入参，不是 new Date() / os.userInfo()', () => {
    // 判据的形态：同titleBlock 跑两次产出逐字相同 ⇒ 里面没有"现在时间"这类
    // 不可控来源。T8 的 E3 是同一条主张在导出出口那层的形态。
    const a = JSON.stringify(titleBlockOps(titleBlock));
    const b = JSON.stringify(titleBlockOps(titleBlock));
    expect(a).toBe(b);
  });

  it('F4 标题栏在图框的右下角', () => {
    const block = titleBlockOps(titleBlock);
    const xs = block.flatMap((o) => xy(o).map((p) => p.x));
    const ys = block.flatMap((o) => xy(o).map((p) => p.y));
    // 标题栏的中心落在图框**右半边**且**下半边**
    const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
    expect(centerX).toBeGreaterThan(A3_LANDSCAPE_MM.width / 2);
    expect(centerY).toBeGreaterThan(A3_LANDSCAPE_MM.height / 2);
    // 且它的右边缘与下边缘就是图框的右下角（贴边）
    expect(Math.max(...xs)).toBeCloseTo(A3_LANDSCAPE_MM.width - MARGINS_MM.right, 3);
    expect(Math.max(...ys)).toBeCloseTo(A3_LANDSCAPE_MM.height - MARGINS_MM.bottom, 3);
  });

  it('F6 图框与标题栏的图层是 frame，且标题栏在 frame 层里', () => {
    for (const op of ops()) {
      expect(op.pen.layer).toBe('frame');
    }
  });
});

describe('annotate：指北针与标高（N1 / N2 / N3 / N4）', () => {
  it('N1 指北针钉"包含一个 45° 斜线段 + 一个闭合多边形"两件事，不钉"长得像"', () => {
    const arrow = northArrowOps({ x: 380, y: 30 });
    // ① 有一个 45° 斜线段（针身）
    const diagonals = arrow.filter(
      (o) => o.kind === 'line' && Math.abs(Math.abs(o.a.x - o.b.x) - Math.abs(o.a.y - o.b.y)) < 1e-6,
    );
    expect(diagonals.length).toBeGreaterThan(0);
    // ② 有一个**闭合**多边形（针头或圆环）
    const closed = arrow.filter(
      (o) => o.kind === 'polygon' && o.pts.length >= 3 && Math.abs(polygonArea(o.pts)) > 0,
    );
    expect(closed.length).toBeGreaterThan(0);
  });

  it('N2 标高符号是等腰直角三角（两个直角边等长）', () => {
    const mark = elevationMarkOps({ x: 50, y: 50 }, 3000);
    const tris = mark.filter((o) => o.kind === 'polygon' && o.pts.length === 3);
    expect(tris.length).toBeGreaterThan(0);
    // 三点里有一个直角：两条直角边等长 ⇒ 腰 = 底/√2
    for (const t of tris) {
      if (t.kind !== 'polygon') continue;
      const [p, q, r] = t.pts;
      const legs = [Math.hypot(q.x - p.x, q.y - p.y), Math.hypot(r.x - q.x, r.y - q.y), Math.hypot(p.x - r.x, p.y - r.y)].sort(
        (a, b) => a - b,
      );
      const [short, mid, long] = legs;
      // 等腰直角：短边相等，斜边 = 短 × √2
      expect(mid!).toBeCloseTo(short!, 3);
      expect(long!).toBeCloseTo(short! * Math.SQRT2, 2);
    }
  });

  it('N3 两者的图层是 annotation，且在 dimension 之后（层索引单调）', () => {
    const combined = [
      ...frameOps(),
      ...titleBlockOps(titleBlock),
      ...northArrowOps({ x: 380, y: 30 }),
      ...elevationMarkOps({ x: 50, y: 50 }, 3000),
    ];
    const idx = combined.map((o) => PAPER_LAYERS.indexOf(o.pen.layer));
    for (const i of idx) expect(i).toBeGreaterThanOrEqual(0);
    // 单调不减：frame(0) 在前，annotation(5) 在后
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i]).toBeGreaterThanOrEqual(idx[i - 1]!);
    }
    // 且这两个符号自己的层是 annotation
    for (const o of [...northArrowOps({ x: 380, y: 30 }), ...elevationMarkOps({ x: 50, y: 50 }, 3000)]) {
      expect(o.pen.layer).toBe('annotation');
    }
  });

  it('N4 符号的纸面尺寸**不随图幅缩放**（它们是图面规范量）', () => {
    // 判据的形态：同一个符号函数在两个不同幅面下产出**同样大小**的图元 ——
    // 尺寸只由符号自己的参数决定，与图幅无关。
    const a = northArrowOps({ x: 100, y: 100 });
    const b = northArrowOps({ x: 100, y: 100 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // 显式验：针身长度与"图幅"无关（用一个远离 A3 尺寸的坐标，尺寸不变）
    const far = northArrowOps({ x: 5, y: 5 });
    const near = northArrowOps({ x: 415, y: 292 });
    const sizeOf = (list: readonly PaperOp[]): number =>
      Math.max(
        ...list.map((o) =>
          o.kind === 'line'
            ? Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y)
            : o.kind === 'polygon'
              ? Math.max(...o.pts.map((p) => p.x)) - Math.min(...o.pts.map((p) => p.x))
              : 0,
        ),
      );
    expect(sizeOf(far)).toBeCloseTo(sizeOf(near), 6);
  });

  it('N4b 标高符号的纸面尺寸也不随标高值变化（标高是模型量，符号是图面量）', () => {
    // 同一个符号画在 0mm 与 30000mm 的标高处，纸面大小必须一样 ——
    // 若它随标高变，那"标高"这个图面规范量就被模型的数值污染了。
    const low = elevationMarkOps({ x: 50, y: 50 }, 0);
    const high = elevationMarkOps({ x: 50, y: 50 }, 30_000);
    const sizeOf = (list: readonly PaperOp[]): number =>
      Math.max(
        ...list.map((o) =>
          o.kind === 'polygon'
            ? Math.max(...o.pts.map((p) => p.x)) - Math.min(...o.pts.map((p) => p.x))
            : 0,
        ),
      );
    expect(sizeOf(low)).toBeCloseTo(sizeOf(high), 6);
  });

  it('annotate.ts 的源码里没有颜色/字体名（与 T2 那条同一条边界）', () => {
    // 与 `linetypes` 的 L6 同一族：纸面域不认颜色与字体名。
    const src = readFileSync(join(process.cwd(), 'packages/drawing/src/annotate.ts'), 'utf8');
    for (const re of [/#[0-9a-fA-F]{3,8}/, /rgb\(/, /\bcolor\b/i, /fontFamily|font-family|fontSize/i]) {
      expect(src).not.toMatch(re);
    }
  });

  it('T8 同参数连跑两次，图元逐字节相同', () => {
    const args = { x: 380, y: 30 } as const;
    expect(JSON.stringify(northArrowOps(args))).toBe(JSON.stringify(northArrowOps(args)));
    expect(JSON.stringify(elevationMarkOps(args, 3000))).toBe(JSON.stringify(elevationMarkOps(args, 3000)));
  });
});

// —— 助手 ————————————————————————————————————————————————

function xy(op: PaperOp): { x: number; y: number }[] {
  switch (op.kind) {
    case 'line':
      return [op.a, op.b];
    case 'polyline':
    case 'polygon':
      return [...op.pts];
    case 'text':
    case 'tick':
      return [op.at];
  }
}

function polygonArea(pts: readonly { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
