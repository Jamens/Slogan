import { useEffect, useRef, useState } from 'react';
import { requirePoint, wallMoveEndpoint, type EntityId } from '@dajia/core';
import {
  buildDrawList,
  draftAtPress,
  draftCommand,
  dragHandlesOf,
  dragProbe,
  dropTargetOf,
  EMPTY_SNAP_FIELD,
  fitStorey,
  HANDLE_COLOR,
  HANDLE_RADIUS_PX,
  handleDropTarget,
  lastCreatedWall,
  legalWallCreate,
  mmToPx,
  moveDraft,
  newWallDefaults,
  pickHandle,
  pickOne,
  PIXEL_CHANNEL_TOL,
  planDelete,
  pointSnapshot,
  PREVIEW_COLOR,
  probeTarget,
  pruneSelection,
  propProbe,
  SNAP_COLOR,
  SNAP_MARK_HALF_PX,
  SNAP_MARK_OUTER_HALF_PX,
  snapFieldOf,
  SELECTED,
  wallProbe,
  type DeleteOutcome,
  type DragHandle,
  type DragProbe,
  type DrawOp,
  type DraftWall,
  type Pen,
  type PickProbe,
  type PropProbe,
  type Px,
  type SnapField,
  type StoreyTab,
  type Tool,
  type Viewport,
  type WallProbe,
  type WallProps,
} from '@dajia/scene-2d';
import { useEditor } from './stores/editorStore';
import { useSelection } from './stores/selectionStore';
import {
  panelReadout,
  PropPanel,
  STOREY_TAB_HEIGHT_PX,
  StoreyTabs,
  VIEW_PAD_PX,
  type PanelTrialReport,
} from './panels';

export interface DropReport {
  outcome: 'ok' | 'noop' | 'failed';
  wallId: string;
  end: string;
  targetMm: { x: number; y: number };
  /** 松手那一刻从真源读到的坐标（不是命令参数）：ok 与 failed 的分界要靠它。 */
  pointMm: { x: number; y: number };
}

export interface KeyEventReport {
  /**
   * 每一发被 renderer 处理的 keydown 递增一次。**判据不能只靠 `combo`**：第 8 步的
   * "空栈再按 Ctrl+Shift+Z"与第 6 步的"重做 Ctrl+Shift+Z"是同一串字面量，而空栈那一发
   * 故意什么都不改（`depth`、`revision`、坐标全不动，只换一句中文）⇒ 真源侧没有任何字段
   * 能证明它到过。`waitKeyApplied` 等的就是这个数变大，`combo` 只用来证"回声的是那一发"。
   */
  seq: number;
  combo: string;
  depth: number;
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
  lastError: string | null;
}

/** 松手那一发拉出来的墙。`'rejected'` = 草稿 `legal === false`，**一条命令都没发**；`'failed'` = 发了但真源抛。 */
export interface CreateReport {
  outcome: 'ok' | 'rejected' | 'failed';
  wallId: string | null;
  /** 派发成功后从真源读的两端点 id（S6 的三票之一：`affected` 给 id，`doc.get` 复核存在）。 */
  startId: string | null;
  endId: string | null;
  /** 松手前草稿的终点毫米。命令入参可能是一支 `{ pointId }`（没有毫米），所以账要记在落点上。 */
  endMm: { x: number; y: number } | null;
  /** 本层点数的前后两次读数：新建一面全新终点的墙 ⇒ +1，删回去 ⇒ 回到原值。 */
  pointCountBefore: number;
  pointCountAfter: number;
}

/**
 * `w` / `Escape` / `Delete` / `Backspace` 的回声，与 `KeyEventReport` 同一套 `seq` 机理
 * （T5 D8 那条理由在这里原样成立：`combo` 只证"回声的是哪一发"，等它变大抓不到"到过 renderer"）。
 * 单独一份而不是塞进 `KeyEventReport`：撤销/重做那一发不碰工具态，这里每一发都碰。
 */
export interface HotkeyReport {
  seq: number;
  combo: string;
  /** 这一发处理完之后的工具态：`w` 与 `Escape` 的凭据就在它身上。 */
  tool: Tool;
  /** 这一发处理完还有没有草稿（Escape 取消、松手、被拒都该让它变 false）。 */
  draftActive: boolean;
  /** 只有 `Delete` / `Backspace` 那一发给值；其余快捷键给 null。四色判"沉默是哪一种沉默"（S5）。 */
  deleteOutcome: DeleteOutcome | null;
  depth: number;
  revision: number;
  lastError: string | null;
}

/** 本层的点数。`points` 快照的键集合就是它，所以这里不再数第二遍（两个真值来源必漂）。 */
function pointCountOf(points: Record<string, { x: number; y: number }>): number {
  return Object.keys(points).length;
}

export interface DebugReport {
  ops: number;
  layers: Record<string, number>;
  nonBlankPx: number;
  wPx: number;
  hPx: number;
  selectedIds: string[];
  selectedPx: number;
  pick: PickProbe | null;
  selectedAfterBlank: number;
  /**
   * 画布原点在**页面/视口坐标空间**（CSS px，getBoundingClientRect 口径）的位置。
   * `pick` 与 `edit` 里的像素点是**画布坐标空间**；sendInputEvent 吃页面空间。两套空间
   * 差的就是这个值 —— 换算由 main 的 clickCanvasPx / 拖拽助手做，"它今天等于 (0, 32)"
   * 由 --pick-shot / --edit-shot 的 origin PASS 行断言。32 那一格是 Task 8 的楼层 tab 栏
   * （高度住在 `panels.tsx` 的 `STOREY_TAB_HEIGHT_PX`，与这里同一个数），不是 body margin。
   */
  canvasOriginPx: { x: number; y: number };
  // ↓ T5 的 14 个
  revision: number;
  depth: number;
  canUndo: boolean;
  canRedo: boolean;
  lastError: string | null;
  handlePx: number;
  previewPx: number;
  /** 临时线中离**当前光标** 2px 内的那一撮：只有 `previewPx` 分不出"跟手的线"与"钉在按下点的线"。 */
  previewNearCursorPx: number;
  points: Record<string, { x: number; y: number }>;
  edit: DragProbe | null;
  /** 拖拽进行中 store 里那一发 `targetMm`：没在拖就是 null。松手前 main 用它确认
   *  最后一发 `pointermove` 真的进了 store —— 早一步 release 用的是**旧光标**。 */
  dragTargetMm: { x: number; y: number } | null;
  /** 拖拽进行中 store 里那一发**已处理**的光标像素。主进程拿它对照"我到底发了哪个像素"：
   *  `previewNearCursorPx` 量的就是 store 自报的光标，自洽 ⇒ 光标落后一帧它也照样绿。 */
  dragCursorPx: Px | null;
  lastDrop: DropReport | null;
  lastKeyEvent: KeyEventReport | null;
  // ↓ T6 的 9 个
  tool: Tool;
  /** 进行中的草稿（含两端落点、吸附结论、合法性）。null = 没在拉墙。 */
  draft: DraftWall | null;
  /** 第四色像素总数。**只证"那一刻吸附了"，不证吸到哪**（S8）：位置的对账走毫米。 */
  snapMarkPx: number;
  lastCreate: CreateReport | null;
  /**
   * 最后一次删除里**文档真的不再含有**的 id（按 `candidateIds` 的顺序筛）。
   * 记的是真源账不是计划账：`dispatchBatch` 第一条抛错就 break，后面几条根本没执行，
   * 那些构件还在文档里 ⇒ 不许出现在这一本账上（D2 的 `--draw-shot` 与 Task 8 拿它对账）。
   */
  deletedIds: string[];
  /**
   * 最后一次删除计划留给面板的、本层取不到的 id（别层构件）。样例房里恒空 ——
   * 两层房的构件都点在这一层里，字段是接线凭据不是分支凭据。
   */
  unsupportedIds: string[];
  /** 删除剪枝**之后**的选中集（`pruneSelection` 的答案直接落在这儿，不经过 store 二次推导）。 */
  selectionAfterDelete: string[];
  lastHotkey: HotkeyReport | null;
  /** 拉墙的靶子：与 `edit` 同一条纪律 —— 主进程只读它，不猜坐标（`pxPerMm` 住在 renderer）。 */
  draw: WallProbe | null;
  // ↓ Task 8 棒 D1 的 5 个。全部读 `panelReadout()`（面板自己上屏那一帧公布的值），
  // 这里**不许**再拿 `storeyTabsOf` / `wallPropsOf` 算第二遍：重算等于用结论证结论 ——
  // 面板画错、画空、画陈旧，报告照样绿。
  /** 当前层的 tab 列表（顺序、标签、标高全部来自 `storeyTabsOf`，renderer 不自己排）。 */
  storeyTabs: StoreyTab[];
  /** `selectedWallForPanel` 的答案；null = 面板不渲染。 */
  panelWallId: EntityId | null;
  /** 面板三格读数 + 轴长；null 同上。 */
  panelProps: WallProps | null;
  /** 最近一次输入框预言：`{ kind, input, ok, reason }`。`--prop-shot` 的红字判据读它。 */
  lastTrial: PanelTrialReport | null;
  /** 最近一次成功提交后的**真源**读数（不是输入框的值）：证"面板读真源"。 */
  propsAfterEdit: WallProps | null;
  /**
   * 面板提交通路的"到过人"计数（读 `panelReadout().thicknessCommitAttempts`）：`--prop-shot` 第 6 步
   * 用它当"那一发 Enter 到没到"的到位凭据，不进 React state、不等下一帧（见 `panels.tsx` 的注释）。
   * 与上面那五格同一条纪律：值直通 `panelReadout()`，这里一个都不重算。
   */
  thicknessCommitAttempts: number;
  // ↓ Task 8 棒 E 的 3 个：`--prop-shot` 第 1、2 步（切层 + P10）的读数口。
  // 这一对不读 `panelReadout()`，读的是 store 自己（视口只住在那里）—— 面板那五格的
  // "不许重算"纪律管不到它，这里也没有第二份算式：`fitStorey` 的答案在写进 store 那一刻就定了。
  /** 当前层（`useEditor.storeyId`）。tab 判据问"点第 2 个 tab 之后当前层是不是它"。 */
  storeyId: EntityId;
  /** 当前视口：null = 还没量过画布（`fit()` 之前的一帧）。 */
  viewport: Viewport | null;
  /**
   * 这份视口是**为哪一层**算的。样例房两层的 footprint 相同 ⇒ 两层的 `fitStorey` 结果逐字相同，
   * "切层那一发的 `pxPerMm` 与另一层不同"这一口咬不住（2026-09-30 实测），于是 P10 的牙改在配对上：
   * 它必须跟着 `storeyId` 一起动。摘掉 `setStorey` 里的重算，它就留在上一层。
   */
  viewportStoreyId: EntityId | null;
  /**
   * `--prop-shot` 的靶子（一面改得动的墙 + 它身上点得中的洞口 + 三格要写的新值）。
   * 与 `edit` / `draw` 同一条纪律：主进程只读它，不猜坐标、也不猜哪面墙改得动。
   */
  prop: PropProbe | null;
}

declare global {
  interface Window {
    __dajiaDebug?: () => DebugReport;
  }
}

const DASH: Record<Pen['lineType'], number[]> = {
  solid: [],
  dashed: [6, 4],
  'dash-dot': [12, 4, 2, 4],
};

const BG = '#ffffff';

/** 临时线的虚实：比轴线更疏一点，免得和 `DASH.dashed` 的轴线混成一类。 */
const PREVIEW_DASH = [4, 3];

function rgbOf(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

const SEL_RGB = rgbOf(SELECTED);
const HANDLE_RGB = rgbOf(HANDLE_COLOR);
const PREVIEW_RGB = rgbOf(PREVIEW_COLOR);
const SNAP_RGB = rgbOf(SNAP_COLOR);

/**
 * 抗锯齿让线边缘是渐变而不是纯色，所以按通道 ±TOL 数，不比 RGB 全等（T4 的口径）。
 * 容差取自 `handles.ts` 的 `PIXEL_CHANNEL_TOL`：判据与画家不许各拿一个数 ——
 * `handles.test.ts` 最后那条"四种颜色互相分得开"用的也是它。
 */
function nearChannel(px: number, target: number): boolean {
  return Math.abs(px - target) <= PIXEL_CHANNEL_TOL;
}

/** 没有 ctx 时（理论分支）用的零值，与 `countPixels` 的返回同一形状。 */
const NO_PIXELS: Buckets = {
  nonBlankPx: 0,
  selectedPx: 0,
  handlePx: 0,
  previewPx: 0,
  previewNearCursorPx: 0,
  snapMarkPx: 0,
};

function paint(ctx: CanvasRenderingContext2D, ops: readonly DrawOp[]): void {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.lineCap = 'round';
  for (const op of ops) {
    ctx.strokeStyle = op.pen.color;
    ctx.lineWidth = op.pen.widthPx;
    ctx.setLineDash(DASH[op.pen.lineType]);
    if (op.kind === 'polygon') {
      ctx.beginPath();
      op.pts.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      if (op.fill !== null) {
        ctx.fillStyle = op.fill;
        ctx.fill();
        ctx.fillStyle = BG;
      }
      ctx.stroke();
    } else if (op.kind === 'line') {
      ctx.beginPath();
      ctx.moveTo(op.from.x, op.from.y);
      ctx.lineTo(op.to.x, op.to.y);
      ctx.stroke();
    } else {
      ctx.setLineDash([]);
      ctx.fillStyle = op.pen.color;
      ctx.font = `${String(op.sizePx)}px system-ui, sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.fillText(op.text, op.at.x, op.at.y);
    }
  }
  ctx.setLineDash([]);
}

/** D2：把手不进指令表，所以它有专用画家。圆而不是方块 —— 端点上盖得住、旁边盖不住。 */
function paintHandles(ctx: CanvasRenderingContext2D, handles: readonly DragHandle[]): void {
  ctx.fillStyle = HANDLE_COLOR;
  for (const h of handles) {
    ctx.beginPath();
    ctx.arc(h.atPx.x, h.atPx.y, HANDLE_RADIUS_PX, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 拖拽中的临时线：起点是按下那一发的像素，终点是当前光标（不是 targetMm 的像素 ——
 *  中途要让光标指哪画哪，落点那对整数毫米是松手才生效的东西）。 */
function paintPreview(
  ctx: CanvasRenderingContext2D,
  fromPx: Px,
  cursorPx: Px,
): void {
  ctx.strokeStyle = PREVIEW_COLOR;
  ctx.fillStyle = PREVIEW_COLOR;
  ctx.lineWidth = 1.5;
  ctx.setLineDash(PREVIEW_DASH);
  ctx.beginPath();
  ctx.moveTo(fromPx.x, fromPx.y);
  ctx.lineTo(cursorPx.x, cursorPx.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(cursorPx.x, cursorPx.y, HANDLE_RADIUS_PX, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * 吸附标记：**空心方环**（外沿 9×9、中间 5×5 挖空），画在**吸附后的落点**上（不是光标上 ——
 * 光标那儿已经有 `paintPreview` 的绿点）。它是第四色，所以它唯一能证的事是"这一发光标确实被吸走了"；
 * 吸到哪一律走毫米（`draft.end.mm` / `lastCreate.endMm`），像素不参与对账。
 *
 * 为什么中间要挖空（裁决 D1-B）：拖把手时 `drop.snap.distPx` 可以小到 0.33px（foot 恒等档），
 * 于是这枚标记正好落在第五桶 `previewNearCursorPx` 那 **±2px 窗口的正中间**，把 `paintPreview`
 * 的 r=4.5 绿实心圆盖掉 —— 实测 `nearMid` 25 → 5 → 0，`--edit-shot` 第 2 步随机红。
 * 空心环的橙色只占切比雪夫距离 `> 2` 且 `<= 4` 那一圈 ⇒ 窗口里一个橙像素都不进，
 * 而橙像素总数仍 `> 0`（S8 的存在性凭据、`--draw-shot` 那道硬 throw 都还在）。
 * 画序保持"preview 先、marker 后"：反过来不行 —— 草稿路的 `distPx` 只有量化往返残差（`--draw-shot`
 * 实测 0.33 / 0.45px，仍落进 ±2 窗口），r=4.5 的绿圆会把
 * 整枚标记（半对角 3.54px）盖没，`snapMarkPx` 归 0。
 *
 * `left/top` 先取整再画：`mmToPx` 给浮点，浮点原点的 `fillRect` 会把方块摊成半透明边，
 * 而 `nearChannel` 的 ±40 容差吃不下与白底混过色的高通道（`#ff8a00` 的 G=138，
 * 五成混白就是 196 > 178）—— 于是同一个标记在两种视图下数出来是 25 与 0。
 * 环带用四条 `fillRect` 拼（上/下/左/右），**不用 `strokeRect`**：描边要抗锯齿，于是环带上会出现
 * 与底图混过色的半透明像素，而橙色桶数的是"每通道与 `rgbOf(SNAP_COLOR)` 相差 `<= PIXEL_CHANNEL_TOL`
 * （±40）"（`nearChannel`，T4 的口径）—— **不是**逐字节相等，那个前提是写错的。真理由在这儿：
 * 混色像素落不落进桶取决于它底下是什么颜色 ⇒ 同一个标记在不同底图上数出不同的总数，
 * `snapMarkPx` 的读数变得不可解释。空心环这条裁决（D1-B）的根据不变：它让 `previewNearCursorPx`
 * 不再被橙标记盖住（`--edit-shot` 的 `nearMid` 实测 20/20/20/20/25）。
 * 取整之后恒 56 个纯色像素（9×9 − 5×5，两个半尺寸见 `snapping.ts`）。
 */
function paintSnapMarker(ctx: CanvasRenderingContext2D, atPx: Px): void {
  // 与旧的实心画法同一套取整口径：先 `round(中心 - 半尺寸)` 再画 `半尺寸 * 2` 宽。
  const innerX = Math.round(atPx.x - SNAP_MARK_HALF_PX);
  const innerY = Math.round(atPx.y - SNAP_MARK_HALF_PX);
  const outerX = Math.round(atPx.x - SNAP_MARK_OUTER_HALF_PX);
  const outerY = Math.round(atPx.y - SNAP_MARK_OUTER_HALF_PX);
  const innerSize = Math.round(SNAP_MARK_HALF_PX * 2);
  const outerSize = Math.round(SNAP_MARK_OUTER_HALF_PX * 2);
  // 环带宽 = 外沿与内圈的像素差的一半 = 2px（上下各盖 outerSize 宽，左右各补 innerSize 高）。
  const band = (outerSize - innerSize) / 2;
  ctx.fillStyle = SNAP_COLOR;
  ctx.fillRect(outerX, outerY, outerSize, band);
  ctx.fillRect(outerX, innerY + innerSize, outerSize, band);
  ctx.fillRect(outerX, innerY, band, innerSize);
  ctx.fillRect(innerX + innerSize, innerY, band, innerSize);
}

interface Buckets {
  nonBlankPx: number;
  selectedPx: number;
  handlePx: number;
  previewPx: number;
  previewNearCursorPx: number;
  snapMarkPx: number;
}

/**
 * 六个桶一次扫完。分开扫要六次 `getImageData`（每次都是跨进程边界的拷贝），一次扫是同一件事的几倍便宜。
 * 桶与桶**可以重叠**（一根线正好压在把手上），所以这里数的是"有多少像素像这个颜色"，
 * 不是像素分配 —— 判据全是 `> 0` / `=== 0`，不拿它们做加减。
 *
 * `cursorPx` 只服务第五个桶：临时线的**颜色**证不了它跟手（`previewPx` 在一根钉死于
 * 按下点的线上一样的 >20），所以要数"离当前光标 2px 内的临时线像素"。窗口给 2px 而不是 0，
 * 是因为 `offsetX` 在缩放的 Windows 上可能带小数，而 `sendInputEvent` 发出去的是取整值。
 * 拖拽之外（`cursorPx === null`）这一桶恒 0 —— 没人拿它判"没在拖"的那种情形。
 */
function countPixels(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  cursorPx: Px | null,
): Buckets {
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const width = canvas.width;
  const out: Buckets = {
    nonBlankPx: 0,
    selectedPx: 0,
    handlePx: 0,
    previewPx: 0,
    previewNearCursorPx: 0,
    snapMarkPx: 0,
  };
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    if (r < 250 || g < 250 || b < 250) out.nonBlankPx += 1;
    if (nearChannel(r, SEL_RGB[0]) && nearChannel(g, SEL_RGB[1]) && nearChannel(b, SEL_RGB[2])) {
      out.selectedPx += 1;
    }
    if (nearChannel(r, HANDLE_RGB[0]) && nearChannel(g, HANDLE_RGB[1]) && nearChannel(b, HANDLE_RGB[2])) {
      out.handlePx += 1;
    }
    if (nearChannel(r, PREVIEW_RGB[0]) && nearChannel(g, PREVIEW_RGB[1]) && nearChannel(b, PREVIEW_RGB[2])) {
      out.previewPx += 1;
      if (cursorPx !== null) {
        const col = (i / 4) % width;
        const row = Math.floor(i / 4 / width);
        if (Math.abs(col - cursorPx.x) <= 2 && Math.abs(row - cursorPx.y) <= 2) {
          out.previewNearCursorPx += 1;
        }
      }
    }
    // 第六桶**不开位置窗口**：标记就画在吸附后的落点上，而落点在哪儿正是判据要问的东西 ——
    // 拿"落点像素"当窗口去数自己的像素，等于用结论证结论。所以这一桶只数颜色，位置对账一律走毫米。
    if (nearChannel(r, SNAP_RGB[0]) && nearChannel(g, SNAP_RGB[1]) && nearChannel(b, SNAP_RGB[2])) {
      out.snapMarkPx += 1;
    }
  }
  return out;
}

/**
 * 画布像素坐标。**不再读 `event.offsetX/offsetY`**：那两个数相对**事件目标**，而目标在窗口级
 * 监听下会变成 `<html>`（指针拖出画布外那一刻），那时它是页面空间坐标 —— 而本棒之后画布原点
 * 不再是视口原点（上面多了一栏 32px 的楼层 tab），两套空间差的就是实测原点，按下去会整体偏 32px，
 * 红形是"点了没反应"，那是最难查的一类。
 * 口径与 `canvasOriginPx` 同源：都从这块 canvas 的 `getBoundingClientRect()` 减出来 ——
 * 两套空间的换算只有一份数，主进程与这里不许各减各的。
 * 非有限值返回 null：`quantizeMm` 会抛 RangeError，而那一发既没什么可写、也没什么可撤销。
 */
function pointerPx(event: PointerEvent, canvas: HTMLCanvasElement): Px | null {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

export function PlanCanvas(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * 画布外面那一格（`fit()` 量的是**它**，不是 canvas）。量 canvas 自己是行不通的：
   * 本棒的 CSS 尺寸由 `fit()` 写死成整数，于是 canvas 的 CSS 宽**依赖上一次量的结果** ——
   * 第一次量到的是 `<canvas>` 的默认 300×150，之后就锁死在 300。格子是 flex 给的，
   * 与画布尺寸无关（画布绝对定位），所以它才是那个"独立于结论"的读数来源。
   */
  const canvasCellRef = useRef<HTMLDivElement | null>(null);
  // 指针事件的靶子必须是**刷上屏的那一份**指令表与把手表（T4 的纪律延续到把手上）：
  // 副本与屏幕一旦漂开，"点得中的就是画出来的"就只剩注释在守。
  const opsRef = useRef<readonly DrawOp[]>([]);
  const handlesRef = useRef<readonly DragHandle[]>([]);
  // 诊断值住 ref 不进 paint 依赖（D6）：它们只给 __dajiaDebug 读，进了依赖就等于
  // "每一次抛错都自己制造一次重绘"，那 revision 的设计就白做了。
  const dropRef = useRef<DropReport | null>(null);
  const keyRef = useRef<KeyEventReport | null>(null);
  // 快捷键的"到过"计数器：与 keyRef 同生命周期，只给 __dajiaDebug 读（同样不进依赖）。
  const keySeqRef = useRef<number>(0);
  // "这次按下落在把手上"的同步副本：window 级监听器只注册一次、依赖里没有 drag，
  // 它判断"当前这串 move/up 属不属于一次拖"只能读 ref。屏幕上的那一半住 store（管重绘）。
  // T6 起它同时表示"这串手势归我管"：把手拖与拉墙的按下都置 true，`onMove`/`onUp` 再按
  // store 里是 `drag` 还是 `draft` 分岔 —— 两条路共用一个手势标志，因为一次按下只会走一条。
  const activeRef = useRef<boolean>(false);
  // 吸附的场：paint effect 每次上屏时刷新，指针事件只读不建（`snapFieldOf` 要展开本层全部墙，
  // 放在 `pointermove` 里就是每发一次整层遍历）。它必须是**刷上屏那一份**：场与屏幕不同步，
  // 判据就会说"吸上了一个屏幕上根本不存在的东西"。
  const fieldRef = useRef<SnapField>(EMPTY_SNAP_FIELD);
  /** 最后一次删除计划的三本账（发出的 / 本层取不到的 / 剪完之后剩下的），给 `__dajiaDebug` 读。 */
  const deleteRef = useRef<{
    deletedIds: string[];
    unsupportedIds: string[];
    selectionAfterDelete: string[];
  }>({ deletedIds: [], unsupportedIds: [], selectionAfterDelete: [] });
  /** 最后一次拉墙的回执（`CreateReport`）。同 `dropRef`：诊断值，不进 paint 依赖。 */
  const createRef = useRef<CreateReport | null>(null);
  const hotRef = useRef<HotkeyReport | null>(null);
  /** 只数 `w`/`Escape`/`Delete`/`Backspace` 这一路，与 `keySeqRef` 各数各的（见 `HotkeyReport`）。 */
  const hotSeqRef = useRef<number>(0);
  /**
   * 画布自己的实测尺寸（CSS px），由 `fit()` 写、`StoreyTabs` 读：tab 点击那一发要用它算
   * 新层的 `fitStorey`，而面板量不到画布 —— 递数字进去，比让面板去读 `window.innerWidth` 少一套口径。
   */
  const [canvasSizePx, setCanvasSizePx] = useState<{ readonly w: number; readonly h: number } | null>(null);

  const log = useEditor((s) => s.log);
  const storeyId = useEditor((s) => s.storeyId);
  const viewport = useEditor((s) => s.viewport);
  const revision = useEditor((s) => s.revision);
  const drag = useEditor((s) => s.drag);
  const tool = useEditor((s) => s.tool);
  const draft = useEditor((s) => s.draft);
  const setViewport = useEditor((s) => s.setViewport);
  const setDrag = useEditor((s) => s.setDrag);
  // `setTool` / `dispatchBatch` 不在这里取：只有快捷键那一路用它们，而那一路全部走
  // `useEditor.getState()`（闭包不捕获会变的东西 ⇒ 依赖表留空才是诚实的）。
  // `setDraft` 要取：按下/移动/松手三步都在指针路径里写草稿，它进那条 useEffect 的依赖表。
  const setDraft = useEditor((s) => s.setDraft);
  const dispatch = useEditor((s) => s.dispatch);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const ids = useSelection((s) => s.ids);
  const select = useSelection((s) => s.select);
  const toggle = useSelection((s) => s.toggle);
  const clear = useSelection((s) => s.clear);

  // 页面归位（真窗口实测后补的一行）：默认 body margin 8px 会把画布原点推到 (8,8)，
  // 而探针点/把手点的口径是画布坐标 —— 差值恰好 8px，等于吃光 PICK_TOL_PX，同一判据在
  // 真窗口里间歇性"点了没反应"（T4 实测 12 跑 5 红）。归零仍是必需的（它同时治了画布溢出），
  // 但它**不再是坐标系的前提**：前提由 __dajiaDebug 实测的 canvasOriginPx 明说，
  // 闸门的 origin PASS 行照实测值断言（Task 8 布局之后是 (0, 32)，32 那一格是 tab 栏），
  // 拖拽助手也照 measured origin 换算（见 main）。
  // cleanup 恢复原值：样式突变不许"改了没人还"。
  useEffect(() => {
    const previous = document.body.style.margin;
    document.body.style.margin = '0';
    return () => {
      document.body.style.margin = previous;
    };
  }, []);

  useEffect(() => {
    const fit = (): void => {
      const canvas = canvasRef.current;
      const cell = canvasCellRef.current;
      if (canvas === null || cell === null) return;
      // 尺寸来源是**画布那一格的实测**，不再是 `window.innerWidth/innerHeight`：Task 8 之后画布
      // 只是中栏左侧那一格（右边 260px 是属性面板，上面 32px 是 tab 栏），拿窗口尺寸当画布尺寸
      // 会让画布画到面板底下去 —— 而 `fitStorey` 按整窗算出的 `pxPerMm` 与屏幕上真的看得见的
      // 那块区域不再是一回事。
      const rect = cell.getBoundingClientRect();
      const wPx = Math.max(1, Math.floor(rect.width));
      const hPx = Math.max(1, Math.floor(rect.height));
      // 属性与 CSS 两边写**同一个整数**（这一条从 T3 起就在，本棒只是把尺寸来源从窗口换成画布）：
      // 格子宽是 `100vw − 260`，缩放比例非 100% 时它会带小数，而 `width: 100%` 让 CSS 尺寸跟着小数走
      // ⇒ `canvas.width`（整数）≠ CSS 宽 ⇒ 位图被合成器缩放，`countPixels` 数的与屏幕上点的不是同一份，
      // "1 canvas px = 1 CSS px" 一崩，像素判据全体失效。所以这里显式写死 CSS 尺寸，不靠格子给。
      canvas.width = wPx;
      canvas.height = hPx;
      canvas.style.width = `${String(wPx)}px`;
      canvas.style.height = `${String(hPx)}px`;
      // tab 点击那一发要拿**同一份**实测尺寸去 `fitStorey`（面板量不到画布），所以把它抬进 state。
      // 只在真的变了时才 `set`：`fit()` 由 resize 触发，同尺寸的重入不该白排一帧。
      setCanvasSizePx((prev) => (prev !== null && prev.w === wPx && prev.h === hPx ? prev : { w: wPx, h: hPx }));
      // 视口只在挂载、换层、窗口改尺寸这三件事上重算，**不跟着重渲染重算**。
      // 依赖里不写 `log`：`log` 是可变类实例、引用永不变，写进依赖挡不住任何东西 ——
      // 真正会咬人的是下面这句 `log.document` 是个**活读**的 getter：窗口改尺寸那一发
      // 触发 `fit()`，算的是**当时**的文档，于是中途改过坐标之后再来一发 resize，
      // 整张图按新边界重缩放，之前算定的探针像素全体失效（实测同一把手从 (253,74)
      // 漂到 (332,75)，第 7 步「原地松手」按到了空白）。闸门侧由 `waitForLayoutSettled`
      // 把 resize 收敛掉，这里则由"要当下的文档就从 store 一次性取"保证读到的不是陈旧闭包。
      // 换层与改尺寸才是重算视口的两个真实理由。
      setViewport(fitStorey(useEditor.getState().log.document, storeyId, wPx, hPx, VIEW_PAD_PX), storeyId);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [storeyId, setViewport]);

  // 一条绘制通路：指令表 → 把手 → 临时线/标记，同一个 effect、同一次 ctx 获取。
  // `revision` 进了依赖却没被读：它是扳机不是数据（见 editorStore 的 D6 注释）。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || viewport === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    // 整趟绘制包在 try 里，任何抛点都退化成本任务已有的 `lastError` 通道。
    // **这一支不是判据、不是预判**：它不复述任何派生规则（星形 / 同向重叠 / 接缝点 / 翻面
    // 只有 `deriveStoreyGeometry` 一个产地，计划 8427/8474 那条禁令在这儿原样有效），
    // 只保证"派生层任何抛点都不会把 React 树卸掉"—— renderer 全仓没有 ErrorBoundary，
    // 一次裸抛的 `RangeError` 就是白屏 + `window.__dajiaDebug` 一起消失，后续判据全读不到东西。
    // 真源的收口在 T7：`assertDerivesAfterApply` 挂上 `wallCreate.build` 之后，星形接头那一发
    // 在 `dispatch` 就抛、被既有的 catch 记进 `lastError`、`outcome` 报 `failed`，
    // 屏幕上根本不会留下这一发几何 —— 届时这一支 catch 退化成不会被走到的保险。
    // 失败那一帧 `opsRef` / `fieldRef` / `handlesRef` 留的是**上一趟的好值**：`buildDrawList`
    // 在赋值之前抛 ⇒ 引用不会变成半成品（不为此加清理逻辑：清成空表等于让指针事件打空）。
    try {
      const doc = log.document;
      const ops = buildDrawList(doc, storeyId, viewport, { ids });
      opsRef.current = ops;
      paint(ctx, ops);
      // 场与指令表在同一趟里取：指针事件的靶子、吸附的候选，全都来自刚刷上屏那一份几何。
      fieldRef.current = snapFieldOf(doc, storeyId);
      // S2：拉墙时屏幕上不许有把手。不画还不算完 —— `handlesRef` 也要清空，否则
      // `pickHandle` 会在墙模式下继续吃上一趟留下的把手（按下就该起草稿，不该拖老墙）。
      const handles = tool === 'wall' ? [] : dragHandlesOf(doc, storeyId, { ids }, viewport);
      handlesRef.current = handles;
      paintHandles(ctx, handles);
      if (drag !== null) {
        paintPreview(ctx, drag.fromPx, drag.cursorPx);
        const dragSnap = drag.drop?.snap ?? null;
        if (dragSnap !== null) paintSnapMarker(ctx, mmToPx(viewport, dragSnap.mm));
      }
      if (draft !== null) {
        // 临时线**恒**画到裸光标（`draft.cursorPx`），不画到吸附点：吸附点由橙色方环说。
        paintPreview(ctx, draft.start.px, draft.cursorPx);
        if (draft.start.snap !== null) paintSnapMarker(ctx, mmToPx(viewport, draft.start.snap.mm));
        if (draft.end.snap !== null) paintSnapMarker(ctx, mmToPx(viewport, draft.end.snap.mm));
      }
    } catch (err) {
      // 走 `getState()` 而不是订阅：报告口是稳定的方法引用，但把它写进依赖表等于
      // "每一次抛错都自己再上一次屏"，那正是 D6 要避免的事（见上面 `revision` 那条注）。
      useEditor.getState().reportPaintError(err);
    }
  }, [log, storeyId, viewport, revision, ids, drag, draft, tool]);

  // 按下：先问把手，再问指令表（D2 说的"把手命中排在 pickOne 之前"就是这一行的顺序）。
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    // 没有 viewport 就什么都没有：handlesRef 与 opsRef 由 paint effect 填，而它在
    // viewport === null 时直接 return（屏幕上是空的）。在这里返回假视口等于自欺。
    if (viewport === null) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const px = pointerPx(event.nativeEvent, canvas);
    if (px === null) return;
    const hit = pickHandle(handlesRef.current, px);
    if (hit !== null) {
      // D5：拖之前先选中，同一趟里做完。于是"拖的那面墙"与"红着的那面墙"是同一个表达式给的。
      select(hit.wallId);
      const point = requirePoint(log.document, hit.pointId, '端点');
      const atMm = { x: point.x, y: point.y };
      activeRef.current = true;
      setDrag({
        wallId: hit.wallId,
        end: hit.end,
        pointId: hit.pointId,
        atMm,
        fromPx: hit.atPx,
        cursorPx: px,
        targetMm: atMm,
        // S4 ①：按下那一发**不吸**（绝不走 `handleDropTarget`/`dropTargetOf`），但落点取
        // **真源现值** `atMm`，不是 `moveTargetOf` 的像素反算值（裁决 D1-A）。
        // 为什么原句"把手已经在原地，吸一下只会把 targetMm 挪回 atMm 之外的别处"是反的：
        // 像素反算是 `intPx(pxToMm(px))` 那种量化，对同一个 px 是确定性的 —— T5 时代"落点=
        // 反算值"所以原地重按必等，那条 noop 判据成立。但本任务把**松手落点**改成了吸附后的
        // 毫米（实测 `raw(toPx)={796,-3}` 而落点 `drop.mm={796,0}`，foot 档 distPx=0.328）
        // ⇒ 真源停在一枚**像素反算不可达**的整数毫米上 ⇒ 原地重按给回 `-3` ⇒ `onUp` 的
        // noop 判据不成立 ⇒ 发出一发没被 `derivesAfterMove` 校验过的几毫米移动（转 T7 差额①）
        // ⇒ 把直通墙族推歪 3mm ⇒ 派生层判成 star ⇒ paint effect 抛、React 树崩、`__dajiaDebug` 没了。
        handle: hit,
        drop: null,
      });
      return;
    }
    if (tool === 'wall') {
      // S2：拉墙时点选完全不生效 —— 既不 `pickOne` 也不 `clear()`。不清选中集是因为退出墙模式后
      // 用户期望看见的仍是刚才红着的那批构件；在这里清掉等于让"按一次 w"有隐蔽副作用。
      const field = fieldRef.current;
      // 两次调用喂同一对入参 ⇒ `start.mm` 与 `end.mm` 必然相同（`draftAtPress` 的定义就是
      // `dropTargetOf(v, px, null, field)`）。宁可多跑一次吸附，也不在 renderer 里手拼
      // `DropTarget`：那是第二条 px→mm 通路，D4 禁的东西。
      const start = draftAtPress(viewport, px, field);
      const seed: DraftWall = {
        storeyId,
        start,
        cursorPx: px,
        end: dropTargetOf(viewport, px, null, field),
        legal: false,
      };
      activeRef.current = true;
      // 按下即试跑：零长草稿的 `legal` 恒 false，屏幕上的临时线从第一发起就是"不许松手"的颜色语义。
      setDraft({ ...seed, legal: legalWallCreate(log.document, seed) });
      return;
    }
    const opHit = pickOne(opsRef.current, px);
    if (opHit === null) {
      clear();
      return;
    }
    if (event.shiftKey) toggle(opHit.ownerId);
    else select(opHit.ownerId);
  };

  // 中途与松手挂 window：拖出画布外也要继续画、也要能结束（元素级 handler 在指针离开后就收不到了，
  // 于是"临时线钉在屏幕上"是这类实现的标配 bug）。
  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      if (!activeRef.current || viewport === null) return;
      const canvas = canvasRef.current;
      if (canvas === null) return;
      const px = pointerPx(event, canvas);
      if (px === null) return;
      const s = useEditor.getState();
      const current = s.drag;
      if (current !== null) {
        // S4 ②：中途走 `handleDropTarget` —— 锚点与被排除的原地都从**按下那一把**把手身上取，
        // 与 `dragProbe` 里那一发是同一个函数、同一对入参，于是"探针给的毫米"与
        // "屏幕上真会落下的毫米"仍然是同一个纯函数的同一个输出。
        const drop = handleDropTarget(viewport, px, current.handle, fieldRef.current);
        setDrag({ ...current, cursorPx: px, targetMm: drop.mm, drop });
        return;
      }
      const currentDraft = s.draft;
      if (currentDraft !== null) {
        // 终点以起点为锚（正交/15° 只有相对起点才成立），并排掉起点坐标（否则吸自己、拖不开）。
        setDraft(moveDraft(s.log.document, currentDraft, viewport, px, fieldRef.current));
      }
    };
    const onUp = (): void => {
      if (!activeRef.current) return;
      activeRef.current = false;
      const s = useEditor.getState();
      const currentDraft = s.draft;
      if (currentDraft !== null) {
        setDraft(null);
        const before = pointCountOf(pointSnapshot(s.log.document, s.storeyId));
        const cmd = draftCommand(currentDraft, newWallDefaults(s.log.document, s.storeyId));
        if (cmd === null) {
          // 预言说不合法 ⇒ 一条命令都不发。这一支是 `--draw-shot` 里"拒绝就不留痕迹"那一步的凭据。
          createRef.current = {
            outcome: 'rejected',
            wallId: null,
            startId: null,
            endId: null,
            endMm: currentDraft.end.mm,
            pointCountBefore: before,
            pointCountAfter: before,
          };
          return;
        }
        dispatch(cmd);
        const after = useEditor.getState();
        const doc = after.log.document;
        // `lastCreatedWall` 的三条纪律之一：只在成功分支里**同步**读 `affected`，读完拿文档复核。
        const created =
          after.lastError === null ? lastCreatedWall(doc, after.log.affected, after.storeyId) : null;
        createRef.current = {
          // `failed` 而不是 `rejected`：命令已经发出去了，是真源抛的。`dispatch` 的 `legalDrop`
          // 缺位（D3/D6）在这里同样成立 —— 预言说行、真源说不行，那就是两边漂了，必须留一条能红的路。
          outcome: after.lastError === null && created !== null ? 'ok' : 'failed',
          wallId: created?.wallId ?? null,
          startId: created?.startId ?? null,
          endId: created?.endId ?? null,
          endMm: currentDraft.end.mm,
          pointCountBefore: before,
          pointCountAfter: pointCountOf(pointSnapshot(doc, after.storeyId)),
        };
        // 建完就选中它（D5 的入口唯一）：下一步"拖刚建的墙""删刚建的墙"都要它在选中集里，
        // 而把手只从选中集生成 —— 不选中的话屏幕上会出现一面没有把手的新墙。
        if (created !== null) select(created.wallId);
        return;
      }
      const current = s.drag;
      setDrag(null);
      if (current === null || viewport === null) return;
      // D4：零移动不发命令。否则每点一次把手都往撤销栈塞一步空操作，
      // 真东西就被埋了 —— spec 验收 2 要的是"连按撤销能看到一串串改动退回去"。
      if (current.targetMm.x === current.atMm.x && current.targetMm.y === current.atMm.y) {
        dropRef.current = {
          outcome: 'noop',
          wallId: current.wallId,
          end: current.end,
          targetMm: current.targetMm,
          pointMm: current.atMm,
        };
        return;
      }
      // 不预检 legalDrop（见 editorStore 那条注）：让真源判，抛错由 dispatch 的 catch 记。
      dispatch(wallMoveEndpoint({ wallId: current.wallId, end: current.end, ...current.targetMm }));
      const after = useEditor.getState();
      const point = requirePoint(after.log.document, current.pointId, '端点');
      dropRef.current = {
        outcome: after.lastError === null ? 'ok' : 'failed',
        wallId: current.wallId,
        end: current.end,
        targetMm: current.targetMm,
        pointMm: { x: point.x, y: point.y },
      };
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [viewport, dispatch, setDrag, setDraft, select]);

  // D7：Ctrl+Z / Ctrl+Shift+Z（mac 上 meta 同义）。挂在 window 而不是 canvas：
  // 快捷键不该要求"鼠标正好停在图上"。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'z' && event.key !== 'Z') return;
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const isRedo = event.shiftKey;
      if (isRedo) redo();
      else undo();
      const s = useEditor.getState();
      keySeqRef.current += 1;
      keyRef.current = {
        seq: keySeqRef.current,
        combo: isRedo ? 'Ctrl+Shift+Z' : 'Ctrl+Z',
        depth: s.log.depth,
        revision: s.revision,
        canUndo: s.log.canUndo,
        canRedo: s.log.canRedo,
        lastError: s.lastError,
      };
      // undo/redo 都不碰选中集（D7）：撤销的是文档，不是视图。
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]);

  // T6 的四发快捷键。与上面那发 `z` **分家成两个监听器**：那一路逐字不动（T5 的 R1–R7 与
  // `--edit-shot` 的 21 判据全压在它身上），而这一路每一发都碰工具态。两路各数各的 `seq`
  // （`keySeqRef` / `hotSeqRef`）：判据等的是"我这一路到过"，混在一个计数器上就分不清是哪一发。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const key = event.key;
      const isWall = key === 'w' || key === 'W';
      const isEscape = key === 'Escape';
      const isDelete = key === 'Delete' || key === 'Backspace';
      if (!isWall && !isEscape && !isDelete) return;
      event.preventDefault();
      // 全部状态从 `getState()` 现取，闭包不捕获任何会变的东西 ⇒ 依赖表留空是诚实的。
      const s = useEditor.getState();
      const sel = useSelection.getState();
      let combo: string;
      let outcome: DeleteOutcome | null = null;
      if (isWall) {
        combo = 'W';
        // 已经在墙模式就是空操作（`setTool` 给同一个值，zustand 照样换 state 对象，
        // 但 `tool` 引用不变 ⇒ 订阅者比的是 `s.tool` ⇒ 不重渲）。不清草稿：连按 w 不该吞手势。
        s.setTool('wall');
      } else if (isEscape) {
        combo = 'Escape';
        // `s` 是**这一发之前**的快照（`set()` 换的是 store 里的新对象），下面四个分支都读它：
        // 判的是"这一发该不该取消点什么"，不是"取消完了以后还剩什么"。
        if (s.draft !== null) s.setDraft(null);
        // 取消草稿后**留在**墙模式：Escape 的第一含义是"这一下不拉了"，不是"我要退出工具"。
        else if (s.tool === 'wall') s.setTool('select');
        // 不在墙模式也没有草稿：退回"什么都不选"，与点空白同一条语义。
        else sel.clear();
        // 按着指针时按 Escape ⇒ 手势当场作废：`activeRef` 不清的话，下一次 `onUp` 会拿
        // 一个已经作废的 `drag`/`draft` 再发一条命令（松手那一下本来不该有落点了）。
        if (s.drag !== null) s.setDrag(null);
        if (s.drag !== null || s.draft !== null) activeRef.current = false;
      } else {
        combo = key === 'Delete' ? 'Delete' : 'Backspace';
        const plan = planDelete(s.log.document, s.storeyId, s.tool, sel.ids);
        outcome = plan.outcome;
        if (plan.commands.length > 0) {
          s.dispatchBatch(plan.commands);
          // `deletedIds` 记的是**真源真的不再含有**的那些 id，不是"计划要发"的那些：
          // `dispatchBatch`（editorStore 的批处理循环）**第一条抛错就 break** ⇒ 一批 N>1 里
          // 后面的 id 会被报成"已删"而其实还在文档里，D2 的 `--draw-shot` 与 Task 8 拿它对账就错。
          // 复核走 S6 已经在用的同一口径：拿派发之后的新文档逐条问 `doc.get(id)`。
          // 剪枝在派发之后、读的是活 store（`wallDelete` 级联掉了谁只有真源知道）。
          const afterBatch = useEditor.getState();
          deleteRef.current.deletedIds = plan.candidateIds.filter(
            (id) => afterBatch.log.document.get(id) === undefined,
          );
        } else {
          // 四条出口里只有 'ok' 发命令。'empty' / 'ignored-in-wall-mode' / 'unsupported' 一律
          // 留一本空账 —— 判据据此分"上次删了东西"与"上次什么都没删"，而不是读一句中文。
          deleteRef.current.deletedIds = [];
        }
        deleteRef.current.unsupportedIds = [...plan.unsupported];
        const after = useEditor.getState();
        // 剪枝在**派发之后**、拿新文档问：`wallDelete` 级联掉的东西只有真源知道（口径见它注释）。
        const kept = pruneSelection(after.log.document, after.storeyId, useSelection.getState().ids);
        useSelection.getState().retain(kept);
        deleteRef.current.selectionAfterDelete = kept;
      }
      const after = useEditor.getState();
      hotSeqRef.current += 1;
      hotRef.current = {
        seq: hotSeqRef.current,
        combo,
        tool: after.tool,
        draftActive: after.draft !== null,
        deleteOutcome: outcome,
        depth: after.log.depth,
        revision: after.revision,
        lastError: after.lastError,
      };
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || viewport === null) return;
    const previous = window.__dajiaDebug;
    window.__dajiaDebug = (): DebugReport => {
      const ops = opsRef.current;
      const layers: Record<string, number> = {};
      for (const o of ops) layers[o.pen.layer] = (layers[o.pen.layer] ?? 0) + 1;
      const ctx = canvas.getContext('2d');
      // `s` 先取：第五个桶要拿**当下 store 里的光标**去量像素。这一句是整个判据的要害 ——
      // 位置取自 store（活的那一份），颜色取自屏幕（刷上屏的那一份），两者对不上就是"没跟手"。
      const s = useEditor.getState();
      // 光标来源两支：拖把手时读 `drag.cursorPx`（T5 的第五桶判据一字不动），拉墙时读
      // `draft.cursorPx`。两支都非空的那一帧不存在 —— 一个手势只会走一条路。
      const counted =
        ctx === null
          ? NO_PIXELS
          : countPixels(ctx, canvas, s.drag?.cursorPx ?? s.draft?.cursorPx ?? null);
      // 实测画布原点（页面空间）：探针点/把手点在画布空间，main 拿这个值做换算与 PASS 断言。
      const rect = canvas.getBoundingClientRect();
      // Task 8 那五格的唯一读者是判据，而判据要问的是"屏幕上真画了什么"：值由面板在自己
      // 提交后的 effect 里公布（见 `panels.tsx` 的 `panelReadout`）。这里**一律不重算** ——
      // 拿同一批纯函数再算一遍，"panelProps 与真源逐字相同"就变成同义反复。
      const panel = panelReadout();
      return {
        ops: ops.length,
        layers,
        nonBlankPx: counted.nonBlankPx,
        wPx: canvas.width,
        hPx: canvas.height,
        selectedIds: [...ids],
        selectedPx: counted.selectedPx,
        pick: probeTarget(ops, viewport),
        selectedAfterBlank: ids.size,
        canvasOriginPx: { x: rect.left, y: rect.top },
        revision: s.revision,
        depth: s.log.depth,
        canUndo: s.log.canUndo,
        canRedo: s.log.canRedo,
        lastError: s.lastError,
        handlePx: counted.handlePx,
        previewPx: counted.previewPx,
        previewNearCursorPx: counted.previewNearCursorPx,
        points: pointSnapshot(s.log.document, s.storeyId),
        edit: dragProbe(s.log.document, s.storeyId, ops, viewport),
        // 拖拽目标由 renderer 自己算（`handleDropTarget(...).mm`，S4 ② 之后与探针同源）：
        // 这一行让主进程能在**松手之前**看见它，于是"那一发 pointermove 到底进没进 store"
        // 是可等的，而不是只能从"落点不对"倒推。
        dragTargetMm: s.drag?.targetMm ?? null,
        dragCursorPx: s.drag?.cursorPx ?? null,
        lastDrop: dropRef.current,
        lastKeyEvent: keyRef.current,
        // ↓ T6 的 9 个。全部读 `s`（活的那一份）与 `ops`（刷上屏的那一份），不读闭包里的
        // `tool`/`draft` —— 闭包可能是上一帧的，而判据要的是"按下这一发之后"。
        tool: s.tool,
        draft: s.draft,
        snapMarkPx: counted.snapMarkPx,
        lastCreate: createRef.current,
        deletedIds: deleteRef.current.deletedIds,
        unsupportedIds: deleteRef.current.unsupportedIds,
        selectionAfterDelete: deleteRef.current.selectionAfterDelete,
        lastHotkey: hotRef.current,
        draw: wallProbe(s.log.document, s.storeyId, ops, viewport),
        // ↓ Task 8 棒 D1 的 5 个。五者**只**读 `panel`（面板在自己提交后的 effect 里公布的上屏值），
        // 这里一个都不重算：拿同一批纯函数再算一遍，"panelProps 与真源逐字相同"就成了同义反复。
        storeyTabs: panel.storeyTabs,
        panelWallId: panel.panelWallId,
        panelProps: panel.panelProps,
        lastTrial: panel.lastTrial,
        propsAfterEdit: panel.propsAfterEdit,
        // 直通 `panelReadout()`：这一格同样是面板上屏通路公布的账，这里一个都不重算。
        thicknessCommitAttempts: panel.thicknessCommitAttempts,
        // ↓ Task 8 棒 E 的 3 个。`viewport` 用闭包里那一份（ paint effect 与探针用的就是它，
        // 报告里的视口必须与报告里的像素同源），`storeyId` / `viewportStoreyId` 活读 `s`。
        storeyId: s.storeyId,
        viewport,
        viewportStoreyId: s.viewportStoreyId,
        prop: propProbe(s.log.document, s.storeyId, ops, viewport),
      };
    };
    return () => {
      window.__dajiaDebug = previous;
    };
  }, [viewport, ids, revision]);

  return (
    // 三格真布局（裁决 T8-3）：上 = 楼层 tab（32px），中左 = 画布，中右 = 属性面板（260px）。
    // 两个尺寸常量住在 `panels.tsx`（面板自己的口径），这里只摆格子 —— 于是画布原点
    // 从 (0,0) 变成 (0,32)，而 `pointerPx` 与 `canvasOriginPx` 都按实测值走（见那两处的注释）。
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
      }}
    >
      {canvasSizePx === null ? (
        // 第一帧还没量过画布：先按同一个 `STOREY_TAB_HEIGHT_PX` 占住这一栏，否则 `fit()` 量到的
        // 画布高度会把栏位吃掉，量完再渲染就来回抖一次（而闸门的原点判据读的是量完之后那一帧）。
        <div style={{ height: `${String(STOREY_TAB_HEIGHT_PX)}px`, flex: '0 0 auto' }} />
      ) : (
        <StoreyTabs widthPx={canvasSizePx.w} heightPx={canvasSizePx.h} />
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
        <div
          ref={canvasCellRef}
          style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}
        >
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            // 位置钉在格子左上角，**尺寸不交给格子**：CSS 宽高由 `fit()` 写死成与 `canvas.width`
            // 同一个整数（见那里），这样 `countPixels` 读的仍是 1 canvas px = 1 CSS px。
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              display: 'block',
              touchAction: 'none',
              cursor: 'crosshair',
            }}
          />
        </div>
        <PropPanel />
      </div>
    </div>
  );
}
