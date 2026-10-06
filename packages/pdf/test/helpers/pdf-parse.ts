/**
 * 一份最小但**真**的 PDF 解析器，只用于测试里把 writer 的产物读回来校验
 * （M1.5a 的验收是「产物能被一个真 PDF 解析器读回，线宽与坐标逐字对得上」）。
 *
 * **独立性是第一要务**：这里的坐标变换、PT_PER_MM、xref 解析全部重新实现，**不引用**
 * `../src/index.ts` 的任何常量或函数。若 writer 与 reader 共享同一份常量、同一处笔误，
 * 测试会「绿得虚假」—— 所以 reader 是 writer 的「对立面」，不是它的镜像。
 *
 * 它真解析：跟 xref 偏移走对象表、拆 `N 0 obj`、取内容流、分词内容流、按图形状态机
 * 解释 `m/l/h/re/w/d/RG/rg/q/Q/S/B/...` 算子，吐出每段线的**纸面毫米**坐标与线宽。
 * 文字算子（`BT/Tj/TJ`）M1.5a 不产出，reader 也不解释（M1.5b 再加）。
 */

const PT_PER_MM_LOCAL = 72 / 25.4;

export interface SegmentMm {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  widthMm: number;
}

export interface TextRun {
  /** baseline 左基点 x（毫米，已逆翻转 IR 坐标）。 */
  x: number;
  /** baseline 左基点 y（毫米，已逆翻转 IR 坐标）。 */
  y: number;
  /** Identity-H 的 2 字节 GID 十六进制串（不含尖括号），reader 不解码，交给字体。 */
  hex: string;
}

export interface ParsedPage {
  mediaBoxMm: [number, number, number, number];
  segments: SegmentMm[];
  textRuns: TextRun[];
}

export interface ParsedPdf {
  version: string;
  pages: ParsedPage[];
}

function decode(bytes: Uint8Array): string {
  // latin1：每字节 1:1 映射成字符，字符串下标 == 字节偏移，便于核对 xref。
  return new TextDecoder('latin1').decode(bytes);
}

export function parsePdf(bytes: Uint8Array): ParsedPdf {
  const text = decode(bytes);

  // 头部版本
  const hdr = /%PDF-(\d\.\d)/.exec(text);
  if (!hdr) throw new Error('不是合法 PDF：缺少 %PDF- 头');
  const version = hdr[1]!;

  // startxref
  const sx = /startxref\s+(\d+)/.exec(text);
  if (!sx) throw new Error('不是合法 PDF：缺少 startxref');
  const xrefStart = Number(sx[1]);

  // xref 表
  const xrefSec = text.slice(xrefStart);
  const xrefLines = xrefSec.split('\n');
  const count = Number(xrefLines[1]!.split(' ')[1]);
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) {
    const entry = xrefLines[2 + i]!;
    offsets[i] = Number(entry.slice(0, 10));
  }

  // 按 xref 偏移取对象正文（"N 0 obj" 到 "endobj" 之前）
  const objects: Record<number, string> = {};
  for (let num = 1; num < count; num++) {
    const seg = text.slice(offsets[num]!);
    const end = seg.indexOf('endobj');
    if (end < 0) throw new Error(`对象 ${num} 缺少 endobj`);
    objects[num] = seg.slice(0, end);
  }

  // 目录 → 页树
  const catalog = objects[1]!;
  const pagesRef = /Pages (\d+) 0 R/.exec(catalog);
  if (!pagesRef) throw new Error('目录缺少 /Pages');
  const pagesObj = objects[Number(pagesRef[1])]!;
  const kids = /Kids \[([^\]]*)\]/.exec(pagesObj)![1]!
    .match(/(\d+) 0 R/g)!
    .map((r) => Number(r.replace(' 0 R', '')));

  const pages: ParsedPage[] = [];
  for (const kid of kids) {
    const pageObj = objects[kid]!;
    const mb = /MediaBox \[([^\]]*)\]/.exec(pageObj)![1]!.split(/\s+/).map(Number);
    const wpt = mb[2]!;
    const hpt = mb[3]!;
    const mediaBoxMm: [number, number, number, number] = [
      mb[0]!,
      mb[1]!,
      wpt / PT_PER_MM_LOCAL,
      hpt / PT_PER_MM_LOCAL,
    ];
    const contentRef = /Contents (\d+) 0 R/.exec(pageObj);
    if (!contentRef) throw new Error(`页 ${kid} 缺少 /Contents`);
    const contentObj = objects[Number(contentRef[1])]!;
    const cs = contentObj.indexOf('stream');
    const ce = contentObj.indexOf('endstream');
    let start = cs + 'stream'.length;
    if (contentObj[start] === '\n') start++;
    else if (contentObj[start] === '\r') start += 2;
    const stream = contentObj.slice(start, ce);

    pages.push({
      mediaBoxMm,
      segments: interpret(stream, hpt / PT_PER_MM_LOCAL),
      textRuns: interpretText(stream, hpt / PT_PER_MM_LOCAL),
    });
  }

  return { version, pages };
}

interface State {
  widthPt: number;
  cp: { x: number; y: number } | null;
  start: { x: number; y: number } | null;
}

function interpret(content: string, heightMm: number): SegmentMm[] {
  const tokens = content.match(/[A-Za-z]+|-?\d+\.?\d*|\/[\w]+|\[|\]/g) ?? [];
  const segs: SegmentMm[] = [];
  const stack: State[] = [];
  let st: State = { widthPt: 0, cp: null, start: null };

  const toMm = (x: number, y: number): { x: number; y: number } => ({
    x: x / PT_PER_MM_LOCAL,
    y: heightMm - y / PT_PER_MM_LOCAL, // 逆翻转：PDF 点 → IR 毫米
  });

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === 'q') {
      stack.push({ ...st });
      i++;
    } else if (t === 'Q') {
      st = stack.pop() ?? st;
      i++;
    } else if (t === 'w') {
      // `w` 的操作数是它**前面**那个数（`<num> w`）
      st.widthPt = Number(tokens[i - 1]);
      i++;
    } else if (t === 'd') {
      i++; // 虚线数组已被 `[` 分支解析、相位已被 else 跳过，这里只过算子
    } else if (t === '[') {
      i++; // 虚线数组在 writer 已写成 `[] 0 d`，这里收集到 `]`
      while (tokens[i] !== ']') i++;
      i++;
    } else if (t === 'RG' || t === 'rg') {
      i++; // 3 个颜色数已被 else 跳过，这里只过算子
    } else if (t === 'cm') {
      i++; // M1.5a 不产 cm，纯防御（6 个数已被 else 跳过）
    } else if (t === 'm') {
      const x = Number(tokens[i + 1]);
      const y = Number(tokens[i + 2]);
      st.cp = { x, y };
      st.start = { x, y };
      i += 3;
    } else if (t === 'l') {
      const x = Number(tokens[i + 1]);
      const y = Number(tokens[i + 2]);
      if (st.cp) {
        const a = toMm(st.cp.x, st.cp.y);
        const b = toMm(x, y);
        segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, widthMm: st.widthPt / PT_PER_MM_LOCAL });
      }
      st.cp = { x, y };
      i += 3;
    } else if (t === 'h') {
      if (st.cp && st.start) {
        const a = toMm(st.cp.x, st.cp.y);
        const b = toMm(st.start.x, st.start.y);
        segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, widthMm: st.widthPt / PT_PER_MM_LOCAL });
      }
      st.cp = st.start;
      i++;
    } else if (t === 're') {
      const x = Number(tokens[i + 1]);
      const y = Number(tokens[i + 2]);
      const w = Number(tokens[i + 3]);
      const h = Number(tokens[i + 4]);
      const c: [number, number][] = [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ];
      for (let k = 0; k < 4; k++) {
        const a = toMm(c[k]![0], c[k]![1]);
        const b = toMm(c[(k + 1) % 4]![0], c[(k + 1) % 4]![1]);
        segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, widthMm: st.widthPt / PT_PER_MM_LOCAL });
      }
      i += 5;
    } else {
      i++; // S/s/f/F/B/b/n 等描边/填充算子：线段已在 l/h/re 时记下了，这里跳过
    }
  }
  return segs;
}

/**
 * 抽文字 run（BT…Tj/TJ…ET）。独立实现，不引用 `../src/font.ts`：只把 Identity-H 的
 * `<GIDhex>` 原样记下（连同baseline 左基点，mm），解码交回字体做 —— 这样 reader 与
 * writer 不在「解码」这件事上共享同一份代码，往返校验才不「绿得虚假」。
 */
function interpretText(content: string, heightMm: number): TextRun[] {
  const tokens = content.match(/[A-Za-z]+|-?\d+\.?\d*|\/[\w]+|\[|\]|<[0-9A-Fa-f]*>/g) ?? [];
  const runs: TextRun[] = [];
  let tx = 0;
  let ty = 0;
  let inText = false;

  const toRun = (hx: string): TextRun => ({
    x: tx / PT_PER_MM_LOCAL,
    y: heightMm - ty / PT_PER_MM_LOCAL, // 逆翻转
    hex: hx.replace(/^<|>$/g, ''),
  });

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === 'BT') {
      tx = 0;
      ty = 0;
      inText = true;
      i++;
    } else if (t === 'ET') {
      inText = false;
      i++;
    } else if (t === 'Tm') {
      // `a b c d e f Tm`：平移量 = (e, f) = 末两个数
      tx = Number(tokens[i - 2]);
      ty = Number(tokens[i - 1]);
      i++;
    } else if (t === 'Td') {
      tx += Number(tokens[i - 2]);
      ty += Number(tokens[i - 1]);
      i++;
    } else if (t === 'Tj') {
      const hx = tokens[i - 1]!;
      if (inText && hx.startsWith('<')) runs.push(toRun(hx));
      i++;
    } else if (t === 'TJ') {
      // `[ ... ] TJ`：从匹配的 `]` 回退到 `[`，拼起所有 `<hex>` 段（忽略字距数）。
      let j = i - 1;
      while (j >= 0 && tokens[j] !== '[') j--;
      let hx = '';
      for (let k = j + 1; k < i - 1; k++) {
        if (tokens[k]!.startsWith('<')) hx += tokens[k]!.slice(1, -1);
      }
      if (inText && hx) runs.push(toRun(hx));
      i++;
    } else {
      i++;
    }
  }
  return runs;
}
