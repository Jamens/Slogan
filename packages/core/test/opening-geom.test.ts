// 洞口沿墙定位、墙身分段与整层派生入口：区间换算是浮点判据、校验只有一份、零长段不产
import { describe, expect, it } from 'vitest';
import {
  Document,
  TransactionLog,
  assertSpansFit,
  deriveJoints,
  deriveStoreyGeometry,
  deriveWallQuads,
  openingSpans,
  piecesFromSpans,
  storeyCreate,
  uuidv7,
  wallAxisById,
  wallCreate,
  type Joint,
  type OpeningEntity,
  type WallEntity,
} from '@dajia/core';

const projectId = uuidv7();

function oneWall(
  start: { x: number; y: number },
  end: { x: number; y: number },
  thicknessMm = 240,
) {
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  const storeyId = log.document.byKind('storey')[0]!.id;
  log.dispatch(wallCreate({ storeyId, start, end, thicknessMm, heightMm: 3000 }));
  return { log, storeyId, wall: log.document.byKind('wall')[0]! };
}

/** 长度字段一律给合法的整数毫米，只让被测的 distance/width 变化。 */
function addOpening(
  log: TransactionLog,
  wall: WallEntity,
  spec: {
    distanceMm: number;
    widthMm: number;
    category?: 'door' | 'window';
    storeyId?: string;
    /** 只给排序用例钉 id 字典序（见那条用例里的说明），其余一律随机。 */
    id?: string;
  },
): OpeningEntity {
  const opening: OpeningEntity = {
    kind: 'opening',
    id: spec.id ?? uuidv7(),
    storeyId: spec.storeyId ?? wall.storeyId,
    hostWallId: wall.id,
    distanceMm: spec.distanceMm,
    widthMm: spec.widthMm,
    heightMm: 1500,
    sillMm: spec.category === 'door' ? 0 : 900,
    category: spec.category ?? 'window',
  };
  log.dispatch({ type: 'opening.create', build: () => ({ upsert: [opening], remove: [] }) });
  return opening;
}

function axisLen(log: TransactionLog, wallId: string): number {
  return wallAxisById(log.document, wallId).lengthMm;
}

describe('洞口区间与墙身分段', () => {
  it('无洞口：一整段 [0, 轴长]', () => {
    const { log, wall } = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    expect(openingSpans(log.document, wall)).toEqual([]);
    expect(piecesFromSpans(wall.id, axisLen(log, wall.id), [])).toEqual([
      { wallId: wall.id, fromMm: 0, toMm: 3600 },
    ]);
  });

  it('一个居中窗：两段，边界精确，Σ段长 + Σ洞口宽 = 轴长', () => {
    const { log, wall } = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    const opening = addOpening(log, wall, { distanceMm: 900, widthMm: 1200 });
    const spans = openingSpans(log.document, wall);
    expect(spans).toEqual([{ openingId: opening.id, fromMm: 900, toMm: 2100 }]);
    const pieces = piecesFromSpans(wall.id, axisLen(log, wall.id), spans);
    expect(pieces).toEqual([
      { wallId: wall.id, fromMm: 0, toMm: 900 },
      { wallId: wall.id, fromMm: 2100, toMm: 3600 },
    ]);
    const pieceSum = pieces.reduce((s, p) => s + (p.toMm - p.fromMm), 0);
    const openingSum = spans.reduce((s, x) => s + (x.toMm - x.fromMm), 0);
    expect(pieceSum + openingSum).toBeCloseTo(3600, 9);
  });

  it('门洞贴墙起点：跳过零长段，只剩尾段', () => {
    const { log, wall } = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    addOpening(log, wall, { distanceMm: 0, widthMm: 900, category: 'door' });
    expect(piecesFromSpans(wall.id, axisLen(log, wall.id), openingSpans(log.document, wall))).toEqual(
      [{ wallId: wall.id, fromMm: 900, toMm: 3600 }],
    );
  });

  it('两洞之间必须留墙垛：贴边抛；留 1mm 恰好三段（正对照）', () => {
    const { log, wall } = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    addOpening(log, wall, { distanceMm: 900, widthMm: 1200 });
    addOpening(log, wall, { distanceMm: 2100, widthMm: 500 });
    expect(() =>
      piecesFromSpans(wall.id, axisLen(log, wall.id), openingSpans(log.document, wall)),
    ).toThrow(/重叠或贴边/);

    const ok = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    addOpening(ok.log, ok.wall, { distanceMm: 900, widthMm: 1200 });
    addOpening(ok.log, ok.wall, { distanceMm: 2101, widthMm: 500 });
    expect(piecesFromSpans(ok.wall.id, 3600, openingSpans(ok.log.document, ok.wall))).toEqual([
      { wallId: ok.wall.id, fromMm: 0, toMm: 900 },
      { wallId: ok.wall.id, fromMm: 2100, toMm: 2101 },
      { wallId: ok.wall.id, fromMm: 2601, toMm: 3600 },
    ]);
  });

  it('超出宿主墙抛；正好收在墙尾合法（正对照）', () => {
    const over = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    addOpening(over.log, over.wall, { distanceMm: 3000, widthMm: 900 });
    expect(() =>
      piecesFromSpans(over.wall.id, 3600, openingSpans(over.log.document, over.wall)),
    ).toThrow(/超出宿主墙/);

    const flush = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    addOpening(flush.log, flush.wall, { distanceMm: 2700, widthMm: 900 });
    expect(piecesFromSpans(flush.wall.id, 3600, openingSpans(flush.log.document, flush.wall))).toEqual(
      [{ wallId: flush.wall.id, fromMm: 0, toMm: 2700 }],
    );
  });

  it('斜墙按浮点轴长判定：1414 宽放行，1415 宽抛', () => {
    const fits = oneWall({ x: 0, y: 0 }, { x: 1000, y: 1000 });
    addOpening(fits.log, fits.wall, { distanceMm: 0, widthMm: 1414 });
    const lengthMm = axisLen(fits.log, fits.wall.id);
    expect(lengthMm).toBeCloseTo(Math.SQRT2 * 1000, 9);
    expect(Number.isInteger(lengthMm)).toBe(false);
    expect(piecesFromSpans(fits.wall.id, lengthMm, openingSpans(fits.log.document, fits.wall))).toHaveLength(
      1,
    );

    const over = oneWall({ x: 0, y: 0 }, { x: 1000, y: 1000 });
    addOpening(over.log, over.wall, { distanceMm: 0, widthMm: 1415 });
    expect(() =>
      piecesFromSpans(over.wall.id, axisLen(over.log, over.wall.id), openingSpans(over.log.document, over.wall)),
    ).toThrow(/超出宿主墙/);
  });

  it('openingSpans 按 fromMm 升序，而非实体创建顺序', () => {
    const { log, wall } = oneWall({ x: 0, y: 0 }, { x: 6000, y: 0 });
    // id 必须钉死：uuidv7 同毫秒内不单调（ids.ts 的 12 位 rand_a 是随机的），
    // 拿"先建的洞 id 更小"当预言就是抛硬币 —— 这条原文照抄时三次连跑红过一次。
    // 前 48 位是毫秒时间戳、决定字典序，给三个固定毫秒值就让 far.id < near.id < tied.id 恒成立。
    const far = addOpening(log, wall, { distanceMm: 4000, widthMm: 600, id: uuidv7(1) });
    const near = addOpening(log, wall, { distanceMm: 500, widthMm: 600, id: uuidv7(2) });
    // 第三个洞与 near 的 fromMm **相同**：没有平距样本，tie-break 那个分支一次都走不到，
    // 把比较号整个反转也不会红（Task 6 评审的 R10 实测 12 条全绿）。本用例只调 openingSpans，
    // 不调 piecesFromSpans，所以两片重叠在这里是合法的夹具材料 —— 排序契约要的就是平距。
    const tied = addOpening(log, wall, { distanceMm: 500, widthMm: 300, id: uuidv7(3) });
    // 先建的洞在远端、id 也排在前：结果顺序同时与建序和 id 升序相反，否则这条排序是空跑
    expect(far.id < near.id).toBe(true);
    expect(openingSpans(log.document, wall).map((s) => s.openingId)).toEqual([
      near.id,
      tied.id,
      far.id,
    ]);
  });

  it('洞口与宿主墙不同层：抛（真源不校验引用，派生层必须查）', () => {
    const { log, wall, storeyId } = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    const alien = uuidv7();
    addOpening(log, wall, { distanceMm: 100, widthMm: 600, storeyId: alien });
    // 消息里点名两个楼层 id 才是有用的预言：`toBeTruthy()` 那种空跑断言（Task 6 评审 F3）
    // 对任何实现变异都恒绿。uuid 只含 hex 与 '-'，直接进正则安全。
    expect(() => openingSpans(log.document, wall)).toThrow(
      new RegExp(`属于楼层 ${alien}，宿主墙 .* 属于楼层 ${storeyId}：两者必须同层`),
    );
  });

  it('assertSpansFit 要求入参升序：乱序直接抛，不静默漏检重叠', () => {
    expect(() =>
      assertSpansFit(uuidv7(), 3600, [
        { openingId: uuidv7(), fromMm: 2000, toMm: 2600 },
        { openingId: uuidv7(), fromMm: 500, toMm: 1100 },
      ]),
    ).toThrow(/升序/);
  });
});

describe('deriveStoreyGeometry', () => {
  it('整层派生：墙、接头、段三类结果都只含本层', () => {
    const { log, storeyId } = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    const w0 = log.document.byKind('wall')[0]!;
    addOpening(log, w0, { distanceMm: 900, widthMm: 1200 });
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    const storey1 = log.document.byKind('storey').find((s) => s.index === 1)!.id;
    log.dispatch(
      wallCreate({
        storeyId: storey1,
        start: { x: 0, y: 0 },
        end: { x: 0, y: 3000 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    );
    const w1 = log.document.byKind('wall').find((w) => w.storeyId === storey1)!;
    const g0 = deriveStoreyGeometry(log.document, storeyId);
    const g1 = deriveStoreyGeometry(log.document, storey1);
    expect(g0.walls.map((q) => q.wallId)).toEqual([w0.id]);
    expect(g0.pieces).toEqual([
      { wallId: w0.id, fromMm: 0, toMm: 900 },
      { wallId: w0.id, fromMm: 2100, toMm: 3600 },
    ]);
    expect(g1.walls.map((q) => q.wallId)).toEqual([w1.id]);
    expect(g1.pieces).toEqual([{ wallId: w1.id, fromMm: 0, toMm: 3000 }]);
    // 两层各 2 个自由端：接头不许串层（两层墙起点同为 (0,0) 也不许合并）
    expect(g0.joints).toHaveLength(2);
    expect(g1.joints).toHaveLength(2);
    expect(g0.joints.every((j) => j.members.every((m) => m.wallId === w0.id))).toBe(true);

    // ---- Task 5 回填 O1：钉住"传进来的接头表真被消费" ----
    // 评审实测：把 outline.ts 的 `joints ?? deriveJoints(doc)` 改成彻底忽略入参，Task 5 的 13 条全绿
    //（那条显式传参的用例两侧同源，对"参数是否被读"这个维度结构性失明）。补在这里而不是新开一条
    // `it` —— Task 6 的 it 数（12）与计数链 181 是计划级契约。
    expect(() => deriveWallQuads(log.document, [])).toThrow(/接头表里找不到墙/);
    // 更强的预言：喂一张改过 trim 的表，角点必须跟着动（用的是这张表，不是重新派生出来的那份）
    const patched: Joint[] = deriveJoints(log.document).map((joint) => ({
      ...joint,
      members: joint.members.map((m) =>
        m.wallId === w0.id
          ? { ...m, trimLeftMm: m.trimLeftMm + 500, trimRightMm: m.trimRightMm + 500 }
          : m,
      ),
    }));
    const moved = deriveWallQuads(log.document, patched).find((q) => q.wallId === w0.id)!;
    // w0 是 (0,0)→(3600,0) 厚 240 的自由端墙：+500 内退发生在 start 端的 +normal 侧 ⇒ (500, 120)
    expect(moved.corners[0]).toEqual({ x: 500, y: 120 });
    expect(moved.corners[1]).toEqual({ x: 3100, y: 120 });
  });

  it('楼层不存在抛；空楼层给三个空集合而不是抛', () => {
    const { log } = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    expect(() => deriveStoreyGeometry(log.document, uuidv7())).toThrow(/楼层 不存在/);
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    const empty = log.document.byKind('storey').find((s) => s.index === 1)!.id;
    expect(deriveStoreyGeometry(log.document, empty)).toEqual({
      storeyId: empty,
      walls: [],
      joints: [],
      pieces: [],
    });
  });

  it('跨楼层共享端点：命令层造不出来，手工构造时抛，不静默按本层派生', () => {
    const { log, storeyId } = oneWall({ x: 0, y: 0 }, { x: 3600, y: 0 });
    const w0 = log.document.byKind('wall')[0]!;
    log.dispatch(storeyCreate({ projectId, index: 1, elevationMm: 3000, heightMm: 3000 }));
    const storey1 = log.document.byKind('storey').find((s) => s.index === 1)!.id;
    log.dispatch(
      wallCreate({
        storeyId: storey1,
        start: { x: 0, y: 0 },
        end: { x: 0, y: 3000 },
        thicknessMm: 240,
        heightMm: 3000,
      }),
    );
    const w1 = log.document.byKind('wall').find((w) => w.storeyId === storey1)!;
    // 伪造一面"属于楼层 1、起点却是楼层 0 的点"的墙：resolvePointRef 挡住了命令，
    // 但 Document 不校验引用完整性，派生层必须自己发现。
    const fake: WallEntity = { ...w1, id: uuidv7(), startId: w0.startId };
    // fake 是 w1 的**替身**，不是第三面墙：两者只换起点、endId 仍是同一个点，于是它们的
    // end 端从同一点朝同一方向离开 ⇒ joint.ts 的 assertNoSameRay 先抛「同向重叠」，
    // 根本走不到本层的跨层守卫（简报原文在这里留两个写入者，红在别的病上）。
    const entities = new Map(log.document.entities);
    entities.delete(w1.id);
    entities.set(fake.id, fake);
    const bad = Document.replaceEntities(log.document, entities);
    // 消息点名"被派生的那一层"才算预言（Task 6 评审 F3：原来的 `expect(storeyId).toBeTruthy()`
    // 是恒真的空跑，唯一作用是喂 noUnusedLocals）。同一个病态共享点让**两层都**少一个接头，
    // 于是两层各抛一次、消息里的楼层号跟着变 —— 这两条一起钉住守卫打的是被派生的那一层。
    expect(() => deriveStoreyGeometry(bad, storey1)).toThrow(
      new RegExp(`端点接头不在本层（楼层 ${storey1}）`),
    );
    expect(() => deriveStoreyGeometry(bad, storeyId)).toThrow(
      new RegExp(`端点接头不在本层（楼层 ${storeyId}）`),
    );
  });
});
