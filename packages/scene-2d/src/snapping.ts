import {
  quantizeMm,
  requirePoint,
  wallAxisById,
  type Document,
  type PointRef,
  type Vec2,
} from '@dajia/core';
import { mmToPx, pxToMm, type Px, type Viewport } from './viewport';
import { PICK_TOL_PX } from './pick';

/**
 * 屏幕像素 → 真源整数毫米的**唯一**通路（Task 5 D4 预留的那一行在这里落地）。
 *
 * `MoveTarget` / `moveTargetOf` 原本住在 `handles.ts`，Task 6 把它们搬进来：吸附必须插在
 * "像素换算毫米"之后（D4），而换算与吸附分居两个文件就会长出第二条 px→mm 的路 ——
 * 那正是 D4 禁止的东西。搬完之后，全模块只有两个出口会把光标变成落点：
 * `moveTargetOf`（裸落点，只给临时线与探针的 raw 用）与 `dropTargetOf`（吸附后的落点，
 * 只给 dispatch 用）。
 */

/** 落在真源上的整数毫米。与 core 的 `Vec2` 结构相同，但语义是"已过 quantizeMm"。 */
export interface MoveTarget {
  readonly x: number;
  readonly y: number;
}

/**
 * 浮点毫米 → 整数毫米。`quantizeMm` 的 `Math.round(v) + 0` 顺手把 -0 归一成 +0，
 * 所以任何一对候选坐标比较之前都先过这里 —— 否则 `Object.is(-0, 0)` 为 false，
 * "正交档没动 y"会在锚点 y 恰为 0 时被判成动了。
 */
export function quantizeTarget(v: Vec2): MoveTarget {
  return { x: quantizeMm(v.x), y: quantizeMm(v.y) };
}

/**
 * 屏幕像素 → 真源整数毫米（D4）。非有限输入由 `quantizeMm` 直接抛 RangeError：
 * 指针事件的坐标恒为有限数，真出 NaN 说明上面有人算了个 0/0 —— 那种东西静默兜成 0
 * 就是"一拖就飞到原点"，比当场崩掉难查得多。调用方（PlanCanvas 的落点分支）整段包在
 * try/catch 里报 `lastError`。
 */
export function moveTargetOf(viewport: Viewport, cursorPx: Px): MoveTarget {
  return quantizeTarget(pxToMm(viewport, cursorPx));
}

/**
 * 吸附容差沿用命中容差：屏幕上"点得中一条线"与"吸得上一个点"必须是同一个手感，
 * 否则用户没法形成预期（`pick.ts` 顶部那段"毫米容差放大 k 倍就宽 k 倍"的理由在这里同样成立）。
 *
 * **代价**：极度缩小时 8px 换算是很大的毫米数，吸附会把整张图吃光 —— 那是 `pick` 本来就有的
 * 性质（缩小后什么都点得中），不是这里新引入的。
 */
export const SNAP_TOL_PX = PICK_TOL_PX;

/** 角度档（正交 / 15°）的角容差，单位是**度**。 */
export const ANGLE_TOL_DEG = 3;

/**
 * 吸附标记的第四色（S8）。它在闸门里只承担一句话："那一刻确实吸附了" —— `snapMarkPx` 数的是
 * 全画布上这个颜色的像素总数，判据 `> 0` / 两发比较，**位置一律走毫米对账**。
 * 为什么不给它一个位置窗口：按构造吸附点离光标不超过 `SNAP_TOL_PX`（8px），而 T5 那五个桶用的
 * 是 ±2px 窗口 —— 不存在任何一个窗口既能把标记点和别的像素分开、又不会在"标记真的跑到 8px 外"
 * 时红。硬写那种窗口就是假绿。
 */
export const SNAP_COLOR = '#ff8a00';

/**
 * 标记的**内圈**半尺寸（空心方环中间挖空的那一枚 5×5，见 `SNAP_MARK_OUTER_HALF_PX`）：
 * 与把手（`HANDLE_RADIUS_PX = 4.5`）同量级、不同尺寸，屏幕上两枚标记分得开。
 * 挖空不是装饰 —— T5 的第五桶在**光标** ±2px 窗口里数绿色临时线像素，而这枚标记会落在
 * 离光标 0.3px 的吸附点上；实心方块会把那 25 枚绿像素整个盖掉（实测 `previewNearCursorPx`
 * 25 → 5 → 0），空心环让窗口里一个橙像素都不进。
 */
export const SNAP_MARK_HALF_PX = 2.5;

/**
 * 标记的**外沿**半尺寸：橙色只占切比雪夫距离 `> SNAP_MARK_HALF_PX` 且 `<= 4.5`（9×9 减 5×5）
 * 那一圈环带，共恒 56 枚纯色像素。第四色桶 `snapMarkPx` 判的是 `> 0`（S8 只证存在），
 * 环带比实心块多出来的像素数不影响任何判据。
 */
export const SNAP_MARK_OUTER_HALF_PX = 4.5;

/** 五档吸附。前三种吸到**已有的东西**上，后两种吸到**方向**上。 */
export type SnapKind = 'endpoint' | 'midpoint' | 'foot' | 'ortho' | 'angle15';

/** 静态点表里出现的两种档：垂足与角度档的候选按光标现算，不可能预先列出（见 `SnapField`）。 */
export type SnapPointKind = 'endpoint' | 'midpoint';

/** 表里的一枚候选点。`ownerId` 只用于并列破序，不给语义。 */
export interface SnapPoint {
  readonly kind: SnapPointKind;
  readonly mm: MoveTarget;
  /** 端点才有：它是真源里那一枚点，`{ pointId }` 复用全靠这个值非 null。中点为 null。 */
  readonly pointId: string | null;
  readonly ownerId: string;
}

/** 一面墙的轴线：垂足档把它当"无限长直线里的一段"来投影。 */
export interface SnapAxis {
  readonly ownerId: string;
  /** 轴起点。整数毫米（`wallAxisById` 的 start 直接读自 `requirePoint`），这里只做形状转换。 */
  readonly startMm: MoveTarget;
  /** 单位向量 start→end（浮点，只用于投影，永不写回真源）。 */
  readonly dir: Vec2;
  readonly lengthMm: number;
}

/** 一层的吸附场。`fitStorey` 一次、拖动开始时取一次，`pointermove` 里只读不建。 */
export interface SnapField {
  readonly points: readonly SnapPoint[];
  readonly axes: readonly SnapAxis[];
}

/** 吸附结果。`distPx` 是**光标到吸附点**的像素距离，恒 ≤ `SNAP_TOL_PX`。 */
export interface SnapResult {
  readonly kind: SnapKind;
  readonly pointId: string | null;
  readonly mm: MoveTarget;
  readonly distPx: number;
}

/** 一发光标的完整答案：裸落点 + 吸附后的落点 + 命中的那一档（没吸到就是 null）。 */
export interface DropTarget {
  readonly raw: MoveTarget;
  readonly mm: MoveTarget;
  readonly snap: SnapResult | null;
}

export interface SnapOptions {
  /**
   * 排掉**这一对坐标**的所有候选（不是排掉 pointId）：拖一枚端点时，原地那枚点既是端点
   * 候选、又是它自己那条轴线上 t=0 的垂足候选，只按 id 排会漏掉垂足那一发 —— 表现是
   * "一松手墙没动"。
   */
  readonly excludeMm?: MoveTarget | null;
}

/** 只按角度档时用这一份：没有既有几何可吸，但仍然要正交 / 15°。 */
export const EMPTY_SNAP_FIELD: SnapField = { points: [], axes: [] };

/** 先分组（对象档永远压过方向档），组内先比距离，再比档位，最后比 ownerId。 */
const GROUP: Record<SnapKind, number> = { endpoint: 0, midpoint: 0, foot: 0, ortho: 1, angle15: 1 };
const PRIORITY: Record<SnapKind, number> = {
  endpoint: 0,
  midpoint: 1,
  foot: 2,
  ortho: 3,
  angle15: 4,
};

/**
 * **具名点吸收带**（px）：一枚垂足如果离某枚端点 / 中点不到这个像素数，它就不是"墙上的另一个点"，
 * 而是那一角、那一点本身 —— 于是它整发不进候选池，`takeBest` 只能看见具名点那一枚。
 *
 * 为什么要有这条（Task 8 撞出来的，不是预防性设计）：端点候选存的是真源整数毫米，`mmToPx` 出来带
 * 小数；垂足候选经 `footOf` 的 `quantizeTarget` 也落在整数毫米上。光标是"端点那一发取整像素"时，
 * 同一根轴上离角点 0.5~4.4mm 的垂足常常比角点自己还近零点几像素 —— 而 `takeBest` 先比 `distPx`
 * 才轮到 `PRIORITY`，档位表里「端点 < 中点 < 垂足」那条意图就被取整噪声吃掉了。屏幕上表现为
 * "按在墙角吸到角点旁一枚无名点"（`pointId = null`）⇒ 拉出的新墙不复用那枚点，接头悄悄断掉。
 *
 * 为什么是 1.5：垂足只可能靠取整噪声在 **< √2 ≈ 1.4142px** 的差距里赢（`intPx` 每轴各舍 0.5px，
 * 两轴合成 √2），1.5 是第一个盖住它的整齐值 —— 与 `--draw-shot` 的 D4 那条 `distPx ≤ 1.5` 同一把尺。
 * 阈值住在 px 而毫米数由 `pxPerMm` 折回来：判据是"屏幕上同一个位置"，写死毫米数一缩放就得重测。
 *
 * **代价**：角点旁一像素以内（本尺度约 13mm）的墙上点吸不到了。认了 —— 施工图纸上那一像素不构成
 * 另一个可命名的点，而吸错到它上面断掉的是接头。
 */
const FOOT_ABSORB_PX = 1.5;

/** 这枚垂足是否被池里某枚具名点（端点 / 中点）吸收。距离走毫米，容差由 `pxPerMm` 折回来。 */
function absorbedByPoint(mm: MoveTarget, points: readonly SnapPoint[], absorbMm: number): boolean {
  return points.some((p) => Math.hypot(p.mm.x - mm.x, p.mm.y - mm.y) <= absorbMm);
}

/**
 * 本层的端点（按 pointId 去重）+ 每面墙的中点 + 每面墙的轴线。
 *
 * 去重是必须的：样例房一层有六枚共享端点，不去重就是"同一个点六个候选、六个 ownerId"，
 * 并列破序会挑出任意一面墙，`pointId` 却全都一样 —— 结果对，过程没法测。
 * 柱/板的顶点、洞口中心不在表里：Task 9 的补档（柱端点、轴网交点）要加时改这里，不在 UI 侧另搭一份。
 */
export function snapFieldOf(doc: Document, storeyId: string): SnapField {
  const points: SnapPoint[] = [];
  const axes: SnapAxis[] = [];
  const seen = new Set<string>();
  for (const wall of doc.byKind('wall')) {
    // 别层的墙一枚靶子都不给：两层的坐标区间会重叠（上下层同位置），
    // 漏了这行就会把一层的落点吸到另一层的点上 —— `resolvePointRef` 那一句跨层抛错
    // 紧接着会把一发无害的吸附变成命令层异常。
    if (wall.storeyId !== storeyId) continue;
    // 零长墙在 `wallCreate` / `wallMoveEndpoint` 那两道正数定值闸外就已经进不来真源，
    // 所以 `wallAxisById` 的"两端点重合"抛错在这里不可达（真打进来就是真源坏了）。
    const axis = wallAxisById(doc, wall.id);
    axes.push({
      ownerId: wall.id,
      startMm: { x: axis.start.x, y: axis.start.y },
      dir: axis.dir,
      lengthMm: axis.lengthMm,
    });
    for (const pointId of [wall.startId, wall.endId]) {
      if (seen.has(pointId)) continue;
      seen.add(pointId);
      const point = requirePoint(doc, pointId, '吸附端点');
      points.push({
        kind: 'endpoint',
        // 直读真源，不做任何 px ↔ mm 往返：吸上去的坐标必须和点上存的逐字相同，
        // 否则"复用"会顺手把那枚点挪走零点几毫米。
        mm: { x: point.x, y: point.y },
        pointId,
        ownerId: wall.id,
      });
    }
    // 手写轴 start + dir·(L/2)：和 `SnapAxis` 用同一套浮点算法，中点与垂足不会漂出半个像素。
    const half = axis.lengthMm / 2;
    points.push({
      kind: 'midpoint',
      mm: quantizeTarget({ x: axis.start.x + axis.dir.x * half, y: axis.start.y + axis.dir.y * half }),
      pointId: null,
      ownerId: wall.id,
    });
  }
  return { points, axes };
}

/** 取最优的内部形状 = `SnapResult` + `ownerId`：并列破序要用，但它不属于对外的落点结论。 */
interface Scored {
  readonly kind: SnapKind;
  readonly pointId: string | null;
  readonly mm: MoveTarget;
  readonly ownerId: string;
  readonly distPx: number;
}

/** 候选生成器的返回：吸附点与档位，`distPx` 由 `consider` 现算。 */
interface Ranked {
  readonly kind: SnapKind;
  readonly pointId: string | null;
  readonly mm: MoveTarget;
  readonly ownerId: string;
}

/**
 * 取最优。三条不许商量的性质：
 * ① 非有限 `distPx` 一个都不许赢 —— NaN 比较恒 false，写成 `if (dist > tol) continue`
 *    会把第一条候选当成命中（T4 第 8 条、T5 `pickHandle` 那条同款病）；
 * ② 严格 `<` 才换，所以并列时留下的是**先扫到**的那一枚 —— 扫描序与输入数组的序无关性由
 *    "并列判据全序化（group → distPx → PRIORITY → ownerId）"保证，`ownerId` 是 uuidv7，
 *    `byKind` 又已按 id 升序，故同一次扫描里两枚并列候选的 ownerId 不可能相等；
 * ③ 越界（> SNAP_TOL_PX）在这里统一挡，五个候选生成器都不必各自判容差。
 */
function takeBest(best: Scored | null, cand: Scored | null): Scored | null {
  if (cand === null || !Number.isFinite(cand.distPx) || cand.distPx > SNAP_TOL_PX) return best;
  if (best === null) return cand;
  if (GROUP[cand.kind] !== GROUP[best.kind]) return GROUP[cand.kind] < GROUP[best.kind] ? cand : best;
  if (cand.distPx !== best.distPx) return cand.distPx < best.distPx ? cand : best;
  if (PRIORITY[cand.kind] !== PRIORITY[best.kind]) {
    return PRIORITY[cand.kind] < PRIORITY[best.kind] ? cand : best;
  }
  return cand.ownerId < best.ownerId ? cand : best;
}

/**
 * 光标 → 吸附结果。五档各造候选，`takeBest` 挑。
 *
 * `raw` 是**已经量化过**的裸落点（调用方给 `moveTargetOf` 的结果）：角度档要的是"光标在
 * 世界里的位置"，用它而不是再用一次 cursorPx，才能保证落点是像素的不动点 ——
 * 同一发光标问两次必须得同一个数，否则 `--edit-shot` 那句"松手落点逐字等于探针给的毫米"
 * 会随机红。
 *
 * `anchorMm` 为 null 时角度档整段不参与：拖洞口、拖把手以外的场合没有"从哪儿出发"这回事。
 */
export function snapFromCursor(
  viewport: Viewport,
  cursorPx: Px,
  raw: MoveTarget,
  anchorMm: MoveTarget | null,
  field: SnapField,
  opts: SnapOptions = {},
): SnapResult | null {
  const exclude = opts.excludeMm ?? null;
  // 五个档位先各造候选、合成一个池子，再统一排序：分开比五趟"谁更近"要把这条判据抄五遍，
  // 而漏抄的那一遍永远不会红（它只在两档同时命中的那一格才说话）。
  // 池子里留 null 是"这一档没命中"，不是"没有候选点" —— 过滤只发生在下面那一趟循环里。
  const pool: (Ranked | null)[] = [];
  for (const p of field.points) pool.push(p);
  // 垂足档先过一遍"具名点吸收带"（见 `FOOT_ABSORB_PX`）：与某一枚端点或中点在屏幕上同一位置的
  // 垂足不进池子，于是那一角那一档只剩具名点一枚候选，`takeBest` 的距离比较无从赢起。
  const absorbMm = FOOT_ABSORB_PX / viewport.pxPerMm;
  for (const axis of field.axes) {
    const foot = footOf(axis, raw);
    if (foot === null || absorbedByPoint(foot.mm, field.points, absorbMm)) continue;
    pool.push(foot);
  }
  if (anchorMm !== null) {
    // 一律走裸算术，不调 core 的 sub/scale/advance/add：那些助手每个返回值都把 -0 归一成
    // +0，但**输入参数**里的 -0 会原样参与乘法，`-0 * 0` 仍是 -0，最后 `anchor.x + (-0)`
    // 把 -0 带进落点。绕开它们，这条就不必存在第二份。
    const dx = raw.x - anchorMm.x;
    const dy = raw.y - anchorMm.y;
    // 落点与锚点重合 ⇒ 无方向。不调 normalize / atan2：前者抛"零向量无法归一化"，
    // 后者 atan2(0,0) = 0 ⇒ 会凭空造出一枚"水平正交"候选（『落点与锚点重合 ⇒ 无方向』那条钉的就是这条）。
    if (dx !== 0 || dy !== 0) {
      const theta = Math.atan2(dy, dx);
      pool.push(orthoOf(anchorMm, raw, theta));
      pool.push(angle15Of(anchorMm, theta, Math.hypot(dx, dy)));
    }
  }
  let best: Scored | null = null;
  for (const cand of pool) {
    if (cand === null) continue;
    if (exclude !== null && cand.mm.x === exclude.x && cand.mm.y === exclude.y) continue;
    const p = mmToPx(viewport, cand.mm);
    best = takeBest(best, {
      kind: cand.kind,
      pointId: cand.pointId,
      mm: cand.mm,
      ownerId: cand.ownerId,
      distPx: Math.hypot(cursorPx.x - p.x, cursorPx.y - p.y),
    });
  }
  if (best === null) return null;
  // 剥掉 ownerId：它只是并列判据，不是"吸到了谁"的结论（结论是 kind + mm + pointId）。
  return { kind: best.kind, pointId: best.pointId, mm: best.mm, distPx: best.distPx };
}

/**
 * 垂足：光标（量化后的 `raw`）到轴线那段**线段**的正投影。
 * `t` 的上下界不能省 —— 放开它就会吸到轴延长线上，画出一条"对着空气齐"的墙。
 * 投影长度不量化，所以端点判定比真正垂线的参数范围宽一整个 |Δraw|：光标离墙端 1mm 时
 * 仍可能给出一枚墙外垂足。那一枚离角点不到一像素，由 `FOOT_ABSORB_PX` 那道吸收带挡在候选池外
 * （旧注释在这儿写的是"永远被端点吸收，不补"—— 那件事当时并没有被实现，Task 8 把它撞红了）。
 */
function footOf(axis: SnapAxis, raw: MoveTarget): Ranked | null {
  const dx = raw.x - axis.startMm.x;
  const dy = raw.y - axis.startMm.y;
  const t = dx * axis.dir.x + dy * axis.dir.y;
  if (t < 0 || t > axis.lengthMm) return null;
  return {
    kind: 'foot',
    pointId: null,
    mm: quantizeTarget({ x: axis.startMm.x + axis.dir.x * t, y: axis.startMm.y + axis.dir.y * t }),
    ownerId: axis.ownerId,
  };
}

const DEG = 180 / Math.PI;
const QUADRANTS = [0, 90, 180, 270];

/** 偏离最近一条轴 ≤ ANGLE_TOL_DEG ⇒ 把那根坐标钉到锚点上（**保坐标**语义，S3）。 */
function orthoOf(
  anchor: MoveTarget,
  raw: MoveTarget,
  theta: number,
): Ranked | null {
  let best: { readonly deg: number; readonly q: number } | null = null;
  for (const q of QUADRANTS) {
    const d = Math.abs(((theta * DEG - q + 540) % 360) - 180);
    if (d <= ANGLE_TOL_DEG && (best === null || d < best.deg)) best = { deg: d, q };
  }
  if (best === null) return null;
  return {
    kind: 'ortho',
    pointId: null,
    // 横向保 y、纵向保 x：另一根坐标取自裸落点（不是光标），所以"保坐标"与"保距离旋转"
    // 在判据上分得开（角度档那一段里 1mm 位移的用例就是钉这条的）。
    mm: best.q % 180 === 0 ? { x: raw.x, y: anchor.y } : { x: anchor.x, y: raw.y },
    ownerId: 'ortho',
  };
}

/**
 * 偏离最近的 15° 倍数 ≤ ANGLE_TOL_DEG ⇒ 绕锚点**保距旋转**到那条射线上。
 * 90 的倍数整档让给正交（S3）：两档同时收轴方向会给出两个不同的点，而按距离算旋转那一发
 * 永远更近 —— 于是"画一条 4000 的水平墙"会得到 3997.8，屏幕上看不出来、真源里是一枚
 * 永远对不齐的坐标。
 */
function angle15Of(
  anchor: MoveTarget,
  theta: number,
  radius: number,
): Ranked | null {
  const deg = ((theta * DEG + 360) % 360);
  const n = Math.round(deg / 15);
  if (n % 6 === 0) return null; // 0 / ±90 / 180 / 270 ⇒ 正交档的地盘
  const target = n * 15;
  if (Math.abs(deg - target) > ANGLE_TOL_DEG) return null;
  const rad = (target * Math.PI) / 180;
  return {
    kind: 'angle15',
    pointId: null,
    mm: quantizeTarget({
      x: anchor.x + radius * Math.cos(rad),
      y: anchor.y + radius * Math.sin(rad),
    }),
    ownerId: 'angle15',
  };
}

/**
 * 一发光标的落点：`moveTargetOf` 之后紧接的一步，也是 dispatch 前最后一站。
 * 没吸到时 `mm` 就是 `raw`（同一次 `moveTargetOf` 的结果，不是再算一遍）。
 */
export function dropTargetOf(
  viewport: Viewport,
  cursorPx: Px,
  anchorMm: MoveTarget | null,
  field: SnapField,
  opts: SnapOptions = {},
): DropTarget {
  const raw = moveTargetOf(viewport, cursorPx);
  const snap = snapFromCursor(viewport, cursorPx, raw, anchorMm, field, opts);
  return { raw, mm: snap === null ? raw : snap.mm, snap };
}

/**
 * 落点 → 命令入参的端点。**吸到既有点就复用它**，否则才新建 —— 真源里存"两个坐标相同的点"
 * 永远合不上接头（`topology.ts` 顶部那句），所以这一句是拓扑闭合在屏幕侧的唯一出口。
 */
export function pointRefOf(mm: MoveTarget, snap: SnapResult | null): PointRef {
  if (snap !== null && snap.pointId !== null) return { pointId: snap.pointId };
  // 显式抄两个字段，不 return mm：PointRef 的字面量那一支只认 x/y，多带字段会被
  // `isExistingPoint` 的 `'pointId' in ref` 判据以外的地方读到。
  return { x: mm.x, y: mm.y };
}
