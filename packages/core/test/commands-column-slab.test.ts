import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  columnCreate,
  slabCreate,
  storeyCreate,
  storeySetElevation,
  uuidv7,
  wallCreate,
  type ColumnEntity,
  type PointEntity,
  type SlabEntity,
  type StoreyEntity,
  type WallCreateInput,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();

function buildLog(): TransactionLog {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  return log;
}

/** 与 read.test.ts 同一个假 id：uuidv7 造不出它，也不会同一撞上真实体。 */
const MISSING = '00000000-0000-7000-8000-000000000009';

/** 按 index 取楼层：同毫秒的 uuidv7 不保证有序，byKind 下标是掷硬币。 */
function storeyByIndex(log: TransactionLog, index: number): string {
  const hit = log.document.byKind('storey').find((s) => s.index === index);
  if (!hit) throw new Error(`测试找不到楼层 index=${index}`);
  return hit.id;
}

// 取刚建成的实体一律靠 affected + 字面量判别（kind 写字面量才能收窄类型，不必修道断言）
function lastWall(log: TransactionLog): WallEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建墙');
}

function lastColumn(log: TransactionLog): ColumnEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'column') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建柱');
}

function lastSlab(log: TransactionLog): SlabEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'slab') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建板');
}

/** heightMm 由本助手兜底成 3000，所以一并从入参类型里 Omit 掉：
 *  留着它会让类型必填、下面又写死，TS2783 与三处调用点同时编不过。 */
function addWall(
  log: TransactionLog,
  spec: Omit<WallCreateInput, 'storeyId' | 'heightMm'>,
): WallEntity {
  log.dispatch(wallCreate({ storeyId: storeyByIndex(log, 0), heightMm: 3000, ...spec }));
  return lastWall(log);
}

/** 拐角在 (3600, 0)：柱与板都要复用这个点。 */
function lCorner(): {
  log: TransactionLog;
  storeyId: string;
  sharedId: string;
  first: WallEntity;
  second: WallEntity;
} {
  const log = buildLog();
  const storeyId = storeyByIndex(log, 0);
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
  return { log, storeyId, sharedId, first, second };
}

/** 只要一个楼层、不要墙的场合（板的环用裸坐标就够）。 */
function oneStorey(): { log: TransactionLog; storeyId: string } {
  const log = buildLog();
  return { log, storeyId: storeyByIndex(log, 0) };
}

/** 6000×6000 矩形板四角，板的三条用例共用。 */
const RECT_CORNERS = [
  { x: 0, y: 0 },
  { x: 6000, y: 0 },
  { x: 6000, y: 6000 },
  { x: 0, y: 6000 },
];

describe('columnCreate', () => {
  it('给坐标建柱：点与柱一起进真源，坐标过 quantizeMm，默认承重且材料是混凝土', () => {
    const { log, storeyId } = lCorner();
    log.dispatch(
      columnCreate({ storeyId, at: { x: 1200.4, y: 600.2 }, widthMm: 400, depthMm: 400 }),
    );
    const column = lastColumn(log);
    const point = log.document.get(column.pointId) as PointEntity;
    expect([point.x, point.y]).toEqual([1200, 600]);
    expect(point.storeyId).toBe(storeyId);
    expect(column.loadBearing).toBe(true);
    expect(column.material).toBe('concrete');
    expect(log.affected).toEqual(new Set([column.pointId, column.id]));
  });

  it('复用拐角点：只 upsert 柱，affected 一个 id', () => {
    const { log, storeyId, sharedId } = lCorner();
    log.dispatch(
      columnCreate({ storeyId, at: { pointId: sharedId }, widthMm: 400, depthMm: 400 }),
    );
    const column = lastColumn(log);
    expect(column.pointId).toBe(sharedId);
    expect(log.affected).toEqual(new Set([column.id]));
    expect(log.document.byKind('point')).toHaveLength(3);
  });

  it('heightMm 省略时取所在楼层层高；给了就用给的', () => {
    const { log, storeyId } = lCorner();
    log.dispatch(columnCreate({ storeyId, at: { x: 0, y: 0 }, widthMm: 400, depthMm: 400 }));
    expect(lastColumn(log).heightMm).toBe(3000);
    log.dispatch(
      columnCreate({
        storeyId,
        at: { x: 900, y: 900 },
        widthMm: 400,
        depthMm: 400,
        heightMm: 2600,
      }),
    );
    expect(lastColumn(log).heightMm).toBe(2600);
  });

  it('截面或柱高非正 → /必须为正/；浮点截面 → 构造期 /整数毫米/，日志一步没走', () => {
    const { log, storeyId } = lCorner();
    const depth = log.depth;
    expect(() =>
      log.dispatch(columnCreate({ storeyId, at: { x: 0, y: 0 }, widthMm: 0, depthMm: 400 })),
    ).toThrow(/柱截面宽必须为正/);
    expect(() =>
      log.dispatch(columnCreate({ storeyId, at: { x: 0, y: 0 }, widthMm: 400, depthMm: -1 })),
    ).toThrow(/柱截面深必须为正/);
    expect(() =>
      log.dispatch(
        columnCreate({
          storeyId,
          at: { x: 0, y: 0 },
          widthMm: 400,
          depthMm: 400,
          heightMm: 0,
        }),
      ),
    ).toThrow(/柱高必须为正/);
    // 浮点这条直接断言**工厂**抛，不套 log.dispatch：Document.validate 的整数检查也含
    // 「整数毫米」，套上 dispatch 就分不清是命令层拦的还是落库层拦的（Task 7 栽过一次）
    expect(() =>
      columnCreate({ storeyId, at: { x: 0, y: 0 }, widthMm: 400.5, depthMm: 400 }),
    ).toThrow(/整数毫米/);
    expect(log.depth).toBe(depth);
    expect(log.document.byKind('column')).toHaveLength(0);
  });

  it('同一个点上不能有两根柱 → /已有柱/；换个坐标就行（正对照）', () => {
    const { log, storeyId, sharedId } = lCorner();
    log.dispatch(
      columnCreate({ storeyId, at: { pointId: sharedId }, widthMm: 400, depthMm: 400 }),
    );
    const before = log.document.canonical();
    expect(() =>
      log.dispatch(
        columnCreate({ storeyId, at: { pointId: sharedId }, widthMm: 500, depthMm: 500 }),
      ),
    ).toThrow(/已有柱/);
    expect(log.document.canonical()).toBe(before);
    log.dispatch(
      columnCreate({ storeyId, at: { x: 100, y: 100 }, widthMm: 400, depthMm: 400 }),
    );
    expect(log.document.byKind('column')).toHaveLength(2);
  });

  it('复用别层的点 → 抛（与墙共用 resolvePointRef 那条判据）', () => {
    const { log, sharedId } = lCorner();
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    expect(() =>
      log.dispatch(
        columnCreate({
          storeyId: storeyByIndex(log, 1),
          at: { pointId: sharedId },
          widthMm: 400,
          depthMm: 400,
        }),
      ),
    ).toThrow(/不能给楼层/);
  });

  it('楼层不存在 / 拿墙当楼层 → 两道中文各抛一次，柱一根都不许留下', () => {
    const { log, first } = lCorner();
    const depth = log.depth;
    expect(() =>
      log.dispatch(
        columnCreate({ storeyId: MISSING, at: { x: 0, y: 0 }, widthMm: 400, depthMm: 400 }),
      ),
    ).toThrow(/楼层 不存在/);
    expect(() =>
      log.dispatch(
        columnCreate({ storeyId: first.id, at: { x: 0, y: 0 }, widthMm: 400, depthMm: 400 }),
      ),
    ).toThrow(/不是楼层，是 wall/);
    // requireStorey 是 build 的第一行：抛在建点之前，所以点数与日志深度都该原地不动
    expect(log.depth).toBe(depth);
    expect(log.document.byKind('column')).toHaveLength(0);
    expect(log.document.byKind('point')).toHaveLength(3);
  });

  it('撤销新建柱：连它自己建的点一起消失', () => {
    const { log, storeyId } = lCorner();
    const points = log.document.byKind('point').length;
    const before = log.document.canonical();
    log.dispatch(
      columnCreate({ storeyId, at: { x: 100, y: 100 }, widthMm: 400, depthMm: 400 }),
    );
    expect(log.document.byKind('point')).toHaveLength(points + 1);
    const forward = log.document.canonical();
    log.undo();
    expect(log.document.byKind('column')).toHaveLength(0);
    expect(log.document.byKind('point')).toHaveLength(points);
    // 可逆性是硬约束（spec 5.5）：撤销逐字节复原、重做逐字节回到正向状态
    expect(log.document.canonical()).toBe(before);
    expect(log.redo()).toBe(true);
    expect(log.document.canonical()).toBe(forward);
  });

  it('撤销复用拐角的柱：那个点必须留下（墙还指着它）', () => {
    const { log, storeyId, sharedId } = lCorner();
    const before = log.document.canonical();
    log.dispatch(
      columnCreate({ storeyId, at: { pointId: sharedId }, widthMm: 400, depthMm: 400 }),
    );
    const forward = log.document.canonical();
    log.undo();
    expect(log.document.byKind('column')).toHaveLength(0);
    expect(log.document.get(sharedId)).toBeDefined();
    // 复用点没进补丁 → 撤销不会带走它，逐字节回到 dispatch 之前
    expect(log.document.canonical()).toBe(before);
    expect(log.redo()).toBe(true);
    expect(log.document.canonical()).toBe(forward);
  });
});

describe('slabCreate', () => {
  it('矩形板：4 个新点 + 1 块板进补丁，boundaryPointIds 保持传入顺序', () => {
    const { log, storeyId } = oneStorey();
    log.dispatch(slabCreate({ storeyId, boundary: RECT_CORNERS, thicknessMm: 120 }));
    const slab = lastSlab(log);
    expect(slab.boundaryPointIds).toHaveLength(4);
    expect(log.affected.size).toBe(5);
    expect(slab.elevationOffsetMm).toBe(0);
    // 顺序是真源的一部分：派生侧靠它复原环，不许偷偷排序
    const ring = slab.boundaryPointIds.map((id) => log.document.get(id) as PointEntity);
    expect(ring.map((p) => [p.x, p.y])).toEqual(RECT_CORNERS.map((c) => [c.x, c.y]));
  });

  it('混排复用与新建：拐角点直接进环，补丁里只有板与两个新点', () => {
    const { log, storeyId, sharedId } = lCorner();
    log.dispatch(
      slabCreate({
        storeyId,
        boundary: [{ pointId: sharedId }, { x: 3600, y: 2400 }, { x: 0, y: 0 }],
        thicknessMm: 120,
      }),
    );
    const slab = lastSlab(log);
    expect(slab.boundaryPointIds).toHaveLength(3);
    expect(slab.boundaryPointIds[0]).toBe(sharedId);
    expect(log.affected.size).toBe(3);
    // 复用的点没被改动 → 不进补丁。affected 只说"这次真的改了什么"（与 Task 7 同一口径）
    expect(log.affected.has(sharedId)).toBe(false);
    expect(log.affected.has(slab.id)).toBe(true);
  });

  it('环非法即抛：少于 3 点、自交，点与板都不许留下', () => {
    const { log, storeyId } = oneStorey();
    const before = log.document.canonical();
    expect(() =>
      log.dispatch(
        slabCreate({ storeyId, boundary: [{ x: 0, y: 0 }, { x: 6000, y: 0 }], thicknessMm: 120 }),
      ),
    ).toThrow(/至少 3 个顶点/);
    expect(() =>
      log.dispatch(
        slabCreate({
          storeyId,
          boundary: [
            { x: 0, y: 0 },
            { x: 10000, y: 8000 },
            { x: 9000, y: 0 },
            { x: 0, y: 10000 },
          ],
          thicknessMm: 120,
        }),
      ),
    ).toThrow(/自交/);
    expect(log.document.canonical()).toBe(before);
    expect(log.document.byKind('slab')).toHaveLength(0);
    // 补丁是原子的：build 抛错 → dispatch 什么都不做，环上的点也不许先落盘
    expect(log.document.byKind('point')).toHaveLength(0);
  });

  it('顶点 id 重复 → 抛；板厚非正与浮点 → 抛', () => {
    const { log, storeyId, sharedId } = lCorner();
    expect(() =>
      log.dispatch(
        slabCreate({
          storeyId,
          boundary: [
            { pointId: sharedId },
            { pointId: sharedId },
            { x: 0, y: 0 },
            { x: 0, y: 2400 },
          ],
          thicknessMm: 120,
        }),
      ),
    ).toThrow(/重复的顶点/);
    expect(() =>
      log.dispatch(slabCreate({ storeyId, boundary: RECT_CORNERS, thicknessMm: 0 })),
    ).toThrow(/板厚必须为正/);
    // 同柱那条：浮点板厚直接问工厂，dispatch 版会被 Document.validate 的同款文案顶掉
    expect(() => slabCreate({ storeyId, boundary: RECT_CORNERS, thicknessMm: 120.5 })).toThrow(
      /整数毫米/,
    );
  });

  it('撤销整块板：自建的点消失，复用的点保留', () => {
    const { log, storeyId, sharedId } = lCorner();
    const points = log.document.byKind('point').length;
    const before = log.document.canonical();
    log.dispatch(
      slabCreate({
        storeyId,
        boundary: [{ pointId: sharedId }, { x: 3600, y: 2400 }, { x: 0, y: 0 }],
        thicknessMm: 120,
      }),
    );
    expect(log.document.byKind('slab')).toHaveLength(1);
    const forward = log.document.canonical();
    log.undo();
    expect(log.document.byKind('slab')).toHaveLength(0);
    expect(log.document.byKind('point')).toHaveLength(points);
    expect(log.document.get(sharedId)).toBeDefined();
    // 可逆性是硬约束（spec 5.5）：环上三个点的补丁一起回滚，逐字节复原
    expect(log.document.canonical()).toBe(before);
    expect(log.redo()).toBe(true);
    expect(log.document.canonical()).toBe(forward);
  });

  it('楼层不存在 / 拿墙当楼层 → 抛，环上的四个点一个都不许留下', () => {
    const { log, first } = lCorner();
    const before = log.document.canonical();
    expect(() =>
      log.dispatch(slabCreate({ storeyId: MISSING, boundary: RECT_CORNERS, thicknessMm: 120 })),
    ).toThrow(/楼层 不存在/);
    expect(() =>
      log.dispatch(slabCreate({ storeyId: first.id, boundary: RECT_CORNERS, thicknessMm: 120 })),
    ).toThrow(/不是楼层，是 wall/);
    // requireStorey 在取环上各点之前：四次新建点连 build 都没进到
    expect(log.document.canonical()).toBe(before);
    expect(log.document.byKind('point')).toHaveLength(3);
    expect(log.document.byKind('slab')).toHaveLength(0);
  });
});

describe('storeySetElevation', () => {
  it('只改标高：层内的墙与点坐标一字未动，affected 只有楼层', () => {
    const { log, storeyId, sharedId } = lCorner();
    const point = log.document.get(sharedId) as PointEntity;
    log.dispatch(storeySetElevation({ storeyId, elevationMm: 450 }));
    const storey = log.document.get(storeyId) as StoreyEntity;
    expect(storey.elevationMm).toBe(450);
    expect(storey.heightMm).toBe(3000);
    expect(storey.index).toBe(0);
    expect(log.affected).toEqual(new Set([storeyId]));
    // 标高挂在楼层上，点的 (x, y) 与本层楼面无关 → 一个字都不该改
    expect(log.document.get(sharedId)).toEqual(point);
  });

  it('与上层重叠 → 抛；正好贴邻与留出空隙都合法（两条正对照）', () => {
    const { log, storeyId } = lCorner();
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 4500, heightMm: 3000 }));
    const before = log.document.canonical();
    // 本层抬到 1501：[1501, 4501) 与上层 [4500, 7500) 重叠 1mm
    expect(() =>
      log.dispatch(storeySetElevation({ storeyId, elevationMm: 1501 })),
    ).toThrow(/标高重叠/);
    expect(log.document.canonical()).toBe(before);
    // 正好贴邻：[1500, 4500) 与 [4500, 7500) 在半开区间下不相交
    log.dispatch(storeySetElevation({ storeyId, elevationMm: 1500 }));
    expect((log.document.get(storeyId) as StoreyEntity).elevationMm).toBe(1500);
    // 留出空隙：错层、夹层、吊顶都是真实工况 —— 只禁重叠，不禁缝
    log.dispatch(storeySetElevation({ storeyId, elevationMm: 0 }));
    expect((log.document.get(storeyId) as StoreyEntity).elevationMm).toBe(0);
  });

  it('负标高合法（地下室）：符号一律不查', () => {
    const { log, storeyId } = lCorner();
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    log.dispatch(storeySetElevation({ storeyId, elevationMm: -3000 }));
    expect((log.document.get(storeyId) as StoreyEntity).elevationMm).toBe(-3000);
    expect(log.document.byKind('storey')).toHaveLength(2);
  });

  it('storeyCreate 也拒绝重叠楼层（共用一份判据）；index 查重仍然先生效', () => {
    const { log } = lCorner();
    const before = log.document.canonical();
    // 二层建在 [2999, 5999)：与一层 [0, 3000) 重叠 1mm
    expect(() =>
      log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 2999, heightMm: 3000 })),
    ).toThrow(/标高重叠/);
    // index 重复走不到标高判据：两条判据各管一件事，顺序也不能反
    expect(() =>
      log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 9000, heightMm: 3000 })),
    ).toThrow(/index 重复/);
    expect(log.document.canonical()).toBe(before);
    expect(log.document.byKind('storey')).toHaveLength(1);
    expect(log.depth).toBe(3);
  });

  it('不同项目的楼层互不相干：标高重叠也各自成立', () => {
    const { log, storeyId } = lCorner();
    log.dispatch(
      storeyCreate({ projectId: uuidv7(), index: 0, elevationMm: 0, heightMm: 3000 }),
    );
    // 另一个项目已经占住 [0, 3000)，本项目的这层照旧抬到 100
    log.dispatch(storeySetElevation({ storeyId, elevationMm: 100 }));
    expect((log.document.get(storeyId) as StoreyEntity).elevationMm).toBe(100);
    expect(log.document.byKind('storey')).toHaveLength(2);
  });

  it('撤销标高改动逐字节复原，重做结果相同', () => {
    const { log, storeyId } = lCorner();
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    const before = log.document.canonical();
    log.dispatch(storeySetElevation({ storeyId, elevationMm: -500 }));
    expect(log.document.canonical()).not.toBe(before);
    expect(log.undo()).toBe(true);
    expect(log.document.canonical()).toBe(before);
    expect(log.redo()).toBe(true);
    expect((log.document.get(storeyId) as StoreyEntity).elevationMm).toBe(-500);
  });
});
