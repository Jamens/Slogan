import { useEffect, useRef } from 'react';
import {
  SELECTED,
  buildDrawList,
  fitStorey,
  pickOne,
  probeTarget,
  type DrawOp,
  type Pen,
  type PickProbe,
} from '@dajia/scene-2d';
import { useEditor } from './stores/editorStore';
import { useSelection } from './stores/selectionStore';

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
   * `pick` 里的 clickPx/blankPx 是**画布坐标空间**（相对画布原点）；sendInputEvent 吃的是
   * 页面空间。两套空间差的就是这个值 —— 换算由 main 的 clickCanvasPx 做，断言
   * "今天它等于 (0,0)" 由 --pick-shot 的 origin PASS 行做，不靠 body margin 归零默默兜底。
   */
  canvasOriginPx: { x: number; y: number };
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
const CHANNEL_TOL = 40;

/** 选中色从 scene-2d 的常量解析，不在这里重抄一遍 hex —— 改了常量这里跟着变，判据不漂。 */
function rgbOf(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

const [SEL_R, SEL_G, SEL_B] = rgbOf(SELECTED);

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

/** 抗锯齿让选中线边缘是渐变而不是纯色，所以按通道 ±40 数，不比 RGB 全等。 */
function countPixels(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
): { nonBlankPx: number; selectedPx: number } {
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let nonBlankPx = 0;
  let selectedPx = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    if (r < 250 || g < 250 || b < 250) nonBlankPx += 1;
    if (
      Math.abs(r - SEL_R) <= CHANNEL_TOL &&
      Math.abs(g - SEL_G) <= CHANNEL_TOL &&
      Math.abs(b - SEL_B) <= CHANNEL_TOL
    ) {
      selectedPx += 1;
    }
  }
  return { nonBlankPx, selectedPx };
}

export function PlanCanvas(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 指针事件的靶子必须是**刷上屏的那一份**指令表，不是现算的副本：副本与屏幕一旦漂开，
  // "点得中的就是画出来的"这条就只剩注释还在守着。
  const opsRef = useRef<readonly DrawOp[]>([]);
  const log = useEditor((s) => s.log);
  const storeyId = useEditor((s) => s.storeyId);
  const viewport = useEditor((s) => s.viewport);
  const setViewport = useEditor((s) => s.setViewport);
  const ids = useSelection((s) => s.ids);
  const select = useSelection((s) => s.select);
  const toggle = useSelection((s) => s.toggle);
  const clear = useSelection((s) => s.clear);

  // 页面归位（真窗口实测后补的一行）：默认 body margin 8px 会把画布原点推到 (8,8)，
  // 而探针点/空白点的口径是画布坐标 —— 差值恰好 8px，等于吃光 PICK_TOL_PX，同一判据在
  // 真窗口里间歇性"点了没反应"（实测 12 跑 5 红，红全卡在第一处 waitUntil）。
  // 归零仍是必需的（它同时治了 innerWidth 画布的溢出），但它**不再是坐标系的前提**：
  // 前提现在由 __dajiaDebug 实测的 canvasOriginPx 明说，闸门有一行 PASS 断言它等于
  // (0,0)。谁再往路上加 margin/平移，红的是那一行，而不是随 uuid 漂移的偶发失灵。
  // cleanup 恢复原值：样式突变不许"改了没人还"。
  useEffect(() => {
    const previous = document.body.style.margin;
    document.body.style.margin = '0';
    return () => {
      document.body.style.margin = previous;
    };
  }, []);

  // 尺寸 → 视口。尺寸仍取 innerWidth：没有 CSS 缩放参与，视口尺寸就是窗口内容区，
  // shot 的期望像素数不随布局漂。原点则**必须实测**（见 debug 钩子里的 canvasOriginPx）：
  // 尺寸不必问 rect，坐标换算要问 —— 两套空间是否重合从此是测出来的，不是注释约定的。
  // （拖拽/缩放交互在 T5 才接管这条线。）
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
      setViewport(fitStorey(log.document, storeyId, wPx, hPx, 60));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [log, storeyId, setViewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || viewport === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const ops = buildDrawList(log.document, storeyId, viewport, { ids });
    opsRef.current = ops;
    paint(ctx, ops);
  }, [log, storeyId, viewport, ids]);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    // offsetX/offsetY 就是画布像素：canvas.width === style.width（上面那两行），
    // 没有 CSS 缩放掺进来，所以屏幕坐标与 DrawOp 的坐标同一单位。
    // DPR≠1 时图会糊，但点不偏 —— sendInputEvent 的 x/y 是 DIP，等于这里的 CSS 像素。
    const hit = pickOne(opsRef.current, {
      x: event.nativeEvent.offsetX,
      y: event.nativeEvent.offsetY,
    });
    if (hit === null) {
      clear();
      return;
    }
    if (event.shiftKey) toggle(hit.ownerId);
    else select(hit.ownerId);
  };

  // 钩子必须在"这一帧已经刷完"之后存在：effect 顺序 = 声明顺序，paint 在前、这条在后。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || viewport === null) return;
    const previous = window.__dajiaDebug;
    window.__dajiaDebug = (): DebugReport => {
      // 读 opsRef（屏幕上那张图）而不是重算一份：重算的那份不知道选中集，
      // T3 这么写没问题（那时选中不上屏），T4 之后再重算就是在测另一张图。
      const ops = opsRef.current;
      const layers: Record<string, number> = {};
      for (const o of ops) layers[o.pen.layer] = (layers[o.pen.layer] ?? 0) + 1;
      const ctx = canvas.getContext('2d');
      const counted =
        ctx === null ? { nonBlankPx: 0, selectedPx: 0 } : countPixels(ctx, canvas);
      // 实测画布原点（页面空间）：探针点在画布空间，闸门拿这个值做换算与断言。
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
      };
    };
    return () => {
      window.__dajiaDebug = previous;
    };
  }, [viewport, ids]);

  return <canvas ref={canvasRef} onPointerDown={onPointerDown} style={{ display: 'block' }} />;
}
