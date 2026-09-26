import { describe, expect, it } from 'vitest';
import {
  PARALLEL_EPS,
  add,
  advance,
  angleBetween,
  angleOf,
  cross,
  dot,
  intersectLines,
  isParallel,
  length,
  normalize,
  perp,
  scale,
  sinOfAngle,
  sub,
  vec,
} from '@dajia/core';

describe('vec 基本运算', () => {
  it('加减与数乘逐分量', () => {
    expect(add(vec(1, 2), vec(3, 4))).toEqual({ x: 4, y: 6 });
    expect(sub(vec(1, 2), vec(3, 4))).toEqual({ x: -2, y: -2 });
    expect(scale(vec(2, -3), 2.5)).toEqual({ x: 5, y: -7.5 });
  });

  it('点积与叉积：叉积符号区分左右侧', () => {
    expect(dot(vec(2, 3), vec(4, -1))).toBe(8 - 3);
    expect(cross(vec(1, 0), vec(0, 1))).toBe(1);
    expect(cross(vec(0, 1), vec(1, 0))).toBe(-1);
  });

  it('perp 是逆时针 90°', () => {
    expect(perp(vec(1, 0))).toEqual({ x: 0, y: 1 });
    expect(perp(vec(0, 1))).toEqual({ x: -1, y: 0 });
  });
});

describe('长度与方向', () => {
  it('length 走 hypot，斜边取整不丢', () => {
    expect(length(vec(3, 4))).toBe(5);
    expect(length(vec(-3, -4))).toBe(5);
  });

  it('normalize 保长度 1', () => {
    const u = normalize(vec(3, 4));
    expect(u.x).toBeCloseTo(0.6, 12);
    expect(u.y).toBeCloseTo(0.8, 12);
    expect(length(u)).toBeCloseTo(1, 12);
  });

  it('零向量归一化直接抛，不返回 NaN', () => {
    expect(() => normalize(vec(0, 0))).toThrow(RangeError);
    expect(() => normalize(vec(0, 0))).toThrow(/零向量/);
  });

  it('angleOf 与 angleBetween 取主值与无向角', () => {
    expect(angleOf(vec(1, 0))).toBe(0);
    expect(angleOf(vec(0, 1))).toBeCloseTo(Math.PI / 2, 12);
    expect(angleBetween(vec(1, 0), vec(0, 1))).toBeCloseTo(Math.PI / 2, 12);
    expect(angleBetween(vec(1, 0), vec(-1, 0))).toBeCloseTo(Math.PI, 12);
    // 无向：反向取钝角的一侧，结果落在 [0, π]
    expect(angleBetween(vec(1, 0), vec(0, -1))).toBeCloseTo(Math.PI / 2, 12);
    expect(angleBetween(vec(2, 4), vec(1, 2))).toBe(0);
  });

  it('advance 沿单位向量前移，负值后退', () => {
    expect(advance(vec(10, 10), vec(1, 0), 5)).toEqual({ x: 15, y: 10 });
    expect(advance(vec(10, 10), vec(1, 0), -2.5)).toEqual({ x: 7.5, y: 10 });
  });
});

describe('平行判定与直线求交', () => {
  it('sinOfAngle 对零向量直接抛，不折叠成"平行"', () => {
    expect(() => sinOfAngle(vec(0, 0), vec(1, 0))).toThrow(RangeError);
    expect(() => sinOfAngle(vec(0, 0), vec(1, 0))).toThrow(/零向量/);
    expect(() => sinOfAngle(vec(1, 0), vec(0, 0))).toThrow(/零向量/);
    expect(sinOfAngle(vec(1, 0), vec(0, 2))).toBeCloseTo(1, 12);
    expect(sinOfAngle(vec(1, 0), vec(-1, 0))).toBe(0);
  });

  it('isParallel 同向与反向都算平行', () => {
    expect(isParallel(vec(1, 0), vec(5, 0))).toBe(true);
    expect(isParallel(vec(1, 0), vec(-5, 0))).toBe(true);
    expect(isParallel(vec(1, 0), vec(0, 5))).toBe(false);
  });

  it('isParallel 是相对判据：大坐标下不误判', () => {
    // 叉积绝对值很大（3e5），但 sin 只有 1e-6 > PARALLEL_EPS → 不平行
    expect(isParallel(vec(3e5, 0), vec(3e5, 0.3))).toBe(false);
    // sin ≈ 1e-12 < PARALLEL_EPS → 平行
    expect(isParallel(vec(3e5, 0), vec(3e5, 3e-7))).toBe(true);
  });

  it('intersectLines 求交点', () => {
    const hit = intersectLines(vec(0, 0), vec(1, 0), vec(2, 3), vec(0, -1));
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(2, 12);
    expect(hit!.y).toBeCloseTo(0, 12);
  });

  it('intersectLines 平行返回 null 而不是 Infinity', () => {
    expect(intersectLines(vec(0, 0), vec(1, 0), vec(0, 5), vec(1, 0))).toBeNull();
  });

  it('isParallel 遇零长度轴抛错：退化输入不等于真平行', () => {
    expect(() => isParallel(vec(0, 0), vec(1, 0))).toThrow(RangeError);
    expect(() => isParallel(vec(0, 0), vec(1, 0))).toThrow(/零向量/);
    expect(() => isParallel(vec(1, 0), vec(0, 0))).toThrow(/零向量/);
  });

  it('intersectLines 遇零长度方向轴抛错：退化输入不折叠成 null', () => {
    expect(() => intersectLines(vec(0, 0), vec(0, 0), vec(2, 3), vec(0, 1))).toThrow(RangeError);
    expect(() => intersectLines(vec(0, 0), vec(0, 0), vec(2, 3), vec(0, 1))).toThrow(/零向量/);
    expect(() => intersectLines(vec(0, 0), vec(1, 0), vec(2, 3), vec(0, 0))).toThrow(/零向量/);
  });

  it('PARALLEL_EPS 是 1e-9 量级：接头斜切对角度不敏感到有误差的程度', () => {
    expect(PARALLEL_EPS).toBe(1e-9);
  });
});

describe('派生层不出现 -0', () => {
  // 断言一律用 Object.is：`-0 === 0` 为 true，写成 toEqual/toBe(0) 之外的形式没有区分力。
  it('vec 与 add/sub 把分量上的 -0 归一为 +0', () => {
    expect(Object.is(vec(-0, -0).x, -0)).toBe(false);
    expect(Object.is(vec(-0, -0).x, 0)).toBe(true);
    expect(Object.is(vec(-0, -0).y, 0)).toBe(true);
    // 绕过 vec 直接传字面量对象，单独考 add/sub 自己的归一（-0 + -0 = -0）
    const sum = add({ x: -0, y: -0 }, { x: -0, y: -0 });
    expect(Object.is(sum.x, 0)).toBe(true);
    expect(Object.is(sum.y, 0)).toBe(true);
    const diff = sub({ x: -0, y: -0 }, { x: 0, y: 0 });
    expect(Object.is(diff.x, 0)).toBe(true);
  });

  it('scale 不制造 -0：scale(dir, -1) 是 Task 4 反方向的常规写法', () => {
    const flipped = scale({ x: 0, y: 5 }, -1);
    expect(Object.is(flipped.x, -0)).toBe(false);
    expect(Object.is(flipped.x, 0)).toBe(true);
    expect(flipped.y).toBe(-5);
  });

  it('normalize 与 perp 的两个分量都不留 -0', () => {
    // -0 / l 仍是 -0（l > 0）；perp 的 y 分量直通 a.x，两处都得归一
    expect(Object.is(normalize({ x: -0, y: 5 }).x, 0)).toBe(true);
    expect(Object.is(perp({ x: 1, y: 0 }).x, 0)).toBe(true);
    expect(Object.is(perp({ x: -0, y: 1 }).y, -0)).toBe(false);
    expect(Object.is(perp({ x: -0, y: 1 }).y, 0)).toBe(true);
  });

  it('advance 的 -0 原点与前移量相加仍是 +0', () => {
    const p = advance({ x: -0, y: -0 }, { x: -0, y: -0 }, 1);
    expect(Object.is(p.x, 0)).toBe(true);
    expect(Object.is(p.y, 0)).toBe(true);
  });

  it('零的符号是行为差异：angleOf 不会因 -0 翻到负角', () => {
    // 未归一时 sub 会把 -0 留在 y 上，atan2(-0, -1) = -π 而不是 +π
    expect(angleOf(sub({ x: -1, y: -0 }, { x: 0, y: 0 }))).toBe(Math.PI);
    // 未归一时 scale 会把 y 变成 -0，atan2(-0, 1) = -0 而不是 +0
    expect(angleOf(scale({ x: -1, y: 0 }, -1))).toBe(0);
  });
});
