import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  Document,
  TransactionLog,
  advance,
  isExistingPoint,
  length,
  quantizeMm,
  requirePoint,
  resolvePointRef,
  storeyCreate,
  uuidv7,
  vec,
  wallAxisById,
  wallCreate,
  type PointRef,
  type WallEntity,
} from '@dajia/core';
import {
  ANGLE_TOL_DEG,
  EMPTY_SNAP_FIELD,
  PICK_TOL_PX,
  SNAP_TOL_PX,
  buildDrawList,
  demoHouse,
  draftAtPress,
  dropTargetOf,
  fitStorey,
  mmToPx,
  moveTargetOf,
  pointRefOf,
  snapFieldOf,
  snapFromCursor,
  viewportOf,
  wallProbe,
  type MoveTarget,
  type Px,
  type SnapField,
  type SnapResult,
  type Viewport,
} from '@dajia/scene-2d';

const house = demoHouse();
const view = fitStorey(house.doc, house.lowerStoreyId, 1200, 900, 60);
const field = snapFieldOf(house.doc, house.lowerStoreyId);
const lowerWalls = house.doc.byKind('wall').filter((w) => w.storeyId === house.lowerStoreyId);
const lowerPointIds = new Set(lowerWalls.flatMap((w) => [w.startId, w.endId]));

/** 整数毫米生成器：真源只收这个形状，属性不许拿浮点当输入。 */
const mmInt = fc.integer({ min: -20000, max: 20000 });

/**
 * 角度档专用的小视口：`pxPerMm` 取 0.05 ⇒ 8px 容差 = 160mm。样例房那一份 `fitStorey` 给的是
 * 0.125px/mm（8px = 64mm），在它上面构造"偏 2.5° 但离锚点 8000mm"那一发要算的舍入太多，
 * 红的时候分不清是角度档坏了还是像素上限坏了。角度档的用例一律在 `av` 上跑，靶子档的用例在 `view` 上跑。
 */
const av = viewportOf(1000, 800, { pxPerMm: 0.05, center: vec(1500, 1500) });

/** 光标就停在这对整数毫米的像素上：`snapFromCursor` 拿到的 raw 与 cursorPx 因此逐字自洽。 */
const pxOf = (mm: MoveTarget, v: Viewport): Px => mmToPx(v, vec(mm.x, mm.y));

/** 静态表里落在这一对坐标上的档位（排序后比，数组序不是判据）。 */
const kindsAt = (fd: SnapField, x: number, y: number): string[] =>
  fd.points
    .filter((p) => p.mm.x === x && p.mm.y === y)
    .map((p) => `${p.kind}`)
    .sort();

/** 把两个池子的扫描序整个倒过来：并列判据是全序的话，答案不许变。 */
const reversed = (fd: SnapField): SnapField => ({
  points: [...fd.points].reverse(),
  axes: [...fd.axes].reverse(),
});

/**
 * 量化留下的那一格：候选毫米是 `quantizeMm` 之后的整数，而真值在量化前每根坐标最多偏 0.5mm
 * ⇒ 垂直距离最多 0.71mm。判据用它当容差，红的时候说的是"`mm` 没接吸附的答案"，不是"浮点差了一点"。
 */
const QUANT_SLACK_MM = 0.75;

/**
 * 「这一对毫米是不是**这一档的候选**」—— 只按档位的几何定义判，入参一律来自 `field` 那张表与锚点，
 * **不调** `snapFromCursor` / `dropTargetOf`（拿结论证结论就是恒真）。
 * 五档各判各的：端点档复用真源那枚点 ⇒ 坐标与表里那条逐字相同；中点档同理；垂足档必须在某条轴线
 * **那一段**里；正交档**钉坐标**（某一根必须等于锚点那一根）；15° 档绕锚点**保距旋转**，
 * 于是落点到某条 15° 射线的垂距与半径差都只剩量化那一格。
 */
function isCandidateForSnap(
  fd: SnapField,
  anchor: MoveTarget,
  raw: MoveTarget,
  snap: SnapResult,
  mm: MoveTarget,
): boolean {
  switch (snap.kind) {
    case 'endpoint': {
      const hit = fd.points.find((p) => p.pointId === snap.pointId);
      return hit?.kind === 'endpoint' && hit.mm.x === mm.x && hit.mm.y === mm.y;
    }
    case 'midpoint':
      return fd.points.some((p) => p.kind === 'midpoint' && p.mm.x === mm.x && p.mm.y === mm.y);
    case 'foot':
      return fd.axes.some((a) => {
        const dx = mm.x - a.startMm.x;
        const dy = mm.y - a.startMm.y;
        const along = dx * a.dir.x + dy * a.dir.y;
        const across = Math.abs(dx * a.dir.y - dy * a.dir.x);
        return (
          across <= QUANT_SLACK_MM && along >= -QUANT_SLACK_MM && along <= a.lengthMm + QUANT_SLACK_MM
        );
      });
    case 'ortho':
      return mm.x === anchor.x || mm.y === anchor.y;
    case 'angle15': {
      const vx = mm.x - anchor.x;
      const vy = mm.y - anchor.y;
      const deg = (Math.atan2(vy, vx) * 180) / Math.PI;
      const n = Math.round((((deg + 360) % 360) / 15));
      if (n % 6 === 0) return false; // 0 / ±90 / 180 / 270 是正交档的地盘，不该出现在这一档
      const rad = (n * 15 * Math.PI) / 180;
      const across = Math.abs(vx * Math.sin(rad) - vy * Math.cos(rad));
      const radiusDelta = Math.abs(
        Math.hypot(vx, vy) - Math.hypot(raw.x - anchor.x, raw.y - anchor.y),
      );
      return across <= QUANT_SLACK_MM && radiusDelta <= QUANT_SLACK_MM;
    }
  }
}

/** 独立的一层（无墙），给角度档当"没有别的靶子"的对照组。 */
function synthStorey(): { log: TransactionLog; storeyId: string } {
  const projectId = uuidv7();
  const log = new TransactionLog(Document.create(projectId));
  log.dispatch(storeyCreate({ projectId, index: 0, elevationMm: 0, heightMm: 3000 }));
  let storeyId = '';
  for (const id of log.affected) {
    if (log.document.get(id)?.kind === 'storey') storeyId = id;
  }
  if (storeyId === '') throw new TypeError('affected 里没有新建的楼层');
  return { log, storeyId };
}

/**
 * 建一面墙并把实体取回来。**不许** `byKind('wall').at(-1)`（全局约束：uuidv7 同毫秒不单调），
 * 也不许拿入参里的坐标去 `doc.get` —— 字面坐标那一支的点 id 是命令内部新建的，外面根本拿不到。
 */
function wallAt(log: TransactionLog, storeyId: string, start: PointRef, end: PointRef): WallEntity {
  log.dispatch(wallCreate({ storeyId, start, end, thicknessMm: 240, heightMm: 3000 }));
  for (const id of log.affected) {
    const entity = log.document.get(id);
    if (entity?.kind === 'wall') return entity;
  }
  throw new TypeError('affected 里没有新建的墙');
}

/** 极坐标转整数毫米（度、y 朝上）。只用来**造测试输入**，判据一律不吃它。 */
function mmAtAngle(deg: number, radiusMm: number): MoveTarget {
  const rad = (deg * Math.PI) / 180;
  return { x: quantizeMm(Math.cos(rad) * radiusMm), y: quantizeMm(Math.sin(rad) * radiusMm) };
}

/** 一对毫米的绝对角度（度，[0,360)）。判"落在哪条射线上"用。 */
function degOf(mm: MoveTarget): number {
  const d = (Math.atan2(mm.y, mm.x) * 180) / Math.PI;
  return d < 0 ? d + 360 : d;
}

describe('吸附靶子表', () => {
  it('端点表 = 本层墙端点的去重集，坐标逐枚直读真源', () => {
    const eps = field.points.filter((t) => t.kind === 'endpoint');
    // 样例房一层八枚：四个角 + 拐角 (4000,0) + 中段 (4000,3000) + partWest 挪出来的 (800,3000) + partEast 外端 (7000,3000)
    expect(lowerPointIds.size).toBe(8);
    expect(eps).toHaveLength(8);
    // 去重：拐角 (4000,0) 被三面墙共享，只能有一条候选
    expect(new Set(eps.map((t) => t.pointId)).size).toBe(8);
    for (const t of eps) {
      expect(t.pointId).not.toBeNull();
      const point = requirePoint(house.doc, t.pointId as string, '端点');
      expect(t.mm).toEqual({ x: point.x, y: point.y }); // 整数毫米直读真源，不做任何 px ↔ mm 往返
      expect(Number.isInteger(t.mm.x) && Number.isInteger(t.mm.y)).toBe(true);
    }
  });

  it('中点每面墙一条，坐标是沿轴一半处的量化毫米，且 pointId 为 null', () => {
    const mids = field.points.filter((t) => t.kind === 'midpoint');
    expect(lowerWalls).toHaveLength(8);
    expect(mids).toHaveLength(8);
    for (const t of mids) {
      expect(t.pointId).toBeNull(); // 中点不是真源里的点：`{pointId}` 复用那一支对它无意义
      const axis = wallAxisById(house.doc, t.ownerId);
      const mid = advance(axis.start, axis.dir, axis.lengthMm / 2);
      expect(t.mm).toEqual({ x: quantizeMm(mid.x), y: quantizeMm(mid.y) });
    }
    // 样例房全是正交墙，中点必然正好是整数毫米 —— 这一句把"量化"与"直接抄浮点"在样例上区分开
    expect(mids.map((t) => t.mm)).toContainEqual({ x: 2000, y: 0 });
  });

  it('楼层过滤：二层的端点一枚都不许进一层的表', () => {
    const upper = snapFieldOf(house.doc, house.upperStoreyId);
    const upperIds = new Set(upper.points.filter((t) => t.kind === 'endpoint').map((t) => t.pointId));
    expect(upperIds.size).toBe(8); // 素材自证：二层自己有靶子，否则下面全部断言恒真
    expect(upper.axes).toHaveLength(8); // 轴线也按层筛：别层的轴当吸附轨道会让落点吸到另一层去
    for (const id of upperIds) {
      expect(lowerPointIds.has(id as string)).toBe(false);
    }
    for (const t of field.points) {
      // 反向对照（两个方向都判，摘掉层过滤才一定红）：一层的表里也不该有二层的点
      if (t.pointId === null) continue;
      expect(upperIds.has(t.pointId)).toBe(false);
    }
  });

  it('同一坐标既是端点又是中点：并列（各差 0px）时优先级赢，且洗牌不改变答案', () => {
    const { log, storeyId } = synthStorey();
    wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const b = wallAt(log, storeyId, { x: 2000, y: 0 }, { x: 6000, y: 0 });
    const f = snapFieldOf(log.document, storeyId);
    // 静态表只有两枚（端点 + 中点）；同坐标的两枚垂足是**按光标现算**的，所以表里不列
    // （『楼层过滤』那条的 axes 长度自证它们有来源）
    expect(kindsAt(f, 2000, 0)).toEqual(['endpoint', 'midpoint']);
    const cursor = mmToPx(view, vec(2000, 0));
    const first = snapFromCursor(view, cursor, { x: 2000, y: 0 }, null, f);
    expect(first?.kind).toBe('endpoint'); // 四发并列（各差 0px）⇒ 端点（0）赢中点（1）与两枚垂足（2）
    expect(first?.pointId).toBe(b.startId);
    expect(first?.distPx).toBeLessThan(1e-9);
    expect(snapFromCursor(view, cursor, { x: 2000, y: 0 }, null, reversed(f))).toEqual(first);
  });
});

describe('光标 → 吸附结果', () => {
  it('光标压在端点上：kind / pointId / mm 三样都对，落点就是真源那枚点', () => {
    const cursor = pxOf({ x: 8000, y: 6000 }, view); // 样例房东北角，一枚共享端点
    const snap = snapFromCursor(view, cursor, { x: 8000, y: 6000 }, null, field);
    expect(snap?.kind).toBe('endpoint');
    expect(snap?.pointId).not.toBeNull();
    expect(snap?.mm).toEqual({ x: 8000, y: 6000 });
    expect(snap?.distPx).toBeLessThanOrEqual(SNAP_TOL_PX);
  });

  it('容差边界含等于：差 8.000px 吸、差 8.5px 不吸（改成 < 时第一句红）', () => {
    const base = pxOf({ x: 0, y: 0 }, view); // 样例房西南角
    const toward = (dPx: number): Px => ({ x: base.x + dPx, y: base.y });
    // raw 恒写 {0,0}：容差判的是**光标到吸附点**的像素距离，与 raw 量化到哪儿无关
    expect(snapFromCursor(view, toward(SNAP_TOL_PX), { x: 0, y: 0 }, null, field)?.kind).toBe('endpoint');
    expect(snapFromCursor(view, toward(SNAP_TOL_PX + 0.5), { x: 0, y: 0 }, null, field)).toBeNull();
    // 8.000px 那一发本身就是 `<=` 与 `<` 的分界（hypot(8,0) 是二进制精确值，不靠浮点余量）
    expect(snapFromCursor(view, toward(SNAP_TOL_PX - 0.5), { x: 0, y: 0 }, null, field)?.kind).toBe('endpoint');
  });

  it('容差沿用 PICK_TOL_PX：屏幕上"点得中一条线"与"吸得上一个点"是同一个手感', () => {
    expect(SNAP_TOL_PX).toBe(PICK_TOL_PX);
  });

  it('垂足比端点近时距离赢，且同距的正交档把功劳让给对象档', () => {
    const { log, storeyId } = synthStorey();
    wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const v = viewportOf(1000, 800, { pxPerMm: 0.02, center: vec(2000, 0) }); // 8px = 400mm
    const list = snapFieldOf(log.document, storeyId);
    const raw = { x: 200, y: 8 };
    const snap = snapFromCursor(v, pxOf(raw, v), raw, null, list);
    // 端点 (0,0) 离光标 200.16mm = 4.0px（在容差内！），垂足 (200,0) 离 8mm = 0.16px
    // ⇒ 端点优先级更高（0 < 2），但垂足近 25 倍 —— 距离赢，落点必须回到轴上
    expect(snap?.kind).toBe('foot');
    expect(snap?.mm).toEqual({ x: 200, y: 0 });
    expect(snap?.pointId).toBeNull();
    // 素材自证：换成"只看优先级"的写法时它抓得到东西（端点确实在容差之内）
    const ep = list.points.find((t) => t.kind === 'endpoint' && t.mm.x === 0);
    expect(ep).toBeDefined();
    // 同一发再加锚点 (0,0)：偏 2.29° 在 ANGLE_TOL_DEG 之内 ⇒ 正交档给出**同一枚**落点，
    // 组判据必须把功劳记给对象档（否则 --draw-shot 的 snapKind 读数会随机在两种之间跳）
    const noAnchor = snapFromCursor(v, pxOf(raw, v), raw, null, list);
    const withAnchor = snapFromCursor(v, pxOf(raw, v), raw, { x: 0, y: 0 }, list);
    expect(noAnchor?.kind).toBe('foot');
    expect(withAnchor?.kind).toBe('foot');
    expect(withAnchor?.mm).toEqual({ x: 200, y: 0 });
    expect(withAnchor?.distPx).toBe(noAnchor?.distPx); // 同一发候选，锚点不许把距离改掉
  });

  it('超出容差 ⇒ null，且 dropTargetOf 原样给 raw', () => {
    const base = pxOf({ x: 0, y: 0 }, view);
    // 往西南**外**的对角方向走 9px：沿轴方向走会被垂足档接住（它离光标恒 ≤ 半像素），
    // 那不是容差判据能测的方向 —— 垂足候选又被 t 的上下界挡在墙外（见下一条）。
    const far: Px = { x: base.x - SNAP_TOL_PX - 1, y: base.y + SNAP_TOL_PX + 1 };
    const raw = moveTargetOf(view, far);
    expect(snapFromCursor(view, far, raw, null, field)).toBeNull();
    const drop = dropTargetOf(view, far, null, field);
    expect(drop.snap).toBeNull();
    expect(drop.mm).toEqual(raw);
    expect(drop.raw).toEqual(raw);
  });

  it('垂足：光标落在斜墙轴线外侧，吸到轴上且不越过墙端', () => {
    const { log, storeyId } = synthStorey();
    wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 4000 });
    const v = viewportOf(1000, 800, { pxPerMm: 0.1, center: vec(2000, 2000) });
    const list = snapFieldOf(log.document, storeyId);
    const raw = { x: 2000, y: 2050 };
    const snap = snapFromCursor(v, pxOf(raw, v), raw, null, list);
    // 4050/2 = 2025：垂足的精确解（斜率 1 的轴上它正好是坐标平均），量化后逐字钉得住
    expect(snap?.mm).toEqual({ x: 2025, y: 2025 });
    expect(snap?.kind).toBe('foot');
    expect(snap?.pointId).toBeNull();
    // 该墙的中点 (2000,2000) 离光标 50mm = 5px、垂足离 35.4mm = 3.5px ⇒ 这一发同时证了"距离赢"
    expect(snap?.distPx).toBeLessThan(5);
  });

  it('垂足不许越过墙端：光标落在轴延长线外侧 ⇒ 整档没有候选', () => {
    const { log, storeyId } = synthStorey();
    wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 4000 });
    const v = viewportOf(1000, 800, { pxPerMm: 0.1, center: vec(2000, 2000) });
    const list = snapFieldOf(log.document, storeyId);
    const raw = { x: 4100, y: 4100 };
    // 沿轴 t = 5798mm > 轴长 5656.9mm ⇒ 该墙的 foot 候选被 t 的上下界挡掉；
    // 最近的端点 (4000,4000) 离光标 14.1px > 8px ⇒ 什么都没有。摘掉 t 上界会吸出一枚"墙外垂足"。
    expect(snapFromCursor(v, pxOf(raw, v), raw, null, list)).toBeNull();
    // 素材自证：把 t 上界放开的实现会在这一发上给出 kind 'foot' 且落点在墙外 —— 轴长是 5656.9mm
    const axis = wallAxisById(log.document, list.points[0]!.ownerId);
    expect(axis.lengthMm).toBeLessThan(5700);
  });

  it('空层（本层没有墙）⇒ 表是空的，dropTargetOf 恒等', () => {
    const { log, storeyId } = synthStorey();
    const list = snapFieldOf(log.document, storeyId);
    expect(list.points).toEqual([]);
    expect(list.axes).toEqual([]);
    const cursor = { x: 400, y: 300 };
    const drop = dropTargetOf(view, cursor, null, list);
    expect(drop.mm).toEqual(moveTargetOf(view, cursor));
    expect(drop.snap).toBeNull();
  });

  it('NaN 光标抛 RangeError；NaN 像素一个候选都不许赢', () => {
    expect(() => dropTargetOf(view, { x: Number.NaN, y: 5 }, null, field)).toThrow(RangeError);
    // raw 有限、cursorPx 是 NaN ⇒ 所有 distPx 都是 NaN。写成 `if (dist > tol) continue` 时
    // NaN > tol 是 false ⇒ 第一条候选会被当成命中（T4 第 8 条、T5 pickHandle 那条同款病）。
    expect(snapFromCursor(view, { x: Number.NaN, y: Number.NaN }, { x: 0, y: 0 }, null, field)).toBeNull();
  });

  it('对象档永远压过方向档：端点在 0.7px、正交在 0.5px，赢的仍是端点', () => {
    const cursor = pxOf({ x: 0, y: 0 }, view);
    // 往屏幕左上各偏 0.5px ⇒ 裸落点 (-4, -4)：它在 southWest 与 west 两条轴的**墙外侧**
    // （t = -4 < 0），所以垂足档这一发给不出候选，场上只剩端点与正交两档。
    const off: Px = { x: cursor.x - 0.5, y: cursor.y + 0.5 };
    const raw = moveTargetOf(view, off);
    // 素材自证：裸落点确实不是 (0,0)，否则这条什么都没判
    expect(raw).not.toEqual({ x: 0, y: 0 });
    const drop = dropTargetOf(view, off, { x: 4000, y: 0 }, field);
    expect(drop.snap?.kind).toBe('endpoint');
    expect(drop.snap?.mm).toEqual({ x: 0, y: 0 }); // 端点（对象档）赢，不是正交的 (-4, 0)
    expect(drop.raw).toEqual(raw); // 但 raw 原样保留：预览线仍画到光标
  });

  it('并列判据到底只剩 ownerId：同档位、同距离、坐标不同的两枚候选，倒序扫描给同一个落点', () => {
    const { log, storeyId } = synthStorey();
    wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    wallAt(log, storeyId, { x: 0, y: 8 }, { x: 4000, y: 8 });
    // pxPerMm = 1 ⇒ 光标 (2000, 4) 到两条轴的中点各差 4px，且 `hypot(0, 4)` 是二进制精确值
    // —— 距离**逐位相等**，不是"近似相等"。这一格是 ownerId 那一级唯一的用武之地。
    const v = viewportOf(1000, 800, { pxPerMm: 1, center: vec(2000, 4) });
    const f = snapFieldOf(log.document, storeyId);
    const raw = { x: 2000, y: 4 };
    const cursor = mmToPx(v, vec(raw.x, raw.y));
    const first = snapFromCursor(v, cursor, raw, null, f);
    const flipped = snapFromCursor(v, cursor, raw, null, reversed(f));
    // 素材自证：赢的是并列两枚里的一枚，且真有一发命中（否则下面两句恒真）
    expect(first?.kind).toBe('midpoint'); // 中点（1）压过两枚垂足（2），同档位同距离 ⇒ 只剩 id
    expect(Math.abs((first?.distPx ?? 0) - 4)).toBeLessThan(0.01);
    expect([[2000, 0], [2000, 8]]).toContainEqual([first!.mm.x, first!.mm.y]);
    // 判据只许比"倒序前后相等"，**不许**钉死哪一枚赢：两面墙每次现建 uuidv7，谁小不一定。
    expect(flipped).toEqual(first);
  });
});

/**
 * Task 8 撞出来的那一发（控制位实测）：画布从 1427×865 变 1167×833 ⇒ `wallProbe` 筛① 的幸存者
 * 从 **2/8** 掉到 **0/8**，`--draw-shot` 直接死在第 0 步。旧尺寸那一份也不是"对"，只是运气好 ——
 * 判据押在视口相位上，正是这条缺陷的病根，所以用例一律**遍历**而不挑一枚。
 *
 * 机理：端点候选存真源的整数毫米（`mmToPx` 出来带小数），垂足候选经 `footOf` 的 `quantizeTarget`
 * 也落在整数毫米上；光标是"端点那一发取整像素"时，同一根轴上离角点 0.5~4.4mm 的垂足常常比角点
 * 自己还近零点几像素，而 `takeBest` 先比 `distPx` 才轮到 `PRIORITY` ⇒ 档位表里"端点 < 中点 < 垂足"
 * 这条意图被取整噪声吃掉。屏幕上表现为"按在墙角吸到角点旁一枚无名点"⇒ 接头悄悄断掉。
 */
const gateView = fitStorey(house.doc, house.lowerStoreyId, 1167, 833, 60);

/** 与 `wallProbe` 的 `startPx` 同一发像素（取整），不然测的就不是屏幕上那一发了。 */
const intPxOf = (mm: MoveTarget, v: Viewport): Px => {
  const p = mmToPx(v, vec(mm.x, mm.y));
  return { x: Math.round(p.x), y: Math.round(p.y) };
};

describe('具名点优先：垂足不许靠取整噪声赢掉角点与中点', () => {
  it('按在端点那一发像素上：逐枚端点都吸回自己（遍历，不挑一枚）', () => {
    const endpoints = field.points.filter((p) => p.kind === 'endpoint');
    // 素材自证：这一层确实有八枚去重端点（`snapFieldOf` 按 pointId 去重），零枚的话下面那个循环恒真
    expect(endpoints.length).toBe(8);
    for (const ep of endpoints) {
      const press = intPxOf(ep.mm, gateView);
      const d = draftAtPress(gateView, press, field);
      const at = `(${String(ep.mm.x)},${String(ep.mm.y)})`;
      expect(d.snap?.kind, `端点 ${at} 被吸成了 ${String(d.snap?.kind)}`).toBe('endpoint');
      expect(d.snap?.pointId, `端点 ${at} 没复用成自己`).toBe(ep.pointId);
      expect(d.snap?.mm).toEqual(ep.mm);
    }
  });

  it('中段垂足照吸：离两端与中点都远超一像素的落点仍然是 foot（不许过吸）', () => {
    // 南墙轴上 (0,1500)：离两端各 1500mm ≈ 171px、离该墙中点 (0,3000) 同样 171px，
    // 远超吸收带（1.5px ≈ 13mm）⇒ 它必须是墙上那个点，而不是被角点吸走。
    const raw: MoveTarget = { x: 0, y: 1500 };
    const d = dropTargetOf(gateView, intPxOf(raw, gateView), null, field);
    expect(d.snap?.kind).toBe('foot');
    expect(d.snap?.pointId).toBeNull();
  });

  it('按在中点那一发像素上：不被自己那根轴上的垂足赢掉（除非该处另有端点，那由端点接）', () => {
    const endpoints = field.points.filter((p) => p.kind === 'endpoint');
    const midpoints = field.points.filter((p) => p.kind === 'midpoint');
    expect(midpoints.length).toBeGreaterThan(0);
    let tested = 0;
    for (const mid of midpoints) {
      // 与某枚端点重合的中点（T 字头）由端点接走：那是档位表本来的顺序，不是本条判据要问的事
      if (endpoints.some((ep) => ep.mm.x === mid.mm.x && ep.mm.y === mid.mm.y)) continue;
      tested += 1;
      const d = draftAtPress(gateView, intPxOf(mid.mm, gateView), field);
      expect(d.snap?.kind, `中点 (${String(mid.mm.x)},${String(mid.mm.y)}) 被吸成了 ${String(d.snap?.kind)}`).toBe('midpoint');
      expect(d.snap?.mm).toEqual(mid.mm);
    }
    // 素材自证：这一层至少有一枚"不与端点重合的中点"，否则上面那个循环恒真
    expect(tested).toBeGreaterThan(0);
  });

  it('闸门前置条件：这一份 1167×833 视口下 `wallProbe` 给得出靶子，起点是真源端点', () => {
    const probe = wallProbe(house.doc, house.lowerStoreyId, buildDrawList(house.doc, house.lowerStoreyId, gateView), gateView);
    expect(probe).not.toBeNull();
    const start = field.points.find(
      (p) => p.kind === 'endpoint' && p.mm.x === probe?.startMm.x && p.mm.y === probe?.startMm.y,
    );
    expect(start?.pointId).toBe(probe?.startPointId);
  });
});

describe('角度档：15° 与正交', () => {
  it('正交走"保坐标"语义：横向吸 y、纵向吸 x，落点是逐字整数', () => {
    const anchor = { x: 0, y: 0 };
    const horiz = snapFromCursor(av, pxOf({ x: 3000, y: 60 }, av), { x: 3000, y: 60 }, anchor, EMPTY_SNAP_FIELD);
    // 旋转保距语义会给 (3001, 0)（半径 3000.6 转平后 x 变 3000.6）：差 1mm 就红，两种语义彻底分得开
    expect(horiz?.kind).toBe('ortho');
    expect(horiz?.pointId).toBeNull();
    expect(horiz?.mm).toEqual({ x: 3000, y: 0 });
    expect(Math.abs((horiz?.distPx ?? 0) - 3)).toBeLessThan(0.01);
    const vert = snapFromCursor(av, pxOf({ x: 60, y: 3000 }, av), { x: 60, y: 3000 }, anchor, EMPTY_SNAP_FIELD);
    expect(vert?.mm).toEqual({ x: 0, y: 3000 }); // 纵向保 y：x 归到锚点的 x
  });

  it('15° 走"保距旋转"语义：落在 45° 射线上、半径不变、位移在容差之内', () => {
    const anchor = { x: 0, y: 0 };
    const raw = { x: 1000, y: 1035 }; // 45.98°：离 45° 只 0.98°，离最近的轴还 44°
    const snap = snapFromCursor(av, pxOf(raw, av), raw, anchor, EMPTY_SNAP_FIELD);
    expect(snap?.kind).toBe('angle15');
    expect(snap?.pointId).toBeNull();
    // 旋转语义给的是浮点半径上的量化值 ⇒ 钉性质不钉字面量（正交那一发是整数，才许钉字面量）
    expect(Math.abs(degOf(snap!.mm) - 45)).toBeLessThan(0.05);
    const radiusMm = length(vec(snap!.mm.x, snap!.mm.y));
    expect(Math.abs(radiusMm - length(vec(raw.x, raw.y)))).toBeLessThan(1.5);
    expect(snap!.distPx).toBeLessThanOrEqual(SNAP_TOL_PX);
  });

  it('档位互斥：离 45° 2.9° 给 angle15，离轴 2.3° 给 ortho，90 的倍数不属于 15° 档', () => {
    const near45 = snapFromCursor(
      av,
      pxOf({ x: 904, y: 1000 }, av),
      { x: 904, y: 1000 },
      { x: 0, y: 0 },
      EMPTY_SNAP_FIELD,
    );
    expect(near45?.kind).toBe('angle15');
    const nearAxis = snapFromCursor(
      av,
      pxOf({ x: 3000, y: 124 }, av),
      { x: 3000, y: 124 },
      { x: 0, y: 0 },
      EMPTY_SNAP_FIELD,
    );
    // 素材自证：它同时落在两条 15° 线的 3° 楔形里 —— 45° 那一发差 2.63°，比正交的 2.38° 还近
    expect(degOf({ x: 3000, y: 124 }) - 0).toBeGreaterThan(2.3);
    expect(45 - degOf({ x: 3000, y: 124 })).toBeGreaterThan(2.6);
    // S3 的牙齿：若 15° 档也收 90 的倍数，这一发会被"旋转保距"抢先（它位移更小），落点就不是整数 0
    expect(nearAxis?.kind).toBe('ortho');
    expect(nearAxis?.mm).toEqual({ x: 3000, y: 0 });
  });

  it('角度容差是 ANGLE_TOL_DEG：偏 2.90° 吸、偏 3.18° 不吸（两侧各留 0.1° 余量，不赌浮点边界）', () => {
    const anchor = { x: 0, y: 0 };
    const inside = mmAtAngle(47.9, 1350);
    const outside = mmAtAngle(48.2, 1350);
    expect(degOf(inside) - 45).toBeGreaterThan(2.8); // 素材自证：真的在容差内侧
    expect(degOf(outside) - 45).toBeGreaterThan(3.1); // 素材自证：真的越过了容差
    expect(snapFromCursor(av, pxOf(inside, av), inside, anchor, EMPTY_SNAP_FIELD)?.kind).toBe('angle15');
    // 外侧那一发的半径只 1350mm ⇒ 45° 候选离光标约 75mm = 3.8px，**在像素容差之内**：
    // 所以它被拒只能是角度判据干的，这条用例因此测的是 ANGLE_TOL_DEG 而不是 S1 的上限。
    expect(snapFromCursor(av, pxOf(outside, av), outside, anchor, EMPTY_SNAP_FIELD)).toBeNull();
    expect(ANGLE_TOL_DEG).toBe(3);
  });

  it('角度档也受 SNAP_TOL_PX 上限：同是偏 2.5°，半径 8000mm 不吸、2000mm 吸', () => {
    const anchor = { x: 0, y: 0 };
    const far = mmAtAngle(32.5, 8000); // 离 30° 差 2.502°（在 3° 之内），但楔形张开 349mm = 17.5px
    expect(snapFromCursor(av, pxOf(far, av), far, anchor, EMPTY_SNAP_FIELD)).toBeNull();
    const near = mmAtAngle(32.5, 2000); // 同一个角度、同一个档位：位移只有 87mm = 4.4px
    expect(snapFromCursor(av, pxOf(near, av), near, anchor, EMPTY_SNAP_FIELD)?.kind).toBe('angle15');
    // 这一对把"上限"与"角度判据"分开了：只有半径变、角度不变 ⇒ 红的只能怪上限
    expect(degOf(far) - 30).toBeGreaterThan(2.4);
    expect(degOf(near) - 30).toBeGreaterThan(2.4);
  });

  it('落点与锚点重合 ⇒ 无方向，角度档不给候选也不抛', () => {
    const anchor = { x: 1000, y: 2000 };
    expect(snapFromCursor(av, pxOf(anchor, av), anchor, anchor, EMPTY_SNAP_FIELD)).toBeNull();
  });

  it('1mm 的极短位移：正交档照给，落点就是那 1mm，且不许漏出 -0', () => {
    const anchor = { x: 0, y: 0 };
    const snap = snapFromCursor(av, pxOf({ x: 1, y: 0 }, av), { x: 1, y: 0 }, anchor, EMPTY_SNAP_FIELD);
    expect(snap?.kind).toBe('ortho');
    expect(snap?.mm).toEqual({ x: 1, y: 0 });
    // `anchor.y - 0` 与 `-0` 在 Object.is 下不等，而 mmToPx 会把它带进屏幕（vec.ts 的 ±0 纪律）
    expect(Object.is(snap?.mm.y, -0)).toBe(false);
  });

  it('anchorMm 为 null ⇒ 只有靶子档，画墙以外的场合不许被角度档牵走', () => {
    const raw = { x: 3000, y: 60 };
    expect(snapFromCursor(av, pxOf(raw, av), raw, null, EMPTY_SNAP_FIELD)).toBeNull();
  });
});

describe('落点出口与复用引用', () => {
  it('dropTargetOf 是 moveTargetOf 之后的同一发：连问两次逐字节相同，落点是像素的不动点', () => {
    const cursor = pxOf({ x: 0, y: 0 }, view); // 样例房西南角：端点 + 两条轴的垂足同时在这里
    const first = dropTargetOf(view, cursor, { x: 8000, y: 6000 }, field);
    expect(first.raw).toEqual(moveTargetOf(view, cursor));
    expect(first.mm).toEqual({ x: 0, y: 0 });
    expect(first.snap?.kind).toBe('endpoint'); // 三发并列（各差 0px）⇒ 优先级只在这一刻说话
    expect(dropTargetOf(view, cursor, { x: 8000, y: 6000 }, field)).toEqual(first);
    // 不动点：吸附点再过一次 `moveTargetOf` 不许漂（S4 与 --edit-shot「落点逐字相等」的地基）
    expect(moveTargetOf(view, mmToPx(view, vec(first.mm.x, first.mm.y)))).toEqual(first.mm);
  });

  it('拖端点时排掉"原地那一枚"：不排除会吸回自己，排除后这一发什么都没有', () => {
    const { log, storeyId } = synthStorey();
    const w = wallAt(log, storeyId, { x: 0, y: 0 }, { x: 4000, y: 0 });
    const list = snapFieldOf(log.document, storeyId);
    const raw = { x: 0, y: 0 };
    const cursor = pxOf(raw, view);
    // 不排除：端点与该墙起点处的垂足全部重合在原地 ⇒ 拖不动（屏幕上表现为一松手墙没动）
    expect(snapFromCursor(view, cursor, raw, { x: 4000, y: 0 }, list)?.kind).toBe('endpoint');
    // 排除的是**坐标**而不是 pointId：那一枚点是端点、又是它自己轴线的 t=0 垂足，还正好在
    // 锚点 (4000,0) 往回的水平射线上 —— 只按 id 排除会漏掉后两发。
    expect(snapFromCursor(view, cursor, raw, { x: 4000, y: 0 }, list, { excludeMm: raw })).toBeNull();
    expect(w.startId).not.toBe('');
  });

  it('属性：任意光标下落点恒为整数毫米、离光标不超过 SNAP_TOL_PX，非端点档不给 pointId', () => {
    let snapped = 0; // 素材自证：400 发里必须真的走过"吸上了"那一支，否则下面的候选判据是空转
    fc.assert(
      fc.property(
        fc.record({
          x: mmInt,
          y: mmInt,
          dx: fc.double({ min: -20, max: 20, noNaN: true }),
          dy: fc.double({ min: -20, max: 20, noNaN: true }),
        }),
        ({ x, y, dx, dy }) => {
          const base = pxOf({ x, y }, view);
          const cursor = { x: base.x + dx, y: base.y + dy };
          const drop = dropTargetOf(view, cursor, { x: 0, y: 0 }, field);
          expect(Number.isInteger(drop.mm.x) && Number.isInteger(drop.mm.y)).toBe(true);
          if (drop.snap !== null) {
            snapped += 1;
            expect(drop.snap.distPx).toBeLessThanOrEqual(SNAP_TOL_PX);
            if (drop.snap.kind !== 'endpoint') expect(drop.snap.pointId).toBeNull();
            // 吸上了 ⇒ 落点必须是**这一档的候选**（判据只吃 `field` 那张表与锚点，见上面那条注）。
            // 旧写法 `expect(drop.mm).toEqual(drop.snap.mm)` 是 `dropTargetOf` 里那句
            // `mm: snap.mm` 的同义反复：把 `mm` 改回裸落点（吸了等于没吸）它也不红。
            expect(isCandidateForSnap(field, { x: 0, y: 0 }, drop.raw, drop.snap, drop.mm)).toBe(true);
          } else {
            // 没吸上 ⇒ 落点必须是**这一发光标的量化值**，由测试自己重问一遍 `moveTargetOf`
            // （`handles.test.ts` 那句恒等式的同一写法：同一个纯函数、同一对入参，破的是接线 ——
            // 这里红的是"`dropTargetOf` 的 `mm`/`raw` 没走光标那一发的量化"，不是"两边写了同一句"）。
            expect(drop.mm).toEqual(moveTargetOf(view, cursor));
          }
        },
      ),
      { numRuns: 400 },
    );
    expect(snapped).toBeGreaterThan(0);
  });

  it('pointRefOf 只认 `pointId` 非 null 那一支：吸到中点也必须新建点', () => {
    const mid: SnapResult = { kind: 'midpoint', pointId: null, mm: { x: 2000, y: 0 }, distPx: 0 };
    const ref = pointRefOf(mid.mm, mid);
    expect(ref).toEqual({ x: 2000, y: 0 });
    expect(isExistingPoint(ref)).toBe(false);
    // 素材自证：`snap !== null` 不是复用判据，`snap.pointId !== null` 才是。放宽一个字面量，
    // 上面两句同时红 —— 而命令层拿到的是 `{ pointId: null }`，`resolvePointRef` 当场抛。
    expect(pointRefOf(mid.mm, { ...mid, pointId: lowerWalls[0]!.startId })).toEqual({
      pointId: lowerWalls[0]!.startId,
    });
  });

  it('属性：pointRefOf 与 resolvePointRef 同一口径 —— 吸到既有点就复用它，否则才新建', () => {
    const existingId = lowerWalls[0]!.startId;
    fc.assert(
      fc.property(fc.record({ x: mmInt, y: mmInt, reuse: fc.boolean() }), ({ x, y, reuse }) => {
        const snap: SnapResult | null = reuse
          ? { kind: 'endpoint', pointId: existingId, mm: { x, y }, distPx: 0 }
          : null;
        const ref = pointRefOf({ x, y }, snap);
        if (snap === null) {
          expect(isExistingPoint(ref)).toBe(false);
          expect(ref).toEqual({ x, y });
          // 字面量那一支：resolvePointRef 必返 null，命令层才会真的新建点
          expect(resolvePointRef(house.doc, ref, house.lowerStoreyId)).toBeNull();
          return;
        }
        expect(isExistingPoint(ref)).toBe(true);
        expect(ref).toEqual({ pointId: existingId });
        // 复用那一支必须真能被真源解析回来：解析不到就是"屏幕上以为复用了，真源里另建了一枚点"
        expect(resolvePointRef(house.doc, ref, house.lowerStoreyId)?.id).toBe(existingId);
      }),
      { numRuns: 200 },
    );
  });
});
