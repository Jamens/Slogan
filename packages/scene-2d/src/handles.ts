import {
  applyPatch,
  deriveStoreyGeometry,
  endPointId,
  incidentWallEnds,
  requirePoint,
  wallAxisById,
  wallMoveEndpoint,
  wallSetLoadBearing,
  wallSetMaterial,
  wallSetThickness,
  type Document,
  type EntityId,
  type WallEnd,
} from '@dajia/core';
import { mmToPx, type Px, type Viewport } from './viewport';
import type { DrawOp, Selection } from './drawlist';
import { openingPickPx, PICK_TOL_PX, pickOne, pickPxOf, probeTarget } from './pick';
import { PANEL_MATERIAL_OPTIONS, trialCommand, wallPropsOf, type WallProps } from './panel';
import {
  dropTargetOf,
  snapFieldOf,
  type DropTarget,
  type MoveTarget,
  type SnapField,
} from './snapping';

/**
 * 编辑器画在屏幕上、却**不进指令表**的那一层（Task 5 D2）：把手、拖拽临时线、
 * 以及"这个落点拖不拖得动"的预言。
 *
 * 为什么不进 `buildDrawList`：那张表是**图纸内容的投影** —— 计划 4 的像素判据与计划 5 的
 * 可施工图都直接吃它，把蓝点掺进去等于往施工图上印编辑器家具，而"指令表还是 31 条"
 * 这类回归判据恰好看不见多印了什么。代价是这个文件外面要再多两个画家（PlanCanvas 的
 * `paintHandles` / `paintPreview`），"只有一条绘制通路"这条纪律改由像素计数来守（Step 5/6）。
 *
 * T6 之后本文件不再自带"像素 → 毫米"：`MoveTarget` / `moveTargetOf` 搬进了 `snapping.ts`
 * （吸附必须接在换算之后，两者分居两文件就会长出第二条 px→mm 的路，那正是 D4 禁止的）。
 * 本文件因此只剩两个**读者**：`dragProbe` 吃 `dropTargetOf`（吸附后的落点，与 renderer 松手
 * 那一发同一个函数、同一个场），`legalDrop` 只吃已经定好的 `MoveTarget`。
 */

/**
 * 四种颜色给 `countPixels` 认道：选中（红）、把手（蓝）、临时线（绿）、吸附标记（橙，
 * 常量在 `snapping.ts` 的 `SNAP_COLOR`）。
 * 两两最大通道差必须 > 2×`PIXEL_CHANNEL_TOL`（`handles.test.ts` 最后一条钉死）：
 * 认色是按通道 ±TOL 开窗的，两种颜色挨太近时同一片像素会同时进两个桶，
 * Step 6 的 `handlePx` / `previewPx` 就全是假绿。#1668dc 与 #12b886 的差只在 G/B 上
 * （104↔184、220↔134，最大 86 > 80），挨得不远 —— 所以改任何一个字面量都要回去跑那条。
 */
export const HANDLE_COLOR = '#1668dc';
export const PREVIEW_COLOR = '#12b886';
export const PIXEL_CHANNEL_TOL = 40;
export const HANDLE_RADIUS_PX = 4.5;

/** 一枚可拖把手：`end` 与 `pointId` 配对钉死（计划 1 的角色反转 bug 就是这个配对松开过）。 */
export interface DragHandle {
  readonly wallId: string;
  readonly end: WallEnd;
  readonly pointId: string;
  /** 真源里那对整数毫米，直读实体，不做任何 px ↔ mm 往返。 */
  readonly atMm: MoveTarget;
  /** 它在线上的哪一端：与 `wallAxisById` 同源，所以和墙多边形永远对齐。 */
  readonly atPx: Px;
  /**
   * 另一端那对整数毫米：T6 的角度档（正交 / 15°）要一个**毫米**锚点，而 `anchorPx` 是浮点像素，
   * 拿它反算毫米会引入一次往返。与 `anchorPx` 同产地（都取自 `wallAxisById` 的另一端），
   * 所以两枚永远指同一头 —— 它不进 `dispatch`，只当锚，不必像 `atMm` 那样另立"直读实体"这一票。
   */
  readonly anchorMm: MoveTarget;
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
      const anchor = end === 'start' ? axis.end : axis.start;
      out.push({
        wallId: wall.id,
        end,
        pointId,
        // atMm 直读实体、atPx 走轴线：两个产地同一个数字，用例分别钉（H1）。
        // 只从轴取 atMm 的话，"轴算错了"和"点被人改了"会红在同一条断言上。
        atMm: { x: point.x, y: point.y },
        atPx: mmToPx(v, end === 'start' ? axis.start : axis.end),
        // anchorMm 与 anchorPx 同产地、同一端：角度档吃毫米，命中与探针吃像素。
        anchorMm: { x: anchor.x, y: anchor.y },
        anchorPx: mmToPx(v, anchor),
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

/**
 * 拖拽与松手**共用**的那一发落点：锚点与被排除的坐标都从把手自己身上取，两个调用点
 * （`dragProbe` 与 PlanCanvas 的 `onMove`/松手）拿到的是同一个函数、同一对参数。
 *
 * 这一层薄壳不是 convenience，是**把 S4 第二条纪律变成可红的判据**。分开写两遍时，"探针传
 * `null` 锚点 / 忘了排除"是可写的，而实测那种改坏时红时不红（2026-09-28 八个进程里红 5 个：
 * 落点是否依赖锚点取决于探针挑到哪一面墙）—— 拿不稳的判据不算凭据。收进这一个出口之后，
 * 改锚点/改排除只有"改出口"这一种写法，而它必然同时打到两个调用点：实测摘锚点红
 * 「拖拽路径真的在吃吸附」、摘排除红「把手按在原地那一发」，两条都是 8/8 进程逐字红。
 *
 * 说清楚它**不**保证什么：有人绕过本出口、在探针里另抄一遍 `dropTargetOf(...)` 并漏掉排除
 * （改坏清单 HE3），本层拦不住 —— 实测那条零红，恒等筛也兜不住它（HE3 + 摘掉恒等筛的联合
 * 改坏 HE4 同样零红，样例房那十发候选里没有一发吸回原地）。出口买到的是"参数只有一处可写"，
 * 不是"参数写错必然红"；后者靠的是判探针与 renderer 同一个调用那两条。
 */
export function handleDropTarget(
  v: Viewport,
  cursorPx: Px,
  h: DragHandle,
  field: SnapField,
): DropTarget {
  return dropTargetOf(v, cursorPx, h.anchorMm, field, { excludeMm: h.atMm });
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
 * `sendInputEvent` 只收整数 DIP，而 renderer 松手时算的是
 * `dropTargetOf(视图, 那一发整数像素, 锚点, 场, 排除原地)`。
 * 所以探针**先取整像素、再由像素定落点**：这样"探针给的毫米"与"屏幕上真会落下的毫米"
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
 * 候选落点按顺序试，第一个"**吸附之后**真的动了且合法"的赢。偏移全写成整数毫米 ⇒ 同一份文档、
 * 同一个视图，每次问都给出同一个靶子（"撤销后回到原值"这条判据的前提就是靶子可复现）。
 *
 * 这一串候选**会**被吸走，别把"偏移取得远"当成"吸不上"。样例房一层 16 把把手 × 这十发 = 160 问
 * （2026-09-28 实测，十个进程逐字相同）：86 问吸上了东西，其中 72 问吸成**恒等** —— 垂足 54、
 * 正交 17、中点 1，那些落点本来就在自己那面墙的轴线上，吸附只是原样还回来；剩下 14 问被 15° 档
 * 挪走，最大位移 55.79mm = 6.97px（仍在 `SNAP_TOL_PX` 之内），且这 160 问的落点**在 Task 6 落地时**全部过得了 `legalDrop`。
 * （Task 7 把派生复核搬进 `wallMoveEndpoint.build` 之后这一句不再成立：160 发里 `build` 拒 84 发、全是 star，
 * 可拖 76 发，且"第一发可拖"从第 0 发挪到第 1 发的有 **16 把把手里的 12 把**（去重是 8 个位置，另外 4 把不动）—— 实测见 Task 7 的 T6 交接第 ④ 条。）
 * 所以"整数百米毫米"买到的是靶子可复现与恒等落点上的稳定，不是"探针不吃吸附"。
 *
 * `handles.test.ts` 的「拖拽路径真的在吃吸附」把这几个计数钉成判据（恒等 ≥ 8、改写 ≥ 1、
 * 改写只许来自 `angle15`）。它红的那天不是回归，是要回来重量的那天：`--edit-shot` 的
 * "松手落点逐字等于探针给的毫米"仍成立（两边同吃 `dropTargetOf`），但"拖了 800mm"这类
 * 位移预期从此不再等于偏移本身 —— 到那天要改的是判据，不是把吸附从拖拽路径上摘掉。
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
  // 场在入口取一次：`snapFieldOf` 要展开本层全部墙与点，放在候选循环里就是 O(候选² × 墙)。
  // 判据（`--edit-shot` 逐字相等）要的是"探针与 renderer 同一个函数、同一个场"，不是"更快一点"。
  const field = snapFieldOf(doc, storeyId);
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
    // 锚点也要进筛：`--edit-shot` 第 9 步「压扁到锚点」按的就是这一发（T5 只筛了 `fromPx`/`toPx`，
    // 因为那时画布铺满整个窗口，锚点不可能跑出画布）。Task 8 把画布缩成格子之后，长墙的锚点
    // 第一次落到画布外 ⇒ `sendInputEvent` 打中属性面板，那一发既没拖也没拒，`lastError` 恒空。
    const anchorPx = snapPx(h.anchorPx);
    if (!insideCanvas(v, anchorPx)) continue;
    for (const off of PROBE_OFFSETS) {
      const toPx = snapPx(mmToPx(v, { x: h.atMm.x + off.x, y: h.atMm.y + off.y }));
      // 落点越界 = 这一发会被 sendInputEvent 夹到边界上，测的就不再是探针声称的那个落点
      if (!insideCanvas(v, toPx)) continue;
      // 与 renderer 松手那一发**同一个调用**：`handleDropTarget(视图, 那一发整数像素, 这把把手, 场)`。
      // 锚点与排除集都在那个出口里从把手身上取（见它的注释）：原地要排掉的是**被拖那枚点的坐标**
      // 而不是 `pointId`（原地同时是端点候选又是它自己轴线上的垂足），锚点要给另一端，角度档才有方向可对齐。
      const { mm: targetMm } = handleDropTarget(v, toPx, h, field);
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
        anchorPx,
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

/**
 * 面板那一步的厚度候选表，**与裁决 P8 的 B 组实测同一张表**（样例房一层八面墙各试这四档：
 * 四面全档可改、四面全档锁死）。顺序是判据的一部分：`propProbe` 交的是**表里第一档改得动的**，
 * 所以红了先查这张表与那面墙的轴长，别查屏幕。
 */
export const PROP_THICKNESS_CANDIDATES: readonly number[] = [120, 370, 500, 3900];

/** `--prop-shot` 的靶子：一面改得动的墙、它身上的一樘洞口、以及三格要写进去的新值。 */
export interface PropProbe {
  readonly wallId: EntityId;
  /** 选中这面墙的那一发（画布空间、整数）。 */
  readonly clickPx: Px;
  /** 清空选中集的那一发：序列里每两步之间都要它，否则会带着上一步的选中集进下一步。 */
  readonly blankPx: Px;
  /** 住在 `wallId` 那面墙上的一樘洞口（第 11 步的 shift 点击）。 */
  readonly openingId: EntityId;
  readonly openingPx: Px;
  /**
   * 本层**另一面**点得中且在画布内的墙（第 11 步再 shift 点它 ⇒ 选中集里有两面墙 ⇒ 面板消失）。
   * 挑不到给 null（单墙层是合法文档），闸门在那一步自己抛 —— 它是"尽力靶子"，
   * 不是第七道拒人的筛：把它做成筛会让所有单墙夹具交不出靶子，下游每条用例都得陪改。
   */
  readonly secondWallId: EntityId | null;
  readonly secondWallPx: Px | null;
  /** 探针当时刻意**没有**改过的读数：闸门拿它当"第 3 步该读到什么"的预言。 */
  readonly props: WallProps;
  readonly thicknessTo: number;
  readonly materialTo: string;
  readonly loadBearingTo: boolean;
}

/**
 * 找一发"值得在真窗口里改属性"的墙 —— `--prop-shot` 十六步的靶子，与 `dragProbe` / `wallProbe`
 * 同一条纪律：**主进程只读它，不猜坐标，也不猜哪面墙改得动**。
 *
 * 六道筛，每条各堵一处假绿：
 * ① `wallPropsOf` 给得出读数（本层的墙、还活在文档里）。
 * ② 点得中且在画布内：`pickPxOf` 那把"全局唯一命中"的尺 + `insideCanvas`（D4 那次的教训 ——
 *    越界那一发会被 `sendInputEvent` 夹到边界上，测的就不再是探针声称的那一发）。
 * ③ **改得动**：`PROP_THICKNESS_CANDIDATES` 里第一档"与现值不同且真源收"的厚度。少了这一筛，
 *    探针可能挑到 P8 B 组那四面被 T 接同厚锁死的墙，`--prop-shot` 第 5 步会红成"面板拒了合法输入"
 *    的假象（计划原文那句「挑到后四面上，那六步会红成假象」说的就是这件事）。
 *    "与现值不同"是 P12 的另一半：同值那一发屏幕上根本不发命令，depth 判据会空转。
 * ④ 材料候选同理。**诚实说一句：④⑤ 那两次现问真源今天没有能红的路径** —— core 对
 *    `wall.setMaterial` 只判写法（非空、无首尾空白、≤32 字符），对 `wall.setLoadBearing` 连写法都不判，
 *    五档候选全过 ⇒ 摘掉这两次试跑，`handles.test.ts` 当时那批句柄用例一条不红（2026-09-30 变异实测
 *    M-E1-d / M-E1-e，见 `t8E-teeth-2.log`）。留着它们要买的东西写在这里：屏幕侧不许攒第二套合法性
 *    口径（裁决 P11），将来 core 给材料或承重补一道守卫时这里**不需要改**就能把"改不动的墙"跳过去。
 * ⑤ 承重翻转同理（真源今天没有守卫会拒它，但那是**判出来的**，不是假设的）。
 * ⑥ 它身上有一樘点得中的洞口：第 11 步"墙 + 洞口"多选与第 12 步那句 cascade 全靠它。
 *    样例房一层四樘洞口实测全点得中（2026-09-30），但**不是每面墙都有洞口** ——
 *    横墙 `stem` 与两面隔墙就没有，③④⑤ 全过而 ⑥ 不过，必须跳过。
 *
 * 六道筛之外还交一发**尽力**靶子（不是筛，挑不到不影响靶子成立）：本层另一面点得中、在画布内的
 * 墙 `secondWallPx`。第 11 步"再 shift 点一面墙 ⇒ 面板整块消失"要靠它，而主进程不许自己猜坐标。
 *
 * 谁被挑中由 uuidv7 每次现建的 id 定（`byKind` 是 id 升序），所以调用方与测试都**只判性质，
 * 不判具体 id**。返回 null 是合法结果（空层、没有带洞口的可改墙），闸门在那一步就抛。
 */
export function propProbe(
  doc: Document,
  storeyId: string,
  ops: readonly DrawOp[],
  v: Viewport,
): PropProbe | null {
  // 空白点与"随便一面墙"都由 `probeTarget` 给：它比这里的每一筛都便宜，且它 null 就意味着
  // 这一层铺满了画布 —— 那种屏幕上"点空白清空选中"根本做不到，整条序列的前提没了。
  const target = probeTarget(ops, v);
  if (target === null) return null;
  const blankPx = snapPx(target.blankPx);
  for (const wall of doc.byKind('wall')) {
    if (wall.storeyId !== storeyId) continue;
    const props = wallPropsOf(doc, wall.id); // 筛 ①
    if (props === null) continue;
    const rawClick = pickPxOf(ops, wall.id); // 筛 ② 之一
    if (rawClick === null) continue;
    const clickPx = snapPx(rawClick);
    if (!insideCanvas(v, clickPx)) continue; // 筛 ② 之二
    const thicknessTo = PROP_THICKNESS_CANDIDATES.find(
      // 筛 ③：现问真源，不查表里的"应该能改"
      (cand) =>
        cand !== props.thicknessMm &&
        trialCommand(doc, () => wallSetThickness({ wallId: wall.id, thicknessMm: cand })).ok,
    );
    if (thicknessTo === undefined) continue;
    const materialTo = PANEL_MATERIAL_OPTIONS.find(
      (opt) =>
        opt.value !== props.material &&
        trialCommand(doc, () => wallSetMaterial({ wallId: wall.id, material: opt.value })).ok,
    )?.value; // 筛 ④
    if (materialTo === undefined) continue;
    const loadBearingTo = !props.loadBearing;
    if (
      !trialCommand(doc, () => wallSetLoadBearing({ wallId: wall.id, loadBearing: loadBearingTo })).ok
    ) {
      continue; // 筛 ⑤
    }
    let openingId: EntityId | null = null;
    let openingPx: Px | null = null;
    for (const opening of doc.byKind('opening')) {
      if (opening.hostWallId !== wall.id) continue;
      const px = openingPickPx(ops, opening.id);
      if (px === null || !insideCanvas(v, px)) continue;
      openingId = opening.id;
      openingPx = px;
      break;
    }
    if (openingId === null || openingPx === null) continue; // 筛 ⑥
    // 第二面墙（多选那一发的靶子）：只要求"本层、不是它自己、点得中、在画布内"。
    // 不要求它改得动 —— 那一发判的是面板**消失**，与第二面墙的三格无关；挑不到就交 null，
    // 由闸门在那一步抛（单墙层是合法文档，不该让探针整体失能）。
    let secondWallId: EntityId | null = null;
    let secondWallPx: Px | null = null;
    for (const other of doc.byKind('wall')) {
      if (other.storeyId !== storeyId || other.id === wall.id) continue;
      const raw = pickPxOf(ops, other.id);
      if (raw === null) continue;
      const px = snapPx(raw);
      if (!insideCanvas(v, px)) continue;
      secondWallId = other.id;
      secondWallPx = px;
      break;
    }
    return {
      wallId: wall.id,
      clickPx,
      blankPx,
      openingId,
      openingPx,
      secondWallId,
      secondWallPx,
      props,
      thicknessTo,
      materialTo,
      loadBearingTo,
    };
  }
  return null;
}
