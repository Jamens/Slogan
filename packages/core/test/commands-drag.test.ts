import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  columnCreate,
  storeyCreate,
  uuidv7,
  wallCreate,
  wallMoveEndpoint,
  type ColumnEntity,
  type PointEntity,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();

/** 拐角在 (3600, 0) 的 L 形，第二面墙拉到 (3600, 4800)：给"把柱拖到另一根柱头上"留出合法落点。 */
function lCorner(): {
  log: TransactionLog;
  storeyId: string;
  sharedId: string;
  first: WallEntity;
  second: WallEntity;
} {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 6000 }));
  const storeyId = storeyByIndex(log, 0);
  const first = addWall(log, storeyId, {
    start: { x: 0, y: 0 },
    end: { x: 3600, y: 0 },
    thicknessMm: 240,
  });
  const sharedId = first.endId;
  const second = addWall(log, storeyId, {
    start: { pointId: sharedId },
    end: { x: 3600, y: 4800 },
    thicknessMm: 240,
  });
  return { log, storeyId, sharedId, first, second };
}

function storeyByIndex(log: TransactionLog, index: number): string {
  const hit = log.document.byKind('storey').find((s) => s.index === index);
  if (!hit) throw new Error(`测试找不到楼层 index=${index}`);
  return hit.id;
}

function addWall(
  log: TransactionLog,
  storeyId: string,
  spec: { start: { x: number; y: number } | { pointId: string }; end: { x: number; y: number } | { pointId: string }; thicknessMm: number },
): WallEntity {
  log.dispatch(wallCreate({ storeyId, heightMm: 6000, ...spec }));
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建墙');
}

function addColumn(
  log: TransactionLog,
  storeyId: string,
  at: { x: number; y: number } | { pointId: string },
): ColumnEntity {
  log.dispatch(columnCreate({ storeyId, at, widthMm: 400, depthMm: 400 }));
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'column') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建柱');
}

const pointAt = (log: TransactionLog, id: string): PointEntity =>
  log.document.get(id) as PointEntity;

/** 整条重影文案钉一次，两个产地共用（`columnCreate` 与 `wallMoveEndpoint` 必须说同一句话）。 */
const GHOST_AT_2400 =
  /^该坐标已有柱 [0-9a-f-]+（点 [0-9a-f-]+，落在 \(3600, 2400\)）：同一层的同一个坐标上不能立两根柱$/;

describe('拖共享端点与柱（计划 2 Ruling ㊤ 的落点）', () => {
  it('拖共享端点 ⇒ 挂在点上的柱跟走：还是那一根柱、同一个落点引用，坐标跟着变', () => {
    const { log, storeyId, sharedId, first } = lCorner();
    const column = addColumn(log, storeyId, { pointId: sharedId });
    const depth = log.depth;
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 1200 }));
    // 跟走 = 柱实体一个字都没动，动的只是它引用的那枚点。若这里改写成"upsert 一份新柱"，
    // 第二条断言会红：affected 里只有点，没有柱。
    expect(log.document.get(column.id)).toBe(column);
    expect([pointAt(log, column.pointId).x, pointAt(log, column.pointId).y]).toEqual([3600, 1200]);
    expect(log.document.byKind('column')).toHaveLength(1);
    expect(log.document.byKind('point')).toHaveLength(3); // 没新建点：复用即跟走
    expect(log.depth).toBe(depth + 1);
  });

  it('把骑手柱拖到另一根柱的坐标上 ⇒ 抛，且真源与撤销栈原地不动（第二处复核在 build 内）', () => {
    const { log, storeyId, sharedId, first } = lCorner();
    addColumn(log, storeyId, { pointId: sharedId });
    addColumn(log, storeyId, { x: 3600, y: 2400 });
    const depth = log.depth;
    const before = log.document.canonical();
    // (3600,2400) 这个落点几何上完全合法：first 长 4326、second 长 2400，都大于各自墙厚。
    // 所以这一发能红的唯一原因就是重影复核 —— 摘掉那行它就绿，见 Step 4 的 M13。
    expect(() =>
      log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 2400 })),
    ).toThrow(GHOST_AT_2400);
    expect(log.depth).toBe(depth);
    expect(log.document.canonical()).toBe(before);
  });

  it('建柱与拖动两个产地共用同一份判据 ⇒ 同一句文案（抽函数没改口径）', () => {
    const { log, storeyId } = lCorner();
    addColumn(log, storeyId, { x: 3600, y: 2400 });
    expect(() =>
      log.dispatch(
        columnCreate({ storeyId, at: { x: 3600, y: 2400 }, widthMm: 400, depthMm: 400 }),
      ),
    ).toThrow(GHOST_AT_2400);
  });

  it('钉住"同层"这半边：另一层同坐标有柱不算重影，拖动照走（正对照）', () => {
    const { log, storeyId, sharedId, first } = lCorner();
    addColumn(log, storeyId, { pointId: sharedId });
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 6000, heightMm: 6000 }));
    addColumn(log, storeyByIndex(log, 1), { x: 3600, y: 2400 });
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 2400 }));
    expect([pointAt(log, sharedId).x, pointAt(log, sharedId).y]).toEqual([3600, 2400]);
    expect(log.document.byKind('column')).toHaveLength(2);
  });

  it('原地拖（落点与当前坐标逐字相同）⇒ 不抛：骑手柱自己不算对手', () => {
    const { log, storeyId, sharedId, first } = lCorner();
    addColumn(log, storeyId, { pointId: sharedId });
    const depth = log.depth;
    const before = log.document.canonical();
    // exceptPointId 那一行 continue 只在这条路上有牙齿：不排自己，"点了把手又原样松开"
    // 会报"该坐标已有柱"。renderer 用 D4 的 noop 过滤挡掉这一发，但命令层不许靠上层守规矩 ——
    // 计划 4 的批量导入、计划 5 的图面复核都直接 dispatch 命令。
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 0 }));
    expect(log.depth).toBe(depth + 1); // 确实发出去了（不是被谁悄悄吞掉）
    expect(log.document.canonical()).toBe(before); // 而真源逐字节没变：这是一步空操作
  });
});

describe('wallMoveEndpoint 的 end:start 角色反转（计划 2 转下游 #1 收口）', () => {
  it('拖 start 端 ⇒ 动的只有 startId 那枚点，endId 一字未改，affected 恰好 {startId}', () => {
    const { log, first, sharedId } = lCorner();
    expect(first.startId).not.toBe(sharedId);
    const before = log.document.get(first.startId) as PointEntity;
    const cornerBefore = log.document.get(sharedId) as PointEntity;
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'start', x: 1200, y: 900 }));
    const after = log.document.get(first.startId) as PointEntity;
    expect([before.x, before.y]).toEqual([0, 0]);
    expect([after.x, after.y]).toEqual([1200, 900]);
    expect(log.affected).toEqual(new Set([first.startId]));
    // 拐角那枚点（= first.endId）压根没进补丁：applyPatch 用 `new Map(doc.entities)` 抄表，
    // 没被 upsert 的实体保持**对象同一性**。所以引用相等比"坐标没变"更强 ——
    // "把同一个坐标重述一遍"那种假改动（坐标断言看不出）会在这里红。
    expect(log.document.get(sharedId)).toBe(cornerBefore);
    expect([cornerBefore.x, cornerBefore.y]).toEqual([3600, 0]);
  });

  it('把 start 端拖到离 end 只剩 100mm ⇒ 拒的是本墙，守卫盯的是被拖的那一端', () => {
    const { log, second, sharedId } = lCorner();
    const depth = log.depth;
    const before = log.document.canonical();
    // second 是 (3600,0)-(3600,4800)、厚 240：start 拖到 (3600,4700) 之后轴长 100 < 240。
    // 角色写反了会拿"另一端点"当被拖端，那一发拒的是别的东西甚至放行。
    expect(() =>
      log.dispatch(wallMoveEndpoint({ wallId: second.id, end: 'start', x: 3600, y: 4700 })),
    ).toThrow(/移动端点会让墙 .* 的墙厚 240 不小于轴长 100/);
    expect(log.depth).toBe(depth);
    expect(log.document.canonical()).toBe(before);
    expect([pointAt(log, sharedId).x, pointAt(log, sharedId).y]).toEqual([3600, 0]);
  });
});
