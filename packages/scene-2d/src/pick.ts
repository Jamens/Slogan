import { DRAW_LAYERS, type DrawLayer, type DrawOp } from './drawlist';
import type { Px, Viewport } from './viewport';

/**
 * 吸附半径，单位是**屏幕像素**。换算成毫米比较就做不到"放大时吸附不变松"：
 * 毫米容差钉的是世界尺寸，放大 k 倍它在屏幕上就宽 k 倍。
 */
export const PICK_TOL_PX = 8;

export interface PickHit {
  readonly ownerId: string;
  readonly layer: DrawLayer;
  readonly distancePx: number;
}

/** 给一次性回读用的靶子：一个必定命中 `ownerId` 的点，和一个必定什么都不命中的点。 */
export interface PickProbe {
  readonly ownerId: string;
  readonly clickPx: Px;
  readonly blankPx: Px;
}

function dist(a: Px, b: Px): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 点到线段。零长段必须退化到点距：不写这一句，`t` 的分母是 0 ⇒ `NaN`，
 * 而 `NaN <= tol` 是 false —— 一个退化的控制点会既"点不中"又把 NaN 带进排序。
 */
export function distanceToSegmentPx(p: Px, from: Px, to: Px): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, from);
  const t = ((p.x - from.x) * dx + (p.y - from.y) * dy) / len2;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return dist(p, { x: from.x + dx * clamped, y: from.y + dy * clamped });
}

/** 奇偶射线法。只在 `fill !== null` 时用到 —— 本计划的墙轮廓 fill 恒为 null，用不到它。 */
function insidePolygon(p: Px, pts: readonly Px[]): boolean {
  let odd = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > p.y !== b.y > p.y) {
      const xAt = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (p.x < xAt) odd = !odd;
    }
  }
  return odd;
}

/** 命中距离。null = 这条指令根本不可点。 */
function distanceOfOp(op: DrawOp, p: Px): number | null {
  switch (op.kind) {
    case 'text':
      // 注记不是构件：点它会往选中集塞一个 storeyId，而 T5/T6 的拖拽与删除只认构件。
      return null;
    case 'line':
      return distanceToSegmentPx(p, op.from, op.to);
    case 'polygon': {
      const n = op.pts.length;
      // 少于 2 点连一条边都凑不出来，屏幕上根本没有可见轮廓。
      // 本计划没有这种输入（轮廓一律四点），所以它不红任何用例 —— 是防御，不是判据。
      if (n < 2) return null;
      let d = Infinity;
      for (let i = 0; i < n; i++) {
        const a = op.pts[i]!;
        const b = op.pts[(i + 1) % n]!; // 取模：多边形是闭合环，回边也画了线
        d = Math.min(d, distanceToSegmentPx(p, a, b));
      }
      // fill 非 null ⇒ 内部真的涂了像素，点在里面就该命中（距离记 0：它比任何边都"更在这条指令上"）。
      if (op.fill !== null && insidePolygon(p, op.pts)) return 0;
      return d;
    }
  }
}

function rankOf(layer: DrawLayer): number {
  const i = DRAW_LAYERS.indexOf(layer);
  if (i < 0) throw new RangeError(`未知绘制层 ${layer}`);
  return i;
}

/** 层序先赢，同层近的赢。 */
function better(a: PickHit, b: PickHit): boolean {
  const ra = rankOf(a.layer);
  const rb = rankOf(b.layer);
  if (ra !== rb) return ra > rb;
  return a.distancePx < b.distancePx;
}

/**
 * 将 `point` 命中（≤ `tolPx`）的实体，按 R3 的口径排好序，**每个 owner 只出一条**。
 * 同一个 owner 常常有几条指令同时命中（墙轮廓 + 它的轴线 + 它的洞口断口），
 * 那是同一个实体，不是几个候选。
 */
export function pickAt(ops: readonly DrawOp[], point: Px, tolPx: number = PICK_TOL_PX): PickHit[] {
  // 入口守卫：NaN 与 tolPx 的一切比较都是 false，`d > tolPx` 兜不住它 —— 少了这三行，
  // NaN 点击点会命中"距离为 NaN"的第一条指令。
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return [];
  const byOwner = new Map<string, PickHit>();
  for (const op of ops) {
    const ownerId = op.ownerId;
    if (ownerId === null) continue;
    const d = distanceOfOp(op, point);
    if (d === null || d > tolPx) continue;
    const hit: PickHit = { ownerId, layer: op.pen.layer, distancePx: d };
    const current = byOwner.get(ownerId);
    if (current === undefined || better(hit, current)) byOwner.set(ownerId, hit);
  }
  // ownerId 升序收尾是必需的：去重后 owner 互不相同 ⇒ 它把排序变成全序，
  // 于是洗牌不改变结果（见那条属性）。少了它，`Array.sort` 的稳定性会让绘制顺序掺进答案。
  return [...byOwner.values()].sort((a, b) => {
    if (rankOf(a.layer) !== rankOf(b.layer)) return rankOf(b.layer) - rankOf(a.layer);
    if (a.distancePx !== b.distancePx) return a.distancePx - b.distancePx;
    return a.ownerId < b.ownerId ? -1 : a.ownerId > b.ownerId ? 1 : 0;
  });
}

/** 单击语义的入口：层序 + 距离选出的那一个，什么都没命中就是 null。 */
export function pickOne(ops: readonly DrawOp[], point: Px, tolPx: number = PICK_TOL_PX): PickHit | null {
  return pickAt(ops, point, tolPx)[0] ?? null;
}

function minDistanceToOps(ops: readonly DrawOp[], p: Px): number {
  let d = Infinity;
  for (const op of ops) {
    const dd = distanceOfOp(op, p);
    if (dd !== null && dd < d) d = dd;
  }
  return d;
}

function blankPoint(ops: readonly DrawOp[], v: Viewport): Px | null {
  const inset = PICK_TOL_PX + 2;
  const corners: Px[] = [
    { x: inset, y: inset },
    { x: v.widthPx - inset, y: inset },
    { x: inset, y: v.heightPx - inset },
    { x: v.widthPx - inset, y: v.heightPx - inset },
  ];
  let best: Px | null = null;
  let bestD = -Infinity;
  for (const c of corners) {
    const d = minDistanceToOps(ops, c);
    // 严格 >：四角同分时保留先出现的（左下角），洗牌与浮点都不改变结果
    if (d > bestD) {
      bestD = d;
      best = c;
    }
  }
  if (best === null || bestD <= PICK_TOL_PX) return null;
  return best;
}

/**
 * 候选点边长下限（= `PICK_TOL_PX * 8` = 64px）：太短的边，其中点四周挤着一堆相邻指令，
 * 唯一命中几乎不可能成立。
 *
 * 出口是必需的而不是顺手：`editing.ts` 的 `wallProbe` 要在**建墙之前**预言"这面墙建出来点得中吗"，
 * 而那个"点得中"就是这一条尺 —— 不在这里给出去，探针只能抄一份 64，抄的那一份最先漂。
 */
export const MIN_PICK_EDGE_PX = PICK_TOL_PX * 8;

/**
 * `ownerId` 的唯一命中候选点：按绘制序扫该 owner 的多边形指令，取第一条够长的边的中点，
 * 且要求 `pickAt` 在这一点恰好返回 1 条。找不到 ⇒ null。
 *
 * 抽成文件内私有只有一条理由：`probeTarget`（随便挑一个能用的靶子）与 `pickPxOf`（点名要某一个
 * 实体的靶子）必须吃同一把尺 —— 边长下限、唯一命中两条判据抄成两遍，漏抄的那一遍永远不红。
 */
function uniqueHitOf(ops: readonly DrawOp[], ownerId: string, minEdgePx: number): Px | null {
  for (const op of ops) {
    if (op.kind !== 'polygon' || op.ownerId !== ownerId) continue;
    const n = op.pts.length;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const a = op.pts[i]!;
      const b = op.pts[(i + 1) % n]!;
      if (dist(a, b) < minEdgePx) continue;
      const mid: Px = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // 多命中 = 这个点上"谁在上面"说不清，换下一条边，不猜。
      // hits.length === 1 时那条必然是本条指令自己（中点在它上面，距离 0），
      // 所以这里不再重复断言 ownerId —— 写了也没人能走到另一支，测试里由 probe 那两条钉。
      if (pickAt(ops, mid).length !== 1) continue;
      return mid;
    }
  }
  return null;
}

/**
 * 点名要某一个实体的可点像素 —— `probeTarget` 只能给"随便一面墙"，而 `--draw-shot` 的删除
 * 那一步要的是**刚新建的那一面**（撤销栈顶上恰好只有它时，删错墙也能绿，那是假绿）。
 * 边太短 / 每条边都被别的指令压住 / 该实体只有线和字（洞口、楼层注记）⇒ null，调用方当失败处理。
 */
export function pickPxOf(ops: readonly DrawOp[], ownerId: string): Px | null {
  return uniqueHitOf(ops, ownerId, MIN_PICK_EDGE_PX);
}

/**
 * 一次性回读用的靶子。两条规则都是为了让"点了没反应"这种失败藏不住：
 * ① 只接受 `pickAt` 恰好返回 1 条的候选点 —— 相邻墙共享斜切顶点，那附近的"选中谁"
 *    是 ownerId 升序给的巧合，不是判据；
 * ② 空白点从四角里挑离一切指令最远的，且必须比容差更远，否则整个返回 null
 *    （"点空白清空选中"这一步不许其实打中了东西）。
 * 图铺满画布时没有空白角 ⇒ null，调用方（`__dajiaDebug` 与 `--pick-shot`）把它当失败处理。
 */
export function probeTarget(ops: readonly DrawOp[], v: Viewport): PickProbe | null {
  const blank = blankPoint(ops, v);
  if (blank === null) return null;
  const minEdgePx = MIN_PICK_EDGE_PX;
  // owner 按**首次出现**的绘制序试，`tried` 让一面墙的轮廓与它的轴线只进一次。
  // 换抽之前这里是"逐条指令扫"；`buildDrawList` 按实体成组产出指令（一个 owner 的轮廓紧挨着
  // 它的轴线），所以两种写法给出的第一个靶子逐字相同。诚实说一句：`tried` 因此**不是判据**，
  // 只是省一遍重复扫描 —— 实测摘掉它（PK6）18 条全绿，别为它写用例，也别把它读成"排重规则"。
  const tried = new Set<string>();
  for (const op of ops) {
    const ownerId = op.ownerId;
    if (ownerId === null || op.kind !== 'polygon' || tried.has(ownerId)) continue;
    tried.add(ownerId);
    const clickPx = uniqueHitOf(ops, ownerId, minEdgePx);
    if (clickPx !== null) return { ownerId, clickPx, blankPx: blank };
  }
  return null;
}
