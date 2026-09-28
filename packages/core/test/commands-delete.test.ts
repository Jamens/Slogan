// 删除侧的三条补口命令（storey.delete / column.delete / slab.delete）与那一份孤儿判据
// （pointStillReferenced）。计划 3 Task 7 的 A2 与 A3。
//
// 两条口径贯穿整个文件：① 级联与孤儿判定各只有一个产地（问 dependentsOf 与
// pointStillReferenced，不在命令里再数一遍）；② 删除路径一律不跑派生复核 ——
// 坏数据必须还能删，守卫挡住删除等于把文档锁死（正面用例在 derive-guard.test.ts）。
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  applyPatch,
  columnCreate,
  columnDelete,
  deriveStoreyGeometry,
  openingCreate,
  pointStillReferenced,
  slabCreate,
  slabDelete,
  storeyCreate,
  storeyDelete,
  uuidv7,
  wallCreate,
  wallDelete,
  type Entity,
  type EntityId,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();

/** 往文档里贴/换一条实体，其余原样。手搓坏文档只走这条路。 */
function withEntity(doc: Document, entity: Entity): Document {
  const merged = new Map<EntityId, Entity>();
  for (const kind of ['storey', 'point', 'wall', 'opening', 'column', 'slab'] as const) {
    for (const e of doc.byKind(kind)) merged.set(e.id, e);
  }
  merged.set(entity.id, entity);
  return Document.replaceEntities(doc, merged);
}

function newLog(): TransactionLog {
  return new TransactionLog(Document.create(projectId));
}

function addStorey(log: TransactionLog, index: number): EntityId {
  log.dispatch(storeyCreate({ projectId, index, elevationMm: index * 3000, heightMm: 3000 }));
  const storey = log.document.byKind('storey').find((s) => s.index === index);
  if (!storey) throw new Error(`建不出序号 ${index} 的楼层`);
  return storey.id;
}

function addWall(
  log: TransactionLog,
  storeyId: EntityId,
  start: { x: number; y: number } | { pointId: EntityId },
  end: { x: number; y: number } | { pointId: EntityId },
): WallEntity {
  log.dispatch(
    wallCreate({ storeyId, start, end, thicknessMm: 240, heightMm: 3000, material: 'brick' }),
  );
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new Error('dispatch 之后没找到新墙');
}

/**
 * 一层里塞满四类下游：墙（墙上挂樘门）、柱、板，加上各自的点。
 * 坐标彼此离远，除了墙自己，别给删除添接头上的麻烦。
 */
function fullStorey(log: TransactionLog, storeyId: EntityId) {
  const wall = addWall(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
  log.dispatch(
    openingCreate({
      hostWallId: wall.id,
      distanceMm: 1000,
      widthMm: 900,
      heightMm: 2100,
      category: 'door',
    }),
  );
  const openingId = log.document.byKind('opening')[0]!.id;
  log.dispatch(columnCreate({ storeyId, at: { x: 9000, y: 9000 }, widthMm: 400, depthMm: 400 }));
  const columnId = log.document.byKind('column')[0]!.id;
  log.dispatch(
    slabCreate({
      storeyId,
      boundary: [
        { x: 20000, y: 20000 },
        { x: 26000, y: 20000 },
        { x: 26000, y: 24000 },
      ],
      thicknessMm: 120,
    }),
  );
  return { wallId: wall.id, openingId, columnId, slabId: log.document.byKind('slab')[0]!.id };
}

describe('storeyDelete 的级联', () => {
  it('楼层的下游全在删除集里：墙、洞口、柱、板、点一个不漏，upsert 恒空', () => {
    const log = newLog();
    const storeyId = addStorey(log, 0);
    // 空着的第二层只为满足"最后一层不许删"而存在（见下面那条用例），不参与删除集
    addStorey(log, 1);
    const { wallId, openingId, columnId, slabId } = fullStorey(log, storeyId);
    const patch = storeyDelete({ storeyId }).build(log.document);
    expect(patch.upsert).toEqual([]);
    const remove = new Set(patch.remove);
    expect(remove.has(storeyId)).toBe(true);
    for (const id of [wallId, openingId, columnId, slabId]) expect(remove.has(id)).toBe(true);
    // 点也一起走：这层的点数 = 墙 2 + 柱 1 + 板 3
    const points = log.document.byKind('point').filter((p) => p.storeyId === storeyId);
    expect(points).toHaveLength(6);
    for (const point of points) expect(remove.has(point.id)).toBe(true);
    expect(remove.size).toBe(11);
  });

  it('只动本层：另一层的墙与点不在删除集里', () => {
    const log = newLog();
    const one = addStorey(log, 0);
    const two = addStorey(log, 1);
    fullStorey(log, one);
    const other = addWall(log, two, { x: 0, y: 0 }, { x: 3000, y: 0 });
    const patch = storeyDelete({ storeyId: one }).build(log.document);
    const remove = new Set(patch.remove);
    expect(remove.has(other.id)).toBe(false);
    for (const point of log.document.byKind('point').filter((p) => p.storeyId === two)) {
      expect(remove.has(point.id)).toBe(false);
    }
    expect(remove.has(two)).toBe(false);
    // 反面对照：本层那面墙确实在删除集里，别是"什么都删不到"蒙对了第一条
    expect(remove.has(log.document.byKind('wall').find((w) => w.storeyId === one)!.id)).toBe(true);
  });

  it('删除补丁逐字可重放：同一文档 build 两次，remove 数组连顺序都相同', () => {
    const log = newLog();
    const storeyId = addStorey(log, 0);
    addStorey(log, 1);
    fullStorey(log, storeyId);
    const cmd = storeyDelete({ storeyId });
    // 顺序 = dependentsOf 的书写顺序（墙→洞口→柱→板）再接点（byKind 的 id 升序）。
    // 写死的不是这一串 id（它们是 uuid），写死的是"两次调用给出同一个数组"。
    expect(cmd.build(log.document).remove).toEqual(cmd.build(log.document).remove);
  });

  it('删完这一层，另一层照常派生得动；undo 把整层原样还回来，redo 再带走', () => {
    const log = newLog();
    const one = addStorey(log, 0);
    const two = addStorey(log, 1);
    fullStorey(log, one);
    addWall(log, two, { x: 0, y: 0 }, { x: 3000, y: 0 });
    const before = log.document.canonical();
    log.dispatch(storeyDelete({ storeyId: one }));
    expect(log.document.byKind('storey')).toHaveLength(1);
    expect(log.document.byKind('wall')).toHaveLength(1);
    expect(() => deriveStoreyGeometry(log.document, two)).not.toThrow();
    expect(log.undo()).toBe(true);
    expect(log.document.canonical()).toBe(before);
    expect(log.redo()).toBe(true);
    expect(log.document.byKind('wall')).toHaveLength(1);
  });

  it('空层也删得掉：删除集就只有楼层自己', () => {
    const log = newLog();
    addStorey(log, 0);
    const two = addStorey(log, 1);
    expect(storeyDelete({ storeyId: two }).build(log.document)).toEqual({
      upsert: [],
      remove: [two],
    });
  });

  it('最后一层不许删：S1 不产零层项目（fitStorey 对空点集是抛的）', () => {
    const log = newLog();
    const one = addStorey(log, 0);
    expect(() => storeyDelete({ storeyId: one }).build(log.document)).toThrow(/最后一层/);
    // 有了第二层就删得动：判据是"同项目还有别的楼层"，不是"文档里还有别的实体"
    const two = addStorey(log, 1);
    expect(() => storeyDelete({ storeyId: one }).build(log.document)).not.toThrow();
    expect(() => storeyDelete({ storeyId: two }).build(log.document)).not.toThrow();
  });

  it('闭合性检查兜住跨层悬空：别层的墙指着本层的点 → 抛，不留下断链', () => {
    const log = newLog();
    const one = addStorey(log, 0);
    const two = addStorey(log, 1);
    const victim = addWall(log, one, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const own = addWall(log, two, { x: 8000, y: 0 }, { x: 9000, y: 0 });
    // 手工把二层再加一面墙：一端指一层的点。命令层走不出这种文档
    // （resolvePointRef 限同层），但读盘与手搓能 —— 真源不校验引用完整性，
    // 所以删除侧必须自己数闭合。
    const doc = withEntity(log.document, {
      kind: 'wall',
      id: uuidv7(),
      storeyId: two,
      startId: victim.startId,
      endId: own.startId,
      thicknessMm: 240,
      heightMm: 3000,
      elevationOffsetMm: 0,
      loadBearing: true,
      material: 'brick',
    });
    expect(() => storeyDelete({ storeyId: one }).build(doc)).toThrow(/会留下悬空引用/);
    // 二层自己删得动：那面越界的墙在二层的删除集里，被它引用的点不属于二层、也不被删
    expect(() => storeyDelete({ storeyId: two }).build(doc)).not.toThrow();
  });
});

describe('columnDelete 与 slabDelete 的孤儿点', () => {
  it('柱的落点没人共用 → 点跟着删；落在墙端点上 → 只删柱，点留着', () => {
    const log = newLog();
    const storeyId = addStorey(log, 0);
    const wall = addWall(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    log.dispatch(columnCreate({ storeyId, at: { x: 9000, y: 9000 }, widthMm: 400, depthMm: 400 }));
    const own = log.document.byKind('column')[0]!;
    log.dispatch(
      columnCreate({ storeyId, at: { pointId: wall.startId }, widthMm: 400, depthMm: 400 }),
    );
    const shared = log.document.byKind('column').find((c) => c.pointId === wall.startId)!;

    expect(columnDelete({ columnId: own.id }).build(log.document).remove).toEqual([
      own.id,
      own.pointId,
    ]);
    expect(columnDelete({ columnId: shared.id }).build(log.document).remove).toEqual([shared.id]);
    // 那一发真的删不掉点：applyPatch 之后墙端点还在，墙于是还是那面墙
    const next = applyPatch(log.document, columnDelete({ columnId: own.id }).build(log.document))
      .doc;
    expect(next.get(wall.startId)).toBeDefined();
    expect(next.get(own.pointId)).toBeUndefined();
  });

  it('板的角点：独占的删、与墙共用的留', () => {
    const log = newLog();
    const storeyId = addStorey(log, 0);
    const a = addWall(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    addWall(log, storeyId, { pointId: a.endId }, { x: 4000, y: 3000 });
    // 板的第 1、2 个角复用两枚墙端点，第 3 个角是板自己新建的
    log.dispatch(
      slabCreate({
        storeyId,
        boundary: [{ pointId: a.startId }, { pointId: a.endId }, { x: 8000, y: 8000 }],
        thicknessMm: 120,
      }),
    );
    const slab = log.document.byKind('slab')[0]!;
    const ownCorner = slab.boundaryPointIds[2]!;
    expect(slab.boundaryPointIds.slice(0, 2)).toEqual([a.startId, a.endId]);
    expect(slabDelete({ slabId: slab.id }).build(log.document).remove).toEqual([
      slab.id,
      ownCorner,
    ]);
    const next = applyPatch(log.document, slabDelete({ slabId: slab.id }).build(log.document)).doc;
    expect(next.get(a.startId)).toBeDefined();
    expect(next.get(ownCorner)).toBeUndefined();
  });

  it('角点早就悬空的板仍删得掉：remove 里不许有文档里不存在的 id', () => {
    const log = newLog();
    const storeyId = addStorey(log, 0);
    log.dispatch(
      slabCreate({
        storeyId,
        boundary: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }],
        thicknessMm: 120,
      }),
    );
    const slab = log.document.byKind('slab')[0]!;
    const ghost = uuidv7();
    // 手工把一角换成不存在的 id：`applyPatch` 对不存在的 remove id 是**抛**的，
    // 少这一句跳过，一块缺角的板就把整份文档锁死。
    const doc = withEntity(log.document, {
      ...slab,
      boundaryPointIds: [ghost, ...slab.boundaryPointIds.slice(1)],
    });
    const patch = slabDelete({ slabId: slab.id }).build(doc);
    expect(patch.remove).not.toContain(ghost);
    expect(() => applyPatch(doc, patch)).not.toThrow();
    expect(applyPatch(doc, patch).doc.byKind('slab')).toHaveLength(0);
  });
});

describe('pointStillReferenced：孤儿判据只有一个产地', () => {
  /** 一枚点被墙引用、另一枚被柱引用、第三枚被板引用 —— 三种引用各验一次。 */
  function refs(log: TransactionLog, storeyId: EntityId) {
    const wall = addWall(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    log.dispatch(
      columnCreate({ storeyId, at: { pointId: wall.startId }, widthMm: 400, depthMm: 400 }),
    );
    const column = log.document.byKind('column')[0]!;
    log.dispatch(
      slabCreate({
        storeyId,
        boundary: [{ pointId: wall.endId }, { x: 1000, y: 5000 }, { x: 2000, y: 5000 }],
        thicknessMm: 120,
      }),
    );
    const slab = log.document.byKind('slab')[0]!;
    return { wall, column, slab };
  }

  it('墙、柱、板三种引用都认；exceptIds 排除掉引用者自己之后才算孤儿', () => {
    const log = newLog();
    const storeyId = addStorey(log, 0);
    const { wall, column, slab } = refs(log, storeyId);
    const ownCorner = slab.boundaryPointIds[1]!;
    const none = new Set<EntityId>();
    expect(pointStillReferenced(log.document, wall.startId, none)).toBe(true);
    expect(pointStillReferenced(log.document, wall.endId, none)).toBe(true);
    expect(pointStillReferenced(log.document, ownCorner, none)).toBe(true);
    // 排除柱自己：那点仍被墙端引用 → 不是孤儿
    expect(pointStillReferenced(log.document, column.pointId, new Set([column.id]))).toBe(true);
    // 排除墙自己：那点仍被柱引用 → 不是孤儿
    expect(pointStillReferenced(log.document, wall.startId, new Set([wall.id]))).toBe(true);
    // 排除板自己：它独占的那个角点于是成为孤儿
    expect(pointStillReferenced(log.document, ownCorner, new Set([slab.id]))).toBe(false);
  });

  it('wallDelete 用的就是这一份判据：删墙不动被柱、板共用的两枚端点', () => {
    const log = newLog();
    const storeyId = addStorey(log, 0);
    const { wall, column, slab } = refs(log, storeyId);
    expect(wallDelete({ wallId: wall.id }).build(log.document).remove).toEqual([wall.id]);
    log.dispatch(wallDelete({ wallId: wall.id }));
    expect(log.document.get(column.pointId)).toBeDefined();
    expect(log.document.get(slab.boundaryPointIds[0]!)).toBeDefined();
    // 对照：一根没人引用的墙（同层再建一面独立的）删下去会把两个端点一起带走
    const lone = addWall(log, storeyId, { x: 30000, y: 30000 }, { x: 34000, y: 30000 });
    expect(wallDelete({ wallId: lone.id }).build(log.document).remove).toEqual([
      lone.id,
      lone.startId,
      lone.endId,
    ]);
  });
});
