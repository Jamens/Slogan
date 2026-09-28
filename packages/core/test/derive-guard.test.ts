// 派生复核（`assertDerivesAfterApply`）：改得出"画不出来的几何"的那一发，命令层就抛，
// 且不留痕迹。计划 3 Task 7 的 A1。
//
// joint.test.ts 里那四条守卫用例（同向重叠 / 翻面 / 直通异厚 / star）从 Task 7 起改成
// **手工造文档**（`handBuild`），因为命令层已经不让它们走到派生层了。这个文件钉的是正面：
// 正常建房子的路走不到那四种文档，而坏数据仍然删得掉。
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  applyPatch,
  deriveStoreyGeometry,
  storeyCreate,
  uuidv7,
  wallCreate,
  wallDelete,
  wallMoveEndpoint,
  wallSetMaterial,
  wallSetThickness,
  type Entity,
  type EntityId,
  type PointRef,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();

/** 一层楼、空文档。每个用例自己往上盖墙，互不干扰。 */
function newLog(): TransactionLog {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  return log;
}

function storeyOf(log: TransactionLog, index = 0): EntityId {
  const storey = log.document.byKind('storey').find((s) => s.index === index);
  if (!storey) throw new Error(`没有序号为 ${index} 的楼层`);
  return storey.id;
}

/**
 * 走命令层盖一面墙，返回新墙。
 * 取返回值而不是 `byKind('wall')[n]`：uuidv7 同毫秒内不保证单调，byKind 按 id 升序，
 * **创建顺序在实体数组里根本没有位置可言** —— 下标选墙迟早漂。
 */
function addWall(
  log: TransactionLog,
  start: PointRef,
  end: PointRef,
  thicknessMm = 240,
): WallEntity {
  log.dispatch(
    wallCreate({ storeyId: storeyOf(log), start, end, thicknessMm, heightMm: 3000 }),
  );
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new Error('dispatch 之后没找到新墙');
}

/**
 * 手工贴墙与点（绕开命令层）：坐标相同的两端复用同一枚点 id，与命令层的共享端点语义一致。
 * Task 7 之后"合法命令造得出画不出的文档"这条路被复核堵死，要造坏文档只剩这一条路。
 */
function handEntities(storeyId: EntityId, specs: Array<[number, number, number, number]>) {
  const entities: Entity[] = [];
  const pointIds = new Map<string, EntityId>();
  const pointOf = (x: number, y: number): EntityId => {
    const key = `${x},${y}`;
    const hit = pointIds.get(key);
    if (hit) return hit;
    const id = uuidv7();
    pointIds.set(key, id);
    entities.push({ kind: 'point', id, storeyId, x, y });
    return id;
  };
  for (const [x0, y0, x1, y1] of specs) {
    entities.push({
      kind: 'wall',
      id: uuidv7(),
      storeyId,
      startId: pointOf(x0, y0),
      endId: pointOf(x1, y1),
      thicknessMm: 240,
      heightMm: 3000,
      elevationOffsetMm: 0,
      loadBearing: true,
      material: 'brick',
    });
  }
  return entities;
}

/** 把现有实体原样保留，再贴进 extras。 */
function withExtras(doc: Document, extras: readonly Entity[]): Document {
  const merged = new Map<EntityId, Entity>();
  for (const entity of doc.byKind('point')) merged.set(entity.id, entity);
  for (const entity of doc.byKind('wall')) merged.set(entity.id, entity);
  for (const entity of doc.byKind('storey')) merged.set(entity.id, entity);
  for (const entity of extras) merged.set(entity.id, entity);
  return Document.replaceEntities(doc, merged);
}

/** 三面墙、三个方向过 (5000, 5000)：S1 画不出来的那一颗。坐标离命令建的那面墙远远的。 */
const STAR_SPECS: Array<[number, number, number, number]> = [
  [5000, 5000, 6000, 5000],
  [5000, 5000, 5000, 6000],
  [5000, 5000, 5900, 6000],
];

describe('wallCreate 的派生复核', () => {
  it('三面墙过同一点、三个方向 → 命令层就抛 /star/，文档与撤销栈都不动', () => {
    const log = newLog();
    const hub = addWall(log, { x: 0, y: 0 }, { x: 1000, y: 0 }).endId;
    addWall(log, { pointId: hub }, { x: 1000, y: 900 });
    const before = log.document.canonical();
    const depth = log.depth;
    // 第三臂走斜方向 → 三条方向线过同一点 = star。加复核之前这一发**建得出来**，
    // 建完之后整层再也派生不了（屏幕侧就是重绘时抛 RangeError）。
    expect(() => addWall(log, { pointId: hub }, { x: 2000, y: 900 })).toThrow(/star/);
    expect(log.document.canonical()).toBe(before);
    expect(log.depth).toBe(depth);
  });

  it('同一点同向两笔 → 抛 /同向重叠/（重叠墙带进不了真源）', () => {
    const log = newLog();
    const spine = addWall(log, { x: 1000, y: 0 }, { x: 2000, y: 0 });
    expect(() => addWall(log, { pointId: spine.startId }, { x: 3000, y: 0 })).toThrow(
      /同向重叠/,
    );
    expect(log.document.byKind('wall')).toHaveLength(1);
  });

  it('合法的两臂直角照常建得出来；复核只读草稿，不动原档', () => {
    const log = newLog();
    const hub = addWall(log, { x: 0, y: 0 }, { x: 1000, y: 0 }).endId;
    const before = log.document.canonical();
    const cmd = wallCreate({
      storeyId: storeyOf(log),
      start: { pointId: hub },
      end: { x: 1000, y: 900 },
      thicknessMm: 240,
      heightMm: 3000,
    });
    const patch = cmd.build(log.document);
    // 复核是把补丁贴到草稿上再派生一遍，原文档一个字节都不动（applyPatch 本就不可变）
    expect(log.document.canonical()).toBe(before);
    // 起点复用 hub：复核看的就是"共享端点"这一语义，不是新建了一枚同坐标的点
    const wall = patch.upsert.find((e) => e.kind === 'wall');
    expect(wall?.kind === 'wall' && wall.startId === hub).toBe(true);
    expect(() => log.dispatch(cmd)).not.toThrow();
    expect(() => deriveStoreyGeometry(log.document, storeyOf(log))).not.toThrow();
  });

  it('复核吃的是**整份文档**：别层藏一颗星，本层也写不进墙', () => {
    const log = newLog();
    const storeyOne = storeyOf(log);
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    const storeyTwo = storeyOf(log, 1);
    const doc = withExtras(log.document, handEntities(storeyTwo, STAR_SPECS));
    // deriveJoints 是全局的（斜切量是全局性质），所以二层的坏文档会让一层的每发墙命令
    // 都替它抛错。这条行为要留档：计划 4 的读盘若读到坏层，本层是**冻结写入**的。
    expect(() =>
      wallCreate({
        storeyId: storeyOne,
        start: { x: 5000, y: 5000 },
        end: { x: 6000, y: 5000 },
        thicknessMm: 240,
        heightMm: 3000,
      }).build(doc),
    ).toThrow(/star/);
  });
});

describe('wallMoveEndpoint 的派生复核', () => {
  /** 一条直梁 + 一枚竖臂组成的合法 T 接：返回直通里"端点是 hub"的那面墙与 hub。 */
  function tee(): { log: TransactionLog; spine: WallEntity; hub: EntityId } {
    const log = newLog();
    const through = addWall(log, { x: 0, y: 0 }, { x: 1000, y: 0 });
    const hub = through.endId;
    addWall(log, { pointId: hub }, { x: 2000, y: 0 });
    addWall(log, { pointId: hub }, { x: 1000, y: 900 });
    // spine = 以 hub 为 end 的那面（拖它的 end 才是在搬 hub 本身）
    const spine = log.document.byKind('wall').find((w) => w.endId === hub)!;
    return { log, spine, hub };
  }

  it('把 T 接的公共点拖离直通线 → 三个方向过同一点，抛 /star/，文档不动', () => {
    const { log, spine } = tee();
    const storeyId = storeyOf(log);
    expect(() => deriveStoreyGeometry(log.document, storeyId)).not.toThrow();
    const before = log.document.canonical();
    const depth = log.depth;
    // hub 是三端共用的那枚点：拖 spine 的 end 就是把 hub 搬走，三臂方向同时变。
    // 命令层的轴长、零长、邻墙守卫一条都不会叫（三条边都还很长），
    // 接头分类只有派生层会算 —— 这正是 T5/T6 记的"legalDrop 只跑 build"的差额。
    expect(() =>
      wallMoveEndpoint({ wallId: spine.id, end: 'end', x: 1000, y: 300 }).build(log.document),
    ).toThrow(/star/);
    expect(log.document.canonical()).toBe(before);
    expect(log.depth).toBe(depth);
  });

  it('沿直通线拖同一个点 → 仍是 T 接，合法：红的是这一发的几何，不是"拖共点一律抛"', () => {
    const { log, spine, hub } = tee();
    log.dispatch(wallMoveEndpoint({ wallId: spine.id, end: 'end', x: 1200, y: 0 }));
    // 三端仍共 hub：拖点不拆连接，也不另造一枚同坐标的新点
    expect(
      log.document.byKind('wall').filter((w) => w.startId === hub || w.endId === hub),
    ).toHaveLength(3);
    expect(() => deriveStoreyGeometry(log.document, storeyOf(log))).not.toThrow();
  });
});

describe('wallSetThickness 的派生复核', () => {
  it('5° 斜角的两面墙：厚 120 合法，加厚到 240 会翻面 → 抛 /翻面/', () => {
    const log = newLog();
    const storeyId = storeyOf(log);
    const horizontal = addWall(log, { x: -2000, y: 0 }, { x: 0, y: 0 }, 120);
    const angled = addWall(log, { pointId: horizontal.endId }, { x: -2000, y: 175 }, 120);
    expect(() => deriveStoreyGeometry(log.document, storeyId)).not.toThrow();
    expect(() =>
      wallSetThickness({ wallId: angled.id, thicknessMm: 240 }).build(log.document),
    ).toThrow(/翻面/);
    // 加厚到 121 仍然合法：证明红的是这一发的几何，不是"这条命令一律抛"
    expect(() =>
      wallSetThickness({ wallId: angled.id, thicknessMm: 121 }).build(log.document),
    ).not.toThrow();
  });
});

describe('复核只挂在改几何的三条命令上', () => {
  /** 一份带星的文档：一面命令建的合法墙 + 三条手工星臂（三端共点、三个方向线）。 */
  function starDoc(): { doc: Document; storeyId: EntityId; legal: WallEntity; arms: EntityId[] } {
    const log = newLog();
    const storeyId = storeyOf(log);
    const legal = addWall(log, { x: 0, y: 0 }, { x: 1000, y: 0 });
    const doc = withExtras(log.document, handEntities(storeyId, STAR_SPECS));
    const arms = doc
      .byKind('wall')
      .filter((w) => w.id !== legal.id)
      .map((w) => w.id);
    return { doc, storeyId, legal, arms };
  }

  it('坏数据必须还能删：逐面删掉星臂之后，这一层重新派生得动', () => {
    const { doc, storeyId, arms } = starDoc();
    expect(() => deriveStoreyGeometry(doc, storeyId)).toThrow(/star/);
    expect(arms).toHaveLength(3);
    let cursor = doc;
    // 第一发的 build 打在**仍然带星**的文档上，后两发打在删了一半的坏文档上：
    // 删除路径不跑复核，否则守卫挡住删除等于把这份文档锁死，用户只能重开。
    for (const wallId of arms) {
      cursor = applyPatch(cursor, wallDelete({ wallId }).build(cursor)).doc;
    }
    expect(() => deriveStoreyGeometry(cursor, storeyId)).not.toThrow();
    expect(cursor.byKind('wall')).toHaveLength(1);
  });

  it('材料不进派生：同一份坏文档，wallSetMaterial 照常通过', () => {
    const { doc, storeyId, legal } = starDoc();
    expect(() => deriveStoreyGeometry(doc, storeyId)).toThrow(/star/);
    expect(() =>
      wallSetMaterial({ wallId: legal.id, material: 'concrete' }).build(doc),
    ).not.toThrow();
  });
});
