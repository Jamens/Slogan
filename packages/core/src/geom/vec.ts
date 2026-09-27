/**
 * 派生层唯一的二维向量类型：浮点毫米（spec D8 的"临时构造计算"侧）。
 * 它的值**永不写回真源** —— 真源只收整数毫米，见 units/mm.ts。
 *
 * 派生层不出现 -0：本文件返回的每个向量都经内部 point() 逐分量把 ±0 归一成 +0，
 * 因为 -0 在 `===` 下与 +0 全等、在 `Object.is`（vitest 的 toEqual/toBe 用它）下不等，
 * 且 `Math.atan2(-0, -1)` 是 -π 而 `Math.atan2(0, -1)` 是 +π —— 零的符号会翻掉
 * angleOf 的分支，是行为差异（Task 4 的斜切角）而不是显示问题。
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

/** ±0 归一为 +0；非零值（含 NaN 与 ±Infinity）原样返回，不做任何兜底。 */
function noNegZero(v: number): number {
  return v === 0 ? 0 : v;
}

/**
 * 本文件唯一的 Vec2 构造点：vec/add/sub/scale/normalize/perp/advance 的返回值
 * 全部经此，所以 -0 无法从派生层漏出去。不导出 —— 避免有人绕过归一。
 */
function point(x: number, y: number): Vec2 {
  return { x: noNegZero(x), y: noNegZero(y) };
}

export function vec(x: number, y: number): Vec2 {
  return point(x, y);
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return point(a.x + b.x, a.y + b.y);
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return point(a.x - b.x, a.y - b.y);
}

export function scale(a: Vec2, k: number): Vec2 {
  // 0 * -1 是 -0：scale(dir, -1) 这个"反向"写法正是 -0 的主要产地。
  return point(a.x * k, a.y * k);
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
  // 除以正数保号：-0 / l 仍是 -0，所以这里也必须走 point。
  return point(a.x / l, a.y / l);
}

/** 逆时针 90°。墙的"左"侧一律取 +normal，即 perp(dir)。 */
export function perp(a: Vec2): Vec2 {
  return point(-a.y, a.x);
}

export function angleOf(a: Vec2): number {
  return Math.atan2(a.y, a.x);
}

/** 无向夹角，结果落在 [0, π]。共线反向给 π。零长度向量没有方向，抛 —— 与 sinOfAngle 同口径。 */
export function angleBetween(a: Vec2, b: Vec2): number {
  if (length(a) === 0 || length(b) === 0) throw new RangeError('零向量无方向，无法求夹角');
  return Math.abs(Math.atan2(cross(a, b), dot(a, b)));
}

/** dir 必须是单位向量（来自 normalize），调用方保证。 */
export function advance(origin: Vec2, dir: Vec2, dist: number): Vec2 {
  return point(origin.x + dir.x * dist, origin.y + dir.y * dist);
}

/**
 * 带符号夹角的正弦。零长度向量没有方向，直接抛 —— 不把退化输入折叠成"平行"，
 * 否则 Task 4 里"轴线端点缺失"与"真的平行"不可区分，接头会静默判成平接。
 */
export function sinOfAngle(a: Vec2, b: Vec2): number {
  const l = length(a) * length(b);
  if (l === 0) throw new RangeError('零向量无方向，无法求夹角正弦');
  return cross(a, b) / l;
}

/** 近平行判据（相对容差）。任一轴为零长度时随 sinOfAngle 抛错，不返回 true/false。 */
export function isParallel(a: Vec2, b: Vec2): boolean {
  return Math.abs(sinOfAngle(a, b)) <= PARALLEL_EPS;
}

/**
 * 两条无限直线求交：p 沿 dir、q 沿 other。
 * 平行（含近平行）返回 null —— 绝不返回 Infinity 或 NaN，
 * 因为 Task 4 的接头会把这些点直接写进派生多边形。
 * 方向轴零长度抛错（退化的"线"不是平行线）。
 */
export function intersectLines(p: Vec2, dir: Vec2, q: Vec2, other: Vec2): Vec2 | null {
  if (isParallel(dir, other)) return null;
  const t = cross(sub(q, p), other) / cross(dir, other);
  return advance(p, dir, t);
}

/**
 * 闭线段是否相交（端点相接与共线重叠都算）。环的自交判据要的就是"闭"这一档语义：
 * 差一点点就算漏，画出来的轮廓是破的。
 *
 * 这里**不引入 EPS**：调用方给的恒是真源里的整数毫米，叉积量级 4e8 远在 double 精确区内，
 * 共线就是 cross === 0。浮点输入才需要容差判据，那属于计划 5 的环规范化。
 */
export function segmentsIntersect(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): boolean {
  const o1 = cross(sub(a2, a1), sub(b1, a1));
  const o2 = cross(sub(a2, a1), sub(b2, a1));
  const o3 = cross(sub(b2, b1), sub(a1, b1));
  const o4 = cross(sub(b2, b1), sub(a2, b1));
  // 严格相交：两条线段的两个端点各在对方两侧（0 与任何非零都"不同号"，端点落在线上会被下面兜住）
  if (Math.sign(o1) !== Math.sign(o2) && Math.sign(o3) !== Math.sign(o4)) return true;
  const within = (a: Vec2, b: Vec2, p: Vec2): boolean =>
    Math.min(a.x, b.x) <= p.x &&
    p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y &&
    p.y <= Math.max(a.y, b.y);
  // 共线：只有落进另一条线段的包围盒里才算碰上了
  return (
    (o1 === 0 && within(a1, a2, b1)) ||
    (o2 === 0 && within(a1, a2, b2)) ||
    (o3 === 0 && within(b1, b2, a1)) ||
    (o4 === 0 && within(b1, b2, a2))
  );
}
