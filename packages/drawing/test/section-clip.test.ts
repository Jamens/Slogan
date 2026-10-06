import { describe, expect, it } from 'vitest';
import { Document, type Entity, type EntityId } from '@dajia/core';
import { type PaperOp, type PaperVec2, type Sheet } from '../src';
import { clipSheet, type ClipLine } from '../src/section/clip';
import { planSheet, type PlanOptions } from '../src/plan';

const PID = '0193bb00-0000-7000-8000-0000000000a1' as EntityId;
const STOREY = '0193bb00-0000-7000-8000-0000000000a2' as EntityId;
const OPTS: PlanOptions = { storeyId: STOREY, title: '一层', drafter: '搭家', sheetNo: 'A-101' };

/**
 * 剖切线：纸面 mm，水平线 y=0（从 x=-50 到 x=50）。
 * 贯穿 RightWall（重心在右）、LeftWall（重心在左）、RightSlab（重心在右）。
 */
const HLINE: ClipLine = { a: { x: -50, y: 0 }, b: { x: 50, y: 0 } };

/**
 * 一栋含两堵墙 + 一块板的房子（纸面 mm 坐标见各实体注释，由 planSheet 的
 * mmToPaperMm(÷100) + y 取反推出）。几何只为喂给 X3–X7，不代表真实户型。
 */
function clipHouse(): Document {
  const id = (s: string) => `${PID.slice(0, 36 - 2)}${s}` as EntityId;
  const pt = (s: string, x: number, y: number): [EntityId, Entity] => [
    id(s),
    { kind: 'point' as const, id: id(s), storeyId: STOREY, x, y },
  ];
  const wall = (s: string, p1: EntityId, p2: EntityId): [EntityId, Entity] => [
    id(s),
    {
      kind: 'wall' as const,
      id: id(s),
      storeyId: STOREY,
      startId: p1,
      endId: p2,
      thicknessMm: 240,
      heightMm: 3000,
      elevationOffsetMm: 0,
      loadBearing: true,
      material: '砖',
    },
  ];
  const slab = (s: string, ids: EntityId[]): [EntityId, Entity] => [
    id(s),
    {
      kind: 'slab' as const,
      id: id(s),
      storeyId: STOREY,
      thicknessMm: 100,
      elevationOffsetMm: 0,
      boundaryPointIds: ids,
    },
  ];
  return Document.replaceEntities(
    Document.create(PID),
    new Map<EntityId, Entity>([
      [
        STOREY,
        { kind: 'storey' as const, id: STOREY, projectId: PID, index: 0, elevationMm: 0, heightMm: 3000 },
      ],
      // RightWall：轴 model y=30 ⇒ 纸面 y=-0.3（右侧），x 5..15。被 y=0 剖到。
      pt('03', 500, 30),
      pt('04', 1500, 30),
      wall('07', id('03'), id('04')),
      // LeftWall：轴 model y=-30 ⇒ 纸面 y=+0.3（左侧），x 0..10。被 y=0 剖到。
      pt('05', 0, -30),
      pt('06', 1000, -30),
      wall('08', id('05'), id('06')),
      // RightSlab：边界 model y∈[0,500] ⇒ 纸面 y∈[0,-5]，重心纸面 (0.5,-2.5)（右侧）。
      pt('09', -100, 0),
      pt('0a', 200, 0),
      pt('0b', 200, 500),
      pt('0c', -100, 500),
      slab('0d', [id('09'), id('0a'), id('0b'), id('0c')]),
    ]),
  );
}

/** 输出里所有剖切断（polyline）的坐标对列表。 */
function cutPolylines(sheet: Sheet): Array<Array<[number, number]>> {
  return sheet.ops
    .filter((o): o is Extract<PaperOp, { kind: 'polyline' }> => o.kind === 'polyline')
    .map((o) => o.pts.map((p) => [p.x, p.y] as [number, number]));
}

/** 两段是否近似相等（容差 1e-6，兜住几何求交的浮点尾差）。 */
function segClose(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => Math.abs(p[0] - b[i]![0]) < 1e-6 && Math.abs(p[1] - b[i]![1]) < 1e-6);
}
/** 剖切断集合里是否包含某段（近似）。 */
function cutsInclude(cuts: Array<Array<[number, number]>>, seg: Array<[number, number]>): boolean {
  return cuts.some((c) => segClose(c, seg));
}

/** 一条 op 的几何是否整段等于剖切线本身（X1：剖切线不该被画出来）。 */
function isClipLineDrawn(o: PaperOp, line: ClipLine): boolean {
  if (o.kind === 'line') return samePt(o.a, line.a) && samePt(o.b, line.b);
  if (o.kind === 'polyline') return o.pts.length === 2 && samePt(o.pts[0]!, line.a) && samePt(o.pts[1]!, line.b);
  return false;
}
function samePt(a: PaperVec2, b: PaperVec2): boolean {
  return a.x === b.x && a.y === b.y;
}

describe('T7 剖切轮廓：剖切线是视图状态（X1 / X2 / D1）', () => {
  it('X1+X2 剖切线不入 Document、不进 PaperOp，且 doc 调用前后逐字不变', () => {
    const doc = clipHouse();
    const before = doc.canonical();
    const sheet = clipSheet(doc, OPTS, HLINE);
    const after = doc.canonical();
    // X2：文档一个字节没动（剖切线是入参，从不写回真源）。
    expect(after).toBe(before);
    // X1：输出里没有任何 op 把剖切线本身画出来（我们只画剖切断，不画剖切线）。
    expect(sheet.ops.filter((o) => isClipLineDrawn(o, HLINE))).toEqual([]);
    // X1 续：剖切线是被消费的入参 —— 挪到一栋建筑之外的位置，剖切断数量变 0。
    const farLine: ClipLine = { a: { x: -50, y: 100 }, b: { x: 50, y: 100 } };
    expect(cutPolylines(clipSheet(doc, OPTS, farLine))).toEqual([]);
  });
});

describe('T7 剖切轮廓：求交与保留侧（X3 / X4）', () => {
  it('X3 对墙/柱/板纸面多边形求与剖切线的交段', () => {
    const doc = clipHouse();
    const cuts = cutPolylines(clipSheet(doc, OPTS, HLINE));
    // RightWall 被 y=0 剖出 [(5,0),(15,0)]。
    expect(cutsInclude(cuts, [[5, 0], [15, 0]])).toBe(true);
  });

  it('X4 只保留剖切线法向右侧的构件（左侧墙被丢弃）', () => {
    const doc = clipHouse();
    const cuts = cutPolylines(clipSheet(doc, OPTS, HLINE));
    // 右侧墙的段在；左侧墙的段 [(0,0),(10,0)] 不在。
    expect(cutsInclude(cuts, [[5, 0], [15, 0]])).toBe(true);
    expect(cutsInclude(cuts, [[0, 0], [10, 0]])).toBe(false);
  });
});

describe('T7 剖切轮廓：只轮廓不填充（X5 / X6 / D3）', () => {
  it('X5 剖到的构件输出轮廓线（polyline），不输出填充', () => {
    const doc = clipHouse();
    const sheet = clipSheet(doc, OPTS, HLINE);
    // 整张剖切图幅里没有任何填充多边形（D3）。
    expect(sheet.ops.some((o) => o.kind === 'polygon' && o.fill)).toBe(false);
    // 且所有剖切断都是 polyline（不是 polygon）。
    for (const o of sheet.ops) {
      if (o.kind === 'polyline') expect(o.kind).toBe('polyline');
    }
  });

  it('X6 楼板在平面图里是轮廓线，剖到时同样只画线（不升级成填充）', () => {
    const doc = clipHouse();
    const cuts = cutPolylines(clipSheet(doc, OPTS, HLINE));
    // RightSlab 被剖出 [(-1,0),(2,0)]，且它是 polyline（X5 的同一条纪律）。
    expect(cutsInclude(cuts, [[-1, 0], [2, 0]])).toBe(true);
  });
});

describe('T7 剖切轮廓：保留侧判据的变异守门（X7）', () => {
  it('X7 保留侧判反（sideOf <= EPS 改成 >= -EPS）⇒ 本格红', () => {
    const doc = clipHouse();
    const cuts = cutPolylines(clipSheet(doc, OPTS, HLINE));
    // 真实规则（保留右侧）：RightWall + RightSlab 两段，LeftWall 被丢。
    // 若把 clip.ts 里 `retainRight` 的 `<= SIDE_EPS` 翻成 `>= -SIDE_EPS`，
    // 右侧两构件被丢、左侧墙被留 ⇒ 段数从 2 变 1、段内容也不同 ⇒ 下面两行红。
    expect(cuts).toHaveLength(2);
    expect(cutsInclude(cuts, [[5, 0], [15, 0]])).toBe(true);
    expect(cutsInclude(cuts, [[-1, 0], [2, 0]])).toBe(true);
  });
});

describe('T7 剖切轮廓：独立图幅（X8 / D2）', () => {
  it('X8 产出一张自带图框的新图幅，且与平面图 IR 分层不同', () => {
    const doc = clipHouse();
    const plan = planSheet(doc, OPTS);
    const section = clipSheet(doc, OPTS, HLINE);
    // 平面图里不允许出现 section 层（那是 T7 的活）。
    expect(plan.ops.some((o) => o.pen.layer === 'section')).toBe(false);
    // 剖切轮廓是独立图幅：自带图框（frame 层）+ 剖切轮廓（section 层），A3 横式。
    expect(section.widthMm).toBe(420);
    expect(section.heightMm).toBe(297);
    expect(section.ops.some((o) => o.pen.layer === 'frame')).toBe(true);
    expect(section.ops.some((o) => o.pen.layer === 'section')).toBe(true);
  });
});
