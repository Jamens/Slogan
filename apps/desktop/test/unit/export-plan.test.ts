import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Document, type Entity, type EntityId } from '@dajia/core';
import { type ClipLine } from '@dajia/drawing';
import { exportPlan, type ExportPlanOptions } from '../../src/main/draw/export-plan';

const PID = '0193bb00-0000-7000-8000-0000000000e1' as EntityId;
const STOREY = '0193bb00-0000-7000-8000-0000000000e2' as EntityId;
const P1 = '0193bb00-0000-7000-8000-0000000000e3' as EntityId;
const P2 = '0193bb00-0000-7000-8000-0000000000e4' as EntityId;
const W1 = '0193bb00-0000-7000-8000-0000000000e5' as EntityId;
const P3 = '0193bb00-0000-7000-8000-0000000000e6' as EntityId;
const P4 = '0193bb00-0000-7000-8000-0000000000e7' as EntityId;
const W2 = '0193bb00-0000-7000-8000-0000000000e8' as EntityId;
const S1 = '0193bb00-0000-7000-8000-0000000000e9' as EntityId;
const P5 = '0193bb00-0000-7000-8000-0000000000eb' as EntityId;
const P6 = '0193bb00-0000-7000-8000-0000000000ec' as EntityId;
const S2 = '0193bb00-0000-7000-8000-0000000000ea' as EntityId;

/** 一栋两堵墙 + 两块板的一层。reverseInsertion 时实体的 Map 插入序倒序（E4 用）。 */
function buildHouse(reverseInsertion = false): Document {
  const entries: Array<[EntityId, Entity]> = [
    [STOREY, { kind: 'storey' as const, id: STOREY, projectId: PID, index: 0, elevationMm: 0, heightMm: 3000 }],
    [P1, { kind: 'point' as const, id: P1, storeyId: STOREY, x: 0, y: 0 }],
    [P2, { kind: 'point' as const, id: P2, storeyId: STOREY, x: 3600, y: 0 }],
    [W1, { kind: 'wall' as const, id: W1, storeyId: STOREY, startId: P1, endId: P2, thicknessMm: 240, heightMm: 3000, elevationOffsetMm: 0, loadBearing: true, material: '砖' }],
    [P3, { kind: 'point' as const, id: P3, storeyId: STOREY, x: 0, y: 4000 }],
    [P4, { kind: 'point' as const, id: P4, storeyId: STOREY, x: 3600, y: 4000 }],
    [W2, { kind: 'wall' as const, id: W2, storeyId: STOREY, startId: P3, endId: P4, thicknessMm: 240, heightMm: 3000, elevationOffsetMm: 0, loadBearing: true, material: '砖' }],
    [S1, { kind: 'slab' as const, id: S1, storeyId: STOREY, thicknessMm: 100, elevationOffsetMm: 0, boundaryPointIds: [P1, P2, P4, P3] }],
    [P5, { kind: 'point' as const, id: P5, storeyId: STOREY, x: 0, y: 2000 }],
    [P6, { kind: 'point' as const, id: P6, storeyId: STOREY, x: 3600, y: 2000 }],
    [S2, { kind: 'slab' as const, id: S2, storeyId: STOREY, thicknessMm: 100, elevationOffsetMm: 0, boundaryPointIds: [P1, P2, P6, P5] }],
  ];
  if (reverseInsertion) entries.reverse();
  return Document.replaceEntities(Document.create(PID), new Map(entries));
}

const OPTS: ExportPlanOptions = {
  storeyId: STOREY,
  title: '一层',
  drafter: '搭家',
  sheetNo: 'A-101',
  date: '2026-10-06',
};

/** 横向剖切线（纸面 mm），穿过两堵墙与板。 */
const CLIP: ClipLine = { a: { x: -50, y: 0 }, b: { x: 50, y: 0 } };

function tmpPdf(): string {
  return join(tmpdir(), `export-${Math.random().toString(36).slice(2)}.pdf`);
}
function exportBytes(doc: Document, opts: ExportPlanOptions): Buffer {
  const p = tmpPdf();
  exportPlan(doc, opts, p);
  return readFileSync(p);
}

describe('T8 导出出口（E1–E4）', () => {
  it('E1 出口是纯函数 + fs 参数，不 import electron，字体/写盘走 pdf 与 node:fs', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../src/main/draw/export-plan.ts', import.meta.url)),
      'utf8',
    );
    // 不对称是有意的：导出本就要碰盘（writeFileSync），但绝不认识 electron。
    expect(src.includes("from 'electron'")).toBe(false);
    expect(src.includes('writeFileSync')).toBe(true);
    expect(src.includes('loadDefaultFont')).toBe(true);
  });

  it('E2 同 doc + 同 opts 连跑两次，字节逐字相同', () => {
    const doc = buildHouse();
    const a = exportBytes(doc, OPTS);
    const b = exportBytes(doc, OPTS);
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it('E3 日期/设计人是入参：改 date 字节就变（不是 new Date 常量），且源码不取运行时值', () => {
    const doc = buildHouse();
    const a = exportBytes(doc, OPTS);
    const c = exportBytes(doc, { ...OPTS, date: '2026-10-07' });
    expect(Buffer.compare(a, c)).not.toBe(0);
    // 反向判据：源码里若偷偷 new Date() / os.userInfo()，E2 会红且这行抓得到。
    const src = readFileSync(
      fileURLToPath(new URL('../../src/main/draw/export-plan.ts', import.meta.url)),
      'utf8',
    );
    expect(src.includes('new Date()')).toBe(false);
    expect(src.includes('os.userInfo')).toBe(false);
  });

  it('E4 实体排序按 id 稳定，不随 Map 插入序漂（插入序倒序 → 仍逐字相同）', () => {
    const a = exportBytes(buildHouse(false), OPTS);
    const b = exportBytes(buildHouse(true), OPTS);
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it('X8 给了剖切线 ⇒ 导出两页（平面图 + 剖切轮廓），字节仍稳定', () => {
    const doc = buildHouse();
    const one = exportBytes(doc, OPTS);
    const two = exportBytes(doc, { ...OPTS, clipLine: CLIP });
    // 两页 PDF 比单页长（多了剖切轮廓那一页的对象/内容流）。
    expect(two.length).toBeGreaterThan(one.length);
    // 且同输入复现。
    const twoAgain = exportBytes(doc, { ...OPTS, clipLine: CLIP });
    expect(Buffer.compare(two, twoAgain)).toBe(0);
  });
});
