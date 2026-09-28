import { useEffect, useRef } from 'react';
import { requirePoint, wallMoveEndpoint } from '@dajia/core';
import {
  buildDrawList,
  dragHandlesOf,
  dragProbe,
  fitStorey,
  HANDLE_COLOR,
  HANDLE_RADIUS_PX,
  handleDropTarget,
  moveTargetOf,
  pickHandle,
  pickOne,
  PIXEL_CHANNEL_TOL,
  pointSnapshot,
  PREVIEW_COLOR,
  probeTarget,
  SELECTED,
  EMPTY_SNAP_FIELD,
  snapFieldOf,
  type DragHandle,
  type DragProbe,
  type DrawOp,
  type MoveTarget,
  type Pen,
  type PickProbe,
  type Px,
  type SnapField,
} from '@dajia/scene-2d';
import { useEditor } from './stores/editorStore';
import { useSelection } from './stores/selectionStore';

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
   * 差的就是这个值 —— 换算由 main 的 clickCanvasPx / 拖拽助手做，"它今天等于 (0,0)"
   * 由 --pick-shot / --edit-shot 的 origin PASS 行断言，不靠 body margin 归零默默兜底。
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
  dragTargetMm: MoveTarget | null;
  /** 拖拽进行中 store 里那一发**已处理**的光标像素。主进程拿它对照"我到底发了哪个像素"：
   *  `previewNearCursorPx` 量的就是 store 自报的光标，自洽 ⇒ 光标落后一帧它也照样绿。 */
  dragCursorPx: Px | null;
  lastDrop: DropReport | null;
  lastKeyEvent: KeyEventReport | null;
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

/**
 * 抗锯齿让线边缘是渐变而不是纯色，所以按通道 ±TOL 数，不比 RGB 全等（T4 的口径）。
 * 容差取自 `handles.ts` 的 `PIXEL_CHANNEL_TOL`：判据与画家不许各拿一个数 ——
 * `handles.test.ts` 最后那条"三种颜色互相分得开"用的也是它。
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

interface Buckets {
  nonBlankPx: number;
  selectedPx: number;
  handlePx: number;
  previewPx: number;
  previewNearCursorPx: number;
}

/**
 * 五个桶一次扫完。分开扫要五次 `getImageData`（每次都是跨进程边界的拷贝），一次扫是同一件事的几倍便宜。
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
  }
  return out;
}

/**
 * 画布像素坐标。`offsetX/offsetY` 相对**事件目标**，而目标在窗口级监听下仍然是命中到的那块
 * canvas（它铺满内容区、1 canvas px = 1 CSS px，没有 CSS 缩放掺进来），所以它与 `DrawOp`
 * 的坐标同一单位、同一原点 —— 指针拖出画布外时目标会变成 `<html>`，那时 `offsetX` 就不是
 * 画布坐标了，但 `moveTargetOf` 拿到的仍是同一张屏幕上的数，最多是落点偏一点，不会算错单位。
 * 非有限值返回 null：`quantizeMm` 会抛 RangeError，而那一发既没什么可写、也没什么可撤销。
 */
function pointerPx(event: PointerEvent): Px | null {
  const x = Number.isFinite(event.offsetX) ? event.offsetX : event.clientX;
  const y = Number.isFinite(event.offsetY) ? event.offsetY : event.clientY;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

export function PlanCanvas(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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

  const log = useEditor((s) => s.log);
  const storeyId = useEditor((s) => s.storeyId);
  const viewport = useEditor((s) => s.viewport);
  const revision = useEditor((s) => s.revision);
  const drag = useEditor((s) => s.drag);
  const setViewport = useEditor((s) => s.setViewport);
  const setDrag = useEditor((s) => s.setDrag);
  const dispatch = useEditor((s) => s.dispatch);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const ids = useSelection((s) => s.ids);
  const select = useSelection((s) => s.select);
  const toggle = useSelection((s) => s.toggle);
  const clear = useSelection((s) => s.clear);

  // 页面归位（真窗口实测后补的一行）：默认 body margin 8px 会把画布原点推到 (8,8)，
  // 而探针点/把手点的口径是画布坐标 —— 差值恰好 8px，等于吃光 PICK_TOL_PX，同一判据在
  // 真窗口里间歇性"点了没反应"（T4 实测 12 跑 5 红）。归零仍是必需的（它同时治了 innerWidth
  // 画布的溢出），但它**不再是坐标系的前提**：前提由 __dajiaDebug 实测的 canvasOriginPx 明说，
  // 闸门有 PASS 行断言它等于 (0,0)，拖拽助手也照 measured origin 换算（见 main）。
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
      const wPx = Math.max(1, Math.floor(window.innerWidth));
      const hPx = Math.max(1, Math.floor(window.innerHeight));
      const canvas = canvasRef.current;
      if (canvas !== null) {
        canvas.width = wPx;
        canvas.height = hPx;
        canvas.style.width = `${String(wPx)}px`;
        canvas.style.height = `${String(hPx)}px`;
      }
      // 视口只在挂载、换层、窗口改尺寸这三件事上重算，**不跟着重渲染重算**。
      // 依赖里不写 `log`：`log` 是可变类实例、引用永不变，写进依赖挡不住任何东西 ——
      // 真正会咬人的是下面这句 `log.document` 是个**活读**的 getter：窗口改尺寸那一发
      // 触发 `fit()`，算的是**当时**的文档，于是中途改过坐标之后再来一发 resize，
      // 整张图按新边界重缩放，之前算定的探针像素全体失效（实测同一把手从 (253,74)
      // 漂到 (332,75)，第 7 步「原地松手」按到了空白）。闸门侧由 `waitForLayoutSettled`
      // 把 resize 收敛掉，这里则由"要当下的文档就从 store 一次性取"保证读到的不是陈旧闭包。
      // 换层与改尺寸才是重算视口的两个真实理由。
      setViewport(fitStorey(useEditor.getState().log.document, storeyId, wPx, hPx, 60));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [storeyId, setViewport]);

  // 一条绘制通路：指令表 → 把手 → 临时线，同一个 effect、同一次 ctx 获取。
  // `revision` 进了依赖却没被读：它是扳机不是数据（见 editorStore 的 D6 注释）。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || viewport === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const ops = buildDrawList(log.document, storeyId, viewport, { ids });
    opsRef.current = ops;
    paint(ctx, ops);
    // 场与指令表在同一趟里取：指针事件的靶子、吸附的候选，全都来自刚刷上屏那一份几何。
    fieldRef.current = snapFieldOf(log.document, storeyId);
    const handles = dragHandlesOf(log.document, storeyId, { ids }, viewport);
    handlesRef.current = handles;
    paintHandles(ctx, handles);
    if (drag !== null) paintPreview(ctx, drag.fromPx, drag.cursorPx);
  }, [log, storeyId, viewport, revision, ids, drag]);

  // 按下：先问把手，再问指令表（D2 说的"把手命中排在 pickOne 之前"就是这一行的顺序）。
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    // 没有 viewport 就什么都没有：handlesRef 与 opsRef 由 paint effect 填，而它在
    // viewport === null 时直接 return（屏幕上是空的）。在这里返回假视口等于自欺。
    if (viewport === null) return;
    const px = pointerPx(event.nativeEvent);
    if (px === null) return;
    const hit = pickHandle(handlesRef.current, px);
    if (hit !== null) {
      // D5：拖之前先选中，同一趟里做完。于是"拖的那面墙"与"红着的那面墙"是同一个表达式给的。
      select(hit.wallId);
      const point = requirePoint(log.document, hit.pointId, '端点');
      const target = moveTargetOf(viewport, px);
      activeRef.current = true;
      setDrag({
        wallId: hit.wallId,
        end: hit.end,
        pointId: hit.pointId,
        atMm: { x: point.x, y: point.y },
        fromPx: hit.atPx,
        cursorPx: px,
        targetMm: target,
        // S4 ①：按下那一发**不吸**。把手已经在原地，吸一下只会把 `targetMm` 挪回 `atMm`
        // 之外的别处，于是"零移动 ⇒ noop"那条判据（D4）会在第一发上就判错。
        handle: hit,
        drop: null,
      });
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
      const px = pointerPx(event);
      if (px === null) return;
      const s = useEditor.getState();
      const current = s.drag;
      if (current === null) return;
      // S4 ②：中途走 `handleDropTarget` —— 锚点与被排除的原地都从**按下那一把**把手身上取，
      // 与 `dragProbe` 里那一发是同一个函数、同一对入参，于是"探针给的毫米"与
      // "屏幕上真会落下的毫米"仍然是同一个纯函数的同一个输出。
      const drop = handleDropTarget(viewport, px, current.handle, fieldRef.current);
      setDrag({ ...current, cursorPx: px, targetMm: drop.mm, drop });
    };
    const onUp = (): void => {
      if (!activeRef.current) return;
      activeRef.current = false;
      const s = useEditor.getState();
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
  }, [viewport, dispatch, setDrag]);

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
      const counted =
        ctx === null ? NO_PIXELS : countPixels(ctx, canvas, s.drag?.cursorPx ?? null);
      // 实测画布原点（页面空间）：探针点/把手点在画布空间，main 拿这个值做换算与 PASS 断言。
      const rect = canvas.getBoundingClientRect();
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
        // 拖拽目标由 renderer 自己算（`moveTargetOf(viewport, px)`）：这一行让主进程能在
        // **松手之前**看见它，于是"那一发 pointermove 到底进没进 store"是可等的，而不是
        // 只能从"落点不对"倒推。
        dragTargetMm: s.drag?.targetMm ?? null,
        dragCursorPx: s.drag?.cursorPx ?? null,
        lastDrop: dropRef.current,
        lastKeyEvent: keyRef.current,
      };
    };
    return () => {
      window.__dajiaDebug = previous;
    };
  }, [viewport, ids, revision]);

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={onPointerDown}
      style={{ display: 'block', touchAction: 'none', cursor: 'crosshair' }}
    />
  );
}
