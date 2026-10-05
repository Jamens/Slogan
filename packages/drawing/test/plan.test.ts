import { describe, expect, it } from 'vitest';
import { Document, type EntityId } from '@dajia/core';
import { PAPER_LAYERS, type PaperOp } from '../src/ir';
import { THICKEST } from '../src/linetypes';
import { planSheet, wallPiecesOf } from '../src/plan';

const PID = '0193bb00-0000-7000-8000-00000000000a' as EntityId;
const STOREY = '0193bb00-0000-7000-8000-00000000000b' as EntityId;
const P1 = '0193bb00-0000-7000-8000-00000000000c' as EntityId;
const P2 = '0193bb00-0000-7000-8000-00000000000d' as EntityId;

/**
 * 一层一堵 3600 长、240 厚的墙，墙上一门一窗。
 *
 * 夹具照 plan5 §四 P1 走 core 的现物：**用命令建**而不是手搓实体 ——
 * 洞口的几何由 `clampOpeningsToWall` 那些命令算出来，drawing 侧只读结果。
 */
function oneWallHouse(): Document {
  return Document.replaceEntities(
    Document.create(PID),
    new Map([
        [
          STOREY,
          {
            kind: 'storey' as const,
            id: STOREY,
            projectId: PID,
            index: 0,
            elevationMm: 0,
            heightMm: 3000,
          },
        ],
        [P1, { kind: 'point' as const, id: P1, storeyId: STOREY, x: 0, y: 0 }],
        [P2, { kind: 'point' as const, id: P2, storeyId: STOREY, x: 3600, y: 0 }],
        [
          '0193bb00-0000-7000-8000-00000000000e' as EntityId,
          {
            kind: 'wall' as const,
            id: '0193bb00-0000-7000-8000-00000000000e' as EntityId,
            storeyId: STOREY,
            startId: P1,
            endId: P2,
            thicknessMm: 240,
            heightMm: 3000,
            elevationOffsetMm: 0,
            loadBearing: true,
            material: '砖',
          },
        ],
    ]),
  );
}

const WALL = '0193bb00-0000-7000-8000-00000000000e' as EntityId;

describe('plan：墙投影直接取 core 的 corners，不自己算轮廓（P1）', () => {
  it('P1 墙的纸面多边形逐字节来自 deriveStoreyGeometry 的 corners 投影', () => {
    const doc = oneWallHouse();
    const sheet = planSheet(doc, { storeyId: STOREY, title: '一层', drafter: '搭家', sheetNo: 'A-101' });
    // 至少产出面墙的图元
    const structureOps = sheet.ops.filter((o) => o.pen.layer === 'structure');
    expect(structureOps.length).toBeGreaterThan(0);
    // **2026-10-06 实测订正**：这堵墙沿 x 方向，法向是 y ⇒ 240 的厚度落在 **y** 上，
    // 不落在 x 跨度上。x 跨度就是 3600/100 = 36 纸面 mm。
    // （我第一版写的 38.4 是把厚度加到了错误的轴上 —— 实现一直是对的。）
    const xs = structureOps.flatMap((o) => xyOf(o).map((p) => p.x));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(36, 2);
    // 厚度那一侧：240/100 = 2.4 纸面 mm
    const ys = structureOps.flatMap((o) => xyOf(o).map((p) => p.y));
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2.4, 2);
  });

  it('P6 柱与板进 structure 层（本计划不画它们到别的层去）', () => {
    const doc = oneWallHouse();
    const sheet = planSheet(doc, { storeyId: STOREY, title: '一层', drafter: '搭家', sheetNo: 'A-101' });
    // 无柱无板时 structure 里只有那堵墙的图元；本格钉住"层归属"这件事
    for (const op of sheet.ops) {
      if (op.kind === 'polygon') expect(op.pen.layer).toBe('structure');
    }
  });

  it('P7 产出图元的层单调不减，且不越 PAPER_LAYERS 的界', () => {
    const doc = oneWallHouse();
    const sheet = planSheet(doc, { storeyId: STOREY, title: '一层', drafter: '搭家', sheetNo: 'A-101' });
    const idx = sheet.ops.map((o) => PAPER_LAYERS.indexOf(o.pen.layer));
    for (const i of idx) expect(i).toBeGreaterThanOrEqual(0);
    // 单调不减：后画的压在上面，所以层号不许往回走
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i]).toBeGreaterThanOrEqual(idx[i - 1]!);
    }
    // **2026-10-06 变异实测补的缺口**：只钉"单调不减"不够 —— 把墙身也标成
    // annotation 时序列是 [4,4,4,4]，**仍然单调**，而图已经错了（结构层空着）。
    // 所以这一格还要钉住"**structure 层必须有图元**"（一堵墙至少产一块），
    // 否则"忘了分层"这一型会静默通过。
    expect(sheet.ops.filter((o) => o.pen.layer === 'structure').length).toBeGreaterThan(0);
    // 且 `frame` 与 `section` 在本模块**不许**出现（那是 T6 / T7 的活）
    for (const op of sheet.ops) {
      expect(op.pen.layer === 'frame' || op.pen.layer === 'section').toBe(false);
    }
  });

  it('P10 空层产出空图元列表，不抛', () => {
    const doc = oneWallHouse();
    // 一个**没有墙**的楼层：另起一个 storeyId，派生返回 0 面墙
    const EMPTY = '0193bb00-0000-7000-8000-0000000000ff' as EntityId;
    const withEmpty = Document.replaceEntities(
      doc,
      new Map([
        ...doc.entities,
        [
          EMPTY,
          { kind: 'storey' as const, id: EMPTY, projectId: PID, index: 1, elevationMm: 3000, heightMm: 3000 },
        ],
      ]),
    );
    const sheet = planSheet(withEmpty, {
      storeyId: EMPTY,
      title: '空层',
      drafter: '搭家',
      sheetNo: 'A-102',
    });
    // 允许只有图框/标题栏那点东西，但**不许有一面墙的图元**
    const structure = sheet.ops.filter((o) => o.pen.layer === 'structure');
    expect(structure).toEqual([]);
    // 且不抛 —— 这一格的全部内容就是"没有它会红"
  });
});

describe('plan：墙身拆块吃 core 的 pieces，不自己算（P2 / P3）', () => {
  it('P3 一堵墙上一门一窗 ⇒ 墙身拆成 3 块（core 的 pieces 是唯一产地）', () => {
    const doc = withDoorAndWindow();
    // **这一格是"不写第二份几何派生"的证据**：`wallPiecesOf` 直接转发 core 的
    // `deriveStoreyGeometry(doc, storeyId).pieces`，它自己一个数都不算。
    const pieces = wallPiecesOf(doc, STOREY, WALL);
    // 门 @500 宽 900 ⇒ 占 [500,1400]；窗 @1800 宽 1200 ⇒ 占 [1800,3000]。
    // 实心段是**洞口之间的空隙**：[0,500] 门前的、[1400,1800] 门与窗之间、
    // [3000,3600] 窗后的。**2026-10-06 实测**（我第一版把门后的空隙当成了
    // 整段 [500,1400]，那是我的算术错 —— core 的分段一直是对的）。
    expect(pieces.map((p) => [p.fromMm, p.toMm])).toEqual([
      [0, 500],
      [1400, 1800],
      [3000, 3600],
    ]);
  });

  it('P2 洞口在墙上是留白（不产"洞的轮廓线"那类图元）', () => {
    const doc = withDoorAndWindow();
    const pieces = wallPiecesOf(doc, STOREY, WALL);
    // 三段实心 = 三个多边形；洞口占的区间**不**被画成闭合的洞框
    const sheet = planSheet(doc, { storeyId: STOREY, title: '一层', drafter: '搭家', sheetNo: 'A-101' });
    const wallPolys = sheet.ops.filter(
      (o) => o.kind === 'polygon' && o.pen.layer === 'structure' && xyOf(o).length === 4,
    );
    // 洞口留白 ⇒ 墙身是三块实心多边形，而不是一整块 + 一个洞轮廓。
    // **图元数与 core 的分段数一一对应**：这一句是"图上画出来的块数没有第二份
    // 算术"的证据 —— 若 plan.ts 自己按洞口算块，两者在洞口贴墙端那种边界上
    // 就会差一格（core 不产零长空壳，自算的那份未必）。
    expect(pieces).toHaveLength(3);
    expect(wallPolys).toHaveLength(3);
  });

  it('P5 洞口越界在 drawing 侧响亮地抛，且文案点名宿主墙与洞口', () => {
    // core 的 `piecesFromSpans` → `assertSpansFit` 已经在同一条路径上抛了，
    // 所以 drawing 侧**不需要重算一遍**（plan5 §四 P5 的注释就是这么写的：
    // "core 的不变式，drawing 不许重算"）。本格钉的是"错误会冒到调用方"，
    // 也就是接线没把 core 抛的东西吞掉。
    const doc = withOverreachingOpening();
    expect(() => wallPiecesOf(doc, STOREY, WALL)).toThrow();
  });

  it('P3 边界：洞口正压墙端时不产零长空壳（core 的口径原样透出）', () => {
    // `piecesFromSpans` 明确"零长段跳过，不产空壳"。本格钉住 drawing 侧照原样透出，
    // 而不是自己补一个 [3600,3600] 的退化多边形。
    const doc = withOpeningAtWallEnd();
    const pieces = wallPiecesOf(doc, STOREY, WALL);
    for (const p of pieces) {
      expect(p.toMm).toBeGreaterThan(p.fromMm);
    }
  });
});

describe('plan：图面的其余内容（P8）', () => {
  it('P8 楼层标高文字取 StoreyEntity.elevationMm，且落在 annotation 层', () => {
    const doc = oneWallHouse();
    const sheet = planSheet(doc, { storeyId: STOREY, title: '一层', drafter: '搭家', sheetNo: 'A-101' });
    const texts = sheet.ops.filter((o) => o.kind === 'text');
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) {
      if (t.kind === 'text') expect(t.pen.layer).toBe('annotation');
    }
    // 标高那一条写的是层高（0mm ⇒ 纸面 0）
    const elev = texts.find((t) => t.kind === 'text' && t.s.includes('±'));
    if (elev && elev.kind === 'text') expect(elev.s).toContain('0.00');
  });

  it('T8 同 doc 同参数连跑两次，图元逐字节相同（IR 快照层的稳定性）', () => {
    const doc = withDoorAndWindow();
    const a = planSheet(doc, { storeyId: STOREY, title: '一层', drafter: '搭家', sheetNo: 'A-101' });
    const b = planSheet(doc, { storeyId: STOREY, title: '一层', drafter: '搭家', sheetNo: 'A-101' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('线宽只取线型表的档（墙身用 solid 的默认档 0.5）', () => {
    const doc = oneWallHouse();
    const sheet = planSheet(doc, { storeyId: STOREY, title: '一层', drafter: '搭家', sheetNo: 'A-101' });
    const widths = new Set(sheet.ops.map((o) => o.pen.widthMm));
    // 全部落在五档之内
    for (const w of widths) expect([0.18, 0.25, 0.35, 0.5, 0.7]).toContain(w);
    // 且最粗的那档只留给图框
    expect(widths.has(THICKEST)).toBe(false);
  });
});

// —— 夹具助手 ——————————————————————————————————————————————

function xyOf(op: PaperOp): { x: number; y: number }[] {
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

/** 一堵墙上一门（@500，宽 900）一窗（@1800，宽 1200）。 */
function withDoorAndWindow(): Document {
  const base = oneWallHouse();
  return Document.replaceEntities(
    base,
    new Map([
      ...base.entities,
      [
        '0193bb00-0000-7000-8000-000000000010' as EntityId,
        {
          kind: 'opening' as const,
          id: '0193bb00-0000-7000-8000-000000000010' as EntityId,
          storeyId: STOREY,
          hostWallId: WALL,
          distanceMm: 500,
          widthMm: 900,
          heightMm: 2100,
          sillMm: 0,
          category: 'door' as const,
        },
      ],
      [
        '0193bb00-0000-7000-8000-000000000011' as EntityId,
        {
          kind: 'opening' as const,
          id: '0193bb00-0000-7000-8000-000000000011' as EntityId,
          storeyId: STOREY,
          hostWallId: WALL,
          distanceMm: 1800,
          widthMm: 1200,
          heightMm: 1500,
          sillMm: 900,
          category: 'window' as const,
        },
      ],
    ]),
  );
}

/** 一个伸到墙外的门：@3400 宽 900 ⇒ 到 4300 > 3600。 */
function withOverreachingOpening(): Document {
  const base = oneWallHouse();
  return Document.replaceEntities(
    base,
    new Map([
      ...base.entities,
      [
        '0193bb00-0000-7000-8000-000000000012' as EntityId,
        {
          kind: 'opening' as const,
          id: '0193bb00-0000-7000-8000-000000000012' as EntityId,
          storeyId: STOREY,
          hostWallId: WALL,
          distanceMm: 3400,
          widthMm: 900,
          heightMm: 2100,
          sillMm: 0,
          category: 'door' as const,
        },
      ],
    ]),
  );
}

/** 洞口正压墙尾：@2700 宽 900 ⇒ 到 3600 恰好墙尾 ⇒ 末段零长。 */
function withOpeningAtWallEnd(): Document {
  const base = oneWallHouse();
  return Document.replaceEntities(
    base,
    new Map([
      ...base.entities,
      [
        '0193bb00-0000-7000-8000-000000000013' as EntityId,
        {
          kind: 'opening' as const,
          id: '0193bb00-0000-7000-8000-000000000013' as EntityId,
          storeyId: STOREY,
          hostWallId: WALL,
          distanceMm: 2700,
          widthMm: 900,
          heightMm: 2100,
          sillMm: 0,
          category: 'door' as const,
        },
      ],
    ]),
  );
}
