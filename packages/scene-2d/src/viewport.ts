import { vec, type Aabb, type Vec2 } from '@dajia/core';

/** 屏幕像素点。y 朝下，与毫米（y 朝上）相反 —— 翻转只发生在这一层。 */
export interface Px {
  readonly x: number;
  readonly y: number;
}

/**
 * 视口 = 缩放 + 平移。浮点只许活在屏幕侧：任何要写回命令的坐标必须先过 quantizeMm。
 * origin 是「屏幕左上角那一像素对应的毫米点」，用中心构造（viewportOf 的 center），
 * 因为"以视口中心为焦点"是打开图纸时的默认，而 origin 是它的派生量。
 */
export interface Viewport {
  readonly pxPerMm: number;
  readonly origin: Vec2;
  readonly widthPx: number;
  readonly heightPx: number;
}

const MIN_PX_PER_MM = 1e-6;
const MAX_PX_PER_MM = 1e4;

function requireFinite(label: string, n: number): void {
  if (!Number.isFinite(n)) throw new RangeError(`${label} 必须是有限数，收到 ${String(n)}`);
}

function assertScale(label: string, pxPerMm: number): void {
  requireFinite(label, pxPerMm);
  if (pxPerMm < MIN_PX_PER_MM || pxPerMm > MAX_PX_PER_MM) {
    throw new RangeError(`${label} 必须在 [${MIN_PX_PER_MM}, ${MAX_PX_PER_MM}] px/mm 之间，收到 ${pxPerMm}`);
  }
}

function assertSize(widthPx: number, heightPx: number): void {
  requireFinite('widthPx', widthPx);
  requireFinite('heightPx', heightPx);
  if (widthPx <= 0 || heightPx <= 0) {
    throw new RangeError(`视口尺寸必须为正，收到 ${widthPx}×${heightPx}`);
  }
}

export function viewportOf(
  widthPx: number,
  heightPx: number,
  opts: { pxPerMm?: number; center?: Vec2 } = {},
): Viewport {
  assertSize(widthPx, heightPx);
  const pxPerMm = opts.pxPerMm ?? 0.1;
  assertScale('pxPerMm', pxPerMm);
  const center = opts.center ?? vec(0, 0);
  return {
    pxPerMm,
    // center 是视口中心的毫米点：左上角 = 中心往 -x 走半宽、往 +y 走半高（y 朝上）
    origin: vec(center.x - widthPx / 2 / pxPerMm, center.y + heightPx / 2 / pxPerMm),
    widthPx,
    heightPx,
  };
}

export function mmToPx(v: Viewport, p: Vec2): Px {
  return { x: (p.x - v.origin.x) * v.pxPerMm, y: (v.origin.y - p.y) * v.pxPerMm };
}

export function pxToMm(v: Viewport, p: Px): Vec2 {
  return vec(v.origin.x + p.x / v.pxPerMm, v.origin.y - p.y / v.pxPerMm);
}

/**
 * 平移视口：`dPx` 是**指针移动量**，图跟手 —— 同一个毫米点在屏幕上移动 `dPx`。
 * 于是 x 用减（原点在世界里往左），y 用加（屏幕 y 轴朝下，`mmToPx` 里已经翻过一次，
 * 这里再翻就变成"往右拖图往左走"）。约定写在函数上而不是只写在测试标题里：
 * 后面任何接拖拽平移的代码都只能有一种解法。
 */
export function panBy(v: Viewport, dPx: Px): Viewport {
  requireFinite('pan.dx', dPx.x);
  requireFinite('pan.dy', dPx.y);
  return {
    ...v,
    origin: vec(v.origin.x - dPx.x / v.pxPerMm, v.origin.y + dPx.y / v.pxPerMm),
  };
}

/**
 * 以 anchorPx 为焦点缩放。锚点下的毫米点必须原地不动 —— 忘了重算 origin 就是
 * "一缩放图就飘走"，那是编辑器最刺眼的 bug，所以它由测试单独钉。
 */
export function zoomAt(v: Viewport, anchorPx: Px, factor: number): Viewport {
  requireFinite('zoom.factor', factor);
  if (factor <= 0) throw new RangeError(`缩放因子必须为正，收到 ${factor}`);
  const anchorMm = pxToMm(v, anchorPx);
  const pxPerMm = v.pxPerMm * factor;
  assertScale('zoom.pxPerMm', pxPerMm);
  const next: Viewport = { ...v, pxPerMm };
  return {
    ...next,
    origin: vec(anchorMm.x - anchorPx.x / pxPerMm, anchorMm.y + anchorPx.y / pxPerMm),
  };
}

/**
 * 把 box 完整装进视口，四周留 padPx 边距。取两边的**较小**缩放：
 * 取大就有一条边被切掉，而"图被切掉一角"在平面图上看起来像房子本来就只有那么大。
 * 留白吃满时抛错而不是静默产出负的可用区 —— 后者会算出负的 pxPerMm。
 */
export function fitViewport(widthPx: number, heightPx: number, box: Aabb, padPx: number): Viewport {
  assertSize(widthPx, heightPx);
  requireFinite('padPx', padPx);
  if (padPx < 0) throw new RangeError(`padPx 不许为负，收到 ${padPx}`);
  const wMm = box.maxX - box.minX;
  const hMm = box.maxY - box.minY;
  if (!(wMm > 0) || !(hMm > 0)) {
    throw new RangeError(`fitViewport 需要非零包围盒，收到 ${wMm}×${hMm}`);
  }
  const availW = widthPx - padPx * 2;
  const availH = heightPx - padPx * 2;
  if (availW <= 0 || availH <= 0) {
    throw new RangeError(`padPx=${padPx} 把 ${widthPx}×${heightPx} 的视口留白吃光了`);
  }
  const pxPerMm = Math.min(availW / wMm, availH / hMm);
  assertScale('fitViewport.pxPerMm', pxPerMm);
  return viewportOf(widthPx, heightPx, {
    pxPerMm,
    center: vec((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2),
  });
}
