import { describe, expect, it } from 'vitest';
import {
  Document,
  SpatialIndex,
  TransactionLog,
  aabbIntersects,
  aabbOfPoints,
  applyPatch,
  columnCreate,
  deriveWallQuads,
  expandAffected,
  openingAabb,
  openingCreate,
  openingSpans,
  slabCreate,
  storeyCreate,
  uuidv7,
  wallAxisById,
  wallCreate,
  wallDelete,
  wallMoveEndpoint,
  wallSetThickness,
  type Aabb,
  type OpeningEntity,
  type PointRef,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();
const MISSING = '00000000-0000-7000-8000-000000000009';

function buildLog(): TransactionLog {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  return log;
}

function storeyByIndex(log: TransactionLog, index: number): string {
  const hit = log.document.byKind('storey').find((s) => s.index === index);
  if (!hit) throw new Error(`测试找不到楼层 index=${index}`);
  return hit.id;
}

/** 取刚建成的实体一律走 affected + 字面量判别（同毫秒的 uuidv7 不保证有序）。 */
function lastWall(log: TransactionLog): WallEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建墙');
}

function idOfKind(log: TransactionLog, kind: 'column' | 'slab'): string {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === kind) return id;
  }
  throw new Error(`最近一次 dispatch 没有新建 ${kind}`);
}

/**
 * 夹具只写坐标，墙高统一 3000。
 * 这里不用 `Omit<WallCreateInput, 'storeyId'>`：那个类型里 `heightMm` 是必填，
 * Omit 掉 storeyId 之后每条 addWall 都得自己再写一遍墙高。本地 `WallSpec` 让它可选，
 * 默认值只在这一处。
 */
interface WallSpec {
  start: PointRef;
  end: PointRef;
  thicknessMm: number;
  heightMm?: number;
}

function addWall(log: TransactionLog, spec: WallSpec): WallEntity {
  log.dispatch(
    wallCreate({
      storeyId: storeyByIndex(log, 0),
      start: spec.start,
      end: spec.end,
      thicknessMm: spec.thicknessMm,
      heightMm: spec.heightMm ?? 3000,
    }),
  );
  return lastWall(log);
}

/** 只有一面 3600×240 的横墙：洞口盒与 queryPoint 用它，没有接头干扰。 */
function straightWall(): { log: TransactionLog; storeyId: string; wall: WallEntity } {
  const log = buildLog();
  const wall = addWall(log, { start: { x: 0, y: 0 }, end: { x: 3600, y: 0 }, thicknessMm: 240 });
  return { log, storeyId: storeyByIndex(log, 0), wall };
}

/** 拐角在 (3600, 0) 的 L 形：A 横 B 竖，两墙同厚 240。 */
function lCorner(): {
  log: TransactionLog;
  storeyId: string;
  sharedId: string;
  first: WallEntity;
  second: WallEntity;
} {
  const log = buildLog();
  const first = addWall(log, {
    start: { x: 0, y: 0 },
    end: { x: 3600, y: 0 },
    thicknessMm: 240,
  });
  const sharedId = first.endId;
  const second = addWall(log, {
    start: { pointId: sharedId },
    end: { x: 3600, y: 2400 },
    thicknessMm: 240,
  });
  return { log, storeyId: storeyByIndex(log, 0), sharedId, first, second };
}

function addOpening(
  log: TransactionLog,
  spec: Omit<Parameters<typeof openingCreate>[0], 'hostWallId'> & { hostWallId: string },
): OpeningEntity {
  log.dispatch(openingCreate(spec));
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'opening') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建洞口');
}

/** L 形 + A 上一樘窗（2000–2900）、B 上一樘门（1400–2300）。 */
function lCornerWithOpenings(): {
  log: TransactionLog;
  storeyId: string;
  sharedId: string;
  first: WallEntity;
  second: WallEntity;
  win: OpeningEntity;
  door: OpeningEntity;
} {
  const base = lCorner();
  const win = addOpening(base.log, {
    hostWallId: base.first.id,
    distanceMm: 2000,
    widthMm: 900,
    heightMm: 1500,
    category: 'window',
  });
  const door = addOpening(base.log, {
    hostWallId: base.second.id,
    distanceMm: 1400,
    widthMm: 900,
    heightMm: 2100,
    category: 'door',
  });
  return { ...base, win, door };
}

/** count 面互不相连的横墙排成一列，i 号占 x ∈ [i*4000, i*4000+3000]。 */
function wallRow(count: number): { log: TransactionLog; storeyId: string; walls: WallEntity[] } {
  const log = buildLog();
  const walls: WallEntity[] = [];
  for (let i = 0; i < count; i++) {
    walls.push(
      addWall(log, {
        start: { x: i * 4000, y: 0 },
        end: { x: i * 4000 + 3000, y: 0 },
        thicknessMm: 200,
      }),
    );
  }
  return { log, storeyId: storeyByIndex(log, 0), walls };
}

describe('expandAffected', () => {
  it('三种 seed 都含自身，并沿引用关系往下走', () => {
    const { log, first, win } = lCornerWithOpenings();
    // 洞口没有下游：闭包就是它自己
    expect([...expandAffected(log.document, new Set([win.id]))]).toEqual([win.id]);
    // 墙 → 它身上的洞口
    expect([...expandAffected(log.document, new Set([first.id]))].sort()).toEqual(
      [first.id, win.id].sort(),
    );
    // 独占的端点 → 墙 → 洞口（一次走到底，不是只走一层）
    expect([...expandAffected(log.document, new Set([first.startId]))].sort()).toEqual(
      [first.startId, first.id, win.id].sort(),
    );
  });

  it('共享端点一脏，两墙与两墙上的洞口一次收全', () => {
    const { log, sharedId, first, second, win, door } = lCornerWithOpenings();
    const closure = expandAffected(log.document, new Set([sharedId]));
    expect([...closure].sort()).toEqual(
      [sharedId, first.id, second.id, win.id, door.id].sort(),
    );
  });

  it('楼层 id 一脏，整层构件全脏；点不在闭包里（点没有要重算的几何）', () => {
    const { log, storeyId, first, second, win, door } = lCornerWithOpenings();
    log.dispatch(
      columnCreate({ storeyId, at: { pointId: first.startId }, widthMm: 400, depthMm: 400 }),
    );
    const column = idOfKind(log, 'column');
    log.dispatch(
      slabCreate({
        storeyId,
        boundary: [
          { pointId: first.startId },
          { x: 3600, y: 0 },
          { x: 0, y: 2400 },
        ],
        thicknessMm: 120,
      }),
    );
    const slab = idOfKind(log, 'slab');
    const closure = expandAffected(log.document, new Set([storeyId]));
    expect([...closure].sort()).toEqual(
      [storeyId, first.id, second.id, win.id, door.id, column, slab].sort(),
    );
    // 点是楼层的**上游**：楼层脏不需要重算点
    expect(closure.has(first.startId)).toBe(false);
  });

  it('已经不在文档里的 id 当 seed：不抛，闭包只剩它自己', () => {
    const { log, first, second } = lCorner();
    log.dispatch(wallDelete({ wallId: second.id }));
    const closure = expandAffected(log.document, new Set([second.id]));
    expect([...closure]).toEqual([second.id]);
    // 活着的共享端点仍能把邻墙带进来 —— 删除不切断闭包的其他入口
    expect(expandAffected(log.document, new Set([first.endId])).has(first.id)).toBe(true);
  });

  it('终止性：startId === endId 的病态墙也不会让闭包转圈', () => {
    const { log, wall } = straightWall();
    // 真源不校验引用完整性，这种墙只能靠 applyPatch 手工造出来（命令层建不出：零长墙被拒）
    const bad: WallEntity = { ...wall, startId: wall.endId };
    const doc = applyPatch(log.document, { upsert: [bad], remove: [] }).doc;
    const closure = expandAffected(doc, new Set([bad.endId]));
    expect([...closure].sort()).toEqual([bad.endId, bad.id].sort());
  });

  it('Task 7 的口径：被拉伸的两面墙 ∪ 被夹的洞口 ⊆ expandAffected(doc, {pointId})', () => {
    const { log, sharedId, first, second, win, door } = lCornerWithOpenings();
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 1200 }));
    // 命令层的补丁只写了那个点与被夹动的门
    expect([...log.affected].sort()).toEqual([sharedId, door.id].sort());
    const closure = expandAffected(log.document, new Set([sharedId]));
    for (const id of [first.id, second.id, door.id]) expect(closure.has(id)).toBe(true);
    // 没被夹动的窗也在闭包里：多重建不会错，少重建会
    expect(closure.has(win.id)).toBe(true);
  });

  it('点 seed 的闭包不出本层：这就是索引按楼层建的作用域前提', () => {
    const { log, storeyId, sharedId } = lCorner();
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    const upper = storeyByIndex(log, 1);
    log.dispatch(
      wallCreate({
        storeyId: upper,
        start: { x: 3600, y: 0 },
        end: { x: 3600, y: 2400 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    );
    const closure = expandAffected(log.document, new Set([sharedId]));
    // 二层那面墙与本层的 B 平面坐标完全重合，但它引用的是别层的点 → 不在闭包里
    for (const id of closure) {
      const entity = log.document.get(id);
      if (!entity || entity.kind === 'storey') continue;
      expect(entity.storeyId).toBe(storeyId);
    }
    expect(closure.size).toBe(3);
  });
});

describe('Aabb 助手', () => {
  it('aabbOfPoints 取四极值；单点退化成零面积矩形；空数组抛', () => {
    const box = aabbOfPoints([
      { x: 10, y: -30 },
      { x: 40, y: 20 },
      { x: -5, y: 7 },
    ]);
    expect(box).toEqual({ minX: -5, minY: -30, maxX: 40, maxY: 20 });
    expect(aabbOfPoints([{ x: 3, y: 4 }])).toEqual({ minX: 3, minY: 4, maxX: 3, maxY: 4 });
    expect(() => aabbOfPoints([])).toThrow(/至少一个点/);
  });

  it('aabbIntersects 用闭区间：贴边与包含都算相交，错开一格才算不相交', () => {
    const a: Aabb = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(aabbIntersects(a, { minX: 10, minY: 0, maxX: 20, maxY: 10 })).toBe(true);
    expect(aabbIntersects(a, { minX: 2, minY: 2, maxX: 3, maxY: 3 })).toBe(true);
    expect(aabbIntersects(a, a)).toBe(true);
    expect(aabbIntersects(a, { minX: 11, minY: 0, maxX: 20, maxY: 10 })).toBe(false);
    expect(aabbIntersects(a, { minX: -10, minY: -10, maxX: -1, maxY: 5 })).toBe(false);
  });

  it('openingAabb 是沿轴区间 × 墙厚，不带斜切：2600+900 的窗落在 x[2600,3500] y[-120,120]', () => {
    const { log, wall } = straightWall();
    const axis = wallAxisById(log.document, wall.id);
    expect(openingAabb(axis, { openingId: uuidv7(), fromMm: 2600, toMm: 3500 })).toEqual({
      minX: 2600,
      minY: -120,
      maxX: 3500,
      maxY: 120,
    });
    // 区间口径不自己拼：吃 openingSpans 的输出，和派生轮廓用的是同一张表。
    // 「索引里的洞口条目」（kind / dependsOn）由 Step 3 那条用例接着验。
    const win = addOpening(log, {
      hostWallId: wall.id,
      distanceMm: 2600,
      widthMm: 900,
      heightMm: 1500,
      category: 'window',
    });
    const spans = openingSpans(log.document, wall);
    expect(spans).toEqual([{ openingId: win.id, fromMm: 2600, toMm: 3500 }]);
    expect(openingAabb(axis, spans[0]!)).toEqual({ minX: 2600, minY: -120, maxX: 3500, maxY: 120 });
    // 洞口盒恒真包含洞口本身：墙厚方向不外伸（±half），沿轴不外伸（to - from == widthMm）。
    // 斜切只削墙的角，不会把洞口削到盒子外面 —— 这条是 query 敢把 AABB 当候选的依据。
    expect(spans[0]!.toMm - spans[0]!.fromMm).toBe(900);
    expect(axis.thicknessMm / 2).toBe(120);
  });
});

/**
 * 暴力遍历：直接吃 Task 5 的轮廓与 Task 6 的洞口表算盒子，不看网格。
 * 它验的是**分桶**有没有漏、有没有多，不是盒子本身（盒子由 Task 5 / 本任务前面几条验）。
 */
function bruteForce(doc: Document, storeyId: string, rect: Aabb): string[] {
  const hits = new Set<string>();
  for (const quad of deriveWallQuads(doc)) {
    const entity = doc.get(quad.wallId);
    // 用 kind 收窄，不用 as WallEntity：本计划里读实体一律走判别式（Task 8 Step 7 查的就是这个）
    if (!entity || entity.kind !== 'wall' || entity.storeyId !== storeyId) continue;
    if (aabbIntersects(aabbOfPoints(quad.corners), rect)) hits.add(quad.wallId);
  }
  for (const wall of doc.byKind('wall')) {
    if (wall.storeyId !== storeyId) continue;
    const axis = wallAxisById(doc, wall.id);
    for (const span of openingSpans(doc, wall)) {
      if (aabbIntersects(openingAabb(axis, span), rect)) hits.add(span.openingId);
    }
  }
  return [...hits].sort();
}

const PROBES: Aabb[] = [
  { minX: -9000, minY: -9000, maxX: 9000, maxY: 9000 },
  { minX: 3601, minY: -119, maxX: 3719, maxY: -1 },
  { minX: 3540, minY: -60, maxX: 3660, maxY: 60 },
  { minX: 100, minY: 1000, maxX: 200, maxY: 1100 },
  { minX: 0, minY: -130, maxX: 100, maxY: -121 },
  { minX: 2000, minY: -1, maxX: 2900, maxY: 1 },
  { minX: 3481, minY: 2380, maxX: 3599, maxY: 2401 },
  { minX: -3600, minY: -120, maxX: -3599, maxY: 120 },
  // 第 9 条是**恰好共边**：minX 3720 就是 A 与 B 盒子的右边界。
  // 没有它，把 aabbIntersects 的 <= 改成 < 也能全绿 —— 闭区间这件事就成了空测试。
  { minX: 3720, minY: -119, maxX: 3800, maxY: 119 },
];

describe('SpatialIndex.fromDoc 与 query', () => {
  it('只收本层的墙与洞口；楼层 id 不存在当场抛', () => {
    const { log, storeyId, first, second, win, door } = lCornerWithOpenings();
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    const upper = storeyByIndex(log, 1);
    log.dispatch(
      wallCreate({
        storeyId: upper,
        start: { x: 0, y: 0 },
        end: { x: 3600, y: 0 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    );
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    expect([...index.snapshot().map((e) => e.id)].sort()).toEqual(
      [first.id, second.id, win.id, door.id].sort(),
    );
    expect(index.size).toBe(4);
    expect(() => SpatialIndex.fromDoc(log.document, MISSING)).toThrow(/楼层 不存在/);
  });

  it('query 与暴力遍历在 9 个探针矩形上逐条一致', () => {
    const { log, storeyId } = lCornerWithOpenings();
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    for (const rect of PROBES) {
      expect(index.query(rect)).toEqual(bruteForce(log.document, storeyId, rect));
    }
    // 反证：探针不是恒空的。6 条非空（第 1/2/3/6/7/9 条），3 条真空 ——
    // 全空的话上面那九次比对可以绿着什么都不验
    expect(index.query(PROBES[8]!).length).toBeGreaterThan(0);
    expect(PROBES.filter((rect) => index.query(rect).length > 0).length).toBe(6);
  });

  it('queryPoint：墙身内、洞口内、墙外空档各得其所', () => {
    const { log, storeyId, first, second, win, door } = lCornerWithOpenings();
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    // (1000, 0) 在 A 的墙身里，窗在 2000–2900，所以只有 A
    expect(index.queryPoint(1000, 0)).toEqual([first.id]);
    // (2500, 0) 同时在 A 与窗的盒子里：洞口先于宿主墙被点是常识，但两者都该在
    expect(index.queryPoint(2500, 0).sort()).toEqual([first.id, win.id].sort());
    // (3600, 2000) 在 B 的盒子里（A 的 y 到 ±120 为止），同时也在 B 上那樘门的盒子里
    // （门沿轴 1400–2300、横向 ±120）：宿主墙与门一起报，正是拾取要的那一对候选
    expect(index.queryPoint(3600, 2000).sort()).toEqual([second.id, door.id].sort());
    // 只要 B 一家的话取 y 500：门从 1400 才起，A 与窗都到不了这里
    expect(index.queryPoint(3600, 500)).toEqual([second.id]);
    expect(index.queryPoint(500000, 500000)).toEqual([]);
  });

  it('墙框来自斜切后的梯形：共角那端超出轴线端点，超出那段仍命中', () => {
    const { log, storeyId, first, second } = lCorner();
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    const box = index.entryOf(first.id)?.aabb;
    if (!box) throw new Error('索引里找不到 A');
    // corner 的 trim 是 (+120, -120)：一侧内退 120，另一侧外伸 120 → 框宽 3720
    expect(box.maxX).toBeGreaterThan(3600);
    expect(box.minX).toBe(0);
    // 外伸那段（x > 3600）落在 A 的盒子里，网格在那里也必须报出 A：A 的轴线端点在 3600，
    // 盒子却到 3720，这一问盯的就是"漏报"（Step 6 第 4 条变异红在这里）。
    // B 自己的盒子是 x[3480,3720] × y[-120,2400]，把整个外伸方块盖住了，
    // 所以这一问在这副夹具里必然两家一起中 —— 单独只要 A 的矩形问不出来。
    expect(index.query({ minX: 3601, minY: -120, maxX: box.maxX - 1, maxY: 120 }).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    // 孤墙没有这个外伸：同一条墙拆掉邻墙之后，框回到 3600（「删一面墙」那条靠这个差别）
  });

  it('条目形状：墙 dependsOn 两个端点，洞口 dependsOn 宿主墙 + 那两个端点', () => {
    const { log, storeyId, first, win } = lCornerWithOpenings();
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    const wallEntry = index.entryOf(first.id);
    if (!wallEntry) throw new Error('索引里找不到 A');
    expect(wallEntry.kind).toBe('wall');
    expect(wallEntry.dependsOn).toEqual([first.startId, first.endId]);
    const openingEntry = index.entryOf(win.id);
    if (!openingEntry) throw new Error('索引里找不到那樘窗');
    expect(openingEntry.kind).toBe('opening');
    expect(openingEntry.dependsOn).toEqual([first.id, first.startId, first.endId]);
    // 宿主墙 id 必须在 dependsOn 里：拖端点带动洞口重算，靠的就是这条反向边
    expect(openingEntry.dependsOn).toContain(first.id);
    // 洞口盒子不随接头变化：A 的共角端被斜掉 120，窗盒仍从 2000 起到 2900
    expect(openingEntry.aabb).toEqual({ minX: 2000, minY: -120, maxX: 2900, maxY: 120 });
  });

  it('cellVisits 只数局部：12 面墙排一列，小窗口落在 2 个格子里', () => {
    const { log, storeyId, walls } = wallRow(12);
    const index = SpatialIndex.fromDoc(log.document, storeyId, { cellSizeMm: 4000 });
    const rect: Aabb = { minX: 8100, minY: -50, maxX: 8200, maxY: 50 };
    expect(index.size).toBe(12);
    expect(index.cellVisits(rect)).toBe(2);
    expect(index.query(rect)).toEqual([walls[2]!.id]);
  });

  it('非有限或上下界颠倒的矩形 → 抛（不许把 Infinity 当"无限大的窗口"）', () => {
    const { log, storeyId } = lCorner();
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    expect(() => index.query({ minX: -Infinity, minY: 0, maxX: 0, maxY: 0 })).toThrow(/有限数/);
    expect(() => index.query({ minX: 100, minY: 0, maxX: 50, maxY: 0 })).toThrow(/上下界颠倒/);
    expect(() => SpatialIndex.fromDoc(log.document, storeyId, { cellSizeMm: 0 })).toThrow(
      /网格边长/,
    );
  });
});

describe('SpatialIndex.applyAffected', () => {
  /** 局部重建之后必须与整层重建逐条相等 —— 本任务唯一的硬指标。 */
  function expectSame(index: SpatialIndex, doc: Document, storeyId: string): void {
    expect(index.snapshot()).toEqual(SpatialIndex.fromDoc(doc, storeyId, {}).snapshot());
  }

  it('拖拐角：affected 只有那个点与被夹的门，索引里两墙两洞口都换过', () => {
    const { log, storeyId, sharedId, first, second, win, door } = lCornerWithOpenings();
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    const before = index.entryOf(first.id)!.aabb;
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 1200 }));
    expect([...log.affected].sort()).toEqual([sharedId, door.id].sort());
    index.applyAffected(log.document, log.affected);
    expectSame(index, log.document, storeyId);
    // 两面墙都动了：A 变斜、B 变短，盒子不可能原地不动。
    // 比整盒而不比单个分量：A 的外伸角是斜切后的外侧面与 B 的外侧面 x=3720 的交点，
    // 拖之前拖之后都仍贴在那条竖直线上（实测 maxX 两回都是 3720），
    // 真正变了的是 minX（0 → -37.947…）、minY（-120 → -113.842…）、maxY（120 → 1286.491…）。
    expect(index.entryOf(first.id)!.aabb).not.toEqual(before);
    // 拖完之后 (2300, 750) 同时落在 A 的新盒子与那樘窗的盒子里；拖之前那是墙外的空档
    expect(index.queryPoint(2300, 750).sort()).toEqual([first.id, win.id].sort());
    // 而 (1000, 0) 只剩 A 一家：窗沿轴 2000–2900 才起，B 与门都在 x 3480 之外
    expect(index.queryPoint(1000, 0)).toEqual([first.id]);
    // B 的下边界从 -120 抬到 1000 以上（共享端点被拖走，旧盒子留不住这个数）。
    // 阈值取 500 不取 1033：这个数由 Task 4 的任意角斜切公式算出来，测试不该把它的
    // 小数位钉死 —— 钉"抬起来了"这个方向就够，钉"抬到哪一毫米"是 Task 4 的事。
    expect(index.entryOf(second.id)?.aabb.minY).toBeGreaterThan(500);
  });

  it('删一面墙：邻墙的接头从 corner 变 free，它的框必须跟着换', () => {
    const { log, storeyId, first, second } = lCorner();
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    const wideBefore = index.entryOf(first.id)!.aabb;
    expect(wideBefore.maxX - wideBefore.minX).toBeGreaterThan(3600);
    log.dispatch(wallDelete({ wallId: second.id }));
    index.applyAffected(log.document, log.affected);
    const after = index.entryOf(first.id)!.aabb;
    // free 端 trim 为 0 → 梯形变矩形，宽恰好等于轴长。这条断言与上一条配对，
    // 才能证明"局部重建真的动了 A"，而不是索引一直没碰它
    expect(after.maxX - after.minX).toBe(3600);
    expect(index.entryOf(second.id)).toBeUndefined();
    expectSame(index, log.document, storeyId);
  });

  it('改一面墙的墙厚：共角的另一面墙也在脏集合里（doc 的反向依赖给不出这条边）', () => {
    const { log, storeyId, first, second } = lCorner();
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    const neighbourBefore = index.entryOf(second.id)!.aabb;
    // 真源闭包只到"这面墙 + 它身上的洞口"：邻墙不在里面
    expect(expandAffected(log.document, new Set([first.id])).has(second.id)).toBe(false);
    log.dispatch(wallSetThickness({ wallId: first.id, thicknessMm: 300 }));
    index.applyAffected(log.document, log.affected);
    expect(index.entryOf(second.id)!.aabb).not.toEqual(neighbourBefore);
    expectSame(index, log.document, storeyId);
  });

  it('与本层无关的 id 是空操作：柱、别层的墙与点都不动索引', () => {
    const { log, storeyId, first } = lCorner();
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    const upper = storeyByIndex(log, 1);
    log.dispatch(
      wallCreate({
        storeyId: upper,
        start: { x: 0, y: 0 },
        end: { x: 3600, y: 0 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    );
    const upperWall = lastWall(log);
    log.dispatch(
      columnCreate({ storeyId, at: { pointId: first.startId }, widthMm: 400, depthMm: 400 }),
    );
    const column = idOfKind(log, 'column');
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    const snapshot = index.snapshot();
    // 本层的柱：进了脏闭包，但它不入索引 → remove 是空操作
    index.applyAffected(log.document, new Set([column]));
    // 别层的楼层 id：闭包把它那面墙带进来，墙不属于本层 → 同样空操作
    index.applyAffected(log.document, new Set([upper]));
    // 别层墙的一个端点：连"本层"这道门都进不来
    index.applyAffected(log.document, new Set([upperWall.startId]));
    // 文档里根本没有的 id：不抛，也不动
    index.applyAffected(log.document, new Set([MISSING]));
    expect(index.snapshot()).toEqual(snapshot);
    expect(index.size).toBe(2);
  });

  it('undo / redo 回放：每一步之后的局部重建都与整层重建相等', () => {
    const { log, storeyId, first } = lCornerWithOpenings();
    const index = SpatialIndex.fromDoc(log.document, storeyId);
    expectSame(index, log.document, storeyId);
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 1200 }));
    index.applyAffected(log.document, log.affected);
    expectSame(index, log.document, storeyId);
    expect(log.undo()).toBe(true);
    index.applyAffected(log.document, log.affected);
    expectSame(index, log.document, storeyId);
    expect(log.redo()).toBe(true);
    index.applyAffected(log.document, log.affected);
    expectSame(index, log.document, storeyId);
  });
});
