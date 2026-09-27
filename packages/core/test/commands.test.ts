import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  storeyCreate,
  uuidv7,
  wallCreate,
  wallDelete,
  wallMoveEndpoint,
  wallSetThickness,
  type ColumnEntity,
  type OpeningEntity,
  type PointEntity,
  type SlabEntity,
  type StoreyEntity,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();

function emptyLog(): TransactionLog {
  return new TransactionLog(Document.create(projectId));
}

function oneWall(log: TransactionLog): { storeyId: string; wallId: string } {
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  const storeyId = log.document.byKind('storey')[0]!.id;
  log.dispatch(
    wallCreate({
      storeyId,
      start: { x: 0, y: 0 },
      end: { x: 3600, y: 0 },
      thicknessMm: 240,
      heightMm: 3000,
    }),
  );
  return { storeyId, wallId: log.document.byKind('wall')[0]!.id };
}

describe('storeyCreate', () => {
  it('建楼层，可撤销回空文档', () => {
    const log = emptyLog();
    const before = log.document.canonical();
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    const storey = log.document.byKind('storey')[0] as StoreyEntity;
    expect(storey.elevationMm).toBe(0);
    expect(storey.heightMm).toBe(3000);
    log.undo();
    expect(log.document.canonical()).toBe(before);
  });

  it('index 重复时抛错', () => {
    const log = emptyLog();
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    expect(() =>
      log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 3000, heightMm: 3000 })),
    ).toThrow(/index/);
  });
});

describe('wallCreate', () => {
  it('建墙即带出两个端点，坐标落到整数毫米', () => {
    const log = emptyLog();
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    const storeyId = log.document.byKind('storey')[0]!.id;
    log.dispatch(
      wallCreate({
        storeyId,
        start: { x: 0, y: 0 },
        end: { x: 3600.4, y: 0.2 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    );
    const w = log.document.byKind('wall')[0] as WallEntity;
    const pts = log.document.byKind('point') as PointEntity[];
    expect(pts).toHaveLength(2);
    expect(w.endId).not.toBe(w.startId);
    expect(pts.find((p) => p.id === w.endId)!.x).toBe(3600);
    expect(w.loadBearing).toBe(true);
    expect(w.material).toBe('brick');
    expect(w.elevationOffsetMm).toBe(0);
  });

  it('浮点墙厚被拒：未量化的值不能进真源', () => {
    const log = emptyLog();
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    const storeyId = log.document.byKind('storey')[0]!.id;
    expect(() =>
      log.dispatch(
        wallCreate({
          storeyId,
          start: { x: 0, y: 0 },
          end: { x: 1000, y: 0 },
          thicknessMm: 240.5,
          heightMm: 3000,
        }),
      ),
    ).toThrow(/整数毫米/);
  });

  it('零长墙抛错', () => {
    const log = emptyLog();
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    const storeyId = log.document.byKind('storey')[0]!.id;
    expect(() =>
      log.dispatch(
        wallCreate({
          storeyId,
          start: { x: 100, y: 100 },
          end: { x: 100.2, y: 100.1 },
          thicknessMm: 240,
          heightMm: 3000,
        }),
      ),
    ).toThrow(/零长/);
  });

  it('墙厚不能大于等于自身长度（自相交轮廓的入口，先挡住）', () => {
    const log = emptyLog();
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    const storeyId = log.document.byKind('storey')[0]!.id;
    expect(() =>
      log.dispatch(
        wallCreate({
          storeyId,
          start: { x: 0, y: 0 },
          end: { x: 100, y: 0 },
          thicknessMm: 240,
          heightMm: 3000,
        }),
      ),
    ).toThrow(/不小于墙长/);
  });

  it('零墙厚被拒：真源里不存在零厚的墙', () => {
    const log = emptyLog();
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    const storeyId = log.document.byKind('storey')[0]!.id;
    expect(() =>
      log.dispatch(
        wallCreate({
          storeyId,
          start: { x: 0, y: 0 },
          end: { x: 3600, y: 0 },
          thicknessMm: 0,
          heightMm: 3000,
        }),
      ),
    ).toThrow(/墙厚必须为正/);
  });

  it('负墙厚被拒：符号在构造期就挡，不等派生层画歪', () => {
    const log = emptyLog();
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    const storeyId = log.document.byKind('storey')[0]!.id;
    expect(() =>
      log.dispatch(
        wallCreate({
          storeyId,
          start: { x: 0, y: 0 },
          end: { x: 3600, y: 0 },
          thicknessMm: -100,
          heightMm: 3000,
        }),
      ),
    ).toThrow(/墙厚必须为正/);
  });

  it('零墙高被拒：与墙厚同口径', () => {
    const log = emptyLog();
    log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
    const storeyId = log.document.byKind('storey')[0]!.id;
    expect(() =>
      log.dispatch(
        wallCreate({
          storeyId,
          start: { x: 0, y: 0 },
          end: { x: 3600, y: 0 },
          thicknessMm: 240,
          heightMm: 0,
        }),
      ),
    ).toThrow(/墙高必须为正/);
  });

  it('拿墙 id 当 storeyId 建墙被拒：楼层位必须是楼层', () => {
    const log = emptyLog();
    const { wallId } = oneWall(log);
    const depth = log.depth;
    expect(() =>
      log.dispatch(
        wallCreate({
          storeyId: wallId,
          start: { x: 0, y: 0 },
          end: { x: 3600, y: 0 },
          thicknessMm: 240,
          heightMm: 3000,
        }),
      ),
    ).toThrow(/不是楼层，是 wall/);
    // requireStorey 是 build 的第一行：抛在建点之前，墙数与日志深度都该原地不动
    expect(log.depth).toBe(depth);
    expect(log.document.byKind('wall')).toHaveLength(1);
  });
});

describe('wallSetThickness / wallMoveEndpoint', () => {
  it('改厚度并撤销回原值', () => {
    const log = emptyLog();
    const { wallId } = oneWall(log);
    const before = log.document.canonical();
    log.dispatch(wallSetThickness({ wallId, thicknessMm: 120 }));
    expect((log.document.get(wallId) as WallEntity).thicknessMm).toBe(120);
    log.undo();
    expect(log.document.canonical()).toBe(before);
  });

  it('移动端点只改那一个点，affected 恰好一个实体', () => {
    const log = emptyLog();
    const { wallId } = oneWall(log);
    const w = log.document.get(wallId) as WallEntity;
    log.dispatch(wallMoveEndpoint({ wallId, end: 'end', x: 4800, y: 900 }));
    expect((log.document.get(w.endId) as PointEntity).x).toBe(4800);
    expect((log.document.get(w.startId) as PointEntity).x).toBe(0);
    expect(log.affected).toEqual(new Set([w.endId]));
  });

  it('把端点移到与另一端同处 = 零长墙，抛错', () => {
    const log = emptyLog();
    const { wallId } = oneWall(log);
    const w = log.document.get(wallId) as WallEntity;
    const start = log.document.get(w.startId) as PointEntity;
    expect(() =>
      wallMoveEndpoint({ wallId, end: 'end', x: start.x, y: start.y }).build(log.document),
    ).toThrow(/零长/);
  });
});

describe('wallDelete', () => {
  function wallWithOpening(log: TransactionLog) {
    const { wallId, storeyId } = oneWall(log);
    log.dispatch({
      type: 'opening.create',
      // 不带 doc 形参：这条命令不读文档，留着会撞 noUnusedParameters（TS6133）。
      // Command 的 build 可以少写参数，TS 允许。
      build() {
        const opening: OpeningEntity = {
          kind: 'opening',
          id: uuidv7(),
          storeyId,
          hostWallId: wallId,
          distanceMm: 900,
          widthMm: 900,
          heightMm: 2100,
          sillMm: 0,
          category: 'door',
        };
        return { upsert: [opening], remove: [] };
      },
    });
    const openingId = log.document.byKind('opening')[0]!.id;
    return { wallId, openingId };
  }

  it('删墙级联删其洞口', () => {
    const log = emptyLog();
    const { wallId, openingId } = wallWithOpening(log);
    expect(log.document.get(openingId)).toBeDefined();
    log.dispatch(wallDelete({ wallId }));
    expect(log.document.get(wallId)).toBeUndefined();
    expect(log.document.get(openingId)).toBeUndefined();
  });

  it('无人引用的端点被回收，仍被引用的留下', () => {
    const log = emptyLog();
    const { wallId } = oneWall(log);
    const first = log.document.get(wallId) as WallEntity;
    // 第二面墙共享 first.endId
    log.dispatch({
      type: 'wall.create',
      build() {
        const end: PointEntity = {
          kind: 'point',
          id: uuidv7(),
          storeyId: first.storeyId,
          x: 3600,
          y: 2400,
        };
        const w: WallEntity = {
          kind: 'wall',
          id: uuidv7(),
          storeyId: first.storeyId,
          startId: first.endId,
          endId: end.id,
          thicknessMm: 240,
          heightMm: 3000,
          elevationOffsetMm: 0,
          loadBearing: true,
          material: 'brick',
        };
        return { upsert: [end, w], remove: [] };
      },
    });
    const sharedEnd = first.endId;
    const orphanStart = first.startId;
    log.dispatch(wallDelete({ wallId }));
    expect(log.document.get(orphanStart)).toBeUndefined();
    expect(log.document.get(sharedEnd)).toBeDefined();
  });

  it('删不存在的墙抛错', () => {
    const log = emptyLog();
    expect(() => wallDelete({ wallId: uuidv7() }).build(log.document)).toThrow(/不存在/);
  });

  it('端点仍被柱或板引用时不回收', () => {
    const log = emptyLog();
    const { wallId, storeyId } = oneWall(log);
    const wall = log.document.get(wallId) as WallEntity;
    log.dispatch({
      type: 'column.create',
      build() {
        const column: ColumnEntity = {
          kind: 'column',
          id: uuidv7(),
          storeyId,
          pointId: wall.startId,
          widthMm: 400,
          depthMm: 400,
          heightMm: 3000,
          loadBearing: true,
          material: 'concrete',
        };
        const slab: SlabEntity = {
          kind: 'slab',
          id: uuidv7(),
          storeyId,
          // 故意只挂终点：让"查柱"与"查板"两条分支各自决定一个点的生死，
          // 否则起点被柱和板同时引用，漏查板也能蒙过。板边界点数与环合法性从 Task 8 起由 slabCreate
          // 校验：这个 1 顶点边界只有绕开命令层的手写裸补丁才留得住，能拒它的最早也要到计划 4 落库。
          boundaryPointIds: [wall.endId],
          thicknessMm: 120,
          elevationOffsetMm: 0,
        };
        return { upsert: [column, slab], remove: [] };
      },
    });
    log.dispatch(wallDelete({ wallId }));
    // 起点只剩柱引用，终点只剩板引用：两条引用扫描少一条就会误删
    expect(log.document.get(wall.startId)).toBeDefined();
    expect(log.document.get(wall.endId)).toBeDefined();
  });

  it('撤消删除后墙、洞口、端点全部原样回来', () => {
    const log = emptyLog();
    const { wallId, openingId } = wallWithOpening(log);
    const before = log.document.canonical();
    log.dispatch(wallDelete({ wallId }));
    expect(log.document.canonical()).not.toBe(before);
    log.undo();
    expect(log.document.get(wallId)).toBeDefined();
    expect(log.document.get(openingId)).toBeDefined();
    expect(log.document.canonical()).toBe(before);
  });
});
