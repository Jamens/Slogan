// 共享端点进真源（PointRef / resolvePointRef / 查询）与移动端点的邻墙守卫
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  dependentsOf,
  incidentWallEnds,
  isExistingPoint,
  resolvePointRef,
  sharedPointIds,
  storeyCreate,
  uuidv7,
  wallCreate,
  wallDelete,
  wallMoveEndpoint,
  type ColumnEntity,
  type OpeningEntity,
  type PointEntity,
  type SlabEntity,
  type WallCreateInput,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();

/**
 * 取这次 dispatch 新建的墙。**不能**写 `byKind('wall').at(-1)`：
 * 计划 1 的 ids.test.ts 专门钉了"同毫秒不保证有序"，同一毫秒建两面墙时那样取是掷硬币。
 * `affected` 恰好是本次补丁写入的 id 集合（patch.upsert 顺序：起点、终点、墙），
 * 里面只有一面墙，取它确定无疑。
 */
function lastWall(log: TransactionLog): WallEntity {
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new Error('最近一次 dispatch 没有新建墙');
}

function buildLog(): TransactionLog {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  return log;
}

function storey0(log: TransactionLog): string {
  return storeyByIndex(log, 0);
}

/**
 * 按 index 取楼层 id。**不要**写 `byKind('storey')[1]`：byKind 是 id 升序，
 * 而同一毫秒内的 uuidv7 不保证单调（Global Constraints），两个楼层的下标是掷硬币。
 */
function storeyByIndex(log: TransactionLog, index: number): string {
  const hit = log.document.byKind('storey').find((s) => s.index === index);
  if (!hit) throw new Error(`测试找不到楼层 index=${index}`);
  return hit.id;
}

/**
 * heightMm 也排除掉：它是 WallCreateInput 的必填字段，留着 Omit 就得写死它，
 * 而 addWall 本来就是替用例把层高补齐（写了反而触发 TS2783 的重复指定）。
 */
function addWall(
  log: TransactionLog,
  spec: Omit<WallCreateInput, 'storeyId' | 'heightMm'>,
): WallEntity {
  log.dispatch(wallCreate({ storeyId: storey0(log), heightMm: 3000, ...spec }));
  return lastWall(log);
}

/** 拐角在 (3600, 0)：第一面墙 A(0,0)→B，第二面墙 B→C(3600,2400)，B 是共享点。 */
function lCorner(): {
  log: TransactionLog;
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
  return { log, sharedId, first, second };
}

describe('PointRef 与 resolvePointRef', () => {
  it('isExistingPoint 认得两种形态', () => {
    expect(isExistingPoint({ x: 0, y: 0 })).toBe(false);
    expect(isExistingPoint({ pointId: uuidv7() })).toBe(true);
    // 三个字段都给时以 pointId 为准：判据不能写成 "没有 x 就是复用"
    expect(isExistingPoint({ x: 1, y: 2, pointId: uuidv7() })).toBe(true);
  });

  it('坐标字面量给 null：点还不存在，由命令层新建', () => {
    const log = buildLog();
    expect(resolvePointRef(log.document, { x: 100, y: 200 }, storey0(log))).toBeNull();
  });

  it('既有 pointId 给点本体', () => {
    const { log, sharedId } = lCorner();
    const p = resolvePointRef(log.document, { pointId: sharedId }, storey0(log));
    expect(p).not.toBeNull();
    expect(p!.x).toBe(3600);
    expect(p!.y).toBe(0);
    expect(p!.storeyId).toBe(storey0(log));
  });

  it('跨楼层复用直接抛：点属于别的楼层', () => {
    const log = buildLog();
    const s0 = storey0(log);
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    const s1 = storeyByIndex(log, 1);
    expect(s1).not.toBe(s0);
    // 手工造一个属于楼层 1 的点：只为把"异层的点"单独摆出来给 resolvePointRef 判。
    // 注意"点不能凭空长出来"这说法到 Task 3 之后已经不成立：wallCreate({ storeyId: s1, … })
    // 就会在楼层 1 上长出点，所以这条跨层拒绝完全能从真 dispatch 里投出来。
    // 真正留给 Task 10 的是**两层墙网**的整合（两层各有一张互相引用的网），不是这条守卫。
    const p: PointEntity = { kind: 'point', id: uuidv7(), storeyId: s1, x: 800, y: 800 };
    const doc = Document.replaceEntities(
      log.document,
      new Map([...log.document.entities, [p.id, p]]),
    );
    expect(() => resolvePointRef(doc, { pointId: p.id }, s0)).toThrow(/属于楼层/);
    expect(() => resolvePointRef(doc, { pointId: p.id }, s0)).toThrow(/不能给楼层/);
    // 正对照：同一点交给它自己的楼层就不抛，说明抛错的原因是跨层而不是点本身非法
    expect(resolvePointRef(doc, { pointId: p.id }, s1)).toBe(p);
  });

  it('pointId 指向非点实体时抛「端点 不是 point 实体」', () => {
    const { log, first } = lCorner();
    expect(() => resolvePointRef(log.document, { pointId: first.id }, storey0(log))).toThrow(
      /端点 不是 point 实体/,
    );
  });
});

describe('共享端点查询', () => {
  it('incidentWallEnds：拐角两面墙，排除自己只剩邻墙，且端点角色正确', () => {
    const { log, sharedId, first, second } = lCorner();
    const all = incidentWallEnds(log.document, sharedId);
    // 不能写成 toEqual([first…, second…])：byKind 按 id 升序，而这两面墙几乎总在同一毫秒建成，
    // 同毫秒的 uuidv7 先后是掷硬币（ids.test.ts 钉过）。比集合 + 逐个钉端点角色，
    // 与顺序无关但照样钉得住"少了 startId 那一支"这种变异。
    expect(all).toHaveLength(2);
    expect(new Set(all.map((ref) => ref.wallId))).toEqual(new Set([first.id, second.id]));
    expect(all.find((ref) => ref.wallId === first.id)?.end).toBe('end');
    expect(all.find((ref) => ref.wallId === second.id)?.end).toBe('start');
    expect(incidentWallEnds(log.document, sharedId, first.id)).toEqual([
      { wallId: second.id, end: 'start' },
    ]);
  });

  it('incidentWallEnds：独占的点只有自己', () => {
    const { log, sharedId, first } = lCorner();
    expect(incidentWallEnds(log.document, first.startId)).toEqual([
      { wallId: first.id, end: 'start' },
    ]);
    expect(incidentWallEnds(log.document, first.startId, first.id)).toEqual([]);
    // 起点不是拐角那个点：少了这条，"整面墙两端同点"的假文档也能过上面两条
    expect(first.startId).not.toBe(sharedId);
  });

  it('sharedPointIds：孤墙给空，L 形给那一个', () => {
    const lonely = buildLog();
    addWall(lonely, { start: { x: 0, y: 0 }, end: { x: 3600, y: 0 }, thicknessMm: 240 });
    expect(sharedPointIds(lonely.document)).toEqual([]);
    const { log, sharedId } = lCorner();
    expect(sharedPointIds(log.document)).toEqual([sharedId]);
    expect(log.document.byKind('point')).toHaveLength(3);
  });
});

describe('dependentsOf', () => {
  /** 一个 L 角 + 挂在第一面墙上的门 + 落在共享点的柱与板 */
  function docWithEverything(): {
    log: TransactionLog;
    doc: Document;
    first: WallEntity;
    second: WallEntity;
    sharedId: string;
    openingId: string;
    columnId: string;
    slabId: string;
  } {
    const { log, sharedId, first, second } = lCorner();
    const storeyId = storey0(log);
    const opening: OpeningEntity = {
      kind: 'opening',
      id: uuidv7(),
      storeyId,
      hostWallId: first.id,
      distanceMm: 500,
      widthMm: 900,
      heightMm: 2100,
      sillMm: 0,
      category: 'door',
    };
    const column: ColumnEntity = {
      kind: 'column',
      id: uuidv7(),
      storeyId,
      pointId: sharedId,
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
      boundaryPointIds: [sharedId],
      thicknessMm: 120,
      elevationOffsetMm: 0,
    };
    const doc = Document.replaceEntities(
      log.document,
      new Map([
        ...log.document.entities,
        [opening.id, opening],
        [column.id, column],
        [slab.id, slab],
      ]),
    );
    return {
      log,
      doc,
      first,
      second,
      sharedId,
      openingId: opening.id,
      columnId: column.id,
      slabId: slab.id,
    };
  }

  it('点 → 引用它的墙柱板；只给一层，洞口的下游要调用方自己迭代', () => {
    const x = docWithEverything();
    expect(new Set(dependentsOf(x.doc, x.sharedId))).toEqual(
      new Set([x.first.id, x.second.id, x.columnId, x.slabId]),
    );
    // 洞口挂在墙下：本函数不递归，Task 9 负责迭代到不动点
    expect(dependentsOf(x.doc, x.sharedId)).not.toContain(x.openingId);
  });

  it('墙 → 它的洞口', () => {
    const x = docWithEverything();
    expect(dependentsOf(x.doc, x.first.id)).toEqual([x.openingId]);
  });

  it('楼层 → 该层全部构件（墙/洞口/柱/板）', () => {
    const x = docWithEverything();
    // 楼层的下游是该层全部构件：柱与板也挂着 storeyId，漏了它们 Task 8 的
    // storey.setElevation 就漏算下游
    expect(new Set(dependentsOf(x.doc, storey0(x.log)))).toEqual(
      new Set([
        ...x.doc.byKind('wall').map((w) => w.id),
        x.openingId,
        x.columnId,
        x.slabId,
      ]),
    );
  });

  it('叶子（洞口/柱/板）给空；实体不存在直接抛', () => {
    const x = docWithEverything();
    expect(dependentsOf(x.doc, x.openingId)).toEqual([]);
    expect(dependentsOf(x.doc, x.columnId)).toEqual([]);
    expect(dependentsOf(x.doc, x.slabId)).toEqual([]);
    expect(() => dependentsOf(x.doc, uuidv7())).toThrow(/实体 不存在/);
  });
});

// 命令级用例：wallCreate 复用 / wallMoveEndpoint 邻墙守卫 / wallDelete 与共享点
describe('wallCreate 复用端点进真源', () => {
  it('L 形只新建 3 个点；同坐标各建各的仍是 4 个点', () => {
    const { log, sharedId, second } = lCorner();
    expect(log.document.byKind('point')).toHaveLength(3);
    expect(sharedPointIds(log.document)).toEqual([sharedId]);
    expect(second.startId).toBe(sharedId);
    // 正对照：同样几何、不复用 → 4 个点、无共享。少了这条，上面的 3 可能是恒真。
    const dup = buildLog();
    addWall(dup, { start: { x: 0, y: 0 }, end: { x: 3600, y: 0 }, thicknessMm: 240 });
    addWall(dup, { start: { x: 3600, y: 0 }, end: { x: 3600, y: 2400 }, thicknessMm: 240 });
    expect(dup.document.byKind('point')).toHaveLength(4);
    expect(sharedPointIds(dup.document)).toEqual([]);
  });

  it('复用的点不进补丁：affected 只有新墙与新点', () => {
    const { log, sharedId, second } = lCorner();
    expect(log.affected).toEqual(new Set([second.id, second.endId]));
    expect(log.affected.has(sharedId)).toBe(false);
    expect(second.startId).toBe(sharedId);
  });

  it('撤销回到单墙，重做不产生新点', () => {
    const { log, sharedId } = lCorner();
    const cornerDoc = log.document.canonical();
    const pointsBefore = log.document.byKind('point').length;
    expect(log.undo()).toBe(true);
    // 撤销回到单墙：共享点没被连带回收，第二面墙自己的新终点回收了
    expect(log.document.byKind('wall')).toHaveLength(1);
    expect(log.document.byKind('point')).toHaveLength(2);
    expect(sharedPointIds(log.document)).toEqual([]);
    expect(log.redo()).toBe(true);
    // 逐字节相同 = 重做没有新建点：新点必带新 id，canonical 就变了
    expect(log.document.canonical()).toBe(cornerDoc);
    expect(log.document.byKind('point')).toHaveLength(pointsBefore);
    expect(sharedPointIds(log.document)).toEqual([sharedId]);
  });

  it('两端复用同一个 pointId = 零长墙，拒在 build', () => {
    const { log, sharedId } = lCorner();
    const before = log.document.canonical();
    expect(() =>
      log.dispatch(
        wallCreate({
          storeyId: storey0(log),
          start: { pointId: sharedId },
          end: { pointId: sharedId },
          thicknessMm: 240,
          heightMm: 3000,
        }),
      ),
    ).toThrow(/零长/);
    expect(log.document.canonical()).toBe(before);
    // lCorner 已经压了三笔（建层 + 两面墙）：抛掉的这笔不能入栈
    expect(log.depth).toBe(3);
  });

  it('复用端点导致墙厚 ≥ 轴长：构造期算不出来，必须拒在 build', () => {
    const { log, sharedId } = lCorner();
    const before = log.document.canonical();
    // (3600,0) → (3600,200) 轴长 200 < 墙厚 240；起点是复用的，构造期无从得知它的坐标
    expect(() =>
      log.dispatch(
        wallCreate({
          storeyId: storey0(log),
          start: { pointId: sharedId },
          end: { x: 3600, y: 200 },
          thicknessMm: 240,
          heightMm: 3000,
        }),
      ),
    ).toThrow(/不小于墙长/);
    expect(log.document.canonical()).toBe(before);
    expect(log.depth).toBe(3);
  });

  it('正对照：两端都是坐标字面量时，构造期就抛，连文档都不需要', () => {
    // 计划 1 的时序承诺：这类非法输入在 wallCreate(...) 这一步就拒，不进入 dispatch
    expect(() =>
      wallCreate({
        storeyId: '不存在的楼层',
        start: { x: 100, y: 100 },
        end: { x: 100.2, y: 100.1 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    ).toThrow(/零长/);
    expect(() =>
      wallCreate({
        storeyId: '不存在的楼层',
        start: { x: 0, y: 0 },
        end: { x: 100, y: 0 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    ).toThrow(/不小于墙长/);
  });
});

describe('wallMoveEndpoint 带走邻墙', () => {
  it('拖拐角：两面墙同步跟随，共享关系不变', () => {
    const { log, sharedId, first, second } = lCorner();
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 1200 }));
    const p = log.document.get(sharedId) as PointEntity;
    expect([p.x, p.y]).toEqual([3600, 1200]);
    expect((log.document.get(first.id) as WallEntity).endId).toBe(sharedId);
    expect((log.document.get(second.id) as WallEntity).startId).toBe(sharedId);
    expect(sharedPointIds(log.document)).toEqual([sharedId]);
  });

  it('affected 仍只有那一个点 —— 记档：Task 9 必须用 dependentsOf 扩脏', () => {
    const { log, sharedId, first } = lCorner();
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 1200 }));
    expect(log.affected).toEqual(new Set([sharedId]));
    // 派生层与索引要重算的却是两墙 + 它们的洞口：这就是反向依赖闭包存在的理由
    expect(new Set(dependentsOf(log.document, sharedId))).toEqual(
      new Set(log.document.byKind('wall').map((w) => w.id)),
    );
  });

  it('邻墙被拖成零长 → 抛，且文档一点没动', () => {
    const { log, first, second } = lCorner();
    const before = log.document.canonical();
    expect(() =>
      log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 2400 })),
    ).toThrow(/移动端点会让墙/);
    expect(() =>
      log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 2400 })),
    ).toThrow(second.id);
    expect(log.document.canonical()).toBe(before);
    // 抛掉的 dispatch 不入栈：depth 还停在 lCorner 的三笔（建层 + 两面墙）
    expect(log.depth).toBe(3);
  });

  it('邻墙被拖成墙厚 ≥ 轴长 → 抛（守卫的是非法轮廓，不只是零长）', () => {
    const { log, first } = lCorner();
    const before = log.document.canonical();
    // 新位置 (3600,2200)：邻墙 B→C 轴长 200 < 墙厚 240
    expect(() =>
      log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 2200 })),
    ).toThrow(/墙厚 240 不小于轴长 200/);
    expect(log.document.canonical()).toBe(before);
  });

  it('把自己这面墙拖成墙厚 ≥ 轴长 → 抛（邻墙循环一轮不进，也要有守卫）', () => {
    const log = buildLog();
    const wall = addWall(log, {
      start: { x: 0, y: 0 },
      end: { x: 3600, y: 0 },
      thicknessMm: 240,
    });
    // 没有任何共享端点：这道守卫盯的是本墙自己，与邻墙循环无关
    expect(sharedPointIds(log.document)).toEqual([]);
    const before = log.document.canonical();
    expect(() =>
      log.dispatch(wallMoveEndpoint({ wallId: wall.id, end: 'end', x: 200, y: 0 })),
    ).toThrow(/墙厚 240 不小于轴长 200/);
    expect(log.document.canonical()).toBe(before);
    // 这里的 2 是 建楼层 + 建墙；抛掉的那次移动端点没有入栈
    expect(log.depth).toBe(2);
    // 正对照：300 ≥ 240 合法。少了它，"改成恒抛"这一变异能蒙过上一条断言。
    log.dispatch(wallMoveEndpoint({ wallId: wall.id, end: 'end', x: 300, y: 0 }));
    expect((log.document.get(wall.endId) as PointEntity).x).toBe(300);
  });

  it('正对照：同一坐标在不共享的文档上合法 —— 证明上面两条红是因为共享，不是坐标本身非法', () => {
    const log = buildLog();
    const first = addWall(log, {
      start: { x: 0, y: 0 },
      end: { x: 3600, y: 0 },
      thicknessMm: 240,
    });
    const neighbour = addWall(log, {
      start: { x: 3600, y: 0 },
      end: { x: 3600, y: 2400 },
      thicknessMm: 240,
    });
    expect(sharedPointIds(log.document)).toEqual([]);
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 2200 }));
    expect((log.document.get(first.endId) as PointEntity).y).toBe(2200);
    // 邻墙纹丝不动：坐标一样但不共享点，于是没有联动。
    // 断言打在 neighbour.startId 这个点上 —— 若实现改成"按坐标吸附"，这里会跟着动，测试就红。
    expect(neighbour.startId).not.toBe(first.endId);
    expect((log.document.get(neighbour.startId) as PointEntity).y).toBe(0);
  });

  it('撤销拖动的拐角：两墙一起回位', () => {
    const { log, sharedId, first } = lCorner();
    const before = log.document.canonical();
    log.dispatch(wallMoveEndpoint({ wallId: first.id, end: 'end', x: 3600, y: 1200 }));
    expect(log.document.canonical()).not.toBe(before);
    expect(log.undo()).toBe(true);
    expect((log.document.get(sharedId) as PointEntity).y).toBe(0);
    expect(log.document.canonical()).toBe(before);
  });
});

describe('wallDelete 与共享端点', () => {
  it('删 L 形的一面墙，共享点必须留下，撤销后重新共享', () => {
    const { log, sharedId, first, second } = lCorner();
    const before = log.document.canonical();
    log.dispatch(wallDelete({ wallId: first.id }));
    expect(log.document.get(sharedId)).toBeDefined();
    expect(log.document.byKind('point')).toHaveLength(2);
    expect(sharedPointIds(log.document)).toEqual([]);
    expect(second.startId).toBe(sharedId);
    log.undo();
    expect(log.document.canonical()).toBe(before);
    expect(sharedPointIds(log.document)).toEqual([sharedId]);
  });
});
