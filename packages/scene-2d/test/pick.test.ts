import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { vec } from '@dajia/core';
import {
  PICK_TOL_PX,
  buildDrawList,
  demoHouse,
  distanceToSegmentPx,
  EMPTY_SELECTION,
  fitStorey,
  mmToPx,
  pickAt,
  pickOne,
  probeTarget,
  viewportOf,
  type DrawOp,
  type Pen,
  type PickHit,
  type Px,
  type Viewport,
} from '@dajia/scene-2d';

const PEN_S: Pen = { layer: 'structure', lineType: 'solid', widthPx: 2, color: '#1f1f1f' };
const PEN_O: Pen = { layer: 'opening', lineType: 'solid', widthPx: 1.5, color: '#1f1f1f' };

const seg = (ownerId: string | null, pen: Pen, from: Px, to: Px): DrawOp => ({
  kind: 'line',
  ownerId,
  from,
  to,
  pen,
});
const face = (ownerId: string, pen: Pen, pts: Px[], fill: string | null = null): DrawOp => ({
  kind: 'polygon',
  ownerId,
  pts,
  fill,
  pen,
});
const label = (ownerId: string | null, at: Px): DrawOp => ({
  kind: 'text',
  ownerId,
  at,
  text: '楼层 0 · 标高 0.000',
  sizePx: 14,
  pen: { layer: 'annotation', lineType: 'solid', widthPx: 1, color: '#1f1f1f' },
});

const owners = (hits: PickHit[]): string[] => hits.map((h) => h.ownerId);

/** 一条指令的"第一条可点边"的中点：polygon 取 pts[0]→pts[1]，line 取整段，text 取锚点。 */
function firstEdgeMid(op: DrawOp): Px {
  if (op.kind === 'polygon') {
    const a = op.pts[0]!;
    const b = op.pts[1]!;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  if (op.kind === 'line') return { x: (op.from.x + op.to.x) / 2, y: (op.from.y + op.to.y) / 2 };
  return op.at;
}

const square = (ownerId: string, pen: Pen, size: number, fill: string | null): DrawOp =>
  face(
    ownerId,
    pen,
    [
      { x: 0, y: 0 },
      { x: size, y: 0 },
      { x: size, y: size },
      { x: 0, y: size },
    ],
    fill,
  );

// 与 T2/T3 同源的样例房：视口用 fitStorey（1200×900、pad 60 → 0.125 px/mm），
// 下面所有"点得中/点不中"的像素算式都以这个缩放为准。
const house = demoHouse();
const view = fitStorey(house.doc, house.lowerStoreyId, 1200, 900, 60);
const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);

describe('命中测试 —— 合成指令（判据的每一侧都手动摆过）', () => {
  it('容差边界含等于：屏幕上正好 8px 命中，再多 0.01px 不命中', () => {
    const ops = [seg('w', PEN_S, { x: 0, y: 0 }, { x: 100, y: 0 })];
    // 用常量而不是字面量 8：这条钉的是**边界含等于**，不是"8 这个数"
    expect(owners(pickAt(ops, { x: 50, y: PICK_TOL_PX }))).toEqual(['w']);
    expect(pickAt(ops, { x: 50, y: PICK_TOL_PX + 0.01 })).toEqual([]);
  });

  it('零长段退化到点距：不许 NaN 混进比较', () => {
    const ops = [seg('dot', PEN_S, { x: 10, y: 10 }, { x: 10, y: 10 })];
    expect(distanceToSegmentPx({ x: 10, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 10 })).toBe(0);
    const hits = pickAt(ops, { x: 10, y: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.distancePx).toBe(0);
    // 点到 9px 外：9 > 8，必须判不中。NaN 走这条会静默命中（NaN > tol 是 false）
    expect(pickAt(ops, { x: 19, y: 10 })).toEqual([]);
  });

  it('多边形按闭合环判：回边（最后一点 → 第一点）也点得中', () => {
    const ops = [square('w', PEN_S, 100, null)];
    // (-3, 50) 只挨着 pts[3]→pts[0] 那条回边；不取模就只剩三条边，这个点的最近距离是 50.09
    expect(owners(pickAt(ops, { x: -3, y: 50 }))).toEqual(['w']);
  });

  it('fill 为 null 的内部是白的 —— 点进去不算命中；fill 非 null 时内部算，且距离 0', () => {
    const tol = 4;
    const hollow = [square('hollow', PEN_S, 10, null)];
    const filled = [square('filled', PEN_S, 10, '#dddddd')];
    // 中心 (5,5) 到边是 5px：tol=4 时 hollow 必须空（内部没画东西），filled 必须命中且 0
    expect(pickAt(hollow, { x: 5, y: 5 }, tol)).toEqual([]);
    const hits = pickAt(filled, { x: 5, y: 5 }, tol);
    expect(owners(hits)).toEqual(['filled']);
    expect(hits[0]!.distancePx).toBe(0);
  });

  it('层序压倒距离：更远的洞口线赢过更近的墙轮廓', () => {
    const ops = [
      face('wall', PEN_S, [
        { x: 0, y: 5 },
        { x: 100, y: 5 },
        { x: 100, y: 105 },
        { x: 0, y: 105 },
      ]),
      seg('win', PEN_O, { x: 0, y: 9 }, { x: 100, y: 9 }),
    ];
    const hits = pickAt(ops, { x: 50, y: 0 }, 20);
    expect(hits.map((h) => h.layer)).toEqual(['opening', 'structure']);
    expect(hits.map((h) => h.distancePx)).toEqual([9, 5]);
    expect(pickOne(ops, { x: 50, y: 0 }, 20)!.ownerId).toBe('win');
  });

  it('同层按距离升序，同距离按 ownerId 升序', () => {
    const ops = [
      seg('far', PEN_S, { x: 0, y: 6 }, { x: 100, y: 6 }),
      seg('bbb', PEN_S, { x: 0, y: -2 }, { x: 100, y: -2 }),
      seg('aaa', PEN_S, { x: 0, y: 2 }, { x: 100, y: 2 }),
    ];
    expect(owners(pickAt(ops, { x: 50, y: 0 }))).toEqual(['aaa', 'bbb', 'far']);
  });

  it('同一 owner 的多条指令去重成一条，留最近的那条', () => {
    const ops = [
      face('w', PEN_S, [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 40 },
        { x: 0, y: 40 },
      ]),
      seg('w', PEN_S, { x: 0, y: 2 }, { x: 100, y: 2 }),
    ];
    const hits = pickAt(ops, { x: 50, y: 6 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.distancePx).toBe(4);
  });

  it('text 永不命中；ownerId 为 null 的指令永不命中', () => {
    const ops = [
      label('storey-1', { x: 50, y: 0 }),
      label(null, { x: 50, y: 0 }),
      seg(null, PEN_S, { x: 0, y: 0 }, { x: 100, y: 0 }),
    ];
    expect(pickAt(ops, { x: 50, y: 0 })).toEqual([]);
  });

  it('NaN 点击点返回空表，不许静默命中', () => {
    const ops = [seg('w', PEN_S, { x: 0, y: 0 }, { x: 100, y: 0 })];
    expect(pickAt(ops, { x: NaN, y: 0 })).toEqual([]);
    expect(pickAt(ops, { x: 50, y: NaN })).toEqual([]);
    expect(pickOne(ops, { x: NaN, y: NaN })).toBeNull();
  });

  it('probeTarget 只接受唯一命中的候选点：被洞口线压住的那条边必须跳过', () => {
    const v = viewportOf(1200, 900, { pxPerMm: 1, center: vec(0, 0) });
    const ops = [
      face('wall', PEN_S, [
        { x: 0, y: 0 },
        { x: 400, y: 0 },
        { x: 400, y: 40 },
        { x: 0, y: 40 },
      ]),
      // 断口线正好穿过上边 (200, 0)：那条边的中点上"谁在上面"说不清（opening 层还压着 structure）
      seg('win', PEN_O, { x: 200, y: -20 }, { x: 200, y: 20 }),
    ];
    const probe = probeTarget(ops, v);
    expect(probe).not.toBeNull();
    if (probe === null) return; // 上一条已断言非空，这里只为类型收窄
    // 跳过 (200,0) 之后，下一条够长的边是下边，中点 (200,40) 只挨着墙。
    // 钉死坐标才是真正的牙齿：不筛唯一命中就会拿到 (200, 0)。
    expect(probe.clickPx).toEqual({ x: 200, y: 40 });
    expect(owners(pickAt(ops, probe.clickPx))).toEqual(['wall']);
    expect(pickAt(ops, probe.blankPx)).toEqual([]);
  });

  it('probeTarget：clickPx 唯一命中自己，blankPx 一个都不命中', () => {
    const probe = probeTarget(ops, view);
    expect(probe).not.toBeNull();
    if (probe === null) return; // 上一条已经断言过非空，这里只为类型收窄；走到这儿就是测试失败
    expect(owners(pickAt(ops, probe.clickPx))).toEqual([probe.ownerId]);
    expect(house.doc.get(probe.ownerId)?.kind).toBe('wall');
    expect(pickAt(ops, probe.blankPx)).toEqual([]);
  });
});

describe('命中测试 —— 样例两层房', () => {
  it('每条指令的每条边中点都点得中自己', () => {
    let checked = 0;
    for (const op of ops) {
      if (op.kind === 'text') continue;
      const ownerId = op.ownerId;
      if (ownerId === null) continue;
      // 边表显式列出来：多边形是闭合环（回边算一条），线段只有一条。
      // 把 `[from, to]` 塞进同一个取模循环会数出两条（from→to 与 to→from 中点相同），
      // 于是下面的 54 会红在 76 —— 而这个数字正是"少一条边就红"的那颗牙。
      const edges: Array<[Px, Px]> = [];
      if (op.kind === 'polygon') {
        const ring = op.pts;
        for (let i = 0; i < ring.length; i++) {
          edges.push([ring[i]!, ring[(i + 1) % ring.length]!]);
        }
      } else {
        edges.push([op.from, op.to]);
      }
      for (const [a, b] of edges) {
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        expect(owners(pickAt(ops, mid, PICK_TOL_PX))).toContain(ownerId);
        checked += 1;
      }
    }
    // 空循环等于没测：8 轮廓 × 4 边 + 12 轴线 + 10 洞口线 = 54 条边
    expect(checked).toBe(54);
  });

  it('放大时吸附在屏幕上不变松、在世界里变紧（像素口径的唯一证明）', () => {
    const fine = viewportOf(1200, 900, { pxPerMm: 0.125, center: vec(4000, 3000) });
    const zoom = viewportOf(1200, 900, { pxPerMm: 0.5, center: vec(4000, 3000) });
    const opsFine = buildDrawList(house.doc, house.lowerStoreyId, fine, EMPTY_SELECTION);
    const opsZoom = buildDrawList(house.doc, house.lowerStoreyId, zoom, EMPTY_SELECTION);
    // southWest 墙厚 240 → 下表面在 y = -120mm；x=2000 处没有接头，那条边是完整的
    const onFace = vec(2000, -120);
    const below5px = (v: Viewport): Px => ({ x: mmToPx(v, onFace).x, y: mmToPx(v, onFace).y + 5 });
    // 屏幕偏移同为 5px：两个缩放都命中 —— 吸附在屏幕上一样紧
    expect(pickOne(opsFine, below5px(fine))).not.toBeNull();
    expect(pickOne(opsZoom, below5px(zoom))).not.toBeNull();
    // 而同一**世界**点（下表面往下 40mm）：0.125 下是 5px（命中），0.5 下是 20px（不命中）。
    // 毫米口径会给相反的答案，这三行就是像素口径的钉子。
    expect(pickOne(opsFine, mmToPx(fine, vec(2000, -160)))).not.toBeNull();
    expect(pickOne(opsZoom, mmToPx(zoom, vec(2000, -160)))).toBeNull();
  });

  it('属性：容差越大，命中集只增不减', () => {
    const near = ops.filter((o) => o.kind !== 'text' && o.ownerId !== null);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: near.length - 1 }),
        fc.double({ min: -3, max: 3, noNaN: true }),
        fc.double({ min: -3, max: 3, noNaN: true }),
        (rawIndex, dx, dy) => {
          const op = near[rawIndex % near.length]!;
          const mid = firstEdgeMid(op);
          const p = { x: mid.x + dx, y: mid.y + dy };
          const small = new Set(owners(pickAt(ops, p, 4)));
          const big = new Set(owners(pickAt(ops, p, 16)));
          // 容差 4 时至少点得中自己那条边（jitter ≤ 4.25px），空集就是这条属性在自欺
          expect(small.size).toBeGreaterThanOrEqual(1);
          for (const id of small) expect(big.has(id)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('属性：排序契约对任意点击成立，且结果与指令数组的顺序无关', () => {
    const near = ops.filter((o) => o.kind !== 'text' && o.ownerId !== null);
    const mid = firstEdgeMid(near[0]!);
    const p = { x: mid.x + 1, y: mid.y + 2 };
    const reference = pickAt(ops, p);
    expect(reference.length).toBeGreaterThanOrEqual(1);
    fc.assert(
      fc.property(
        fc.shuffledSubarray(ops, { minLength: ops.length, maxLength: ops.length }),
        (shuffled) => {
          expect(pickAt(shuffled, p)).toEqual(reference);
        },
      ),
      { numRuns: 100 },
    );
    for (const hits of [reference, pickAt(ops, { x: mid.x, y: mid.y })]) {
      for (let i = 1; i < hits.length; i++) {
        const a = hits[i - 1]!;
        const b = hits[i]!;
        const rank = (h: PickHit) => ['structure', 'opening', 'annotation'].indexOf(h.layer);
        expect(rank(b)).toBeLessThanOrEqual(rank(a));
        if (rank(b) === rank(a)) expect(b.distancePx).toBeGreaterThanOrEqual(a.distancePx);
        expect(a.ownerId).not.toBe(b.ownerId);
      }
    }
  });
});
