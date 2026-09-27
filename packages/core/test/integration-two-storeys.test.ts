/**
 * spec 11.1 那栋两层住宅的定值整合：几何、分段、索引、撤销四个层面各钉一票。
 * 本文件不新增任何被测代码，只把 Task 4–9 的派生口径在一张真实图纸上对一遍。
 */
import { describe, expect, it } from 'vitest';
import {
  Document,
  SpatialIndex,
  TransactionLog,
  aabbOfPoints,
  deriveJoints,
  deriveStoreyGeometry,
  deriveWallQuads,
  memberTrim,
  openingCreate,
  openingMove,
  storeyCreate,
  storeySetElevation,
  uuidv7,
  wallAxisById,
  wallCreate,
  wallMoveEndpoint,
  wallSetThickness,
  type Command,
  type Joint,
  type PointRef,
  type Vec2,
  type WallEnd,
  type WallEntity,
  type WallPiece,
} from '@dajia/core';

const STOREY_HEIGHT_MM = 3000;
const projectId = uuidv7();

type WallName =
  | 'southWest'
  | 'southEast'
  | 'east'
  | 'north'
  | 'west'
  | 'stem'
  | 'partWest'
  | 'partEast';

type OpeningName = 'doorSouth' | 'doorEast' | 'winNorth' | 'winWest';

interface StoreyParts {
  readonly storeyId: string;
  readonly walls: Record<WallName, WallEntity>;
  readonly openings: Record<OpeningName, string>;
}

interface House {
  readonly log: TransactionLog;
  readonly lower: StoreyParts;
  readonly upper: StoreyParts;
  /** 每一笔之后的 canonical，长度 == 命令数 + 1（含起点） */
  readonly snaps: string[];
}

/**
 * 与 geometry-properties.test.ts 同款的六行：取新建实体只认 affected + 字面量判别。
 * 墙与洞口各一个助手，不做泛型 —— 见下一段。
 */
function lastCreatedWall(log: TransactionLog): WallEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new TypeError('affected 里没有新建的墙');
}

function lastCreatedOpening(log: TransactionLog): string {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'opening') return entity.id;
  }
  throw new TypeError('affected 里没有新建的洞口');
}

/** 取刚 dispatch 出来的那个楼层 id。同样不 `byKind('storey').at(-1)`，理由见 buildHouse 之后。 */
function lastCreatedStorey(log: TransactionLog): string {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'storey') return entity.id;
  }
  throw new TypeError('affected 里没有新建的楼层');
}

/**
 * `step` 是第三个入参：brief 的 Expected 要"30 笔命令 / 31 张快照 / 撤到底回到空文档"，
 * 那 16 笔 wallCreate 与 8 笔 openingCreate 必须在记录器里走，否则快照只有 6 张，
 * 而且 snaps[0] 会是"已有两个楼层"的文档，最后一撤的那句 `toBe(empty)` 比错了对象。
 * 建墙与建洞口都用它，dispatch 只在这一处发生。
 */
function buildStorey(
  log: TransactionLog,
  storeyId: string,
  step: (cmd: Command) => void,
): StoreyParts {
  const walls = {} as Record<WallName, WallEntity>;
  const put = (name: WallName, start: PointRef, end: PointRef, thicknessMm: number): void => {
    step(wallCreate({ storeyId, start, end, thicknessMm, heightMm: STOREY_HEIGHT_MM }));
    walls[name] = lastCreatedWall(log);
  };
  put('southWest', { x: 0, y: 0 }, { x: 4000, y: 0 }, 240);
  put('southEast', { pointId: walls.southWest.endId }, { x: 8000, y: 0 }, 240);
  put('east', { pointId: walls.southEast.endId }, { x: 8000, y: 6000 }, 240);
  put('north', { pointId: walls.east.endId }, { x: 0, y: 6000 }, 240);
  put('west', { pointId: walls.southWest.startId }, { pointId: walls.north.endId }, 240);
  put('stem', { pointId: walls.southWest.endId }, { x: 4000, y: 3000 }, 120);
  put('partWest', { x: 1000, y: 3000 }, { pointId: walls.stem.endId }, 120);
  put('partEast', { pointId: walls.stem.endId }, { x: 7000, y: 3000 }, 120);

  const openings = {} as Record<OpeningName, string>;
  const cut = (
    name: OpeningName,
    host: WallEntity,
    input: { distanceMm: number; widthMm: number; heightMm: number; category: 'door' | 'window' },
  ): void => {
    step(openingCreate({ hostWallId: host.id, ...input }));
    openings[name] = lastCreatedOpening(log);
  };
  cut('doorSouth', walls.southWest, { distanceMm: 1500, widthMm: 1000, heightMm: 2100, category: 'door' });
  cut('doorEast', walls.east, { distanceMm: 1000, widthMm: 1000, heightMm: 2100, category: 'door' });
  cut('winNorth', walls.north, { distanceMm: 2000, widthMm: 1500, heightMm: 1500, category: 'window' });
  cut('winWest', walls.west, { distanceMm: 3500, widthMm: 1200, heightMm: 1500, category: 'window' });
  return { storeyId, walls, openings };
}

function buildHouse(): House {
  const log = new TransactionLog(Document.create(projectId));
  // 起点那张是空文档：30 笔全撤回去比的正是它（登记表最后一行"命令数 30"的另一个半边）
  const snaps: string[] = [log.document.canonical()];
  const step = (cmd: Command): void => {
    log.dispatch(cmd);
    snaps.push(log.document.canonical());
  };
  step(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: STOREY_HEIGHT_MM }));
  const lowerId = lastCreatedStorey(log);
  const lower = buildStorey(log, lowerId, step);
  step(storeyCreate({ projectId, index: 1, elevationMm: 6000, heightMm: STOREY_HEIGHT_MM }));
  const upperId = lastCreatedStorey(log);
  const upper = buildStorey(log, upperId, step);

  const edit = (cmd: Command): void => step(cmd);
  edit(wallMoveEndpoint({ wallId: lower.walls.partWest.id, end: 'start', x: 800, y: 3000 }));
  edit(wallSetThickness({ wallId: lower.walls.stem.id, thicknessMm: 240 }));
  edit(openingMove({ openingId: lower.openings.winNorth, distanceMm: 2200 }));
  edit(storeySetElevation({ storeyId: upperId, elevationMm: 3000 }));
  return { log, lower, upper, snaps };
}

/** 墙 id → 楼层 id。`doc.get` 返回实体联合，判别式走完，cast 一处都不留。 */
function storeyOfWall(doc: Document, wallId: string): string {
  const wall = doc.get(wallId);
  if (wall?.kind !== 'wall') throw new TypeError(`${wallId} 不是墙`);
  return wall.storeyId;
}

/** 接头属于哪一层：只看第一个成员。"成员不跨层"这件事由第 1 条断言负责，这里不重复检查。 */
const memberStorey = (doc: Document, joint: Joint): string =>
  storeyOfWall(doc, joint.members[0]!.wallId);

/** 本层存活的墙。`byKind` 给 id 升序，与本文件的期望值无关，只是别拿它当"创建顺序"。 */
const liveWallsOf = (doc: Document, storeyId: string): WallEntity[] =>
  doc.byKind('wall').filter((wall) => wall.storeyId === storeyId);

/** 轴长走 Task 2 的实现：整合测试测的是接线，不是把几何再推导一遍（那份在属性测试里）。 */
const axisLength = (doc: Document, wall: WallEntity): number => wallAxisById(doc, wall.id).lengthMm;

/** 按坐标找接头：登记表里的点全是整数，直接 == 比。 */
function jointAt(doc: Document, parts: StoreyParts, x: number, y: number): Joint {
  for (const joint of deriveJoints(doc)) {
    if (memberStorey(doc, joint) !== parts.storeyId) continue;
    const point = doc.get(joint.pointId);
    if (point?.kind === 'point' && point.x === x && point.y === y) return joint;
  }
  throw new Error(`(${x}, ${y}) 处没有属于本层的接头`);
}

/**
 * 该接头处这面墙的两侧斜切，折成 { left, right } 方便断言。
 * 查找仍然交给 Task 4 的 `memberTrim`（传一枚接头组成的数组），本文件不写第二份查找；
 * 找不到时它抛 `/找不到/`，比这里自己抛更准，因为那条消息是 Task 4 契约的一部分。
 */
const trimAt = (joint: Joint, wallId: string, end: WallEnd): { left: number; right: number } => {
  const member = memberTrim([joint], wallId, end);
  return { left: member.trimLeftMm, right: member.trimRightMm };
};

/** 该端两枚角点，按 (x, y) 排序后返回：比的是点集，不是环序。 */
function quadEndCorners(doc: Document, wallId: string, end: WallEnd): Vec2[] {
  const quad = deriveWallQuads(doc).find((q) => q.wallId === wallId);
  if (!quad) throw new Error(`墙 ${wallId} 没有轮廓`);
  const corners = quad.corners;
  const pair = end === 'start' ? [corners[0], corners[3]] : [corners[1], corners[2]];
  return pair.sort((p, q) => p.x - q.x || p.y - q.y);
}

describe('两层住宅：接头与轮廓', () => {
  const kinds = (parts: StoreyParts, doc: Document): string[] =>
    deriveJoints(doc)
      .filter((joint) => memberStorey(doc, joint) === parts.storeyId)
      .map((j) => j.kind)
      .sort();

  it('每层 8 个接头：4 corner + 2 tee + 2 free，且不跨层', () => {
    const h = buildHouse();
    const doc = h.log.document;
    const want = ['corner', 'corner', 'corner', 'corner', 'free', 'free', 'tee', 'tee'];
    expect(kinds(h.lower, doc)).toEqual(want);
    expect(kinds(h.upper, doc)).toEqual(want);
    // 上面两条只证明"每层各自有 8 枚"；这一条证明没有第三层的、或者谁都不 belonging 的接头漏网
    expect(deriveJoints(doc).length).toBe(16);
    // 楼层不串：每一枚接头的成员都在同一层
    for (const joint of deriveJoints(doc)) {
      const storeys = new Set(joint.members.map((m) => storeyOfWall(doc, m.wallId)));
      expect(storeys.size).toBe(1);
    }
  });

  it('同向角定值：A 是 start/start、D 是 end/end，凹凸角点与两侧斜切逐条吻合', () => {
    const h = buildHouse();
    const doc = h.log.document;
    const a = jointAt(doc, h.lower, 0, 0);
    expect(a.kind).toBe('corner');
    expect(a.members.map((m) => m.end)).toEqual(['start', 'start']);
    // 凹 = 两内侧面之交点 = (120,120)；凸 = 2P − 凹 = (−120,−120)
    expect(trimAt(a, h.lower.walls.southWest.id, 'start')).toEqual({ left: 120, right: -120 });
    expect(trimAt(a, h.lower.walls.west.id, 'start')).toEqual({ left: -120, right: 120 });
    expect(quadEndCorners(doc, h.lower.walls.southWest.id, 'start')).toEqual([
      { x: -120, y: -120 },
      { x: 120, y: 120 },
    ]);
    const d = jointAt(doc, h.lower, 0, 6000);
    expect(d.members.map((m) => m.end)).toEqual(['end', 'end']);
    expect(trimAt(d, h.lower.walls.north.id, 'end')).toEqual({ left: 120, right: -120 });
    expect(trimAt(d, h.lower.walls.west.id, 'end')).toEqual({ left: -120, right: 120 });
  });

  it('两个 tee：支墙切到直通墙面线，直通墙方头', () => {
    const h = buildHouse();
    const doc = h.log.document;
    const s1 = jointAt(doc, h.lower, 4000, 0);
    const q = jointAt(doc, h.lower, 4000, 3000);
    expect([s1.kind, q.kind]).toEqual(['tee', 'tee']);
    expect(s1.members.length).toBe(3);
    // 只有支墙被切：直通两墙 trim 全 0（方头），stem 两侧同值
    expect(trimAt(s1, h.lower.walls.southWest.id, 'end')).toEqual({ left: 0, right: 0 });
    expect(trimAt(s1, h.lower.walls.southEast.id, 'start')).toEqual({ left: 0, right: 0 });
    expect(trimAt(q, h.lower.walls.partWest.id, 'end')).toEqual({ left: 0, right: 0 });
    expect(trimAt(q, h.lower.walls.partEast.id, 'start')).toEqual({ left: 0, right: 0 });
    expect(trimAt(s1, h.lower.walls.stem.id, 'start')).toEqual({ left: 120, right: 120 });
    expect(trimAt(q, h.lower.walls.stem.id, 'end')).toEqual({ left: 60, right: 60 });
    expect(quadEndCorners(doc, h.lower.walls.stem.id, 'start')).toEqual([
      { x: 3880, y: 120 },
      { x: 4120, y: 120 },
    ]);
    expect(quadEndCorners(doc, h.lower.walls.stem.id, 'end')).toEqual([
      { x: 3880, y: 2940 },
      { x: 4120, y: 2940 },
    ]);
  });

  it('每层 12 片墙身，洞口分段与登记表逐端点相同', () => {
    const h = buildHouse();
    const geometry = deriveStoreyGeometry(h.log.document, h.lower.storeyId);
    expect(geometry.pieces.length).toBe(12);
    const pieceOf = (wallId: string): WallPiece[] => geometry.pieces.filter((p) => p.wallId === wallId);
    expect(pieceOf(h.lower.walls.southWest.id)).toEqual([
      { wallId: h.lower.walls.southWest.id, fromMm: 0, toMm: 1500 },
      { wallId: h.lower.walls.southWest.id, fromMm: 2500, toMm: 4000 },
    ]);
    // 第 3 笔编辑（openingMove 2000 → 2200）真的落到了分段上
    expect(pieceOf(h.lower.walls.north.id)).toEqual([
      { wallId: h.lower.walls.north.id, fromMm: 0, toMm: 2200 },
      { wallId: h.lower.walls.north.id, fromMm: 3700, toMm: 8000 },
    ]);
    // 无洞的墙整段一片，且第 1 笔编辑把 partWest 从 3000 拉到 3200
    expect(pieceOf(h.lower.walls.partWest.id)).toEqual([
      { wallId: h.lower.walls.partWest.id, fromMm: 0, toMm: 3200 },
    ]);
  });

  it('面积恒等式在一张真图纸上成立：Σ 轮廓 = 8,140,800 = Σ 轴长×墙厚 − 43,200', () => {
    const h = buildHouse();
    const doc = h.log.document;
    const area = deriveWallQuads(doc)
      .filter((q) => storeyOfWall(doc, q.wallId) === h.lower.storeyId)
      .reduce((total, q) => total + q.areaMm2, 0);
    expect(area).toBeCloseTo(8_140_800, 6);
    // Σ 轴长 × 墙厚：全是整数轴长（本图纸没有斜墙），hypot 逐位精确
    const nominal = liveWallsOf(doc, h.lower.storeyId).reduce(
      (total, wall) => total + axisLength(doc, wall) * wall.thicknessMm,
      0,
    );
    expect(nominal).toBe(8_184_000);
    // 差额只来自两处 tee 重叠，逐项列出来，别写成"减一个大约的数"
    expect(nominal - area).toBeCloseTo(28_800 + 14_400, 6);
  });

  it('全体角点 AABB = {−120,−120,8120,6120}', () => {
    const h = buildHouse();
    const doc = h.log.document;
    const corners = deriveWallQuads(doc)
      .filter((q) => storeyOfWall(doc, q.wallId) === h.lower.storeyId)
      .flatMap((q) => [...q.corners]);
    expect(corners.length).toBe(32);
    expect(aabbOfPoints(corners)).toEqual({ minX: -120, minY: -120, maxX: 8120, maxY: 6120 });
  });

  it('索引：每层 12 条，queryPoint(2000,0) 恰好命中南墙与它的门，两层不相交', () => {
    const h = buildHouse();
    const doc = h.log.document;
    const lower = SpatialIndex.fromDoc(doc, h.lower.storeyId);
    const upper = SpatialIndex.fromDoc(doc, h.upper.storeyId);
    expect(lower.size).toBe(12);
    expect(upper.size).toBe(12);
    expect(lower.queryPoint(2000, 0).sort()).toEqual(
      [h.lower.walls.southWest.id, h.lower.openings.doorSouth].sort(),
    );
    expect(upper.queryPoint(2000, 0).sort()).toEqual(
      [h.upper.walls.southWest.id, h.upper.openings.doorSouth].sort(),
    );
    // 楼层隔离：二层的任何一个 id 都不该出现在本层的命中里
    for (const id of lower.queryPoint(2000, 0)) expect(upper.queryPoint(2000, 0)).not.toContain(id);
  });

  it('30 笔命令：撤到底、逐字节回到空文档、重做逐张复现，图还活着', () => {
    const h = buildHouse();
    const empty = h.snaps[0];
    expect(h.snaps.length).toBe(31);      // 起点 1 张 + 30 笔各 1 张
    expect(h.log.depth).toBe(30);
    for (let i = 0; i < 30; i++) expect(h.log.undo()).toBe(true);
    expect(h.log.undo()).toBe(false);
    expect(h.log.document.canonical()).toBe(empty);
    for (let i = 1; i < h.snaps.length; i++) {
      expect(h.log.redo()).toBe(true);
      expect(h.log.document.canonical()).toBe(h.snaps[i]);
    }
    expect(h.log.canRedo).toBe(false);
    // 撤销重做的不是字符串，是那张图：重放完再算一遍面积与索引
    const area = deriveWallQuads(h.log.document)
      .filter((q) => storeyOfWall(h.log.document, q.wallId) === h.lower.storeyId)
      .reduce((total, q) => total + q.areaMm2, 0);
    expect(area).toBeCloseTo(8_140_800, 6);
    expect(SpatialIndex.fromDoc(h.log.document, h.upper.storeyId).size).toBe(12);
  });
});
