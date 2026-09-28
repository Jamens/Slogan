import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  aabbOfPoints,
  deriveStoreyGeometry,
  storeyCreate,
  vec,
  type TransactionLog,
} from '@dajia/core';
import {
  buildDrawList,
  demoHouse,
  EMPTY_SELECTION,
  fitStorey,
  fitViewport,
  mmToPx,
  viewportOf,
  type DrawLayer,
  type DrawOp,
  type Px,
} from '@dajia/scene-2d';

const house = demoHouse();
const geo = deriveStoreyGeometry(house.doc, house.lowerStoreyId);
const box = aabbOfPoints(geo.walls.flatMap((q) => [...q.corners]));
const view = fitViewport(1200, 900, box, 60);

const polys = (ops: DrawOp[]) => ops.filter((o) => o.kind === 'polygon');
const lines = (ops: DrawOp[]) => ops.filter((o) => o.kind === 'line');

function lastCreatedStorey(log: TransactionLog): string {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'storey') return entity.id;
  }
  throw new TypeError('affected 里没有新建的楼层');
}

const allPx = (ops: DrawOp[]): number[] =>
  ops.flatMap((o) =>
    o.kind === 'polygon'
      ? o.pts.flatMap((p) => [p.x, p.y])
      : o.kind === 'line'
        ? [o.from.x, o.from.y, o.to.x, o.to.y]
        : [o.at.x, o.at.y],
  );

const ptsOf = (o: DrawOp): readonly Px[] =>
  o.kind === 'polygon' ? o.pts : o.kind === 'line' ? [o.from, o.to] : [o.at];

const layerRank = (l: DrawLayer) => ['structure', 'opening', 'annotation'].indexOf(l);

describe('绘制指令表', () => {
  it('一面墙一个轮廓多边形，四角，层是 structure', () => {
    const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);
    const walls = polys(ops).filter((o) => o.pen.layer === 'structure');
    expect(geo.walls.length).toBeGreaterThan(0);
    expect(walls).toHaveLength(geo.walls.length);
    for (const w of walls) expect(w.pts).toHaveLength(4);
  });

  it('多边形顶点就是派生角点的 mmToPx：绘制层里不许有第二份几何', () => {
    const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);
    const wallPolys = polys(ops).filter((o) => o.pen.layer === 'structure');
    expect(wallPolys.map((o) => [...o.pts])).toEqual(
      geo.walls.map((q) => q.corners.map((c) => mmToPx(view, c))),
    );
  });

  it('轴线段数等于墙垛段数（洞口处必须是断的）', () => {
    const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);
    const axes = lines(ops).filter(
      (o) => o.pen.layer === 'structure' && o.pen.lineType === 'dash-dot',
    );
    expect(geo.pieces.length).toBeGreaterThan(0);
    expect(axes).toHaveLength(geo.pieces.length);
  });

  it('洞口走 opening 层：4 樘共 8 条断口线，两樘窗各多一条中线', () => {
    const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);
    const openingOps = ops.filter((o) => o.pen.layer === 'opening');
    const openingIds = new Set(
      house.doc
        .byKind('opening')
        .filter((x) => x.storeyId === house.lowerStoreyId)
        .map((x) => x.id),
    );
    expect(openingIds.size).toBe(4);
    expect(new Set(openingOps.map((o) => o.ownerId))).toEqual(openingIds);
    expect(openingOps.filter((o) => o.pen.lineType === 'solid')).toHaveLength(8);
    expect(openingOps.filter((o) => o.pen.lineType === 'dashed')).toHaveLength(2);
  });

  it('每条指令的 ownerId 只能是本层的实体或 null', () => {
    const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);
    const storeyWallIds = new Set(geo.walls.map((q) => q.wallId));
    const storeyOpeningIds = new Set(
      house.doc
        .byKind('opening')
        .filter((x) => x.storeyId === house.lowerStoreyId)
        .map((x) => x.id),
    );
    expect(ops.length).toBeGreaterThan(0);
    for (const o of ops) {
      const ok =
        o.ownerId === null ||
        o.ownerId === house.lowerStoreyId ||
        storeyWallIds.has(o.ownerId) ||
        storeyOpeningIds.has(o.ownerId);
      expect(ok).toBe(true);
    }
  });

  it('选中必须真的改变输出：变红的只有被选中的那个实体', () => {
    const wallId = geo.walls[0]!.wallId;
    const plain = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);
    const picked = buildDrawList(house.doc, house.lowerStoreyId, view, { ids: new Set([wallId]) });
    const red = (o: DrawOp) => o.pen.color === '#c9252d';
    expect(plain.some(red)).toBe(false);
    const redOps = picked.filter(red);
    expect(redOps.length).toBeGreaterThan(0);
    expect(new Set(redOps.map((o) => o.ownerId))).toEqual(new Set([wallId]));
    expect(picked).toHaveLength(plain.length);
  });

  it('指令按层序出，最后一条必须是楼层标签', () => {
    const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);
    const order = ops.map((o) => o.pen.layer);
    for (let i = 1; i < order.length; i++) {
      expect(layerRank(order[i]!)).toBeGreaterThanOrEqual(layerRank(order[i - 1]!));
    }
    // 这里的数组尾巴是确定的（指令表由本函数排序产出），与真源里禁用的
    // byKind(...).at(-1) 无关 —— 那条禁的是靠 uuid 序猜"刚创建的那个实体"。
    expect(ops[ops.length - 1]!.pen.layer).toBe('annotation');
    expect(ops.filter((o) => o.pen.layer === 'annotation')).toHaveLength(1);
  });

  it('空层给空表：没有墙就没有任何指令', () => {
    const fresh = demoHouse();
    fresh.log.dispatch(
      storeyCreate({
        projectId: fresh.doc.projectId,
        index: 2,
        elevationMm: 6000,
        heightMm: 3000,
      }),
    );
    const thirdId = lastCreatedStorey(fresh.log);
    // 读文档一律读 `log.document`：`dispatch` 之后 `fresh.doc` 还是 `demoHouse()` 那一刻的
    // 快照，第三层不在里面 —— 拿它去派生会红在 `TypeError: 楼层 不存在`，
    // 而不是红在本条要钉的那句"空层不许抛"。
    const doc = fresh.log.document;
    expect(deriveStoreyGeometry(doc, thirdId).walls).toEqual([]);
    expect(buildDrawList(doc, thirdId, view)).toEqual([]);
    // 空层也要能打开：视口退化到默认缩放，而不是把 RangeError 抛给 UI
    expect(fitStorey(doc, thirdId, 1200, 900, 60).widthPx).toBe(1200);
  });

  it('fitStorey 把整层装进画布：没有一条指令落在画布外', () => {
    const pad = 60;
    const fitted = fitStorey(house.doc, house.lowerStoreyId, 1200, 900, pad);
    const ops = buildDrawList(house.doc, house.lowerStoreyId, fitted);
    expect(ops.length).toBeGreaterThan(0);
    for (const o of ops) {
      for (const p of ptsOf(o)) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(1200);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(900);
      }
    }
    // 本样例是"高"这一边吃满（6240mm / 780px = 8.0 > 8240mm / 1080px ≈ 7.63：
    // mm/px 越大的一边越先填满，可用像素先被纵向用光）。纵向张幅必须正好等于可用高，
    // 否则 fitStorey 把 padPx 丢了或选错了缩放边。
    // 两个数不是手抖写的：整层角点 AABB = {−120,−120,8120,6120}（计划 2 的 integration 定值），
    // 张幅 6120−(−120)=6240 与 8120−(−120)=8240；可用高宽 = 900−120 / 1200−120。
    const ys = ops
      .filter((o) => o.pen.layer !== 'annotation')
      .flatMap((o) => [...ptsOf(o)].map((p) => p.y));
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(900 - pad * 2, 6);
  });

  it('属性：换视口只换像素，不换指令表的结构', () => {
    const expectedOps = buildDrawList(house.doc, house.lowerStoreyId, view).length;
    fc.assert(
      fc.property(
        fc.double({ min: 0.005, max: 200, noNaN: true }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        (pxPerMm, cx, cy) => {
          const v = viewportOf(1000, 800, { pxPerMm, center: vec(cx, cy) });
          const ops = buildDrawList(house.doc, house.lowerStoreyId, v);
          expect(ops).toHaveLength(expectedOps);
          for (const n of allPx(ops)) expect(Number.isFinite(n)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});
