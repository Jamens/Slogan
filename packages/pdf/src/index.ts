import type { Pen, PaperLineType, Sheet } from '@dajia/drawing';

/**
 * 自研 PDF 内容流后端（spec D4，M1.5a）。
 *
 * 它吃什么：图面 IR（`Sheet`）—— 已经乘过比例、单位是纸面毫米、原点在图框左上、
 * y 向下（见 `packages/drawing/src/ir.ts` 的注释）。
 *
 * 它产什么：一份**合法、未压缩内容流**的 PDF（`Uint8Array`）。内容流不压缩是有意的：
 * M1.5a 的验收是「产物能被一个真 PDF 解析器读回，线宽与坐标逐字对得上」，未压缩让
 * 最简的解析器（见 `test/helpers/pdf-parse.ts`）也能逐字节读回；压缩是 M1.5c 的活。
 *
 * **M1.5a 不含文字**（spec 要求「中文字体嵌入」，字体方案待 M1.5b 与用户定）。
 * `text` op 在这里被静默跳过，`G9` 锁住「输出里没有文字算子」—— 免得以后悄悄丢字
 * 还以为对了。
 */

/** 1 英寸 = 25.4 毫米 = 72 点（PDF 用户空间单位）。 */
export const PT_PER_MM = 72 / 25.4;
/** PDF 版本（无压缩内容流，保证可被最简解析器读回）。 */
export const PDF_VERSION = '1.7';
/** 端点符号（tick）的固定纸面长度（毫米，spec C3）。 */
const TICK_LENGTH_MM = 2;

function mmToPt(mm: number): number {
  return mm * PT_PER_MM;
}

/** 坐标写 4 位小数 ≈ 0.0001pt ≈ 0.000035mm 误差，远小于验收 0.01mm。 */
function num(n: number): string {
  return n.toFixed(4);
}

/**
 * 四种线型在纸面毫米下的虚线模板。spec §7 没给死值，取工程图常用比例。
 * **只影响描边节奏，不影响线段端点** —— 几何校验不比对虚线，但 PDF 得画对。
 */
const DASH_MM: Record<PaperLineType, readonly number[]> = {
  solid: [],
  dashed: [4, 2],
  'dash-dot': [8, 2, 1, 2],
  center: [12, 2, 2, 2],
};

function dashOp(lineType: PaperLineType): string {
  const arr = DASH_MM[lineType].map((d) => num(mmToPt(d)));
  return `[${arr.join(' ')}] 0 d`;
}

/** IR 毫米坐标 → PDF 点坐标。翻转 y：IR 原点左上y向下 → PDF 原点左下y向上。 */
function toPt(sheet: Sheet, x: number, y: number): { x: number; y: number } {
  return { x: mmToPt(x), y: mmToPt(sheet.heightMm - y) };
}

function fmtPt(p: { x: number; y: number }): string {
  return `${num(p.x)} ${num(p.y)}`;
}

/** 一笔的画笔设置：线宽（pt）+ 虚线 + 黑（M1.5a 全黑，IR 不带颜色）。`q`/`Q` 隔离不泄漏。 */
function penOps(pen: Pen): string {
  return `q ${num(mmToPt(pen.widthMm))} w ${dashOp(pen.lineType)} 0 0 0 RG`;
}

function strokeOf(filled: boolean): string {
  return filled ? 'B' : 'S';
}

function emitPath(pts: readonly { x: number; y: number }[], close: boolean, out: string[]): void {
  if (pts.length === 0) return;
  out.push(`m ${fmtPt(pts[0]!)}`);
  for (let i = 1; i < pts.length; i++) out.push(`l ${fmtPt(pts[i]!)}`);
  if (close) out.push('h');
}

function sheetContent(sheet: Sheet): string {
  const out: string[] = [];
  for (const op of sheet.ops) {
    if (op.kind === 'text') continue; // M1.5a：文字延后（见文件头注释）
    out.push(penOps(op.pen));
    switch (op.kind) {
      case 'line':
        out.push(`m ${fmtPt(toPt(sheet, op.a.x, op.a.y))} l ${fmtPt(toPt(sheet, op.b.x, op.b.y))}`);
        out.push(strokeOf(false));
        break;
      case 'polyline':
        emitPath(op.pts.map((p) => toPt(sheet, p.x, p.y)), false, out);
        out.push(strokeOf(false));
        break;
      case 'polygon':
        emitPath(op.pts.map((p) => toPt(sheet, p.x, p.y)), true, out);
        out.push(strokeOf(op.fill));
        break;
      case 'tick': {
        // 45° 斜线，固定纸面长 2mm。半分量 = L/(2√2) 使总长恰为 2（不是 L·√2）。
        const d = TICK_LENGTH_MM / (2 * Math.SQRT2);
        emitPath([toPt(sheet, op.at.x - d, op.at.y - d), toPt(sheet, op.at.x + d, op.at.y + d)], false, out);
        out.push(strokeOf(false));
        break;
      }
    }
    out.push('Q');
  }
  return out.join('\n');
}

interface PdfObject {
  readonly num: number;
  readonly dict: string;
  readonly stream?: string;
}

function buildPdf(sheets: readonly Sheet[]): Uint8Array {
  const n = sheets.length;
  const catalogNum = 1;
  const pagesNum = 2;
  const pageNums = sheets.map((_, i) => 3 + i);
  const contentNums = sheets.map((_, i) => 3 + n + i);

  const objs: PdfObject[] = [{ num: catalogNum, dict: `<< /Type /Catalog /Pages ${pagesNum} 0 R >>` }];
  objs.push({
    num: pagesNum,
    dict: `<< /Type /Pages /Kids [${pageNums.map((p) => `${p} 0 R`).join(' ')}] /Count ${n} >>`,
  });
  sheets.forEach((sheet, i) => {
    const wpt = num(mmToPt(sheet.widthMm));
    const hpt = num(mmToPt(sheet.heightMm));
    objs.push({
      num: pageNums[i]!,
      dict:
        `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${wpt} ${hpt}] ` +
        `/Contents ${contentNums[i]!} 0 R /Resources << /ProcSet [/PDF] >> >>`,
    });
    const content = sheetContent(sheet);
    // /Length = 内容字节数。内容全 ASCII（UTF-8 = 字节），string.length == 字节数。
    objs.push({ num: contentNums[i]!, dict: `<< /Length ${content.length} >>`, stream: content });
  });

  let s = `%PDF-${PDF_VERSION}\n`;
  const offsets: number[] = [];
  for (const o of objs) {
    offsets[o.num] = s.length;
    s += `${o.num} 0 obj\n${o.dict}`;
    if (o.stream !== undefined) s += `\nstream\n${o.stream}\nendstream`;
    s += '\nendobj\n';
  }
  const xrefStart = s.length;
  const size = objs.length + 1; // 最高对象号 = objs.length，Size = 最高 + 1
  s += `xref\n0 ${size}\n`;
  s += `0000000000 65535 f \n`; // 0 号空闲项
  for (let i = 1; i < size; i++) {
    const off = offsets[i] ?? 0;
    s += `${off.toString().padStart(10, '0')} 00000 n \n`; // 每条 20 字节
  }
  s += `trailer\n<< /Size ${size} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  // 全 ASCII → UTF-8 编码后字节偏移 == 字符串下标，xref 偏移逐字节精确。
  return new TextEncoder().encode(s);
}

/** 多张图 → 多页 PDF。T8 的导出计划直接复用它。 */
export function writeSheets(sheets: readonly Sheet[]): Uint8Array {
  if (sheets.length === 0) throw new Error('writeSheets: 至少要有一张图');
  return buildPdf(sheets);
}

/** 单张图 → 单页 PDF。 */
export function writeSheet(sheet: Sheet): Uint8Array {
  return writeSheets([sheet]);
}
