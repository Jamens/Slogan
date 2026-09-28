import { useEffect, useRef } from 'react';
import { buildDrawList, fitStorey, type DrawOp, type Pen } from '@dajia/scene-2d';
import { useEditor } from './stores/editorStore';

export interface DebugReport {
  ops: number;
  layers: Record<string, number>;
  nonBlankPx: number;
  wPx: number;
  hPx: number;
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

export function PlanCanvas(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const log = useEditor((s) => s.log);
  const storeyId = useEditor((s) => s.storeyId);
  const viewport = useEditor((s) => s.viewport);
  const setViewport = useEditor((s) => s.setViewport);

  // 尺寸 → 视口。刻意不用 getBoundingClientRect：没有 CSS 参与，视口尺寸就是窗口
  // 内容区，shot 的期望像素数才不会随布局漂。（拖拽/缩放交互在 T5 才接管这条线。）
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
    paint(ctx, buildDrawList(log.document, storeyId, viewport));
  }, [log, storeyId, viewport]);

  // 钩子必须在"这一帧已经刷完"之后存在：effect 顺序 = 声明顺序，paint 在前、这条在后。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || viewport === null) return;
    const previous = window.__dajiaDebug;
    window.__dajiaDebug = (): DebugReport => {
      const ops = buildDrawList(log.document, storeyId, viewport);
      const layers: Record<string, number> = {};
      for (const o of ops) layers[o.pen.layer] = (layers[o.pen.layer] ?? 0) + 1;
      let nonBlankPx = 0;
      const ctx = canvas.getContext('2d');
      if (ctx !== null) {
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        for (let i = 0; i < data.length; i += 4) {
          if (data[i]! < 250 || data[i + 1]! < 250 || data[i + 2]! < 250) nonBlankPx += 1;
        }
      }
      return { ops: ops.length, layers, nonBlankPx, wPx: canvas.width, hPx: canvas.height };
    };
    return () => {
      window.__dajiaDebug = previous;
    };
  }, [log, storeyId, viewport]);

  return <canvas ref={canvasRef} style={{ display: 'block' }} />;
}
