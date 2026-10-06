/**
 * 内嵌子集 CFF 字体解析（M1.5b）。
 *
 * 它吃什么：一份 CID-keyed 的 OTF（思源黑体子集，见 `assets/noto-sans-sc.subset.otf`，
 * SIL OFL 授权，可随仓库分发）。
 *
 * 它产什么：一个 `PdfFont` —— 把图面 `text` op 里的字符编码成 PDF 的 Identity-H 字节流、
 * 同时给出 `/W` 字宽数组与裸 CFF 字节（塞进 `/FontFile3`），让 writer 能产出**真·可渲染**
 * 的中文 PDF。
 *
 * **为什么用 `/CIDToGIDMap /Identity`（不解析 CFF 内部 CID→GID charset）：**
 * 这份子集是 CID-keyed CFF（ROS = `Adobe-Identity-0`），字形顺序即 GID 顺序
 * （`CharStrings` INDEX 第 g 项 = 字形序 g）。PDF 规定 CIDFontType0C 一旦声明
 * `/CIDToGIDMap /Identity`，就把编码字节直接当 GID 用、跳过 CFF 内部的 charset 映射。
 * 于是「编码字节 = GID」、字宽数组按 GID 排、`cmap` 直接给 GID —— 整个解析器只需读
 * `cmap`(u2g) + `hmtx`(字宽) + `head`(em/bbox) + 裸 CFF 字节，**不必碰 CFF charset**，
 * 后端自包含、可独立单测。
 *
 * 裸 CFF 字节即 `CFF ` 表本体（含 CIDFontType0C 所需的全部信息），writer 直接放进
 * `/FontFile3` stream。
 */

const NOTDEF = 0;

interface TableLoc {
  readonly offset: number;
  readonly length: number;
}

function u16(b: Uint8Array, p: number): number {
  return (b[p]! << 8) | b[p + 1]!;
}
function u32(b: Uint8Array, p: number): number {
  return ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0;
}
/** 有符号 16 位（bbox 等可能是负数，需符号扩展）。 */
function i16(b: Uint8Array, p: number): number {
  const v = (b[p]! << 8) | b[p + 1]!;
  return v >= 0x8000 ? v - 0x10000 : v;
}

export interface PdfFont {
  /** PDF 里用的字体名（ASCII，无空格）。 */
  readonly baseName: string;
  /** 字体 em 单位（思源 = 1000）。字宽数组基于此。 */
  readonly unitsPerEm: number;
  /** 字体设计 bbox（字体单位）。用于 FontDescriptor /FontBBox。 */
  readonly bbox: readonly [number, number, number, number];
  /** 裸 CFF 表字节，直接塞进 `/FontFile3`。 */
  readonly cff: Uint8Array;
  /** 码点 → GID。字形序即 GID 序。 */
  readonly u2g: ReadonlyMap<number, number>;
  /** 每个 GID 的 advance 宽度（字体单位，=unitsPerEm 制）。 */
  readonly widthByGid: readonly number[];
  /** 字形总数。 */
  readonly numGlyphs: number;
  /** 把 JS 字符串编码成 Identity-H 的 2 字节 GID 十六进制串（无空格）。未收录字 → .notdef(0)。 */
  encode(s: string): string;
  /** 把 Identity-H 的 2 字节 GID 十六进制串解回字符串（reader 往返校验用）。 */
  decode(hex: string): string;
  /** `/W` 数组体（按 GID 排）：`0 [w0 w1 ... wN]`。 */
  wArray(): string;
}

/** 读 sfnt 目录，返回每个表名 → (文件内偏移, 长度)。 */
function sfntDir(b: Uint8Array): Map<string, TableLoc> {
  // 头: sfntVersion(4) + numTables(2) + (searchRange,entrySelector,rangeShift 各2)
  const numTables = u16(b, 4);
  const map = new Map<string, TableLoc>();
  const base = 12;
  for (let i = 0; i < numTables; i++) {
    const rec = base + i * 16;
    const tag = String.fromCharCode(b[rec]!, b[rec + 1]!, b[rec + 2]!, b[rec + 3]!);
    map.set(tag, { offset: u32(b, rec + 8), length: u32(b, rec + 12) });
  }
  return map;
}

/** 解析 cmap —— 优先 (3,1) Windows BMP，退回 (0,*) Unicode；支持 format 4 / 12。返回码点→GID。 */
function parseCmap(b: Uint8Array, loc: TableLoc): Map<number, number> {
  const cmap = b.subarray(loc.offset, loc.offset + loc.length);
  const nsub = u16(cmap, 2);
  let subOff: number | null = null;
  let fallback: number | null = null;
  for (let i = 0; i < nsub; i++) {
    const rec = 4 + i * 8;
    const pid = u16(cmap, rec);
    const eid = u16(cmap, rec + 2);
    const off = u32(cmap, rec + 4); // 子表偏移是 uint32
    if (pid === 3 && eid === 1) subOff = off;
    if (pid === 0 && fallback === null) fallback = off;
  }
  const off = subOff ?? fallback;
  if (off === null) throw new Error('cmap 缺少可用的子表 (platform 3/1 或 0/*)');
  const fmt = u16(cmap, off);
  const out = new Map<number, number>();
  if (fmt === 4) {
    const segCount = u16(cmap, off + 6) / 2;
    const endBase = off + 14;
    const startBase = off + 16 + 2 * segCount;
    const deltaBase = off + 16 + 4 * segCount;
    const roBase = off + 16 + 6 * segCount;
    for (let i = 0; i < segCount; i++) {
      const start = u16(cmap, startBase + i * 2);
      const end = u16(cmap, endBase + i * 2);
      const delta = u16(cmap, deltaBase + i * 2);
      const ro = u16(cmap, roBase + i * 2);
      if (start === 0xffff && end === 0xffff) continue; // 终止段
      for (let cp = start; cp <= end; cp++) {
        let gid: number;
        if (ro === 0) {
          gid = (cp + delta) & 0xffff;
        } else {
          const addr = roBase + i * 2 + ro + 2 * (cp - start);
          const g = u16(cmap, addr);
          gid = g === 0 ? 0 : (g + delta) & 0xffff;
        }
        out.set(cp, gid);
      }
    }
  } else if (fmt === 12) {
    // format 12: nGroups(4) + [startCode(4), endCode(4), startGID(4)]*
    const nGroups = u32(cmap, off + 12);
    let p = off + 16;
    for (let i = 0; i < nGroups; i++) {
      const start = u32(cmap, p);
      const end = u32(cmap, p + 4);
      const gid0 = u32(cmap, p + 8);
      for (let cp = start; cp <= end; cp++) out.set(cp, gid0 + (cp - start));
      p += 12;
    }
  } else {
    throw new Error(`cmap 子表 format ${fmt} 暂不支持（仅 4/12）`);
  }
  return out;
}

/** 解析 hmtx + hhea，给出每个 GID 的 advance 宽度（字体单位）。 */
function parseHmtx(b: Uint8Array, hhea: TableLoc, hmtx: TableLoc, numGlyphs: number): number[] {
  const nH = u16(b.subarray(hhea.offset, hhea.offset + hhea.length), 34);
  const h = b.subarray(hmtx.offset, hmtx.offset + hmtx.length);
  const adv: number[] = [];
  for (let i = 0; i < nH; i++) adv.push(u16(h, i * 4));
  const last = adv.length ? adv[adv.length - 1]! : 0;
  while (adv.length < numGlyphs) adv.push(last);
  return adv;
}

export function loadSubsetFont(bytes: Uint8Array, baseName = 'NotoSansSC'): PdfFont {
  const tables = sfntDir(bytes);
  const need = ['cmap', 'hmtx', 'hhea', 'head', 'CFF ', 'maxp'];
  for (const t of need) if (!tables.has(t)) throw new Error(`字体缺少必需表 ${t}`);

  const head = tables.get('head')!;
  const headB = bytes.subarray(head.offset, head.offset + head.length);
  const unitsPerEm = u16(headB, 18);
  const bbox: [number, number, number, number] = [
    i16(headB, 36),
    i16(headB, 38),
    i16(headB, 40),
    i16(headB, 42),
  ];

  const maxp = tables.get('maxp')!;
  const numGlyphs = u16(bytes.subarray(maxp.offset, maxp.offset + maxp.length), 4);

  const u2g = parseCmap(bytes, tables.get('cmap')!);
  const widthByGid = parseHmtx(bytes, tables.get('hhea')!, tables.get('hmtx')!, numGlyphs);

  const cffLoc = tables.get('CFF ')!;
  const cff = bytes.subarray(cffLoc.offset, cffLoc.offset + cffLoc.length);

  // 反向映射 GID→码点（reader 往返用）
  const gid2u = new Map<number, number>();
  for (const [cp, gid] of u2g) if (!gid2u.has(gid)) gid2u.set(gid, cp);

  const encode = (s: string): string => {
    let hex = '';
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      const gid = u2g.get(cp) ?? NOTDEF;
      hex += gid.toString(16).padStart(4, '0');
    }
    return hex;
  };
  const decode = (hex: string): string => {
    let out = '';
    for (let i = 0; i + 4 <= hex.length; i += 4) {
      const gid = parseInt(hex.slice(i, i + 4), 16);
      const cp = gid2u.get(gid);
      out += cp === undefined ? '�' : String.fromCodePoint(cp);
    }
    return out;
  };
  const wArray = (): string => {
    const ws = widthByGid.map((w) => w.toString(10)).join(' ');
    return `0 [${ws}]`;
  };

  return {
    baseName,
    unitsPerEm,
    bbox,
    cff: cff.slice(),
    u2g,
    widthByGid,
    numGlyphs,
    encode,
    decode,
    wArray,
  };
}
