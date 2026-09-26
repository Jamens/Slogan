import type { EntityId } from '../ids';
import type { Document } from '../model/document';
import { mustExist, requirePoint, requireWall } from '../model/read';
import type { WallEntity } from '../model/entity';
import { advance, length, normalize, perp, sub, vec, type Vec2 } from './vec';

export type WallEnd = 'start' | 'end';

/**
 * 墙轴线的派生视图。lengthMm / dir / normal 都是浮点：斜墙轴长不是整数
 * （spec D8 允许浮点只存在于临时构造计算，本目录就是那个"临时构造"）。
 */
export interface WallAxis {
  readonly wallId: EntityId;
  readonly storeyId: EntityId;
  readonly start: Vec2;
  readonly end: Vec2;
  /** 单位向量 start→end */
  readonly dir: Vec2;
  /** perp(dir)：逆时针 90°，墙的左侧 */
  readonly normal: Vec2;
  readonly lengthMm: number;
  readonly thicknessMm: number;
}

export function wallAxis(doc: Document, wall: WallEntity): WallAxis {
  const s = requirePoint(doc, wall.startId, '墙起点');
  const e = requirePoint(doc, wall.endId, '墙终点');
  const start = vec(s.x, s.y);
  const end = vec(e.x, e.y);
  const delta = sub(end, start);
  const lengthMm = length(delta);
  if (lengthMm === 0) {
    throw new RangeError(`墙 ${wall.id} 两端点重合，轴线无方向（零长墙应在命令层就被拒绝）`);
  }
  const dir = normalize(delta);
  return {
    wallId: wall.id,
    storeyId: wall.storeyId,
    start,
    end,
    dir,
    normal: perp(dir),
    lengthMm,
    thicknessMm: wall.thicknessMm,
  };
}

export function wallAxisById(doc: Document, wallId: EntityId): WallAxis {
  const wall = requireWall(doc, wallId);
  mustExist(doc, wall.storeyId, '楼层');
  return wallAxis(doc, wall);
}

export function otherEnd(end: WallEnd): WallEnd {
  return end === 'start' ? 'end' : 'start';
}

/** 真源里该端的点 id。Task 3 的共享端点与 Task 4 的接头分组都从它出发。 */
export function endPointId(wall: WallEntity, end: WallEnd): EntityId {
  return end === 'start' ? wall.startId : wall.endId;
}

export function endPoint(axis: WallAxis, end: WallEnd): Vec2 {
  return end === 'start' ? axis.start : axis.end;
}

/** 从该端点指向墙内部的单位方向。接头算的就是"这个端点上，墙往哪走"。 */
export function awayDir(axis: WallAxis, end: WallEnd): Vec2 {
  // 走 vec() 而不是裸字面量：-axis.dir.y 在水平墙上给出 -0，而派生层约定不出现 -0
  // （见 vec.ts 的 Vec2 文档块）—— Object.is(-0, 0) 为 false，Task 4 的接头比对会红在
  // 符号零上而不是几何上。取负本身照旧，不做任何兜底。
  return end === 'start' ? axis.dir : vec(-axis.dir.x, -axis.dir.y);
}

/**
 * 该端点某一侧的轮廓角点。side: +1 = normal 侧（左），-1 = -normal 侧（右）。
 * trimMm 是沿 awayDir 的内退距离（0 = 平接到端点，>0 = 斜切掉一段）。
 */
export function cornerPoint(axis: WallAxis, end: WallEnd, side: 1 | -1, trimMm: number): Vec2 {
  const half = axis.thicknessMm / 2;
  const base = advance(endPoint(axis, end), awayDir(axis, end), trimMm);
  return advance(base, axis.normal, side * half);
}
