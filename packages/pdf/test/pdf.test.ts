import { describe, expect, it } from 'vitest';
import { writeSheet, writeSheets } from '../src/index';
import type { PaperLineType, Pen, Sheet } from '@dajia/drawing';
import { line, polygon, polyline, text, tick } from '@dajia/drawing';
import { parsePdf, type SegmentMm } from './helpers/pdf-parse';

const pen = (widthMm: number, lineType: PaperLineType = 'solid'): Pen => ({
  layer: 'structure',
  widthMm,
  lineType,
});

const A3: Sheet = { widthMm: 420, heightMm: 297, ops: [] };

/** IR 毫米坐标直接就是「真值」：reader 把 PDF 点逆变换回毫米后应当逐字还原它。 */
interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  widthMm: number;
}

/** 端点无关方向 + 1e-3mm 量化（严于验收 0.01mm），转成可比较的 key。 */
function canon(s: Seg): string {
  let a: [number, number] = [s.x1, s.y1];
  let b: [number, number] = [s.x2, s.y2];
  if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) [a, b] = [b, a];
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return [r(a[0]), r(a[1]), r(b[0]), r(b[1]), r(s.widthMm)].join(',');
}

function segSet(segs: readonly Seg[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of segs) m.set(canon(s), (m.get(canon(s)) ?? 0) + 1);
  return m;
}

function expectSameSet(actual: readonly SegmentMm[], expected: readonly Seg[]): void {
  expect(segSet(actual)).toEqual(segSet(expected));
}

describe('M1.5a PDF 后端：几何逐字往返', () => {
  it('G1 单条直线：端点与线宽逐字对得上（≤0.01mm）', () => {
    const sheet: Sheet = { ...A3, ops: [line({ x: 10, y: 20 }, { x: 210, y: 90 }, pen(0.5))] };
    const pdf = writeSheet(sheet);
    const parsed = parsePdf(pdf);
    expect(parsed.pages).toHaveLength(1);
    const segs = parsed.pages[0]!.segments;
    expect(segs).toHaveLength(1);
    // 逐字精度断言（验收硬指标）
    expect(Math.abs(segs[0]!.x1 - 10)).toBeLessThan(0.01);
    expect(Math.abs(segs[0]!.y1 - 20)).toBeLessThan(0.01);
    expect(Math.abs(segs[0]!.x2 - 210)).toBeLessThan(0.01);
    expect(Math.abs(segs[0]!.y2 - 90)).toBeLessThan(0.01);
    expect(Math.abs(segs[0]!.widthMm - 0.5)).toBeLessThan(0.005);
    expectSameSet(segs, [{ x1: 10, y1: 20, x2: 210, y2: 90, widthMm: 0.5 }]);
  });

  it('G2 多段折线：每段都独立往返', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 50 },
      { x: 200, y: 0 },
      { x: 300, y: 50 },
    ];
    const sheet: Sheet = { ...A3, ops: [polyline(pts, pen(0.35))] };
    const segs = parsePdf(writeSheet(sheet)).pages[0]!.segments;
    expect(segs).toHaveLength(3);
    expectSameSet(segs, [
      { x1: 0, y1: 0, x2: 100, y2: 50, widthMm: 0.35 },
      { x1: 100, y1: 50, x2: 200, y2: 0, widthMm: 0.35 },
      { x1: 200, y1: 0, x2: 300, y2: 50, widthMm: 0.35 },
    ]);
  });

  it('G3 闭合多边形：含闭合边（末点→首点）', () => {
    const pts = [
      { x: 50, y: 50 },
      { x: 150, y: 50 },
      { x: 150, y: 150 },
      { x: 50, y: 150 },
    ];
    const sheet: Sheet = { ...A3, ops: [polygon(pts, pen(0.7), false)] };
    const segs = parsePdf(writeSheet(sheet)).pages[0]!.segments;
    expect(segs).toHaveLength(4); // 4 条边（含闭合）
    expectSameSet(segs, [
      { x1: 50, y1: 50, x2: 150, y2: 50, widthMm: 0.7 },
      { x1: 150, y1: 50, x2: 150, y2: 150, widthMm: 0.7 },
      { x1: 150, y1: 150, x2: 50, y2: 150, widthMm: 0.7 },
      { x1: 50, y1: 150, x2: 50, y2: 50, widthMm: 0.7 },
    ]);
  });

  it('G4 端点符号 tick：45°、固定纸面长 2mm', () => {
    const sheet: Sheet = { ...A3, ops: [tick({ x: 100, y: 150 }, pen(0.25))] };
    const segs = parsePdf(writeSheet(sheet)).pages[0]!.segments;
    expect(segs).toHaveLength(1);
    const s = segs[0]!;
    const dx = s.x2 - s.x1;
    const dy = s.y2 - s.y1;
    const len = Math.hypot(dx, dy);
    expect(Math.abs(len - 2)).toBeLessThan(0.01); // 长恰 2mm，不是 2√2
    expect(Math.abs(Math.abs(dx) - Math.abs(dy))).toBeLessThan(0.01); // 45°
  });

  it('G5 五种合法线宽：每个都产出精确的 pt 线宽', () => {
    const widths = [0.18, 0.25, 0.35, 0.5, 0.7];
    const ops = widths.map((w, k) => line({ x: 0, y: 10 + k * 10 }, { x: 100, y: 10 + k * 10 }, pen(w)));
    const segs = parsePdf(writeSheet({ ...A3, ops })).pages[0]!.segments;
    expect(segs).toHaveLength(5);
    const got = new Set(segs.map((s) => Math.round(s.widthMm * 1000) / 1000));
    for (const w of widths) expect(got.has(w)).toBe(true);
  });

  it('G6 多张图 → 多页：每页 MediaBox 与几何各自往返', () => {
    const s0: Sheet = { widthMm: 420, heightMm: 297, ops: [line({ x: 0, y: 0 }, { x: 420, y: 297 }, pen(0.5))] };
    const s1: Sheet = { widthMm: 200, heightMm: 150, ops: [line({ x: 0, y: 0 }, { x: 200, y: 150 }, pen(0.35))] };
    const pdf = writeSheets([s0, s1]);
    const parsed = parsePdf(pdf);
    expect(parsed.pages).toHaveLength(2);
    // MediaBox 经 pt 存储再逆变换回 mm 有 ~1e-5mm 舍入（内容流 4 位小数），远小于验收 0.01mm
    expect(parsed.pages[0]!.mediaBoxMm[2]!).toBeCloseTo(420, 3);
    expect(parsed.pages[0]!.mediaBoxMm[3]!).toBeCloseTo(297, 3);
    expect(parsed.pages[1]!.mediaBoxMm[2]!).toBeCloseTo(200, 3);
    expect(parsed.pages[1]!.mediaBoxMm[3]!).toBeCloseTo(150, 3);
    expectSameSet(parsed.pages[0]!.segments, [
      { x1: 0, y1: 0, x2: 420, y2: 297, widthMm: 0.5 },
    ]);
    expectSameSet(parsed.pages[1]!.segments, [
      { x1: 0, y1: 0, x2: 200, y2: 150, widthMm: 0.35 },
    ]);
  });

  it('G7 结构合法：版本、xref、trailer 都能被真解析器读回', () => {
    const pdf = writeSheet({ ...A3, ops: [line({ x: 1, y: 1 }, { x: 2, y: 2 }, pen(0.5))] });
    const parsed = parsePdf(pdf);
    expect(parsed.version).toBe('1.7');
    const raw = new TextDecoder('latin1').decode(pdf);
    expect(raw.startsWith('%PDF-1.7')).toBe(true);
    expect(raw.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(raw).toContain('/Root 1 0 R');
    expect(raw).toContain('trailer');
    // 每个 xref 偏移都确实指向 "N 0 obj"
    const sx = /startxref\s+(\d+)/.exec(raw)![1]!;
    const xrefLines = raw.slice(Number(sx)).split('\n');
    const count = Number(xrefLines[1]!.split(' ')[1]);
    for (let i = 1; i < count; i++) {
      const off = Number(xrefLines[2 + i]!.slice(0, 10));
      expect(raw.slice(off).startsWith(`${i} 0 obj`)).toBe(true);
    }
  });

  it('G8 y 翻转正确：IR 左上y向下 → PDF 左下y向上（用非对称线锁死）', () => {
    // (10,20)→(30,40) 非对称：若 writer 没翻转 y，reader 逆变换会得到 (10, H-20)→(30, H-40)，对不上。
    const sheet: Sheet = { ...A3, ops: [line({ x: 10, y: 20 }, { x: 30, y: 40 }, pen(0.5))] };
    const segs = parsePdf(writeSheet(sheet)).pages[0]!.segments;
    expectSameSet(segs, [{ x1: 10, y1: 20, x2: 30, y2: 40, widthMm: 0.5 }]);
  });

  it('G9 M1.5a 无文字：text op 被跳过，但几何不丢', () => {
    const sheet: Sheet = {
      ...A3,
      ops: [
        line({ x: 0, y: 0 }, { x: 100, y: 100 }, pen(0.5)),
        text({ x: 50, y: 50 }, 2.5, '图名', pen(0.18)),
      ],
    };
    const pdf = writeSheet(sheet);
    const raw = new TextDecoder('latin1').decode(pdf);
    // 输出里不得出现任何文字算子（M1.5b 会引入 Tj，那时本格要反过来断言「有文字」）
    expect(raw).not.toContain('Tj');
    expect(raw).not.toContain('TJ');
    expect(raw).not.toContain('BT');
    // 但那条线还在
    expectSameSet(parsePdf(pdf).pages[0]!.segments, [
      { x1: 0, y1: 0, x2: 100, y2: 100, widthMm: 0.5 },
    ]);
  });
});
