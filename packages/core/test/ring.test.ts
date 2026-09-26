import { describe, expect, it } from 'vitest';
import { assertSimpleRing, polygonArea, segmentsIntersect, vec } from '@dajia/core';

const RECT = [vec(0, 0), vec(10000, 0), vec(10000, 6000), vec(0, 6000)];
/** 凹角 L 形板：合法，且专门用来盯"共线判据会不会误伤真转角"。 */
const CONCAVE_L = [
  vec(0, 0),
  vec(6000, 0),
  vec(6000, 3000),
  vec(3000, 3000),
  vec(3000, 6000),
  vec(0, 6000),
];

describe('assertSimpleRing', () => {
  it('矩形与它的反向绕序都通过（判据与顶点顺序方向无关）', () => {
    expect(() => assertSimpleRing('板', RECT)).not.toThrow();
    expect(() => assertSimpleRing('板', [...RECT].reverse())).not.toThrow();
    expect(() => assertSimpleRing('板', [vec(0, 0), vec(3000, 0), vec(0, 3000)])).not.toThrow();
  });

  it('凹 L 形板通过：凹角不是自交，共线判据不许把 90° 转角当冗余', () => {
    expect(() => assertSimpleRing('板', CONCAVE_L)).not.toThrow();
    // 反证：这个环的鞋带面积确实是 27000000，说明它没退化（退化环才是我们要挡的）
    expect(polygonArea(CONCAVE_L)).toBe(27000000);
  });

  it('少于 3 个顶点 → 抛（两点的"环"是一条线）', () => {
    expect(() => assertSimpleRing('板', [vec(0, 0), vec(1000, 0)])).toThrow(/至少 3 个顶点/);
    expect(() => assertSimpleRing('板', [])).toThrow(/至少 3 个顶点/);
  });

  it('重复顶点 → 抛；把首点重复写成终点也算重复', () => {
    expect(() =>
      assertSimpleRing('板', [vec(0, 0), vec(1000, 0), vec(1000, 0), vec(0, 1000)]),
    ).toThrow(/重复顶点/);
    // 开环约定：闭合由调用方隐含，写了首点就是重复
    expect(() =>
      assertSimpleRing('板', [vec(0, 0), vec(1000, 0), vec(0, 1000), vec(0, 0)]),
    ).toThrow(/重复顶点/);
  });

  it('相邻三点共线 → 抛：180° 折回与冗余共线点一起挡', () => {
    // 折回：面积 25000000 算得出来，只有共线判据抓得到 —— 面积判据在这里是瞎的
    expect(() =>
      assertSimpleRing('板', [vec(0, 0), vec(10000, 0), vec(5000, 0), vec(0, 10000)]),
    ).toThrow(/共线/);
    // 冗余顶点：同一条边上多一个点，出图会被标成真实转角
    expect(() =>
      assertSimpleRing('板', [vec(0, 0), vec(5000, 0), vec(10000, 0), vec(0, 10000)]),
    ).toThrow(/共线/);
  });

  it('自交 → 抛：用面积非 0 的交叉四边形，不用蝴蝶结', () => {
    // 蝴蝶结的鞋带恒为 0（Task 5 已钉），拿它当反例会让人以为"面积也能管自交"。
    // 这个四边形面积 9000000，只有边相交判据抓得到。
    const crossed = [vec(0, 0), vec(10000, 8000), vec(9000, 0), vec(0, 10000)];
    expect(polygonArea(crossed)).toBe(9000000);
    expect(() => assertSimpleRing('板', crossed)).toThrow(/自交/);
  });

  it('相邻边只查非相邻对：共顶点不算相交', () => {
    // RECT 的四条边两两在顶点相接，上面第一条已经证明整环通过；
    // 这里直接盯 segmentsIntersect 本身，防止它"返回恒真"混过环判据。
    expect(segmentsIntersect(vec(0, 0), vec(10, 0), vec(5, -5), vec(5, 5))).toBe(true);
    expect(segmentsIntersect(vec(0, 0), vec(10, 0), vec(10, 0), vec(10, 10))).toBe(true);
    expect(segmentsIntersect(vec(0, 0), vec(10, 0), vec(0, 5), vec(10, 5))).toBe(false);
    expect(segmentsIntersect(vec(0, 0), vec(10, 0), vec(20, -5), vec(20, 5))).toBe(false);
    // 共线但错开：不重叠就不算相交
    expect(segmentsIntersect(vec(0, 0), vec(10, 0), vec(11, 0), vec(20, 0))).toBe(false);
    // 共线且重叠：算相交
    expect(segmentsIntersect(vec(0, 0), vec(10, 0), vec(5, 0), vec(20, 0))).toBe(true);
  });
});
