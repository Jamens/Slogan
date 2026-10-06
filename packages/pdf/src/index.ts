import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { loadSubsetFont } from './font';
import type { Pen, PaperLineType, Sheet } from '@dajia/drawing';
import type { PdfFont } from './font';

/**
 * 自研 PDF 内容流后端（spec D4，M1.5a + M1.5b + M1.5c）。
 *
 * 它吃什么：图面 IR（`Sheet`）—— 已经乘过比例、单位是纸面毫米、原点在图框左上、
 * y 向下（见 `packages/drawing/src/ir.ts`）。
 *
 * 它产什么：一份**合法**的 PDF（`Uint8Array`）。M1.5a 故意不压缩内容流以便读回；
 * M1.5c 起内容流默认用 `/Filter /FlateDecode` 压缩（用 `node:zlib`，Electron/node 环境），
 * 独立的 reader（见 `test/helpers/pdf-parse.ts`）会先 inflate 再解析 —— 两种形态都能
 * 逐字节读回做往返校验。想关压缩调试传 `{ compress: false }`。
 *
 *
 * **M1.5b 加文字**：传给 `writeSheets(sheets, { font })` 一个 `PdfFont`（思源黑体子集），
 * `text` op 就被渲染成真·可显示的中文 —— Type0/Identity-H + 内嵌 CIDFontType0C。
 * 不传 font 时 `text` 仍被跳过（M1.5a 行为），保持后端对「无字体」场景的兼容。
 *
 * **字节组装**：PDF 里混了 ASCII 文本字典和裸二进制 CFF 流，所以整体用 `Uint8Array`
 * 块拼接（不是字符串），xref 偏移按字节精确记账 —— 否则二进制塞进 JS 字符串会错位。
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

/** 一笔的画笔设置：线宽（pt）+ 虚线 + 黑（IR 不带颜色，全黑）。`q`/`Q` 隔离不泄漏。 */
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

function sheetContent(sheet: Sheet, font: PdfFont | undefined): string {
  const out: string[] = [];
  for (const op of sheet.ops) {
    if (op.kind === 'text') {
      if (!font) continue; // 没给字体 → 跳过（兼容 M1.5a）
      const sizePt = mmToPt(op.heightMm);
      const p = toPt(sheet, op.at.x, op.at.y); // baseline 原点，y 翻转
      const enc = font.encode(op.s);
      // 文字用填充色（rg），不是描边色（RG）。Identity-H：`<GIDhex>` 是 2 字节 GID。
      out.push('q 0 0 0 rg');
      out.push(`BT /F1 ${num(sizePt)} Tf 1 0 0 1 ${num(p.x)} ${num(p.y)} Tm <${enc}> Tj ET`);
      out.push('Q');
      continue;
    }
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
  /** 内容流：字符串（ASCII 内容流）或 Uint8Array（二进制，如 /FontFile3 或压缩后的内容流）。 */
  readonly stream?: string | Uint8Array;
}

export interface WriteOptions {
  /** 内嵌字体。给了就渲染 `text` op，否则跳过（M1.5a 行为）。 */
  readonly font?: PdfFont;
  /** 是否把 CFF 字节塞进 /FontFile3。默认 true。false = 字体不内嵌（M1.5b 变异测试）。 */
  readonly embed?: boolean;
  /**
   * 内容流是否用 `/FlateDecode` 压缩。默认 true（M1.5c）。reader 会先 inflate 再解析，
   * 往返校验不受影响；传 false 出未压缩内容流便于肉眼调试。
   */
  readonly compress?: boolean;
}

function buildPdf(sheets: readonly Sheet[], opts: WriteOptions = {}): Uint8Array {
  const font = opts.font;
  const embed = opts.embed ?? true;
  const compress = opts.compress ?? true;
  const enc = new TextEncoder();
  const n = sheets.length;
  const catalogNum = 1;
  const pagesNum = 2;
  const pageNums = sheets.map((_, i) => 3 + i);
  const contentNums = sheets.map((_, i) => 3 + n + i);

  // 字体对象号（仅当给了 font）
  let type0Num = 0;
  let descNum = 0;
  let fdNum = 0;
  let ffNum = 0;
  if (font) {
    const base = 3 + 2 * n;
    type0Num = base;
    descNum = base + 1;
    fdNum = base + 2;
    ffNum = base + 3;
  }

  const objs: PdfObject[] = [{ num: catalogNum, dict: `<< /Type /Catalog /Pages ${pagesNum} 0 R >>` }];
  objs.push({
    num: pagesNum,
    dict: `<< /Type /Pages /Kids [${pageNums.map((p) => `${p} 0 R`).join(' ')}] /Count ${n} >>`,
  });

  sheets.forEach((sheet, i) => {
    const wpt = num(mmToPt(sheet.widthMm));
    const hpt = num(mmToPt(sheet.heightMm));
    const res = font
      ? `/Resources << /ProcSet [/PDF] /Font << /F1 ${type0Num} 0 R >> >>`
      : `/Resources << /ProcSet [/PDF] >>`;
    objs.push({
      num: pageNums[i]!,
      dict:
        `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${wpt} ${hpt}] ` +
        `/Contents ${contentNums[i]!} 0 R ${res} >>`,
    });
    const content = sheetContent(sheet, font);
    // 内容流压缩：deflate 后是二进制 Uint8Array；不压缩则是 ASCII 字符串（字节长 == 串长）。
    const contentBytes = compress ? deflateSync(enc.encode(content)) : enc.encode(content);
    const filter = compress ? ' /Filter /FlateDecode' : '';
    objs.push({
      num: contentNums[i]!,
      dict: `<< /Length ${contentBytes.length}${filter} >>`,
      stream: contentBytes,
    });
  });

  if (font) {
    objs.push({
      num: type0Num,
      dict:
        `<< /Type /Font /Subtype /Type0 /BaseFont /${font.baseName} ` +
        `/Encoding /Identity-H /DescendantFonts [${descNum} 0 R] >>`,
    });
    const fdRef = embed ? ` /FontFile3 ${ffNum} 0 R` : '';
    objs.push({
      num: descNum,
      dict:
        `<< /Type /Font /Subtype /CIDFontType0C /BaseFont /${font.baseName} ` +
        `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
        `/FontDescriptor ${fdNum} 0 R /CIDToGIDMap /Identity /W [ ${font.wArray()} ] >>`,
    });
    const bb = font.bbox.map((v) => v.toString(10)).join(' ');
    // Ascent/Descent/CapHeight 用 1000-em 制合理默认（reader 不严格校验）。
    objs.push({
      num: fdNum,
      dict:
        `<< /Type /FontDescriptor /FontName /${font.baseName} /Flags 4 ` +
        `/FontBBox [${bb}] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 ` +
        `/StemV 80${fdRef} >>`,
    });
    if (embed) {
      objs.push({
        num: ffNum,
        dict:
          `<< /Length ${font.cff.length} /Subtype /CIDFontType0C /Length1 ${font.cff.length} >>`,
        stream: font.cff,
      });
    }
  }

  // 字节拼接：ASCII 字典/内容用 TextEncoder，二进制（CFF / 压缩内容流）用裸字节；xref 偏移按字节记账。
  const chunks: Uint8Array[] = [];
  let len = 0;
  const offsets: number[] = [];
  const pushStr = (s: string): void => {
    const b = enc.encode(s);
    chunks.push(b);
    len += b.length;
  };
  const pushBytes = (b: Uint8Array): void => {
    chunks.push(b);
    len += b.length;
  };

  pushStr(`%PDF-${PDF_VERSION}\n`);
  for (const o of objs) {
    offsets[o.num] = len;
    pushStr(`${o.num} 0 obj\n${o.dict}`);
    if (o.stream !== undefined) {
      pushStr('\nstream\n');
      if (typeof o.stream === 'string') pushStr(o.stream);
      else pushBytes(o.stream);
      pushStr('\nendstream');
    }
    pushStr('\nendobj\n');
  }

  const xrefStart = len;
  const size = objs.length + 1; // 最高对象号 = objs.length，Size = 最高 + 1
  pushStr(`xref\n0 ${size}\n`);
  pushStr('0000000000 65535 f \n'); // 0 号空闲项
  for (let i = 1; i < size; i++) {
    const off = offsets[i] ?? 0;
    pushStr(`${off.toString().padStart(10, '0')} 00000 n \n`);
  }
  pushStr(`trailer\n<< /Size ${size} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  const out = new Uint8Array(len);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

/** 多张图 → 多页 PDF。T8 的导出计划直接复用它。 */
export function writeSheets(sheets: readonly Sheet[], opts: WriteOptions = {}): Uint8Array {
  if (sheets.length === 0) throw new Error('writeSheets: 至少要有一张图');
  return buildPdf(sheets, opts);
}

/** 单张图 → 单页 PDF。 */
export function writeSheet(sheet: Sheet, opts: WriteOptions = {}): Uint8Array {
  return writeSheets([sheet], opts);
}

/**
 * 加载随仓库分发的默认中文字体（思源黑体子集，SIL OFL）。
 * T8 的导出入口直接调它拿 `PdfFont`，字体的物理路径留在 pdf 包内，
 * 不向外层（desktop）暴露相对路径。字节是常数 ⇒ 不影响导出字节稳定性（E2）。
 */
const DEFAULT_FONT_ASSET = new URL('../assets/noto-sans-sc.subset.otf', import.meta.url);
export function loadDefaultFont(baseName = 'NotoSansSC'): PdfFont {
  const bytes = new Uint8Array(readFileSync(fileURLToPath(DEFAULT_FONT_ASSET)));
  return loadSubsetFont(bytes, baseName);
}

export { loadSubsetFont } from './font';
export type { PdfFont } from './font';
export { calibrationSheet } from './calibration';
export type { CalibrationOptions } from './calibration';
