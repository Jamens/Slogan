import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  Document,
  TransactionLog,
  columnCreate,
  openingCreate,
  openingDelete,
  requirePoint,
  slabCreate,
  storeyCreate,
  uuidv7,
  vec,
  wallCreate,
  wallDelete,
  type PointRef,
  type WallEntity,
} from '@dajia/core';
import {
  EMPTY_SELECTION,
  EMPTY_SNAP_FIELD,
  MIN_PICK_EDGE_PX,
  MIN_WALL_LENGTH_MM,
  NEW_WALL_THICKNESS_MM,
  buildDrawList,
  demoHouse,
  draftAtPress,
  draftCommand,
  draftRefs,
  dropTargetOf,
  fitStorey,
  lastCreatedWall,
  legalWallCreate,
  mmToPx,
  moveDraft,
  moveTargetOf,
  newWallDefaults,
  pickAt,
  pickPxOf,
  planDelete,
  pointRefOf,
  pruneSelection,
  snapFieldOf,
  viewportOf,
  wallProbe,
  type DraftWall,
  type MoveTarget,
  type Px,
  type SnapField,
  type Viewport,
} from '@dajia/scene-2d';

const house = demoHouse();
const view = fitStorey(house.doc, house.lowerStoreyId, 1200, 900, 60);
const field = snapFieldOf(house.doc, house.lowerStoreyId);
const ops = buildDrawList(house.doc, house.lowerStoreyId, view, EMPTY_SELECTION);
const lowerWalls = house.doc.byKind('wall').filter((w) => w.storeyId === house.lowerStoreyId);
const upperWalls = house.doc.byKind('wall').filter((w) => w.storeyId === house.upperStoreyId);

/** 整数毫米生成器：真源只收这个形状，属性不许拿浮点当输入。 */
const mmInt = fc.integer({ min: -20000, max: 20000 });

/**
 * 合成用例专用视口：0.1px/mm ⇒ `MIN_PICK_EDGE_PX`(64px) = 640mm、`SNAP_TOL_PX`(8px) = 80mm，
 * 且 10mm 恰好是一像素 ⇒ `moveTargetOf` 在整数毫米上是不动点，红的时候不必先排除舍入。
 * 样例房那一份 `fitStorey` 是 0.125px/mm（1px = 8mm），算落点要处理的边角太多。
 */
const sv = viewportOf(1000, 800, { pxPerMm: 0.1, center: vec(2000, 1000) });

/** 独立的一层（可选层高），删除与新建的判据都在它上面跑，免得样例房的接头掺进来。 */
function synthStorey(heightMm = 3000): { log: TransactionLog; storeyId: string } {
  const projectId = uuidv7();
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm }));
  let storeyId = '';
  for (const id of log.affected) {
    if (log.document.get(id)?.kind === 'storey') storeyId = id;
  }
  if (storeyId === '') throw new TypeError('affected 里没有新建的楼层');
  return { log, storeyId };
}

/** 建一面墙并把实体取回来（**不许** `byKind('wall').at(-1)`：uuidv7 同毫秒不单调）。 */
function wallAt(log: TransactionLog, storeyId: string, start: PointRef, end: PointRef): WallEntity {
  log.dispatch(wallCreate({ storeyId, start, end, thicknessMm: 240, heightMm: 3000 }));
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new TypeError('affected 里没有新建的墙');
}

/** 建一樘洞口并取回 id。 */
function openingAt(log: TransactionLog, hostWallId: string, distanceMm: number): string {
  log.dispatch(openingCreate({ hostWallId, distanceMm, widthMm: 1000, heightMm: 2100, category: 'door' }));
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'opening') return id;
  }
  throw new TypeError('affected 里没有新建的洞口');
}

/** 本层唯一那面墙。 */
function onlyWall(log: TransactionLog): WallEntity {
  const walls = log.document.byKind('wall');
  if (walls.length !== 1) throw new TypeError('合成现场应当恰好只有一面墙');
  return walls[0]!;
}

/**
 * 从上一次派发的 `affected` 里挑出该 kind 的那枚 id。柱与板在屏幕上点不到（`pickAt` 只认墙与洞口），
 * 所以 ③④ 两支的夹具只能这样手工构造 —— 这道助手就是"合成夹具"这四个字的具体形状。
 */
function kindId(log: TransactionLog, kind: 'column' | 'slab'): string {
  const id = [...log.affected].find((a) => log.document.get(a)?.kind === kind);
  if (id === undefined) throw new TypeError(`affected 里没有那枚 ${kind}`);
  return id;
}

/** 光标就停在这对整数毫米的像素上：草稿拿到的像素与毫米因此逐字自洽。 */
const pxOf = (mm: MoveTarget, v: Viewport): Px => mmToPx(v, vec(mm.x, mm.y));

/** `editing.ts` 里那道私有的 `intPx`：探针发出去的 DIP 是取整后的像素，比对界也要用同一份取整。 */
const intPxOf = (p: Px): Px => ({ x: Math.round(p.x), y: Math.round(p.y) });

/** 同 `insideCanvas`（私有），边距 2px 抄同一份：这里判的是"探针给的靶子发不发得出 DIP"。 */
const insidePx = (v: Viewport, p: Px): boolean =>
  p.x >= 2 && p.y >= 2 && p.x < v.widthPx - 2 && p.y < v.heightPx - 2;

/**
 * 一条**一面墙**的合成现场。所有移动 / 合法性用例都吃它，所以三个数字在整份文件里只解释一次：
 * 墙 (0,0)→(4000,0)、视口 0.1px/mm、容差 8px = 80mm。
 */
function oneWall(): { log: TransactionLog; storeyId: string; wall: WallEntity; field: SnapField } {
  const { log, storeyId } = synthStorey();
  const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
  return { log, storeyId, wall, field: snapFieldOf(log.document, storeyId) };
}

/** 按下的起点：压在 (0,0) 那枚既有端点上，`legal` 还没算过（false）。 */
function pressAtOrigin(fd: SnapField, storeyId: string): DraftWall {
  const start = draftAtPress(sv, pxOf({ x: 0, y: 0 }, sv), fd);
  return {
    storeyId,
    start,
    cursorPx: start.px,
    end: dropTargetOf(sv, start.px, null, fd),
    legal: false,
  };
}

/** 从当前草稿把光标拖到**这对毫米**对应的像素上：走的就是屏幕那条通路（不手搓 DropTarget）。 */
function dragToEnd(draft: DraftWall, end: MoveTarget, doc: Document, fd: SnapField, v: Viewport): DraftWall {
  return moveDraft(doc, draft, v, pxOf(end, v), fd);
}

describe('新墙默认值', () => {
  it('墙高读真源的层高，不是抄常量：3600 的层拿 3600', () => {
    const { log, storeyId } = synthStorey(3600);
    expect(newWallDefaults(log.document, storeyId)).toEqual({
      thicknessMm: NEW_WALL_THICKNESS_MM,
      heightMm: 3600,
    });
    // 对照：样例房两层都是 3000。少这一句，上面那发可以被"恒返回 3600"的写法混过去
    expect(newWallDefaults(house.doc, house.lowerStoreyId).heightMm).toBe(3000);
  });

  it('楼层不存在 ⇒ 抛，不兜成默认值', () => {
    expect(() => newWallDefaults(house.doc, 'no-such-storey')).toThrow(/不存在|楼层/);
  });
});

describe('按下与移动', () => {
  it('起点压在既有端点上：吸到端点档，pointId 与 mm 逐字取自真源', () => {
    const wall = lowerWalls[0]!;
    const point = requirePoint(house.doc, wall.startId, '起点');
    const pressPx = pxOf({ x: point.x, y: point.y }, view);
    const start = draftAtPress(view, pressPx, field);
    expect(start.snap?.kind).toBe('endpoint');
    expect(start.snap?.pointId).toBe(wall.startId);
    expect(start.mm).toEqual({ x: point.x, y: point.y });
    // `px` 存的是**按下那一发**的像素（起点标记画在哪儿读它），不是吸附点的像素
    expect(start.px).toEqual(pressPx);
  });

  it('按下处的像素与吸附点的像素是两个值：标记画在按下处，落点吸到点上', () => {
    const { storeyId, wall, field: fd } = oneWall();
    const pressPx = pxOf({ x: -50, y: -50 }, sv); // 离原点那枚端点 7.07px（容差 8px 之内），且在两条轴的延长线外
    const start = draftAtPress(sv, pressPx, fd);
    expect(start.snap?.pointId).toBe(wall.startId); // 素材自证：这一发确实吸上了那枚点
    expect(start.mm).toEqual({ x: 0, y: 0 });
    // 但 `px` 记下的是手指按下的地方。存成吸附点的像素，屏幕上就是"标记自己跳过去了"，
    // 而这一条在真源里查不出来 —— 只有这两个值不相等的那一发能分辨。
    expect(start.px).toEqual(pressPx);
    expect(start.px).not.toEqual(mmToPx(sv, vec(start.mm.x, start.mm.y)));
    expect(storeyId).not.toBe(''); // 素材自证：合成现场立起来了
  });

  it('起点在空白处按下：什么都不吸，也不吃角度档（锚点恒 null）', () => {
    const { log, storeyId, field: fd } = oneWall();
    // (4200, 60)：在墙的延长线方向上 —— 垂足越界（t > 4000）、最近的端点也在 100px 外，
    // 所以靶子档一枚都不命中；它离水平轴只有 0.82°，**带上锚点**就会被正交档钉平。
    const raw: MoveTarget = { x: 4200, y: 60 };
    const start = draftAtPress(sv, pxOf(raw, sv), fd);
    expect(start.snap).toBeNull();
    expect(start.mm).toEqual(moveTargetOf(sv, pxOf(raw, sv)));
    // 素材自证：同一发带上锚点就吸得上 ⇒ "按下不吸"确实是锚点造成的，不是坐标碰巧没人要
    const withAnchor = dropTargetOf(sv, pxOf(raw, sv), { x: 0, y: 0 }, EMPTY_SNAP_FIELD);
    expect(withAnchor.snap?.kind).toBe('ortho');
    expect(withAnchor.mm).toEqual({ x: 4200, y: 0 });
    expect(storeyId).not.toBe(''); // 素材自证：合成现场确实立起来了（楼层 + 一面墙）
    expect(log.depth).toBe(2);
  });

  it('拖到水平方向：终点吸成逐字整数、临时线仍画到裸光标、原草稿不动', () => {
    const { log, storeyId, field: fd } = oneWall();
    const base = pressAtOrigin(fd, storeyId);
    // 往 **-x** 拖（穿过锚点那枚端点的反向延长线）：Task 7 把派生复核挂上 `wallCreate.build`
    // 之后，从原点沿 +x 画会与素材那面 (0,0)→(4000,0) **同向重叠** ⇒ 同一发有了两个拒绝理由，
    // `legal` 就不再只由正交档说话。反向延长线只在锚点处接出一个两臂贯通点，合法。
    const cursor = pxOf({ x: -2000, y: 60 }, sv); // 离轴 1.72°，在 ANGLE_TOL_DEG(=3) 之内
    const moved = moveDraft(log.document, base, sv, cursor, fd);
    expect(moved.end.snap?.kind).toBe('ortho');
    expect(moved.end.mm).toEqual({ x: -2000, y: 0 }); // 正交档保坐标 ⇒ 逐字整数
    expect(moved.cursorPx).toEqual(cursor); // S4 第三条：预览线画到**裸光标**，不是吸附点
    expect(moved.legal).toBe(true);
    // 不可变：原草稿一格都没动（renderer 比引用决定要不要重绘，改原地等于让 React 看不见这一发）
    expect(base.cursorPx).not.toEqual(cursor);
    expect(base.legal).toBe(false);
  });

  it('光标压在起点上：终点排掉起点坐标、零长墙判不合法', () => {
    const { log, storeyId, field: fd } = oneWall();
    const base = pressAtOrigin(fd, storeyId);
    expect(base.start.snap?.pointId).not.toBeNull(); // 素材自证：起点确实吸上了那枚端点
    const moved = moveDraft(log.document, base, sv, base.start.px, fd);
    // 不排起点会吸回自己（端点档 + 该点处的垂足档），于是"一松手什么也没发生"
    expect(moved.end.snap).toBeNull();
    expect(moved.end.mm).toEqual(base.start.mm);
    expect(moved.legal).toBe(false);
    expect(draftCommand(moved, newWallDefaults(log.document, storeyId))).toBeNull();
  });

  it('draftRefs：起点复用 {pointId}、终点新建 {x,y}，真源里接头真接上了', () => {
    const { log, storeyId, field: fd } = oneWall();
    const base = pressAtOrigin(fd, storeyId);
    const moved = dragToEnd(base, { x: 0, y: 2500 }, log.document, fd, sv);
    expect(moved.legal).toBe(true);
    const refs = draftRefs(moved);
    expect(refs.start).toEqual({ pointId: base.start.snap?.pointId });
    expect(refs.end).not.toHaveProperty('pointId');
    const command = draftCommand(moved, newWallDefaults(log.document, storeyId));
    expect(command?.type).toBe('wall.create');
    if (command === null) throw new TypeError('legal 为真却拿不到命令');
    const before = log.document.byKind('point').length;
    log.dispatch(command);
    const created = lastCreatedWall(log.document, log.affected, storeyId);
    if (created === null) throw new TypeError('affected 里没有那面墙');
    // 接头成立 = 起点那一端**就是**既有那枚点；终点是新建的，所以点数恰好 +1（不是 +2）
    expect(created.startId).toBe(base.start.snap?.pointId);
    expect(created.endId).not.toBe(created.startId);
    expect(log.document.byKind('point').length).toBe(before + 1);
    expect(requirePoint(log.document, created.startId, '共享起点')).toEqual(
      expect.objectContaining({ x: 0, y: 0 }),
    );
    // 复用的判据只有一处：`pointRefOf` 看到 snap.pointId 非 null。换一种写法（自己摸 snap 拼 ref）
    // 就会在这里给出 {x,y} ⇒ +2 枚点，上面那句先红。
    expect(pointRefOf(moved.start.mm, moved.start.snap)).toEqual(refs.start);
  });
});

describe('合法性预言与真命令', () => {
  it('试跑不动真源：墙数、撤销栈深度、affected 三票全部原样', () => {
    const { log, storeyId, field: fd } = oneWall();
    const moved = dragToEnd(pressAtOrigin(fd, storeyId), { x: 0, y: 1200 }, log.document, fd, sv);
    const walls = log.document.byKind('wall').length;
    const affectedBefore = [...log.affected].sort();
    expect(legalWallCreate(log.document, moved)).toBe(true);
    expect(legalWallCreate(log.document, moved)).toBe(true); // 问两次同值（探针的可复现性靠这句）
    expect(log.document.byKind('wall').length).toBe(walls);
    expect(log.depth).toBe(2);
    // 少了这一条，"预览时每问一次就污染一次 affected"会让 `lastCreatedWall` 拿到试跑那一份
    expect([...log.affected].sort()).toEqual(affectedBefore);
  });

  it('三种拒绝各一色：零长、墙厚不小于墙长、跨层复用点', () => {
    const { log, storeyId, field: fd } = oneWall();
    const base = pressAtOrigin(fd, storeyId);
    const defaults = newWallDefaults(log.document, storeyId);
    // ① 零长：终点落回起点
    expect(moveDraft(log.document, base, sv, base.start.px, fd).legal).toBe(false);
    // ② 墙厚不小于墙长：240 厚的墙拖 200mm。方向取 **+y**（与素材那面 (0,0)→(4000,0) 垂直）：
    // Task 7 把派生复核挂上 `wallCreate.build` 之后，沿 +x 拖会先撞上「同向重叠」，
    // 那一发就同时有两个拒绝理由，②不再"各一色"。垂直方向只有墙厚这一条会说话。
    expect(dragToEnd(base, { x: 0, y: 200 }, log.document, fd, sv).legal).toBe(false);
    // 素材自证：同一方向多拖一点就合法（否则"恒 false"的写法也过这一发）
    expect(dragToEnd(base, { x: 0, y: 400 }, log.document, fd, sv).legal).toBe(true);
    // ③ 跨层复用点：把二层那枚起点当一层的起点，`resolvePointRef` 抛。
    // 终点保持"合法那一发"，所以这一发红只可能是起点造成的 —— 反过来（只换终点）证不到起点。
    const legalSoFar = dragToEnd(base, { x: 0, y: 1500 }, log.document, fd, sv);
    expect(legalSoFar.legal).toBe(true);
    const upper = upperWalls[0]!;
    const crossLayer: DraftWall = {
      ...legalSoFar,
      start: {
        mm: { x: 0, y: 0 },
        px: legalSoFar.start.px,
        snap: { kind: 'endpoint', pointId: upper.startId, mm: { x: 0, y: 0 }, distPx: 0 },
      },
    };
    expect(legalWallCreate(log.document, crossLayer)).toBe(false);
    // 素材自证：同一份草稿换回本层那枚点就合法 —— 上一发红在跨层，不是红在 `upper.startId` 写错了
    const sameLayer: DraftWall = {
      ...crossLayer,
      start: { mm: { x: 0, y: 0 }, px: legalSoFar.start.px, snap: base.start.snap },
    };
    expect(legalWallCreate(log.document, sameLayer)).toBe(true);
    expect(defaults.heightMm).toBe(3000);
  });

  it('draftCommand 只认 legal 一色：false 给 null，true 给可派发的命令', () => {
    const { log, storeyId, field: fd } = oneWall();
    const base = pressAtOrigin(fd, storeyId);
    const defaults = newWallDefaults(log.document, storeyId);
    expect(draftCommand(base, defaults)).toBeNull(); // 手工摆的草稿 legal 恒 false
    const ok = dragToEnd(base, { x: 0, y: -1500 }, log.document, fd, sv);
    expect(ok.legal).toBe(true);
    expect(draftCommand(ok, defaults)?.type).toBe('wall.create');
    // 对照：同一发把 legal 抹成 false，命令就发不出去（判据只有这一色，没有第二条路）
    expect(draftCommand({ ...ok, legal: false }, defaults)).toBeNull();
  });
});

describe('删除计划', () => {
  it('选一面墙：一条 wall.delete，candidateIds 记着它', () => {
    const { log, storeyId } = oneWall();
    const wall = onlyWall(log);
    const plan = planDelete(log.document, storeyId, 'select', [wall.id]);
    expect(plan.outcome).toBe('ok');
    expect(plan.commandTypes).toEqual(['wall.delete']);
    expect(plan.candidateIds).toEqual([wall.id]);
    expect(plan.unsupported).toEqual([]);
    // 命令真的删得掉（预言与真源的对照；`build` 的 remove 里带这面墙）
    expect(plan.commands[0]?.build(log.document).remove).toContain(wall.id);
  });

  it('墙与它的洞口一起选中：只发一条 wall.delete，不复述级联', () => {
    const { log, storeyId } = oneWall();
    const wall = onlyWall(log);
    const openingId = openingAt(log, wall.id, 1000);
    const plan = planDelete(log.document, storeyId, 'select', [wall.id, openingId]);
    // 第二条 `opening.delete` 不该出现：`wallDelete` 的级联已经收了它（复述必漂）
    expect(plan.outcome).toBe('ok');
    expect(plan.commandTypes).toEqual(['wall.delete']);
    expect(plan.candidateIds).toEqual([wall.id]);
    expect(plan.unsupported).toEqual([]);
    // 照计划真跑：墙与洞口一起消失
    const once = new TransactionLog(log.document);
    for (const command of plan.commands) once.dispatch(command);
    expect(once.document.get(wall.id)).toBeUndefined();
    expect(once.document.get(openingId)).toBeUndefined();
    // 反过来（给宿主墙同批删除的洞口也发一条）会炸在半路：墙先删掉 ⇒ 洞口已不存在 ⇒ requireOpening 抛。
    // 这一发是 `dispatchBatch` 的"半途留半套状态"的凭据，不是想象。
    const twice = new TransactionLog(log.document);
    twice.dispatch(wallDelete({ wallId: wall.id }));
    expect(twice.document.get(openingId)).toBeUndefined();
    expect(() => twice.dispatch(openingDelete({ openingId }))).toThrow();
  });

  it('独立洞口 + 另一面墙：两条命令，洞口在前、墙在后', () => {
    const { log, storeyId } = synthStorey();
    const a = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const b = wallAt(log, storeyId, { x: 0, y: 2000 }, { x: 4000, y: 2000 });
    const openingId = openingAt(log, a.id, 1200);
    const plan = planDelete(log.document, storeyId, 'select', [b.id, openingId]);
    expect(plan.outcome).toBe('ok');
    // 顺序不是随手排的：栈顶留 `wall.delete`，一次 Ctrl+Z 还原"墙 + 它级联掉的洞口"
    expect(plan.commandTypes).toEqual(['opening.delete', 'wall.delete']);
    expect(plan.candidateIds).toEqual([openingId, b.id]);
    for (const command of plan.commands) log.dispatch(command);
    expect(log.document.get(openingId)).toBeUndefined();
    expect(log.document.get(b.id)).toBeUndefined();
    expect(log.document.get(a.id)?.kind).toBe('wall'); // 宿主墙没被选中，它和它的洞口都该还在
    expect(log.document.byKind('opening').length).toBe(0);
  });

  it('三种沉默三种颜色：拉墙模式 / 只剩裸点 / 空集', () => {
    const { log, storeyId } = oneWall();
    const wall = onlyWall(log);
    // Task 8 把柱与板接进 `planDelete` 之后，"只剩一根柱"不再是 unsupported 的样例 —— 它发得出
    // `column.delete`。这一格从此只装屏幕上根本取不到的两样东西：裸点与楼层本身。这里用裸点当靶子
    // （`wall.startId` 在屏幕上不是一个命中目标：`pickAt` 的命中集只有墙与洞口）。
    const bare = wall.startId;
    expect(log.document.get(bare)?.kind).toBe('point');
    // ① 拉墙时误触 Delete：什么都不发，但**不许**报"没选中东西"（选中集不该被清空）
    expect(planDelete(log.document, storeyId, 'wall', [wall.id, bare])).toEqual({
      outcome: 'ignored-in-wall-mode',
      commands: [],
      commandTypes: [],
      candidateIds: [],
      unsupported: [],
    });
    // ② 只选了一枚裸点：发不出命令，如实报 unsupported（Delete 键不是删点的入口）
    const only = planDelete(log.document, storeyId, 'select', [bare]);
    expect(only.outcome).toBe('unsupported');
    expect(only.commands).toHaveLength(0);
    expect(only.unsupported).toEqual([bare]);
    // ③ 什么都没选：'empty'，与 ② 不同色
    const none = planDelete(log.document, storeyId, 'select', []);
    expect(none.outcome).toBe('empty');
    expect(none.unsupported).toEqual([]);
    // 三色的存在性：写成布尔（"发没发命令"）就把 ①②③ 糊成一格
    expect(new Set(['ignored-in-wall-mode', only.outcome, none.outcome]).size).toBe(3);
    // 混选：裸点 + 墙 ⇒ 墙照删，点进 unsupported（不是"整批不做"）
    const mixed = planDelete(log.document, storeyId, 'select', [bare, wall.id]);
    expect(mixed.outcome).toBe('ok');
    expect(mixed.commandTypes).toEqual(['wall.delete']);
    expect(mixed.unsupported).toEqual([bare]);
    // 素材自证：同一根柱换到本层就发得出命令 ⇒ 上面那发红在"它是点"，不红在"这层没东西可删"
    log.dispatch(columnCreate({ storeyId, at: { x: 500, y: 500 }, widthMm: 400, depthMm: 400 }));
    const columnId = kindId(log, 'column');
    expect(planDelete(log.document, storeyId, 'select', [columnId]).outcome).toBe('ok');
  });

  it('别层构件进 unsupported，不是"没选中"：本层没这个权力（墙、洞口、柱三样一起判）', () => {
    const log = new TransactionLog(house.doc);
    log.dispatch(
      columnCreate({ storeyId: house.upperStoreyId, at: { x: 100, y: 100 }, widthMm: 400, depthMm: 400 }),
    );
    const doc = log.document;
    const upper = upperWalls[0]!;
    const upperOpening = doc.byKind('opening').find((o) => o.storeyId === house.upperStoreyId);
    if (upperOpening === undefined) throw new TypeError('样例房二层应当有洞口');
    const upperColumn = kindId(log, 'column');
    const plan = planDelete(doc, house.lowerStoreyId, 'select', [upper.id, upperOpening.id, upperColumn]);
    expect(plan.outcome).toBe('unsupported');
    expect(plan.commands).toHaveLength(0); // 一发都不许发：删二层的构件不在本层的权力里
    expect(plan.candidateIds).toEqual([]);
    expect([...plan.unsupported].sort()).toEqual([upper.id, upperOpening.id, upperColumn].sort());
    // 素材自证：同一枚柱换到它自己的层就发得出命令 ⇒ 上一发红在认层，不红在"柱删不掉"
    const same = planDelete(doc, house.upperStoreyId, 'select', [upperColumn]);
    expect(same.outcome).toBe('ok');
    expect(same.commandTypes).toEqual(['column.delete']);
  });

  it('③④ 接上屏幕：四类混选发四条，顺序定死成 洞口 → 柱 → 板 → 墙', () => {
    const { log, storeyId } = synthStorey();
    const host = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const other = wallAt(log, storeyId, { x: 0, y: 2000 }, { x: 4000, y: 2000 });
    const openingId = openingAt(log, host.id, 1200); // 宿主是 host，而 host **不**进本次删除集 ⇒ 它得自己发一条
    log.dispatch(columnCreate({ storeyId, at: { x: 500, y: 500 }, widthMm: 400, depthMm: 400 }));
    const columnId = kindId(log, 'column');
    log.dispatch(
      slabCreate({
        storeyId,
        boundary: [
          { x: 0, y: 4000 },
          { x: 4000, y: 4000 },
          { x: 4000, y: 6000 },
          { x: 0, y: 6000 },
        ],
        thicknessMm: 120,
      }),
    );
    const slabId = kindId(log, 'slab');
    const other2 = wallAt(log, storeyId, { x: 0, y: 8000 }, { x: 4000, y: 8000 });
    // 同类多枚时**输入故意降序**：只有一枚墙的夹具测不出 sort（实测摘掉四处 sort 全绿，
    // 因为单元素数组排不排都一样）。降序进、升序出才是这道 sort 的牙齿。
    const wallsDesc = [other.id, other2.id].sort().reverse();
    // 传入顺序故意打乱：判的是"输出顺序由规则定死"，不是"跟着选中集走"
    const plan = planDelete(log.document, storeyId, 'select', [slabId, ...wallsDesc, openingId, columnId]);
    expect(plan.outcome).toBe('ok');
    expect(plan.commandTypes).toEqual([
      'opening.delete',
      'column.delete',
      'slab.delete',
      'wall.delete',
      'wall.delete',
    ]);
    expect(plan.candidateIds).toEqual([openingId, columnId, slabId, ...[other.id, other2.id].sort()]);
    // 判据的牙齿：栈顶必须是 wall.delete。摘掉四处 sort（按集合插入序发）这一发就红，
    // 于是撤销一次还回来的不是"墙 + 它级联掉的洞口"整组，而是一樘无主的洞口。
    const tx = new TransactionLog(log.document);
    for (const command of plan.commands) tx.dispatch(command);
    expect(tx.depth).toBe(5);
    expect(tx.document.get(host.id)?.kind).toBe('wall'); // host 没被选中，它和它的洞口都该还在
    expect(tx.document.get(openingId)).toBeUndefined();
    expect(tx.document.get(columnId)).toBeUndefined();
    expect(tx.document.get(slabId)).toBeUndefined();
    expect(tx.document.get(other.id)).toBeUndefined();
    expect(tx.document.get(other2.id)).toBeUndefined();
    // 撤销栈顶那一条：最后删的那面墙回来了，其余四条各占一格 ⇒ 一次 Ctrl+Z 只回来一面墙
    const undone = wallsDesc[0]!;
    tx.undo();
    expect(tx.document.get(undone)?.kind).toBe('wall');
    expect(tx.document.get(slabId)).toBeUndefined();
  });

  it('柱落在墙端点上：删柱只删柱，那枚点还被墙引用 ⇒ 不许跟着走（删柱拆墙）', () => {
    const { log, storeyId } = oneWall();
    const wall = onlyWall(log);
    // 复用墙起点当柱心：这是 S1 里柱最常见的形态（柱在墙角）
    log.dispatch(columnCreate({ storeyId, at: { pointId: wall.startId }, widthMm: 400, depthMm: 400 }));
    const columnId = kindId(log, 'column');
    const pointsBefore = log.document.byKind('point').length;
    const plan = planDelete(log.document, storeyId, 'select', [columnId]);
    for (const command of plan.commands) log.dispatch(command);
    expect(log.document.get(columnId)).toBeUndefined();
    expect(log.document.byKind('point').length).toBe(pointsBefore); // 一根点都不许少
    expect(requirePoint(log.document, wall.startId, '墙起点').storeyId).toBe(storeyId);
    // 反向自证：同一根柱换成独占落点，那枚点就跟着走 —— 区别只在"还有谁引用它"
    const solo = new TransactionLog(log.document);
    solo.dispatch(columnCreate({ storeyId, at: { x: 900, y: 900 }, widthMm: 400, depthMm: 400 }));
    const soloId = kindId(solo, 'column');
    const soloPoint = (solo.document.get(soloId) as { pointId: string }).pointId;
    const before = solo.document.byKind('point').length;
    for (const command of planDelete(solo.document, storeyId, 'select', [soloId]).commands) {
      solo.dispatch(command);
    }
    expect(solo.document.byKind('point').length).toBe(before - 1);
    expect(solo.document.get(soloPoint)).toBeUndefined();
  });

  it('删一根带独占落点的柱：pruneSelection 把柱与孤儿点一起剔掉', () => {
    const { log, storeyId } = oneWall();
    const wall = onlyWall(log);
    log.dispatch(columnCreate({ storeyId, at: { x: 500, y: 500 }, widthMm: 400, depthMm: 400 }));
    const columnId = kindId(log, 'column');
    const columnPoint = (log.document.get(columnId) as { pointId: string }).pointId;
    const selected = [columnId, columnPoint, wall.id];
    const plan = planDelete(log.document, storeyId, 'select', [columnId]);
    for (const command of plan.commands) log.dispatch(command);
    expect(log.document.get(columnId)).toBeUndefined();
    expect(log.document.get(columnPoint)).toBeUndefined(); // 级联收的，不是 UI 发的
    // 柱与它的点都不在选中集里了，而墙还在 —— 这一发的凭据是"问真源"，不是 UI 自己抄一份孤儿判定
    expect(pruneSelection(log.document, storeyId, selected)).toEqual([wall.id]);
  });

  it('删掉一面带洞口的墙：洞口与它的孤儿点一起消失，pruneSelection 把两者都剔掉', () => {
    const { log, storeyId } = oneWall();
    const wall = onlyWall(log);
    const openingId = openingAt(log, wall.id, 1000);
    const pointsBefore = log.document.byKind('point').length;
    const selected = [wall.id, openingId, wall.startId];
    const plan = planDelete(log.document, storeyId, 'select', [wall.id]);
    for (const command of plan.commands) log.dispatch(command);
    expect(log.document.get(wall.id)).toBeUndefined();
    expect(log.document.get(openingId)).toBeUndefined(); // 级联收的，不是 UI 发的
    // 这面墙的两枚端点都不再被引用 ⇒ wallDelete 一并收掉，点数回到建墙之前
    expect(log.document.byKind('point').length).toBe(pointsBefore - 2);
    expect(pruneSelection(log.document, storeyId, selected)).toEqual([]);
  });

  it('pruneSelection：别层的、已不存在的、楼层本身都剔掉，留下的按 id 升序', () => {
    // 两层都取样例房：合成文档里只有一层，"别层的构件"根本不存在，摘掉层过滤也红不出来（实测过）。
    const lower = lowerWalls[0]!;
    const upper = upperWalls[0]!;
    expect(pruneSelection(house.doc, house.lowerStoreyId, [lower.id, upper.id, 'gone'])).toEqual([lower.id]);
    // 点按它自己的 storeyId 筛（不是"一律放行"）：别层的点留在本层选中集里，
    // 下一发拖动就会拿二层的坐标去改一层的点。
    expect(requirePoint(house.doc, upper.startId, '别层端点').storeyId).toBe(house.upperStoreyId);
    expect(
      pruneSelection(house.doc, house.lowerStoreyId, [lower.startId, upper.startId, house.upperStoreyId]),
    ).toEqual([lower.startId]);
    // 反方向的同一发：二层的选中集里不许留一层的点
    expect(pruneSelection(house.doc, house.upperStoreyId, [lower.startId, upper.startId])).toEqual([
      upper.startId,
    ]);
    // 升序是判据的一部分：撤销一次再比"选中集没变"，Set 的插入序会漂，只有排过序才可比
    const many = house.doc.byKind('wall').filter((w) => w.storeyId === house.lowerStoreyId).slice(0, 4);
    const kept = pruneSelection(house.doc, house.lowerStoreyId, [...many].reverse().map((w) => w.id));
    expect(kept).toEqual([...kept].sort());
    expect(kept).toHaveLength(many.length);
    expect(kept).toEqual(many.map((w) => w.id).sort());
  });
});

describe('新建回执与探针', () => {
  it('lastCreatedWall：派发后拿得到；撤销后 affected 仍列着那枚 id，但答案必须是 null', () => {
    const { log, storeyId } = oneWall();
    const created = wallAt(log, storeyId, { x: 0, y: 1000 }, { x: 4000, y: 1000 });
    const read = lastCreatedWall(log.document, log.affected, storeyId);
    expect(read).toEqual({ wallId: created.id, storeyId, startId: created.startId, endId: created.endId });
    // S6 的那一枪：`undo()` 把 lastAffected 设成**前向**补丁的 id，所以 id 还在集合里，
    // 而文档里已经没有那面墙。少了 `doc.get(id)` 复核，屏幕上就是一个不存在的构件的把手。
    expect(log.undo()).toBe(true);
    expect(log.affected.has(created.id)).toBe(true);
    expect(log.document.get(created.id)).toBeUndefined();
    expect(lastCreatedWall(log.document, log.affected, storeyId)).toBeNull();
  });

  it('lastCreatedWall 认层：别层的墙不给本层的答案', () => {
    const upper = upperWalls[0]!;
    const ids = new Set([upper.id, upper.startId, upper.endId]);
    expect(lastCreatedWall(house.doc, ids, house.lowerStoreyId)).toBeNull();
    expect(lastCreatedWall(house.doc, ids, house.upperStoreyId)?.wallId).toBe(upper.id);
  });

  it('wallProbe 在样例房里给得出靶子，六道筛逐条自证，且两次问逐字相同', () => {
    const probe = wallProbe(house.doc, house.lowerStoreyId, ops, view);
    expect(probe).not.toBeNull();
    if (probe === null) throw new TypeError('探针给不出可画的空白落点');
    // ① 起点吸到既有端点，且复用那一枚
    const startDrop = dropTargetOf(view, probe.startPx, null, field);
    expect(startDrop.snap?.kind).toBe('endpoint');
    expect(startDrop.snap?.pointId).toBe(probe.startPointId);
    const startPoint = requirePoint(house.doc, probe.startPointId, '探针起点');
    expect(probe.startMm).toEqual({ x: startPoint.x, y: startPoint.y });
    // ② 终点不引别人的点（正交档命中是允许的，它不带 pointId）
    const endDrop = dropTargetOf(view, probe.endPx, probe.startMm, field, { excludeMm: probe.startMm });
    expect(endDrop.mm).toEqual(probe.endMm);
    expect(endDrop.snap?.pointId ?? null).toBeNull();
    // ③ 两道长度下限
    expect(probe.lengthMm).toBeGreaterThanOrEqual(MIN_WALL_LENGTH_MM);
    expect((probe.lengthMm - probe.defaults.thicknessMm) * view.pxPerMm).toBeGreaterThanOrEqual(
      MIN_PICK_EDGE_PX,
    );
    // ④ 落点与中点两发像素一个候选都不命中
    expect(pickAt(ops, probe.endPx)).toEqual([]);
    expect(pickAt(ops, probe.midPx)).toEqual([]);
    // ⑤ 三发像素全在画布内（留 2px 边）：越界的那一发 `sendInputEvent` 发不出去
    for (const px of [probe.startPx, probe.endPx, probe.midPx]) {
      expect(px.x).toBeGreaterThanOrEqual(2);
      expect(px.y).toBeGreaterThanOrEqual(2);
      expect(px.x).toBeLessThan(view.widthPx - 2);
      expect(px.y).toBeLessThan(view.heightPx - 2);
    }
    // 像素是整数（`sendInputEvent` 只收整数 DIP），毫米由像素反算 ⇒ 不动点
    expect(Number.isInteger(probe.endPx.x) && Number.isInteger(probe.endPx.y)).toBe(true);
    expect(moveTargetOf(view, probe.endPx)).toEqual(probe.endMm);
    // 确定性：同一个靶子两次问必须一模一样（"撤销后回到原值"那类判据的前提）
    expect(wallProbe(house.doc, house.lowerStoreyId, ops, view)).toEqual(probe);
    // 建出来真的点得中：这一发证明筛 ③ 够用，删除那一步能在真窗口里点名
    const log = new TransactionLog(house.doc);
    const command = draftCommand(
      {
        storeyId: house.lowerStoreyId,
        start: { mm: probe.startMm, px: probe.startPx, snap: startDrop.snap },
        cursorPx: probe.endPx,
        end: endDrop,
        legal: true,
      },
      probe.defaults,
    );
    if (command === null) throw new TypeError('legal 为真却拿不到命令');
    log.dispatch(command);
    const created = lastCreatedWall(log.document, log.affected, house.lowerStoreyId);
    if (created === null) throw new TypeError('affected 里没有那面墙');
    const after = buildDrawList(log.document, house.lowerStoreyId, view, EMPTY_SELECTION);
    const named = pickPxOf(after, created.wallId);
    expect(named).not.toBeNull(); // 筛 ③/④ 的全部目的：删除那一步点得出这面墙
    if (named !== null) expect(pickAt(after, named).map((h) => h.ownerId)).toEqual([created.wallId]);
  });

  it('探针靶子的配平账：ops 空表（筛 ④ 失效）时建出来恰好多一枚点、删回去账回到原样', () => {
    // 空指令表 = "屏幕上什么都没有" ⇒ 筛 ④ 一枚都不拒，这一发只剩"起点复用、终点新建"这条账可判。
    // 终点若复用了既有点，删掉这面墙时那枚点仍被别人引用 ⇒ 留下 ⇒ 点数回不到原样。
    // 闸门那一步"删掉新建的墙"的配平判据就是这句话。
    //
    // **这一发在摘掉筛 ② 时不红**（E14 实测）：样例房的第一发候选终点本来就不是既有点，
    // 拦不拦都一样。② 自己的牙齿在下一条合成夹具那儿 —— 两条别合并，它们钉的是两件事。
    const probe = wallProbe(house.doc, house.lowerStoreyId, [], view);
    expect(probe).not.toBeNull();
    if (probe === null) throw new TypeError('空表下探针该给得出靶子');
    const startDrop = dropTargetOf(view, probe.startPx, null, field);
    const endDrop = dropTargetOf(view, probe.endPx, probe.startMm, field, { excludeMm: probe.startMm });
    expect(endDrop.snap?.pointId ?? null).toBeNull();
    const command = draftCommand(
      {
        storeyId: house.lowerStoreyId,
        start: { mm: probe.startMm, px: probe.startPx, snap: startDrop.snap },
        cursorPx: probe.endPx,
        end: endDrop,
        legal: true,
      },
      probe.defaults,
    );
    if (command === null) throw new TypeError('legal 为真却拿不到命令');
    const log = new TransactionLog(house.doc);
    const before = log.document.byKind('point').length;
    log.dispatch(command);
    const created = lastCreatedWall(log.document, log.affected, house.lowerStoreyId);
    if (created === null) throw new TypeError('affected 里没有那面墙');
    expect(log.document.byKind('point').length).toBe(before + 1); // 起点复用、终点新建
    log.dispatch(wallDelete({ wallId: created.wallId }));
    expect(log.document.byKind('point').length).toBe(before); // 孤儿点被收走，账配平
  });

  it('筛 ② 有牙齿：画布夹住的靶场里，唯一活着的候选引的是别人的点', () => {
    // **靶场视口**：300×300px @0.1px/mm ⇒ 画布只夹住 mm x ∈ (−1500, 1500)、y ∈ (−500, 2500)。
    // 两面墙各从画布内的一枚端点往 x=−6000 长出去 ⇒ 画布外那两枚端点当起点全被筛 ⑤ 拒掉，
    // 剩下 (0,0) 与 (0,2000) **互为对方唯一落在画布内的候选** —— 而那一枚终点是别人的点。
    // 摘掉筛 ②（E14）探针就把这一发交出来 ⇒ 本条恒红在最后那句"必须给 null"。
    //
    // 为什么这一格必须靠画布夹住、而不是"把样例房的那一发换个干净落点"：终点复用既有点 ⇒
    // 那一枚像素必然压在那面墙的轮廓上 ⇒ 筛 ④ 顺手就拒；就算 `ops` 给空表绕过 ④，共线重叠的
    // 墙又派生不出来 ⇒ 筛 ⑥ 也拒。也就是说 **④ 与 ⑥ 天生罩住 ②**（2026-09-28 实测：加了 ⑤⑥
    // 之后 E14 连跑八次 30/0，一条都不红）。这一格把 `ops` 给空表、再用画布把活着的候选逼到
    // 只剩一发，② 才重新有自己说话的地方 —— **判据不许因为"反正后面有人拦"就删掉前面的筛**：
    // ⑥ 每发要做一次整层派生，② 是一次比较，屏幕上拖一次光标要问十几发。
    const tv = viewportOf(300, 300, { pxPerMm: 0.1, center: vec(0, 1000) });
    const { log, storeyId } = synthStorey();
    wallAt(log, storeyId, { x: 0, y: 0 }, { x: -6000, y: 0 });
    wallAt(log, storeyId, { x: 0, y: 2000 }, { x: -6000, y: 2000 });
    const doc = log.document;
    const fd = snapFieldOf(doc, storeyId);
    // 素材自证 ①：那一发引的确实是既有点 —— 否则"给 null"是"场里什么都没有"造成的，与 ② 无关
    const candPx = pxOf({ x: 0, y: 2000 }, tv);
    const cand = dropTargetOf(tv, candPx, { x: 0, y: 0 }, fd, { excludeMm: { x: 0, y: 0 } });
    expect(cand.snap?.pointId ?? null).not.toBeNull();
    // 素材自证 ②：三发像素全在画布内（筛 ⑤ 放行）、两道长度下限都过（筛 ③ 放行）
    for (const p of [pxOf({ x: 0, y: 0 }, tv), candPx, pxOf({ x: 0, y: 1000 }, tv)]) {
      expect(p.x).toBeGreaterThanOrEqual(2);
      expect(p.y).toBeGreaterThanOrEqual(2);
      expect(p.x).toBeLessThan(tv.widthPx - 2);
      expect(p.y).toBeLessThan(tv.heightPx - 2);
    }
    expect(2000).toBeGreaterThanOrEqual(MIN_WALL_LENGTH_MM);
    // 素材自证 ③：命令层建得成、派生层也画得出 ⇒ 前五道筛加两个试跑都不拒它
    const startDrop = dropTargetOf(tv, pxOf({ x: 0, y: 0 }, tv), null, fd);
    const defaults = newWallDefaults(doc, storeyId);
    const trial = new TransactionLog(doc);
    trial.dispatch(
      wallCreate({
        storeyId,
        start: { pointId: startDrop.snap?.pointId ?? 'x' },
        end: { pointId: cand.snap?.pointId ?? 'x' },
        thicknessMm: defaults.thicknessMm,
        heightMm: defaults.heightMm,
      }),
    );
    expect(() => buildDrawList(trial.document, storeyId, tv)).not.toThrow();
    // 判据：六道筛齐全 ⇒ 这一格探针给 null
    expect(wallProbe(doc, storeyId, [], tv)).toBeNull();
    // 反面自证：同一份文档把画布松开（`sv` 夹住 x ∈ (−3000, 7000)）靶子就出现了
    // ⇒ 上面那发红在"越界把候选挤到只剩引点那一发"，不红在文档本身没有可画的落点
    expect(wallProbe(doc, storeyId, [], sv)).not.toBeNull();
  });

  it('筛 ④ 有牙齿：画布夹住的靶场里，唯一活着的候选中点压在横墙上', () => {
    // 同一块画布：竖着的候选 (0,0)→(0,2000) 落点**空**、中点 (0,1000) 正压在横墙 (−6000,1000)→(6000,1000)
    // 的轮廓里 ⇒ 只有筛 ④ 拒它（终点没引任何点 ⇒ ②放行；建得成也画得出 ⇒ 命令层与 ⑥ 放行；
    // 三发像素全在画布内 ⇒ ⑤ 放行）。摘掉筛 ④（E15）探针把这一发交出来 ⇒ 恒红在最后那句。
    // 起点只有 (0,0) 一枚在画布内（其余端点全在 x=±6000 之外）⇒ 与 uuidv7 的排位无关。
    const tv = viewportOf(300, 300, { pxPerMm: 0.1, center: vec(0, 1000) });
    const { log, storeyId } = synthStorey();
    wallAt(log, storeyId, { x: 0, y: 0 }, { x: -6000, y: 0 });
    wallAt(log, storeyId, { x: -6000, y: 1000 }, { x: 6000, y: 1000 });
    const doc = log.document;
    const tvOps = buildDrawList(doc, storeyId, tv, EMPTY_SELECTION);
    const fd = snapFieldOf(doc, storeyId);
    // 素材自证 ①：中点确实压在横墙上（这一句就是 ④ 要拒的东西）
    expect(pickAt(tvOps, pxOf({ x: 0, y: 1000 }, tv))).not.toEqual([]);
    // 素材自证 ②：落点自己是空白的，且不带别人的点 ⇒ ④ 之外没有第二道筛替它说话
    const candPx = pxOf({ x: 0, y: 2000 }, tv);
    expect(pickAt(tvOps, candPx)).toEqual([]);
    const cand = dropTargetOf(tv, candPx, { x: 0, y: 0 }, fd, { excludeMm: { x: 0, y: 0 } });
    expect(cand.snap?.pointId ?? null).toBeNull();
    // 素材自证 ③：命令层与派生层都放行（新点落在横墙内侧是 S1 允许的几何，闸门只要求点得中）
    const defaults = newWallDefaults(doc, storeyId);
    const trial = new TransactionLog(doc);
    trial.dispatch(
      wallCreate({
        storeyId,
        start: { pointId: fd.points.find((p) => p.mm.x === 0 && p.mm.y === 0)?.pointId ?? 'x' },
        end: { x: cand.mm.x, y: cand.mm.y },
        thicknessMm: defaults.thicknessMm,
        heightMm: defaults.heightMm,
      }),
    );
    expect(() => buildDrawList(trial.document, storeyId, tv)).not.toThrow();
    // 判据：六道筛齐全 ⇒ 探针给 null；松开画布（靶子换到别发候选）就有了 ⇒ 不红在空场
    expect(wallProbe(doc, storeyId, tvOps, tv)).toBeNull();
    const svOps = buildDrawList(doc, storeyId, sv, EMPTY_SELECTION);
    expect(wallProbe(doc, storeyId, svOps, sv)).not.toBeNull();
  });

  it('探针只给整数像素：换一把"整数毫米落在分数像素上"的尺子仍然成立', () => {
    // 样例房在 0.125px/mm 下所有靶子恰好落在整数像素上，那份视图证不了 `intPx` 这句话。
    // 高度改成 901 ⇒ pxPerMm 变成 781/6240，同样的毫米乘出来带小数，取整这一步才有对象。
    const v = fitStorey(house.doc, house.lowerStoreyId, 1200, 901, 60);
    expect(v.pxPerMm).not.toBe(0.125);
    // 素材自证：这把尺子下"毫米的原始像素"确实带小数 —— 不然这一发与上一发是同一件事，
    // `intPx` 依然没有对象（0.125px/mm + 全是 100 的倍数的坐标，取整恒等，红不出来）。
    const witness = mmToPx(v, vec(0, 0));
    expect(Number.isInteger(witness.x) && Number.isInteger(witness.y)).toBe(false);
    const oddOps = buildDrawList(house.doc, house.lowerStoreyId, v, EMPTY_SELECTION);
    const probe = wallProbe(house.doc, house.lowerStoreyId, oddOps, v);
    expect(probe).not.toBeNull();
    if (probe === null) throw new TypeError('换尺子后探针给不出靶子');
    for (const px of [probe.startPx, probe.endPx, probe.midPx]) {
      expect(Number.isInteger(px.x) && Number.isInteger(px.y)).toBe(true);
    }
    // 取整之后仍然自洽：落点是**那一发整数像素**过一遍屏幕通路的结果 ⇒ 闸门发得出、renderer 落得回
    const endDrop = dropTargetOf(v, probe.endPx, probe.startMm, field, { excludeMm: probe.startMm });
    expect(endDrop.mm).toEqual(probe.endMm);
    const startDrop = dropTargetOf(v, probe.startPx, null, field);
    expect(startDrop.mm).toEqual(probe.startMm);
    expect(startDrop.snap?.pointId).toBe(probe.startPointId);
  });

  it('极度缩小下探针给 null，稍大一档就给得出：说话的是那道像素下限', () => {
    // 两发的差别只有比例。0.02px/mm ⇒ 候选 2000mm = 40px：中点离既有墙角 20px（筛 ④ 放行），
    // 而 `(2000-240)*0.02 = 35.2 < 64` 被像素下限拒掉 ⇒ null。0.04px/mm 同一批候选 = 80px，
    // `(2000-240)*0.04 = 70.4 ≥ 64` 过筛 ⇒ 给得出。
    // 为什么比例要挑在中间：太小（0.005）时中点也挤进 8px 命中圈，改坏"摘掉像素下限"会被
    // 筛 ④ 顺手补上，这一发就退化成"④ 的第二个用例"；太大则两道筛都不说话。
    const tiny = viewportOf(1000, 800, { pxPerMm: 0.02, center: vec(4000, 3000) });
    const big = viewportOf(1000, 800, { pxPerMm: 0.04, center: vec(4000, 3000) });
    const tinyOps = buildDrawList(house.doc, house.lowerStoreyId, tiny, EMPTY_SELECTION);
    const bigOps = buildDrawList(house.doc, house.lowerStoreyId, big, EMPTY_SELECTION);
    expect(wallProbe(house.doc, house.lowerStoreyId, tinyOps, tiny)).toBeNull();
    const okProbe = wallProbe(house.doc, house.lowerStoreyId, bigOps, big);
    expect(okProbe).not.toBeNull();
    if (okProbe === null) throw new TypeError('0.04px/mm 下探针该给得出靶子');
    expect((okProbe.lengthMm - okProbe.defaults.thicknessMm) * big.pxPerMm).toBeGreaterThanOrEqual(
      MIN_PICK_EDGE_PX,
    );
    // 毫米下限在这一发里是**旁观者**：候选偏移恒 ≥2000mm，这条 500 对它永远不生效。
    // 所以 `MIN_WALL_LENGTH_MM` 只保护探针挑靶子，不保护用户那一发（那一发的下限是真源的墙厚）。
    expect(okProbe.lengthMm).toBeGreaterThan(MIN_WALL_LENGTH_MM);
  });

  it('筛 ⑤ 有牙齿：整层挪出画布后探针没靶子，回到拟合视图靶子就出现', () => {
    // 样例房在没有这条筛时挑中的是 (0,0)→(-2000,0)：毫米合法、`pickAt` 空、两道长度下限都过，
    // 但 `endPx = (-150, 825)`、`midPx = (-25, 825)` 在画布**左边界之外**（2026-09-28 实测）。
    // 这一发判的不是"样例房挑哪一发"（那随 uuidv7 变），而是"挑出来的三发必须发得出 DIP"。
    const off = viewportOf(1200, 900, { pxPerMm: view.pxPerMm, center: vec(30000, 30000) });
    // 素材自证：这一发的原点确实在画布外 —— 否则那句 null 是别的东西造成的（尺寸、比例、空场…）
    expect(mmToPx(off, vec(0, 0)).x).toBeLessThan(2);
    expect(snapFieldOf(house.doc, house.lowerStoreyId).points.length).toBeGreaterThan(0);
    const offOps = buildDrawList(house.doc, house.lowerStoreyId, off, EMPTY_SELECTION);
    expect(wallProbe(house.doc, house.lowerStoreyId, offOps, off)).toBeNull();
    // 同一份文档回到拟合视图 ⇒ 靶子出现：证上面那发红在"越界"，不红在文档或比例
    expect(wallProbe(house.doc, house.lowerStoreyId, ops, view)).not.toBeNull();
  });

  it('筛 ⑤ 的确定性夹具：两个端点绕不开同一发 —— 画布外那一发只由 ⑤ 拒', () => {
    // 上一发判的是"越界会让探针没靶子"，但它读的是样例房，而样例房里**哪个端点先被枚举**随
    // uuidv7 变，所以它只能说"给不给得出"，不能说"给的是哪一发"。Task 8 要把 ⑤ 钉成可复算的账，
    // 于是这里换一份一面墙的合成现场：把画布摆到只有 (4000,0) 那端在界内（另一端 (0,0) 的
    // startPx 就越界 ⇒ 它的十个候选全被 ⑤ 拒），于是无论枚举顺序如何，答案只能是同一发。
    // 视口尺寸 / 中心是算出来的不是试出来的：pxPerMm=0.2、640×800 ⇒ x 可见 [1900, 5100]、
    // y 可见 [-1000, 3000]。于是 (4000,0) 的候选里 E=(6000,0) 越右界、S=(4000,-2000) 越下界、
    // W=(2000,0) 压在既有墙上（筛 ④），只剩 N=(4000,2000)。
    const { log, storeyId } = synthStorey();
    const wall = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const v = viewportOf(640, 800, { pxPerMm: 0.2, center: vec(3500, 1000) });
    const doc = log.document;
    const vOps = buildDrawList(doc, storeyId, v, EMPTY_SELECTION);
    // 素材自证（三发都在界外/界内的哪一侧，先钉死，才许说"答案唯一"）
    expect(mmToPx(v, vec(0, 0)).x).toBeLessThan(2); // A 端整个在画布左外 ⇒ 它的候选全交不出靶子
    expect(insidePx(v, intPxOf(mmToPx(v, vec(4000, 0))))).toBe(true); // B 端在界内
    const eastOff = intPxOf(mmToPx(v, vec(6000, 0)));
    expect(eastOff.x).toBeGreaterThanOrEqual(v.widthPx - 2); // E 候选越右界
    expect(pickAt(vOps, eastOff)).toEqual([]); // ……而筛 ④ 放行它 ⇒ 拒它的只有 ⑤
    expect(snapFieldOf(doc, storeyId).points.length).toBeGreaterThan(0);
    const probe = wallProbe(doc, storeyId, vOps, v);
    if (probe === null) throw new TypeError('这个夹具上探针该给得出靶子');
    // 判据的牙齿（2026-09-28 实测）：摘掉 ⑤ 那一发不是"探针没靶子"，而是**换了一发挑不中 DIP 的**
    // —— 答案改挑 (0,0) 那端（它的 startPx 在画布左外），四个独立进程都红在这里。
    // 而"答案只能是 B 端那一发"这件事本身是确定性的：A 端十个候选全被 ⑤ 拒（startPx 越界与候选无关），
    // 所以无论 uuidv7 让哪一端先被枚举，能交靶子的只有 B。
    expect(probe.startMm).toEqual({ x: 4000, y: 0 });
    expect(probe.startPointId).toBe(wall.endId);
    expect(probe.endMm).toEqual({ x: 4000, y: 2000 });
    expect(insidePx(v, probe.endPx)).toBe(true);
    expect(insidePx(v, probe.midPx)).toBe(true);
  });

  it('⑥ 的前提：同一发候选在命令层与派生层一起拒（星形接头）', () => {
    // 角点 (0,0) 已经过着两条线（x 轴与 y 轴）。第三发 45° 斜线过同一点 ⇒ core 的 `deriveJoints`
    // 判它星形接头。Task 6 写这一条时它**过了 ①~⑤ 也过了命令层**，只在派生层炸；Task 7 把派生复核
    // 挂上 `wallCreate.build` 之后，同一发在**两层一起拒** ⇒ 本条改判"两层同判、预言不漂"。
    // ⑥ 真正的牙齿在上一条样例房用例里
    // （摘掉 ⑥ 那次实测八个进程：「六道筛逐条自证」七次红、一次绿，红在建完再派生那一句 —— 本条不跟着红，
    // 因为它判的是候选本身，不判探针挑了谁）。
    const { log, storeyId } = synthStorey();
    const east = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    wallAt(log, storeyId, { pointId: east.startId }, { x: 0, y: 4000 });
    const fd = snapFieldOf(log.document, storeyId);
    const startMm: MoveTarget = { x: 0, y: 0 };
    const startOps = buildDrawList(log.document, storeyId, sv, EMPTY_SELECTION);
    const endPx = pxOf({ x: 2000, y: 2000 }, sv);
    const start = draftAtPress(sv, pxOf(startMm, sv), fd);
    const end = dropTargetOf(sv, endPx, startMm, fd, { excludeMm: startMm });
    const draft: DraftWall = { storeyId, start, cursorPx: endPx, end, legal: true };
    // ①③④⑤ 逐条自证：这一发确实"前五条全过"，于是它红的时候只可能是 ⑥ 干的
    expect(start.snap?.kind).toBe('endpoint');
    expect(end.snap?.pointId ?? null).toBeNull();
    expect(end.mm).toEqual({ x: 2000, y: 2000 });
    expect(pickAt(startOps, endPx)).toEqual([]);
    expect(endPx.x).toBeGreaterThanOrEqual(2);
    expect(endPx.y).toBeGreaterThanOrEqual(2);
    expect(endPx.x).toBeLessThan(sv.widthPx - 2);
    expect(endPx.y).toBeLessThan(sv.heightPx - 2);
    expect(Math.hypot(end.mm.x - startMm.x, end.mm.y - startMm.y)).toBeGreaterThan(MIN_WALL_LENGTH_MM);
    expect(legalWallCreate(log.document, draft)).toBe(false);
    // Task 7 把派生复核挂上 `wallCreate.build` 之后，这一发不再是"命令层放行、派生层抛"，
    // 而是**两层一起拒**：`legalWallCreate` 试跑的就是 `build`，所以它拿到的抛错就是 ⑥ 那句。
    // 这一发从此不判"⑥ 为什么必须存在"，判的是"⑥ 从画图时炸提前到松手前拒"这条搬迁落地了。
    const command = draftCommand(draft, newWallDefaults(log.document, storeyId));
    if (command === null) throw new TypeError('legal 为假却拿不到命令（`draftCommand` 看了 legal？）');
    expect(() => command.build(log.document)).toThrow(/S1 不支持/);
    // ⑥ 在这一发夹具上**不承重**：摘掉它，探针换的还是别发轴向候选，本条不红（实测 E28 只红
    // 「六道筛逐条自证」那一条，且八进程里七次）。留着它是为了证"探针给的每一发都画得出"这句判据本身写得对。
    const probe = wallProbe(log.document, storeyId, startOps, sv);
    if (probe === null) throw new TypeError('这个夹具上探针该给得出别发候选（四条轴向外侧）');
    const t2 = new TransactionLog(log.document);
    t2.dispatch(
      wallCreate({
        storeyId,
        start: { pointId: probe.startPointId },
        end: { x: probe.endMm.x, y: probe.endMm.y },
        thicknessMm: probe.defaults.thicknessMm,
        heightMm: probe.defaults.heightMm,
      }),
    );
    expect(() => buildDrawList(t2.document, storeyId, sv)).not.toThrow();
  });

  it('⑥ 的确定性夹具：八发候选在命令层与派生层判得一字一样', () => {
    // 上一发只钉了 45° 那一发。Task 8 把属性面板接上屏之后，"屏幕上拒过一次"就不再是孤例，
    // 于是这里把 (0,0) 这个三臂点周围的**八发**候选全问一遍，判的是两层**逐发同判**：
    // 摘掉 core 的 `assertDerivesAfterApply` ⇒ 四发斜线在命令层翻成放行、派生层仍然抛 ⇒ 本条红。
    // 这一条不读探针挑了谁，所以它不受 uuidv7 影响 —— 这就是"确定性夹具"四个字的含义。
    const { log, storeyId } = synthStorey();
    const east = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    wallAt(log, storeyId, { pointId: east.startId }, { x: 0, y: 4000 });
    const doc = log.document;
    const fd = snapFieldOf(doc, storeyId);
    const defaults = newWallDefaults(doc, storeyId);
    const startMm: MoveTarget = { x: 0, y: 0 };
    const start = draftAtPress(sv, pxOf(startMm, sv), fd);
    expect(start.snap?.kind).toBe('endpoint'); // 素材自证：起点真的压在三臂点上，否则八发都在别处
    const rows = [
      { x: 2000, y: 0 },
      { x: 0, y: 2000 },
      { x: -2000, y: 0 },
      { x: 0, y: -2000 },
      { x: 2000, y: 2000 },
      { x: -2000, y: 2000 },
      { x: 2000, y: -2000 },
      { x: -2000, y: -2000 },
    ].map((off) => {
      const endPx = pxOf(off, sv);
      const end = dropTargetOf(sv, endPx, startMm, fd, { excludeMm: startMm });
      const draft: DraftWall = { storeyId, start, cursorPx: endPx, end, legal: true };
      const command = legalWallCreate(doc, draft);
      let derived: boolean;
      try {
        const commandBuilt = draftCommand(draft, defaults);
        if (commandBuilt === null) throw new TypeError('legal 为真却拿不到命令');
        const trial = new TransactionLog(doc);
        trial.dispatch(commandBuilt);
        buildDrawList(trial.document, storeyId, sv);
        derived = true;
      } catch {
        derived = false;
      }
      return { mm: end.mm, command, derived };
    });
    for (const row of rows) expect(row.derived).toBe(row.command);
    // 四发斜线（过同一枚点的第三个方向）两层一起拒：这就是星形接头搬迁后的形状
    for (const row of rows.filter((r) => Math.abs(r.mm.x) === Math.abs(r.mm.y))) {
      expect(row.command).toBe(false);
    }
    // 判据不空转：八发里确实有放行的（四条轴向外侧），否则"同判"可以靠"全拒"糊过去
    expect(rows.filter((r) => r.command).length).toBeGreaterThan(0);
  });

  it('wallProbe 在空层给 null（不抛），有了靶子才给得出', () => {
    const { log, storeyId } = synthStorey();
    const emptyField = snapFieldOf(log.document, storeyId);
    const emptyOps = buildDrawList(log.document, storeyId, sv, EMPTY_SELECTION);
    expect(wallProbe(log.document, storeyId, emptyOps, sv)).toBeNull();
    // 素材自证：空表确实空 —— 否则"给 null"可以是任何实现的功劳
    expect(emptyField.points).toEqual([]);
    expect(emptyField.axes).toEqual([]);
    // 建一面墙后靶子出现了：证上一发红在"没有端点可吸"，不是红在视口或筛写反
    wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const afterOps = buildDrawList(log.document, storeyId, sv, EMPTY_SELECTION);
    expect(wallProbe(log.document, storeyId, afterOps, sv)).not.toBeNull();
  });

  it('属性：legal 与"真 build 会不会抛"逐字同口径（试跑不是第二套判据）', () => {
    const { log, storeyId, field: fd } = oneWall();
    const base = pressAtOrigin(fd, storeyId);
    const defaults = newWallDefaults(log.document, storeyId);
    const wallsBefore = log.document.byKind('wall').length;
    // 起点恒复用 (0,0) 那枚端点（`pressAtOrigin` 按在它上面），终点是草稿的 `end.mm`。
    // 这张手抄表只记命令层那两条守卫（产地是 `model/invariants.ts` 的 `assertWallShape`，`commands/wall.ts` 调的就是这一份）：
    //   ① 两端点量化后重合 ⇒ 零长墙；② `thicknessMm >= lengthMm` ⇒ 轮廓自相交。
    // 其余四道（墙厚/墙高为正、楼层存在、跨层复用点）在这份夹具上**结构性不可能**触发：
    // 240 与 3000 是常量、`storeyId` 就是刚建的那层、`field` 只收本层的点。
    // Task 7 把派生复核挂上 `wallCreate.build` 末尾之后，「star / 同向重叠 / 翻面」的拒绝**在这张
    // 表之外**（2026-09-29 裁决 D-1 实测：给表加第三项「同向重叠 = dy===0 && dx>0」后连跑 6 遍仍
    // 5 红 1 绿，反例是一批轴长 ≈241～250 的短斜墙，被派生复核判翻面）⇒ 这张表不可能也不需要
    // 覆盖派生层（覆盖它就得复述轮廓/miter 规则，正是计划一贯禁止的事）。于是**两个方向分开判**：
    //   表判 false ⇒ `legal` 必须 false 且 `draftCommand` 给 null（单向钉子，只由这张表说话）；
    //   表判 true ⇒ `legal` 与「真 `build` 会不会抛」逐字同色 —— 标题就是判据（A1 要的命题）。
    // 派生层的自有真相由 core 的 `derive-guard.test.ts` 钉，不在这里复述。
    expect(defaults).toEqual({ thicknessMm: 240, heightMm: 3000 });
    // 240 是**手抄的字面量**（不是从 `defaults` 读回来的）：默认墙厚改了，屏幕上"最短拉得出"
    // 这条产品口径得跟着想清楚，红在这儿比漂在真源里便宜。上面那句 `toEqual` 是这一发的素材自证。
    const expectLegal = (endMm: MoveTarget): boolean => {
      const dx = endMm.x - base.start.mm.x;
      const dy = endMm.y - base.start.mm.y;
      return !(dx === 0 && dy === 0) && 240 < Math.hypot(dx, dy);
    };
    fc.assert(
      fc.property(mmInt, mmInt, (x, y) => {
        const draft = moveDraft(log.document, base, sv, pxOf({ x, y }, sv), fd);
        if (!expectLegal(draft.end.mm)) {
          // 单向钉子（这一段**不读 `build`**，保住原注释担心的那颗牙）：表判 false 的候选，
          // `legal` 必须 false 且命令层不给命令。「摘掉 core 的 `assertWallShape` ⇒ 零长/厚度
          // 一起变恒真」那种失效会让下面两句先红 —— **2026-09-29 实测过这颗牙**：把 `assertWallShape`
          // 改成进门就 `return`，这一发红在下面第一句（反例 `(-1, 0)`：轴长 1mm 的墙过得了派生层
          // 那道复核，只有这道构造期守卫挡它），「三种拒绝各一色」那条同时红。
          expect(draft.legal).toBe(false);
          expect(draftCommand(draft, defaults)).toBeNull(); // 只有 legal 为假才许给 null
          return;
        }
        // 反向（表判 true 的候选）：`legal` 与「真 `build` 会不会抛」逐字同口径。
        // 手把 `legal` 置真取命令（`draftCommand` 只认 legal 一色），再问真 `build`。
        // 判的是**同一产地的两个消费者**：`legalWallCreate` 里的 `buildCreate` 与这里的 `draftCommand`
        // 拿同一份 doc、同一组入参构造同一条 `wallCreate` ⇒ 这一支**今天恒真**（`throws === !legal`
        // 是当前实现的恒等式），它钉的是那两处字段映射/默认值漂开时才红（`draftCommand` 还看了别的
        // 东西 ⇒ 下面那句 TypeError；legal 为真却拿不到命令 ⇒ 支尾的 TypeError）。
        // 别把它读成"摘掉派生复核会红在这里"：摘掉复核时两侧同时变合法，这一支照绿 —— 会红的是上面
        // 那半边（表判 false 的单向钉子）与 core 的 `derive-guard.test.ts`，不在这里。
        const probe = draftCommand({ ...draft, legal: true }, defaults);
        if (probe === null) throw new TypeError('legal 置真后拿不到命令（`draftCommand` 还看了别的？）');
        let throws = false;
        try {
          probe.build(log.document);
        } catch {
          throws = true;
        }
        expect(draft.legal).toBe(!throws);
        if (throws) return;
        const command = draftCommand(draft, defaults);
        if (command === null) throw new TypeError('legal 为真却拿不到命令');
        const fresh = new TransactionLog(log.document);
        expect(() => fresh.dispatch(command)).not.toThrow();
        expect(fresh.document.byKind('wall').length).toBe(wallsBefore + 1);
      }),
      { numRuns: 250 },
    );
  });
});
