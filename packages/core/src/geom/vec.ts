/**
 * 派生层唯一的二维向量类型：浮点毫米（spec D8 的"临时构造计算"侧）。
 * 它的值**永不写回真源** —— 真源只收整数毫米，见 units/mm.ts。
 */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/**
 * 近平行判据的相对容差。用 |sinθ| 而不是叉积绝对值：坐标量级到 2e5 mm 时
 * 叉积绝对值本身没有可比性（Task 1 有一条测试专门钉这点）。
 */
export const PARALLEL_EPS = 1e-9;

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** 标量叉积。> 0 表示 b 在 a 的逆时针侧（即墙的 +normal 侧）。 */
export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

export function length(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function normalize(a: Vec2): Vec2 {
  const l = length(a);
  if (l === 0) throw new RangeError('零向量无法归一化');
  return { x: a.x / l, y: a.y / l };
}

/** 逆时针 90°。墙的"左"侧一律取 +normal，即 perp(dir)。 */
export function perp(a: Vec2): Vec2 {
  // -a.y 在 a.y 为 0 时给出 -0，而 -0 会顺着派生点一路漏到 Task 5 的轮廓断言里
  // （vitest 的 toEqual/toBe 用 Object.is，区分 ±0）。这里把 ±0 归一成 +0；
  // 非零与 NaN 原样取负，不做任何兜底。
  return { x: a.y === 0 ? 0 : -a.y, y: a.x };
}

export function angleOf(a: Vec2): number {
  return Math.atan2(a.y, a.x);
}

/** 无向夹角，结果落在 [0, π]。共线反向给 π。 */
export function angleBetween(a: Vec2, b: Vec2): number {
  return Math.abs(Math.atan2(cross(a, b), dot(a, b)));
}

/** dir 必须是单位向量（来自 normalize），调用方保证。 */
export function advance(origin: Vec2, dir: Vec2, dist: number): Vec2 {
  return { x: origin.x + dir.x * dist, y: origin.y + dir.y * dist };
}

/** 带符号夹角的正弦。任一向量为零时给 0（退化方向按"平行"处理，交由上层抛错或平接）。 */
export function sinOfAngle(a: Vec2, b: Vec2): number {
  const l = length(a) * length(b);
  return l === 0 ? 0 : cross(a, b) / l;
}

export function isParallel(a: Vec2, b: Vec2): boolean {
  return Math.abs(sinOfAngle(a, b)) <= PARALLEL_EPS;
}

/**
 * 两条无限直线求交：p 沿 dir、q 沿 other。
 * 平行（含近平行）返回 null —— 绝不返回 Infinity 或 NaN，
 * 因为 Task 4 的接头会把这些点直接写进派生多边形。
 */
export function intersectLines(p: Vec2, dir: Vec2, q: Vec2, other: Vec2): Vec2 | null {
  const den = cross(dir, other);
  if (Math.abs(den) <= PARALLEL_EPS * length(dir) * length(other)) return null;
  const t = cross(sub(q, p), other) / den;
  return advance(p, dir, t);
}
