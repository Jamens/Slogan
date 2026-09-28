import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { vec, type Aabb } from '@dajia/core';
import {
  fitViewport,
  mmToPx,
  panBy,
  pxToMm,
  viewportOf,
  zoomAt,
  type Viewport,
} from '@dajia/scene-2d';

/** 亚微米容差：浮点像素换算的误差量级远小于此，真写错时差的是毫米级。 */
const TOL_MM = 1e-6;
const TOL_PX = 1e-9;

const nearMm = (a: { x: number; y: number }, b: { x: number; y: number }): void => {
  expect(Math.abs(a.x - b.x)).toBeLessThan(TOL_MM);
  expect(Math.abs(a.y - b.y)).toBeLessThan(TOL_MM);
};

describe('视口仿射', () => {
  it('原点在左上角时：x 同向、y 翻转、按 pxPerMm 缩放', () => {
    const v = viewportOf(1000, 800, { pxPerMm: 0.5, center: vec(0, 0) });
    // center 是视口中心的毫米点；中心在 (0,0) 时左上角是 (-1000, 800) mm
    expect(mmToPx(v, vec(0, 0))).toEqual({ x: 500, y: 400 });
    expect(mmToPx(v, vec(100, 0)).x).toBeCloseTo(550, 9);
    expect(mmToPx(v, vec(0, 100)).y).toBeCloseTo(350, 9); // y 朝上 → 屏幕 y 变小
  });

  it('pxToMm ∘ mmToPx 还原同一个毫米点', () => {
    const v = viewportOf(1234, 567, { pxPerMm: 0.137, center: vec(4321, 6543) });
    nearMm(pxToMm(v, mmToPx(v, vec(1234.5, -678.25))), vec(1234.5, -678.25));
  });

  it('panBy 是纯平移：屏幕坐标整体加上位移（"抓住图拖"= 图跟手），不碰缩放', () => {
    const v = viewportOf(1000, 800, { pxPerMm: 0.25, center: vec(0, 0) });
    const moved = panBy(v, { x: 40, y: -25 });
    const p = vec(800, 300);
    // 图跟手：指针向右下走 dPx，同一个毫米点就朝 dPx 方向移动（y 轴朝下为正，与 mmToPx 同向）。
    // 这一句同时钉死了两个候选符号：origin 用减、y 用加，任何一处反过来这里就红。
    expect(mmToPx(moved, p).x).toBeCloseTo(mmToPx(v, p).x + 40, 9);
    expect(mmToPx(moved, p).y).toBeCloseTo(mmToPx(v, p).y - 25, 9);
    expect(moved.pxPerMm).toBe(v.pxPerMm);
    // 换的是"哪一毫米在左上角"，不是世界：向右拖 40px ⇒ 原点在世界里左移 40/pxPerMm 毫米。
    expect(moved.origin.x).toBeCloseTo(v.origin.x - 40 / 0.25, 9);
    expect(moved.origin.y).toBeCloseTo(v.origin.y - 25 / 0.25, 9);
  });

  it('zoomAt 之后，锚点那一像素下的毫米点没换（这是拖拽缩放的前提）', () => {
    const v = viewportOf(1000, 800, { pxPerMm: 0.2, center: vec(5000, 3000) });
    const anchor = { x: 731, y: 208 };
    const before = pxToMm(v, anchor);
    for (const f of [2, 0.5, 1.7, 0.031]) {
      nearMm(pxToMm(zoomAt(v, anchor, f), anchor), before);
    }
  });

  it('zoomAt 改的是 pxPerMm，不是别的', () => {
    const v = viewportOf(1000, 800, { pxPerMm: 0.2, center: vec(0, 0) });
    expect(zoomAt(v, { x: 500, y: 400 }, 2).pxPerMm).toBeCloseTo(0.4, 12);
  });

  it('fitViewport 把整盒装进视口并留出 padPx，且不许放大到超出任一边', () => {
    const box: Aabb = { minX: 0, minY: 0, maxX: 8000, maxY: 6000 };
    const v = fitViewport(900, 700, box, 40);
    for (const corner of [vec(0, 0), vec(8000, 0), vec(0, 6000), vec(8000, 6000)]) {
      const p = mmToPx(v, corner);
      expect(p.x).toBeGreaterThanOrEqual(40 - TOL_PX);
      expect(p.x).toBeLessThanOrEqual(900 - 40 + TOL_PX);
      expect(p.y).toBeGreaterThanOrEqual(40 - TOL_PX);
      expect(p.y).toBeLessThanOrEqual(700 - 40 + TOL_PX);
    }
    // 取小边：高 6000mm 要落在 620px 内 → 上限 620/6000，而不是宽边的 820/8000
    expect(v.pxPerMm).toBeLessThanOrEqual(620 / 6000 + 1e-12);
    expect(v.pxPerMm).toBeGreaterThan(0.1);
  });

  it('退化输入一律抛，不产出 NaN 视口', () => {
    expect(() => viewportOf(0, 800)).toThrow(RangeError);
    expect(() => viewportOf(1000, -1)).toThrow(RangeError);
    expect(() => viewportOf(1000, 800, { pxPerMm: 0 })).toThrow(RangeError);
    expect(() => viewportOf(1000, 800, { pxPerMm: Number.NaN })).toThrow(RangeError);
    expect(() => zoomAt(viewportOf(1000, 800), { x: 0, y: 0 }, 0)).toThrow(RangeError);
    expect(() => zoomAt(viewportOf(1000, 800), { x: 0, y: 0 }, -2)).toThrow(RangeError);
    expect(() => fitViewport(900, 700, { minX: 0, minY: 0, maxX: 0, maxY: 0 }, 40)).toThrow(RangeError);
    expect(() => fitViewport(80, 700, { minX: 0, minY: 0, maxX: 8000, maxY: 6000 }, 400)).toThrow(RangeError);
  });

  it('属性：任意合法视口下 round-trip 稳定在亚微米', () => {
    const arbViewport: fc.Arbitrary<Viewport> = fc
      .record({
        w: fc.integer({ min: 1, max: 8192 }),
        h: fc.integer({ min: 1, max: 8192 }),
        pxPerMm: fc.double({ min: 0.005, max: 200, noNaN: true }),
        cx: fc.integer({ min: -1_000_000, max: 1_000_000 }),
        cy: fc.integer({ min: -1_000_000, max: 1_000_000 }),
      })
      .map((r) => viewportOf(r.w, r.h, { pxPerMm: r.pxPerMm, center: vec(r.cx, r.cy) }));

    fc.assert(
      fc.property(
        arbViewport,
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        (v, x, y) => {
          const back = pxToMm(v, mmToPx(v, vec(x, y)));
          // 相对容差：1e6 mm 量级上浮点像素的绝对误差不可能压到 1e-6
          expect(Math.abs(back.x - x)).toBeLessThan(Math.max(1e-6, Math.abs(x) * 1e-9));
          expect(Math.abs(back.y - y)).toBeLessThan(Math.max(1e-6, Math.abs(y) * 1e-9));
        },
      ),
      { numRuns: 500 },
    );
  });

  it('属性：zoomAt 的锚点不变式对任意锚点与因子成立', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 4096 }),
        fc.integer({ min: 100, max: 4096 }),
        fc.double({ min: 0.01, max: 50, noNaN: true }),
        fc.double({ min: 0.02, max: 50, noNaN: true }),
        (w, h, pxPerMm, factor) => {
          const v = viewportOf(w, h, { pxPerMm, center: vec(0, 0) });
          const anchor = { x: w / 3, y: h / 2 };
          const before = pxToMm(v, anchor);
          const after = pxToMm(zoomAt(v, anchor, factor), anchor);
          expect(Math.abs(after.x - before.x)).toBeLessThan(1e-3);
          expect(Math.abs(after.y - before.y)).toBeLessThan(1e-3);
        },
      ),
      { numRuns: 500 },
    );
  });
});
