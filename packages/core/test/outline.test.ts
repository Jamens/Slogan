// 墙轮廓四角与面积：斜切保面积、T 接与十字缩进、四角严格凸，蝴蝶结给 0
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  deriveJoints,
  deriveWallQuads,
  polygonArea,
  storeyCreate,
  uuidv7,
  wallAxisById,
  wallCreate,
  type Vec2,
  type WallQuad,
} from '@dajia/core';

const projectId = uuidv7();

function build(
  specs: Array<{
    start: { x: number; y: number };
    end: { x: number; y: number };
    thicknessMm: number;
  }>,
) {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  const storeyId = log.document.byKind('storey')[0]!.id;
  for (const s of specs) log.dispatch(wallCreate({ storeyId, heightMm: 3000, ...s }));
  return log;
}

/**
 * 以 {pointId} 复用端点追加一面墙，返回新墙 id。
 * 取新墙靠 affected，不靠 byKind 下标（同毫秒 uuidv7 不保证单调，见 Global Constraints）。
 * 计划文本的 fixture 里 tee/obliqueL 把它当对象读 `.wallId`，与 lCorner 当 id 用互相矛盾
 * （TS2339）；本文件的注释写明返回的就是 id，故统一按 id 用。
 */
function append(
  log: TransactionLog,
  startId: string,
  end: { x: number; y: number },
  thicknessMm: number,
): string {
  const storeyId = log.document.byKind('storey')[0]!.id;
  log.dispatch(
    wallCreate({ storeyId, start: { pointId: startId }, end, thicknessMm, heightMm: 3000 }),
  );
  for (const id of log.affected) if (log.document.get(id)?.kind === 'wall') return id;
  throw new Error('追加墙失败：affected 里没有墙');
}

function quadOf(log: TransactionLog, wallId: string): WallQuad {
  const hit = deriveWallQuads(log.document).find((q) => q.wallId === wallId);
  if (!hit) throw new Error(`测试找不到墙 ${wallId} 的轮廓`);
  return hit;
}

/** 直角 L：A (0,0)→P(1000,0)，B P→(1000,800)，同厚 240。 */
function lCorner() {
  const log = build([{ start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: 240 }]);
  const a = log.document.byKind('wall')[0]!;
  const b = append(log, a.endId, { x: 1000, y: 800 }, 240);
  return { log, a: a.id, b };
}

/** T 接：直通 (0,0)→P(1000,0)→(2000,0) 厚 240，支墙 P→(1000,800) 厚 120。 */
function tee() {
  const log = build([{ start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thicknessMm: 240 }]);
  const hub = log.document.byKind('wall')[0]!.endId;
  append(log, hub, { x: 2000, y: 0 }, 240);
  const stem = append(log, hub, { x: 1000, y: 800 }, 120);
  return { log, hub, stem };
}

/** 十字：四臂皆终于 P(1000,1000)，全厚 240。 */
function plus() {
  const log = build([
    { start: { x: 0, y: 1000 }, end: { x: 1000, y: 1000 }, thicknessMm: 240 },
  ]);
  const hub = log.document.byKind('wall')[0]!.endId;
  for (const end of [
    { x: 2000, y: 1000 },
    { x: 1000, y: 0 },
    { x: 1000, y: 2000 },
  ]) {
    append(log, hub, end, 240);
  }
  return { log, hub };
}

/** 60° 异厚 L：A (-2000,0)→P(0,0) 厚 370，B P→(-1000,1732) 厚 200。 */
function obliqueL() {
  const log = build([{ start: { x: -2000, y: 0 }, end: { x: 0, y: 0 }, thicknessMm: 370 }]);
  const a = log.document.byKind('wall')[0]!;
  const b = append(log, a.endId, { x: -1000, y: 1732 }, 200);
  return { log, a: a.id, b };
}

/** 严格凸：四个叉积同号，共线角（叉积为 0）也算不合格。 */
function strictlyConvex(corners: readonly Vec2[]): boolean {
  let sign = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    const c = corners[(i + 2) % corners.length]!;
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (z === 0) return false;
    const s = z > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function sumArea(log: TransactionLog): number {
  return deriveWallQuads(log.document).reduce((s, q) => s + q.areaMm2, 0);
}

describe('polygonArea', () => {
  it('凸多边形恒正，且与顶点起点无关', () => {
    const square: Vec2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(polygonArea(square)).toBe(100);
    expect(polygonArea([...square.slice(2), ...square.slice(0, 2)])).toBe(100);
    expect(polygonArea([...square].reverse())).toBe(100);
  });

  it('蝴蝶结给 0：这就是 assertNoFlip 必须存在、凸性必须单独断言的原因', () => {
    expect(
      polygonArea([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ]),
    ).toBe(0);
  });
});

describe('孤墙与斜墙', () => {
  it('孤墙：四角是精确矩形，面积 = 轴长 × 墙厚', () => {
    const log = build([{ start: { x: 0, y: 0 }, end: { x: 4000, y: 0 }, thicknessMm: 240 }]);
    const [quad] = deriveWallQuads(log.document);
    expect(quad!.corners).toEqual([
      { x: 0, y: 120 },
      { x: 4000, y: 120 },
      { x: 4000, y: -120 },
      { x: 0, y: -120 },
    ]);
    expect(quad!.areaMm2).toBe(960000);
  });

  it('斜墙：面积仍等于轴长 × 墙厚，四角到轴线的垂直距离都等于半厚', () => {
    const log = build([{ start: { x: 0, y: 0 }, end: { x: 3000, y: 4000 }, thicknessMm: 200 }]);
    const wall = log.document.byKind('wall')[0]!;
    const axis = wallAxisById(log.document, wall.id);
    const quad = quadOf(log, wall.id);
    expect(quad.areaMm2).toBeCloseTo(5000 * 200, 6);
    for (const c of quad.corners) {
      const perpDist = Math.abs(
        (c.x - axis.start.x) * axis.normal.x + (c.y - axis.start.y) * axis.normal.y,
      );
      expect(perpDist).toBeCloseTo(100, 9);
    }
  });

  it('deriveWallQuads 的顺序与 byKind("wall") 一致（契约是 id 升序，不是创建顺序）', () => {
    const log = build([
      { start: { x: 0, y: 0 }, end: { x: 3000, y: 0 }, thicknessMm: 240 },
      { start: { x: 0, y: 0 }, end: { x: 0, y: 3000 }, thicknessMm: 240 },
      { start: { x: 3000, y: 0 }, end: { x: 3000, y: 3000 }, thicknessMm: 120 },
    ]);
    expect(deriveWallQuads(log.document).map((q) => q.wallId)).toEqual(
      log.document.byKind('wall').map((w) => w.id),
    );
  });
});

describe('接头处的轮廓', () => {
  it('直角 L：两墙共用同一条接缝边（四个角点逐个精确相等）', () => {
    const { log, a, b } = lCorner();
    const qa = quadOf(log, a);
    const qb = quadOf(log, b);
    expect(qa.corners).toEqual([
      { x: 0, y: 120 },
      { x: 880, y: 120 },
      { x: 1120, y: -120 },
      { x: 0, y: -120 },
    ]);
    expect(qb.corners).toEqual([
      { x: 880, y: 120 },
      { x: 880, y: 800 },
      { x: 1120, y: 800 },
      { x: 1120, y: -120 },
    ]);
    // A 的 1、2 号 === B 的 0、3 号：共边即共边界，既无缝也无双层
    expect(qa.corners[1]).toEqual(qb.corners[0]);
    expect(qa.corners[2]).toEqual(qb.corners[3]);
  });

  it('直角 L：每面墙面积恰为 轴长 × 墙厚（斜切保面积）', () => {
    const { log, a, b } = lCorner();
    expect(quadOf(log, a).areaMm2).toBeCloseTo(1000 * 240, 6);
    expect(quadOf(log, b).areaMm2).toBeCloseTo(800 * 240, 6);
    expect(sumArea(log)).toBeCloseTo(432000, 6);
  });

  it('60° 异厚 L：偏置斜切仍保面积', () => {
    const { log, a, b } = obliqueL();
    expect(quadOf(log, a).areaMm2).toBeCloseTo(2000 * 370, 6);
    expect(quadOf(log, b).areaMm2).toBeCloseTo(Math.hypot(1000, 1732) * 200, 6);
  });

  it('T 接：支墙轮廓止于直通墙面线，面积 = 120 × (800 − 120)', () => {
    const { log, stem } = tee();
    const quad = quadOf(log, stem);
    expect(quad.corners).toEqual([
      { x: 940, y: 120 },
      { x: 940, y: 800 },
      { x: 1060, y: 800 },
      { x: 1060, y: 120 },
    ]);
    expect(quad.areaMm2).toBe(81600);
    // 直通两墙各自方头到 P，正好拼满横带：240000 + 240000 = 2000 × 240
    expect(sumArea(log)).toBeCloseTo(480000 + 81600, 6);
  });

  it('十字：Σ 面积 = 手工并集 902400，中心没有重叠块', () => {
    const { log } = plus();
    expect(deriveWallQuads(log.document)).toHaveLength(4);
    // 独立算：横带 2000×240 + 竖带 240×2000 − 中心 240×240
    expect(sumArea(log)).toBeCloseTo(2000 * 240 + 240 * 2000 - 240 * 240, 6);
    expect(sumArea(log)).toBeCloseTo(902400, 6);
  });
});

describe('派生入口的契约', () => {
  it('显式传 joints 与让函数内部派生结果完全相同', () => {
    const { log } = lCorner();
    const doc = log.document;
    expect(deriveWallQuads(doc, deriveJoints(doc))).toEqual(deriveWallQuads(doc));
  });

  it('墙指向不存在的点：抛，不给 NaN 轮廓', () => {
    const log = build([{ start: { x: 0, y: 0 }, end: { x: 3600, y: 0 }, thicknessMm: 240 }]);
    const wall = log.document.byKind('wall')[0]!;
    const broken = Document.replaceEntities(
      log.document,
      new Map([...log.document.entities].filter(([id]) => id !== wall.endId)),
    );
    expect(() => deriveWallQuads(broken)).toThrow(/墙终点 不存在/);
  });

  it('四个 fixture 的 11 面墙轮廓全部严格凸（自相交与共线退化都会红）', () => {
    const fixtures = [lCorner(), tee(), plus(), obliqueL()];
    let checked = 0;
    for (const { log } of fixtures) {
      for (const quad of deriveWallQuads(log.document)) {
        checked++;
        expect(strictlyConvex(quad.corners)).toBe(true);
      }
    }
    // L 2 + tee 3 + cross 4 + 斜 L 2：数量写死，防止 fixture 悄悄少建墙变成空跑
    expect(checked).toBe(11);
  });
});
