import {
  applyPatch,
  deriveStoreyGeometry,
  endPointId,
  incidentWallEnds,
  quantizeMm,
  requirePoint,
  wallAxisById,
  wallMoveEndpoint,
  type Document,
  type WallEnd,
} from '@dajia/core';
import { mmToPx, pxToMm, type Px, type Viewport } from './viewport';
import type { DrawOp, Selection } from './drawlist';
import { PICK_TOL_PX, pickOne } from './pick';

/**
 * 编辑器画在屏幕上、却**不进指令表**的那一层（Task 5 D2）：把手、拖拽临时线、
 * 以及"这个落点拖不拖得动"的预言。
 *
 * 为什么不进 `buildDrawList`：那张表是**图纸内容的投影** —— 计划 4 的像素判据与计划 5 的
 * 可施工图都直接吃它，把蓝点掺进去等于往施工图上印编辑器家具，而"指令表还是 31 条"
 * 这类回归判据恰好看不见多印了什么。代价是这个文件外面要再多两个画家（PlanCanvas 的
 * `paintHandles` / `paintPreview`），"只有一条绘制通路"这条纪律改由像素计数来守（Step 5/6）。
 */

/**
 * 三种颜色给 `countPixels` 认道：选中（红）、把手（蓝）、临时线（绿）。
 * 两两最大通道差必须 > 2×`PIXEL_CHANNEL_TOL`（`handles.test.ts` 最后一条钉死）：
 * 认色是按通道 ±TOL 开窗的，两种颜色挨太近时同一片像素会同时进两个桶，
 * Step 6 的 `handlePx` / `previewPx` 就全是假绿。#1668dc 与 #12b886 的差只在 G/B 上
 * （104↔184、220↔134，最大 86 > 80），挨得不远 —— 所以改任何一个字面量都要回去跑那条。
 */
export const HANDLE_COLOR = '#1668dc';
export const PREVIEW_COLOR = '#12b886';
export const PIXEL_CHANNEL_TOL = 40;
export const HANDLE_RADIUS_PX = 4.5;

/** 落在真源上的整数毫米。与 core 的 `Vec2` 结构相同，但语义是"已过 quantizeMm"。 */
export interface MoveTarget {
  readonly x: number;
  readonly y: number;
}

/**
 * 屏幕像素 → 真源整数毫米的唯一出口（D4）。T6 的吸附（端点/中点/15°）插在它**之后**、
 * `dispatch` 之前，不许有第二条 px→mm 的路绕过这里。
 *
 * 非有限输入（NaN / ±Infinity）由 `quantizeMm` 直接抛 RangeError：指针事件的坐标恒为有限数，
 * 真出 NaN 说明上面有人算了个 0/0 —— 那种东西静默兜成 0 就是"一拖就飞到原点"，
 * 比当场崩掉难查得多。调用方（PlanCanvas 的落点分支）整段包在 try/catch 里报 `lastError`。
 */
export function moveTargetOf(v: Viewport, cursorPx: Px): MoveTarget {
  const mm = pxToMm(v, cursorPx);
  return { x: quantizeMm(mm.x), y: quantizeMm(mm.y) };
}

/** 一枚可拖把手：`end` 与 `pointId` 配对钉死（计划 1 的角色反转 bug 就是这个配对松开过）。 */
export interface DragHandle {
  readonly wallId: string;
  readonly end: WallEnd;
  readonly pointId: string;
  /** 真源里那对整数毫米，直读实体，不做任何 px ↔ mm 往返。 */
  readonly atMm: MoveTarget;
  /** 它在线上的哪一端：与 `wallAxisById` 同源，所以和墙多边形永远对齐。 */
  readonly atPx: Px;
  /** 另一端：拖到这里必然'零长墙'，压扁拖的回读判据要的就是这个值。 */
  readonly anchorPx: Px;
}

/** 排序键：代码单元序，和 `Array.prototype.sort()` 默认序一致（测试拿它当定义比）。
 *  绝不用 `localeCompare` —— 它对 `-` 与数字的排序规则跟代码单元序不同，两边会各排各的。 */
function handleKey(h: DragHandle): string {
  return `${h.wallId}:${h.end}`;
}

const WALL_ENDS: readonly WallEnd[] = ['start', 'end'];

/**
 * 把手只从**当前选中集**里生（D5）：入参 `sel` 就是 paint effect 刚拿去上色的那份 `ids`，
 * 于是"屏幕上红着的"与"屏幕上能拖的"不可能是两批构件。
 * 返回顺序只服务一件事：确定性（同文档同选中集 ⇒ 同数组），不给 `start` 排前面这种语义。
 */
export function dragHandlesOf(
  doc: Document,
  storeyId: string,
  sel: Selection,
  v: Viewport,
): DragHandle[] {
  const out: DragHandle[] = [];
  for (const id of sel.ids) {
    const wall = doc.get(id);
    // 三种"不是本层墙"的 id（洞口的、楼层的、已经不存在的）一律跳过，不抛：
    // 选中集来自点选，而那枚构件可能在两次渲染之间被撤销掉 —— 抛出去就是白屏。
    if (wall?.kind !== 'wall') continue;
    // 别层的墙不给把手：两层各自建面点，跨层拖一发就是拿一层的坐标去改另一层的点
    // （`wallCreate` 的 resolvePointRef 明确禁止跨层复用点，这里不能给 UI 开后门）。
    if (wall.storeyId !== storeyId) continue;
    const axis = wallAxisById(doc, wall.id);
    for (const end of WALL_ENDS) {
      const pointId = endPointId(wall, end);
      const point = requirePoint(doc, pointId, '墙端点');
      out.push({
        wallId: wall.id,
        end,
        pointId,
        // atMm 直读实体、atPx 走轴线：两个产地同一个数字，用例分别钉（H1）。
        // 只从轴取 atMm 的话，"轴算错了"和"点被人改了"会红在同一条断言上。
        atMm: { x: point.x, y: point.y },
        atPx: mmToPx(v, end === 'start' ? axis.start : axis.end),
        anchorPx: mmToPx(v, end === 'start' ? axis.end : axis.start),
      });
    }
  }
  return out.sort((a, b) => {
    const ka = handleKey(a);
    const kb = handleKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * 命中把手：排在 `pickOne` **之前**的独立一趟（D2 说的"比层序更强"就是这里）。
 * 容差沿用 `PICK_TOL_PX`：屏幕上"点得中一条线"与"点得中一个点"该是同一个手感。
 *
 * 不要求入参已排序：并列时按 `handleKey` 升序取第一个，所以结果只由把手集合决定，
 * 不由谁先塞进数组决定（H6 的"洗牌再问一次"靠这句成立）。
 * 循环里是 `!(dist <= tolPx)` 而不是 `if (dist > tolPx) continue` —— 后者会让 NaN 混进命中。
 */
export function pickHandle(
  handles: readonly DragHandle[],
  point: Px,
  tolPx: number = PICK_TOL_PX,
): DragHandle | null {
  let best: DragHandle | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  let bestKey = '';
  for (const h of handles) {
    const dist = Math.hypot(h.atPx.x - point.x, h.atPx.y - point.y);
    if (!(dist <= tolPx)) continue;
    const key = handleKey(h);
    if (best === null || dist < bestDist || (dist === bestDist && key < bestKey)) {
      best = h;
      bestDist = dist;
      bestKey = key;
    }
  }
  return best;
}

/**
 * "这一发拖得动吗" = 拿真命令试跑一次（D3）。绝不在屏幕上重写一遍轴长比较：
 * `wallMoveEndpoint` 的守卫有六道（本墙零长、本墙墙厚、每面邻墙零长、每面邻墙墙厚、
 * 墙缩短后洞口放不下、重影柱），少抄一道就是"看着能拖、松手才报错"。第三条用例专门
 * 挑"本墙合格、邻墙被拖成零长"那种落点 —— 自己算的写法唯一会漏的就是它。
 *
 * 试跑安全的前提（读过源码才敢这么写）：`build` 是纯函数 —— 不新建实体（这个命令里一个
 * `uuidv7` 都没有）、不改文档、同一入参两次调用结果逐字节相同。
 * `catch` 宽到一切异常是有意的：连墙 id 打错这种 TypeError 也只有一种回答 —— 不能拖。
 */
export function legalDrop(
  doc: Document,
  wallId: string,
  end: WallEnd,
  target: MoveTarget,
): boolean {
  try {
    wallMoveEndpoint({ wallId, end, x: target.x, y: target.y }).build(doc);
    return true;
  } catch {
    return false;
  }
}

/**
 * 命令批准 ≠ 屏幕画得出。`wallMoveEndpoint` 的六道守卫管的是轴（零长、墙厚、邻墙、洞口、重影柱），
 * 而 star —— 三面墙在同一点、三个方向 —— 过得了那六道，过不了计划 2 的接头分类：
 * `deriveStoreyGeometry` 抛 RangeError，renderer 每次 paint 都跑派生，于是这一发落下去是白屏。
 * 判据问真派生，不在这里重写接头分类：派生的规则改了，这条自己跟着改。
 */
function derivesAfterMove(
  doc: Document,
  wallId: string,
  end: WallEnd,
  target: MoveTarget,
  storeyId: string,
): boolean {
  try {
    const patch = wallMoveEndpoint({ wallId, end, x: target.x, y: target.y }).build(doc);
    deriveStoreyGeometry(applyPatch(doc, patch).doc, storeyId);
    return true;
  } catch {
    return false;
  }
}

/** 一次自动拖拽的全部坐标：`--edit-shot` 只读它，不猜靶子。 */
export interface DragProbe {
  readonly wallId: string;
  readonly end: WallEnd;
  readonly pointId: string;
  /** 几面墙指着这个点（>= 2）：孤墙拖了证不出"邻墙跟着动"，那才是回读要判的事。 */
  readonly sharedBy: number;
  /** 三枚像素全部取整（见 `snapPx`）：回读脚本发得出、renderer 反算得回同一个毫米。 */
  readonly fromPx: Px;
  readonly toPx: Px;
  readonly anchorPx: Px;
  readonly targetMm: MoveTarget;
}

/**
 * `sendInputEvent` 只收整数 DIP，而 renderer 松手时算的是 `moveTargetOf(视图, 那一发整数像素)`。
 * 所以探针**先取整像素、再由像素反算毫米**：这样"探针给的毫米"与"屏幕上真会落下的毫米"
 * 是同一个纯函数的同一个输出，不是近似。反过来（先定毫米再算像素）会在 0.125 px/mm 这种
 * 比例上差出最多 4mm —— 回读判据就会变成"有时候差一点"的随机红。
 */
function snapPx(p: Px): Px {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/**
 * 像素必须在画布内。这条不是洁癖而是判据成立的前提：闸门发的坐标进的是
 * `win.webContents.sendInputEvent`，它把**越界坐标悄悄夹到边界上** —— 于是探针说"点在 (253,74)"、
 * renderer 收到的是别处，落点越界则那一发根本压不扁墙，判据就红成"没被拒"（假阴性）或
 * "选中了别面墙"（假阳性）。越界的候选不是"难测"，是"测的不是它声称测的那一发"，所以直接淘汰。
 */
function insideCanvas(v: Viewport, p: Px): boolean {
  return p.x >= 0 && p.y >= 0 && p.x <= v.widthPx - 1 && p.y <= v.heightPx - 1;
}

/**
 * 候选落点按顺序试，第一个"取整后真的动了且合法"的赢。偏移全写成整数毫米 ⇒ 同一份文档、
 * 同一个视图，每次问都给出同一个靶子（"撤销后回到原值"这条判据的前提就是靶子可复现）。
 */
const PROBE_OFFSETS: readonly MoveTarget[] = [
  { x: 0, y: 800 },
  { x: 800, y: 0 },
  { x: 0, y: -800 },
  { x: -800, y: 0 },
  { x: 600, y: 600 },
  { x: -600, y: 600 },
  { x: 600, y: -600 },
  { x: -600, y: -600 },
  { x: 0, y: 2400 },
  { x: 2400, y: 0 },
];

/**
 * 找一个"值得自动拖"的共享端点。返回 null 是合法结果（空层、孤墙层）。
 *
 * 注意它返回的是**哪面墙**取决于样例房每次现建的 uuidv7（接头处三面墙叠在同一片像素上，
 * 谁赢由 T4 的层序 + ownerId 排序决定），所以调用方与测试都只判性质，不判具体 id。
 */
export function dragProbe(
  doc: Document,
  storeyId: string,
  ops: readonly DrawOp[],
  v: Viewport,
): DragProbe | null {
  const wallIds = doc
    .byKind('wall')
    .filter((w) => w.storeyId === storeyId)
    .map((w) => w.id);
  // dragHandlesOf 已排序 ⇒ 这一趟的候选顺序与"谁在选中集里先插入"无关
  for (const h of dragHandlesOf(doc, storeyId, { ids: new Set(wallIds) }, v)) {
    const sharedBy = incidentWallEnds(doc, h.pointId).length;
    if (sharedBy < 2) continue;
    const fromPx = snapPx(h.atPx);
    // D5 的前提要在真窗口里成立，这一句是根：那一发点下去必须选中被拖那面墙。
    // 判的是**取整后**的像素 —— 回读脚本发的就是它，不是 h.atPx 那个浮点数。
    // 选不中就换一把 —— 而不是拖一面"屏幕上没红着的"墙。
    if (!insideCanvas(v, fromPx)) continue;
    if (pickOne(ops, fromPx)?.ownerId !== h.wallId) continue;
    for (const off of PROBE_OFFSETS) {
      const toPx = snapPx(mmToPx(v, { x: h.atMm.x + off.x, y: h.atMm.y + off.y }));
      // 落点越界 = 这一发会被 sendInputEvent 夹到边界上，测的就不再是探针声称的那个落点
      if (!insideCanvas(v, toPx)) continue;
      const targetMm = moveTargetOf(v, toPx);
      // 极小比例视图下取整会把这一发抹回原地：那不是"移动"，撤销/重做判据会全部空转，换下一个候选。
      if (targetMm.x === h.atMm.x && targetMm.y === h.atMm.y) continue;
      if (!legalDrop(doc, h.wallId, h.end, targetMm)) continue;
      if (!derivesAfterMove(doc, h.wallId, h.end, targetMm, storeyId)) continue;
      return {
        wallId: h.wallId,
        end: h.end,
        pointId: h.pointId,
        sharedBy,
        fromPx,
        toPx,
        anchorPx: snapPx(h.anchorPx),
        targetMm,
      };
    }
  }
  return null;
}

/**
 * 本层全部墙端点的整数毫米，给 `--edit-shot` 当回读快照（"拖动前 vs 拖动后 vs 撤销后"）。
 * 只走墙端点，不遍历 `byKind('point')`：真源里的 point 只被墙/柱/板引用，而本任务的
 * 判据全部关于墙 —— 顺带把"别层的点漏进来"变成可红的断言（快照口径与 `dragHandlesOf` 的层过滤一致）。
 */
export function pointSnapshot(doc: Document, storeyId: string): Record<string, MoveTarget> {
  const out: Record<string, MoveTarget> = {};
  for (const wall of doc.byKind('wall')) {
    if (wall.storeyId !== storeyId) continue;
    for (const id of [wall.startId, wall.endId]) {
      if (out[id] !== undefined) continue; // 共享点只记一次
      const point = requirePoint(doc, id, '墙端点');
      out[id] = { x: point.x, y: point.y };
    }
  }
  return out;
}
