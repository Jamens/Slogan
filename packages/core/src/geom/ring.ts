import type { Vec2 } from './vec';
import { cross, segmentsIntersect, sub } from './vec';

/**
 * 一个开环（首尾不重复，闭合由调用方隐含）能不能当构件轮廓用。
 * 三条精确判据：顶点数、顶点互异、相邻三点不共线、非相邻边不相交。
 *
 * 故意不看面积：Task 5 已钉"蝴蝶结的鞋带面积恒为 0"，面积能挡的病这三条全能挡，
 * 而 180° 折回（面积照样为正）和面积非 0 的交叉四边形，面积判据一个都挡不住。
 * 多留一份判据就多一份"到底哪条在起作用"的疑问。
 */
export function assertSimpleRing(label: string, points: readonly Vec2[]): void {
  const n = points.length;
  if (n < 3) throw new RangeError(`${label}至少 3 个顶点，收到 ${n}`);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (points[i]!.x === points[j]!.x && points[i]!.y === points[j]!.y) {
        throw new RangeError(
          `${label}有重复顶点（第 ${i} 与 ${j} 个同为 (${points[i]!.x}, ${points[i]!.y})）：` +
            `开环不重复首点，两点也不许重合`,
        );
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const c = points[(i + 2) % n]!;
    // 输入恒为整数毫米 → 零判定精确，不需要 EPS
    if (cross(sub(b, a), sub(c, b)) === 0) {
      throw new RangeError(
        `${label}第 ${i}、${(i + 1) % n}、${(i + 2) % n} 个顶点共线：` +
          `要么 180° 折回，要么是图纸上的冗余转角`,
      );
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // 相邻边天生共享一个端点，(0, n-1) 也因为环闭合而相邻 —— 这些对一律不查
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (
        segmentsIntersect(points[i]!, points[(i + 1) % n]!, points[j]!, points[(j + 1) % n]!)
      ) {
        throw new RangeError(
          `${label}自交：第 ${i}-${(i + 1) % n} 条边与第 ${j}-${(j + 1) % n} 条边相交`,
        );
      }
    }
  }
}
