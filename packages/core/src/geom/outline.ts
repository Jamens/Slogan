import type { EntityId } from '../ids';
import type { Document } from '../model/document';
import { cornerPoint, wallAxis, type WallAxis } from './axis';
import { deriveJoints, memberTrim, type Joint, type JointMember } from './joint';
import type { Vec2 } from './vec';

/**
 * 一面墙的矩形（斜切后是梯形）轮廓。corners 是**环序**：
 * 0 = start 侧 +normal，1 = end 侧 +normal，2 = end 侧 -normal，3 = start 侧 -normal。
 * 顺序即契约 —— 计划 3 描边、计划 5 标注都以它为前提。
 */
export interface WallQuad {
  readonly wallId: EntityId;
  readonly corners: readonly [Vec2, Vec2, Vec2, Vec2];
  readonly areaMm2: number;
}

/**
 * 鞋带公式，返回绝对值。注意：自相交的蝴蝶形两叶带符号相消 → 给 0，
 * 所以"面积对"不等于"形状对"，调用方要单独保证不自交（joint.ts 的 assertNoFlip）。
 */
export function polygonArea(points: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/**
 * 轴线 + 两端的斜切量 → 四角。角点一律走 axis.ts 的 cornerPoint（它内部经 vec.ts 的
 * point() 构造向量），本文件不自建 Vec2 字面量 —— 于是 -0 无从产生（±0 纪律）。
 */
export function wallQuad(axis: WallAxis, startTrim: JointMember, endTrim: JointMember): WallQuad {
  const corners: [Vec2, Vec2, Vec2, Vec2] = [
    cornerPoint(axis, 'start', 1, startTrim.trimLeftMm),
    cornerPoint(axis, 'end', 1, endTrim.trimLeftMm),
    cornerPoint(axis, 'end', -1, endTrim.trimRightMm),
    cornerPoint(axis, 'start', -1, startTrim.trimRightMm),
  ];
  return { wallId: axis.wallId, corners, areaMm2: polygonArea(corners) };
}

/**
 * joints 可传入以避免重复派生（Task 6 的整层入口一次派生两处用）。
 * 不传就内部派生：绝不因为"没接头表"就退化成平接 —— 那样接头会静默开裂。
 * 顺序跟着 doc.byKind('wall')（墙 id 升序），不跟着创建顺序。
 */
export function deriveWallQuads(doc: Document, joints?: readonly Joint[]): WallQuad[] {
  const table = joints ?? deriveJoints(doc);
  return doc.byKind('wall').map((wall) => {
    const axis = wallAxis(doc, wall);
    return wallQuad(axis, memberTrim(table, wall.id, 'start'), memberTrim(table, wall.id, 'end'));
  });
}
