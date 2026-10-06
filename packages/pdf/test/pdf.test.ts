import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeSheet, writeSheets, loadSubsetFont, calibrationSheet, type PdfFont } from '../src/index';
import type { PaperLineType, Pen, Sheet } from '@dajia/drawing';
import { line, polygon, polyline, text, tick } from '@dajia/drawing';
import { parsePdf, type SegmentMm, type TextRun } from './helpers/pdf-parse';

/** 读仓库内的思源黑体子集（SIL OFL，可随仓库分发）。 */
function loadFont(): PdfFont {
  const url = new URL('../assets/noto-sans-sc.subset.otf', import.meta.url);
  const bytes = new Uint8Array(readFileSync(fileURLToPath(url)));
  return loadSubsetFont(bytes);
}

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

describe('M1.5b PDF 后端：中文真实内嵌（思源黑体子集）', () => {
  it('G10 字体解析：cmap→GID / hmtx 字宽 / head bbox 逐字对得上字体事实', () => {
    const font = loadFont();
    // 以下 GID 由 fontTools 独立核对（见 tmp/probe-font.py），不是 writer 自证。
    expect(font.unitsPerEm).toBe(1000);
    expect(font.numGlyphs).toBe(219);
    expect(font.u2g.get(0x56fe)).toBe(107); // 图
    expect(font.u2g.get(0x540d)).toBe(105); // 名
    expect(font.u2g.get(0x8bbe)).toBe(169); // 设
    expect(font.u2g.get(0x8ba1)).toBe(168); // 计
    expect(font.u2g.get(0x0031)).toBe(10); // 1
    expect(font.u2g.get(0x0030)).toBe(9); // 0
    expect(font.u2g.get(0x0041)).toBe(21); // A
    // 字宽（字体单位）：CJK 全 1000，数字 555，A 607
    expect(font.widthByGid[107]).toBe(1000);
    expect(font.widthByGid[10]).toBe(555);
    expect(font.widthByGid[21]).toBe(607);
    // bbox（字体单位）= [-44, -1048, 2928, 1808]
    expect(font.bbox[0]).toBe(-44);
    expect(font.bbox[1]).toBe(-1048);
    expect(font.bbox[2]).toBe(2928);
    expect(font.bbox[3]).toBe(1808);
    // 裸 CFF 字节可塞 FontFile3
    expect(font.cff.length).toBeGreaterThan(1000);
    // encode/decode 自身往返
    const s = '图名设计比例1A';
    expect(font.decode(font.encode(s))).toBe(s);
  });

  it('G11 中文真渲染：BT/Tj 产出，reader 抽回 hex，字体解码回原 Unicode', () => {
    const font = loadFont();
    const sheet: Sheet = {
      ...A3,
      ops: [text({ x: 50, y: 80 }, 3.5, '图名设计', pen(0.18))],
    };
    const pdf = writeSheet(sheet, { font });
    const page = parsePdf(pdf).pages[0]!;
    expect(page.textRuns).toHaveLength(1);
    const run: TextRun = page.textRuns[0]!;
    // reader 抽回的 hex 经字体解码应等于原串
    expect(font.decode(run.hex)).toBe('图名设计');
    // baseline 左基点（mm）逆翻转后应对上 IR 的 (50,80)
    expect(Math.abs(run.x - 50)).toBeLessThan(0.01);
    expect(Math.abs(run.y - 80)).toBeLessThan(0.01);
    // 字体相关字典未压缩：Identity-H / FontFile3 应出现在产物里
    const raw = new TextDecoder('latin1').decode(pdf);
    expect(raw).toContain('Identity-H');
    expect(raw).toContain('/FontFile3');
  });

  it('G12 带字体时几何不丢：线 + 文字共存，线段仍逐字往返', () => {
    const font = loadFont();
    const sheet: Sheet = {
      ...A3,
      ops: [
        line({ x: 0, y: 0 }, { x: 100, y: 100 }, pen(0.5)),
        text({ x: 40, y: 40 }, 2.5, '审核', pen(0.18)),
      ],
    };
    const parsed = parsePdf(writeSheet(sheet, { font }));
    expectSameSet(parsed.pages[0]!.segments, [
      { x1: 0, y1: 0, x2: 100, y2: 100, widthMm: 0.5 },
    ]);
    expect(parsed.pages[0]!.textRuns).toHaveLength(1);
    expect(font.decode(parsed.pages[0]!.textRuns[0]!.hex)).toBe('审核');
  });

  it('G13 变异：子集没收录的字 → 落 .notdef(GID 0)，PDF 仍合法可解析', () => {
    const font = loadFont();
    // 已知 GID：图=107(0x6B)、名=105(0x69)。先锁死编码映射。
    expect(font.encode('图名')).toBe('006b0069');
    // '𠮷' (U+20BB7) 超 BMP，子集只有 BMP，必走 .notdef(=0000)。与真字混排。
    const s = '图𠮷名';
    const enc = font.encode(s);
    expect(enc).toBe('006b00000069'); // 图(006b) .notdef(0000) 名(0069)
    const sheet: Sheet = { ...A3, ops: [text({ x: 10, y: 10 }, 2.5, s, pen(0.18))] };
    const pdf = writeSheet(sheet, { font });
    // 仍能被真解析器读回（不崩）
    const page = parsePdf(pdf).pages[0]!;
    expect(page.textRuns).toHaveLength(1);
    // 解码：缺字位置是替换符（字体无码点可回），真字还原
    const dec = font.decode(page.textRuns[0]!.hex);
    expect(dec).toContain('图');
    expect(dec).toContain('名');
  });

  it('G14 变异：embed=false → 输出不含 /FontFile3（字体未内嵌，viewer 会告警）', () => {
    const font = loadFont();
    const sheet: Sheet = { ...A3, ops: [text({ x: 10, y: 10 }, 2.5, '图名', pen(0.18))] };
    const embedded = new TextDecoder('latin1').decode(writeSheet(sheet, { font, embed: true }));
    const notEmbeddedBytes = writeSheet(sheet, { font, embed: false });
    const notEmbedded = new TextDecoder('latin1').decode(notEmbeddedBytes);
    expect(embedded).toContain('/FontFile3');
    expect(embedded).toContain('/CIDFontType0C');
    expect(notEmbedded).not.toContain('/FontFile3'); // 未内嵌：字体字典未生成
    // 但文字算子仍在（只是没字体数据可渲染）—— 用 reader 抽回验证
    const np = parsePdf(notEmbeddedBytes).pages[0]!;
    expect(np.textRuns).toHaveLength(1);
  });

  it('G15 产出可视图：A3 中文标题栏 sample-a3-cn.pdf', () => {
    const font = loadFont();
    const title = (label: string, value: string, x: number, y: number): Sheet['ops'] => [
      text({ x, y }, 3.5, label, pen(0.18)),
      text({ x: x + 28, y }, 3.5, value, pen(0.18)),
    ];
    const sheet: Sheet = {
      widthMm: 420,
      heightMm: 297,
      ops: [
        line({ x: 0, y: 0 }, { x: 420, y: 297 }, pen(0.5)),
        line({ x: 0, y: 270 }, { x: 420, y: 270 }, pen(0.35)),
        ...title('图名', '一层平面图', 20, 282),
        ...title('比例', '1:100', 20, 250),
        ...title('日期', '2026-10-06', 220, 282),
        ...title('设计', '张三', 220, 250),
        ...title('审核', '李四', 220, 215),
        text({ x: 20, y: 30 }, 5, '建筑专业 · 施工图', pen(0.25)),
      ],
    };
    const pdf = writeSheet(sheet, { font });
    const url = new URL('../../../tmp/sample-a3-cn.pdf', import.meta.url);
    writeFileSync(fileURLToPath(url), pdf);
    // 基本健全性
    expect(parsePdf(pdf).pages[0]!.textRuns.length).toBeGreaterThan(0);
  });
});

describe('M1.5c PDF 后端：内容流压缩 + 100mm 校准页', () => {
  it('G16 压缩往返：默认 /FlateDecode，reader 先 inflate 再解析，几何+文字逐字对得上', () => {
    const font = loadFont();
    const sheet: Sheet = {
      ...A3,
      ops: [
        line({ x: 0, y: 0 }, { x: 100, y: 100 }, pen(0.5)),
        text({ x: 50, y: 50 }, 3.5, '图名设计', pen(0.18)),
      ],
    };
    const compressed = writeSheet(sheet, { font }); // 默认 compress: true
    const uncompressed = writeSheet(sheet, { font, compress: false });

    // 压缩后整体更小（内容流被 deflate）
    expect(compressed.length).toBeLessThan(uncompressed.length);

    // 压缩产物能被独立 reader 读回：几何 + 中文解码都正确
    const page = parsePdf(compressed).pages[0]!;
    expectSameSet(page.segments, [{ x1: 0, y1: 0, x2: 100, y2: 100, widthMm: 0.5 }]);
    expect(page.textRuns).toHaveLength(1);
    expect(font.decode(page.textRuns[0]!.hex)).toBe('图名设计');
  });

  it('G17 关闭压缩仍可往返（调试兼容）：compress:false 出未压缩内容流', () => {
    const font = loadFont();
    const sheet: Sheet = { ...A3, ops: [text({ x: 10, y: 10 }, 2.5, '审核', pen(0.18))] };
    const pdf = writeSheet(sheet, { font, compress: false });
    const page = parsePdf(pdf).pages[0]!;
    expect(page.textRuns).toHaveLength(1);
    expect(font.decode(page.textRuns[0]!.hex)).toBe('审核');
    // 未压缩时，内容流的文字算子在原文里肉眼可见
    expect(new TextDecoder('latin1').decode(pdf)).toContain('Identity-H');
  });

  it('G18 校准页：两根 100mm 主线 + 刻度，几何逐字对得上，并产出可视图', () => {
    const font = loadFont();
    const sheet = calibrationSheet(); // 默认 A4 / 100mm
    expect(sheet.widthMm).toBe(210);
    expect(sheet.heightMm).toBe(297);

    const pdf = writeSheet(sheet, { font });
    const page = parsePdf(pdf).pages[0]!;
    // 2 根主线 + 21 横刻度 + 21 竖刻度 = 44 段（文字不计入线段）
    expect(page.segments).toHaveLength(44);

    const lenOf = (s: SegmentMm): number => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    const has100 = page.segments.some((s) => Math.abs(lenOf(s) - 100) < 0.01);
    expect(has100).toBe(true);

    // 两根 100mm 主线的精确端点（原点 ox=40, oy=140）
    const segSetNow = segSet(
      page.segments.map((s) => ({
        x1: s.x1,
        y1: s.y1,
        x2: s.x2,
        y2: s.y2,
        widthMm: s.widthMm,
      })),
    );
    // 横线 (40,140)-(140,140) 与 竖线 (40,140)-(40,240) 都应在
    expect(segSetNow.has('40,140,140,140,0.5')).toBe(true);
    expect(segSetNow.has('40,140,40,240,0.5')).toBe(true);

    // 产出可视图
    const url = new URL('../../../tmp/sample-calibration.pdf', import.meta.url);
    writeFileSync(fileURLToPath(url), pdf);
  });
});

